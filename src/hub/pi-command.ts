/**
 * How the hub starts a dog's pi: which executable, and with which arguments.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";

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
  /** Trust project-local resources, when the main pi already trusts them. */
  approve?: boolean;
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
  if (o.approve) args.push("--approve");
  return args;
}
