# Approach B part 2: smoothness (frame bursts), narrower main, focus handling, --pos, focus mode.
# Expects the windows left open by B-test.ps1 (state\hwnds.json).
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
Add-Type -AssemblyName System.Drawing
$j = Get-Content "$State\hwnds.json" | ConvertFrom-Json
foreach ($p in $j.PSObject.Properties) { $script:Known[$p.Name] = [IntPtr][long]$(if ($p.Value.value) { $p.Value.value } else { $p.Value }) }
$m = $script:Known['main']; $work = [PiDogs.Win]::Work($m)
$agents = 'a1', 'a3', 'a4'
foreach ($a in 'a5', 'a6') { [PiDogs.Win]::ShowWindow($script:Known[$a], 6) | Out-Null }
$scr = "$env:TEMP\pi-dogs-frames"; New-Item -ItemType Directory -Force $scr | Out-Null

# capture N frames as fast as possible right after applying a layout; build a downscaled montage
function Burst($label, [scriptblock]$apply, $frames = 8) {
  $W = $work.R - $work.L; $H = $work.B - $work.T
  $bmps = @(); $times = @()
  Raise-Spike; Start-Sleep -m 600
  $sw = [Diagnostics.Stopwatch]::StartNew(); & $apply
  for ($k = 0; $k -lt $frames; $k++) {
    $b = [System.Drawing.Bitmap]::new($W, $H); $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen(0, 0, 0, 0, [System.Drawing.Size]::new($W, $H)); $g.Dispose(); $bmps += $b; $times += $sw.ElapsedMilliseconds
  }
  $tw = 860; $th = [int]($H * $tw / $W); $cols = 2; $rows = [math]::Ceiling($frames / $cols)
  $mont = [System.Drawing.Bitmap]::new($tw * $cols, ($th + 18) * $rows); $g = [System.Drawing.Graphics]::FromImage($mont)
  $g.Clear([System.Drawing.Color]::White); $font = [System.Drawing.Font]::new('Segoe UI', 10)
  for ($k = 0; $k -lt $frames; $k++) {
    $x = ($k % $cols) * $tw; $y = [math]::Floor($k / $cols) * ($th + 18)
    $g.DrawString("$label  frame $k  t=$($times[$k]) ms", $font, [System.Drawing.Brushes]::Black, $x + 4, $y)
    $g.DrawImage($bmps[$k], $x, $y + 18, $tw, $th); $bmps[$k].Dispose()
  }
  $g.Dispose(); $out = Join-Path $PSScriptRoot "..\..\docs\spike\screens\B-smooth-$label.png"; $mont.Save($out); $mont.Dispose()
  "  burst $label frame times: $($times -join ',') ms"
}

"== smoothness: stacked-3 <-> columns-3 transitions"
Set-Layout (Get-Layout $work stacked $agents 0.5) | Out-Null; Start-Sleep -m 800
Burst 'seq' { Set-Layout (Get-Layout $work columns $agents 0.4) 'seq' | Out-Null }
Burst 'defer' { Set-Layout (Get-Layout $work stacked $agents 0.5) 'defer' | Out-Null }
Burst 'defer-noredraw' { Set-Layout (Get-Layout $work columns $agents 0.4) 'defer' ([PiDogs.Win]::SWP_NOREDRAW) | Out-Null }
Burst 'defer-async' { Set-Layout (Get-Layout $work stacked $agents 0.5) 'defer' ([PiDogs.Win]::SWP_ASYNC) | Out-Null }

"== narrower main for columns-3"
foreach ($f in 0.30, 0.33, 0.35) {
  $r = Get-Layout $work columns $agents $f; Set-Layout $r | Out-Null; Start-Sleep -m 900
  "  columns n=3 main=$f  " + (Sizes main a1 a3 a4)
}
Shot 'B-columns-3-main33' | Out-Null
$r = Get-Layout $work columns ($agents + 'a5') 0.30 5 4; Set-Layout $r | Out-Null; Start-Sleep -m 900
"  columns n=4 (4 cols) main=0.30  " + (Sizes main a1 a3 a4 a5)
Shot 'B-columns-4-4cols-main30' | Out-Null
[PiDogs.Win]::ShowWindow($script:Known['a5'], 6) | Out-Null

"== focus: can we hand the foreground back to main after opening a window?"
[PiDogs.Win]::SetForegroundWindow($m) | Out-Null; Start-Sleep -m 300; "  main is fg before: " + ([PiDogs.Win]::GetForegroundWindow() -eq $m)
$o = Open-Agent f1 idle $Colors[5]; Start-Sleep -m 300
"  after open: new is fg=" + ([PiDogs.Win]::GetForegroundWindow() -eq $o.Hwnd)
$ok = [PiDogs.Win]::SetForegroundWindow($m); Start-Sleep -m 200
"  SetForegroundWindow(main) returned $ok, main is fg=" + ([PiDogs.Win]::GetForegroundWindow() -eq $m)
Stop-Pane f1

"== --pos at launch (avoids first frame at the cascade position?)"
$o = Open-Agent p1 idle $Colors[6] '2600,700'; "  requested --pos 2600,700 -> initial rect $($o.Rect) (hwnd after $($o.HwndMs) ms)"
Stop-Pane p1

"== focus mode window (no tab row): rows gained"
$before = @(Get-WtWindows | % { $_.Hwnd })
wt -w pi-dogs-spikeB-fm --focusMode new-tab --title pd-fm --suppressApplicationTitle (PaneCmd fm); Start-Sleep -m 1500
$fm = Get-WtWindows | ? { $before -notcontains $_.Hwnd } | Select -First 1
if ($fm) { $script:Known['fm'] = $fm.Hwnd
  $r = Get-Layout $work stacked @('a1', 'fm', 'a3', 'a4') 0.5; Set-Layout $r | Out-Null; Start-Sleep -m 900
  "  stacked-4 with one focus-mode window: " + (Sizes a1 fm a3 a4); Shot 'B-stacked-4-with-focusmode-window' | Out-Null }
else { "  focus-mode window not found" }
Stop-Pane fm; Start-Sleep -m 800
Set-Layout (Get-Layout $work stacked $agents 0.5) | Out-Null

