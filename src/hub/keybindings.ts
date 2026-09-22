/**
 * `/dogs setup-keys`: free Ctrl+L for the pi-dogs overlay.
 *
 * pi reserves Ctrl+L for `app.model.select`, and extensions cannot override
 * reserved shortcuts (docs/spike/pi-api.md, Q5). The fix is a user
 * keybinding that moves the model selector (and the `/tree` "labeled only"
 * filter, to silence a conflict warning) to Ctrl+Alt+L.
 *
 * This module only computes and writes a *merge*: every other entry in the
 * user's keybindings.json is preserved, and an action the user has already
 * moved away from Ctrl+L is left alone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const KEYBINDINGS_FILE_NAME = "keybindings.json";
export const OVERLAY_KEY = "ctrl+l";
export const REMAP_TARGET = "ctrl+alt+l";

/** Actions that pi binds to Ctrl+L by default. */
export const CTRL_L_ACTIONS = ["app.model.select", "app.tree.filter.labeledOnly"] as const;

type KeyValue = string | string[];
export type KeybindingsFile = Record<string, KeyValue>;

const norm = (key: string) => key.trim().toLowerCase().split("+").sort().join("+");
const keysOf = (value: KeyValue | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const hasKey = (value: KeyValue | undefined, key: string) => keysOf(value).some((k) => norm(k) === norm(key));

export interface MergePlan {
  /** The merged file content. */
  result: KeybindingsFile;
  /** Human-readable description of each change. Empty when nothing needs to change. */
  changes: string[];
  /** Other actions that already use the target key (shown to the user before confirming). */
  conflicts: string[];
}

/**
 * Plan the remap. For each Ctrl+L action: if it is not configured, bind it to
 * the target; if it is configured and still contains Ctrl+L, replace just
 * that key; otherwise keep the user's value.
 */
export function planKeybindingsMerge(existing: KeybindingsFile, target = REMAP_TARGET): MergePlan {
  const result: KeybindingsFile = { ...existing };
  const changes: string[] = [];
  for (const action of CTRL_L_ACTIONS) {
    const current = existing[action];
    if (current === undefined) {
      result[action] = target;
      changes.push(`${action}: ctrl+l (default) -> ${target}`);
    } else if (hasKey(current, OVERLAY_KEY)) {
      const replaced = keysOf(current).map((k) => (norm(k) === norm(OVERLAY_KEY) ? target : k));
      const unique = [...new Set(replaced)];
      result[action] = unique.length === 1 ? unique[0]! : unique;
      changes.push(`${action}: ${JSON.stringify(current)} -> ${JSON.stringify(result[action])}`);
    }
  }
  const conflicts = Object.entries(existing)
    .filter(([action, value]) => !(CTRL_L_ACTIONS as readonly string[]).includes(action) && hasKey(value, target))
    .map(([action]) => action);
  return { result, changes, conflicts };
}

/** Whether Ctrl+L is still taken by `app.model.select` (then an extension cannot use it). */
export function isOverlayKeyReserved(existing: KeybindingsFile): boolean {
  const current = existing["app.model.select"];
  return current === undefined || hasKey(current, OVERLAY_KEY);
}

/** Parse a keybindings file. Throws with a clear message for anything that is not a JSON object of strings/arrays. */
export function parseKeybindings(text: string): KeybindingsFile {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("keybindings.json must contain a JSON object");
  }
  for (const [action, keys] of Object.entries(value)) {
    const ok = typeof keys === "string" || (Array.isArray(keys) && keys.every((k) => typeof k === "string"));
    if (!ok) throw new Error(`keybindings.json: "${action}" must be a key string or an array of key strings`);
  }
  return value as KeybindingsFile;
}

export function keybindingsPath(agentDir: string): string {
  return join(agentDir, KEYBINDINGS_FILE_NAME);
}

/** Read the user's keybindings; a missing file is an empty object. Throws if the file is unreadable or invalid. */
export function readKeybindings(file: string): KeybindingsFile {
  if (!existsSync(file)) return {};
  return parseKeybindings(readFileSync(file, "utf8"));
}

/** Best-effort variant for startup checks: an unreadable file counts as empty. */
export function readKeybindingsOrEmpty(file: string): KeybindingsFile {
  try {
    return readKeybindings(file);
  } catch {
    return {};
  }
}

/** Write atomically (temp file + rename) so a crash never leaves a half-written file. */
export function writeKeybindings(file: string, content: KeybindingsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.pi-dogs-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(content, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}
