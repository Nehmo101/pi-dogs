import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canTransition, InvalidTransitionError, isTerminal, Registry, type NewDog } from "../../src/hub/registry.ts";
import type { AgentState } from "../../src/protocol/types.ts";

const dog = (agentId: string, name: string, startedAt = 1000): NewDog => ({
  agentId,
  name,
  token: "t",
  color: "#ffffff",
  model: "ollama/qwen3.5:4b",
  mode: "autonomous",
  cwd: "C:\\work",
  task: "task",
  closeOnDone: true,
  sessionFile: "s.jsonl",
  runDir: "run",
  launchFile: "run/launch.json",
  exitFile: "run/exit.json",
  startedAt,
});

describe("state machine", () => {
  const ALL: AgentState[] = ["starting", "running", "idle", "closing", "done", "failed", "killed"];

  it("allows the documented transitions", () => {
    const allowed: [AgentState, AgentState][] = [
      ["starting", "running"],
      ["starting", "failed"],
      ["running", "idle"],
      ["idle", "running"],
      ["running", "closing"],
      ["idle", "closing"],
      ["closing", "done"],
      ["closing", "killed"],
      ["closing", "failed"],
      ["running", "done"],
      ["running", "failed"],
      ["idle", "killed"],
    ];
    for (const [from, to] of allowed) assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  });

  it("forbids leaving terminal states and going back from closing", () => {
    for (const from of ["done", "failed", "killed"] as const) {
      assert.equal(isTerminal(from), true);
      for (const to of ALL) assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    }
    for (const to of ["starting", "running", "idle"] as const) assert.equal(canTransition("closing", to), false);
    assert.equal(canTransition("running", "starting"), false);
  });

  it("throws on invalid transitions and stamps endedAt on terminal ones", () => {
    const r = new Registry();
    r.add(dog("a", "Rex"));
    assert.equal(r.transition("a", "running", 2000), true);
    assert.equal(r.transition("a", "running", 2001), false, "same state is a no-op");
    assert.throws(() => r.transition("a", "starting", 2002), InvalidTransitionError);
    r.update("a", { currentTool: "bash", connected: true });
    r.transition("a", "failed", 3000);
    const rec = r.get("a")!;
    assert.equal(rec.endedAt, 3000);
    assert.equal(rec.connected, false);
    assert.equal(rec.currentTool, undefined);
    assert.equal(r.tryTransition("a", "running", 4000), false);
  });
});

describe("Registry", () => {
  it("finds dogs by id, name (case-insensitive) and unique prefix, preferring live dogs", () => {
    const r = new Registry();
    r.add(dog("bello-1", "Bello Baggins", 1));
    r.add(dog("bello-2", "Bello Bytebeißer", 2));
    r.add(dog("rex-1", "Rex", 3));
    assert.equal(r.find("rex-1")?.name, "Rex");
    assert.equal(r.find("bello baggins")?.agentId, "bello-1");
    assert.equal(r.find("bello"), undefined, "ambiguous prefix");
    r.transition("bello-1", "killed", 5);
    assert.equal(r.find("bello")?.agentId, "bello-2", "only one live match");
    assert.equal(r.find(""), undefined);
    assert.deepEqual(r.live().map((d) => d.agentId), ["bello-2", "rex-1"]);
  });

  it("rejects duplicate ids", () => {
    const r = new Registry();
    r.add(dog("a", "A"));
    assert.throws(() => r.add(dog("a", "B")), /Duplicate/);
  });

  it("builds mirror lines from events and trims to the limit", () => {
    const r = new Registry({ mirrorLimit: 4 });
    r.add(dog("a", "A"));
    r.applyEvent("a", { kind: "user_message", text: "task", source: "hub" }, 1);
    r.applyEvent("a", { kind: "text_delta", text: "one\ntw" }, 2);
    r.applyEvent("a", { kind: "text_delta", text: "o" }, 3);
    r.applyEvent("a", { kind: "tool_start", toolCallId: "c", tool: "read", args: "x.ts" }, 4);
    r.applyEvent("a", { kind: "tool_end", toolCallId: "c", tool: "read", isError: true }, 5);
    const mirror = r.get("a")!.mirror;
    assert.deepEqual(mirror.map((l) => l.kind), ["user", "text", "text", "tool"]);
    const tool = mirror[3]!;
    assert.ok(tool.kind === "tool" && tool.status === "error");
    assert.equal(mirror[2]!.kind === "text" && mirror[2]!.text, "two");
    r.applyEvent("a", { kind: "text_delta", text: "after tool" }, 6);
    assert.equal(r.get("a")!.mirror.length, 4, "trimmed");
    assert.deepEqual(r.get("a")!.mirror.at(-1), { kind: "text", text: "after tool" });
  });

  it("marks unseen output only while minimized", () => {
    const r = new Registry();
    r.add(dog("a", "A"));
    r.applyEvent("a", { kind: "text_delta", text: "x" }, 1);
    assert.equal(r.get("a")!.unseen, false);
    r.update("a", { minimized: true });
    r.applyEvent("a", { kind: "text_delta", text: "y" }, 2);
    assert.equal(r.get("a")!.unseen, true);
  });

  it("snapshots and restores plain data, marking everyone disconnected", () => {
    const r = new Registry();
    r.add(dog("a", "A"));
    r.update("a", { connected: true, pid: 42, taskSent: true });
    r.transition("a", "running", 5);
    const snap = JSON.parse(JSON.stringify(r.snapshot()));
    const restored = Registry.restore(snap);
    const rec = restored.get("a")!;
    assert.equal(rec.state, "running");
    assert.equal(rec.pid, 42);
    assert.equal(rec.taskSent, true);
    assert.equal(rec.connected, false);
    r.update("a", { name: "changed" });
    assert.equal(restored.get("a")!.name, "A", "snapshot is a copy");
  });
});
