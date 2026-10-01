import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prodInstanceRoot } from '../../instance/resolve.js';
import { LogStore, resolveLogInstanceName, type LogStoreRow } from '../../mss/logging/log-store.js';
import type { LogInstanceView } from '../../mss/logging/instance-registry.js';
import type { MetaApiOpts } from './meta-api.js';
import { buildRunTrace, buildTrace, handleTrace, handleTraceEvidence } from './trace.js';
import { handleLogsQuery } from './log-fabric.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

const open = { noAuth: true } as MetaApiOpts;
const locked = { noAuth: false, bearerToken: 'a-secret' } as MetaApiOpts;
const req = (path: string, token?: string) => new Request(`http://localhost${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
const ts = '2026-09-28T00:00:00.000Z';
function row(id: number, data: object, overrides: Partial<LogStoreRow> = {}): LogStoreRow {
  return { id, ts, ts_ms: Date.parse(ts), level: 'info', instance: 'test:one', surface: 'nexus', category: 'decision', event: 'VERIFY', session_id: null, trace_id: null, data: JSON.stringify(data), ...overrides };
}
function seed(instance = 'test:one'): LogStore {
  const store = new LogStore(':memory:', { instance });
  store.insertBatch([
    { rec: { ts, category: 'decision', event: 'VERIFY', data: { runId: 'run-a', parentRunId: 'parent-a', phase: 'review', kind: 'VERIFY', what: 'gate failed', why: 'two fixes', refs: { pr: 42, commit: 'abc' } } }, surface: 'nexus' },
    { rec: { ts: '2026-09-28T00:01:00.000Z', category: 'decision', event: 'HEAL', data: { runId: 'run-a', phase: 'review', what: 'retry' } }, surface: 'nexus' },
    { rec: { ts: '2026-09-28T00:02:00.000Z', category: 'harness.gate', event: 'failed', data: { runId: 'run-b', phase: 'gate' } }, surface: 'nexus' },
  ]);
  return store;
}
function view(name: string): LogInstanceView {
  return { name, dbPath: `/tmp/${name}.db`, dbExists: true, stateDir: '/tmp', configDir: '/tmp', pid: 0, startedAt: '', alive: false, liveness: 'dead', stateDirCount: 1, ambiguous: false, kind: 'test' } as LogInstanceView;
}

describe('buildTrace — pure L0–L3 graph', () => {
  const records = [row(3, { runId: 'run-a', phase: 'review', kind: 'HEAL', what: 'retry again' }), row(2, { runId: 'run-a', phase: 'review', kind: 'HEAL', what: 'retry' }), row(1, { runId: 'run-a', parentRunId: 'parent-a', phase: 'review', kind: 'VERIFY', what: 'failed', why: 'must fix', refs: { pr: 42 } })];
  it('preserves evidence IDs, decision fields, facets and unmeasured instead of inventing zero', () => {
    const snapshot = JSON.stringify(records);
    const trace = buildTrace(records, 'L3');
    expect(trace.events[2]).toMatchObject({ id: 'log:test%3Aone:1', universe: 'test:one', runId: 'run-a', parentRunId: 'parent-a', kind: 'VERIFY', why: 'must fix', refs: { logId: 'log:test%3Aone:1', pr: 42 } });
    expect(trace.facets).toEqual({ universe: { 'test:one': 3 }, kind: { HEAL: 2, VERIFY: 1 }, phase: { review: 3 }, unmeasured: { why: 2, machine: 3, shard: 3 } });
    expect(trace.nodes.find((n) => n.id === 'log:test%3Aone:1')).toMatchObject({ level: 'L3', kind: 'VERIFY' });
    expect(trace.edges).toContainEqual({ source: 'log:test%3Aone:1', target: 'log:test%3Aone:2', kind: 'next' });
    expect(JSON.stringify(records)).toBe(snapshot);
  });
  it('projects the real emitDecision payload reason and numeric PATHS without losing them', () => {
    const trace = buildTrace([row(4, {
      kind: 'VERIFY', runId: 'run-a', parentRunId: 'supervisor', phase: 'gate', shard: 'pod-1',
      what: 'gate failed', reason: 'must-fix', purpose: 'ship safely', target: 'HEAL', paths: 2,
      refs: { pr: 42, commit: 'abc' },
    }, { category: 'harness.decision', event: 'decision' })], 'L3');
    expect(trace.events[0]).toMatchObject({ why: 'must-fix', purpose: 'ship safely', target: 'HEAL', paths: 2,
      shard: 'pod-1', parentRunId: 'supervisor', refs: { pr: 42, commit: 'abc' } });
    expect(trace.facets.unmeasured).toEqual({ machine: 1 });
    expect(trace.nodes).toContainEqual(expect.objectContaining({ id: 'shard:test:one:run-a:gate:pod-1', level: 'L2' }));
    expect(trace.edges).toContainEqual({ source: 'phase:test:one:run-a:gate', target: 'shard:test:one:run-a:gate:pod-1', kind: 'shard' });
  });
  it('shows measured machine at L0 and missing run/phase without a fake run', () => {
    const trace = buildTrace([row(7, { what: 'orphan' }, { host_id: 'host-1' })], 'L0');
    expect(trace.nodes.map((node) => node.id)).toEqual(['universe:test:one', 'machine:test:one:host-1']);
    expect(trace.edges).toEqual([{ source: 'universe:test:one', target: 'machine:test:one:host-1', kind: 'hosts' }]);
    expect(trace.facets.unmeasured).toEqual({ why: 1, runId: 1, phase: 1, shard: 1 });
    expect(buildTrace([row(7, { what: 'orphan' })], 'L3').nodes.some((node) => node.level === 'L1')).toBe(false);
  });
  it('changes graph resolution without discarding events and links parent run to child', () => {
    const l0 = buildTrace(records, 'L0');
    const l1 = buildTrace(records, 'L1');
    const l2 = buildTrace(records, 'L2');
    expect(l0.nodes.map((n) => n.level)).toEqual(['L0']);
    expect(l1.nodes.some((n) => n.id === 'run:test:one:parent-a')).toBe(true);
    expect(l1.edges).toContainEqual({ source: 'run:test:one:parent-a', target: 'run:test:one:run-a', kind: 'parent' });
    expect(l2.nodes.some((n) => n.level === 'L2' && n.phase === 'review')).toBe(true);
    expect(l2.nodes.some((n) => n.level === 'L3')).toBe(false);
    expect([l0, l1, l2].map((v) => v.events.length)).toEqual([3, 3, 3]);
  });
});

describe('buildRunTrace — run projection', () => {
  it('counts runs per universe and keeps an absent parent at count zero regardless of input order', () => {
    const runs = [
      { universe: 'test:one', runId: 'child', parentRunId: 'parent', firstTs: ts, lastTs: ts, rows: 3 },
      { universe: 'test:one', runId: 'parent', parentRunId: null, firstTs: ts, lastTs: ts, rows: 9 },
      { universe: 'test:two', runId: 'orphan', parentRunId: 'missing', firstTs: ts, lastTs: ts, rows: 1 },
    ];
    const unchanged = JSON.stringify(runs);
    const l1 = buildRunTrace(runs, 'L1');
    expect(l1.nodes.find((n) => n.id === 'universe:test:one')?.count).toBe(2);
    expect(l1.nodes.find((n) => n.id === 'run:test:one:parent')).toMatchObject({ count: 9, firstTs: ts, lastTs: ts });
    expect(l1.nodes.find((n) => n.id === 'run:test:two:missing')?.count).toBe(0);
    expect(l1.edges).toContainEqual({ source: 'run:test:one:parent', target: 'run:test:one:child', kind: 'parent' });
    expect(l1.facets.universe).toEqual({ 'test:one': 2, 'test:two': 1 });
    expect(l1.events).toEqual([]);
    expect(buildRunTrace(runs, 'L0').nodes.map((n) => n.id)).toEqual(['universe:test:one', 'universe:test:two']);
    expect(JSON.stringify(runs)).toBe(unchanged);
  });
});

describe('authenticated trace and evidence', () => {
  it('includes quiet older runs outside the newest 1000 rows at L1 without truncating, while L3 keeps the row page', async () => {
    const store = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const base = Date.parse(ts);
    const quiet = ['r-a', 'r-b', 'r-c'].flatMap((runId, index) => Array.from({ length: 3 }, (_, i) => ({
      rec: { ts: new Date(base + index * 3000 + i * 1000).toISOString(), category: 'decision', event: 'VERIFY',
        data: { runId, ...(runId === 'r-b' ? { parentRunId: 'r-a' } : {}) } }, surface: 'nexus',
    })));
    const hot = Array.from({ length: 1200 }, (_, i) => ({ rec: {
      ts: new Date(base + 10_000 + i * 1000).toISOString(), category: 'decision', event: 'VERIFY', data: { runId: 'r-hot' },
    }, surface: 'nexus' }));
    try {
      store.insertBatch([...quiet, ...hot]);
      const observed: unknown[] = [];
      const deps = { store: () => store, queryLog: (details: unknown) => observed.push(details) };
      const l1 = await handleTrace(req('/v1/trace?level=L1&limit=1000'), open, deps).json() as {
        nodes: Array<{ id: string; count: number; firstTs?: string; lastTs?: string }>;
        edges: Array<{ source: string; target: string; kind: string }>;
        events: unknown[]; facets: { universe: Record<string, number> }; truncated: boolean;
      };
      expect(new Set(l1.nodes.filter((n) => n.id.startsWith('run:')).map((n) => n.id))).toEqual(new Set(['r-hot', 'r-a', 'r-b', 'r-c'].map((id) => `run:${store.instance}:${id}`)));
      expect(l1.nodes.find((n) => n.id === `run:${store.instance}:r-hot`)?.count).toBe(1200);
      expect(l1.nodes.find((n) => n.id === `run:${store.instance}:r-b`)).toMatchObject({ count: 3, firstTs: quiet[3]!.rec.ts, lastTs: quiet[5]!.rec.ts });
      expect(l1.facets.universe).toEqual({ [store.instance]: 4 });
      expect(l1.events).toEqual([]);
      expect(l1.truncated).toBe(false);
      expect(l1.edges).toContainEqual({ source: `run:${store.instance}:r-a`, target: `run:${store.instance}:r-b`, kind: 'parent' });
      const l0 = await handleTrace(req('/v1/trace?level=L0&limit=1'), open, deps).json() as { nodes: Array<{ count: number }>; truncated: boolean };
      expect(l0.nodes).toMatchObject([{ count: 4 }]);
      expect(l0.truncated).toBe(false);
      const l3 = await handleTrace(req('/v1/trace?level=L3&limit=1000'), open, deps).json() as { events: Array<{ runId: string }>; truncated: boolean };
      expect(l3.events).toHaveLength(1000);
      expect(l3.events.every((e) => e.runId === 'r-hot')).toBe(true);
      expect(l3.truncated).toBe(true);
      expect(observed).toContainEqual({ stores: [store.instance], level: 'L1', count: 0, truncated: false, mode: 'runs', runs: 4 });
      expect(observed).toContainEqual({ stores: [store.instance], level: 'L3', count: 1000, truncated: true, mode: 'rows', runs: 1 });
    } finally { store.close(); }
  });

  it('marks a store truncated at 500 distinct runs and keeps q/kind on the original row path', async () => {
    const store = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    try {
      store.insertBatch(Array.from({ length: 500 }, (_, i) => ({ rec: {
        ts: new Date(Date.parse(ts) + i * 1000).toISOString(), category: 'decision', event: 'VERIFY',
        data: { runId: `r-${i}`, kind: 'VERIFY' },
      }, surface: 'nexus' })));
      const deps = { store: () => store, queryLog: () => {} };
      const runs = await handleTrace(req('/v1/trace?level=L1'), open, deps).json() as { truncated: boolean; nodes: Array<{ id: string }> };
      expect(runs.nodes.filter((n) => n.id.startsWith('run:'))).toHaveLength(500);
      expect(runs.truncated).toBe(true);
      for (const filter of ['kind=VERIFY', 'q=VERIFY']) {
        const rows = await handleTrace(req(`/v1/trace?level=L1&limit=2&${filter}`), open, deps).json() as { events: unknown[]; truncated: boolean };
        expect(rows.events).toHaveLength(2);
        expect(rows.truncated).toBe(true);
      }
    } finally { store.close(); }
  });

  it('preserves the row projection byte for L2, L3, runId, q and kind lenses', async () => {
    const store = seed(resolveLogInstanceName());
    try {
      const urls = [
        '/v1/trace?level=L2&runId=run-a',
        '/v1/trace?level=L3',
        '/v1/trace?level=L1&runId=run-a',
        '/v1/trace?level=L0&q=retry',
        '/v1/trace?level=L1&kind=VERIFY',
      ];
      for (const path of urls) {
        const url = new URL(req(path).url);
        const level = url.searchParams.get('level') as 'L0' | 'L1' | 'L2' | 'L3';
        const runId = url.searchParams.get('runId');
        const search = url.searchParams.get('q');
        const kind = url.searchParams.get('kind');
        const query = { limit: 1001, ...(search ? { grep: search } : {}) };
        const selected = (runId ? store.queryTraceRun(runId, query) : store.query(query))
          .filter((entry) => !kind || JSON.parse(entry.data!).kind === kind || (kind === 'VERIFY' && entry.event === 'VERIFY'));
        const expected = JSON.stringify({ ok: true, ...buildTrace(selected.slice(0, 100), level, selected.length > 100), stores: [store.instance], registeredStores: 1 });
        const actual = await handleTrace(req(path), open, { store: () => store, instances: () => [], queryLog: () => {} }).text();
        expect(actual).toBe(expected);
      }
    } finally { store.close(); }
  });

  it('blocks unauthenticated reads before resolving stores', () => {
    let calls = 0;
    const deps = { store: () => { calls++; return null; }, instances: () => { calls++; return []; } };
    expect(handleTrace(req('/v1/trace'), locked, deps).status).toBe(401);
    expect(handleTraceEvidence(req('/v1/trace/evidence/log:test%3Aone:1'), locked, 'log:test%3Aone:1', deps).status).toBe(401);
    expect(calls).toBe(0);
    const store = seed(resolveLogInstanceName());
    try {
      expect(handleTrace(req('/v1/trace', 'a-secret'), locked, { store: () => store, queryLog: () => {} }).status).toBe(200);
      const ref = `log:${encodeURIComponent(store.instance)}:1`;
      expect(handleTraceEvidence(req(`/v1/trace/evidence/${ref}`, 'a-secret'), locked, ref, { store: () => store }).status).toBe(200);
    } finally { store.close(); }
  });
  it('resolves an unregistered prod store through the injected root before the default resolver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-trace-prod-'));
    const dbPath = join(dir, 'logs', 'logs.db');
    mkdirSync(join(dir, 'logs'));
    const writer = new LogStore(dbPath, { instance: 'prod' });
    writer.insertBatch([{ rec: { ts, category: 'decision', event: 'VERIFY', data: { runId: 'prod-run' } }, surface: 'nexus' }]);
    writer.close();
    const opened: string[] = [];
    const deps = { instances: () => [], prodStateRoot: () => dir,
      openRemoteStore: (v: LogInstanceView) => { opened.push(v.dbPath); return LogStore.openReadOnly(v.dbPath); } };
    try {
      const result = await handleTrace(req('/v1/trace?store=prod&level=L3'), open, deps).json() as { events: Array<{ universe: string }> };
      expect(result.events.map((e) => e.universe)).toEqual(['prod']);
      const evidence = await handleTraceEvidence(req('/v1/trace/evidence/log:prod:1'), open, 'log:prod:1', deps).json() as { evidence: { instance: string } };
      expect(evidence.evidence.instance).toBe('prod');
      expect(opened).toEqual([dbPath, dbPath]);
      expect(prodInstanceRoot()).not.toBe(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('filters run, universe, kind, search, time; clamps limits and logs queries', async () => {
    const store = seed(resolveLogInstanceName());
    const logs: unknown[] = [];
    try {
      const res = handleTrace(req(`/v1/trace?universe=${encodeURIComponent(store.instance)}&runId=run-a&kind=VERIFY&q=gate%20failed&from=2026-09-28T00%3A00%3A00Z&to=2026-09-28T00%3A01%3A00Z&level=L3&limit=50000`), open, { store: () => store, queryLog: (details) => logs.push(details) });
      expect(res.status).toBe(200);
      const body = await res.json() as { events: Array<{ id: string }>; nodes: unknown[]; facets: { kind: Record<string, number> }; truncated: boolean };
      expect(body.events.map((e) => e.id)).toEqual([`log:${encodeURIComponent(store.instance)}:1`]);
      expect(body.facets.kind).toEqual({ VERIFY: 1 });
      expect(logs).toEqual([{ stores: [store.instance], level: 'L3', count: 1, truncated: false, mode: 'rows', runs: 1 }]);
      const limited = await handleTrace(req('/v1/trace?level=L3&limit=1'), open, { store: () => store, queryLog: () => {} }).json() as { events: unknown[]; truncated: boolean };
      expect(limited.events).toHaveLength(1);
      expect(limited.truncated).toBe(true);
    } finally { store.close(); }
  });
  it('rejects invalid level, time and limit without querying and reports absent store', () => {
    const store = seed();
    let queried = 0;
    const deps = { store: () => store, instances: () => [], queryLog: () => { queried++; } };
    for (const path of ['/v1/trace?level=L4', '/v1/trace?limit=0', '/v1/trace?from=bogus', '/v1/trace?from=2026-10-01&to=2026-09-01']) expect(handleTrace(req(path), open, deps).status).toBe(400);
    expect(handleTrace(req('/v1/trace?store=unknown'), open, deps).status).toBe(404);
    expect(handleTrace(req('/v1/trace?universe=test:unselected'), open, deps).status).toBe(404);
    expect(handleTrace(req('/v1/trace?store=unknown&universe=test:unselected'), open, deps).status).toBe(404);
    expect(queried).toBe(0);
    store.close();
  });
  it('federates registered stores, closes remote handles and never aliases equal local IDs', async () => {
    const one = seed(resolveLogInstanceName());
    const two = seed('test:two');
    const closed: string[] = [];
    const deps = { store: () => one, instances: () => [view('test:two')], openRemoteStore: () => two, closeRemoteStore: () => { closed.push('two'); }, queryLog: () => {} };
    try {
      const res = handleTrace(req(`/v1/trace?store=${encodeURIComponent(one.instance)},test:two&runId=run-a`), open, deps);
      const body = await res.json() as { stores: string[]; events: Array<{ id: string }> };
      expect(body.events).toHaveLength(4);
      expect(new Set(body.events.map((e) => e.id)).size).toBe(4);
      expect(body.stores).toEqual([one.instance, 'test:two']);
      const universeOnly = await handleTrace(req('/v1/trace?universe=test:two&runId=run-a'), open, deps).json() as { events: Array<{ universe: string }> };
      expect(universeOnly.events).toHaveLength(2);
      expect(universeOnly.events.every((event) => event.universe === 'test:two')).toBe(true);
      expect(closed).toEqual(['two', 'two']);
      const evidence = handleTraceEvidence(req('/v1/trace/evidence/log:test%3Atwo:1'), open, 'log:test%3Atwo:1', deps);
      expect((await evidence.json() as { evidence: { instance: string; data: { what: string } } }).evidence).toMatchObject({ instance: 'test:two', data: { what: 'gate failed' } });
      expect(closed).toEqual(['two', 'two', 'two']);
      expect(handleTraceEvidence(req('/v1/trace/evidence/bad'), open, 'bad', deps).status).toBe(400);
      expect(handleTraceEvidence(req('/v1/trace/evidence/log:test%3Atwo:99'), open, 'log:test%3Atwo:99', deps).status).toBe(404);
    } finally { one.close(); two.close(); }
  });
  it('counts registered log stores outside @active and reports registry read failures as null', async () => {
    const self = seed(resolveLogInstanceName());
    const recent = seed('test:recent');
    const views = [view('test:recent'), view('test:stale'), { ...view('test:empty'), dbExists: false }];
    const path = '/v1/trace?level=L1&store=@active';
    const deps = {
      store: () => self, instances: () => views,
      dbMtimeMs: (dbPath: string) => dbPath.includes('recent') ? Date.now() : Date.now() - 3 * 86_400_000,
      openRemoteStore: () => recent, closeRemoteStore: () => {}, queryLog: () => {},
    };
    try {
      const counted = await handleTrace(req(path), open, deps).json() as { registeredStores: number | null; stores: string[] };
      expect(counted.registeredStores).toBe(3);
      expect(counted.stores).toEqual([self.instance, 'test:recent']);
      const expectedRuns = [self, recent].flatMap((store) => store.aggregateRuns({}, 500).map((run) => ({ ...run, universe: store.instance })));
      const { registeredStores, ...existingFields } = counted;
      expect(JSON.stringify(existingFields)).toBe(JSON.stringify({ ok: true, ...buildRunTrace(expectedRuns, 'L1'), stores: [self.instance, 'test:recent'] }));
      const unreadable = await handleTrace(req(path), open, {
        ...deps, instances: () => { throw new Error('registry unavailable'); },
      }).json() as { registeredStores: number | null; stores: string[] };
      expect(unreadable.registeredStores).toBeNull();
      expect(unreadable.stores).toEqual([self.instance]);
      const rowMode = await handleTrace(req('/v1/trace?level=L3'), open, {
        ...deps, instances: () => { throw new Error('registry unavailable'); },
      }).json() as { registeredStores: number | null };
      expect(rowMode.registeredStores).toBeNull();
      const selfRegistered = await handleTrace(req('/v1/trace?level=L3'), open, {
        ...deps, instances: () => [view(self.instance), ...views],
      }).json() as { registeredStores: number | null };
      expect(selfRegistered.registeredStores).toBe(3);
    } finally { self.close(); recent.close(); }
  });
  it('expands @active through log fabric and excludes stale universes', async () => {
    const self = seed(resolveLogInstanceName());
    const recent = seed('test:recent');
    const now = Date.now();
    const opened: string[] = [];
    const deps = {
      store: () => self,
      instances: () => [view('test:recent'), view('test:stale')],
      dbMtimeMs: (path: string) => path.includes('recent') ? now - 1_000 : now - 3 * 86_400_000,
      openRemoteStore: (v: LogInstanceView) => { opened.push(v.name); return recent; },
      closeRemoteStore: () => {}, queryLog: () => {},
    };
    try {
      const body = await handleTrace(req('/v1/trace?store=@active&limit=10'), open, deps).json() as { stores: string[]; nodes: Array<{ id: string }>; events: unknown[] };
      expect(body.stores).toEqual([self.instance, 'test:recent']);
      expect(body.events).toEqual([]);
      expect(new Set(body.nodes.filter((node) => node.id.startsWith('universe:')).map((node) => node.id))).toEqual(new Set([`universe:${self.instance}`, 'universe:test:recent']));
      expect(opened).toEqual(['test:recent']);
    } finally { self.close(); recent.close(); }
  });
  it('resolves an L3 run outside @active by its ledger, then scans its logs when the ledger is absent', async () => {
    const runId = 'run-318ea5d4-a21b-4fc2-ae24-3177278b2036';
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-ledger-'));
    const bDir = join(root, 'b');
    const ledgerDir = runLedgerDir(bDir);
    mkdirSync(ledgerDir, { recursive: true });
    const ledger = runLedgerPath(runId, ledgerDir);
    writeFileSync(ledger, `${JSON.stringify({ runId, event: 'start', data: {} })}\n`);
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const a = new LogStore(':memory:', { instance: 'test:a' });
    const b = new LogStore(':memory:', { instance: 'test:b' });
    b.insertBatch(['VERIFY', 'HEAL', 'SHIP'].map((kind, index) => ({ rec: {
      ts: new Date(Date.parse(ts) + index * 1000).toISOString(), category: 'harness.decision', event: 'decision',
      data: { runId, kind, phase: 'gate', what: kind },
    }, surface: 'nexus' })));
    const views = [{ ...view('test:a'), stateDir: join(root, 'a') }, { ...view('test:b'), stateDir: bDir }];
    const opened: string[] = [];
    const closed: string[] = [];
    const deps = {
      store: () => self, instances: () => views,
      dbMtimeMs: (path: string) => path.includes('test:a') ? Date.now() : Date.now() - 3 * 86_400_000,
      openRemoteStore: (v: LogInstanceView) => { opened.push(v.name); return v.name === 'test:a' ? a : b; },
      closeRemoteStore: (store: LogStore) => { closed.push(store.instance); }, queryLog: () => {},
    };
    const path = `/v1/trace?level=L3&runId=${runId}&store=@active`;
    try {
      const found = await handleTrace(req(path), open, deps).json() as { events: Array<{ kind: string; universe: string }>; stores: string[]; resolvedFrom?: string; runUniverse?: string };
      expect(found.events.map((event) => event.kind)).toEqual(['SHIP', 'HEAL', 'VERIFY']);
      expect(found.events.every((event) => event.universe === 'test:b')).toBe(true);
      expect(found.resolvedFrom).toBe('ledger');
      expect(found.stores).toEqual([self.instance, 'test:a', 'test:b']);
      expect(found.runUniverse).toBe('test:b');
      expect(opened).toEqual(['test:a', 'test:b']);
      expect(closed).toEqual(['test:a', 'test:b']);
      const l2Found = await handleTrace(req(path.replace('level=L3', 'level=L2')), open, deps).json() as { events: unknown[]; resolvedFrom?: string; runUniverse?: string };
      expect(l2Found).toMatchObject({ resolvedFrom: 'ledger', runUniverse: 'test:b' });
      expect(l2Found.events).toHaveLength(3);
      unlinkSync(ledger);
      const scanned = await handleTrace(req(path), open, deps).json() as { events: Array<{ kind: string }>; stores: string[]; runUniverse?: string; checked?: number; resolvedFrom?: string; truncated: boolean };
      expect(scanned.events.map((event) => event.kind)).toEqual(['SHIP', 'HEAL', 'VERIFY']);
      expect(scanned).toMatchObject({ runUniverse: 'test:b', checked: 2, resolvedFrom: 'log-scan', truncated: false });
      expect(scanned.stores).toEqual([self.instance, 'test:a', 'test:b']);
      expect(opened).toEqual(['test:a', 'test:b', 'test:a', 'test:b', 'test:a', 'test:a', 'test:b', 'test:b']);
      const l2 = await handleTrace(req(path.replace('level=L3', 'level=L2')), open, deps).json() as { runUniverse: string; checked: number; events: unknown[]; resolvedFrom: string };
      expect(l2).toMatchObject({ runUniverse: 'test:b', checked: 2, resolvedFrom: 'log-scan' });
      expect(l2.events).toHaveLength(3);
    } finally { self.close(); a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('reports a complete log-scan miss without claiming an absent ledger is a found universe', async () => {
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const other = new LogStore(':memory:', { instance: 'test:other' });
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-absent-'));
    try {
      const result = await handleTrace(req('/v1/trace?level=L2&runId=run-no-ledger-or-logs'), open, {
        store: () => self, instances: () => [{ ...view('test:other'), stateDir: root }],
        openRemoteStore: () => other, closeRemoteStore: () => {}, queryLog: () => {},
      }).json() as { runUniverse: string; checked: number; truncated: boolean; resolvedFrom?: string; events: unknown[] };
      expect(result).toMatchObject({ runUniverse: 'not-found', checked: 1, truncated: false, events: [] });
      expect(result.resolvedFrom).toBeUndefined();
    } finally { self.close(); other.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('does not report not-found when the only registered database could not be scanned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-unreadable-'));
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    try {
      for (const failure of ['open', 'query'] as const) {
        const response = handleTrace(req('/v1/trace?level=L2&runId=run-unreadable'), open, {
          store: () => self, instances: () => [{ ...view('test:unreadable'), stateDir: root }],
          openRemoteStore: () => failure === 'open' ? null : ({
            queryTraceRun: () => { throw new Error('read failed'); }, close: () => {},
          }) as unknown as LogStore,
          queryLog: () => {},
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          runUniverse: 'unresolved', checked: 1, truncated: false, events: [],
        });
      }
    } finally { self.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a bounded scan as unresolved rather than not-found', async () => {
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const views = Array.from({ length: 201 }, (_, i) => view(`test:scan-${i}`));
    let opens = 0;
    try {
      const result = await handleTrace(req('/v1/trace?level=L3&runId=run-outside-scan-cap'), open, {
        store: () => self, instances: () => views,
        ledgerStat: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
        openRemoteStore: () => { opens++; return { queryTraceRun: () => [], close: () => {} } as unknown as LogStore; },
        queryLog: () => {},
      }).json() as { runUniverse: string; checked: number; truncated: boolean; events: unknown[] };
      expect(result).toMatchObject({ runUniverse: 'unresolved', checked: 200, truncated: true, events: [] });
      expect(opens).toBe(200);
    } finally { self.close(); }
  });

  it('skips unreadable unselected databases while scanning for a ledgerless run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-scan-failure-'));
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const found = new LogStore(':memory:', { instance: 'test:found' });
    found.insertBatch([{ rec: { ts, category: 'harness.review', event: 'passed', data: { run_id: 'run-ledgerless', phase: 'review' } }, surface: 'nexus' }]);
    const views = ['test:failed', 'test:found'].map((name) => ({ ...view(name), stateDir: root }));
    const opened: string[] = [];
    try {
      const body = await handleTrace(req('/v1/trace?level=L2&runId=run-ledgerless'), open, {
        store: () => self, instances: () => views,
        openRemoteStore: (v) => { opened.push(v.name); if (v.name === 'test:failed') throw new Error('unreadable'); return found; },
        closeRemoteStore: () => {}, queryLog: () => {},
      }).json() as { runUniverse: string; checked: number; resolvedFrom: string; events: Array<{ universe: string }> };
      expect(body).toMatchObject({ runUniverse: 'test:found', checked: 2, resolvedFrom: 'log-scan' });
      expect(body.events.map((event) => event.universe)).toEqual(['test:found']);
      expect(opened).toEqual(['test:failed', 'test:found', 'test:found']);
    } finally { self.close(); found.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('still resolves the run by its ledger when one selected store fails to open, and keeps reporting that failure', async () => {
    const runId = 'run-318ea5d4-a21b-4fc2-ae24-3177278b2036';
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-failed-store-'));
    const bDir = join(root, 'b');
    const ledgerDir = runLedgerDir(bDir);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(runLedgerPath(runId, ledgerDir), `${JSON.stringify({ runId, event: 'start', data: {} })}\n`);
    const a = new LogStore(':memory:', { instance: 'test:a' });
    const b = new LogStore(':memory:', { instance: 'test:b' });
    b.insertBatch([{ rec: { ts, category: 'harness.decision', event: 'decision', data: { runId, kind: 'SHIP', what: 'merged' } }, surface: 'nexus' }]);
    const views = [{ ...view('test:a'), stateDir: join(root, 'a') }, { ...view('test:b'), stateDir: bDir }];
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    // `test:empty` is selected but has no log db — the production daemon's own tree-derived universe looked like this.
    views.push({ ...view('test:empty'), dbExists: false, stateDir: join(root, 'empty') });
    const deps = {
      store: () => self,
      instances: () => views,
      dbMtimeMs: (path: string) => path.includes('test:a') ? Date.now() : Date.now() - 3 * 86_400_000,
      openRemoteStore: (v: LogInstanceView) => v.name === 'test:a' ? a : b,
      closeRemoteStore: () => {}, queryLog: () => {},
    };
    const path = `/v1/trace?level=L3&runId=${runId}&store=@active,test:empty`;
    try {
      const res = handleTrace(req(path), open, deps);
      const body = await res.json() as { ok: boolean; events: Array<{ kind: string }>; resolvedFrom?: string; runUniverse?: string; failedStores?: Array<{ name: string }>; truncated: boolean };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.events.map((event) => event.kind)).toEqual(['SHIP']);
      expect(body).toMatchObject({ resolvedFrom: 'ledger', runUniverse: 'test:b', truncated: true });
      expect(body.failedStores?.map((f) => f.name)).toEqual(['test:empty']);
    } finally { self.close(); a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('reports a selected universe with a ledger but no matching log rows instead of not-found', async () => {
    const runId = 'run-318ea5d4-a21b-4fc2-ae24-3177278b2036';
    const root = mkdtempSync(join(tmpdir(), 'elanous-trace-selected-ledger-'));
    const aDir = join(root, 'a');
    const ledgerDir = runLedgerDir(aDir);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(runLedgerPath(runId, ledgerDir), `${JSON.stringify({ runId, event: 'start', data: {} })}\n`);
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const a = new LogStore(':memory:', { instance: 'test:a' });
    const b = new LogStore(':memory:', { instance: 'test:b' });
    a.insertBatch([{ rec: { ts, category: 'harness.decision', event: 'decision', data: { runId, kind: 'VERIFY', what: 'gate' } }, surface: 'nexus' }]);
    const views = [{ ...view('test:a'), stateDir: aDir }, { ...view('test:b'), stateDir: join(root, 'b') }];
    const opened: string[] = [];
    const deps = {
      store: () => self, instances: () => views,
      dbMtimeMs: (path: string) => path.includes('test:a') ? Date.now() : Date.now() - 3 * 86_400_000,
      openRemoteStore: (v: LogInstanceView) => { opened.push(v.name); return v.name === 'test:a' ? a : b; },
      closeRemoteStore: () => {}, queryLog: () => {},
    };
    try {
      for (const lens of ['q=does-not-match', 'from=2026-09-29', 'to=2026-09-27']) {
        const body = await handleTrace(req(`/v1/trace?level=L3&runId=${runId}&store=@active&${lens}`), open, deps).json() as {
          events: unknown[]; runUniverse?: string; resolvedFrom?: string; stores: string[];
        };
        expect(body.events).toEqual([]);
        expect(body).toMatchObject({ runUniverse: 'test:a', resolvedFrom: 'ledger', stores: [self.instance, 'test:a'] });
      }
      const empty = new LogStore(':memory:', { instance: 'test:a' });
      try {
        const noRows = await handleTrace(req(`/v1/trace?level=L2&runId=${runId}&store=@active`), open, {
          ...deps, openRemoteStore: () => empty,
        }).json() as { events: unknown[]; runUniverse?: string; resolvedFrom?: string };
        expect(noRows).toMatchObject({ events: [], runUniverse: 'test:a', resolvedFrom: 'ledger' });
      } finally { empty.close(); }
      expect(opened).toEqual(['test:a', 'test:a', 'test:a']);
    } finally { self.close(); a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('does not classify a failed ledger lookup as a missing run', async () => {
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const a = new LogStore(':memory:', { instance: 'test:a' });
    const views = [view('test:a'), { ...view('test:b'), stateDir: '/inaccessible-state' }];
    const runId = 'run-318ea5d4-a21b-4fc2-ae24-3177278b2036';
    const examined: string[] = [];
    const opened: string[] = [];
    try {
      const response = handleTrace(req(`/v1/trace?level=L3&runId=${runId}&store=@active`), open, {
        store: () => self, instances: () => views,
        dbMtimeMs: (path) => path.includes('test:a') ? Date.now() : Date.now() - 3 * 86_400_000,
        openRemoteStore: (view) => { opened.push(view.name); return a; }, closeRemoteStore: () => {}, queryLog: () => {},
        ledgerStat: (path) => { examined.push(path); if (path.includes('inaccessible-state')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { ok: boolean; error: string; reason: string; runUniverse?: string };
      expect(body).toMatchObject({ ok: false, error: 'run-universe-unavailable' });
      expect(body.reason).toContain("test:b");
      expect(body.runUniverse).toBeUndefined();
      expect(examined).toEqual([runLedgerPath(runId, runLedgerDir('/tmp')), runLedgerPath(runId, runLedgerDir('/inaccessible-state'))]);
      expect(opened).toEqual(['test:a']);
    } finally { self.close(); a.close(); }
  });
  it('does not call an unqueried selected universe not-found when another selected store was read', async () => {
    const self = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    const a = new LogStore(':memory:', { instance: 'test:a' });
    const runId = 'run-318ea5d4-a21b-4fc2-ae24-3177278b2036';
    const path = `/v1/trace?level=L3&runId=${runId}&store=@active`;
    const views = [view('test:a'), view('test:b')];
    const active = { store: () => self, instances: () => views,
      dbMtimeMs: (path: string) => path.includes('test:a') ? Date.now() : Date.now() - 3 * 86_400_000,
      closeRemoteStore: () => {}, queryLog: () => {} };
    try {
      const openFailure = handleTrace(req(path), open, { ...active, openRemoteStore: () => null });
      expect(openFailure.status).toBe(503);
      expect(await openFailure.json()).toMatchObject({ ok: false, error: 'log-store-unavailable', failedStores: [{ name: 'test:a' }] });
      const queryFailure = handleTrace(req(path), open, { ...active,
        openRemoteStore: () => ({ queryTraceRun: () => { throw new Error('read failed'); } }) as unknown as LogStore });
      expect(queryFailure.status).toBe(503);
      expect(await queryFailure.json()).toMatchObject({ ok: false, error: 'log-store-unavailable', failedStores: [{ name: 'test:a', reason: 'read failed' }] });
      const root = mkdtempSync(join(tmpdir(), 'elanous-trace-found-unavailable-'));
      try {
        const bDir = join(root, 'b');
        const ledgerDir = runLedgerDir(bDir);
        mkdirSync(ledgerDir, { recursive: true });
        writeFileSync(runLedgerPath(runId, ledgerDir), `${JSON.stringify({ runId, event: 'start' })}\n`);
        const found = handleTrace(req(path), open, { ...active, instances: () => [views[0]!, { ...views[1]!, stateDir: bDir }],
          openRemoteStore: (v: LogInstanceView) => v.name === 'test:a' ? a : null });
        expect(found.status).toBe(503);
        expect(await found.json()).toMatchObject({ ok: false, error: 'log-store-unavailable', failedStores: [{ name: 'test:b' }] });
        const foundQueryFailure = handleTrace(req(path), open, { ...active, instances: () => [views[0]!, { ...views[1]!, stateDir: bDir }],
          openRemoteStore: (v: LogInstanceView) => v.name === 'test:a' ? a : ({ queryTraceRun: () => { throw new Error('ledger store unreadable'); } }) as unknown as LogStore });
        expect(foundQueryFailure.status).toBe(503);
        expect(await foundQueryFailure.json()).toMatchObject({ ok: false, error: 'log-store-unavailable', failedStores: [{ name: 'test:b', reason: 'ledger store unreadable' }] });
      } finally { rmSync(root, { recursive: true, force: true }); }
    } finally { self.close(); a.close(); }
  });
  it('returns partial federation failures with the successful rows', async () => {
    const self = seed(resolveLogInstanceName());
    try {
      const body = await handleTrace(req('/v1/trace?store=@active,test:missing'), open, {
        store: () => self, instances: () => [], dbMtimeMs: () => null, queryLog: () => {},
      }).json() as { ok: boolean; truncated: boolean; events: unknown[]; nodes: Array<{ id: string }>; failedStores: Array<{ name: string; reason: string }> };
      expect(body.ok).toBe(true);
      expect(body.truncated).toBe(true);
      expect(body.events).toEqual([]);
      expect(body.nodes.some((n) => n.id === `run:${self.instance}:run-a`)).toBe(true);
      expect(body.failedStores).toEqual([{ name: 'test:missing', reason: "unknown instance 'test:missing'" }]);
    } finally { self.close(); }
  });
  it('rejects more than 20 explicitly selected stores before opening any remote handle', () => {
    let opened = 0;
    const stores = Array.from({ length: 21 }, (_, i) => `test:store-${i}`).join(',');
    const response = handleTrace(req(`/v1/trace?store=${stores}`), open, {
      store: () => { opened++; return null; },
      instances: () => { opened++; return []; },
    });
    expect(response.status).toBe(400);
    expect(opened).toBe(0);
  });
  it('returns 503 for an unavailable local log store without inventing zero events', () => {
    expect(handleTrace(req('/v1/trace'), open, { store: () => null }).status).toBe(503);
    const ref = `log:${encodeURIComponent(resolveLogInstanceName())}:1`;
    expect(handleTraceEvidence(req(`/v1/trace/evidence/${ref}`), open, ref, { store: () => null }).status).toBe(503);
  });
  it('keeps missing remote stores visible rather than silently returning an empty graph', async () => {
    const body = await handleTrace(req('/v1/trace?store=test:missing'), open, {
      store: () => null, instances: () => [view('test:missing')], openRemoteStore: () => null,
    }).json() as { error: string; failedStores: Array<{ name: string; reason: string }> };
    expect(body.error).toBe('log-store-unavailable');
    expect(body.failedStores).toEqual([{ name: 'test:missing', reason: "instance 'test:missing' store open failed" }]);
  });
  it('keeps the existing /v1/logs response envelope unchanged', async () => {
    const store = seed(resolveLogInstanceName());
    try {
      const body = await handleLogsQuery(req('/v1/logs?limit=1'), open, { store: () => store }).json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['count', 'logs', 'ok', 'ts']);
      expect(body.count).toBe(1);
      expect(Array.isArray(body.logs)).toBe(true);
    } finally { store.close(); }
  });
  it('finds an old run beyond the candidate page rather than dropping it', async () => {
    const store = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    try {
      store.insertBatch([{ rec: { ts, category: 'decision', event: 'VERIFY', data: { runId: 'old-run', what: 'root cause' } }, surface: 'nexus' }]);
      store.insertBatch(Array.from({ length: 1002 }, (_, i) => ({ rec: { ts: new Date(Date.parse(ts) + (i + 1) * 1000).toISOString(), category: 'decision', event: 'VERIFY', data: { runId: 'other' } }, surface: 'nexus' })));
      const body = await handleTrace(req('/v1/trace?runId=old-run'), open, { store: () => store, queryLog: () => {} }).json() as { events: Array<{ what: string }> };
      expect(body.events.map((event) => event.what)).toEqual(['root cause']);
    } finally { store.close(); }
  });
  it('caps HTTP output at 1000 even when a larger limit is requested', async () => {
    const store = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    try {
      store.insertBatch(Array.from({ length: 1002 }, (_, i) => ({ rec: { ts: new Date(Date.parse(ts) + i * 1000).toISOString(), category: 'decision', event: 'VERIFY', data: { runId: 'r' } }, surface: 'nexus' })));
      const body = await handleTrace(req('/v1/trace?level=L3&limit=50000'), open, { store: () => store, queryLog: () => {} }).json() as { events: unknown[]; truncated: boolean };
      expect(body.events).toHaveLength(1000);
      expect(body.truncated).toBe(true);
    } finally { store.close(); }
  });
  it('does not silently report a complete filtered result when its candidate page was capped', async () => {
    const store = new LogStore(':memory:', { instance: resolveLogInstanceName() });
    try {
      store.insertBatch([{ rec: { ts, category: 'decision', event: 'PLAN', data: { runId: 'old', kind: 'PLAN' } }, surface: 'nexus' }]);
      store.insertBatch(Array.from({ length: 1002 }, (_, i) => ({ rec: { ts: new Date(Date.parse(ts) + (i + 1) * 1000).toISOString(), category: 'decision', event: 'VERIFY', data: { runId: 'new', kind: 'VERIFY' } }, surface: 'nexus' })));
      const body = await handleTrace(req('/v1/trace?kind=PLAN'), open, { store: () => store, queryLog: () => {} }).json() as { events: unknown[]; truncated: boolean };
      expect(body.events).toEqual([]);
      expect(body.truncated).toBe(true);
    } finally { store.close(); }
  });
  it('retrieves old evidence beyond a recent 1000-row page', async () => {
    const store = new LogStore(':memory:');
    try {
      store.insertBatch(Array.from({ length: 1002 }, (_, i) => ({ rec: { ts: new Date(Date.parse(ts) + i * 1000).toISOString(), category: 'decision', event: 'VERIFY', data: { runId: 'r' } }, surface: 'nexus' })));
      const ref = `log:${encodeURIComponent(store.instance)}:1`;
      expect((await handleTraceEvidence(req(`/v1/trace/evidence/${ref}`), open, ref, { store: () => store }).json() as { evidence: { id: number } }).evidence.id).toBe(1);
    } finally { store.close(); }
  });
  it('redacts secrets in evidence and rejects path-like store names', async () => {
    const store = new LogStore(':memory:');
    try {
      store.insertBatch([{ rec: { ts, category: 'decision', event: 'VERIFY', data: { runId: 'r', access_token: 'tok-value-123456', what: 'Authorization: Bearer abcdefgh12345678' } }, surface: 'nexus' }]);
      const ref = `log:${encodeURIComponent(store.instance)}:1`;
      const body = JSON.stringify(await handleTraceEvidence(req(`/v1/trace/evidence/${ref}`), open, ref, { store: () => store }).json());
      expect(body).not.toContain('tok-value-123456');
      expect(body).not.toContain('abcdefgh12345678');
      expect(body).toContain('"runId":"r"');
      for (const bad of ['log:..:1', 'log:%2E%2E:1', 'log:a%2Fb:1']) expect(handleTraceEvidence(req(`/v1/trace/evidence/${bad}`), open, bad, { store: () => store }).status).toBe(400);
    } finally { store.close(); }
  });
});

describe('NEXUS routes', () => {
  it('registers GET /v1/trace and /v1/trace/evidence/:ref behind owner auth', async () => {
    const opts = { metaApi: { bearerToken: 'owner-secret' } } as NexusHttpServerOpts;
    const server = { requestIP: () => ({ address: '203.0.113.1' }) } as any;
    const ref = { get: () => null } as any;
    const remote = (path: string, auth = true) => new Request(`http://remote.invalid${path}`, auth ? { headers: { authorization: 'Bearer owner-secret' } } : undefined);
    expect((await routeRequest(remote('/v1/trace', false), opts, server, null, ref))?.status).toBe(401);
    expect((await routeRequest(remote('/v1/trace/evidence/log:prod:1', false), opts, server, null, ref))?.status).toBe(401);
    expect((await routeRequest(remote('/v1/trace?level=L2'), opts, server, null, ref))?.status).toBe(400);
    expect((await routeRequest(remote('/v1/trace/evidence/bad'), opts, server, null, ref))?.status).toBe(400);
  });
});
