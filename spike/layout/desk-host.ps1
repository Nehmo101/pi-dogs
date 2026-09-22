# Runs a script on the interactive desktop (inside a throwaway WT window titled 'pi-dogs-desk' that
# first moves itself off-screen). Needed because the agent sandbox has no input desktop access
# (GetForegroundWindow()=0, CopyFromScreen fails). Output goes to <script>.log.
param([string]$ScriptPath)
. $PSScriptRoot\Win32Layout.ps1
$me = $null; for ($i = 0; $i -lt 100 -and -not $me; $i++) { $me = Get-WtWindows | ? Title -eq 'pi-dogs-desk'; if (-not $me) { Start-Sleep -m 20 } }
if ($me) { [PiDogs.Win]::SetWindowPos($me.Hwnd, [IntPtr]::Zero, -20000, -20000, 400, 300, 0x14) | Out-Null; $global:DeskHwnd = $me.Hwnd }
try { & $ScriptPath *>&1 | Out-String -Width 250 | Set-Content "$ScriptPath.log" }
catch { "ERROR: $_" | Add-Content "$ScriptPath.log" }
"done" | Add-Content "$ScriptPath.log"
