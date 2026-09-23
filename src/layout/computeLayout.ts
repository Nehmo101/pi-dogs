/**
 * Pure window layout for the main pi window and its subagent windows.
 *
 * Rects are in screen pixels (physical, as used by the window backend) and
 * describe the visible window bounds. Compensating for invisible resize
 * borders or other platform quirks is the backend's job, not this module's.
 *
 * Rules (docs/PLAN.md, sections 13 and 15; measured in docs/spike/layout.md):
 * 1. The main window sits on the left of the primary work area and never gets
 *    less than `mainMinCols` terminal columns.
 * 2. Agents fill the area to the right, depending on `arrangement`:
 *    - "columns" (default): as many full-height columns side by side as fit
 *      with at least `agentMinCols` columns each. When more agents are
 *      visible, they wrap into further rows of columns (up to `maxRows`),
 *      each at least `agentMinRows` high.
 *    - "stacked": one column with equal heights (each at least
 *      `agentMinRows`); when that is full, another column is added (up to
 *      `maxColumns`).
 * 3. The main window's share adapts to the number of agent columns (see
 *    {@link autoMainFraction}), clamped so the agents keep their minimum.
 * 4. Optional secondary work areas (other monitors) take the agents that do
 *    not fit next to the main window, before anything is minimized. They are
 *    filled with the same rules, without a main window.
 * 5. If not even one agent fits next to main (small or highly scaled
 *    screens), the minimums are relaxed step by step ({@link relaxPrefs}):
 *    first main may shrink to `agentMinCols`, then main and agents split the
 *    area 50/50 as long as each half keeps at least {@link RELAXED_MIN_COLS}
 *    columns. Rows (up to `maxRows`) then work as usual.
 * 6. If the agents still do not fit, the oldest ones are minimized instead of
 *    shrinking everything.
 * 7. Rects are integers and, together with the gaps, tile each work area
 *    exactly: no overlaps and no stray pixels from rounding.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface LayoutAgent {
  id: string;
  /** Minimized by the user; never gets a window rect. */
  minimized?: boolean;
}

export type Arrangement = "columns" | "stacked";

export interface LayoutPrefs {
  arrangement: Arrangement;
  /** Size of one terminal cell in pixels at the current DPI scale (may be fractional). */
  cellSize: Size;
  /** Per-window overhead in pixels (title/tab bar, padding, scrollbar). */
  chrome: Size;
  mainMinCols: number;
  agentMinCols: number;
  agentMinRows: number;
  /**
   * Preferred share of the primary work area's width for the main window:
   * a number between 0 and 1, or "auto" to adapt it to the number of agent
   * columns ({@link autoMainFraction}).
   */
  mainFraction: number | "auto";
  /** "stacked" only: maximum number of agent columns per work area. */
  maxColumns: number;
  /** "columns" only: maximum number of agent rows per work area. */
  maxRows: number;
  /** Gap between windows in pixels. The outer edges have no gap. */
  gap: number;
}

/** A further work area (another monitor) that may take agents that do not fit next to main. */
export interface SecondaryWorkArea {
  rect: Rect;
  /** Cell size on that monitor if its DPI differs from the primary one. */
  cellSize?: Size;
  /** Window chrome on that monitor if its DPI differs from the primary one. */
  chrome?: Size;
}

export interface LayoutOptions {
  /** Used in order, only for agents that do not fit into the primary work area. */
  secondaryWorkAreas?: readonly SecondaryWorkArea[];
}

export interface Layout {
  main: Rect;
  /**
   * Visible agents in fill order: per work area (primary first, then the
   * secondary ones in order), oldest first; "columns" fills row by row, left
   * to right, "stacked" column by column, top to bottom. The newest agents
   * are on the primary work area, next to the main window.
   */
  agents: { id: string; rect: Rect }[];
  /** Ids of agents without a window (user- or auto-minimized), in input order. */
  minimized: string[];
}

/**
 * All layout defaults, at 100 % display scaling. Cell and chrome sizes were
 * measured in the layout spike (Windows Terminal 1.24, default font, 96 DPI;
 * see docs/spike/layout.md). Other DPI scales are not measured yet.
 */
export const DEFAULT_LAYOUT_PREFS: Readonly<LayoutPrefs> = Object.freeze({
  arrangement: "columns",
  cellSize: Object.freeze({ w: 9, h: 19 }),
  chrome: Object.freeze({ w: 36, h: 56 }),
  mainMinCols: 100,
  agentMinCols: 80,
  agentMinRows: 16,
  mainFraction: "auto",
  maxColumns: 2,
  maxRows: 2,
  gap: 0,
});

/**
 * The main window's preferred share of the width with `k` agent columns next
 * to it: 2 / (k + 3), i.e. 50 % with one column, 40 % with two, 33 % with
 * three, 29 % with four.
 *
 * Why this curve: the spike measured exactly these shares as the most
 * readable choices on 3440 px (1 agent: 50/50; 2: main 40 %, agents 110
 * cols; 3: main 33 %, agents 81 cols; 2 x 2 grid: main 40 %). Read as weights,
 * main gets 2 parts and the agent area k + 1 parts, so the main window is as
 * wide as one agent column with one agent and approaches twice a column's
 * width with many: the window you type in stays the widest, but never takes
 * away a column that would fit at a readable width. The hard minimums
 * (`mainMinCols`, `agentMinCols`) still win over this preference.
 */
export function autoMainFraction(agentColumns: number): number {
  return 2 / (Math.max(1, agentColumns) + 3);
}

/** Default prefs with cell and chrome sizes scaled for a DPI scale factor (1.25 = 125 %). */
export function layoutPrefsForScale(scale: number, overrides: Partial<LayoutPrefs> = {}): LayoutPrefs {
  if (!(scale > 0)) throw new RangeError(`scale must be positive, got ${scale}`);
  const d = DEFAULT_LAYOUT_PREFS;
  return {
    ...d,
    cellSize: { w: Math.round(d.cellSize.w * scale), h: Math.round(d.cellSize.h * scale) },
    chrome: { w: Math.round(d.chrome.w * scale), h: Math.round(d.chrome.h * scale) },
    ...overrides,
  };
}

/** Minimum window sizes in pixels derived from prefs (cell sizes may be fractional). */
export function minimumSizes(
  prefs: Pick<LayoutPrefs, "cellSize" | "chrome" | "mainMinCols" | "agentMinCols" | "agentMinRows">,
): { main: number; agent: Size } {
  const { cellSize: cell, chrome } = prefs;
  return {
    main: Math.ceil(prefs.mainMinCols * cell.w + chrome.w),
    agent: {
      w: Math.ceil(prefs.agentMinCols * cell.w + chrome.w),
      h: Math.ceil(prefs.agentMinRows * cell.h + chrome.h),
    },
  };
}

/**
 * Narrowest window (in columns) the relaxation in {@link relaxPrefs} accepts.
 * Below this, terminal UIs wrap badly; minimizing is the better choice.
 */
export const RELAXED_MIN_COLS = 60;

/**
 * The prefs a work area is laid out with. Normally `p` unchanged; only when
 * not even one agent would fit (capacity 0) are the minimums relaxed:
 * 1. with main: main may shrink to `agentMinCols` (main and agent equally wide),
 * 2. main and agents (without main: the agents) get the widest column count
 *    that still fits two windows side by side (one without main), provided
 *    that is at least {@link RELAXED_MIN_COLS}.
 * Pure and deterministic. Exported so tests and diagnostics can see the
 * minimums that were actually used.
 */
export function relaxPrefs(rect: Rect, hasMain: boolean, p: LayoutPrefs): LayoutPrefs {
  if (capacityOf(rect, hasMain, p) > 0) return p;
  if (hasMain && p.mainMinCols > p.agentMinCols) {
    const shrunk = { ...p, mainMinCols: p.agentMinCols };
    if (capacityOf(rect, hasMain, shrunk) > 0) return shrunk;
  }
  const windows = hasMain ? 2 : 1;
  const slot = Math.floor((rect.width - (windows - 1) * p.gap) / windows);
  const cols = Math.floor((slot - p.chrome.w) / p.cellSize.w);
  if (cols < RELAXED_MIN_COLS || cols >= p.agentMinCols) return p;
  const relaxed = { ...p, mainMinCols: Math.min(p.mainMinCols, cols), agentMinCols: cols };
  return capacityOf(rect, hasMain, relaxed) > 0 ? relaxed : p;
}

function capacityOf(rect: Rect, hasMain: boolean, p: LayoutPrefs): number {
  const a = describeArea(rect, hasMain, p);
  return a.perTrack * a.tracks;
}

/** One work area as seen by the placement code. */
interface Area {
  rect: Rect;
  hasMain: boolean;
  min: { main: number; agent: Size };
  /** Agents per track at most (columns per row, or windows per column). */
  perTrack: number;
  /** Tracks that fit at most (rows of columns, or columns of windows). */
  tracks: number;
}

export function computeLayout(
  workArea: Rect,
  agents: readonly LayoutAgent[],
  prefs: Partial<LayoutPrefs> = {},
  options: LayoutOptions = {},
): Layout {
  const p: LayoutPrefs = { ...DEFAULT_LAYOUT_PREFS, ...prefs };
  const secondary = options.secondaryWorkAreas ?? [];
  validate(workArea, secondary, agents, p);

  const areas: Area[] = [
    describeArea(workArea, true, relaxPrefs(workArea, true, p)),
    ...secondary.map((s) => {
      const sp = { ...p, ...cellOverrides(s) };
      return describeArea(s.rect, false, relaxPrefs(s.rect, false, sp));
    }),
  ];
  const visible = agents.filter((a) => !a.minimized);
  const maxLevel = Math.max(...areas.map((a) => a.tracks));
  const capacity = (a: Area, level: number) => a.perTrack * Math.min(level, a.tracks);
  const total = (level: number) => areas.reduce((sum, a) => sum + capacity(a, level), 0);

  const shownCount = Math.min(visible.length, total(maxLevel));
  // Use as few tracks as possible everywhere: find the lowest level at which
  // everything fits, fill every area up to the level below, then hand out the
  // rest in area order (primary first).
  let level = 1;
  while (level < maxLevel && total(level) < shownCount) level++;
  const counts = areas.map((a) => capacity(a, level - 1));
  let rest = shownCount - counts.reduce((sum, c) => sum + c, 0);
  areas.forEach((a, i) => {
    const add = Math.min(rest, capacity(a, level) - counts[i]!);
    counts[i] = counts[i]! + add;
    rest -= add;
  });

  // Newest agents on the primary area, the next older ones on the next area.
  const shown = visible.slice(visible.length - shownCount);
  let end = shown.length;
  let main: Rect = { ...workArea };
  const placed: { id: string; rect: Rect }[] = [];
  areas.forEach((area, i) => {
    const count = counts[i]!;
    const group = shown.slice(end - count, end);
    end -= count;
    if (count === 0) return;
    const result = place(area, group, Math.ceil(count / area.perTrack), p);
    if (!result) throw new Error("computeLayout: internal error, capacity and placement disagree");
    if (area.hasMain) main = result.main;
    placed.push(...result.agents);
  });

  const ids = new Set(placed.map((a) => a.id));
  return { main, agents: placed, minimized: agents.filter((a) => !ids.has(a.id)).map((a) => a.id) };
}

function cellOverrides(s: SecondaryWorkArea): Partial<LayoutPrefs> {
  const out: Partial<LayoutPrefs> = {};
  if (s.cellSize) out.cellSize = s.cellSize;
  if (s.chrome) out.chrome = s.chrome;
  return out;
}

function describeArea(rect: Rect, hasMain: boolean, p: LayoutPrefs): Area {
  const min = minimumSizes(p);
  const { gap } = p;
  const width = hasMain ? rect.width - min.main - gap : rect.width;
  const fit = (space: number, item: number) => (space >= item ? Math.floor((space + gap) / (item + gap)) : 0);
  const cols = fit(width, min.agent.w);
  const rows = fit(rect.height, min.agent.h);
  const stacked = p.arrangement === "stacked";
  const perTrack = stacked ? rows : cols;
  const tracks = Math.min(stacked ? cols : rows, stacked ? p.maxColumns : p.maxRows);
  const usable = perTrack > 0 && tracks > 0;
  return { rect, hasMain, min, perTrack: usable ? perTrack : 0, tracks: usable ? tracks : 0 };
}

/**
 * Place `agents` in `tracks` tracks: rows of side-by-side windows for
 * "columns", columns of stacked windows for "stacked". Earlier tracks take
 * the remainder. Returns undefined if any minimum size would be violated.
 */
function place(
  area: Area,
  agents: readonly LayoutAgent[],
  tracks: number,
  p: LayoutPrefs,
): { main: Rect; agents: { id: string; rect: Rect }[] } | undefined {
  const { gap } = p;
  const { rect: box, min } = area;
  const stacked = p.arrangement === "stacked";
  const perTrack = Math.ceil(agents.length / tracks);
  const gridCols = stacked ? tracks : perTrack;
  const gridRows = stacked ? perTrack : tracks;
  if (gridRows * min.agent.h + (gridRows - 1) * gap > box.height) return undefined;

  const agentsMinWidth = gridCols * min.agent.w + (gridCols - 1) * gap;
  let mainWidth = 0;
  if (area.hasMain) {
    const maxMainWidth = box.width - gap - agentsMinWidth;
    if (maxMainWidth < min.main) return undefined;
    const fraction = p.mainFraction === "auto" ? autoMainFraction(gridCols) : p.mainFraction;
    const preferred = Math.floor((box.width - gap) * fraction);
    mainWidth = Math.max(min.main, Math.min(preferred, maxMainWidth));
  } else if (agentsMinWidth > box.width) {
    return undefined;
  }
  const main: Rect = { x: box.x, y: box.y, width: mainWidth, height: box.height };

  const agentsX = area.hasMain ? box.x + mainWidth + gap : box.x;
  const agentsWidth = area.hasMain ? box.width - mainWidth - gap : box.width;
  const base = Math.floor(agents.length / tracks);
  const extra = agents.length % tracks;
  const placed: { id: string; rect: Rect }[] = [];
  let next = 0;
  split(stacked ? agentsWidth : box.height, tracks, gap).forEach((track, t) => {
    const count = base + (t < extra ? 1 : 0);
    for (const item of split(stacked ? box.height : agentsWidth, count, gap)) {
      const rect: Rect = stacked
        ? { x: agentsX + track.offset, y: box.y + item.offset, width: track.size, height: item.size }
        : { x: agentsX + item.offset, y: box.y + track.offset, width: item.size, height: track.size };
      placed.push({ id: agents[next++]!.id, rect });
    }
  });
  return { main, agents: placed };
}

/** Split `total` pixels into `parts` integer segments separated by `gap`. Sizes differ by at most 1. */
function split(total: number, parts: number, gap: number): { offset: number; size: number }[] {
  const available = total - (parts - 1) * gap;
  const base = Math.floor(available / parts);
  const remainder = available - base * parts;
  const segments: { offset: number; size: number }[] = [];
  let offset = 0;
  for (let i = 0; i < parts; i++) {
    const size = base + (i < remainder ? 1 : 0);
    segments.push({ offset, size });
    offset += size + gap;
  }
  return segments;
}

function validateRect(name: string, r: Rect): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!Number.isInteger(r[key])) throw new RangeError(`${name}.${key} must be an integer, got ${r[key]}`);
  }
  if (r.width <= 0 || r.height <= 0) throw new RangeError(`${name} must have a positive size`);
}

function validateCells(name: string, cell: Size | undefined, chrome: Size | undefined): void {
  if (cell && !(cell.w > 0 && cell.h > 0)) throw new RangeError(`${name}cellSize must be positive`);
  if (chrome && !(chrome.w >= 0 && chrome.h >= 0)) throw new RangeError(`${name}chrome must not be negative`);
}

function validate(
  area: Rect,
  secondary: readonly SecondaryWorkArea[],
  agents: readonly LayoutAgent[],
  p: LayoutPrefs,
): void {
  validateRect("workArea", area);
  secondary.forEach((s, i) => {
    validateRect(`secondaryWorkAreas[${i}].rect`, s.rect);
    validateCells(`secondaryWorkAreas[${i}].`, s.cellSize, s.chrome);
  });
  for (const [name, value] of [["gap", p.gap], ["maxColumns", p.maxColumns], ["maxRows", p.maxRows]] as const) {
    if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${value}`);
  }
  if (p.gap < 0) throw new RangeError("gap must not be negative");
  if (p.arrangement !== "columns" && p.arrangement !== "stacked") {
    throw new RangeError(`arrangement must be "columns" or "stacked", got ${String(p.arrangement)}`);
  }
  if (p.maxColumns < 1 || p.maxRows < 1) throw new RangeError("maxColumns and maxRows must be at least 1");
  validateCells("", p.cellSize, p.chrome);
  for (const name of ["mainMinCols", "agentMinCols", "agentMinRows"] as const) {
    if (!(p[name] >= 1)) throw new RangeError(`${name} must be at least 1, got ${p[name]}`);
  }
  if (p.mainFraction !== "auto" && !(p.mainFraction > 0 && p.mainFraction < 1)) {
    throw new RangeError(`mainFraction must be "auto" or between 0 and 1, got ${String(p.mainFraction)}`);
  }
  const ids = new Set<string>();
  for (const { id } of agents) {
    if (ids.has(id)) throw new Error(`Duplicate agent id: ${id}`);
    ids.add(id);
  }
}
