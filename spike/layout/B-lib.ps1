# Approach B helpers: one WT window per agent, tiled by us via Win32. Dot-source after Win32Layout.ps1 + A-common.ps1.
$script:Known = @{}   # agent name -> hwnd

# Open a named WT window for an agent and return its HWND. Discovery = new CASCADIA window (not seen before)
# whose title equals the unique, suppressed tab title. Also returns timings.
function Open-Agent([string]$Name, [string]$Mode = 'text', [string]$Color = '#3a7bd5', [string]$Pos = '') {
  $before = @(Get-WtWindows | % { $_.Hwnd })
  $title = "pd-$Name"; Remove-Item "$State\$Name.stop", "$State\$Name.size" -ErrorAction SilentlyContinue
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $posArgs = @(); if ($Pos) { $posArgs = @('--pos', $Pos) }
  wt -w "pi-dogs-spikeB-$Name" @posArgs new-tab --title $title --suppressApplicationTitle --tabColor $Color (PaneCmd $Name $Mode)
  $tWt = $sw.ElapsedMilliseconds
  $hw = $null
  while (-not $hw -and $sw.ElapsedMilliseconds -lt 8000) {
    $hw = Get-WtWindows | ? { $_.Title -eq $title -and $before -notcontains $_.Hwnd } | Select -First 1
    if (-not $hw) { Start-Sleep -m 10 }
  }
  $script:Known[$Name] = $hw.Hwnd
  [pscustomobject]@{ Name = $Name; Hwnd = $hw.Hwnd; WtMs = $tWt; HwndMs = $sw.ElapsedMilliseconds; Rect = "$($hw.Rect)" }
}

# Layout: returns ordered list of @{Name; X; Y; W; H} (visible-frame rects) for main + N agents.
#  kind 'stacked' : main left (MainFrac), agents in one right column, equal heights (2 columns when > MaxPerCol)
#  kind 'columns' : main left, agents as full-height columns to the right (2 rows when > MaxCols)
#  kind 'equalcols': main and agents all equal-width full-height columns
function Get-Layout($Work, [string]$Kind, [string[]]$Agents, [double]$MainFrac = 0.5, [int]$MaxPerCol = 4, [int]$MaxCols = 3) {
  $X = $Work.L; $Y = $Work.T; $W = $Work.R - $Work.L; $H = $Work.B - $Work.T; $n = $Agents.Count
  $out = New-Object System.Collections.ArrayList
  if ($Kind -eq 'equalcols') { $MainFrac = 1.0 / ($n + 1) }
  $mw = [int][math]::Round($W * $MainFrac); if ($n -eq 0) { $mw = $W }
  [void]$out.Add(@{ Name = 'main'; X = $X; Y = $Y; W = $mw; H = $H })
  if ($n -eq 0) { return $out }
  $rx = $X + $mw; $rw = $W - $mw
  if ($Kind -eq 'stacked') { $cols = [math]::Ceiling($n / $MaxPerCol); $rows = [math]::Ceiling($n / $cols) }
  else { $rows = [math]::Ceiling($n / $MaxCols); $cols = [math]::Ceiling($n / $rows) }
  for ($i = 0; $i -lt $n; $i++) {
    if ($Kind -eq 'stacked') { $c = [math]::Floor($i / $rows); $r = $i % $rows; $inCol = [math]::Min($rows, $n - $c * $rows); $rowsHere = $inCol; $colsHere = $cols }
    else { $r = [math]::Floor($i / $cols); $c = $i % $cols; $colsHere = [math]::Min($cols, $n - $r * $cols); $rowsHere = $rows }
    $x0 = $rx + [int][math]::Round($rw * $c / $colsHere); $x1 = $rx + [int][math]::Round($rw * ($c + 1) / $colsHere)
    $y0 = $Y + [int][math]::Round($H * $r / $rowsHere); $y1 = $Y + [int][math]::Round($H * ($r + 1) / $rowsHere)
    [void]$out.Add(@{ Name = $Agents[$i]; X = $x0; Y = $y0; W = $x1 - $x0; H = $y1 - $y0 })
  }
  $out
}

# Apply a layout. Method 'defer' = one BeginDeferWindowPos batch (atomic), 'seq' = SetWindowPos one by one.
# Rects are VISIBLE frame rects; invisible resize borders (DWM extended frame) are compensated.
function Set-Layout($Rects, [string]$Method = 'defer', [uint32]$Extra = 0) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $flags = [PiDogs.Win]::SWP_NOZORDER -bor [PiDogs.Win]::SWP_NOACTIVATE -bor $Extra
  $items = foreach ($r in $Rects) {
    $h = $script:Known[$r.Name]; if (-not $h) { continue }
    if ([PiDogs.Win]::IsIconic($h)) { [PiDogs.Win]::ShowWindow($h, 4) | Out-Null }   # SW_SHOWNOACTIVATE restores without focus
    $wr = New-Object PiDogs.RECT; [void][PiDogs.Win]::GetWindowRect($h, [ref]$wr); $fr = [PiDogs.Win]::Frame($h)
    $l = $fr.L - $wr.L; $t = $fr.T - $wr.T; $rr = $wr.R - $fr.R; $b = $wr.B - $fr.B
    @{ H = $h; X = $r.X - $l; Y = $r.Y - $t; W = $r.W + $l + $rr; Hh = $r.H + $t + $b }
  }
  if ($Method -eq 'defer') {
    $d = [PiDogs.Win]::BeginDeferWindowPos($items.Count)
    foreach ($i in $items) { $d = [PiDogs.Win]::DeferWindowPos($d, $i.H, [IntPtr]::Zero, $i.X, $i.Y, $i.W, $i.Hh, $flags) }
    [void][PiDogs.Win]::EndDeferWindowPos($d)
  } else {
    foreach ($i in $items) { [void][PiDogs.Win]::SetWindowPos($i.H, [IntPtr]::Zero, $i.X, $i.Y, $i.W, $i.Hh, $flags) }
  }
  $sw.ElapsedMilliseconds
}

# Check flushness: returns max gap/overlap in px between the actual visible frames and the requested rects.
function Test-Flush($Rects) {
  $worst = 0
  foreach ($r in $Rects) { $h = $script:Known[$r.Name]; if (-not $h) { continue }; $f = [PiDogs.Win]::Frame($h)
    $d = [math]::Max([math]::Max([math]::Abs($f.L - $r.X), [math]::Abs($f.T - $r.Y)), [math]::Max([math]::Abs(($f.R - $f.L) - $r.W), [math]::Abs(($f.B - $f.T) - $r.H)))
    $worst = [math]::Max($worst, $d) }
  $worst
}
function Sizes { ($args | % { "$_=" + (Get-Size $_) }) -join '  ' }


