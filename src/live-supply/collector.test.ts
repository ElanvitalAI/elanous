import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveSupplyCollector } from './collector.js';
import type { SupplyProbes } from './snapshot.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-supply-'));
  roots.push(root);
  let now = Date.parse('2026-10-26T12:00:00Z');
  let quota: 'usable' | 'exhausted' = 'usable';
  let poolFails = false;
  const probes: SupplyProbes = {
    codex: () => ({ accounts: [{ name: 'third', usedPercent: 30, signalAt: '2026-10-26T12:00:00Z', available: true }] }),
    grok: () => ({ quota, observedAt: '2026-10-26T12:00:00Z' }),
    cost: () => ({ used: 12, limit: 100, currency: 'USD' }),
    pool: () => { if (poolFails) throw new Error('secret-token=do-not-persist'); return { members: [{ context: 'node-b', occupied: 1, capacity: 4 }] }; },
    hostCredentials: () => ({ hosts: [{ host: 'node-b', grokExpiry: 'expiring', grokExpiresAt: '2026-10-26T13:00:00Z', claude5hUsed: null, claude7dUsed: null, claude5hResetAt: null, claude7dResetAt: null }] }),
    parentHosts: () => ({ hosts: [{ host: 'node-b', approvalCapacity: 4, active: 2, headroom: 2 }] }),
  };
  const collector = new LiveSupplyCollector(probes, { directory: root, now: () => now });
  const events = () => { try { return readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  return { root, collector, events, advance: () => { now += 60_000; }, setQuota: (value: typeof quota) => { quota = value; }, failPool: () => { poolFails = true; } };
}

test('first tick commits measured axes; unchanged next tick does not publish duplicate changes', async () => {
  const f = fixture();
  const first = await f.collector.tick();
  expect(first.sequence).toBe(1);
  expect(first.sources.pool.status).toBe('measured');
  expect(first.values.parentHosts?.hosts[0]?.headroom).toBe(2);
  f.advance();
  const second = await f.collector.tick();
  expect(second.sequence).toBe(2);
  expect(f.events()).toEqual([]);
});

test('quota change emits one sequenced change, failed pool read keeps stale value without falsely reporting capacity zero', async () => {
  const f = fixture();
  await f.collector.tick();
  f.advance();
  f.setQuota('exhausted');
  f.failPool();
  const second = await f.collector.tick();
  expect(second.values.grok?.quota).toBe('exhausted');
  expect(second.sources.pool).toMatchObject({ status: 'stale', reason: 'probe-failed' });
  expect(second.values.pool?.members[0]?.occupied).toBe(1);
  expect(JSON.stringify(second)).not.toContain('secret-token');
  expect(f.events().map(e => [e.kind, e.axis, e.sequence])).toEqual([
    ['supply.changed', 'grok', 2], ['supply.unmeasured', 'pool', 2],
  ]);
  f.advance();
  await f.collector.tick();
  expect(f.events()).toHaveLength(2);
});

test('restart exposes disk snapshot as stale until a new sample succeeds', async () => {
  const f = fixture();
  await f.collector.tick();
  const restarted = new LiveSupplyCollector({
    codex: () => { throw new Error('offline'); }, grok: () => { throw new Error('offline'); },
    cost: () => { throw new Error('offline'); }, pool: () => { throw new Error('offline'); },
    hostCredentials: () => { throw new Error('offline'); }, parentHosts: () => { throw new Error('offline'); },
  }, { directory: f.root, now: () => Date.parse('2026-10-26T12:00:01Z') });
  expect(restarted.read()?.sources.codex.status).toBe('stale');
  const next = await restarted.tick();
  expect(next.sequence).toBe(2);
  expect(next.sources.codex.status).toBe('stale');
  expect(next.values.codex?.accounts[0]?.name).toBe('third');
});

test('start samples immediately and schedules at 60 seconds; stop clears the interval', async () => {
  const f = fixture();
  let callback: (() => void) | undefined;
  let interval = 0;
  let stopped = false;
  const collector = new LiveSupplyCollector({
    codex: () => ({ accounts: [] }), grok: () => ({ quota: 'unknown', observedAt: null }),
    cost: () => ({ used: null, limit: null, currency: null }), pool: () => ({ members: [] }),
    hostCredentials: () => ({ hosts: [] }), parentHosts: () => ({ hosts: [] }),
  }, {
    directory: join(f.root, 'scheduled'), setInterval: ((fn: () => void, ms: number) => { callback = fn; interval = ms; return 1; }) as typeof setInterval,
    clearInterval: (() => { stopped = true; }) as typeof clearInterval,
  });
  expect((await collector.start()).sequence).toBe(1);
  expect(interval).toBe(60_000);
  callback?.();
  await collector.tick();
  expect(collector.read()?.sequence).toBe(2);
  collector.stop();
  expect(stopped).toBe(true);
});
