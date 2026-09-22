/**
 * Finding the Windows Terminal window that hosts the main pi process.
 *
 * pi-dogs runs inside pi, which runs in a Windows Terminal tab. Windows
 * Terminal attaches every tab's processes to a ConPTY, whose hidden
 * "PseudoConsoleWindow" is *owned* by the terminal's top-level window. So:
 *
 * 1. `GetConsoleWindow()` returns that pseudo window, and
 *    `GetAncestor(hwnd, GA_ROOTOWNER)` walks up to the WT window
 *    (class CASCADIA_HOSTING_WINDOW_CLASS). Verified with WT 1.24. This is
 *    exact even with several WT windows open and does not depend on focus
 *    or titles.
 * 2. Fallback: when running inside WT (WT_SESSION is set) and the foreground
 *    window is a WT window. pi was just started by typing into it, so at
 *    startup this is almost always right; it is only used if 1 fails.
 *
 * Titles are not used: pi and the user may change the tab title at any time.
 */

import { WT_WINDOW_CLASS, type Hwnd, type Win32 } from "./win32.ts";

export type MainWindowResult =
  | { hwnd: Hwnd; source: "console-owner" | "foreground" }
  | { hwnd: 0; source: "none"; reason: string };

export function findMainWindow(win32: Win32, env: NodeJS.ProcessEnv = process.env): MainWindowResult {
  const consoleWindow = win32.getConsoleWindow();
  if (consoleWindow) {
    const root = win32.getRootOwner(consoleWindow);
    if (root && root !== consoleWindow && win32.getClassName(root) === WT_WINDOW_CLASS) {
      return { hwnd: root, source: "console-owner" };
    }
  }
  if (env["WT_SESSION"]) {
    const foreground = win32.getForegroundWindow();
    if (foreground && win32.getClassName(foreground) === WT_WINDOW_CLASS) {
      return { hwnd: foreground, source: "foreground" };
    }
  }
  return {
    hwnd: 0,
    source: "none",
    reason: consoleWindow
      ? "the console window is not owned by a Windows Terminal window"
      : "this process has no console window",
  };
}
