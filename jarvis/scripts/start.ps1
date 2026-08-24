# Demarrage de JARVIS en une seule commande.
#
#   .\scripts\start.ps1
#
# Compile l'interface si necessaire, lance le serveur, ouvre le navigateur.
# Un seul terminal, un seul processus: l'API sert aussi l'interface.
# Pour developper avec rechargement a chaud, utiliser dev.ps1 a la place.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$venvPython = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Environnement absent. Lance d'abord: .\scripts\setup.ps1" -ForegroundColor Red
    exit 1
}

# L'interface est recompilee seulement si les sources ont bouge depuis le build.
$dist = "ui\dist\index.html"
$needsBuild = -not (Test-Path $dist)
if (-not $needsBuild) {
    $built = (Get-Item $dist).LastWriteTime
    $newest = Get-ChildItem "ui\src", "ui\index.html", "ui\package.json" -Recurse -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest -and $newest.LastWriteTime -gt $built) { $needsBuild = $true }
}
if ($needsBuild) {
    Write-Host "-> compilation de l'interface" -ForegroundColor Cyan
    Push-Location "ui"
    if (-not (Test-Path "node_modules")) { npm install }
    npm run build
    Pop-Location
}

# Le port vient de .env; 8787 par defaut.
$port = 8787
if (Test-Path ".env") {
    $line = Select-String -Path ".env" -Pattern "^JARVIS_PORT=(\d+)" | Select-Object -First 1
    if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
}

Write-Host ""
Write-Host "JARVIS demarre sur http://127.0.0.1:$port" -ForegroundColor Green
Write-Host "Ctrl+C pour arreter." -ForegroundColor DarkGray
Write-Host ""

Start-Job -ScriptBlock {
    param($url)
    Start-Sleep -Seconds 3
    Start-Process $url
} -ArgumentList "http://127.0.0.1:$port" | Out-Null

& $venvPython -m jarvis_core.cli serve
