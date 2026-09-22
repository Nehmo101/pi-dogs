import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWtArgs,
  encodeChildArg,
  escapeWtSemicolons,
  parseWindowsCommandLine,
  quoteWindowsArg,
  simulateWtChildCommandLine,
} from "../../src/backend/windows-terminal/wt-args.ts";

// The same set was verified end to end against WT 1.24 (child printed its argv).
const TRICKY = [
  "a b",
  "C:\\My Dir\\",
  'he said "hi"',
  "x;y",
  "\\;",
  "",
  "tab\there",
  "trail\\\\",
  "semi;colon space",
  "ümlaut 🐕",
  "a^b&c|d",
  'q"',
  "  lead",
  'back\\\\" x',
  "-- ",
  ";",
  "a;b;c d;",
  "--title",
  "-d",
  "C:\\Program Files\\nodejs\\node.exe",
];

const base = { windowName: "pi-dogs-a1-x", title: "t", command: "pwsh" };

describe("quoteWindowsArg", () => {
  it("leaves simple arguments alone", () => {
    assert.equal(quoteWindowsArg("abc"), "abc");
    assert.equal(quoteWindowsArg("C:\\dir\\file.txt"), "C:\\dir\\file.txt");
  });

  it("quotes whitespace, quotes and empty strings", () => {
    assert.equal(quoteWindowsArg("a b"), '"a b"');
    assert.equal(quoteWindowsArg(""), '""');
    assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
    assert.equal(quoteWindowsArg("C:\\My Dir\\"), '"C:\\My Dir\\\\"');
  });

  it("round-trips through CommandLineToArgvW rules", () => {
    const line = TRICKY.map(quoteWindowsArg).join(" ");
    assert.deepEqual(parseWindowsCommandLine(line), TRICKY);
  });
});

describe("wt escaping", () => {
  it("escapes every semicolon", () => {
    assert.equal(escapeWtSemicolons("a;b;c"), "a\\;b\\;c");
    assert.equal(escapeWtSemicolons("\\;"), "\\\\;");
    assert.equal(escapeWtSemicolons("none"), "none");
  });

  it("delivers every child argument unchanged after wt re-joins them", () => {
    const argv = buildWtArgs({ ...base, command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: TRICKY });
    const childLine = simulateWtChildCommandLine(argv);
    assert.deepEqual(parseWindowsCommandLine(childLine), ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ...TRICKY]);
  });

  it("never leaves a bare semicolon in any wt element", () => {
    const argv = buildWtArgs({ ...base, title: "a;b", cwd: "C:\\x;y", args: TRICKY });
    for (const element of argv) assert.ok(!/(^|[^\\]);/.test(element), `unescaped ; in ${JSON.stringify(element)}`);
  });

  it("strips the outer quotes only when wt adds them back", () => {
    assert.equal(encodeChildArg("a b"), "a b");
    assert.equal(encodeChildArg('q"'), '"q\\""');
    assert.equal(encodeChildArg("tab\there"), '"tab\there"');
    assert.equal(encodeChildArg(""), '""');
  });
});

describe("buildWtArgs", () => {
  it("builds the documented command line", () => {
    const argv = buildWtArgs({
      windowName: "pi-dogs-bello-k3",
      title: "🐕 Bello Baggins · qwen3.5:4b",
      tabColor: "#d5533a",
      cwd: "C:\\work dir",
      pos: { x: 1721, y: 0 },
      size: { cols: 187, rows: 70 },
      command: "node",
      args: ["launcher.ts", "--pi-dogs-launch=C:\\tmp\\a b.json"],
    });
    assert.deepEqual(argv, [
      "-w", "pi-dogs-bello-k3",
      "--pos", "1721,0",
      "--size", "187,70",
      "new-tab",
      "--title", "🐕 Bello Baggins · qwen3.5:4b",
      "--suppressApplicationTitle",
      "--tabColor", "#d5533a",
      "-d", "C:\\work dir",
      "--", "node", "launcher.ts", "--pi-dogs-launch=C:\\tmp\\a b.json",
    ]);
  });

  it("allows negative positions (monitors left of or above the primary one)", () => {
    const argv = buildWtArgs({ ...base, pos: { x: -2559, y: -300 } });
    assert.deepEqual(argv.slice(2, 4), ["--pos", "-2559,-300"]);
  });

  it("can keep the application title", () => {
    assert.ok(!buildWtArgs({ ...base, suppressApplicationTitle: false }).includes("--suppressApplicationTitle"));
  });

  it("rejects what wt cannot carry", () => {
    assert.throws(() => buildWtArgs({ ...base, args: ["%PATH%"] }), /expand/);
    assert.throws(() => buildWtArgs({ ...base, cwd: "C:\\%USERPROFILE%" }), /expand/);
    assert.throws(() => buildWtArgs({ ...base, args: ["a\nb"] }), /line breaks/);
    assert.throws(() => buildWtArgs({ ...base, title: "a\nb" }), /line breaks/);
    assert.throws(() => buildWtArgs({ ...base, windowName: "has space" }), /window name/);
    assert.throws(() => buildWtArgs({ ...base, windowName: "12" }), /numeric/);
    assert.throws(() => buildWtArgs({ ...base, tabColor: "red" }), /tabColor/);
    assert.throws(() => buildWtArgs({ ...base, pos: { x: 1.5, y: 0 } }), /pos/);
    assert.throws(() => buildWtArgs({ ...base, size: { cols: 0, rows: 5 } }), /size/);
    assert.throws(() => buildWtArgs({ ...base, command: "" }), /command/);
  });

  it("accepts a single percent sign", () => {
    assert.doesNotThrow(() => buildWtArgs({ ...base, args: ["100%"] }));
  });
});
