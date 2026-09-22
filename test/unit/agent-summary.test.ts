import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideAutoDone, lastAssistantText, lastStop, type MessageLike } from "../../src/agent/summary.ts";

const assistant = (text: string, stopReason = "stop", errorMessage?: string): MessageLike => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: "hm" }, { type: "text", text }],
  stopReason,
  ...(errorMessage ? { errorMessage } : {}),
});

const base = { mode: "autonomous" as const, takenOver: false, alreadyDone: false, ranTask: true };

describe("summary helpers", () => {
  it("finds the last assistant text, skipping empty messages", () => {
    const messages = [{ role: "user", content: "task" }, assistant("First"), { role: "toolResult", content: [] }, assistant("  ")];
    assert.equal(lastAssistantText(messages), "First");
    assert.equal(lastAssistantText([{ role: "assistant", content: "plain" }]), "plain");
    assert.equal(lastAssistantText([]), "");
    assert.deepEqual(lastStop([assistant("x", "error", "overloaded")]), { stopReason: "error", errorMessage: "overloaded" });
  });
});

describe("decideAutoDone", () => {
  it("finishes an autonomous run with the last assistant text", () => {
    assert.deepEqual(decideAutoDone({ ...base, messages: [assistant("Result: 42")] }), { action: "done", summary: "Result: 42" });
  });

  it("reports a model error as an error result", () => {
    const d = decideAutoDone({ ...base, messages: [assistant("", "error", "rate limited")] });
    assert.deepEqual(d, { action: "done", summary: "", error: "rate limited" });
  });

  it("stays open when interactive, taken over, aborted, already done or before the task ran", () => {
    const messages = [assistant("x")];
    assert.equal(decideAutoDone({ ...base, mode: "interactive", messages }).action, "none");
    assert.equal(decideAutoDone({ ...base, takenOver: true, messages }).action, "none");
    assert.equal(decideAutoDone({ ...base, alreadyDone: true, messages }).action, "none");
    assert.equal(decideAutoDone({ ...base, ranTask: false, messages }).action, "none");
    assert.equal(decideAutoDone({ ...base, messages: [assistant("half", "aborted")] }).action, "none");
  });
});
