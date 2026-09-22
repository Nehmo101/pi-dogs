/**
 * Pure view model for the dock and the overlay header: which dogs to show
 * and what each cell says. Styling happens in dock.ts / overlay.ts.
 */
import type { DogRecord } from "../registry.ts";
import { isTerminal } from "../registry.ts";
import { elapsedOf, formatElapsed, formatTokens } from "../format.ts";
import { modelLabel } from "../models.ts";

/** Finished dogs stay visible in the dock for this long. */
export const FINISHED_LINGER_MS = 20_000;

export type Tone = "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text";

export interface DogRow {
  agentId: string;
  name: string;
  color: string;
  model: string;
  stateIcon: string;
  stateText: string;
  tone: Tone;
  tool: string;
  elapsed: string;
  tokens: string;
  minimized: boolean;
  unseen: boolean;
}

/** Dogs worth showing: all live ones plus recently finished ones, in start order. */
export function visibleDogs(dogs: readonly DogRecord[], now: number, lingerMs = FINISHED_LINGER_MS): DogRecord[] {
  return dogs.filter((d) => !isTerminal(d.state) || (d.endedAt !== undefined && now - d.endedAt < lingerMs));
}

export function stateBadge(dog: DogRecord): { icon: string; text: string; tone: Tone } {
  if (dog.takenOver && (dog.state === "running" || dog.state === "idle")) return { icon: "✋", text: "by hand", tone: "warning" };
  if (!dog.connected && (dog.state === "running" || dog.state === "idle")) return { icon: "⚡", text: "reconnecting", tone: "warning" };
  switch (dog.state) {
    case "starting":
      return { icon: "…", text: "starting", tone: "dim" };
    case "running":
      return { icon: "▶", text: "running", tone: "accent" };
    case "idle":
      return { icon: "⏸", text: "idle", tone: "muted" };
    case "closing":
      return { icon: "⏏", text: "closing", tone: "muted" };
    case "done":
      return dog.outcome?.error ? { icon: "!", text: "done (error)", tone: "warning" } : { icon: "✓", text: "done", tone: "success" };
    case "failed":
      return { icon: "✗", text: "failed", tone: "error" };
    case "killed":
      return { icon: "■", text: "stopped", tone: "warning" };
  }
}

export function toRow(dog: DogRecord, now: number): DogRow {
  const badge = stateBadge(dog);
  return {
    agentId: dog.agentId,
    name: dog.name,
    color: dog.color,
    model: modelLabel(dog.model) + (dog.thinking ? `:${dog.thinking}` : ""),
    stateIcon: badge.icon,
    stateText: badge.text,
    tone: badge.tone,
    tool: dog.currentTool ?? "",
    elapsed: formatElapsed(elapsedOf(dog, now)),
    tokens: formatTokens(dog.usage.input + dog.usage.output),
    minimized: dog.minimized,
    unseen: dog.unseen,
  };
}

/** 24-bit foreground colour for a #rrggbb string (the dog's identity colour). */
export function rgb(hex: string, text: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return text;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
