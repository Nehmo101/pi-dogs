import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DOG_NAMES, isValidDogName, makeAgentId, MAX_DOG_NAME_LENGTH, pickDogName, sanitizeDogName } from "../../src/hub/dog-names.ts";

describe("dog names", () => {
  it("has at least 60 unique, valid, mixed German and English names", () => {
    assert.ok(DOG_NAMES.length >= 60, `only ${DOG_NAMES.length}`);
    assert.equal(new Set(DOG_NAMES.map((n) => n.toLowerCase())).size, DOG_NAMES.length, "duplicates");
    for (const name of DOG_NAMES) assert.ok(isValidDogName(name), name);
    assert.ok(DOG_NAMES.some((n) => /[äöüß]/.test(n)), "some German names");
    assert.ok(DOG_NAMES.includes("Sir Barksalot"));
  });

  it("validates names for titles and command lines", () => {
    for (const bad of ["", " Rex", "Rex ", "Käpt'n", 'Say "hi"', "a;b", "x".repeat(MAX_DOG_NAME_LENGTH + 1), "-rex", "Rex|Bello"]) {
      assert.equal(isValidDogName(bad), false, bad);
    }
    for (const good of ["Rex", "Bello Baggins", "R2-D2", "Mr. Wuff", "Knochenkönig"]) assert.equal(isValidDogName(good), true, good);
  });

  it("sanitizes user-provided names", () => {
    assert.equal(sanitizeDogName("  Käpt'n   Kläff!  "), "Käptn Kläff");
    assert.equal(sanitizeDogName("--rex"), "rex");
    assert.equal(sanitizeDogName("'\";"), "");
  });

  it("picks unused names and never repeats within a session", () => {
    const taken: string[] = [];
    for (let i = 0; i < DOG_NAMES.length; i++) taken.push(pickDogName(taken));
    assert.equal(new Set(taken).size, DOG_NAMES.length);
    // Pool exhausted: a number is appended.
    const next = pickDogName(taken, { random: () => 0 });
    assert.equal(next, `${DOG_NAMES[0]} 2`);
  });

  it("uses the preferred name, suffixing duplicates case-insensitively", () => {
    assert.equal(pickDogName([], { preferred: "Scout" }), "Scout");
    assert.equal(pickDogName(["scout", "Scout 2"], { preferred: "Scout" }), "Scout 3");
    assert.equal(pickDogName([], { preferred: "'''", pool: ["Only"] }), "Only", "unusable preferred name falls back");
  });

  it("derives a file- and id-safe agent id", () => {
    assert.equal(makeAgentId("Kläffi McKläffface", () => "3f2a"), "klaeffi-mcklaeffface-3f2a");
    assert.equal(makeAgentId("Mr. Wuff", () => "0001"), "mr-wuff-0001");
    assert.equal(makeAgentId("日本", () => "ab12"), "dog-ab12");
    assert.match(makeAgentId("A".repeat(40), () => "ffff"), /^a{24}-ffff$/);
  });
});
