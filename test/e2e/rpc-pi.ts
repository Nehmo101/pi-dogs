/**
 * Runs a real pi in RPC mode for end-to-end tests and collects its events.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** pi's CLI script: the linked package in node_modules (npm run typecheck links it) or $PI_DOGS_PI_DIR. */
export function piCliPath(): string {
  const dir = process.env.PI_DOGS_PI_DIR ?? join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkgFile = join(dir, "package.json");
  if (!existsSync(pkgFile)) throw new Error(`pi not found at ${dir}; run "node scripts/link-pi.mjs" or set PI_DOGS_PI_DIR`);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error("pi package has no bin entry");
  return join(dir, bin);
}

export type RpcEvent = Record<string, unknown> & { type: string };

export class RpcPi {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: RpcEvent[] = [];
  stderr = "";
  #waiters: Array<{ match: (e: RpcEvent) => boolean; resolve: (e: RpcEvent) => void }> = [];
  #nextId = 0;

  constructor(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(process.execPath, [piCliPath(), "--mode", "rpc", ...args], { cwd: options.cwd, env: options.env });
    // Split on LF only, never on U+2028/U+2029 (no readline), as the RPC docs require.
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let event: RpcEvent;
        try {
          event = JSON.parse(line) as RpcEvent;
        } catch {
          continue;
        }
        this.events.push(event);
        this.#waiters = this.#waiters.filter((w) => {
          if (!w.match(event)) return true;
          w.resolve(event);
          return false;
        });
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c: string) => (this.stderr += c));
  }

  send(command: Record<string, unknown>): string {
    const id = `e2e-${++this.#nextId}`;
    this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    return id;
  }

  /** Send a command and wait for its response. */
  async command(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcEvent> {
    const id = this.send(command);
    return this.waitFor((e) => e.type === "response" && e.id === id, timeoutMs, `response to ${String(command.type)}`);
  }

  waitFor(match: (e: RpcEvent) => boolean, timeoutMs: number, what: string): Promise<RpcEvent> {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}\nstderr:\n${this.stderr.slice(-2000)}`)), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  /** Close stdin (orderly quit) and wait for the process to exit. */
  async quit(timeoutMs = 20_000): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    const exited = new Promise<number | null>((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), timeoutMs);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }
}
