/**
 * The tiler owns the ordered set of agent windows plus the main window and
 * turns computeLayout's rects into window positions.
 *
 * - One BeginDeferWindowPos batch per applied layout (main included), so all
 *   windows change in the same composed frame. Never SWP_NOREDRAW (it leaves
 *   stale pixels behind, see docs/spike/layout.md).
 * - Windows already at their target are left alone, so a relayout that
 *   changes nothing does not make any terminal reflow.
 * - Rects from computeLayout are *visible* frames; the invisible resize
 *   borders are measured per window (DWM extended frame bounds) and added.
 * - After the batch the frames are read back; windows that are off (e.g.
 *   because they crossed to a monitor with another DPI and rescaled
 *   themselves) get one corrective batch. Windows that changed DPI are read
 *   back once more about 100 ms later, because WT rescales asynchronously.
 * - Hung windows (IsHungAppWindow) are skipped, and show/minimize requests
 *   are posted (ShowWindowAsync), so a frozen WT window cannot freeze pi.
 * - Monitor/work-area/DPI changes are debounced (stable for
 *   `environmentSettleMs`) and postponed while the user drags main.
 *
 * All Win32 access goes through the {@link Win32} interface, so this class
 * is unit-tested with a fake window manager.
 */

import {
  computeLayout,
  layoutPrefsForScale,
  type Layout,
  type LayoutPrefs,
  type Rect,
  type SecondaryWorkArea,
  type Size,
} from "../../layout/computeLayout.ts";
import {
  animationFrames,
  defaultInsets,
  estimateCellSize,
  frameInsets,
  outerRect,
  plausibleInsets,
  sameRect,
} from "./geometry.ts";
import { SW, SWP, type Hwnd, type MonitorInfo, type Win32, type WindowPlacement } from "./win32.ts";

export interface AnimationConfig {
  /** Total duration of a transition in milliseconds. */
  durationMs: number;
  /** Number of DeferWindowPos batches per transition (the last one is the exact target). */
  frames: number;
}

export interface TilerConfig {
  /** User overrides for the layout (from pi-dogs.json). Cell size overrides the measured one. */
  prefs?: Partial<LayoutPrefs>;
  /** Put agents that do not fit next to main on other monitors before minimizing them. */
  useSecondaryMonitors?: boolean;
  /** Eased transitions; `false` (default) applies each layout in a single step. */
  animation?: AnimationConfig | false;
  /** Size of the main pi terminal in cells, to measure the real cell size. */
  terminalSize?: () => { cols: number; rows: number } | undefined;
  /**
   * Re-resolves the main window (console owner) on every poll and apply, so
   * a tab torn out into another window is followed. Returns 0 if not found.
   */
  resolveMain?: () => Hwnd;
  /** How long monitor/work area/DPI must stay unchanged before re-tiling. Default 500 ms. */
  environmentSettleMs?: number;
  /** Delay of the second read-back for windows that changed DPI. Default 100 ms. */
  dpiSettleMs?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TileEntry {
  readonly agentId: string;
  /** 0 while the window is still being launched (its slot is already reserved). */
  hwnd: Hwnd;
  /** Minimized on request (backend.minimize or by the user via the taskbar). */
  userMinimized: boolean;
  /** Minimized by the layout because there was no room. */
  autoMinimized: boolean;
  /** Whether we expect the window to be minimized; a difference means the user changed it. */
  expectIconic: boolean;
}

export interface Plan {
  monitor: MonitorInfo;
  dpi: number;
  prefs: LayoutPrefs;
  secondary: SecondaryWorkArea[];
  layout: Layout;
}

export interface MinimizedChange {
  agentId: string;
  minimized: boolean;
  reason: "auto" | "user";
}

export interface ApplyResult {
  /** Wall time of the whole apply (all frames), in milliseconds. */
  ms: number;
  /** Time spent inside DeferWindowPos batches only. */
  batchMs: number;
  /** Windows moved or resized. */
  placed: number;
  /** Batches issued (animation frames plus corrections). */
  batches: number;
  /** Windows that needed a corrective second placement. */
  corrected: number;
  minimizedChanges: MinimizedChange[];
}

export interface PollResult {
  closed: string[];
  minimizedChanges: MinimizedChange[];
  /** Something changed that needs a relayout (closed window, user (un)minimize, monitor, DPI). */
  relayout: boolean;
}

const PLACE_FLAGS = SWP.NOZORDER | SWP.NOACTIVATE | SWP.NOOWNERZORDER;

/** Main's state before we first tiled it, and where it was then. */
interface MainBefore {
  frame: Rect;
  maximized: boolean;
  work: Rect;
  dpi: number;
}

export class Tiler {
  readonly #win32: Win32;
  readonly #config: TilerConfig;
  readonly #entries: TileEntry[] = [];
  #main: Hwnd;
  /** Main window state before we first tiled it, restored when no agent is visible any more. */
  #mainBefore: MainBefore | undefined;
  /** Cell size measured from the main terminal, and the DPI it was measured at. */
  #measuredCell: { cell: Size; dpi: number } | undefined;
  #lastPlan: Plan | undefined;
  #environment = "";
  /** A changed environment waiting to be stable (debounce). */
  #pendingEnvironment: { signature: string; since: number } | undefined;

  constructor(win32: Win32, mainHwnd: Hwnd, config: TilerConfig = {}) {
    this.#win32 = win32;
    this.#main = mainHwnd;
    this.#config = config;
  }

  get main(): Hwnd {
    return this.#main;
  }

  get entries(): readonly TileEntry[] {
    return this.#entries;
  }

  get lastPlan(): Plan | undefined {
    return this.#lastPlan;
  }

  get(agentId: string): TileEntry | undefined {
    return this.#entries.find((e) => e.agentId === agentId);
  }

  /** Add an agent as the newest one. Its slot is reserved until the window is attached. */
  add(agentId: string): TileEntry {
    if (this.get(agentId)) throw new Error(`agent ${agentId} is already tiled`);
    const entry: TileEntry = { agentId, hwnd: 0, userMinimized: false, autoMinimized: false, expectIconic: false };
    this.#entries.push(entry);
    return entry;
  }

  attach(agentId: string, hwnd: Hwnd): void {
    const entry = this.#require(agentId);
    entry.hwnd = hwnd;
    entry.expectIconic = this.#win32.isIconic(hwnd);
  }

  remove(agentId: string): TileEntry | undefined {
    const index = this.#entries.findIndex((e) => e.agentId === agentId);
    return index < 0 ? undefined : this.#entries.splice(index, 1)[0];
  }

  /** Move an agent to the newest position, so the layout keeps it visible. */
  promote(agentId: string): void {
    const entry = this.remove(agentId);
    if (entry) this.#entries.push(entry);
  }

  minimize(agentId: string): void {
    this.#require(agentId).userMinimized = true;
  }

  /**
   * Clear the minimized flag. The agent keeps its place in the order if the
   * layout has room for it there; otherwise it becomes the newest agent, so
   * restoring always shows it (and the oldest one makes room instead).
   */
  unminimize(agentId: string): void {
    const entry = this.#require(agentId);
    entry.userMinimized = false;
    let fits = false;
    try {
      this.plan();
      fits = this.targetOf(agentId) !== undefined;
    } catch {
      // No monitor right now (e.g. RDP reconnect): make sure it is shown later.
    }
    if (!fits) this.promote(agentId);
  }

  /**
   * Give main its original frame back right now, with one SetWindowPos,
   * moved onto the monitor main is on now (e.g. on dispose, where no relayout
   * runs any more). Returns whether main was moved.
   */
  restoreMain(): boolean {
    const win32 = this.#win32;
    const main = this.#main;
    const before = this.#mainBefore;
    if (!before || !main || !win32.isWindow(main) || win32.isIconic(main) || win32.isHung(main)) return false;
    this.#mainBefore = undefined;
    const rect = this.#restoreRect(before, main);
    return win32.setWindowPos(this.#placement(main, rect), PLACE_FLAGS);
  }

  /** Compute where everything should go, without touching any window. */
  plan(): Plan {
    const win32 = this.#win32;
    this.#refreshMain();
    const main = this.#main && win32.isWindow(this.#main) ? this.#main : 0;
    const monitors = win32.listMonitors();
    const monitor =
      (main ? win32.monitorFromWindow(main) : undefined) ?? monitors.find((m) => m.primary) ?? monitors[0];
    if (!monitor) throw new Error("no monitor found");
    const dpi = main ? win32.getDpiForWindow(main) : monitor.dpi;
    const prefs = this.#prefs(dpi, main);

    const secondary: SecondaryWorkArea[] = [];
    if (this.#config.useSecondaryMonitors ?? true) {
      const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      const c = centre(monitor.bounds);
      const others = monitors
        .filter((m) => m.handle !== monitor.handle)
        .sort((a, b) => {
          const da = centre(a.bounds);
          const db = centre(b.bounds);
          return Math.hypot(da.x - c.x, da.y - c.y) - Math.hypot(db.x - c.x, db.y - c.y);
        });
      for (const m of others) {
        const f = m.dpi / dpi;
        secondary.push({
          rect: m.work,
          cellSize: { w: prefs.cellSize.w * f, h: prefs.cellSize.h * f },
          chrome: { w: Math.round(prefs.chrome.w * f), h: Math.round(prefs.chrome.h * f) },
        });
      }
    }
    const layout = computeLayout(
      monitor.work,
      this.#entries.map((e) => ({ id: e.agentId, minimized: e.userMinimized })),
      prefs,
      { secondaryWorkAreas: secondary },
    );
    const plan = { monitor, dpi, prefs, secondary, layout };
    this.#lastPlan = plan;
    return plan;
  }

  /** Target visible rect of an agent in the last plan (undefined: minimized or unknown). */
  targetOf(agentId: string): Rect | undefined {
    return this.#lastPlan?.layout.agents.find((a) => a.id === agentId)?.rect;
  }

  /** DPI of the monitor a rect lies on (for launch sizes on secondary monitors). */
  dpiAt(rect: Rect): number {
    const plan = this.#lastPlan;
    if (!plan) return 96;
    const inside = (r: Rect, box: Rect) =>
      r.x >= box.x && r.y >= box.y && r.x + r.width <= box.x + box.width && r.y + r.height <= box.y + box.height;
    const monitor = this.#win32.listMonitors().find((m) => inside(rect, m.work));
    return monitor?.dpi ?? plan.dpi;
  }

  /** Compute the layout and move all windows there. */
  async apply(): Promise<ApplyResult> {
    const win32 = this.#win32;
    const now = this.#config.now ?? (() => performance.now());
    const started = now();
    const plan = this.plan();
    this.#environment = this.#environmentSignature();
    this.#pendingEnvironment = undefined;
    const { layout } = plan;
    const shown = new Map(layout.agents.map((a) => [a.id, a.rect]));
    const minimizedChanges: MinimizedChange[] = [];
    /** Windows that must jump to their target (just restored): animating them looks wrong. */
    const jump = new Set<Hwnd>();
    /** Posted show requests (ShowWindowAsync) we wait for before placing. */
    const pending: (() => boolean)[] = [];
    /** Never send anything to a hung window: it would block pi until it recovers. */
    const usable = (hwnd: Hwnd) => !!hwnd && win32.isWindow(hwnd) && !win32.isHung(hwnd);

    for (const entry of this.#entries) {
      const auto = !entry.userMinimized && !shown.has(entry.agentId);
      if (auto !== entry.autoMinimized) {
        // Report only effective changes: an auto-minimized window that the
        // user minimizes now stays minimized, so there is nothing to tell.
        if (auto || !entry.userMinimized) minimizedChanges.push({ agentId: entry.agentId, minimized: auto, reason: "auto" });
        entry.autoMinimized = auto;
      }
      if (!usable(entry.hwnd)) continue;
      const hwnd = entry.hwnd;
      const visible = shown.has(entry.agentId);
      const iconic = win32.isIconic(hwnd);
      if (visible && iconic) {
        win32.showWindow(hwnd, SW.SHOWNOACTIVATE); // restore without taking focus
        jump.add(hwnd);
        pending.push(() => !win32.isIconic(hwnd));
      } else if (visible && win32.isZoomed(hwnd)) {
        // A maximized window ignores SetWindowPos sizes until it is restored.
        win32.showWindow(hwnd, SW.SHOWNOACTIVATE);
        jump.add(hwnd);
        pending.push(() => !win32.isZoomed(hwnd));
      } else if (!visible && !iconic) {
        win32.showWindow(hwnd, SW.SHOWMINNOACTIVE); // minimize, keep the active window active
        pending.push(() => win32.isIconic(hwnd));
      }
      entry.expectIconic = !visible;
    }

    const targets: { hwnd: Hwnd; rect: Rect }[] = [];
    const mainTarget = usable(this.#main) ? this.#mainTarget(plan, pending) : undefined;
    if (mainTarget) targets.push({ hwnd: this.#main, rect: mainTarget });
    await this.#settle(pending);
    for (const entry of this.#entries) {
      const rect = shown.get(entry.agentId);
      if (!rect || !usable(entry.hwnd)) continue;
      // Restored from minimized into a maximized state: un-maximize it too.
      if (win32.isZoomed(entry.hwnd)) {
        win32.showWindow(entry.hwnd, SW.SHOWNOACTIVATE);
        const hwnd = entry.hwnd;
        await this.#settle([() => !win32.isZoomed(hwnd)]);
      }
      targets.push({ hwnd: entry.hwnd, rect });
    }

    const stats = { batchMs: 0, placed: 0, batches: 0, corrected: 0 };
    const batch = (placements: WindowPlacement[]) => {
      if (placements.length === 0) return;
      const t = now();
      if (!win32.deferWindowPos(placements, PLACE_FLAGS)) {
        this.#log(`DeferWindowPos batch of ${placements.length} windows failed; placing them one by one`);
        for (const p of placements) {
          if (usable(p.hwnd) && !win32.setWindowPos(p, PLACE_FLAGS)) this.#log(`SetWindowPos failed for window ${p.hwnd}`);
        }
      }
      stats.batchMs += now() - t;
      stats.batches++;
    };

    // Current frames; windows already in place are skipped entirely.
    const moving = targets
      .map((t) => ({ ...t, frame: win32.getFrameBounds(t.hwnd), dpi: win32.getDpiForWindow(t.hwnd) }))
      .filter((t) => !t.frame || !sameRect(t.frame, t.rect));
    stats.placed = moving.length;

    const animation = this.#config.animation;
    const frameCount = animation && animation.frames > 1 ? animation.frames : 1;
    const paths = moving.map((m) =>
      m.frame && frameCount > 1 && !jump.has(m.hwnd) ? animationFrames(m.frame, m.rect, frameCount) : [m.rect],
    );
    const steps = Math.max(0, ...paths.map((p) => p.length));
    const interval = animation ? animation.durationMs / frameCount : 0;
    for (let step = 0; step < steps; step++) {
      const stepStart = now();
      const placements: WindowPlacement[] = [];
      moving.forEach((m, i) => {
        const path = paths[i]!;
        if (step < path.length) placements.push(this.#placement(m.hwnd, path[step]!));
      });
      batch(placements);
      if (step < steps - 1) {
        const wait = interval - (now() - stepStart);
        if (wait > 0) await (this.#config.sleep ?? defaultSleep)(wait);
      }
    }

    // Read back and correct once (DPI changes, windows that refused a size).
    const correct = (list: typeof moving) => {
      const corrections: WindowPlacement[] = [];
      for (const m of list) {
        if (!usable(m.hwnd)) continue;
        const frame = win32.getFrameBounds(m.hwnd);
        if (frame && !sameRect(frame, m.rect)) corrections.push(this.#placement(m.hwnd, m.rect));
      }
      stats.corrected += corrections.length;
      batch(corrections);
    };
    correct(moving);
    // A window that moved to a monitor with another DPI rescales itself a
    // little later (WT handles WM_DPICHANGED asynchronously): check it again.
    const crossed = moving.filter((m) => usable(m.hwnd) && win32.getDpiForWindow(m.hwnd) !== m.dpi);
    if (crossed.length > 0) {
      await (this.#config.sleep ?? defaultSleep)(this.#config.dpiSettleMs ?? 100);
      correct(crossed);
    }

    return { ms: now() - started, ...stats, minimizedChanges };
  }

  /** Cheap check for closed windows, user (un)minimizes and monitor changes. Call every ~250 ms. */
  poll(): PollResult {
    const win32 = this.#win32;
    const mainChanged = this.#refreshMain();
    const closed: string[] = [];
    const minimizedChanges: MinimizedChange[] = [];
    for (const entry of [...this.#entries]) {
      if (!entry.hwnd) continue;
      if (!win32.isWindow(entry.hwnd)) {
        this.remove(entry.agentId);
        closed.push(entry.agentId);
        continue;
      }
      const iconic = win32.isIconic(entry.hwnd);
      if (iconic === entry.expectIconic) continue;
      entry.expectIconic = iconic;
      if (iconic) {
        // Minimized by the user (taskbar, title bar button, Win+Down).
        entry.userMinimized = true;
        entry.autoMinimized = false;
        minimizedChanges.push({ agentId: entry.agentId, minimized: true, reason: "user" });
      } else {
        // Restored by the user: bring it into the layout as the newest window.
        const wasMinimized = entry.userMinimized || entry.autoMinimized;
        this.unminimize(entry.agentId);
        entry.autoMinimized = false;
        if (wasMinimized) minimizedChanges.push({ agentId: entry.agentId, minimized: false, reason: "user" });
      }
    }
    let environmentChanged = false;
    try {
      environmentChanged = this.#environmentSettled();
    } catch (error) {
      this.#log(`cannot read the monitor setup: ${(error as Error).message}`);
    }
    return {
      closed,
      minimizedChanges,
      relayout: closed.length > 0 || minimizedChanges.length > 0 || environmentChanged || mainChanged,
    };
  }

  /**
   * Debounced environment check: true once a changed monitor/work area/DPI
   * signature has been stable for `environmentSettleMs` and the user is not
   * dragging main (move/size loop or mouse button down), so the tiler does
   * not fight a window that is being dragged across monitors.
   */
  #environmentSettled(): boolean {
    const environment = this.#environmentSignature();
    if (this.#environment === "") {
      this.#environment = environment;
      return false;
    }
    if (environment === this.#environment) {
      this.#pendingEnvironment = undefined;
      return false;
    }
    const now = (this.#config.now ?? (() => performance.now()))();
    const pending = this.#pendingEnvironment;
    if (!pending || pending.signature !== environment) {
      this.#pendingEnvironment = { signature: environment, since: now };
      return false;
    }
    if (now - pending.since < (this.#config.environmentSettleMs ?? 500) || this.#userIsDragging()) return false;
    this.#environment = environment;
    this.#pendingEnvironment = undefined;
    return true;
  }

  #userIsDragging(): boolean {
    const win32 = this.#win32;
    const main = this.#main;
    if (win32.isMouseButtonDown()) return true;
    return !!main && win32.isWindow(main) && !win32.isHung(main) && win32.isInMoveSize(main);
  }

  /** Follow main when the pi tab now lives in another WT window (torn out, moved). */
  #refreshMain(): boolean {
    const resolve = this.#config.resolveMain;
    if (!resolve) return false;
    let next: Hwnd;
    try {
      next = resolve();
    } catch {
      return false;
    }
    if (!next || next === this.#main) return false;
    const old = this.#main;
    // The old window keeps the user's other tabs: give it its frame back.
    if (old && this.#mainBefore && this.#win32.isWindow(old) && !this.#win32.isHung(old) && !this.#win32.isIconic(old)) {
      this.#win32.setWindowPos(this.#placement(old, this.#restoreRect(this.#mainBefore, old)), PLACE_FLAGS);
    }
    this.#log(`main pi window changed from ${old} to ${next}`);
    this.#main = next;
    this.#mainBefore = undefined;
    return true;
  }

  /** Wait (briefly) until posted ShowWindowAsync requests have taken effect. */
  async #settle(conditions: readonly (() => boolean)[]): Promise<void> {
    const sleep = this.#config.sleep ?? defaultSleep;
    for (let i = 0; i < 30 && !conditions.every((c) => c()); i++) await sleep(5);
  }

  /**
   * Where main goes back to: its frame from before tiling (or the full work
   * area if it was maximized), moved onto the monitor it is on now and
   * scaled for that monitor's DPI, clamped into the work area.
   */
  #restoreRect(before: MainBefore, hwnd: Hwnd): Rect {
    const monitor = this.#win32.monitorFromWindow(hwnd);
    if (!monitor) return before.frame;
    const work = monitor.work;
    if (before.maximized) return { ...work };
    if (sameRect(work, before.work)) return before.frame;
    const f = this.#win32.getDpiForWindow(hwnd) / before.dpi;
    const width = Math.min(work.width, Math.round(before.frame.width * f));
    const height = Math.min(work.height, Math.round(before.frame.height * f));
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    return {
      x: clamp(work.x + Math.round((before.frame.x - before.work.x) * f), work.x, work.x + work.width - width),
      y: clamp(work.y + Math.round((before.frame.y - before.work.y) * f), work.y, work.y + work.height - height),
      width,
      height,
    };
  }

  #log(message: string): void {
    this.#config.log?.(message);
  }

  #require(agentId: string): TileEntry {
    const entry = this.get(agentId);
    if (!entry) throw new Error(`unknown agent ${agentId}`);
    return entry;
  }

  #prefs(dpi: number, main: Hwnd): LayoutPrefs {
    const base = layoutPrefsForScale(dpi / 96);
    const user = this.#config.prefs ?? {};
    let cellSize = base.cellSize;
    if (!user.cellSize && main) {
      if (!this.#measuredCell && !this.#mainBefore) {
        // Measure once, before we first resize main (its cols/rows are then
        // settled). Later DPI changes scale the measurement.
        const frame = this.#win32.getFrameBounds(main);
        const terminal = this.#config.terminalSize?.();
        if (frame && terminal) {
          const cell = estimateCellSize({ w: frame.width, h: frame.height }, terminal, user.chrome ?? base.chrome, base.cellSize);
          if (cell !== base.cellSize) this.#measuredCell = { cell, dpi };
        }
      }
      if (this.#measuredCell) {
        const f = dpi / this.#measuredCell.dpi;
        cellSize = { w: this.#measuredCell.cell.w * f, h: this.#measuredCell.cell.h * f };
      }
    }
    return { ...base, cellSize, ...user };
  }

  /** Where main goes, or undefined to leave it alone. */
  #mainTarget(plan: Plan, pending: (() => boolean)[]): Rect | undefined {
    const win32 = this.#win32;
    const main = this.#main;
    if (!main || !win32.isWindow(main) || win32.isIconic(main)) return undefined;
    const work = plan.monitor.work;
    const tiling = !sameRect(plan.layout.main, work);
    if (tiling) {
      if (!this.#mainBefore) {
        const frame = win32.getFrameBounds(main);
        if (frame) this.#mainBefore = { frame, maximized: win32.isZoomed(main), work: work, dpi: plan.dpi };
      }
      // A maximized window ignores SetWindowPos sizes until it is restored.
      if (win32.isZoomed(main)) {
        win32.showWindow(main, SW.SHOWNOACTIVATE);
        pending.push(() => !win32.isZoomed(main));
      }
      return plan.layout.main;
    }
    // No agent next to main any more: give main its space back once.
    const before = this.#mainBefore;
    if (!before) return undefined;
    this.#mainBefore = undefined;
    // Maximizing would activate main (and steal focus); the full work area looks the same.
    return this.#restoreRect(before, main);
  }

  #placement(hwnd: Hwnd, visible: Rect): WindowPlacement {
    const win32 = this.#win32;
    const outer = win32.getWindowRect(hwnd);
    const frame = win32.getFrameBounds(hwnd);
    const dpi = win32.getDpiForWindow(hwnd);
    let insets = outer && frame ? frameInsets(outer, frame) : defaultInsets(dpi);
    if (!plausibleInsets(insets, dpi)) insets = defaultInsets(dpi);
    return { hwnd, ...outerRect(visible, insets) };
  }

  #environmentSignature(): string {
    const win32 = this.#win32;
    const main = this.#main && win32.isWindow(this.#main) ? this.#main : 0;
    const r = (x: Rect) => `${x.x},${x.y},${x.width},${x.height}`;
    const monitor = main ? win32.monitorFromWindow(main) : undefined;
    const parts = [monitor ? `${monitor.handle}:${r(monitor.work)}` : "-", main ? win32.getDpiForWindow(main) : 0];
    if (this.#config.useSecondaryMonitors ?? true) {
      for (const m of win32.listMonitors()) parts.push(`${m.handle}:${r(m.work)}:${m.dpi}`);
    }
    return parts.join("|");
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
