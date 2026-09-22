import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WindowsTerminalBackend, type WindowsTerminalBackendOptions } from "../../src/backend/windows-terminal/backend.ts";
import type { OpenSpec } from "../../src/backend/pane-backend.ts";
import { WM_CLOSE } from "../../src/backend/windows-terminal/win32.ts";
import { FakeWin32 } from "../helpers/fake-win32.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Simulates wt.exe: a window with the requested title shows up a few ms later and takes the foreground. */
function fakeWt(w: FakeWin32, calls: string[][], behaviour: { failFirst?: boolean; never?: boolean; noSteal?: boolean } = {}) {
  let failed = false;
  return async (_exe: string, argv: readonly string[]) => {
    calls.push([...argv]);
    if (behaviour.failFirst && !failed) {
      failed = true;
      throw new Error("wt.exe exited with code 1");
    }
    if (behaviour.never) return;
    const title = argv[argv.indexOf("--title") + 1]!.replace(/\\;/g, ";");
    const [x, y] = argv[argv.indexOf("--pos") + 1]!.split(",").map(Number) as [number, number];
    setTimeout(() => {
      const win = w.addWindow({ title, frame: { x: x - 1, y, width: 700, height: 500 }, visible: false });
      setTimeout(() => {
        win.visible = true;
        if (!behaviour.noSteal) w.foreground = win.hwnd; // new WT windows normally take the foreground
      }, 3);
    }, 5);
  };
}

function setup(options: Partial<WindowsTerminalBackendOptions> & { wt?: Parameters<typeof fakeWt>[2] } = {}) {
  const w = new FakeWin32();
  const main = w.addMainWindow();
  const calls: string[][] = [];
  const logs: string[] = [];
  const backend = new WindowsTerminalBackend({
    win32: w,
    wtExe: "wt.exe",
    runWt: fakeWt(w, calls, options.wt),
    env: { WT_SESSION: "test" },
    terminalSize: () => undefined,
    relayoutDelayMs: 1,
    relayoutMaxDelayMs: 20,
    discoveryTimeoutMs: 500,
    log: (m) => logs.push(m),
    ...options,
  });
  return { w, main, backend, calls, logs };
}

const spec = (i: number, extra: Partial<OpenSpec> = {}): OpenSpec => ({
  agentId: `dog-${i}`,
  name: ["Bello Baggins", "Sir Wuffelot", "Doggo Dynamo", "Pfotenprinz"][i] ?? `Dog ${i}`,
  modelLabel: "qwen3.5:4b",
  color: "#d5533a",
  cwd: "C:\\work",
  command: "node",
  args: ["launcher.ts", "--pi-dogs-launch=C:\\a b;c.json"],
  ...extra,
});

function frames(w: FakeWin32, backend: WindowsTerminalBackend) {
  const d = backend.diagnostics();
  return {
    main: w.frameOf(d.main!.hwnd),
    agents: Object.fromEntries(d.windows.map((x) => [x.agentId, w.frameOf(x.hwnd)])),
    layout: d.plan!.layout,
  };
}

describe("WindowsTerminalBackend.available", () => {
  it("explains what is missing", () => {
    const w = new FakeWin32();
    const notInWt = new WindowsTerminalBackend({ win32: w, wtExe: "wt.exe", env: {} }).available();
    assert.ok(!notInWt.ok && /Windows Terminal/.test(notInWt.hint));
    const noWt = new WindowsTerminalBackend({ win32: w, env: { WT_SESSION: "x", PATH: "" } }).available();
    assert.ok(!noWt.ok && /wt\.exe/.test(noWt.hint));
    assert.deepEqual(new WindowsTerminalBackend({ win32: w, wtExe: "wt.exe", env: { WT_SESSION: "x" } }).available(), { ok: true });
  });
});

describe("WindowsTerminalBackend", () => {
  it("opens a window in its slot, tiles flush and gives the focus back", async () => {
    const { w, main, backend, calls } = setup();
    await backend.open(spec(0));
    const f = frames(w, backend);
    assert.deepEqual(f.main, { x: 0, y: 0, width: 1720, height: 1392 });
    assert.deepEqual(f.agents["dog-0"], { x: 1720, y: 0, width: 1720, height: 1392 });
    assert.equal(w.foreground, main.hwnd);
    const argv = calls[0]!;
    assert.equal(argv[argv.indexOf("--pos") + 1], "1721,0");
    assert.equal(argv[argv.indexOf("--size") + 1], "187,70");
    assert.equal(argv[argv.indexOf("--tabColor") + 1], "#d5533a");
    assert.match(argv[argv.indexOf("--title") + 1]!, /^🐕 Bello Baggins · qwen3\.5:4b/);
    assert.match(argv[1]!, /^pi-dogs-dog-0-/);
    assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["node", "launcher.ts", "--pi-dogs-launch=C:\\a b\\;c.json"]);
    backend.dispose();
  });

  it("makes room once for a burst and launches every window straight into its final slot", async () => {
    const { w, main, backend, calls } = setup();
    await Promise.all([0, 1, 2].map((i) => backend.open(spec(i))));
    // The very first batch already gives main its 3-column width.
    assert.equal(w.batches[0]!.find((p) => p.hwnd === main.hwnd)!.width, 1146 + 14);
    assert.deepEqual(calls.map((a) => a[a.indexOf("--pos") + 1]), ["1147,0", "1912,0", "2677,0"]);
    const f = frames(w, backend);
    for (const a of f.layout.agents) assert.deepEqual(f.agents[a.id], a.rect);
    assert.equal(w.foreground, main.hwnd);
    backend.dispose();
  });

  it("closes windows via WM_CLOSE and re-tiles the rest", async () => {
    const { w, backend } = setup();
    await backend.open(spec(0));
    await backend.open(spec(1));
    const hwnd = backend.diagnostics().windows[0]!.hwnd;
    await backend.close({ agentId: "dog-0" });
    assert.deepEqual(w.posted.at(-1), [hwnd, WM_CLOSE]);
    const f = frames(w, backend);
    assert.equal(f.layout.agents.length, 1);
    assert.deepEqual(f.main, { x: 0, y: 0, width: 1720, height: 1392 });
    await backend.close({ agentId: "unknown" }); // no-op
    backend.dispose();
  });

  it("reports windows closed by the user and re-tiles", async () => {
    const { w, backend } = setup({ pollIntervalMs: 5 });
    const closed: string[] = [];
    backend.setEvents({ onClosed: (ref) => closed.push(ref.agentId) });
    await backend.open(spec(0));
    await backend.open(spec(1));
    w.close(backend.diagnostics().windows[0]!.hwnd);
    for (let i = 0; i < 50 && closed.length === 0; i++) await sleep(5);
    assert.deepEqual(closed, ["dog-0"]);
    for (let i = 0; i < 50 && frames(w, backend).layout.agents.length !== 1; i++) await sleep(5);
    assert.deepEqual(frames(w, backend).agents["dog-1"], { x: 1720, y: 0, width: 1720, height: 1392 });
    backend.dispose();
  });

  it("minimizes, restores without focus, and focuses on request", async () => {
    const { w, main, backend } = setup();
    await backend.open(spec(0));
    await backend.open(spec(1));
    const hwnd = backend.diagnostics().windows[0]!.hwnd;
    await backend.minimize({ agentId: "dog-0" });
    assert.ok(w.isIconic(hwnd));
    assert.equal(frames(w, backend).layout.agents.length, 1);
    await backend.restore({ agentId: "dog-0" });
    assert.ok(!w.isIconic(hwnd));
    assert.equal(w.foreground, main.hwnd);
    await backend.minimize({ agentId: "dog-0" });
    await backend.focus({ agentId: "dog-0" });
    assert.ok(!w.isIconic(hwnd));
    assert.equal(w.foreground, hwnd);
    backend.dispose();
  });

  it("emits auto-minimize events when the layout runs out of room", async () => {
    const { w, backend } = setup();
    w.monitors[0]!.work = { x: 0, y: 0, width: 1920, height: 1032 };
    w.monitors[0]!.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const changes: string[] = [];
    backend.setEvents({ onMinimizedChange: (ref, minimized, reason) => changes.push(`${ref.agentId}:${minimized}:${reason}`) });
    for (const i of [0, 1, 2]) await backend.open(spec(i));
    assert.deepEqual(changes, ["dog-0:true:auto"]);
    backend.dispose();
  });

  it("fails cleanly when the window never appears, and frees the slot", async () => {
    const { w, main, backend } = setup({ wt: { never: true }, discoveryTimeoutMs: 30 });
    await assert.rejects(backend.open(spec(0)), /did not appear/);
    await backend.relayout();
    assert.equal(backend.diagnostics().windows.length, 0);
    assert.deepEqual(w.frameOf(main.hwnd), { x: 200, y: 150, width: 1295, height: 818 }, "main got its size back");
    backend.dispose();
  });

  it("retries once when wt.exe itself fails", async () => {
    const { backend, calls } = setup({ wt: { failFirst: true } });
    await backend.open(spec(0));
    assert.equal(calls.length, 2);
    backend.dispose();
  });

  it("logs when the foreground lock refuses to give the focus back", async () => {
    const { w, backend, logs } = setup();
    w.lockForeground = true;
    await backend.open(spec(0));
    assert.ok(logs.some((l) => l.includes("could not give the focus back")));
    backend.dispose();
  });

  it("leaves the focus alone when the user moved on during the launch", async () => {
    const { w, backend } = setup({ wt: { noSteal: true } });
    const other = w.addWindow({ className: "Chrome_WidgetWin_1", title: "browser" });
    const opening = backend.open(spec(0));
    w.foreground = other.hwnd; // the user clicked into another app right away
    await opening;
    await sleep(30);
    assert.equal(w.foreground, other.hwnd);
    backend.dispose();
  });

  it("rejects duplicates and use after dispose", async () => {
    const { backend } = setup();
    await backend.open(spec(0));
    await assert.rejects(backend.open(spec(0)), /already/);
    backend.dispose();
    backend.dispose();
    await assert.rejects(backend.open(spec(1)), /disposed/);
    await backend.relayout();
  });
});
