import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── ToolSearch spec (pure · zero-dependency) ──
//
// The ToolSearch **schema** is needed by two very different layers:
//
//   - the dispatch layer (`tool-search.ts`), which resolves deferred
//     schemas out of the runtime registry / surface spec pool, and
//   - the **prompt** layer (`session-runtime/tier-flip.ts`), which must
//     hand the model a summoner whenever it defers anything.
//
// tier-flip is a lean prompt-assembly seam; pulling in `tool-search.ts`
// would drag the tool-runtime registry (and with it the verifier /
// guardian / intent-miss chain) into that path. So the spec — which is
// a pure literal — lives here and both layers import it. One source of
// truth, no cycle.



/** Default result cap — large enough for realistic "select:A,B,C" batch
 *  loading, small enough that a loose keyword search won't flood the
 *  conversation with 20 unrelated schemas. */
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_RESULTS_HARD_CAP = 25;

/** LLM-facing name. Kept as a constant so the prompt layer, the dispatch
 *  layer, and the surface routers all compare against the same string. */
export const TOOL_SEARCH_NAME = 'ToolSearch';

/**
 * ⭐ Hydration hand-off key (F2 gap④ · 2026-07-26).
 *
 * A tool dispatcher that *resolves new tool schemas* (ToolSearch) attaches the
 * resolved `LLMToolSpec[]` to its result under this key. The tool loop
 * (`streamLLMWithTools`) lifts them into the **provider tool list for the
 * remaining turns**, then strips the key before the result is rendered into
 * the conversation.
 *
 * Why it must exist: returning a `<functions>{…}</functions>` block as *text*
 * does NOT make a tool callable. Providers only accept calls for functions in
 * the declared `tools=[…]` array, and that array was fixed for the whole loop
 * — so the model summoned a schema, found it still uncallable, re-summoned,
 * and gave up (실측 5회·하니스 2종). Text-only hydration is a dead end.
 *
 * Generic on purpose: any dispatcher can grow the tool surface this way; the
 * loop knows nothing about ToolSearch. Stripped before rendering so the
 * schemas are not paid for twice in context.
 */
export const HYDRATED_TOOLS_KEY = '__elanousHydratedTools' as const;

/** A hydrated entry is only usable if it can actually be **declared to a
 *  provider**. A bare `{name}` (or an empty name) would be serialized into the
 *  tools array and rejected by the provider — or worse, silently shadow a real
 *  tool. Validate the whole shape, not just the name. */
function isDeclarableSpec(s: unknown): s is LLMToolSpec {
  if (!s || typeof s !== 'object') return false;
  const spec = s as Partial<LLMToolSpec>;
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0) return false;
  if (spec.description !== undefined && typeof spec.description !== 'string') return false;
  // `parameters` is what the provider turns into the JSON-Schema function
  // signature — a missing/non-object one produces an undeclarable tool.
  if (!spec.parameters || typeof spec.parameters !== 'object' || Array.isArray(spec.parameters)) return false;
  return true;
}

/** Lift hydrated specs off a dispatch result, mutating it to drop the key.
 *  Returns [] for any result that doesn't carry them (the common case).
 *
 *  ⚠️ The key is deleted **unconditionally** — before the shape check. A
 *  malformed value must not survive into the conversation just because we
 *  refused to use it; the key is reserved plumbing, never model-facing. */
export function takeHydratedTools(result: unknown): LLMToolSpec[] {
  if (!result || typeof result !== 'object') return [];
  const bag = result as Record<string, unknown>;
  if (!(HYDRATED_TOOLS_KEY in bag)) return [];
  const raw = bag[HYDRATED_TOOLS_KEY];
  delete bag[HYDRATED_TOOLS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDeclarableSpec);
}

/** Build the LLM-facing schema for ToolSearch. */
export function buildToolSearchTool(): LLMToolSpec {
  return {
    name: TOOL_SEARCH_NAME,
    description:
      'Fetch full schema definitions for deferred tools so they can be called. ' +
      'Deferred tools are listed by name in the system prompt but their JSONSchema ' +
      'bodies are withheld to save context; ToolSearch returns those bodies on demand. ' +
      '\n\nQuery forms:\n' +
      '  - "select:Foo,Bar,Baz" — fetch these exact tools by name or alias\n' +
      '  - "keyword text"       — keyword fuzzy search, up to max_results best matches\n' +
      '  - "+slack send"        — require "slack" in name/desc, rank by remaining terms\n' +
      '\nResult is one `<functions>{"description":..., "name":..., "parameters":{...}}</functions>` ' +
      'block per match — same encoding as the base tool list, so once the schema ' +
      'appears the tool is callable exactly like any pre-loaded tool.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'select:-style direct selection or free-text keyword search.',
        },
        max_results: {
          type: 'number',
          description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, hard cap ${MAX_RESULTS_HARD_CAP}).`,
        },
      },
      required: ['query'],
    },
  };
}
