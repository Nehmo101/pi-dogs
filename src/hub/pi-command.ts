/**
 * How the hub starts a dog's pi: which executable, and with which arguments.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface PiCommand {
  command: string;
  /** Leading arguments, e.g. the pi CLI script when `command` is node. */
  args: string[];
}

/**
 * Start dogs with the same pi installation as the main pi. Inside pi,
 * `process.execPath` is node and `process.argv[1]` is pi's CLI script, so the
 * dog runs `node <cli.js>` directly: no `pi.cmd` shim, no cmd.exe quoting.
 * For a single-file pi binary (execPath is pi itself) that binary is used.
 * Falls back to "pi" from PATH, which the launcher resolves.
 */
export function currentPiCommand(execPath = process.execPath, argv1: string | undefined = process.argv[1]): PiCommand {
  const exe = basename(execPath).toLowerCase();
  const isNode = exe === "node" || exe === "node.exe";
  if (!isNode && /^pi(\.exe)?$/.test(exe)) return { command: execPath, args: [] };
  if (isNode && argv1 && /\.(c|m)?js$/.test(argv1) && existsSync(argv1)) return { command: execPath, args: [argv1] };
  return { command: "pi", args: [] };
}

export interface PiArgsOptions {
  /** Path of the agent extension (src/agent/index.ts). */
  agentExtension: string;
  launchFile: string;
  sessionFile: string;
  /** `provider/id` */
  model?: string | undefined;
  thinking?: string | undefined;
  /** Tool allowlist; `subagent_done` is always added. */
  tools?: readonly string[] | undefined;
  /** Session display name (also makes pi's terminal title show the dog's name). */
  name: string;
  /**
   * Project trust: true passes `--approve`, false `--no-approve` (either way
   * pi never shows its trust prompt), undefined leaves the decision to pi.
   */
  approve?: boolean | undefined;
  /** Extra arguments appended last (see `inheritedDogArgs`). */
  extraArgs?: readonly string[] | undefined;
}

/**
 * Flags of the main pi that dogs inherit, so a dog behaves like the session
 * that started it. Currently only bash-guard's opt-out: a user who starts pi
 * with `--bash-guard-disabled` gets dogs without confirmation prompts too
 * (bash-guard's hard-block floor still applies in the dogs).
 */
export const INHERITED_FLAGS = ["--bash-guard-disabled"] as const;

export function inheritedDogArgs(mainArgv: readonly string[] = process.argv): string[] {
  return INHERITED_FLAGS.filter((flag) => mainArgv.includes(flag));
}

/**
 * Project trust for a dog's pi, chosen so that the dog never sits at pi's
 * "Trust project folder?" prompt (it would miss the hub's hello timeout) and
 * never gets more trust than the user gave:
 *
 * - same folder as the main pi: the main pi's decision (`--approve` / `--no-approve`);
 * - another folder without project resources: undefined (pi does not ask);
 * - another folder with a remembered decision: that decision;
 * - otherwise: false (`--no-approve`, project-local resources stay off).
 */
export function dogProjectTrust(o: {
  cwd: string;
  mainCwd: string;
  mainTrusted: boolean;
  /** pi's hasTrustRequiringProjectResources. */
  needsTrust: (cwd: string) => boolean;
  /** pi's ProjectTrustStore.get: true, false, or null when nothing is remembered. */
  storedDecision: (cwd: string) => boolean | null;
}): boolean | undefined {
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(resolve(o.cwd), resolve(o.mainCwd))) return o.mainTrusted;
  try {
    if (!o.needsTrust(o.cwd)) return undefined;
    return o.storedDecision(o.cwd) ?? false;
  } catch {
    return false;
  }
}

/** Command-line arguments for a dog's pi. The task is never passed here (it would look like typed input). */
export function buildPiArgs(o: PiArgsOptions): string[] {
  const args = ["--session", o.sessionFile, "-e", o.agentExtension, `--pi-dogs-launch=${o.launchFile}`, "--name", o.name];
  if (o.model) args.push("--model", o.model);
  if (o.thinking) args.push("--thinking", o.thinking);
  if (o.tools && o.tools.length > 0) {
    const tools = [...new Set([...o.tools.map((t) => t.trim()).filter(Boolean), "subagent_done"])];
    args.push("--tools", tools.join(","));
  }
  if (o.approve === true) args.push("--approve");
  else if (o.approve === false) args.push("--no-approve");
  if (o.extraArgs) args.push(...o.extraArgs);
  return args;
}
