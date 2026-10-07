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

test('unsent briefing stays eligible for same-day retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'watch-retry-'));
  const registry = openSchedulesDb(':memory:');
  try {
    addSource({ id: 'topic', seat: 'user', kind: 'github-query', spec: 'agent', every: '1d' }, root);
    let attempts = 0;
    const scheduler = startWatchDefaultScheduler({
      root, openDb: () => registry, now: () => new Date('2026-10-05T08:30:00+09:00'), timeZone: 'Asia/Seoul',
      brief: async () => ({ sent: ++attempts > 1 }), collect: async () => {},
      setInterval: () => ({ unref() {} } as ReturnType<typeof setInterval>),
    });
    await scheduler.tickNow();
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
