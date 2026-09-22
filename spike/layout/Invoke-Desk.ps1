# Caller side: Invoke-Desk.ps1 <script.ps1>  -> runs it via desk-host.ps1 in WT, waits, prints the log.
param([string]$ScriptPath, [int]$TimeoutSec = 120)
$log = "$ScriptPath.log"; Remove-Item $log -ErrorAction SilentlyContinue
wt -w pi-dogs-spikeDesk new-tab --title pi-dogs-desk --suppressApplicationTitle -- pwsh -NoLogo -NoProfile -File "$PSScriptRoot\desk-host.ps1" $ScriptPath
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
  if ((Test-Path $log) -and ((Get-Content $log -Tail 1) -eq 'done')) { break }
  Start-Sleep -Milliseconds 100
}
Get-Content $log -ErrorAction SilentlyContinue
