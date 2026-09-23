/**
 * The agent extension (src/agent/index.ts) against a real hub over a real
 * pipe, with a fake pi ExtensionAPI. The pi package itself is not loaded:
 * a resolve hook maps it (and typebox) to small stubs, so the test is fast
 * and does not need pi installed.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { RESULT_MESSAGE_TYPE } from "../../../src/hub/hub.ts";
import { Registry } from "../../../src/hub/registry.ts";
import { createHarness, uniquePipe, type Harness } from "../../helpers/hub-harness.ts";
import { waitFor } from "../../helpers/sim-agent.ts";

const STUBS: Record<string, string> = {
  "@earendil-works/pi-coding-agent": "export const VERSION = '0.0.0-stub';",
  typebox: "const t = () => ({}); export const Type = { Object: t, String: t, Optional: t, Boolean: t, Array: t };",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { default: agentExtension } = (await import("../../../src/agent/index.ts")) as { default: (pi: unknown) => void };

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Just enough of ExtensionAPI for the agent extension. */
class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  readonly sent: { text: string; options: unknown }[] = [];
  readonly launchPath: string | undefined;
  constructor(launchPath: string | undefined) {
    this.launchPath = launchPath;
    agentExtension(this);
  }
  registerFlag() {}
  getFlag(name: string) {
    return name === "pi-dogs-launch" ? this.launchPath : undefined;
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
    this.tools.set(tool.name, tool);
  }
  registerCommand() {}
  sendUserMessage(text: string, options: unknown) {
    this.sent.push({ text, options });
  }
  async emit(event: string, payload: unknown, ctx: unknown) {
    for (const h of this.handlers.get(event) ?? []) await h(payload, ctx);
  }
}

/** A pi ExtensionContext stand-in; once `stale`, every access throws like a replaced session's ctx. */
function fakeCtx() {
  const state = { stale: false, shutdowns: 0, notes: [] as string[] };
  const target = {
    hasUI: true,
    ui: { notify: (text: string) => void state.notes.push(text), setStatus: () => undefined },
    shutdown: () => void state.shutdowns++,
    abort: () => undefined,
    isIdle: () => true,
    model: { provider: "test", id: "model" },
    sessionManager: { getSessionFile: () => "C:\\sessions\\dog.jsonl", getBranch: () => [] },
  };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (state.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      return t[key as keyof typeof t];
    },
  });
  return { ctx, state };
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

describe("agent extension", () => {
  const harnesses: Harness[] = [];
  const pis: { pi: FakePi; ctx: unknown }[] = [];
  afterEach(async () => {
    // Quit every dog pi of the test (closes its client), newest first.
    for (const { pi, ctx } of pis.splice(0).reverse()) await pi.emit("session_shutdown", { reason: "quit" }, ctx).catch(() => undefined);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-dogs.agent-carry.v1")];
    for (const h of harnesses.splice(0)) await h.cleanup();
  });
  const track = (h: Harness) => (harnesses.push(h), h);
  const startDog = async (launchPath: string | undefined) => {
    const pi = new FakePi(launchPath);
    const c = fakeCtx();
    await pi.emit("session_start", { reason: "startup" }, c.ctx);
    pis.push({ pi, ctx: c.ctx });
    return { pi, ...c };
  };

  it("survives /reload inside the dog: no bye, same connection, steers reach the new runtime", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const launch = h.lastLaunchFile();
    const first = await startDog(launch);
    await waitFor(() => first.pi.sent.some((m) => m.text === "Find the answer"), 3000, "task");
    await waitFor(() => dog.state === "running", 2000, "running");

    await first.pi.emit("session_shutdown", { reason: "reload" }, first.ctx);
    first.state.stale = true;
    pis.splice(0); // the first runtime is gone; only the second may quit
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(dog.state, "running", "a reload is not a quit");
    assert.equal(dog.connected, true, "the pipe stays up across the reload");
    assert.equal(h.hub.steer(dog, "while reloading").ok, true);

    const second = await startDog(launch); // the launch file is gone by now
    assert.equal(second.state.shutdowns, 0, "carried state, not a missing launch file");
    await waitFor(() => second.pi.sent.some((m) => m.text === "while reloading"), 2000, "queued steer replayed");
    assert.equal(h.hub.steer(dog, "after reload").ok, true);
    await waitFor(() => second.pi.sent.some((m) => m.text === "after reload"), 2000, "steer");
    assert.equal(first.pi.sent.filter((m) => m.text !== "Find the answer").length, 0);
  });

  it("gives up on a gone hub through the current ctx, not a stale one", async () => {
    const h = await createHarness({ config: { hubGoneGraceMs: 150 } });
    await h.spawn();
    const launch = h.lastLaunchFile();
    const first = await startDog(launch);
    await waitFor(() => first.pi.sent.length > 0, 3000, "task");
    await first.pi.emit("session_shutdown", { reason: "new" }, first.ctx);
    first.state.stale = true;
    pis.splice(0);
    const second = await startDog(launch);
    await h.cleanup(); // the main pi goes away
    await waitFor(() => second.state.shutdowns > 0, 5000, "dog closes");
    assert.ok(second.state.notes.some((n) => /unreachable/.test(n)));
  });

  it("quits cleanly when its launch file is missing", async () => {
    const h = track(await createHarness());
    const dog = await startDog(join(h.dir, "no-such-launch.json"));
    assert.equal(dog.state.shutdowns, 1);
    assert.ok(dog.state.notes.some((n) => /launch file/.test(n)));
  });

  it("sends no automatic result for a run cut short by the hub's shutdown", async () => {
    const h = track(await createHarness({ config: { killGraceMs: 2000 } }));
    const dog = await h.spawn();
    const d = await startDog(h.lastLaunchFile());
    await waitFor(() => d.pi.sent.length > 0, 3000, "task");
    const killing = h.hub.kill(dog, "stopped by the user", { report: true, triggerTurn: false });
    await waitFor(() => d.state.shutdowns > 0, 2000, "shutdown requested");
    await d.pi.emit("agent_start", {}, d.ctx);
    await d.pi.emit("agent_end", { messages: [assistant("half-done work")] }, d.ctx);
    await d.pi.emit("agent_settled", {}, d.ctx);
    await d.pi.emit("session_shutdown", { reason: "quit" }, d.ctx);
    pis.splice(0);
    await killing;
    assert.equal(dog.state, "killed");
    assert.equal(dog.summary, undefined, "no done was sent");
    const [result] = h.host.sent.filter((m) => m.customType === RESULT_MESSAGE_TYPE);
    assert.equal(result!.triggerTurn, false);
  });

  it("repeats a takeover that happened while the pipe was down", async () => {
    const pipe = uniquePipe();
    const h1 = await createHarness({ pipe });
    const dog = await h1.spawn();
    const d = await startDog(h1.lastLaunchFile());
    await waitFor(() => d.pi.sent.length > 0, 3000, "task");
    const snapshot = h1.hub.registry.snapshot();
    await h1.hub.stop("reload");
    await d.pi.emit("input", { source: "interactive", text: "let me drive" }, d.ctx);
    const h2 = track(await createHarness({ pipe, dir: h1.dir, backend: h1.backend, registry: Registry.restore(snapshot) }));
    const restored = h2.hub.registry.get(dog.agentId)!;
    await waitFor(() => restored.takenOver, 5000, "takeover reached the new hub");
  });

  it("truncates an oversized summary instead of failing to send it", async () => {
    const h = track(await createHarness());
    const dog = await h.spawn();
    const d = await startDog(h.lastLaunchFile());
    await waitFor(() => d.pi.sent.length > 0, 3000, "task");
    await d.pi.tools.get("subagent_done")!.execute("call-1", { summary: "z".repeat(2_000_000) });
    await waitFor(() => dog.summary !== undefined, 3000, "done arrived");
    assert.ok(dog.summary!.length < 600 * 1024);
    assert.match(dog.summary!, /truncated by pi-dogs\)$/);
  });
});
