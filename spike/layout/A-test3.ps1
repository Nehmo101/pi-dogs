# Approach A, part 3: does -w <name> targeting work after a chained creation command?
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1
Clear-State
# (re-run: tests reuse of a window name whose window was closed before)
Add-Type -AssemblyName System.Windows.Forms
$stray = Get-WtWindows | ? Title -eq 'Windows PowerShell'
foreach ($s in $stray) { [PiDogs.Win]::SetForegroundWindow($s.Hwnd) | Out-Null; Start-Sleep -m 300; if ([PiDogs.Win]::GetForegroundWindow() -eq $s.Hwnd) { [System.Windows.Forms.SendKeys]::SendWait("exit{ENTER}"); "closed stray" } }
Start-Sleep -m 800
function Count { (Get-WtWindows | ? Title -ne 'pi-dogs-desk').Count }
"windows before: $(Count)"
wt -w pi-dogs-spikeA5 new-tab --title pd-c0 --suppressApplicationTitle (PaneCmd c0) `; split-pane -V --size 0.5 --title pd-c1 --suppressApplicationTitle (PaneCmd c1)
$w = Wait-WtWindow 'pd-c*'; Start-Sleep -m 2000; "after chained create: $(Count), title $((Get-WtWindows | ? Hwnd -eq $w.Hwnd).Title)"
wt -w pi-dogs-spikeA5 focus-pane --target 0; Start-Sleep -m 800
"after focus-pane -t 0: $(Count), title $((Get-WtWindows | ? Hwnd -eq $w.Hwnd).Title)"
wt -w pi-dogs-spikeA5 split-pane -H --title pd-c2 --suppressApplicationTitle (PaneCmd c2); Start-Sleep -m 1200
"after split: $(Count), sizes c0=$(Get-Size c0) c1=$(Get-Size c1) c2=$(Get-Size c2)"
'c0','c1','c2' | % { Stop-Pane $_ }; Start-Sleep -m 2000
"remaining: " + ((Get-WtWindows | % Title) -join ' | ')
