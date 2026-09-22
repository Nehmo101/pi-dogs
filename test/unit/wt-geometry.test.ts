import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  animationFrames,
  cellsFor,
  defaultInsets,
  easeOutCubic,
  estimateCellSize,
  frameInsets,
  launchGeometry,
  lerpRect,
  outerRect,
  overlapArea,
  plausibleInsets,
  sameRect,
} from "../../src/backend/windows-terminal/geometry.ts";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("frame compensation", () => {
  it("measures the invisible borders (Windows 11: 7/0/7/7 at 96 DPI)", () => {
    // Measured: GetWindowRect 1992,300 769x445 vs. DWM frame 1999,300 755x438.
    assert.deepEqual(frameInsets(rect(1992, 300, 769, 445), rect(1999, 300, 755, 438)), {
      left: 7, top: 0, right: 7, bottom: 7,
    });
  });

  it("turns a visible target into the outer SetWindowPos rect and back", () => {
    const insets = { left: 7, top: 0, right: 7, bottom: 7 };
    const outer = outerRect(rect(1146, 0, 765, 1392), insets);
    assert.deepEqual(outer, rect(1139, 0, 779, 1399));
    assert.deepEqual(frameInsets(outer, rect(1146, 0, 765, 1392)), insets);
  });

  it("scales default insets with DPI and rejects implausible ones", () => {
    assert.deepEqual(defaultInsets(), { left: 7, top: 0, right: 7, bottom: 7 });
    assert.deepEqual(defaultInsets(144), { left: 11, top: 0, right: 11, bottom: 11 });
    assert.ok(plausibleInsets(defaultInsets()));
    // A minimized window reports its caption-sized icon rect: nonsense insets.
    assert.ok(!plausibleInsets({ left: 0, top: 0, right: 120, bottom: 0 }));
    assert.deepEqual(frameInsets(rect(10, 10, 100, 100), rect(0, 0, 200, 200)), { left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe("launch geometry", () => {
  const cell = { w: 8.99, h: 19.05 };
  const chrome = { w: 36, h: 56 };

  it("matches what the integration test measured for WT 1.24", () => {
    // Slot 1720,0 1720x1392 -> launched with --pos 1721,0 --size 187,70, appeared at 1720,0 1718x1388.
    assert.deepEqual(launchGeometry(rect(1720, 0, 1720, 1392), cell, chrome), {
      pos: { x: 1721, y: 0 },
      size: { cols: 187, rows: 70 },
    });
    assert.deepEqual(launchGeometry(rect(2408, 696, 1032, 696), cell, chrome).size, { cols: 110, rows: 33 });
  });

  it("never asks for less than one cell", () => {
    assert.deepEqual(launchGeometry(rect(0, 0, 10, 10), cell, chrome).size, { cols: 1, rows: 1 });
  });

  it("counts the cells of a frame", () => {
    assert.deepEqual(cellsFor({ w: 765, h: 1392 }, { w: 9, h: 19 }, chrome), { cols: 81, rows: 70 });
    assert.deepEqual(cellsFor({ w: 10, h: 10 }, { w: 9, h: 19 }, chrome), { cols: 0, rows: 0 });
  });
});

describe("estimateCellSize", () => {
  const fallback = { w: 9, h: 19 };
  const chrome = { w: 36, h: 56 };

  it("derives the cell size from the main window's frame and terminal size", () => {
    // Measured: a 935x628 frame showed 100x30 cells.
    assert.deepEqual(estimateCellSize({ w: 935, h: 628 }, { cols: 100, rows: 30 }, chrome, fallback), { w: 8.99, h: 19.07 });
  });

  it("follows a smaller font", () => {
    assert.deepEqual(estimateCellSize({ w: 1756, h: 1400 }, { cols: 215, rows: 84 }, chrome, fallback), { w: 8, h: 16 });
  });

  it("falls back when the numbers do not fit (split panes, missing tty)", () => {
    assert.equal(estimateCellSize({ w: 1720, h: 1392 }, { cols: 90, rows: 70 }, chrome, fallback), fallback);
    assert.equal(estimateCellSize({ w: 1720, h: 1392 }, { cols: 0, rows: 0 }, chrome, fallback), fallback);
  });
});

describe("animation frames", () => {
  it("eases out and ends exactly on the target", () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.ok(easeOutCubic(0.5) > 0.5);
    assert.equal(easeOutCubic(2), 1);
    const frames = animationFrames(rect(0, 0, 1720, 1392), rect(0, 0, 1146, 1392), 6);
    assert.equal(frames.length, 6);
    assert.deepEqual(frames.at(-1), rect(0, 0, 1146, 1392));
    const widths = frames.map((f) => f.width);
    assert.deepEqual([...widths].sort((a, b) => b - a), widths, "monotonic");
  });

  it("keeps shared edges shared in every frame (no gaps between neighbours)", () => {
    // main 1720 -> 1146 and its neighbour 1720..3440 -> 1146..1911
    const a = animationFrames(rect(0, 0, 1720, 1392), rect(0, 0, 1146, 1392), 6);
    const b = animationFrames(rect(1720, 0, 1720, 1392), rect(1146, 0, 765, 1392), 6);
    a.forEach((f, i) => assert.equal(f.x + f.width, b[i]!.x));
  });

  it("jumps when there is nothing to animate", () => {
    assert.deepEqual(animationFrames(rect(1, 2, 3, 4), rect(1, 2, 3, 4), 6), [rect(1, 2, 3, 4)]);
    assert.deepEqual(animationFrames(rect(0, 0, 3, 4), rect(9, 9, 3, 4), 1), [rect(9, 9, 3, 4)]);
    assert.deepEqual(lerpRect(rect(0, 0, 10, 10), rect(10, 10, 10, 10), 0.5), rect(5, 5, 10, 10));
  });

  it("compares and intersects rects", () => {
    assert.ok(sameRect(rect(1, 2, 3, 4), rect(1, 2, 3, 4)));
    assert.ok(!sameRect(rect(1, 2, 3, 4), rect(1, 2, 3, 5)));
    assert.equal(overlapArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), 25);
    assert.equal(overlapArea(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), 0);
  });
});
