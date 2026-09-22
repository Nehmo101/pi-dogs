/**
 * Funny dog names for subagents that were started without an explicit name.
 *
 * Names are display names: they appear in window titles, the dock, the mirror
 * overlay and result messages, and the main agent uses them to address a dog.
 * They may only contain letters, digits, spaces, dots and hyphens so that they
 * are safe in window titles and command lines. Every dog additionally gets a
 * technical `agentId` (see `makeAgentId`), which is what the protocol uses.
 */

export const DOG_NAMES: readonly string[] = Object.freeze([
  // German
  "Sir Wuffelot",
  "Bello Baggins",
  "Kläffi McKläffface",
  "Pfotenprinz",
  "Waldi Wirbelwind",
  "Graf Schnuffel",
  "Frau Wuff",
  "Hasso Hurtig",
  "Bello Bytebeißer",
  "Rex Rechenknecht",
  "Struppi Stackspur",
  "Fiffi Fehlerfrei",
  "Lumpi Lückenlos",
  "Schnuffi Schnell",
  "Kommissar Rex",
  "Baron von Bellheim",
  "Wurstwedel",
  "Knochenkönig",
  "Herr Hechel",
  "Tante Tatze",
  "Pfötchen Pünktlich",
  "Rudi Rüssel",
  "Brummbär Bruno",
  "Flocke Flink",
  "Senf der Spürhund",
  "Dackel Dynamit",
  "Hundini",
  "Schlappohr",
  "Wauzi Wunderbar",
  "Bürste Borstig",
  "Momo Mampf",
  // English
  "Doggo Dynamo",
  "Sir Barksalot",
  "Woofgang Amadeus",
  "Bark Twain",
  "Sherlock Bones",
  "Chewbarka",
  "Droolius Caesar",
  "Hairy Pawter",
  "Pup Tart",
  "Captain Sniffles",
  "Muttley Crew",
  "Biscuit Byte",
  "Lord Fluffington",
  "Snoop Dogg-ish",
  "Fetch Overflow",
  "Waggle Wizard",
  "Pixel Paws",
  "Barkley Debugger",
  "Noodle Nose",
  "Duke of Drool",
  "Tail Recursion",
  "Pupperoni",
  "Bitsy Borkins",
  "Scruffy Scripter",
  "Howl Pacino",
  "Ruff Diff",
  "Mister Sniffs",
  "Wiggle Butt",
  "Nacho Pup",
  "Lint Retriever",
  "Git Pup",
  "Null Pointer Pup",
  "Captain Wagtail",
  "Bork Knight",
]);

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .\-]*$/u;

/** Maximum length of a dog name, in UTF-16 code units. */
export const MAX_DOG_NAME_LENGTH = 40;

/**
 * Whether `name` can be used as a display name. Apostrophes and quotes are
 * deliberately not allowed because they would need quoting on command lines.
 */
export function isValidDogName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_DOG_NAME_LENGTH && NAME_PATTERN.test(name) && name.trim() === name;
}

/** Normalize a user-provided name: trim, collapse whitespace, drop unsafe characters. */
export function sanitizeDogName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} .\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\-\s]+/, "")
    .slice(0, MAX_DOG_NAME_LENGTH)
    .trim();
}

const key = (name: string) => name.toLocaleLowerCase("en");

/**
 * Pick a name that is not in `taken` (case-insensitive). If `preferred` is
 * given it is used, with " 2", " 3", ... appended when already taken.
 * Otherwise a random unused name from `pool` is chosen; once the pool is
 * exhausted, a number is appended to a random pool name.
 */
export function pickDogName(
  taken: Iterable<string>,
  options: { preferred?: string; pool?: readonly string[]; random?: () => number } = {},
): string {
  const used = new Set([...taken].map(key));
  const random = options.random ?? Math.random;
  const withSuffix = (base: string): string => {
    if (!used.has(key(base))) return base;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const candidate = base.slice(0, MAX_DOG_NAME_LENGTH - suffix.length).trimEnd() + suffix;
      if (!used.has(key(candidate))) return candidate;
    }
  };

  if (options.preferred !== undefined) {
    const clean = sanitizeDogName(options.preferred);
    if (clean) return withSuffix(clean);
  }
  const pool = (options.pool ?? DOG_NAMES).filter(isValidDogName);
  if (pool.length === 0) return withSuffix("Dog");
  const free = pool.filter((name) => !used.has(key(name)));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  return withSuffix(pool[Math.floor(random() * pool.length)]!);
}

const TRANSLITERATION: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/**
 * Technical agent id derived from the name: lowercase ASCII slug plus a short
 * random suffix, e.g. "bello-baggins-3f2a". Safe for file names, pipe
 * messages and window titles.
 */
export function makeAgentId(name: string, randomHex: () => string): string {
  const slug = name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => TRANSLITERATION[c] ?? c)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return `${slug || "dog"}-${randomHex()}`;
}
