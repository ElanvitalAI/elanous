import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { releaseLedgerRoot } from '../../src/instance/resolve.js';
import { cutChecklistGate, type ChecklistGate } from '../../src/release-loop/checklist.js';

/** Only the verdict fields are read — so a `release run` deps checklist (`Pick<…>`) fits as well. */
export type ReadinessChecklist = Pick<ChecklistGate, 'ok' | 'red' | 'undecided' | 'blocked'>;
import { RELEASE_CUT_DUE_WINDOW_MS, getSchedule, formatKst } from '../../src/release-loop/release-schedule.js';
import { debug } from '../../src/debug/log.js';
import { baseVersion, isReleaseVersion, prereleaseKind } from './release-version.js';
import { parsePodPool } from '../../src/task-orchestrator/surfaces/pod-pool.js';
import { quickpassHint, countdownReceiptPath, defaultCountdownProbes, evaluateCountdown, poolHosts, writeCountdownReceipt,
  type CountdownConditions, type CountdownProbes } from './release-countdown.js';

export type ReleaseReadiness =
  | { ready: false; reason: 'already-published'; details: string }
  | { ready: false; reason: 'already-running'; details: string }
  | { ready: false; reason: 'before-cut'; details: string }
  | { ready: false; reason: 'checklist-blocked'; details: ReadinessChecklist }
  | { ready: true; reason: 'ready'; details: ReadinessChecklist };

export interface ReleaseReadinessDeps {
  ledgerRoot?: string;
  checklist?: (version: string) => ReadinessChecklist;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** Countdown callers may start the graph before cutAt; the cut remains a graph constraint. */
  allowBeforeCut?: boolean;
}

export interface GateImageReadinessSignal {
  schemaVersion: 1;
  status: 'ready';
  runId: string;
  cutCommit: string;
  imageDigest: string;
  eligiblePools: string[];
  checkedAt: string;
}

export type GateImageReadiness =
  | { status: 'ready'; signal: GateImageReadinessSignal }
  | { status: 'unknown'; reason: 'signal-missing' | 'signal-invalid' | 'run-mismatch' | 'commit-mismatch' | 'prebuild-pending' | 'prebuild-unconfirmed' };

export function gateImageReadinessSignalPath(root: string, version: string): string {
  // x.y.z or a prerelease x.y.z-(rc|alpha|beta).N; anything else (e.g. `../0.2.6`) never reaches a ledger path.
  if (!isReleaseVersion(version)) throw new Error(`release version must be x.y.z: ${version}`);
  return join(root, 'release', version, 'image-readiness.json');
}

export function gateImageReadinessPendingPath(root: string, version: string): string {
  return join(dirname(gateImageReadinessSignalPath(root, version)), 'image-readiness.pending');
}

/** Fail closed until the image producer publishes a run- and cut-bound readiness signal. */
export function readGateImageReadinessSignal(path: string, expected: { runId: string; cutCommit: string },
  options: { ignorePending?: boolean } = {}): GateImageReadiness {
  if (!options.ignorePending && existsSync(join(dirname(path), 'image-readiness.pending')))
    return { status: 'unknown', reason: 'prebuild-pending' };
  if (!existsSync(path)) return { status: 'unknown', reason: 'signal-missing' };
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { status: 'unknown', reason: 'signal-invalid' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'unknown', reason: 'signal-invalid' };
  const signal = value as Partial<GateImageReadinessSignal>;
  if (signal.schemaVersion !== 1 || signal.status !== 'ready' || typeof signal.runId !== 'string'
    || typeof signal.cutCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(signal.cutCommit)
    || typeof signal.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(signal.imageDigest)
    || !Array.isArray(signal.eligiblePools) || signal.eligiblePools.length === 0
    || signal.eligiblePools.some((pool) => typeof pool !== 'string' || !pool.trim())
    || typeof signal.checkedAt !== 'string' || !Number.isFinite(Date.parse(signal.checkedAt))) {
    return { status: 'unknown', reason: 'signal-invalid' };
  }
  if (signal.runId !== expected.runId) return { status: 'unknown', reason: 'run-mismatch' };
  if (signal.cutCommit.toLowerCase() !== expected.cutCommit.toLowerCase()) return { status: 'unknown', reason: 'commit-mismatch' };
  return { status: 'ready', signal: signal as GateImageReadinessSignal };
}

export interface ReadinessGraphContext {
  runId?: unknown;
  input?: { version?: unknown; gatePodPool?: unknown; branchCutBaseCommit?: unknown };
  outputs?: Record<string, unknown>;
}

export interface ImageT60HoldDeps {
  ledgerRoot?: string;
  readSignal?: typeof readGateImageReadinessSignal;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMilliseconds?: number;
  /** Go/No-Go probes (RELEASE-COUNTDOWN-IN-GRAPH). The graph entry passes all of them; an absent probe is a skipped condition. */
  probes?: Partial<CountdownProbes>;
}

// Source: QUICKPASS sheet (OP 대표 #105271) — after 15 minutes blocked an operator may choose the manual path.
// Notice cadence only: the hold itself stays unbounded and fail-closed (recipes.yaml readiness-countdown timeout_ms 0).
export const COUNTDOWN_LONG_HOLD_NOTICE_MS = 15 * 60_000;

function writeCountdownState(path: string, state: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** T-60 image hold at the graph boundary; absent or mismatched producer data stays held. */
export async function waitForGateImageT60(context: ReadinessGraphContext, deps: ImageT60HoldDeps = {}): Promise<{
  version: string; runId: string; cutCommit: string; eta: string; signalPath: string;
}> {
  const version = context.input?.version;
  const runId = context.runId;
  const versionOutput = context.outputs?.['cut-branch'] ?? context.outputs?.['version-release'];
  const cutCommit = versionOutput && typeof versionOutput === 'object' && !Array.isArray(versionOutput)
    ? (versionOutput as { commit?: unknown }).commit : undefined;
  if (typeof version !== 'string' || typeof runId !== 'string' || typeof cutCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(cutCommit)) {
    throw new Error('readiness countdown requires graph runId, version, and version-release cut commit');
  }
  const root = deps.ledgerRoot ?? releaseLedgerRoot();
  const schedule = getSchedule(version, root);
  // 0.3.6 skips the new image signal contract, but every scheduled graph still
  // waits for its cut before progressing beyond this node.
  const versionParts = (isReleaseVersion(version) ? baseVersion(version) : version).split('.').map(Number);
  const before037 = versionParts[0]! === 0 && (versionParts[1]! < 3 || (versionParts[1]! === 3 && versionParts[2]! < 7));
  // A prerelease (rehearsal) run has no schedule row of its own: its cut is treated as already reached,
  // while the image T-60 signal contract below still applies. A stable version without a row holds SCHEDULE_MISSING (bounded) instead of failing.
  const prerelease = isReleaseVersion(version) && prereleaseKind(version) !== null;
  if (!schedule && before037) return { version, runId, cutCommit, eta: (deps.now ?? (() => new Date()))().toISOString(), signalPath: '' };
  if (schedule && !Number.isFinite(Date.parse(schedule.cutAt))) throw new Error(`readiness countdown has invalid cutAt: ${schedule.cutAt}`);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMilliseconds = deps.pollMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 1) throw new Error('pollMilliseconds must be a positive integer');
  if (before037) {
    while (true) {
      const currentSchedule = getSchedule(version, root);
      if (!currentSchedule || !Number.isFinite(Date.parse(currentSchedule.cutAt))) throw new Error(`readiness countdown schedule unavailable or invalid: ${version}`);
      const remaining = Date.parse(currentSchedule.cutAt) - now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMilliseconds, remaining));
    }
    const eta = now().toISOString();
    debug.log('release.schedule', 'countdown-ready', { version, runId, cutCommit, eta, signalPath: '' });
    return { version, runId, cutCommit, eta, signalPath: '' };
  }
  const signalPath = gateImageReadinessSignalPath(root, version);
  const statePath = join(root, 'release', version, 'readiness-countdown.json');
  const readSignal = deps.readSignal ?? readGateImageReadinessSignal;
  const prebuildSource = context.outputs?.['gate-image-prebuild'];
  const prebuild = (prebuildSource && typeof prebuildSource === 'object' && !Array.isArray(prebuildSource)
    ? (prebuildSource as { gateImagePrebuild?: unknown }).gateImagePrebuild : undefined)
    ?? (versionOutput && typeof versionOutput === 'object' && !Array.isArray(versionOutput)
      ? (versionOutput as { gateImagePrebuild?: unknown }).gateImagePrebuild : undefined);
  const attestation = prebuild && typeof prebuild === 'object' && !Array.isArray(prebuild)
    ? prebuild as { outcome?: unknown; runId?: unknown; cutCommit?: unknown; digest?: unknown; eligiblePools?: unknown } : null;
  const prebuildSucceeded = (attestation?.outcome === 'built' || attestation?.outcome === 'reused')
    && attestation.runId === runId && typeof attestation.cutCommit === 'string'
    && attestation.cutCommit.toLowerCase() === cutCommit.toLowerCase()
    && typeof attestation.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(attestation.digest)
    && Array.isArray(attestation.eligiblePools) && attestation.eligiblePools.length > 0
    && attestation.eligiblePools.every((pool) => typeof pool === 'string' && pool.trim());
  const poolSpec = typeof context.input?.gatePodPool === 'string' ? context.input.gatePodPool : undefined;
  const poolContexts = poolSpec ? parsePodPool(poolSpec).map((member) => member.context) : [];
  const hosts = poolHosts(poolSpec);
  const cutBase = versionOutput && typeof versionOutput === 'object' && !Array.isArray(versionOutput)
    ? (versionOutput as { base?: unknown }).base : undefined;
  const expectedBase = context.input?.branchCutBaseCommit;
  const probes = deps.probes ?? {};
  const receiptPath = countdownReceiptPath(root, version);
  let holdSince: number | null = null;
  let longHold: { since: string; codes: string[]; hint: string; notifiedAt: string } | null = null;
  let attempt = 0;
  let lastReason = '';
  let lastCutAt: string | null | undefined;
  while (true) {
    attempt++;
    const currentSchedule = getSchedule(version, root);
    if (currentSchedule && !Number.isFinite(Date.parse(currentSchedule.cutAt))) throw new Error(`readiness countdown schedule unavailable or invalid: ${version}`);
    const cutAt = currentSchedule?.cutAt ?? null;
    const instant = now();
    const observedAt = instant.toISOString();
    const fromCutAt = lastCutAt !== undefined && lastCutAt !== cutAt ? lastCutAt : undefined;
    const observed = readSignal(signalPath, { runId, cutCommit });
    const image: GateImageReadiness | { status: 'unknown'; reason: 'pool-mismatch' } = observed.status === 'unknown' ? observed
      : !(prebuildSucceeded && String(attestation!.digest).toLowerCase() === observed.signal.imageDigest.toLowerCase()
        && [...attestation!.eligiblePools as string[]].sort().join('\n') === [...observed.signal.eligiblePools].sort().join('\n'))
        ? { status: 'unknown', reason: 'prebuild-unconfirmed' }
        // T-30: the image must be loaded on the run's own pool, not merely somewhere.
        : poolContexts.length && !poolContexts.some((pool) => observed.signal.eligiblePools.includes(pool))
          ? { status: 'unknown', reason: 'pool-mismatch' } : observed;
    const conditions: CountdownConditions = {
      schedule: { present: currentSchedule !== null, exempt: prerelease },
      ...(typeof expectedBase === 'string' && expectedBase ? { baseSha: { expected: expectedBase, actual: typeof cutBase === 'string' ? cutBase : undefined } } : {}),
      image: { ready: image.status === 'ready', detail: image.status === 'ready' ? 'ready' : `image-t60:${image.reason}` },
      ...(probes.trafficPrep ? { traffic: probes.trafficPrep(version, { now: instant, cutAt }) } : {}),
      ...(probes.hostReachable && hosts.length ? { hosts: hosts.map((host) => ({ host, reachable: probes.hostReachable!(host) })) } : {}),
      ...(probes.credentials ? { credentials: probes.credentials() } : {}),
    };
    const verdict = evaluateCountdown('gate', conditions);
    const cutReached = cutAt === null || instant.getTime() >= Date.parse(cutAt);
    const ready = verdict.go && cutReached;
    const holdReason = verdict.holds.length
      ? verdict.holds.map((hold) => hold.code === 'IMAGE_NOT_READY' ? hold.detail : hold.code).join(',')
      : cutReached ? null : 'cut-time-constraint';
    const eta = ready ? observedAt : verdict.go ? cutAt : null;
    const phase = ready ? 'ready' : verdict.go ? 'countdown' : 'hold';
    holdSince = verdict.go ? null : holdSince ?? instant.getTime();
    if (holdSince === null) longHold = null;
    else if (instant.getTime() - holdSince >= COUNTDOWN_LONG_HOLD_NOTICE_MS
      && (longHold === null || instant.getTime() - Date.parse(longHold.notifiedAt) >= COUNTDOWN_LONG_HOLD_NOTICE_MS)) {
      // A long hold never fails the run: it tells the operator once per cadence that QUICKPASS is an option.
      longHold = { since: new Date(holdSince).toISOString(), codes: verdict.holds.map((hold) => hold.code), hint: quickpassHint(version), notifiedAt: observedAt };
      debug.log('release.schedule', 'countdown-long-hold', { version, runId, ...longHold, attempt });
    }
    const state = { version, runId, cutCommit, phase, eta, holdReason, signalPath, updatedAt: observedAt };
    writeCountdownState(statePath, state);
    writeCountdownReceipt(receiptPath, { schemaVersion: 1, version, runId, cutCommit, stage: verdict.stage, go: verdict.go, phase,
      holds: verdict.holds, skipped: verdict.skipped, cutAt, eta, attempt, holdSince: holdSince === null ? null : new Date(holdSince).toISOString(),
      longHold, evaluatedAt: observedAt });
    // The only failure exit of a hold: the release's own deadline — the schedule row's cut-due window
    // (RELEASE_CUT_DUE_WINDOW_MS, the same window dueReleaseCutEvents uses) has passed while still not GO.
    if (!verdict.go && cutAt !== null && instant.getTime() - Date.parse(cutAt) >= RELEASE_CUT_DUE_WINDOW_MS) {
      debug.log('release.schedule', 'countdown-window-expired', { version, runId, cutAt, codes: verdict.holds.map((hold) => hold.code), attempt });
      throw new Error(`readiness countdown RELEASE_WINDOW_EXPIRED: cut ${cutAt} is past its due window and still held by ${verdict.holds.map((hold) => `${hold.code} (${hold.detail})`).join('; ')} — ${quickpassHint(version)}`);
    }
    if (fromCutAt !== undefined) {
      debug.log('release.schedule', 'countdown-cut-time-changed', { version, runId, fromCutAt,
        cutAt, observedAt, eta, phase: state.phase, holdReason });
    }
    lastCutAt = cutAt;
    if (ready) {
      debug.log('release.schedule', 'countdown-ready', { version, runId, cutCommit, eta: observedAt, signalPath });
      return { version, runId, cutCommit, eta: observedAt, signalPath };
    }
    const reason = holdReason!;
    if (lastReason !== reason) {
      debug.log('release.schedule', 'countdown-hold', { version, runId, cutCommit, eta, reason, signalPath, cutAt });
      lastReason = reason;
    }
    await sleep(pollMilliseconds);
  }
}

function readIfPresent(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}

/** Read-only preflight; callers own acquiring and releasing run.lock around the graph. */
export function releaseReadiness(version: string, deps: ReleaseReadinessDeps = {}): ReleaseReadiness {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error(`release version must be x.y.z: ${version}`);
  const dir = join(deps.ledgerRoot ?? releaseLedgerRoot(), 'release', version);
  const record = readIfPresent(join(dir, 'release.json'));
  if (record) {
    const data = JSON.parse(record) as { publishedAt?: unknown };
    if (typeof data.publishedAt === 'string' && data.publishedAt.trim()) {
      return { ready: false, reason: 'already-published', details: data.publishedAt };
    }
  }
  const lock = readIfPresent(join(dir, 'run.lock'));
  if (lock) {
    let pid: unknown;
    try { pid = (JSON.parse(lock) as { pid?: unknown } | null)?.pid; }
    catch { pid = undefined; }
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && (deps.isPidAlive ?? isPidAlive)(pid)) {
      return { ready: false, reason: 'already-running', details: String(pid) };
    }
  }
  const schedule = getSchedule(version, deps.ledgerRoot);
  const now = (deps.now ?? (() => new Date()))();
  if (schedule && now.getTime() < Date.parse(schedule.cutAt) && !deps.allowBeforeCut) {
    debug.log('release.schedule', 'countdown-held', { version, cutAt: schedule.cutAt, landBy: schedule.landBy,
      observedAt: now.toISOString(), eta: schedule.cutAt, holdReason: 'cut-time-constraint' });
    return { ready: false, reason: 'before-cut', details: `before-cut (${formatKst(schedule.cutAt)})` };
  }
  // GATE-ENTRY-ALIGN: the same cut judgement as `release run`'s entry check and the checklist-gate node.
  const gate = (deps.checklist ?? ((v: string) => cutChecklistGate(v, schedule?.landBy, now)))(version);
  if (!gate.ok) {
    debug.log('release.schedule', 'countdown-held', { version, cutAt: schedule?.cutAt ?? null, observedAt: now.toISOString(), eta: null,
      holdReason: 'checklist-blocked', red: gate.red, undecided: gate.undecided, blocked: gate.blocked });
    return { ready: false, reason: 'checklist-blocked', details: gate };
  }
  debug.log('release.schedule', 'countdown-planned', { version, cutAt: schedule?.cutAt ?? null, observedAt: now.toISOString(),
    expectedEta: schedule && now.getTime() < Date.parse(schedule.cutAt) ? schedule.cutAt : now.toISOString(),
    phase: schedule && now.getTime() < Date.parse(schedule.cutAt) ? 'pre-cut' : 'go' });
  return { ready: true, reason: 'ready', details: gate };
}

async function runImageT60HoldCli(): Promise<void> {
  try {
    if (!process.argv.includes('--image-t60-hold')) throw new Error('usage: release-readiness.ts --image-t60-hold');
    const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
    if (!contextPath) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as ReadinessGraphContext;
    const result = await waitForGateImageT60(context, {
      probes: defaultCountdownProbes(releaseLedgerRoot(), (context.input ?? {}) as Record<string, unknown>),
    });
    console.log(JSON.stringify({ outcome: 'ok', ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) void runImageT60HoldCli();
