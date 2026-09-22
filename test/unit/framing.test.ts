import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_LINE_BYTES,
  encodeMessage,
  FramingError,
  JsonlDecoder,
  parseMessage,
  type DecodeResult,
} from "../../src/protocol/framing.ts";
import type { Message } from "../../src/protocol/types.ts";

const usage = { input: 1200, output: 340, cost: 0.0042 };

const SAMPLES: Message[] = [
  { v: 1, type: "hello", agentId: "scout", token: "t0k3n", pid: 4242, piVersion: "0.87.1", protocol: 1 },
  { v: 1, type: "hello", agentId: "scout", token: "t0k3n", pid: 4242, piVersion: "0.87.1", protocol: 1, reconnect: true },
  {
    v: 1,
    type: "welcome",
    agentId: "scout",
    config: { mode: "autonomous", closeOnDone: true, hubGoneGraceMs: 30000, name: "Bello Baggins" },
    resumed: false,
  },
  { v: 1, type: "ack", agentId: "scout", ref: "done-1" },
  { v: 1, type: "reject", agentId: "scout", reason: "invalid token" },
  { v: 1, type: "task", agentId: "scout", id: "req-1", text: "Find all callers of createSurface" },
  { v: 1, type: "status", agentId: "scout", state: "running", tool: "bash", usage, model: "qwen3.5:4b" },
  { v: 1, type: "status", agentId: "scout", state: "idle", usage, model: "qwen3.5:4b" },
  { v: 1, type: "event", agentId: "scout", event: { kind: "text_delta", text: "Grüße 👋" } },
  { v: 1, type: "event", agentId: "scout", event: { kind: "tool_start", toolCallId: "c1", tool: "read", args: "src/a.ts" } },
  { v: 1, type: "event", agentId: "scout", event: { kind: "tool_end", toolCallId: "c1", tool: "read", isError: false } },
  { v: 1, type: "steer", agentId: "scout", text: "Examples in English, please", mode: "followUp" },
  { v: 1, type: "abort", agentId: "scout", reason: "user request" },
  { v: 1, type: "shutdown", agentId: "scout" },
  { v: 1, type: "takeover", agentId: "scout" },
  { v: 1, type: "done", agentId: "scout", summary: "Found 3 callers.", usage, sessionFile: "C:\\tmp\\s.jsonl" },
  { v: 1, type: "done", agentId: "scout", id: "done-1", summary: "", usage, sessionFile: "s.jsonl", error: "overloaded" },
  { v: 1, type: "bye", agentId: "scout", reason: "quit" },
  { v: 1, type: "status", agentId: "scout", state: "closing", usage, model: "qwen3.5:4b" },
  { v: 1, type: "event", agentId: "scout", event: { kind: "user_message", text: "hi", source: "user" } },
  { v: 1, type: "error", agentId: "scout", message: "model unavailable", fatal: true },
  { v: 1, type: "ping", agentId: "scout", id: "p-7" },
  { v: 1, type: "pong", agentId: "scout", id: "p-7" },
];

const messages = (results: DecodeResult[]) =>
  results.map((r) => {
    assert.ok(r.ok, r.ok ? "" : `unexpected error: ${r.error.message}`);
    return r.message;
  });

const errorCodes = (results: DecodeResult[]) => results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error.code));

const line = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("encodeMessage", () => {
  it("round-trips every message type", () => {
    for (const msg of SAMPLES) {
      const encoded = encodeMessage(msg);
      assert.ok(encoded.endsWith("\n"));
      assert.equal(encoded.indexOf("\n"), encoded.length - 1, "exactly one LF, at the end");
      assert.deepEqual(parseMessage(encoded.slice(0, -1)), msg);
    }
  });

  it("escapes newlines inside strings", () => {
    const encoded = encodeMessage({ v: 1, type: "task", agentId: "a", text: "one\ntwo\r\nthree" });
    assert.equal(encoded.split("\n").length, 2);
    assert.ok(!encoded.slice(0, -1).includes("\r"));
  });

  it("rejects messages over the line limit", () => {
    const msg: Message = { v: 1, type: "task", agentId: "a", text: "x".repeat(100) };
    assert.throws(() => encodeMessage(msg, { maxLineBytes: 50 }), (e: unknown) => {
      return e instanceof FramingError && e.code === "LINE_TOO_LONG" && /exceeding the limit of 50 bytes/.test(e.message);
    });
  });

  it("measures the limit in UTF-8 bytes, not UTF-16 units", () => {
    const msg: Message = { v: 1, type: "task", agentId: "a", text: "€".repeat(10) }; // 3 bytes each
    const bytes = Buffer.byteLength(JSON.stringify(msg));
    assert.doesNotThrow(() => encodeMessage(msg, { maxLineBytes: bytes }));
    assert.throws(() => encodeMessage(msg, { maxLineBytes: bytes - 1 }), FramingError);
  });
});

describe("JsonlDecoder", () => {
  const stream = Buffer.from(SAMPLES.map((m) => encodeMessage(m)).join(""), "utf8");

  it("decodes a whole stream in one chunk", () => {
    assert.deepEqual(messages(new JsonlDecoder().push(stream)), SAMPLES);
  });

  it("decodes byte by byte, including inside multi-byte UTF-8 sequences", () => {
    const decoder = new JsonlDecoder();
    const out: DecodeResult[] = [];
    for (let i = 0; i < stream.length; i++) out.push(...decoder.push(stream.subarray(i, i + 1)));
    assert.deepEqual(messages(out), SAMPLES);
    assert.deepEqual(decoder.end(), []);
  });

  it("decodes identically at every two-chunk split point", () => {
    const text = encodeMessage({ v: 1, type: "task", agentId: "a", text: "é € 😀 漢字" }) + encodeMessage(SAMPLES[0]!);
    const bytes = Buffer.from(text, "utf8");
    const expected = messages(new JsonlDecoder().push(bytes));
    for (let i = 0; i <= bytes.length; i++) {
      const decoder = new JsonlDecoder();
      const out = [...decoder.push(bytes.subarray(0, i)), ...decoder.push(bytes.subarray(i))];
      assert.deepEqual(messages(out), expected, `split at byte ${i}`);
    }
  });

  it("does not reuse the caller's chunk memory for buffered data", () => {
    const decoder = new JsonlDecoder();
    const chunk = Buffer.from(line({ v: 1, type: "ping", agentId: "abc" }), "utf8");
    const head = Buffer.from(chunk.subarray(0, 10));
    decoder.push(head);
    head.fill(0x20); // Caller reuses its buffer.
    assert.deepEqual(messages(decoder.push(chunk.subarray(10))), [{ v: 1, type: "ping", agentId: "abc" }]);
  });

  it("accepts string chunks", () => {
    const decoder = new JsonlDecoder();
    const text = encodeMessage(SAMPLES[6]!);
    assert.deepEqual(messages([...decoder.push(text.slice(0, 20)), ...decoder.push(text.slice(20))]), [SAMPLES[6]]);
  });

  it("strips a trailing CR (CRLF framing)", () => {
    const out = new JsonlDecoder().push(line({ v: 1, type: "ping", agentId: "a" }).replace("\n", "\r\n"));
    assert.deepEqual(messages(out), [{ v: 1, type: "ping", agentId: "a" }]);
  });

  it("handles CR and LF arriving in separate chunks", () => {
    const decoder = new JsonlDecoder();
    const body = JSON.stringify({ v: 1, type: "ping", agentId: "a" });
    assert.deepEqual(decoder.push(body + "\r"), []);
    assert.deepEqual(messages(decoder.push("\n")), [{ v: 1, type: "ping", agentId: "a" }]);
  });

  it("does not treat U+2028 / U+2029 as line separators", () => {
    const msg: Message = { v: 1, type: "task", agentId: "a", text: "a\u2028b\u2029c" };
    const encoded = encodeMessage(msg);
    assert.ok(encoded.includes("\u2028") && encoded.includes("\u2029"), "raw separators stay in the line");
    const out = messages(new JsonlDecoder().push(encoded + encoded));
    assert.deepEqual(out, [msg, msg]);
  });

  it("ignores blank lines", () => {
    const out = new JsonlDecoder().push("\n\r\n" + line({ v: 1, type: "ping", agentId: "a" }) + "\n");
    assert.deepEqual(messages(out), [{ v: 1, type: "ping", agentId: "a" }]);
  });

  it("accepts a line of exactly maxLineBytes, with or without CR", () => {
    const body = JSON.stringify({ v: 1, type: "task", agentId: "a", text: "x".repeat(40) });
    const max = Buffer.byteLength(body);
    assert.equal(messages(new JsonlDecoder({ maxLineBytes: max }).push(body + "\n")).length, 1);
    assert.equal(messages(new JsonlDecoder({ maxLineBytes: max }).push(body + "\r\n")).length, 1);
    assert.deepEqual(errorCodes(new JsonlDecoder({ maxLineBytes: max - 1 }).push(body + "\n")), ["LINE_TOO_LONG"]);
  });

  it("reports an over-long line once and resynchronizes at the next LF", () => {
    const decoder = new JsonlDecoder({ maxLineBytes: 64 });
    const out: DecodeResult[] = [];
    const long = line({ v: 1, type: "task", agentId: "a", text: "y".repeat(500) });
    for (let i = 0; i < long.length; i += 7) out.push(...decoder.push(long.slice(i, i + 7)));
    out.push(...decoder.push(line({ v: 1, type: "ping", agentId: "a" })));
    assert.deepEqual(errorCodes(out), ["LINE_TOO_LONG"]);
    const error = out.find((r) => !r.ok);
    assert.ok(error && !error.ok && /limit of 64 bytes/.test(error.error.message));
    assert.deepEqual(
      out.filter((r) => r.ok).map((r) => (r.ok ? r.message.type : "")),
      ["ping"],
    );
  });

  it("does not buffer more than the limit while discarding", () => {
    const decoder = new JsonlDecoder({ maxLineBytes: 16 });
    assert.deepEqual(errorCodes(decoder.push("z".repeat(100))), ["LINE_TOO_LONG"]);
    assert.deepEqual(decoder.push("z".repeat(10_000)), []);
    assert.deepEqual(decoder.end(), [], "discarded data is not reported again as truncated");
  });

  it("reports invalid UTF-8 and keeps going", () => {
    const bad = Buffer.concat([Buffer.from('{"v":1,"type":"task","agentId":"a","text":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]);
    const decoder = new JsonlDecoder();
    const out = [...decoder.push(bad), ...decoder.push(line({ v: 1, type: "ping", agentId: "a" }))];
    assert.deepEqual(errorCodes(out), ["INVALID_UTF8"]);
    assert.equal(out.filter((r) => r.ok).length, 1);
  });

  it("reports a truncated final line on end()", () => {
    const decoder = new JsonlDecoder();
    decoder.push('{"v":1,"type":"pi');
    assert.deepEqual(errorCodes(decoder.end()), ["TRUNCATED"]);
    assert.deepEqual(decoder.end(), [], "state is reset after end()");
  });

  it("validates maxLineBytes", () => {
    assert.throws(() => new JsonlDecoder({ maxLineBytes: 0 }), RangeError);
    assert.throws(() => new JsonlDecoder({ maxLineBytes: 1.5 }), RangeError);
    assert.equal(DEFAULT_MAX_LINE_BYTES, 1024 * 1024);
  });
});

describe("message validation", () => {
  const cases: [string, string, string][] = [
    ["not JSON", "{nope", "INVALID_JSON"],
    ["an array", "[1,2]", "INVALID_MESSAGE"],
    ["null", "null", "INVALID_MESSAGE"],
    ["missing v", JSON.stringify({ type: "ping", agentId: "a" }), "UNSUPPORTED_VERSION"],
    ["v as string", JSON.stringify({ v: "1", type: "ping", agentId: "a" }), "UNSUPPORTED_VERSION"],
    ["future version", JSON.stringify({ v: 2, type: "ping", agentId: "a" }), "UNSUPPORTED_VERSION"],
    ["missing type", JSON.stringify({ v: 1, agentId: "a" }), "INVALID_MESSAGE"],
    ["unknown type", JSON.stringify({ v: 1, type: "launch", agentId: "a" }), "UNKNOWN_TYPE"],
    ["inherited type name", JSON.stringify({ v: 1, type: "toString", agentId: "a" }), "UNKNOWN_TYPE"],
    ["missing agentId", JSON.stringify({ v: 1, type: "ping" }), "INVALID_MESSAGE"],
    ["empty agentId", JSON.stringify({ v: 1, type: "ping", agentId: "" }), "INVALID_MESSAGE"],
    ["numeric id", JSON.stringify({ v: 1, type: "ping", agentId: "a", id: 7 }), "INVALID_MESSAGE"],
    ["missing payload field", JSON.stringify({ v: 1, type: "task", agentId: "a" }), "INVALID_MESSAGE"],
    ["wrong payload type", JSON.stringify({ v: 1, type: "error", agentId: "a", message: "x", fatal: "yes" }), "INVALID_MESSAGE"],
    ["bad enum", JSON.stringify({ v: 1, type: "steer", agentId: "a", text: "x", mode: "now" }), "INVALID_MESSAGE"],
    [
      "bad optional field",
      JSON.stringify({ v: 1, type: "status", agentId: "a", state: "idle", tool: 3, usage: {}, model: "m" }),
      "INVALID_MESSAGE",
    ],
    ["bad event kind", JSON.stringify({ v: 1, type: "event", agentId: "a", event: { kind: "nope" } }), "INVALID_MESSAGE"],
  ];

  for (const [name, input, code] of cases) {
    it(`rejects ${name} with ${code}`, () => {
      assert.throws(() => parseMessage(input), (e: unknown) => e instanceof FramingError && e.code === code);
      assert.deepEqual(errorCodes(new JsonlDecoder().push(input + "\n")), [code]);
    });
  }

  it("allows unknown extra fields", () => {
    const msg = parseMessage(JSON.stringify({ v: 1, type: "ping", agentId: "a", extra: true }));
    assert.equal(msg.type, "ping");
  });
});
