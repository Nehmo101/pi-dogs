/**
 * Hub + simulated agent over a real named pipe: the normal lifecycle,
 * authentication, steering, takeover and results.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { RESULT_MESSAGE_TYPE, INFO_MESSAGE_TYPE } from "../../../src/hub/hub.ts";
import { createHarness, type Harness } from "../../helpers/hub-harness.ts";
import { SimAgent, waitFor } from "../../helpers/sim-agent.ts";

const usage = { input: 1200, output: 300, cost: 0.002 };

describe("hub lifecycle", () => {
  let h: Harness | undefined;
  const agents: SimAgent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) a.close();
    await h?.cleanup();
    h = undefined;
  });
  const agent = (file: ConstructorParameters<typeof SimAgent>[0], options?: ConstructorParameters<typeof SimAgent>[1]) => {
    const a = new SimAgent(file, options);
    agents.push(a);
    return a.connect();
  };

  it("spawns, delivers the task, reports the result and closes", async () => {
    h = await createHarness();
    const dog = await h.spawn({ name: "Bello Baggins" });
    assert.equal(dog.state, "starting");
    assert.equal(h.backend.opened[0]!.name, "Bello Baggins");
    assert.equal(h.backend.opened[0]!.modelLabel, "model");
    assert.equal(h.backend.opened[0]!.args[0], join(h.dir, "launcher.mjs"));

    // The seeded session holds the context as a custom_message.
    const lines = readFileSync(dog.sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].type, "session");
    assert.equal(lines[1].customType, "pi-dogs-context");
    assert.match(lines[1].content, /Test context/);

    const launchFile = h.lastLaunchFile();
    const a = agent(launchFile);
    assert.equal(existsSync(launchFile), false, "launch file is deleted after reading");
    assert.ok(a.launch.pi.args.includes("--session"));
    assert.ok(a.launch.pi.args.includes("--model"));

    const welcome = await a.next("welcome");
    assert.equal(welcome.resumed, false);
    assert.equal(welcome.config.mode, "autonomous");
    assert.equal((await a.next("task")).text, "Find the answer");
    await waitFor(() => dog.state === "running", 2000, "running");

    a.send({ type: "status", state: "running", tool: "bash", usage, model: "test/model" });
    a.send({ type: "event", event: { kind: "tool_start", toolCallId: "c1", tool: "bash", args: "ls" } });
    a.send({ type: "event", event: { kind: "text_delta", text: "Hello\nwor" } });
    a.send({ type: "event", event: { kind: "text_delta", text: "ld" } });
    await waitFor(() => dog.mirror.length >= 3, 2000, "mirror");
    assert.equal(dog.currentTool, "bash");
    assert.deepEqual(
      dog.mirror.map((l) => (l.kind === "text" ? l.text : l.kind)),
      ["tool", "Hello", "world"],
    );

    a.client.sendReliable({ type: "done", id: "done-1", summary: "The answer is 42.", usage, sessionFile: dog.sessionFile });
    const ack = await a.next("ack");
    assert.equal(ack.ref, "done-1");
    assert.equal(a.client.pending("done-1"), false);
    await waitFor(() => dog.state === "closing", 2000, "closing");

    const result = h.host.sent.find((m) => m.customType === RESULT_MESSAGE_TYPE);
    assert.ok(result, "result delivered to the main agent");
    assert.equal(result.triggerTurn, true);
    assert.match(result.content, /Bello Baggins/);
    assert.match(result.content, /The answer is 42\./);
    assert.match(result.content, /1\.2k in \/ 300 out/);
    assert.match(result.content, new RegExp(dog.sessionFile.replace(/[\\.]/g, "\\$&")));

    // pi quits after the ack: bye, then the pipe closes.
    a.send({ type: "bye", reason: "quit" });
    await waitFor(() => dog.state === "done", 2000, "done");
    assert.equal(dog.outcome?.summary, "The answer is 42.");
    assert.equal(h.host.sent.filter((m) => m.customType === RESULT_MESSAGE_TYPE).length, 1, "reported exactly once");
    await waitFor(() => h!.backend.count("close", dog.agentId) === 1, 1000, "window closed");
  });

  it("rejects a hello with a wrong token", async () => {
    h = await createHarness();
    await h.spawn();
    const a = agent(h.lastLaunchFile(), { token: "wrong", backoffMs: [20] });
    await new Promise((r) => setTimeout(r, 300));
    // The reject carries no hub secret (the hub cannot know whom it talks to), so the
    // dog cannot tell it from an impostor's and keeps retrying until its grace period.
    assert.equal(a.hubGone, undefined);
    assert.equal(a.client.ready, false);
    assert.equal(h.hub.registry.all()[0]!.state, "starting");
  });

  it("honours an authenticated reject (the dog is already finished)", async () => {
    h = await createHarness();
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    a.close();
    await waitFor(() => !dog.connected, 2000, "disconnect");
    h.hub.windowClosed(dog.agentId);
    await waitFor(() => dog.state === "killed", 3000, "killed");
    const again = agent(a.launch, { backoffMs: [20] });
    await waitFor(() => again.hubGone !== undefined, 2000, "reject");
    assert.match(again.hubGone!, /already killed/);
  });

  it("steers a running dog and refuses to steer a closing one", async () => {
    h = await createHarness();
    const dog = await h.spawn();
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    assert.deepEqual(h.hub.steer(dog, "Use English", "followUp"), { ok: true });
    const steer = await a.next("steer");
    assert.equal(steer.text, "Use English");
    assert.equal(steer.mode, "followUp");

    a.send({ type: "done", id: "d", summary: "ok", usage, sessionFile: "" });
    await waitFor(() => dog.state === "closing");
    const refused = h.hub.steer(dog, "more work");
    assert.equal(refused.ok, false);
  });

  it("tells the main agent about a takeover without triggering a turn", async () => {
    h = await createHarness();
    const dog = await h.spawn({ name: "Rex" });
    const a = agent(h.lastLaunchFile());
    await a.next("task");
    a.send({ type: "takeover" });
    a.send({ type: "takeover" });
    await waitFor(() => dog.takenOver);
    await waitFor(() => h!.host.sent.length > 0);
    const infos = h.host.sent.filter((m) => m.customType === INFO_MESSAGE_TYPE);
    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.triggerTurn, false);
    assert.match(infos[0]!.content, /took over subagent "Rex"/);
  });

  it("gives every dog a unique name and respects maxAgents", async () => {
    h = await createHarness({ config: { maxAgents: 2 } });
    const a = await h.spawn({ name: "Rex" });
    const b = await h.spawn({ name: "rex" });
    assert.equal(a.name, "Rex");
    assert.equal(b.name, "rex 2");
    assert.notEqual(a.agentId, b.agentId);
    await assert.rejects(h.spawn(), /maxAgents 2/);
  });

  it("fails a dog that never connects, and keeps its window open", async () => {
    h = await createHarness({ config: { helloTimeoutMs: 100 } });
    const dog = await h.spawn();
    await waitFor(() => dog.state === "failed", 2000, "failed");
    assert.match(dog.outcome!.reason!, /did not connect/);
    assert.equal(h.backend.count("close", dog.agentId), 0);
    const result = h.host.sent.find((m) => m.customType === RESULT_MESSAGE_TYPE);
    assert.match(result!.content, /failed: did not connect/);
  });

  it("reports an unavailable backend before creating anything", async () => {
    h = await createHarness();
    h.backend.availability = { ok: false, hint: "Start pi inside Windows Terminal." };
    await assert.rejects(h.spawn(), /Windows Terminal/);
    assert.equal(h.hub.registry.all().length, 0);
  });

  it("marks a dog failed when its window cannot be opened", async () => {
    h = await createHarness();
    h.backend.failOpen = new Error("wt.exe not found");
    await assert.rejects(h.spawn({ name: "Rex" }), /wt\.exe not found/);
    assert.equal(h.hub.registry.find("Rex")!.state, "failed");
  });

  it("syncs minimize state from the backend and the hub API", async () => {
    h = await createHarness();
    const dog = await h.spawn();
    await h.hub.minimize(dog);
    assert.equal(dog.minimized, true);
    assert.equal(h.backend.count("minimize", dog.agentId), 1);
    h.backend.events.onMinimizedChange?.({ agentId: dog.agentId }, false, "user");
    assert.equal(dog.minimized, false);
    await h.hub.focus(dog);
    assert.equal(h.backend.count("focus", dog.agentId), 1);
  });
});
