/**
 * Pure window layout for the main pi window and its subagent windows.
 *
 * Rects are in screen pixels (physical, as used by the window backend) and
 * describe the visible window bounds. Compensating for invisible resize
 * borders or other platform quirks is the backend's job, not this module's.
 *
 * Rules (docs/PLAN.md, section 13):
 * 1. The main window sits on the left and prefers `mainFraction` of the width
 *    (50/50 with one agent). It never gets less than `mainMinFraction` of the
 *    width or `mainMinCols` terminal columns.
 * 2. Agents fill the area to the right, depending on `arrangement`:
 *    - "columns": full-height columns side by side with equal widths. When a
 *      column would get narrower than the minimum, the agents wrap into
 *      another row of columns (up to `maxRows`).
 *    - "stacked": one column with equal heights. When a window would get
 *      shorter than the minimum, another column is added (up to `maxColumns`).
 * 3. If the agents still do not fit, the oldest ones are minimized instead of
 *    shrinking everything.
 * 4. Rects are integers and, together with the gaps, tile the work area
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
  /** Size of one terminal cell in pixels at the current DPI scale. */
  cellSize: Size;
  /** Per-window overhead in pixels (title/tab bar, padding, scrollbar). */
  chrome: Size;
  mainMinCols: number;
  agentMinCols: number;
  agentMinRows: number;
  /** Preferred share of the width for the main window. */
  mainFraction: number;
  /** Smallest share of the width the main window may shrink to. */
  mainMinFraction: number;
  /** "stacked" only: maximum number of agent columns. */
  maxColumns: number;
  /** "columns" only: maximum number of agent rows. */
  maxRows: number;
  /** Gap between windows in pixels. The outer edges have no gap. */
  gap: number;
}

export interface Layout {
  main: Rect;
  /**
   * Visible agents, oldest first, in fill order: "columns" fills row by row,
   * left to right; "stacked" fills column by column, top to bottom.
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
  mainFraction: 0.5,
  mainMinFraction: 0.45,
  maxColumns: 2,
  maxRows: 2,
  gap: 0,
});

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

/** Minimum window sizes in pixels derived from prefs. */
export function minimumSizes(workAreaWidth: number, prefs: LayoutPrefs): { main: number; agent: Size } {
  const { cellSize: cell, chrome } = prefs;
  return {
    main: Math.max(Math.ceil(prefs.mainMinFraction * workAreaWidth), prefs.mainMinCols * cell.w + chrome.w),
    agent: { w: prefs.agentMinCols * cell.w + chrome.w, h: prefs.agentMinRows * cell.h + chrome.h },
  };
}

export function computeLayout(
  workArea: Rect,
  agents: readonly LayoutAgent[],
  prefs: Partial<LayoutPrefs> = {},
): Layout {
  const p: LayoutPrefs = { ...DEFAULT_LAYOUT_PREFS, ...prefs };
  validate(workArea, agents, p);

  const visible = agents.filter((a) => !a.minimized);
  const min = minimumSizes(workArea.width, p);

  const maxTracks = p.arrangement === "columns" ? p.maxRows : p.maxColumns;
  // Show as many of the newest agents as fit, with as few tracks as possible.
  for (let n = visible.length; n > 0; n--) {
    for (let tracks = 1; tracks <= Math.min(maxTracks, n); tracks++) {
      const placed = place(workArea, visible.slice(visible.length - n), tracks, p, min);
      if (!placed) continue;
      const shown = new Set(placed.agents.map((a) => a.id));
      return { ...placed, minimized: agents.filter((a) => !shown.has(a.id)).map((a) => a.id) };
    }
  }
  return { main: { ...workArea }, agents: [], minimized: agents.map((a) => a.id) };
}

/**
 * Try to place all `agents` in `tracks` tracks: columns of stacked windows for
 * "stacked", rows of side-by-side windows for "columns". Earlier tracks take
 * the remainder. Returns undefined if any minimum size would be violated.
 */
function place(
  area: Rect,
  agents: readonly LayoutAgent[],
  tracks: number,
  p: LayoutPrefs,
  min: { main: number; agent: Size },
): Omit<Layout, "minimized"> | undefined {
  const { gap } = p;
  const stacked = p.arrangement === "stacked";
  const perTrack = Math.ceil(agents.length / tracks);
  const gridCols = stacked ? tracks : perTrack;
  const gridRows = stacked ? perTrack : tracks;
  if (gridRows * min.agent.h + (gridRows - 1) * gap > area.height) return undefined;

  const agentsMinWidth = gridCols * min.agent.w + (gridCols - 1) * gap;
  const maxMainWidth = area.width - gap - agentsMinWidth;
  if (maxMainWidth < min.main) return undefined;

  const preferred = Math.floor((area.width - gap) * p.mainFraction);
  const mainWidth = Math.max(min.main, Math.min(preferred, maxMainWidth));
  const main: Rect = { x: area.x, y: area.y, width: mainWidth, height: area.height };

  const agentsX = area.x + mainWidth + gap;
  const agentsWidth = area.width - mainWidth - gap;
  const base = Math.floor(agents.length / tracks);
  const extra = agents.length % tracks;
  const placed: { id: string; rect: Rect }[] = [];
  let next = 0;
  split(stacked ? agentsWidth : area.height, tracks, gap).forEach((track, t) => {
    const count = base + (t < extra ? 1 : 0);
    for (const item of split(stacked ? area.height : agentsWidth, count, gap)) {
      const rect: Rect = stacked
        ? { x: agentsX + track.offset, y: area.y + item.offset, width: track.size, height: item.size }
        : { x: agentsX + item.offset, y: area.y + track.offset, width: item.size, height: track.size };
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

function validate(area: Rect, agents: readonly LayoutAgent[], p: LayoutPrefs): void {
  const ints: [string, number][] = [
    ["workArea.x", area.x],
    ["workArea.y", area.y],
    ["workArea.width", area.width],
    ["workArea.height", area.height],
    ["gap", p.gap],
    ["maxColumns", p.maxColumns],
    ["maxRows", p.maxRows],
  ];
  for (const [name, value] of ints) {
    if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${value}`);
  }
  if (area.width <= 0 || area.height <= 0) throw new RangeError("workArea must have a positive size");
  if (p.gap < 0) throw new RangeError("gap must not be negative");
  if (p.arrangement !== "columns" && p.arrangement !== "stacked") {
    throw new RangeError(`arrangement must be "columns" or "stacked", got ${String(p.arrangement)}`);
  }
  if (p.maxColumns < 1 || p.maxRows < 1) throw new RangeError("maxColumns and maxRows must be at least 1");
  if (!(p.cellSize.w > 0 && p.cellSize.h > 0)) throw new RangeError("cellSize must be positive");
  if (!(p.chrome.w >= 0 && p.chrome.h >= 0)) throw new RangeError("chrome must not be negative");
  for (const name of ["mainFraction", "mainMinFraction"] as const) {
    if (!(p[name] > 0 && p[name] < 1)) throw new RangeError(`${name} must be between 0 and 1, got ${p[name]}`);
  }
  const ids = new Set<string>();
  for (const { id } of agents) {
    if (ids.has(id)) throw new Error(`Duplicate agent id: ${id}`);
    ids.add(id);
  }
}
