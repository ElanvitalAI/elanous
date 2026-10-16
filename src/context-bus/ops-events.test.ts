import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitOpsEvent, OPS_EVENT_KINDS, type OpsEventInput, type OpsEventKind } from './ops-events.js';
import { openSurfaceEventsDb, recordEvent, type SurfaceEventInput } from '../domains/surface-events.js';

test('all eight ops kinds are accepted and passed to recordEvent with the event payload', () => {
  expect([...OPS_EVENT_KINDS]).toEqual([
    'land.start', 'land.refused', 'land.merged',
    'review.verdict', 'gate.rc', 'cell.opened', 'cell.hold', 'config.set',
  ]);
  const db = openSurfaceEventsDb(':memory:');
  const seen: SurfaceEventInput[] = [];
  const record: typeof recordEvent = (target, evt) => { seen.push(evt); return recordEvent(target, evt); };
  try {
    for (const [index, kind] of OPS_EVENT_KINDS.entries()) {
      const id = emitOpsEvent({ kind, text: `OPS1 ${kind} ${index}`, ref: 'PR-7', at: '2026-10-14T01:02:03.000Z' }, { db, record });
      expect(typeof id).toBe('string');
    }
    expect(seen.map(evt => evt.kind)).toEqual([...OPS_EVENT_KINDS]);
    expect(seen.map(evt => evt.text)).toEqual([...OPS_EVENT_KINDS].map((kind, index) => `OPS1 ${kind} ${index}`));
    expect(seen.every(evt => evt.surface === 'ops' && evt.direction === 'outbound'
      && evt.domain === 'elanous' && evt.category === 'ops')).toBe(true);
    expect(seen.every(evt => JSON.parse(evt.refs ?? '{}').ref === 'PR-7')).toBe(true);
    expect(seen.every(evt => evt.ts === '2026-10-14T01:02:03.000Z')).toBe(true);
    const rows = db.prepare('SELECT kind, text FROM events ORDER BY rowid').all() as Array<{ kind: string; text: string }>;
    expect(rows.map(row => row.kind)).toEqual([...OPS_EVENT_KINDS]);
    expect(rows.map(row => row.text)).toEqual(seen.map(evt => evt.text));
  } finally { db.close(); }
});

test('a throwing recordEvent and a schema-mismatched db never propagate (fail-soft)', () => {
  const db = openSurfaceEventsDb(':memory:');
  const record: typeof recordEvent = () => { throw new Error('record boom'); };
  try {
    expect(() => emitOpsEvent({ kind: 'land.start', text: 'OPS1 throwing record' }, { db, record })).not.toThrow();
    expect(emitOpsEvent({ kind: 'land.start', text: 'OPS1 throwing record' }, { db, record })).toBe(null);
    const bare = new Database(':memory:');
    try {
      expect(() => emitOpsEvent({ kind: 'gate.rc', text: 'OPS1 schema mismatch' }, { db: bare })).not.toThrow();
      expect(emitOpsEvent({ kind: 'gate.rc', text: 'OPS1 schema mismatch' }, { db: bare })).toBe(null);
    } finally { bare.close(); }
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test('malformed input is handled without throwing and without writing garbage', () => {
  const db = openSurfaceEventsDb(':memory:');
  try {
    expect(() => emitOpsEvent({ kind: 'bogus' as OpsEventKind, text: 'OPS1 no' }, { db })).not.toThrow();
    expect(emitOpsEvent({ kind: 'bogus' as OpsEventKind, text: 'OPS1 no' }, { db })).toBe(null);
    expect(emitOpsEvent({ kind: 'land.merged', text: '   ' }, { db })).toBe(null);
    expect(emitOpsEvent({ kind: 'land.merged', text: '' }, { db })).toBe(null);
    expect(emitOpsEvent(null as unknown as OpsEventInput, { db })).toBe(null);
    expect(emitOpsEvent({} as OpsEventInput, { db })).toBe(null);
    expect(emitOpsEvent({ kind: 'cell.hold', text: 'OPS1 first\nsecond' }, { db })).not.toBe(null);
    expect(emitOpsEvent({ kind: 'config.set', text: 'OPS1 unparseable at', at: 'not-a-date' }, { db })).not.toBe(null);
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 2 });
    const rows = db.prepare('SELECT kind, text, ts FROM events ORDER BY rowid').all() as Array<{ kind: string; text: string; ts: string }>;
    expect(rows[0]).toMatchObject({ kind: 'cell.hold', text: 'OPS1 first' });
    expect(rows[1]?.kind).toBe('config.set');
    expect(rows[1]?.ts).not.toBe('not-a-date');
  } finally { db.close(); }
});

/** Run `body` with HOME and ELANOUS_STATE_DIR pointed at fresh temp dirs (or the state dir unset), restoring both after. */
function withIsolatedEnv(stateDir: 'set' | 'unset', body: (paths: { home: string; state: string; prodDb: string; stateDb: string }) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'ops-events-home-'));
  const state = mkdtempSync(join(tmpdir(), 'ops-events-state-'));
  const saved = { HOME: process.env.HOME, ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR };
  process.env.HOME = home;
  if (stateDir === 'set') process.env.ELANOUS_STATE_DIR = state; else delete process.env.ELANOUS_STATE_DIR;
  try {
    // prodDb = where memoryDbPath() resolves with no state dir (the user's production journal under HOME).
    body({ home, state, prodDb: join(home, '.elanous', 'memory', 'surface_events.db'), stateDb: join(state, 'surface_events.db') });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}

// Storage boundary under a test runner (same contract as recordInboundTurn in domains/surface-events.ts):
// an explicit ELANOUS_STATE_DIR is the caller's isolated instance and is written; with none, the writer uses
// ':memory:' and never falls through to the production journal under HOME.
test('default path with an isolated ELANOUS_STATE_DIR records exactly one row there and nothing in the production journal', () => {
  withIsolatedEnv('set', ({ prodDb, stateDb }) => {
    expect(existsSync(stateDb)).toBe(false);
    const id = emitOpsEvent({ kind: 'review.verdict', text: 'OPS1 default path', ref: '#9' });
    expect(typeof id).toBe('string');
    expect(existsSync(stateDb)).toBe(true);
    const db = new Database(stateDb, { readonly: true });
    try {
      const rows = db.prepare('SELECT id, kind, text, surface, refs FROM events').all() as Array<{ id: string; kind: string; text: string; surface: string; refs: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ id: id!, kind: 'review.verdict', text: 'OPS1 default path', surface: 'ops' });
      expect(JSON.parse(rows[0]!.refs).ref).toBe('#9');
    } finally { db.close(); }
    expect(existsSync(prodDb)).toBe(false);
  });
});

test('default path with no ELANOUS_STATE_DIR under a test runner writes no database file anywhere', () => {
  withIsolatedEnv('unset', ({ home, state, prodDb, stateDb }) => {
    const id = emitOpsEvent({ kind: 'review.verdict', text: 'OPS1 default path in-memory', ref: '#9' });
    expect(typeof id).toBe('string');
    expect(existsSync(prodDb)).toBe(false);
    expect(existsSync(join(home, '.elanous'))).toBe(false);
    expect(existsSync(stateDb)).toBe(false);
    expect(readdirSync(state)).toEqual([]);
  });
});
