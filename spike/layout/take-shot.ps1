# Caller side: launches shot.ps1 in a throwaway WT window and waits for it to finish.
param([string]$Name, [int]$DelayMs = 400)
$done = "$env:TEMP\pi-dogs-shot.done"; Remove-Item $done -ErrorAction SilentlyContinue
wt -w pi-dogs-spikeShot new-tab --title pi-dogs-shot --suppressApplicationTitle -- pwsh -NoLogo -NoProfile -File "$PSScriptRoot\shot.ps1" $Name $DelayMs
for ($i = 0; $i -lt 200 -and -not (Test-Path $done); $i++) { Start-Sleep -Milliseconds 50 }
if (Test-Path $done) { "shot $Name : " + (Get-Content $done) } else { "shot $Name : timeout" }
