/**
 * Session-scoped glue between pi and the hub core: owns the Hub for the
 * current extension runtime, the UI (dock, overlay), and the state that
 * must survive a `/reload` (kept on globalThis, see `carryOver`).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PaneBackend } from "../backend/pane-backend.ts";
import { pipeNameForPid, runRootForPid } from "../protocol/launch.ts";
import { createBackend } from "./backend.ts";
import type { PiDogsConfig } from "./config.ts";
import { Hub, type HubHost } from "./hub.ts";
import { modelRef as refOf, type ModelInfo } from "./models.ts";
import { currentPiCommand } from "./pi-command.ts";
import { isPidAlive } from "./process.ts";
import { Registry, type RegistrySnapshot } from "./registry.ts";
import { DockComponent } from "./ui/dock.ts";
import { MirrorOverlay } from "./ui/overlay.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_EXTENSION_PATH = join(here, "..", "agent", "index.ts");
export const LAUNCHER_PATH = join(here, "..", "launcher", "launcher.mjs");

const WIDGET_KEY = "pi-dogs";
const UI_THROTTLE_MS = 100;

/** State that outlives one extension runtime (module state is lost on /reload). */
interface CarryOver {
  backend?: PaneBackend;
  snapshot?: RegistrySnapshot;
  sessionDefaultModel?: string | undefined;
  sessionRoles?: Record<string, string>;
}

const CARRY_KEY = Symbol.for("pi-dogs.carry-over.v1");

function carryOver(): CarryOver {
  const g = globalThis as unknown as Record<symbol, CarryOver | undefined>;
  return (g[CARRY_KEY] ??= {});
}

/** Unavailable backend used when the real one cannot even be created; spawning then fails with the hint. */
function unavailableBackend(hint: string): PaneBackend {
  const fail = async () => {
    throw new Error(hint);
  };
  return {
    name: "unavailable",
    available: () => ({ ok: false, hint }),
    open: fail,
    minimize: fail,
    restore: fail,
    focus: fail,
    close: async () => undefined,
    relayout: async () => undefined,
    setEvents: () => undefined,
    dispose: () => undefined,
  };
}

export class HubRuntime {
  readonly pi: ExtensionAPI;
  readonly config: PiDogsConfig;
  readonly agentDir: string;
  hub: Hub | undefined;
  ctx: ExtensionContext | undefined;
  /** Shortcut shown in the dock header. */
  overlayHint: string | undefined;
  #dockTui: { requestRender(): void } | undefined;
  #overlayTui: { requestRender(): void } | undefined;
  #overlayOpen = false;
  #uiTimer: NodeJS.Timeout | undefined;
  #tick: NodeJS.Timeout | undefined;
  #startError: string | undefined;

  constructor(pi: ExtensionAPI, config: PiDogsConfig, agentDir: string) {
    this.pi = pi;
    this.config = config;
    this.agentDir = agentDir;
  }

  get startError(): string | undefined {
    return this.#startError;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    removeStaleRunRoots();
    const carry = carryOver();
    let backend = carry.backend;
    if (!backend) {
      try {
        backend = await createBackend(this.config);
      } catch (err) {
        backend = unavailableBackend(`pi-dogs could not load its window backend: ${(err as Error).message}`);
      }
      carry.backend = backend;
    }
    const registry = carry.snapshot ? Registry.restore(carry.snapshot, { mirrorLimit: this.config.mirrorLines }) : undefined;
    delete carry.snapshot;

    const hub = new Hub({
      pipe: pipeNameForPid(process.pid),
      runRoot: runRootForPid(process.pid),
      agentExtension: AGENT_EXTENSION_PATH,
      launcher: LAUNCHER_PATH,
      nodePath: process.execPath,
      piCommand: currentPiCommand(),
      backend,
      config: this.config,
      host: this.#host(),
      ...(registry ? { registry } : {}),
    });
    hub.sessionDefaultModel = carry.sessionDefaultModel;
    Object.assign(hub.sessionRoles, carry.sessionRoles ?? {});
    try {
      await hub.start();
      this.hub = hub;
      this.#startError = undefined;
    } catch (err) {
      this.#startError = `pi-dogs could not listen on ${hub.pipe}: ${(err as Error).message}`;
      this.notify(this.#startError, "error");
      return;
    }
    this.#installDock(ctx);
    this.#tick = setInterval(() => {
      if (this.hub?.registry.live().length) this.#render();
    }, 1000);
    this.#tick.unref();
  }

  /** On "quit": stop dogs and dispose the backend. Otherwise hand state to the next runtime. */
  async stop(reason: string): Promise<void> {
    if (this.#tick) clearInterval(this.#tick);
    if (this.#uiTimer) clearTimeout(this.#uiTimer);
    const carry = carryOver();
    const hub = this.hub;
    this.hub = undefined;
    if (!hub) return;
    if (reason === "quit") {
      await hub.stop("quit");
      carry.backend?.dispose();
      delete carry.backend;
      delete carry.snapshot;
      rmSync(runRootForPid(process.pid), { recursive: true, force: true });
      return;
    }
    carry.snapshot = hub.registry.snapshot();
    carry.sessionDefaultModel = hub.sessionDefaultModel;
    carry.sessionRoles = { ...hub.sessionRoles };
    await hub.stop(reason);
  }

  requireHub(): Hub {
    if (this.hub) return this.hub;
    throw new Error(this.#startError ?? "pi-dogs is not ready yet (no session started).");
  }

  usableModels(ctx: ExtensionContext | undefined = this.ctx): ModelInfo[] {
    try {
      return (ctx?.modelRegistry.getAvailable() ?? []).map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
    } catch {
      return [];
    }
  }

  mainModelRef(ctx: ExtensionContext | undefined = this.ctx): string | undefined {
    const m = ctx?.model;
    return m ? refOf({ provider: m.provider, id: m.id }) : undefined;
  }

  /**
   * Where dog sessions go: next to the main session (so /resume finds them),
   * or, for an in-memory main session (--no-session), under the agent dir.
   */
  sessionDirFor(ctx: ExtensionContext): string {
    try {
      if (ctx.sessionManager.getSessionFile()) return ctx.sessionManager.getSessionDir();
    } catch {
      // Fall through to the default below.
    }
    return join(this.agentDir, "sessions", "pi-dogs");
  }

  notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    if (this.ctx?.hasUI) this.ctx.ui.notify(text, level);
  }

  /** Open the mirror overlay, optionally on a specific dog. */
  openOverlay(ctx: ExtensionContext, agentId?: string): void {
    if (ctx.mode !== "tui") {
      this.notify("The mirror view needs the interactive terminal UI.", "warning");
      return;
    }
    if (this.#overlayOpen) return;
    const hub = this.hub;
    if (!hub) {
      this.notify(this.#startError ?? "pi-dogs is not ready.", "warning");
      return;
    }
    this.#overlayOpen = true;
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          this.#overlayTui = tui;
          return new MirrorOverlay(
            tui,
            theme,
            {
              dogs: () => this.hub?.registry.all() ?? [],
              now: () => Date.now(),
              steer: (dog, text) => {
                const r = this.hub?.steer(dog, text);
                return r && !r.ok ? r.error : undefined;
              },
              restore: (dog) => void this.hub?.restore(dog).catch((e: Error) => this.notify(e.message, "warning")),
              minimize: (dog) => void this.hub?.minimize(dog).catch((e: Error) => this.notify(e.message, "warning")),
              kill: (dog) => void this.hub?.kill(dog, "stopped by the user", { report: true, triggerTurn: false }),
              seen: (dog) => this.hub?.markSeen(dog),
            },
            () => done(undefined),
            agentId,
          );
        },
        { overlay: true, overlayOptions: { width: "80%", minWidth: 60, maxHeight: "90%", anchor: "center" } },
      )
      .finally(() => {
        this.#overlayOpen = false;
        this.#overlayTui = undefined;
      });
  }

  #host(): HubHost {
    return {
      sendToMain: (message, options) => {
        this.pi.sendMessage(
          { customType: message.customType, content: message.content, display: true, details: message.details },
          // followUp: do not cut into a running tool chain of the main agent.
          options.triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
        );
      },
      notify: (text, level) => this.notify(text, level),
      changed: () => this.#scheduleRender(),
    };
  }

  #installDock(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        this.#dockTui = tui;
        return new DockComponent(
          { dogs: () => this.hub?.registry.all() ?? [], now: () => Date.now(), shortcut: () => this.overlayHint },
          theme,
        );
      },
      { placement: "aboveEditor" },
    );
  }

  #scheduleRender(): void {
    this.#uiTimer ??= setTimeout(() => {
      this.#uiTimer = undefined;
      this.#render();
    }, UI_THROTTLE_MS);
  }

  #render(): void {
    this.#dockTui?.requestRender();
    this.#overlayTui?.requestRender();
  }
}


/** Remove run directories left behind by main pi processes that no longer exist. */
function removeStaleRunRoots(): void {
  const base = join(tmpdir(), "pi-dogs");
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || isPidAlive(pid)) continue;
    rmSync(join(base, entry), { recursive: true, force: true });
  }
}
