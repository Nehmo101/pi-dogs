/**
 * JSONL framing for protocol messages: one JSON object per line, UTF-8, LF.
 *
 * The decoder works on bytes and splits only on "\n" (0x0A). It deliberately
 * avoids `readline`, which also treats U+2028 and U+2029 as line breaks; those
 * characters are valid inside JSON strings and pass through untouched.
 * A trailing "\r" is stripped, so CRLF-framed input is accepted.
 */
import type { AgentState, Message, MessageType } from "./types.ts";
import { isSupportedVersion } from "./version.ts";

/** Default maximum line length in bytes, excluding the line terminator. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

/**
 * Largest free text (task, steer message, done summary) that goes into one
 * message, measured as its JSON-encoded size. Leaves ample room for the
 * envelope within DEFAULT_MAX_LINE_BYTES (docs/protocol.md, section 2).
 */
export const MAX_TEXT_BYTES = 512 * 1024;

/** Size of `text` once JSON-encoded (escapes included), in UTF-8 bytes. */
export function encodedTextBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/** Shorten `text` so that its encoded size fits `maxBytes`, marking the cut. */
export function truncateText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  if (encodedTextBytes(text) <= maxBytes) return text;
  const marker = "\n… (truncated by pi-dogs)";
  let cut = text;
  for (;;) {
    const size = encodedTextBytes(cut + marker);
    if (size <= maxBytes || cut.length === 0) return cut + marker;
    cut = cut.slice(0, Math.max(0, Math.floor((cut.length * maxBytes) / size) - 1));
  }
}

export type FramingErrorCode =
  | "LINE_TOO_LONG"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_TYPE"
  | "TRUNCATED";

export class FramingError extends Error {
  readonly code: FramingErrorCode;

  constructor(code: FramingErrorCode, message: string) {
    super(message);
    this.name = "FramingError";
    this.code = code;
  }
}

export type DecodeResult =
  | { ok: true; message: Message }
  | { ok: false; error: FramingError };

export interface FramingOptions {
  /** Maximum line length in bytes, excluding "\n" and an optional "\r". */
  maxLineBytes?: number;
}

const LF = 0x0a;
const CR = 0x0d;

/** Serialize a message as a single JSONL line, including the trailing "\n". */
export function encodeMessage(message: Message, options: FramingOptions = {}): string {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  // JSON.stringify escapes "\n" and "\r" inside strings, so the output is one line.
  const line = JSON.stringify(message);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > maxLineBytes) {
    throw new FramingError(
      "LINE_TOO_LONG",
      `Encoded "${message.type}" message is ${bytes} bytes, exceeding the limit of ${maxLineBytes} bytes`,
    );
  }
  return line + "\n";
}

/**
 * Streaming decoder. Feed it arbitrary chunks (split anywhere, including in the
 * middle of a multi-byte UTF-8 sequence); it returns one result per complete
 * line. Malformed lines produce an error result and decoding resumes at the
 * next line, so the caller decides whether to drop the connection.
 */
export class JsonlDecoder {
  readonly #maxLineBytes: number;
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  /** True while skipping the rest of an over-long line. */
  #discarding = false;

  constructor(options: FramingOptions = {}) {
    const max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isInteger(max) || max <= 0) {
      throw new RangeError(`maxLineBytes must be a positive integer, got ${max}`);
    }
    this.#maxLineBytes = max;
  }

  push(chunk: Uint8Array | string): DecodeResult[] {
    const buf =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const results: DecodeResult[] = [];
    let start = 0;
    while (start < buf.length) {
      const lf = buf.indexOf(LF, start);
      if (lf === -1) {
        this.#append(buf.subarray(start), results);
        break;
      }
      this.#append(buf.subarray(start, lf), results);
      this.#finishLine(results);
      start = lf + 1;
    }
    return results;
  }

  /** Signal end of stream. Reports an unterminated final line as TRUNCATED. */
  end(): DecodeResult[] {
    const results: DecodeResult[] = [];
    if (!this.#discarding && this.#pendingBytes > 0) {
      results.push({
        ok: false,
        error: new FramingError("TRUNCATED", `Stream ended in the middle of a line (${this.#pendingBytes} bytes buffered)`),
      });
    }
    this.#reset();
    return results;
  }

  #append(segment: Buffer, results: DecodeResult[]): void {
    if (this.#discarding || segment.length === 0) return;
    // Allow one extra byte for a trailing "\r" that will be stripped.
    if (this.#pendingBytes + segment.length > this.#maxLineBytes + 1) {
      results.push({
        ok: false,
        error: new FramingError("LINE_TOO_LONG", `Line exceeds the limit of ${this.#maxLineBytes} bytes`),
      });
      this.#reset();
      this.#discarding = true;
      return;
    }
    this.#pending.push(Buffer.from(segment)); // Copy: the caller may reuse its chunk buffer.
    this.#pendingBytes += segment.length;
  }

  #finishLine(results: DecodeResult[]): void {
    if (this.#discarding) {
      this.#reset();
      return;
    }
    let line = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
    this.#reset();
    if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, -1);
    if (line.length === 0) return; // Blank lines are ignored.
    if (line.length > this.#maxLineBytes) {
      results.push({
        ok: false,
        error: new FramingError("LINE_TOO_LONG", `Line of ${line.length} bytes exceeds the limit of ${this.#maxLineBytes} bytes`),
      });
      return;
    }
    let text: string;
    try {
      text = this.#utf8.decode(line);
    } catch {
      results.push({ ok: false, error: new FramingError("INVALID_UTF8", "Line is not valid UTF-8") });
      return;
    }
    try {
      results.push({ ok: true, message: parseMessage(text) });
    } catch (err) {
      if (!(err instanceof FramingError)) throw err;
      results.push({ ok: false, error: err });
    }
  }

  #reset(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#discarding = false;
  }
}

type FieldSpec = "string" | "number" | "boolean" | "object" | readonly string[];

const AGENT_STATES: readonly AgentState[] = ["starting", "running", "idle", "closing", "done", "failed", "killed"];

/** Required payload fields per message type. A "?" suffix marks optional fields. */
const PAYLOAD_FIELDS: Record<MessageType, Record<string, FieldSpec>> = {
  hello: { token: "string", pid: "number", piVersion: "string", protocol: "number", "reconnect?": "boolean" },
  welcome: { config: "object", resumed: "boolean", hubSecret: "string" },
  reject: { reason: "string", "hubSecret?": "string" },
  ack: { ref: "string" },
  task: { text: "string" },
  status: { state: AGENT_STATES, "tool?": "string", usage: "object", model: "string" },
  event: { event: "object" },
  steer: { text: "string", mode: ["steer", "followUp"] },
  abort: { reason: "string" },
  shutdown: {},
  takeover: {},
  done: { summary: "string", usage: "object", sessionFile: "string", "error?": "string" },
  bye: { reason: "string" },
  error: { message: "string", fatal: "boolean" },
  ping: {},
  pong: {},
};

/** Payload fields per event kind, checked with the same rules as PAYLOAD_FIELDS. */
const EVENT_FIELDS: Record<string, Record<string, FieldSpec>> = {
  text_delta: { text: "string" },
  tool_start: { toolCallId: "string", tool: "string", "args?": "string" },
  tool_end: { toolCallId: "string", tool: "string", isError: "boolean" },
  user_message: { text: "string", source: ["hub", "user"] },
};

const USAGE_FIELDS: Record<string, FieldSpec> = {
  input: "number",
  output: "number",
  "cacheRead?": "number",
  "cacheWrite?": "number",
  "cost?": "number",
};

const CONFIG_FIELDS: Record<string, FieldSpec> = {
  mode: ["autonomous", "interactive"],
  closeOnDone: "boolean",
  hubGoneGraceMs: "number",
  name: "string",
};

/** Nested objects checked per message type: field name -> its payload fields. */
const NESTED_FIELDS: Partial<Record<MessageType, Record<string, Record<string, FieldSpec>>>> = {
  status: { usage: USAGE_FIELDS },
  done: { usage: USAGE_FIELDS },
  welcome: { config: CONFIG_FIELDS },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(value: unknown, spec: FieldSpec): boolean {
  if (Array.isArray(spec)) return typeof value === "string" && spec.includes(value);
  if (spec === "object") return isObject(value);
  return typeof value === spec;
}

/**
 * Parse and validate one line of JSON as a protocol message. Checks the
 * envelope (`v`, `type`, `agentId`, `id`) and the presence and primitive types
 * of the payload fields. Unknown extra fields are allowed.
 */
export function parseMessage(line: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw new FramingError("INVALID_JSON", `Line is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(value)) throw new FramingError("INVALID_MESSAGE", "Message must be a JSON object");
  if (!isSupportedVersion(value.v)) {
    throw new FramingError("UNSUPPORTED_VERSION", `Unsupported protocol version: ${JSON.stringify(value.v)}`);
  }
  const type = value.type;
  if (typeof type !== "string") throw new FramingError("INVALID_MESSAGE", 'Field "type" must be a string');
  if (!Object.hasOwn(PAYLOAD_FIELDS, type)) {
    throw new FramingError("UNKNOWN_TYPE", `Unknown message type: ${JSON.stringify(type)}`);
  }
  if (typeof value.agentId !== "string" || value.agentId === "") {
    throw new FramingError("INVALID_MESSAGE", `"${type}": field "agentId" must be a non-empty string`);
  }
  if (value.id !== undefined && typeof value.id !== "string") {
    throw new FramingError("INVALID_MESSAGE", `"${type}": field "id" must be a string`);
  }
  checkFields(type, "", value, PAYLOAD_FIELDS[type as MessageType]);
  for (const [field, specs] of Object.entries(NESTED_FIELDS[type as MessageType] ?? {})) {
    checkFields(type, `${field}.`, value[field] as Record<string, unknown>, specs);
  }
  if (type === "event") {
    const event = value.event as Record<string, unknown>;
    const kind = event.kind;
    if (typeof kind !== "string" || !Object.hasOwn(EVENT_FIELDS, kind)) {
      throw new FramingError("INVALID_MESSAGE", `"event": unknown event kind ${JSON.stringify(kind)}`);
    }
    checkFields(type, "event.", event, EVENT_FIELDS[kind]!);
  }
  return value as unknown as Message;
}

function checkFields(type: string, prefix: string, value: Record<string, unknown>, specs: Record<string, FieldSpec>): void {
  for (const [key, spec] of Object.entries(specs)) {
    const optional = key.endsWith("?");
    const name = optional ? key.slice(0, -1) : key;
    const field = value[name];
    if (optional && field === undefined) continue;
    if (!matches(field, spec)) {
      const expected = Array.isArray(spec) ? `one of ${spec.join(", ")}` : `a ${spec}`;
      throw new FramingError("INVALID_MESSAGE", `"${type}": field "${prefix}${name}" must be ${expected}`);
    }
  }
}
