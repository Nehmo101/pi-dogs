/**
 * Deciding when an autonomous dog is finished, and what it reports.
 *
 * An autonomous dog normally ends by calling `subagent_done`. If the model
 * forgets and simply stops, the dog finishes automatically once pi has
 * settled, with its last assistant message as the summary (the approach of
 * HazAT/pi-interactive-subagents, MIT, see NOTICE). A run the user aborted
 * (Esc) is left open, and a dog that was taken over by hand never finishes on
 * its own.
 */

/** Minimal message shape (pi's AgentMessage) used here. */
export interface MessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Text of the last assistant message that has any text. */
export function lastAssistantText(messages: readonly MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = textOf(m.content);
    if (text) return text;
  }
  return "";
}

/** Stop reason and error of the last assistant message, if any. */
export function lastStop(messages: readonly MessageLike[]): { stopReason?: string; errorMessage?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const out: { stopReason?: string; errorMessage?: string } = {};
    if (m.stopReason) out.stopReason = m.stopReason;
    if (m.errorMessage) out.errorMessage = m.errorMessage;
    return out;
  }
  return {};
}

export type AutoDoneDecision = { action: "none"; why: string } | { action: "done"; summary: string; error?: string };

export function decideAutoDone(input: {
  mode: "autonomous" | "interactive";
  takenOver: boolean;
  alreadyDone: boolean;
  /** The task has been delivered and at least one run completed since. */
  ranTask: boolean;
  messages: readonly MessageLike[];
}): AutoDoneDecision {
  if (input.alreadyDone) return { action: "none", why: "already done" };
  if (input.mode !== "autonomous") return { action: "none", why: "interactive mode" };
  if (input.takenOver) return { action: "none", why: "taken over by the user" };
  if (!input.ranTask) return { action: "none", why: "task not run yet" };
  const stop = lastStop(input.messages);
  if (stop.stopReason === "aborted") return { action: "none", why: "run was aborted" };
  const summary = lastAssistantText(input.messages);
  if (stop.stopReason === "error") {
    return { action: "done", summary, error: stop.errorMessage?.trim() || "the model run ended with an error" };
  }
  return { action: "done", summary };
}
