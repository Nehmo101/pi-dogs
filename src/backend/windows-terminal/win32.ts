/**
 * Minimal Win32 bindings for the Windows Terminal backend, via koffi (FFI).
 *
 * koffi is loaded lazily on first use (about 25 ms once), so importing this
 * module is free on other platforms and in unit tests. Everything the tiler
 * needs goes through the small {@link Win32} interface, which tests replace
 * with a fake.
 *
 * All coordinates are physical pixels: the calling thread is made
 * per-monitor-v2 DPI aware when the bindings are loaded. pi is a console
 * process without windows of its own, so this has no visible side effects.
 */

import { createRequire } from "node:module";

import type { Rect } from "../../layout/computeLayout.ts";

/** Window handle as a plain number (HWNDs fit into 32 bits on Windows). */
export type Hwnd = number;

export interface MonitorInfo {
  handle: number;
  /** Full monitor rectangle. */
  bounds: Rect;
  /** Monitor rectangle minus taskbar and app bars. */
  work: Rect;
  primary: boolean;
  /** Effective DPI of the monitor (96 = 100 %). */
  dpi: number;
}

export interface WindowPlacement {
  hwnd: Hwnd;
  /** Outer window rect as SetWindowPos expects it (invisible borders included). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of Win32 the backend uses. Implemented by koffi, faked in tests. */
export interface Win32 {
  /** All top-level windows of a window class, in z-order. */
  findWindowsByClass(className: string): Hwnd[];
  getWindowText(hwnd: Hwnd): string;
  getClassName(hwnd: Hwnd): string;
  isWindow(hwnd: Hwnd): boolean;
  /** WS_VISIBLE (a minimized window is still visible). */
  isWindowVisible(hwnd: Hwnd): boolean;
  isIconic(hwnd: Hwnd): boolean;
  isZoomed(hwnd: Hwnd): boolean;
  /** Outer window rect (GetWindowRect), including invisible resize borders. */
  getWindowRect(hwnd: Hwnd): Rect | undefined;
  /** Visible frame (DWMWA_EXTENDED_FRAME_BOUNDS), or undefined if DWM cannot tell. */
  getFrameBounds(hwnd: Hwnd): Rect | undefined;
  showWindow(hwnd: Hwnd, cmd: number): boolean;
  /** Apply all placements in one BeginDeferWindowPos batch. Returns false if the batch failed. */
  deferWindowPos(placements: readonly WindowPlacement[], flags: number): boolean;
  setForegroundWindow(hwnd: Hwnd): boolean;
  getForegroundWindow(): Hwnd;
  /** The console window of this process (in Windows Terminal: the hidden ConPTY window). 0 if none. */
  getConsoleWindow(): Hwnd;
  /** GetAncestor(hwnd, GA_ROOTOWNER): walks parents and owners to the top. */
  getRootOwner(hwnd: Hwnd): Hwnd;
  /** Monitor containing (most of) the window, or the nearest one. */
  monitorFromWindow(hwnd: Hwnd): MonitorInfo | undefined;
  listMonitors(): MonitorInfo[];
  getDpiForWindow(hwnd: Hwnd): number;
  postMessage(hwnd: Hwnd, msg: number, wParam?: number, lParam?: number): boolean;
}

export const WT_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";

export const SW = Object.freeze({ MINIMIZE: 6, SHOWNOACTIVATE: 4, RESTORE: 9, SHOWMINNOACTIVE: 7 });
export const SWP = Object.freeze({
  NOSIZE: 0x1,
  NOMOVE: 0x2,
  NOZORDER: 0x4,
  NOREDRAW: 0x8,
  NOACTIVATE: 0x10,
  NOOWNERZORDER: 0x200,
  ASYNCWINDOWPOS: 0x4000,
});
export const WM_CLOSE = 0x0010;

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const MONITOR_DEFAULTTONEAREST = 2;
const MONITORINFOF_PRIMARY = 1;
const GA_ROOTOWNER = 3;
const MDT_EFFECTIVE_DPI = 0;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

let cached: Win32 | undefined;
let loadError: Error | undefined;

/**
 * Load the koffi bindings (once). Throws a descriptive error if koffi or the
 * Win32 DLLs cannot be loaded; later calls rethrow the same error.
 */
export function loadWin32(): Win32 {
  if (cached) return cached;
  if (loadError) throw loadError;
  try {
    cached = createKoffiWin32();
    return cached;
  } catch (error) {
    loadError = new Error(`pi-dogs: cannot load the Win32 bindings (koffi): ${(error as Error).message}`, {
      cause: error,
    });
    throw loadError;
  }
}

/** Whether koffi and user32 load; never throws. */
export function tryLoadWin32(): { ok: true; win32: Win32 } | { ok: false; error: Error } {
  try {
    return { ok: true, win32: loadWin32() };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

interface RawRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const toRect = (r: RawRect): Rect => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });

function createKoffiWin32(): Win32 {
  if (process.platform !== "win32") throw new Error("Win32 bindings are only available on Windows");
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as typeof import("koffi");

  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  let shcore: ReturnType<typeof koffi.load> | undefined;
  try {
    shcore = koffi.load("shcore.dll");
  } catch {
    shcore = undefined; // Windows 8.1+ has it; without it monitor DPI falls back to 96.
  }

  // Named types with a per-load suffix: other code in the same process may use
  // koffi too, and koffi keeps one global type registry. (Anonymous types are no
  // way out: in koffi 3.3 an anonymous struct and a later proto can receive the
  // same generated name, which breaks pointer declarations.)
  const suffix = `_pidogs_${process.pid}_${Date.now().toString(36)}`;
  const RECT = koffi.struct(`RECT${suffix}`, { left: "int32", top: "int32", right: "int32", bottom: "int32" });
  const MONITORINFO = koffi.struct(`MONITORINFO${suffix}`, { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
  const HANDLE = "intptr_t";
  const EnumWindowsProc = koffi.proto("__stdcall", `EnumWindowsProc${suffix}`, "bool", [HANDLE, "intptr_t"]);
  const MonitorEnumProc = koffi.proto("__stdcall", `MonitorEnumProc${suffix}`, "bool", [HANDLE, HANDLE, "void *", "intptr_t"]);

  const fn = (lib: typeof user32, name: string, result: string, args: unknown[]) => {
    try {
      return lib.func("__stdcall", name, result, args as Parameters<typeof lib.func>[3]);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
  };

  const EnumWindows = fn(user32, "EnumWindows", "bool", [koffi.pointer(EnumWindowsProc), "intptr_t"]);
  const GetWindowTextW = fn(user32, "GetWindowTextW", "int", [HANDLE, koffi.out(koffi.pointer("uint16_t")), "int"]);
  const GetWindowTextLengthW = fn(user32, "GetWindowTextLengthW", "int", [HANDLE]);
  const GetClassNameW = fn(user32, "GetClassNameW", "int", [HANDLE, koffi.out(koffi.pointer("uint16_t")), "int"]);
  const IsWindow = fn(user32, "IsWindow", "bool", [HANDLE]);
  const IsIconic = fn(user32, "IsIconic", "bool", [HANDLE]);
  const IsWindowVisible = fn(user32, "IsWindowVisible", "bool", [HANDLE]);
  const IsZoomed = fn(user32, "IsZoomed", "bool", [HANDLE]);
  const GetWindowRect = fn(user32, "GetWindowRect", "bool", [HANDLE, koffi.out(koffi.pointer(RECT))]);
  const ShowWindow = fn(user32, "ShowWindow", "bool", [HANDLE, "int"]);
  const SetForegroundWindow = fn(user32, "SetForegroundWindow", "bool", [HANDLE]);
  const GetForegroundWindow = fn(user32, "GetForegroundWindow", HANDLE, []);
  const GetAncestor = fn(user32, "GetAncestor", HANDLE, [HANDLE, "uint32"]);
  const BeginDeferWindowPos = fn(user32, "BeginDeferWindowPos", HANDLE, ["int"]);
  const DeferWindowPos = fn(user32, "DeferWindowPos", HANDLE, [
    HANDLE, HANDLE, HANDLE, "int", "int", "int", "int", "uint32",
  ]);
  const EndDeferWindowPos = fn(user32, "EndDeferWindowPos", "bool", [HANDLE]);
  const MonitorFromWindow = fn(user32, "MonitorFromWindow", HANDLE, [HANDLE, "uint32"]);
  const GetMonitorInfoW = fn(user32, "GetMonitorInfoW", "bool", [HANDLE, koffi.inout(koffi.pointer(MONITORINFO))]);
  const EnumDisplayMonitors = fn(user32, "EnumDisplayMonitors", "bool", [
    HANDLE, "void *", koffi.pointer(MonitorEnumProc), "intptr_t",
  ]);
  const GetDpiForWindow = fn(user32, "GetDpiForWindow", "uint32", [HANDLE]);
  const PostMessageW = fn(user32, "PostMessageW", "bool", [HANDLE, "uint32", "uintptr_t", "intptr_t"]);
  const SetThreadDpiAwarenessContext = fn(user32, "SetThreadDpiAwarenessContext", "intptr_t", ["intptr_t"]);
  const GetConsoleWindow = fn(kernel32, "GetConsoleWindow", HANDLE, []);
  const DwmGetWindowAttribute = fn(dwmapi, "DwmGetWindowAttribute", "int32", [
    HANDLE, "uint32", koffi.out(koffi.pointer(RECT)), "uint32",
  ]);
  const GetDpiForMonitor = shcore
    ? fn(shcore, "GetDpiForMonitor", "int32", [HANDLE, "int", koffi.out(koffi.pointer("uint32")), koffi.out(koffi.pointer("uint32"))])
    : undefined;

  // Physical pixels everywhere. Thread-level, so pi's own awareness is untouched
  // for other threads; Node runs all JS (and so all these calls) on this thread.
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  const rectSize = koffi.sizeof(RECT);
  const monitorInfoSize = koffi.sizeof(MONITORINFO);
  const textBuffer = new Uint16Array(512);
  const readText = (count: number) => String.fromCharCode(...textBuffer.subarray(0, Math.max(0, count)));

  const monitorInfo = (handle: number): MonitorInfo | undefined => {
    if (!handle) return undefined;
    const info = { cbSize: monitorInfoSize, rcMonitor: {}, rcWork: {}, dwFlags: 0 } as {
      cbSize: number;
      rcMonitor: RawRect;
      rcWork: RawRect;
      dwFlags: number;
    };
    if (!GetMonitorInfoW(handle, info)) return undefined;
    let dpi = 96;
    if (GetDpiForMonitor) {
      const dx = [0];
      const dy = [0];
      if (GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, dx, dy) === 0 && dx[0]) dpi = dx[0];
    }
    return {
      handle,
      bounds: toRect(info.rcMonitor),
      work: toRect(info.rcWork),
      primary: (info.dwFlags & MONITORINFOF_PRIMARY) !== 0,
      dpi,
    };
  };

  return {
    findWindowsByClass(className) {
      const found: Hwnd[] = [];
      const classBuffer = new Uint16Array(256);
      EnumWindows((hwnd: number) => {
        const n = GetClassNameW(hwnd, classBuffer, classBuffer.length);
        if (n === className.length && String.fromCharCode(...classBuffer.subarray(0, n)) === className) found.push(hwnd);
        return true;
      }, 0);
      return found;
    },
    getWindowText(hwnd) {
      const length = GetWindowTextLengthW(hwnd);
      if (length <= 0) return "";
      if (length >= textBuffer.length) {
        const big = new Uint16Array(length + 1);
        const n = GetWindowTextW(hwnd, big, big.length);
        return String.fromCharCode(...big.subarray(0, Math.max(0, n)));
      }
      return readText(GetWindowTextW(hwnd, textBuffer, textBuffer.length));
    },
    getClassName(hwnd) {
      return readText(GetClassNameW(hwnd, textBuffer, 256));
    },
    isWindow: (hwnd) => !!hwnd && IsWindow(hwnd),
    isIconic: (hwnd) => IsIconic(hwnd),
    isWindowVisible: (hwnd) => IsWindowVisible(hwnd),
    isZoomed: (hwnd) => IsZoomed(hwnd),
    getWindowRect(hwnd) {
      const r = {} as RawRect;
      return GetWindowRect(hwnd, r) ? toRect(r) : undefined;
    },
    getFrameBounds(hwnd) {
      const r = {} as RawRect;
      return DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, rectSize) === 0 ? toRect(r) : undefined;
    },
    showWindow: (hwnd, cmd) => ShowWindow(hwnd, cmd),
    deferWindowPos(placements, flags) {
      if (placements.length === 0) return true;
      let hdwp = BeginDeferWindowPos(placements.length);
      if (!hdwp) return false;
      for (const p of placements) {
        hdwp = DeferWindowPos(hdwp, p.hwnd, 0, p.x, p.y, p.width, p.height, flags);
        // On failure DeferWindowPos frees the batch itself; nothing to end.
        if (!hdwp) return false;
      }
      return EndDeferWindowPos(hdwp);
    },
    setForegroundWindow: (hwnd) => SetForegroundWindow(hwnd),
    getForegroundWindow: () => GetForegroundWindow(),
    getConsoleWindow: () => GetConsoleWindow(),
    getRootOwner: (hwnd) => GetAncestor(hwnd, GA_ROOTOWNER),
    monitorFromWindow: (hwnd) => monitorInfo(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)),
    listMonitors() {
      const handles: number[] = [];
      EnumDisplayMonitors(0, null, (handle: number) => {
        handles.push(handle);
        return true;
      }, 0);
      return handles.map(monitorInfo).filter((m): m is MonitorInfo => m !== undefined);
    },
    getDpiForWindow: (hwnd) => GetDpiForWindow(hwnd) || 96,
    postMessage: (hwnd, msg, wParam = 0, lParam = 0) => PostMessageW(hwnd, msg, wParam, lParam),
  };
}
