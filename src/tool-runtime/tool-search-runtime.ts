// ── ToolSearch ToolRuntime (Coding Pipeline P1) ──
//
// Wraps dispatchToolSearch in the ToolRuntime shape so the dashboard
// chat loop dispatches ToolSearch through the shared registry. Pure —
// no I/O, no deps slot. Safe to call in parallel with any read-only
// tool (supportsParallel=true in catalog).

import {
  buildToolSearchTool,
  dispatchToolSearch,
  type ToolSearchArgs,
} from '../skills/tools/tool-search.js';
import { HYDRATED_TOOLS_KEY } from '../skills/tools/tool-search-spec.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

/** Extended result — keeps `matched` / `unknown` arrays on the record
 *  for debug/audit while still satisfying `{output: string}` so the
 *  LLM layer can forward the <functions> block verbatim. */
export interface ToolSearchRunResult {
  output: string;
  matched: string[];
  unknown: string[];
  /** ⭐ Hydration hand-off (gap④) — MUST be forwarded. This wrapper used to
   *  project only `output`/`matched`/`unknown`, which silently dropped the
   *  resolved specs, so on the dashboard path a summoned tool stayed
   *  uncallable (schema as text only). The tool loop strips this key before
   *  the result reaches the conversation. */
  [HYDRATED_TOOLS_KEY]?: LLMToolSpec[];
}

/** Session runtime applies this only to the fixed harness turn, using its
 * originating userText. Both the callable catalog and visible schemas must
 * agree, so a later model turn cannot rehydrate Edit or Write from this result. */
export function blockWriteToolSearchHydration(result: ToolSearchRunResult): ToolSearchRunResult {
  const hydrated = result[HYDRATED_TOOLS_KEY] ?? [];
  const allowed = hydrated.filter((tool) => tool.name !== 'Edit' && tool.name !== 'Write');
  if (allowed.length === hydrated.length) return result;
  const blocked = new Set(['Edit', 'Write']);
  const matched = result.matched.filter((name) => !blocked.has(name));
  const schemas = allowed.length > 0
    ? `<functions>\n${allowed.map((tool) => `<function>${JSON.stringify({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    })}</function>`).join('\n')}\n</functions>`
    : '';
  const output = `# ToolSearch: ${matched.length} allowed match${matched.length === 1 ? '' : 'es'}\n\n${schemas}`;
  return {
    ...result,
    output,
    matched,
    [HYDRATED_TOOLS_KEY]: allowed,
  };
}

export const toolSearchRuntime: ToolRuntime<ToolSearchArgs, ToolSearchRunResult> = {
  id: 'tool_search',
  spec: buildToolSearchTool(),
  async run(req: ToolSearchArgs, _ctx: ToolRuntimeContext): Promise<ToolSearchRunResult> {
    const result = dispatchToolSearch(req);
    const hydrated = result[HYDRATED_TOOLS_KEY];
    return {
      output: result.content,
      matched: result.matched,
      unknown: result.unknown,
      ...(hydrated && hydrated.length > 0 ? { [HYDRATED_TOOLS_KEY]: hydrated } : {}),
    };
  },
};
