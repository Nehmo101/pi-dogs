# Spike helper: simulate a user typing into the child's terminal WITHOUT touching window focus.
# Attaches to the target process' console (ConPTY inside Windows Terminal) and writes KEY_EVENT
# records into its input buffer. Usage: pwsh -File inject-keys.ps1 -TargetPid <pid> -Keys "hi{ENTER}" [-CtrlL]
param([int]$TargetPid, [string]$Keys = "", [switch]$CtrlL, [string]$Log = "")
$src = @"
using System;
using System.Runtime.InteropServices;
public static class ConIn {
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode)]
  public struct INPUT_RECORD { [FieldOffset(0)] public ushort EventType; [FieldOffset(4)] public KEY_EVENT_RECORD Key; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct KEY_EVENT_RECORD { public int bKeyDown; public ushort wRepeatCount; public ushort wVirtualKeyCode; public ushort wVirtualScanCode; public char UnicodeChar; public uint dwControlKeyState; }
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr sec, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] r, uint n, out uint w);
  static INPUT_RECORD K(bool down, ushort vk, char c, uint ctrl) { var r = new INPUT_RECORD(); r.EventType = 1; r.Key.bKeyDown = down?1:0; r.Key.wRepeatCount = 1; r.Key.wVirtualKeyCode = vk; r.Key.UnicodeChar = c; r.Key.dwControlKeyState = ctrl; return r; }
  public static string Send(uint pid, string text, bool ctrlL) {
    FreeConsole();
    if (!AttachConsole(pid)) return "AttachConsole failed " + Marshal.GetLastWin32Error();
    IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    var list = new System.Collections.Generic.List<INPUT_RECORD>();
    if (ctrlL) { list.Add(K(true, 0x4C, (char)0x0C, 0x0008)); list.Add(K(false, 0x4C, (char)0x0C, 0x0008)); }
    foreach (char ch in text) { ushort vk = ch == '\r' ? (ushort)0x0D : (ushort)0; list.Add(K(true, vk, ch, 0)); list.Add(K(false, vk, ch, 0)); }
    uint w; bool ok = WriteConsoleInput(h, list.ToArray(), (uint)list.Count, out w);
    FreeConsole();
    return "ok=" + ok + " written=" + w + " err=" + Marshal.GetLastWin32Error();
  }
}
"@
Add-Type -TypeDefinition $src
$text = $Keys.Replace("{ENTER}", "`r").Replace("{ESC}", [string][char]27)
$r = [ConIn]::Send([uint32]$TargetPid, $text, $CtrlL.IsPresent)
if ($Log) { Add-Content -Path $Log -Value "$(Get-Date -Format o) inject pid=$TargetPid ctrlL=$($CtrlL.IsPresent) keys=$Keys -> $r" }
