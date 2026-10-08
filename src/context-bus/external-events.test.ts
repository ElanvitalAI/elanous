import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';
import { contextDayTimeline } from './context-day.js';
import { listCoordEvents, recordCoordEvent } from './coord-events.js';
import { CONTEXT_SUMMARY_MAX, observeExternalEvent, recordExternalEvent } from './external-events.js';
import { emitSessionEvent } from './session-events.js';

const base = '2026-10-02T02:00:00.000Z';

test('three origins share the chronological coord events journal without storing conversations', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    const hook = recordExternalEvent({ origin: 'claude-code', kind: 'claimed', summary: `Claimed ${'A'.repeat(200)}\nPRIVATE TRANSCRIPT`,
      source: 'https://example.org/claim', at: base }, { db });
    recordExternalEvent({ origin: 'codex-agent-mission', kind: 'started', summary: 'Codex agent mission started',
      source: 'elanous://agent-mission/branch', at: '2026-10-02T02:00:01.000Z' }, { db });
    recordExternalEvent({ origin: 'harness-child', kind: 'finished', summary: 'Harness child finished: completion-marker',
      source: 'elanous://harness/run/pty', at: '2026-10-02T02:00:02.000Z' }, { db });
    recordCoordEvent({ seat: 'TC', recipients: [], all: false, kind: '보고', slot: null, deadline: null,
      headline: 'Channel report', url: null, at: '2026-10-02T02:00:03.000Z' }, { db });
    const rows = listCoordEvents({ since: base }, { db });
    expect(rows.map((r) => r.refs.seat)).toEqual(['claude-code', 'codex-agent-mission', 'harness-child', 'TC']);
    expect(rows.map((r) => r.kind)).toEqual(['claimed', 'started', 'finished', '보고']);
    expect(rows[0]?.summary.length).toBe(CONTEXT_SUMMARY_MAX);
    expect(rows[0]?.refs.source).toBe('https://example.org/claim');
    expect(listCoordEvents({ since: base, seat: 'harness-child' }, { db })).toHaveLength(1);
    expect(db.prepare('SELECT surface, text, summary FROM events WHERE id=?').get(hook)).toEqual({
      surface: 'context:external', text: rows[0]?.summary, summary: rows[0]?.summary,
    });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE TRANSCRIPT');
    expect(JSON.stringify(db.prepare('SELECT text, summary, refs FROM events').all())).not.toContain('PRIVATE TRANSCRIPT');
  } finally { db.close(); }
});

test('OP TC MK UX daily signals and three external origins share one chronological summary-only journal', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'context-four-seats-'));
  const path = join(dir, 'surface_events.db');
  const db = openSurfaceEventsDb(path);
  const now = new Date('2026-10-04T12:00:00.000Z');
  try {
    // Insert out of order so neither insertion order nor a per-seat store can pass as a timeline.
    emitSessionEvent({ seat: 'UX', kind: 'task-done', text: 'UX completed', ref: 'UX-1', at: '2026-10-04T10:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'harness-child', kind: 'finished', summary: 'Child completed\nRAW CHILD TRANSCRIPT',
      source: 'elanous://harness/run/1', at: '2026-10-04T09:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'MK', kind: 'guidance-changed', text: 'MK guidance updated', ref: 'MK-1', at: '2026-10-04T08:00:00.000Z' }, { db });
    recordCoordEvent({ seat: 'TC', recipients: ['OP'], all: false, kind: '요청', slot: 'CTX1', deadline: null,
      headline: 'TC requested review\nRAW CHANNEL BODY', url: 'https://example.org/coord/1', at: '2026-10-04T07:00:00.000Z' }, { db });
    emitSessionEvent({ seat: 'OP', kind: 'task-claimed', text: 'OP claimed work', ref: 'OP-1', at: '2026-10-04T06:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'codex-agent-mission', kind: 'started', summary: 'Codex started',
      source: 'elanous://agent-mission/1', at: '2026-10-04T05:00:00.000Z' }, { db });
    recordExternalEvent({ origin: 'claude-code', kind: 'asked', summary: 'Claude asked\nRAW CLAUDE TRANSCRIPT',
      source: 'elanous://context/claude-code/1', at: '2026-10-04T04:00:00.000Z' }, { db });
    recordEvent(db, { surface: 'claude-code', direction: 'inbound', kind: 'qna', text: 'RAW USER PROMPT',
      summary: 'RAW USER PROMPT', ts: '2026-10-04T07:30:00.000Z' });
    const rows = listCoordEvents({ since: '2026-10-04T00:00:00.000Z' }, { db });
    expect(rows.map(row => [row.refs.seat, row.kind, row.summary])).toEqual([
      ['claude-code', 'asked', 'Claude asked'],
      ['codex-agent-mission', 'started', 'Codex started'],
      ['OP', 'task-claimed', 'OP claimed work'],
      ['TC', '요청', 'TC requested review'],
      ['MK', 'guidance-changed', 'MK guidance updated'],
      ['harness-child', 'finished', 'Child completed'],
      ['UX', 'task-done', 'UX completed'],
    ]);
    expect(db.prepare(`SELECT surface, count(*) AS n FROM events WHERE direction='outbound' GROUP BY surface ORDER BY surface`).all()).toEqual([
      { surface: 'context:external', n: 3 }, { surface: 'context:session', n: 3 }, { surface: 'coord:channel', n: 1 },
    ]);
    const timeline = contextDayTimeline('24h', { now: () => now, dbPath: path });
    expect(timeline.events.map(event => [event.source, event.kind, event.summary])).toEqual([
      ['claude-code', 'asked', 'Claude asked'],
      ['codex-agent-mission', 'task-claimed', 'Codex started'],
      ['OP', 'task-claimed', 'OP claimed work'],
      ['TC', 'asked', 'TC requested review'],
      ['MK', 'guidance-changed', 'MK guidance updated'],
      ['harness-child', 'done', 'Child completed'],
      ['UX', 'done', 'UX completed'],
    ]);
    for (const seat of ['OP', 'TC', 'MK', 'UX'] as const) {
      expect(contextDayTimeline('24h', { now: () => now, dbPath: path, seat }).events).toEqual(
        timeline.events.filter(event => event.source === seat));
      expect(listCoordEvents({ since: '2026-10-04T00:00:00.000Z', seat }, { db })).toHaveLength(1);
    }
    expect(timeline.events.map(event => event.link)).toEqual([
      'elanous://context/claude-code/1', 'elanous://agent-mission/1', 'elanous://context/ref/OP-1',
      'https://example.org/coord/1', 'elanous://context/ref/MK-1', 'elanous://harness/run/1', 'elanous://context/ref/UX-1',
    ]);
    expect(JSON.stringify(rows) + JSON.stringify(timeline)).not.toMatch(/RAW (?:USER PROMPT|CLAUDE TRANSCRIPT|CHILD TRANSCRIPT|CHANNEL BODY)/);
    expect(JSON.stringify(db.prepare(`SELECT text, summary, refs FROM events WHERE direction='outbound'`).all())).not.toContain('RAW');
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 8 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('hook kinds, invalid sources and empty summary are rejected; secrets are redacted before storage', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    for (const kind of ['claimed', 'done', 'asked', 'guide-changed'] as const) {
      recordExternalEvent({ origin: 'claude-code', kind, summary: `Reported token=very-sensitive-value ${kind}`,
        source: 'https://example.org/hook' }, { db });
    }
    expect(listCoordEvents({ since: '2000-01-01T00:00:00Z' }, { db }).map((r) => r.kind)).toEqual(['claimed', 'done', 'asked', 'guide-changed']);
    expect(JSON.stringify(db.prepare('SELECT text, summary, refs FROM events').all())).not.toContain('very-sensitive-value');
    const input = { origin: 'claude-code' as const, kind: 'done' as const, summary: 'ok', source: 'https://example.org/hook' };
    expect(() => recordExternalEvent({ ...input, summary: '\nPRIVATE' }, { db })).toThrow('summary');
    expect(() => recordExternalEvent({ ...input, source: 'file:///tmp/transcript' }, { db })).toThrow('source');
    expect(() => recordExternalEvent({ ...input, source: `https://example.org/${'x'.repeat(520)}` }, { db })).toThrow('source');
    expect(() => recordExternalEvent({ ...input, kind: 'invalid' as 'done' }, { db })).toThrow('kind');
    expect(() => recordExternalEvent({ ...input, kind: 'started' }, { db })).toThrow('kind');
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 4 });
  } finally { db.close(); }
});

test('Claude Code hook CLI emit is readable from the same coord events CLI', () => {
  const root = resolve(import.meta.dir, '../..');
  const configDir = mkdtempSync(resolve(tmpdir(), 'context-hook-'));
  const env = { ...process.env, ELANOUS_CONFIG_DIR: configDir, ELANOUS_STATE_DIR: configDir };
  const invoke = (args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 90_000,
  });
  try {
    const emit = invoke(['context', 'emit', '--kind', 'guide-changed', '--summary', 'Guide changed', '--source', 'https://example.org/guide']);
    expect(emit.status).toBe(0);
    const events = invoke(['coord', 'events', '--since', '2000-01-01T00:00:00Z', '--json']);
    expect(events.status).toBe(0);
    expect(JSON.parse(events.stdout) as unknown[]).toEqual([expect.objectContaining({
      summary: 'Guide changed', kind: 'guide-changed', refs: expect.objectContaining({ seat: 'claude-code', source: 'https://example.org/guide' }),
    })]);
    const invalid = invoke(['context', 'emit', '--kind', 'bad', '--summary', 'No', '--source', 'https://example.org/guide']);
    expect(invalid.status).not.toBe(0);
  } finally { rmSync(configDir, { recursive: true, force: true }); }
  // Spawns the real CLI three times; cold start exceeds the 5s default under load.
}, 120_000);

test('lifecycle observation failure does not change the child result', () => {
  expect(() => observeExternalEvent({ origin: 'harness-child', kind: 'finished', summary: 'failed', source: 'elanous://harness/run/pty' },
    () => { throw new Error('store unavailable'); })).not.toThrow();
});
