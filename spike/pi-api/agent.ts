// Spike Q1-Q7 (child side): extension loaded into a sub Pi that runs the INTERACTIVE TUI.
// Start: pi -e agent.ts --pi-dogs-launch=<launch.json>
// launch.json = { pipe, token, agentId }. The extension connects in session_start, says hello,
// forwards selected events, and executes commands received from the hub (see handle()).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "logs");
mkdirSync(logDir, { recursive: true });
const log = (msg: string, data?: unknown) =>
	appendFileSync(join(logDir, "agent.log"), `${new Date().toISOString()} ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`);

export default function (pi: ExtensionAPI) {
	// Q1: flags are registered in the factory; values are only readable later (session_start).
	pi.registerFlag("pi-dogs-launch", { description: "pi-dogs launch file (spike)", type: "string" });
	log("factory: getFlag =", pi.getFlag("pi-dogs-launch"));

	let sock: net.Socket | undefined;
	let ctxRef: ExtensionContext | undefined;
	let agentId = "?";
	const send = (m: Record<string, unknown>) => sock?.write(JSON.stringify({ v: 1, agentId, ...m }) + "\n");

	// ---- Q4: event forwarding with batched text deltas (flushed every 250 ms) ----
	let pendingText = "";
	let flushTimer: NodeJS.Timeout | undefined;
	const flush = () => { if (pendingText) { send({ type: "event", kind: "text_delta", text: pendingText }); pendingText = ""; } };

	// ---- Q3: takeover detection ----
	let rawKeys = 0;

	// ---- Q6: widget + overlay state ----
	let widgetTimer: NodeJS.Timeout | undefined;
	let mirror: string[] = ["(mirror empty)"];
	let overlayDone: ((r: string | undefined) => void) | undefined;
	let overlayTui: { requestRender(): void } | undefined;

	pi.on("session_start", (event, ctx) => {
		ctxRef = ctx;
		const launchFile = pi.getFlag("pi-dogs-launch");
		log("session_start", { reason: event.reason, mode: ctx.mode, launchFile });
		if (typeof launchFile !== "string" || sock) return;
		const launch = JSON.parse(readFileSync(launchFile, "utf8"));
		rmSync(launchFile, { force: true }); // launch file carries the token: delete right after reading
		agentId = launch.agentId;
		// Tools are registered in the factory; per-launch configuration can only (de)activate them here.
		if (launch.noDoneTool) pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "subagent_done"));
		sock = net.connect(launch.pipe, () => send({ type: "hello", token: launch.token, pid: process.pid, protocol: 1 }));
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (chunk: string) => {
			buf += chunk;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				if (line.trim()) handle(JSON.parse(line));
			}
		});
		sock.on("error", (e) => log("sock error", String(e)));
		sock.on("close", () => log("sock closed"));

		// Q3: raw keystrokes typed into THIS terminal (never fired by sendUserMessage).
		if (ctx.mode === "tui") {
			ctx.ui.onTerminalInput((data) => {
				rawKeys++;
				log("onTerminalInput", { data: JSON.stringify(data), rawKeys });
				send({ type: "event", kind: "raw_key", data });
				return undefined; // do not consume
			});
		}
		ctx.ui.setTitle(`pi-dogs-apispike ${agentId}`);
	});

	function handle(msg: any) {
		log("recv", msg);
		const ctx = ctxRef!;
		try {
			switch (msg.type) {
				case "welcome": break;
				case "task": // Q2: idle injection
					pi.sendUserMessage(msg.text);
					break;
				case "steer": // Q2: injection while a turn may be running
					pi.sendUserMessage(msg.text, msg.mode ? { deliverAs: msg.mode } : undefined);
					break;
				case "custom": // Q2: custom message variant
					pi.sendMessage({ customType: "pi-dogs-steer", content: msg.text, display: true }, { triggerTurn: msg.triggerTurn, deliverAs: msg.deliverAs });
					break;
				case "state":
					send({ type: "state", idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
					break;
				case "abort":
					ctx.abort();
					break;
				case "widget": // Q6: persistent multi-line dock updated ~4x/s
					if (widgetTimer) clearInterval(widgetTimer);
					widgetTimer = undefined;
					if (msg.on) {
						let n = 0;
						const t0 = Date.now();
						widgetTimer = setInterval(() => {
							n++;
							const s = ((Date.now() - t0) / 1000).toFixed(1);
							ctx.ui.setWidget("pi-dogs-dock", [
								ctx.ui.theme.fg("accent", `agents dock  tick=${n}  t=${s}s`),
								`  scout   running  tool=bash   ${"#".repeat(n % 20)}`,
								`  critic  idle     tokens=${n * 13}`,
								`  writer  done     ok`,
							]);
						}, 250);
					} else ctx.ui.setWidget("pi-dogs-dock", undefined);
					break;
				case "mirror": // feed lines into the overlay
					mirror = msg.lines;
					overlayTui?.requestRender();
					break;
				case "overlay":
					if (msg.open) openOverlay(ctx);
					else overlayDone?.(undefined);
					break;
				case "shutdown": // Q7
					log("shutdown requested, idle=", ctx.isIdle());
					ctx.shutdown();
					break;
			}
		} catch (e) {
			log("handle error", String(e));
			send({ type: "error", message: String(e) });
		}
	}

	// Q6: live mirror overlay with a single-line steering Input from pi-tui.
	function openOverlay(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		void ctx.ui
			.custom<string | undefined>(
				(tui, theme, _kb, done) => {
					overlayDone = done;
					overlayTui = tui;
					const input = new Input({ prompt: "steer> ", placeholder: "type to steer, Enter to send, Esc to close" });
					input.onSubmit = (v) => { send({ type: "event", kind: "overlay_submit", text: v }); input.setValue(""); tui.requestRender(); };
					input.onEscape = () => done(undefined);
					const comp: Component & Focusable = {
						focused: false,
						render(width: number) {
							input.focused = this.focused; // propagate focus for IME/cursor placement
							const w = Math.max(10, width);
							const border = theme.fg("accent", "─".repeat(w));
							return [
								border,
								truncateToWidth(theme.bold(" mirror: scout "), w),
								...mirror.slice(-8).map((l) => truncateToWidth(` ${l}`, w)),
								border,
								...input.render(w),
							];
						},
						handleInput(data: string) {
							if (matchesKey(data, "escape")) return done(undefined);
							input.handleInput(data);
							tui.requestRender();
						},
						invalidate() { input.invalidate(); },
					};
					return comp;
				},
				{ overlay: true, overlayOptions: { width: "70%", maxHeight: "60%", anchor: "center" }, onHandle: (h) => log("overlay handle", { focused: h.isFocused() }) },
			)
			.then((r) => { log("overlay closed", r); overlayDone = undefined; overlayTui = undefined; send({ type: "event", kind: "overlay_closed" }); });
	}

	// Q3: input events carry a source: "interactive" (typed/CLI arg), "rpc", or "extension" (sendUserMessage).
	pi.on("input", (e) => {
		log("input", { source: e.source, text: e.text, streamingBehavior: e.streamingBehavior });
		send({ type: "event", kind: "input", source: e.source, streamingBehavior: e.streamingBehavior });
		if (e.source === "interactive") send({ type: "takeover" });
		return { action: "continue" };
	});
	pi.on("user_bash", (e) => { send({ type: "takeover", via: "user_bash" }); log("user_bash", e.command); });

	// Q4: forwarded events
	pi.on("agent_start", () => send({ type: "status", state: "running" }));
	pi.on("agent_end", () => { flush(); send({ type: "event", kind: "agent_end" }); });
	pi.on("agent_settled", (_e, ctx) => send({ type: "status", state: "idle", idle: ctx.isIdle() }));
	pi.on("message_update", (e) => {
		const a = e.assistantMessageEvent;
		if (a.type === "text_delta") {
			pendingText += a.delta;
			flushTimer ??= setTimeout(() => { flushTimer = undefined; flush(); }, 250);
		}
	});
	pi.on("message_end", (e) => {
		const m: any = e.message;
		if (m.role === "assistant") send({ type: "event", kind: "usage", usage: m.usage, stopReason: m.stopReason });
		if (m.role === "user" || m.role === "custom") send({ type: "event", kind: "message", role: m.role, text: typeof m.content === "string" ? m.content : m.content?.[0]?.text });
	});
	pi.on("tool_execution_start", (e) => send({ type: "event", kind: "tool_start", tool: e.toolName, args: JSON.stringify(e.args).slice(0, 120) }));
	pi.on("tool_execution_end", (e) => send({ type: "event", kind: "tool_end", tool: e.toolName, isError: e.isError }));

	// Q5: try to take over Ctrl+L (built-in app.model.select).
	pi.registerShortcut("ctrl+l", {
		description: "pi-dogs overlay (spike)",
		handler: (ctx) => { log("ctrl+l handler fired"); send({ type: "event", kind: "ctrl+l" }); openOverlay(ctx); },
	});

	// Q7: autonomous finish.
	pi.registerTool({
		name: "subagent_done",
		label: "Subagent Done",
		description: "Call when the task is complete. Pass a short summary; this closes the sub agent session.",
		parameters: Type.Object({ summary: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			send({ type: "done", summary: params.summary });
			log("subagent_done -> ctx.shutdown()", { idle: ctx.isIdle() });
			ctx.shutdown(); // deferred by the TUI until agent_settled
			return { content: [{ type: "text", text: "Done. Session closing." }], details: undefined, terminate: true };
		},
	});

	pi.on("session_shutdown", (e) => {
		log("session_shutdown", e);
		if (widgetTimer) clearInterval(widgetTimer);
		flush();
		send({ type: "bye", reason: e.reason });
		sock?.end();
		sock = undefined;
	});
}
