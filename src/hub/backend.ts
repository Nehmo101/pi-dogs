/**
 * Choosing the window backend.
 *
 * The default is the Windows Terminal backend (one tiled WT window per dog).
 * `PI_DOGS_BACKEND_MODULE` may point to a module exporting
 * `createBackend(config)`; the end-to-end tests use it to run dogs in plain
 * console windows, and it is the hook for experimenting with other terminals.
 *
 * The backend instance is kept across `/reload` (see index.ts): it owns
 * native window handles that the next hub runtime still needs.
 */
import { pathToFileURL } from "node:url";

import type { PaneBackend } from "../backend/pane-backend.ts";
import type { LayoutPrefs } from "../layout/computeLayout.ts";
import type { PiDogsConfig } from "./config.ts";
import { debugLog } from "./log.ts";

export const BACKEND_MODULE_ENV = "PI_DOGS_BACKEND_MODULE";

export interface BackendModule {
  createBackend(config: PiDogsConfig): PaneBackend | Promise<PaneBackend>;
}

export async function createBackend(config: PiDogsConfig, env: NodeJS.ProcessEnv = process.env): Promise<PaneBackend> {
  const custom = env[BACKEND_MODULE_ENV];
  if (custom) {
    const mod = (await import(pathToFileURL(custom).href)) as Partial<BackendModule>;
    if (typeof mod.createBackend !== "function") throw new Error(`${custom} does not export createBackend(config)`);
    return mod.createBackend(config);
  }
  const { WindowsTerminalBackend } = await import("../backend/windows-terminal/index.ts");
  return new WindowsTerminalBackend({ prefs: config.layout as Partial<LayoutPrefs>, log: (message) => debugLog(`wt: ${message}`) });
}
