// Spike Q4: log every lifecycle event an extension can observe, with a compact
// payload shape, so we know which events to forward over the pipe.
// Run: pi -p -e events-probe.ts --model ollama/qwen3.5:4b --no-session "..."
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const logDir = join(here, "logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "events-probe.jsonl");

// Summarize a value: keep structure, truncate long strings and arrays.
function shape(v: unknown, depth = 0): unknown {
	if (v === null || v === undefined) return v;
	if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…(${v.length})` : v;
	if (typeof v !== "object") return v;
	if (depth > 4) return "…";
	if (Array.isArray(v)) return v.length > 3 ? [...v.slice(0, 3).map((x) => shape(x, depth + 1)), `…+${v.length - 3}`] : v.map((x) => shape(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (k === "systemPrompt" || k === "systemPromptOptions" || k === "context" || k === "partial") { out[k] = "<omitted>"; continue; }
		out[k] = shape(val, depth + 1);
	}
	return out;
}

const EVENTS = [
	"session_start", "session_shutdown", "input", "before_agent_start", "agent_start", "agent_end",
	"agent_before_settle", "agent_settled", "turn_start", "turn_end", "message_start", "message_update",
	"message_end", "tool_call", "tool_execution_start", "tool_execution_update", "tool_execution_end",
	"tool_result", "model_select",
] as const;

export default function (pi: ExtensionAPI) {
	let deltas = 0;
	for (const name of EVENTS) {
		pi.on(name as any, (event: any, ctx: any) => {
			// message_update fires per token: log only the first few of each sub-type.
			if (name === "message_update") {
				deltas++;
				if (deltas > 6 && event.assistantMessageEvent?.type?.endsWith("_delta")) return;
			}
			appendFileSync(logFile, JSON.stringify({ t: Date.now(), name, idle: ctx.isIdle(), event: shape(event) }) + "\n");
		});
	}
}
