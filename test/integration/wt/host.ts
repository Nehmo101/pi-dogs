// Windows Terminal integration test, host side. Runs INSIDE a Windows Terminal
// window that test/integration/wt/run.ts opened for it; that window plays the
// main pi window. Opens dummy agent windows through the real backend, checks
// the tiling pixel by pixel, and saves screenshots to docs/screens/.
//
// Usage (via run.ts): node host.ts <resultFile>

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WindowsTerminalBackend } from "../../../src/backend/windows-terminal/backend.ts";
import { Tiler } from "../../../src/backend/windows-terminal/tiler.ts";
import { loadWin32, WM_CLOSE, WT_WINDOW_CLASS, type Hwnd } from "../../../src/backend/windows-terminal/win32.ts";
import type { Rect } from "../../../src/layout/computeLayout.ts";
import { saveComposite } from "./screenshot.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const resultFile = process.argv[2] ?? join(tmpdir(), "pi-dogs-wt-test.json");
const screens = join(repo, "docs", "screens");
const state = join(tmpdir(), `pi-dogs-wt-test-${process.pid}`);
mkdirSync(screens, { recursive: true });
mkdirSync(state, { recursive: true });

const lines: string[] = [];
const failures: string[] = [];
const timings: Record<string, number | number[] | string> = {};
const t0 = performance.now();
const log = (message: string) => {
  const line = `${((performance.now() - t0) / 1000).toFixed(2).padStart(6)}s ${message}`;
  lines.push(line);
  process.stdout.write(line.slice(0, (process.stdout.columns ?? 120) - 1) + "\n");
};
const check = (ok: boolean, what: string) => {
  log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const same = (a: Rect | undefined, b: Rect | undefined) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const fmt = (r: Rect | undefined) => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : "-");

// Read stdin so Node notices console resizes (getWindowSize() is stale otherwise).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", () => {});
}

const win32 = loadWin32();
const backendLog: string[] = [];
const backend = new WindowsTerminalBackend({ log: (m) => (backendLog.push(m), log(m)) });
const closedEvents: string[] = [];
const minimizedEvents: string[] = [];
backend.setEvents({
  onClosed: (ref) => closedEvents.push(ref.agentId),
  onMinimizedChange: (ref, minimized, reason) => minimizedEvents.push(`${ref.agentId}:${minimized}:${reason}`),
});

const COLORS = ["#d5533a", "#3a7bd5", "#3aa55d", "#b0569f", "#c9a227"];
const DOGS = ["Bello Baggins", "Sir Wuffelot", "Doggo Dynamo", "Pfotenprinz", "Waldi Wirbelwind"];
const hwndOf = (agentId: string) => backend.diagnostics().windows.find((w) => w.agentId === agentId)?.hwnd ?? 0;
const ours = new Set<Hwnd>();

function spec(i: number) {
  const id = `wt-test-${i}`;
  rmSync(join(state, `${id}.stop`), { force: true });
  // pwsh -Command with ';', quotes and a path with spaces exercises the wt escaping for real.
  const script = `& '${process.execPath}' '${join(here, "dummy-agent.ts")}' '${state}' '${DOGS[i]}' '${COLORS[i]}'; exit 0`;
  return {
    agentId: id,
    name: DOGS[i]!,
    modelLabel: i % 2 ? "qwen3.5:4b" : "claude-sonnet-5",
    color: COLORS[i]!,
    cwd: repo,
    command: "pwsh",
    args: ["-NoLogo", "-NoProfile", "-Command", script],
  };
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 8000): Promise<number> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) {
      check(false, `timed out waiting for ${what}`);
      return -1;
    }
    await sleep(20);
  }
  return performance.now() - start;
}

/** Verify that every visible window's DWM frame equals its layout rect and the rects tile the work area. */
function verifyTiling(label: string, expectAgents: number): void {
  const d = backend.diagnostics();
  const plan = d.plan!;
  const layout = plan.layout;
  check(layout.agents.length === expectAgents, `${label}: ${expectAgents} agent windows visible (got ${layout.agents.length})`);
  const mainFrame = win32.getFrameBounds(d.main!.hwnd);
  let worst = 0;
  const err = (a: Rect | undefined, b: Rect) =>
    a ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) : 9999;
  worst = Math.max(worst, err(mainFrame, layout.main));
  const report = [`main ${fmt(mainFrame)}`];
  for (const a of layout.agents) {
    const frame = win32.getFrameBounds(hwndOf(a.id));
    worst = Math.max(worst, err(frame, a.rect));
    report.push(`${a.id.replace("wt-test-", "#")} ${fmt(frame)}`);
  }
  log(`${label}: ${report.join(" | ")}`);
  check(worst === 0, `${label}: all frames flush with the layout (max error ${worst}px)`);
  const hidden = layout.agents.filter((a) => !win32.isWindowVisible(hwndOf(a.id)) || win32.isIconic(hwndOf(a.id)));
  check(hidden.length === 0, `${label}: every agent window is really shown (${hidden.length} hidden)`);
  const work = plan.monitor.work;
  const area = [layout.main, ...layout.agents.map((a) => a.rect)].reduce((s, r) => s + r.width * r.height, 0);
  check(area === work.width * work.height, `${label}: windows cover the work area ${fmt(work)} exactly`);
}

function lastSize(name: string): { cols: number; rows: number } | undefined {
  const file = join(state, `${name}.sizes`);
  if (!existsSync(file)) return undefined;
  const all = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(all.at(-1)!);
}

function checkReadable(label: string): void {
  const d = backend.diagnostics();
  for (const a of d.plan!.layout.agents) {
    const i = Number(a.id.split("-").at(-1));
    const size = lastSize(DOGS[i]!);
    check(!!size && size.cols >= 80 && size.rows >= 16, `${label}: ${DOGS[i]} readable (${size?.cols}x${size?.rows} cells)`);
  }
  const cols = process.stdout.isTTY ? process.stdout.getWindowSize()[0] : 0;
  check(cols >= 100, `${label}: main keeps >= 100 columns (${cols})`);
}

async function shot(name: string): Promise<void> {
  const d = backend.diagnostics();
  const work = d.plan!.monitor.work;
  const windows = [d.main!.hwnd, ...d.windows.map((w) => w.hwnd)];
  const path = join(screens, `${name}.png`);
  const ok = await saveComposite(win32, windows, work, path);
  check(ok, ok ? `screenshot docs/screens/${name}.png` : `screenshot ${name} not saved (window covered or capture failed)`);
}

async function settle(ms = 700): Promise<void> {
  await sleep(ms); // let the terminals redraw before measuring or taking a screenshot
}

try {
  log(`host pid ${process.pid}, terminal ${process.stdout.columns}x${process.stdout.rows}`);
  const available = backend.available();
  check(available.ok, `available(): ${available.ok ? "ok" : available.hint}`);

  // 1 agent ------------------------------------------------------------------
  let t = performance.now();
  await backend.open(spec(0));
  timings["open1Ms"] = Math.round(performance.now() - t);
  ours.add(hwndOf("wt-test-0"));
  const d0 = backend.diagnostics();
  check(d0.main?.source === "console-owner", `main window found via ${d0.main?.source}`);
  log(`measured cell size ${JSON.stringify(d0.plan!.prefs.cellSize)} at ${d0.plan!.dpi} DPI`);
  check(win32.getForegroundWindow() === d0.main!.hwnd, "focus is back on the main window after open");
  await waitFor("agent 0 drawn", () => !!lastSize(DOGS[0]!));
  await settle();
  verifyTiling("1 agent", 1);
  checkReadable("1 agent");
  await shot("wt-1-agent");

  // 2 agents at once (burst) -> 3 columns --------------------------------------
  const relayoutsBefore = backendLog.filter((m) => m.includes("relayout:")).length;
  t = performance.now();
  await Promise.all([backend.open(spec(1)), backend.open(spec(2))]);
  timings["openBurst2Ms"] = Math.round(performance.now() - t);
  const relayouts = backendLog.filter((m) => m.includes("relayout:")).length - relayoutsBefore;
  timings["burstRelayouts"] = relayouts;
  check(relayouts <= 3, `burst of 2 opens caused ${relayouts} relayouts (make room + place, coalesced)`);
  for (const i of [1, 2]) ours.add(hwndOf(`wt-test-${i}`));
  for (const i of [1, 2]) await waitFor(`agent ${i} drawn`, () => !!lastSize(DOGS[i]!));
  check(win32.getForegroundWindow() === backend.diagnostics().main!.hwnd, "focus is back on main after the burst");
  await settle();
  verifyTiling("3 agents", 3);
  checkReadable("3 agents");
  await shot("wt-3-agents-columns");

  // 4th agent -> two rows of two ----------------------------------------------
  t = performance.now();
  await backend.open(spec(3));
  timings["open4thMs"] = Math.round(performance.now() - t);
  ours.add(hwndOf("wt-test-3"));
  await waitFor("agent 3 drawn", () => !!lastSize(DOGS[3]!));
  await settle();
  verifyTiling("4 agents", 4);
  checkReadable("4 agents");
  timings["relayout4BatchMs"] = +backend.diagnostics().lastApply!.batchMs.toFixed(2);
  await shot("wt-4-agents-grid");

  // The user closes agent 1 (its process exits) -> back to 3 columns ------------
  const closedHwnd = hwndOf("wt-test-1");
  t = performance.now();
  writeFileSync(join(state, `${DOGS[1]}.stop`), "");
  await waitFor("onClosed for agent 1", () => closedEvents.includes("wt-test-1"));
  timings["closeDetectMs"] = Math.round(performance.now() - t);
  await waitFor("relayout after close", () => backend.diagnostics().plan!.layout.agents.length === 3);
  check(!win32.isWindow(closedHwnd), "closed window is gone");
  await settle();
  verifyTiling("after close", 3);
  await shot("wt-5-after-close");

  // Minimize and restore agent 2 ---------------------------------------------
  const h2 = hwndOf("wt-test-2");
  await backend.minimize({ agentId: "wt-test-2" });
  await settle(400);
  check(win32.isIconic(h2), "agent 2 is minimized");
  verifyTiling("minimized", 2);
  await shot("wt-6-minimized");
  const mainHwnd = backend.diagnostics().main!.hwnd;
  win32.setForegroundWindow(mainHwnd);
  await sleep(100);
  await backend.restore({ agentId: "wt-test-2" });
  await settle(400);
  check(!win32.isIconic(h2), "agent 2 is restored");
  check(win32.getForegroundWindow() === mainHwnd, "restore did not take the focus");
  verifyTiling("restored", 3);
  await shot("wt-7-restored");
  check(minimizedEvents.length === 0, `no spurious minimize events (${minimizedEvents.join(", ") || "none"})`);

  // Explicit close() ----------------------------------------------------------
  const h3 = hwndOf("wt-test-3");
  t = performance.now();
  await backend.close({ agentId: "wt-test-3" });
  timings["closeCallMs"] = Math.round(performance.now() - t);
  check(!win32.isWindow(h3), "close() closed agent 3's window");
  check(!closedEvents.includes("wt-test-3"), "close() does not report onClosed");
  await settle(300);
  verifyTiling("after close()", 2);

  // Animation experiment (after dispose, on the remaining windows) -------------
  const remaining = backend.diagnostics().windows.map((w) => ({ id: w.agentId, hwnd: w.hwnd }));
  backend.dispose();
  const probeDog = DOGS[Number(remaining[0]!.id.split("-").at(-1))]!;
  for (const [label, animation] of [
    ["single-step", false],
    ["animated-150ms-6", { durationMs: 150, frames: 6 }],
  ] as const) {
    const tiler = new Tiler(win32, mainHwnd, { animation, terminalSize: () => undefined });
    for (const r of remaining) {
      tiler.add(r.id);
      tiler.attach(r.id, r.hwnd);
    }
    await tiler.apply();
    const sizeLines = () => (existsSync(join(state, `${probeDog}.sizes`)) ? readFileSync(join(state, `${probeDog}.sizes`), "utf8").trim().split("\n").length : 0);
    const results = [];
    for (let k = 0; k < 4; k++) {
      // Toggle between 1 and 2 visible agents: every window changes size.
      if (k % 2 === 0) tiler.minimize(remaining[1]!.id);
      else tiler.unminimize(remaining[1]!.id);
      const before = sizeLines();
      const r = await tiler.apply();
      await sleep(600);
      results.push({ ms: +r.ms.toFixed(1), batchMs: +r.batchMs.toFixed(2), batches: r.batches, reflows: sizeLines() - before });
    }
    timings[label] = JSON.stringify(results);
    log(`${label}: ${JSON.stringify(results)}`);
  }
} catch (error) {
  check(false, `exception: ${(error as Error).stack ?? error}`);
} finally {
  backend.dispose();
  // Close everything we opened: dummies exit on their stop file; WM_CLOSE as a fallback.
  for (const name of DOGS) writeFileSync(join(state, `${name}.stop`), "");
  await sleep(600);
  for (const hwnd of ours) if (win32.isWindow(hwnd)) win32.postMessage(hwnd, WM_CLOSE);
  await sleep(300);
  const leftovers = [...ours].filter((h) => win32.isWindow(h));
  check(leftovers.length === 0, `all test windows closed (${leftovers.length} left)`);
  // Our windows have titles starting with the dog emoji and a test dog name; never touch others.
  const stray = win32.findWindowsByClass(WT_WINDOW_CLASS).filter((h) => DOGS.some((d) => win32.getWindowText(h).includes(d)));
  check(stray.length === 0, `no stray test windows (${stray.length})`);
  rmSync(state, { recursive: true, force: true });
  writeFileSync(resultFile, JSON.stringify({ ok: failures.length === 0, failures, timings, log: lines }, null, 2));
  process.exit(0); // always 0 so Windows Terminal closes this window; the verdict is in the result file
}
