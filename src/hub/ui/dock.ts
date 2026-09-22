/**
 * The dock: a widget above the main editor with one line per dog.
 *
 *   ● Bello Baggins   qwen3.5:4b   ▶ running   bash    00:42   3.1k
 *   ● Sir Wuffelot    sonnet-5     ✋ by hand           01:10  12k
 *   ● Pfotenprinz     qwen3.5:4b   ⏸ idle  min         03:10  ◉
 *
 * It is a component (not a string array), so it is not limited to 10 lines
 * and re-renders in place: data changes call `tui.requestRender()`, which pi
 * coalesces and draws differentially.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { isTerminal, type DogRecord } from "../registry.ts";
import { rgb, toRow, visibleDogs, type DogRow } from "./rows.ts";

export interface DockSource {
  dogs(): DogRecord[];
  now(): number;
  /** Shortcut hint shown in the header, e.g. "ctrl+l". */
  shortcut(): string | undefined;
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));

export class DockComponent implements Component {
  readonly #source: DockSource;
  readonly #theme: Theme;

  constructor(source: DockSource, theme: Theme) {
    this.#source = source;
    this.#theme = theme;
  }

  render(width: number): string[] {
    const now = this.#source.now();
    const dogs = visibleDogs(this.#source.dogs(), now);
    const rows = dogs.map((d) => toRow(d, now));
    if (rows.length === 0) return [];
    const t = this.#theme;
    const nameW = Math.min(22, Math.max(...rows.map((r) => visibleWidth(r.name))));
    const modelW = Math.min(20, Math.max(...rows.map((r) => visibleWidth(r.model))));
    const stateW = Math.max(...rows.map((r) => visibleWidth(`${r.stateIcon} ${r.stateText}${r.minimized ? "  min" : ""}`)));
    const toolW = Math.min(14, Math.max(0, ...rows.map((r) => visibleWidth(r.tool))));

    const shortcut = this.#source.shortcut();
    const live = dogs.filter((d) => !isTerminal(d.state)).length;
    const title = ` 🐕 dogs · ${live} active`;
    const hint = shortcut ? `${shortcut} mirror · /dogs ` : "/dogs ";
    const fill = Math.max(1, width - visibleWidth(title) - visibleWidth(hint) - 2);
    const header = t.fg("borderMuted", "─") + t.fg("muted", title) + " " + t.fg("borderMuted", "─".repeat(fill)) + " " + t.fg("dim", hint);

    const lines = [truncateToWidth(header, width)];
    for (const r of rows) lines.push(truncateToWidth(this.#line(r, nameW, modelW, stateW, toolW), width));
    return lines;
  }

  #line(r: DogRow, nameW: number, modelW: number, stateW: number, toolW: number): string {
    const t = this.#theme;
    const name = pad(truncateToWidth(r.name, nameW), nameW);
    const model = t.fg("muted", pad(truncateToWidth(r.model, modelW), modelW));
    const stateText = `${r.stateIcon} ${r.stateText}`;
    const state = pad(t.fg(r.tone, stateText) + (r.minimized ? t.fg("dim", "  min") : ""), stateW);
    const tool = toolW ? t.fg("toolTitle", pad(truncateToWidth(r.tool, toolW), toolW)) + "  " : "";
    const unseen = r.unseen ? " " + t.fg("accent", "◉") : "";
    return ` ${rgb(r.color, "●")} ${t.bold(name)}  ${model}  ${state}  ${tool}${t.fg("dim", r.elapsed)}  ${t.fg("dim", r.tokens)}${unseen}`;
  }

  invalidate(): void {
    // Stateless: everything is computed in render().
  }
}
