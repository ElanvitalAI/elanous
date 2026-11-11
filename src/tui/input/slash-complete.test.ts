import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, NEXT_TUI_ROUTE_REGISTRY, resolveNextTuiRoute } from '../core/registry.js';
import { nextSlashCandidates } from './slash-complete.js';

const candidates = (draft: string) => nextSlashCandidates(
  draft, NEXT_TUI_ROUTE_REGISTRY, NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute,
);

test('suggestions come only from active next routes and rank classic-style', () => {
  expect(candidates('/mo').map((candidate) => candidate.text)).toEqual(['/model', '/memory']);
  expect(candidates('/si').map((candidate) => candidate.text)).toEqual(['/side', '/sidetab', '/signals', '/mission']);
  expect(candidates('/').some((candidate) => candidate.text === '/run-skill')).toBe(false);
  expect(candidates('/help ').length).toBe(0);
  expect(candidates('please /help').length).toBe(0);
});
