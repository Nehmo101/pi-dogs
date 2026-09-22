import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chooseModelPattern, formatModelList, modelLabel, resolveModelPattern, suggestModels, type ModelInfo } from "../../src/hub/models.ts";

const MODELS: ModelInfo[] = [
  { provider: "ollama", id: "qwen3.5:4b", name: "Qwen 3.5 4B" },
  { provider: "ollama", id: "qwen3.6:27b" },
  { provider: "llamacpp", id: "qwen3.5-4b" },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "anthropic", id: "claude-sonnet-5-20260101" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "openrouter", id: "qwen/qwen3-coder:exacto" },
];

const ok = (pattern: string) => {
  const r = resolveModelPattern(pattern, MODELS);
  assert.ok(r.ok, `${pattern}: ${r.ok ? "" : r.error}`);
  return r;
};

describe("resolveModelPattern", () => {
  it("matches provider/id and bare ids exactly, including ids with colons", () => {
    assert.equal(ok("ollama/qwen3.5:4b").ref, "ollama/qwen3.5:4b");
    assert.equal(ok("OLLAMA/QWEN3.5:4B").ref, "ollama/qwen3.5:4b");
    assert.equal(ok("qwen3.6:27b").ref, "ollama/qwen3.6:27b");
    assert.equal(ok("openrouter/qwen/qwen3-coder:exacto").ref, "openrouter/qwen/qwen3-coder:exacto");
    assert.equal(ok("ollama/qwen3.5:4b").thinking, undefined);
  });

  it("splits a thinking-level suffix only when the full pattern does not match", () => {
    const r = ok("ollama/qwen3.5:4b:high");
    assert.equal(r.ref, "ollama/qwen3.5:4b");
    assert.equal(r.thinking, "high");
    assert.equal(ok("*sonnet*:low").thinking, "low");
    assert.equal(resolveModelPattern("ollama/qwen3.5:4b:loud", MODELS).ok, false);
  });

  it("supports globs and prefers aliases over dated snapshots", () => {
    assert.equal(ok("*sonnet*").ref, "anthropic/claude-sonnet-5");
    assert.equal(ok("anthropic/*haiku*").ref, "anthropic/claude-haiku-4-5");
    assert.equal(ok("claude-sonnet-5-2026*").ref, "anthropic/claude-sonnet-5-20260101");
  });

  it("falls back to fuzzy substring matching, optionally scoped to a provider", () => {
    assert.equal(ok("haiku").ref, "anthropic/claude-haiku-4-5");
    assert.equal(ok("llamacpp/qwen").ref, "llamacpp/qwen3.5-4b");
    assert.equal(ok("Sonnet 5").ref, "anthropic/claude-sonnet-5");
  });

  it("returns a clear error with suggestions for unknown models", () => {
    const r = resolveModelPattern("qwen3.5:8b", MODELS);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /Unknown or unavailable model "qwen3\.5:8b"/);
    assert.ok(r.suggestions.includes("ollama/qwen3.5:4b"), r.suggestions.join());
    const none = resolveModelPattern("x", []);
    assert.ok(!none.ok && /No usable models/.test(none.error));
    assert.equal(resolveModelPattern("  ", MODELS).ok, false);
  });

  it("suggests similar models first", () => {
    assert.deepEqual(suggestModels("claude-sonet", MODELS, 2), ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"]);
  });
});

describe("chooseModelPattern", () => {
  const defaults = {
    sessionDefault: "session/model",
    sessionRoles: { review: "session/reviewer" },
    configDefault: "config/model",
    configRoles: { review: "config/reviewer", scout: "config/scout" },
    mainModel: "main/model",
  };

  it("follows the order call → role → session default → config default → main model", () => {
    assert.deepEqual(chooseModelPattern({ model: "x/y", role: "review" }, defaults), { pattern: "x/y", source: "call" });
    assert.deepEqual(chooseModelPattern({ role: "Review" }, defaults), { pattern: "session/reviewer", source: "role" });
    assert.deepEqual(chooseModelPattern({ role: "scout" }, defaults), { pattern: "config/scout", source: "role" });
    assert.deepEqual(chooseModelPattern({ role: "unknown" }, defaults), { pattern: "session/model", source: "session" });
    assert.deepEqual(chooseModelPattern({}, { ...defaults, sessionDefault: undefined }), { pattern: "config/model", source: "config" });
    assert.deepEqual(chooseModelPattern({}, { mainModel: "main/model" }), { pattern: "main/model", source: "main" });
    assert.equal(chooseModelPattern({ model: "  " }, {}), undefined);
  });
});

describe("formatting", () => {
  it("lists models compactly and truncates with a count", () => {
    assert.equal(formatModelList(MODELS.slice(0, 2)), "ollama/qwen3.5:4b, ollama/qwen3.6:27b");
    const long = formatModelList(MODELS, 40);
    assert.match(long, /\(\+\d+ more\)$/);
  });

  it("labels models without provider", () => {
    assert.equal(modelLabel("ollama/qwen3.5:4b"), "qwen3.5:4b");
    assert.equal(modelLabel("openrouter/qwen/qwen3-coder"), "qwen/qwen3-coder");
    assert.equal(modelLabel("default"), "default");
  });
});
