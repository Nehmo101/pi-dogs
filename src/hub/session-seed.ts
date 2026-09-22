/**
 * Prepare a dog's session file before its pi starts (docs/spike/pi-api.md, Q8).
 *
 * The file holds a v3 session header plus one `custom_message` entry with the
 * context summary written by the calling model. The message is part of the
 * LLM context but, unlike a fake user message, it does not trigger pi's
 * `input` event (no false takeover) and is clearly marked as injected.
 *
 * With `fork`, the entries of the main agent's active branch are copied
 * first, cut before its last user message (that turn is the one that is
 * spawning the dog, and its tool call has no result yet). Adapted from
 * `seedSubagentSessionFile` in HazAT/pi-interactive-subagents (MIT, see NOTICE).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONTEXT_MESSAGE_TYPE = "pi-dogs-context";

/** Minimal shape of a session entry as found in pi session files. */
export interface SeedEntry {
  type: string;
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface SeedOptions {
  file: string;
  cwd: string;
  /** Context summary written by the caller (required by the `subagent` tool). */
  context: string;
  /** Main agent's session file, recorded as `parentSession`. */
  parentSession?: string | undefined;
  /** Main agent's active branch (root to leaf) to copy for `fork`. */
  forkEntries?: readonly SeedEntry[] | undefined;
  /** Dog identity, shown in the context message. */
  name: string;
  /** How the dog is expected to finish (changes the instructions). */
  mode?: "autonomous" | "interactive";
  now?: Date;
}

/** Entries to copy for a fork: everything before the last user message, without session headers. */
export function forkableEntries(branch: readonly SeedEntry[]): SeedEntry[] {
  let cut = branch.length;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    const message = entry.message as { role?: unknown } | undefined;
    if (entry.type === "message" && message?.role === "user") {
      cut = i;
      break;
    }
  }
  return branch.slice(0, cut).filter((e) => e.type !== "session");
}

export function buildContextText(name: string, context: string, mode: "autonomous" | "interactive" = "autonomous"): string {
  const finish =
    mode === "autonomous"
      ? ["Work on the task you receive next. When you are finished, call the `subagent_done` tool", "with a concise summary of your result; the summary is returned to the main agent."]
      : ["Work on the task you receive next. A human may join you in this window. When the work is", "complete, call `subagent_done` with a concise summary; it is returned to the main agent."];
  return [
    `You are "${name}", a sub agent started by the main pi agent (pi-dogs).`,
    ...finish,
    "",
    "Context from the main agent:",
    context.trim() || "(none given)",
  ].join("\n");
}

/** Session file name in pi's convention: `<timestamp>_<uuid>.jsonl`. */
export function sessionFileName(now: Date, id: string): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

export function defaultSessionFile(sessionDir: string, now = new Date()): { file: string; id: string } {
  const id = randomUUID();
  return { file: join(sessionDir, sessionFileName(now, id)), id };
}

/** Write the seeded session file and return the entries written (header first). */
export function seedSessionFile(options: SeedOptions, sessionId: string = randomUUID()): SeedEntry[] {
  const now = options.now ?? new Date();
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: now.toISOString(),
    cwd: options.cwd,
  };
  if (options.parentSession) header.parentSession = options.parentSession;

  const copied = options.forkEntries ? forkableEntries(options.forkEntries) : [];
  const contextEntry: SeedEntry = {
    type: "custom_message",
    id: randomBytes(4).toString("hex"),
    parentId: copied.length ? copied[copied.length - 1]!.id : null,
    timestamp: now.toISOString(),
    customType: CONTEXT_MESSAGE_TYPE,
    display: true,
    content: buildContextText(options.name, options.context, options.mode),
  };
  const entries = [header as SeedEntry, ...copied, contextEntry];
  mkdirSync(dirname(options.file), { recursive: true });
  writeFileSync(options.file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return entries;
}
