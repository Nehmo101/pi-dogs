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
 * 2. There is deliberately no fallback. WT_SESSION is inherited by conhost
 *    and VS Code terminals started from a WT tab, and the backend starts
 *    lazily (at the first open), so "the foreground WT window" can be any
 *    window of the user. If 1 fails, main is not moved at all; its area in
 *    the layout simply stays empty (agents do not stretch over it).
 *
 * Titles are not used: pi and the user may change the tab title at any time.
 * Cheap (three calls), so the tiler re-resolves it on every poll to follow a
 * tab that was torn out into another window.
 */

import { WT_WINDOW_CLASS, type Hwnd, type Win32 } from "./win32.ts";

export type MainWindowResult =
  | { hwnd: Hwnd; source: "console-owner" }
  | { hwnd: 0; source: "none"; reason: string };

export function findMainWindow(win32: Win32): MainWindowResult {
  const consoleWindow = win32.getConsoleWindow();
  if (consoleWindow) {
    const root = win32.getRootOwner(consoleWindow);
    if (root && root !== consoleWindow && win32.getClassName(root) === WT_WINDOW_CLASS) {
      return { hwnd: root, source: "console-owner" };
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
