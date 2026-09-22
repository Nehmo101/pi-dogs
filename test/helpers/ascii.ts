import type { Layout, Rect } from "../../src/layout/computeLayout.ts";

/**
 * Render a layout as ASCII art so humans can eyeball it in test output.
 * The work area is scaled to `cols` x `rows` characters.
 */
export function renderLayout(layout: Layout, area: Rect, cols = 64, rows = 16): string {
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
  const toCol = (x: number) => Math.round(((x - area.x) * cols) / area.width);
  const toRow = (y: number) => Math.round(((y - area.y) * rows) / area.height);

  const box = (rect: Rect, label: string) => {
    const c0 = toCol(rect.x);
    const c1 = toCol(rect.x + rect.width) - 1;
    const r0 = toRow(rect.y);
    const r1 = toRow(rect.y + rect.height) - 1;
    for (let c = c0; c <= c1; c++) {
      grid[r0]![c] = "-";
      grid[r1]![c] = "-";
    }
    for (let r = r0; r <= r1; r++) {
      grid[r]![c0] = "|";
      grid[r]![c1] = "|";
    }
    for (const [r, c] of [[r0, c0], [r0, c1], [r1, c0], [r1, c1]] as const) grid[r]![c] = "+";
    const room = c1 - c0 - 1;
    const full = ` ${label} ${rect.width}x${rect.height}`;
    const text = (full.length <= room ? full : ` ${label}`).slice(0, Math.max(0, room));
    if (r1 > r0 + 1) [...text].forEach((ch, i) => (grid[r0 + 1]![c0 + 1 + i] = ch));
  };

  box(layout.main, "main");
  for (const agent of layout.agents) box(agent.rect, agent.id);
  const lines = grid.map((row) => row.join("").trimEnd());
  if (layout.minimized.length > 0) lines.push(`minimized: ${layout.minimized.join(", ")}`);
  return lines.join("\n");
}
