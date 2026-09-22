# 发布服务器发现文件：把 server-discovery.json 提交推送（独立进程不经过沙箱），并刷新 jsDelivr CDN 缓存
$ErrorActionPreference = 'Continue'
$root = 'e:\desktop-pet'
$log = Join-Path $root 'dist-share\discovery-publish.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log($msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Write-Output $line
    try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $utf8NoBom) } catch {}
}

Set-Location $root
# 先 add 再按路径提交：server-discovery.json 首次发布时是 untracked，git commit -- <path> 对
# untracked 文件不生效（会静默跳过），必须显式 add 才能进版本库
git add server-discovery.json 2>&1 | Out-Null
git commit -m 'chore: auto update tunnel discovery' -- server-discovery.json 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Log 'nothing to commit (or commit failed), skip'
    exit 0
}
$pushed = $false
for ($i = 0; $i -lt 15; $i++) {
    git -c http.version=HTTP/1.1 push origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    Write-Log "push retry $i"
    Start-Sleep -Seconds 60
}
if (-not $pushed) { Write-Log 'push failed after retries'; exit 1 }
Write-Log 'pushed to github'
# 刷新 jsDelivr CDN 缓存（无需认证），让手机端 1 分钟内拿到新地址
try {
    $r = Invoke-WebRequest -Uri 'https://purge.jsdelivr.net/gh/telawitif073-debug/desktop-pet@main/server-discovery.json' -UseBasicParsing -TimeoutSec 15
    Write-Log ("cdn purged HTTP " + $r.StatusCode)
} catch {
    Write-Log ('cdn purge failed: ' + $_.Exception.Message)
}
