/**
 * The hub's record of every dog in this pi process, and the state machine
 * that governs its lifecycle (docs/protocol.md, "Agent states").
 *
 * The registry holds plain data only, so it can be snapshotted across a
 * `/reload` of the main pi (see `snapshot()` / `Registry.restore()`).
 */
import type { AgentEvent, AgentMode, AgentState, Usage } from "../protocol/types.ts";

/** Allowed transitions. Terminal states (done, failed, killed) have none. */
const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = {
  starting: ["running", "idle", "closing", "failed", "killed"],
  running: ["idle", "closing", "done", "failed", "killed"],
  idle: ["running", "closing", "done", "failed", "killed"],
  closing: ["done", "failed", "killed"],
  done: [],
  failed: [],
  killed: [],
};

export const TERMINAL_STATES: readonly AgentState[] = ["done", "failed", "killed"];

export const isTerminal = (state: AgentState): boolean => TERMINAL_STATES.includes(state);

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(agentId: string, from: AgentState, to: AgentState) {
    super(`Invalid state transition for ${agentId}: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** One line in the mirror view. */
export type MirrorLine =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; args?: string; status: "running" | "ok" | "error"; toolCallId: string }
  | { kind: "user"; text: string; source: "hub" | "user" }
  | { kind: "info"; text: string };

/** How the dog ended, once it is in a terminal state. */
export interface DogOutcome {
  state: "done" | "failed" | "killed";
  /** Human-readable reason, e.g. "window closed" or "exit code 1". */
  reason?: string;
  summary?: string;
  error?: string;
}

export interface DogRecord {
  agentId: string;
  name: string;
  token: string;
  /** Echoed in `welcome` so the dog can tell the real hub from a squatter. */
  hubSecret: string;
  color: string;
  /** Model as `provider/id`, plus the thinking level if one was requested. */
  model: string;
  thinking?: string;
  role?: string;
  mode: AgentMode;
  cwd: string;
  task: string;
  closeOnDone: boolean;
  sessionFile: string;
  runDir: string;
  launchFile: string;
  exitFile: string;

  state: AgentState;
  /** Window minimized; the dog keeps running. */
  minimized: boolean;
  /** A human typed into the dog's window. */
  takenOver: boolean;
  /** New output arrived while minimized and the mirror has not shown it yet. */
  unseen: boolean;
  /** Connected over the pipe right now. */
  connected: boolean;
  /** pi process id from `hello`. */
  pid?: number;
  /** The task has been sent (never re-sent after a reconnect). */
  taskSent: boolean;
  currentTool?: string;
  usage: Usage;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  /** What to become once the process is gone, while `closing`. */
  closingTarget?: "done" | "killed";
  closingReason?: string;
  /** How to report a kill once the dog is gone (kept here so it survives a /reload). */
  closingReport?: boolean;
  closingTriggerTurn?: boolean;
  /** The user closed the dog's window (reported as killed, not as a crash). */
  windowClosed?: boolean;
  /** Main session epoch at spawn; bumped by /new and /resume in the main pi. */
  sessionEpoch?: number;
  /** Result reported by the dog (kept for `subagent_list` and the overlay). */
  summary?: string;
  outcome?: DogOutcome;
  /** Result has been handed to the main agent. */
  reported: boolean;
  mirror: MirrorLine[];
}

export type NewDog = Omit<
  DogRecord,
  "state" | "minimized" | "takenOver" | "unseen" | "connected" | "taskSent" | "usage" | "lastActivityAt" | "reported" | "mirror"
>;

export interface RegistrySnapshot {
  version: 1;
  records: DogRecord[];
}

/**
 * Remove C0/C1 control characters (ESC sequences included) except newline and
 * tab: mirrored text is drawn into the main pi's terminal and must not be able
 * to move the cursor, change colours or set the window title.
 */
export function stripControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class Registry {
  readonly #records = new Map<string, DogRecord>();
  readonly #mirrorLimit: number;

  constructor(options: { mirrorLimit?: number } = {}) {
    this.#mirrorLimit = options.mirrorLimit ?? 400;
  }

  /** Drop the oldest finished dogs beyond `keep`, so snapshots and lists stay small. */
  pruneTerminal(keep: number): void {
    const finished = this.all().filter((r) => isTerminal(r.state));
    for (const record of finished.slice(0, Math.max(0, finished.length - keep))) this.#records.delete(record.agentId);
  }

  static restore(snapshot: RegistrySnapshot, options: { mirrorLimit?: number } = {}): Registry {
    const registry = new Registry(options);
    for (const record of snapshot.records) registry.#records.set(record.agentId, { ...record, connected: false });
    return registry;
  }

  snapshot(): RegistrySnapshot {
    return { version: 1, records: this.all().map((r) => structuredClone(r)) };
  }

  add(dog: NewDog): DogRecord {
    if (this.#records.has(dog.agentId)) throw new Error(`Duplicate agent id: ${dog.agentId}`);
    const record: DogRecord = {
      ...dog,
      state: "starting",
      minimized: false,
      takenOver: false,
      unseen: false,
      connected: false,
      taskSent: false,
      usage: { input: 0, output: 0 },
      lastActivityAt: dog.startedAt,
      reported: false,
      mirror: [],
    };
    this.#records.set(record.agentId, record);
    return record;
  }

  get(agentId: string): DogRecord | undefined {
    return this.#records.get(agentId);
  }

  /** Find by agent id or (case-insensitive) name; also accepts a unique name prefix. */
  find(nameOrId: string): DogRecord | undefined {
    const q = nameOrId.trim().toLowerCase();
    if (!q) return undefined;
    const all = this.all();
    const exact = all.find((r) => r.agentId === nameOrId || r.name.toLowerCase() === q);
    if (exact) return exact;
    // Prefer live dogs when a prefix is ambiguous across finished ones.
    const prefixed = all.filter((r) => r.name.toLowerCase().startsWith(q) || r.agentId.startsWith(q));
    const live = prefixed.filter((r) => !isTerminal(r.state));
    if (live.length === 1) return live[0];
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  /** All records in start order. */
  all(): DogRecord[] {
    return [...this.#records.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Records that are not in a terminal state. */
  live(): DogRecord[] {
    return this.all().filter((r) => !isTerminal(r.state));
  }

  names(): string[] {
    return this.all().map((r) => r.name);
  }

  /**
   * Move a dog to a new state. Returns false (and changes nothing) when the
   * dog is already in `to`. Throws InvalidTransitionError for a transition the
   * state machine does not allow.
   */
  transition(agentId: string, to: AgentState, now: number): boolean {
    const record = this.#require(agentId);
    if (record.state === to) return false;
    if (!canTransition(record.state, to)) throw new InvalidTransitionError(agentId, record.state, to);
    record.state = to;
    record.lastActivityAt = now;
    if (isTerminal(to)) {
      record.endedAt = now;
      record.connected = false;
      delete record.currentTool;
    }
    return true;
  }

  /** Like `transition`, but silently ignores transitions that are not allowed. */
  tryTransition(agentId: string, to: AgentState, now: number): boolean {
    const record = this.#records.get(agentId);
    if (!record || record.state === to || !canTransition(record.state, to)) return false;
    return this.transition(agentId, to, now);
  }

  update(agentId: string, patch: Partial<Omit<DogRecord, "agentId" | "state">>): DogRecord {
    const record = this.#require(agentId);
    Object.assign(record, patch);
    return record;
  }

  /** Apply a forwarded agent event to the mirror buffer. */
  applyEvent(agentId: string, event: AgentEvent, now: number): void {
    const record = this.#require(agentId);
    record.lastActivityAt = now;
    if (record.minimized) record.unseen = true;
    const mirror = record.mirror;
    switch (event.kind) {
      case "text_delta": {
        const [first = "", ...rest] = stripControls(event.text).split("\n");
        let last = mirror[mirror.length - 1];
        if (last?.kind !== "text") {
          last = { kind: "text", text: "" };
          mirror.push(last);
        }
        last.text += first;
        for (const part of rest) mirror.push({ kind: "text", text: part });
        break;
      }
      case "tool_start":
        mirror.push(
          event.args === undefined
            ? { kind: "tool", tool: stripControls(event.tool), status: "running", toolCallId: event.toolCallId }
            : { kind: "tool", tool: stripControls(event.tool), args: stripControls(event.args), status: "running", toolCallId: event.toolCallId },
        );
        break;
      case "tool_end": {
        for (let i = mirror.length - 1; i >= 0; i--) {
          const line = mirror[i]!;
          if (line.kind === "tool" && line.toolCallId === event.toolCallId) {
            line.status = event.isError ? "error" : "ok";
            break;
          }
        }
        break;
      }
      case "user_message":
        mirror.push({ kind: "user", text: stripControls(event.text), source: event.source });
        break;
    }
    this.#trim(record);
  }

  addInfo(agentId: string, text: string): void {
    const record = this.#require(agentId);
    record.mirror.push({ kind: "info", text });
    this.#trim(record);
  }

  remove(agentId: string): void {
    this.#records.delete(agentId);
  }

  #trim(record: DogRecord): void {
    const excess = record.mirror.length - this.#mirrorLimit;
    if (excess > 0) record.mirror.splice(0, excess);
  }

  #require(agentId: string): DogRecord {
    const record = this.#records.get(agentId);
    if (!record) throw new Error(`Unknown agent: ${agentId}`);
    return record;
  }
}
