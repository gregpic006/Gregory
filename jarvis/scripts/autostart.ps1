# Demarrer JARVIS avec Windows.
#
#   .\scripts\autostart.ps1            -> installe le demarrage automatique
#   .\scripts\autostart.ps1 -Remove    -> le retire
#   .\scripts\autostart.ps1 -Status    -> dit ou ca en est
#
# Utilise le Planificateur de taches plutot que le dossier Demarrage: la tache
# demarre meme sans ouvrir de session interactive, et se relance si elle tombe.
#
# Rien n'est installe en dehors de ton compte utilisateur: pas de service
# systeme, pas de droits administrateur.

param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "JARVIS"

function Get-JarvisTask {
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

if ($Status) {
    $task = Get-JarvisTask
    if ($null -eq $task) {
        Write-Host "Le demarrage automatique n'est pas installe." -ForegroundColor Yellow
        Write-Host "Pour l'installer : .\scripts\autostart.ps1"
        exit 0
    }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "Demarrage automatique : installe" -ForegroundColor Green
    Write-Host "  etat            : $($task.State)"
    Write-Host "  derniere execution : $($info.LastRunTime)"
    Write-Host "  dernier resultat   : $($info.LastTaskResult)"
    exit 0
}

if ($Remove) {
    if ($null -eq (Get-JarvisTask)) {
        Write-Host "Rien a retirer : le demarrage automatique n'etait pas installe."
        exit 0
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Demarrage automatique retire." -ForegroundColor Green
    Write-Host "JARVIS continue de fonctionner quand tu le lances toi-meme."
    exit 0
}

# --- installation ---

$venvPython = Join-Path $root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $venvPython)) {
    # pythonw.exe lance sans fenetre de console; python.exe est le repli.
    $venvPython = Join-Path $root ".venv\Scripts\python.exe"
}
if (-not (Test-Path $venvPython)) {
    Write-Host "Environnement Python absent. Lance d'abord : .\scripts\setup.ps1" -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute $venvPython `
    -Argument "-m jarvis_core.cli serve" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartCount : si JARVIS tombe, Windows le relance trois fois avant d'abandonner.
# StartWhenAvailable : si l'ordinateur etait eteint a l'heure prevue, on rattrape.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

if ($null -ne (Get-JarvisTask)) {
    Write-Host "-> mise a jour de la tache existante"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Description "Assistant personnel JARVIS" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited | Out-Null

Write-Host ""
Write-Host "JARVIS demarrera automatiquement a ta prochaine ouverture de session." -ForegroundColor Green
Write-Host ""
Write-Host "  Adresse       : http://127.0.0.1:8787"
Write-Host "  Verifier      : .\scripts\autostart.ps1 -Status"
Write-Host "  Desinstaller  : .\scripts\autostart.ps1 -Remove"
Write-Host ""
Write-Host "Note : l'interface n'est pas recompilee au demarrage automatique." -ForegroundColor DarkGray
Write-Host "Apres un 'git pull', lance .\scripts\start.ps1 une fois." -ForegroundColor DarkGray
