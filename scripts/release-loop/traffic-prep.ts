// RELEASE-TRAFFIC-PREP-T1H — OP 대표 #108102: «예행·발행 런 1시간 전 트래픽 컨트롤 필수».
// The T-1h step applies the same release traffic writer the graph's traffic nodes use (cut-start: global gate,
// pre-cut traffic measured into releaseLifecycle.beforeCut) under a prep run id, then records a receipt.
// The run's own traffic-cut-start inherits that measured beforeCut (same version, later run, stage 0), so
// traffic-failed-restore still returns to the pre-prep traffic. The cut-branch node refuses to start without
// a valid receipt for this exact run version (stable and rc alike): it holds TRAFFIC_NOT_PREPPED, re-evaluates
// within a bounded budget, then fails with the reason codes and the QUICKPASS hint (no setting, no bypass).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { getSchedule } from '../../src/release-loop/release-schedule.js';
import type { GraphContext } from './node-verdict.js';
import { baseVersion, isReleaseVersion, prereleaseKind } from './release-version.js';
import { applyReleaseTrafficEvent, type TrafficTransitionOptions } from './traffic-transition.js';

export const TRAFFIC_PREP_RECEIPT_SCHEMA = 'release-traffic-prep/v1';
/** Source: OP 대표 #108102 — traffic control runs one hour before the rehearsal or release run. */
export const TRAFFIC_PREP_LEAD_MS = 60 * 60_000;
/** Source: dueReleaseCutEvents (release-schedule.ts) — a cut is still due up to 24h after cutAt. */
export const TRAFFIC_PREP_VALID_AFTER_CUT_MS = 24 * 3_600_000;
export const TRAFFIC_PREP_NODE_ID = 'traffic-prep';

export interface TrafficPrepReceipt {
  schema: typeof TRAFFIC_PREP_RECEIPT_SCHEMA;
  /** Exact run version: `0.3.31` for the release run, `0.3.31-rc.0` for the rc rehearsal. */
  version: string;
  baseVersion: string;
  prerelease: string | null;
  cutAt: string;
  /** cutAt − 1h: prep is accepted from here … */
  windowStart: string;
  /** … up to cutAt. */
  windowEnd: string;
  /** cutAt + 24h: the cut-branch guard rejects the receipt after this instant (stale). */
  validUntil: string;
  appliedAt: string;
  prepRunId: string;
  /** origin/main HEAD observed at prep time (the cut commit does not exist yet); null when unreadable. */
  baseSha: string | null;
  trafficFile: string;
  /** sha256 of the traffic file bytes right after the prep transition. */
  trafficFileSha256: string;
  trafficResult: 'applied' | 'already-applied';
  restoredAt?: string;
  /** Graph node only: applied after cutAt (a late run) but within validUntil — the guard accepts it only with this stamp. */
  late?: boolean;
  /** Graph node only: the operator's T-1h prep run id this release run took the traffic control over from. */
  takenOverFrom?: string;
}

export interface TrafficPrepDeps {
  now?: () => Date;
  /** Instance root holding release/<v>/traffic-prep.json (default: effective instance root). */
  root?: string;
  /** Schedule lookup by stable version (default: release-schedule getSchedule). */
  schedule?: (version: string) => { cutAt: string } | null;
  baseSha?: () => string | null;
  traffic?: TrafficTransitionOptions;
}

export function trafficPrepReceiptPath(version: string, root = effectiveInstanceRoot()): string {
  return join(root, 'release', version, 'traffic-prep.json');
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

function cutWindow(cutAt: string): { cut: number; windowStart: string; windowEnd: string; validUntil: string } {
  const cut = Date.parse(cutAt);
  if (!Number.isFinite(cut)) throw new Error(`invalid cutAt: ${cutAt}`);
  return { cut, windowStart: iso(cut - TRAFFIC_PREP_LEAD_MS), windowEnd: iso(cut), validUntil: iso(cut + TRAFFIC_PREP_VALID_AFTER_CUT_MS) };
}

function scheduledCutAt(version: string, deps: TrafficPrepDeps): string | null {
  return (deps.schedule ?? ((v: string) => getSchedule(v)))(baseVersion(version))?.cutAt ?? null;
}

/** The prep cut instant: an explicit --cut-at (required for an rc rehearsal) or the stable schedule cutAt. */
export function resolvePrepCutAt(version: string, cutAt: string | undefined, deps: TrafficPrepDeps = {}): string {
  const scheduled = scheduledCutAt(version, deps);
  if (cutAt !== undefined) {
    const parsed = Date.parse(cutAt);
    if (!Number.isFinite(parsed)) throw new Error(`invalid --cut-at: ${cutAt}`);
    const normalized = iso(parsed);
    if (!prereleaseKind(version) && scheduled && Date.parse(scheduled) !== parsed)
      throw new Error(`--cut-at ${normalized} differs from the ${version} schedule cutAt ${scheduled}`);
    return normalized;
  }
  if (prereleaseKind(version)) throw new Error(`rc rehearsal ${version} needs --cut-at <rehearsal run start ISO>`);
  if (!scheduled) throw new Error(`no release schedule for ${version}; set it or pass --cut-at`);
  return iso(Date.parse(scheduled));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeReceipt(path: string, receipt: TrafficPrepReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function readTrafficPrepReceipt(version: string, root = effectiveInstanceRoot()): TrafficPrepReceipt | null {
  const path = trafficPrepReceiptPath(version, root);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as TrafficPrepReceipt;
}

function prepContext(version: string, prepRunId: string, startedAt: string): GraphContext {
  // previousVersion is unused by the traffic writer; the base version keeps the GraphContext shape valid.
  return { graphId: 'release-loop', nodeId: TRAFFIC_PREP_NODE_ID, runId: prepRunId, startedAt,
    input: { version, previousVersion: baseVersion(version) }, outputs: {} };
}

export type TrafficPrepResult =
  | { ok: true; receiptPath: string; receipt: TrafficPrepReceipt }
  | { ok: false; reason: string; detail: string; receiptPath: string };

/** Apply the T-1h traffic control for one run version and write its receipt; refuses outside [cutAt−1h, cutAt]. */
export async function runTrafficPrep(input: { version: string; cutAt?: string }, deps: TrafficPrepDeps = {}): Promise<TrafficPrepResult> {
  const { version } = input;
  if (!isReleaseVersion(version)) throw new Error(`invalid release version: ${version}`);
  const root = deps.root ?? effectiveInstanceRoot();
  const receiptPath = trafficPrepReceiptPath(version, root);
  const now = (deps.now ?? (() => new Date()))();
  const cutAt = resolvePrepCutAt(version, input.cutAt, deps);
  const window = cutWindow(cutAt);
  const at = now.getTime();
  if (at < Date.parse(window.windowStart) || at > window.cut) {
    const detail = `${now.toISOString()} is outside the traffic-prep window ${window.windowStart} … ${window.windowEnd}`;
    debug.log('release-loop.traffic-prep', 'refused', { version, cutAt, reason: 'outside-window', detail });
    return { ok: false, reason: 'outside-window', detail, receiptPath };
  }
  const trafficFile = deps.traffic?.trafficFile;
  if (!trafficFile) return { ok: false, reason: 'traffic-file-unset', detail: 'release.loop.trafficFile is not configured', receiptPath };
  const prior = readTrafficPrepReceipt(version, root);
  // A repeated prep for the same cut is idempotent under the first application's run id and stamp;
  // after a restore, a new prep is a later run of the same version (the writer orders runs by startedAt).
  const repeat = prior && prior.cutAt === cutAt && !prior.restoredAt ? prior : null;
  const startedAt = repeat ? repeat.appliedAt : now.toISOString();
  const prepRunId = repeat ? repeat.prepRunId : `${TRAFFIC_PREP_NODE_ID}:${version}:${startedAt}`;
  const result = await applyReleaseTrafficEvent(prepContext(version, prepRunId, startedAt), 'cut-start',
    { ...deps.traffic, trafficFile, now: () => now });
  if (!result.applied) {
    const detail = `traffic-prep transition not applied: ${result.reason ?? 'unknown'}`;
    debug.log('release-loop.traffic-prep', 'refused', { version, cutAt, reason: 'transition-ignored', detail });
    return { ok: false, reason: 'transition-ignored', detail, receiptPath };
  }
  const receipt: TrafficPrepReceipt = {
    schema: TRAFFIC_PREP_RECEIPT_SCHEMA, version, baseVersion: baseVersion(version), prerelease: prereleaseKind(version),
    cutAt, windowStart: window.windowStart, windowEnd: window.windowEnd, validUntil: window.validUntil,
    appliedAt: startedAt, prepRunId, baseSha: (deps.baseSha ?? (() => null))(),
    trafficFile: resolve(trafficFile), trafficFileSha256: sha256File(resolve(trafficFile)),
    trafficResult: result.reason === 'already-applied' ? 'already-applied' : 'applied',
  };
  writeReceipt(receiptPath, receipt);
  debug.log('release-loop.traffic-prep', 'applied', { version, cutAt, prepRunId, receiptPath, trafficResult: receipt.trafficResult });
  return { ok: true, receiptPath, receipt };
}

/** Undo a prep whose run will not start: restores the pre-prep traffic and marks the receipt unusable. */
export async function restoreTrafficPrep(version: string, deps: TrafficPrepDeps = {}): Promise<TrafficPrepResult> {
  const root = deps.root ?? effectiveInstanceRoot();
  const receiptPath = trafficPrepReceiptPath(version, root);
  const receipt = readTrafficPrepReceipt(version, root);
  if (!receipt) return { ok: false, reason: 'missing', detail: `no traffic-prep receipt at ${receiptPath}`, receiptPath };
  const trafficFile = deps.traffic?.trafficFile ?? receipt.trafficFile;
  const now = (deps.now ?? (() => new Date()))();
  const result = await applyReleaseTrafficEvent({ ...prepContext(version, receipt.prepRunId, receipt.appliedAt), nodeId: 'traffic-failed-restore' },
    'failed', { ...deps.traffic, trafficFile, now: () => now });
  if (!result.applied && result.reason !== 'already-restored')
    return { ok: false, reason: 'transition-ignored', detail: `traffic-prep restore not applied: ${result.reason ?? 'unknown'}`, receiptPath };
  const restored = { ...receipt, restoredAt: now.toISOString() };
  writeReceipt(receiptPath, restored);
  debug.log('release-loop.traffic-prep', 'restored', { version, prepRunId: receipt.prepRunId, receiptPath });
  return { ok: true, receiptPath, receipt: restored };
}

export type TrafficPrepGuardResult =
  | { ok: true; receiptPath: string; receipt: TrafficPrepReceipt }
  | { ok: false; reason: 'missing' | 'invalid' | 'version-mismatch' | 'restored' | 'outside-window' | 'rescheduled' | 'stale' | 'not-in-effect';
    detail: string; receiptPath: string };

/** Cut-branch entry guard: a receipt for this exact run version, applied inside its window, still in effect. */
export function checkTrafficPrepReceipt(version: string, deps: TrafficPrepDeps & { runId?: string } = {}): TrafficPrepGuardResult {
  const root = deps.root ?? effectiveInstanceRoot();
  const receiptPath = trafficPrepReceiptPath(version, root);
  const refuse = (reason: Extract<TrafficPrepGuardResult, { ok: false }>['reason'], detail: string): TrafficPrepGuardResult =>
    ({ ok: false, reason, detail, receiptPath });
  let receipt: TrafficPrepReceipt | null;
  try { receipt = readTrafficPrepReceipt(version, root); }
  catch (error) { return refuse('invalid', `unreadable traffic-prep receipt: ${error instanceof Error ? error.message : String(error)}`); }
  if (!receipt) return refuse('missing', `no traffic-prep receipt for ${version}: run \`elanous release traffic-prep --version ${baseVersion(version)}${prereleaseKind(version) ? ` --prerelease ${prereleaseKind(version)} --cut-at <iso>` : ''}\` at cutAt−1h`);
  if (receipt.schema !== TRAFFIC_PREP_RECEIPT_SCHEMA || typeof receipt.cutAt !== 'string' || typeof receipt.appliedAt !== 'string')
    return refuse('invalid', `traffic-prep receipt has an unknown shape at ${receiptPath}`);
  if (receipt.version !== version) return refuse('version-mismatch', `traffic-prep receipt is for ${receipt.version}, not ${version}`);
  if (receipt.restoredAt) return refuse('restored', `traffic-prep for ${version} was restored at ${receipt.restoredAt}`);
  let window: ReturnType<typeof cutWindow>;
  try { window = cutWindow(receipt.cutAt); } catch (error) { return refuse('invalid', (error as Error).message); }
  const applied = Date.parse(receipt.appliedAt);
  // A late run's graph node applies after cutAt but within validUntil and stamps `late: true` (never implied).
  const lateApplied = receipt.late === true && applied > window.cut && applied <= Date.parse(window.validUntil);
  if (!Number.isFinite(applied) || applied < Date.parse(window.windowStart) || (applied > window.cut && !lateApplied))
    return refuse('outside-window', `traffic-prep applied at ${receipt.appliedAt}, outside ${window.windowStart} … ${window.windowEnd}`);
  if (!prereleaseKind(version)) {
    const scheduled = scheduledCutAt(version, deps);
    if (scheduled && Date.parse(scheduled) !== window.cut)
      return refuse('rescheduled', `traffic-prep cutAt ${receipt.cutAt} no longer matches the schedule cutAt ${scheduled}`);
  }
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (now < applied || now > Date.parse(window.validUntil))
    return refuse('stale', `traffic-prep receipt for cut ${receipt.cutAt} is not valid at ${iso(now)} (valid ${receipt.appliedAt} … ${window.validUntil})`);
  const trafficFile = deps.traffic?.trafficFile ?? receipt.trafficFile;
  if (trafficFile) {
    let lifecycle: { runId?: unknown; stage?: unknown } | undefined;
    try { lifecycle = (JSON.parse(readFileSync(resolve(trafficFile), 'utf8')) as { releaseLifecycle?: typeof lifecycle }).releaseLifecycle; }
    catch (error) { return refuse('not-in-effect', `traffic file unreadable: ${error instanceof Error ? error.message : String(error)}`); }
    // The run that consumed the prep (its own traffic-cut-start already took over) is still in effect.
    const current = lifecycle?.runId === receipt.prepRunId || (deps.runId !== undefined && lifecycle?.runId === deps.runId);
    if (!current || (lifecycle?.runId === receipt.prepRunId && lifecycle?.stage !== 0))
      return refuse('not-in-effect', `traffic file no longer carries the prep control ${receipt.prepRunId} (now ${String(lifecycle?.runId ?? 'none')} stage ${String(lifecycle?.stage ?? 'none')})`);
  }
  return { ok: true, receiptPath, receipt };
}

/** Hold code shared with the Go/No-Go countdown (RELEASE-COUNTDOWN-IN-GRAPH, PR #39159 HOLD_CODES). Never rename. */
export const TRAFFIC_NOT_PREPPED = 'TRAFFIC_NOT_PREPPED';
export type TrafficPrepHoldReason = Extract<TrafficPrepGuardResult, { ok: false }>['reason'];
// Source: QUICKPASS sheet (OP 대표 #105271) — a graph run blocked 15 minutes switches to the manual path (same bound as #39159).
export const TRAFFIC_PREP_HOLD_BUDGET_MS = 15 * 60_000;
// Source: release-readiness.ts waitForGateImageT60 — the countdown re-evaluates every 30 seconds.
export const TRAFFIC_PREP_HOLD_POLL_MS = 30_000;
export function trafficPrepQuickpassHint(version: string): string {
  return `QUICKPASS: graph path blocked for v${version} — OP explicitly runs \`eln release prepare --version ${version} --source <cut> --out <prepared>\`, verifies cut and notes, then \`eln release publish --dir <prepared> --notes-file <approved-notes> --yes\`; critpath cannot auto-publish without out-of-band proof`;
}

export interface TrafficPrepHold { code: typeof TRAFFIC_NOT_PREPPED; reason: TrafficPrepHoldReason; detail: string; receiptPath: string;
  attempts: number; heldMs: number; budgetMs: number }

export class TrafficPrepHoldError extends Error {
  constructor(readonly hold: TrafficPrepHold, version: string) {
    super(`${TRAFFIC_NOT_PREPPED}(${hold.reason}): ${hold.detail} — hold budget ${hold.budgetMs / 60_000} min exhausted after ${hold.attempts} evaluations — ${trafficPrepQuickpassHint(version)}`);
  }
}

export interface TrafficPrepHoldDeps {
  check?: () => TrafficPrepGuardResult;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  pollMs?: number;
  budgetMs?: number;
  onHold?: (hold: TrafficPrepHold) => void;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Cut-branch entry: GO on a valid receipt; otherwise hold TRAFFIC_NOT_PREPPED(<reason>) and re-evaluate (the prep may
 * still be applied inside its window) until the bounded budget is spent, then throw TrafficPrepHoldError with the hint.
 */
export function awaitTrafficPrep(version: string, deps: TrafficPrepHoldDeps & { root?: string; runId?: string } = {}): TrafficPrepReceipt {
  const check = deps.check ?? (() => checkTrafficPrepReceipt(version, { ...(deps.root ? { root: deps.root } : {}), ...(deps.runId !== undefined ? { runId: deps.runId } : {}) }));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepSync;
  const pollMs = deps.pollMs ?? TRAFFIC_PREP_HOLD_POLL_MS;
  const budgetMs = deps.budgetMs ?? TRAFFIC_PREP_HOLD_BUDGET_MS;
  const since = now();
  for (let attempts = 1; ; attempts++) {
    const verdict = check();
    if (verdict.ok) {
      if (attempts > 1) debug.log('release-loop.traffic-prep', 'hold-cleared', { version, attempts, heldMs: now() - since });
      return verdict.receipt;
    }
    const heldMs = now() - since;
    const hold: TrafficPrepHold = { code: TRAFFIC_NOT_PREPPED, reason: verdict.reason, detail: verdict.detail, receiptPath: verdict.receiptPath,
      attempts, heldMs, budgetMs };
    debug.log('release-loop.traffic-prep', 'hold', { version, runId: deps.runId, ...hold });
    deps.onHold?.(hold);
    if (heldMs >= budgetMs) throw new TrafficPrepHoldError(hold, version);
    sleep(Math.min(pollMs, budgetMs - heldMs));
  }
}

export type TrafficPrepRunResult =
  | { ok: true; receiptPath: string; receipt: TrafficPrepReceipt; reused: boolean }
  | { ok: false; reason: 'before-window'; detail: string; receiptPath: string; cutAt: string; windowStart: string }
  | { ok: false; reason: 'stale' | 'traffic-file-unset' | 'transition-ignored'; detail: string; receiptPath: string; cutAt?: string };

/**
 * RELEASE-TRAFFIC-PREP-T1H graph node (`traffic-prep`, before `cut-branch`): the release run applies its own T-1h
 * traffic control under its run id, so the run's traffic-cut-start is an idempotent same-run step and its
 * traffic-failed-restore returns to the pre-prep baseline measured here.
 * - A valid receipt for this run version (the operator's manual prep, or this run's own on resume) is reused: its
 *   cutAt, appliedAt and late stamp are kept and the run takes the traffic control over (`takenOverFrom`).
 * - Otherwise the cut is the stable schedule cutAt; an rc rehearsal (or a stable run without a schedule row) has no
 *   scheduled cut, so this entry instant — the run start — is its cutAt, exactly like the CLI's `--cut-at <run start>`.
 * - Before cutAt−1h it returns `before-window` (the node holds); inside the window it applies; after cutAt and up to
 *   validUntil (cutAt+24h) it still applies and stamps `late: true` (a late run is never skipped); past validUntil it
 *   returns `stale` (the countdown would fail RELEASE_WINDOW_EXPIRED on the same cut anyway).
 */
export async function runTrafficPrepForRun(input: { version: string; runId: string }, deps: TrafficPrepDeps = {}): Promise<TrafficPrepRunResult> {
  const { version, runId } = input;
  if (!isReleaseVersion(version)) throw new Error(`invalid release version: ${version}`);
  if (!runId) throw new Error('traffic-prep node requires the graph runId');
  const root = deps.root ?? effectiveInstanceRoot();
  const receiptPath = trafficPrepReceiptPath(version, root);
  const now = (deps.now ?? (() => new Date()))();
  const at = now.getTime();
  const trafficFile = deps.traffic?.trafficFile;
  if (!trafficFile) return { ok: false, reason: 'traffic-file-unset', detail: 'release.loop.trafficFile is not configured', receiptPath };
  const existing = checkTrafficPrepReceipt(version, { ...deps, root, now: () => now, runId });
  const kept = existing.ok ? existing.receipt : null;
  const cutAt = kept ? kept.cutAt : (!prereleaseKind(version) ? scheduledCutAt(version, deps) : null) ?? now.toISOString();
  const window = cutWindow(cutAt);
  if (!kept && at < Date.parse(window.windowStart)) {
    return { ok: false, reason: 'before-window', receiptPath, cutAt, windowStart: window.windowStart,
      detail: `${now.toISOString()} is before the traffic-prep window ${window.windowStart} … ${window.windowEnd}` };
  }
  if (!kept && at > Date.parse(window.validUntil)) {
    return { ok: false, reason: 'stale', receiptPath, cutAt,
      detail: `${now.toISOString()} is past the cut ${cutAt} validity ${window.validUntil}; the release window has expired` };
  }
  // The lifecycle orders runs by startedAt: this instant is later than any prep or failed run it supersedes.
  const result = await applyReleaseTrafficEvent(prepContext(version, runId, now.toISOString()), 'cut-start',
    { ...deps.traffic, trafficFile, now: () => now });
  if (!result.applied) {
    const detail = `traffic-prep transition not applied: ${result.reason ?? 'unknown'}`;
    debug.log('release-loop.traffic-prep', 'refused', { version, runId, cutAt, reason: 'transition-ignored', detail });
    return { ok: false, reason: 'transition-ignored', detail, receiptPath, cutAt };
  }
  const takenOverFrom = kept && kept.prepRunId !== runId ? kept.prepRunId : kept?.takenOverFrom;
  const receipt: TrafficPrepReceipt = {
    schema: TRAFFIC_PREP_RECEIPT_SCHEMA, version, baseVersion: baseVersion(version), prerelease: prereleaseKind(version),
    cutAt, windowStart: window.windowStart, windowEnd: window.windowEnd, validUntil: window.validUntil,
    appliedAt: kept ? kept.appliedAt : now.toISOString(), prepRunId: runId,
    baseSha: kept ? kept.baseSha : (deps.baseSha ?? (() => null))(),
    trafficFile: resolve(trafficFile), trafficFileSha256: sha256File(resolve(trafficFile)),
    trafficResult: result.reason === 'already-applied' ? 'already-applied' : 'applied',
    late: kept ? kept.late === true : at > window.cut,
    ...(takenOverFrom ? { takenOverFrom } : {}),
  };
  writeReceipt(receiptPath, receipt);
  debug.log('release-loop.traffic-prep', 'node-applied', { version, runId, cutAt, receiptPath, late: receipt.late,
    reused: kept !== null, takenOverFrom, trafficResult: receipt.trafficResult });
  return { ok: true, receiptPath, receipt, reused: kept !== null };
}
