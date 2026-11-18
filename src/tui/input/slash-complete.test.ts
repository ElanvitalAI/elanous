import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, NEXT_TUI_ROUTE_REGISTRY, resolveNextTuiRoute } from '../core/registry.js';
import { nextSlashCandidates } from './slash-complete.js';

const candidates = (draft: string) => nextSlashCandidates(
  draft, NEXT_TUI_ROUTE_REGISTRY, NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute,
);

test('suggestions come only from active next routes and rank classic-style', () => {
  // NEXT-TUI-UI-ENGLISH: /status's English summary «Model · …» now matches by description word (classic rank 10).
  expect(candidates('/mo').map((candidate) => candidate.text)).toEqual(['/model', '/memory', '/status']);
  // Aliases fold into their route's row: /sidetab under /side, /sessions under /session;
  // /app matches its English summary word «simulation».
  expect(candidates('/si').map((candidate) => candidate.text)).toEqual(['/side', '/signals', '/mission', '/session', '/app']);
  expect(candidates('/').some((candidate) => candidate.text === '/run-skill')).toBe(false);
  expect(candidates('/help ').length).toBe(0);
  expect(candidates('please /help').length).toBe(0);
});

test('TUI-SLASH-TEXT-KOREAN-AND-RESIDUE: alias pairs show once, with the typed spelling first', () => {
  const all = candidates('/');
  for (const alias of ['/clear', '/st', '/mem', '/dec', '/ctx', '/sidetab', '/terminal', '/exit'])
    expect(all.some((candidate) => candidate.text === alias)).toBe(false);
  expect(all.find((candidate) => candidate.text === '/new')?.description).toContain('alias /clear');
  expect(all.find((candidate) => candidate.text === '/quit')?.description).toContain('alias /exit');
  // Typing an alias shows that alias, with the primary listed as the other spelling.
  const typed = candidates('/cl')[0];
  expect(typed?.text).toBe('/clear');
  expect(typed?.description).toContain('alias /new');
});

test('TUI-COMPACT-CROWDED-FOOTER: the first candidate of an empty query is /help, never /quit (Enter runs the first row)', () => {
  const all = candidates('/').map((candidate) => candidate.text);
  expect(all[0]).toBe('/help');
  expect(all.at(-1)).toBe('/quit');
  expect(all).toContain('/quit');
  // A typed query still ranks by classic score: /q finds /quit first.
  expect(candidates('/q')[0]?.text).toBe('/quit');
  expect(candidates('/qu').map((candidate) => candidate.text)).toEqual(['/quit', '/remaining']);
});
