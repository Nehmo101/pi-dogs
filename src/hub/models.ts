/**
 * Model selection for dogs (docs/PLAN.md, section 14.2).
 *
 * Patterns follow pi's `--model` syntax: `provider/id`, a bare `id`, a
 * case-insensitive glob (`*sonnet*`) or a fuzzy substring, each optionally
 * followed by `:<thinking level>`. Resolution runs against the models the main
 * pi can actually use, *before* a window is opened, so a typo produces a clear
 * error with suggestions instead of a broken window.
 *
 * Everything here is pure; the hub passes in plain model descriptors taken
 * from `ctx.modelRegistry.getAvailable()`.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export type ResolveResult =
  | { ok: true; model: ModelInfo; ref: string; thinking?: ThinkingLevel }
  | { ok: false; error: string; suggestions: string[] };

export const modelRef = (m: ModelInfo): string => `${m.provider}/${m.id}`;

const lower = (s: string) => s.toLowerCase();
const isThinking = (s: string): s is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(s);

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/** Prefer aliases over dated snapshots (`-20250929`), then the lexically latest id. */
function pickBest(candidates: ModelInfo[]): ModelInfo {
  const dated = /-\d{8}$/;
  return [...candidates].sort((a, b) => {
    const da = dated.test(a.id) ? 1 : 0;
    const db = dated.test(b.id) ? 1 : 0;
    if (da !== db) return da - db;
    return b.id.localeCompare(a.id, "en", { numeric: true });
  })[0]!;
}

/** Match a pattern without a thinking suffix. Returns the matches of the first rule that hits. */
function match(pattern: string, models: readonly ModelInfo[]): ModelInfo[] {
  const p = lower(pattern);
  const exactRef = models.filter((m) => lower(modelRef(m)) === p);
  if (exactRef.length) return exactRef;
  const exactId = models.filter((m) => lower(m.id) === p);
  if (exactId.length) return exactId;

  if (/[*?]/.test(pattern)) {
    const re = globToRegExp(pattern);
    return models.filter((m) => re.test(modelRef(m)) || re.test(m.id) || (m.name !== undefined && re.test(m.name)));
  }

  // "provider/fuzzy": restrict to that provider.
  const slash = p.indexOf("/");
  if (slash > 0) {
    const provider = p.slice(0, slash);
    const rest = p.slice(slash + 1);
    const inProvider = models.filter((m) => lower(m.provider) === provider);
    if (inProvider.length) return inProvider.filter((m) => lower(m.id).includes(rest) || lower(m.name ?? "").includes(rest));
  }
  return models.filter((m) => lower(m.id).includes(p) || lower(m.name ?? "").includes(p));
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Up to `limit` model refs that look similar to `pattern`. */
export function suggestModels(pattern: string, models: readonly ModelInfo[], limit = 5): string[] {
  const p = lower(pattern.replace(/[*?]/g, ""));
  return models
    .map((m) => {
      const id = lower(m.id);
      const ref = lower(modelRef(m));
      const score = Math.min(levenshtein(p, id), levenshtein(p, ref)) - (id.includes(p) || p.includes(id) ? 100 : 0);
      return { ref: modelRef(m), score };
    })
    .sort((a, b) => a.score - b.score || a.ref.localeCompare(b.ref))
    .slice(0, limit)
    .map((s) => s.ref);
}

/**
 * Resolve a model pattern against the usable models. The full pattern is tried
 * first because model ids may contain colons (`qwen3.5:4b`); only if that
 * fails is a trailing `:<thinking level>` split off.
 */
export function resolveModelPattern(pattern: string, models: readonly ModelInfo[]): ResolveResult {
  const trimmed = pattern.trim();
  if (!trimmed) return { ok: false, error: "Empty model pattern.", suggestions: [] };
  if (models.length === 0) {
    return { ok: false, error: "No usable models: no provider is logged in or configured.", suggestions: [] };
  }

  const attempt = (p: string, thinking?: ThinkingLevel): ResolveResult | undefined => {
    const hits = match(p, models);
    if (hits.length === 0) return undefined;
    const model = pickBest(hits);
    return thinking ? { ok: true, model, ref: modelRef(model), thinking } : { ok: true, model, ref: modelRef(model) };
  };

  const direct = attempt(trimmed);
  if (direct) return direct;
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const suffix = lower(trimmed.slice(colon + 1));
    if (isThinking(suffix)) {
      const withThinking = attempt(trimmed.slice(0, colon), suffix);
      if (withThinking) return withThinking;
    }
  }
  const suggestions = suggestModels(trimmed, models);
  return {
    ok: false,
    error: `Unknown or unavailable model "${trimmed}".` + (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
    suggestions,
  };
}

export type ModelSource = "call" | "role" | "session" | "config" | "main";

export interface ModelDefaults {
  /** Session default set via `/dogs model` or `subagent_config`. */
  sessionDefault?: string | undefined;
  /** Session role overrides set via `subagent_config`. */
  sessionRoles?: Readonly<Record<string, string>>;
  /** From pi-dogs.json. */
  configDefault?: string | undefined;
  configRoles?: Readonly<Record<string, string>>;
  /** The main agent's current model as `provider/id`. */
  mainModel?: string | undefined;
}

/**
 * Pick the pattern to use for a new dog. Order (PLAN 14.2): explicit `model`
 * → `role` (session map, then config map) → session default → config default
 * → main agent's model.
 */
export function chooseModelPattern(
  request: { model?: string | undefined; role?: string | undefined },
  defaults: ModelDefaults,
): { pattern: string; source: ModelSource } | undefined {
  if (request.model?.trim()) return { pattern: request.model.trim(), source: "call" };
  const role = request.role?.trim().toLowerCase();
  if (role) {
    const pattern = defaults.sessionRoles?.[role] ?? defaults.configRoles?.[role];
    if (pattern) return { pattern, source: "role" };
  }
  if (defaults.sessionDefault) return { pattern: defaults.sessionDefault, source: "session" };
  if (defaults.configDefault) return { pattern: defaults.configDefault, source: "config" };
  if (defaults.mainModel) return { pattern: defaults.mainModel, source: "main" };
  return undefined;
}

/** Compact, length-limited list of usable models for the `subagent` tool description. */
export function formatModelList(models: readonly ModelInfo[], maxChars = 900): string {
  const refs = [...new Set(models.map(modelRef))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const out: string[] = [];
  let length = 0;
  for (const ref of refs) {
    if (length + ref.length + 2 > maxChars) break;
    out.push(ref);
    length += ref.length + 2;
  }
  const rest = refs.length - out.length;
  return out.join(", ") + (rest > 0 ? `, … (+${rest} more)` : "");
}

/** Short label for titles and the dock: the model id without the provider. */
export function modelLabel(ref: string): string {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}
