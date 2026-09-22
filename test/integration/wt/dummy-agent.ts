// Stand-in for an agent window in the Windows Terminal integration test.
// Usage: node dummy-agent.ts <stateDir> <name> <color>
//  - draws a banner with its terminal size and a page of code-like text, redrawn on resize
//  - appends every size it sees to <stateDir>/<name>.sizes (JSON lines with a timestamp)
//  - exits with code 0 when <stateDir>/<name>.stop appears (so WT closes the window)
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [stateDir = ".", name = "dog", color = "#3a7bd5"] = process.argv.slice(2);
const sizes = join(stateDir, `${name}.sizes`);
const stop = join(stateDir, `${name}.stop`);

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const [r, g, b] = hex(/^#[0-9a-f]{6}$/i.test(color) ? color : "#3a7bd5");

const SAMPLE = `export function computeLayout(workArea: Rect, agents: readonly LayoutAgent[]): Layout {
  const visible = agents.filter((a) => !a.minimized);
  // Show as many of the newest agents as fit, with as few rows as possible.
  for (let n = visible.length; n > 0; n--) {
    for (let rows = 1; rows <= maxRows; rows++) {
      const placed = place(workArea, visible.slice(visible.length - n), rows);
      if (placed) return placed;
    }
  }
  return { main: workArea, agents: [], minimized: agents.map((a) => a.id) };
}

  ● read src/layout/computeLayout.ts (212 lines)
  ● bash npm test
    ✔ computeLayout invariants across screens, scales and agent counts (1.2s)
    ✔ columns: three full-height columns next to a 100+ column main
    ℹ tests 65 · pass 65 · fail 0

The layout keeps every agent at 80 columns or more. When a fourth column would
be narrower than that, the agents wrap into a second row instead, and the main
window's share adapts: 50 % with one agent, 40 % with two, 33 % with three.`.split("\n");

let last = "";
function draw(): void {
  // getWindowSize() asks the console directly; columns/rows can be stale.
  const [cols, rows] = process.stdout.isTTY ? process.stdout.getWindowSize() : [80, 24];
  if (`${cols}x${rows}` === last) return;
  last = `${cols}x${rows}`;
  appendFileSync(sizes, JSON.stringify({ t: Date.now(), cols, rows }) + "\n");
  const banner = ` ${name}  ${cols} x ${rows} `;
  const lines: string[] = [];
  lines.push(`\x1b[48;2;${r};${g};${b}m\x1b[38;2;255;255;255m\x1b[1m${banner.padEnd(cols).slice(0, cols)}\x1b[0m`);
  lines.push("");
  for (let i = 0; lines.length < rows - 1; i++) {
    const line = SAMPLE[i % SAMPLE.length]!;
    const shade = line.startsWith("  ●") ? "\x1b[36m" : line.startsWith("    ✔") ? "\x1b[32m" : "\x1b[37m";
    lines.push(shade + line.slice(0, cols - 1) + "\x1b[0m");
  }
  process.stdout.write("\x1b[?25l\x1b[H\x1b[2J" + lines.join("\r\n"));
}

draw();
// On Windows, Node only sees console resize events while it reads stdin (as
// pi's TUI does), so read it in raw mode; the 50 ms poll below is a fallback.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", () => {});
}
process.stdout.on("resize", draw);
const timer = setInterval(() => {
  draw();
  if (existsSync(stop)) {
    clearInterval(timer);
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  }
}, 50);
