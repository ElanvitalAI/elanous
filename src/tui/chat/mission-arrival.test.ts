import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { createNextTuiHistoryCache, renderNextTuiLogFrame } from '../core/render.js';
import { addTranscriptMarker, missionArrivalText, type TranscriptMarkerStore } from './mission-arrival.js';

test('arrival text names the agent, pairing and result path; failures say why', () => {
  expect(missionArrivalText({ agent: 'claude', paired: false, ok: true, path: '/tmp/r.md' })).toBe('✓ Mission result arrived · claude · /tmp/r.md');
  expect(missionArrivalText({ agent: 'codex', paired: true, ok: false, error: 'crashed' })).toBe('✘ Mission failed · codex + parallel · crashed');
});

test('a mission that finishes while another turn runs stays visible after that turn and the next ones', () => {
  const store: TranscriptMarkerStore = new Map();
  const messages: SerializedMessage[] = [
    { role: 'user', content: 'first prompt', ts: '2026-11-17T00:00:00Z' },
    { role: 'assistant', content: 'first reply', ts: '2026-11-17T00:00:01Z' },
    { role: 'user', content: 'second prompt (turn running)', ts: '2026-11-17T00:00:02Z' },
  ];
  // Arrival lands mid-turn: the per-turn activity buffer is NOT used.
  expect(addTranscriptMarker(store, 's1', messages.length, missionArrivalText({ agent: 'claude', paired: false, ok: true, path: '/tmp/r.md' }))).toBe(true);
  const base = { columns: 80, rows: 15, header: ['h'], footer: ['f'], promptLine: '❯ ', notices: [], activity: [] as string[],
    scroll: 0, expandedToolIndexes: new Set<number>() };
  const cache = createNextTuiHistoryCache();
  const inputFor = () => ({ ...base, messages, turnEndMarkers: store.get('s1') ?? [] });
  const during = renderNextTuiLogFrame(inputFor(), cache(inputFor())).lines.join('\n');
  expect(during).toContain('✓ Mission result arrived · claude · /tmp/r.md');
  // The running turn finishes: its reply lands and its activity buffer is cleared. Then another turn starts.
  messages.push({ role: 'assistant', content: 'second reply', ts: '2026-11-17T00:00:03Z' });
  messages.push({ role: 'user', content: 'third prompt', ts: '2026-11-17T00:00:04Z' });
  const after = renderNextTuiLogFrame(inputFor(), cache(inputFor())).lines.join('\n');
  expect(after).toContain('✓ Mission result arrived · claude · /tmp/r.md');
  expect(after.indexOf('✓ Mission result arrived')).toBeLessThan(after.indexOf('third prompt'));
});

test('no message to anchor to: the caller falls back to the activity buffer', () => {
  const store: TranscriptMarkerStore = new Map();
  expect(addTranscriptMarker(store, 's1', 0, 'x')).toBe(false);
  expect(addTranscriptMarker(store, '', 3, 'x')).toBe(false);
  expect(store.size).toBe(0);
});
