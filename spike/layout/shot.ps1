# Screenshot of the primary work area. Must run on the interactive desktop (the agent sandbox cannot
# CopyFromScreen), so it is launched through wt:  pwsh -File take-shot.ps1 <name>
param([string]$Name, [int]$DelayMs = 400)
. $PSScriptRoot\Win32Layout.ps1
# hide our own shooter window off-screen first
$me = $null; for ($i = 0; $i -lt 100 -and -not $me; $i++) { $me = Get-WtWindows | ? Title -eq 'pi-dogs-shot'; if (-not $me) { Start-Sleep -m 20 } }
if ($me) { [PiDogs.Win]::SetWindowPos($me.Hwnd, [IntPtr]::Zero, -20000, -20000, 400, 300, 0x14) | Out-Null }
# raise our spike windows (titles start with 'pd-') above everything else, without activating
Get-WtWindows | ? Title -like 'pd-*' | % { [PiDogs.Win]::SetWindowPos($_.Hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x13) | Out-Null }
Start-Sleep -Milliseconds $DelayMs
try { Save-WorkAreaShot $Name | Out-Null; "ok" | Set-Content "$env:TEMP\pi-dogs-shot.done" }
catch { "$_" | Set-Content "$env:TEMP\pi-dogs-shot.done" }
