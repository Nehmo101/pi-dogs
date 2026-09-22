/**
 * Plain-text formatting shared by tools, commands, the dock and result messages.
 */
import type { Usage } from "../protocol/types.ts";
import type { DogRecord } from "./registry.ts";
import { modelLabel } from "./models.ts";

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined || cost <= 0) return undefined;
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** "12.4k in / 1.2k out, $0.03" */
export function formatUsage(usage: Usage): string {
  const parts = [`${formatTokens(usage.input)} in / ${formatTokens(usage.output)} out`];
  const cost = formatCost(usage.cost);
  if (cost) parts.push(cost);
  return parts.join(", ");
}

/** mm:ss below an hour, h:mm:ss above. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function elapsedOf(dog: DogRecord, now: number): number {
  return (dog.endedAt ?? now) - dog.startedAt;
}

export const STATE_LABELS: Record<DogRecord["state"], string> = {
  starting: "starting",
  running: "running",
  idle: "idle",
  closing: "closing",
  done: "done",
  failed: "failed",
  killed: "killed",
};

/** One line per dog for `subagent_list` and `/dogs`. */
export function describeDog(dog: DogRecord, now: number): string {
  const live = dog.state !== "starting" && dog.state !== "done" && dog.state !== "failed" && dog.state !== "killed";
  const flags = [dog.minimized ? "minimized" : "", dog.takenOver ? "taken over by user" : "", live && !dog.connected ? "disconnected" : ""]
    .filter(Boolean)
    .join(", ");
  const parts = [
    `${dog.name}`,
    STATE_LABELS[dog.state] + (flags ? ` (${flags})` : ""),
    modelLabel(dog.model) + (dog.thinking ? `:${dog.thinking}` : ""),
    dog.mode,
    formatElapsed(elapsedOf(dog, now)),
    formatUsage(dog.usage),
  ];
  if (dog.currentTool) parts.push(`tool: ${dog.currentTool}`);
  return parts.join(" · ");
}

/** Truncate to `max` characters, adding an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export interface ResultDetails {
  agentId: string;
  name: string;
  model: string;
  state: "done" | "failed" | "killed";
  usage: Usage;
  sessionFile: string;
  elapsedMs: number;
  error?: string;
  reason?: string;
}

/** Text of the custom message that hands a dog's result to the main agent. */
export function buildResultText(d: ResultDetails & { summary?: string | undefined }): string {
  const who = `Subagent "${d.name}" (${d.model})`;
  const lines: string[] = [];
  if (d.state === "done" && !d.error) lines.push(`${who} finished.`);
  else if (d.state === "done") lines.push(`${who} finished with an error: ${d.error}`);
  else if (d.state === "failed") lines.push(`${who} failed${d.reason ? `: ${d.reason}` : "."}`);
  else lines.push(`${who} was stopped${d.reason ? ` (${d.reason})` : ""}.`);
  lines.push(`Usage: ${formatUsage(d.usage)} · time ${formatElapsed(d.elapsedMs)}`);
  lines.push(`Session file: ${d.sessionFile}` + (d.state === "done" ? "" : " (resume with `pi --session <file>`)"));
  if (d.summary?.trim()) lines.push("", "Result:", d.summary.trim());
  else if (d.state === "done") lines.push("", "Result: (the subagent returned no summary)");
  return lines.join("\n");
}
