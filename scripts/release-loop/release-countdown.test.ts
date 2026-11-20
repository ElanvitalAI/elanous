import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOLD_CODES, evaluateCountdown, readTrafficPrepMarker, trafficPrepMarkerPath, type CountdownConditions, type CountdownProbes, type HoldCode } from './release-countdown.js';
import { COUNTDOWN_LONG_HOLD_NOTICE_MS, gateImageReadinessSignalPath, waitForGateImageT60 } from './release-readiness.js';
import { spyOn } from 'bun:test';
import { debug } from '../../src/debug/log.js';
import { RELEASE_CUT_DUE_WINDOW_MS, setSchedule } from '../../src/release-loop/release-schedule.js';

const base = 'abcdef0123456789abcdef0123456789abcdef01';
const allGo: Required<CountdownConditions> = {
  schedule: { present: true, exempt: false },
  baseSha: { expected: base, actual: base },
  image: { ready: true, detail: 'ready' },
  traffic: { prepped: true, detail: 'prepped' },
  hosts: [{ host: 'aws1', reachable: true }],
  credentials: { npmTokenFile: true, ghAuth: true },
  approvalMarker: 'RELEASE-HUMAN-APPROVAL',
};
const broken: Record<HoldCode, Partial<CountdownConditions>> = {
  SCHEDULE_MISSING: { schedule: { present: false, exempt: false } },
  BASE_SHA_MISMATCH: { baseSha: { expected: base, actual: 'fedcba9876543210fedcba9876543210fedcba98' } },
  IMAGE_NOT_READY: { image: { ready: false, detail: 'image-t60:signal-missing' } },
  TRAFFIC_NOT_PREPPED: { traffic: { prepped: false, detail: 'T-1h traffic marker missing' } },
  HOST_UNREACHABLE: { hosts: [{ host: 'aws1', reachable: false }] },
  CREDENTIAL_STALE: { credentials: { npmTokenFile: true, ghAuth: false } },
  APPROVAL_MARKER_ABSENT: { approvalMarker: null },
};

test('COUNTDOWN-GO: every declared condition GO lets cut, gate and publish proceed', () => {
  for (const stage of ['cut', 'gate', 'publish'] as const) {
    expect(evaluateCountdown(stage, allGo)).toEqual({ stage, go: true, holds: [], skipped: [] });
  }
});

test('COUNTDOWN-HOLD: each single missing condition holds with exactly its stable code', () => {
  for (const code of HOLD_CODES) {
    const stage = code === 'APPROVAL_MARKER_ABSENT' ? 'publish' : 'gate';
    const verdict = evaluateCountdown(stage, { ...allGo, ...broken[code] });
    expect(verdict.go).toBe(false);
    expect(verdict.holds.map((hold) => hold.code)).toEqual([code]);
  }
});

test('COUNTDOWN-RC: a prerelease keeps the schedule-row exemption; a stable version does not', () => {
  expect(evaluateCountdown('cut', { ...allGo, schedule: { present: false, exempt: true } }).go).toBe(true);
  expect(evaluateCountdown('cut', { ...allGo, schedule: { present: false, exempt: false } }).holds.map((hold) => hold.code)).toEqual(['SCHEDULE_MISSING']);
});

test('COUNTDOWN-SKIP: unprobed conditions are recorded as skipped, but an absent approval marker always holds publish', () => {
  expect(evaluateCountdown('gate', { schedule: allGo.schedule, image: allGo.image })).toEqual({
    stage: 'gate', go: true, holds: [], skipped: ['baseSha', 'traffic', 'hosts', 'credentials'],
  });
  expect(evaluateCountdown('publish', { credentials: allGo.credentials }).holds.map((hold) => hold.code)).toEqual(['APPROVAL_MARKER_ABSENT']);
});

test('TRAFFIC-PREP receipt contract (#39160): only a live, applied, unrestored receipt for this exact version and cut counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-traffic-'));
  const version = '0.3.31-rc.0';
  const path = trafficPrepMarkerPath(root, version);
  const cutAt = '2026-11-20T20:30:00.000Z';
  const at = { now: new Date('2026-11-20T20:00:00.000Z'), cutAt };
  const receipt = { schema: 'release-traffic-prep/v1', version, baseVersion: '0.3.31', prerelease: 'rc', cutAt,
    windowStart: '2026-11-20T19:30:00.000Z', windowEnd: cutAt, validUntil: '2026-11-21T20:30:00.000Z',
    appliedAt: '2026-11-20T19:31:00.000Z', prepRunId: 'prep-run', baseSha: null, trafficFile: '/tmp/traffic.json',
    trafficFileSha256: 'abc', trafficResult: 'applied' };
  try {
    expect(readTrafficPrepMarker(path, version, at).prepped).toBe(false);
    mkdirSync(join(root, 'release', version), { recursive: true });
    const { appliedAt: _applied, ...unapplied } = receipt;
    for (const bad of [{ ...receipt, schema: 'release-traffic-prep/v2' }, { ...receipt, version: '0.3.31' }, unapplied,
      { ...receipt, restoredAt: '2026-11-20T19:45:00.000Z' }, { ...receipt, validUntil: '2026-11-20T19:59:00.000Z' },
      { ...receipt, cutAt: '2026-11-20T21:30:00.000Z' }, { schemaVersion: 1, version, status: 'done', preparedAt: cutAt }]) {
      writeFileSync(path, JSON.stringify(bad));
      expect(readTrafficPrepMarker(path, version, at).prepped).toBe(false);
    }
    writeFileSync(path, JSON.stringify(receipt));
    expect(readTrafficPrepMarker(path, version, at).prepped).toBe(true);
    expect(readTrafficPrepMarker(path, version, { ...at, cutAt: null }).prepped).toBe(true);
    expect(readTrafficPrepMarker(path, version, { ...at, now: new Date(receipt.validUntil) }).prepped).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const runId = 'run-countdown-graph';
const digest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
function graphContext(version: string) {
  return { runId, input: { version, gatePodPool: 'pool-aws1@aws1', branchCutBaseCommit: base }, outputs: {
    'cut-branch': { outcome: 'ok', commit: base, base },
    'gate-image-prebuild': { outcome: 'ok', gateImagePrebuild: { outcome: 'reused', runId, cutCommit: base, digest, eligiblePools: ['pool-aws1'] } },
  } };
}
function writeImageSignal(root: string, version: string): void {
  mkdirSync(join(root, 'release', version), { recursive: true });
  writeFileSync(gateImageReadinessSignalPath(root, version), JSON.stringify({ schemaVersion: 1, status: 'ready', runId, cutCommit: base,
    imageDigest: digest, eligiblePools: ['pool-aws1'], checkedAt: '2026-11-20T20:00:00.000Z' }));
}
const goProbes: CountdownProbes = {
  trafficPrep: () => ({ prepped: true, detail: 'prepped' }),
  hostReachable: () => true,
  credentials: () => ({ npmTokenFile: true, ghAuth: true }),
};
const receipt = (root: string, version: string) => JSON.parse(readFileSync(join(root, 'release', version, 'countdown.json'), 'utf8'));

test('COUNTDOWN-NODE: a stable run with a missing schedule row holds SCHEDULE_MISSING, then proceeds once the row lands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-node-'));
  const version = '0.3.31';
  const instant = new Date('2026-11-20T20:30:00.000Z');
  const seen: unknown[] = [];
  try {
    writeImageSignal(root, version);
    const result = await waitForGateImageT60(graphContext(version), { ledgerRoot: root, now: () => instant, probes: goProbes,
      sleep: async () => {
        seen.push(receipt(root, version).holds.map((hold: { code: string }) => hold.code));
        setSchedule(version, { cutAt: '2026-11-20T20:30:00.000Z' }, 'OP', root);
      } });
    expect(result).toMatchObject({ version, runId, cutCommit: base, eta: instant.toISOString() });
    expect(seen).toEqual([['SCHEDULE_MISSING']]);
    expect(receipt(root, version)).toMatchObject({ go: true, phase: 'ready', holds: [], skipped: [], longHold: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('COUNTDOWN-NODE: an image signal later than the notice cadence still turns GO and proceeds — a long hold never fails the run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-late-image-'));
  const version = '0.3.31';
  const start = new Date('2026-11-20T20:30:00.000Z');
  let instant = start;
  const seen: unknown[] = [];
  try {
    setSchedule(version, { cutAt: start.toISOString() }, 'OP', root);
    const result = await waitForGateImageT60(graphContext(version), { ledgerRoot: root, now: () => instant, probes: goProbes,
      sleep: async () => {
        const current = receipt(root, version);
        seen.push({ codes: current.holds.map((hold: { code: string }) => hold.code), longHold: current.longHold });
        instant = new Date(instant.getTime() + COUNTDOWN_LONG_HOLD_NOTICE_MS);
        if (current.longHold) writeImageSignal(root, version);
      } });
    expect(result).toMatchObject({ version, runId, eta: instant.toISOString() });
    expect(seen).toEqual([
      { codes: ['IMAGE_NOT_READY'], longHold: null },
      { codes: ['IMAGE_NOT_READY'], longHold: { since: start.toISOString(), codes: ['IMAGE_NOT_READY'],
        hint: expect.stringContaining(`eln release critpath --version ${version}`), notifiedAt: new Date(start.getTime() + COUNTDOWN_LONG_HOLD_NOTICE_MS).toISOString() } },
    ]);
    expect(receipt(root, version)).toMatchObject({ go: true, phase: 'ready', longHold: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('COUNTDOWN-NODE: a long hold emits the QUICKPASS notice with its codes at most once per cadence, and keeps holding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-long-hold-'));
  const version = '0.3.31';
  const start = new Date('2026-11-20T20:30:00.000Z');
  let instant = start;
  const reachable = [false, false, false, false, true];
  const advance = [true, false, true, false];
  const notices: Array<Record<string, unknown>> = [];
  const log = spyOn(debug, 'log').mockImplementation((_category, event, fields) => {
    if (event === 'countdown-long-hold') notices.push(fields as Record<string, unknown>);
  });
  try {
    writeImageSignal(root, version);
    setSchedule(version, { cutAt: start.toISOString() }, 'OP', root);
    const result = await waitForGateImageT60(graphContext(version), { ledgerRoot: root, now: () => instant,
      probes: { ...goProbes, hostReachable: () => reachable.shift()! },
      sleep: async () => { if (advance.shift()) instant = new Date(instant.getTime() + COUNTDOWN_LONG_HOLD_NOTICE_MS); } });
    expect(result).toMatchObject({ version, runId });
    expect(notices.map((notice) => notice.notifiedAt)).toEqual([
      new Date(start.getTime() + COUNTDOWN_LONG_HOLD_NOTICE_MS).toISOString(),
      new Date(start.getTime() + COUNTDOWN_LONG_HOLD_NOTICE_MS + COUNTDOWN_LONG_HOLD_NOTICE_MS).toISOString(),
    ]);
    for (const notice of notices) {
      expect(notice).toMatchObject({ version, since: start.toISOString(), codes: ['HOST_UNREACHABLE'] });
      expect(String(notice.hint)).toContain(`eln release critpath --version ${version}`);
    }
    expect(reachable).toEqual([]);
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('COUNTDOWN-NODE: a hold fails only on the explicit deadline — the schedule row\'s cut-due window has passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-deadline-'));
  const version = '0.3.31';
  const start = new Date('2026-11-20T20:30:00.000Z');
  let instant = start;
  try {
    writeImageSignal(root, version);
    setSchedule(version, { cutAt: start.toISOString() }, 'OP', root);
    await expect(waitForGateImageT60(graphContext(version), { ledgerRoot: root, now: () => instant,
      probes: { ...goProbes, hostReachable: () => false },
      sleep: async () => { instant = new Date(instant.getTime() + RELEASE_CUT_DUE_WINDOW_MS); } }))
      .rejects.toThrow(/RELEASE_WINDOW_EXPIRED.*HOST_UNREACHABLE.*eln release critpath --version/);
    expect(receipt(root, version)).toMatchObject({ go: false, phase: 'hold', holds: [{ code: 'HOST_UNREACHABLE' }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('COUNTDOWN-NODE: the T-30 image must be on the run\'s own pool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'countdown-pool-'));
  const version = '0.3.31';
  const context = graphContext(version);
  context.input.gatePodPool = 'pool-gcp@cloud-vm';
  try {
    writeImageSignal(root, version);
    setSchedule(version, { cutAt: '2026-11-20T20:30:00.000Z' }, 'OP', root);
    await expect(waitForGateImageT60(context, { ledgerRoot: root, now: () => new Date('2026-11-20T20:30:00.000Z'), probes: goProbes,
      sleep: async () => { throw new Error('held'); } })).rejects.toThrow('held');
    expect(receipt(root, version).holds).toEqual([{ code: 'IMAGE_NOT_READY', detail: 'image-t60:pool-mismatch' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
