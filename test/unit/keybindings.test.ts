import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  isOverlayKeyReserved,
  keybindingsPath,
  parseKeybindings,
  planKeybindingsMerge,
  readKeybindings,
  writeKeybindings,
} from "../../src/hub/keybindings.ts";

describe("planKeybindingsMerge", () => {
  it("adds both remaps to an empty file", () => {
    const plan = planKeybindingsMerge({});
    assert.deepEqual(plan.result, { "app.model.select": "ctrl+alt+l", "app.tree.filter.labeledOnly": "ctrl+alt+l" });
    assert.equal(plan.changes.length, 2);
    assert.deepEqual(plan.conflicts, []);
  });

  it("keeps every other entry and actions the user already moved", () => {
    const existing = { "app.session.new": "ctrl+shift+n", "app.model.select": "f2", "tui.editor.undo": ["ctrl+z", "ctrl+-"] };
    const plan = planKeybindingsMerge(existing);
    assert.equal(plan.result["app.model.select"], "f2");
    assert.equal(plan.result["app.session.new"], "ctrl+shift+n");
    assert.deepEqual(plan.result["tui.editor.undo"], ["ctrl+z", "ctrl+-"]);
    assert.equal(plan.result["app.tree.filter.labeledOnly"], "ctrl+alt+l");
    assert.equal(plan.changes.length, 1);
  });

  it("replaces only ctrl+l inside a list, in any modifier spelling", () => {
    const plan = planKeybindingsMerge({ "app.model.select": ["F2", "Ctrl+L"], "app.tree.filter.labeledOnly": "l+ctrl" });
    assert.deepEqual(plan.result["app.model.select"], ["F2", "ctrl+alt+l"]);
    assert.equal(plan.result["app.tree.filter.labeledOnly"], "ctrl+alt+l");
  });

  it("reports nothing to do once applied, and lists conflicts", () => {
    const once = planKeybindingsMerge({ "my.action": "alt+ctrl+l" });
    assert.deepEqual(once.conflicts, ["my.action"]);
    assert.deepEqual(planKeybindingsMerge(once.result).changes, []);
  });
});

describe("keybindings file", () => {
  it("knows when Ctrl+L is still reserved", () => {
    assert.equal(isOverlayKeyReserved({}), true);
    assert.equal(isOverlayKeyReserved({ "app.model.select": ["ctrl+l", "f2"] }), true);
    assert.equal(isOverlayKeyReserved({ "app.model.select": "ctrl+alt+l" }), false);
  });

  it("parses strictly (never overwrite a file we cannot understand)", () => {
    assert.deepEqual(parseKeybindings('\uFEFF{"a":"ctrl+x","b":["x","y"]}'), { a: "ctrl+x", b: ["x", "y"] });
    assert.throws(() => parseKeybindings("[]"), /JSON object/);
    assert.throws(() => parseKeybindings('{"a": 1}'), /"a"/);
    assert.throws(() => parseKeybindings("{"));
  });

  it("merges into an existing file atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dogs-keys-"));
    try {
      const file = keybindingsPath(dir);
      assert.deepEqual(readKeybindings(file), {});
      writeFileSync(file, JSON.stringify({ "app.session.new": "ctrl+shift+n" }));
      writeKeybindings(file, planKeybindingsMerge(readKeybindings(file)).result);
      const written = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(written["app.session.new"], "ctrl+shift+n");
      assert.equal(written["app.model.select"], "ctrl+alt+l");
      assert.deepEqual(readdirSync(dir), ["keybindings.json"], "no temp file left behind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
