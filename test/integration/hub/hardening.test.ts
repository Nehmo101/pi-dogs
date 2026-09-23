/**
 * Regression tests for review findings, over a real named pipe: pipe
 * handlers must never throw into pi, kills must win over late results and
 * survive a /reload, dogs trust only their own hub, and edge cases of window
 * closes, reconnects and quitting.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AgentClient } from "../../../src/agent/client.ts";
import { RESULT_MESSAGE_TYPE } from "../../../src/hub/hub.ts";
import { Registry } from "../../../src/hub/registry.ts";
import { encodeMessage, JsonlDecoder } from "../../../src/protocol/framing.ts";
import { WINDOW_CLOSED_EXIT_CODE } from "../../../src/protocol/launch.ts";
import type { HubToAgentMessage } from "../../../src/protocol/types.ts";
import { createHarness, RecordingHost, uniquePipe, type Harness } from "../../helpers/hub-harness.ts";
import { SimAgent, waitFor } from "../../helpers/sim-agent.ts";

const usage = { input: 3, output: 2 };
const FAKE_PID = 4_000_002;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results = (h: { host: RecordingHost }) => h.host.sent.filter((m) => m.customType === RESULT_MESSAGE_TYPE);

describe("hub hardening", () => {
  const harnesses: Harness[] = [];
  const agents: SimAgent[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) a.close();
    for (const h of harnesses.splice(0)) await h.cleanup();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const track = (h: Harness) => (harnesses.push(h), h);
  const agent = (file: ConstructorParameters<typeof SimAgent>[0], options?: ConstructorParameters<typeof SimAgent>[1]) => {
    const a = new SimAgent(file, options);
    agents.push(a);
    return a.connect();
  };
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), "pi-dogs-test-"));
    dirs.push(d);
    return d;
  };

  // ---- finding 1: nothing may throw out of a pipe handler ----

  it("refuses an oversized task before creating anything", async () => {
    const h = track(await createHarness());
    await assert.rejects(h.spawn({ task: "x".repeat(600 * 1024) }), /task is too long/);
    assert.equal(h.hub.registry.all().length, 0);
    assert.equal(h.backend.opened.length, 0);
  });

  it("refuses an oversized steer message with a clear error", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    const r = h.hub.steer(dog, "y".repeat(600 * 1024));
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /too long/);
  });

  it("drops a connection with a malformed nested event and keeps working", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { backoffMs: [20] });
    await a.next("task");
    // Valid envelope and kind, but no text: must be a protocol error, not a crash in applyEvent.
    a.send({ type: "event", event: { kind: "text_delta" } } as never);
    await waitFor(() => !dog.connected, 2000, "dropped");
    await waitFor(() => dog.connected, 2000, "reconnected");
    a.send({ type: "event", event: { kind: "text_delta", text: "still fine" } });
    await waitFor(() => dog.mirror.some((l) => l.kind === "text" && l.text === "still fine"), 2000, "mirror");
  });

  it("contains an exception thrown while handling a message", async () => {
    class ThrowingHost extends RecordingHost {
      armed = false;
      override changed() {
        super.changed();
        if (this.armed) {
          this.armed = false;
          throw new Error("boom in the UI");
        }
      }
    }
    const host = new ThrowingHost();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const h = track(await createHarness({ host, hub: { isAlive: () => true } }));
      const dog = await h.spawn();
      const a = agent(h.lastLaunchFile(), { backoffMs: [20] });
      await a.next("task");
      host.armed = true;
      a.send({ type: "status", state: "running", usage, model: "test/model" });
      await waitFor(() => host.notes.some((n) => /internal error/.test(n.text)), 2000, "error noted");
      await waitFor(() => dog.connected, 2000, "reconnected");
      assert.deepEqual(uncaught, []);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  // ---- finding 3: a done that crosses a kill ----

  it("a done arriving during a kill does not override it (quit/subagent_kill: no report)", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { obeyShutdown: false });
    await a.next("task");
    const killing = h.hub.kill(dog, "stopped by the main agent", { report: false });
    await a.next("shutdown");
    a.send({ type: "done", id: "d1", summary: "partial", usage, sessionFile: "" });
    await a.next("ack");
    a.send({ type: "bye", reason: "quit" });
    await killing;
    assert.equal(dog.state, "killed");
    assert.equal(dog.outcome!.reason, "stopped by the main agent");
    assert.equal(results(h).length, 0, "the kill said: no report");
  });

  it("a done arriving during /dogs kill is reported with the kill's settings", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { obeyShutdown: false });
    await a.next("task");
    const killing = h.hub.kill(dog, "stopped by the user", { report: true, triggerTurn: false });
    await a.next("shutdown");
    a.send({ type: "done", id: "d1", summary: "partial result", usage, sessionFile: "" });
    a.send({ type: "bye", reason: "quit" });
    await killing;
    assert.equal(dog.state, "killed");
    const [result, ...more] = results(h);
    assert.equal(more.length, 0);
    assert.equal(result!.triggerTurn, false);
    assert.match(result!.content, /partial result/);
  });

  // ---- findings 8, 9 and the reload hand-over ----

  it("after a /reload only the new hub reports, the old one stays silent", async () => {
    const dir = tempDir();
    const pipe = uniquePipe();
    const h1 = await createHarness({ dir, pipe, hub: { isAlive: () => false } });
    const dog = await h1.spawn();
    const a = agent(h1.lastLaunchFile(), { backoffMs: [30] });
    await a.next("task");
    const snapshot = h1.hub.registry.snapshot();
    await h1.hub.stop("reload");
    const h2 = track(await createHarness({ dir, pipe, backend: h1.backend, registry: Registry.restore(snapshot), hub: { isAlive: () => true } }));
    const restored = h2.hub.registry.get(dog.agentId)!;
    await waitFor(() => restored.connected, 3000, "reconnected to the new hub");
    a.send({ type: "done", id: "d1", summary: "the answer", usage, sessionFile: "" });
    await a.next("ack");
    await sleep(400); // longer than the old hub's exit-file grace
    assert.equal(h1.host.sent.length, 0, "old runtime reports nothing");
    assert.equal(results(h2).length, 1);
    assert.equal(dog.state, "running", "the old record is left alone");
  });

  it("an in-flight kill and its report settings survive a /reload; the reconnecting dog gets shutdown again", async () => {
    const dir = tempDir();
    const pipe = uniquePipe();
    const killed: number[] = [];
    const h1 = await createHarness({ dir, pipe, config: { killGraceMs: 5000 } });
    const dog = await h1.spawn();
    const a = agent(h1.lastLaunchFile(), { obeyShutdown: false, backoffMs: [30] });
    await a.next("task");
    const killing = h1.hub.kill(dog, "stopped by the user", { report: true, triggerTurn: false });
    await a.next("shutdown");
    const snapshot = h1.hub.registry.snapshot();
    await h1.hub.stop("reload");
    await killing; // bails out quietly, no stale host calls
    assert.equal(snapshot.records[0]!.closingReport, true);
    assert.equal(snapshot.records[0]!.closingTriggerTurn, false);

    const h2 = track(
      await createHarness({ dir, pipe, backend: h1.backend, registry: Registry.restore(snapshot), hub: { killTree: async (pid) => void killed.push(pid) } }),
    );
    await a.next("shutdown", 3000, 1);
    a.send({ type: "bye", reason: "quit" });
    const restored = h2.hub.registry.get(dog.agentId)!;
    await waitFor(() => restored.state === "killed", 3000, "killed");
    assert.equal(h1.host.sent.length, 0);
    const [result] = results(h2);
    assert.equal(result!.triggerTurn, false, "the kill's triggerTurn=false survived the reload");
    assert.match(result!.content, /stopped by the user/);
  });

  // ---- finding 7: dogs trust only their own hub ----

  it("an agent ignores a hub that does not know its hub secret", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { hubSecret: "not-the-real-one", backoffMs: [50] });
    await waitFor(() => dog.taskSent, 2000, "hub sent the task");
    await sleep(200);
    assert.equal(a.client.ready, false);
    assert.deepEqual(a.received, [], "welcome and task from an unverified peer are dropped");
  });

  it("an agent ignores everything a squatter on the pipe sends", async () => {
    const pipe = uniquePipe();
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      const decoder = new JsonlDecoder();
      socket.on("data", (chunk) => {
        for (const r of decoder.push(chunk)) {
          if (!r.ok) continue;
          seen.push(r.message.type);
          const send = (m: object) => socket.write(encodeMessage({ v: 1, agentId: "rex", ...m } as HubToAgentMessage));
          send({ type: "task", text: "rm -rf everything" });
          send({ type: "reject", reason: "go away" });
          send({ type: "welcome", config: { mode: "autonomous", closeOnDone: true, hubGoneGraceMs: 0, name: "x" }, resumed: false, hubSecret: "guess" });
          send({ type: "shutdown" });
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((r) => server.listen(pipe, r));
    const received: HubToAgentMessage[] = [];
    let gone: string | undefined;
    const client = new AgentClient({
      pipe,
      agentId: "rex",
      token: "t",
      hubSecret: "the-real-secret",
      pid: process.pid,
      piVersion: "test",
      backoffMs: [50],
      hubGoneGraceMs: 0,
      onMessage: (m) => void received.push(m),
      onHubGone: (reason) => {
        gone = reason;
      },
    });
    try {
      client.connect();
      await waitFor(() => seen.length >= 2, 3000, "retried after dropping the squatter");
      assert.deepEqual(received, []);
      assert.equal(gone, undefined, "an unverified reject does not end the dog");
      assert.equal(client.ready, false);
    } finally {
      client.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // ---- finding 6: closing a window by hand is not a crash ----

  it("reports a window closed by the user as killed even with an exit code", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    a.close();
    await waitFor(() => !dog.connected, 2000, "disconnected");
    h.backend.closeWindow(dog.agentId);
    writeFileSync(dog.exitFile, JSON.stringify({ code: 1, signal: null, endedAt: new Date().toISOString() }));
    await waitFor(() => dog.state === "killed", 3000, "killed");
    assert.equal(dog.outcome!.reason, "window closed");
  });

  it("treats exit code 0xC000013A (console closed) as a user close", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    writeFileSync(dog.exitFile, JSON.stringify({ code: WINDOW_CLOSED_EXIT_CODE, signal: null, endedAt: new Date().toISOString() }));
    a.close();
    await waitFor(() => dog.state === "killed", 3000, "killed");
    assert.equal(dog.outcome!.reason, "window closed");
  });

  it("still reports a crash whose exit file was there before the window closed", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    writeFileSync(dog.exitFile, JSON.stringify({ code: 1, signal: null, endedAt: new Date().toISOString() }));
    h.backend.closeWindow(dog.agentId);
    a.close();
    await waitFor(() => dog.state === "failed", 3000, "failed");
    assert.match(dog.outcome!.reason!, /pi crashed \(exit code 1\)/);
  });

  // ---- findings 11, 12, 16, 17 and the session epoch ----

  it("does not leave a 'starting' record behind when starting fails after it was added", async () => {
    const piCommand = Object.defineProperty({ args: [] as string[] }, "command", {
      get() {
        throw new Error("no pi here");
      },
    }) as { command: string; args: string[] };
    const h = track(await createHarness({ hub: { piCommand } }));
    await assert.rejects(h.spawn({ name: "Oops" }), /Could not start Oops: no pi here/);
    const [dog] = h.hub.registry.all();
    assert.equal(dog!.state, "failed");
  });

  it("on quit also shuts down finished dogs that kept their pi open (closeOnDone=false)", async () => {
    const h = await createHarness({ config: { closeOnDone: false } });
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    a.send({ type: "done", id: "d1", summary: "kept open", usage, sessionFile: "" });
    await waitFor(() => dog.state === "done", 2000, "done");
    await h.hub.stop("quit");
    assert.ok(a.received.some((m) => m.type === "shutdown"));
    await h.cleanup();
  });

  it("gives up on a dog whose PID stays 'alive' without reconnecting (PID reuse)", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true, reconnectTimeoutMs: 200 } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    a.close();
    await waitFor(() => dog.state === "failed", 3000, "failed");
    assert.match(dog.outcome!.reason!, /did not reconnect within/);
  });

  it("keeps only the most recent finished dogs", async () => {
    const h = track(await createHarness({ config: { maxAgents: 30 } }));
    for (let i = 0; i < 23; i++) {
      const dog = await h.spawn({ name: `Dog ${i}` });
      await h.hub.kill(dog, "test", { report: false });
    }
    const names = h.hub.registry.all().map((d) => d.name);
    assert.equal(names.length, 20);
    assert.equal(names[0], "Dog 3");
  });

  it("results of dogs from before /new or /resume do not trigger a turn", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    h.hub.sessionEpoch = 1; // the runtime bumps this on /new and /resume
    a.send({ type: "done", id: "d1", summary: "old news", usage, sessionFile: "" });
    await waitFor(() => results(h).length === 1, 2000, "result");
    const [result] = results(h);
    assert.equal(result!.triggerTurn, false);
    assert.match(result!.content, /earlier session/);
    assert.match(result!.content, /old news/);
  });

  it("tells the user when a dog window kept the keyboard focus", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn({ name: "Grabby" });
    h.backend.events.onFocusNotReturned?.({ agentId: dog.agentId });
    assert.ok(h.host.notes.some((n) => n.level === "warning" && /Grabby/.test(n.text) && /keystrokes/.test(n.text)));
  });
});
