/**
 * Tools for the main agent: subagent, subagent_steer, subagent_list,
 * subagent_kill and subagent_config (docs/PLAN.md, sections 7 and 14.2).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describeDog, formatUsage } from "./format.ts";
import { chooseModelPattern, formatModelList, resolveModelPattern, type ModelInfo } from "./models.ts";
import type { Hub } from "./hub.ts";
import type { DogRecord } from "./registry.ts";
import type { HubRuntime } from "./runtime.ts";
import type { SeedEntry } from "./session-seed.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

/** Resolve the model for a new dog, or throw a model-facing error. */
export function resolveDogModel(
  runtime: HubRuntime,
  hub: Hub,
  ctx: ExtensionContext,
  request: { model?: string | undefined; role?: string | undefined },
): { model?: string; thinking?: string; source?: string } {
  const choice = chooseModelPattern(request, {
    sessionDefault: hub.sessionDefaultModel,
    sessionRoles: hub.sessionRoles,
    configDefault: runtime.config.models.default,
    configRoles: runtime.config.models.roles,
    mainModel: runtime.mainModelRef(ctx),
  });
  if (!choice) return {};
  const models = runtime.usableModels(ctx);
  const resolved = resolveModelPattern(choice.pattern, models);
  if (resolved.ok) {
    return { model: resolved.ref, source: choice.source, ...(resolved.thinking ? { thinking: resolved.thinking } : {}) };
  }
  // The main agent's own model is known to work even if the registry lists it differently.
  if (choice.source === "main") return { model: choice.pattern, source: choice.source };
  const where = choice.source === "call" ? "" : ` (from the ${choice.source} default)`;
  throw new Error(`${resolved.error}${where}\nUsable models: ${formatModelList(models, 600) || "none"}`);
}

function describeSubagentTool(runtime: HubRuntime, models: ModelInfo[], hub: Hub | undefined): string {
  const lines = [
    "Start a sub agent (a separate pi) in its own terminal window. It runs in the background and this call returns at once;",
    "its result arrives later as a message. The user can watch it, type into it, or minimize it.",
    "Write `context` yourself: the goal, relevant files, what is known so far; the sub agent sees nothing else unless fork=true.",
    'mode "autonomous" (default) finishes by itself; "interactive" waits for the user or for subagent_done.',
    "Do not poll subagent_list in a loop; results arrive on their own.",
  ];
  const list = formatModelList(models);
  if (list) lines.push(`Usable models for \`model\` (provider/id, optional :thinking suffix): ${list}.`);
  const roles = { ...runtime.config.models.roles, ...(hub?.sessionRoles ?? {}) };
  if (Object.keys(roles).length) lines.push(`Configured roles for \`role\`: ${Object.entries(roles).map(([r, m]) => `${r} → ${m}`).join(", ")}.`);
  const def = hub?.sessionDefaultModel ?? runtime.config.models.default;
  lines.push(`Default model: ${def ?? "same as the main agent"}.`);
  return lines.join("\n");
}

function findDog(hub: Hub, name: string): DogRecord {
  const dog = hub.registry.find(name);
  if (dog) return dog;
  const names = hub.registry.all().map((d) => d.name);
  throw new Error(`No subagent named "${name}".` + (names.length ? ` Known: ${names.join(", ")}.` : " No subagents have been started."));
}

/** Register (or re-register with a fresh model list) the `subagent` tool. Called in session_start. */
export function registerSubagentTool(pi: ExtensionAPI, runtime: HubRuntime): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: describeSubagentTool(runtime, runtime.usableModels(), runtime.hub),
    promptSnippet: "Start a sub agent in its own window that works in the background (result arrives as a message)",
    promptGuidelines: [
      "Use subagent for independent, well-scoped work that can run in parallel; give it a self-contained task and context.",
      "After starting sub agents, continue with other work or end your turn; do not busy-wait for their results.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "What the sub agent should do. Be specific about the expected result." }),
      context: Type.String({ description: "Background the sub agent needs: goal, relevant files, findings so far. Written by you." }),
      name: Type.Optional(Type.String({ description: "Display name. Omit for a random dog name." })),
      model: Type.Optional(Type.String({ description: "Model pattern, e.g. ollama/qwen3.5:4b or *sonnet*:high. Omit for the default." })),
      role: Type.Optional(Type.String({ description: "Role that selects a configured model, e.g. review or scout." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for the sub agent, e.g. [\"read\",\"grep\",\"find\"]." })),
      cwd: Type.Optional(Type.String({ description: "Working directory, relative to the current one." })),
      mode: Type.Optional(Type.Union([Type.Literal("autonomous"), Type.Literal("interactive")])),
      fork: Type.Optional(Type.Boolean({ description: "Give the sub agent this whole conversation instead of only `context`." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const hub = runtime.requireHub();
      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
      const model = resolveDogModel(runtime, hub, ctx, { model: params.model, role: params.role });
      const dog = await hub.spawn({
        task: params.task,
        context: params.context,
        name: params.name,
        model: model.model,
        thinking: model.thinking,
        role: params.role,
        tools: params.tools,
        cwd,
        mode: params.mode,
        forkEntries: params.fork ? (ctx.sessionManager.getBranch() as unknown as SeedEntry[]) : undefined,
        parentSession: ctx.sessionManager.getSessionFile(),
        sessionDir: runtime.sessionDirFor(ctx),
        approve: cwd === ctx.cwd && ctx.isProjectTrusted(),
      });
      return {
        content: [
          {
            type: "text",
            text:
              `Started subagent "${dog.name}" (${dog.model}${dog.thinking ? `:${dog.thinking}` : ""}, ${dog.mode}) in its own window. ` +
              "It works in the background; its result will arrive as a message. " +
              `Use subagent_steer with name "${dog.name}" to send it instructions.`,
          },
        ],
        details: { agentId: dog.agentId, name: dog.name, model: dog.model, mode: dog.mode, sessionFile: dog.sessionFile },
      };
    },
  });
}

export function registerControlTools(pi: ExtensionAPI, runtime: HubRuntime): void {
  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Subagent",
    description:
      "Send a message to a running sub agent. mode \"steer\" (default) is delivered at its next turn boundary; " +
      "\"followUp\" after it would otherwise stop.",
    parameters: Type.Object({
      name: Type.String({ description: "Name of the sub agent." }),
      message: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
    }),
    async execute(_id, params) {
      const hub = runtime.requireHub();
      const dog = findDog(hub, params.name);
      const result = hub.steer(dog, params.message, params.mode ?? "steer");
      if (!result.ok) throw new Error(result.error);
      return text(`Sent to ${dog.name}.`);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all sub agents of this session with state, model, runtime and usage.",
    parameters: Type.Object({}),
    async execute() {
      const hub = runtime.requireHub();
      const dogs = hub.registry.all();
      if (dogs.length === 0) return text("No subagents have been started.");
      const now = Date.now();
      return text(dogs.map((d) => `- ${describeDog(d, now)}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description: "Stop a sub agent and close its window. Its session file is kept.",
    parameters: Type.Object({ name: Type.String({ description: "Name of the sub agent." }) }),
    async execute(_id, params) {
      const hub = runtime.requireHub();
      const dog = findDog(hub, params.name);
      await hub.kill(dog, "stopped by the main agent", { report: false });
      return text(`Stopped ${dog.name} (${formatUsage(dog.usage)}). Session file: ${dog.sessionFile}`);
    },
  });

  pi.registerTool({
    name: "subagent_config",
    label: "Configure Subagents",
    description:
      "Set the default model for new sub agents in this session, and/or the model per role. " +
      'Use when the user says which models sub agents should use. Pass defaultModel "" to reset to the configured default.',
    parameters: Type.Object({
      defaultModel: Type.Optional(Type.String({ description: "Model pattern for new sub agents, e.g. ollama/qwen3.5:4b." })),
      roles: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Role → model pattern, e.g. {"review": "*sonnet*"}. Empty value removes a role.' })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const hub = runtime.requireHub();
      const models = runtime.usableModels(ctx);
      const check = (pattern: string) => {
        const r = resolveModelPattern(pattern, models);
        if (!r.ok) throw new Error(r.error);
        return r.ref + (r.thinking ? `:${r.thinking}` : "");
      };
      if (params.defaultModel !== undefined) hub.sessionDefaultModel = params.defaultModel.trim() ? check(params.defaultModel) : undefined;
      for (const [role, pattern] of Object.entries(params.roles ?? {})) {
        const key = role.trim().toLowerCase();
        if (!pattern.trim()) delete hub.sessionRoles[key];
        else hub.sessionRoles[key] = check(pattern);
      }
      return text(describeModelConfig(runtime, hub, ctx));
    },
  });
}

export function describeModelConfig(runtime: HubRuntime, hub: Hub, ctx: ExtensionContext | undefined): string {
  const roles = { ...runtime.config.models.roles, ...hub.sessionRoles };
  const lines = [
    `Default model for new subagents: ${hub.sessionDefaultModel ?? runtime.config.models.default ?? `same as the main agent (${runtime.mainModelRef(ctx) ?? "unknown"})`}` +
      (hub.sessionDefaultModel ? " (set for this session)" : runtime.config.models.default ? " (from pi-dogs.json)" : ""),
    Object.keys(roles).length ? `Roles: ${Object.entries(roles).map(([r, m]) => `${r} → ${m}`).join(", ")}` : "Roles: none",
  ];
  return lines.join("\n");
}
