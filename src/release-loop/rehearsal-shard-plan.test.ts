import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateShardsPath, writeGateShards } from './gate-shards.js';
import { planRehearsalShards, rehearsalHostResources, type RehearsalShardPlanDeps } from './rehearsal-shard-plan.js';

const resources = { cpus: 16, freeBytes: 227e9, totalBytes: 256e9 };
const board: NonNullable<RehearsalShardPlanDeps['board']> = () => ({ v: 1, version: '0.2.23', updatedAt: new Date().toISOString(), shards: Array.from({ length: 12 }, (_, i) => ({ id: String(i), state: 'done' })) });
const deps: RehearsalShardPlanDeps = { board, resources: () => resources, readAlways: () => 'test/always.test.ts\n', resolveBase: () => 'base', select: () => ({ testFiles: Array.from({ length: 699 }, (_, i) => `test/${i}.test.ts`) }) };

test('host resources cap OS free memory with available cgroup headroom', () => {
  const gib = 1024 ** 3;
  const resources = rehearsalHostResources((path) => path.endsWith('memory.max') ? String(8 * gib) : path.endsWith('memory.current') ? String(7 * gib) : (() => { throw new Error('missing'); })());
  expect(resources.cpus).toBeGreaterThan(0);
  expect(resources.totalBytes).toBe(8 * gib);
  expect(resources.freeBytes).toBeLessThanOrEqual(gib);
  expect(rehearsalHostResources(() => 'max').totalBytes).toBeGreaterThan(0);
});

test('persisted gate shard board is read from the release ledger, not inferred from a fixture count', () => {
  const root = mkdtempSync(join(tmpdir(), 'rehearsal-shard-board-'));
  try {
    writeGateShards(gateShardsPath('0.2.23', root), {
      v: 1, version: '0.2.23', updatedAt: new Date().toISOString(),
      shards: Array.from({ length: 6 }, (_, i) => ({ id: `shard-${i}`, state: 'done' })),
    });
    const plan = planRehearsalShards('0.2.23', root, '/checkout', { ...deps, board: undefined });
    expect(plan.gatePlanShards).toBe(6);
    expect(plan.shards).toBe(6);
    expect(plan.unmeasured).toContain('importer coverage not reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('split, retry and tail observations do not increase the persisted root shard plan', () => {
  const rows = ['pod-0', 'pod-1', 'pod-0-0', 'pod-0-retry', 'pod-1-tail'];
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', {
    ...deps, board: () => ({ v: 1, version: '0.2.23', updatedAt: new Date().toISOString(),
      shards: rows.map(id => ({ id, state: 'done' })) }),
  });
  expect(plan.gatePlanShards).toBe(2);
  expect(plan.shards).toBe(2);
});

test('selection uses the same base and always-include inputs as light RC; board count is only a candidate, not proof', () => {
  const seen: unknown[] = [];
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, select: (cwd, options) => { seen.push([cwd, options]); return deps.select!(cwd, options); } });
  expect(seen).toEqual([['/checkout', { base: 'base', alwaysInclude: ['test/always.test.ts'], includeImporterTests: true }]]);
  expect(plan).toMatchObject({ shards: 12, testFiles: 699, resources, gatePlanShards: 12 });
  expect(plan.unmeasured).toContain('importer coverage not reported');
});

test('small incomplete selection, missing board and invalid host remain unmeasured', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, board: () => null, resources: () => ({ ...resources, cpus: 0 }), select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 3 }) });
  expect(plan).toMatchObject({ shards: 1, testFiles: 1, gatePlanShards: null });
  expect(plan.unmeasured).toContain('importer tests not run: 3');
  expect(plan.unmeasured).toContain('persisted gate shard plan unavailable');
  expect(plan.unmeasured).toContain('host resources unavailable');
  const missingResources = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, resources: () => ({ ...resources, cpus: 0 }) });
  expect(missingResources.shards).toBe(4);
});

test('board and host capacity cap the candidate; missing board preserves the RC default as a candidate only', () => {
  const capped = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, resources: () => ({ ...resources, cpus: 3 }) });
  expect(capped.shards).toBe(3);
  const noBoard = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, board: () => null });
  expect(noBoard.shards).toBe(4);
  expect(noBoard.unmeasured).toContain('persisted gate shard plan unavailable');
  const incomplete = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, select: () => ({ testFiles: ['test/a.test.ts'], routeLookupFailures: ['missing route'], unverified: ['missing caller'] }) });
  expect(incomplete.shards).toBe(1);
  expect(incomplete.unmeasured).toContain('route lookup failed: 1');
  expect(incomplete.unmeasured).toContain('unverified scope: 1');
});

test('memory budget changes the selected count while missing measurements stay unmeasured', () => {
  const gib = 1024 ** 3;
  const complete = { ...deps, select: () => ({ testFiles: Array.from({ length: 36 }, (_, i) => `test/${i}.test.ts`), unrunImporterTotal: 0 }) };
  const plan = (freeBytes: number) => planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...complete, resources: () => ({ cpus: 16, totalBytes: 256 * gib, freeBytes }) });
  expect(plan(227 * gib)).toMatchObject({ shards: 12, testFiles: 36, capacity: { memoryShards: 113, requiredBytes: 25 * gib } });
  expect(plan(7 * gib)).toMatchObject({ shards: 3, testFiles: 36, capacity: { memoryShards: 3, requiredBytes: 7 * gib } });
  expect(plan(1)).toMatchObject({ shards: 1, testFiles: 36, capacity: { memoryShards: 0, requiredBytes: 3 * gib } });
  expect(plan(1).unmeasured).toContain('host memory insufficient');
  expect(plan(227 * gib).unmeasured).toContain('selected file memory not measured');
});

test('remote candidate keeps host capacity provisional until the RC measures that host', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, remoteGate: true,
    select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 600]]),
    resources: () => ({ cpus: 0, freeBytes: 0, totalBytes: 0 }),
  });
  expect(plan).toMatchObject({ shards: 1, remoteCapacityPending: true, planningGaps: [] });
  expect(plan.unmeasured).toContain('remote gate host resources unmeasured before RC');
});

test('one local shard with hundreds of measured files is still workload-unmeasured', () => {
  const files = Array.from({ length: 300 }, (_, index) => `test/${index}.test.ts`);
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
    board: () => ({ v: 1, version: '0.2.23', updatedAt: new Date().toISOString(), shards: [{ id: '0', state: 'done' }] }),
    select: () => ({ testFiles: files, unrunImporterTotal: 0 }),
    fileMemory: () => new Map(files.map(file => [file, 600])),
  });
  expect(plan).toMatchObject({ shards: 1, capacity: { measuredFiles: 300 } });
  expect(plan.unmeasured).toContain('local gate shard workload sufficiency not measured');
});

test('measured peak memory of the selected files raises the per-shard requirement', () => {
  const gib = 1024 ** 3;
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
    select: () => ({ testFiles: ['test/a.test.ts', 'test/b.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 6_000], ['test/b.test.ts', 500]]),
    resources: () => ({ cpus: 16, freeBytes: 9 * gib, totalBytes: 16 * gib }),
  });
  expect(plan).toMatchObject({ shards: 1, testFiles: 2, capacity: { measuredFiles: 2, peakFileBytes: 6_000_000_000, bytesPerShard: 6_000_000_000, memoryShards: 1 } });
  expect(plan.unmeasured).toContain('local gate shard workload sufficiency not measured');
  const tooSmall = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
    select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 6_000]]),
    resources: () => ({ cpus: 16, freeBytes: 4 * gib, totalBytes: 16 * gib }),
  });
  expect(tooSmall.shards).toBe(1);
  expect(tooSmall.unmeasured).toContain('selected file peak exceeds host memory');
});

test('default planner reads selected-file peak memory from the checkout measurement, not the calling tree', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'rehearsal-shard-measured-'));
  try {
    const path = join(checkout, 'docs/measurements');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'td1-whole-gate-mechanical-2026-10-01.tsv'), 'file\trss_mb\ntest/a.test.ts\t6000\ntest/b.test.ts\t500\n');
    const gib = 1024 ** 3;
    const plan = planRehearsalShards('0.2.23', '/ledger', checkout, { ...deps,
      select: () => ({ testFiles: ['test/a.test.ts', 'test/b.test.ts'], unrunImporterTotal: 0 }),
      resources: () => ({ cpus: 16, freeBytes: 9 * gib, totalBytes: 16 * gib }),
    });
    expect(plan).toMatchObject({ shards: 1, testFiles: 2, capacity: { measuredFiles: 2, peakFileBytes: 6_000_000_000 } });
    expect(plan.unmeasured).toContain('measurement revision not verified');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('dated RSS remains measured only while selected test content matches its source revision', () => {
  const checkout = mkdtempSync(join(tmpdir(), 'rehearsal-shard-revision-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    expect(result.status).toBe(0);
  };
  try {
    mkdirSync(join(checkout, 'docs/measurements'), { recursive: true });
    mkdirSync(join(checkout, 'test'), { recursive: true });
    mkdirSync(join(checkout, 'src'), { recursive: true });
    writeFileSync(join(checkout, 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv'), 'file\trss_mb\ntest/a.test.ts\t600\ntest/b.test.ts\t700\n');
    writeFileSync(join(checkout, 'test/a.test.ts'), 'import "../src/helper"; test one\n');
    writeFileSync(join(checkout, 'src/helper.ts'), 'export const value = 1;\n');
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'measurement');
    const plan = (file = 'test/a.test.ts') => planRehearsalShards('0.2.23', '/ledger', checkout, { ...deps,
      select: () => ({ testFiles: [file], unrunImporterTotal: 0 }),
    });
    expect(plan().unmeasured).toContain('local gate shard workload sufficiency not measured');
    writeFileSync(join(checkout, 'test/a.test.ts'), 'test dirty\n');
    expect(plan().unmeasured).toContain('measurement revision not verified');
    git('checkout', '--', 'test/a.test.ts');
    writeFileSync(join(checkout, 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv'), 'file\trss_mb\ntest/a.test.ts\t1\ntest/b.test.ts\t700\n');
    expect(plan().unmeasured).toContain('measurement revision not verified');
    git('checkout', '--', 'docs/measurements/td1-whole-gate-mechanical-2026-10-01.tsv');
    writeFileSync(join(checkout, 'test/b.test.ts'), 'test untracked\n');
    expect(plan('test/b.test.ts').unmeasured).toContain('measurement revision not verified');
    rmSync(join(checkout, 'test/b.test.ts'));
    writeFileSync(join(checkout, 'src/helper.ts'), 'export const value = 2;\n');
    expect(plan().unmeasured).toContain('measurement revision not verified');
    git('checkout', '--', 'src/helper.ts');
    writeFileSync(join(checkout, 'test/a.test.ts'), 'test changed\n');
    git('add', 'test/a.test.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'changed test');
    expect(plan().unmeasured).toContain('measurement revision not verified');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('zero RSS is missing evidence even when all selected names occur in the table', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
    select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 0 }),
    fileMemory: () => new Map([['test/a.test.ts', 0]]),
  });
  expect(plan.capacity).toMatchObject({ measuredFiles: 0, peakFileBytes: null });
  expect(plan.unmeasured).toContain('selected file memory not measured: 1/1');
});

test('invalid memory readings are unknown capacity, not an inferred sufficient slot', () => {
  for (const freeBytes of [-1, Number.NaN, 257e9]) {
    const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
      resources: () => ({ cpus: 16, freeBytes, totalBytes: 256e9 }),
    });
    expect(plan.capacity).toMatchObject({ memoryShards: null });
    expect(plan.unmeasured).toContain('host resources unavailable');
  }
});

test('selection reports caller overflow separately from importer coverage', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps,
    select: () => ({ testFiles: ['test/a.test.ts'], unrunImporterTotal: 0, callerTestsOverflow: ['test/b.test.ts'] }),
  });
  expect(plan.shards).toBe(1);
  expect(plan.unmeasured).toContain('caller tests overflow: 1');
});

test('skipped gate selection remains unmeasured even when a file list is present', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, select: () => ({ testFiles: ['test/a.test.ts'], skipTestStep: true }) });
  expect(plan.unmeasured).toContain('gate test step skipped');
});

test('a duplicated shard board is not accepted as a persisted plan', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, board: () => ({ v: 1, version: '0.2.23', updatedAt: new Date().toISOString(), shards: [{ id: 'same', state: 'done' }, { id: 'same', state: 'done' }] }) });
  expect(plan.gatePlanShards).toBeNull();
  expect(plan.unmeasured).toContain('persisted gate shard plan unavailable');
});

test('unavailable host resource probe stays unmeasured with an explicitly unknown capacity', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, resources: () => { throw new Error('probe offline'); } });
  expect(plan.resources).toEqual({ cpus: 0, freeBytes: 0, totalBytes: 0 });
  expect(plan.unmeasured).toContain('probe offline');
  expect(plan.shards).toBe(4);
});

test('a board read error remains unmeasured without suppressing the RC attempt', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, board: () => { throw new Error('permission denied'); } });
  expect(plan.gatePlanShards).toBeNull();
  expect(plan.unmeasured).toContain('permission denied');
  expect(plan.shards).toBe(4);
});

test('a selection error is recorded instead of treating the file count as zero', () => {
  const plan = planRehearsalShards('0.2.23', '/ledger', '/checkout', { ...deps, resolveBase: () => { throw new Error('no previous cut'); } });
  expect(plan.testFiles).toBeNull();
  expect(plan.shards).toBe(4);
  expect(plan.unmeasured).toContain('no previous cut');
});
