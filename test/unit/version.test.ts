import assert from "node:assert/strict";
import { it } from "node:test";

import { isSupportedVersion, PROTOCOL_VERSION, SUPPORTED_VERSIONS } from "../../src/protocol/version.ts";

it("speaks protocol version 1", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(SUPPORTED_VERSIONS, [1]);
});

it("accepts only supported numeric versions", () => {
  assert.equal(isSupportedVersion(1), true);
  for (const v of [0, 2, "1", null, undefined, 1.5]) assert.equal(isSupportedVersion(v), false, String(v));
});
