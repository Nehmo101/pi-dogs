import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../../src/hub/config.ts";

describe("mergeConfig", () => {
  it("returns a copy of the defaults for no input", () => {
    const { config, warnings } = mergeConfig(undefined);
    assert.deepEqual(config, { ...DEFAULT_CONFIG, models: { roles: {} }, dogNames: [], layout: {} });
    assert.deepEqual(warnings, []);
    mergeConfig(undefined).config.models.roles["x"] = "y";
    assert.deepEqual(DEFAULT_CONFIG.models.roles, {}, "defaults are not mutated");
  });

  it("merges valid values and reports invalid or unknown ones", () => {
    const { config, warnings } = mergeConfig({
      maxAgents: 3,
      closeOnDone: false,
      defaultMode: "interactive",
      eventDetail: "loud",
      helloTimeoutMs: -1,
      mysterious: true,
      models: { default: "ollama/qwen3.5:4b", roles: { Review: "*sonnet*", bad: 5 }, extra: 1 },
      dogNames: ["Rex"],
      layout: { arrangement: "stacked" },
      $schema: "ignored",
    });
    assert.equal(config.maxAgents, 3);
    assert.equal(config.closeOnDone, false);
    assert.equal(config.defaultMode, "interactive");
    assert.equal(config.eventDetail, "full");
    assert.equal(config.helloTimeoutMs, DEFAULT_CONFIG.helloTimeoutMs);
    assert.deepEqual(config.models, { default: "ollama/qwen3.5:4b", roles: { review: "*sonnet*" } });
    assert.deepEqual(config.dogNames, ["Rex"]);
    assert.deepEqual(config.layout, { arrangement: "stacked" });
    assert.equal(warnings.length, 5, warnings.join("\n"));
    assert.ok(warnings.some((w) => w.includes('"eventDetail"')));
    assert.ok(warnings.some((w) => w.includes('unknown setting "mysterious"')));
    assert.ok(warnings.some((w) => w.includes("models.roles.bad")));
    assert.ok(warnings.some((w) => w.includes("models.extra")));
  });

  it("rejects non-object settings", () => {
    const { config, warnings } = mergeConfig([1, 2]);
    assert.equal(config.maxAgents, DEFAULT_CONFIG.maxAgents);
    assert.equal(warnings.length, 1);
  });
});

describe("loadConfig", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dogs-config-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("uses defaults when the file is missing", () =>
    withDir((dir) => {
      const loaded = loadConfig(dir);
      assert.equal(loaded.path, join(dir, "pi-dogs.json"));
      assert.equal(loaded.config.maxAgents, 6);
      assert.deepEqual(loaded.warnings, []);
    }));

  it("reads a file with a UTF-8 BOM", () =>
    withDir((dir) => {
      writeFileSync(join(dir, "pi-dogs.json"), "\uFEFF" + JSON.stringify({ maxAgents: 2 }));
      assert.equal(loadConfig(dir).config.maxAgents, 2);
    }));

  it("survives broken JSON with a warning", () =>
    withDir((dir) => {
      writeFileSync(join(dir, "pi-dogs.json"), "{ nope");
      const loaded = loadConfig(dir);
      assert.equal(loaded.config.maxAgents, 6);
      assert.match(loaded.warnings[0]!, /could not read/);
    }));
});
