/**
 * Protocol v1 message types exchanged between the hub (main pi) and an agent
 * (subagent pi) over a named pipe, one JSON object per line.
 *
 * Every message carries `v` (protocol version), `type` and `agentId`.
 * Requests that expect a reply may carry an `id`, echoed by the reply.
 */
import type { ProtocolVersion } from "./version.ts";

/** Lifecycle states of an agent, as tracked by the hub registry. */
export type AgentState = "starting" | "running" | "idle" | "done" | "failed" | "killed";

/** Token usage and cost, cumulative for the agent session. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Total cost in USD, if the provider reports it. */
  cost?: number;
}

/** Filtered pi events forwarded for the live mirror view. */
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; toolCallId: string; tool: string; args?: string }
  | { kind: "tool_end"; toolCallId: string; tool: string; isError: boolean };

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

export interface DoneMessage extends Envelope<"done"> {
  summary: string;
  usage: Usage;
  sessionFile: string;
}

export interface ErrorMessage extends Envelope<"error"> {
  message: string;
  fatal: boolean;
}

// Hub -> agent

export interface WelcomeMessage extends Envelope<"welcome"> {
  config: Record<string, unknown>;
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
  | ErrorMessage
  | PingMessage
  | PongMessage;

export type HubToAgentMessage =
  | WelcomeMessage
  | RejectMessage
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
