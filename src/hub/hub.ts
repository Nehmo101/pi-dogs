/**
 * Hub core: starts dogs, talks to them over the pipe, tracks their lifecycle
 * and reports results to the main agent.
 *
 * The class is independent of pi: everything pi-specific (sending messages to
 * the main agent, notifications, UI refresh) goes through `HubHost`, and the
 * windows go through a `PaneBackend`. That keeps it testable with a fake
 * backend and a simulated agent over a real named pipe.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { PaneBackend } from "../backend/pane-backend.ts";
import { encodedTextBytes, MAX_TEXT_BYTES } from "../protocol/framing.ts";
import { describeExit, readExitFile, writeLaunchFile, AGENT_ENV_VAR, WINDOW_CLOSED_EXIT_CODE, type ExitFile } from "../protocol/launch.ts";
import type { AgentConfig, AgentMode, AgentToHubMessage, HelloMessage, Usage } from "../protocol/types.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";
import type { PiDogsConfig } from "./config.ts";
import { DOG_NAMES, makeAgentId, pickDogName } from "./dog-names.ts";
import { buildResultText, elapsedOf, type ResultDetails } from "./format.ts";
import { modelLabel } from "./models.ts";
import { buildPiArgs, type PiCommand } from "./pi-command.ts";
import { debugLog } from "./log.ts";
import { isPidAlive, killProcessTree } from "./process.ts";
import { isTerminal, Registry, type DogOutcome, type DogRecord } from "./registry.ts";
import { defaultSessionFile, seedSessionFile, type SeedEntry } from "./session-seed.ts";
import { Connection, PipeServer } from "./server.ts";

const RUN_DIR_CLEANUP_MS = 10_000;
/** Finished dogs kept in the registry (and in /reload snapshots). */
const KEEP_FINISHED = 20;

export const RESULT_MESSAGE_TYPE = "pi-dogs-result";
export const INFO_MESSAGE_TYPE = "pi-dogs-info";

/** Accent colours, assigned round-robin (tab colour, dock dot). */
export const DOG_COLORS: readonly string[] = ["#e5a50a", "#3584e4", "#2ec27e", "#c061cb", "#e66100", "#1c71d8", "#26a269", "#f66151"];

export interface HubHost {
  /** Deliver a custom message to the main agent (pi.sendMessage). */
  sendToMain(message: { customType: string; content: string; details: unknown }, options: { triggerTurn: boolean }): void;
  notify(text: string, level: "info" | "warning" | "error"): void;
  /** Something in the registry changed; refresh the UI. */
  changed(): void;
}

export interface HubOptions {
  pipe: string;
  /** Directory for per-dog runtime files (launch and exit files). */
  runRoot: string;
  /** Path of the agent extension loaded into each dog with `-e`. */
  agentExtension: string;
  /** Path of launcher.mjs and the node binary that runs it. */
  launcher: string;
  nodePath: string;
  piCommand: PiCommand;
  backend: PaneBackend;
  config: PiDogsConfig;
  host: HubHost;
  /** Registry restored after a /reload. */
  registry?: Registry;
  now?: () => number;
  killTree?: (pid: number) => Promise<void>;
  isAlive?: (pid: number) => boolean;
  /** How often to look for the exit file after a pipe loss. */
  pollMs?: number;
  /** After the pi process is gone, how long to wait for the launcher's exit file. */
  exitFileGraceMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  /**
   * How long a dog whose pipe dropped may stay away while its PID still
   * looks alive. Caps the wait when the PID was reused by another process.
   */
  reconnectTimeoutMs?: number;
}

export interface SpawnRequest {
  task: string;
  context: string;
  name?: string | undefined;
  /** Resolved model (`provider/id`) and optional thinking level. */
  model?: string | undefined;
  thinking?: string | undefined;
  role?: string | undefined;
  tools?: string[] | undefined;
  cwd: string;
  mode?: AgentMode | undefined;
  /** Main agent's active branch to copy into the dog's session (`fork`). */
  forkEntries?: SeedEntry[] | undefined;
  parentSession?: string | undefined;
  /** Where to create the dog's session file. */
  sessionDir: string;
  /**
   * Project trust for the dog's pi: true passes `--approve`, false
   * `--no-approve`, undefined lets pi decide (it then may prompt).
   */
  approve?: boolean | undefined;
}

export type Result<T = void> = ({ ok: true } & (T extends void ? unknown : { value: T })) | { ok: false; error: string };

export class HubError extends Error {
  override name = "HubError";
}

export class Hub {
  readonly registry: Registry;
  readonly #o: Required<Omit<HubOptions, "registry">>;
  readonly #server: PipeServer;
  /** Current connection per agent. */
  readonly #conns = new Map<string, Connection>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #watches = new Map<string, NodeJS.Timeout>();
  readonly #finalWaiters = new Map<string, Array<() => void>>();
  /** Session-scoped settings (set with /dogs model or subagent_config). */
  sessionDefaultModel: string | undefined;
  readonly sessionRoles: Record<string, string> = {};
  /**
   * Bumped by the runtime on /new and /resume of the main pi. Results of dogs
   * started in an earlier epoch belong to another conversation: they are
   * delivered without triggering a turn.
   */
  sessionEpoch = 0;
  /** No new dogs (shutting down). */
  #stopped = false;
  /** Handed over to the next runtime (or quit finished): ignore late events. */
  #detached = false;

  constructor(options: HubOptions) {
    this.#o = {
      now: Date.now,
      killTree: killProcessTree,
      isAlive: isPidAlive,
      pollMs: 250,
      exitFileGraceMs: 1500,
      pingIntervalMs: 5_000,
      idleTimeoutMs: 15_000,
      reconnectTimeoutMs: 60_000,
      ...options,
    } as Required<Omit<HubOptions, "registry">>;
    this.registry = options.registry ?? new Registry({ mirrorLimit: options.config.mirrorLines });
    this.#server = new PipeServer({
      pipe: options.pipe,
      pingIntervalMs: this.#o.pingIntervalMs,
      idleTimeoutMs: this.#o.idleTimeoutMs,
      onHello: (conn, hello) => this.#onHello(conn, hello),
      onMessage: (conn, msg) => this.#onMessage(conn, msg),
      onClose: (conn) => this.#onClose(conn),
      onError: (err) => this.#o.host.notify(`pi-dogs pipe error: ${err.message}`, "error"),
    });
    this.#o.backend.setEvents({
      onClosed: (ref) => this.windowClosed(ref.agentId),
      onMinimizedChange: (ref, minimized) => {
        if (this.#detached) return;
        const dog = this.registry.get(ref.agentId);
        if (!dog || dog.minimized === minimized) return;
        this.registry.update(dog.agentId, { minimized });
        this.#o.host.changed();
      },
      onFocusNotReturned: (ref) => {
        if (this.#detached) return;
        const dog = this.registry.get(ref.agentId);
        if (!dog) return;
        this.#o.host.notify(`Windows kept the focus on ${dog.name}'s window: keystrokes now go there. Click this window to continue here.`, "warning");
      },
    });
  }

  get pipe(): string {
    return this.#server.pipe;
  }

  get config(): PiDogsConfig {
    return this.#o.config;
  }

  get backend(): PaneBackend {
    return this.#o.backend;
  }

  /** Listen on the pipe and resume supervision of dogs restored from a snapshot. */
  async start(): Promise<void> {
    mkdirSync(this.#o.runRoot, { recursive: true });
    await this.#server.listen();
    const now = this.#o.now();
    for (const dog of this.registry.live()) {
      if (dog.state === "starting") this.#armHelloTimer(dog, Math.max(0, dog.startedAt + this.#o.config.helloTimeoutMs - now));
      else this.#watchExit(dog.agentId, dog.windowClosed === true);
      // A kill that was in flight when the previous runtime stopped: carry it through.
      if (dog.state === "closing" && dog.closingTarget === "killed") {
        void this.kill(dog, dog.closingReason ?? "stopped").catch((err: Error) => debugLog(`resumed kill ${dog.agentId} failed: ${err.message}`));
      }
    }
  }

  // ---------------------------------------------------------------- spawning

  async spawn(req: SpawnRequest): Promise<DogRecord> {
    const config = this.#o.config;
    if (this.#stopped) throw new HubError("pi-dogs is shutting down.");
    const live = this.registry.live().length;
    if (live >= config.maxAgents) {
      throw new HubError(`Too many subagents (${live} of maxAgents ${config.maxAgents}). Wait for one to finish or kill one.`);
    }
    const availability = this.#o.backend.available();
    if (!availability.ok) throw new HubError(availability.hint);
    const taskBytes = encodedTextBytes(req.task);
    if (taskBytes > MAX_TEXT_BYTES) {
      throw new HubError(
        `The task is too long (${Math.ceil(taskBytes / 1024)} KiB, limit ${MAX_TEXT_BYTES / 1024} KiB). ` +
          "Put large material into a file and name the file in the task, or pass it as `context`.",
      );
    }

    const pool = config.dogNamesMode === "replace" && config.dogNames.length ? config.dogNames : [...DOG_NAMES, ...config.dogNames];
    const name = pickDogName(this.registry.names(), req.name === undefined ? { pool } : { pool, preferred: req.name });
    const agentId = makeAgentId(name, () => randomBytes(2).toString("hex"));
    const runDir = join(this.#o.runRoot, agentId);
    mkdirSync(runDir, { recursive: true });
    const now = this.#o.now();
    const { file: sessionFile, id: sessionId } = defaultSessionFile(req.sessionDir, new Date(now));
    seedSessionFile(
      {
        file: sessionFile,
        cwd: req.cwd,
        context: req.context,
        name,
        mode: req.mode ?? config.defaultMode,
        parentSession: req.parentSession,
        forkEntries: req.forkEntries,
        now: new Date(now),
      },
      sessionId,
    );

    const launchFile = join(runDir, "launch.json");
    const exitFile = join(runDir, "exit.json");
    const color = DOG_COLORS[this.registry.all().length % DOG_COLORS.length]!;
    const record = this.registry.add({
      agentId,
      name,
      token: randomBytes(24).toString("base64url"),
      hubSecret: randomBytes(24).toString("base64url"),
      color,
      model: req.model ?? "default",
      ...(req.thinking ? { thinking: req.thinking } : {}),
      ...(req.role ? { role: req.role } : {}),
      mode: req.mode ?? config.defaultMode,
      cwd: req.cwd,
      task: req.task,
      closeOnDone: config.closeOnDone,
      sessionFile,
      runDir,
      launchFile,
      exitFile,
      startedAt: now,
      sessionEpoch: this.sessionEpoch,
    });

    try {
      const piArgs = buildPiArgs({
        agentExtension: this.#o.agentExtension,
        launchFile,
        sessionFile,
        model: req.model,
        thinking: req.thinking,
        tools: req.tools,
        name,
        approve: req.approve,
      });
      writeLaunchFile(launchFile, {
        v: PROTOCOL_VERSION,
        agentId,
        name,
        pipe: this.pipe,
        token: record.token,
        hubSecret: record.hubSecret,
        cwd: req.cwd,
        exitFile,
        pi: { command: this.#o.piCommand.command, args: [...this.#o.piCommand.args, ...piArgs] },
        env: { ...forwardedEnv(), [AGENT_ENV_VAR]: agentId },
      });
      await this.#o.backend.open({
        agentId,
        name,
        modelLabel: modelLabel(record.model),
        color,
        cwd: req.cwd,
        command: this.#o.nodePath,
        args: [this.#o.launcher, launchFile],
      });
    } catch (err) {
      // Whatever failed after the record was added (launch file, window), never leave it "starting".
      this.#finalize(agentId, { state: "failed", reason: `could not start: ${(err as Error).message}` }, { report: false });
      throw new HubError(`Could not start ${name}: ${(err as Error).message}`);
    }
    debugLog(`spawned ${agentId} "${name}" model=${record.model} backend=${this.#o.backend.name} cwd=${req.cwd}`);
    this.#armHelloTimer(record, config.helloTimeoutMs);
    this.#o.host.changed();
    return record;
  }

  #armHelloTimer(dog: DogRecord, ms: number): void {
    this.#setTimer(
      dog.agentId,
      setTimeout(() => {
        const current = this.registry.get(dog.agentId);
        if (current?.state !== "starting") return;
        const exit = readExitFile(current.exitFile);
        const reason = exit ? `pi ended before connecting (${describeExit(exit)})` : `did not connect within ${Math.round(this.#o.config.helloTimeoutMs / 1000)} s`;
        // Keep the window open for diagnosis: no backend.close here.
        this.#finalize(dog.agentId, { state: "failed", reason }, { report: true, triggerTurn: true, closeWindow: false });
      }, ms),
    );
  }

  // ------------------------------------------------------------------ pipe

  #onHello(conn: Connection, hello: HelloMessage): true | { reject: string; hubSecret?: string } {
    if (this.#detached) return { reject: "hub is shutting down" };
    const dog = this.registry.get(hello.agentId);
    if (!dog || !tokensEqual(dog.token, hello.token)) return { reject: "unknown agent or invalid token" };
    // Authenticated: the reject carries the hub secret, so the dog knows it is final.
    if (hello.protocol < PROTOCOL_VERSION) return { reject: `protocol ${hello.protocol} is not supported`, hubSecret: dog.hubSecret };
    if (isTerminal(dog.state) && dog.state !== "done") return { reject: `agent already ${dog.state}`, hubSecret: dog.hubSecret };

    const previous = this.#conns.get(dog.agentId);
    this.#conns.set(dog.agentId, conn);
    if (previous && previous !== conn) previous.destroy("replaced by a new connection");
    this.#clearWatch(dog.agentId);
    if (dog.state === "starting") this.#clearTimer(dog.agentId);

    const now = this.#o.now();
    debugLog(`hello ${dog.agentId} pid=${hello.pid} reconnect=${hello.reconnect === true} state=${dog.state}`);
    this.registry.update(dog.agentId, { pid: hello.pid, connected: true, lastActivityAt: now });
    const agentConfig: AgentConfig = {
      mode: dog.mode,
      closeOnDone: dog.closeOnDone,
      hubGoneGraceMs: this.#o.config.killChildrenOnExit ? this.#o.config.hubGoneGraceMs : 0,
      name: dog.name,
    };
    const resumed = dog.taskSent;
    conn.send({ type: "welcome", config: agentConfig, resumed, hubSecret: dog.hubSecret }, dog.agentId);
    if (dog.state === "closing" && dog.closingTarget === "killed") {
      // Reconnected while being killed (e.g. the shutdown was lost with the old pipe): repeat it.
      conn.send({ type: "shutdown" }, dog.agentId);
    } else if (!dog.taskSent) {
      conn.send({ type: "task", text: dog.task }, dog.agentId);
      this.registry.update(dog.agentId, { taskSent: true });
      this.registry.tryTransition(dog.agentId, "running", now);
    }
    if (resumed) this.registry.addInfo(dog.agentId, "reconnected");
    this.#o.host.changed();
    return true;
  }

  #onMessage(conn: Connection, msg: AgentToHubMessage): void {
    const dog = this.registry.get(msg.agentId);
    if (this.#detached || !dog || this.#conns.get(msg.agentId) !== conn) return;
    const now = this.#o.now();
    switch (msg.type) {
      case "status": {
        this.registry.update(dog.agentId, { usage: msg.usage, lastActivityAt: now });
        if (msg.tool) this.registry.update(dog.agentId, { currentTool: msg.tool });
        else delete dog.currentTool;
        if (msg.state === "running" || msg.state === "idle" || msg.state === "closing") this.registry.tryTransition(dog.agentId, msg.state, now);
        break;
      }
      case "event":
        this.registry.applyEvent(dog.agentId, msg.event, now);
        break;
      case "takeover":
        this.#onTakeover(dog);
        break;
      case "done":
        this.#onDone(dog, msg.summary, msg.usage, msg.sessionFile, msg.error);
        if (msg.id !== undefined) conn.send({ type: "ack", ref: msg.id });
        break;
      case "bye":
        this.#onBye(dog, msg.reason);
        break;
      case "error":
        this.registry.addInfo(dog.agentId, `error: ${msg.message}`);
        if (msg.fatal) this.#o.host.notify(`${dog.name}: ${msg.message}`, "error");
        break;
      default:
        return;
    }
    this.#o.host.changed();
  }

  #onTakeover(dog: DogRecord): void {
    if (dog.takenOver || isTerminal(dog.state)) return;
    this.registry.update(dog.agentId, { takenOver: true });
    this.registry.addInfo(dog.agentId, "taken over by the user");
    this.#o.host.notify(`${dog.name} was taken over by hand.`, "info");
    this.#o.host.sendToMain(
      {
        customType: INFO_MESSAGE_TYPE,
        content:
          `The user took over subagent "${dog.name}" by typing into its window. It will not finish on its own; ` +
          "its result arrives when the user ends it with /done. Do not wait for it.",
        details: { agentId: dog.agentId, name: dog.name, event: "takeover" },
      },
      { triggerTurn: false },
    );
  }

  #onDone(dog: DogRecord, summary: string, usage: Usage, sessionFile: string, error: string | undefined): void {
    if (dog.reported || isTerminal(dog.state)) return; // duplicate after a reconnect
    debugLog(`done ${dog.agentId}${error ? ` error=${error}` : ""}`);
    const now = this.#o.now();
    this.registry.update(dog.agentId, { usage, summary, sessionFile: sessionFile || dog.sessionFile });
    if (dog.state === "closing" && dog.closingTarget === "killed") {
      // A result that crossed our shutdown (e.g. the aborted run settled): the kill wins.
      // Keep the text for the kill report; how (and whether) to report is the kill's choice.
      this.registry.update(dog.agentId, { outcome: { state: "killed", summary, ...(error ? { error } : {}) } });
      return;
    }
    const outcome: DogOutcome = { state: "done", summary, ...(error ? { error } : {}) };
    if (dog.closeOnDone) {
      this.registry.transition(dog.agentId, "closing", now);
      this.registry.update(dog.agentId, { closingTarget: "done", outcome });
    } else {
      this.registry.transition(dog.agentId, "done", now);
      this.registry.update(dog.agentId, { outcome });
    }
    this.#report(dog, outcome, true);
    if (!dog.closeOnDone) this.#resolveFinal(dog.agentId);
  }

  #onBye(dog: DogRecord, reason: string): void {
    debugLog(`bye ${dog.agentId} (${reason}) state=${dog.state}`);
    if (dog.state === "closing") {
      this.#finalize(dog.agentId, { state: dog.closingTarget ?? "killed", ...(dog.closingReason ? { reason: dog.closingReason } : {}) });
    } else if (!isTerminal(dog.state)) {
      // The user quit the dog's pi by hand (/quit, Ctrl+D) without /done.
      this.#finalize(dog.agentId, { state: "killed", reason: "closed by the user without a result" }, { report: true, triggerTurn: true });
    }
  }

  #onClose(conn: Connection): void {
    const agentId = conn.agentId;
    // After stop() our own server.close() drops every pipe: the next runtime takes over.
    if (this.#detached || agentId === undefined || this.#conns.get(agentId) !== conn) return;
    this.#conns.delete(agentId);
    const dog = this.registry.get(agentId);
    if (!dog) return;
    debugLog(`pipe closed ${agentId} (${conn.closeReason}) state=${dog.state}`);
    this.registry.update(agentId, { connected: false });
    if (!isTerminal(dog.state)) this.#watchExit(agentId);
    this.#o.host.changed();
  }

  /**
   * The backend saw the dog's window disappear. Public so the runtime can
   * replay a close that happened while no hub was subscribed (/reload).
   */
  windowClosed(agentId: string): void {
    if (this.#detached) return;
    const dog = this.registry.get(agentId);
    if (!dog || isTerminal(dog.state)) return;
    // An exit file with a real crash code written before the window went means pi ended on its own.
    const early = readExitFile(dog.exitFile);
    if (!early || !isCrash(early)) this.registry.update(agentId, { windowClosed: true });
    if (dog.state === "starting") {
      const exit = readExitFile(dog.exitFile);
      this.#finalize(dog.agentId, { state: "failed", reason: exit ? describeExit(exit) : "window closed before the agent connected" }, { report: true, triggerTurn: true, closeWindow: false });
      return;
    }
    this.#watchExit(dog.agentId, true);
  }

  /**
   * After the pipe is lost (or the window closed): wait for a reconnect, the
   * launcher's exit file, or the pi process disappearing, whichever is first.
   */
  #watchExit(agentId: string, windowGone = false): void {
    if (this.#detached) return;
    this.#clearWatch(agentId);
    let goneSince: number | undefined;
    const since = this.#o.now();
    const tick = () => {
      const dog = this.registry.get(agentId);
      if (this.#detached || !dog || isTerminal(dog.state) || dog.connected) return this.#clearWatch(agentId);
      const now = this.#o.now();
      const exit = readExitFile(dog.exitFile);
      const alive = dog.pid !== undefined && !windowGone ? this.#o.isAlive(dog.pid) : false;
      if (exit || !alive) {
        goneSince ??= now;
        if (exit || now - goneSince >= this.#o.exitFileGraceMs) {
          this.#finalize(agentId, this.#exitOutcome(dog, exit, windowGone), { report: true, triggerTurn: true });
          return;
        }
      } else if (now - since >= this.#o.reconnectTimeoutMs) {
        // "Alive" for this long without a reconnect: most likely the PID now belongs to another process.
        const secs = Math.round(this.#o.reconnectTimeoutMs / 1000);
        this.#finalize(agentId, { state: "failed", reason: `lost the connection and did not reconnect within ${secs} s` }, { report: true, triggerTurn: true });
        return;
      }
      this.#watches.set(agentId, setTimeout(tick, this.#o.pollMs));
    };
    this.#watches.set(agentId, setTimeout(tick, this.#o.pollMs));
  }

  #exitOutcome(dog: DogRecord, exit: ExitFile | undefined, windowGone: boolean): DogOutcome {
    if (dog.state === "closing") {
      const target = dog.closingTarget ?? "killed";
      return { state: target, ...(dog.closingReason ? { reason: dog.closingReason } : {}), ...(dog.outcome?.summary ? { summary: dog.outcome.summary } : {}) };
    }
    // Closing the window ends pi too; whatever exit that produced, it was the user's doing.
    if (dog.windowClosed || exit?.code === WINDOW_CLOSED_EXIT_CODE) return { state: "killed", reason: "window closed" };
    if (exit && isCrash(exit)) return { state: "failed", reason: `pi crashed (${describeExit(exit)})` };
    if (exit) return { state: "failed", reason: "pi exited without reporting a result" };
    return { state: "killed", reason: windowGone ? "window closed" : "window closed or process ended" };
  }

  // -------------------------------------------------------------- control

  steer(dog: DogRecord, text: string, mode: "steer" | "followUp" = "steer"): Result {
    if (!text.trim()) return { ok: false, error: "Empty message." };
    const bytes = encodedTextBytes(text);
    if (bytes > MAX_TEXT_BYTES) {
      return { ok: false, error: `Message too long (${Math.ceil(bytes / 1024)} KiB, limit ${MAX_TEXT_BYTES / 1024} KiB). Put large material into a file and name the file.` };
    }
    if (dog.state === "closing" || isTerminal(dog.state)) return { ok: false, error: `${dog.name} is ${dog.state} and accepts no more messages.` };
    const conn = this.#conns.get(dog.agentId);
    if (!conn || !dog.connected) return { ok: false, error: `${dog.name} is not connected right now (starting or reconnecting); try again shortly.` };
    conn.send({ type: "steer", text, mode });
    return { ok: true };
  }

  abort(dog: DogRecord, reason = "requested by the main agent"): Result {
    const conn = this.#conns.get(dog.agentId);
    if (!conn || isTerminal(dog.state)) return { ok: false, error: `${dog.name} is not connected.` };
    conn.send({ type: "abort", reason });
    return { ok: true };
  }

  /**
   * Stop a dog: ask it to shut down over the pipe, then kill its pi after
   * `graceMs`. Resolves once the dog is in a terminal state.
   */
  async kill(dog: DogRecord, reason: string, options: { report?: boolean; triggerTurn?: boolean; graceMs?: number } = {}): Promise<void> {
    if (this.#detached) return;
    const graceMs = options.graceMs ?? this.#o.config.killGraceMs;
    const conn = this.#conns.get(dog.agentId);
    if (isTerminal(dog.state)) {
      // A finished dog with closeOnDone=false may still have its window open.
      conn?.send({ type: "shutdown" });
      return;
    }
    const final = this.#waitFinal(dog.agentId);
    if (dog.state === "starting" && !conn) {
      this.#finalize(dog.agentId, { state: "killed", reason }, { report: options.report ?? false, triggerTurn: options.triggerTurn ?? false });
      return;
    }
    if (dog.state !== "closing") {
      this.registry.transition(dog.agentId, "closing", this.#o.now());
      this.registry.update(dog.agentId, { closingTarget: "killed", closingReason: reason });
    }
    if (dog.closingTarget === "killed") {
      // On the record, not in a map: a /reload snapshot must carry how to report the kill.
      this.registry.update(dog.agentId, {
        closingReport: options.report ?? dog.closingReport ?? true,
        closingTriggerTurn: options.triggerTurn ?? dog.closingTriggerTurn ?? false,
      });
    }
    this.#o.host.changed();
    conn?.send({ type: "shutdown" });
    if (await withTimeout(final, graceMs)) return;
    // The runtime was replaced while we waited: the next hub resumes this kill.
    if (this.#detached) return;
    if (dog.pid !== undefined) await this.#o.killTree(dog.pid);
    if (await withTimeout(final, this.#o.exitFileGraceMs + this.#o.pollMs * 2)) return;
    if (this.#detached) return;
    this.#finalize(dog.agentId, { state: dog.closingTarget ?? "killed", reason });
  }

  async minimize(dog: DogRecord): Promise<void> {
    await this.#o.backend.minimize({ agentId: dog.agentId });
    this.registry.update(dog.agentId, { minimized: true });
    this.#o.host.changed();
  }

  async restore(dog: DogRecord): Promise<void> {
    await this.#o.backend.restore({ agentId: dog.agentId });
    this.registry.update(dog.agentId, { minimized: false, unseen: false });
    this.#o.host.changed();
  }

  async focus(dog: DogRecord): Promise<void> {
    if (dog.minimized) await this.restore(dog);
    await this.#o.backend.focus({ agentId: dog.agentId });
  }

  markSeen(dog: DogRecord): void {
    if (dog.unseen) {
      this.registry.update(dog.agentId, { unseen: false });
      this.#o.host.changed();
    }
  }

  /**
   * Stop the hub. On "quit" the dogs are shut down (if `killChildrenOnExit`)
   * and the backend is disposed. On any other reason (/reload, /new, /resume)
   * the dogs keep running and reconnect to the next hub runtime.
   */
  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (reason === "quit" && this.#o.config.killChildrenOnExit) {
      // Live dogs, plus finished ones still connected (closeOnDone=false keeps their pi open).
      // kill() only sends those a shutdown; their pi then exits and its window closes.
      const dogs = this.registry.all().filter((dog) => !isTerminal(dog.state) || this.#conns.has(dog.agentId));
      const finished = dogs.filter((dog) => isTerminal(dog.state));
      await Promise.all(dogs.map((dog) => this.kill(dog, "main pi quit", { report: false, triggerTurn: false, graceMs: this.#o.config.quitGraceMs })));
      // Let their shutdown reach them before the server drops every pipe.
      const open = finished.map((dog) => this.#conns.get(dog.agentId)).filter((c): c is Connection => c !== undefined);
      for (const conn of open) conn.close("main pi quit");
      const deadline = Date.now() + this.#o.config.quitGraceMs;
      while (open.some((c) => !c.closed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    }
    this.#detached = true;
    // Pending kill() calls of this runtime return now; the next runtime resumes them.
    for (const agentId of [...this.#finalWaiters.keys()]) this.#resolveFinal(agentId);
    for (const t of this.#timers.values()) clearTimeout(t);
    for (const t of this.#watches.values()) clearTimeout(t);
    this.#timers.clear();
    this.#watches.clear();
    await this.#server.close();
    this.#conns.clear();
  }

  // --------------------------------------------------------------- endings

  #finalize(agentId: string, outcome: DogOutcome, options: { report?: boolean; triggerTurn?: boolean; closeWindow?: boolean } = {}): void {
    const dog = this.registry.get(agentId);
    if (this.#detached || !dog || isTerminal(dog.state)) return;
    this.#clearTimer(agentId);
    this.#clearWatch(agentId);
    const merged: DogOutcome = { ...dog.outcome, ...outcome };
    debugLog(`finalize ${agentId} -> ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    if (outcome.state === "killed" && dog.closingTarget === "killed" && dog.closingReport !== undefined) {
      options = { ...options, report: dog.closingReport, triggerTurn: dog.closingTriggerTurn ?? false };
    }
    this.registry.transition(agentId, outcome.state, this.#o.now());
    this.registry.update(agentId, { outcome: merged });
    this.#conns.get(agentId)?.close("finished");
    this.#conns.delete(agentId);
    if (options.report && !dog.reported) this.#report(dog, merged, options.triggerTurn ?? true);
    // The launcher writes the exit file after pi ends; remove the run dir a bit later.
    const launchFile = dog.launchFile;
    rmSync(launchFile, { force: true }); // holds the token
    setTimeout(() => rmSync(dog.runDir, { recursive: true, force: true }), RUN_DIR_CLEANUP_MS).unref();
    if (options.closeWindow !== false) {
      void this.#o.backend.close({ agentId }).catch(() => undefined);
    }
    void this.#o.backend.relayout().catch(() => undefined);
    this.#resolveFinal(agentId);
    this.registry.pruneTerminal(KEEP_FINISHED);
    this.#o.host.changed();
  }

  #report(dog: DogRecord, outcome: DogOutcome, triggerTurn: boolean): void {
    this.registry.update(dog.agentId, { reported: true });
    const details: ResultDetails = {
      agentId: dog.agentId,
      name: dog.name,
      model: dog.model + (dog.thinking ? `:${dog.thinking}` : ""),
      state: outcome.state,
      usage: dog.usage,
      sessionFile: dog.sessionFile,
      elapsedMs: elapsedOf(dog, this.#o.now()),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    let content = buildResultText({ ...details, summary: outcome.summary });
    if ((dog.sessionEpoch ?? 0) !== this.sessionEpoch) {
      // Started before /new or /resume: this conversation did not ask for it.
      const [head = "", ...rest] = content.split("\n");
      content = [head, "(Started in an earlier session of the main pi; shown for reference only.)", ...rest].join("\n");
      triggerTurn = false;
    }
    this.#o.host.sendToMain({ customType: RESULT_MESSAGE_TYPE, content, details }, { triggerTurn });
  }

  #waitFinal(agentId: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.#finalWaiters.get(agentId) ?? [];
      list.push(resolve);
      this.#finalWaiters.set(agentId, list);
    });
  }

  #resolveFinal(agentId: string): void {
    const list = this.#finalWaiters.get(agentId);
    this.#finalWaiters.delete(agentId);
    for (const resolve of list ?? []) resolve();
  }

  #setTimer(agentId: string, timer: NodeJS.Timeout): void {
    this.#clearTimer(agentId);
    this.#timers.set(agentId, timer);
  }

  #clearTimer(agentId: string): void {
    const t = this.#timers.get(agentId);
    if (t) clearTimeout(t);
    this.#timers.delete(agentId);
  }

  #clearWatch(agentId: string): void {
    const t = this.#watches.get(agentId);
    if (t) clearTimeout(t);
    this.#watches.delete(agentId);
  }
}

/**
 * pi settings a dog must share with the main pi. Terminal windows do not
 * necessarily inherit the main pi's environment, so these travel in the
 * launch file.
 */
const FORWARDED_ENV = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK"];

function forwardedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** An exit that looks like pi failing on its own (not a clean exit, not a closed window). */
function isCrash(exit: ExitFile): boolean {
  if (exit.code === WINDOW_CLOSED_EXIT_CODE) return false;
  return exit.code !== 0 || exit.error !== undefined || exit.signal !== null;
}

function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Resolve true if `promise` settles within `ms`, false otherwise. */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
