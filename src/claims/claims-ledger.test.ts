import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { ClaimsInputError, ClaimsLedger } from './claims-ledger.js';
import { queueStaleRechecks, renderClaims } from './claims-render.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'claims-ledger-')));
const input = { id: 'C1', claim: '측정으로 검증된 주장.', audience: 'personal,team', owner: 'MK', contrast: '다른 도구보다 빠름' };

test('evidence expires exactly once, stale publication fails and fresh verification recovers', () => {
  const stateDir = root();
  let now = new Date('2026-10-04T00:00:00Z');
  const store = new ClaimsLedger({ stateDir, now: () => now });
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => { logs.push({ category, event, data }); });
  try {
    expect(store.path).toBe(join(stateDir, 'claims', 'claims.sqlite'));
    expect(store.add(input)).toMatchObject({ id: 'C1', status: 'draft', audience: 'personal,team' });
    expect(() => store.add(input)).toThrow(ClaimsInputError);
    expect(() => store.add(input)).toThrow('claim already exists: C1');
    expect(store.get('C1').history).toHaveLength(1);
    expect(() => store.publish('C1', 'MK')).toThrow('verified, valid evidence');
    const first = { value: '42', command: 'measure --count', measuredAt: now.toISOString(), validUntil: '2026-10-05T00:00:00Z', by: 'TC' };
    expect(store.verify('C1', first).status).toBe('verified');
    expect(store.publish('C1', 'MK').status).toBe('public');
    expect(store.link('C1', { cell: 'CLAIMS1', version: '0.2.6' }).status).toBe('public');
    expect(store.get('C1')).toMatchObject({ contrast: input.contrast, links: [{ cell: 'CLAIMS1', version: '0.2.6' }], evidence: [{ value: '42', command: first.command }] });
    now = new Date('2026-10-06T00:00:00Z');
    expect(store.list({ status: 'stale', audience: 'team' }).map(row => row.id)).toEqual(['C1']);
    expect(store.list({ status: 'public' })).toEqual([]);
    expect(store.get('C1').status).toBe('stale');
    expect(() => store.publish('C1', 'MK')).toThrow('verified, valid evidence');
    expect(store.get('C1').history.filter(event => event.event === 'stale')).toHaveLength(1);
    expect(store.verify('C1', { ...first, value: '43', measuredAt: now.toISOString(), validUntil: '2026-10-07T00:00:00Z' }).status).toBe('verified');
    expect(store.get('C1').history.map(event => event.event)).toEqual(['add', 'verify', 'publish', 'link', 'stale', 'verify']);
    expect(logs.filter(log => log.category === 'claims.ledger').map(log => [log.event, log.data])).toEqual([
      ['add', { id: 'C1', status: 'draft' }], ['verify', { id: 'C1', status: 'verified' }],
      ['publish', { id: 'C1', status: 'public' }], ['link', { id: 'C1', status: 'public' }],
      ['stale', { id: 'C1', status: 'stale' }], ['verify', { id: 'C1', status: 'verified' }],
    ]);
    const db = new Database(store.path);
    try {
      expect((db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    } finally { db.close(); }
  } finally { spy.mockRestore(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('retract preserves history, excludes rendering and rechecks even after evidence expires', () => {
  const stateDir = root();
  const instanceRoot = root();
  let now = new Date('2026-10-04T00:00:00Z');
  const store = new ClaimsLedger({ stateDir, now: () => now });
  try {
    store.add(input);
    const proof = { value: '42건', command: 'measure', measuredAt: now.toISOString(), validUntil: '2026-10-05T00:00:00Z', by: 'TC' };
    store.verify('C1', proof);
    store.publish('C1', 'MK');
    expect(renderClaims(store, { surface: 'deck' }).included).toEqual(['C1']);
    expect(store.retract('C1', { reason: '근거보다 넓은 주장', by: 'MK' }).status).toBe('retracted');
    now = new Date('2026-10-06T00:00:00Z');
    expect(store.list().map(row => row.status)).toEqual(['retracted']);
    expect(store.list({ status: 'retracted' }).map(row => row.id)).toEqual(['C1']);
    expect(store.list({ status: 'stale' })).toEqual([]);
    expect(store.get('C1').history.map(h => h.event)).toEqual(['add', 'verify', 'publish', 'retract']);
    expect(store.get('C1').history.at(-1)).toMatchObject({ event: 'retract', by: 'MK', detail: '근거보다 넓은 주장' });
    const rendered = renderClaims(store, { surface: 'deck' });
    expect(rendered.included).toEqual([]);
    expect(rendered.excluded).toEqual([{ id: 'C1', reason: 'retracted' }]);
    expect(rendered.markdown).not.toContain(input.claim);
    expect(queueStaleRechecks(store, { root: instanceRoot, now })).toBe(0);
    expect(existsSync(join(instanceRoot, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(() => store.retract('C1', { reason: 'again', by: 'MK' })).toThrow(ClaimsInputError);
    expect(() => store.verify('C1', { ...proof, measuredAt: now.toISOString(), validUntil: '2026-10-07T00:00:00Z' })).toThrow(ClaimsInputError);
    expect(store.get('C1').history).toHaveLength(4);
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(instanceRoot, { recursive: true, force: true }); }
});

test('migrates old CHECK schema while preserving claim and dependent rows', () => {
  const stateDir = root();
  const dir = join(stateDir, 'claims');
  mkdirSync(dir);
  const db = new Database(join(dir, 'claims.sqlite'));
  try {
    db.exec(`CREATE TABLE claims (
      id TEXT PRIMARY KEY, claim TEXT NOT NULL, audience TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','verified','public','stale')),
      owner TEXT NOT NULL, contrast TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE evidence (claim_id TEXT NOT NULL REFERENCES claims(id), value TEXT NOT NULL, command TEXT NOT NULL,
        source TEXT, measured_at TEXT NOT NULL, valid_until TEXT NOT NULL);
      CREATE TABLE links (claim_id TEXT NOT NULL REFERENCES claims(id), cell TEXT NOT NULL, version TEXT);
      CREATE TABLE history (claim_id TEXT NOT NULL REFERENCES claims(id), at TEXT NOT NULL, by TEXT NOT NULL,
        event TEXT NOT NULL, detail TEXT NOT NULL);
      INSERT INTO claims VALUES ('old', '오래된 주장.', 'team', 'public', 'MK', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
      INSERT INTO evidence VALUES ('old', '7건', 'measure', NULL, '2026-10-01T00:00:00Z', '2026-10-07T00:00:00Z');
      INSERT INTO links VALUES ('old', 'CLAIMS1', '0.2.15');
      INSERT INTO history VALUES ('old', '2026-10-01T00:00:00Z', 'MK', 'add', '오래된 주장.');`);
  } finally { db.close(); }
  try {
    const store = new ClaimsLedger({ stateDir, now: () => new Date('2026-10-04T00:00:00Z') });
    expect(store.get('old')).toMatchObject({ status: 'public', claim: '오래된 주장.',
      evidence: [{ value: '7건' }], links: [{ cell: 'CLAIMS1' }], history: [{ event: 'add' }] });
    expect(store.retract('old', { reason: 'too broad', by: 'MK' }).status).toBe('retracted');
    const migrated = new Database(store.path);
    try {
      expect(migrated.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((migrated.query('SELECT count(*) AS n FROM evidence').get() as { n: number }).n).toBe(1);
      expect((migrated.query('SELECT count(*) AS n FROM links').get() as { n: number }).n).toBe(1);
      expect((migrated.query('SELECT count(*) AS n FROM history').get() as { n: number }).n).toBe(2);
    } finally { migrated.close(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('two ledger instances alternate writes to one SQLite file without losing rows', () => {
  const stateDir = root();
  try {
    const a = new ClaimsLedger({ stateDir });
    const b = new ClaimsLedger({ stateDir });
    a.add(input);
    b.add({ ...input, id: 'C2' });
    a.verify('C2', { value: 'yes', command: 'echo yes', measuredAt: new Date().toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), by: 'TC' });
    b.link('C1', { cell: 'CLAIMS1' });
    expect(a.list().map(row => row.id)).toEqual(['C1', 'C2']);
    expect(b.get('C2').evidence).toHaveLength(1);
    expect(a.get('C1').links).toHaveLength(1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('latest measurement decides freshness and equality with expiry is stale', () => {
  const stateDir = root();
  let now = new Date('2026-10-04T00:00:00Z');
  try {
    const store = new ClaimsLedger({ stateDir, now: () => now });
    store.add(input);
    store.verify('C1', { value: 'old', command: 'old', measuredAt: '2026-10-03T00:00:00Z', validUntil: '2026-10-04T01:00:00Z', by: 'TC' });
    store.verify('C1', { value: 'new', command: 'new', measuredAt: '2026-10-04T00:00:00Z', validUntil: '2026-10-06T00:00:00Z', by: 'TC' });
    now = new Date('2026-10-04T02:00:00Z');
    expect(store.list()[0]?.status).toBe('verified');
    now = new Date('2026-10-06T00:00:00Z');
    expect(store.get('C1').status).toBe('stale');
    expect(store.get('C1').history.filter(h => h.event === 'stale')).toHaveLength(1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
