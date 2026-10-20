# Deploy oncesi hazirlik: lint + syntax check + zip uret (tek komut).
# Kullanim:  powershell -ExecutionPolicy Bypass -File scripts\prepare-deploy.ps1
# Sonrasi:   cPanel File Manager -> Upload + Extract -> Node.js STOP->START
#            -> (CSS/gorsel degistiyse) Cloudflare Purge Everything
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo

Write-Host '1/3 lint:ejs ...' -ForegroundColor Cyan
npm run lint:ejs
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'FAIL: lint:ejs' -ForegroundColor Red; exit 1 }

Write-Host '2/3 node --check server.js ...' -ForegroundColor Cyan
node --check server.js
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'FAIL: server.js sozdizimi' -ForegroundColor Red; exit 1 }

Pop-Location

Write-Host '3/3 deploy zip ...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'deploy-spaceship.ps1')
