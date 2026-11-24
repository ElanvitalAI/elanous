// TUI-KEEP-TRANSCRIPT-ON-COMPACT — compaction shrinks the model context, never the displayed transcript.
// Expectations are literals, independent of the product's marker/merge code (rule 11).
import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { compactMarkerText, displayRowsAfterReload, mergeDisplayAfterCompact, previousAttemptMarker } from './compact-display.js';

function row(n: number, role: 'user' | 'assistant' = n % 2 === 0 ? 'user' : 'assistant'): SerializedMessage {
  return { role, content: `message ${n} body`, ts: `2026-11-24T22:00:${String(n).padStart(2, '0')}.000Z`, turn_id: `T${String(n).padStart(3, '0')}` } as SerializedMessage;
}

test('(a) same session · a compaction that replaced 20 old rows with a summary keeps all 20 shown rows, then the new rows', () => {
  const shown = Array.from({ length: 20 }, (_, i) => row(i));
  const summary = { role: 'system', content: '<context_summary>the first 20 rows</context_summary>', ts: '2026-11-24T22:01:00.000Z', turn_id: 'S001' } as SerializedMessage;
  const reloaded = [summary, row(20), row(21)];
  const merged = mergeDisplayAfterCompact(shown, reloaded);
  expect(merged.rows.length).toBe(22);
  expect(merged.rows.slice(0, 20).map((r) => r.content)).toEqual(Array.from({ length: 20 }, (_, i) => `message ${i} body`));
  expect(merged.rows.slice(20).map((r) => r.content)).toEqual(['message 20 body', 'message 21 body']);
  expect(merged.keptMissing).toBe(20);
  // The marker anchors after the last row shown before the compaction (index 19), so one marker sits between old and new.
  expect(merged.compactionPoint).toBe(19);
  expect(compactMarkerText('Compacted 120→30 messages')).toBe('── context compacted 120→30 ──');
  // The summary row itself is model context only.
  expect(merged.rows.some((r) => r.content.startsWith('<context_summary>'))).toBe(false);
});

test('(a2) a row the compaction stubbed keeps the text the person read', () => {
  const mail = { role: 'user', content: 'long seat mail line one\nline two\nline three', ts: '2026-11-24T22:00:00.000Z', turn_id: 'M001' } as SerializedMessage;
  const stub = { ...mail, content: '[seat-mail 1 from OPC] long seat mail line one' };
  const merged = mergeDisplayAfterCompact([mail], [stub]);
  expect(merged.rows.map((r) => r.content)).toEqual(['long seat mail line one\nline two\nline three']);
});

test('(a3) a reload with nothing dropped is the store as is (a grown row takes the store version)', () => {
  const shown = [row(0), { ...row(1), content: 'partial' }];
  const merged = mergeDisplayAfterCompact(shown, [row(0), row(1), row(2)]);
  expect(merged.rows.map((r) => r.content)).toEqual(['message 0 body', 'message 1 body', 'message 2 body']);
  expect(merged.keptMissing).toBe(0);
});

test('(b) a session switch replaces the display; a same-session reload after compaction keeps it', () => {
  const shown = [row(0), row(1)];
  const otherSession = [row(50), row(51)];
  const switched = displayRowsAfterReload({ sameSession: false, compacted: true, displayed: shown, reloaded: otherSession });
  expect(switched.rows.map((r) => r.content)).toEqual(['message 50 body', 'message 51 body']);
  const neverCompacted = displayRowsAfterReload({ sameSession: true, compacted: false, displayed: shown, reloaded: [row(1)] });
  expect(neverCompacted.rows.map((r) => r.content)).toEqual(['message 1 body']);
  const kept = displayRowsAfterReload({ sameSession: true, compacted: true, displayed: shown, reloaded: [row(1), row(2)] });
  expect(kept.rows.map((r) => r.content)).toEqual(['message 0 body', 'message 1 body', 'message 2 body']);
});

test('(c) a replaced preview is retained as one folded «previous attempt» line', () => {
  const marker = previousAttemptMarker('First try at the answer\nsecond line', 'A different restart');
  expect(marker).toEqual({ text: '↺ previous attempt · First try at the answer second line', detail: ['First try at the answer', 'second line'] });
  // A restart that continues the same text, or nothing shown before, adds no line.
  expect(previousAttemptMarker('Same start', 'Same start and more')).toBeNull();
  expect(previousAttemptMarker('', 'anything')).toBeNull();
  // A replace to an empty preview still keeps what was shown.
  expect(previousAttemptMarker('shown text', '')?.text).toBe('↺ previous attempt · shown text');
});
