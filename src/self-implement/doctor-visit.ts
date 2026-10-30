import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../util/spawn-sync-output.js';
import { debug } from '../debug/log.js';
import { readRunChart, recordRunChartDecision } from './run-chart.js';
import { selectKnowhowPack } from './knowhow-pack.js';
import { loadReviewRoundBrief, type ReviewRoundBrief } from './review-round-brief.js';
import { findIncidentPrecedents, type IncidentPrecedent } from '../harness/harness-incidents.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import {
  appendRunLedgerEntry,
  appendRunLedgerEntryChecked,
  listRunLedgers,
  loadRunLedger,
  lookupRunLedger,
  runLedgerDir,
  type RunLedgerCheckedAppendOutcome,
  type RunLedgerLookupOptions,
} from './run-ledger.js';
import { pickAutohealAction, type AutohealAction } from './stop-autoheal.js';
import { RUN_STOP_CLASSES, type RunStopClass } from './run-stop.js';
/** 사고 원장 루트 기본값 — 운영/시험 우주 상태 디렉터리(없으면 빈 선례 · fail-soft). */
export function doctorVisitIncidentRoot(): string {
  return elanousStateRoot();
}

export interface DoctorReviewPrMetadata { headRefOid: string; body: string; files: string[]; comments?: Array<{ body: string; author: string }> }

/** Fetch only the metadata needed to anchor a saved review to the current PR head. */
export function readDoctorReviewPr(pr: number): DoctorReviewPrMetadata {
  const result = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,body,files,author,comments'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: SPAWN_SYNC_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`PR #${pr} unavailable: ${result.error?.message ?? result.stderr?.trim() ?? 'gh failed'}`);
  const data = JSON.parse(result.stdout) as { headRefOid?: unknown; body?: unknown; files?: unknown; author?: { login?: unknown }; comments?: unknown };
  if (typeof data.headRefOid !== 'string' || !/^[a-f0-9]{40}$/i.test(data.headRefOid)) throw new Error('PR headRefOid is missing or invalid');
  return {
    headRefOid: data.headRefOid,
    body: typeof data.body === 'string' ? data.body : '',
    files: Array.isArray(data.files) ? data.files.flatMap((file: unknown) => {
      if (typeof file === 'string') return [file];
      if (file && typeof file === 'object' && typeof (file as { path?: unknown }).path === 'string') return [(file as { path: string }).path];
      return [];
    }) : [],
    comments: typeof data.author?.login === 'string' && Array.isArray(data.comments) ? data.comments.flatMap((comment: unknown) => {
      if (!comment || typeof comment !== 'object') return [];
      const item = comment as { body?: unknown; author?: { login?: unknown } };
      const login = item.author?.login;
      return typeof item.body === 'string' && typeof login === 'string' && login === data.author?.login
        ? [{ body: item.body, author: login }] : [];
    }) : [],
  };
}

/** Doctor's saved-review view; never records a run-ledger visit for a PR. */
export function readDoctorReviewBrief(pr: number, read: (pr: number) => DoctorReviewPrMetadata = readDoctorReviewPr, reviewResultsDir?: string): ReviewRoundBrief {
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('PR number must be a positive integer');
  const metadata = read(pr);
  return loadReviewRoundBrief({ pr, head: metadata.headRefOid, body: metadata.body, changedFiles: metadata.files, comments: metadata.comments?.map((comment) => comment.body),
    ...(reviewResultsDir ? { reviewResultsDir } : {}) });
}

/** DOCTOR-VISIT 증상 닫힌 목록 — 이 밖의 값은 기록·조회 모두 거부한다. */
export const DOCTOR_SYMPTOMS = [
  'admit-starved',
  'image-loop',
  'no-progress',
  'child-dead-no-result',
  'stale-install',
  'oom',
  'slow-tool',
  'host-overload',
  'not-grounded',
  'scope-drift',
  'review-loop',
  'knowledge-gap',
  'too-big',
  'long-run',
  'needs-owner',
] as const;

export type DoctorSymptom = (typeof DOCTOR_SYMPTOMS)[number];

/** 진료 요청을 보낸 쪽 닫힌 목록. */
export const DOCTOR_VISIT_SOURCES = ['supervisor', 'parent', 'child', 'judge', 'seat', 'auto', 'task-agent'] as const;

export type DoctorVisitSource = (typeof DOCTOR_VISIT_SOURCES)[number];

const DOCTOR_SYMPTOM_SET: ReadonlySet<string> = new Set(DOCTOR_SYMPTOMS);
const DOCTOR_VISIT_SOURCE_SET: ReadonlySet<string> = new Set(DOCTOR_VISIT_SOURCES);

export function isDoctorSymptom(value: string): value is DoctorSymptom {
  return DOCTOR_SYMPTOM_SET.has(value);
}

export function isDoctorVisitSource(value: string): value is DoctorVisitSource {
  return DOCTOR_VISIT_SOURCE_SET.has(value);
}

export interface RecordDoctorVisitInput {
  runId: string;
  from: string;
  symptom: string;
  evidence?: string;
  /** 원장 디렉터리(시험 seam) — 기본 = `runLedgerDir()`. */
  dir?: string;
  /** 사고 원장 루트(시험 seam) — 기본 = `doctorVisitIncidentRoot()`. `null` 이면 선례 연결을 건너뛴다. */
  incidentRoot?: string | null;
}

export interface DoctorVisit {
  runId: string;
  from: DoctorVisitSource;
  symptom: DoctorSymptom;
  evidence?: string;
  timestamp?: string;
  /** 사고 선례 연결 — 같은 reason 으로 이전에 기록된 실제 exit(기록 없으면 빈 배열). */
  incidentPrecedents?: IncidentPrecedent[];
}

/**
 * 런 원장에 진료 요청 한 줄(`event: 'doctor-visit'`)을 남긴다.
 * 원장이 없는 runId 는 «없음»으로 거부한다 — 조용히 새 원장을 만들지 않는다.
 */
export function recordDoctorVisit(visit: RecordDoctorVisitInput): DoctorVisit {
  if (!isDoctorSymptom(visit.symptom)) {
    throw new Error(`unknown symptom: ${visit.symptom} — closed list: ${DOCTOR_SYMPTOMS.join(', ')}`);
  }
  if (!isDoctorVisitSource(visit.from)) {
    throw new Error(`unknown from: ${visit.from} — closed list: ${DOCTOR_VISIT_SOURCES.join(', ')}`);
  }
  if (loadRunLedger(visit.runId, visit.dir) === null) {
    throw new Error(`없음: 런 원장이 없습니다 (runId=${visit.runId}) — 새 원장을 만들지 않습니다`);
  }
  const timestamp = new Date().toISOString();
  // 사고 선례 연결 — 기록된 실제 exit 만(지어내기 금지). 원장이 없으면 빈 배열(fail-soft).
  const incidentRoot = 'incidentRoot' in visit ? visit.incidentRoot ?? null : doctorVisitIncidentRoot();
  const incidentPrecedents = incidentRoot === null
    ? []
    : findIncidentPrecedents({ reason: visit.symptom, at: timestamp, runId: visit.runId }, incidentRoot);
  const data: Record<string, unknown> = { from: visit.from, symptom: visit.symptom };
  if (typeof visit.evidence === 'string' && visit.evidence.length > 0) data.evidence = visit.evidence;
  if (incidentPrecedents.length > 0) data.incidentPrecedents = incidentPrecedents;
  appendRunLedgerEntry({ timestamp, runId: visit.runId, event: 'doctor-visit', data }, visit.dir);
  debug.log('run-doctor', 'visit', { runId: visit.runId, from: visit.from, symptom: visit.symptom, incidentPrecedents: incidentPrecedents.length });
  return {
    runId: visit.runId,
    from: visit.from,
    symptom: visit.symptom,
    ...(typeof visit.evidence === 'string' && visit.evidence.length > 0 ? { evidence: visit.evidence } : {}),
    ...(incidentPrecedents.length > 0 ? { incidentPrecedents } : {}),
    timestamp,
  };
}

const AUTO_LONG_RUN_THRESHOLD_MS = 60 * 60 * 1000;
const AUTO_LONG_RUN_WINDOW = '60m';

/** A running Pod crossing 60 minutes records one visit per run and threshold window. */
export function recordAutoLongRunVisit(input: {
  runId: string;
  startedAt: string;
  now?: string;
  dir?: string;
}): { status: 'below-threshold' | 'recorded' | 'already-recorded' } {
  const startedMs = Date.parse(input.startedAt);
  const nowMs = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) {
    throw new Error('invalid-long-run-time: startedAt/now must be ISO timestamps');
  }
  if (loadRunLedger(input.runId, input.dir) === null) throw new Error(`run-ledger-missing: ${input.runId}`);
  const ageMs = nowMs - startedMs;
  if (ageMs < AUTO_LONG_RUN_THRESHOLD_MS) return { status: 'below-threshold' };
  const timestamp = new Date(nowMs).toISOString();
  const outcome = appendRunLedgerEntryChecked(input.runId, (entries) => {
    if (entries === null) throw new Error(`run-ledger-missing: ${input.runId}`);
    const seen = entries.some((entry) => entry.event === 'doctor-visit'
      && entry.data.from === 'auto' && entry.data.symptom === 'long-run'
      && entry.data.thresholdWindow === AUTO_LONG_RUN_WINDOW);
    if (seen) return { append: false, result: 'already-recorded' as const };
    return { append: true, entry: {
      timestamp,
      runId: input.runId,
      event: 'doctor-visit',
      data: { from: 'auto', symptom: 'long-run', thresholdMs: AUTO_LONG_RUN_THRESHOLD_MS,
        thresholdWindow: AUTO_LONG_RUN_WINDOW, startedAt: input.startedAt, ageMs },
    } };
  }, input.dir);
  if (outcome.appended) {
    debug.log('run-doctor', 'visit', { runId: input.runId, from: 'auto', symptom: 'long-run', thresholdWindow: AUTO_LONG_RUN_WINDOW });
    return { status: 'recorded' };
  }
  if (outcome.result === null) throw new Error(`run-ledger-write-refused: ${input.runId}`);
  return { status: outcome.result };
}

/** A TA card's specific needs-owner transition creates one visit only if its run ledger exists. */
export function recordTaskAgentNeedsOwnerVisit(input: {
  runId: string;
  cardId: string;
  at: string;
  reason: string;
  transitionIndex: number;
  dir?: string;
}): { status: 'missing-ledger' | 'recorded' | 'already-recorded' } {
  if (!input.reason.startsWith('failed/needs-owner')) throw new Error(`not-needs-owner: ${input.reason}`);
  const key = JSON.stringify([input.cardId, input.transitionIndex, input.at, input.reason]);
  const outcome = appendRunLedgerEntryChecked(input.runId, (entries) => {
    if (entries === null) return { append: false, result: 'missing-ledger' as const };
    if (entries.some((row) => row.event === 'doctor-visit' && row.data.from === 'task-agent'
      && row.data.transitionKey === key)) return { append: false, result: 'already-recorded' as const };
    return { append: true, entry: {
      runId: input.runId,
      timestamp: new Date().toISOString(),
      event: 'doctor-visit',
      data: { from: 'task-agent', symptom: 'needs-owner', evidence: input.reason,
        cardId: input.cardId, transitionAt: input.at, transitionIndex: input.transitionIndex, transitionKey: key },
    } };
  }, input.dir);
  if (outcome.appended) {
    debug.log('run-doctor', 'visit', { runId: input.runId, from: 'task-agent', symptom: 'needs-owner', cardId: input.cardId });
    return { status: 'recorded' };
  }
  return { status: outcome.result ?? 'missing-ledger' };
}

/** A parent stop that needs an owner records one shadow visit per stop, without running a prescription. */
export function recordParentNeedsOwnerVisit(input: {
  runId: string;
  stopKey: string;
  evidence: string;
  dir?: string;
}): { status: 'missing-ledger' | 'recorded' | 'already-recorded' } {
  const outcome = appendRunLedgerEntryChecked(input.runId, (entries) => {
    if (entries === null) return { append: false, result: 'missing-ledger' as const };
    if (entries.some((entry) => entry.event === 'doctor-visit' && entry.data.from === 'parent'
      && entry.data.symptom === 'needs-owner' && entry.data.stopKey === input.stopKey)) {
      return { append: false, result: 'already-recorded' as const };
    }
    return { append: true, entry: {
      runId: input.runId,
      timestamp: new Date().toISOString(),
      event: 'doctor-visit',
      data: { from: 'parent', symptom: 'needs-owner', stopKey: input.stopKey, evidence: input.evidence },
    } };
  }, input.dir);
  if (outcome.appended) {
    debug.log('run-doctor', 'visit', { runId: input.runId, from: 'parent', symptom: 'needs-owner', stopKey: input.stopKey });
    return { status: 'recorded' };
  }
  if (outcome.result === null) throw new Error(`run-ledger-write-refused: ${input.runId}`);
  return { status: outcome.result };
}

export type ReadDoctorVisitsOptions = RunLedgerLookupOptions;

export interface RunDoctorHandoffResult {
  status: 'acted' | 'already-acted' | 'needs-human' | 'missing-handoff';
  action?: AutohealAction;
  outcome?: string;
  stopKey: string;
}

/** Consume one persisted run-supervisor handoff through PR1's graph-aware stop prescription. */
export async function runDoctorHandoff(input: {
  runId: string;
  stopKey: string;
  dir?: string;
  dispatch: (action: AutohealAction, handoff: Record<string, unknown>) => Promise<{ outcome: string; detail?: string }> | { outcome: string; detail?: string };
}): Promise<RunDoctorHandoffResult> {
  const entries = loadRunLedger(input.runId, input.dir);
  if (entries === null) return { status: 'missing-handoff', stopKey: input.stopKey };
  const latestHandoff = [...entries].reverse().find((entry) => entry.event === 'run-chart-cell'
    && entry.data.device === 'run-supervisor' && entry.data.handoff === 'run-doctor');
  const handoff = latestHandoff?.data.stopKey === input.stopKey ? latestHandoff : undefined;
  if (!handoff) return { status: 'missing-handoff', stopKey: input.stopKey };
  const prior = entries.filter((entry) => entry.event === 'doctor-rx' && entry.data.stopKey === input.stopKey);
  const completed = prior.find((entry) => entry.data.status === 'completed' || entry.data.status === 'needs-human');
  if (completed) return { status: completed.data.status === 'completed' ? 'already-acted' : 'needs-human',
    ...(typeof completed.data.action === 'string' ? { action: completed.data.action as AutohealAction } : {}),
    ...(typeof completed.data.outcome === 'string' ? { outcome: completed.data.outcome } : {}), stopKey: input.stopKey };
  if (prior.some((entry) => entry.data.status === 'started')) {
    const outcome = 'needs-human: prior doctor action started without a recorded result';
    return { status: 'needs-human', outcome, stopKey: input.stopKey };
  }

  const chartBefore = readRunChart(input.runId, 'run-doctor', input.dir ?? runLedgerDir());
  const rawClass = handoff.data.failureClass ?? (handoff.data.verdict === 'wait' ? 'implement-aborted' : undefined);
  const failureClass = typeof rawClass === 'string' && (RUN_STOP_CLASSES as readonly string[]).includes(rawClass)
    ? rawClass as RunStopClass : 'unclassified';
  const prescription = pickAutohealAction(failureClass);
  const visitAppend = appendRunLedgerEntryChecked(input.runId, (current) => {
    if (current === null) return { append: false, result: false };
    if (current.some((entry) => entry.event === 'doctor-visit' && entry.data.stopKey === input.stopKey)) return { append: false, result: true };
    return { append: true, entry: { timestamp: new Date().toISOString(), runId: input.runId,
      event: 'doctor-visit', data: { from: 'supervisor', symptom: 'no-progress', stopKey: input.stopKey,
        evidence: `consecutive wait decisions=${String(handoff.data.waitCount ?? 'unknown')}`, prescription: prescription.action } } };
  }, input.dir);
  if (!visitAppend.appended && visitAppend.result !== true) return { status: 'missing-handoff', stopKey: input.stopKey };
  const claim = appendRunLedgerEntryChecked(input.runId, (current) => {
    if (current === null) return { append: false, result: 'missing-ledger' as const };
    const priorAction = current.find((entry) => entry.event === 'doctor-rx' && entry.data.stopKey === input.stopKey);
    if (priorAction) return { append: false, result: priorAction.data.status === 'completed' ? 'completed' as const
      : priorAction.data.status === 'needs-human' ? 'needs-human' as const : 'in-progress' as const };
    return { append: true, entry: { timestamp: new Date().toISOString(), runId: input.runId, event: 'doctor-rx',
      data: { device: 'run-doctor', stopKey: input.stopKey, status: 'started', action: prescription.action,
        source: prescription.source, ...(prescription.overlayId ? { overlayId: prescription.overlayId } : {}), executed: false } } };
  }, input.dir);
  if (!claim.appended) {
    if (claim.result === 'completed') return { status: 'already-acted', action: prescription.action, stopKey: input.stopKey };
    return { status: 'needs-human', action: prescription.action,
      outcome: claim.result === 'needs-human' ? 'needs-human: prior action requires a person'
        : claim.result === 'missing-ledger' ? 'needs-human: run ledger missing' : 'needs-human: doctor action already in progress',
      stopKey: input.stopKey };
  }

  let outcome: string;
  let detail: string | undefined;
  try {
    const result = await input.dispatch(prescription.action, handoff.data);
    outcome = result.outcome;
    detail = result.detail;
  } catch (error) {
    outcome = 'needs-human';
    detail = error instanceof Error ? error.message : String(error);
  }
  const needsHuman = outcome === 'needs-human' || outcome.startsWith('needs-human:');
  appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId: input.runId, event: 'doctor-rx',
    data: { device: 'run-doctor', stopKey: input.stopKey, status: needsHuman ? 'needs-human' : 'completed',
      action: prescription.action, source: prescription.source, outcome, executed: !needsHuman,
      ...(detail ? { detail: detail.slice(0, 300) } : {}) } }, input.dir);
  recordRunChartDecision({ runId: input.runId, device: 'run-doctor', stopKey: input.stopKey,
    observed: String(handoff.data.observed ?? 'supervisor handoff'), verdict: needsHuman ? 'needs-human' : 'acted',
    action: prescription.action, handoff: needsHuman ? 'outer-supervisor'
      : prescription.action === 'reauthor-from-materialized' ? 'reauthor' : null,
    why: detail ?? outcome, readStopKeys: chartBefore.map((cell) => cell.stopKey), dir: input.dir ?? runLedgerDir() });
  debug.log('run-doctor', 'action', { runId: input.runId, stopKey: input.stopKey, action: prescription.action,
    source: prescription.source, outcome, executed: !needsHuman });
  return { status: needsHuman ? 'needs-human' : 'acted', action: prescription.action, outcome, stopKey: input.stopKey };
}

/** Project logged review briefs into status without changing the run-ledger schema. Keep the latest observation per PR. */
export function doctorReviewVisits(events: readonly { timestamp?: string; sequence?: number; runId?: string; key?: string; evidence?: string }[]): (Omit<DoctorVisit, 'runId'> & { runId?: string })[] {
  const seenPrs = new Set<string>();
  return [...events].sort((left, right) => {
    const leftAt = left.timestamp ? Date.parse(left.timestamp) : 0;
    const rightAt = right.timestamp ? Date.parse(right.timestamp) : 0;
    return rightAt - leftAt || (right.sequence ?? 0) - (left.sequence ?? 0) || String(right.key ?? '').localeCompare(String(left.key ?? ''));
  }).flatMap((event) => {
    const pr = /^(\d+)(?::|$)/.exec(event.key ?? '')?.[1];
    if (pr && seenPrs.has(pr)) return [];
    if (pr) seenPrs.add(pr);
    return [{ ...(event.runId ? { runId: event.runId } : {}), from: 'seat' as const, symptom: 'review-loop' as const,
      ...(event.evidence ? { evidence: event.evidence } : {}), ...(event.timestamp ? { timestamp: event.timestamp } : {}) }];
  });
}

/** `runId` 원장이 조회 범위 안에 있는가 — `doctor status --run` 이 없는 런을 «0건»으로 삼키지 않게 한다. */
export function doctorVisitRunExists(runId: string, options: ReadDoctorVisitsOptions = {}): boolean {
  return lookupRunLedger(runId, options).matches.length > 0;
}

/** 원장의 `doctor-visit` 사건을 읽는다. `runId` 를 주면 그 런만, 없으면 전체 원장을 훑는다. */
export function readDoctorVisits(runId?: string, options: ReadDoctorVisitsOptions = {}): DoctorVisit[] {
  const matches = runId === undefined ? listRunLedgers(options).matches : lookupRunLedger(runId, options).matches;
  const visits: DoctorVisit[] = [];
  for (const match of matches) {
    for (const entry of match.entries) {
      if (entry.event !== 'doctor-visit') continue;
      const from = typeof entry.data.from === 'string' && isDoctorVisitSource(entry.data.from) ? entry.data.from : null;
      const symptom = typeof entry.data.symptom === 'string' && isDoctorSymptom(entry.data.symptom) ? entry.data.symptom : null;
      if (from === null || symptom === null) continue;
      visits.push({
        runId: entry.runId,
        from,
        symptom,
        ...(typeof entry.data.evidence === 'string' && entry.data.evidence.length > 0 ? { evidence: entry.data.evidence } : {}),
        ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
      });
    }
  }
  return visits.sort((left, right) =>
    (left.timestamp ?? '').localeCompare(right.timestamp ?? '') || left.runId.localeCompare(right.runId));
}

/** First RUN-DOCTOR-LOOP shadow prescription. It records advice and never dispatches it. */
export function recordShadowDoctorReevaluation(runId: string, dir?: string): {
  status: 'recorded' | 'already-recorded' | 'no-visit';
  rx?: 're-evaluate-member';
  outcome?: 'shadow-recorded' | 'needs-evidence';
  visitIndex?: number;
} {
  const entries = loadRunLedger(runId, dir);
  if (entries === null) throw new Error(`없음: 런 원장이 없습니다 (runId=${runId})`);
  let visitIndex = -1;
  let lastVisitIndex = -1;
  for (let index = 0; index < entries.length; index++) {
    if (entries[index]?.event !== 'doctor-visit' || entries[index]?.data.symptom !== 'admit-starved') continue;
    lastVisitIndex = index;
    if (!entries.some((entry) => entry.event === 'doctor-rx'
      && entry.data.shadow === true && entry.data.visitIndex === index)) {
      visitIndex = index;
      break;
    }
  }
  if (visitIndex < 0) return lastVisitIndex < 0
    ? { status: 'no-visit' }
    : { status: 'already-recorded', visitIndex: lastVisitIndex };
  const visit = entries[visitIndex]!;

  const evidence = typeof visit.data.evidence === 'string' ? visit.data.evidence.trim() : '';
  // The pack selected for this run was observed before the visit. Keep its actual slice ids;
  // an absent or malformed observation must remain unknown, never imply an empty pack.
  const pack = entries.slice(0, visitIndex).reverse().find((entry) => entry.event === 'knowhow-pack');
  const packIds = Array.isArray(pack?.data?.ids) && pack.data.ids.length > 0
    && pack.data.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)
    ? pack.data.ids as string[] : 'unknown';
  // Pull the repository lesson at prescription time. A vanished worktree leaves the prior observed ids
  // as provenance only; it must never manufacture a current remedy.
  const sourceRepo = typeof pack?.data?.repoPath === 'string' ? pack.data.repoPath : null;
  const sourceGoal = typeof pack?.data?.goal === 'string' ? pack.data.goal : null;
  const pulled = sourceRepo && sourceGoal ? selectKnowhowPack(sourceRepo, sourceGoal) : null;
  const currentIds = pulled?.ids.length ? pulled.ids : packIds;
  const rx = evidence ? 're-evaluate-member' as const : null;
  const outcome = evidence ? 'shadow-recorded' as const : 'needs-evidence' as const;
  const data: Record<string, unknown> = {
    shadow: true,
    visitIndex,
    visit: { runId, from: visit.data.from, symptom: 'admit-starved', timestamp: visit.timestamp, evidence: evidence || null },
    diagnosis: evidence ? 'admit-starved-reported' : 'evidence-unmeasured',
    knowhowPackSliceIds: currentIds,
    knowhowPackDecision: { source: pulled ? 'repository' : 'unavailable', ids: pulled?.ids ?? [], reason: pulled?.reason ?? 'source-unavailable',
      reference: pulled?.text || null },
    rx,
    cost: { estimatedTokens: 0, usedTokens: 0 },
    outcome,
    execution: 'none',
    handoff: evidence ? `parent-re-evaluate-member${pulled?.ids.length ? ` · 검토할 노하우 ${pulled.ids.join(',')}` : ''}` : 'visit-owner-provide-admission-evidence',
  };
  appendRunLedgerEntry({ timestamp: new Date().toISOString(), runId, event: 'doctor-rx', data }, dir);
  debug.log('run-doctor', 'rx', { runId, visitIndex, rx, outcome, shadow: true, executed: false });
  return { status: 'recorded', ...(rx ? { rx } : {}), outcome, visitIndex };
}

/** Guardian shadow tick: prescribe only for ledgers with an admit-starved visit. Repeated ticks are idempotent. */
export function recordPendingShadowDoctorReevaluations(dir?: string): { recorded: number; alreadyRecorded: number } {
  let recorded = 0;
  let alreadyRecorded = 0;
  for (const ledger of listRunLedgers(dir ? { dir } : {}).matches) {
    const visits = ledger.entries.flatMap((entry, index) => entry.event === 'doctor-visit' && entry.data.symptom === 'admit-starved' ? [index] : []);
    if (visits.length === 0) continue;
    const prescribed = new Set(ledger.entries.flatMap(entry => entry.event === 'doctor-rx' && entry.data.shadow === true
      && typeof entry.data.visitIndex === 'number' ? [entry.data.visitIndex] : []));
    if (visits.every(index => prescribed.has(index))) { alreadyRecorded++; continue; }
    const result = recordShadowDoctorReevaluation(ledger.runId, ledger.ledgerDirectory);
    if (result.status === 'recorded') recorded++;
    else if (result.status === 'already-recorded') alreadyRecorded++;
  }
  debug.log('run-doctor', 'shadow-tick', { recorded, alreadyRecorded });
  return { recorded, alreadyRecorded };
}

/** OP 손판정 한 건 — 시각과 결과만 받는다(그 밖의 입력은 받지 않는다). */
export interface DoctorOpJudgment {
  /** 손판정 시각(ISO). */
  timestamp: string;
  /** 손판정 결과 — 예: 'agree' | 'disagree'. */
  result: string;
}

export interface RecordDoctorComparisonInput {
  runId: string;
  judgment: DoctorOpJudgment;
  /** 원장 디렉터리(시험 seam) — 기본 = `runLedgerDir()`. */
  dir?: string;
}

export interface DoctorComparisonRecord {
  status: 'recorded' | 'already-recorded';
  visitIndex: number;
  shadowRxIndex: number;
  rx: string | null;
  outcome: string | null;
  opResult: string;
}

/**
 * 하류 계약: 운영/시험 원장 쓰기 거부는 message 문자열이 아니라 typed identity(`reason`·`runId`·
 * `ledgerDir`)로 도착한다. 사람이 읽는 문면은 종전과 같은 문장 그대로다.
 */
export class DoctorComparisonLedgerWriteRefusedError extends Error {
  readonly reason = 'ledger-write-refused' as const;
  constructor(readonly runId: string, readonly ledgerDir: string) {
    super(`ledger-write-refused: 테스트 우주가 운영 원장 쓰기를 거부했습니다 (runId=${runId}) — 운영 원장에 쓰지 않았습니다`);
    this.name = 'DoctorComparisonLedgerWriteRefusedError';
  }
}

/**
 * RUN-DOCTOR-LIVE 0.2.36 첫 비교 슬라이스 — 그 정확한 runId 의 OP 손판정 1건(timestamp·result)을
 * 이미 기록된 shadow doctor-rx/visit 에 결속해 원장에 `doctor-compare` 한 행을 남긴다.
 * 행에는 양쪽 판단 시각(visit·shadowRx·OP), 원본 shadow rx/outcome, OP 판정 결과,
 * 안정적 원본 인덱스(visitIndex·shadowRxIndex)를 담는다. 존재 판정과 단일 append 는
 * appendRunLedgerEntryChecked 로 같은 per-run lock 안에서 원자적으로 이뤄진다(#30403).
 * 명명된 실패 — invalid-op-judgment · run-ledger-missing · shadow-rx-missing · runId-mismatch ·
 * visit-missing. 어떤 경우도 shadow 결과를 지어내지 않는다. 같은 shadow rx 에 대한 재시도는
 * already-recorded 로 원장에 한 행만 남긴다(멱등).
 * 하류 계약(typed identity) — ① 원장 쓰기 거부는 DoctorComparisonLedgerWriteRefusedError
 * (`reason='ledger-write-refused'`·`runId`·`ledgerDir`), ② runId 불일치는 원장 바이트와 checked
 * append 양쪽 모두 RunLedgerCheckedAppendRunIdMismatchError(`reason='runId-mismatch'`·
 * `decisionRunId`·`lockedRunId`)로 도착한다. 문자열 파싱 없이 분류하고, 실제로 없는 원장만
 * `run-ledger-missing` 이다.
 *
 * 배선 경계(의도적): 이 슬라이스의 호출자는 시험 경로뿐이다 — live dispatch·stall-watch retirement
 * 은 후속 cross-judgment 증거 슬라이스에서 붙는다(현행 `eln doctor status --json` = total 0
 * operating visits 이므로 live outcome 을 주장하지 않는다).
 */
export function recordDoctorComparison(input: RecordDoctorComparisonInput): DoctorComparisonRecord {
  const runId = input.runId;
  const judgment = input.judgment;
  if (typeof judgment !== 'object' || judgment === null
    || typeof judgment.timestamp !== 'string' || judgment.timestamp.length === 0
    || typeof judgment.result !== 'string' || judgment.result.length === 0) {
    throw new Error(`invalid-op-judgment: OP 손판정은 timestamp·result 문자열이 필요합니다 (runId=${runId})`);
  }
  const holder: { recorded?: DoctorComparisonRecord } = {};
  // ⛔ typed identity 를 «문자열 하나»로 뭉개지 않는다 — checked append 가 던지는
  // RunLedgerCheckedAppendRunIdMismatchError(원장 바이트 불일치는 같은 reason 의
  // RunLedgerEntryRunIdMismatchError)의 reason·decisionRunId·lockedRunId 가 그대로 하류까지 간다.
  // 그래서 이 호출을 try/catch 로 감싸 재발사하지 않는다(감싸면 identity 가 사라진다).
  // 단일 per-run lock 안에서 비교 행 존재 판정과 단일 append를 원자적으로 수행한다(#30403 동시 중복 결함).
  // lock 안에서 appendRunLedgerEntry 를 다시 부르지 않는다(중첩 lock 시간초과).
  const outcome: RunLedgerCheckedAppendOutcome<DoctorComparisonRecord> = appendRunLedgerEntryChecked<DoctorComparisonRecord>(runId, (entries) => {
    if (entries === null) {
      throw new Error(`run-ledger-missing: 런 원장이 없습니다 (runId=${runId}) — 새 원장을 만들지 않습니다`);
    }
    let shadowRxIndex = -1;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.event === 'doctor-rx' && entry.data.shadow === true) shadowRxIndex = index;
    }
    if (shadowRxIndex < 0) {
      throw new Error(`shadow-rx-missing: 이 runId 의 shadow doctor-rx 가 없습니다 (runId=${runId}) — shadow 결과를 지어내지 않습니다`);
    }
    const shadowRx = entries[shadowRxIndex]!;
    const rx = typeof shadowRx.data.rx === 'string' ? shadowRx.data.rx : null;
    const shadowOutcome = typeof shadowRx.data.outcome === 'string' ? shadowRx.data.outcome : null;
    const visitIndex = typeof shadowRx.data.visitIndex === 'number' ? shadowRx.data.visitIndex : -1;
    const visit = visitIndex >= 0 && visitIndex < entries.length ? entries[visitIndex] : undefined;
    if (visit === undefined || visit.event !== 'doctor-visit' || visit.runId !== runId) {
      throw new Error(`visit-missing: shadow doctor-rx 가 가리키는 doctor-visit 행이 없습니다 (runId=${runId}, visitIndex=${visitIndex})`);
    }
    const existing = entries.find((entry) => entry.event === 'doctor-compare' && entry.data.shadowRxIndex === shadowRxIndex);
    if (existing !== undefined) {
      const stored = existing.data.opJudgment as { timestamp?: unknown; result?: unknown };
      if (typeof stored?.timestamp !== 'string' || stored.timestamp.length === 0
        || typeof stored?.result !== 'string' || stored.result.length === 0) {
        throw new Error(`comparison-corrupt: 이미 기록된 doctor-compare 의 저장 판단이 손상됐습니다 (runId=${runId}, shadowRxIndex=${shadowRxIndex}, stored=${JSON.stringify(stored)}) — 거짓 already-recorded 를 승인하지 않습니다`);
      }
      if (stored.timestamp !== judgment.timestamp || stored.result !== judgment.result) {
        throw new Error(`comparison-conflict: 이미 기록된 doctor-compare 와 손판정이 다릅니다 (runId=${runId}, shadowRxIndex=${shadowRxIndex}, stored=${JSON.stringify(stored)}, received=${JSON.stringify(judgment)}) — 기존 행을 유지합니다`);
      }
      return { append: false as const, result: { status: 'already-recorded' as const, visitIndex, shadowRxIndex, rx, outcome: shadowOutcome, opResult: judgment.result } };
    }
    const data: Record<string, unknown> = {
      shadow: true,
      visitIndex,
      shadowRxIndex,
      visit: { runId, from: visit.data.from, symptom: visit.data.symptom, timestamp: visit.timestamp },
      shadowRx: { timestamp: shadowRx.timestamp, rx, outcome: shadowOutcome },
      opJudgment: { timestamp: judgment.timestamp, result: judgment.result },
    };
    holder.recorded = { status: 'recorded', visitIndex, shadowRxIndex, rx, outcome: shadowOutcome, opResult: judgment.result };
    return { append: true as const, entry: { timestamp: new Date().toISOString(), runId, event: 'doctor-compare', data } };
  }, input.dir);
  if (outcome.refusal === 'ledger-write-refused') {
    throw new DoctorComparisonLedgerWriteRefusedError(runId, input.dir ?? runLedgerDir());
  }
  if (outcome.result !== null) {
    return outcome.result;
  }
  if (holder.recorded === undefined) {
    throw new Error(`run-ledger-missing: 런 원장이 없습니다 (runId=${runId}) — 새 원장을 만들지 않습니다`);
  }
  const record = holder.recorded;
  debug.log('run-doctor', 'compare', { runId, visitIndex: record.visitIndex, shadowRxIndex: record.shadowRxIndex, opResult: judgment.result, executed: false });
  return record;
}
