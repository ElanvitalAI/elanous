#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { evaluateWaiverEvent, readWaiverEvents, type WaiverEventDecision } from '../../src/release-loop/waiver-events.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import type { GateResult } from './gate-types.js';
import { emitNodeResult, latestGateOutput, readGraphContext, type GraphContext } from './node-verdict.js';
import { planAdaptiveGateHeal } from './adaptive-gate-heal.js';
import { macrophageEvidenceMatchesObservedGate, planMacrophageRepairLadder, type MacrophageRepairLadderDecision, type MacrophageRepairLadderInput } from '../../src/release-loop/macrophage-repair-ladder.js';
import type { GateTriageClass, GateTriageEvidence, GateTriageShadow } from './gate-triage-types.js';
import { parseRollingMainState, rollingMainReceiptIntact, type RollingMainReceipt } from './rolling-main-gate.js';
import { loadCutKeyDiffCommits, lookupMainSameKeyReceipts, triageFailureKeyDiff,
  type KeyDiffInput, type KeyDiffVerdict } from './gate-key-diff.js';
import { appendKnownFailOwnerLedger, auditKnownFailFailures, isKnownFailOwnerRecord,
  readKnownFailOwnerLedger, type KnownFailOwnerRecord } from './gate-shard-receipts.js';
export type { GateTriageClass, GateTriageEvidence, GateTriageShadow } from './gate-triage-types.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/** Repeated unmeasured results are routed to their owning cell, never converted into a pass. */
export function assignRepeatedUnmeasuredFailures(failureIds: readonly string[], prior: NonNullable<GateTriageEvidence['priorDecisions']>,
  commit: string, ownerCellByFailureId: Record<string, string>, threshold = 3): KnownFailOwnerRecord[] {
  if (!Number.isSafeInteger(threshold) || threshold < 1 || !COMMIT_SHA.test(commit)) return [];
  const ids = [...new Set(failureIds)].sort();
  return ids.flatMap(failureId => {
    let consecutive = 1;
    const matchingPrior: NonNullable<GateTriageEvidence['priorDecisions']> = [];
    for (const previous of [...prior].reverse()) {
      if (previous.classification !== 'unmeasured' || !previous.failureIds.includes(failureId)) break;
      matchingPrior.push(previous);
      consecutive++;
    }
    const candidate = { failureId, checklistCellId: ownerCellByFailureId[failureId] ?? '',
      firstSeenCommit: matchingPrior.at(-1)?.commit ?? commit };
    return consecutive >= threshold && isKnownFailOwnerRecord(candidate) ? [candidate] : [];
  });
}

function supportsIntroducedMainFixedPick(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return false;
  const [, majorText, minorText, patchText, prerelease] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  return major > 0 || minor > 3 || (minor === 3 && (patch > 7 || (patch === 7 && prerelease === undefined)));
}

export interface IntroducedMainFixedPickInput {
  readonly cutCommit: string;
  readonly mainTip: string;
  readonly firstParentBaseCommit: string;
  /** Complete main first-parent sequence, inclusive of merge base and main tip. */
  readonly firstParentCommits: readonly string[];
  readonly introducedIds: readonly string[];
  readonly cutResults: readonly { id: string; status: 'pass' | 'fail' | 'unmeasured' }[];
  readonly mainMeasurement?: { commit: string; runId: string; receiptSha256: string; receiptBody: string };
  readonly rollingRuns?: readonly { commit: string; status: 'green' | 'red' | 'unreusable'; introduced: readonly string[];
    receipt?: RollingMainReceipt }[];
}

export interface IntroducedMainFixedPick {
  readonly status: 'measured' | 'unmeasured';
  readonly reason: string;
  readonly candidates: readonly { failureId: string; commit: string; source: 'rolling-main-transition' | 'main-head-fallback' }[];
  readonly unverifiedCandidates: readonly { failureId: string; commit: string; status: 'unverified'; reason: 'execution receipt absent' }[];
  readonly firstParentCommits?: readonly string[];
}

type GateTriageShadowWithMainFixedPick = GateTriageShadow & {
  mainFixedPick?: IntroducedMainFixedPick;
  keyDiff?: KeyDiffVerdict[];
};

/** Consume only one key comparison per measured failure; malformed or missing rows cannot silently clear it. */
export function triageRegressionKeyDiffs(introducedIds: readonly string[], supplied: unknown,
  gitHistory?: { repo: string; mainTip: string; mainReceiptRoot: string }): KeyDiffVerdict[] {
  const rows = Array.isArray(supplied) ? supplied as KeyDiffInput[] : [];
  return introducedIds.map((failureId) => {
    const matches = rows.filter((row) => row && typeof row === 'object' && row.failureId === failureId);
    if (matches.length !== 1 || !Array.isArray(matches[0]?.commits) || !Array.isArray(matches[0]?.mainReceipts))
      return { status: 'unmeasured', failureId, reason: 'one complete key comparison is required per failure',
        changedInputs: [] };
    const row = matches[0]!;
    // Opaque closure evidence is itself sufficient to choose the conservative bisect fallback.
    // Do not let unavailable first-parent commit metadata erase that measured opacity.
    if (row.base?.opaqueReason || row.cut?.opaqueReason) return triageFailureKeyDiff(row);
    if (gitHistory) {
      const baseCommit = (row as KeyDiffInput & { baseCommit?: unknown }).baseCommit;
      const cutCommit = (row as KeyDiffInput & { cutCommit?: unknown }).cutCommit;
      const commits = typeof baseCommit === 'string' && typeof cutCommit === 'string'
        ? loadCutKeyDiffCommits(gitHistory.repo, baseCommit, cutCommit) : null;
      if (!commits) return { status: 'unmeasured', failureId,
        reason: 'cut first-parent append history is missing or inconsistent', changedInputs: [] };
      const mainReceipts = lookupMainSameKeyReceipts(gitHistory.mainReceiptRoot, row.cut,
        gitHistory.mainTip, gitHistory.repo);
      return triageFailureKeyDiff({ ...row, commits, mainReceipts });
    }
    return triageFailureKeyDiff(row);
  });
}

/** Suggest only the first measured first-parent point where a cut failure disappears. */
export function assessIntroducedMainFixedPick(input: IntroducedMainFixedPickInput): IntroducedMainFixedPick {
  const unmeasured = (reason: string, unverifiedCandidates: IntroducedMainFixedPick['unverifiedCandidates'] = [],
    firstParentCommits?: readonly string[]): IntroducedMainFixedPick =>
    ({ status: 'unmeasured', reason, candidates: [], unverifiedCandidates,
      ...(firstParentCommits ? { firstParentCommits: [...firstParentCommits] } : {}) });
  if (!COMMIT_SHA.test(input.cutCommit) || !COMMIT_SHA.test(input.mainTip)
      || !COMMIT_SHA.test(input.firstParentBaseCommit)
      || !Array.isArray(input.firstParentCommits) || !Array.isArray(input.introducedIds)
      || !Array.isArray(input.cutResults)
      || input.firstParentCommits.length < 2 || input.firstParentCommits[0] !== input.firstParentBaseCommit
      || input.firstParentCommits.at(-1) !== input.mainTip
      || input.firstParentCommits.some((commit) => !COMMIT_SHA.test(commit))
      || new Set(input.firstParentCommits).size !== input.firstParentCommits.length)
    return unmeasured('cut-to-main first-parent chain is incomplete or invalid');
  const ids = [...new Set(input.introducedIds)];
  if (!ids.length || ids.length !== input.introducedIds.length || ids.some((id) => typeof id !== 'string' || !id.trim()))
    return unmeasured('cut introduced failure identities are empty, duplicated, or invalid');
  const exactResults = (rows: readonly { id: string; status: string }[]) => rows.length === ids.length
    && rows.every((row) => row && typeof row.id === 'string' && typeof row.status === 'string')
    && new Set(rows.map((row) => row.id)).size === rows.length
    && ids.every((id) => rows.some((row) => row.id === id));
  if (!exactResults(input.cutResults) || input.cutResults.some((row) => row.status !== 'fail'))
    return unmeasured('cut remeasurement does not prove every introduced identity failed');
  let mainResults: readonly { id: string; status: 'pass' | 'fail' | 'unmeasured' }[] | undefined;
  if (input.mainMeasurement) {
    const measurement = input.mainMeasurement;
    if (measurement.commit === input.mainTip && /^[\w.-]{1,120}$/.test(measurement.runId)
        && /^[0-9a-f]{64}$/i.test(measurement.receiptSha256)
        && createHash('sha256').update(measurement.receiptBody).digest('hex') === measurement.receiptSha256) {
      try {
        const receipt = JSON.parse(measurement.receiptBody) as {
          schema?: unknown; complete?: unknown; runId?: unknown; commit?: unknown; results?: unknown;
        };
        if (receipt.schema === 'main-standalone-v1' && receipt.complete === true && receipt.runId === measurement.runId
            && receipt.commit === input.mainTip && Array.isArray(receipt.results)
            && exactResults(receipt.results) && receipt.results.every((row) => ['pass', 'fail', 'unmeasured'].includes(row.status))
            && !receipt.results.some((row) => row.status === 'unmeasured'))
          mainResults = receipt.results as readonly { id: string; status: 'pass' | 'fail' | 'unmeasured' }[];
      } catch {
        // Ignore unusable standalone evidence; an intact rolling receipt can still prove a transition.
      }
    }
  }
  const standaloneFallback = (reason: string): IntroducedMainFixedPick => {
    if (!input.mainMeasurement || !mainResults) {
      const claimedPasses = mainResults?.filter((row) => row.status === 'pass').map((row) => row.id) ?? ids;
      return unmeasured(reason, claimedPasses.map((failureId) => ({ failureId, commit: input.mainTip,
        status: 'unverified' as const, reason: 'execution receipt absent' as const })), input.firstParentCommits);
    }
    return { status: 'measured', reason, firstParentCommits: [...input.firstParentCommits],
      candidates: ids.flatMap((failureId) => mainResults!.find((row) => row.id === failureId)?.status === 'pass'
        ? [{ failureId, commit: input.mainTip, source: 'main-head-fallback' as const }] : []), unverifiedCandidates: [] };
  };
  if (input.rollingRuns === undefined) {
    return standaloneFallback('rolling-main state absent; main-head standalone measurements and verified first-parent range used as fallback');
  }
  const expectedRunCommits = input.firstParentCommits.slice(1);
  if (input.rollingRuns.length !== expectedRunCommits.length
      || input.rollingRuns.some((run, index) => run.commit !== expectedRunCommits[index]))
    return standaloneFallback('rolling-main range is incomplete; verified main-head standalone measurements used as fallback');
  for (const run of input.rollingRuns) {
    if (run.status === 'unreusable' || !Array.isArray(run.introduced)
        || run.introduced.some((id: unknown) => typeof id !== 'string'))
      return standaloneFallback(`rolling-main run ${run.commit} is unmeasured; standalone measurements used as fallback`);
    if (run.status === 'green' && (!run.receipt || run.receipt.commit !== run.commit
        || !rollingMainReceiptIntact(run.receipt) || run.introduced.length !== 0))
      return standaloneFallback(`rolling-main green receipt ${run.commit} is absent, changed, or inconsistent; standalone measurements used as fallback`);
    if (run.status === 'red' && run.receipt !== undefined)
      return standaloneFallback(`rolling-main red run ${run.commit} unexpectedly carries a green receipt; standalone measurements used as fallback`);
  }
  const candidates: Array<{ failureId: string; commit: string; source: 'rolling-main-transition' | 'main-head-fallback' }> = [];
  const unverifiedCandidates: IntroducedMainFixedPick['unverifiedCandidates'][number][] = [];
  for (const id of ids) {
    let observedMainFailure = false;
    let transitionAmbiguous = false;
    let currentRollingFailure = false;
    let latestGreen: { failureId: string; commit: string; source: 'rolling-main-transition' } | undefined;
    let latestUnverified: IntroducedMainFixedPick['unverifiedCandidates'][number] | undefined;
    for (const run of input.rollingRuns) {
      const stillIntroduced = run.introduced.includes(id);
      if (stillIntroduced) {
        observedMainFailure = true;
        transitionAmbiguous = false;
        if (run.commit === input.mainTip) currentRollingFailure = true;
        latestGreen = undefined;
        latestUnverified = { failureId: id, commit: run.commit, status: 'unverified', reason: 'execution receipt absent' };
      } else if (observedMainFailure && run.status === 'green' && run.receipt && rollingMainReceiptIntact(run.receipt)) {
        if (!transitionAmbiguous) {
          latestGreen ??= { failureId: id, commit: run.commit, source: 'rolling-main-transition' };
          latestUnverified = undefined;
        }
      } else if (observedMainFailure) {
        transitionAmbiguous = true;
        latestGreen = undefined;
        latestUnverified = { failureId: id, commit: run.commit, status: 'unverified', reason: 'execution receipt absent' };
      }
    }
    if (mainResults?.find((row) => row.id === id)?.status === 'fail') continue;
    if (latestGreen) candidates.push(latestGreen);
    else if (mainResults?.find((row) => row.id === id)?.status === 'pass' && !currentRollingFailure)
      candidates.push({ failureId: id, commit: input.mainTip, source: 'main-head-fallback' });
    else if (latestUnverified) unverifiedCandidates.push(latestUnverified);
    else unverifiedCandidates.push({ failureId: id, commit: input.mainTip,
      status: 'unverified', reason: 'execution receipt absent' });
  }
  return { status: candidates.length || mainResults ? 'measured' : 'unmeasured',
    reason: candidates.some((candidate) => candidate.source === 'rolling-main-transition')
      ? 'cut, main, first-parent sequence, and rolling-main receipt agree'
      : candidates.length ? 'main standalone receipt verifies the current main-head candidate'
      : mainResults ? 'main standalone receipt confirms no verified fix candidate at the current main tip'
        : 'no per-test transition receipt; suggestions are unverified',
    firstParentCommits: [...input.firstParentCommits], candidates,
    unverifiedCandidates: unverifiedCandidates.filter((item) => !candidates.some((candidate) => candidate.failureId === item.failureId)) };
}

function verifiedFirstParentRange(cutCommit: string, mainTip: string, supplied: unknown):
  { baseCommit: string; commits: string[] } | null {
  if (!COMMIT_SHA.test(cutCommit) || !COMMIT_SHA.test(mainTip)
      || (supplied !== undefined && (!Array.isArray(supplied) || !supplied.every((commit) => typeof commit === 'string')))) return null;
  const tip = spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (tip.status !== 0 || tip.stdout.trim() !== mainTip) return null;
  const remoteTip = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (remoteTip.status !== 0 || remoteTip.stdout.trim().split(/\s+/)[0] !== mainTip) return null;
  const mergeBase = spawnSync('git', ['merge-base', cutCommit, mainTip], { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const baseCommit = mergeBase.status === 0 ? mergeBase.stdout.trim() : '';
  if (!COMMIT_SHA.test(baseCommit)) return null;
  const history = spawnSync('git', ['rev-list', '--first-parent', '--reverse', `${baseCommit}..${mainTip}`],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (history.status !== 0) return null;
  const firstParentAncestors = spawnSync('git', ['rev-list', '--first-parent', mainTip],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (firstParentAncestors.status !== 0 || !firstParentAncestors.stdout.split(/\r?\n/).includes(baseCommit)) return null;
  const commits = [baseCommit, ...history.stdout.trim().split(/\r?\n/).filter(Boolean)];
  return supplied === undefined || JSON.stringify(commits) === JSON.stringify(supplied) ? { baseCommit, commits } : null;
}

function introducedMainFixedPickFromContext(context: GraphContext, supplied: unknown,
  introducedIds: readonly string[]): IntroducedMainFixedPick {
  const unmeasured = (reason: string, mainTip = '', firstParentCommits?: readonly string[]): IntroducedMainFixedPick => ({
    status: 'unmeasured', reason, candidates: [], unverifiedCandidates: mainTip
      ? introducedIds.map((failureId) => ({ failureId, commit: mainTip, status: 'unverified', reason: 'execution receipt absent' })) : [],
    ...(firstParentCommits ? { firstParentCommits: [...firstParentCommits] } : {}),
  });
  const value = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied as Record<string, unknown> : {};
  const cutCommit = typeof context.outputs.gate?.commit === 'string' ? context.outputs.gate.commit : '';
  const currentMain = spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8', timeout: 15_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  const mainTip = typeof value.mainTip === 'string' ? value.mainTip : currentMain.status === 0 ? currentMain.stdout.trim() : '';
  const firstParentRange = verifiedFirstParentRange(cutCommit, mainTip, value.firstParentCommits);
  if (!firstParentRange) return unmeasured('main tip or first-parent sequence does not match the local main history');
  const statePath = join(effectiveInstanceRoot(), 'release', context.input.version, 'rolling-main-gate.json');
  const measurementInfo = value.mainMeasurement && typeof value.mainMeasurement === 'object' && !Array.isArray(value.mainMeasurement)
    ? value.mainMeasurement as Record<string, unknown> : {};
  const runId = typeof measurementInfo.runId === 'string' ? measurementInfo.runId : '';
  const receiptSha256 = typeof measurementInfo.receiptSha256 === 'string' ? measurementInfo.receiptSha256 : '';
  let mainMeasurement: IntroducedMainFixedPickInput['mainMeasurement'];
  if (runId && /^[\w.-]{1,120}$/.test(runId) && /^[0-9a-f]{64}$/i.test(receiptSha256)
      && measurementInfo.commit === mainTip) {
    const measurementPath = join(effectiveInstanceRoot(), 'release', context.input.version, 'main-standalone', `${runId}.json`);
    try {
      const body = readFileSync(measurementPath, 'utf8');
      mainMeasurement = { commit: mainTip, runId, receiptSha256, receiptBody: body };
    } catch {
      // Missing or corrupt execution evidence yields only an explicitly unverified suggestion below.
    }
  }
  const measurement = { cutCommit: cutCommit as string, mainTip, firstParentBaseCommit: firstParentRange.baseCommit,
    firstParentCommits: firstParentRange.commits, introducedIds,
    cutResults: introducedIds.map((id) => ({ id, status: 'fail' as const })),
    ...(mainMeasurement ? { mainMeasurement } : {}) };
  try {
    const state = parseRollingMainState(readFileSync(statePath, 'utf8'), context.input.version);
    return assessIntroducedMainFixedPick({ ...measurement, rollingRuns: state.runs });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return assessIntroducedMainFixedPick(measurement);
    if (mainMeasurement) return assessIntroducedMainFixedPick(measurement);
    return unmeasured(`rolling-main state or reusable receipt unavailable: ${error instanceof Error ? error.message : String(error)}`,
      mainTip, firstParentRange.commits);
  }
}

/** Gate-triage reports eligible waiver events as evidence; it never consumes one. */
export function gateWaiverEventObservations(events: ReturnType<typeof readWaiverEvents>, context: {
  runId: string; head: string; now: number; measuredRegression: boolean; releaseEnded?: boolean;
}): Array<{ eventId: string; kind: string; target: string; mode: string; decision: WaiverEventDecision }> {
  return events.filter((event) => event.kind === 'gate').map((event) => ({
    eventId: event.eventId, kind: event.kind, target: event.target, mode: event.mode,
    decision: evaluateWaiverEvent(event, { target: `run:${context.runId}`, head: context.head, now: context.now,
      measuredRegression: context.measuredRegression, releaseEnded: context.releaseEnded ?? false }),
  }));
}

/** A prescription is selected from observed gate facts. Execution waits until the failed run is terminal. */
export type GatePrescription =
  | { action: 'rerun-pod'; reason: string; runId: string | null; commit: string; macrophageRepairLadder?: MacrophageRepairLadderDecision }
  | { action: 'repair-card'; reason: string; runId: string | null; commit: string; failureIds: string[]; macrophageRepairLadder?: MacrophageRepairLadderDecision }
  | { action: 'decision-card'; reason: string; runId: string | null; commit: string; macrophageRepairLadder?: MacrophageRepairLadderDecision }
  | { action: 'none'; reason: string; runId: string | null; commit: string; macrophageRepairLadder?: MacrophageRepairLadderDecision };

export function chooseGatePrescription(context: GraphContext, triage: GateTriageShadow): GatePrescription {
  const runId = context.runId ?? null;
  const common = { runId, commit: triage.commit };
  const hasLadderInput = Object.prototype.hasOwnProperty.call(context.input, 'macrophageRepairLadder');
  if (hasLadderInput) {
    const raw = context.input.macrophageRepairLadder;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...common, action: 'decision-card', reason: 'macrophage repair-ladder input is malformed' };
    }
    const ladderInput = raw as MacrophageRepairLadderInput;
    if (typeof context.runId !== 'string' || ladderInput.runId !== context.runId) {
      return { ...common, action: 'decision-card', reason: 'repair-ladder run id does not match the active release run' };
    }
    if (!Array.isArray(ladderInput.failureIds) || !ladderInput.failureIds.every((id) => typeof id === 'string')
      || JSON.stringify([...ladderInput.failureIds].sort()) !== JSON.stringify([...triage.failureIds].sort())) {
      return { ...common, action: 'decision-card', reason: 'repair-ladder failure IDs do not match the attributed gate failures' };
    }
    const gate = context.outputs.gate;
    if (!gate || typeof gate.outcome !== 'string' || gate.commit !== triage.commit
      || !macrophageEvidenceMatchesObservedGate(ladderInput.evidence, gate as never, triage)) {
      return { ...common, action: 'decision-card', reason: 'repair-ladder evidence contradicts the observed gate or triage result' };
    }
    const macrophageRepairLadder = planMacrophageRepairLadder(ladderInput);
    const ladderCommon = { ...common, macrophageRepairLadder };
    if (macrophageRepairLadder.action === 'no-op')
      return { ...ladderCommon, action: 'none', reason: macrophageRepairLadder.reason };
    if (macrophageRepairLadder.step === 'R0-remeasure')
      return { ...ladderCommon, action: 'decision-card', reason: 'same-slice isolated remeasurement executor is not connected' };
    if (macrophageRepairLadder.step === 'R1-single-file' || macrophageRepairLadder.step === 'R2-split-files')
      return { ...ladderCommon, action: 'decision-card', reason: `${macrophageRepairLadder.step} awaits a cut-append constrained executor` };
    return { ...ladderCommon, action: 'decision-card', reason: macrophageRepairLadder.reason };
  }
  const gate = context.outputs.gate;
  const unattributed = (Array.isArray(gate?.stalledShards)
    && gate.stalledShards.some((shard: unknown) => shard && typeof shard === 'object'
      && (shard as { reason?: unknown }).reason === 'unattributed'))
    || (typeof gate?.error === 'string' && /failure attribution (?:incomplete|summary=)|unattributed/.test(gate.error));
  if (triage.classification === 'exhausted')
    return { ...common, action: 'decision-card', reason: 'same gate symptom recurred twice' };
  if (unattributed && triage.introduced.length === 0 && context.input.gateExecutor === 'host')
    return { ...common, action: 'rerun-pod', reason: 'host gate attribution incomplete' };
  if (triage.classification === 'regression' && triage.introduced.length > 0)
    return { ...common, action: 'repair-card', reason: 'introduced gate regressions', failureIds: [...triage.introduced] };
  return { ...common, action: 'none', reason: `no evidence-backed automatic remedy for ${triage.classification}` };
}

function timeoutShape(gate: GateResult): boolean {
  return gate.stalledShards?.some((shard) => shard.reason === 'timeout' || shard.reason === 'no-output') === true
    || (gate.loadFlaky?.length ?? 0) > 0;
}

export function classifyGateShadow(gate: GateResult, evidence: GateTriageEvidence = {}): GateTriageShadow {
  const stalledFiles = [...new Set((gate.stalledShards ?? []).flatMap((shard) => shard.files))].sort();
  const failureIds = [...new Set([...gate.introduced, ...stalledFiles, ...gate.stalledEnv.map((item) => item.file)])].sort();
  let classification: GateTriageClass;
  let reason: string;

  const unmeasured = gate.stalledShards?.some((shard) => shard.reason !== 'timeout' && shard.reason !== 'no-output') === true;
  const loadExplainsIntroduced = gate.introduced.every((id) => gate.loadFlaky?.includes(id) === true
    && evidence.isolatedCheckedFailureIds?.includes(id) === true);
  const loadExplainsStalled = stalledFiles.every((file) => evidence.isolatedPassedFiles?.includes(file) === true);
  const noUnexplainedEnvironmentFailure = gate.stalledEnv.length === 0;
  const envFiles = new Set(gate.stalledEnv.filter((item) => item.local === 'passed').map((item) => item.file));
  const envExplainsIntroduced = gate.introduced.every((id) => envFiles.has(id.split(' > ', 1)[0]!)
    && evidence.environmentFailureIds?.includes(id) === true);
  const envExplainsStalled = stalledFiles.every((file) => envFiles.has(file));
  const allEnvironmentChecksPassed = gate.stalledEnv.length > 0 && gate.stalledEnv.every((item) => item.local === 'passed');
  if (unmeasured) {
    classification = 'unmeasured';
    reason = 'gate has unfinished or unattributed shard files';
  } else if ((gate.introduced.length > 0 || stalledFiles.length > 0)
    && timeoutShape(gate) && loadExplainsIntroduced && loadExplainsStalled && noUnexplainedEnvironmentFailure
    && evidence.highLoad === true && evidence.isolatedReproductions === 0) {
    classification = 'load';
    reason = 'timeout shape under observed load did not reproduce in isolation';
  } else if (gate.outcome !== 'ok' && allEnvironmentChecksPassed && envExplainsIntroduced && envExplainsStalled) {
    classification = 'env';
    reason = 'Pod environment failure passed outside the Pod';
  } else if (stalledFiles.length || (gate.outcome === 'error' && gate.introduced.length === 0)) {
    classification = 'unmeasured';
    reason = stalledFiles.length ? 'timeout-shaped files remain unmeasured' : 'gate errored without a measured regression';
  } else if (gate.introduced.length > 0 || gate.outcome === 'regression') {
    classification = 'regression';
    reason = 'gate measured an introduced regression';
  } else if (gate.outcome === 'ok') {
    classification = 'clean';
    reason = 'gate passed';
  } else {
    classification = 'unmeasured';
    reason = 'gate failure has no measured regression identity';
  }

  const measuredClassification = classification;
  const repeated = failureIds.length > 0 && evidence.priorDecisions?.slice(-2).length === 2
    && evidence.priorDecisions.slice(-2).every((prior) => prior.classification === classification
      && prior.commit === gate.commit
      && JSON.stringify([...prior.failureIds].sort()) === JSON.stringify(failureIds));
  if (classification !== 'clean' && repeated) {
    classification = 'exhausted';
    reason = 'the same class and failure identities already recurred twice';
  }
  const knownFailAudit = auditKnownFailFailures(failureIds, evidence.knownFailOwners);
  const unmeasuredOwnerAssignments = measuredClassification === 'unmeasured'
    ? assignRepeatedUnmeasuredFailures(gate.introduced, evidence.priorDecisions ?? [], gate.commit,
      evidence.ownerCellByFailureId ?? {}) : [];
  return { classification, reason, commit: gate.commit, introduced: [...gate.introduced], stalledFiles, failureIds,
    knownFailAudit, unmeasuredOwnerAssignments,
    evidence: { highLoad: evidence.highLoad ?? null, isolatedReproductions: evidence.isolatedReproductions ?? null,
      isolatedCheckedFailureIds: evidence.isolatedCheckedFailureIds ? [...evidence.isolatedCheckedFailureIds] : null,
      isolatedPassedFiles: evidence.isolatedPassedFiles ? [...evidence.isolatedPassedFiles] : null,
      environmentFailureIds: evidence.environmentFailureIds ? [...evidence.environmentFailureIds] : null,
      loadFlaky: gate.loadFlaky ? [...gate.loadFlaky] : null,
      stalledEnv: gate.stalledEnv.map((item) => ({ file: item.file, local: item.local })) },
    outcome: 'ok' };
}

/** Read only the completed gate output. The graph wiring is a separate change after M3. */
export function gateTriageShadowFromContext(context: GraphContext, evidence?: GateTriageEvidence,
  ledgerHistory: NonNullable<GateTriageEvidence['priorDecisions']> = []): GateTriageShadowWithMainFixedPick {
  const value = context.outputs.gate;
  if (!value || typeof value.commit !== 'string' || !Array.isArray(value.introduced)
    || !value.introduced.every((item) => typeof item === 'string')
    || !Array.isArray(value.stalledEnv)
    || !value.stalledEnv.every((item) => item && typeof item === 'object' && typeof item.file === 'string'
      && ['passed', 'failed', 'timeout'].includes(String(item.local)))
    || (value.stalledShards !== undefined && (!Array.isArray(value.stalledShards)
      || !value.stalledShards.every((item) => item && typeof item === 'object' && Array.isArray(item.files)
        && item.files.every((file: unknown) => typeof file === 'string') && typeof item.reason === 'string')))
    || (value.loadFlaky !== undefined && (!Array.isArray(value.loadFlaky)
      || !value.loadFlaky.every((item) => typeof item === 'string')))
    || !['ok', 'regression', 'fail', 'error'].includes(String(value.outcome))) {
    throw new Error('gate output is missing or malformed');
  }
  const input = context.input.gateTriageEvidence;
  const supplied = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const observed: GateTriageEvidence = evidence ?? {
    ...(supplied.highLoad === true ? { highLoad: true } : {}),
    ...(Number.isSafeInteger(supplied.isolatedReproductions) && Number(supplied.isolatedReproductions) >= 0
      ? { isolatedReproductions: Number(supplied.isolatedReproductions) } : {}),
    ...(Array.isArray(supplied.isolatedCheckedFailureIds) && supplied.isolatedCheckedFailureIds.every((id) => typeof id === 'string')
      ? { isolatedCheckedFailureIds: supplied.isolatedCheckedFailureIds as string[] } : {}),
    ...(Array.isArray(supplied.isolatedPassedFiles) && supplied.isolatedPassedFiles.every((file) => typeof file === 'string')
      ? { isolatedPassedFiles: supplied.isolatedPassedFiles as string[] } : {}),
    ...(Array.isArray(supplied.environmentFailureIds) && supplied.environmentFailureIds.every((id) => typeof id === 'string')
      ? { environmentFailureIds: supplied.environmentFailureIds as string[] } : {}),
    ...(Array.isArray(supplied.priorDecisions) && supplied.priorDecisions.every((item) => item && typeof item === 'object'
      && typeof item.classification === 'string' && typeof item.commit === 'string' && Array.isArray(item.failureIds)
      && item.failureIds.every((id: unknown) => typeof id === 'string'))
      ? { priorDecisions: supplied.priorDecisions as GateTriageEvidence['priorDecisions'] } : {}),
    ...(Array.isArray(supplied.knownFailOwners) ? { knownFailOwners: supplied.knownFailOwners } : {}),
    ...(supplied.ownerCellByFailureId && typeof supplied.ownerCellByFailureId === 'object'
      && !Array.isArray(supplied.ownerCellByFailureId)
      ? { ownerCellByFailureId: supplied.ownerCellByFailureId as Record<string, string> } : {}),
  };
  if (!observed.priorDecisions && ledgerHistory.length) observed.priorDecisions = ledgerHistory;
  // The graph adapter maps a measured gate regression to `fail` for edge routing.
  // Restore the gate verdict before classifying the shadow; keep the context untouched.
  const gate = value.outcome === 'fail' ? { ...value, outcome: 'regression' } : value;
  const expectedExecutionId = context.input.adaptiveGateExecutionId;
  if (expectedExecutionId !== undefined && (typeof expectedExecutionId !== 'string' ||
    typeof value.executionId !== 'string' || value.executionId !== expectedExecutionId)) {
    throw new Error('gate triage input does not match the latest gate execution id');
  }
  const shadow = { ...classifyGateShadow(gate as unknown as GateResult, observed),
    ...(typeof value.executionId === 'string' ? { gateExecutionId: value.executionId } : {}) };
  const mainReceiptRoot = supplied.mainFileReceiptRoot;
  const hasKeyDiffEvidence = supplied.regressionKeyDiff !== undefined && shadow.introduced.length > 0;
  const mainTip = hasKeyDiffEvidence
    ? spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8', timeout: 15_000 }) : undefined;
  const keyDiff = hasKeyDiffEvidence
    ? triageRegressionKeyDiffs(shadow.introduced, supplied.regressionKeyDiff,
      { repo: process.cwd(), mainTip: mainTip?.status === 0 ? mainTip.stdout.trim() : '',
        mainReceiptRoot: typeof mainReceiptRoot === 'string' ? mainReceiptRoot : '' }) : undefined;
  if ((value.introduced as string[]).length > 0
      && (supplied.introducedMainFixedPick !== undefined || supportsIntroducedMainFixedPick(context.input.version)))
    return { ...shadow, ...(keyDiff ? { keyDiff } : {}), mainFixedPick: introducedMainFixedPickFromContext(context, supplied.introducedMainFixedPick,
      value.introduced as string[]) };
  return { ...shadow, ...(keyDiff ? { keyDiff } : {}) };
}

export function logGateTriageShadow(result: GateTriageShadow, version: string): void {
  debug.log('graph.ground', 'gate-triage-shadow', { version, ...result });
}

/** Last two completed triage facts from distinct release runs on this exact cut commit. */
export function priorGateDecisionsFromLedger(context: GraphContext, root = effectiveInstanceRoot()): NonNullable<GateTriageEvidence['priorDecisions']> {
  const commit = context.outputs.gate?.commit;
  if (typeof commit !== 'string' || !commit) return [];
  const dir = join(root, 'graph-runs', 'release-loop');
  try {
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
      .map(name => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 200);
    const prior: NonNullable<GateTriageEvidence['priorDecisions']> = [];
    for (const { name } of files) {
      try {
        const state = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
        if (state.runId === context.runId || (state.input as Record<string, unknown> | undefined)?.version !== context.input.version) continue;
        const nodes = Array.isArray(state.nodes) ? state.nodes as Array<Record<string, unknown>> : [];
        const node = [...nodes].reverse().find(item => item.nodeId === 'gate-triage' && item.executed === true);
        const raw = node?.output;
        const output = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown> | undefined;
        if (output?.commit !== commit || !['unmeasured', 'load', 'env', 'regression', 'clean'].includes(String(output.classification))
          || !Array.isArray(output.failureIds) || !output.failureIds.every(id => typeof id === 'string')) continue;
        prior.push({ classification: output.classification as GateTriageClass, commit, failureIds: output.failureIds as string[] });
        if (prior.length === 2) break;
      } catch { /* Other runs may be incomplete while their ledger is being written. */ }
    }
    return prior.reverse();
  } catch { return []; }
}

/** A saved verdict has fewer fields than the live gate output. Keep the absent evidence absent. */
export function gateTriageShadowFromSavedVerdict(value: unknown): { version: string; result: GateTriageShadow } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid saved gate verdict');
  const saved = value as Record<string, unknown>;
  if (typeof saved.version !== 'string' || typeof saved.commit !== 'string'
    || !['ok', 'regression', 'error'].includes(String(saved.outcome))
    || !Array.isArray(saved.introduced) || !saved.introduced.every((id) => typeof id === 'string')
    || (saved.loadFlaky !== undefined && (!Array.isArray(saved.loadFlaky)
      || !saved.loadFlaky.every((id) => typeof id === 'string')))) throw new Error('invalid saved gate verdict');
  const gate: GateResult = { outcome: saved.outcome as GateResult['outcome'], commit: saved.commit,
    introduced: saved.introduced, preexisting: 0, fixed: null, knownEnv: 0, knownEnvCleared: [],
    stalledEnv: (saved.stalledEnv ?? []) as GateResult['stalledEnv'], rcNonzeroNoFailures: [], durationMs: 0,
    ...(saved.stalledShards !== undefined ? { stalledShards: saved.stalledShards as GateResult['stalledShards'] } : {}),
    ...(saved.loadFlaky !== undefined ? { loadFlaky: saved.loadFlaky as string[] } : {}) };
  const context: GraphContext = { input: { version: saved.version, previousVersion: '0.0.0' },
    outputs: { gate: gate as unknown as Record<string, unknown> } };
  return { version: saved.version, result: gateTriageShadowFromContext(context) };
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  let context: GraphContext | undefined;
  let errorVersion = 'unknown';
  try {
    const savedPath = process.argv[2] === '--gate-verdict' ? process.argv[3] : undefined;
    if (process.argv[2] && !savedPath) throw new Error('usage: gate-triage-node.ts [--gate-verdict <path>]');
    context = savedPath ? undefined : readGraphContext();
    if (context) {
      const currentGate = latestGateOutput(context);
      if (currentGate) context.outputs.gate = currentGate;
      else delete context.outputs.gate;
    }
    errorVersion = context?.input.version ?? 'unknown';
    if (context && !context.outputs.gate) throw new Error('gate output is missing; adaptive triage is unmeasured');
    const history = context ? priorGateDecisionsFromLedger(context) : [];
    const ownerLedger = context ? readKnownFailOwnerLedger(effectiveInstanceRoot()) : undefined;
    const rawTriageEvidence = context?.input.gateTriageEvidence;
    const suppliedTriageEvidence = rawTriageEvidence && typeof rawTriageEvidence === 'object'
      && !Array.isArray(rawTriageEvidence) ? rawTriageEvidence as Record<string, unknown> : {};
    const { version, result } = savedPath
      ? gateTriageShadowFromSavedVerdict(JSON.parse(readFileSync(savedPath, 'utf8')))
      : { version: context!.input.version, result: gateTriageShadowFromContext(context!, {
        ...suppliedTriageEvidence,
        knownFailOwners: ownerLedger?.writable
          ? [...ownerLedger.records, ...(Array.isArray(suppliedTriageEvidence.knownFailOwners) ? suppliedTriageEvidence.knownFailOwners : [])]
          : [],
      }, history) };
    if (context && ownerLedger?.writable) {
      try {
        appendKnownFailOwnerLedger(effectiveInstanceRoot(), [
          ...(Array.isArray(suppliedTriageEvidence.knownFailOwners) ? suppliedTriageEvidence.knownFailOwners : []),
          ...result.unmeasuredOwnerAssignments,
        ]);
      } catch (error) {
        debug.log('release-loop.gate', 'known-fail-owner-ledger-write-failed', { version,
          reason: error instanceof Error ? error.message : String(error) });
      }
    } else if (context && ownerLedger && !ownerLedger.writable) {
      debug.log('release-loop.gate', 'known-fail-owner-ledger-unreadable', { version,
        reason: 'failures remain residual; refusing to overwrite the ledger' });
    }
    logGateTriageShadow(result, version);
    const waiverEvents = readWaiverEvents(join(effectiveInstanceRoot(), 'review-results', 'waiver-events.jsonl'));
    const measuredRegression = Array.isArray(context?.outputs.gate?.introduced)
      && (context.outputs.gate.introduced as unknown[]).length > 0;
    const waiverEventObservations = context ? gateWaiverEventObservations(waiverEvents, { runId: context.runId ?? '',
      head: typeof context.outputs.gate?.commit === 'string' ? context.outputs.gate.commit : 'unknown', now: Date.now(),
      measuredRegression, releaseEnded: false }) : [];
    const gateOutput = context?.outputs.gate;
    const rawVisitState = context?.input.adaptiveHealVisitState;
    const visitState = rawVisitState && typeof rawVisitState === 'object' && !Array.isArray(rawVisitState)
      ? { gate: Number((rawVisitState as Record<string, unknown>).gate),
        gateTriage: Number((rawVisitState as Record<string, unknown>).gateTriage) } : undefined;
    const macroInputPresent = context ? Object.prototype.hasOwnProperty.call(context.input, 'macrophageRepairLadder') : false;
    const adaptiveHeal = context && gateOutput ? planAdaptiveGateHeal({ version, runId: context.runId ?? 'unknown',
      gate: (gateOutput.outcome === 'fail' ? { ...gateOutput, outcome: 'regression' } : gateOutput) as unknown as GateResult,
      triage: result, sourceOutcome: gateOutput.outcome as GateResult['outcome'] | 'fail',
      ...(visitState ? { visitState } : {}),
      ...(macroInputPresent
        ? { macrophageRepairLadder: context.input.macrophageRepairLadder as MacrophageRepairLadderInput } : {}),
      gateExecutor: context.input.gateExecutor === 'host' ? 'host' : 'pod',
      ...(typeof context.input.gatePodPool === 'string' ? { gatePodPool: context.input.gatePodPool } : {}) }) : undefined;
    if (adaptiveHeal) debug.log('release-loop.heal', 'prescription-issued', { version, runId: context?.runId ?? null,
      disposition: adaptiveHeal.disposition });
    if (adaptiveHeal) for (const event of adaptiveHeal.events)
      debug.log('release-loop.heal', event.name, { version, runId: context?.runId ?? null, ...event.data });
    const outcome = adaptiveHeal?.disposition.action === 'decision-required' ? 'fail' : result.outcome;
    emitNodeResult<Record<string, unknown>>({ ...result, outcome, waiverEventObservations,
      ...(adaptiveHeal ? { prescription: adaptiveHeal.disposition, adaptiveHeal } : {}),
      verdict: result.outcome === 'ok' ? 'pass' : 'fail',
      summary: adaptiveHeal ? `gate-triage live plan: ${adaptiveHeal.disposition.action}`
        : `gate-triage shadow: ${result.classification} — ${result.reason}` });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result: GateTriageShadow = { outcome: 'error', classification: 'unmeasured', reason,
      commit: 'unknown', introduced: [], stalledFiles: [], failureIds: [],
      knownFailAudit: { covered: [], residual: [] }, unmeasuredOwnerAssignments: [],
      evidence: { highLoad: null, isolatedReproductions: null, isolatedCheckedFailureIds: null,
        isolatedPassedFiles: null, environmentFailureIds: null, loadFlaky: null, stalledEnv: [] } };
    logGateTriageShadow(result, 'unknown');
    const adaptiveHeal = planAdaptiveGateHeal({ version: errorVersion, runId: context?.runId ?? 'unknown', sourceOutcome: 'error',
      gate: { outcome: 'error', commit: 'unknown', introduced: [], preexisting: 0, fixed: null, knownEnv: 0,
        knownEnvCleared: [], stalledEnv: [], rcNonzeroNoFailures: [], durationMs: 0, error: reason }, triage: result });
    for (const event of adaptiveHeal.events) debug.log('release-loop.heal', event.name, { version: errorVersion,
      runId: context?.runId ?? null, ...event.data });
    emitNodeResult({ ...result, outcome: 'fail', prescription: adaptiveHeal.disposition, adaptiveHeal,
      verdict: 'fail', summary: `gate-triage failed closed: ${reason}` });
    process.exitCode = 1;
  }
}
