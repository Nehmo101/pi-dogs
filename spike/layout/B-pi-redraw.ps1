# Checks whether pi repaints fully after a resize: re-layout stacked-3, screenshot after 0.3 s and 5 s.
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
$j = Get-Content "$State\hwnds.json" | ConvertFrom-Json
foreach ($p in $j.PSObject.Properties) { $script:Known[$p.Name] = [IntPtr][long]$p.Value.value }
$work = [PiDogs.Win]::Work($script:Known['main'])
[PiDogs.Win]::ShowWindow($script:Known['pi4'], 6) | Out-Null
Set-Layout (Get-Layout $work stacked @('pi1', 'pi2', 'pi3') 0.5) | Out-Null
Start-Sleep -m 300; Shot 'B-pi-redraw-0300ms' | Out-Null
Start-Sleep 5; Shot 'B-pi-redraw-5s' | Out-Null
"fg title: " + ((Get-WtWindows | ? Hwnd -eq ([PiDogs.Win]::GetForegroundWindow())).Title)
