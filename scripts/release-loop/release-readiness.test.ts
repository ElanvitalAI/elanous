import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateImageReadinessSignalPath, readGateImageReadinessSignal, releaseReadiness, waitForGateImageT60,
  type ReleaseReadinessDeps } from './release-readiness.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { setSchedule } from '../../src/release-loop/release-schedule.js';
import { addItem, listChecklist } from '../../src/release-loop/checklist.js';
import { debug } from '../../src/debug/log.js';
import { spyOn } from 'bun:test';
import { parse as yaml } from 'yaml';

const version = '0.2.6';
const clear = { ok: true, red: [], undecided: [], blocked: [], moved: [], knownIssues: [] };
const blocked = { ...clear, ok: false, red: ['K13'] };

function fixture(run: (dir: string, deps: ReleaseReadinessDeps, write: (name: string, value: unknown) => void) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'release-readiness-'));
  const dir = join(root, 'release', version);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  try { run(dir, { ledgerRoot: root, checklist: () => clear }, write); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('publishedAt takes precedence over a live lock and checklist without calling the gate', () => fixture((_dir, deps, write) => {
  write('release.json', { version, publishedAt: '2026-09-30T10:00:00Z' });
  write('run.lock', { pid: process.pid });
  expect(releaseReadiness(version, { ...deps, checklist: () => { throw new Error('not reached'); } })).toEqual({
    ready: false, reason: 'already-published', details: '2026-09-30T10:00:00Z',
  });
}));

test('a prepared record without publishedAt and a live PID prevent the checklist', () => fixture((_dir, deps, write) => {
  write('release.json', { version, preparedAt: 'now' });
  write('run.lock', { pid: process.pid });
  expect(releaseReadiness(version, { ...deps, checklist: () => { throw new Error('not reached'); } })).toEqual({
    ready: false, reason: 'already-running', details: String(process.pid),
  });
}));

test('missing lock, dead PID and malformed PID are absent; checklist determines readiness', () => fixture((dir, deps, write) => {
  expect(releaseReadiness(version, deps)).toEqual({ ready: true, reason: 'ready', details: clear });
  expect(existsSync(join(deps.ledgerRoot!, 'release/features.sqlite'))).toBe(false);
  write('run.lock', { pid: 12345 });
  expect(releaseReadiness(version, { ...deps, isPidAlive: () => false })).toEqual({ ready: true, reason: 'ready', details: clear });
  for (const pid of [0, -1, '12345', 1.5, null]) {
    write('run.lock', { pid });
    expect(releaseReadiness(version, { ...deps, isPidAlive: () => { throw new Error('invalid PID probed'); } })).toEqual({ ready: true, reason: 'ready', details: clear });
  }
  for (const value of ['not json', 'null']) {
    writeFileSync(join(dir, 'run.lock'), value);
    expect(releaseReadiness(version, deps)).toEqual({ ready: true, reason: 'ready', details: clear });
  }
}));

test('checklist-blocked retains the full gate result after an absent lock', () => fixture((_dir, deps) => {
  expect(releaseReadiness(version, { ...deps, checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
}));

test('version rejects path traversal before reading the ledger', () => fixture((_dir, deps) => {
  expect(() => releaseReadiness('../0.2.6', deps)).toThrow('release version must be x.y.z');
}));

test('주입 시계가 컷 전이면 before-cut · 정확히 컷 시각이면 기존 체크리스트 판정', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    setSchedule(version, { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'OP');
    const early = { ...deps, now: () => new Date('2026-10-02T22:59:00Z'), checklist: () => { throw new Error('gate reached before cut'); } };
    expect(releaseReadiness(version, early)).toEqual({ ready: false, reason: 'before-cut', details: 'before-cut (10-03(토) 08:00 KST)' });
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-held', expect.objectContaining({
      version, cutAt: '2026-10-02T23:00:00.000Z', landBy: '2026-10-02T21:30:00.000Z', eta: '2026-10-02T23:00:00.000Z',
      holdReason: 'cut-time-constraint',
    }));
    expect(releaseReadiness(version, { ...deps, allowBeforeCut: true, now: () => new Date('2026-10-02T22:59:00Z') }))
      .toEqual({ ready: true, reason: 'ready', details: clear });
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-planned', expect.objectContaining({
      version, expectedEta: '2026-10-02T23:00:00.000Z', phase: 'pre-cut',
    }));
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T23:00:00Z') })).toEqual({ ready: true, reason: 'ready', details: clear });
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T23:00:00Z'), checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
  } finally { log.mockRestore(); resetElanousConfigDir(); }
}));

test('해당 판 일정이 없으면 다른 판에 컷이 있어도 기존 판정 유지', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule('0.2.7', { cutAt: '2099-10-03T08:00+09:00' }, 'OP');
    expect(releaseReadiness(version, { ...deps, now: () => new Date('2026-10-02T22:59:00Z') })).toEqual({ ready: true, reason: 'ready', details: clear });
    expect(releaseReadiness(version, { ...deps, checklist: () => blocked })).toEqual({ ready: false, reason: 'checklist-blocked', details: blocked });
  } finally { resetElanousConfigDir(); }
}));

test('GATE-ENTRY-ALIGN: past the landing deadline readiness lets non-P0 yellows through and blocks on P0 yellows', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule(version, { cutAt: '2026-10-03T08:00+09:00', landBy: '2026-10-03T06:30+09:00' }, 'OP');
    addItem(version, { id: 'LATE', title: 'Missed deadline', owner: 'TC', priority: 'P1' });
    const real = { ledgerRoot: deps.ledgerRoot, now: () => new Date('2026-10-02T23:00:00Z') };
    expect(releaseReadiness(version, real)).toMatchObject({ ready: true, reason: 'ready', details: { moved: ['LATE'], undecided: [] } });
    addItem(version, { id: 'URGENT', title: 'P0 open', owner: 'TC', priority: 'P0' });
    expect(releaseReadiness(version, real)).toMatchObject({ ready: false, reason: 'checklist-blocked', details: { blocked: ['URGENT'] } });
    // Readiness only judges — nothing is carried to the next version.
    expect(listChecklist(version).items.map((item) => item.id)).toEqual(['LATE', 'URGENT']);
  } finally { resetElanousConfigDir(); }
}));

test('GATE-ENTRY-ALIGN: before the landing deadline an undecided non-P0 yellow still blocks readiness', () => fixture((_dir, deps) => {
  setElanousConfigDir(deps.ledgerRoot!);
  try {
    setSchedule(version, { cutAt: '2026-10-03T06:00+09:00', landBy: '2026-10-03T08:30+09:00' }, 'OP');
    addItem(version, { id: 'WAIT', title: 'Before deadline', priority: 'P1' });
    expect(releaseReadiness(version, { ledgerRoot: deps.ledgerRoot, now: () => new Date('2026-10-02T22:00:00Z') })).toMatchObject({ ready: false, reason: 'checklist-blocked', details: { undecided: ['WAIT'] } });
  } finally { resetElanousConfigDir(); }
}));

test('image T-60 readiness signal is run- and cut-bound; absent or mismatched evidence stays unknown', () => fixture((dir, deps) => {
  const path = gateImageReadinessSignalPath(deps.ledgerRoot!, version);
  expect(path).toBe(join(dir, 'image-readiness.json'));
  expect(readGateImageReadinessSignal(path, { runId: 'run-1', cutCommit: 'a'.repeat(40) }))
    .toEqual({ status: 'unknown', reason: 'signal-missing' });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, status: 'ready', runId: 'run-1', cutCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, eligiblePools: ['gate-pool-a'], checkedAt: '2026-11-07T03:00:00.000Z' }));
  expect(readGateImageReadinessSignal(path, { runId: 'run-1', cutCommit: 'a'.repeat(40) }).status).toBe('ready');
  expect(readGateImageReadinessSignal(path, { runId: 'run-2', cutCommit: 'a'.repeat(40) }))
    .toEqual({ status: 'unknown', reason: 'run-mismatch' });
  expect(readGateImageReadinessSignal(path, { runId: 'run-1', cutCommit: 'c'.repeat(40) }))
    .toEqual({ status: 'unknown', reason: 'commit-mismatch' });
}));

test('T-minus image hold reads the real signal contract, waits through cutAt, then releases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-image-t60-'));
  const countdownVersion = '0.3.7';
  const runId = 'run-countdown';
  const cutCommit = 'a'.repeat(40);
  const signalPath = gateImageReadinessSignalPath(root, countdownVersion);
  const cutAt = '2026-11-07T03:05:00.000Z';
  let currentCutAt = cutAt;
  let instant = new Date('2026-11-07T03:00:00.000Z');
  let sleeps = 0;
  let unknownEta: unknown = 'not-observed';
  const eventStates: Array<{ phase: string; eta: string | null; holdReason: string | null }> = [];
  const log = spyOn(debug, 'log').mockImplementation((_category, event) => {
    if (event === 'countdown-cut-time-changed') {
      const state = JSON.parse(readFileSync(join(root, 'release', countdownVersion, 'readiness-countdown.json'), 'utf8')) as typeof eventStates[number];
      eventStates.push({ phase: state.phase, eta: state.eta, holdReason: state.holdReason });
    }
  });
  const writeSignal = (signalRunId: string) => writeFileSync(signalPath, JSON.stringify({ schemaVersion: 1, status: 'ready',
    runId: signalRunId, cutCommit, imageDigest: `sha256:${'b'.repeat(64)}`, eligiblePools: ['gate-pool-a'], checkedAt: instant.toISOString() }));
  try {
    setSchedule(countdownVersion, { cutAt }, 'OP', root);
    const result = await waitForGateImageT60({ runId, input: { version: countdownVersion }, outputs: { 'version-release': {
      commit: cutCommit, gateImagePrebuild: { outcome: 'built', runId, cutCommit,
        digest: `sha256:${'b'.repeat(64)}`, eligiblePools: ['gate-pool-a'] },
    } } }, {
      ledgerRoot: root, now: () => instant,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) unknownEta = JSON.parse(readFileSync(join(root, 'release', countdownVersion, 'readiness-countdown.json'), 'utf8')).eta;
        if (sleeps === 1) { writeSignal('other-run'); currentCutAt = '2026-11-07T03:06:00.000Z'; setSchedule(countdownVersion, { cutAt: currentCutAt }, 'OP', root); }
        if (sleeps === 2) { writeSignal(runId); instant = new Date('2026-11-07T03:04:00.000Z'); }
        if (sleeps === 3) { currentCutAt = '2026-11-07T03:07:00.000Z'; setSchedule(countdownVersion, { cutAt: currentCutAt }, 'OP', root); }
        if (sleeps === 4) { currentCutAt = '2026-11-07T03:03:00.000Z'; setSchedule(countdownVersion, { cutAt: currentCutAt }, 'OP', root); }
      },
      pollMilliseconds: 1000,
    });
    expect(result).toMatchObject({ version: countdownVersion, runId, cutCommit, eta: instant.toISOString(), signalPath });
    expect(sleeps).toBe(4);
    expect(unknownEta).toBeNull();
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-hold', expect.objectContaining({
      version: countdownVersion, eta: null, reason: 'image-t60:signal-missing',
    }));
    expect(log.mock.calls.filter((call) => call[0] === 'release.schedule' && call[1] === 'countdown-cut-time-changed')).toHaveLength(3);
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-cut-time-changed', {
      version: countdownVersion, runId, fromCutAt: cutAt, cutAt: '2026-11-07T03:06:00.000Z',
      observedAt: '2026-11-07T03:00:00.000Z', eta: null, phase: 'hold', holdReason: 'image-t60:run-mismatch',
    });
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-cut-time-changed', {
      version: countdownVersion, runId, fromCutAt: '2026-11-07T03:07:00.000Z', cutAt: currentCutAt,
      observedAt: '2026-11-07T03:04:00.000Z', eta: instant.toISOString(), phase: 'ready', holdReason: null,
    });
    expect(eventStates).toEqual([
      { phase: 'hold', eta: null, holdReason: 'image-t60:run-mismatch' },
      { phase: 'countdown', eta: '2026-11-07T03:07:00.000Z', holdReason: 'cut-time-constraint' },
      { phase: 'ready', eta: '2026-11-07T03:04:00.000Z', holdReason: null },
    ]);
    expect(log).toHaveBeenCalledWith('release.schedule', 'countdown-cut-time-changed', {
      version: countdownVersion, runId, fromCutAt: '2026-11-07T03:06:00.000Z', cutAt: '2026-11-07T03:07:00.000Z',
      observedAt: '2026-11-07T03:04:00.000Z', eta: '2026-11-07T03:07:00.000Z', phase: 'countdown', holdReason: 'cut-time-constraint',
    });
    expect(JSON.parse(readFileSync(join(root, 'release', countdownVersion, 'readiness-countdown.json'), 'utf8')))
      .toMatchObject({ phase: 'ready', eta: result.eta, holdReason: null, runId, cutCommit });
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  expect(existsSync(root)).toBe(false);
});

test('0.3.6 skips the image signal but holds graph progress until cutAt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-image-036-'));
  let instant = new Date('2026-11-07T03:04:00.000Z');
  let sleeps = 0;
  let cutAt = '2026-11-07T03:05:00.000Z';
  try {
    setSchedule('0.3.6', { cutAt }, 'OP', root);
    const result = await waitForGateImageT60({ runId: 'run-036', input: { version: '0.3.6' },
      outputs: { 'version-release': { commit: 'a'.repeat(40) } } }, {
      ledgerRoot: root, readSignal: () => { throw new Error('0.3.6 must not read the new signal'); },
      now: () => instant,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) { instant = new Date(cutAt); cutAt = '2026-11-07T03:06:00.000Z'; setSchedule('0.3.6', { cutAt }, 'OP', root); }
        else instant = new Date(cutAt);
      },
      pollMilliseconds: 1000,
    });
    expect(result).toEqual({ version: '0.3.6', runId: 'run-036', cutCommit: 'a'.repeat(40), eta: cutAt, signalPath: '' });
    expect(sleeps).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production release graph routes every version through the cut-time readiness node', () => {
  const graph = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as {
    nodes: Array<{ node_id: string; recipe?: string }>;
    edges: Array<{ from: string; map?: Record<string, string> }>;
  };
  const recipes = yaml(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command?: string; timeout_ms?: number }>;
  expect(graph.edges.find((edge) => edge.from === 'version-release')?.map).toEqual({
    ok: 'readiness-countdown', fail: 'failed', error: 'failed',
  });
  expect(graph.edges.find((edge) => edge.from === 'readiness-countdown')?.map?.ok).toBe('traffic-cut-start');
  expect(recipes['readiness-countdown']?.command).toBe('bun scripts/release-loop/release-readiness.ts --image-t60-hold');
  expect(recipes['readiness-countdown']?.timeout_ms).toBe(0);
  expect(graph.nodes.find((node) => node.node_id === 'readiness-countdown')?.recipe).toBe('cmd:readiness-countdown');
});
