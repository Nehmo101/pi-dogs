/**
 * Opt-in debug log for troubleshooting: set `PI_DOGS_DEBUG=1` to write to
 * `%TEMP%\pi-dogs\debug.log`, or `PI_DOGS_DEBUG=<path>` to choose the file.
 * Never throws; logging must not break the hub.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function target(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.PI_DOGS_DEBUG;
  if (!value || value === "0") return undefined;
  return value === "1" ? join(tmpdir(), "pi-dogs", "debug.log") : value;
}

export function debugLog(message: string): void {
  const file = target();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}\n`, "utf8");
  } catch {
    // Ignore: debugging aid only.
  }
}
