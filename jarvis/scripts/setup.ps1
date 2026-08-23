# Installation de JARVIS sous Windows (PowerShell).
#   .\scripts\setup.ps1
$ErrorActionPreference = "Stop"

Write-Host "== JARVIS : installation ==" -ForegroundColor Cyan

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".venv")) {
    Write-Host "-> creation de l'environnement Python"
    python -m venv .venv
}

Write-Host "-> installation des dependances Python"
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[anthropic,dev]"

if (-not (Test-Path ".env")) {
    Write-Host "-> creation du fichier .env"
    Copy-Item ".env.example" ".env"
    $key = .\.venv\Scripts\python.exe -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    (Get-Content ".env") -replace "^JARVIS_ENCRYPTION_KEY=.*", "JARVIS_ENCRYPTION_KEY=$key" | Set-Content ".env"
    Write-Host "   cle de chiffrement generee." -ForegroundColor Green
    Write-Host "   Ajoute maintenant ANTHROPIC_API_KEY dans .env." -ForegroundColor Yellow
}

Write-Host "-> installation de l'interface"
Set-Location "ui"
npm install
Set-Location $root

Write-Host ""
Write-Host "Termine. Pour demarrer :" -ForegroundColor Green
Write-Host "  .\scripts\dev.ps1"
