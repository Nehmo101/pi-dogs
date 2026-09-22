import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeLayout, type Rect } from "../../src/layout/computeLayout.ts";
import { Tiler } from "../../src/backend/windows-terminal/tiler.ts";
import { SW } from "../../src/backend/windows-terminal/win32.ts";
import { FakeWin32 } from "../helpers/fake-win32.ts";

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

  it("asks for a relayout when the work area or DPI changes", async () => {
    const { w, tiler } = setup(1);
    await tiler.apply();
    assert.equal(tiler.poll().relayout, false);
    w.monitors[0]!.work = { x: 0, y: 0, width: 3440, height: 1400 }; // taskbar auto-hidden
    assert.equal(tiler.poll().relayout, true);
    assert.equal(tiler.poll().relayout, false);
    w.monitors[0]!.dpi = 120;
    assert.equal(tiler.poll().relayout, true);
  });

  it("rejects duplicate and unknown agents", () => {
    const { tiler } = setup(1);
    assert.throws(() => tiler.add("a0"), /already/);
    assert.throws(() => tiler.minimize("zz"), /unknown/);
    assert.equal(tiler.remove("zz"), undefined);
  });
});
