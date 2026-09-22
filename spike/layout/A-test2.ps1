# Approach A, part 2: equal 4-stack via pre-computed fractions; move-pane back from parking tab.
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1
Clear-State
function Sizes { ($args | % { "$_=" + (Get-Size $_) }) -join '  ' }
$W = 'pi-dogs-spikeA3'
wt -w $W new-tab --title pd-main4 --suppressApplicationTitle --tabColor $Colors[0] (PaneCmd m4) `; split-pane -V --size 0.5 --title pd-e1 --suppressApplicationTitle --tabColor $Colors[1] (PaneCmd e1) `; split-pane -H --size 0.75 --title pd-e2 --suppressApplicationTitle --tabColor $Colors[2] (PaneCmd e2) `; split-pane -H --size 0.6667 --title pd-e3 --suppressApplicationTitle --tabColor $Colors[3] (PaneCmd e3) `; split-pane -H --size 0.5 --title pd-e4 --suppressApplicationTitle --tabColor $Colors[4] (PaneCmd e4)
$w = Wait-WtWindow 'pd-*'; Start-Sleep -m 800; $h = $w.Hwnd
[PiDogs.Win]::PlaceFlush($h, 0, 0, 3440, 1392, 0); Start-Sleep -m 1500
"4 equal: " + (Sizes m4 e1 e2 e3 e4); Shot 'A-6-main+4sub-equal-precomputed'
"== park e2 (focus-pane -t 2, move-pane --tab 1), then bring it back (move-pane --tab 0)"
wt -w $W focus-pane --target 2; Start-Sleep -m 400
wt -w $W move-pane --tab 1; Start-Sleep -m 1000
"parked: " + (Sizes m4 e1 e2 e3 e4)
wt -w $W focus-tab --target 0; Start-Sleep -m 300; wt -w $W focus-pane --target 0; Start-Sleep -m 300
"title (focused) = " + (Get-WtWindows | ? Hwnd -eq $h).Title
wt -w $W focus-tab --target 1; Start-Sleep -m 300
wt -w $W move-pane --tab 0; Start-Sleep -m 1200
"restored: " + (Sizes m4 e1 e2 e3 e4); Shot 'A-7-after-park-and-restore'
'm4', 'e1', 'e2', 'e3', 'e4' | % { Stop-Pane $_ }; Start-Sleep -m 2000
"remaining: " + ((Get-WtWindows | % Title) -join ' | ')
