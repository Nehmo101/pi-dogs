import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeLayout,
  DEFAULT_LAYOUT_PREFS,
  layoutPrefsForScale,
  minimumSizes,
  type Arrangement,
  type Layout,
  type LayoutAgent,
  type LayoutPrefs,
  type Rect,
} from "../../src/layout/computeLayout.ts";
import { renderLayout } from "../helpers/ascii.ts";

// Physical work areas (monitor minus a 48 px taskbar) at common resolutions.
const WORK_AREAS: Rect[] = [
  { x: 0, y: 0, width: 1920, height: 1032 },
  { x: 0, y: 0, width: 2560, height: 1392 },
  { x: 0, y: 0, width: 3440, height: 1392 },
  { x: 0, y: 0, width: 3840, height: 2112 },
];
const SCALES = [1, 1.25, 1.5];
const ARRANGEMENTS: Arrangement[] = ["columns", "stacked"];

const agentsOf = (n: number): LayoutAgent[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));
const area = (width: number, height: number, x = 0, y = 0): Rect => ({ x, y, width, height });
const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

function groupBy<T>(items: T[], key: (item: T) => number): T[][] {
  const groups = new Map<number, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]) => g);
}

function assertSpread(values: number[], max: number, what: string): void {
  assert.ok(Math.max(...values) - Math.min(...values) <= max, `${what} differ by more than ${max}px: ${values}`);
}

/** Assert that consecutive segments are separated by exactly `gap` and span [start, end). */
function assertTiles(segments: { start: number; end: number }[], start: number, end: number, gap: number, what: string) {
  assert.equal(segments[0]!.start, start, `${what}: first segment starts at the edge`);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i]!.start, segments[i - 1]!.end + gap, `${what}: segment ${i} is ${gap}px after the previous`);
  }
  assert.equal(segments.at(-1)!.end, end, `${what}: last segment ends at the edge`);
}

/** Check every invariant a layout must satisfy, independent of screen and arrangement. */
function assertValidLayout(work: Rect, input: LayoutAgent[], prefs: LayoutPrefs, layout: Layout): void {
  const rects = [layout.main, ...layout.agents.map((a) => a.rect)];
  const label = `${work.width}x${work.height} ${prefs.arrangement} n=${input.length}`;

  for (const r of rects) {
    for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(v), `${label}: integer coords`);
    assert.ok(r.width > 0 && r.height > 0, `${label}: positive size`);
    assert.ok(r.x >= work.x && r.y >= work.y && right(r) <= right(work) && bottom(r) <= bottom(work), `${label}: inside`);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i]!, rects[j]!];
      const overlap = a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
      assert.ok(!overlap, `${label}: rects ${i} and ${j} overlap`);
    }
  }
  if (prefs.gap === 0) {
    const covered = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    assert.equal(covered, work.width * work.height, `${label}: rects cover the work area exactly`);
  }

  // Ids: every agent is either placed or minimized; the shown ones are the newest.
  const shown = layout.agents.map((a) => a.id);
  const candidates = input.filter((a) => !a.minimized).map((a) => a.id);
  assert.deepEqual(shown, candidates.slice(candidates.length - shown.length), `${label}: newest agents are shown`);
  assert.deepEqual(
    layout.minimized,
    input.map((a) => a.id).filter((id) => !shown.includes(id)),
    `${label}: minimized lists all others in input order`,
  );

  // Main window: left, full height, share and minimum width.
  const min = minimumSizes(work.width, prefs);
  assert.equal(layout.main.x, work.x);
  assert.equal(layout.main.y, work.y);
  assert.equal(layout.main.height, work.height);
  if (layout.agents.length === 0) {
    assert.deepEqual(layout.main, work, `${label}: main fills the work area when alone`);
    return;
  }
  assert.ok(layout.main.width >= min.main, `${label}: main keeps its minimum width`);
  assert.ok(layout.main.width >= 0.45 * work.width, `${label}: main keeps >= 45% of the width`);
  for (const { id, rect } of layout.agents) {
    assert.ok(rect.width >= min.agent.w, `${label}: ${id} width ${rect.width} >= ${min.agent.w}`);
    assert.ok(rect.height >= min.agent.h, `${label}: ${id} height ${rect.height} >= ${min.agent.h}`);
  }

  // Structure: tracks tile the agent area; items tile each track.
  const agentRects = layout.agents.map((a) => a.rect);
  const agentsX = right(layout.main) + prefs.gap;
  const xs = (rs: Rect[]) => rs.map((r) => ({ start: r.x, end: right(r) }));
  const ys = (rs: Rect[]) => rs.map((r) => ({ start: r.y, end: bottom(r) }));
  if (prefs.arrangement === "stacked") {
    const columns = groupBy(agentRects, (r) => r.x);
    assertTiles(xs(columns.map((c) => c[0]!)), agentsX, right(work), prefs.gap, `${label}: columns`);
    assertSpread(columns.map((c) => c[0]!.width), 1, `${label}: column widths`);
    for (const column of columns) {
      assertSpread(column.map((r) => r.width), 0, `${label}: widths within a column`);
      assertSpread(column.map((r) => r.height), 1, `${label}: heights within a column`);
      assertTiles(ys([...column].sort((a, b) => a.y - b.y)), work.y, bottom(work), prefs.gap, `${label}: column items`);
    }
  } else {
    const rows = groupBy(agentRects, (r) => r.y);
    assertTiles(ys(rows.map((r) => r[0]!)), work.y, bottom(work), prefs.gap, `${label}: rows`);
    assertSpread(rows.map((r) => r[0]!.height), 1, `${label}: row heights`);
    for (const row of rows) {
      assertSpread(row.map((r) => r.height), 0, `${label}: heights within a row`);
      assertSpread(row.map((r) => r.width), 1, `${label}: widths within a row`);
      assertTiles(xs([...row].sort((a, b) => a.x - b.x)), agentsX, right(work), prefs.gap, `${label}: row items`);
    }
  }
}

describe("computeLayout invariants across screens, scales and agent counts", () => {
  for (const arrangement of ARRANGEMENTS) {
    for (const work of WORK_AREAS) {
      for (const scale of SCALES) {
        it(`${arrangement} ${work.width}x${work.height} @${scale * 100}%`, () => {
          for (const gap of [0, 8]) {
            const prefs = layoutPrefsForScale(scale, { arrangement, gap });
            let previousShown = 0;
            for (let n = 0; n <= 8; n++) {
              const input = agentsOf(n);
              const layout = computeLayout(work, input, prefs);
              assertValidLayout(work, input, prefs, layout);
              assert.deepEqual(computeLayout(work, input, prefs), layout, "deterministic");
              assert.ok(layout.agents.length >= previousShown, "adding an agent never hides more windows");
              previousShown = layout.agents.length;
            }
          }
        });
      }
    }
  }
});

describe("computeLayout rules", () => {
  const p100 = (overrides: Partial<LayoutPrefs> = {}) => layoutPrefsForScale(1, overrides);

  it("gives the main window the whole work area without agents", () => {
    const work = area(2560, 1392);
    assert.deepEqual(computeLayout(work, []), { main: work, agents: [], minimized: [] });
  });

  for (const arrangement of ARRANGEMENTS) {
    it(`${arrangement}: splits 50/50 with one agent`, () => {
      const layout = computeLayout(area(1920, 1032), agentsOf(1), p100({ arrangement }));
      assert.deepEqual(layout.main, area(960, 1032));
      assert.deepEqual(layout.agents, [{ id: "a0", rect: area(960, 1032, 960) }]);
    });

    it(`${arrangement}: auto-minimizes the oldest agents when space runs out`, () => {
      const layout = computeLayout(area(1920, 1032), agentsOf(4), p100({ arrangement }));
      assert.deepEqual(layout.agents.map((a) => a.id), ["a2", "a3"]);
      assert.deepEqual(layout.minimized, ["a0", "a1"]);
    });

    it(`${arrangement}: user-minimized agents free their space`, () => {
      const input = [{ id: "a0" }, { id: "a1", minimized: true }, { id: "a2" }];
      const layout = computeLayout(area(1920, 1032), input, p100({ arrangement }));
      assert.deepEqual(layout.agents.map((a) => a.id), ["a0", "a2"]);
      assert.deepEqual(layout.minimized, ["a1"]);
    });

    it(`${arrangement}: minimizes everything when not even one agent fits`, () => {
      // 1920 px at 150 %: 100 + 80 columns of 14 px do not fit side by side.
      const work = area(1920, 1032);
      const layout = computeLayout(work, agentsOf(2), layoutPrefsForScale(1.5, { arrangement }));
      assert.deepEqual(layout, { main: work, agents: [], minimized: ["a0", "a1"] });
    });

    it(`${arrangement}: honours the work area origin (second monitor, top taskbar)`, () => {
      const work = area(2560, 1392, -2560, 48);
      const layout = computeLayout(work, agentsOf(3), p100({ arrangement }));
      assertValidLayout(work, agentsOf(3), p100({ arrangement }), layout);
      assert.equal(layout.main.x, -2560);
      assert.ok(layout.agents.every((a) => a.rect.y >= 48));
    });

    it(`${arrangement}: distributes rounding remainders without gaps or overlaps`, () => {
      const work = area(3441, 1393);
      for (const gap of [0, 3]) {
        const prefs = p100({ arrangement, gap });
        for (let n = 1; n <= 6; n++) assertValidLayout(work, agentsOf(n), prefs, computeLayout(work, agentsOf(n), prefs));
      }
    });
  }

  it("columns: places agents side by side at full height", () => {
    const layout = computeLayout(area(3440, 1392), agentsOf(2), p100({ arrangement: "columns" }));
    assert.deepEqual(layout.main, area(1720, 1392));
    assert.deepEqual(layout.agents.map((a) => a.rect), [area(860, 1392, 1720), area(860, 1392, 2580)]);
  });

  it("columns: wraps into a second row when columns get too narrow", () => {
    const layout = computeLayout(area(3440, 1392), agentsOf(3), p100({ arrangement: "columns" }));
    assert.deepEqual(layout.agents, [
      { id: "a0", rect: area(860, 696, 1720, 0) },
      { id: "a1", rect: area(860, 696, 2580, 0) },
      { id: "a2", rect: area(1720, 696, 1720, 696) },
    ]);
  });

  it("columns: keeps the main width stable while agents are added", () => {
    const widths = [1, 2, 3, 4].map((n) => computeLayout(area(3440, 1392), agentsOf(n)).main.width);
    assert.deepEqual(widths, [1720, 1720, 1720, 1720]);
  });

  it("stacked: stacks agents with equal heights in one column", () => {
    const layout = computeLayout(area(2560, 1392), agentsOf(3), p100({ arrangement: "stacked" }));
    assert.deepEqual(layout.main, area(1280, 1392));
    assert.deepEqual(layout.agents.map((a) => a.rect), [
      area(1280, 464, 1280, 0),
      area(1280, 464, 1280, 464),
      area(1280, 464, 1280, 928),
    ]);
  });

  it("stacked: adds a second column when windows get too short", () => {
    const layout = computeLayout(area(3440, 1392), agentsOf(4), p100({ arrangement: "stacked" }));
    assert.deepEqual(layout.agents.map((a) => a.rect), [
      area(860, 696, 1720, 0),
      area(860, 696, 1720, 696),
      area(860, 696, 2580, 0),
      area(860, 696, 2580, 696),
    ]);
  });

  it("stacked: respects maxColumns", () => {
    const layout = computeLayout(area(3440, 1392), agentsOf(4), p100({ arrangement: "stacked", maxColumns: 1 }));
    assert.equal(layout.agents.length, 3);
    assert.deepEqual(layout.minimized, ["a0"]);
  });

  it("applies gaps only between windows", () => {
    const layout = computeLayout(area(1920, 1032), agentsOf(2), p100({ arrangement: "stacked", gap: 8 }));
    assert.deepEqual(layout.main, area(956, 1032));
    assert.deepEqual(layout.agents.map((a) => a.rect), [area(956, 512, 964, 0), area(956, 512, 964, 520)]);
  });

  it("does not mutate its inputs", () => {
    const work = Object.freeze(area(2560, 1392));
    const input = Object.freeze(agentsOf(5).map((a) => Object.freeze(a)));
    assert.doesNotThrow(() => computeLayout(work, input, Object.freeze(p100())));
  });

  it("rejects invalid input", () => {
    assert.throws(() => computeLayout(area(0, 1000), []), RangeError);
    assert.throws(() => computeLayout(area(1920.5, 1000), []), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [{ id: "x" }, { id: "x" }]), /Duplicate agent id/);
    assert.throws(() => computeLayout(area(1920, 1032), [], { gap: -1 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { maxRows: 0 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { mainFraction: 1.2 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { cellSize: { w: 0, h: 20 } }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { arrangement: "grid" as Arrangement }), RangeError);
  });
});

describe("prefs", () => {
  it("keeps all defaults in DEFAULT_LAYOUT_PREFS", () => {
    assert.equal(DEFAULT_LAYOUT_PREFS.arrangement, "columns");
    assert.equal(computeLayout(area(1920, 1032), agentsOf(1)).main.width, 960);
    assert.ok(Object.isFrozen(DEFAULT_LAYOUT_PREFS));
  });

  it("scales cell and chrome sizes with the DPI scale", () => {
    assert.deepEqual(layoutPrefsForScale(1).cellSize, DEFAULT_LAYOUT_PREFS.cellSize);
    assert.deepEqual(layoutPrefsForScale(1.25).cellSize, { w: 11, h: 24 });
    assert.deepEqual(layoutPrefsForScale(1.5).cellSize, { w: 14, h: 29 });
    assert.deepEqual(layoutPrefsForScale(1.5).chrome, { w: 54, h: 84 });
    assert.equal(layoutPrefsForScale(2, { gap: 4 }).gap, 4);
    assert.throws(() => layoutPrefsForScale(0), RangeError);
  });

  it("derives minimum sizes from terminal cells plus chrome", () => {
    assert.deepEqual(minimumSizes(1920, layoutPrefsForScale(1)), { main: 936, agent: { w: 756, h: 360 } });
    // At 3840 px the 45 % share dominates the 100-column minimum.
    assert.equal(minimumSizes(3840, layoutPrefsForScale(1)).main, 1728);
  });
});

describe("ASCII rendering (snapshot)", () => {
  const work = area(3440, 1392);
  const input = ["scout", "rev", "docs", "tests", "lint"].map((id) => ({ id }));

  it("columns: 5 agents on 3440x1392 @100%", () => {
    const text = renderLayout(computeLayout(work, input, layoutPrefsForScale(1, { arrangement: "columns" })), work);
    assert.equal(
      text,
      [
        "+------------------------------++--------------++--------------+",
        "| main 1720x1392               || rev 860x696  || docs 860x696 |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              |+--------------++--------------+",
        "|                              |+--------------++--------------+",
        "|                              || tests 860x696|| lint 860x696 |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "+------------------------------++--------------++--------------+",
        "minimized: scout",
      ].join("\n"),
    );
  });

  it("stacked: 5 agents on 3440x1392 @100%", () => {
    const text = renderLayout(computeLayout(work, input, layoutPrefsForScale(1, { arrangement: "stacked" })), work);
    assert.equal(
      text,
      [
        "+------------------------------++--------------++--------------+",
        "| main 1720x1392               || scout 860x464|| tests 860x696|",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "|                              |+--------------+|              |",
        "|                              |+--------------+|              |",
        "|                              || rev 860x464  ||              |",
        "|                              ||              |+--------------+",
        "|                              ||              |+--------------+",
        "|                              ||              || lint 860x696 |",
        "|                              |+--------------+|              |",
        "|                              |+--------------+|              |",
        "|                              || docs 860x464 ||              |",
        "|                              ||              ||              |",
        "|                              ||              ||              |",
        "+------------------------------++--------------++--------------+",
      ].join("\n"),
    );
  });
});
