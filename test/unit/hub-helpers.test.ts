import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { parseNewArgs, parseSubcommand, splitDogAndText } from "../../src/hub/command-args.ts";
import { buildResultText, formatCost, formatElapsed, formatTokens, formatUsage } from "../../src/hub/format.ts";
import { buildPiArgs, currentPiCommand, dogProjectTrust } from "../../src/hub/pi-command.ts";
import { Registry } from "../../src/hub/registry.ts";
import { forkableEntries, seedSessionFile, sessionFileName, type SeedEntry } from "../../src/hub/session-seed.ts";
import { rgb, stateBadge, toRow, visibleDogs } from "../../src/hub/ui/rows.ts";

const newDog = (agentId: string, name: string, startedAt = 0) => ({
  agentId,
  name,
  token: "t",
  hubSecret: "h",
  color: "#102030",
  model: "ollama/qwen3.5:4b",
  mode: "autonomous" as const,
  cwd: ".",
  task: "t",
  closeOnDone: true,
  sessionFile: "s",
  runDir: "r",
  launchFile: "l",
  exitFile: "e",
  startedAt,
});

describe("/dogs argument parsing", () => {
  it("parses subcommands and aliases", () => {
    assert.equal(parseSubcommand("").sub, "list");
    assert.deepEqual(parseSubcommand("steer Bello Baggins hi there"), { sub: "steer", rest: "Bello Baggins hi there", raw: "steer" });
    assert.equal(parseSubcommand("stop rex").sub, "kill");
    assert.equal(parseSubcommand("Bello").sub, undefined);
  });

  it("splits multi-word dog names from the text", () => {
    const r = new Registry();
    r.add(newDog("a", "Bello Baggins"));
    r.add(newDog("b", "Rex"));
    assert.deepEqual(
      (({ dog, text }) => [dog.name, text])(splitDogAndText("Bello Baggins use English please", r)!),
      ["Bello Baggins", "use English please"],
    );
    assert.equal(splitDogAndText("rex", r)!.dog.name, "Rex");
    assert.equal(splitDogAndText("nobody here", r), undefined);
  });

  it("parses /dogs new options", () => {
    assert.deepEqual(parseNewArgs("--model ollama/qwen3.5:4b -i --name Scout find callers of x"), {
      model: "ollama/qwen3.5:4b",
      mode: "interactive",
      name: "Scout",
      task: "find callers of x",
    });
    assert.deepEqual(parseNewArgs("just a task"), { task: "just a task" });
  });

  it("keeps the text after the name and the task verbatim (no whitespace squashing)", () => {
    const r = new Registry();
    r.add(newDog("a", "Bello Baggins"));
    const steer = "  Use   this:\n\tline 1\n\tline 2  ";
    const { sub, rest } = parseSubcommand(`steer Bello Baggins ${steer}`);
    assert.equal(sub, "steer");
    assert.equal(splitDogAndText(rest, r)!.text, "Use   this:\n\tline 1\n\tline 2");
    assert.equal(parseNewArgs("-i  --name  Scout  fix   a\n  b").task, "fix   a\n  b");
    assert.deepEqual(parseSubcommand("  kill   Rex  "), { sub: "kill", rest: "Rex", raw: "kill" });
  });
});

describe("formatting", () => {
  it("formats tokens, cost, usage and elapsed time", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(12_400), "12.4k");
    assert.equal(formatTokens(250_000), "250k");
    assert.equal(formatTokens(3_000_000), "3M");
    assert.equal(formatCost(0), undefined);
    assert.equal(formatCost(0.004), "$0.0040");
    assert.equal(formatCost(1.5), "$1.50");
    assert.equal(formatUsage({ input: 12_400, output: 1_200, cost: 0.03 }), "12.4k in / 1.2k out, $0.03");
    assert.equal(formatElapsed(190_000), "03:10");
    assert.equal(formatElapsed(3_723_000), "1:02:03");
  });

  it("builds result messages for each outcome", () => {
    const base = { agentId: "a", name: "Rex", model: "m/x", usage: { input: 1, output: 2 }, sessionFile: "s.jsonl", elapsedMs: 1000 };
    assert.match(buildResultText({ ...base, state: "done", summary: "All good" }), /^Subagent "Rex" \(m\/x\) finished\.\n.*\nSession file: s\.jsonl\n\nResult:\nAll good$/);
    assert.match(buildResultText({ ...base, state: "done", error: "overloaded" }), /finished with an error: overloaded/);
    assert.match(buildResultText({ ...base, state: "failed", reason: "pi crashed" }), /failed: pi crashed[\s\S]*resume with/);
    assert.match(buildResultText({ ...base, state: "killed", reason: "window closed" }), /was stopped \(window closed\)/);
  });
});

describe("pi command line", () => {
  it("never puts the task on the command line and always allows subagent_done", () => {
    const args = buildPiArgs({
      agentExtension: "agent.ts",
      launchFile: "C:\\t\\launch.json",
      sessionFile: "s.jsonl",
      model: "ollama/qwen3.5:4b",
      thinking: "high",
      tools: ["read", " grep ", "read"],
      name: "Bello Baggins",
      approve: true,
    });
    assert.deepEqual(args, [
      "--session", "s.jsonl", "-e", "agent.ts", "--pi-dogs-launch=C:\\t\\launch.json", "--name", "Bello Baggins",
      "--model", "ollama/qwen3.5:4b", "--thinking", "high", "--tools", "read,grep,subagent_done", "--approve",
    ]);
  });

  it("always decides project trust explicitly when pi would otherwise prompt", () => {
    const base = { agentExtension: "a", launchFile: "l", sessionFile: "s", name: "n" };
    assert.ok(buildPiArgs({ ...base, approve: false }).includes("--no-approve"));
    assert.ok(!buildPiArgs({ ...base, approve: undefined }).some((a) => a.includes("approve")));

    const main = resolve("C:\\work\\proj");
    const trust = (cwd: string, o: { needs?: boolean; stored?: boolean | null; mainTrusted?: boolean } = {}) =>
      dogProjectTrust({
        cwd,
        mainCwd: main,
        mainTrusted: o.mainTrusted ?? true,
        needsTrust: () => o.needs ?? true,
        storedDecision: () => o.stored ?? null,
      });
    assert.equal(trust(main), true, "same folder: the main pi's decision");
    assert.equal(trust(main, { mainTrusted: false }), false);
    assert.equal(trust(resolve("C:\\other"), { needs: false }), undefined, "nothing to trust: pi does not ask");
    assert.equal(trust(resolve("C:\\other"), { stored: true }), true, "remembered decision");
    assert.equal(trust(resolve("C:\\other"), { stored: false }), false);
    assert.equal(trust(resolve("C:\\other")), false, "unknown folder: never trust silently, never prompt");
  });

  it("reuses the running pi: node + cli script, a pi binary, or pi from PATH", () => {
    assert.deepEqual(currentPiCommand(process.execPath, import.meta.filename), { command: "pi", args: [] }, ".ts is not a pi cli");
    assert.deepEqual(currentPiCommand("C:\\bin\\pi.exe", undefined), { command: "C:\\bin\\pi.exe", args: [] });
    assert.deepEqual(currentPiCommand("C:\\node\\node.exe", "C:\\missing\\cli.js"), { command: "pi", args: [] });
  });
});

describe("session seeding", () => {
  it("writes a v3 header and the context as a custom_message", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dogs-seed-"));
    try {
      const file = join(dir, "nested", "s.jsonl");
      seedSessionFile({ file, cwd: dir, context: "Goal: fix it", name: "Rex", parentSession: "parent.jsonl" }, "sid");
      const [header, ctx, ...rest] = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual({ ...header, timestamp: undefined }, { type: "session", version: 3, id: "sid", timestamp: undefined, cwd: dir, parentSession: "parent.jsonl" });
      assert.equal(ctx.type, "custom_message");
      assert.equal(ctx.parentId, null);
      assert.equal(ctx.customType, "pi-dogs-context");
      assert.match(ctx.content, /You are "Rex"/);
      assert.match(ctx.content, /Goal: fix it/);
      assert.deepEqual(rest, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forks the parent branch up to its last user message and links the context entry", () => {
    const branch: SeedEntry[] = [
      { type: "session", id: "h" },
      { type: "message", id: "1", parentId: null, message: { role: "user" } },
      { type: "message", id: "2", parentId: "1", message: { role: "assistant" } },
      { type: "message", id: "3", parentId: "2", message: { role: "user" } },
      { type: "message", id: "4", parentId: "3", message: { role: "assistant" } },
    ];
    assert.deepEqual(forkableEntries(branch).map((e) => e.id), ["1", "2"]);
    const dir = mkdtempSync(join(tmpdir(), "pi-dogs-seed-"));
    try {
      const entries = seedSessionFile({ file: join(dir, "s.jsonl"), cwd: dir, context: "c", name: "Rex", forkEntries: branch });
      assert.deepEqual(entries.map((e) => e.id).slice(1, 3), ["1", "2"]);
      assert.equal(entries[3]!.parentId, "2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names session files like pi does", () => {
    assert.equal(sessionFileName(new Date("2026-09-23T01:02:03.456Z"), "u"), "2026-09-23T01-02-03-456Z_u.jsonl");
  });
});

describe("dock rows", () => {
  it("shows live dogs and recently finished ones, with state badges", () => {
    const r = new Registry();
    r.add(newDog("a", "Rex", 0));
    r.add(newDog("b", "Old", 0));
    r.transition("b", "failed", 1000);
    r.transition("a", "running", 0);
    r.update("a", { connected: true, currentTool: "bash", usage: { input: 1000, output: 500 }, minimized: true, unseen: true });
    assert.deepEqual(visibleDogs(r.all(), 5000).map((d) => d.name), ["Rex", "Old"]);
    assert.deepEqual(visibleDogs(r.all(), 60_000).map((d) => d.name), ["Rex"]);
    const row = toRow(r.get("a")!, 190_000);
    assert.deepEqual(
      { ...row },
      { agentId: "a", name: "Rex", color: "#102030", model: "qwen3.5:4b", stateIcon: "▶", stateText: "running", tone: "accent", tool: "bash", elapsed: "03:10", tokens: "1.5k", minimized: true, unseen: true },
    );
    r.update("a", { takenOver: true });
    assert.equal(stateBadge(r.get("a")!).text, "by hand");
    r.update("a", { takenOver: false, connected: false });
    assert.equal(stateBadge(r.get("a")!).text, "reconnecting");
    assert.equal(rgb("#102030", "●"), "\x1b[38;2;16;32;48m●\x1b[39m");
    assert.equal(rgb("nope", "●"), "●");
  });
});
