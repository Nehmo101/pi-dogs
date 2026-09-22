# Startup + operation latency of the three helper options (find a window, then place 2 windows).
# Args: paths to the built .NET exes and a folder containing node_modules\koffi.
param([string]$JitExe, [string]$AotExe, [string]$KoffiDir, [int]$Runs = 5)
$env:NODE_PATH = Join-Path $KoffiDir 'node_modules'
$place = @('pd-pi1', '1147', '0', '1147', '1392', 'pd-pi2', '2294', '0', '1146', '1392')
function Bench($label, [scriptblock]$sb) {
  $ms = foreach ($i in 1..$Runs) { $sw = [Diagnostics.Stopwatch]::StartNew(); $out = & $sb; $sw.Stop(); $sw.Elapsed.TotalMilliseconds }
  "{0,-34} median {1,6:N0} ms  (min {2:N0}, max {3:N0})   last: {4}" -f $label, (($ms | Sort-Object)[[int]($Runs / 2)]), ($ms | Measure -Minimum).Minimum, ($ms | Measure -Maximum).Maximum, ("$out" -replace '\s+', ' ').Substring(0, [math]::Min(90, "$out".Length))
}
Bench 'pwsh + Add-Type C# (find)' { pwsh -NoLogo -NoProfile -Command ". '$PSScriptRoot\Win32Layout.ps1'; (Get-WtWindows | ? Title -eq 'pd-pi1').Hwnd" }
Bench '.NET 10 JIT exe (find)' { & $JitExe find pd-pi1 }
Bench '.NET 10 JIT exe (place 2)' { & $JitExe place @place }
Bench '.NET 10 NativeAOT exe (find)' { & $AotExe find pd-pi1 }
Bench '.NET 10 NativeAOT exe (place 2)' { & $AotExe place @place }
Bench 'node + koffi (find)' { node "$PSScriptRoot\wtile-koffi.mjs" find pd-pi1 }
Bench 'node + koffi (place 2)' { node "$PSScriptRoot\wtile-koffi.mjs" place @place }
Bench 'node startup only (baseline)' { node -e "0" }
