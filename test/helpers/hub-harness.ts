/**
 * Builds a Hub wired to a FakeBackend and a recording host, on a unique
 * pipe and temp directory, with short timeouts for fast tests.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeConfig, type PiDogsConfig } from "../../src/hub/config.ts";
import { Hub, type HubHost, type HubOptions, type SpawnRequest } from "../../src/hub/hub.ts";
import type { Registry } from "../../src/hub/registry.ts";
import { pipeNameForPid } from "../../src/protocol/launch.ts";
import { FakeBackend } from "./fake-backend.ts";

export interface SentMessage {
  customType: string;
  content: string;
  details: unknown;
  triggerTurn: boolean;
}

export class RecordingHost implements HubHost {
  readonly sent: SentMessage[] = [];
  readonly notes: { text: string; level: string }[] = [];
  changes = 0;
  sendToMain(message: { customType: string; content: string; details: unknown }, options: { triggerTurn: boolean }) {
    this.sent.push({ ...message, triggerTurn: options.triggerTurn });
  }
  notify(text: string, level: string) {
    this.notes.push({ text, level });
  }
  changed() {
    this.changes++;
  }
}

export interface Harness {
  hub: Hub;
  host: RecordingHost;
  backend: FakeBackend;
  dir: string;
  pipe: string;
  config: PiDogsConfig;
  spawn(overrides?: Partial<SpawnRequest>): ReturnType<Hub["spawn"]>;
  /** Launch file path for the most recently opened window. */
  lastLaunchFile(): string;
  cleanup(): Promise<void>;
}

export function uniquePipe(): string {
  return pipeNameForPid(process.pid).replace(/(\d+)(\.sock)?$/, (_m, pid: string, ext = "") => `${pid}-${randomBytes(3).toString("hex")}${ext}`);
}

export async function createHarness(
  options: { config?: Record<string, unknown>; hub?: Partial<HubOptions>; registry?: Registry; pipe?: string; dir?: string; backend?: FakeBackend; host?: RecordingHost } = {},
): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pi-dogs-test-"));
  const pipe = options.pipe ?? uniquePipe();
  const { config } = mergeConfig({ helloTimeoutMs: 2000, killGraceMs: 300, quitGraceMs: 200, hubGoneGraceMs: 5000, ...options.config });
  const backend = options.backend ?? new FakeBackend();
  const host = options.host ?? new RecordingHost();
  const hub = new Hub({
    pipe,
    runRoot: join(dir, "run"),
    agentExtension: join(dir, "agent.ts"),
    launcher: join(dir, "launcher.mjs"),
    nodePath: process.execPath,
    piCommand: { command: "pi", args: [] },
    backend,
    config,
    host,
    pollMs: 20,
    exitFileGraceMs: 150,
    pingIntervalMs: 200,
    idleTimeoutMs: 1000,
    ...(options.registry ? { registry: options.registry } : {}),
    ...options.hub,
  });
  await hub.start();
  return {
    hub,
    host,
    backend,
    dir,
    pipe,
    config,
    spawn: (overrides = {}) =>
      hub.spawn({ task: "Find the answer", context: "Test context", cwd: dir, sessionDir: join(dir, "sessions"), model: "test/model", ...overrides }),
    lastLaunchFile: () => backend.opened[backend.opened.length - 1]!.args[1]!,
    cleanup: async () => {
      await hub.stop("reload");
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
