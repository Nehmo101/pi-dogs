/**
 * Failure paths over a real named pipe: crashes without `done`, closed
 * windows, reconnect after a hub reload, and shutdown sequencing on quit.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, it } from "node:test";

import { RESULT_MESSAGE_TYPE } from "../../../src/hub/hub.ts";
import { encodeMessage } from "../../../src/protocol/framing.ts";
import { consumeLaunchFile } from "../../../src/protocol/launch.ts";
import { Registry } from "../../../src/hub/registry.ts";
import { createHarness, uniquePipe, type Harness } from "../../helpers/hub-harness.ts";
import { SimAgent, waitFor } from "../../helpers/sim-agent.ts";

const usage = { input: 10, output: 5 };
const FAKE_PID = 4_000_001;

describe("hub robustness", () => {
  const harnesses: Harness[] = [];
  const agents: SimAgent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) a.close();
    for (const h of harnesses.splice(0)) await h.cleanup();
  });
  const track = (h: Harness) => (harnesses.push(h), h);
  const agent = (file: ConstructorParameters<typeof SimAgent>[0], options?: ConstructorParameters<typeof SimAgent>[1]) => {
    const a = new SimAgent(file, options);
    agents.push(a);
    return a.connect();
  };

  it("marks a dog failed when pi crashes without done (exit file with code 1)", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn({ name: "Crashy" });
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    writeFileSync(dog.exitFile, JSON.stringify({ code: 1, signal: null, endedAt: new Date().toISOString() }));
    a.close();
    await waitFor(() => dog.state === "failed", 3000, "failed");
    assert.match(dog.outcome!.reason!, /pi crashed \(exit code 1\)/);
    const result = h.host.sent.find((m) => m.customType === RESULT_MESSAGE_TYPE)!;
    assert.equal(result.triggerTurn, true);
    assert.match(result.content, /Crashy.*failed/);
    assert.match(result.content, /resume with `pi --session <file>`/);
  });

  it("reports a closed window as killed when the process is gone and no exit file appears", async () => {
    const alive = new Set([FAKE_PID]);
    const h = track(await createHarness({ hub: { isAlive: (pid) => alive.has(pid) } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    alive.delete(FAKE_PID);
    a.close();
    await waitFor(() => dog.state === "killed", 3000, "killed");
    assert.match(dog.outcome!.reason!, /window closed/);
    assert.ok(h.host.sent.some((m) => m.customType === RESULT_MESSAGE_TYPE && m.triggerTurn));
  });

  it("fails a dog whose window is closed before it connected", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    h.backend.closeWindow(dog.agentId);
    assert.equal(dog.state, "failed");
    assert.match(dog.outcome!.reason!, /window closed before the agent connected/);
  });

  it("keeps a finished dog open with closeOnDone=false", async () => {
    const h = track(await createHarness({ config: { closeOnDone: false } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    const welcome = await a.next("welcome");
    assert.equal(welcome.config.closeOnDone, false);
    a.send({ type: "done", id: "d1", summary: "kept open", usage, sessionFile: "" });
    await waitFor(() => dog.state === "done");
    assert.equal(h.backend.count("close", dog.agentId), 0);
    assert.equal(h.hub.steer(dog, "more").ok, false);
  });

  it("treats a user quitting the dog without /done as stopped", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    a.send({ type: "bye", reason: "quit" });
    await waitFor(() => dog.state === "killed", 2000, "killed");
    assert.match(dog.outcome!.reason!, /closed by the user/);
  });

  it("keeps a dog whose pipe dropped while its process still lives (it will reconnect)", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true } }));
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID });
    await a.next("task");
    a.close();
    await waitFor(() => !dog.connected, 2000, "disconnect");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(dog.state, "running", "still alive, waiting for reconnect");
  });

  it("survives a hub reload: the dog reconnects, gets no second task, and its result arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dogs-test-"));
    const pipe = uniquePipe();
    try {
      const first = await createHarness({ dir, pipe });
      const dog = await first.spawn({ name: "Loyal" });
      const a = agent(first.lastLaunchFile(), { backoffMs: [30, 60] });
      await a.next("task");
      a.send({ type: "status", state: "running", tool: "read", usage, model: "test/model" });
      await waitFor(() => dog.currentTool === "read");

      // /reload: snapshot, stop without killing, start a new hub runtime on the same pipe.
      const snapshot = first.hub.registry.snapshot();
      await first.hub.stop("reload");
      // A result produced while the hub is away must not get lost.
      a.client.sendReliable({ type: "done", id: "done-r", summary: "survived", usage, sessionFile: dog.sessionFile });

      const second = track(await createHarness({ dir, pipe, registry: Registry.restore(snapshot), backend: first.backend }));
      const restored = second.hub.registry.get(dog.agentId)!;
      const welcome = await a.next("welcome", 3000, 1);
      assert.equal(welcome.resumed, true);
      await a.next("ack", 3000);
      await waitFor(() => restored.state === "closing", 2000, "closing");
      assert.equal(a.received.filter((m) => m.type === "task").length, 1, "task sent once");
      const result = second.host.sent.find((m) => m.customType === RESULT_MESSAGE_TYPE)!;
      assert.match(result.content, /survived/);
      assert.equal(first.host.sent.filter((m) => m.customType === RESULT_MESSAGE_TYPE).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an agent gives up when the hub stays away for the grace period", async () => {
    const h = await createHarness({ config: { hubGoneGraceMs: 150 } });
    await h.spawn();
    const a = agent(h.lastLaunchFile(), { backoffMs: [20] });
    await a.next("welcome");
    await h.hub.stop("reload");
    await waitFor(() => a.hubGone !== undefined, 3000, "hub gone");
    assert.match(a.hubGone!, /unreachable/);
    await h.cleanup();
  });

  it("on quit: sends shutdown, waits for the dogs to leave, and reports nothing", async () => {
    const killed: number[] = [];
    const h = await createHarness({ hub: { killTree: async (pid) => void killed.push(pid) } });
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    const started = Date.now();
    await h.hub.stop("quit");
    assert.ok(Date.now() - started < 1000, "quit is quick when dogs obey");
    assert.ok(a.received.some((m) => m.type === "shutdown"));
    assert.equal(dog.state, "killed");
    assert.deepEqual(killed, [], "no taskkill needed");
    assert.equal(h.host.sent.length, 0);
    await h.cleanup();
  });

  it("on quit: kills the pi process of a dog that ignores shutdown", async () => {
    const killed: number[] = [];
    const alive = new Set([FAKE_PID]);
    const h = await createHarness({
      config: { quitGraceMs: 100 },
      hub: {
        isAlive: (pid) => alive.has(pid),
        killTree: async (pid) => {
          killed.push(pid);
          alive.delete(pid);
        },
      },
    });
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile(), { pid: FAKE_PID, obeyShutdown: false });
    await a.next("task");
    await h.hub.stop("quit");
    assert.deepEqual(killed, [FAKE_PID]);
    assert.equal(dog.state, "killed");
    await h.cleanup();
  });

  it("subagent_kill path: shutdown first, no report when asked not to", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    await h.hub.kill(dog, "stopped by the main agent", { report: false });
    assert.equal(dog.state, "killed");
    assert.equal(dog.outcome!.reason, "stopped by the main agent");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.backend.count("close", dog.agentId), 1);
  });

  it("/dogs kill path: reports without triggering a turn", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    await h.hub.kill(dog, "stopped by the user", { report: true, triggerTurn: false });
    const result = h.host.sent.find((m) => m.customType === RESULT_MESSAGE_TYPE)!;
    assert.equal(result.triggerTurn, false);
    assert.match(result.content, /was stopped \(stopped by the user\)/);
  });

  it("drops a connection that stops answering pings", async () => {
    const h = track(await createHarness({ hub: { isAlive: () => true, pingIntervalMs: 30, idleTimeoutMs: 150 } }));
    const dog = await h.spawn();
    const launch = consumeLaunchFile(h.lastLaunchFile());
    // A raw client that says hello and then goes silent (never answers ping).
    const socket = net.connect(launch.pipe, () => {
      socket.write(encodeMessage({ v: 1, type: "hello", agentId: launch.agentId, token: launch.token, pid: FAKE_PID, piVersion: "x", protocol: 1 }));
    });
    socket.on("error", () => undefined);
    await waitFor(() => dog.connected, 1000, "connected");
    await waitFor(() => !dog.connected, 2000, "dropped after ping timeout");
    socket.destroy();
  });
});
