# Shared helpers for approach A (panes in one WT window). Dot-source after Win32Layout.ps1.
$L = $PSScriptRoot; $State = "$L\state"
$Colors = @('#3a7bd5', '#d5533a', '#3ab56a', '#b53ad5', '#d5b43a', '#3ac4d5', '#d53a8a')
function PaneCmd($name, $mode = 'text') { @('--', 'pwsh', '-NoLogo', '-NoProfile', '-File', "$L\pane.ps1", '-Name', $name, '-Mode', $mode) }
function Clear-State { Remove-Item "$State\*" -ErrorAction SilentlyContinue }
function Wait-Size($name, $ms = 8000) { $f = "$State\$name.size"; $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path $f) -and $sw.ElapsedMilliseconds -lt $ms) { Start-Sleep -m 20 }; $sw.ElapsedMilliseconds }
function Get-Size($name) { Get-Content "$State\$name.size" -ErrorAction SilentlyContinue }
function Stop-Pane($name) { New-Item -ItemType File -Force "$State\$name.stop" | Out-Null }
function Raise-Spike { Get-WtWindows | ? Title -like 'pd-*' | % { [PiDogs.Win]::SetWindowPos($_.Hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x13) | Out-Null } }
function Shot($name) { Raise-Spike; Start-Sleep -m 350; Save-WorkAreaShot $name | Out-Null; "  screenshot $name.png" }
function Win-Title($hwnd) { (Get-WtWindows | ? Hwnd -eq $hwnd).Title }

