/**
 * The hub's named-pipe server: framing, authentication gate and keep-alive.
 *
 * The server knows nothing about dogs. It hands every decoded message to the
 * hub, and only after the hub accepted a connection's `hello` are other
 * message types delivered for it. A connection that does not say hello in
 * time, sends garbage, or stops answering pings is closed.
 */
import net from "node:net";

import { encodeMessage, JsonlDecoder } from "../protocol/framing.ts";
import type { AgentToHubMessage, HelloMessage, HubToAgentMessage } from "../protocol/types.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";
import { debugLog } from "./log.ts";

/** Hub-to-agent message without the envelope fields the connection fills in. */
export type Outgoing = DistributiveOmit<HubToAgentMessage, "v" | "agentId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface ServerOptions {
  pipe: string;
  /** Decide on a `hello`; return a reason string to reject it. */
  onHello(conn: Connection, hello: HelloMessage): true | { reject: string; hubSecret?: string };
  onMessage(conn: Connection, message: AgentToHubMessage): void;
  /** An authenticated connection closed (for any reason). */
  onClose(conn: Connection, reason: string): void;
  onError?(error: Error): void;
  pingIntervalMs?: number;
  /** Close a connection that sent nothing for this long. */
  idleTimeoutMs?: number;
  /** Close a connection that has not said hello after this long. */
  helloTimeoutMs?: number;
}

export class Connection {
  /** Set once the hub accepted this connection's hello. */
  agentId: string | undefined;
  lastSeen = Date.now();
  readonly #socket: net.Socket;
  #closed = false;
  #closeReason = "closed";

  constructor(socket: net.Socket) {
    this.#socket = socket;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): string {
    return this.#closeReason;
  }

  send(message: Outgoing, agentId = this.agentId ?? "?"): boolean {
    if (this.#closed || this.#socket.destroyed) return false;
    const full = { v: PROTOCOL_VERSION, agentId, ...message } as HubToAgentMessage;
    let line: string;
    try {
      line = encodeMessage(full);
    } catch (err) {
      // Too long to frame: never let it throw into a pipe handler (it would end the main pi).
      debugLog(`not sent to ${agentId}: ${(err as Error).message}`);
      return false;
    }
    this.#socket.write(line);
    return true;
  }

  /** Close after flushing pending writes. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closeReason = reason;
    this.#socket.end();
    // Do not wait forever for a peer that stopped reading.
    setTimeout(() => this.#socket.destroy(), 1000).unref();
  }

  destroy(reason: string): void {
    this.#closeReason = reason;
    this.#socket.destroy();
  }

  /** @internal */
  markClosed(): void {
    this.#closed = true;
  }
}

export class PipeServer {
  readonly #options: Required<Omit<ServerOptions, "onError">> & Pick<ServerOptions, "onError">;
  readonly #connections = new Set<Connection>();
  #server: net.Server | undefined;
  #pingTimer: NodeJS.Timeout | undefined;

  constructor(options: ServerOptions) {
    this.#options = { pingIntervalMs: 5_000, idleTimeoutMs: 15_000, helloTimeoutMs: 10_000, ...options };
  }

  get pipe(): string {
    return this.#options.pipe;
  }

  /** Authenticated connections. */
  get connections(): Connection[] {
    return [...this.#connections].filter((c) => c.agentId !== undefined && !c.closed);
  }

  /**
   * Start listening. Retries for a moment on EADDRINUSE: after a `/reload`
   * the previous runtime's server may still be releasing the same pipe name.
   */
  async listen(retries = 20, delayMs = 100): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#listenOnce();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.#pingTimer = setInterval(() => this.#keepAlive(), this.#options.pingIntervalMs);
    this.#pingTimer.unref();
  }

  #listenOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#accept(socket));
      const onError = (err: Error) => {
        server.close();
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.#options.pipe, () => {
        server.off("error", onError);
        server.on("error", (err) => this.#options.onError?.(err));
        this.#server = server;
        resolve();
      });
    });
  }

  /** Stop listening and drop every connection. Idempotent. */
  async close(): Promise<void> {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    for (const conn of this.#connections) conn.destroy("hub closing");
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #accept(socket: net.Socket): void {
    const conn = new Connection(socket);
    this.#connections.add(conn);
    const decoder = new JsonlDecoder();
    const helloTimer = setTimeout(() => {
      if (conn.agentId === undefined) conn.destroy("no hello");
    }, this.#options.helloTimeoutMs);
    helloTimer.unref();

    socket.on("data", (chunk) => {
      // An exception escaping a socket handler reaches pi's uncaughtException
      // handler, which ends the main pi. Contain it to this connection.
      try {
        this.#onData(conn, decoder, chunk, helloTimer);
      } catch (err) {
        debugLog(`pipe handler failed for ${conn.agentId ?? "?"}: ${(err as Error).stack ?? String(err)}`);
        this.#options.onError?.(new Error(`internal error while handling a message: ${(err as Error).message}`));
        conn.destroy(`internal error: ${(err as Error).message}`);
      }
    });
    socket.on("error", () => {
      // Reported through "close"; pipe errors are routine when a dog exits.
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      conn.markClosed();
      this.#connections.delete(conn);
      if (conn.agentId === undefined) return;
      try {
        this.#options.onClose(conn, conn.closeReason);
      } catch (err) {
        debugLog(`close handler failed for ${conn.agentId}: ${(err as Error).stack ?? String(err)}`);
      }
    });
  }

  #onData(conn: Connection, decoder: JsonlDecoder, chunk: Buffer, helloTimer: NodeJS.Timeout): void {
    conn.lastSeen = Date.now();
    for (const result of decoder.push(chunk)) {
      if (!result.ok) {
        // A peer that speaks garbage is either broken or not ours.
        conn.destroy(`protocol error: ${result.error.message}`);
        return;
      }
      const message = result.message as AgentToHubMessage;
      if (conn.agentId === undefined) {
        if (message.type !== "hello") {
          conn.destroy(`expected hello, got ${message.type}`);
          return;
        }
        const verdict = this.#options.onHello(conn, message);
        if (verdict === true) {
          conn.agentId = message.agentId;
          clearTimeout(helloTimer);
        } else {
          conn.send({ type: "reject", reason: verdict.reject, ...(verdict.hubSecret ? { hubSecret: verdict.hubSecret } : {}) }, message.agentId);
          conn.close(`rejected: ${verdict.reject}`);
        }
        continue;
      }
      if (message.agentId !== conn.agentId) {
        conn.destroy("agentId mismatch");
        return;
      }
      if (message.type === "ping") {
        conn.send(message.id === undefined ? { type: "pong" } : { type: "pong", id: message.id });
        continue;
      }
      if (message.type === "pong") continue;
      this.#options.onMessage(conn, message);
    }
  }

  #keepAlive(): void {
    const now = Date.now();
    for (const conn of this.connections) {
      if (now - conn.lastSeen > this.#options.idleTimeoutMs) conn.destroy("ping timeout");
      else conn.send({ type: "ping" });
    }
  }
}
