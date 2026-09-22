/**
 * The dog's side of the pipe: connect, say hello, keep the connection alive
 * and reconnect with backoff when it drops.
 *
 * A dropped pipe usually means the main pi is reloading (/reload, /new,
 * /resume re-create the hub on the same pipe name), so the client keeps
 * retrying. Only when the hub stays unreachable for `hubGoneGraceMs` (or
 * rejects the dog) does it report the hub as gone.
 *
 * `done` must not get lost across such a gap: `sendReliable` keeps a message
 * and re-sends it after every reconnect until the hub acknowledges it.
 */
import net from "node:net";

import { encodeMessage, JsonlDecoder } from "../protocol/framing.ts";
import type { AgentToHubMessage, HubToAgentMessage, WelcomeMessage } from "../protocol/types.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AgentOutgoing = DistributiveOmit<AgentToHubMessage, "v" | "agentId">;

export interface AgentClientOptions {
  pipe: string;
  agentId: string;
  token: string;
  pid: number;
  piVersion: string;
  /** Every message from the hub except ping/pong and acks. */
  onMessage(message: HubToAgentMessage): void;
  /** Connected and welcomed (first time or after a reconnect). */
  onReady?(welcome: WelcomeMessage): void;
  /** The pipe dropped; the client is retrying. */
  onDisconnected?(): void;
  /** The hub rejected us or stayed unreachable for the grace period. */
  onHubGone(reason: string): void;
  /** 0 = never give up. Updated from the hub's welcome. */
  hubGoneGraceMs?: number;
  backoffMs?: readonly number[];
  /** Treat the connection as dead if the hub sent nothing for this long (the hub pings every 5 s). */
  idleTimeoutMs?: number;
}

const DEFAULT_BACKOFF = [100, 250, 500, 1000, 2000] as const;

export class AgentClient {
  readonly #o: AgentClientOptions;
  #socket: net.Socket | undefined;
  #ready = false;
  #welcomed = false;
  #closed = false;
  #attempt = 0;
  #disconnectedSince: number | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #hubGoneGraceMs: number;
  readonly #reliable = new Map<string, AgentOutgoing>();

  constructor(options: AgentClientOptions) {
    this.#o = options;
    this.#hubGoneGraceMs = options.hubGoneGraceMs ?? 30_000;
  }

  /** Connected and welcomed. */
  get ready(): boolean {
    return this.#ready;
  }

  set hubGoneGraceMs(ms: number) {
    this.#hubGoneGraceMs = ms;
  }

  connect(): void {
    if (this.#closed || this.#socket) return;
    this.#disconnectedSince ??= Date.now();
    const socket = net.connect(this.#o.pipe);
    this.#socket = socket;
    const decoder = new JsonlDecoder();
    socket.on("connect", () => {
      this.#write(socket, {
        type: "hello",
        token: this.#o.token,
        pid: this.#o.pid,
        piVersion: this.#o.piVersion,
        protocol: PROTOCOL_VERSION,
        ...(this.#welcomed ? { reconnect: true } : {}),
      });
      this.#touch();
    });
    socket.on("data", (chunk) => {
      this.#touch();
      for (const result of decoder.push(chunk)) {
        if (!result.ok) continue; // Ignore lines we do not understand; the hub is authoritative.
        this.#handle(socket, result.message as HubToAgentMessage);
      }
    });
    socket.on("error", () => {
      // Followed by "close".
    });
    socket.on("close", () => this.#onClose(socket));
  }

  /** Send if connected; messages sent while disconnected are dropped (state is re-sent on reconnect). */
  send(message: AgentOutgoing): boolean {
    if (!this.#ready || !this.#socket) return false;
    this.#write(this.#socket, message);
    return true;
  }

  /** Send now if possible, and re-send after every reconnect until the hub acks `message.id`. */
  sendReliable(message: AgentOutgoing & { id: string }): void {
    this.#reliable.set(message.id, message);
    this.send(message);
  }

  /** Whether a reliable message is still waiting for its ack. */
  pending(id: string): boolean {
    return this.#reliable.has(id);
  }

  /** Close for good (pi is shutting down). */
  close(): void {
    this.#closed = true;
    this.#ready = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#socket?.end();
    this.#socket = undefined;
  }

  #handle(socket: net.Socket, message: HubToAgentMessage): void {
    switch (message.type) {
      case "ping":
        this.#write(socket, message.id === undefined ? { type: "pong" } : { type: "pong", id: message.id });
        return;
      case "pong":
        return;
      case "reject":
        this.#o.onHubGone(`rejected by the hub: ${message.reason}`);
        this.close();
        return;
      case "welcome":
        this.#ready = true;
        this.#welcomed = true;
        this.#attempt = 0;
        this.#disconnectedSince = undefined;
        this.#hubGoneGraceMs = message.config.hubGoneGraceMs;
        for (const pending of this.#reliable.values()) this.#write(socket, pending);
        this.#o.onReady?.(message);
        this.#o.onMessage(message);
        return;
      case "ack":
        this.#reliable.delete(message.ref);
        this.#o.onMessage(message);
        return;
      default:
        this.#o.onMessage(message);
    }
  }

  #write(socket: net.Socket, message: AgentOutgoing): void {
    if (socket.destroyed) return;
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, agentId: this.#o.agentId, ...message } as AgentToHubMessage));
  }

  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    const socket = this.#socket;
    this.#idleTimer = setTimeout(() => socket?.destroy(), this.#o.idleTimeoutMs ?? 15_000);
    this.#idleTimer.unref();
  }

  #onClose(socket: net.Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    const wasReady = this.#ready;
    this.#ready = false;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#closed) return;
    this.#disconnectedSince ??= Date.now();
    if (wasReady) this.#o.onDisconnected?.();
    const grace = this.#hubGoneGraceMs;
    if (grace > 0 && Date.now() - this.#disconnectedSince >= grace) {
      this.#closed = true;
      this.#o.onHubGone(`the main pi has been unreachable for ${Math.round(grace / 1000)} s`);
      return;
    }
    const backoff = this.#o.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(this.#attempt++, backoff.length - 1)]!;
    this.#retryTimer = setTimeout(() => this.connect(), delay);
  }
}
