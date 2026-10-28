# Creates a "HackDay Notes" shortcut on the desktop that runs scripts\launch.bat with the app icon.
$root = Split-Path $PSScriptRoot -Parent
$desktop = [Environment]::GetFolderPath("Desktop")
$link = Join-Path $desktop "HackDay Notes.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $root "scripts\launch.bat"
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = (Join-Path $root "web\assets\icon\app.ico") + ",0"
$shortcut.Description = "Digitise handwritten notes and get quizzed, offline with Gemma"
$shortcut.WindowStyle = 1   # normal: shows loading progress (or errors), closes itself once the app opens
$shortcut.Save()
Write-Host "Shortcut created: $link"
