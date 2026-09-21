# 隧道看门狗：每 60s 检查隧道；断线则重启 cloudflared 并把新地址同步进 app-update.json
$ErrorActionPreference = 'Continue'
$share = 'e:\desktop-pet\dist-share'
$manifest = 'e:\desktop-pet\platform\backend\app-update.json'
while ($true) {
    $url = ''
    try { $url = (Get-Content "$share\tunnel-url.txt" -Raw).Trim() } catch {}
    $ok = $false
    if ($url -match '^https://') {
        try {
            $r = Invoke-WebRequest -Uri "$url/api/app-update" -UseBasicParsing -TimeoutSec 8
            $ok = ($r.StatusCode -eq 200)
        } catch { $ok = $false }
    }
    if (-not $ok) {
        Write-Output ("[{0}] tunnel down, re-registering..." -f (Get-Date -Format 'HH:mm:ss'))
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
                $m = Select-String -Path "$share\cf-err.log" -Pattern 'https://[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+\.trycloudflare\.com' -AllMatches |
                    ForEach-Object { $_.Matches.Value } |
                    Select-Object -Unique
                if ($m) { $new = $m[0]; break }
            } catch {}
        }
        if ($new) {
            Set-Content -Path "$share\tunnel-url.txt" -Value $new
            try {
                $j = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
                $j.apkUrl = "$new/MobilePet-1.0.apk"
                $j | ConvertTo-Json -Depth 4 | Set-Content -Path $manifest -Encoding UTF8
            } catch {}
            Write-Output ("[{0}] new tunnel: {1}" -f (Get-Date -Format 'HH:mm:ss'), $new)
        } else {
            Write-Output ("[{0}] register failed, retry next round" -f (Get-Date -Format 'HH:mm:ss'))
        }
    }
    Start-Sleep -Seconds 60
}
