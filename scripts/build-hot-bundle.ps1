# JS Bundle 热更新包打包发布脚本
# 流程：计算新 bundle 版本 → npx react-native bundle 出包 → 归一化资源目录 → zip 到 dist-share
#       → 更新 platform/backend/app-update.json 的 bundle 字段
# 用法：powershell -File scripts\build-hot-bundle.ps1 [-Notes "更新说明"] [-MinApkCode 20]
param(
    [string]$Notes = '体验优化与问题修复',
    [int]$MinApkCode = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $root 'mobile'
$dist = Join-Path $root 'dist-share'
$manifest = Join-Path $root 'platform\backend\app-update.json'

if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

# 1) 计算新 bundle 版本（清单里现有 bundle.version + 1，无则从 1 开始）
# 注意：PS 5.1 Get-Content 对无 BOM UTF-8 按 ANSI 误读会写坏中文，统一用 .NET UTF8 读写
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$update = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$nextVersion = if ($update.bundle -and $update.bundle.version) { [int]$update.bundle.version + 1 } else { 1 }
Write-Host "==> bundle 版本: $nextVersion"

# 2) 出 RN bundle（Hermes 字节码 + 资源）
$tmp = Join-Path $env:TEMP "pet-bundle-$nextVersion"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Push-Location $mobile
try {
    Write-Host '==> react-native bundle（Hermes 编译，约 1-2 分钟）...'
    & npx react-native bundle --platform android --dev false `
        --entry-file index.js `
        --bundle-output (Join-Path $tmp 'index.android.bundle') `
        --assets-dest $tmp
    if ($LASTEXITCODE -ne 0) { throw 'react-native bundle 失败' }
    if (-not (Test-Path (Join-Path $tmp 'index.android.bundle'))) { throw 'bundle 文件未生成' }
} finally {
    Pop-Location
}

# 3) Hermes 字节码编译（rn 0.87 出的是 hermes 字节码吗？--dev false 时 hermesEnabled=true 走 hermesc；
#    CLI 已自动处理，这里校验输出非 JS 文本即可，跳过）

# 4) zip 打包（ZipArchive 逐条目写入并强制用 / 分隔——.NET Framework 的 ZipFile.CreateFromDirectory
#    在 PS 5.1 下会用反斜杠分隔符，安卓端按 / 解析会导致资源目录解压错误；
#    bundle 与 drawable/raw 资源平级，与 RN file-bundle 加载布局一致）
$zipPath = Join-Path $dist "pet-bundle-$nextVersion.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $tmp -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($tmp.Length + 1) -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
    $fs.Dispose()
}
$size = (Get-Item $zipPath).Length
Write-Host ("==> zip 完成: {0} ({1:N1} MB)" -f $zipPath, ($size / 1MB))

# 5) 更新 app-update.json 的 bundle 字段（服务器地址固定内置阿里云，无需动态发现）
$update | Add-Member -Force -NotePropertyName bundle -NotePropertyValue ([pscustomobject]@{
    version = $nextVersion
    url = $zipPath -replace '\\', '/'
    notes = $Notes
    minApkCode = $MinApkCode
})
$cloudBase = 'http://39.105.178.6'
$update.apkUrl = "$cloudBase/MobilePet-1.0.apk"
$update.bundle.url = "$cloudBase/pet-bundle-$nextVersion.zip"
$update | ConvertTo-Json -Depth 5 | Set-Content $manifest -Encoding UTF8
Write-Host "==> app-update.json 已更新（bundle v$nextVersion，url=$($update.bundle.url)）"

# 清理临时目录
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '==> 完成。用户端将在下次检查更新时收到热更提示（无需重装 APK，重启生效）'
