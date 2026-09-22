# 本地打包部署产物：dist-share + backend(dist/node_modules/uploads/.env/app-update.json) + deploy 脚本
# 产出 e:\desktop-pet\deploy\pet-deploy.tar.gz，scp 到服务器 /tmp/ 后执行 server-setup.sh
$ErrorActionPreference = 'Stop'
$root = 'e:\desktop-pet'
$stage = Join-Path $env:TEMP 'pet-deploy-stage'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

# 1) 构建 backend
Push-Location "$root\platform\backend"
npm run build 2>&1 | Select-Object -Last 2
Pop-Location

# 2) 组装 backend/（生产 node_modules 在 staging 独立安装，不动本地开发依赖）
$backend = Join-Path $stage 'backend'
New-Item -ItemType Directory -Path $backend | Out-Null
Copy-Item "$root\platform\backend\dist" "$backend\dist" -Recurse
Copy-Item "$root\platform\backend\package.json" $backend
Copy-Item "$root\platform\backend\package-lock.json" $backend
Push-Location $backend
cmd /c "npm ci --omit=dev --no-audit --no-fund 2>&1" | Select-Object -Last 1
Pop-Location
# uploads 宠物资源（若有）
if (Test-Path "$root\platform\backend\uploads") { Copy-Item "$root\platform\backend\uploads" "$backend\uploads" -Recurse }
# .env：云端版（DB 走本机 postgres，密码与 server-setup.sh 一致）
$envContent = Get-Content "$root\platform\backend\.env" -Raw
$envCloud = $envContent -replace '(?m)^DB_HOST=.*$', 'DB_HOST=127.0.0.1' -replace '(?m)^DB_PORT=.*$', 'DB_PORT=5432' -replace '(?m)^DB_USERNAME=.*$', 'DB_USERNAME=postgres' -replace '(?m)^DB_PASSWORD=.*$', 'DB_PASSWORD=pet_pg_2026' -replace '(?m)^DB_DATABASE=.*$', 'DB_DATABASE=desktop_pet_platform'
[System.IO.File]::WriteAllText("$backend\.env", $envCloud, $utf8NoBom)
# app-update.json：backend 根（controller 以 __dirname/../.. 定位）
Copy-Item "$root\platform\backend\app-update.json" $backend

# 3) dist-share（APK / bundle / 更新清单副本）
Copy-Item "$root\dist-share" "$stage\dist-share" -Recurse

# 4) deploy 脚本
New-Item -ItemType Directory -Path "$stage\deploy" | Out-Null
Copy-Item "$root\deploy\server-setup.sh" "$stage\deploy\server-setup.sh" -Force
Copy-Item "$root\deploy\pet-backend.service" "$stage\deploy\pet-backend.service" -Force
Copy-Item "$root\deploy\nginx-pet.conf" "$stage\deploy\nginx-pet.conf" -Force

# 5) 打 tar.gz（Windows 下用 tar 命令，win10+ 自带 bsdtar）
$tar = Join-Path $root 'deploy\pet-deploy.tar.gz'
if (Test-Path $tar) { Remove-Item $tar }
Push-Location $stage
tar -czf $tar backend dist-share deploy
Pop-Location
$size = [math]::Round((Get-Item $tar).Length / 1MB, 1)
Write-Host "==> 打包完成: $tar ($size MB)"
Write-Host "==> 下一步: scp pet-deploy.tar.gz ubuntu@<IP>:/tmp/ && scp deploy/server-setup.sh ubuntu@<IP>:/tmp/ && ssh ubuntu@<IP> 'sudo bash /tmp/server-setup.sh'"
