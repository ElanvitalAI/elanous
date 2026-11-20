/**
 * CAPSULE-DONE-KNOCK-SCOPE test seam — a FIXED search provider for an isolated real Next TUI session.
 *
 * Test boundary only. It replaces the provider LIST (never the search/permission path): research still runs through
 * `dispatchResearchOmniSearch` / the axis fanout with the same routing, budgets, allowlists and tool admission; only the
 * network call at the very end answers from fixed data. It takes the `exa` slot so the research allowlist is untouched.
 *
 * Active only when ALL hold: `ELANOUS_TEST_FIXED_SEARCH=1`, the fake-LLM test universe switch
 * (`ELANOUS_TEST_FAKE_LLM=1`), and an isolated state root (`--test` / `--test-state-dir` sets ELANOUS_STATE_DIR).
 * Anything else — including a production process that inherited the variable — ignores it and logs one refusal.
 */
import { debug } from '../debug/log.js';
import type { WebSearchProvider, WebSearchResult } from './provider.js';

export const TEST_FIXED_SEARCH_ENV = 'ELANOUS_TEST_FIXED_SEARCH';
export const TEST_FIXED_SEARCH_HITS = Object.freeze([
  { url: 'http://localhost:9/fixed-alpha', title: 'Fixed alpha', snippet: 'Fixed alpha snippet (test provider).' },
  { url: 'http://localhost:9/fixed-beta', title: 'Fixed beta', snippet: 'Fixed beta snippet (test provider).' },
]);

/** True only inside an isolated fake-LLM test universe. A requested-but-refused switch is logged once, never honoured. */
export function testFixedSearchActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[TEST_FIXED_SEARCH_ENV] !== '1') return false;
  if (env.ELANOUS_TEST_FAKE_LLM === '1' && Boolean(env.ELANOUS_STATE_DIR?.trim())) return true;
  try { debug.log('web-search', 'fixed-search-refused', { reason: 'not-an-isolated-fake-llm-universe' }, { level: 'warn' }); } catch { /* observational */ }
  return false;
}

export function buildFixedTestWebSearchProvider(): WebSearchProvider {
  return {
    id: 'exa',
    displayName: 'Fixed test search',
    available: () => true,
    async search(query): Promise<WebSearchResult> {
      const limit = Math.max(1, Math.min(query.limit ?? 5, TEST_FIXED_SEARCH_HITS.length));
      return { hits: TEST_FIXED_SEARCH_HITS.slice(0, limit).map((hit) => ({ ...hit })), providerName: 'fixed-test-search', durationMs: 0 };
    },
  };
}
