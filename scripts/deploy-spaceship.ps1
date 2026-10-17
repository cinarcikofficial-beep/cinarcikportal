# Spaceship shared hosting icin deploy paketi uretir.
# Kullanim:  powershell -ExecutionPolicy Bypass -File scripts\deploy-spaceship.ps1
# Cikti:     %TEMP%\opencode\cinarcik-deploy.zip
# Sonrasi:   cPanel File Manager -> app root (/home/<user>/marmaraninincisi.com)
#            -> Upload + Extract -> (package.json degistiyse) Run NPM Install
#            -> Node.js App panelinde Restart.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $env:TEMP 'opencode'
$stage = Join-Path $outDir 'cinarcik-deploy'
$zip = Join-Path $outDir 'cinarcik-deploy.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

# Gereksiz/tehlikeli seyler paketlenmez: node_modules, git, lokal db, loglar,
# gizli anahtar disindaki her sey (.env BILEREK girer - hosting'de lazim).
$xd = @('node_modules', '.git', '.opencode', 'data')
$xf = @('*.log', 'cookies.txt', 'snake.html')

robocopy $repo $stage /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy hata kodu: $LASTEXITCODE" }

# Bos lokal uploads mirror'i kalmasin (R2 kaynak); server.js acilista olusturur.
$uploads = Join-Path $stage 'public\img\uploads'
if (Test-Path $uploads) { Remove-Item $uploads -Recurse -Force }

# Guvenlik kontrolleri: server.js + db/index.js yerinde olmali.
if (-not (Test-Path (Join-Path $stage 'server.js'))) { throw 'server.js paketlenemedi' }
if (-not (Test-Path (Join-Path $stage 'db\index.js'))) { throw 'db/index.js paketlenemedi' }

# db/cinarcik.db fallback olarak PAKETE GIRER: Turso erisilemez bir anda
# deploy sirasinda site bos DB ile acilmasin. (Asil kaynak yine Turso'dur;
# acilista mergeCloudBuffer ikisini birlestirir. Lokal dosyanin page_views
# kirliligi raporlara yansir, veri kaybina yol acmaz.)
$localDb = Join-Path $repo 'db\cinarcik.db'
if (-not (Test-Path $localDb)) {
  Write-Host 'UYARI: lokal db/cinarcik.db yok - paket DB olmadan uretiliyor (Turso zorunlu).' -ForegroundColor Yellow
}

# .NET ZipFile: forward-slash path yazar (Compress-Archive backslash kullanir,
# bazi extractor'lar bozabilir).
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "OK: $zip ($mb MB)" -ForegroundColor Green
Write-Host ''
Write-Host 'Siradaki adimlar:' -ForegroundColor Cyan
Write-Host '  1. cPanel File Manager -> /home/svclrphtsu/marmaraninincisi.com'
Write-Host '  2. Upload -> bu zip -> Extract'
Write-Host "  3. package.json degistiyse: Node.js App -> Run NPM Install"
Write-Host '  4. Node.js App -> STOP APP -> START (Restart yetmiyor; Extract Passenger bagini koparir)'
Write-Host '  5. https://marmaraninincisi.com smoke test'
Write-Host '  6. CSS/JS/gorsel degistiyse -> Cloudflare -> Caching -> Purge Everything'
