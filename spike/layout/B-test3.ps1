# Approach B part 3: focus-mode window (no tab row) variants.
. $PSScriptRoot\Win32Layout.ps1; . $PSScriptRoot\A-common.ps1; . $PSScriptRoot\B-lib.ps1
Stop-Pane p1
wt --focusMode -w pi-dogs-spikeB-fm3 new-tab --title pd-fm3 --suppressApplicationTitle (PaneCmd fm3)
Start-Sleep -m 2500; "variant1 (--focusMode first): " + (Get-Size fm3)
wt -f -w pi-dogs-spikeB-fm4 new-tab --title pd-fm4 --suppressApplicationTitle (PaneCmd fm4)
Start-Sleep -m 2500; "variant2 (-f first): " + (Get-Size fm4)
wt -w pi-dogs-spikeB-fm5 new-tab --title pd-fm5 --suppressApplicationTitle (PaneCmd fm5)
Start-Sleep -m 2500; "control (no focus mode): " + (Get-Size fm5)
"windows: " + ((Get-WtWindows | % { "$($_.Hwnd):$($_.Title):$($_.Rect)" }) -join ' | ')
