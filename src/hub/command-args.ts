/**
 * Parsing for `/dogs <subcommand> <name> [text]`. Dog names can contain
 * spaces ("Bello Baggins"), so the name is the longest run of leading words
 * that identifies a dog.
 */
import type { DogRecord, Registry } from "./registry.ts";

export const SUBCOMMANDS = ["list", "mirror", "show", "min", "steer", "kill", "model", "new", "setup-keys", "help"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

/** Words of `text` with their start offsets, so a remainder can be cut out verbatim. */
function words(text: string): { word: string; start: number }[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({ word: m[0], start: m.index }));
}

/** Everything after the first `n` words, exactly as typed (only the surrounding whitespace is dropped). */
function afterWords(text: string, n: number): string {
  const w = words(text);
  if (n >= w.length) return "";
  return text.slice(w[n]!.start).trimEnd();
}

export function parseSubcommand(args: string): { sub: Subcommand | undefined; rest: string; raw: string } {
  const trimmed = args.trim();
  const first = words(trimmed)[0]?.word ?? "";
  const word = first.toLowerCase();
  const alias: Record<string, Subcommand> = { ls: "list", minimize: "min", stop: "kill", overlay: "mirror", view: "mirror", restore: "show" };
  const sub = (SUBCOMMANDS as readonly string[]).includes(word) ? (word as Subcommand) : alias[word];
  return { sub: trimmed === "" ? "list" : sub, rest: afterWords(trimmed, 1), raw: first };
}

/** Split "<dog name> <text>" using the registry. Returns undefined if no leading words name a dog. */
export function splitDogAndText(text: string, registry: Registry): { dog: DogRecord; text: string } | undefined {
  const list = words(text).map((w) => w.word);
  for (let n = list.length; n >= 1; n--) {
    const dog = registry.find(list.slice(0, n).join(" "));
    if (dog) return { dog, text: afterWords(text, n) };
  }
  return undefined;
}

/** Parse `/dogs new [--model <pattern>] [--mode interactive] <task>`. */
export function parseNewArgs(text: string): { model?: string; mode?: "autonomous" | "interactive"; name?: string; task: string } {
  const out: { model?: string; mode?: "autonomous" | "interactive"; name?: string; task: string } = { task: "" };
  const tokens = words(text).map((w) => w.word);
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ((t === "--model" || t === "-m") && tokens[i + 1]) out.model = tokens[++i]!;
    else if (t === "--interactive" || t === "-i") out.mode = "interactive";
    else if (t === "--name" && tokens[i + 1]) out.name = tokens[++i]!;
    else break;
  }
  out.task = afterWords(text, i);
  return out;
}
