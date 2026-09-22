# Final pi screenshots (columns-3, columns 2x2), then close every spike window.
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
$j = Get-Content "$State\hwnds.json" | ConvertFrom-Json
foreach ($p in $j.PSObject.Properties) { $script:Known[$p.Name] = [IntPtr][long]$p.Value.value }
$work = [PiDogs.Win]::Work($script:Known['main'])
[PiDogs.Win]::ShowWindow($script:Known['pi4'], 6) | Out-Null
Set-Layout (Get-Layout $work columns @('pi1', 'pi2', 'pi3') 0.33) | Out-Null; Start-Sleep -m 1500; Shot 'B-pi-columns-3-main33' | Out-Null
Set-Layout (Get-Layout $work columns @('pi1', 'pi2', 'pi3', 'pi4') 0.4) | Out-Null; Start-Sleep -m 1500; Shot 'B-pi-columns-4-2x2-main40' | Out-Null
"windows before cleanup: " + ((Get-WtWindows | % { $_.Title }) -join ' | ')
'main', 'pi1', 'pi2', 'pi3', 'pi4', 'a1', 'a3', 'a4', 'a5', 'a6', 'fm4', 'fm5', 'p1' | % { Stop-Pane $_ }
Start-Sleep 4
Add-Type -Name PM -Namespace X -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
$wtPid = (Get-Process WindowsTerminal).Id
[PiDogs.Win]::Find($null) | ? { $wtPid -contains $_.Pid -and $_.Cls -eq '#32770' } | % { "dialog: $($_.Title)"; [X.PM]::PostMessage($_.Hwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
Start-Sleep 1
"windows after cleanup: " + ((Get-WtWindows | % { $_.Title }) -join ' | ')
"WT dialogs left: " + (([PiDogs.Win]::Find($null) | ? { $wtPid -contains $_.Pid -and $_.Cls -eq '#32770' }) | % Title)
