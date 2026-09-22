/**
 * Launching a Windows Terminal window and finding its HWND.
 *
 * Discovery (docs/spike/layout.md): all WT windows belong to one
 * WindowsTerminal.exe process, so the process tree does not help. Instead we
 * snapshot the existing WT windows, launch with a unique tab title and
 * `--suppressApplicationTitle`, and poll EnumWindows for a *new* WT window
 * with exactly that title. Measured: wt.exe exits after 60-280 ms, the window
 * is found 230-640 ms after the call.
 */

import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { delimiter, join } from "node:path";

import { WT_WINDOW_CLASS, type Hwnd, type Win32 } from "./win32.ts";

/**
 * Invisible characters (all "default ignorable" in Unicode, rendered with zero
 * width by DirectWrite) used to make otherwise identical titles unique:
 * ZERO WIDTH SPACE, ZERO WIDTH NON-JOINER, ZERO WIDTH JOINER, WORD JOINER.
 */
const INVISIBLE_DIGITS = [0x200b, 0x200c, 0x200d, 0x2060].map((code) => String.fromCharCode(code));
const INVISIBLE_TAIL = new RegExp(`[${INVISIBLE_DIGITS.join("")}]+$`, "u");

/**
 * `visible` plus an invisible 8-digit base-4 tag (65 536 values), so two
 * windows with the same visible title (e.g. two pi sessions that both spawn
 * "Bello Baggins") can still be told apart.
 */
export function uniqueTitle(visible: string, tag: number): string {
  let suffix = "";
  let value = Math.abs(Math.trunc(tag)) % 65536;
  for (let i = 0; i < 8; i++) {
    suffix += INVISIBLE_DIGITS[value % 4];
    value = Math.floor(value / 4);
  }
  return visible + suffix;
}

/** Remove the invisible tag again (for logs and tests). */
export function visibleTitle(title: string): string {
  return title.replace(INVISIBLE_TAIL, "");
}

/** The visible title of an agent window. */
export function agentTitle(name: string, modelLabel: string): string {
  const clean = (s: string) => s.replace(/[\0\r\n\t]+/g, " ").trim();
  const model = clean(modelLabel);
  return model ? `🐕 ${clean(name)} · ${model}` : `🐕 ${clean(name)}`;
}

/** Locate wt.exe: PATH first, then the per-user app execution alias. */
export function findWtExe(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean);
  if (env["LOCALAPPDATA"]) dirs.push(join(env["LOCALAPPDATA"], "Microsoft", "WindowsApps"));
  for (const dir of dirs) {
    const candidate = join(dir, "wt.exe");
    if (entryExists(candidate)) return candidate;
  }
  return undefined;
}

/** Run wt.exe and wait until it exits (it hands the work to the running WT and quits). */
export function runWt(wtExe: string, argv: readonly string[], timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    // No windowsHide: it puts SW_HIDE into STARTUPINFO, and WT applies that to
    // the new window, which then never becomes visible.
    const child = spawn(wtExe, argv, { stdio: "ignore" });
    const timer = setTimeout(() => {
      // wt.exe itself should never take this long; the window may still come.
      resolve();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot start wt.exe: ${error.message}`, { cause: error }));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`wt.exe exited with code ${code}`));
    });
  });
}

export interface DiscoverOptions {
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop early (e.g. the backend was disposed). */
  cancelled?: () => boolean;
}

/** Snapshot of the WT windows that exist right now. */
export function snapshotWtWindows(win32: Win32): Set<Hwnd> {
  return new Set(win32.findWindowsByClass(WT_WINDOW_CLASS));
}

/**
 * Find a WT window that is not in `before`, has exactly `title` and is
 * visible. WT creates its window hidden, sets the title and shows it about
 * 20-30 ms later (WT 1.24). Only a shown window has its final placement and
 * has taken the foreground, so a hidden one does not count as found yet.
 */
export function findNewWindow(win32: Win32, title: string, before: ReadonlySet<Hwnd>): Hwnd {
  for (const hwnd of win32.findWindowsByClass(WT_WINDOW_CLASS)) {
    if (!before.has(hwnd) && win32.getWindowText(hwnd) === title && win32.isWindowVisible(hwnd)) return hwnd;
  }
  return 0;
}

/** Poll for the new window until it appears or the timeout passes. Returns 0 on timeout. */
export async function discoverWindow(
  win32: Win32,
  title: string,
  before: ReadonlySet<Hwnd>,
  options: DiscoverOptions,
): Promise<Hwnd> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const hwnd = findNewWindow(win32, title, before);
    if (hwnd) return hwnd;
    if (now() >= deadline || options.cancelled?.()) return 0;
    await sleep(options.pollMs);
  }
}

/**
 * `existsSync` follows reparse points, and the wt.exe app execution alias in
 * WindowsApps is one that cannot be followed (stat fails), so use lstat.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
