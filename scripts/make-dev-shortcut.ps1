# Creates a Desktop shortcut that launches the Ironbooks dev app (npm run desktop)
# in one click. For DEVELOPERS only — end users should install the packaged app (see INSTALL.md).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot           # project root (parent of /scripts)
$launcher = Join-Path $root 'scripts\launch-dev.cmd'

# A tiny launcher that opens the project and starts the single-command dev desktop.
$cmd = "@echo off`r`ntitle Ironbooks`r`ncd /d `"$root`"`r`ncall npm run desktop`r`n"
Set-Content -Path $launcher -Value $cmd -Encoding ASCII

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Ironbooks (Dev).lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = "$env:WINDIR\System32\cmd.exe"
$sc.Arguments = "/c `"$launcher`""
$sc.WorkingDirectory = $root
$sc.Description = 'Launch Ironbooks (development build)'
# Use the packaged app icon if a build exists; otherwise default icon.
$ico = Join-Path $root 'build\icon.ico'
if (Test-Path $ico) { $sc.IconLocation = $ico }
$sc.Save()

Write-Output "Created desktop shortcut: $lnkPath"
Write-Output "Double-click 'Ironbooks (Dev)' on your Desktop to launch the app."
