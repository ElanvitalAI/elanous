import { filterSlashCommands } from '../../input-core/slash-filter.js';
import type { NextTuiRoute, NextTuiRouteContext } from '../core/registry.js';

export interface NextSlashCandidate {
  readonly text: string;
  readonly description: string;
}

/** Draw from the same registry used for dispatch, with classic's candidate ranking. */
export function nextSlashCandidates(
  draft: string,
  routes: readonly NextTuiRoute[],
  context: NextTuiRouteContext,
  resolve: (text: string, context: NextTuiRouteContext) => NextTuiRoute | null,
): NextSlashCandidate[] {
  if (!/^\/[\w-]*$/.test(draft)) return [];
  const spellings = new Map<string, NextSlashCandidate>();
  for (const route of routes) {
    for (const text of [...route.slash, ...route.slashPrefixes]) {
      if (text.includes(' ') || resolve(text, context) !== route) continue;
      spellings.set(text, { text, description: route.helpSummary ?? '' });
    }
  }
  return filterSlashCommands(draft.slice(1), [...spellings.values()].map((candidate) => ({
    ...candidate, name: candidate.text.slice(1),
  }))).map(({ text, description }) => ({ text, description }));
}
