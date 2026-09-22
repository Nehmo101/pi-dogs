# Approach B part 4: real pi (ollama/qwen3.5:4b) in tiled windows, stacked vs columns, 2..4 agents.
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
$j = Get-Content "$State\hwnds.json" | ConvertFrom-Json
$script:Known['main'] = [IntPtr][long]$j.main.value
'pi1', 'pi2', 'pi3', 'pi4' | % { Stop-Pane $_ }
# close the WT error dialog left by the failed --focusMode launch
Add-Type -Name PM -Namespace X -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
[PiDogs.Win]::Find($null) | ? { $_.Title -eq 'Error' -and (Get-Process -Id $_.Pid).Name -eq 'WindowsTerminal' } | % { [X.PM]::PostMessage($_.Hwnd, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; '  closed WT error dialog' }
Start-Sleep -m 1500
$work = [PiDogs.Win]::Work($script:Known['main'])
$prompt = 'Explain in detail, with a markdown table and a code example, how a binary heap works. Do not use tools.'
$prompt.Trim() | Set-Content "$State\prompt.txt"
$agents = 'pi1', 'pi2', 'pi3', 'pi4'; $k = 1
foreach ($a in $agents) { $o = Open-Agent $a pi $Colors[$k] ; $k++; "  $a hwnd after $($o.HwndMs) ms"
}
Set-Layout (Get-Layout $work stacked $agents 0.5) | Out-Null
"waiting for pi output..."; Start-Sleep 120
function Take($kind, $n, $frac, $name, $maxCols = 3) {
  $act = @($agents[0..($n - 1)])
  foreach ($a in $agents) { if ($act -notcontains $a -and -not [PiDogs.Win]::IsIconic($script:Known[$a])) { [PiDogs.Win]::ShowWindow($script:Known[$a], 6) | Out-Null } }
  Set-Layout (Get-Layout $work $kind $act $frac 4 $maxCols) | Out-Null; Start-Sleep -m 1500
  "  $name  " + ((@('main') + $act | % { "$_=" + (Get-Size $_) }) -join ' '); Shot $name | Out-Null
}
Take stacked 2 0.5 'B-pi-stacked-2'
Take columns 2 0.5 'B-pi-columns-2'
Take stacked 3 0.5 'B-pi-stacked-3'
Take columns 3 0.33 'B-pi-columns-3-main33'
Take stacked 4 0.5 'B-pi-stacked-4'
Take columns 4 0.4 'B-pi-columns-4-2x2-main40'
Take columns 4 0.30 'B-pi-columns-4-4cols-main30' 4
$script:Known | ConvertTo-Json | Set-Content "$State\hwnds.json"


