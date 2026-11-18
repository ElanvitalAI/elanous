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
  // TUI-SLASH-TEXT-KOREAN-AND-RESIDUE: one row per route; aliases (/clear, /st, /mem …) ride along.
  const grouped: { text: string; name: string; aliases: string[]; summary: string; spellings: string[] }[] = [];
  const seen = new Set<string>();
  // An empty query lists everything in registry order, and the first row is what Enter runs. Quit must not be that default:
  // routes whose action is 'quit' come last (structural `action`, not a command name). A typed query still ranks by score.
  const ordered = [...routes.filter((route) => route.action !== 'quit'), ...routes.filter((route) => route.action === 'quit')];
  for (const route of ordered) {
    const spellings = [...route.slash, ...route.slashPrefixes]
      .filter((text) => !text.includes(' ') && !seen.has(text) && resolve(text, context) === route);
    if (spellings.length === 0) continue;
    spellings.forEach((text) => seen.add(text));
    grouped.push({ text: spellings[0]!, name: spellings[0]!.slice(1), aliases: spellings.slice(1).map((text) => text.slice(1)),
      summary: route.helpSummary ?? '', spellings });
  }
  const query = draft.slice(1).toLowerCase();
  return filterSlashCommands(query, grouped.map((candidate) => ({ ...candidate, description: candidate.summary })))
    .map(({ spellings, summary }) => {
      // Show the spelling the person is typing; the others are listed as aliases.
      const text = spellings.find((spelling) => query && spelling.slice(1).toLowerCase().startsWith(query)) ?? spellings[0]!;
      const others = spellings.filter((spelling) => spelling !== text);
      return { text, description: [summary, others.length ? `alias ${others.join(' · ')}` : ''].filter(Boolean).join(' · ') };
    });
}
