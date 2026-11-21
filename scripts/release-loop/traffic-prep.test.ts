import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyReleaseTrafficEvent, type TrafficFile } from './traffic-transition.js';
import { runTrafficPrepCommand } from './traffic-node.js';
import { main as versionNodeMain } from './version-node.js';
import { writeValidTrafficPrep } from './traffic-prep-fixture.js';
import {
  awaitTrafficPrep, checkTrafficPrepReceipt, runTrafficPrep, restoreTrafficPrep, trafficPrepReceiptPath, TrafficPrepHoldError,
  TRAFFIC_NOT_PREPPED, TRAFFIC_PREP_HOLD_BUDGET_MS, TRAFFIC_PREP_HOLD_POLL_MS, TRAFFIC_PREP_LEAD_MS, TRAFFIC_PREP_RECEIPT_SCHEMA,
  TRAFFIC_PREP_VALID_AFTER_CUT_MS, type TrafficPrepDeps, type TrafficPrepHold, type TrafficPrepHoldReason,
} from './traffic-prep.js';

// RELEASE-TRAFFIC-PREP-T1H: every instant below is derived from the cut and the exported window constants.
const CUT_AT = '2026-11-21T20:30:00.000Z';
const CUT = Date.parse(CUT_AT);
const WINDOW_START = CUT - TRAFFIC_PREP_LEAD_MS;
const INSIDE = WINDOW_START + TRAFFIC_PREP_LEAD_MS / 2;
const at = (ms: number) => () => new Date(ms);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-traffic-prep-'));
  const trafficFile = join(root, 'traffic.json');
  const initial: TrafficFile = {
    global: 'yellow', reason: 'operator-policy', order: ['CELL-A'],
    seats: Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 6, keep: seat }])),
  };
  writeFileSync(trafficFile, JSON.stringify(initial));
  const deps = (now: number, extra: Partial<TrafficPrepDeps> = {}): TrafficPrepDeps => ({
    root, now: at(now), traffic: { trafficFile }, schedule: () => ({ cutAt: CUT_AT }), baseSha: () => 'a'.repeat(40), ...extra,
  });
  const traffic = () => JSON.parse(readFileSync(trafficFile, 'utf8')) as TrafficFile;
  return { root, trafficFile, initial, deps, traffic, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('prep inside cutAt−1h … cutAt applies the release traffic control and writes the receipt contract', async () => {
  const f = fixture();
  try {
    const result = await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE));
    expect(result.ok).toBe(true);
    const path = trafficPrepReceiptPath('0.3.31', f.root);
    expect(result.receiptPath).toBe(path);
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    expect(receipt).toMatchObject({
      schema: TRAFFIC_PREP_RECEIPT_SCHEMA, version: '0.3.31', baseVersion: '0.3.31', prerelease: null, cutAt: CUT_AT,
      windowStart: new Date(WINDOW_START).toISOString(), windowEnd: CUT_AT,
      validUntil: new Date(CUT + TRAFFIC_PREP_VALID_AFTER_CUT_MS).toISOString(),
      appliedAt: new Date(INSIDE).toISOString(), baseSha: 'a'.repeat(40), trafficFile: f.trafficFile, trafficResult: 'applied',
    });
    expect(receipt.trafficFileSha256).toMatch(/^[0-9a-f]{64}$/);
    const after = f.traffic();
    expect(after.global).toBe('gate');
    expect(after.order).toEqual(f.initial.order as string[]);
    expect(after.releaseLifecycle).toMatchObject({ runId: receipt.prepRunId, version: '0.3.31', stage: 0,
      beforeCut: { global: 'yellow', perCycle: { OP: 6, TC: 6, MK: 6, UX: 6 } } });
    // A repeated prep for the same cut is idempotent and keeps the first application stamp.
    const again = await runTrafficPrep({ version: '0.3.31' }, f.deps(CUT));
    expect(again).toMatchObject({ ok: true, receipt: { prepRunId: receipt.prepRunId, appliedAt: receipt.appliedAt, trafficResult: 'already-applied' } });
  } finally { f.cleanup(); }
});

test('prep outside the window refuses and leaves traffic and receipt untouched', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.trafficFile, 'utf8');
    for (const now of [WINDOW_START - TRAFFIC_PREP_LEAD_MS / 2, CUT + TRAFFIC_PREP_LEAD_MS / 2]) {
      const result = await runTrafficPrep({ version: '0.3.31' }, f.deps(now));
      expect(result).toMatchObject({ ok: false, reason: 'outside-window' });
    }
    expect(readFileSync(f.trafficFile, 'utf8')).toBe(before);
    expect(existsSync(trafficPrepReceiptPath('0.3.31', f.root))).toBe(false);
    // A stable prep cannot claim a cut other than the scheduled one.
    await expect(runTrafficPrep({ version: '0.3.31', cutAt: new Date(INSIDE).toISOString() }, f.deps(INSIDE))).rejects.toThrow('differs from');
  } finally { f.cleanup(); }
});

test('cut-branch guard refuses without receipt, with a stale or restored receipt, and for another version', async () => {
  const f = fixture();
  try {
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT))).toMatchObject({ ok: false, reason: 'missing' });
    expect((await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE))).ok).toBe(true);
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT))).toMatchObject({ ok: true, receipt: { version: '0.3.31' } });
    // Another version: no receipt of its own, and a copied receipt does not match it.
    expect(checkTrafficPrepReceipt('0.3.32', f.deps(CUT))).toMatchObject({ ok: false, reason: 'missing' });
    const foreign = trafficPrepReceiptPath('0.3.32', f.root);
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, readFileSync(trafficPrepReceiptPath('0.3.31', f.root), 'utf8'));
    expect(checkTrafficPrepReceipt('0.3.32', f.deps(CUT))).toMatchObject({ ok: false, reason: 'version-mismatch' });
    // Stale: past the cut's due window, or the schedule moved after the prep.
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT + TRAFFIC_PREP_VALID_AFTER_CUT_MS + TRAFFIC_PREP_LEAD_MS)))
      .toMatchObject({ ok: false, reason: 'stale' });
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT, { schedule: () => ({ cutAt: new Date(CUT + TRAFFIC_PREP_LEAD_MS).toISOString() }) })))
      .toMatchObject({ ok: false, reason: 'rescheduled' });
    // Restore returns the pre-prep traffic and voids the receipt.
    expect((await restoreTrafficPrep('0.3.31', f.deps(CUT))).ok).toBe(true);
    expect(f.traffic()).toMatchObject({ global: 'yellow', seats: { OP: { perCycle: 6 } } });
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT))).toMatchObject({ ok: false, reason: 'restored' });
  } finally { f.cleanup(); }
});

test('guard refuses when the traffic file no longer carries the prep control', async () => {
  const f = fixture();
  try {
    expect((await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE))).ok).toBe(true);
    writeFileSync(f.trafficFile, JSON.stringify(f.initial));
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT))).toMatchObject({ ok: false, reason: 'not-in-effect' });
  } finally { f.cleanup(); }
});

test('the run takes over the prep: its cut-start keeps the pre-prep baseline and failed-restore returns to it', async () => {
  const f = fixture();
  try {
    expect((await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE))).ok).toBe(true);
    const run = { runId: 'release-run-after-prep', startedAt: CUT_AT, input: { version: '0.3.31', previousVersion: '0.3.30' }, outputs: {} };
    expect(await applyReleaseTrafficEvent({ ...run, nodeId: 'traffic-cut-start' }, 'cut-start', { trafficFile: f.trafficFile }))
      .toMatchObject({ applied: true });
    expect(f.traffic().releaseLifecycle).toMatchObject({ runId: run.runId, beforeCut: { global: 'yellow' } });
    expect(checkTrafficPrepReceipt('0.3.31', { ...f.deps(CUT), runId: run.runId })).toMatchObject({ ok: true });
    expect(await applyReleaseTrafficEvent({ ...run, nodeId: 'traffic-failed-restore' }, 'failed', { trafficFile: f.trafficFile }))
      .toMatchObject({ applied: true });
    expect(f.traffic()).toMatchObject({ global: 'yellow', seats: { OP: { perCycle: 6 }, UX: { perCycle: 6 } } });
  } finally { f.cleanup(); }
});

test('rc rehearsal uses the same prep step and receipt path under its resolved run version', async () => {
  const f = fixture();
  try {
    const resolveVersion = (version: string, kind: string | undefined) => kind ? `${version}-${kind}.0` : version;
    await expect(runTrafficPrepCommand({ version: '0.3.31', prerelease: 'rc' }, {}, { ...f.deps(INSIDE), resolveVersion }))
      .rejects.toThrow('--cut-at');
    const result = await runTrafficPrepCommand({ version: '0.3.31', prerelease: 'rc', cutAt: CUT_AT }, {},
      { ...f.deps(INSIDE, { schedule: () => null }), resolveVersion });
    expect(result).toMatchObject({ ok: true, version: '0.3.31-rc.0', receiptPath: trafficPrepReceiptPath('0.3.31-rc.0', f.root),
      receipt: { version: '0.3.31-rc.0', baseVersion: '0.3.31', prerelease: 'rc', cutAt: CUT_AT } });
    expect(checkTrafficPrepReceipt('0.3.31-rc.0', f.deps(CUT))).toMatchObject({ ok: true });
    expect(checkTrafficPrepReceipt('0.3.31', f.deps(CUT))).toMatchObject({ ok: false, reason: 'missing' });
  } finally { f.cleanup(); }
});

/** A fake clock the hold advances through its own sleeps: the whole bounded budget runs instantly. */
function fakeHoldClock(start: number) {
  let t = start;
  return { now: () => t, sleep: (ms: number) => { t += ms; } };
}
// Evaluations in one exhausted hold: the first one plus one per poll across the budget.
const EXHAUSTED_EVALUATIONS = TRAFFIC_PREP_HOLD_BUDGET_MS / TRAFFIC_PREP_HOLD_POLL_MS + 1;

function holdOf(run: () => unknown): TrafficPrepHold {
  try { run(); } catch (error) { if (error instanceof TrafficPrepHoldError) return error.hold; throw error; }
  throw new Error('expected a TrafficPrepHoldError');
}

test('no receipt holds TRAFFIC_NOT_PREPPED(missing), re-evaluates within the budget, then fails with the QUICKPASS hint', () => {
  const f = fixture();
  try {
    const clock = fakeHoldClock(CUT);
    const holds: TrafficPrepHold[] = [];
    let error: unknown;
    try { awaitTrafficPrep('0.3.31', { ...clock, root: f.root, onHold: (hold) => holds.push(hold) }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TrafficPrepHoldError);
    const message = (error as Error).message;
    expect(message).toStartWith(`${TRAFFIC_NOT_PREPPED}(missing)`);
    expect(message).toContain('eln release prepare --version 0.3.31');
    expect(message).toContain('eln release publish --dir <prepared> --notes-file <approved-notes> --yes');
    expect(holds.map((hold) => hold.reason)).toEqual(Array.from({ length: EXHAUSTED_EVALUATIONS }, () => 'missing'));
    expect(holds.at(-1)).toMatchObject({ code: TRAFFIC_NOT_PREPPED, attempts: EXHAUSTED_EVALUATIONS, heldMs: TRAFFIC_PREP_HOLD_BUDGET_MS });
  } finally { f.cleanup(); }
});

test('a valid receipt proceeds at once, and a prep that lands during the hold clears it', async () => {
  const f = fixture();
  try {
    const receipt = await writeValidTrafficPrep(f.root, '0.3.31');
    // No schedule row in this fixture: the real ledger's schedule is never consulted.
    const isolated = { root: f.root, schedule: () => null };
    expect(awaitTrafficPrep('0.3.31', { check: () => checkTrafficPrepReceipt('0.3.31', isolated), sleep: () => { throw new Error('a valid receipt must not hold'); } }))
      .toMatchObject({ version: '0.3.31', prepRunId: receipt.prepRunId });
    const verdicts = [checkTrafficPrepReceipt('0.3.32', isolated), checkTrafficPrepReceipt('0.3.31', isolated)];
    const holds: TrafficPrepHold[] = [];
    expect(awaitTrafficPrep('0.3.31', { ...fakeHoldClock(CUT), check: () => verdicts.shift()!, onHold: (hold) => holds.push(hold) }))
      .toMatchObject({ version: '0.3.31' });
    expect(holds.map((hold) => hold.reason)).toEqual(['missing']);
  } finally { f.cleanup(); }
});

test('each detail reason is held under TRAFFIC_NOT_PREPPED and reported when the budget is spent', async () => {
  const f = fixture();
  const reasonAt = (version: string, now: number, extra: Partial<TrafficPrepDeps> = {}): TrafficPrepHoldReason =>
    holdOf(() => awaitTrafficPrep(version, { ...fakeHoldClock(now), check: () => checkTrafficPrepReceipt(version, f.deps(now, extra)) })).reason;
  try {
    const seen: TrafficPrepHoldReason[] = [reasonAt('0.3.31', CUT)];
    expect((await runTrafficPrep({ version: '0.3.31' }, f.deps(INSIDE))).ok).toBe(true);
    const path = trafficPrepReceiptPath('0.3.31', f.root);
    const valid = JSON.parse(readFileSync(path, 'utf8'));
    const foreign = trafficPrepReceiptPath('0.3.32', f.root);
    mkdirSync(dirname(foreign), { recursive: true });
    writeFileSync(foreign, JSON.stringify(valid));
    seen.push(reasonAt('0.3.32', CUT));
    writeFileSync(foreign, '{ not json');
    seen.push(reasonAt('0.3.32', CUT));
    writeFileSync(path, JSON.stringify({ ...valid, appliedAt: new Date(WINDOW_START - TRAFFIC_PREP_LEAD_MS).toISOString() }));
    seen.push(reasonAt('0.3.31', CUT));
    writeFileSync(path, JSON.stringify(valid));
    seen.push(reasonAt('0.3.31', CUT, { schedule: () => ({ cutAt: new Date(CUT + TRAFFIC_PREP_LEAD_MS).toISOString() }) }));
    seen.push(reasonAt('0.3.31', CUT + TRAFFIC_PREP_VALID_AFTER_CUT_MS + TRAFFIC_PREP_LEAD_MS));
    const traffic = readFileSync(f.trafficFile, 'utf8');
    writeFileSync(f.trafficFile, JSON.stringify(f.initial));
    seen.push(reasonAt('0.3.31', CUT));
    writeFileSync(f.trafficFile, traffic);
    writeFileSync(path, JSON.stringify({ ...valid, restoredAt: new Date(CUT).toISOString() }));
    seen.push(reasonAt('0.3.31', CUT));
    expect(seen).toEqual(['missing', 'version-mismatch', 'invalid', 'outside-window', 'rescheduled', 'stale', 'not-in-effect', 'restored']);
  } finally { f.cleanup(); }
});

test('version-node holds the cut-branch entry by default, fails with code and hint, and proceeds on a valid receipt', async () => {
  const f = fixture();
  const previous = process.env.ELANOUS_GRAPH_CONTEXT;
  const checked: string[] = [];
  const check = (version: string) => () => { checked.push(version); return checkTrafficPrepReceipt(version, { root: f.root, schedule: () => null }); };
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ runId: 'guard-run', nodeId: 'cut-branch', input: { version: '0.3.31' }, outputs: {} });
    const held = versionNodeMain(['release', '--no-prebuild', '--json'], f.root, { trafficPrepHold: { ...fakeHoldClock(CUT), check: check('0.3.31') } });
    expect(held).toMatchObject({ outcome: 'error', version: '0.3.31', hold: { code: TRAFFIC_NOT_PREPPED, reason: 'missing', attempts: EXHAUSTED_EVALUATIONS } });
    expect(held.error).toStartWith(`${TRAFFIC_NOT_PREPPED}(missing)`);
    expect(held.error).toContain('eln release publish --dir <prepared>');
    await writeValidTrafficPrep(f.root, '0.3.31');
    checked.length = 0;
    const admitted = versionNodeMain(['release', '--no-prebuild', '--json'], f.root, { trafficPrepHold: { check: check('0.3.31'), sleep: () => { throw new Error('no hold expected'); } } });
    // Past the guard the node runs its real landing (this fixture root is no git checkout): no hold is recorded.
    expect(checked).toEqual(['0.3.31']);
    expect(admitted.hold).toBeUndefined();
    expect(String(admitted.error ?? '')).not.toContain(TRAFFIC_NOT_PREPPED);
    // Not the cut node: the hold is not consulted.
    checked.length = 0;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ runId: 'guard-run', nodeId: 'gate-image-prebuild', input: { version: '0.3.31' }, outputs: {} });
    versionNodeMain(['gate-image-prebuild', '--dry-run', '--cut', 'b'.repeat(40), '--json'], f.root, { trafficPrepHold: { check: check('0.3.31') } });
    expect(checked).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previous;
    f.cleanup();
  }
});
