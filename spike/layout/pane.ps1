# Stand-in for a sub agent inside a WT pane/window.
#  - writes its console size (cols x rows) to state\<Name>.size whenever it changes
#  - Mode 'text': prints sample text; 'pi': runs pi with a local model; 'idle': just a banner
#  - exits with code 0 (so WT closeOnExit=automatic closes the pane) when state\<Name>.stop appears
param([string]$Name, [string]$Mode = 'text', [string]$Prompt = '')
$state = Join-Path $PSScriptRoot 'state'; New-Item -ItemType Directory -Force $state | Out-Null
$sizeFile = Join-Path $state "$Name.size"; $stopFile = Join-Path $state "$Name.stop"
# (a stale stop file from an earlier run is removed by the caller before launch)
"ENV PIDOGS_ENVTEST=[$env:PIDOGS_ENVTEST] cwd=$(Get-Location)" | Set-Content (Join-Path $state "$Name.env")
function Write-Size { $s = $host.UI.RawUI.WindowSize; "$($s.Width)x$($s.Height)" | Set-Content $sizeFile; $s }
$last = Write-Size
if ($Mode -eq 'pi') {
  if (-not $Prompt -and (Test-Path "$state\prompt.txt")) { $Prompt = Get-Content "$state\prompt.txt" -Raw }
  $p = Start-Process -NoNewWindow -PassThru pi.cmd -ArgumentList (@('--model', 'ollama/qwen3.5:4b') + ($(if ($Prompt) { @("`"$Prompt`"") } else { @() })))
  while (-not $p.HasExited -and -not (Test-Path $stopFile)) { Start-Sleep -m 250; $s = $host.UI.RawUI.WindowSize; if ("$s" -ne "$last") { $last = Write-Size } }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force; Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
  exit 0
}
$sample = Get-Content (Join-Path $PSScriptRoot '..\..\docs\PLAN.md') -TotalCount 120
function Show {
  Clear-Host; $s = $host.UI.RawUI.WindowSize
  Write-Host (" [$Name] {0} cols x {1} rows " -f $s.Width, $s.Height) -BackgroundColor DarkCyan -ForegroundColor White
  if ($Mode -eq 'text') { $sample | Select-Object -First ($s.Height - 3) | % { if ($_.Length -gt $s.Width - 1) { $_.Substring(0, $s.Width - 1) } else { $_ } } }
}
Show
while (-not (Test-Path $stopFile)) {
  Start-Sleep -m 200
  $s = $host.UI.RawUI.WindowSize; if ("$s" -ne "$last") { $last = Write-Size; Show }
}
exit 0



