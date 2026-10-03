import { expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore } from '../mss/logging/log-store.js';
import { listLoops } from '../loops/registry.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { parse } from 'yaml';
import { scanSecretExposures } from './secret-exposure-scan.js';

const now = new Date('2026-10-03T12:00:00.000Z');
const version = { released: '0.1.0', dev: '0.1.1', codename: 'test' };

test('daily graph is connected to a single shadow scan command', () => {
  const graph = parse(readFileSync('graphs/ops/secret-exposure.yaml', 'utf8'));
  const recipes = parse(readFileSync('graphs/ops/recipes.yaml', 'utf8'));
  expect(graph.loop.trigger.cron).toBe('0 4 * * *');
  expect(graph.nodes.filter((node: { recipe?: string }) => node.recipe === 'cmd:secret-exposure-scan')).toHaveLength(1);
  expect(graph.edges[0].map.ok).toBe('done');
  expect(recipes['secret-exposure-scan'].command).toContain('src/guardian/secret-exposure-scan.ts');
  expect(recipes['secret-exposure-scan'].command).not.toContain('--publish');
  const listed = listLoops({ root: process.cwd(), stateRoot: process.cwd() + '/.elanous-test', schedules: [] }).find(e => e.id === 'secret-exposure');
  expect(listed?.trigger.cron).toBe('0 4 * * *');
  expect(listed?.enabled).toBe(false);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  const logs = new LogStore(join(root, 'logs', 'logs.db'));
  const decisions = new DecisionLedger({ stateDir: root, now: () => now, resolveVersion: () => version });
  const deps = { logs, decisions, context: () => [], now: () => now, stateRoot: root };
  return { root, logs, decisions, deps, close: () => { logs.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('fake log token yields only store/row ID/kind/prefix/length; shadow writes nothing and publish deduplicates', () => {
  const f = fixture();
  try {
    const token = 'ghp_' + 'S'.repeat(28);
    f.logs.insertBatch([{ rec: { ts: now.toISOString(), category: 'fixture', event: 'candidate', data: { token } }, surface: 'nexus' }]);
    const id = String(f.logs.queryAll()[0]!.id);
    const shadow = scanSecretExposures({}, f.deps);
    expect(shadow).toEqual({ mode: 'shadow', candidates: [{ store: 'logs', rowId: id, kind: 'token-prefix', prefix: 'ghp_', length: token.length }], raised: 0 });
    expect(f.decisions.list({ status: 'all' })).toHaveLength(0);
    expect(JSON.stringify(shadow)).not.toContain(token);
    expect(scanSecretExposures({}, { decisions: f.decisions, context: f.deps.context, now: f.deps.now, stateRoot: f.root })).toEqual(shadow);
    const published = scanSecretExposures({ publish: true }, f.deps);
    expect(published.raised).toBe(1);
    expect(scanSecretExposures({ publish: true }, f.deps).raised).toBe(0);
    const card = f.decisions.list({ status: 'all' })[0]!;
    expect(card.category).toBe('secret');
    expect(card.refs).toEqual([`secret-exposure:logs:${id}:token-prefix`]);
    expect(JSON.stringify(card)).not.toContain(token);
    expect(readFileSync(f.decisions.path, 'utf8')).not.toContain(token);
  } finally { f.close(); }
});

test('key-shaped assignments and bearer headers expose only the captured credential', () => {
  const f = fixture();
  try {
    f.logs.insertBatch([{ rec: { ts: now.toISOString(), category: 'fixture', event: 'headers',
      data: { api_key: 'ABCD' + 'y'.repeat(20), authorization: 'Bearer ' + 'WXYZ' + 'x'.repeat(20) } }, surface: 'nexus' }]);
    const found = scanSecretExposures({}, f.deps).candidates;
    expect(found.map(({ kind, prefix, length }) => ({ kind, prefix, length }))).toEqual([
      { kind: 'bearer', prefix: 'WXYZ', length: 24 }, { kind: 'key', prefix: 'ABCD', length: 24 },
    ]);
    expect(JSON.stringify(found)).not.toContain('WXYZ' + 'x'.repeat(20));
    expect(JSON.stringify(found)).not.toContain('ABCD' + 'y'.repeat(20));
  } finally { f.close(); }
});

test('clean and out-of-window logs yield zero candidates; other ledgers scan without copying secret values', () => {
  const f = fixture();
  try {
    f.logs.insertBatch([
      { rec: { ts: now.toISOString(), category: 'fixture', event: 'clean', data: { message: 'all good' } }, surface: 'nexus' },
      { rec: { ts: new Date(now.getTime() - 86_400_001).toISOString(), category: 'fixture', event: 'old', data: { token: 'ghp_' + 'Z'.repeat(30) } }, surface: 'nexus' },
    ]);
    expect(scanSecretExposures({}, f.deps).candidates).toEqual([]);
    const entry = { id: 'D-20261003-01', title: 'Bearer ' + 'a'.repeat(20), category: 'other', scqa: { s: 'source', c: 'issue' },
      options: [], recommendation: { skipped: true, reason: 'review' }, raisedBy: { agent: 'fixture' }, status: 'open', history: [], raisedAt: now.toISOString() };
    mkdirSync(join(f.root, 'decisions'), { recursive: true });
    appendFileSync(f.decisions.path, JSON.stringify({ type: 'raised', entry }) + '\n');
    const context = [{ id: '11111111-1111-4111-8111-111111111111', at: now.toISOString(), text: '-----BEGIN PRIVATE KEY-----', summary: 'clean', kind: 'note',
      refs: { seat: 'OP', recipients: [], all: false, kind: null, slot: null, deadline: null, url: null } }];
    const result = scanSecretExposures({}, { ...f.deps, context: () => context });
    expect(result.candidates).toEqual([
      { store: 'decisions', rowId: entry.id, kind: 'bearer', prefix: 'aaaa', length: 20 },
      { store: 'context', rowId: '11111111-1111-4111-8111-111111111111', kind: 'private-key', prefix: '----', length: 27 },
    ]);
    expect(JSON.stringify(result)).not.toContain('a'.repeat(20));
    expect(JSON.stringify(result)).not.toContain('-----BEGIN PRIVATE KEY-----');
  } finally { f.close(); }
});
