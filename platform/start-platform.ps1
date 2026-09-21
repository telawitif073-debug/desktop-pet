# 平台一键启动：PostgreSQL（便携版）→ 后端（NestJS 3001）→ 前端（vite 5174）
# 幂等：已在运行的服务自动跳过；关闭对应窗口即可停止服务。

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pgBin = Join-Path $root '.pg\pgsql\bin'
$pgData = Join-Path $root '.pg\data'
$pgLog = Join-Path $root '.pg\logs\pg.log'

function Test-Port([int]$port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (Test-Port $port)
}

# 1/3 PostgreSQL
if (Test-Port 5432) {
  Write-Host '[1/3] PostgreSQL already running (5432)'
} else {
  Write-Host '[1/3] Starting PostgreSQL...'
  & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -l $pgLog start
  if (Wait-Port 5432 20) { Write-Host '      PostgreSQL ready (5432)' }
  else { Write-Warning 'PostgreSQL failed to start, check log: .pg\logs\pg.log'; exit 1 }
}

# 2/3 Backend
if (Test-Port 3001) {
  Write-Host '[2/3] Backend already running (3001)'
} else {
  Write-Host '[2/3] Starting backend (NestJS, port 3001)...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run start:dev' `
    -WorkingDirectory (Join-Path $root 'backend') -WindowStyle Minimized
  if (Wait-Port 3001 60) { Write-Host '      Backend ready (3001)' }
  else { Write-Warning 'Backend did not start within 60s, check the minimized backend window' }
}

# 3/3 Frontend
if (Test-Port 5174) {
  Write-Host '[3/3] Frontend already running (5174)'
} else {
  Write-Host '[3/3] Starting frontend (vite, port 5174)...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
    -WorkingDirectory (Join-Path $root 'frontend') -WindowStyle Minimized
  if (Wait-Port 5174 30) { Write-Host '      Frontend ready (5174)' }
  else { Write-Warning 'Frontend did not start within 30s, check the minimized frontend window' }
}

Write-Host ''
Write-Host 'Platform ready: store UI http://localhost:5174 | API http://localhost:3001/api'
Write-Host 'Open the store from the desktop pet right-click menu. Close the minimized windows to stop services.'
