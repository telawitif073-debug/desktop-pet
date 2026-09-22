# 隧道看门狗 v2：每 60s 体检公网隧道；断线自动重连 cloudflared；
# 任何时候发现 app-update.json 的 apkUrl 与当前隧道不一致都自动修正。
# 所有动作写 dist-share\watchdog.log，不再静默吞错。
$ErrorActionPreference = 'Continue'
$share = 'e:\desktop-pet\dist-share'
$manifest = 'e:\desktop-pet\platform\backend\app-update.json'
$log = Join-Path $share 'watchdog.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log($msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    Write-Output $line
    try { [System.IO.File]::AppendAllText($log, $line + "`r`n", $utf8NoBom) } catch {}
}

# 把清单 apkUrl 对齐到指定隧道；返回 synced / noop / error:...
function Sync-Manifest($tunnel) {
    try {
        $j = [System.IO.File]::ReadAllText($manifest) | ConvertFrom-Json
        $want = "$tunnel/MobilePet-1.0.apk"
        # 热更 bundle 链接同样挂在隧道下，换址时一并重写（保留 zip 文件名）
        $bundleWant = ''
        if ($j.bundle -and $j.bundle.url) {
            $name = ($j.bundle.url -split '/')[-1]
            $bundleWant = "$tunnel/$name"
        }
        if ($j.apkUrl -eq $want -and (-not $bundleWant -or $j.bundle.url -eq $bundleWant)) { return 'noop' }
        $j.apkUrl = $want
        if ($bundleWant) { $j.bundle.url = $bundleWant }
        $out = $j | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($manifest, $out, $utf8NoBom)
        $back = ([System.IO.File]::ReadAllText($manifest) | ConvertFrom-Json).apkUrl
        if ($back -ne $want) { return "error:readback-mismatch($back)" }
        return 'synced'
    } catch {
        return ('error:' + $_.Exception.Message)
    }
}

# 写服务器发现文件并后台发布到 GitHub（手机端在当前地址失效时据此自动引导新地址）
function Publish-Discovery($tunnel) {
    try {
        $discFile = 'e:\desktop-pet\server-discovery.json'
        $payload = [ordered]@{
            tunnel = $tunnel
            api = "$tunnel/api"
            lan = 'http://192.168.1.5:8899/api'
            updatedAt = [int][double]::Parse((Get-Date -UFormat %s))
        }
        [System.IO.File]::WriteAllText($discFile, ($payload | ConvertTo-Json -Depth 3), $utf8NoBom)
        Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','e:\desktop-pet\scripts\publish-discovery.ps1' -WindowStyle Hidden
    } catch {
        Write-Log ('discovery publish error: ' + $_.Exception.Message)
    }
}

Write-Log 'watchdog v2 started'
$lastRegister = $null
while ($true) {
    $url = ''
    try { $url = ([System.IO.File]::ReadAllText("$share\tunnel-url.txt")).Trim() } catch {}
    # 刚注册的新域名 DNS 需 1~3 分钟才生效：宽限期内体检失败不杀隧道，
    # 否则会把刚注册的隧道误杀，造成公链几分钟换一次的恶性循环
    $inGrace = ($lastRegister -and (((Get-Date) - $lastRegister).TotalSeconds -lt 180))
    $ok = $false
    if ($url -match '^https://') {
        try {
            $r = Invoke-WebRequest -Uri "$url/api/app-update" -UseBasicParsing -TimeoutSec 8
            $ok = ($r.StatusCode -eq 200)
        } catch { $ok = $false }
    }
    if (-not $ok -and -not $inGrace) {
        # 二次确认：单次超时可能是网络抖动，避免误杀隧道导致公链频繁换址
        Start-Sleep -Seconds 10
        try {
            $r2 = Invoke-WebRequest -Uri "$url/api/app-update" -UseBasicParsing -TimeoutSec 8
            $ok = ($r2.StatusCode -eq 200)
        } catch { $ok = $false }
    }
    if (-not $ok -and $inGrace) {
        Write-Log 'health check failed within DNS grace window after registration, skip re-register'
    } elseif (-not $ok) {
        Write-Log 'tunnel down (double-checked), re-registering...'
        Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Remove-Item "$share\cf-err.log" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath 'e:\desktop-pet\cloudflared.exe' `
            -ArgumentList 'tunnel','--url','http://localhost:8899','--protocol','http2','--no-autoupdate' `
            -RedirectStandardError "$share\cf-err.log" -RedirectStandardOutput "$share\cf-out.log" `
            -WindowStyle Hidden
        # 最多等 40s 拿新地址
        $new = ''
        for ($i = 0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 5
            try {
                # 快速隧道地址固定为 4 段词组（如 knights-changelog-arcade-sri），
                # 排除注册 API 域名 api.trycloudflare.com 等误匹配
                # @() 强制数组：单一匹配时 PS 会退化为标量字符串，$m[0] 会变成首字母
                $m = @(Select-String -Path "$share\cf-err.log" -Pattern 'https://[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+\.trycloudflare\.com' -AllMatches |
                    ForEach-Object { $_.Matches.Value } |
                    Select-Object -Unique)
                if ($m.Count -gt 0 -and $m[0] -match '^https://') { $new = $m[0]; break }
            } catch {}
        }
        if ($new) {
            [System.IO.File]::WriteAllText("$share\tunnel-url.txt", $new, $utf8NoBom)
            $res = Sync-Manifest $new
            Write-Log ("new tunnel: {0} (manifest: {1})" -f $new, $res)
            Publish-Discovery $new
            $lastRegister = Get-Date
        } else {
            Write-Log 'register failed, retry next round'
        }
    } else {
        # 隧道健康时也对账：兜住手工改动或上次同步失败造成的漂移
        $res = Sync-Manifest $url
        if ($res -ne 'noop') { Write-Log ("reconcile manifest: {0}" -f $res) }
    }
    Start-Sleep -Seconds 60
}
