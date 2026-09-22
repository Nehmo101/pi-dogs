/**
 * Turns pi's high-frequency events into a small, ordered stream for the hub:
 *
 * - text deltas are batched (flushed every ~100 ms, or earlier when large),
 * - tool arguments are reduced to a short, readable summary,
 * - status updates are throttled to at most ~4 per second (latest wins),
 * - order is preserved: pending text is flushed before any other event.
 */
import type { AgentEvent, AgentState, Usage } from "../protocol/types.ts";
import type { AgentOutgoing } from "./client.ts";

export interface StatusFields {
  state: AgentState;
  tool?: string | undefined;
  usage: Usage;
  model: string;
}

export interface ForwarderOptions {
  send(message: AgentOutgoing): void;
  textFlushMs?: number;
  /** Flush text immediately once this many characters are pending. */
  textMaxChars?: number;
  statusIntervalMs?: number;
  argsMaxChars?: number;
  /** Forward text deltas at all ("minimal" event detail turns this off). */
  forwardText?: boolean;
  now?: () => number;
}

/** Keys that best describe a call of common tools, in order of preference. */
const PREFERRED_ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "summary", "message", "name", "task"];

/** A short, single-line description of tool arguments for the mirror view. */
export function summarizeArgs(args: unknown, max = 160): string | undefined {
  if (args === undefined || args === null) return undefined;
  let text: string;
  if (typeof args === "string") text = args;
  else if (typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const key = PREFERRED_ARG_KEYS.find((k) => typeof record[k] === "string");
    text = key ? String(record[key]) : safeJson(args);
  } else text = safeJson(args);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export class EventForwarder {
  readonly #o: Required<ForwarderOptions>;
  #text = "";
  #textTimer: NodeJS.Timeout | undefined;
  #status: StatusFields | undefined;
  #statusTimer: NodeJS.Timeout | undefined;
  #lastStatusAt = -Infinity;
  #disposed = false;

  constructor(options: ForwarderOptions) {
    this.#o = {
      textFlushMs: 100,
      textMaxChars: 4000,
      statusIntervalMs: 250,
      argsMaxChars: 160,
      forwardText: true,
      now: Date.now,
      ...options,
    };
  }

  text(delta: string): void {
    if (this.#disposed || !this.#o.forwardText || !delta) return;
    this.#text += delta;
    if (this.#text.length >= this.#o.textMaxChars) this.flushText();
    else this.#textTimer ??= setTimeout(() => this.flushText(), this.#o.textFlushMs);
  }

  toolStart(toolCallId: string, tool: string, args: unknown): void {
    const summary = summarizeArgs(args, this.#o.argsMaxChars);
    this.#event(summary === undefined ? { kind: "tool_start", toolCallId, tool } : { kind: "tool_start", toolCallId, tool, args: summary });
  }

  toolEnd(toolCallId: string, tool: string, isError: boolean): void {
    this.#event({ kind: "tool_end", toolCallId, tool, isError });
  }

  userMessage(text: string, source: "hub" | "user"): void {
    this.#event({ kind: "user_message", text: text.length > 2000 ? text.slice(0, 1999) + "…" : text, source });
  }

  /** Queue a status update. Sent at once if the last one is old enough, otherwise at the end of the interval. */
  status(fields: StatusFields): void {
    if (this.#disposed) return;
    this.#status = fields;
    const wait = this.#lastStatusAt + this.#o.statusIntervalMs - this.#o.now();
    if (wait <= 0) this.flushStatus();
    else this.#statusTimer ??= setTimeout(() => this.flushStatus(), wait);
  }

  flushText(): void {
    if (this.#textTimer) clearTimeout(this.#textTimer);
    this.#textTimer = undefined;
    if (!this.#text) return;
    const text = this.#text;
    this.#text = "";
    this.#o.send({ type: "event", event: { kind: "text_delta", text } });
  }

  flushStatus(): void {
    if (this.#statusTimer) clearTimeout(this.#statusTimer);
    this.#statusTimer = undefined;
    const status = this.#status;
    if (!status) return;
    this.#status = undefined;
    this.#lastStatusAt = this.#o.now();
    this.flushText();
    const { tool, ...rest } = status;
    this.#o.send(tool ? { type: "status", ...rest, tool } : { type: "status", ...rest });
  }

  /** Send everything that is pending. */
  flush(): void {
    this.flushText();
    this.flushStatus();
  }

  dispose(): void {
    this.flush();
    this.#disposed = true;
  }

  #event(event: AgentEvent): void {
    if (this.#disposed) return;
    this.flushText();
    this.#o.send({ type: "event", event });
  }
}
