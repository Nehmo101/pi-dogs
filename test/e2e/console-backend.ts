/**
 * Minimal real backend for end-to-end runs without the Windows Terminal
 * backend: every dog runs the launcher in its own new console window
 * (`detached: true` on Windows). No tiling, minimize or focus.
 *
 * Loaded by the hub through PI_DOGS_BACKEND_MODULE.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { BackendEvents, OpenSpec, PaneBackend, PaneRef } from "../../src/backend/pane-backend.ts";

export class ConsoleBackend implements PaneBackend {
  readonly name = "console";
  #events: BackendEvents = {};
  readonly #children = new Map<string, ChildProcess>();

  available() {
    return { ok: true as const };
  }

  async open(spec: OpenSpec): Promise<PaneRef> {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, detached: true, stdio: "ignore", windowsHide: false });
    this.#children.set(spec.agentId, child);
    child.on("exit", () => {
      this.#children.delete(spec.agentId);
      this.#events.onClosed?.({ agentId: spec.agentId });
    });
    child.unref();
    return { agentId: spec.agentId };
  }

  async minimize() {}
  async restore() {}
  async focus() {}
  async close() {}
  async relayout() {}

  setEvents(events: BackendEvents) {
    this.#events = events;
  }

  dispose() {
    this.#children.clear();
  }
}

export function createBackend(): PaneBackend {
  return new ConsoleBackend();
}
