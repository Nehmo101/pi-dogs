/**
 * Files exchanged outside the pipe (docs/protocol.md, "Launch and exit files").
 *
 * - The **launch file** is written by the hub and names everything a dog
 *   needs to start and connect. The launcher reads it to start pi; the agent
 *   extension reads it in `session_start` and deletes it, because it holds
 *   the dog's one-time pipe token.
 * - The **exit file** is written by the launcher when pi ends. It is the
 *   fallback signal for crashes, when the pipe closes without `done`.
 *
 * `src/launcher/launcher.mjs` is plain JavaScript (it must run without type
 * stripping) and mirrors the exit-file format; keep both in sync.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROTOCOL_VERSION } from "./version.ts";

export interface LaunchFile {
  v: typeof PROTOCOL_VERSION;
  agentId: string;
  /** Display name. */
  name: string;
  /** Named pipe path of the hub. */
  pipe: string;
  /** One-time token the agent presents in `hello`. */
  token: string;
  /** Working directory for pi. */
  cwd: string;
  /** Where the launcher writes the exit file. */
  exitFile: string;
  /** How to start pi: executable plus leading arguments (e.g. node + cli.js), then `args`. */
  pi: { command: string; args: string[] };
  /** Extra environment variables for the pi process. */
  env: Record<string, string>;
}

export interface ExitFile {
  /** pi's exit code, or null if it was ended by a signal. */
  code: number | null;
  signal: string | null;
  /** ISO timestamp. */
  endedAt: string;
  /** Set when pi could not be started at all. */
  error?: string;
}

/** Environment variable the launcher sets for pi so the hub extension stays inactive inside a dog. */
export const AGENT_ENV_VAR = "PI_DOGS_AGENT_ID";

/** Stable pipe name for a hub: one per main pi process, so it survives /reload, /new and /resume. */
export function pipeNameForPid(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\pi-dogs-${pid}` : join(tmpdir(), `pi-dogs-${pid}.sock`);
}

/** Root directory for per-dog runtime files of one hub. */
export function runRootForPid(pid: number, base: string = tmpdir()): string {
  return join(base, "pi-dogs", String(pid));
}

export function writeLaunchFile(path: string, launch: LaunchFile): void {
  writeFileSync(path, JSON.stringify(launch, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Validate a parsed launch file. Throws with the first problem found. */
export function validateLaunchFile(value: unknown): LaunchFile {
  if (typeof value !== "object" || value === null) throw new Error("launch file must contain a JSON object");
  const v = value as Record<string, unknown>;
  if (v.v !== PROTOCOL_VERSION) throw new Error(`unsupported launch file version ${JSON.stringify(v.v)}`);
  for (const key of ["agentId", "name", "pipe", "token", "cwd", "exitFile"]) {
    if (typeof v[key] !== "string" || v[key] === "") throw new Error(`launch file: "${key}" must be a non-empty string`);
  }
  const pi = v.pi as Record<string, unknown> | undefined;
  if (!pi || typeof pi.command !== "string" || !Array.isArray(pi.args) || !pi.args.every((a) => typeof a === "string")) {
    throw new Error('launch file: "pi" must be { command: string, args: string[] }');
  }
  if (!isStringRecord(v.env)) throw new Error('launch file: "env" must map names to strings');
  return value as LaunchFile;
}

/** Read, validate and delete the launch file (it contains the token). The file is deleted even if invalid. */
export function consumeLaunchFile(path: string): LaunchFile {
  try {
    return validateLaunchFile(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
  } finally {
    rmSync(path, { force: true });
  }
}

/** Read the exit file if the launcher has written it; undefined if absent or unreadable. */
export function readExitFile(path: string): ExitFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ExitFile>;
    if (typeof value !== "object" || value === null) return undefined;
    const exit: ExitFile = {
      code: typeof value.code === "number" ? value.code : null,
      signal: typeof value.signal === "string" ? value.signal : null,
      endedAt: typeof value.endedAt === "string" ? value.endedAt : new Date(0).toISOString(),
    };
    if (typeof value.error === "string") exit.error = value.error;
    return exit;
  } catch {
    return undefined;
  }
}

/** Short description of an exit, e.g. "exit code 1" or "signal SIGTERM". */
export function describeExit(exit: ExitFile): string {
  if (exit.error) return `could not start pi: ${exit.error}`;
  if (exit.signal) return `ended by signal ${exit.signal}`;
  return `exit code ${exit.code ?? "unknown"}`;
}
