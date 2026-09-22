/**
 * The `/dogs` command for the user (docs/PLAN.md, section 7):
 *
 *   /dogs                          list dogs
 *   /dogs mirror [name]            open the live mirror overlay
 *   /dogs show <name>              restore and focus the dog's window
 *   /dogs min <name>               minimize the dog's window
 *   /dogs steer <name> <text>      send a message
 *   /dogs kill <name>              stop the dog
 *   /dogs model [pattern|reset]    show or set the default model for new dogs (this session)
 *   /dogs new [--model m] [-i] <task>   start a dog by hand
 *   /dogs setup-keys               move pi's model selector off Ctrl+L so the overlay can use it
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { parseNewArgs, parseSubcommand, splitDogAndText, SUBCOMMANDS } from "./command-args.ts";
import { describeDog } from "./format.ts";
import { keybindingsPath, planKeybindingsMerge, readKeybindings, writeKeybindings } from "./keybindings.ts";
import { resolveModelPattern } from "./models.ts";
import type { HubRuntime } from "./runtime.ts";
import { describeModelConfig, resolveDogModel } from "./tools.ts";

const HELP = [
  "/dogs                        list subagents",
  "/dogs mirror [name]          live view with steering (also the overlay shortcut)",
  "/dogs show <name>            bring a dog's window back",
  "/dogs min <name>             minimize a dog's window",
  "/dogs steer <name> <text>    send a message to a dog",
  "/dogs kill <name>            stop a dog",
  "/dogs model [pattern|reset]  default model for new dogs in this session",
  "/dogs new [--model m] [-i] <task>  start a dog yourself",
  "/dogs setup-keys             free Ctrl+L for the mirror view",
].join("\n");

export function registerDogsCommand(pi: ExtensionAPI, runtime: HubRuntime, agentDir: string): void {
  pi.registerCommand("dogs", {
    description: "pi-dogs: list, watch, steer and stop subagents (/dogs help)",
    getArgumentCompletions: (prefix) => {
      const words = prefix.split(/\s+/);
      if (words.length <= 1) {
        return SUBCOMMANDS.filter((s) => s.startsWith(words[0] ?? "")).map((s) => ({ value: s, label: s }));
      }
      const sub = words[0];
      if (!["mirror", "show", "min", "steer", "kill"].includes(sub ?? "")) return null;
      const partial = words.slice(1).join(" ").toLowerCase();
      return (runtime.hub?.registry.all() ?? [])
        .filter((d) => d.name.toLowerCase().startsWith(partial))
        .map((d) => ({ value: `${sub} ${d.name}`, label: d.name, description: d.state }));
    },
    handler: async (args, ctx) => {
      try {
        await handle(args, ctx, runtime, agentDir);
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
      }
    },
  });
}

async function handle(args: string, ctx: ExtensionCommandContext, runtime: HubRuntime, agentDir: string): Promise<void> {
  const { sub, rest, raw } = parseSubcommand(args);
  if (sub === "help") return ctx.ui.notify(HELP, "info");
  if (sub === "setup-keys") return setupKeys(ctx, agentDir);

  const hub = runtime.requireHub();
  const named = () => {
    const found = splitDogAndText(rest, hub.registry);
    if (!found) throw new Error(rest.trim() ? `No subagent named "${rest.trim()}".` : `Usage: /dogs ${sub} <name>`);
    return found;
  };

  switch (sub) {
    case "list": {
      const dogs = hub.registry.all();
      const now = Date.now();
      ctx.ui.notify(dogs.length ? dogs.map((d) => describeDog(d, now)).join("\n") : "No subagents yet.", "info");
      return;
    }
    case "mirror": {
      const dog = rest.trim() ? named().dog : undefined;
      runtime.openOverlay(ctx, dog?.agentId);
      return;
    }
    case "show":
      await hub.focus(named().dog);
      return;
    case "min":
      await hub.minimize(named().dog);
      return;
    case "steer": {
      const { dog, text } = named();
      if (!text) throw new Error("Usage: /dogs steer <name> <text>");
      const r = hub.steer(dog, text);
      ctx.ui.notify(r.ok ? `Sent to ${dog.name}.` : r.error, r.ok ? "info" : "warning");
      return;
    }
    case "kill": {
      const { dog } = named();
      await hub.kill(dog, "stopped by the user", { report: true, triggerTurn: false });
      ctx.ui.notify(`Stopped ${dog.name}.`, "info");
      return;
    }
    case "model": {
      const pattern = rest.trim();
      if (pattern && ["reset", "clear", "default"].includes(pattern.toLowerCase())) hub.sessionDefaultModel = undefined;
      else if (pattern) {
        const r = resolveModelPattern(pattern, runtime.usableModels(ctx));
        if (!r.ok) throw new Error(r.error);
        hub.sessionDefaultModel = r.ref + (r.thinking ? `:${r.thinking}` : "");
      }
      ctx.ui.notify(describeModelConfig(runtime, hub, ctx), "info");
      return;
    }
    case "new": {
      const parsed = parseNewArgs(rest);
      if (!parsed.task) throw new Error("Usage: /dogs new [--model <pattern>] [--interactive] [--name <name>] <task>");
      const model = resolveDogModel(runtime, hub, ctx, { model: parsed.model });
      const dog = await hub.spawn({
        task: parsed.task,
        context: "Started by the user with /dogs new. There is no further context.",
        name: parsed.name,
        model: model.model,
        thinking: model.thinking,
        mode: parsed.mode,
        cwd: ctx.cwd,
        sessionDir: runtime.sessionDirFor(ctx),
        parentSession: ctx.sessionManager.getSessionFile(),
        approve: ctx.isProjectTrusted(),
      });
      ctx.ui.notify(`Started ${dog.name} (${dog.model}).`, "info");
      return;
    }
    default: {
      // "/dogs <name>" opens the mirror on that dog.
      const found = splitDogAndText(args, hub.registry);
      if (found && !found.text) return runtime.openOverlay(ctx, found.dog.agentId);
      throw new Error(`Unknown subcommand "${raw}".\n${HELP}`);
    }
  }
}

async function setupKeys(ctx: ExtensionCommandContext, agentDir: string): Promise<void> {
  const file = keybindingsPath(agentDir);
  const existing = readKeybindings(file); // throws on an invalid file: never overwrite what we cannot parse
  const plan = planKeybindingsMerge(existing);
  if (plan.changes.length === 0) {
    ctx.ui.notify("Ctrl+L is already free for pi-dogs. Nothing to change.", "info");
    return;
  }
  const message = [
    `pi-dogs wants to update ${file}:`,
    ...plan.changes.map((c) => `  ${c}`),
    ...(plan.conflicts.length ? [`Note: ctrl+alt+l is also bound to: ${plan.conflicts.join(", ")}.`] : []),
    "All other entries stay as they are. Afterwards run /reload.",
  ].join("\n");
  if (!(await ctx.ui.confirm("Free Ctrl+L for the pi-dogs mirror view?", message))) {
    ctx.ui.notify("Keybindings unchanged.", "info");
    return;
  }
  writeKeybindings(file, plan.result);
  ctx.ui.notify(`Updated ${file}. Run /reload to use Ctrl+L for the mirror view (model selector: Ctrl+Alt+L).`, "info");
}
