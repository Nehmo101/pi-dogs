/**
 * pi-dogs settings: all defaults in one place, plus loading and validation of
 * `<agent-dir>/pi-dogs.json` (default agent dir: `~/.pi/agent`).
 *
 * Unknown keys and values of the wrong type are reported as warnings and
 * replaced by the default, so a typo never prevents pi from starting.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentMode } from "../protocol/types.ts";

export interface ModelsConfig {
  /** Default model pattern for new dogs, e.g. "ollama/qwen3.5:4b". Falls back to the main agent's model. */
  default?: string;
  /** Model pattern per role, e.g. { "review": "*sonnet*" }. Used when a dog is started with `role`. */
  roles: Record<string, string>;
}

export interface PiDogsConfig {
  /** Maximum number of dogs that are not finished yet. */
  maxAgents: number;
  /** Close a dog's window once it has reported its result. */
  closeOnDone: boolean;
  /** Stop all dogs when the main pi quits. When false they keep running on their own. */
  killChildrenOnExit: boolean;
  /** Mode used when the caller does not pass one. */
  defaultMode: AgentMode;
  models: ModelsConfig;
  /** Extra dog names (appended to the built-in list, or replacing it with `dogNamesMode: "replace"`). */
  dogNames: string[];
  dogNamesMode: "append" | "replace";
  /** Shortcut for the mirror overlay. Used only if pi does not bind it itself (see `/dogs setup-keys`). */
  overlayShortcut: string;
  /** Always-available alternative shortcut for the overlay. Empty string disables it. */
  fallbackShortcut: string;
  /** Forward streamed text to the hub ("full") or only tool calls and state ("minimal"). */
  eventDetail: "full" | "minimal";
  /** Give up on a dog that has not connected after this long. */
  helloTimeoutMs: number;
  /** How long a dog keeps trying to reconnect before it assumes the main pi is gone and quits. */
  hubGoneGraceMs: number;
  /** When the main pi quits: how long to wait for dogs to exit after `shutdown` before killing them. */
  quitGraceMs: number;
  /** For `subagent_kill`: how long to wait for a graceful exit before killing the process. */
  killGraceMs: number;
  /** Number of lines kept per dog for the mirror overlay. */
  mirrorLines: number;
  /** Layout preferences, passed through to the window backend (see src/layout/computeLayout.ts). */
  layout: Record<string, unknown>;
}

export const DEFAULT_CONFIG: Readonly<PiDogsConfig> = Object.freeze({
  maxAgents: 6,
  closeOnDone: true,
  killChildrenOnExit: true,
  defaultMode: "autonomous",
  models: Object.freeze({ roles: Object.freeze({}) }) as ModelsConfig,
  dogNames: Object.freeze([]) as unknown as string[],
  dogNamesMode: "append",
  overlayShortcut: "ctrl+l",
  fallbackShortcut: "alt+m",
  eventDetail: "full",
  helloTimeoutMs: 30_000,
  hubGoneGraceMs: 30_000,
  quitGraceMs: 400,
  killGraceMs: 3_000,
  mirrorLines: 400,
  layout: Object.freeze({}) as Record<string, unknown>,
});

export const CONFIG_FILE_NAME = "pi-dogs.json";

export interface LoadedConfig {
  config: PiDogsConfig;
  /** Path that was read, if the file exists. */
  path: string;
  warnings: string[];
}

type Check = (value: unknown) => boolean;

const isPositiveInt: Check = (v) => Number.isInteger(v) && (v as number) > 0;
const isNonNegativeInt: Check = (v) => Number.isInteger(v) && (v as number) >= 0;
const isBool: Check = (v) => typeof v === "boolean";
const isString: Check = (v) => typeof v === "string";
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === "string" && values.includes(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const SCALAR_CHECKS: Partial<Record<keyof PiDogsConfig, [Check, string]>> = {
  maxAgents: [isPositiveInt, "a positive integer"],
  closeOnDone: [isBool, "a boolean"],
  killChildrenOnExit: [isBool, "a boolean"],
  defaultMode: [oneOf("autonomous", "interactive"), '"autonomous" or "interactive"'],
  dogNamesMode: [oneOf("append", "replace"), '"append" or "replace"'],
  overlayShortcut: [isString, "a string"],
  fallbackShortcut: [isString, "a string"],
  eventDetail: [oneOf("full", "minimal"), '"full" or "minimal"'],
  helloTimeoutMs: [isPositiveInt, "a positive integer"],
  hubGoneGraceMs: [isNonNegativeInt, "a non-negative integer"],
  quitGraceMs: [isNonNegativeInt, "a non-negative integer"],
  killGraceMs: [isNonNegativeInt, "a non-negative integer"],
  mirrorLines: [isPositiveInt, "a positive integer"],
};

/** Merge raw (parsed JSON) settings over the defaults. Never throws. */
export function mergeConfig(raw: unknown, defaults: Readonly<PiDogsConfig> = DEFAULT_CONFIG): { config: PiDogsConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: PiDogsConfig = {
    ...defaults,
    models: { ...defaults.models, roles: { ...defaults.models.roles } },
    dogNames: [...defaults.dogNames],
    layout: { ...defaults.layout },
  };
  if (raw === undefined) return { config, warnings };
  if (!isPlainObject(raw)) {
    warnings.push("settings must be a JSON object; using defaults");
    return { config, warnings };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === "$schema") continue;
    if (key === "models") {
      mergeModels(config, value, warnings);
      continue;
    }
    if (key === "dogNames") {
      if (Array.isArray(value) && value.every(isString)) config.dogNames = value as string[];
      else warnings.push('"dogNames" must be an array of strings');
      continue;
    }
    if (key === "layout") {
      if (isPlainObject(value)) config.layout = { ...value };
      else warnings.push('"layout" must be an object');
      continue;
    }
    const check = SCALAR_CHECKS[key as keyof PiDogsConfig];
    if (!check) {
      warnings.push(`unknown setting "${key}"`);
      continue;
    }
    if (check[0](value)) (config as unknown as Record<string, unknown>)[key] = value;
    else warnings.push(`"${key}" must be ${check[1]}; using ${JSON.stringify(defaults[key as keyof PiDogsConfig])}`);
  }
  return { config, warnings };
}

function mergeModels(config: PiDogsConfig, value: unknown, warnings: string[]): void {
  if (!isPlainObject(value)) {
    warnings.push('"models" must be an object');
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === "default") {
      if (typeof v === "string" && v.trim()) config.models.default = v.trim();
      else if (v !== undefined && v !== null) warnings.push('"models.default" must be a non-empty string');
    } else if (key === "roles") {
      if (!isPlainObject(v)) {
        warnings.push('"models.roles" must be an object');
        continue;
      }
      for (const [role, pattern] of Object.entries(v)) {
        if (typeof pattern === "string" && pattern.trim()) config.models.roles[role.toLowerCase()] = pattern.trim();
        else warnings.push(`"models.roles.${role}" must be a non-empty string`);
      }
    } else {
      warnings.push(`unknown setting "models.${key}"`);
    }
  }
}

/** Read `<agentDir>/pi-dogs.json`. A missing file yields the defaults; a broken file yields defaults plus a warning. */
export function loadConfig(agentDir: string): LoadedConfig {
  const path = join(agentDir, CONFIG_FILE_NAME);
  if (!existsSync(path)) return { path, ...mergeConfig(undefined) };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    const { config } = mergeConfig(undefined);
    return { path, config, warnings: [`could not read ${path}: ${(err as Error).message}; using defaults`] };
  }
  return { path, ...mergeConfig(raw) };
}
