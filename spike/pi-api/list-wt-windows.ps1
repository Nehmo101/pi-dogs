# Read-only: list top-level Windows Terminal windows and their titles (to verify our own window closed).
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static List<string> List() { var r = new List<string>(); EnumWindows((h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256);
    if (c.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") { var t = new StringBuilder(512); GetWindowText(h, t, 512); r.Add(h + " " + t); } return true; }, IntPtr.Zero); return r; }
}
"@
[W]::List()
