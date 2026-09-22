// Minimal window-tiling helper for the pi-dogs spike.
// Usage: wtile find <title>            -> prints hwnd, rect, frame, work area, dpi
//        wtile place <title> x y w h ... -> places windows (visible frame rects, flush) in one DeferWindowPos batch
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

static class P {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cb; public RECT mon, work; public int flags; }
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr BeginDeferWindowPos(int n);
  [DllImport("user32.dll")] static extern IntPtr DeferWindowPos(IntPtr d, IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool EndDeferWindowPos(IntPtr d);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);

  static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static int Main(string[] a) {
    if (a.Length >= 2 && a[0] == "find") {
      var h = Find(a[1]); if (h == IntPtr.Zero) { Console.WriteLine("notfound"); return 1; }
      GetWindowRect(h, out var r); DwmGetWindowAttribute(h, 9, out var f, 16);
      var mi = new MONITORINFO { cb = Marshal.SizeOf<MONITORINFO>() }; GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
      Console.WriteLine($"{h} rect={r.L},{r.T},{r.R},{r.B} frame={f.L},{f.T},{f.R},{f.B} work={mi.work.L},{mi.work.T},{mi.work.R},{mi.work.B} dpi={GetDpiForWindow(h)}");
      return 0;
    }
    if (a.Length >= 6 && a[0] == "place") {
      var items = new List<(IntPtr, int, int, int, int)>();
      for (int i = 1; i + 4 < a.Length; i += 5) {
        var h = Find(a[i]); if (h == IntPtr.Zero) continue;
        int x = int.Parse(a[i + 1]), y = int.Parse(a[i + 2]), w = int.Parse(a[i + 3]), hh = int.Parse(a[i + 4]);
        GetWindowRect(h, out var r); DwmGetWindowAttribute(h, 9, out var f, 16);
        int l = f.L - r.L, t = f.T - r.T, rr = r.R - f.R, b = r.B - f.B;
        items.Add((h, x - l, y - t, w + l + rr, hh + t + b));
      }
      var d = BeginDeferWindowPos(items.Count);
      foreach (var it in items) d = DeferWindowPos(d, it.Item1, IntPtr.Zero, it.Item2, it.Item3, it.Item4, it.Item5, 0x14);
      EndDeferWindowPos(d); Console.WriteLine($"placed {items.Count}"); return 0;
    }
    Console.WriteLine("usage: wtile find <title> | wtile place <title> x y w h [...]"); return 2;
  }
}
