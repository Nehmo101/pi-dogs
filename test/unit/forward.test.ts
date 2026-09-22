import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import type { AgentOutgoing } from "../../src/agent/client.ts";
import { EventForwarder, summarizeArgs } from "../../src/agent/forward.ts";

const usage = { input: 1, output: 2 };

function setup(options: Partial<ConstructorParameters<typeof EventForwarder>[0]> = {}) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const sent: AgentOutgoing[] = [];
  const fwd = new EventForwarder({ send: (m) => sent.push(m), now: () => Date.now(), ...options });
  return { sent, fwd, done: () => mock.timers.reset() };
}

describe("EventForwarder", () => {
  it("batches text deltas for ~100 ms", () => {
    const { sent, fwd, done } = setup();
    fwd.text("Hel");
    fwd.text("lo");
    assert.equal(sent.length, 0);
    mock.timers.tick(100);
    assert.deepEqual(sent, [{ type: "event", event: { kind: "text_delta", text: "Hello" } }]);
    done();
  });

  it("flushes pending text before other events, keeping order", () => {
    const { sent, fwd, done } = setup();
    fwd.text("thinking about it");
    fwd.toolStart("c1", "bash", { command: "ls   -la\n/tmp" });
    fwd.toolEnd("c1", "bash", false);
    assert.deepEqual(
      sent.map((m) => (m.type === "event" ? m.event.kind : m.type)),
      ["text_delta", "tool_start", "tool_end"],
    );
    const start = sent[1]!;
    assert.ok(start.type === "event" && start.event.kind === "tool_start" && start.event.args === "ls -la /tmp");
    done();
  });

  it("flushes large text immediately", () => {
    const { sent, fwd, done } = setup({ textMaxChars: 10 });
    fwd.text("0123456789ab");
    assert.equal(sent.length, 1);
    done();
  });

  it("throttles status to one per interval, latest wins", () => {
    const { sent, fwd, done } = setup();
    fwd.status({ state: "running", usage, model: "m" });
    fwd.status({ state: "running", tool: "read", usage, model: "m" });
    fwd.status({ state: "running", tool: "bash", usage, model: "m" });
    assert.equal(sent.length, 1, "leading edge");
    mock.timers.tick(250);
    assert.equal(sent.length, 2);
    const last = sent[1]!;
    assert.ok(last.type === "status" && last.tool === "bash");
    mock.timers.tick(1000);
    assert.equal(sent.length, 2, "nothing pending");
    done();
  });

  it("drops text in minimal mode but still forwards tools", () => {
    const { sent, fwd, done } = setup({ forwardText: false });
    fwd.text("secret");
    fwd.toolStart("c", "read", { path: "a.ts" });
    mock.timers.tick(500);
    assert.deepEqual(sent.map((m) => (m.type === "event" ? m.event.kind : m.type)), ["tool_start"]);
    done();
  });

  it("sends everything on dispose and nothing after", () => {
    const { sent, fwd, done } = setup();
    fwd.text("tail");
    fwd.status({ state: "idle", usage, model: "m" });
    fwd.status({ state: "closing", usage, model: "m" });
    fwd.dispose();
    const kinds = sent.map((m) => (m.type === "status" ? m.state : m.type === "event" ? m.event.kind : m.type));
    assert.deepEqual(kinds, ["text_delta", "idle", "closing"]);
    fwd.text("late");
    mock.timers.tick(500);
    assert.equal(sent.length, 3);
    done();
  });
});

describe("summarizeArgs", () => {
  it("prefers the most descriptive argument and truncates", () => {
    assert.equal(summarizeArgs({ path: "src/a.ts", limit: 20 }), "src/a.ts");
    assert.equal(summarizeArgs({ command: "npm test" }), "npm test");
    assert.equal(summarizeArgs({ x: 1 }), '{"x":1}');
    assert.equal(summarizeArgs("a".repeat(300), 10), "aaaaaaaaa…");
    assert.equal(summarizeArgs(undefined), undefined);
    assert.equal(summarizeArgs({ command: "   " }), undefined);
  });
});
