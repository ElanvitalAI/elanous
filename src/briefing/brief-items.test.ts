import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriefItemsInputError, BriefItemsLedger } from './brief-items.js';

function fixture(): { root: string; store: BriefItemsLedger } {
  const root = mkdtempSync(join(tmpdir(), 'brief-items-'));
  return { root, store: new BriefItemsLedger({ stateDir: root, now: () => new Date('2026-10-05T09:00:00Z') }) };
}

test('append-only SQLite items persist verbatim with nullable fields and timestamp', () => {
  const { root, store } = fixture();
  try {
    expect(store.path).toBe(join(root, 'briefing', 'items.sqlite'));
    const text = '  First line\nsecond line  ';
    const first = store.add({ text, domain: 'ops', priority: 'medium', source: 'meeting', evidence: 'https://example.test/1', deadline: '2026-10-06' });
    const second = store.add({ text, domain: 'ops', priority: 'low', source: 'notes' });
    expect(existsSync(store.path)).toBe(true);
    expect(first).toEqual({ id: 1, text, domain: 'ops', priority: 'medium', deadline: '2026-10-06', evidence: 'https://example.test/1', source: 'meeting', created_at: '2026-10-05T09:00:00.000Z' });
    expect(second.id).toBe(2);
    expect(second.deadline).toBeNull();
    expect(second.evidence).toBeNull();
    expect(new BriefItemsLedger({ stateDir: root }).list()).toEqual([first, second]);
    const db = new Database(store.path);
    try {
      expect(() => db.query('UPDATE items SET text = ? WHERE id = ?').run('rewritten', first.id)).toThrow('brief items are immutable');
      expect(() => db.query('DELETE FROM items WHERE id = ?').run(first.id)).toThrow('brief items are immutable');
    } finally { db.close(); }
    expect(store.list()).toEqual([first, second]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('list filters domains and prioritizes urgent items; compose returns slot Markdown without modifying ledger', () => {
  const { root, store } = fixture();
  try {
    const low = store.add({ text: 'Later', domain: 'ops', priority: 'low', source: 'manual' });
    const highLater = store.add({ text: 'Tomorrow', domain: 'ops', priority: 'high', deadline: '2026-10-07', source: 'brief' });
    const highSoon = store.add({ text: 'Today', domain: 'ops', priority: 'high', deadline: '2026-10-05', source: 'brief', evidence: 'https://example.test/source' });
    store.add({ text: 'Market', domain: 'finance', priority: 'high', source: 'wire' });
    expect(store.list({ domain: 'ops' }).map(row => row.id)).toEqual([highSoon.id, highLater.id, low.id]);
    const before = store.list();
    const markdown = store.compose('morning', { domain: 'ops' });
    expect(markdown).toStartWith('# Briefing — morning\n');
    expect(markdown).toContain('- [high] Today (ops)');
    expect(markdown).toContain('Evidence: https://example.test/source');
    expect(markdown).not.toContain('Market');
    expect(store.compose('evening', { domain: 'ops' })).toContain('# Briefing — evening');
    expect(store.list()).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('list orders same-priority deadlines by instant across offsets, then by insertion id', () => {
  const { root, store } = fixture();
  try {
    const later = store.add({ text: 'Later UTC', domain: 'ops', priority: 'high', deadline: '2026-10-05T01:00:00Z', source: 'wire' });
    const noDeadline = store.add({ text: 'No deadline', domain: 'ops', priority: 'high', source: 'wire' });
    const earlier = store.add({ text: 'Earlier +09', domain: 'ops', priority: 'high', deadline: '2026-10-05T09:00:00+09:00', source: 'wire' });
    const tied = store.add({ text: 'Same instant', domain: 'ops', priority: 'high', deadline: '2026-10-05T00:00:00Z', source: 'wire' });
    const low = store.add({ text: 'Low priority', domain: 'ops', priority: 'low', deadline: '2026-10-04T00:00:00Z', source: 'wire' });
    expect(store.list({ domain: 'ops' }).map(item => item.id)).toEqual([earlier.id, tied.id, later.id, noDeadline.id, low.id]);
    expect(store.list().map(item => item.id)).toEqual([earlier.id, tied.id, later.id, noDeadline.id, low.id]);
    expect(store.compose('morning').indexOf('Earlier +09')).toBeLessThan(store.compose('morning').indexOf('Later UTC'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid item and slot inputs do not add rows', () => {
  const { root, store } = fixture();
  try {
    const input = { text: 'valid', domain: 'ops', priority: 'high' as const, source: 'meeting' };
    expect(() => store.add({ ...input, text: '  ' })).toThrow(BriefItemsInputError);
    expect(() => store.add({ ...input, priority: 'urgent' as 'high' })).toThrow('invalid priority');
    expect(() => store.add({ ...input, deadline: 'next week' })).toThrow('invalid deadline');
    expect(() => store.add({ ...input, evidence: '' })).toThrow('evidence is required');
    expect(() => store.compose(' ')).toThrow('slot is required');
    expect(store.list()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
