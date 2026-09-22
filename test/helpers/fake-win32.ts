import type { Rect } from "../../src/layout/computeLayout.ts";
import {
  SW,
  WM_CLOSE,
  WT_WINDOW_CLASS,
  type Hwnd,
  type MonitorInfo,
  type Win32,
  type WindowPlacement,
} from "../../src/backend/windows-terminal/win32.ts";

export interface FakeWindow {
  hwnd: Hwnd;
  className: string;
  title: string;
  /** Outer rect (with 7/0/7/7 invisible borders around the visible frame). */
  outer: Rect;
  visible: boolean;
  iconic: boolean;
  zoomed: boolean;
  owner: Hwnd;
  dpi: number;
}

const INSET = { left: 7, top: 0, right: 7, bottom: 7 };

/** A tiny in-memory window manager implementing the Win32 interface. */
export class FakeWin32 implements Win32 {
  readonly windows = new Map<Hwnd, FakeWindow>();
  monitors: MonitorInfo[] = [
    { handle: 1, bounds: { x: 0, y: 0, width: 3440, height: 1440 }, work: { x: 0, y: 0, width: 3440, height: 1392 }, primary: true, dpi: 96 },
  ];
  foreground: Hwnd = 0;
  consoleWindow: Hwnd = 0;
  batches: WindowPlacement[][] = [];
  shows: [Hwnd, number][] = [];
  posted: [Hwnd, number][] = [];
  /** Refuse SetForegroundWindow (foreground lock). */
  lockForeground = false;
  #next = 1000;

  addWindow(init: Partial<FakeWindow> & { frame?: Rect } = {}): FakeWindow {
    const frame = init.frame ?? { x: 100, y: 100, width: 800, height: 600 };
    const w: FakeWindow = {
      hwnd: init.hwnd ?? this.#next++,
      className: init.className ?? WT_WINDOW_CLASS,
      title: init.title ?? "",
      outer: init.outer ?? outerOf(frame),
      visible: init.visible ?? true,
      iconic: init.iconic ?? false,
      zoomed: init.zoomed ?? false,
      owner: init.owner ?? 0,
      dpi: init.dpi ?? 96,
    };
    this.windows.set(w.hwnd, w);
    return w;
  }

  /** Main WT window plus the ConPTY pseudo window owned by it, as in a real WT tab. */
  addMainWindow(frame: Rect = { x: 200, y: 150, width: 1295, height: 818 }): FakeWindow {
    const main = this.addWindow({ frame, title: "pi" });
    const pseudo = this.addWindow({ className: "PseudoConsoleWindow", owner: main.hwnd, visible: false });
    this.consoleWindow = pseudo.hwnd;
    this.foreground = main.hwnd;
    return main;
  }

  frameOf(hwnd: Hwnd): Rect | undefined {
    return this.getFrameBounds(hwnd);
  }

  close(hwnd: Hwnd): void {
    this.windows.delete(hwnd);
    if (this.foreground === hwnd) this.foreground = 0;
  }

  findWindowsByClass(className: string): Hwnd[] {
    return [...this.windows.values()].filter((w) => w.className === className).map((w) => w.hwnd);
  }
  getWindowText(hwnd: Hwnd): string {
    return this.windows.get(hwnd)?.title ?? "";
  }
  getClassName(hwnd: Hwnd): string {
    return this.windows.get(hwnd)?.className ?? "";
  }
  isWindow(hwnd: Hwnd): boolean {
    return this.windows.has(hwnd);
  }
  isWindowVisible(hwnd: Hwnd): boolean {
    return this.windows.get(hwnd)?.visible ?? false;
  }
  isIconic(hwnd: Hwnd): boolean {
    return this.windows.get(hwnd)?.iconic ?? false;
  }
  isZoomed(hwnd: Hwnd): boolean {
    return this.windows.get(hwnd)?.zoomed ?? false;
  }
  getWindowRect(hwnd: Hwnd): Rect | undefined {
    const w = this.windows.get(hwnd);
    return w ? { ...w.outer } : undefined;
  }
  getFrameBounds(hwnd: Hwnd): Rect | undefined {
    const w = this.windows.get(hwnd);
    if (!w) return undefined;
    const o = w.outer;
    return {
      x: o.x + INSET.left,
      y: o.y + INSET.top,
      width: o.width - INSET.left - INSET.right,
      height: o.height - INSET.top - INSET.bottom,
    };
  }
  showWindow(hwnd: Hwnd, cmd: number): boolean {
    const w = this.windows.get(hwnd);
    if (!w) return false;
    this.shows.push([hwnd, cmd]);
    if (cmd === SW.MINIMIZE || cmd === SW.SHOWMINNOACTIVE) w.iconic = true;
    if (cmd === SW.SHOWNOACTIVATE || cmd === SW.RESTORE) {
      w.iconic = false;
      w.zoomed = false;
    }
    if (cmd === SW.RESTORE) this.foreground = hwnd;
    return true;
  }
  deferWindowPos(placements: readonly WindowPlacement[]): boolean {
    this.batches.push(placements.map((p) => ({ ...p })));
    for (const p of placements) {
      const w = this.windows.get(p.hwnd);
      if (w) w.outer = { x: p.x, y: p.y, width: p.width, height: p.height };
    }
    return true;
  }
  setForegroundWindow(hwnd: Hwnd): boolean {
    if (this.lockForeground || !this.windows.has(hwnd)) return false;
    this.foreground = hwnd;
    return true;
  }
  getForegroundWindow(): Hwnd {
    return this.foreground;
  }
  getConsoleWindow(): Hwnd {
    return this.consoleWindow;
  }
  getRootOwner(hwnd: Hwnd): Hwnd {
    let current = hwnd;
    for (let i = 0; i < 10; i++) {
      const owner = this.windows.get(current)?.owner ?? 0;
      if (!owner) return current;
      current = owner;
    }
    return current;
  }
  monitorFromWindow(hwnd: Hwnd): MonitorInfo | undefined {
    const frame = this.getFrameBounds(hwnd);
    if (!frame) return undefined;
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;
    const hit = this.monitors.find(
      (m) => cx >= m.bounds.x && cx < m.bounds.x + m.bounds.width && cy >= m.bounds.y && cy < m.bounds.y + m.bounds.height,
    );
    return hit ?? this.monitors.find((m) => m.primary);
  }
  listMonitors(): MonitorInfo[] {
    return this.monitors.map((m) => ({ ...m }));
  }
  getDpiForWindow(hwnd: Hwnd): number {
    return this.monitorFromWindow(hwnd)?.dpi ?? 96;
  }
  postMessage(hwnd: Hwnd, msg: number): boolean {
    this.posted.push([hwnd, msg]);
    if (msg === WM_CLOSE) this.close(hwnd);
    return true;
  }
}

export function outerOf(frame: Rect): Rect {
  return {
    x: frame.x - INSET.left,
    y: frame.y - INSET.top,
    width: frame.width + INSET.left + INSET.right,
    height: frame.height + INSET.top + INSET.bottom,
  };
}
