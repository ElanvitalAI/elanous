import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { contextNow } from './context-now.js';
import { listCoordEvents } from './coord-events.js';
import { emitSessionEvent, SESSION_EVENT_KINDS } from './session-events.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';

const root = resolve(import.meta.dir, '../..');

test('four structured session kinds use the existing journal and context_now event slot in chronological order', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    for (const [index, kind] of SESSION_EVENT_KINDS.entries()) {
      emitSessionEvent({ kind, seat: 'TC', text: `CTX1 event ${index}`, ref: '#123',
        at: '2026-10-03T04:00:00.000Z' }, { db });
    }
    const rows = listCoordEvents({ since: '2026-10-03T00:00:00.000Z', seat: 'TC' }, { db });
    expect(rows.map(row => row.kind)).toEqual([...SESSION_EVENT_KINDS]);
    expect(rows.map(row => row.refs.ref)).toEqual(['#123', '#123', '#123', '#123']);
    expect(db.prepare('SELECT DISTINCT surface FROM events').all()).toEqual([{ surface: 'context:session' }]);
    const answer = contextNow({}, {
      now: () => new Date('2026-10-03T04:01:00.000Z'), version: () => '0.2.0',
      checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: since => listCoordEvents({ since }, { db }),
    });
    expect(answer.events.map(event => event.kind).reverse()).toEqual([...SESSION_EVENT_KINDS]);
    expect(answer.events.map(event => event.summary).reverse()).toEqual([0, 1, 2, 3].map(index => `CTX1 event ${index}`));
    expect(answer.events.every(event => event.source === 'elanous://context/ref/%23123')).toBe(true);
    expect(answer.guide[0]).toContain('CTX1 event 3');
    expect(() => emitSessionEvent({ kind: 'bad' as 'asked', seat: 'TC', text: 'no' }, { db })).toThrow('kind');
    expect(() => emitSessionEvent({ kind: 'asked', seat: 'TC', text: 'line\nprivate' }, { db })).toThrow('one nonempty line');
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 4 });
  } finally { db.close(); }
});

test('long one-line text and ref survive the journal while the context summary stays bounded', () => {
  const db = openSurfaceEventsDb(':memory:');
  const text = `Requested ${'analysis '.repeat(24)}completed`;
  const ref = `PR-${'1234567890'.repeat(15)}-end`;
  try {
    emitSessionEvent({ kind: 'asked', seat: 'TC', text, ref, at: '2026-10-03T04:00:00.000Z' }, { db });
    const [event] = listCoordEvents({ since: '2026-10-03T00:00:00.000Z' }, { db });
    expect(event?.text).toBe(text);
    expect(event?.refs.ref).toBe(ref);
    expect(event?.summary.length).toBe(120);
    const answer = contextNow({}, {
      now: () => new Date('2026-10-03T04:01:00.000Z'), version: () => '0.2.0',
      checklist: version => ({ version, released: '', dev: version, history: [], items: [] }),
      decisions: () => [], seatEntries: () => [], events: since => listCoordEvents({ since }, { db }),
    });
    expect(answer.events[0]?.summary).toBe(event?.summary);
    expect(answer.events[0]?.source).toBe(`elanous://context/ref/${encodeURIComponent(ref)}`);
  } finally { db.close(); }
});

test('CLI emits all four kinds; unknown kind exits 2 without writing; legacy hook CLI still works', () => {
  const state = mkdtempSync(resolve(tmpdir(), 'context-session-'));
  const env = { ...process.env, ELANOUS_CONFIG_DIR: state, ELANOUS_STATE_DIR: state };
  const invoke = (...args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', 'context', 'emit', ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  try {
    for (const [index, kind] of SESSION_EVENT_KINDS.entries()) {
      const result = invoke(kind, '--seat', 'TC', '--text', `CTX1 cli ${index}`, '--ref', 'K6');
      expect(result.status).toBe(0);
    }
    const invalid = invoke('unknown', '--seat', 'TC', '--text', 'not written');
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('unknown context session kind');
    const hook = invoke('--kind', 'claimed', '--summary', 'Legacy hook', '--source', 'https://example.org/claim');
    expect(hook.status).toBe(0);
    const query = spawnSync('bun', ['bin/elanous.mjs', '--test', 'coord', 'events', '--since', '2000-01-01T00:00:00Z', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    expect(query.status).toBe(0);
    const rows = JSON.parse(query.stdout) as Array<{ kind: string; summary: string; refs: { seat: string; ref?: string } }>;
    expect(rows.map(row => row.kind)).toEqual([...SESSION_EVENT_KINDS, 'claimed']);
    expect(rows.slice(0, 4).map(row => [row.refs.seat, row.refs.ref, row.summary])).toEqual(
      [0, 1, 2, 3].map(index => ['TC', 'K6', `CTX1 cli ${index}`]));
    expect(rows[4]).toMatchObject({ summary: 'Legacy hook', refs: { seat: 'claude-code' } });
    const text = `Session ${'analysis '.repeat(24)}completed`;
    const ref = `PR-${'1234567890'.repeat(15)}-end`;
    expect(invoke('asked', '--seat', 'TC', '--text', text, '--ref', ref).status).toBe(0);
    const longQuery = spawnSync('bun', ['bin/elanous.mjs', '--test', 'coord', 'events', '--since', '2000-01-01T00:00:00Z', '--json'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    expect(longQuery.status).toBe(0);
    const longRows = JSON.parse(longQuery.stdout) as Array<{ text: string; summary: string; refs: { ref?: string } }>;
    expect(longRows.at(-1)).toMatchObject({ text, summary: text.slice(0, 120), refs: { ref } });
  } finally { rmSync(state, { recursive: true, force: true }); }
}, 120_000);
