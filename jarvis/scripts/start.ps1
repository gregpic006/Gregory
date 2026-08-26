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

# Configuration automatique: ajoute les nouvelles options, active ce qui doit
# l'etre, cree les dossiers manquants. Idempotent — ne change que ce qui doit
# changer, et ne touche jamais a une cle d'API. L'utilisateur n'a donc jamais a
# ouvrir .env a la main.
#
# Rejoue aussi apres une mise a jour: une nouvelle version peut ajouter des
# options a .env, et le processus relance doit les trouver la.
function Invoke-Preparation {
    Write-Host "-> verification de la configuration" -ForegroundColor Cyan
    & $venvPython -m jarvis_core.cli setup --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "Configuration incomplete (voir ci-dessus). JARVIS ne demarre pas." -ForegroundColor Red
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
}

Invoke-Preparation

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

# Boucle de relance: quand JARVIS se met a jour depuis son interface, il quitte
# avec le code 42. Le script le relance alors, ce qui rend la mise a jour
# invisible — un bouton, et l'application revient a jour toute seule.
# Tout autre code de sortie (dont Ctrl+C) arrete pour de bon.
$RESTART = 42
while ($true) {
    & $venvPython -m jarvis_core.cli serve
    $code = $LASTEXITCODE
    if ($code -ne $RESTART) { break }

    Write-Host ""
    Write-Host "-> mise a jour appliquee, redemarrage" -ForegroundColor Cyan
    Write-Host ""
    Start-Sleep -Seconds 1
    Invoke-Preparation
}
