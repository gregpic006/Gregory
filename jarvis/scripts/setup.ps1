# Installation de JARVIS sous Windows (PowerShell).
#   .\scripts\setup.ps1
$ErrorActionPreference = "Stop"

Write-Host "== JARVIS : installation ==" -ForegroundColor Cyan

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".venv")) {
    # On vise 3.12 en priorite : certaines librairies vocales n'ont pas encore
    # de version compilee pour les toutes dernieres versions de Python.
    $candidates = @(
        @{ Exe = "py";     Arguments = @("-3.12") },
        @{ Exe = "py";     Arguments = @("-3.13") },
        @{ Exe = "py";     Arguments = @("-3.11") },
        @{ Exe = "py";     Arguments = @("-3")    },
        @{ Exe = "python"; Arguments = @()        }
    )

    $chosen = $null
    foreach ($candidate in $candidates) {
        if (-not (Get-Command $candidate.Exe -ErrorAction SilentlyContinue)) { continue }
        $probe = $candidate.Arguments + @("--version")
        & $candidate.Exe @probe 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $chosen = $candidate; break }
    }

    if (-not $chosen) {
        Write-Host "Python 3.11+ introuvable. Installe-le depuis python.org." -ForegroundColor Red
        exit 1
    }

    $label = (@($chosen.Exe) + $chosen.Arguments) -join " "
    Write-Host "-> creation de l'environnement Python ($label)"
    $venvArgs = $chosen.Arguments + @("-m", "venv", ".venv")
    & $chosen.Exe @venvArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Echec de creation de l'environnement virtuel." -ForegroundColor Red
        exit 1
    }
}

$venvPython = ".\.venv\Scripts\python.exe"
$version = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
Write-Host "-> environnement Python $version"
if ([version]$version -lt [version]"3.11") {
    Write-Host "Python 3.11+ est requis (trouve $version)." -ForegroundColor Red
    exit 1
}
if ([version]$version -ge [version]"3.14") {
    Write-Host "   Attention: sur Python $version, faster-whisper peut ne pas s'installer." -ForegroundColor Yellow
    Write-Host "   Pour la voix locale, prefere 3.12 : py install 3.12" -ForegroundColor Yellow
}

Write-Host "-> installation des dependances Python"
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -e ".[anthropic,dev]"

if (-not (Test-Path ".env")) {
    Write-Host "-> creation du fichier .env"
    Copy-Item ".env.example" ".env"
    $key = & $venvPython -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    (Get-Content ".env") -replace "^JARVIS_ENCRYPTION_KEY=.*", "JARVIS_ENCRYPTION_KEY=$key" | Set-Content ".env"
    Write-Host "   cle de chiffrement generee." -ForegroundColor Green
    Write-Host "   Ajoute maintenant ANTHROPIC_API_KEY dans .env." -ForegroundColor Yellow
} else {
    # Un .env existant date d'un jalon anterieur: il lui manque les variables
    # ajoutees depuis. On les ajoute sans jamais toucher aux valeurs en place.
    Write-Host "-> mise a jour du fichier .env"
    & $venvPython -m jarvis_core.cli sync-env
}

Write-Host "-> installation de l'interface"
Set-Location "ui"
npm install
Set-Location $root

Write-Host ""
Write-Host "Termine. Pour demarrer :" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1"
