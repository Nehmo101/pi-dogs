/**
 * Pure geometry helpers for the Windows Terminal backend: invisible frame
 * borders, launch position and size, cell size estimation, animation frames.
 * Numbers were measured with Windows Terminal 1.24 on Windows 11 at 96 DPI
 * (docs/window-backend.md).
 */

import type { Rect, Size } from "../../layout/computeLayout.ts";

/** Invisible resize borders around the visible frame of a window, in pixels. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Windows 11 at 96 DPI: 7 px left/right/bottom, none on top. Scaled for other DPIs. */
export function defaultInsets(dpi = 96): Insets {
  const s = Math.round((7 * dpi) / 96);
  return { left: s, top: 0, right: s, bottom: s };
}

/**
 * Insets from GetWindowRect (outer) and DWMWA_EXTENDED_FRAME_BOUNDS (visible).
 * Negative values (never seen, but DWM is allowed to report odd things for
 * minimized or cloaked windows) are clamped to zero.
 */
export function frameInsets(outer: Rect, visible: Rect): Insets {
  const clamp = (v: number) => Math.max(0, v);
  return {
    left: clamp(visible.x - outer.x),
    top: clamp(visible.y - outer.y),
    right: clamp(outer.x + outer.width - (visible.x + visible.width)),
    bottom: clamp(outer.y + outer.height - (visible.y + visible.height)),
  };
}

/** Whether measured insets look like a normal restored window (not minimized/maximized). */
export function plausibleInsets(insets: Insets, dpi = 96): boolean {
  const max = Math.ceil((16 * dpi) / 96);
  return [insets.left, insets.top, insets.right, insets.bottom].every((v) => v >= 0 && v <= max);
}

/** Outer rect for SetWindowPos so that the *visible* frame ends up at `visible`. */
export function outerRect(visible: Rect, insets: Insets): Rect {
  return {
    x: visible.x - insets.left,
    y: visible.y - insets.top,
    width: visible.width + insets.left + insets.right,
    height: visible.height + insets.top + insets.bottom,
  };
}

/**
 * `wt --pos` and `--size` for a window whose visible frame should be `visible`.
 *
 * Measured with WT 1.24 at 96 DPI: `--pos x,y` puts the visible frame at
 * (x - 1, y), and `--size c,r` yields a frame of c * 9 + 35 by r * 19 + 58
 * pixels. The window is placed exactly right after discovery anyway, so
 * these only need to be close enough that the window does not visibly jump.
 */
export function launchGeometry(
  visible: Rect,
  cell: Size,
  chrome: Size,
  dpi = 96,
): { pos: { x: number; y: number }; size: { cols: number; rows: number } } {
  const offset = Math.max(1, Math.round(dpi / 96));
  return {
    pos: { x: visible.x + offset, y: visible.y },
    size: {
      cols: Math.max(1, Math.floor((visible.width - chrome.w) / cell.w)),
      rows: Math.max(1, Math.floor((visible.height - chrome.h) / cell.h)),
    },
  };
}

/** Terminal cells that fit into a visible window frame. */
export function cellsFor(visible: Size, cell: Size, chrome: Size): { cols: number; rows: number } {
  return {
    cols: Math.max(0, Math.floor((visible.w - chrome.w) / cell.w)),
    rows: Math.max(0, Math.floor((visible.h - chrome.h) / cell.h)),
  };
}

/**
 * Estimate the real cell size from one window whose terminal size is known
 * (the main pi window: its frame from DWM, cols/rows from process.stdout).
 *
 * The chrome estimate only enters divided by the cell count, so being off by
 * 10 px changes a 180-column estimate by 0.06 px. Returns `fallback` when the
 * measurement is implausible (e.g. pi runs in a split pane, so its columns
 * are not the window's), i.e. more than 40 % away from the fallback.
 */
export function estimateCellSize(frame: Size, terminal: { cols: number; rows: number }, chrome: Size, fallback: Size): Size {
  if (!(terminal.cols > 0 && terminal.rows > 0)) return fallback;
  const w = (frame.w - chrome.w) / terminal.cols;
  const h = (frame.h - chrome.h) / terminal.rows;
  const close = (v: number, ref: number) => v > ref * 0.6 && v < ref * 1.4;
  if (!close(w, fallback.w) || !close(h, fallback.h)) return fallback;
  const round = (v: number) => Math.round(v * 100) / 100;
  return { w: round(w), h: round(h) };
}

/** Ease-out cubic: fast start, gentle stop. */
export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}

/** Integer rect between `from` and `to` at progress `t` (0..1, already eased). */
export function lerpRect(from: Rect, to: Rect, t: number): Rect {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const x = mix(from.x, to.x);
  const y = mix(from.y, to.y);
  // Interpolate the edges, not the sizes, so neighbouring windows that share
  // an edge in both layouts keep sharing it in every frame (no gaps).
  const right = mix(from.x + from.width, to.x + to.width);
  const bottom = mix(from.y + from.height, to.y + to.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Intermediate rects for an eased transition, excluding the start and
 * including the exact target as the last frame.
 */
export function animationFrames(from: Rect, to: Rect, frames: number): Rect[] {
  if (frames <= 1 || sameRect(from, to)) return [{ ...to }];
  const out: Rect[] = [];
  for (let i = 1; i < frames; i++) out.push(lerpRect(from, to, easeOutCubic(i / frames)));
  out.push({ ...to });
  return out;
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Area of the intersection of two rects. */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
