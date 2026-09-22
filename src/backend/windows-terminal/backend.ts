/**
 * WindowsTerminalBackend: one Windows Terminal window per agent, tiled next
 * to the main pi window via Win32 (docs/window-backend.md).
 *
 * Flow of `open()`:
 * 1. Reserve the new agent's slot and relayout right away, so the existing
 *    windows make room (coalesced: several agents opened at once cause one
 *    relayout, and every new window already knows its final slot).
 * 2. Launch `wt -w pi-dogs-<id>-<nonce> --pos --size new-tab ...` so the
 *    window appears in its slot at about the right size.
 * 3. Find the HWND (new WT window with the unique title), give the focus
 *    back to whatever had it (new WT windows always take the foreground),
 *    and apply the exact layout.
 *
 * A 250 ms poll notices windows closed by the user or by their process
 * exiting, windows (un)minimized from the taskbar, and monitor, work area
 * or DPI changes; each of these triggers a relayout.
 */

import { randomInt } from "node:crypto";

import type { BackendEvents, OpenSpec, PaneBackend, PaneRef } from "../pane-backend.ts";
import type { LayoutPrefs, Rect } from "../../layout/computeLayout.ts";
import { minimumSizes } from "../../layout/computeLayout.ts";
import { launchGeometry } from "./geometry.ts";
import { agentTitle, discoverWindow, findWtExe, runWt, snapshotWtWindows, uniqueTitle } from "./launch.ts";
import { findMainWindow, type MainWindowResult } from "./main-window.ts";
import { CoalescingScheduler } from "./scheduler.ts";
import { Tiler, type AnimationConfig, type ApplyResult, type MinimizedChange, type Plan } from "./tiler.ts";
import { SW, tryLoadWin32, WM_CLOSE, type Hwnd, type Win32 } from "./win32.ts";
import { buildWtArgs } from "./wt-args.ts";

export interface WindowsTerminalBackendOptions {
  /** Layout overrides from the user's config (arrangement, minimum columns, cell size, ...). */
  prefs?: Partial<LayoutPrefs>;
  /** Put agents that do not fit next to main on other monitors before minimizing them. Default true. */
  useSecondaryMonitors?: boolean;
  /** Eased transitions between layouts. Default false (single step), see docs/window-backend.md. */
  animation?: AnimationConfig | false;
  /** How long to wait for a new window to appear. Default 8000 ms. */
  discoveryTimeoutMs?: number;
  /** Interval of the close/minimize/monitor poll. Default 250 ms. */
  pollIntervalMs?: number;
  /** Quiet time that ends a burst of relayout requests. Default 30 ms. */
  relayoutDelayMs?: number;
  /** Longest a relayout is postponed by a burst. Default 200 ms. */
  relayoutMaxDelayMs?: number;
  /** Diagnostics sink (pi-dogs routes it to its debug log). */
  log?: (message: string) => void;
  /** Injection points for tests. */
  win32?: Win32;
  wtExe?: string;
  runWt?: (wtExe: string, argv: readonly string[]) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  terminalSize?: () => { cols: number; rows: number } | undefined;
}

export interface WindowsTerminalDiagnostics {
  main: MainWindowResult | undefined;
  windows: { agentId: string; hwnd: Hwnd; userMinimized: boolean; autoMinimized: boolean }[];
  lastApply: ApplyResult | undefined;
  /** The layout last applied (work area, prefs incl. measured cell size, rects). */
  plan: Plan | undefined;
}

export class WindowsTerminalBackend implements PaneBackend {
  readonly name = "windows-terminal";
  readonly #options: WindowsTerminalBackendOptions;
  readonly #env: NodeJS.ProcessEnv;
  #events: BackendEvents = {};
  #win32: Win32 | undefined;
  #tiler: Tiler | undefined;
  #main: MainWindowResult | undefined;
  #scheduler: CoalescingScheduler | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #lastApply: ApplyResult | undefined;
  #disposed = false;
  /** Agent windows launched in the last seconds (they take the foreground once when they appear). */
  readonly #recentLaunches = new Map<Hwnd, number>();

  constructor(options: WindowsTerminalBackendOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
  }

  available(): { ok: true } | { ok: false; hint: string } {
    if (!this.#options.win32 && process.platform !== "win32") {
      return { ok: false, hint: "The windows-terminal backend needs Windows 10/11." };
    }
    if (!this.#env["WT_SESSION"]) {
      return {
        ok: false,
        hint: "pi is not running inside Windows Terminal (WT_SESSION is not set). Start pi from a Windows Terminal tab.",
      };
    }
    if (!(this.#options.wtExe ?? findWtExe(this.#env))) {
      return {
        ok: false,
        hint: "wt.exe was not found on PATH. Install Windows Terminal (winget install Microsoft.WindowsTerminal) and make sure its app execution alias is enabled.",
      };
    }
    if (!this.#options.win32) {
      const loaded = tryLoadWin32();
      if (!loaded.ok) {
        return {
          ok: false,
          hint: `${loaded.error.message}. Reinstall pi-dogs so its koffi dependency is present (npm install).`,
        };
      }
    }
    return { ok: true };
  }

  setEvents(events: BackendEvents): void {
    this.#events = events;
  }

  async open(spec: OpenSpec): Promise<PaneRef> {
    const { win32, tiler, scheduler } = this.#start();
    if (tiler.get(spec.agentId)) throw new Error(`agent ${spec.agentId} already has a window`);
    const foreground = win32.getForegroundWindow();
    tiler.add(spec.agentId);
    try {
      // 1. Make room (one relayout for a whole burst of opens).
      await scheduler.request();
      if (this.#disposed) throw new Error("backend disposed");

      // 2. Launch in place.
      const plan = tiler.lastPlan ?? tiler.plan();
      const target = tiler.targetOf(spec.agentId) ?? this.#fallbackRect(plan.monitor.work, plan.prefs);
      const dpi = tiler.dpiAt(target);
      const f = dpi / plan.dpi;
      const cell = { w: plan.prefs.cellSize.w * f, h: plan.prefs.cellSize.h * f };
      const chrome = { w: plan.prefs.chrome.w * f, h: plan.prefs.chrome.h * f };
      const { pos, size } = launchGeometry(target, cell, chrome, dpi);
      const title = uniqueTitle(agentTitle(spec.name, spec.modelLabel), randomInt(65536));
      const argv = buildWtArgs({
        windowName: windowNameFor(spec.agentId),
        title,
        ...(/^#[0-9a-fA-F]{6}$/.test(spec.color) ? { tabColor: spec.color } : {}),
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        pos,
        size,
        command: spec.command,
        args: spec.args,
      });
      const before = snapshotWtWindows(win32);
      await this.#launch(argv);

      // 3. Find it, hand the focus back, place it exactly.
      const hwnd = await discoverWindow(win32, title, before, {
        timeoutMs: this.#options.discoveryTimeoutMs ?? 8000,
        pollMs: 15,
        cancelled: () => this.#disposed || !tiler.get(spec.agentId),
      });
      if (!hwnd) {
        if (!tiler.get(spec.agentId)) throw new Error(`agent ${spec.agentId} was closed while its window was opening`);
        throw new Error(
          `the window for ${spec.name} did not appear within ${this.#options.discoveryTimeoutMs ?? 8000} ms`,
        );
      }
      if (!tiler.get(spec.agentId)) {
        win32.postMessage(hwnd, WM_CLOSE);
        throw new Error(`agent ${spec.agentId} was closed while its window was opening`);
      }
      tiler.attach(spec.agentId, hwnd);
      const appeared = win32.getFrameBounds(hwnd);
      this.#log(
        `window ${hwnd} for ${spec.agentId} appeared at ${rectText(appeared)} (slot ${rectText(target)}, --pos ${pos.x},${pos.y} --size ${size.cols},${size.rows})`,
      );
      const focusBack = this.#returnFocus(foreground, hwnd);
      await scheduler.request();
      await focusBack;
      return { agentId: spec.agentId };
    } catch (error) {
      if (tiler.remove(spec.agentId)) void scheduler.request().catch(() => {});
      throw error;
    }
  }

  async minimize(ref: PaneRef): Promise<void> {
    const { tiler, scheduler } = this.#start();
    const entry = tiler.get(ref.agentId);
    if (!entry || entry.userMinimized) return;
    tiler.minimize(ref.agentId);
    await scheduler.request();
  }

  async restore(ref: PaneRef): Promise<void> {
    const { tiler, scheduler } = this.#start();
    const entry = tiler.get(ref.agentId);
    if (!entry) return;
    tiler.unminimize(ref.agentId);
    await scheduler.request();
  }

  async focus(ref: PaneRef): Promise<void> {
    const { win32, tiler, scheduler } = this.#start();
    const entry = tiler.get(ref.agentId);
    if (!entry?.hwnd) return;
    if (entry.userMinimized || entry.autoMinimized || win32.isIconic(entry.hwnd)) {
      tiler.unminimize(ref.agentId);
      await scheduler.request();
    }
    // The user asked to look at this agent: taking the focus is intended here.
    if (win32.isIconic(entry.hwnd)) win32.showWindow(entry.hwnd, SW.RESTORE);
    win32.setForegroundWindow(entry.hwnd);
  }

  async close(ref: PaneRef): Promise<void> {
    const { win32, tiler, scheduler } = this.#start();
    const entry = tiler.remove(ref.agentId);
    if (!entry) return;
    const relayout = scheduler.request();
    if (entry.hwnd && win32.isWindow(entry.hwnd)) {
      // WT closes the window (and ends the tab's process) on WM_CLOSE; verified with WT 1.24.
      win32.postMessage(entry.hwnd, WM_CLOSE);
      const deadline = Date.now() + 3000;
      while (win32.isWindow(entry.hwnd) && Date.now() < deadline) await sleep(25);
    }
    await relayout;
  }

  async relayout(): Promise<void> {
    if (!this.#tiler || this.#disposed) return;
    await this.#scheduler!.flush();
  }

  /** State for tests, diagnostics and `/dogs debug`. */
  diagnostics(): WindowsTerminalDiagnostics {
    return {
      main: this.#main,
      windows: (this.#tiler?.entries ?? []).map((e) => ({
        agentId: e.agentId,
        hwnd: e.hwnd,
        userMinimized: e.userMinimized,
        autoMinimized: e.autoMinimized,
      })),
      lastApply: this.#lastApply,
      plan: this.#tiler?.lastPlan,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    this.#scheduler?.dispose();
  }

  // ---------------------------------------------------------------------------

  /** Load Win32, find the main window and start the poll, on first use. */
  #start(): { win32: Win32; tiler: Tiler; scheduler: CoalescingScheduler } {
    if (this.#disposed) throw new Error("WindowsTerminalBackend is disposed");
    if (this.#tiler && this.#scheduler && this.#win32) {
      return { win32: this.#win32, tiler: this.#tiler, scheduler: this.#scheduler };
    }
    let win32 = this.#options.win32;
    if (!win32) {
      const loaded = tryLoadWin32();
      if (!loaded.ok) throw loaded.error;
      win32 = loaded.win32;
    }
    const main = findMainWindow(win32, this.#env);
    this.#main = main;
    if (main.source === "none") this.#log(`main pi window not found (${main.reason}); agents are tiled without it`);
    else this.#log(`main pi window ${main.hwnd} (${main.source})`);

    const terminalSize =
      this.#options.terminalSize ??
      (() => (process.stdout.isTTY ? { cols: process.stdout.columns, rows: process.stdout.rows } : undefined));
    const tiler = new Tiler(win32, main.hwnd, {
      ...(this.#options.prefs ? { prefs: this.#options.prefs } : {}),
      useSecondaryMonitors: this.#options.useSecondaryMonitors ?? true,
      animation: this.#options.animation ?? false,
      terminalSize,
    });
    const scheduler = new CoalescingScheduler(() => this.#apply(tiler), {
      delayMs: this.#options.relayoutDelayMs ?? 30,
      maxDelayMs: this.#options.relayoutMaxDelayMs ?? 200,
    });
    this.#win32 = win32;
    this.#tiler = tiler;
    this.#scheduler = scheduler;

    this.#pollTimer = setInterval(() => this.#poll(), this.#options.pollIntervalMs ?? 250);
    this.#pollTimer.unref?.();
    return { win32, tiler, scheduler };
  }

  async #apply(tiler: Tiler): Promise<void> {
    if (this.#disposed) return;
    const result = await tiler.apply();
    this.#lastApply = result;
    this.#emitMinimized(result.minimizedChanges);
    if (result.placed > 0) {
      this.#log(
        `relayout: ${result.placed} windows, ${result.batches} batches, ${result.batchMs.toFixed(1)} ms in DeferWindowPos, ${result.ms.toFixed(1)} ms total`,
      );
    }
  }

  #poll(): void {
    const tiler = this.#tiler;
    if (!tiler || this.#disposed) return;
    let result;
    try {
      result = tiler.poll();
    } catch (error) {
      this.#log(`poll failed: ${(error as Error).message}`);
      return;
    }
    for (const agentId of result.closed) this.#safe(() => this.#events.onClosed?.({ agentId }));
    this.#emitMinimized(result.minimizedChanges);
    if (result.relayout) void this.#scheduler?.request().catch((error) => this.#log(`relayout failed: ${error}`));
  }

  #emitMinimized(changes: readonly MinimizedChange[]): void {
    for (const c of changes) {
      this.#safe(() => this.#events.onMinimizedChange?.({ agentId: c.agentId }, c.minimized, c.reason));
    }
  }


  async #launch(argv: string[]): Promise<void> {
    const wtExe = this.#options.wtExe ?? findWtExe(this.#env) ?? "wt.exe";
    const run = this.#options.runWt ?? runWt;
    try {
      await run(wtExe, argv);
    } catch (error) {
      // Only retry when wt.exe itself failed: then nothing was launched, and a
      // retry cannot start the agent twice.
      this.#log(`wt.exe failed (${(error as Error).message}), retrying once`);
      await sleep(250);
      await run(wtExe, argv);
    }
  }

  /**
   * New WT windows always take the foreground. Give it back to the window
   * that had it before the launch (usually main) as soon as the new window
   * becomes active; watch for a short while because activation can happen a
   * little after the window gets its title.
   *
   * When several agents open at once, the foreground may also be *another*
   * window of the same burst; that counts as stolen too. Any other window
   * means the user moved on, and we leave the focus alone.
   */
  async #returnFocus(previous: Hwnd, launched: Hwnd): Promise<void> {
    const win32 = this.#win32!;
    this.#recentLaunches.set(launched, Date.now());
    try {
      if (!previous || previous === launched || this.#isRecentLaunch(previous)) return;
      const deadline = Date.now() + 600;
      let restoredAt = 0;
      while (Date.now() < deadline) {
        const now = win32.getForegroundWindow();
        if (now === previous) {
          if (restoredAt && Date.now() - restoredAt > 150) return; // stayed put: done
          await sleep(15);
          continue;
        }
        if (now && now !== launched && !this.#isRecentLaunch(now)) return; // the user moved on
        if (now && win32.isWindow(previous)) {
          if (!win32.setForegroundWindow(previous)) {
            this.#log("could not give the focus back to the previous window");
            return;
          }
          restoredAt = Date.now();
        }
        await sleep(15);
      }
    } finally {
      // Keep the entry a little longer so later windows of the same burst still recognise it.
      setTimeout(() => this.#recentLaunches.delete(launched), 2000).unref?.();
    }
  }

  #isRecentLaunch(hwnd: Hwnd): boolean {
    const at = this.#recentLaunches.get(hwnd);
    return at !== undefined && Date.now() - at < 3000;
  }

  /** Where a window goes when the layout has no slot for it (it is minimized right after). */
  #fallbackRect(work: Rect, prefs: LayoutPrefs): Rect {
    const min = minimumSizes(prefs).agent;
    const width = Math.min(work.width, min.w);
    const height = Math.min(work.height, min.h);
    return {
      x: work.x + Math.floor((work.width - width) / 2),
      y: work.y + Math.floor((work.height - height) / 2),
      width,
      height,
    };
  }

  #safe(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#log(`event handler threw: ${(error as Error).message}`);
    }
  }

  #log(message: string): void {
    this.#options.log?.(`[windows-terminal] ${message}`);
  }
}

/**
 * `wt -w` name for an agent window. A random suffix makes sure we never
 * reuse a window left over from an earlier session (wt would add a tab to it
 * instead of creating a window).
 */
export function windowNameFor(agentId: string, nonce = randomInt(1 << 30).toString(36)): string {
  const safe = agentId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40) || "agent";
  return `pi-dogs-${safe}-${nonce}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rectText = (r: Rect | undefined) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : "?");
