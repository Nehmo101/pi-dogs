# Approach B spike: open main + 6 agent windows, tile them in many layouts, measure, screenshot.
# Run via Invoke-Desk.ps1.  Output: timings, cols x rows per window, flushness, screenshots B-*.png
param([switch]$NoShots)
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
Clear-State
$agents = 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'

"== open windows (latency: wt.exe return / HWND found)"
$m = Open-Agent main text $Colors[0]; "  main  wt=$($m.WtMs)ms hwnd=$($m.HwndMs)ms initial=$($m.Rect)"
$work = [PiDogs.Win]::Work($m.Hwnd); $mon = [PiDogs.Win]::Mon($m.Hwnd)
"  monitor $mon  work $work  dpi $([PiDogs.Win]::GetDpiForWindow($m.Hwnd))"
$wr = New-Object PiDogs.RECT; [void][PiDogs.Win]::GetWindowRect($m.Hwnd, [ref]$wr); $fr = [PiDogs.Win]::Frame($m.Hwnd)
"  invisible borders L/T/R/B = $($fr.L-$wr.L)/$($fr.T-$wr.T)/$($wr.R-$fr.R)/$($wr.B-$fr.B) px"
Set-Layout (Get-Layout $work stacked @()) | Out-Null
[PiDogs.Win]::SetForegroundWindow($m.Hwnd) | Out-Null; Start-Sleep -m 600
$i = 1
foreach ($a in $agents) {
  $fg0 = [PiDogs.Win]::GetForegroundWindow()
  $o = Open-Agent $a text $Colors[$i]; $i++
  Start-Sleep -m 300
  $fg1 = [PiDogs.Win]::GetForegroundWindow()
  "  $a wt=$($o.WtMs)ms hwnd=$($o.HwndMs)ms initial=$($o.Rect) foreground: main before=$($fg0 -eq $m.Hwnd) after=$($fg1 -eq $m.Hwnd) new-is-fg=$($fg1 -eq $o.Hwnd)"
  # tile immediately so the new window does not linger at its default spot
  $active = $agents[0..($i - 2)]
  Set-Layout (Get-Layout $work stacked $active) | Out-Null
}
Start-Sleep -m 800

function Show-Layout($kind, $n, $frac = 0.5, $shot = $null, $maxCols = 3, $maxPerCol = 4) {
  $act = @($agents[0..($n - 1)])
  foreach ($a in $agents) { if ($act -notcontains $a -and -not [PiDogs.Win]::IsIconic($script:Known[$a])) { [PiDogs.Win]::ShowWindow($script:Known[$a], 6) | Out-Null } }  # SW_MINIMIZE
  $rects = Get-Layout $work $kind $act $frac $maxPerCol $maxCols
  $ms = Set-Layout $rects
  Start-Sleep -m 900
  $flush = Test-Flush $rects
  $line = "  {0,-9} n={1} main={2,4:P0} apply={3}ms flushErr={4}px  " -f $kind, $n, $frac, $ms, $flush
  $line + ((@('main') + $act | % { "$_=" + (Get-Size $_) }) -join ' ')
  if ($shot -and -not $NoShots) { Shot $shot | Out-Null }
}

"== layouts"
foreach ($n in 1..4) { Show-Layout stacked $n 0.5 "B-stacked-$n" }
foreach ($n in 1..4) { Show-Layout columns $n 0.5 "B-columns-$n" }
foreach ($n in 2..4) { Show-Layout columns $n 0.4 }
foreach ($n in 2..4) { Show-Layout equalcols $n 0 "B-equalcols-$n" }
Show-Layout stacked 6 0.5 'B-stacked-6-2cols'
Show-Layout stacked 6 0.4 'B-stacked-6-2cols-main40'
Show-Layout columns 6 0.4 'B-columns-6-2rows-main40'
Show-Layout columns 6 0.5
Show-Layout columns 5 0.4
Show-Layout stacked 5 0.5

"== re-tile when a middle window closes (stacked 4 -> 3), defer vs seq"
Show-Layout stacked 4 0.5 | Out-Null
Stop-Pane a2; $sw = [Diagnostics.Stopwatch]::StartNew()
while ([PiDogs.Win]::Find($WT_CLASS) | ? Hwnd -eq $script:Known['a2']) { Start-Sleep -m 10 }
"  a2 window gone after $($sw.ElapsedMilliseconds) ms (pane exit 0 -> window closes)"
$script:Known.Remove('a2'); $agents = 'a1', 'a3', 'a4', 'a5', 'a6'
if (-not $NoShots) { Shot 'B-retile-0-gap-after-close' | Out-Null }
Show-Layout stacked 3 0.5 'B-retile-1-after'

"== minimize / restore round trip"
$h = $script:Known['a3']; $f0 = [PiDogs.Win]::Frame($h)
[PiDogs.Win]::ShowWindow($h, 6) | Out-Null; Start-Sleep -m 500; "  iconic=$([PiDogs.Win]::IsIconic($h)) fgIsMain=$([PiDogs.Win]::GetForegroundWindow() -eq $m.Hwnd)"
[PiDogs.Win]::ShowWindow($h, 4) | Out-Null; Start-Sleep -m 500; $f1 = [PiDogs.Win]::Frame($h)
"  restored (SW_SHOWNOACTIVATE) iconic=$([PiDogs.Win]::IsIconic($h)) frame before=$f0 after=$f1 fg=$(if([PiDogs.Win]::GetForegroundWindow() -eq $h){'a3'}else{'not a3'})"
[PiDogs.Win]::ShowWindow($h, 6) | Out-Null; Start-Sleep -m 400
[PiDogs.Win]::ShowWindow($h, 9) | Out-Null; Start-Sleep -m 500
"  restored (SW_RESTORE) fg=$(if([PiDogs.Win]::GetForegroundWindow() -eq $h){'a3'}else{'not a3'})"

"== keep open for smoothness test"
$script:Known | ConvertTo-Json | Set-Content "$State\hwnds.json"
