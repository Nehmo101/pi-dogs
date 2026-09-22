/**
 * Process helpers. Dog windows are not child processes of the main pi (they
 * belong to the terminal), so the hub works with the pi PID from `hello`.
 */
import { execFile } from "node:child_process";

/** Whether a process with this PID exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Forcefully end a process and its descendants. On Windows this is
 * `taskkill /PID <pid> /T /F`. Only the dog's pi is killed, not its launcher,
 * so the launcher still records the exit and closes its window with code 0.
 */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!isPidAlive(pid)) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    resolve();
  });
}
