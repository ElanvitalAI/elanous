import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { acquireLockSync } from '../../storage/file-lock.js';
import { finishAdvice, finishHistoryPath, finishTrend, measureFinish, recordFinishHistory, type FinishMetrics, type MeasureFinishDeps } from './finish-rate.js';

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
    // ORCH-LIVE-1008 ①: a `pod-ledger-incomplete` ledger is a launched Pod run whose result never came back — it counts
    // as launched (no longer «unreadable»), and the incomplete count is observed by reason.
    expect(metrics.launched).toBe(3);
    expect(metrics.launchedUnreadable).toBeUndefined();
    expect(metrics.launchedIncomplete).toBe(1);
    expect(metrics.landingRate).toBeCloseTo(1 / 3);
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 1, launched: 3, launchOnly: 0, childLedgers: 0, unreadable: 0, incomplete: 1,
    });
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-ledger-incomplete', {
      count: 1, byReason: { 'child-ledger-missing': 1 }, sample: [{ runId: ids[2], reason: 'child-ledger-missing' }],
    });
    expect(log.mock.calls.some(([, event]) => event === 'finish-ledger-unreadable')).toBe(false);

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
        directories: 1, launched: 2, launchOnly: 0, childLedgers: 0, unreadable: 0,
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
      directories: 1, launched: 0, launchOnly: 0, childLedgers: 0, unreadable: 0,
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
    // A ledger with neither a start nor a launch/incomplete marker stays «unreadable» (lower bound).
    write(prod, 10, 'heartbeat');
    symlinkSync(join(root, 'test-axon'), alias);
    targets.push({ name: 'alias-axon', dbPath: join(alias, 'logs', 'logs.db') });
    const runGh = (landed: number): MeasureFinishDeps['runGh'] => args => JSON.stringify(
      args.includes('merged') ? Array.from({ length: landed }, (_, i) => pr(i, { mergedAt: now.toISOString() })) : [],
    );
    const four = measureFinish({ ledgerTargets: targets, runGh: runGh(4) }, now);
    expect(four).toMatchObject({ launched: 7, launchedUnreadable: 1, launchedIncomplete: 1, landed: 4 });
    expect(four.landingRate).toBeCloseTo(4 / 7, 3);
    expect(four.reasons.launched).toContain('1개 원장 시작 줄 없음(하한값)');
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 3, launched: 7, launchOnly: 0, childLedgers: 2, unreadable: 1, incomplete: 1,
    });
    const nine = measureFinish({ ledgerTargets: targets, runGh: runGh(9) }, now);
    expect(nine).toMatchObject({ launched: 7, launchedUnreadable: 1, landed: 9, landingRate: null });
    expect(nine.reasons.landingRate).toBe('landed exceeds launched — population mismatch (launched=7, landed=9)');

    const partial = measureFinish({ ledgerTargets: [...targets, { name: 'missing', dbPath: join(root, 'missing', 'logs', 'logs.db') }], runGh: runGh(4) }, now);
    expect(partial).toMatchObject({ launched: 7, launchedUnreadable: 1, landed: 4 });
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

test('Pod-dispatched launch ledgers (launch-quota-policy · author-on-pod-receipt, no start) count as launches, not unreadable', () => {
  // 10-06 real ledgers: 162/400 began with launch-quota-policy and 21 with author-on-pod-receipt (no timestamp) — 447 were «unreadable».
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-launch-')));
  const dir = join(root, 'run-ledger');
  mkdirSync(dir);
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const a = 'run-00000000-0000-4000-8000-0000000000a1';
  const b = 'run-00000000-0000-4000-8000-0000000000b2';
  try {
    writeFileSync(join(dir, `${a}.jsonl`), JSON.stringify({ runId: a, event: 'launch-quota-policy', timestamp: '2026-10-04T15:30:00Z', data: {} }) + '\n');
    writeFileSync(join(dir, `${b}.jsonl`), JSON.stringify({ runId: b, event: 'author-on-pod-receipt', data: { authorOnPod: true } }) + '\n');
    utimesSync(join(dir, `${a}.jsonl`), now, now);
    utimesSync(join(dir, `${b}.jsonl`), new Date('2026-10-04T15:45:00Z'), new Date('2026-10-04T15:45:00Z'));
    const runGh = deps(0, 0, [], [pr(1, { mergeable: 'MERGEABLE' })]).runGh;
    const metrics = measureFinish({ runGh, ledgerTargets: [{ name: 'launch', dbPath: join(root, 'logs', 'logs.db') }] }, now);
    expect(metrics.launched).toBe(2);
    expect(metrics.launchedUnreadable).toBeUndefined();
    expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', {
      directories: 1, launched: 2, launchOnly: 2, childLedgers: 0, unreadable: 0,
    });
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('the same runId with a host launch record and a Pod start in two directories counts once, start time wins (ACP must-fix)', () => {
  const host = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-host-')));
  const pod = realpathSync(mkdtempSync(join(tmpdir(), 'finish-rate-pod-')));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const id = 'run-00000000-0000-4000-8000-0000000000c3';
  try {
    for (const [root, line] of [
      [host, { runId: id, event: 'launch-quota-policy', timestamp: '2026-10-03T15:00:00Z', data: {} }],
      [pod, { runId: id, event: 'start', timestamp: '2026-10-04T15:30:00Z', data: {} }],
    ] as const) {
      mkdirSync(join(root, 'run-ledger'));
      writeFileSync(join(root, 'run-ledger', `${id}.jsonl`), JSON.stringify(line) + '\n');
      utimesSync(join(root, 'run-ledger', `${id}.jsonl`), now, now);
    }
    const runGh = deps(0, 0, [], [pr(1, { mergeable: 'MERGEABLE' })]).runGh;
    for (const order of [[host, pod], [pod, host]]) {
      log.mockClear();
      const metrics = measureFinish({ runGh, ledgerTargets: order.map((root, i) => ({ name: `t${i}`, dbPath: join(root, 'logs', 'logs.db') })) }, now);
      expect(metrics.launched).toBe(1);
      expect(log).toHaveBeenCalledWith('loop.orchestrator', 'finish-launch-population', expect.objectContaining({ launched: 1, launchOnly: 0 }));
    }
  } finally { log.mockRestore(); rmSync(host, { recursive: true, force: true }); rmSync(pod, { recursive: true, force: true }); }
});

// FINISH-RATE 이력 조각(0.2.18): 추세는 다수결 · 한 시간 한 줄.
const tri = (landingRate: number | null, staleDrafts: number | null, conflictRatio: number | null) => ({ landingRate, staleDrafts, conflictRatio });
test('finishTrend: majority of compared metrics, missing values never count', () => {
  expect(finishTrend(tri(0.3, 40, 0.1), tri(0.2, 45, 0.1))).toBe('worsening');
  expect(finishTrend(tri(0.3, 40, 0.1), tri(0.4, 35, 0.2))).toBe('improving');
  expect(finishTrend(tri(0.3, 40, 0.1), tri(0.3, 40, 0.1))).toBe('flat');
  expect(finishTrend(tri(0.3, 40, 0.1), tri(0.4, 45, 0.1))).toBe('flat');
  expect(finishTrend(tri(null, null, null), tri(0.3, 40, 0.1))).toBe('unknown');
  expect(finishTrend(tri(0.3, 40, 0.1), tri(null, null, null))).toBe('unknown');
  expect(finishTrend(null, tri(0.3, 40, 0.1))).toBe('unknown');
  expect(finishTrend(tri(Number.NaN, 40, null), tri(0.1, 41, 0.9))).toBe('worsening');
});

test('recordFinishHistory writes one row per UTC hour and trends against the previous hour', () => {
  const root = mkdtempSync(join(tmpdir(), 'finish-history-'));
  const m = (landingRate: number, staleDrafts: number, conflictRatio: number): FinishMetrics => ({ launched: 10, landed: 3, landingRate, staleDrafts, conflictRatio, unknownMergeable: 0, reasons: {} });
  const lines = () => existsSync(finishHistoryPath(root)) ? readFileSync(finishHistoryPath(root), 'utf8').trimEnd().split('\n') : [];
  try {
    expect(recordFinishHistory(root, m(0.3, 40, 0.1), new Date('2026-10-05T09:00:00Z'))?.trend).toBe('unknown');
    expect(lines()).toHaveLength(1);
    expect(recordFinishHistory(root, m(0.1, 90, 0.9), new Date('2026-10-05T09:40:00Z'))).toBeNull();
    expect(lines()).toHaveLength(1);
    const second = recordFinishHistory(root, m(0.2, 45, 0.1), new Date('2026-10-05T10:05:00Z'));
    expect(lines()).toHaveLength(2);
    expect(second).toMatchObject({ hour: '2026-10-05T10', trend: 'worsening', launched: 10, landed: 3 });
    expect(JSON.parse(lines()[1]!)).toEqual(second);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordFinishHistory waits for the history lock: a peer that writes the hour while holding it leaves one row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'finish-history-lock-'));
  const path = finishHistoryPath(root);
  const mod = join(import.meta.dir, 'finish-rate.ts');
  const script = `import { recordFinishHistory } from ${JSON.stringify(mod)};
    recordFinishHistory(${JSON.stringify(root)}, { launched: 1, landed: 1, landingRate: 1, staleDrafts: 0, conflictRatio: 0, unknownMergeable: 0, reasons: {} }, new Date('2026-10-05T09:30:00Z'));`;
  mkdirSync(join(root, 'harness'), { recursive: true });
  const release = acquireLockSync(`${path}.lock`);
  let released = false;
  try {
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env } });
    await Bun.sleep(1_500);
    // Still blocked on the lock — a lock-free check-then-append would already have written its row.
    expect(child.exitCode).toBeNull();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, `${JSON.stringify({ hour: '2026-10-05T09', at: '2026-10-05T09:10:00Z', launched: 1, landed: 1, landingRate: 1, staleDrafts: 0, conflictRatio: 0, trend: 'unknown' })}\n`);
    release(); released = true;
    expect(await child.exited).toBe(0);
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  } finally {
    if (!released) release();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recordFinishHistory trends against the latest earlier hour, not the last line in the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'finish-history-order-'));
  const row = (hour: string, landingRate: number, staleDrafts: number) => JSON.stringify({ hour, at: `${hour}:00:00Z`, launched: 1, landed: 1, landingRate, staleDrafts, conflictRatio: 0.1, trend: 'unknown' });
  try {
    mkdirSync(join(root, 'harness'), { recursive: true });
    // 10시 줄 뒤에 늦게 덧붙은 9시 줄 — 11시 추세는 10시(0.5·10) 대비여야 한다(9시 0.1·90 대비면 improving).
    writeFileSync(finishHistoryPath(root), `${row('2026-10-05T10', 0.5, 10)}\n${row('2026-10-05T09', 0.1, 90)}\n`);
    const m: FinishMetrics = { launched: 1, landed: 1, landingRate: 0.4, staleDrafts: 20, conflictRatio: 0.1, unknownMergeable: 0, reasons: {} };
    expect(recordFinishHistory(root, m, new Date('2026-10-05T11:05:00Z'))?.trend).toBe('worsening');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordFinishHistory starts a new line after a partially written tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'finish-history-tail-'));
  try {
    mkdirSync(join(root, 'harness'), { recursive: true });
    writeFileSync(finishHistoryPath(root), '{"hour":"2026-10-05T08","trend":"unk');
    const m: FinishMetrics = { launched: 1, landed: 1, landingRate: 0.4, staleDrafts: 20, conflictRatio: 0.1, unknownMergeable: 0, reasons: {} };
    const written = recordFinishHistory(root, m, new Date('2026-10-05T09:05:00Z'));
    const lines = readFileSync(finishHistoryPath(root), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(written);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ORCH-LIVE-1008: a run seen as launch-only in one ledger and pod-ledger-incomplete in another is one launch with an unknown result, in either read order', () => {
  for (const order of [['host', 'pod'], ['pod', 'host']] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-incomplete-order-')));
    const now = new Date('2026-10-07T00:00:00Z');
    const id = 'run-00000000-0000-4000-8000-000000000042';
    const dirs = order.map((name) => { const dir = join(root, name, 'run-ledger'); mkdirSync(dir, { recursive: true }); return dir; });
    const event = (name: string) => name === 'host'
      ? { runId: id, event: 'author-on-pod-receipt', timestamp: '2026-10-06T20:00:00Z', data: {} }
      : { runId: id, event: 'pod-ledger-incomplete', timestamp: '2026-10-06T21:00:00Z', data: { reason: 'logs-unavailable' } };
    order.forEach((name, i) => {
      const path = join(dirs[i]!, `${id}.jsonl`);
      writeFileSync(path, JSON.stringify(event(name)) + '\n');
      utimesSync(path, now, now);
    });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const targets = dirs.map((dir, i) => ({ name: `t${i}`, dbPath: join(dir, '..', 'logs', 'logs.db') }));
      const metrics = measureFinish({ ledgerTargets: targets, runGh: () => '[]' }, now);
      expect(metrics.launched).toBe(1);
      expect(metrics.launchedIncomplete).toBe(1);
      expect(log.mock.calls.find(([, e]) => e === 'finish-ledger-incomplete')?.[2]).toMatchObject({ byReason: { 'logs-unavailable': 1 } });
    } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('ORCH-LIVE-1008: a real start beats the incomplete marker in either read order — its time is kept and nothing counts as incomplete', () => {
  for (const order of [['start', 'pod'], ['pod', 'start']] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'finish-start-order-')));
    const now = new Date('2026-10-07T00:00:00Z');
    const id = 'run-00000000-0000-4000-8000-000000000043';
    const dirs = order.map((name) => { const dir = join(root, name, 'run-ledger'); mkdirSync(dir, { recursive: true }); return dir; });
    const event = (name: string) => name === 'start'
      ? { runId: id, event: 'start', timestamp: '2026-10-06T19:00:00Z', data: {} }
      : { runId: id, event: 'pod-ledger-incomplete', timestamp: '2026-10-06T21:00:00Z', data: { reason: 'child-ledger-missing' } };
    order.forEach((name, i) => {
      const path = join(dirs[i]!, `${id}.jsonl`);
      writeFileSync(path, JSON.stringify(event(name)) + '\n');
      utimesSync(path, now, now);
    });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const targets = dirs.map((dir, i) => ({ name: `t${i}`, dbPath: join(dir, '..', 'logs', 'logs.db') }));
      const metrics = measureFinish({ ledgerTargets: targets, runGh: () => '[]' }, now);
      expect(metrics.launched).toBe(1);
      expect(metrics.launchedIncomplete).toBeUndefined();
      expect(log.mock.calls.some(([, e]) => e === 'finish-ledger-incomplete')).toBe(false);
      expect(log.mock.calls.find(([, e]) => e === 'finish-launch-population')?.[2]).not.toHaveProperty('incomplete');
    } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }
});
