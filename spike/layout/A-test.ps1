# Approach A spike: panes in ONE WT window. Run via Invoke-Desk.ps1 (needs interactive desktop).
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1
Clear-State
$W = 'pi-dogs-spikeA'
function T { Start-Sleep -m 700; "  focused pane (window title) = " + (Win-Title $script:h) }
function Sizes { ($args | % { "$_=" + (Get-Size $_) }) -join '  ' }

"== open main"
wt -w $W new-tab --title pd-main --suppressApplicationTitle --tabColor $Colors[0] (PaneCmd main)
$win = Wait-WtWindow 'pd-main*'; $script:h = $win.Hwnd; Start-Sleep -m 500
[PiDogs.Win]::PlaceFlush($h, 0, 0, 3440, 1392, 0); [void](Wait-Size main); Start-Sleep -m 500

"== env inheritance: caller sets PIDOGS_ENVTEST before wt split-pane"
$env:PIDOGS_ENVTEST = 'from-caller'
$fgBefore = [PiDogs.Win]::GetForegroundWindow()
$sw = [Diagnostics.Stopwatch]::StartNew()
wt -w $W split-pane -V --size 0.5 --title pd-sub1 --suppressApplicationTitle --tabColor $Colors[1] -d $env:USERPROFILE (PaneCmd sub1)
"  wt returned in $($sw.ElapsedMilliseconds) ms; pane process up after $(Wait-Size sub1) ms more"
T; "  foreground window unchanged: " + ($fgBefore -eq [PiDogs.Win]::GetForegroundWindow())
Start-Sleep -m 300; "  sub1 env: " + (Get-Content "$State\sub1.env"); "  " + (Sizes main sub1)
Shot 'A-1-main+1sub'

"== second split (-H 0.5) -> 2 equal"
wt -w $W split-pane -H --size 0.5 --title pd-sub2 --suppressApplicationTitle (PaneCmd sub2); [void](Wait-Size sub2); T
"  " + (Sizes main sub1 sub2); Shot 'A-2-main+2sub'

"== third split, incremental (-H 0.5 on focused sub2) -> 1/2,1/4,1/4"
wt -w $W split-pane -H --size 0.5 --title pd-sub3 --suppressApplicationTitle (PaneCmd sub3); [void](Wait-Size sub3); T
Start-Sleep -m 300; "  " + (Sizes main sub1 sub2 sub3); Shot 'A-3-incremental-unequal'

"== move-focus / focus-pane / swap-pane"
wt -w $W move-focus up; T
wt -w $W focus-pane --target 0; T
wt -w $W focus-pane --target 2; T
wt -w $W swap-pane down; T; Start-Sleep -m 400; "  after swap: " + (Sizes sub1 sub2 sub3)

"== middle pane (sub2) exits -> who gets the space?"
Stop-Pane sub2; Start-Sleep -m 1500; "  " + (Sizes main sub1 sub3); Shot 'A-4-after-middle-exit'

"== move-pane: move focused pane to new tab 1 (parking)"
wt -w $W focus-pane --target 1; T
wt -w $W move-pane --tab 1; Start-Sleep -m 1200; T; "  " + (Sizes main sub1 sub3); Shot 'A-5-after-move-pane'
wt -w $W focus-tab --target 0; T

"== wrong-window check: activate another WT window, then split into $W"
wt -w pi-dogs-spikeA2 new-tab --title pd-other --suppressApplicationTitle (PaneCmd other idle)
$o = Wait-WtWindow 'pd-other*'; Start-Sleep -m 600
[PiDogs.Win]::SetWindowPos($o.Hwnd, [IntPtr]::Zero, 1200, 300, 900, 600, 0x4) | Out-Null
"  foreground is other window: " + ([PiDogs.Win]::GetForegroundWindow() -eq $o.Hwnd)
wt -w $W split-pane -H --size 0.5 --title pd-sub4 --suppressApplicationTitle (PaneCmd sub4); [void](Wait-Size sub4); Start-Sleep -m 500
"  other window title after split: " + (Win-Title $o.Hwnd) + " ; spikeA title: " + (Win-Title $h) + " ; fg now: " + ([PiDogs.Win]::GetForegroundWindow())
"  " + (Sizes main sub1 sub3 sub4)
Stop-Pane other

"== fresh window with pre-computed fractions for 4 equal (0.5 | 0.75, 0.6667, 0.5)"
wt -w pi-dogs-spikeA3 new-tab --title pd-main4 --suppressApplicationTitle --tabColor $Colors[0] (PaneCmd m4) `; split-pane -V --size 0.5 --title pd-e1 --suppressApplicationTitle --tabColor $Colors[1] (PaneCmd e1) `; split-pane -H --size 0.75 --title pd-e2 --suppressApplicationTitle --tabColor $Colors[2] (PaneCmd e2) `; split-pane -H --size 0.6667 --title pd-e3 --suppressApplicationTitle --tabColor $Colors[3] (PaneCmd e3) `; split-pane -H --size 0.5 --title pd-e4 --suppressApplicationTitle --tabColor $Colors[4] (PaneCmd e4)
$w3 = Wait-WtWindow 'pd-*' ; Start-Sleep -m 800
$w3 = Get-WtWindows | ? { $_.Hwnd -ne $h -and $_.Title -like 'pd-*' } | Select -First 1
[PiDogs.Win]::PlaceFlush($w3.Hwnd, 0, 0, 3440, 1392, 0); Start-Sleep -m 1500
"  " + (Sizes m4 e1 e2 e3 e4); Shot 'A-6-main+4sub-equal'

"== cleanup"
'main', 'sub1', 'sub3', 'sub4', 'm4', 'e1', 'e2', 'e3', 'e4' | % { Stop-Pane $_ }
Start-Sleep -m 2500
"  remaining WT windows: " + ((Get-WtWindows | % Title) -join ' | ')
