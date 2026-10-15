import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSource } from '../intake-plane/intake-sources.js';
import { listSchedules, openSchedulesDb } from './schedule-registry.js';
import { startWatchDefaultScheduler } from './watch-default-scheduler.js';

test('daemon executes only user watch jobs at local scheduled minutes and stops when disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-tick-'));
  let clock = new Date('2026-10-05T07:00:00+09:00');
  let tick: () => void = () => {};
  let enabled = true;
  const registry = openSchedulesDb(':memory:');
  const fired: string[] = [];
  try {
    const scheduler = startWatchDefaultScheduler({
      root, enabled: () => enabled, now: () => clock, timeZone: 'Asia/Seoul', openDb: () => registry,
      collect: async () => { fired.push('collect'); }, brief: async () => { fired.push('brief'); return { sent: true }; },
      setInterval: (fn) => { tick = fn; return { unref() {} } as ReturnType<typeof setInterval>; },
    });
    await scheduler.tickNow();
    expect(fired).toEqual([]);
    expect(listSchedules(registry, { source: 'watch-default' })).toEqual([]);
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    await scheduler.tickNow();
    await scheduler.tickNow();
    expect(fired).toEqual(['collect']);
    expect(listSchedules(registry, { source: 'watch-default' }).map(row => row.run_via)).toEqual(['daemon', 'daemon']);
    clock = new Date('2026-10-05T08:30:00+09:00');
    await scheduler.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
    expect(JSON.parse(readFileSync(join(root, 'intake', 'watch-default-last-run.json'), 'utf8'))).toEqual({ 'watch-collect': '2026-10-05', 'watch-brief': '2026-10-05' });
    const restarted = startWatchDefaultScheduler({
      root, enabled: () => enabled, now: () => clock, timeZone: 'Asia/Seoul', openDb: () => registry,
      collect: async () => { fired.push('collect-again'); }, brief: async () => { fired.push('brief-again'); return { sent: true }; },
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    });
    await restarted.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
    restarted.stop();
    enabled = false;
    clock = new Date('2026-10-06T07:00:00+09:00');
    await scheduler.tickNow();
    tick();
    expect(listSchedules(registry, { source: 'watch-default' })).toEqual([]);
    expect(fired).toEqual(['collect', 'brief']);
    scheduler.stop();
    await scheduler.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

test('startup catches up both missed watch jobs once, including across restart and the next day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-catchup-'));
  const registry = openSchedulesDb(':memory:');
  let clock = new Date('2026-10-05T09:15:00+09:00');
  const fired: string[] = [];
  let bootBriefed!: () => void;
  const bootBrief = new Promise<void>(resolve => { bootBriefed = resolve; });
  try {
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    const common = {
      root, openDb: () => registry, now: () => clock, timeZone: 'Asia/Seoul',
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    };
    const scheduler = startWatchDefaultScheduler({
      ...common,
      collect: async () => { fired.push('collect'); },
      brief: async () => { fired.push('brief'); bootBriefed(); return { sent: true }; },
    });
    await bootBrief;
    await scheduler.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
    expect(JSON.parse(readFileSync(join(root, 'intake', 'watch-default-last-run.json'), 'utf8')))
      .toEqual({ 'watch-collect': '2026-10-05', 'watch-brief': '2026-10-05' });
    await scheduler.tickNow();
    scheduler.stop();

    clock = new Date('2026-10-05T12:00:00+09:00');
    const restarted = startWatchDefaultScheduler({
      ...common,
      collect: async () => { fired.push('collect'); },
      brief: async () => { fired.push('brief'); return { sent: true }; },
    });
    await restarted.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
    clock = new Date('2026-10-06T06:59:00+09:00');
    await restarted.tickNow();
    expect(fired).toEqual(['collect', 'brief']);
    clock = new Date('2026-10-06T07:01:00+09:00');
    await restarted.tickNow();
    expect(fired).toEqual(['collect', 'brief', 'collect']);
    clock = new Date('2026-10-06T08:31:00+09:00');
    await restarted.tickNow();
    await restarted.tickNow();
    expect(fired).toEqual(['collect', 'brief', 'collect', 'brief']);
    restarted.stop();
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

test('registry inventory and last-run ledger follow the same non-KST local day', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-non-kst-'));
  const registry = openSchedulesDb(':memory:');
  let clock = new Date('2026-10-06T00:05:00Z'); // October 5 at 17:05 in Los Angeles.
  let inventoryCalls = 0;
  const fired: string[] = [];
  let bootBriefed!: () => void;
  const bootBrief = new Promise<void>(resolve => { bootBriefed = resolve; });
  try {
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    const scheduler = startWatchDefaultScheduler({
      root, timeZone: 'America/Los_Angeles', now: () => clock,
      openDb: () => { inventoryCalls++; return registry; },
      collect: async () => { fired.push('collect'); },
      brief: async () => { fired.push('brief'); bootBriefed(); return { sent: true }; },
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    });
    await bootBrief;
    await scheduler.tickNow();
    expect(inventoryCalls).toBe(1);
    expect(fired).toEqual(['collect', 'brief']);
    expect(JSON.parse(readFileSync(join(root, 'intake', 'watch-default-last-run.json'), 'utf8')))
      .toEqual({ 'watch-collect': '2026-10-05', 'watch-brief': '2026-10-05' });
    clock = new Date('2026-10-06T06:59:00Z'); // Still October 5 in Los Angeles.
    await scheduler.tickNow();
    expect(inventoryCalls).toBe(1);
    clock = new Date('2026-10-06T07:01:00Z'); // October 6 at 00:01 locally; before both jobs.
    await scheduler.tickNow();
    expect(inventoryCalls).toBe(2);
    expect(fired).toEqual(['collect', 'brief']);
    clock = new Date('2026-10-06T15:40:00Z'); // October 6 at 08:40 locally.
    await scheduler.tickNow();
    expect(fired).toEqual(['collect', 'brief', 'collect', 'brief']);
    expect(JSON.parse(readFileSync(join(root, 'intake', 'watch-default-last-run.json'), 'utf8')))
      .toEqual({ 'watch-collect': '2026-10-06', 'watch-brief': '2026-10-06' });
    scheduler.stop();
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unsent briefing stays eligible for same-day retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-retry-'));
  const registry = openSchedulesDb(':memory:');
  try {
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    let attempts = 0;
    let clock = new Date('2026-10-05T08:30:00+09:00');
    const scheduler = startWatchDefaultScheduler({
      root, openDb: () => registry, now: () => clock, timeZone: 'Asia/Seoul',
      brief: async () => ({ sent: ++attempts > 1 }), collect: async () => {},
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    clock = new Date('2026-10-05T08:31:00+09:00');
    await scheduler.tickNow();
    expect(attempts).toBe(2);
    await scheduler.tickNow();
    expect(attempts).toBe(2);
    scheduler.stop();
  } finally { registry.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a registry failure does not skip the scheduled collect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-registry-fail-'));
  try {
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    const fired: string[] = [];
    const scheduler = startWatchDefaultScheduler({
      root, openDb: () => { throw new Error('registry locked'); }, now: () => new Date('2026-10-05T07:00:00+09:00'), timeZone: 'Asia/Seoul',
      collect: async () => { fired.push('collect'); }, brief: async () => ({ sent: true }),
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    });
    await scheduler.tickNow();
    expect(fired).toEqual(['collect']);
    scheduler.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
