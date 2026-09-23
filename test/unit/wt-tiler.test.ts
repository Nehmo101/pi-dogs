import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeLayout, type Rect } from "../../src/layout/computeLayout.ts";
import { Tiler } from "../../src/backend/windows-terminal/tiler.ts";
import { SW } from "../../src/backend/windows-terminal/win32.ts";
import { FakeWin32, outerOf } from "../helpers/fake-win32.ts";

const WORK: Rect = { x: 0, y: 0, width: 3440, height: 1392 };

function setup(n: number, config: ConstructorParameters<typeof Tiler>[2] = {}) {
  const w = new FakeWin32();
  const main = w.addMainWindow();
  const tiler = new Tiler(w, main.hwnd, { terminalSize: () => undefined, ...config });
  const agents = Array.from({ length: n }, (_, i) => {
    const win = w.addWindow({ title: `a${i}` });
    tiler.add(`a${i}`);
    tiler.attach(`a${i}`, win.hwnd);
    return win;
  });
  return { w, main, tiler, agents };
}

function assertMatchesLayout(w: FakeWin32, mainHwnd: number, tiler: Tiler): void {
  const layout = tiler.lastPlan!.layout;
  assert.deepEqual(w.frameOf(mainHwnd), layout.main, "main frame");
  for (const a of layout.agents) {
    const entry = tiler.get(a.id)!;
    assert.deepEqual(w.frameOf(entry.hwnd), a.rect, `${a.id} frame`);
  }
}

describe("Tiler.apply", () => {
  it("places main and all agents flush, in one DeferWindowPos batch", async () => {
    const { w, main, tiler } = setup(3);
    const result = await tiler.apply();
    assert.equal(result.batches, 1);
    assert.equal(w.batches.length, 1);
    assert.equal(w.batches[0]!.length, 4);
    assertMatchesLayout(w, main.hwnd, tiler);
    assert.deepEqual(tiler.lastPlan!.layout, computeLayout(WORK, [{ id: "a0" }, { id: "a1" }, { id: "a2" }]));
    // Outer rects include the invisible borders.
    assert.deepEqual(w.batches[0]![0], { hwnd: main.hwnd, x: -7, y: 0, width: 1160, height: 1399 });
  });

  it("leaves windows that are already in place alone", async () => {
    const { w, tiler } = setup(2);
    await tiler.apply();
    const second = await tiler.apply();
    assert.equal(second.placed, 0);
    assert.equal(second.batches, 0);
    assert.equal(w.batches.length, 1);
  });

  it("minimizes without activating, and restores into the slot without activating", async () => {
    const { w, main, tiler, agents } = setup(3);
    await tiler.apply();
    tiler.minimize("a1");
    await tiler.apply();
    assert.ok(w.isIconic(agents[1]!.hwnd));
    assert.deepEqual(w.shows.at(-1), [agents[1]!.hwnd, SW.SHOWMINNOACTIVE]);
    assert.equal(tiler.lastPlan!.layout.agents.length, 2);
    assertMatchesLayout(w, main.hwnd, tiler);
    tiler.unminimize("a1");
    await tiler.apply();
    assert.ok(!w.isIconic(agents[1]!.hwnd));
    assert.deepEqual(w.shows.at(-1), [agents[1]!.hwnd, SW.SHOWNOACTIVATE]);
    assert.equal(w.foreground, main.hwnd, "focus untouched");
    assert.deepEqual(tiler.entries.map((e) => e.agentId), ["a0", "a1", "a2"], "kept its place");
    assertMatchesLayout(w, main.hwnd, tiler);
  });

  it("auto-minimizes the oldest agent when there is no room and reports it", async () => {
    const { w, tiler, agents } = setup(6);
    const first = await tiler.apply();
    assert.deepEqual(first.minimizedChanges, []);
    const extra = w.addWindow({ title: "a6" });
    tiler.add("a6");
    tiler.attach("a6", extra.hwnd);
    const result = await tiler.apply();
    assert.deepEqual(result.minimizedChanges, [{ agentId: "a0", minimized: true, reason: "auto" }]);
    assert.ok(w.isIconic(agents[0]!.hwnd));
    // Restoring the auto-minimized one makes it the newest; the next oldest yields.
    tiler.unminimize("a0");
    const back = await tiler.apply();
    assert.deepEqual(back.minimizedChanges, [
      { agentId: "a1", minimized: true, reason: "auto" },
      { agentId: "a0", minimized: false, reason: "auto" },
    ]);
    assert.equal(tiler.entries.at(-1)!.agentId, "a0");
  });

  it("reserves a slot for a window that is still launching", async () => {
    const { w, main, tiler } = setup(1);
    tiler.add("pending");
    await tiler.apply();
    assert.equal(w.frameOf(main.hwnd)!.width, 1376, "main already made room for two columns");
    assert.deepEqual(tiler.targetOf("pending"), { x: 2408, y: 0, width: 1032, height: 1392 });
  });

  it("un-maximizes main before tiling and gives it back its space when alone", async () => {
    const { w, main, tiler } = setup(0);
    w.windows.get(main.hwnd)!.zoomed = true;
    w.windows.get(main.hwnd)!.outer = { x: -7, y: 0, width: 3454, height: 1399 };
    const agent = w.addWindow({ title: "a" });
    tiler.add("a");
    tiler.attach("a", agent.hwnd);
    await tiler.apply();
    assert.ok(!w.isZoomed(main.hwnd));
    assert.deepEqual(w.frameOf(main.hwnd), { x: 0, y: 0, width: 1720, height: 1392 });
    tiler.remove("a");
    await tiler.apply();
    assert.deepEqual(w.frameOf(main.hwnd), WORK, "the full work area, without re-maximizing (no focus change)");
  });

  it("restores main's own size when it was not maximized", async () => {
    const { w, main, tiler } = setup(0);
    const original = w.frameOf(main.hwnd);
    const agent = w.addWindow({ title: "a" });
    tiler.add("a");
    tiler.attach("a", agent.hwnd);
    await tiler.apply();
    tiler.remove("a");
    await tiler.apply();
    assert.deepEqual(w.frameOf(main.hwnd), original);
  });

  it("does not touch main when there never were agents, or while it is minimized", async () => {
    const { w, main, tiler } = setup(0);
    await tiler.apply();
    assert.equal(w.batches.length, 0);
    w.windows.get(main.hwnd)!.iconic = true;
    const agent = w.addWindow({ title: "a" });
    tiler.add("a");
    tiler.attach("a", agent.hwnd);
    await tiler.apply();
    assert.ok(w.batches.flat().every((p) => p.hwnd !== main.hwnd));
  });

  it("corrects windows that end up elsewhere (e.g. rescaled after a DPI change)", async () => {
    const { w, main, tiler, agents } = setup(1);
    const real = w.deferWindowPos.bind(w);
    let first = true;
    w.deferWindowPos = (placements) => {
      real(placements);
      if (first) {
        first = false;
        const win = w.windows.get(agents[0]!.hwnd)!;
        win.outer = { ...win.outer, width: win.outer.width - 20 }; // the window resized itself
      }
      return true;
    };
    const result = await tiler.apply();
    assert.equal(result.corrected, 1);
    assert.equal(result.batches, 2);
    assertMatchesLayout(w, main.hwnd, tiler);
  });

  it("animates in eased frames that end exactly on target", async () => {
    const slept: number[] = [];
    const { w, main, tiler } = setup(1, {
      animation: { durationMs: 150, frames: 6 },
      sleep: async (ms) => void slept.push(ms),
    });
    await tiler.apply();
    const widths = w.batches.map((b) => b.find((p) => p.hwnd === main.hwnd)!.width);
    assert.equal(w.batches.length, 6);
    assert.deepEqual([...widths].sort((a, b) => a - b), widths, "main grows monotonically (1295 -> 1720 px)");
    assert.equal(slept.length, 5);
    assertMatchesLayout(w, main.hwnd, tiler);
  });

  it("uses the cell size measured from the main terminal", async () => {
    const w = new FakeWin32();
    // 1295 px wide frame showing 140 columns of 8.99 px: cell ~ (1295-36)/140 = 8.99
    const main = w.addMainWindow({ x: 100, y: 100, width: 1295, height: 818 });
    const tiler = new Tiler(w, main.hwnd, { terminalSize: () => ({ cols: 140, rows: 40 }) });
    const plan = tiler.plan();
    assert.deepEqual(plan.prefs.cellSize, { w: 8.99, h: 19.05 });
    // A user override wins.
    const fixed = new Tiler(w, main.hwnd, { terminalSize: () => ({ cols: 140, rows: 40 }), prefs: { cellSize: { w: 10, h: 20 } } });
    assert.deepEqual(fixed.plan().prefs.cellSize, { w: 10, h: 20 });
  });

  it("scales prefs with the main window's DPI", () => {
    const w = new FakeWin32();
    w.monitors[0]!.dpi = 144;
    const main = w.addMainWindow();
    const plan = new Tiler(w, main.hwnd, { terminalSize: () => undefined }).plan();
    assert.equal(plan.dpi, 144);
    assert.deepEqual(plan.prefs.cellSize, { w: 14, h: 29 });
  });

  it("puts overflow agents on a second monitor, scaled for its DPI", async () => {
    const w = new FakeWin32();
    w.monitors = [
      { handle: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1032 }, primary: true, dpi: 96 },
      { handle: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, work: { x: 1920, y: 0, width: 2560, height: 1392 }, primary: false, dpi: 120 },
    ];
    const main = w.addMainWindow({ x: 100, y: 100, width: 800, height: 600 });
    const tiler = new Tiler(w, main.hwnd, { terminalSize: () => undefined });
    for (let i = 0; i < 3; i++) {
      const win = w.addWindow({ title: `a${i}` });
      tiler.add(`a${i}`);
      tiler.attach(`a${i}`, win.hwnd);
    }
    await tiler.apply();
    const plan = tiler.lastPlan!;
    assert.deepEqual(plan.secondary[0]!.cellSize, { w: 11.25, h: 23.75 });
    const onSecond = plan.layout.agents.filter((a) => a.rect.x >= 1920).map((a) => a.id);
    assert.deepEqual(onSecond, ["a0", "a1"]);
    assert.deepEqual(plan.layout.minimized, []);
    assert.equal(tiler.dpiAt(plan.layout.agents.find((a) => a.id === "a0")!.rect), 120);

    const off = new Tiler(w, main.hwnd, { terminalSize: () => undefined, useSecondaryMonitors: false });
    for (const e of tiler.entries) {
      off.add(e.agentId);
      off.attach(e.agentId, e.hwnd);
    }
    assert.equal(off.plan().secondary.length, 0);
  });
});

describe("Tiler.poll", () => {
  it("reports windows closed by the user", async () => {
    const { w, tiler, agents } = setup(2);
    await tiler.apply();
    assert.deepEqual(tiler.poll(), { closed: [], minimizedChanges: [], relayout: false });
    w.close(agents[0]!.hwnd);
    const result = tiler.poll();
    assert.deepEqual(result.closed, ["a0"]);
    assert.ok(result.relayout);
    assert.equal(tiler.get("a0"), undefined);
  });

  it("notices minimize and restore from the taskbar", async () => {
    const { w, tiler, agents } = setup(2);
    await tiler.apply();
    w.windows.get(agents[0]!.hwnd)!.iconic = true;
    const minimized = tiler.poll();
    assert.deepEqual(minimized.minimizedChanges, [{ agentId: "a0", minimized: true, reason: "user" }]);
    assert.ok(tiler.get("a0")!.userMinimized);
    await tiler.apply();
    w.windows.get(agents[0]!.hwnd)!.iconic = false;
    const restored = tiler.poll();
    assert.deepEqual(restored.minimizedChanges, [{ agentId: "a0", minimized: false, reason: "user" }]);
    assert.ok(restored.relayout);
    assert.ok(!tiler.get("a0")!.userMinimized);
  });

  it("does not mistake its own minimizing for the user's", async () => {
    const { tiler } = setup(2);
    await tiler.apply();
    tiler.minimize("a1");
    await tiler.apply();
    assert.deepEqual(tiler.poll().minimizedChanges, []);
  });

  it("asks for a relayout when the work area or DPI changes, once it is stable for 500 ms", async () => {
    let clock = 0;
    const { w, tiler } = setup(1, { now: () => clock });
    await tiler.apply();
    assert.equal(tiler.poll().relayout, false);
    w.monitors[0]!.work = { x: 0, y: 0, width: 3440, height: 1400 }; // taskbar auto-hidden
    assert.equal(tiler.poll().relayout, false, "not yet: debounced");
    clock += 499;
    assert.equal(tiler.poll().relayout, false);
    clock += 1;
    assert.equal(tiler.poll().relayout, true);
    assert.equal(tiler.poll().relayout, false);
    w.monitors[0]!.dpi = 120;
    tiler.poll();
    clock += 200;
    w.monitors[0]!.dpi = 144; // changed again: the 500 ms start over
    tiler.poll();
    clock += 400;
    assert.equal(tiler.poll().relayout, false);
    clock += 100;
    assert.equal(tiler.poll().relayout, true);
  });

  it("does not re-tile while the user drags main (move/size loop or mouse button down)", async () => {
    let clock = 0;
    const { w, main, tiler } = setup(1, { now: () => clock });
    await tiler.apply();
    tiler.poll();
    w.monitors[0]!.work = { x: 0, y: 0, width: 3440, height: 1400 };
    tiler.poll();
    w.inMoveSize.add(main.hwnd);
    clock += 2000;
    assert.equal(tiler.poll().relayout, false, "still dragging");
    w.inMoveSize.clear();
    w.mouseDown = true;
    assert.equal(tiler.poll().relayout, false, "button still down");
    w.mouseDown = false;
    assert.equal(tiler.poll().relayout, true);
  });

  it("keeps close events when the monitor list is empty for a moment (RDP reconnect)", async () => {
    const { w, tiler, agents } = setup(3);
    await tiler.apply();
    w.windows.get(agents[1]!.hwnd)!.iconic = true;
    tiler.poll();
    const saved = w.monitors;
    w.monitors = [];
    w.close(agents[0]!.hwnd);
    w.windows.get(agents[1]!.hwnd)!.iconic = false; // restored by the user at the same time
    const result = tiler.poll();
    assert.deepEqual(result.closed, ["a0"]);
    assert.deepEqual(result.minimizedChanges, [{ agentId: "a1", minimized: false, reason: "user" }]);
    assert.equal(tiler.entries.at(-1)!.agentId, "a1", "restored one is promoted so it is shown");
    w.monitors = saved;
  });

  it("follows main to another WT window (tab torn out) and gives the old window its frame back", async () => {
    const w = new FakeWin32();
    const main = w.addMainWindow();
    let current = main.hwnd;
    const tiler = new Tiler(w, main.hwnd, { terminalSize: () => undefined, resolveMain: () => current });
    const agent = w.addWindow({ title: "a" });
    tiler.add("a");
    tiler.attach("a", agent.hwnd);
    const original = w.frameOf(main.hwnd);
    await tiler.apply();
    const torn = w.addWindow({ title: "pi (torn out)", frame: { x: 500, y: 300, width: 900, height: 700 } });
    current = torn.hwnd;
    assert.equal(tiler.poll().relayout, true);
    assert.equal(tiler.main, torn.hwnd);
    assert.deepEqual(w.frameOf(main.hwnd), original, "old window restored");
    await tiler.apply();
    assert.deepEqual(w.frameOf(torn.hwnd), tiler.lastPlan!.layout.main);
  });
});

describe("Tiler robustness", () => {
  it("skips hung windows entirely", async () => {
    const { w, main, tiler, agents } = setup(2);
    w.hung.add(agents[0]!.hwnd);
    await tiler.apply();
    assert.ok(w.batches.flat().every((p) => p.hwnd !== agents[0]!.hwnd));
    assert.ok(w.shows.every(([h]) => h !== agents[0]!.hwnd));
    assert.deepEqual(w.frameOf(agents[1]!.hwnd), tiler.targetOf("a1"));
    assert.deepEqual(w.frameOf(main.hwnd), tiler.lastPlan!.layout.main);
  });

  it("un-maximizes a maximized agent window before placing it", async () => {
    const { w, main, tiler, agents } = setup(2);
    w.windows.get(agents[1]!.hwnd)!.zoomed = true;
    await tiler.apply();
    assert.ok(!w.isZoomed(agents[1]!.hwnd));
    assert.ok(w.shows.some(([h, cmd]) => h === agents[1]!.hwnd && cmd === SW.SHOWNOACTIVATE));
    assertMatchesLayout(w, main.hwnd, tiler);
  });

  it("falls back to one SetWindowPos per window when the batch fails", async () => {
    const logs: string[] = [];
    const { w, main, tiler } = setup(2, { log: (m) => logs.push(m) });
    w.failDefer = true;
    await tiler.apply();
    assert.equal(w.singles.length, 3);
    assertMatchesLayout(w, main.hwnd, tiler);
    assert.ok(logs.some((l) => /one by one/.test(l)));
  });

  it("reads a window back again about 100 ms after it changed DPI (moved to another monitor)", async () => {
    const w = new FakeWin32();
    w.monitors = [
      { handle: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1032 }, primary: true, dpi: 96 },
      { handle: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, work: { x: 1920, y: 0, width: 2560, height: 1392 }, primary: false, dpi: 144 },
    ];
    const main = w.addMainWindow({ x: 100, y: 100, width: 800, height: 600 });
    const slept: number[] = [];
    let late: (() => void) | undefined;
    const tiler = new Tiler(w, main.hwnd, {
      terminalSize: () => undefined,
      sleep: async (ms) => {
        slept.push(ms);
        late?.();
        late = undefined;
      },
    });
    const wins = [0, 1, 2].map((i) => {
      const win = w.addWindow({ title: `a${i}`, frame: { x: 200 + i, y: 200, width: 600, height: 400 } });
      tiler.add(`a${i}`);
      tiler.attach(`a${i}`, win.hwnd);
      return win;
    });
    const real = w.deferWindowPos.bind(w);
    let batches = 0;
    w.deferWindowPos = (placements) => {
      real(placements);
      if (++batches === 1) {
        // a0 crossed to the 144 DPI monitor; WT rescales it only a little later.
        late = () => {
          const win = w.windows.get(wins[0]!.hwnd)!;
          win.outer = { ...win.outer, width: Math.round(win.outer.width * 1.5) };
        };
      }
      return true;
    };
    await tiler.apply();
    assert.ok(slept.includes(100), "second read-back after the DPI change");
    for (const a of tiler.lastPlan!.layout.agents) assert.deepEqual(w.frameOf(tiler.get(a.id)!.hwnd), a.rect);
  });

  it("reports an auto-minimized agent that is then minimized explicitly only once", async () => {
    const { w, tiler } = setup(6);
    const extra = w.addWindow({ title: "a6" });
    tiler.add("a6");
    tiler.attach("a6", extra.hwnd);
    const first = await tiler.apply();
    assert.deepEqual(first.minimizedChanges, [{ agentId: "a0", minimized: true, reason: "auto" }]);
    tiler.minimize("a0");
    const second = await tiler.apply();
    assert.deepEqual(second.minimizedChanges, [], "no spurious {minimized: false, auto}");
  });

  it("restoreMain() gives main its frame back in one SetWindowPos, on the monitor it is on now", async () => {
    const w = new FakeWin32();
    w.monitors = [
      { handle: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work: { x: 0, y: 0, width: 1920, height: 1032 }, primary: true, dpi: 96 },
      { handle: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, work: { x: 1920, y: 0, width: 2560, height: 1392 }, primary: false, dpi: 96 },
    ];
    const main = w.addMainWindow({ x: 100, y: 100, width: 800, height: 600 });
    const tiler = new Tiler(w, main.hwnd, { terminalSize: () => undefined });
    const agent = w.addWindow({ title: "a" });
    tiler.add("a");
    tiler.attach("a", agent.hwnd);
    await tiler.apply();
    // The user dragged main to the second monitor since.
    w.windows.get(main.hwnd)!.outer = outerOf({ x: 1920, y: 0, width: 1280, height: 1392 });
    assert.equal(tiler.restoreMain(), true);
    assert.equal(w.singles.length, 1);
    assert.deepEqual(w.frameOf(main.hwnd), { x: 2020, y: 100, width: 800, height: 600 });
    assert.equal(tiler.restoreMain(), false, "only once");
  });

  it("rejects duplicate and unknown agents", () => {
    const { tiler } = setup(1);
    assert.throws(() => tiler.add("a0"), /already/);
    assert.throws(() => tiler.minimize("zz"), /unknown/);
    assert.equal(tiler.remove("zz"), undefined);
  });
});
