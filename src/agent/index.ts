/**
 * pi-dogs agent extension, loaded into every dog's pi with `-e`.
 *
 * It connects to the hub named in the launch file, runs the task it receives,
 * forwards a filtered event stream for the dock and mirror view, detects
 * when a human types into the window (takeover), and reports the result with
 * `done` (via the `subagent_done` tool, the `/done` command, or automatically
 * when an autonomous run settles). See docs/architecture.md.
 *
 * `/reload`, `/new`, `/resume` and `/fork` typed in the dog re-create this
 * extension runtime inside the same process. The launch file is gone by then,
 * so the connection and the dog's state are handed to the next runtime via
 * globalThis (like the hub does), and `bye` is only sent on a real quit.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { truncateText } from "../protocol/framing.ts";
import { consumeLaunchFile, type LaunchFile } from "../protocol/launch.ts";
import type { AgentConfig, AgentState, HubToAgentMessage, Usage } from "../protocol/types.ts";
import { AgentClient, type AgentClientHandlers } from "./client.ts";
import { EventForwarder } from "./forward.ts";
import { decideAutoDone, lastAssistantText, type MessageLike } from "./summary.ts";

export const LAUNCH_FLAG = "pi-dogs-launch";
const STATUS_KEY = "pi-dogs";
const MAX_ERROR_CHARS = 4000;

/** What survives a runtime replacement inside the dog's pi (module state does not). */
interface AgentCarry {
  launch: LaunchFile;
  client: AgentClient;
  config: AgentConfig | undefined;
  state: AgentState;
  takenOver: boolean;
  taskReceived: boolean;
  ranTask: boolean;
  doneId: string | undefined;
  shuttingDown: boolean;
  usage: Usage;
  lastRunMessages: MessageLike[];
  /** Hub messages that arrived between the two runtimes. */
  queued: HubToAgentMessage[];
  hubGone?: string;
}

const CARRY_KEY = Symbol.for("pi-dogs.agent-carry.v1");

function takeCarry(): AgentCarry | undefined {
  const g = globalThis as unknown as Record<symbol, AgentCarry | undefined>;
  const carry = g[CARRY_KEY];
  delete g[CARRY_KEY];
  return carry;
}

function putCarry(carry: AgentCarry): void {
  (globalThis as unknown as Record<symbol, AgentCarry | undefined>)[CARRY_KEY] = carry;
}

export default function agentExtension(pi: ExtensionAPI): void {
  pi.registerFlag(LAUNCH_FLAG, { description: "pi-dogs: launch file written by the hub (internal)", type: "string" });

  let launch: LaunchFile | undefined;
  let client: AgentClient | undefined;
  let forwarder: EventForwarder | undefined;
  let ctxRef: ExtensionContext | undefined;
  let config: AgentConfig | undefined;

  let state: AgentState = "starting";
  let takenOver = false;
  let taskReceived = false;
  let ranTask = false;
  let doneId: string | undefined;
  /** The hub asked us to stop: never report an automatic result any more. */
  let shuttingDown = false;
  /** The hub aborted the current run: skip the automatic result of this run. */
  let abortRequested = false;
  let currentTool: string | undefined;
  let lastRunMessages: MessageLike[] = [];
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  const active = () => launch !== undefined;
  const modelRef = () => (ctxRef?.model ? `${ctxRef.model.provider}/${ctxRef.model.id}` : "unknown");

  const pushStatus = () => {
    forwarder?.status({ state, tool: currentTool, usage: { ...usage }, model: modelRef() });
  };

  const setUiStatus = (text: string) => {
    if (ctxRef?.hasUI) ctxRef.ui.setStatus(STATUS_KEY, text);
  };

  const shutdown = () => {
    forwarder?.flush();
    ctxRef?.shutdown();
  };

  /** Report the result. Re-sent after reconnects until the hub acks it. */
  const sendDone = (summary: string, error?: string) => {
    if (!client || doneId) return false;
    doneId = `done-${Date.now().toString(36)}`;
    state = "closing";
    forwarder?.flush();
    const sessionFile = ctxRef?.sessionManager.getSessionFile() ?? "";
    // Cap the free text so the message always fits one protocol line.
    const fitted = truncateText(summary);
    const err = error && error.length > MAX_ERROR_CHARS ? error.slice(0, MAX_ERROR_CHARS - 1) + "…" : error;
    client.sendReliable({ type: "done", id: doneId, summary: fitted, usage: { ...usage }, sessionFile, ...(err ? { error: err } : {}) });
    setUiStatus(`🐕 ${launch?.name ?? ""} · result sent`);
    return true;
  };

  const inject = (text: string, mode: "steer" | "followUp") => {
    const idle = ctxRef?.isIdle() ?? true;
    forwarder?.userMessage(text, "hub");
    // While a turn runs, a message without deliverAs is rejected and lost (Q2).
    pi.sendUserMessage(text, idle ? undefined : { deliverAs: mode });
  };

  const onHubMessage = (msg: HubToAgentMessage) => {
    switch (msg.type) {
      case "welcome":
        config = msg.config;
        if (msg.resumed) {
          // Reconnected: the new hub runtime needs our live state again.
          pushStatus();
          forwarder?.flushStatus();
        }
        // A takeover sent while the pipe was down was dropped: repeat it (the hub ignores duplicates).
        if (takenOver) client?.send({ type: "takeover" });
        setUiStatus(`🐕 ${config.name} · connected to main pi`);
        break;
      case "task":
        if (taskReceived || doneId) break;
        taskReceived = true;
        inject(msg.text, "followUp");
        break;
      case "steer":
        if (doneId) {
          client?.send({ type: "error", message: "steer ignored: this agent has finished", fatal: false });
          break;
        }
        inject(msg.text, msg.mode);
        break;
      case "abort":
        abortRequested = true;
        ctxRef?.abort();
        break;
      case "shutdown":
        shuttingDown = true;
        state = "closing";
        if (ctxRef && !ctxRef.isIdle()) ctxRef.abort();
        shutdown();
        break;
      case "ack":
        if (msg.ref === doneId && config?.closeOnDone !== false) shutdown();
        break;
      default:
        break;
    }
  };

  // Always go through ctxRef: a ctx captured by a closure goes stale after a runtime replacement.
  const onHubGone = (reason: string) => {
    setUiStatus(`🐕 ${launch?.name ?? ""} · main pi gone`);
    if (config?.hubGoneGraceMs === 0) {
      ctxRef?.ui.notify(`pi-dogs: ${reason}. This session stays open for manual use.`, "warning");
      return;
    }
    ctxRef?.ui.notify(`pi-dogs: ${reason}; closing.`, "warning");
    shutdown();
  };
  const handlers = (): AgentClientHandlers => ({
    onMessage: onHubMessage,
    onDisconnected: () => setUiStatus(`🐕 ${launch?.name ?? ""} · reconnecting to main pi…`),
    onHubGone,
  });
  const attach = (c: AgentClient) => {
    client = c;
    forwarder = new EventForwarder({ send: (m) => void c.send(m) });
  };

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    if (client) return;
    const carried = takeCarry();
    if (carried) {
      // Same dog, new extension runtime: keep the connection and the state.
      ({ launch, config, state, takenOver, taskReceived, ranTask, doneId, shuttingDown, usage, lastRunMessages } = carried);
      attach(carried.client);
      carried.client.setHandlers(handlers());
      setUiStatus(`🐕 ${carried.launch.name} · ${carried.client.ready ? "connected to main pi" : "reconnecting to main pi…"}`);
      pushStatus();
      for (const msg of carried.queued) onHubMessage(msg);
      if (carried.hubGone) onHubGone(carried.hubGone);
      return;
    }
    const launchPath = pi.getFlag(LAUNCH_FLAG);
    if (typeof launchPath !== "string" || !launchPath) return;
    try {
      launch = consumeLaunchFile(launchPath);
    } catch (err) {
      // Typically the hub gave up on us already (e.g. we sat at a prompt past its hello
      // timeout) and removed the file. Without it this pi can never connect: leave.
      ctx.ui.notify(`pi-dogs: cannot read the launch file: ${(err as Error).message}; closing.`, "error");
      ctx.shutdown();
      return;
    }
    const current = launch;
    const c = new AgentClient({
      pipe: current.pipe,
      agentId: current.agentId,
      token: current.token,
      hubSecret: current.hubSecret,
      pid: process.pid,
      piVersion: VERSION,
      ...handlers(),
    });
    attach(c);
    setUiStatus(`🐕 ${current.name} · connecting…`);
    c.connect();
  });

  // ---- takeover detection (docs/spike/pi-api.md, Q3) ----
  pi.on("input", (event) => {
    if (active() && event.source === "interactive") {
      forwarder?.userMessage(event.text, "user");
      if (!takenOver) {
        takenOver = true;
        client?.send({ type: "takeover" });
      }
    }
    return { action: "continue" };
  });
  pi.on("user_bash", () => {
    if (active() && !takenOver) {
      takenOver = true;
      client?.send({ type: "takeover" });
    }
    return undefined;
  });

  // ---- event forwarding (Q4) ----
  pi.on("agent_start", () => {
    abortRequested = false;
    if (!active() || doneId) return;
    state = "running";
    pushStatus();
  });
  pi.on("message_update", (event) => {
    const e = event.assistantMessageEvent;
    if (active() && e.type === "text_delta") forwarder?.text(e.delta);
  });
  pi.on("message_end", (event) => {
    const m = event.message as MessageLike & {
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
    };
    if (!active() || m.role !== "assistant" || !m.usage) return;
    usage.input += m.usage.input ?? 0;
    usage.output += m.usage.output ?? 0;
    usage.cacheRead = (usage.cacheRead ?? 0) + (m.usage.cacheRead ?? 0);
    usage.cacheWrite = (usage.cacheWrite ?? 0) + (m.usage.cacheWrite ?? 0);
    usage.cost = (usage.cost ?? 0) + (m.usage.cost?.total ?? 0);
    pushStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!active()) return;
    currentTool = event.toolName;
    forwarder?.toolStart(event.toolCallId, event.toolName, event.args);
    pushStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!active()) return;
    currentTool = undefined;
    forwarder?.toolEnd(event.toolCallId, event.toolName, event.isError);
    pushStatus();
  });
  pi.on("agent_end", (event) => {
    if (!active()) return;
    lastRunMessages = event.messages as MessageLike[];
    if (taskReceived) ranTask = true;
  });
  // agent_settled, not agent_end: only then will pi not continue on its own (Q4).
  pi.on("agent_settled", () => {
    if (!active()) return;
    currentTool = undefined;
    if (!doneId && !shuttingDown) state = "idle";
    pushStatus();
    // A run cut short by the hub (shutdown or abort) is not a result.
    if (shuttingDown || abortRequested) {
      abortRequested = false;
      return;
    }
    const decision = decideAutoDone({
      mode: config?.mode ?? "autonomous",
      takenOver,
      alreadyDone: doneId !== undefined,
      ranTask,
      messages: lastRunMessages,
    });
    if (decision.action === "done") sendDone(decision.summary, decision.error);
  });

  // ---- finishing ----
  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this when your task is complete. Pass a concise summary of the result (findings, changed files, open questions); " +
      "it is returned to the main agent and this session closes.",
    parameters: Type.Object({
      summary: Type.String({ description: "The result for the main agent. Be concise but complete." }),
    }),
    async execute(_toolCallId, params) {
      if (!active()) throw new Error("subagent_done is only available inside a pi-dogs subagent.");
      const summary = params.summary.trim() || lastAssistantText(lastRunMessages);
      const sent = sendDone(summary);
      return {
        content: [{ type: "text", text: sent ? "Result sent to the main agent. This session will close." : "The result was already sent." }],
        details: undefined,
        // No follow-up model call after this tool (Q7).
        terminate: true,
      };
    },
  });

  pi.registerCommand("done", {
    description: "pi-dogs: hand this subagent back to the main agent, with an optional summary",
    handler: async (args, ctx) => {
      if (!active()) {
        ctx.ui.notify("/done only works inside a pi-dogs subagent.", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch() as unknown as Array<{ type: string; message?: MessageLike }>;
      const messages = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message!);
      const summary = args.trim() || lastAssistantText(messages) || "(no summary)";
      if (!sendDone(summary)) ctx.ui.notify("The result was already sent.", "info");
    },
  });

  pi.on("session_shutdown", (event) => {
    if (!client || !launch) return;
    forwarder?.dispose();
    forwarder = undefined;
    const c = client;
    client = undefined;
    if (event.reason === "quit" || c.closed) {
      c.send({ type: "bye", reason: event.reason });
      c.close();
      return;
    }
    // /reload, /new, /resume or /fork: the process lives on and so does the dog.
    const carry: AgentCarry = {
      launch,
      client: c,
      config,
      state,
      takenOver,
      taskReceived,
      ranTask,
      doneId,
      shuttingDown,
      usage,
      lastRunMessages,
      queued: [],
    };
    c.setHandlers({
      onMessage: (msg) => void carry.queued.push(msg),
      onHubGone: (reason) => {
        carry.hubGone = reason;
      },
    });
    putCarry(carry);
  });
}
