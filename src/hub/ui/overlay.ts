/**
 * The mirror overlay: a live view of one dog inside the main pi, with a line
 * editor to steer it. Opened with the overlay shortcut or `/dogs show`.
 *
 * Two modes keep single-letter keys usable:
 * - view:  Tab / Shift+Tab next/previous dog, Enter steer, R restore window,
 *          M minimize window, K kill (press twice), ↑/↓/PgUp/PgDn scroll, Esc close
 * - steer: type a message, Enter sends it, Esc goes back to view
 *
 * Typing here happens in the *main* pi, so it never counts as a takeover of
 * the dog (docs/spike/pi-api.md, Q6).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

import { formatElapsed, formatTokens, elapsedOf } from "../format.ts";
import type { DogRecord, MirrorLine } from "../registry.ts";
import { isTerminal } from "../registry.ts";
import { rgb, stateBadge, visibleDogs } from "./rows.ts";

export interface OverlayActions {
  dogs(): DogRecord[];
  now(): number;
  steer(dog: DogRecord, text: string): string | undefined;
  restore(dog: DogRecord): void;
  minimize(dog: DogRecord): void;
  kill(dog: DogRecord): void;
  seen(dog: DogRecord): void;
}

const KILL_CONFIRM_MS = 3000;

export class MirrorOverlay implements Component, Focusable {
  focused = false;
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #actions: OverlayActions;
  readonly #close: () => void;
  readonly #input = new Input({ prompt: "" });
  #agentId: string | undefined;
  #mode: "view" | "steer" = "view";
  /** Lines scrolled up from the bottom; 0 follows new output. */
  #scroll = 0;
  #killArmedAt: number | undefined;
  #notice: string | undefined;

  constructor(tui: TUI, theme: Theme, actions: OverlayActions, close: () => void, agentId?: string) {
    this.#tui = tui;
    this.#theme = theme;
    this.#actions = actions;
    this.#close = close;
    this.#agentId = agentId;
    this.#input.onSubmit = (value) => this.#submit(value);
    this.#input.onEscape = () => this.#setMode("view");
  }

  /** The dog currently shown, falling back to the first visible one. */
  #dogs(): DogRecord[] {
    const now = this.#actions.now();
    const all = this.#actions.dogs();
    const visible = visibleDogs(all, now, Infinity);
    return visible.length ? visible : all;
  }

  #current(): DogRecord | undefined {
    const dogs = this.#dogs();
    return dogs.find((d) => d.agentId === this.#agentId) ?? dogs.find((d) => !isTerminal(d.state)) ?? dogs[dogs.length - 1];
  }

  handleInput(data: string): void {
    const dog = this.#current();
    if (this.#mode === "steer") {
      this.#input.handleInput(data);
      this.#tui.requestRender();
      return;
    }
    const letter = (ch: "s" | "r" | "m" | "k") => matchesKey(data, ch) || matchesKey(data, Key.shift(ch));
    if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) return this.#close();
    if (matchesKey(data, Key.tab)) return this.#cycle(1);
    if (matchesKey(data, Key.shift("tab"))) return this.#cycle(-1);
    if (!dog) return;
    if (matchesKey(data, Key.enter) || letter("s")) return this.#setMode("steer");
    if (matchesKey(data, Key.up)) return this.#scrollBy(1);
    if (matchesKey(data, Key.down)) return this.#scrollBy(-1);
    if (matchesKey(data, Key.pageUp)) return this.#scrollBy(10);
    if (matchesKey(data, Key.pageDown)) return this.#scrollBy(-10);
    if (matchesKey(data, Key.end)) return this.#scrollBy(-Infinity);
    if (letter("r")) return this.#act(() => this.#actions.restore(dog), `restoring ${dog.name}`);
    if (letter("m")) return this.#act(() => this.#actions.minimize(dog), `minimizing ${dog.name}`);
    if (letter("k")) {
      const now = this.#actions.now();
      if (this.#killArmedAt !== undefined && now - this.#killArmedAt < KILL_CONFIRM_MS) {
        this.#killArmedAt = undefined;
        return this.#act(() => this.#actions.kill(dog), `stopping ${dog.name}`);
      }
      this.#killArmedAt = now;
      this.#notice = `press K again to stop ${dog.name}`;
      this.#tui.requestRender();
    }
  }

  render(width: number): string[] {
    const t = this.#theme;
    const w = Math.max(20, width);
    const inner = w - 4;
    const dog = this.#current();
    if (dog) {
      this.#agentId = dog.agentId;
      this.#actions.seen(dog);
    }
    const bodyHeight = Math.max(6, Math.min(40, Math.floor(this.#tui.terminal.rows * 0.7) - 6));

    const border = (s: string) => t.fg("borderAccent", s);
    const row = (content: string) => border("│ ") + padTo(truncateToWidth(content, inner), inner) + border(" │");

    // Title bar: name · state · model · time · tokens ............ n/m [Esc]
    const dogs = this.#dogs();
    let title = " no dogs ";
    if (dog) {
      const badge = stateBadge(dog);
      const bits = [
        rgb(dog.color, "● ") + t.bold(dog.name),
        t.fg(badge.tone, `${badge.icon} ${badge.text}`) + (dog.minimized ? t.fg("dim", " · minimized") : ""),
        t.fg("muted", dog.model + (dog.thinking ? `:${dog.thinking}` : "")),
        t.fg("dim", formatElapsed(elapsedOf(dog, this.#actions.now()))),
        t.fg("dim", `${formatTokens(dog.usage.input + dog.usage.output)} tokens`),
      ];
      title = ` ${bits.join(t.fg("dim", " · "))} `;
    }
    const position = dog ? `${dogs.indexOf(dog) + 1}/${dogs.length} ` : "";
    const right = t.fg("dim", `${position}[Esc]`) + " ";
    const titleRoom = w - 2 - visibleWidth(right);
    const titleText = truncateToWidth(title, Math.max(0, titleRoom - 1));
    const top = border("┌") + titleText + border("─".repeat(Math.max(0, titleRoom - visibleWidth(titleText)))) + right + border("┐");

    const body = dog ? this.#bodyLines(dog, inner) : [t.fg("dim", "No subagents yet. The main agent starts them with the subagent tool.")];
    const maxScroll = Math.max(0, body.length - bodyHeight);
    this.#scroll = Math.min(this.#scroll, maxScroll);
    const end = body.length - this.#scroll;
    const visible = body.slice(Math.max(0, end - bodyHeight), end);
    while (visible.length < bodyHeight) visible.unshift("");

    const lines = [top, ...visible.map(row)];
    lines.push(border("├") + border("─".repeat(w - 2)) + border("┤"));
    lines.push(row(this.#footerInput(inner)));
    lines.push(row(this.#hints(dog)));
    lines.push(border("└" + "─".repeat(w - 2) + "┘"));
    return lines;
  }

  invalidate(): void {
    this.#input.invalidate();
  }

  #bodyLines(dog: DogRecord, width: number): string[] {
    const t = this.#theme;
    const out: string[] = [];
    const push = (text: string) => {
      for (const line of wrapTextWithAnsi(text, width)) out.push(line);
    };
    if (dog.mirror.length === 0) push(t.fg("dim", "(waiting for output)"));
    for (const line of dog.mirror) push(this.#styleLine(line));
    if (dog.outcome && isTerminal(dog.state)) {
      const o = dog.outcome;
      push("");
      push(t.fg(o.state === "done" ? "success" : "warning", `── ${o.state}${o.reason ? `: ${o.reason}` : ""}${o.error ? ` (error: ${o.error})` : ""}`));
    }
    return out;
  }

  #styleLine(line: MirrorLine): string {
    const t = this.#theme;
    switch (line.kind) {
      case "text":
        return line.text;
      case "tool": {
        const status = line.status === "running" ? t.fg("accent", "…") : line.status === "ok" ? t.fg("success", "✓") : t.fg("error", "✗");
        return `  ${t.fg("toolTitle", line.tool)}${line.args ? "  " + t.fg("muted", line.args) : ""}  ${status}`;
      }
      case "user":
        return t.fg("userMessageText", `${line.source === "hub" ? "main ›" : "you ›"} ${line.text}`);
      case "info":
        return t.fg("dim", `· ${line.text}`);
    }
  }

  #footerInput(width: number): string {
    const t = this.#theme;
    if (this.#mode === "steer") {
      this.#input.focused = this.focused;
      const label = t.fg("accent", "steer › ");
      const [line = ""] = this.#input.render(Math.max(1, width - visibleWidth(label)));
      return label + line;
    }
    if (this.#notice) return t.fg("warning", this.#notice);
    return t.fg("dim", "steer › (press Enter to type a message)");
  }

  #hints(dog: DogRecord | undefined): string {
    const t = this.#theme;
    const k = (key: string, label: string) => t.fg("accent", `[${key}]`) + t.fg("dim", ` ${label}`);
    if (this.#mode === "steer") return [k("Enter", "send"), k("Esc", "back")].join("  ");
    const hints = [k("Enter", "steer"), k("Tab", "next dog")];
    if (dog && !isTerminal(dog.state)) hints.push(dog.minimized ? k("R", "restore") : k("M", "minimize"), k("K", "kill"));
    hints.push(k("↑↓", "scroll"), k("Esc", "close"));
    return hints.join("  ");
  }

  #submit(value: string): void {
    const dog = this.#current();
    const text = value.trim();
    if (!dog || !text) return;
    const error = this.#actions.steer(dog, text);
    if (error) this.#notice = error;
    else {
      this.#input.setValue("");
      this.#scroll = 0;
      this.#notice = undefined;
    }
    this.#setMode(error ? "view" : "steer");
  }

  #setMode(mode: "view" | "steer"): void {
    this.#mode = mode;
    if (mode === "steer") this.#notice = undefined;
    this.#tui.requestRender();
  }

  #cycle(step: number): void {
    const dogs = this.#dogs();
    if (dogs.length === 0) return;
    const current = this.#current();
    const index = current ? dogs.indexOf(current) : -1;
    this.#agentId = dogs[(index + step + dogs.length) % dogs.length]!.agentId;
    this.#scroll = 0;
    this.#notice = undefined;
    this.#killArmedAt = undefined;
    this.#tui.requestRender();
  }

  #scrollBy(lines: number): void {
    this.#scroll = Math.max(0, lines === -Infinity ? 0 : this.#scroll + lines);
    this.#tui.requestRender();
  }

  #act(action: () => void, notice: string): void {
    this.#notice = notice;
    action();
    this.#tui.requestRender();
  }
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
