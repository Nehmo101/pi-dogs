/**
 * A simulated dog for integration tests: reads the launch file like the
 * agent extension does and talks to the hub through the real AgentClient.
 */
import { AgentClient, type AgentOutgoing } from "../../src/agent/client.ts";
import { consumeLaunchFile, type LaunchFile } from "../../src/protocol/launch.ts";
import type { HubToAgentMessage } from "../../src/protocol/types.ts";

export interface SimAgentOptions {
  pid?: number;
  /** Override the token from the launch file (to test rejection). */
  token?: string;
  /** Answer `shutdown` like pi does: bye, then disconnect. Default true. */
  obeyShutdown?: boolean;
  backoffMs?: number[];
}

export class SimAgent {
  readonly launch: LaunchFile;
  readonly received: HubToAgentMessage[] = [];
  readonly client: AgentClient;
  hubGone: string | undefined;
  #waiters: Array<{ match: (m: HubToAgentMessage) => boolean; resolve: (m: HubToAgentMessage) => void }> = [];

  constructor(launchFile: string, options: SimAgentOptions = {}) {
    this.launch = consumeLaunchFile(launchFile);
    this.client = new AgentClient({
      pipe: this.launch.pipe,
      agentId: this.launch.agentId,
      token: options.token ?? this.launch.token,
      pid: options.pid ?? process.pid,
      piVersion: "0.0.0-test",
      backoffMs: options.backoffMs ?? [20, 40, 80],
      onMessage: (m) => {
        this.received.push(m);
        if (m.type === "shutdown" && options.obeyShutdown !== false) {
          this.send({ type: "bye", reason: "quit" });
          setTimeout(() => this.client.close(), 5);
        }
        this.#waiters = this.#waiters.filter((w) => {
          if (!w.match(m)) return true;
          w.resolve(m);
          return false;
        });
      },
      onHubGone: (reason) => {
        this.hubGone = reason;
      },
    });
  }

  connect(): this {
    this.client.connect();
    return this;
  }

  send(message: AgentOutgoing): boolean {
    return this.client.send(message);
  }

  /** Resolve with the first message (already received or future) of this type. */
  next<T extends HubToAgentMessage["type"]>(type: T, timeoutMs = 2000, skip = 0): Promise<Extract<HubToAgentMessage, { type: T }>> {
    const seen = this.received.filter((m) => m.type === type);
    if (seen.length > skip) return Promise.resolve(seen[skip] as Extract<HubToAgentMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      let count = seen.length;
      this.#waiters.push({
        match: (m) => m.type === type && count++ >= skip,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<HubToAgentMessage, { type: T }>);
        },
      });
    });
  }

  close(): void {
    this.client.close();
  }
}

/** Poll until `predicate` is true. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
