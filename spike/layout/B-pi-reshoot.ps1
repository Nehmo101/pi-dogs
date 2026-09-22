# Re-take the pi layout screenshots with the pi windows opened by B-test4.ps1 (after the model produced output).
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
$j = Get-Content "$State\hwnds.json" | ConvertFrom-Json
foreach ($p in $j.PSObject.Properties) { $script:Known[$p.Name] = [IntPtr][long]$p.Value.value }
$work = [PiDogs.Win]::Work($script:Known['main']); $agents = 'pi1', 'pi2', 'pi3', 'pi4'
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
