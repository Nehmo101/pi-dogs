// Spike Q1/Q2/Q7 (parent side): a named-pipe JSONL server owned by the main Pi.
// - The server is started in session_start (NOT in the factory) and closed in session_shutdown.
// - Pipe clients may send {type:"result", text, triggerTurn?, deliverAs?}; the hub delivers it to the
//   main agent with pi.sendMessage(...) so we can observe whether a turn is triggered (idle / busy).
// - The pipe name is written to logs/hub-pipe.txt so a test driver can find it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "logs");
mkdirSync(logDir, { recursive: true });
const log = (msg: string, data?: unknown) =>
	appendFileSync(join(logDir, "hub.log"), `${new Date().toISOString()} ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`);

// Minimal JSONL framing: split on LF only (never on U+2028/U+2029, so no readline).
function onJsonl(sock: net.Socket, handler: (msg: any) => void) {
	let buf = "";
	sock.setEncoding("utf8");
	sock.on("data", (chunk: string) => {
		buf += chunk;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (line.trim()) {
				try { handler(JSON.parse(line)); } catch (e) { log("bad json", String(e)); }
			}
		}
	});
}

export default function (pi: ExtensionAPI) {
	let server: net.Server | undefined;
	let lastCtx: ExtensionContext | undefined;
	log("factory loaded (no server yet)");

	pi.on("session_start", (event, ctx) => {
		lastCtx = ctx;
		if (server) return; // idempotent
		const pipe = `\\\\.\\pipe\\pi-dogs-spike-${randomBytes(4).toString("hex")}`;
		server = net.createServer((sock) => {
			log("client connected");
			const send = (m: unknown) => sock.write(JSON.stringify(m) + "\n");
			onJsonl(sock, (msg) => {
				log("recv", msg);
				if (msg.type === "hello") send({ type: "welcome" });
				if (msg.type === "result") {
					const idle = lastCtx?.isIdle();
					// Deliver a sub-agent result into the main agent as a custom message.
					pi.sendMessage(
						{ customType: "pi-dogs-result", content: msg.text, display: true, details: { from: "spike" } },
						{ triggerTurn: msg.triggerTurn ?? true, deliverAs: msg.deliverAs },
					);
					log("sendMessage called", { idleAtCall: idle, triggerTurn: msg.triggerTurn ?? true, deliverAs: msg.deliverAs });
					send({ type: "ack", idleAtCall: idle });
				}
				if (msg.type === "shutdown") lastCtx?.shutdown();
			});
			sock.on("error", (e) => log("sock error", String(e)));
		});
		server.listen(pipe, () => {
			log("listening", { pipe, reason: event.reason });
			writeFileSync(join(logDir, "hub-pipe.txt"), pipe);
		});
	});

	for (const ev of ["agent_start", "agent_end", "agent_settled"] as const) {
		pi.on(ev, (_e, ctx) => log(`event ${ev}`, { idle: ctx.isIdle() }));
	}
	pi.on("message_end", (e) => {
		const m: any = e.message;
		if (m.role === "custom" || m.role === "user") log("message_end", { role: m.role, customType: m.customType, content: typeof m.content === "string" ? m.content : m.content?.[0]?.text });
	});

	pi.on("session_shutdown", (event) => {
		log("session_shutdown", event);
		server?.close();
		server = undefined;
	});
}
