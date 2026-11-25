import { afterEach, expect, test } from 'bun:test';
import { withAmbientSessionScope } from '../../debug/log.js';
import { noteBroadSearch, noteNarrowingAction, resetSearchLoopGuardForTest } from './search-loop-guard.js';

afterEach(() => resetSearchLoopGuardForTest());

const broad = (i: number) => ['grep-files', '/repo', '', '', '50', '0', `pattern-${i}`];

test('a session is still blocked on its fourth consecutive broad search', () => {
  const results = withAmbientSessionScope('session-a', () => [1, 2, 3, 4].map((i) => noteBroadSearch(broad(i))));
  expect(results.slice(0, 3).every((r) => !r.blocked)).toBe(true);
  expect(results[3]).toEqual({ blocked: true, consecutive: 4 });
});

test('broad searches in one session do not poison another session', () => {
  withAmbientSessionScope('session-a', () => { for (let i = 1; i <= 4; i++) noteBroadSearch(broad(i)); });
  const other = withAmbientSessionScope('session-b', () => [1, 2, 3].map((i) => noteBroadSearch(broad(i))));
  expect(other.every((r) => !r.blocked)).toBe(true);
  expect(withAmbientSessionScope('session-a', () => noteBroadSearch(broad(5)))).toEqual({ blocked: true, consecutive: 5 });
});

test('a narrowing action resets only its own session', () => {
  withAmbientSessionScope('session-a', () => { for (let i = 1; i <= 3; i++) noteBroadSearch(broad(i)); });
  withAmbientSessionScope('session-b', () => { for (let i = 1; i <= 3; i++) noteBroadSearch(broad(i)); });
  withAmbientSessionScope('session-b', () => noteNarrowingAction());
  expect(withAmbientSessionScope('session-b', () => noteBroadSearch(broad(9)))).toEqual({ blocked: false });
  expect(withAmbientSessionScope('session-a', () => noteBroadSearch(broad(9)))).toEqual({ blocked: true, consecutive: 4 });
});

test('an explicit session id scopes the counter without an ambient scope', () => {
  for (let i = 1; i <= 3; i++) noteBroadSearch(broad(i), undefined, 'explicit-a');
  expect(noteBroadSearch(broad(1), undefined, 'explicit-b')).toEqual({ blocked: false });
  expect(noteBroadSearch(broad(4), undefined, 'explicit-a')).toEqual({ blocked: true, consecutive: 4 });
});
