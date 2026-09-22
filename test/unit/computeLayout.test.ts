import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  autoMainFraction,
  computeLayout,
  DEFAULT_LAYOUT_PREFS,
  layoutPrefsForScale,
  minimumSizes,
  type Arrangement,
  type Layout,
  type LayoutAgent,
  type LayoutPrefs,
  type Rect,
  type SecondaryWorkArea,
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
const inside = (r: Rect, box: Rect) => r.x >= box.x && r.y >= box.y && right(r) <= right(box) && bottom(r) <= bottom(box);
const ids = (layout: Layout) => layout.agents.map((a) => a.id);
const rects = (layout: Layout) => layout.agents.map((a) => a.rect);

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

function assertNoOverlaps(all: Rect[], label: string): void {
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, b] = [all[i]!, all[j]!];
      const overlap = a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);
      assert.ok(!overlap, `${label}: rects ${i} and ${j} overlap`);
    }
  }
}

/** Check the structure of the agent windows inside one area (tracks tile the area, items tile tracks). */
function assertGrid(agentRects: Rect[], box: Rect, prefs: LayoutPrefs, label: string): void {
  const xs = (rs: Rect[]) => rs.map((r) => ({ start: r.x, end: right(r) }));
  const ys = (rs: Rect[]) => rs.map((r) => ({ start: r.y, end: bottom(r) }));
  if (prefs.arrangement === "stacked") {
    const columns = groupBy(agentRects, (r) => r.x);
    assertTiles(xs(columns.map((c) => c[0]!)), box.x, right(box), prefs.gap, `${label}: columns`);
    assertSpread(columns.map((c) => c[0]!.width), 1, `${label}: column widths`);
    for (const column of columns) {
      assertSpread(column.map((r) => r.width), 0, `${label}: widths within a column`);
      assertSpread(column.map((r) => r.height), 1, `${label}: heights within a column`);
      assertTiles(ys([...column].sort((a, b) => a.y - b.y)), box.y, bottom(box), prefs.gap, `${label}: column items`);
    }
  } else {
    const rows = groupBy(agentRects, (r) => r.y);
    assertTiles(ys(rows.map((r) => r[0]!)), box.y, bottom(box), prefs.gap, `${label}: rows`);
    assertSpread(rows.map((r) => r[0]!.height), 1, `${label}: row heights`);
    for (const row of rows) {
      assertSpread(row.map((r) => r.height), 0, `${label}: heights within a row`);
      assertSpread(row.map((r) => r.width), 1, `${label}: widths within a row`);
      assertTiles(xs([...row].sort((a, b) => a.x - b.x)), box.x, right(box), prefs.gap, `${label}: row items`);
    }
  }
}

/** Number of agent columns next to main, as the main-share rule counts them. */
function agentColumns(agentRects: Rect[], arrangement: Arrangement): number {
  if (arrangement === "stacked") return new Set(agentRects.map((r) => r.x)).size;
  return Math.max(...groupBy(agentRects, (r) => r.y).map((row) => row.length));
}

/** Check every invariant a layout must satisfy, independent of screens and arrangement. */
function assertValidLayout(
  work: Rect,
  input: LayoutAgent[],
  prefs: LayoutPrefs,
  layout: Layout,
  secondary: readonly SecondaryWorkArea[] = [],
): void {
  const all = [layout.main, ...rects(layout)];
  const label = `${work.width}x${work.height}+${secondary.length} ${prefs.arrangement} n=${input.length}`;
  const boxes = [work, ...secondary.map((s) => s.rect)];

  for (const r of all) {
    for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(v), `${label}: integer coords`);
    assert.ok(r.width > 0 && r.height > 0, `${label}: positive size`);
    assert.ok(boxes.some((box) => inside(r, box)), `${label}: inside one work area`);
  }
  assert.ok(inside(layout.main, work), `${label}: main on the primary work area`);
  assertNoOverlaps(all, label);

  // Ids: every agent is either placed or minimized; the shown ones are the newest.
  const shown = ids(layout);
  const candidates = input.filter((a) => !a.minimized).map((a) => a.id);
  assert.deepEqual(
    [...shown].sort(),
    candidates.slice(candidates.length - shown.length).sort(),
    `${label}: newest agents are shown`,
  );
  assert.deepEqual(
    layout.minimized,
    input.map((a) => a.id).filter((id) => !shown.includes(id)),
    `${label}: minimized lists all others in input order`,
  );

  // Main window: left, full height, minimum width and preferred share.
  const min = minimumSizes(prefs);
  assert.equal(layout.main.x, work.x);
  assert.equal(layout.main.y, work.y);
  assert.equal(layout.main.height, work.height);
  const primaryAgents = rects(layout).filter((r) => inside(r, work));
  if (primaryAgents.length === 0) {
    assert.deepEqual(layout.main, work, `${label}: main fills the work area without agents next to it`);
  } else {
    assert.ok(layout.main.width >= min.main, `${label}: main keeps its minimum width`);
    const k = agentColumns(primaryAgents, prefs.arrangement);
    const fraction = prefs.mainFraction === "auto" ? autoMainFraction(k) : prefs.mainFraction;
    const preferred = Math.floor((work.width - prefs.gap) * fraction);
    const maxMain = work.width - prefs.gap - (k * min.agent.w + (k - 1) * prefs.gap);
    assert.equal(layout.main.width, Math.max(min.main, Math.min(preferred, maxMain)), `${label}: main share`);
    const agentsBox = { ...work, x: right(layout.main) + prefs.gap, width: right(work) - right(layout.main) - prefs.gap };
    assertGrid(primaryAgents, agentsBox, prefs, `${label} primary`);
  }

  // Minimum sizes everywhere, and a clean grid on each secondary area.
  secondary.forEach((s, i) => {
    const smin = minimumSizes({ ...prefs, ...(s.cellSize && { cellSize: s.cellSize }), ...(s.chrome && { chrome: s.chrome }) });
    const here = rects(layout).filter((r) => inside(r, s.rect));
    for (const r of here) assert.ok(r.width >= smin.agent.w && r.height >= smin.agent.h, `${label}: secondary ${i} min size`);
    if (here.length > 0) assertGrid(here, s.rect, prefs, `${label} secondary ${i}`);
  });
  for (const r of primaryAgents) {
    assert.ok(r.width >= min.agent.w, `${label}: width ${r.width} >= ${min.agent.w}`);
    assert.ok(r.height >= min.agent.h, `${label}: height ${r.height} >= ${min.agent.h}`);
  }

  // The newest agents are next to main: every agent on the primary area is newer than any elsewhere.
  const order = new Map(input.map((a, i) => [a.id, i]));
  const primaryIds = layout.agents.filter((a) => inside(a.rect, work)).map((a) => order.get(a.id)!);
  const otherIds = layout.agents.filter((a) => !inside(a.rect, work)).map((a) => order.get(a.id)!);
  if (primaryIds.length > 0 && otherIds.length > 0) {
    assert.ok(Math.min(...primaryIds) > Math.max(...otherIds), `${label}: newest agents on the primary area`);
  }
}

describe("computeLayout invariants across screens, scales and agent counts", () => {
  for (const arrangement of ARRANGEMENTS) {
    for (const work of WORK_AREAS) {
      for (const scale of SCALES) {
        it(`${arrangement} ${work.width}x${work.height} @${scale * 100}%`, () => {
          for (const gap of [0, 8]) {
            for (const mainFraction of ["auto", 0.5] as const) {
              const prefs = layoutPrefsForScale(scale, { arrangement, gap, mainFraction });
              let previousShown = 0;
              for (let n = 0; n <= 9; n++) {
                const input = agentsOf(n);
                const layout = computeLayout(work, input, prefs);
                assertValidLayout(work, input, prefs, layout);
                if (gap === 0) {
                  const covered = [layout.main, ...rects(layout)].reduce((sum, r) => sum + r.width * r.height, 0);
                  assert.equal(covered, work.width * work.height, "rects cover the work area exactly");
                }
                assert.deepEqual(computeLayout(work, input, prefs), layout, "deterministic");
                assert.ok(layout.agents.length >= previousShown, "adding an agent never hides more windows");
                previousShown = layout.agents.length;
              }
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
      assert.deepEqual(ids(layout), ["a2", "a3"]);
      assert.deepEqual(layout.minimized, ["a0", "a1"]);
    });

    it(`${arrangement}: user-minimized agents free their space`, () => {
      const input = [{ id: "a0" }, { id: "a1", minimized: true }, { id: "a2" }];
      const layout = computeLayout(area(1920, 1032), input, p100({ arrangement }));
      assert.deepEqual(ids(layout), ["a0", "a2"]);
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
        for (let n = 1; n <= 7; n++) assertValidLayout(work, agentsOf(n), prefs, computeLayout(work, agentsOf(n), prefs));
      }
    });
  }

  describe("columns (the measured rule from PLAN §15)", () => {
    const work = area(3440, 1392);

    it("places two agents as full-height columns with main at 40 %", () => {
      const layout = computeLayout(work, agentsOf(2));
      assert.deepEqual(layout.main, area(1376, 1392));
      assert.deepEqual(rects(layout), [area(1032, 1392, 1376), area(1032, 1392, 2408)]);
    });

    it("fits three full-height columns of at least 80 cols next to a 100+ col main", () => {
      const layout = computeLayout(work, agentsOf(3));
      assert.deepEqual(layout.main, area(1146, 1392));
      assert.deepEqual(rects(layout), [area(765, 1392, 1146), area(765, 1392, 1911), area(764, 1392, 2676)]);
      // 764 px = 80 columns of 9 px plus 36 px chrome (and 8 px to spare).
      assert.ok(rects(layout).every((r) => Math.floor((r.width - 36) / 9) >= 80));
    });

    it("wraps into two rows of columns when a fourth column would be too narrow", () => {
      const layout = computeLayout(work, agentsOf(4));
      assert.deepEqual(layout.main, area(1376, 1392));
      assert.deepEqual(rects(layout), [
        area(1032, 696, 1376, 0),
        area(1032, 696, 2408, 0),
        area(1032, 696, 1376, 696),
        area(1032, 696, 2408, 696),
      ]);
    });

    it("adapts the main share to the number of agent columns", () => {
      const widths = [0, 1, 2, 3, 4, 5, 6].map((n) => computeLayout(work, agentsOf(n)).main.width);
      // 0: alone; 1: 50 %; 2: 40 %; 3: 33 %; 4: 2 x 2 -> 40 %; 5, 6: 3 + 2, 3 + 3 -> 33 %.
      assert.deepEqual(widths, [3440, 1720, 1376, 1146, 1376, 1146, 1146]);
    });

    it("shows at most two rows of three on 3440 px and minimizes the oldest beyond that", () => {
      const layout = computeLayout(work, agentsOf(8));
      assert.equal(layout.agents.length, 6);
      assert.deepEqual(layout.minimized, ["a0", "a1"]);
    });

    it("never lets main drop below 100 columns, even when the preferred share would", () => {
      // 3840 px at 150 %: cells 14 px, chrome 54 px. Main minimum 1454, agent minimum 1174.
      const layout = computeLayout(area(3840, 2112), agentsOf(2), layoutPrefsForScale(1.5));
      assert.deepEqual(layout.main, area(1492, 2112)); // preferred 40 % = 1535 leaves too little for 2 columns
      assert.ok(rects(layout).every((r) => r.width >= 1174));
    });

    it("keeps a fixed main share when one is configured", () => {
      const layout = computeLayout(work, agentsOf(2), { mainFraction: 0.5 });
      assert.equal(layout.main.width, 1720);
      // With three agents 50 % would leave only 573 px per column: main yields to the
      // 80-column minimum of the three columns (3440 - 3 x 756 = 1172).
      assert.equal(computeLayout(work, agentsOf(3), { mainFraction: 0.5 }).main.width, 1172);
    });

    it("respects maxRows", () => {
      const layout = computeLayout(work, agentsOf(5), { maxRows: 1 });
      assert.deepEqual(ids(layout), ["a2", "a3", "a4"]);
    });
  });

  describe("stacked", () => {
    it("stacks agents with equal heights in one column", () => {
      const layout = computeLayout(area(2560, 1392), agentsOf(3), p100({ arrangement: "stacked" }));
      assert.deepEqual(layout.main, area(1280, 1392));
      assert.deepEqual(rects(layout), [area(1280, 464, 1280, 0), area(1280, 464, 1280, 464), area(1280, 464, 1280, 928)]);
    });

    it("adds a second column when windows get too short, and main shrinks to 40 %", () => {
      const layout = computeLayout(area(3440, 1392), agentsOf(4), p100({ arrangement: "stacked" }));
      assert.deepEqual(rects(layout), [
        area(1032, 696, 1376, 0),
        area(1032, 696, 1376, 696),
        area(1032, 696, 2408, 0),
        area(1032, 696, 2408, 696),
      ]);
    });

    it("respects maxColumns", () => {
      const layout = computeLayout(area(3440, 1392), agentsOf(4), p100({ arrangement: "stacked", maxColumns: 1 }));
      assert.equal(layout.agents.length, 3);
      assert.deepEqual(layout.minimized, ["a0"]);
    });
  });

  it("applies gaps only between windows", () => {
    const layout = computeLayout(area(1920, 1032), agentsOf(2), p100({ arrangement: "stacked", gap: 8 }));
    assert.deepEqual(layout.main, area(956, 1032));
    assert.deepEqual(rects(layout), [area(956, 512, 964, 0), area(956, 512, 964, 520)]);
  });

  it("does not mutate its inputs", () => {
    const work = Object.freeze(area(2560, 1392));
    const input = Object.freeze(agentsOf(5).map((a) => Object.freeze(a)));
    const secondary = Object.freeze([Object.freeze({ rect: Object.freeze(area(1920, 1032, 2560)) })]);
    assert.doesNotThrow(() => computeLayout(work, input, Object.freeze(p100()), Object.freeze({ secondaryWorkAreas: secondary })));
  });

  it("rejects invalid input", () => {
    assert.throws(() => computeLayout(area(0, 1000), []), RangeError);
    assert.throws(() => computeLayout(area(1920.5, 1000), []), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [{ id: "x" }, { id: "x" }]), /Duplicate agent id/);
    assert.throws(() => computeLayout(area(1920, 1032), [], { gap: -1 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { maxRows: 0 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { mainFraction: 1.2 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { cellSize: { w: 0, h: 20 } }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { agentMinCols: 0 }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], { arrangement: "grid" as Arrangement }), RangeError);
    assert.throws(() => computeLayout(area(1920, 1032), [], {}, { secondaryWorkAreas: [{ rect: area(0, 5) }] }), RangeError);
    assert.throws(
      () => computeLayout(area(1920, 1032), [], {}, { secondaryWorkAreas: [{ rect: area(10, 5), cellSize: { w: -1, h: 1 } }] }),
      RangeError,
    );
  });
});

describe("computeLayout with secondary work areas (multi-monitor)", () => {
  const primary = area(1920, 1032);
  const rightMonitor: SecondaryWorkArea = { rect: area(1920, 1032, 1920) };

  it("does not use a secondary area while everything fits next to main", () => {
    const layout = computeLayout(primary, agentsOf(1), {}, { secondaryWorkAreas: [rightMonitor] });
    assert.deepEqual(layout, computeLayout(primary, agentsOf(1)));
  });

  it("moves older agents to the secondary area before minimizing or adding rows", () => {
    const layout = computeLayout(primary, agentsOf(3), {}, { secondaryWorkAreas: [rightMonitor] });
    assert.deepEqual(layout.main, area(960, 1032));
    assert.deepEqual(layout.agents, [
      { id: "a2", rect: area(960, 1032, 960) },
      { id: "a0", rect: area(960, 1032, 1920) },
      { id: "a1", rect: area(960, 1032, 2880) },
    ]);
    assert.deepEqual(layout.minimized, []);
  });

  it("fills full-height columns on all areas before any area gets a second row", () => {
    const layout = computeLayout(area(3440, 1392), agentsOf(5), {}, { secondaryWorkAreas: [{ rect: area(1920, 1032, 3440) }] });
    const onPrimary = layout.agents.filter((a) => a.rect.x < 3440);
    assert.equal(onPrimary.length, 3);
    assert.ok(layout.agents.every((a) => a.rect.height === (a.rect.x < 3440 ? 1392 : 1032)), "all full height");
    assert.deepEqual(ids(layout), ["a2", "a3", "a4", "a0", "a1"]);
  });

  it("then adds rows, primary first, and minimizes only when all areas are full", () => {
    const work = area(3440, 1392);
    const eight = computeLayout(work, agentsOf(8), {}, { secondaryWorkAreas: [{ rect: area(1920, 1032, 3440) }] });
    assert.equal(eight.agents.filter((a) => a.rect.x < 3440).length, 6);
    assert.equal(eight.agents.filter((a) => a.rect.x >= 3440).length, 2);
    const twelve = computeLayout(work, agentsOf(12), {}, { secondaryWorkAreas: [{ rect: area(1920, 1032, 3440) }] });
    assert.equal(twelve.agents.length, 10); // 3 x 2 on primary, 2 x 2 on the secondary
    assert.deepEqual(twelve.minimized, ["a0", "a1"]);
  });

  it("uses the secondary area's own cell size (different DPI)", () => {
    const hiDpi: SecondaryWorkArea = { rect: area(1920, 1032, 1920), cellSize: { w: 14, h: 29 }, chrome: { w: 54, h: 84 } };
    const layout = computeLayout(primary, agentsOf(4), {}, { secondaryWorkAreas: [hiDpi] });
    // Primary: 1 column x 2 rows. Secondary at 150 %: minimum 1174 x 548 px, so one window fills it.
    const secondaryRects = rects(layout).filter((r) => r.x >= 1920);
    assert.ok(secondaryRects.every((r) => r.width === 1920), "one column only at 150 %");
    assertValidLayout(primary, agentsOf(4), layoutPrefsForScale(1), layout, [hiDpi]);
  });

  it("works with a secondary area left of and above the primary one", () => {
    const secondary = [{ rect: area(2560, 1392, -2560, -360) }];
    for (let n = 0; n <= 10; n++) {
      const layout = computeLayout(primary, agentsOf(n), {}, { secondaryWorkAreas: secondary });
      assertValidLayout(primary, agentsOf(n), layoutPrefsForScale(1), layout, secondary);
    }
  });

  it("puts agents on a secondary area even when none fits next to main", () => {
    const layout = computeLayout(primary, agentsOf(2), layoutPrefsForScale(1.5), { secondaryWorkAreas: [rightMonitor] });
    assert.deepEqual(layout.main, primary);
    assert.deepEqual(ids(layout), ["a1"]);
    assert.deepEqual(layout.minimized, ["a0"]);
  });

  it("keeps all invariants across monitor combinations and agent counts", () => {
    const combos: SecondaryWorkArea[][] = [
      [{ rect: area(1920, 1032, 3440) }],
      [{ rect: area(2560, 1392, -2560) }, { rect: area(1920, 1032, 3440, 200) }],
      [{ rect: area(3840, 2112, 3440), cellSize: { w: 11, h: 24 }, chrome: { w: 45, h: 70 } }],
    ];
    for (const arrangement of ARRANGEMENTS) {
      for (const secondary of combos) {
        const prefs = layoutPrefsForScale(1, { arrangement });
        let previous = 0;
        for (let n = 0; n <= 16; n++) {
          const layout = computeLayout(area(3440, 1392), agentsOf(n), prefs, { secondaryWorkAreas: secondary });
          assertValidLayout(area(3440, 1392), agentsOf(n), prefs, layout, secondary);
          assert.ok(layout.agents.length >= previous, "adding an agent never hides more windows");
          previous = layout.agents.length;
        }
      }
    }
  });
});

describe("prefs", () => {
  it("keeps all defaults in DEFAULT_LAYOUT_PREFS", () => {
    assert.equal(DEFAULT_LAYOUT_PREFS.arrangement, "columns");
    assert.equal(DEFAULT_LAYOUT_PREFS.mainFraction, "auto");
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
    assert.deepEqual(minimumSizes(layoutPrefsForScale(1)), { main: 936, agent: { w: 756, h: 360 } });
    // Measured cell sizes may be fractional; minimums round up.
    assert.deepEqual(minimumSizes(layoutPrefsForScale(1, { cellSize: { w: 8.4, h: 17.5 } })), {
      main: 876,
      agent: { w: 708, h: 336 },
    });
  });

  it("computes the adaptive main share", () => {
    assert.deepEqual([1, 2, 3, 4].map((k) => +autoMainFraction(k).toFixed(3)), [0.5, 0.4, 0.333, 0.286]);
    assert.equal(autoMainFraction(0), 0.5);
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
        "+-------------------++-------------++------------++------------+",
        "| main 1146x1392    || scout       || rev 765x696|| docs       |",
        "|                   ||             ||            ||            |",
        "|                   ||             ||            ||            |",
        "|                   ||             ||            ||            |",
        "|                   ||             ||            ||            |",
        "|                   ||             ||            ||            |",
        "|                   |+-------------++------------++------------+",
        "|                   |+--------------------++-------------------+",
        "|                   || tests 1147x696     || lint 1147x696     |",
        "|                   ||                    ||                   |",
        "|                   ||                    ||                   |",
        "|                   ||                    ||                   |",
        "|                   ||                    ||                   |",
        "|                   ||                    ||                   |",
        "+-------------------++--------------------++-------------------+",
      ].join("\n"),
    );
  });

  it("stacked: 5 agents on 3440x1392 @100%", () => {
    const text = renderLayout(computeLayout(work, input, layoutPrefsForScale(1, { arrangement: "stacked" })), work);
    assert.equal(
      text,
      [
        "+------------------------++-----------------++-----------------+",
        "| main 1376x1392         || scout 1032x464  || tests 1032x696  |",
        "|                        ||                 ||                 |",
        "|                        ||                 ||                 |",
        "|                        |+-----------------+|                 |",
        "|                        |+-----------------+|                 |",
        "|                        || rev 1032x464    ||                 |",
        "|                        ||                 |+-----------------+",
        "|                        ||                 |+-----------------+",
        "|                        ||                 || lint 1032x696   |",
        "|                        |+-----------------+|                 |",
        "|                        |+-----------------+|                 |",
        "|                        || docs 1032x464   ||                 |",
        "|                        ||                 ||                 |",
        "|                        ||                 ||                 |",
        "+------------------------++-----------------++-----------------+",
      ].join("\n"),
    );
  });
});
