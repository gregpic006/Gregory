# Lance le backend et l'interface en mode developpement (deux fenetres).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "-> API sur http://127.0.0.1:8787"
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root'; .\.venv\Scripts\python.exe -m jarvis_core.cli serve"
)

Start-Sleep -Seconds 2

Write-Host "-> interface sur http://localhost:5173"
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$root\ui'; npm run dev"
)

Start-Sleep -Seconds 3
Start-Process "http://localhost:5173"
