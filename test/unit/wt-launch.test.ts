import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { windowNameFor } from "../../src/backend/windows-terminal/backend.ts";
import {
  agentTitle,
  discoverWindow,
  findNewWindow,
  snapshotWtWindows,
  uniqueTitle,
  visibleTitle,
} from "../../src/backend/windows-terminal/launch.ts";
import { findMainWindow } from "../../src/backend/windows-terminal/main-window.ts";
import { FakeWin32 } from "../helpers/fake-win32.ts";

describe("titles", () => {
  it("formats the agent title", () => {
    assert.equal(agentTitle("Bello Baggins", "qwen3.5:4b"), "🐕 Bello Baggins · qwen3.5:4b");
    assert.equal(agentTitle(" Rex\n", ""), "🐕 Rex");
  });

  it("adds an invisible, unique tag", () => {
    const a = uniqueTitle("🐕 Rex", 1);
    const b = uniqueTitle("🐕 Rex", 2);
    assert.notEqual(a, b);
    assert.equal(visibleTitle(a), "🐕 Rex");
    assert.equal(a.length, "🐕 Rex".length + 8);
    assert.ok([...a.slice(-8)].every((c) => [0x200b, 0x200c, 0x200d, 0x2060].includes(c.codePointAt(0)!)));
    const all = new Set(Array.from({ length: 4096 }, (_, i) => uniqueTitle("x", i)));
    assert.equal(all.size, 4096);
  });

  it("makes wt window names safe and fresh", () => {
    assert.equal(windowNameFor("bello-1", "abc"), "pi-dogs-bello-1-abc");
    assert.equal(windowNameFor("Sir Wuffelot/2", "z"), "pi-dogs-Sir-Wuffelot-2-z");
    assert.equal(windowNameFor("???", "z"), "pi-dogs---z");
    assert.equal(windowNameFor("", "z"), "pi-dogs-agent-z");
    assert.notEqual(windowNameFor("a"), windowNameFor("a"));
  });
});

describe("window discovery", () => {
  it("finds only a new, visible WT window with exactly the title", () => {
    const w = new FakeWin32();
    const old = w.addWindow({ title: "T" });
    const before = snapshotWtWindows(w);
    assert.equal(findNewWindow(w, "T", before), 0, "pre-existing windows never match");
    const hidden = w.addWindow({ title: "T", visible: false });
    w.addWindow({ title: "T2" });
    w.addWindow({ title: "T", className: "Other" });
    assert.equal(findNewWindow(w, "T", before), 0, "hidden windows are not found yet");
    w.windows.get(hidden.hwnd)!.visible = true;
    assert.equal(findNewWindow(w, "T", before), hidden.hwnd);
    assert.notEqual(hidden.hwnd, old.hwnd);
  });

  it("polls until the window shows up, or times out", async () => {
    const w = new FakeWin32();
    const before = snapshotWtWindows(w);
    let clock = 0;
    const opts = { timeoutMs: 100, pollMs: 10, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
    let calls = 0;
    const found = discoverWindow(w, "T", before, {
      ...opts,
      sleep: async (ms) => {
        clock += ms;
        if (++calls === 3) w.addWindow({ title: "T", hwnd: 77 });
      },
    });
    assert.equal(await found, 77);
    assert.equal(await discoverWindow(w, "nope", before, opts), 0);
    assert.ok(clock >= 100);
    assert.equal(await discoverWindow(w, "nope", before, { ...opts, cancelled: () => true }), 0);
  });
});

describe("findMainWindow", () => {
  it("uses the ConPTY pseudo window's owner", () => {
    const w = new FakeWin32();
    const main = w.addMainWindow();
    w.foreground = 0;
    assert.deepEqual(findMainWindow(w, {}), { hwnd: main.hwnd, source: "console-owner" });
  });

  it("falls back to the foreground WT window inside WT", () => {
    const w = new FakeWin32();
    const fg = w.addWindow({ title: "pi" });
    w.foreground = fg.hwnd;
    assert.deepEqual(findMainWindow(w, { WT_SESSION: "x" }), { hwnd: fg.hwnd, source: "foreground" });
    assert.equal(findMainWindow(w, {}).source, "none");
  });

  it("reports why it found nothing", () => {
    const w = new FakeWin32();
    const conhost = w.addWindow({ className: "ConsoleWindowClass" });
    w.consoleWindow = conhost.hwnd;
    const result = findMainWindow(w, {});
    assert.equal(result.hwnd, 0);
    assert.match(result.source === "none" ? result.reason : "", /not owned/);
    w.consoleWindow = 0;
    const none = findMainWindow(w, {});
    assert.match(none.source === "none" ? none.reason : "", /no console/);
  });
});
