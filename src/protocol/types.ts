/**
 * Protocol v1 message types exchanged between the hub (main pi) and an agent
 * (subagent pi) over a named pipe, one JSON object per line.
 *
 * Every message carries `v` (protocol version), `type` and `agentId`.
 * Requests that expect a reply may carry an `id`, echoed by the reply.
 */
import type { ProtocolVersion } from "./version.ts";

/**
 * Lifecycle states of an agent, as tracked by the hub registry.
 *
 * - `starting`: window opened, waiting for `hello`.
 * - `running` / `idle`: connected; working on a turn or waiting for input.
 * - `closing`: finished or asked to stop; accepts no more work.
 * - `done` / `failed` / `killed`: terminal states.
 */
export type AgentState = "starting" | "running" | "idle" | "closing" | "done" | "failed" | "killed";

/** How an agent finishes: on its own (autonomous) or only when told to (interactive). */
export type AgentMode = "autonomous" | "interactive";

/** Token usage and cost, cumulative for the agent session. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Total cost in USD, if the provider reports it. */
  cost?: number;
}

/** Settings the hub sends to an agent in `welcome`. */
export interface AgentConfig {
  mode: AgentMode;
  /** Quit the agent pi after its `done` has been acknowledged. */
  closeOnDone: boolean;
  /** How long the agent keeps trying to reconnect before it assumes the hub is gone. */
  hubGoneGraceMs: number;
  /** Display name, for the agent's own UI. */
  name: string;
}

/** Filtered pi events forwarded for the live mirror view. */
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; toolCallId: string; tool: string; args?: string }
  | { kind: "tool_end"; toolCallId: string; tool: string; isError: boolean }
  /** A user message entered the agent's session, from the hub (task/steer) or typed by hand. */
  | { kind: "user_message"; text: string; source: "hub" | "user" };

interface Envelope<T extends string> {
  v: ProtocolVersion;
  type: T;
  agentId: string;
  id?: string;
}

// Agent -> hub

export interface HelloMessage extends Envelope<"hello"> {
  token: string;
  pid: number;
  piVersion: string;
  /** Highest protocol version the agent speaks. */
  protocol: number;
  /** True when the agent reconnects after losing the pipe (it already received its task). */
  reconnect?: boolean;
}

export interface StatusMessage extends Envelope<"status"> {
  state: AgentState;
  /** Name of the tool currently running, if any. */
  tool?: string;
  usage: Usage;
  model: string;
}

export interface EventMessage extends Envelope<"event"> {
  event: AgentEvent;
}

export type TakeoverMessage = Envelope<"takeover">;

/**
 * The agent finished. Sent with an `id`; the agent re-sends it after a
 * reconnect until the hub answers with a matching `ack`.
 */
export interface DoneMessage extends Envelope<"done"> {
  summary: string;
  usage: Usage;
  sessionFile: string;
  /** Set when the run ended with a model/provider error instead of a result. */
  error?: string;
}

/** The agent pi is shutting down (`reason` is pi's shutdown reason, e.g. "quit"). */
export interface ByeMessage extends Envelope<"bye"> {
  reason: string;
}

export interface ErrorMessage extends Envelope<"error"> {
  message: string;
  fatal: boolean;
}

// Hub -> agent

export interface WelcomeMessage extends Envelope<"welcome"> {
  config: AgentConfig;
  /** True when the hub already knows this agent (reconnect); no new `task` follows. */
  resumed: boolean;
}

/** Acknowledges a message that carried an `id` (currently `done`). */
export interface AckMessage extends Envelope<"ack"> {
  ref: string;
}

export interface RejectMessage extends Envelope<"reject"> {
  reason: string;
}

export interface TaskMessage extends Envelope<"task"> {
  text: string;
}

export interface SteerMessage extends Envelope<"steer"> {
  text: string;
  mode: "steer" | "followUp";
}

export interface AbortMessage extends Envelope<"abort"> {
  reason: string;
}

export type ShutdownMessage = Envelope<"shutdown">;

// Both directions

export type PingMessage = Envelope<"ping">;

export type PongMessage = Envelope<"pong">;

export type AgentToHubMessage =
  | HelloMessage
  | StatusMessage
  | EventMessage
  | TakeoverMessage
  | DoneMessage
  | ByeMessage
  | ErrorMessage
  | PingMessage
  | PongMessage;

export type HubToAgentMessage =
  | WelcomeMessage
  | RejectMessage
  | AckMessage
  | TaskMessage
  | SteerMessage
  | AbortMessage
  | ShutdownMessage
  | PingMessage
  | PongMessage;

export type Message = AgentToHubMessage | HubToAgentMessage;

export type MessageType = Message["type"];

/** Look up the message interface for a given `type`. */
export type MessageOfType<T extends MessageType> = Extract<Message, { type: T }>;
