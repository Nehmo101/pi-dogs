# Spike helper: Win32 window lookup / placement / screenshots for pi-dogs layout tests.
# Usage: . <this dir>\Win32Layout.ps1
# All coordinates are physical pixels (process is made per-monitor DPI aware).

if (-not ([System.Management.Automation.PSTypeName]'PiDogs.Win').Type) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace PiDogs {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; public override string ToString(){ return L+","+T+" "+(R-L)+"x"+(B-T); } }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  public class WinInfo { public IntPtr Hwnd; public string Title; public string Cls; public int Pid; public RECT Rect; }
  public static class Win {
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern IntPtr BeginDeferWindowPos(int n);
    [DllImport("user32.dll")] public static extern IntPtr DeferWindowPos(IntPtr hdwp, IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool EndDeferWindowPos(IntPtr hdwp);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    public const uint SWP_NOZORDER=0x4, SWP_NOACTIVATE=0x10, SWP_NOREDRAW=0x8, SWP_ASYNC=0x4000, SWP_FRAMECHANGED=0x20;

    public static void DpiAware(){ SetProcessDpiAwarenessContext(new IntPtr(-4)); } // PER_MONITOR_AWARE_V2

    public static List<WinInfo> Find(string cls){
      var res = new List<WinInfo>();
      EnumWindows((h,p)=>{
        if(!IsWindowVisible(h) && !IsIconic(h)) return true;
        var c=new StringBuilder(256); GetClassName(h,c,256);
        if(cls!=null && c.ToString()!=cls) return true;
        var t=new StringBuilder(512); GetWindowText(h,t,512);
        int pid; GetWindowThreadProcessId(h,out pid);
        RECT r; GetWindowRect(h,out r);
        res.Add(new WinInfo{Hwnd=h,Title=t.ToString(),Cls=c.ToString(),Pid=pid,Rect=r});
        return true;},IntPtr.Zero);
      return res;
    }
    public static RECT Frame(IntPtr h){ RECT r; DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))); return r; } // DWMWA_EXTENDED_FRAME_BOUNDS
    public static RECT Work(IntPtr h){ var mi=new MONITORINFO(); mi.cbSize=Marshal.SizeOf(mi); GetMonitorInfo(MonitorFromWindow(h,2), ref mi); return mi.rcWork; }
    public static RECT Mon(IntPtr h){ var mi=new MONITORINFO(); mi.cbSize=Marshal.SizeOf(mi); GetMonitorInfo(MonitorFromWindow(h,2), ref mi); return mi.rcMonitor; }
    // Place so that the VISIBLE frame (DWM bounds) equals x,y,w,h: compensate invisible resize borders.
    public static void PlaceFlush(IntPtr h,int x,int y,int w,int hh,uint extra){
      RECT wr, fr; GetWindowRect(h,out wr); fr=Frame(h);
      int l=fr.L-wr.L, t=fr.T-wr.T, r=wr.R-fr.R, b=wr.B-fr.B;
      SetWindowPos(h,IntPtr.Zero,x-l,y-t,w+l+r,hh+t+b,SWP_NOZORDER|SWP_NOACTIVATE|extra);
    }
  }
}
'@
}
[PiDogs.Win]::DpiAware() | Out-Null

$script:WT_CLASS = 'CASCADIA_HOSTING_WINDOW_CLASS'
function Get-WtWindows { [PiDogs.Win]::Find($script:WT_CLASS) }
# Wait until a WT window whose title matches $Pattern appears; returns WinInfo.
function Wait-WtWindow([string]$Pattern, [int]$TimeoutMs = 8000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $w = Get-WtWindows | Where-Object { $_.Title -like $Pattern } | Select-Object -First 1
    if ($w) { $w | Add-Member -NotePropertyName FoundMs -NotePropertyValue $sw.ElapsedMilliseconds -Force; return $w }
    Start-Sleep -Milliseconds 25
  }
  throw "window '$Pattern' not found"
}
function Save-WorkAreaShot([string]$Name) {
  $h = (Get-WtWindows | Select-Object -First 1).Hwnd
  $r = [PiDogs.Win]::Work($h)
  $p = (Join-Path $PSScriptRoot "..\..\docs\spike\screens\$Name.png")
  Add-Type -AssemblyName System.Drawing
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = [System.Drawing.Bitmap]::new($w, $hh); $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, [System.Drawing.Size]::new($w, $hh)); $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); $p
}


