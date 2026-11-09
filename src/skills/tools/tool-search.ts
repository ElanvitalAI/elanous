import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── ToolSearch LLM tool (Coding Pipeline P1) ──
//
// Pattern adapted from claude-code-fork's `src/tools/ToolSearchTool/
// ToolSearchTool.ts`. Fetches full JSONSchema definitions for deferred
// tools on demand so the base system prompt can stay lean.
//
// Query grammar:
//
//   - "select:FooTool,BarTool,Baz"  → direct selection by name/alias.
//     Case-insensitive match against both `LLMToolSpec.name` and the
//     catalog `aliases[]`.
//
//   - "+slack send"                 → must-include term ("slack") + rank
//     by remaining free-text terms.
//
//   - "keyword text"                → ranked fuzzy search. Matches
//     against spec.name, spec.description, and catalog.promptSummary.
//
// Result shape: one `<functions>{"description":..., "name":...,
// "parameters":{...}}</functions>` block per match, matching the base
// tool-listing encoding exactly. The LLM that receives this block
// already knows how to call the tool on the next turn — no extra
// registry wiring required.
//
// Safety:
//   - Only deferred, toolSearchable-true tools are eligible. Catalog
//     entries marked `toolSearchable: false` (e.g. ToolSearch itself,
//     or safety-sensitive meta-tools) are excluded from all queries.
//   - A schema is only surfaced when we can actually dispatch it: it
//     must be registered in the runtime registry **or** present in the
//     caller's surface spec pool (see below). We never hand the model a
//     schema for a tool the current surface cannot route.
//
// ⭐ Surface spec pool (2026-07-26 · RFC-observability-driven-tool-selection F2):
//   The runtime registry is a *dashboard* concept. Daemon surfaces
//   (`webterm`/ACP, `chat`) build their tool list directly in
//   `boot/daemon-tools/index.ts` and route by a name switch — those
//   tools (SelfImplement, RunDevHarness, SolveMission, …) are never
//   registered as ToolRuntimes. Resolving only against the registry
//   therefore made ToolSearch answer "no matches" for exactly the
//   battleship tools the daemon surfaces defer. Callers now pass their
//   own `specs` and those resolve FIRST.
//
// Philosophy:
//   "Load the agility-tier (specops) by default; call the big-armada
//    only when it's needed." ToolSearch is the armada's dispatcher —
//    and a dispatcher that cannot reach the armada is not a dispatcher.


import { nativeToolCatalog, type NativeToolCatalogEntry } from '../../native-tool-catalog.js';
import { listToolRuntimes } from '../../tool-runtime/registry.js';
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_HARD_CAP, HYDRATED_TOOLS_KEY } from './tool-search-spec.js';
import { buildToolRouteIndex, routeToolIntentWithFallback } from '../../tool-router/index.js';
import { debug } from '../../debug/log.js';

export { buildToolSearchTool, TOOL_SEARCH_NAME } from './tool-search-spec.js';

export interface ToolSearchArgs {
  /** "select:FooTool,BarTool" | "+slack send" | "free text". */
  query: string;
  /** Max matches to return. Default 5, hard-capped at 25. */
  max_results?: number;
}

export interface ToolSearchOpts {
  /** Surface-local spec pool — the full tool list the calling surface
   *  exposes this turn. Schemas resolve from here before the runtime
   *  registry, so surfaces with no ToolRuntime registration can still
   *  hydrate their own deferred tools. Omit for registry-only lookup
   *  (dashboard behaviour, unchanged). */
  specs?: readonly LLMToolSpec[];
  /** Optional surface label for route-decision observations. */
  surface?: string;
}

export interface ToolSearchResult {
  /** Rendered `<functions>...</functions>` block the LLM can read. */
  content: string;
  /** Tool names that were resolved. Useful for tests and audit. */
  matched: string[];
  /** Names the query asked for (via `select:`) that we couldn't resolve. */
  unknown: string[];
  /** ⭐ Hydration hand-off (gap④) — the resolved specs, for the tool loop to
   *  add to the provider tool list. Rendering the schema as text is NOT enough
   *  to make a tool callable. `takeHydratedTools` strips this before the
   *  result reaches the conversation, so the schemas aren't paid for twice. */
  [HYDRATED_TOOLS_KEY]?: LLMToolSpec[];
}

/** Parse the `query` parameter into an (kind, terms, requiredTerms) tuple. */
export interface ParsedQuery {
  kind: 'select' | 'keyword';
  /** Names requested via `select:` — preserved in original order. */
  selectNames: string[];
  /** Non-required search terms (lowercase). */
  terms: string[];
  /** Required terms (prefixed with `+` in the query). */
  required: string[];
}

export function parseToolSearchQuery(raw: string): ParsedQuery {
  const text = String(raw ?? '').trim();
  if (text.toLowerCase().startsWith('select:')) {
    const list = text.slice('select:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { kind: 'select', selectNames: list, terms: [], required: [] };
  }
  const required: string[] = [];
  const terms: string[] = [];
  for (const tok of text.split(/\s+/).filter((s) => s.length > 0)) {
    if (tok.startsWith('+') && tok.length > 1) {
      required.push(tok.slice(1).toLowerCase());
    } else {
      terms.push(tok.toLowerCase());
    }
  }
  return { kind: 'keyword', selectNames: [], terms, required };
}

/** One resolvable tool: catalog metadata (when there is any) fused with
 *  the concrete schema we would render. Built per dispatch so the
 *  surface spec pool can participate in both `select:` and keyword
 *  queries. */
interface SearchCandidate {
  /** LLM-facing name rendered into the result + reported in `matched`. */
  displayName: string;
  /** Every string that should count as a "name" hit, lowercased. */
  nameText: string;
  /** Lowercased match keys for `select:` resolution. */
  keys: string[];
  summary: string;
  description: string;
  spec: LLMToolSpec;
}

/** Index a surface spec pool by lowercased tool name. */
function buildSpecPool(specs: readonly LLMToolSpec[] | undefined): Map<string, LLMToolSpec> {
  const pool = new Map<string, LLMToolSpec>();
  for (const spec of specs ?? []) {
    if (spec && typeof spec.name === 'string') pool.set(spec.name.toLowerCase(), spec);
  }
  return pool;
}

/** Resolve a catalog entry to a concrete schema.
 *
 *  ⚠️ When the caller supplied `specs`, that pool is the **authoritative
 *  allowlist** — we never fall back to the global runtime registry.
 *  The pool is exactly what the calling surface can dispatch this turn;
 *  a registry hit outside it would hand the model a schema the surface
 *  answers with `unknown tool`, and would defeat nest-cap (which drops
 *  child-spawn tools from the surface catalog, not from the registry).
 *  Registry lookup is the no-pool (dashboard) path only. */
function specForEntry(
  entry: NativeToolCatalogEntry,
  pool: Map<string, LLMToolSpec>,
  authoritative: boolean,
): LLMToolSpec | null {
  for (const key of [entry.displayName, entry.id, ...entry.aliases]) {
    const hit = pool.get(key.toLowerCase());
    if (hit) return hit;
  }
  if (authoritative) return null;
  const rt = listToolRuntimes().find((r) => r.id === entry.id);
  return rt?.spec ?? null;
}

/** Return the set of catalog entries eligible for a ToolSearch result:
 *  must be dispatchable (present in the surface spec pool when one is
 *  given, otherwise runtime-registered), must not have
 *  toolSearchable=false.
 *  Intentionally permissive on tier — we surface BOTH alwaysLoad +
 *  deferred entries so `select:AlreadyLoaded` returns a helpful
 *  "already loaded" hint rather than a silent miss. */
export function listSearchableCatalog(
  specs?: readonly LLMToolSpec[],
): NativeToolCatalogEntry[] {
  const pool = buildSpecPool(specs);
  const authoritative = specs !== undefined;
  return nativeToolCatalog.filter((entry) => {
    if (entry.toolSearchable === false) return false;
    return specForEntry(entry, pool, authoritative) !== null;
  });
}

/** Build the full candidate set: every searchable catalog entry we can
 *  resolve, plus any surface spec that has no catalog entry at all
 *  (the `IMPLICIT_DEFERRED_BY_NAME` tier in tier-flip defers those by
 *  name, so ToolSearch must be able to hydrate them too). */
function listSearchCandidates(specs: readonly LLMToolSpec[] | undefined): SearchCandidate[] {
  const pool = buildSpecPool(specs);
  // Pool supplied ⇒ closed world. See specForEntry for why.
  const authoritative = specs !== undefined;
  const candidates: SearchCandidate[] = [];
  const claimed = new Set<string>();
  for (const entry of nativeToolCatalog) {
    if (entry.toolSearchable === false) {
      // Mark as claimed so a pool spec with the same name cannot sneak
      // back in through the catalog-less path below.
      for (const key of [entry.displayName, entry.id, ...entry.aliases]) claimed.add(key.toLowerCase());
      continue;
    }
    const spec = specForEntry(entry, pool, authoritative);
    if (!spec) continue;
    for (const key of [entry.displayName, entry.id, ...entry.aliases]) claimed.add(key.toLowerCase());
    claimed.add(spec.name.toLowerCase());
    candidates.push({
      displayName: entry.displayName,
      nameText: `${entry.displayName} ${entry.id} ${entry.aliases.join(' ')}`.toLowerCase(),
      keys: [entry.displayName, entry.id, ...entry.aliases].map((k) => k.toLowerCase()),
      summary: entry.promptSummary.toLowerCase(),
      description: entry.description.toLowerCase(),
      spec,
    });
  }
  for (const [key, spec] of pool) {
    if (claimed.has(key)) continue;
    candidates.push({
      displayName: spec.name,
      nameText: spec.name.toLowerCase(),
      keys: [key],
      summary: '',
      description: (spec.description ?? '').toLowerCase(),
      spec,
    });
  }
  return candidates;
}

/** Resolve a user-supplied name or alias (case-insensitive). */
function resolveNameOrAlias(
  candidates: SearchCandidate[],
  query: string,
): SearchCandidate | undefined {
  const needle = query.toLowerCase();
  return candidates.find((c) => c.keys.includes(needle));
}

/** Score a candidate against keyword terms. Higher = better match.
 *  Name match weights heaviest, then promptSummary, then description. */
function scoreEntry(
  entry: SearchCandidate,
  parsed: ParsedQuery,
): number {
  const name = entry.nameText;
  const summary = entry.summary;
  const desc = entry.description;
  // Required terms must ALL appear somewhere in name/summary/desc.
  for (const req of parsed.required) {
    if (!name.includes(req) && !summary.includes(req) && !desc.includes(req)) {
      return -1;  // disqualified
    }
  }
  let score = 0;
  for (const term of parsed.terms) {
    if (name.includes(term)) score += 10;
    else if (summary.includes(term)) score += 4;
    else if (desc.includes(term)) score += 2;
  }
  // Reward entries where ALL terms are found (cohesion).
  if (parsed.terms.length > 0) {
    const allPresent = parsed.terms.every((t) => name.includes(t) || summary.includes(t) || desc.includes(t));
    if (allPresent) score += 5;
  }
  return score;
}

/** Render a single LLMToolSpec into the `<function>{...}</function>` line
 *  shape. The full result wraps this in `<functions>...</functions>`. */
function renderFunctionLine(spec: LLMToolSpec): string {
  // Minify JSON so each function takes one line — matches the base
  // tool-list encoding (see claude-code-fork system prompt format).
  const payload = {
    description: spec.description,
    name: spec.name,
    parameters: spec.parameters,
  };
  return `<function>${JSON.stringify(payload)}</function>`;
}

/** Produce the `<functions>...</functions>` block for the chosen specs. */
function renderFunctionsBlock(specs: LLMToolSpec[]): string {
  if (specs.length === 0) return '';
  return `<functions>\n${specs.map(renderFunctionLine).join('\n')}\n</functions>`;
}

/** Hydrate a route selected from the caller's surface-local manifest index.
 *  The plugin id stays attached through selection so duplicate names cannot
 *  substitute another plugin's schema. This explicit route path is separate
 *  from broad native-catalog keyword search. */
export function dispatchToolSearchRoute(
  routes: readonly { pluginId: string; name: string }[],
  surfaceSpecs: readonly LLMToolSpec[],
): ToolSearchResult {
  const selected: LLMToolSpec[] = [];
  for (const route of routes) {
    const spec = surfaceSpecs.find((candidate) => candidate.pluginId === route.pluginId
      && candidate.name === route.name && candidate.route !== undefined);
    if (spec && !selected.some((candidate) => candidate.pluginId === route.pluginId && candidate.name === route.name)) {
      selected.push(spec);
    }
  }
  return {
    content: `# ToolSearch: ${selected.length} matched\n\n` + renderFunctionsBlock(selected),
    matched: selected.map((spec) => spec.name),
    unknown: [],
    [HYDRATED_TOOLS_KEY]: selected,
  };
}

/** Dispatch entrypoint. Pure (no I/O) — looks up tool specs directly
 *  from the runtime registry so tests can exercise it by registering
 *  fake runtimes. */
export function dispatchToolSearch(
  args: ToolSearchArgs,
  opts: ToolSearchOpts = {},
): ToolSearchResult {
  const maxResults = Math.min(
    Math.max(1, Math.floor(args.max_results ?? DEFAULT_MAX_RESULTS)),
    MAX_RESULTS_HARD_CAP,
  );
  if (/^route:\s*/i.test(args.query)) {
    const intent = args.query.replace(/^route:\s*/i, '').trim();
    const routeSpecs = (opts.specs ?? []).filter((spec) => spec.pluginId && spec.route);
    const enabledPluginIds = new Set(routeSpecs.map((spec) => spec.pluginId!));
    const decision = routeToolIntentWithFallback(intent, () => buildToolRouteIndex(routeSpecs.map((spec) => ({
      pluginId: spec.pluginId!,
      tools: [{ name: spec.name, description: spec.description, route: spec.route! }],
    }))), { enabledPluginIds, limit: args.max_results === undefined ? 1 : maxResults });
    const routes: { pluginId: string; name: string }[] = [];
    const seenRouteNames = new Set<string>();
    for (const match of decision.matches) {
      if (seenRouteNames.has(match.name)) continue;
      seenRouteNames.add(match.name);
      routes.push({ pluginId: match.pluginId, name: match.name });
      if (routes.length >= (args.max_results === undefined ? 1 : maxResults)) break;
    }
    const result = dispatchToolSearchRoute(routes, routeSpecs);
    debug.log('tool.route', 'route-decision', {
      surface: opts.surface ?? 'tool-search-direct', queryLength: intent.length,
      mode: decision.mode, miss: decision.miss,
      matches: decision.matches.map(({ pluginId, name, score }) => ({ pluginId, name, score })),
    });
    return result;
  }
  const parsed = parseToolSearchQuery(args.query);
  const entries = listSearchCandidates(opts.specs);

  if (parsed.kind === 'select') {
    const matched: SearchCandidate[] = [];
    const unknown: string[] = [];
    for (const name of parsed.selectNames) {
      const entry = resolveNameOrAlias(entries, name);
      if (entry) matched.push(entry);
      else unknown.push(name);
    }
    // Truncate to max_results, preserving order.
    const chosen = matched.slice(0, maxResults);
    const specs = chosen.map((c) => c.spec);
    const header = unknown.length > 0
      ? `# ToolSearch: ${chosen.length} matched, ${unknown.length} unknown (${unknown.join(', ')})\n\n`
      : `# ToolSearch: ${chosen.length} matched\n\n`;
    return {
      content: header + renderFunctionsBlock(specs),
      matched: chosen.map((e) => e.displayName),
      unknown,
      [HYDRATED_TOOLS_KEY]: specs,
    };
  }

  // Keyword search.
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, parsed) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, maxResults).map((x) => x.entry);
  const specs = chosen.map((c) => c.spec);
  const header = chosen.length === 0
    ? `# ToolSearch: no matches for "${args.query.trim()}"\n\n`
    : `# ToolSearch: top ${chosen.length} match${chosen.length === 1 ? '' : 'es'} for "${args.query.trim()}"\n\n`;
  return {
    content: header + renderFunctionsBlock(specs),
    matched: chosen.map((e) => e.displayName),
    unknown: [],
    [HYDRATED_TOOLS_KEY]: specs,
  };
}
