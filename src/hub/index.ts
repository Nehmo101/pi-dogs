/**
 * pi-dogs hub extension, loaded into the main pi (`pi install <pi-dogs>`).
 *
 * Registers the subagent tools, the `/dogs` command, the overlay shortcut and
 * the result message renderer. Everything with a lifetime (pipe server,
 * backend, UI) starts in `session_start` and stops in `session_shutdown`
 * (docs/architecture.md).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text, type KeyId } from "@earendil-works/pi-tui";

import { AGENT_ENV_VAR } from "../protocol/launch.ts";
import { registerDogsCommand } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { INFO_MESSAGE_TYPE, RESULT_MESSAGE_TYPE } from "./hub.ts";
import { isOverlayKeyReserved, keybindingsPath, OVERLAY_KEY, readKeybindingsOrEmpty } from "./keybindings.ts";
import type { ResultDetails } from "./format.ts";
import { HubRuntime } from "./runtime.ts";
import { registerControlTools, registerSubagentTool } from "./tools.ts";

const COLLAPSED_SUMMARY_LINES = 8;

export default function hubExtension(pi: ExtensionAPI): void {
  // Inside a dog the hub stays inactive: v1 has no nested dogs, and the dog's
  // pi must not open a second pipe server or dock.
  if (process.env[AGENT_ENV_VAR]) return;

  const agentDir = getAgentDir();
  const { config, warnings } = loadConfig(agentDir);
  const runtime = new HubRuntime(pi, config, agentDir);

  registerControlTools(pi, runtime);
  registerDogsCommand(pi, runtime, agentDir);
  registerShortcuts(pi, runtime, agentDir);
  registerRenderers(pi);

  pi.on("session_start", async (event, ctx) => {
    await runtime.start(ctx, event.reason);
    // Registered here, not in the factory: the description lists the models usable right now.
    registerSubagentTool(pi, runtime);
    for (const warning of warnings) runtime.notify(`pi-dogs.json: ${warning}`, "warning");
  });

  pi.on("model_select", () => {
    if (runtime.hub) registerSubagentTool(pi, runtime);
  });

  // Awaited by pi: on "quit" this sends `shutdown` to the dogs and waits briefly.
  pi.on("session_shutdown", async (event) => {
    await runtime.stop(event.reason);
  });
}

function registerShortcuts(pi: ExtensionAPI, runtime: HubRuntime, agentDir: string): void {
  const open = { description: "pi-dogs: live view of the subagents", handler: (ctx: Parameters<HubRuntime["openOverlay"]>[0]) => runtime.openOverlay(ctx) };
  const keys: string[] = [];
  const preferred = runtime.config.overlayShortcut.trim().toLowerCase();
  // pi skips (with a startup warning) extension shortcuts that collide with its reserved Ctrl+L.
  const reserved = preferred === OVERLAY_KEY && isOverlayKeyReserved(readKeybindingsOrEmpty(keybindingsPath(agentDir)));
  if (preferred && !reserved) keys.push(preferred);
  const fallback = runtime.config.fallbackShortcut.trim().toLowerCase();
  if (fallback && !keys.includes(fallback)) keys.push(fallback);
  for (const key of keys) pi.registerShortcut(key as KeyId, open);
  runtime.overlayHint = keys[0];
}

function registerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ResultDetails>(RESULT_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const d = message.details;
    const content = typeof message.content === "string" ? message.content : "";
    const tone = !d ? "accent" : d.state === "done" && !d.error ? "success" : d.state === "failed" ? "error" : "warning";
    const lines = content.split("\n");
    const [first = "", ...rest] = lines;
    let body = rest;
    if (!expanded && body.length > COLLAPSED_SUMMARY_LINES) {
      body = [...body.slice(0, COLLAPSED_SUMMARY_LINES), theme.fg("dim", `… ${body.length - COLLAPSED_SUMMARY_LINES} more lines (expand to see all)`)];
    }
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${theme.fg(tone, "🐕 " + first)}\n${body.join("\n")}`, 0, 0));
    return box;
  });

  pi.registerMessageRenderer(INFO_MESSAGE_TYPE, (message, { outputPad }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("muted", `🐕 ${content}`), 0, 0));
    return box;
  });
}
