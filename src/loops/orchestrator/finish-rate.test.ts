import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { finishAdvice, measureFinish, type MeasureFinishDeps } from './finish-rate.js';

const now = new Date('2026-10-04T16:00:00Z');
const start = (i: number, startedAt = '2026-10-04T15:00:00Z') => ({ runId: `run-${i}`, startedAt });
const pr = (i: number, extra: Record<string, unknown> = {}) => ({ number: i, headRefName: `self-impl/run-${i}`, ...extra });
const deps = (launched: number, landed: number, drafts: unknown[], open: unknown[]): MeasureFinishDeps => ({
  listStarts: () => ({ starts: [...Array.from({ length: launched }, (_, i) => start(i)), start(999, '2026-10-03T15:59:59Z')], unreadable: [] }),
  runGh: args => {
    if (args.includes('merged')) return JSON.stringify([...Array.from({ length: landed }, (_, i) => pr(i, { mergedAt: '2026-10-04T15:00:00Z' })), pr(999, { headRefName: 'feature/unrelated', mergedAt: '2026-10-04T15:00:00Z' }), pr(1000, { mergedAt: '2026-10-03T15:59:59Z' })]);
    return JSON.stringify(args.includes('--draft') ? drafts : open);
  },
});

test('40 launched, 12 landed, 25 non-superseded stale drafts and 30/40 known conflicting', () => {
  const drafts = Array.from({ length: 30 }, (_, i) => pr(i, { createdAt: '2026-10-03T15:59:59Z', labels: i < 5 ? [{ name: 'elanous:superseded' }] : [] }));
  const open = Array.from({ length: 50 }, (_, i) => pr(i, { mergeable: i < 30 ? 'CONFLICTING' : i < 40 ? 'MERGEABLE' : 'UNKNOWN' }));
  const metrics = measureFinish(deps(40, 12, drafts, open), now);
  expect(metrics).toMatchObject({ launched: 40, landed: 12, landingRate: 0.3, staleDrafts: 25, conflictRatio: 0.75, unknownMergeable: 10, reasons: {} });
  expect(finishAdvice(metrics, 20)).toMatchObject({ state: 'backlogged', finishSlots: 6, launchSlots: 14 });
});

test('healthy finish keeps two slots; threshold comparisons are strict and backlog scales', () => {
  const drafts = Array.from({ length: 3 }, (_, i) => pr(i, { createdAt: '2026-10-03T15:00:00Z', labels: [] }));
  const open = Array.from({ length: 20 }, (_, i) => pr(i, { mergeable: i === 0 ? 'CONFLICTING' : 'MERGEABLE' }));
  const metrics = measureFinish(deps(20, 15, drafts, open), now);
  expect(metrics).toMatchObject({ landingRate: 0.75, staleDrafts: 3, conflictRatio: 0.05, unknownMergeable: 0 });
  expect(finishAdvice(metrics, 20)).toMatchObject({ state: 'healthy', finishSlots: 2, launchSlots: 18 });
  expect(finishAdvice(metrics, 20, { landingRate: 0.75, staleDrafts: 3, conflictRatio: 0.05 }).state).toBe('healthy');
  expect(finishAdvice({ ...metrics, staleDrafts: 21 }, 30)).toMatchObject({ state: 'backlogged', finishSlots: 9, launchSlots: 21 });
});

test('failed landed collector yields null with reason, not zero; other collectors still run', () => {
  const source = deps(20, 15, [], [pr(1, { mergeable: 'MERGEABLE' })]);
  const metrics = measureFinish({ ...source, runGh: args => {
    if (args.includes('merged')) throw new Error('merged PR query failed');
    return source.runGh!(args);
  } }, now);
  expect(metrics).toMatchObject({ launched: 20, landed: null, landingRate: null, staleDrafts: 0, conflictRatio: 0 });
  expect(metrics.reasons.landed).toBe('merged PR query failed');
  expect(metrics.reasons.landingRate).toContain('merged PR query failed');
  expect(finishAdvice(metrics, 20)).toMatchObject({ state: 'unknown', finishSlots: 6, launchSlots: 14 });
});

test('read failures are independent and a truncated PR list never masquerades as a complete count', () => {
  const source = deps(20, 15, [], [pr(1, { mergeable: 'MERGEABLE' })]);
  const metrics = measureFinish({ ...source, listStarts: () => { throw new Error('ledger unreadable'); }, runGh: args => {
    if (args.includes('--draft')) throw new Error('draft query failed');
    if (args.includes('merged')) return source.runGh!(args);
    return JSON.stringify(Array.from({ length: 1000 }, (_, i) => pr(i, { mergeable: 'MERGEABLE' })));
  } }, now);
  expect(metrics).toMatchObject({ launched: null, landed: 15, landingRate: null, staleDrafts: null, conflictRatio: null, unknownMergeable: null });
  expect(metrics.reasons).toMatchObject({ launched: 'ledger unreadable', staleDrafts: 'draft query failed', conflictRatio: 'incomplete or invalid PR observation' });
  expect(finishAdvice(metrics, 20)).toMatchObject({ state: 'unknown', finishSlots: 6, launchSlots: 14 });
});

test('zero denominator and no known mergeability remain unknown', () => {
  const metrics = measureFinish(deps(0, 0, [], [pr(1, { mergeable: 'UNKNOWN' })]), now);
  expect(metrics.landingRate).toBeNull();
  expect(metrics.reasons.landingRate).toContain('no harness runs');
  expect(metrics.conflictRatio).toBeNull();
  expect(metrics.unknownMergeable).toBe(1);
  expect(finishAdvice(metrics, 3)).toMatchObject({ state: 'unknown', finishSlots: 3, launchSlots: 0 });
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const partial = measureFinish({ ...deps(0, 0, [], [pr(1, { mergeable: 'UNKNOWN' })]),
      listStarts: () => ({ starts: [], unreadable: [{ runId: 'run-no-start', reason: 'pod-ledger-incomplete' }] }) }, now);
    expect(partial).toMatchObject({ launched: 0, launchedUnreadable: 1, landingRate: null });
    expect(partial.reasons.launched).toContain('하한값');
    expect(partial.reasons.landingRate).toBe('launched lower bound is zero — launch population unknown: 1개 원장 시작 줄 없음(하한값)');
    expect(finishAdvice(partial, 3).reasons).toContain(partial.reasons.launched!);
    const failedGh = measureFinish({ listStarts: () => ({ starts: [start(1)], unreadable: [{ runId: 'run-no-start', reason: 'pod-ledger-incomplete' }] }),
      runGh: () => { throw new Error('gh offline'); } }, now);
    expect(failedGh).toMatchObject({ launched: 1, launchedUnreadable: 1, landed: null, landingRate: null, staleDrafts: null, conflictRatio: null });
    expect(failedGh.reasons).toMatchObject({ launched: '1개 원장 시작 줄 없음(하한값)', landed: 'gh offline', landingRate: 'landed unavailable: gh offline' });
  } finally {
    log.mockRestore();
  }
});

test('recent startless ledger reports a lower bound while an old one is excluded', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-')));
  const dir = join(root, 'run-ledger');
  mkdirSync(dir);
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const ids = [
    'run-00000000-0000-4000-8000-000000000001',
    'run-00000000-0000-4000-8000-000000000002',
    'run-00000000-0000-4000-8000-000000000003',
    'run-00000000-0000-4000-8000-000000000004',
  ];
  const write = (id: string, event: string, timestamp?: string) => {
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, JSON.stringify(event === 'start'
      ? { runId: id, event, timestamp, data: {} }
      : { runId: id, event: 'pod-ledger-incomplete', data: { job: 'si-termination-oom-93677dc6', reason: 'child-ledger-missing' } }) + '\n');
    return path;
  };
  try {
    write(ids[0]!, 'start', '2026-10-04T14:00:00Z');
    write(ids[1]!, 'start', '2026-10-04T15:00:00Z');
    write(ids[2]!, 'pod-ledger-incomplete');
    const old = write(ids[3]!, 'pod-ledger-incomplete');
    utimesSync(old, new Date('2026-10-02T16:00:00Z'), new Date('2026-10-02T16:00:00Z'));
    for (const id of ids.slice(0, 3)) {
      const path = join(dir, `${id}.jsonl`);
      utimesSync(path, now, now);
    }
    const runGh = deps(0, 1, [], [pr(1, { mergeable: 'MERGEABLE' })]).runGh;
    const metrics = measureFinish({ runGh, ledgerTargets: [{ name: 'isolated', dbPath: join(root, 'logs', 'logs.db') }] }, now);
    expect(metrics.launched).toBe(2);
    expect(metrics.launchedUnreadable).toBe(1);
    expect(metrics.landingRate).toBe(0.5);
    expect(metrics.reasons.launched).toContain('1개 원장 시작 줄 없음(하한값)');
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 1, launched: 2, childLedgers: 0, unreadable: 1,
    });
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-ledger-unreadable', {
      count: 1, sample: [{ runId: ids[2], reason: 'pod-ledger-incomplete' }],
    });
    expect(finishAdvice(metrics, 20)).toMatchObject({ state: 'healthy', reasons: [metrics.reasons.launched!] });

    const cleanRoot = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-clean-')));
    try {
      mkdirSync(join(cleanRoot, 'run-ledger'));
      for (const id of ids.slice(0, 2)) {
        const path = join(cleanRoot, 'run-ledger', `${id}.jsonl`);
        writeFileSync(path, JSON.stringify({ runId: id, event: 'start', timestamp: '2026-10-04T15:00:00Z', data: {} }) + '\n');
        utimesSync(path, now, now);
      }
      log.mockClear();
      const clean = measureFinish({ runGh, ledgerTargets: [{ name: 'clean', dbPath: join(cleanRoot, 'logs', 'logs.db') }] }, now);
      expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
        directories: 1, launched: 2, childLedgers: 0, unreadable: 0,
      });
      expect(clean.launched).toBe(2);
      expect(clean).not.toHaveProperty('launchedUnreadable');
      expect(clean.reasons.launched).toBeUndefined();
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unreadable directory aliases count once after realpath resolution', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-unreadable-')));
  const ledger = join(root, 'unreadable', 'run-ledger');
  mkdirSync(join(root, 'unreadable'));
  writeFileSync(ledger, 'not a directory');
  symlinkSync(join(root, 'unreadable'), join(root, 'alias'));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const targets = ['unreadable', 'alias'].map(name => ({ name, dbPath: join(root, name, 'logs', 'logs.db') }));
    const metrics = measureFinish({ ledgerTargets: targets, runGh: () => '[]' }, now);
    expect(metrics).toMatchObject({ launched: 0, landed: 0, landingRate: null });
    expect(metrics.reasons.launched).toBe('원장 폴더 1개 못 읽음(하한값)');
    expect(metrics.reasons.landingRate).toBe('launched lower bound is zero — launch population unknown: 원장 폴더 1개 못 읽음(하한값)');
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 1, launched: 0, childLedgers: 0, unreadable: 0,
    });
  } finally {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('federated launch population deduplicates runs and child ledgers and refuses over-100% rates', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-federated-')));
  const directories = ['prod', 'test-axon', 'test-temp'].map(name => {
    const dir = join(root, name, 'run-ledger');
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  });
  const [prod, axon, temp] = directories as [string, string, string];
  const id = (i: number) => `run-00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const write = (dir: string, i: number, event: string) => {
    const path = join(dir, `${id(i)}.jsonl`);
    writeFileSync(path, JSON.stringify({ runId: id(i), event, timestamp: now.toISOString(), data: {} }) + '\n');
    utimesSync(path, now, now);
  };
  const targets = directories.map((dir, i) => ({ name: `seat-${i}`, dbPath: join(dir, '..', 'logs', 'logs.db') }));
  const alias = join(root, 'same-axon');
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    write(prod, 1, 'start'); write(prod, 2, 'start');
    write(axon, 3, 'start'); write(axon, 4, 'start'); write(axon, 5, 'start');
    write(temp, 6, 'start'); write(temp, 3, 'start');
    write(axon, 7, 'pod-child-run'); write(temp, 8, 'pod-child-run');
    write(prod, 9, 'pod-ledger-incomplete');
    symlinkSync(join(root, 'test-axon'), alias);
    targets.push({ name: 'alias-axon', dbPath: join(alias, 'logs', 'logs.db') });
    const runGh = (landed: number): MeasureFinishDeps['runGh'] => args => JSON.stringify(
      args.includes('merged') ? Array.from({ length: landed }, (_, i) => pr(i, { mergedAt: now.toISOString() })) : [],
    );
    const four = measureFinish({ ledgerTargets: targets, runGh: runGh(4) }, now);
    expect(four).toMatchObject({ launched: 6, launchedUnreadable: 1, landed: 4 });
    expect(four.landingRate).toBeCloseTo(0.667, 2);
    expect(four.reasons.launched).toContain('1개 원장 시작 줄 없음(하한값)');
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 3, launched: 6, childLedgers: 2, unreadable: 1,
    });
    const nine = measureFinish({ ledgerTargets: targets, runGh: runGh(9) }, now);
    expect(nine).toMatchObject({ launched: 6, launchedUnreadable: 1, landed: 9, landingRate: null });
    expect(nine.reasons.landingRate).toBe('landed exceeds launched — population mismatch (launched=6, landed=9)');

    const partial = measureFinish({ ledgerTargets: [...targets, { name: 'missing', dbPath: join(root, 'missing', 'logs', 'logs.db') }], runGh: runGh(4) }, now);
    expect(partial).toMatchObject({ launched: 6, launchedUnreadable: 1, landed: 4 });
    expect(partial.reasons.launched).toContain('원장 폴더 1개 못 읽음(하한값)');
    const directoryOnly = measureFinish({ ledgerTargets: [{ name: 'prod', dbPath: join(root, 'missing', 'logs', 'logs.db') }], runGh: runGh(4) }, now);
    expect(directoryOnly).toMatchObject({ launched: 0, landed: 4, landingRate: null });
    expect(directoryOnly).not.toHaveProperty('launchedUnreadable');
    expect(directoryOnly.reasons.launched).toBe('원장 폴더 1개 못 읽음(하한값)');
    expect(directoryOnly.reasons.landingRate).toBe('launched lower bound is zero — launch population unknown: 원장 폴더 1개 못 읽음(하한값)');
    expect(finishAdvice(directoryOnly, 20).reasons).toContain(directoryOnly.reasons.launched!);
  } finally {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
