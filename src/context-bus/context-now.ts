import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { queryRunningRuns, type QueriedRunningRunsResult } from '../self-implement/running-runs.js';
import { loadRunLedger, resolveFederatedRunLedgerDirectories, runLedgerDir } from '../self-implement/run-ledger.js';
import { localLoopRows } from '../dashboard/slash-runtime/loops-table.js';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug, redactSecretText } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { listChecklist, devVersion, type Checklist } from '../release-loop/checklist.js';
import { effectiveInstanceRoot, releaseLedgerRoot } from '../instance/resolve.js';
import { readReleaseRuns, type ReleaseRunView } from '../nexus/api/ops-api.js';
import { gateShardsPath, readGateShards, summarizeShards } from '../release-loop/gate-shards.js';
import { getSchedule, listSchedules } from '../release-loop/release-schedule.js';
import { readLandingFreeze } from '../release-loop/landing-freeze.js';
import { readSweepCertificate } from '../../scripts/release-loop/sweep-cert.js';
import { setElanousConfigDir } from '../elanous-config-dir.js';
import { seatDay, seatLedgerPath, type SeatEntry } from '../seat-loop/seat-loop.js';
import { listCoordEvents, type CoordEvent } from './coord-events.js';
import { filterPublicDemoContext } from './context-now-public.js';

export type ContextFact =
  | { kind: 'version'; version: string; source: string }
  | { kind: 'cell'; version: string; id: string; title: string; status: string; owner: string | null; source: string; priority?: string | null }
  | { kind: 'decision'; id: string; title: string; status: string; dueAt: string | null; source: string }
  | { kind: 'seat'; seat: string; at: string; status: string; id: string | null; title: string | null; source: string }
  | { kind: 'run'; goal: string; phase: string; elapsed: string; source: string; unreadable?: string }
  | { kind: 'release'; version: string; node: string; status: string; source: string; unreadable?: string;
      phase?: string; currentNode?: string | null; nextAction?: string;
      gateProgress?: { completed: number; total: number; failed: number } | null;
      regressions?: { introduced: number | null; preexisting: number | null } | null;
      receiptStatus?: 'valid' | 'invalid' | 'absent' | 'unreadable'; waiverEvents?: string[];
      emergencySwitch?: { state: 'on' | 'off' | 'unknown'; reason?: string };
      landingFreeze?: { state: 'on' | 'off' | 'unknown'; reason?: string };
      expectedPublishAt?: string | null; etaMinutes?: number | null;
      auditCoverage?: { uncoveredFiles: number; totalFiles: number } | null; residualRuns?: number | null;
      sweepCertificateAgeMinutes?: number | null;
      failureCounts?: { introduced: number | null; preexisting: number | null; undetermined: number | null } | null;
      sourceRefs?: Array<{ signal: string; source: string }>;
      ledgerErrors?: Array<{ signal: string; source: string; reason: string }> }
  | { kind: 'schedule-late'; count: number | null; names: string[]; source: string; unreadable?: string };
export type ContextEvent = { at: string; kind: string; summary: string; source: string };
export type ContextNowAnswer = { at: string; topic: string | null; facts: ContextFact[]; events: ContextEvent[]; guide: string[]; hiddenCount?: number };

interface GateVerdictEvidence {
  version: string; commit: string; outcome: 'ok' | 'regression' | 'error';
  introduced: string[]; knownEnv: string[]; preexisting: string[]; loadFlaky: string[];
  baselineReceipt: { schema: 2; valid: boolean; reason: string; version: string; commit: string; head40: string;
    graphSha: string | null; recipeSha: string | null; envFingerprint: string; imageDigest: string | null;
    executionIdentity: unknown; files: number; shards: number };
}

function isGateVerdictEvidence(value: unknown, version: string): value is GateVerdictEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const receipt = row.baselineReceipt;
  if (row.version !== version || typeof row.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(row.commit)
    || !['ok', 'regression', 'error'].includes(String(row.outcome))
    || !['introduced', 'knownEnv', 'preexisting', 'loadFlaky'].every(key => Array.isArray(row[key]) && (row[key] as unknown[]).every(item => typeof item === 'string'))
    || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  const r = receipt as Record<string, unknown>;
  const hex = (item: unknown) => typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item);
  const digest = (item: unknown) => item === null || (typeof item === 'string' && /^sha256:[0-9a-f]{64}$/i.test(item));
  const identity = r.executionIdentity;
  const validIdentity = identity === null || (!!identity && typeof identity === 'object' && !Array.isArray(identity)
    && typeof (identity as Record<string, unknown>).bunVersion === 'string'
    && typeof (identity as Record<string, unknown>).platform === 'string'
    && typeof (identity as Record<string, unknown>).architecture === 'string'
    && hex((identity as Record<string, unknown>).envFingerprint)
    && typeof (identity as Record<string, unknown>).baseImageDigest === 'string');
  return r.schema === 2 && typeof r.valid === 'boolean' && typeof r.reason === 'string'
    && r.version === version && r.commit === row.commit && r.head40 === row.commit
    && (r.graphSha === null || hex(r.graphSha)) && (r.recipeSha === null || hex(r.recipeSha))
    && hex(r.envFingerprint) && digest(r.imageDigest) && validIdentity
    && Number.isSafeInteger(r.files) && Number.isSafeInteger(r.shards)
    && (r.artifactPath === undefined || typeof r.artifactPath === 'string')
    && (r.fileInventory === undefined || (Array.isArray(r.fileInventory) && r.fileInventory.every(item => typeof item === 'string')))
    && (r.rechecks === undefined || Array.isArray(r.rechecks));
}

export interface ContextNowDeps {
  now?: () => Date;
  version?: () => string;
  checklist?: (version: string) => Checklist;
  decisions?: () => DecisionEntry[];
  seatEntries?: (now: Date) => Array<{ entry: SeatEntry; source: string }>;
  events?: (since: string) => CoordEvent[];
  runningRuns?: (now: Date) => Extract<ContextFact, { kind: 'run' }>[];
  queryRuns?: () => QueriedRunningRunsResult;
  releaseRun?: () => Extract<ContextFact, { kind: 'release' }> | null;
  lateSchedules?: (now: Date) => Extract<ContextFact, { kind: 'schedule-late' }> | null;
  brandCheck?: typeof checkBrand;
}

function todaySeatEntries(now: Date): Array<{ entry: SeatEntry; source: string }> {
  const root = effectiveInstanceRoot();
  const day = seatDay(now);
  return ['OP', 'TC', 'MK', 'UX'].flatMap(seat => {
    const path = seatLedgerPath(seat, root, now);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => line.trim() ? [{
      entry: JSON.parse(line) as SeatEntry,
      source: `elanous://seat-loop/${seat}/${day}#${index + 1}`,
    }] : []);
  });
}

function seatFact({ entry, source }: { entry: SeatEntry; source: string }): Extract<ContextFact, { kind: 'seat' }> {
  return { kind: 'seat', seat: entry.seat, at: entry.at, status: entry.status,
    id: entry.item?.id ?? null, title: entry.item?.source === 'checklist'
      ? redactSecretText(entry.item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120) : null, source };
}

/** The TUI status line needs seat facts only; it must not scan release or run ledgers. */
export function seatStatusNow(now = new Date()): ContextNowAnswer {
  return { at: `${now.toISOString().slice(0, 16)}:00.000Z`, topic: null,
    facts: todaySeatEntries(now).map(seatFact), events: [], guide: [] };
}

const runSource = 'elanous://self-implement/running-runs';
const releaseSource = 'elanous://graph-runs/release-loop';
const scheduleSource = 'elanous://schedules';
const oneLine = (text: string) => redactSecretText(text.split(/\r?\n/, 1)[0] ?? '').slice(0, 120);

/** One concise release-ledger answer shared by chat, TUI and tool callers. */
export function releaseFactSummary(fact: Extract<ContextFact, { kind: 'release' }>): string {
  if (fact.unreadable) return `발행 런 원장 못 읽음 · ${fact.unreadable}`;
  const parts = [`${fact.version} · ${fact.node} · ${fact.status}`];
  if (fact.phase) parts.push(`국면 ${fact.phase}`);
  if (fact.currentNode) parts.push(`현재 ${fact.currentNode}`);
  if (fact.nextAction) parts.push(`다음 ${fact.nextAction}`);
  if (fact.gateProgress) parts.push(`게이트 ${fact.gateProgress.completed}/${fact.gateProgress.total} · 실패 ${fact.gateProgress.failed}`);
  if (fact.regressions) parts.push(`회귀 도입 ${fact.regressions.introduced ?? '?'} · 기존 ${fact.regressions.preexisting ?? '?'}`);
  if (fact.receiptStatus) parts.push(`영수증 ${fact.receiptStatus}`);
  if (fact.waiverEvents) parts.push(`면제 ${fact.waiverEvents.length ? `${fact.waiverEvents.slice(0, 3).map(oneLine).join(', ')}${fact.waiverEvents.length > 3 ? ` · 생략 ${fact.waiverEvents.length - 3} (/release)` : ''}` : '없음'}`);
  if (fact.emergencySwitch) parts.push(`긴급 전환 ${fact.emergencySwitch.state}${fact.emergencySwitch.reason ? ` · ${fact.emergencySwitch.reason}` : ''}`);
  if (fact.landingFreeze) parts.push(`착지 동결 ${fact.landingFreeze.state}${fact.landingFreeze.reason ? ` · ${fact.landingFreeze.reason}` : ''}`);
  if (fact.expectedPublishAt) parts.push(`예상 발행 ${fact.expectedPublishAt}`);
  if (fact.etaMinutes !== undefined) parts.push(`ETA ${fact.etaMinutes === null ? '미측정' : `${fact.etaMinutes}m`}`);
  if (fact.auditCoverage !== undefined) parts.push(`미덮임 ${fact.auditCoverage?.uncoveredFiles ?? '?'}/${fact.auditCoverage?.totalFiles ?? '?'}`);
  if (fact.residualRuns !== undefined) parts.push(`residual 실행 ${fact.residualRuns ?? '?'}`);
  if (fact.sweepCertificateAgeMinutes !== undefined) parts.push(`sweep 증명서 나이 ${fact.sweepCertificateAgeMinutes === null ? '?' : `${fact.sweepCertificateAgeMinutes}m`}`);
  if (fact.failureCounts !== undefined) parts.push(`실패 introduced ${fact.failureCounts?.introduced ?? '?'} / preexisting ${fact.failureCounts?.preexisting ?? '?'} / 미판정 ${fact.failureCounts?.undetermined ?? '?'}`);
  if (fact.sourceRefs?.length) parts.push(`근거 ${fact.sourceRefs.slice(0, 8).map(ref => `${ref.signal}=${ref.source}`).join(', ')}${fact.sourceRefs.length > 8 ? ` · 생략 ${fact.sourceRefs.length - 8} (/release)` : ''}`);
  if (fact.ledgerErrors?.length) parts.push(`원장 오류 ${fact.ledgerErrors.slice(0, 3).map(error => `${error.signal} (${error.source}): ${error.reason}`).join(', ')}${fact.ledgerErrors.length > 3 ? ` · 생략 ${fact.ledgerErrors.length - 3} (/release)` : ''}`);
  return Array.from(parts.join(' · ')).slice(0, 1500).join('');
}

/** Render the same release fact used by context-now for one graph run, from explicit ledgers. */
export function releaseRunContextSummary(runId: string, options: {
  stateRoot?: string;
  ledgerRoot?: string;
  events?: readonly CoordEvent[];
  now?: Date;
} = {}): string | undefined {
  const stateRoot = options.stateRoot ?? effectiveInstanceRoot();
  const ledgerRoot = options.ledgerRoot ?? releaseLedgerRoot();
  const now = options.now ?? new Date();
  const runs = readReleaseRuns(null, join(stateRoot, 'graph-runs', 'release-loop'), {
    facts: true, ledgerRoot, now: now.getTime(),
  });
  if (runs === 'unavailable') return `run=${runId} · 발행 런 원장 관측 불가`;
  const run = runs.find(item => item.runId === runId);
  if (!run) return undefined;
  const version = run.version ?? '판 미기록';
  const fact = releaseContextFact(version, run, undefined, [], options.events ?? [], now, stateRoot, ledgerRoot);
  return fact ? releaseFactSummary(fact) : undefined;
}

// src/dashboard/slash-runtime/dashboard-handlers.ts:buildDashboardSlashRegistry /now calls contextNowInWorker;
// contextNow → queryRunningRuns → queryFederatedUnfinishedRunLedgers → queryUnfinishedRunLedgers (persisted scan index).
function runningRunFacts(now: Date, queryRuns: () => QueriedRunningRunsResult = () => queryRunningRuns({
  includeTest: false,
  caller: 'context-now',
  noCache: false,
}, {
  ledgerDirectories: () => [...new Set([runLedgerDir(), ...resolveFederatedRunLedgerDirectories({ includeTest: false })])],
})): Extract<ContextFact, { kind: 'run' }>[] {
  const observed = queryRuns();
  const unreadable = observed.completeness === 'partial' || observed.pty.unreadable.length || !!observed.phases?.unreadableTargetCount;
  const facts = observed.entries.filter(entry => observed.countedStatuses.includes(entry.status)).slice(0, 8).flatMap(entry => {
    let ledgerReadFailure = false;
    const starts = entry.ledgerDirectories.flatMap(directory => {
      try { return loadRunLedger(entry.runId, directory)?.filter(record => record.event === 'start') ?? []; }
      catch { ledgerReadFailure = true; return []; }
    });
    const goalRecord = starts.find(record => typeof record.data.feature === 'string' && record.data.feature.trim());
    const goal = typeof goalRecord?.data.feature === 'string' ? goalRecord.data.feature : ledgerReadFailure ? '골 관측 불가' : '골 미기록';
    const started = starts.map(record => record.timestamp ? Date.parse(record.timestamp) : NaN).find(Number.isFinite) ?? NaN;
    const minutes = Number.isFinite(started)
      ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : null;
    const fact = { kind: 'run' as const, goal: oneLine(goal),
      phase: entry.lastPhase ?? '단계 미관측', elapsed: minutes === null ? ledgerReadFailure ? '경과 관측 불가' : '경과 미관측' : `${minutes}분`,
      source: `${runSource}/${encodeURIComponent(entry.runId)}` };
    return ledgerReadFailure
      ? [
          ...(goalRecord || minutes !== null ? [fact] : []),
          { kind: 'run' as const, goal: '', phase: '', elapsed: '', source: fact.source, unreadable: '런 원장 일부 관측 불가' },
        ] : [fact];
  });
  return unreadable ? [...facts, { kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: '런 원장 또는 관측 대상 일부' }] : facts;
}

function releaseContextFacts(defaultVersion: string, events: readonly CoordEvent[] = [], now = new Date()): Array<Extract<ContextFact, { kind: 'release' }>> {
  const stateRoot = effectiveInstanceRoot();
  const ledgerRoot = releaseLedgerRoot();
  const runs = readReleaseRuns(null, join(stateRoot, 'graph-runs', 'release-loop'), { facts: true, ledgerRoot, now: Date.now() });
  const runsByVersion = new Map<string, ReleaseRunView>();
  let latestUnversionedRun: ReleaseRunView | undefined;
  if (runs !== 'unavailable') {
    for (const run of runs) {
      if (run.version) {
        if (!runsByVersion.has(run.version)) runsByVersion.set(run.version, run);
      } else latestUnversionedRun ??= run;
    }
  }
  const latestRun = runs === 'unavailable' ? undefined : runs[0];
  const runReadError = runs === 'unavailable' ? '런 목록을 읽을 수 없음' : undefined;
  const commonErrors: Array<{ signal: string; source: string; reason: string }> = runReadError
    ? [{ signal: 'run', source: releaseSource, reason: runReadError }] : [];
  const knownVersions = new Set<string>();
  try {
    for (const schedule of listSchedules(ledgerRoot)) knownVersions.add(schedule.version);
  } catch (error) { commonErrors.push({ signal: 'schedule-index', source: scheduleSource, reason: unreadableReason(error) }); }
  const releaseRoot = join(ledgerRoot, 'release');
  try {
    for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta|dev)\.\d+)?$/.test(entry.name)) continue;
      if (existsSync(join(releaseRoot, entry.name, 'gate-verdict.json')) || existsSync(gateShardsPath(entry.name, ledgerRoot))) knownVersions.add(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') commonErrors.push({ signal: 'release-index', source: 'elanous://release', reason: unreadableReason(error) });
  }
  for (const runVersion of runsByVersion.keys()) knownVersions.add(runVersion);
  if (latestUnversionedRun) knownVersions.add('판 미기록');
  if (!knownVersions.size) knownVersions.add(latestRun?.version ?? defaultVersion);
  const versions = [...knownVersions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.flatMap(version => {
    const run = runsByVersion.get(version) ?? (version === '판 미기록' ? latestUnversionedRun : undefined);
    const fact = releaseContextFact(version, run, runReadError, commonErrors, events, now);
    return fact ? [fact] : [];
  });
}

function releaseContextFact(version: string, run: ReleaseRunView | undefined,
  runReadError: string | undefined, commonErrors: Array<{ signal: string; source: string; reason: string }>,
  events: readonly CoordEvent[] = [], now = new Date(), stateRoot = effectiveInstanceRoot(), ledgerRoot = releaseLedgerRoot()): Extract<ContextFact, { kind: 'release' }> | null {
  const ledgerErrors: Array<{ signal: string; source: string; reason: string }> = [...commonErrors];
  const runUnavailable = runReadError !== undefined;
  const runSourceRef = run ? `${releaseSource}/${encodeURIComponent(run.runId)}` : releaseSource;
  const sourceRefs: Array<{ signal: string; source: string }> = [{ signal: runUnavailable ? 'run-status' : 'run', source: runSourceRef }];
  let raw: { input?: { publishAt?: unknown }; etaMinutes?: unknown; etaAt?: unknown; estimatedCompletionAt?: unknown; pending?: { nodeId?: unknown; message?: unknown };
    nodes?: Array<{ nodeId?: unknown; endedAt?: unknown; output?: unknown; waiver?: { reason?: unknown; approvedBy?: unknown; at?: unknown } }> } = {};
  let rawReadable = false;
  if (run) {
    try { raw = JSON.parse(readFileSync(join(stateRoot, 'graph-runs', 'release-loop', `${run.runId}.json`), 'utf8')); rawReadable = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ledgerErrors.push({ signal: 'run', source: runSourceRef, reason: unreadableReason(error) });
    }
  }
  const current = run ? run.nodes.find(node => node.ok === null && node.startedAt && run.path.at(-1) === node.nodeId) : undefined;
  const arrival = run?.status === 'running' && !current && run.path.length
    ? [...events].reverse().find(event => event.refs.origin === 'release-graph' && event.kind === 'exit'
      && event.summary === `release graph node-arrival · run=${run.runId} · node=${run.path.at(-1)}`)
    : undefined;
  const arrivalNode = arrival ? run?.path.at(-1) : undefined;
  const phase = !run ? runUnavailable ? '관측 불가' : '미기동'
    : run.status === 'awaiting-approval' ? '승인 대기' : current?.nodeId ?? arrivalNode ?? run.status;
  const pending = typeof raw.pending?.message === 'string' ? oneLine(raw.pending.message) : undefined;
  let nextAction = !run ? runUnavailable ? '런 원장 복구 후 재관측' : '런 관측 대기'
    : run.status === 'awaiting-approval' ? `승인${pending ? ` 필요 · ${pending}` : ' 필요'}`
      : run.status === 'failed' || run.status === 'budget-exceeded' ? '실패 원인 확인 후 재개 판단'
      : run.status === 'done' ? '완료' : current ? `${current.nodeId} 완료 대기` : arrivalNode ? `${arrivalNode} 도착 · 시작 대기` : '다음 노드 관측 대기';
  const nodeIndex = run ? Math.min(run.path.length, run.nodes.length + (run.status === 'running' || run.status === 'awaiting-approval' ? 1 : 0)) : 0;
  const versioned = version !== '판 미기록';
  const gatePath = gateShardsPath(version, ledgerRoot);
  const gateShardsSource = `elanous://release/${encodeURIComponent(version)}/gate-shards`;
  const gateVerdictSource = `elanous://release/${encodeURIComponent(version)}/gate-verdict`;
  const scheduleFactSource = `elanous://release/${encodeURIComponent(version)}/schedule`;
  let gateFile: ReturnType<typeof readGateShards> = null;
  try {
    if (!versioned) throw Object.assign(new Error('unversioned'), { code: 'ENOENT' });
    readFileSync(gatePath, 'utf8');
    gateFile = readGateShards(gatePath);
    if (!gateFile) ledgerErrors.push({ signal: 'gate-shards', source: gateShardsSource, reason: '원장 형식 오류' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ledgerErrors.push({ signal: 'gate-shards', source: gateShardsSource, reason: unreadableReason(error) });
  }
  const gate = gateFile?.version === version ? summarizeShards(gateFile, Date.now()) : null;
  const terminalShards = gateFile?.shards.filter(shard => ['done', 'failed', 'timeout'].includes(shard.state)).length ?? 0;
  let regressions: Extract<ContextFact, { kind: 'release' }>['regressions'] = gate?.verdict
    ? { introduced: gate.verdict.introduced, preexisting: gate.verdict.preexisting } : null;
  let receiptStatus: Extract<ContextFact, { kind: 'release' }>['receiptStatus'] = 'absent';
  let verdict: GateVerdictEvidence | null = null;
  if (version !== '판 미기록') {
    try {
      const rawVerdict: unknown = JSON.parse(readFileSync(join(ledgerRoot, 'release', version, 'gate-verdict.json'), 'utf8'));
      if (!isGateVerdictEvidence(rawVerdict, version)) throw new Error('원장 형식 오류');
      const parsed = rawVerdict;
      verdict = parsed;
      if (!regressions && (Array.isArray(verdict.introduced) || typeof verdict.preexisting === 'number')) {
        regressions = { introduced: Array.isArray(verdict.introduced) ? verdict.introduced.length : null,
          preexisting: typeof verdict.preexisting === 'number' ? verdict.preexisting : null };
      }
      receiptStatus = verdict.baselineReceipt?.valid === true ? 'valid'
        : verdict.baselineReceipt?.valid === false ? 'invalid' : 'absent';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        receiptStatus = 'unreadable';
        const formatError = error instanceof SyntaxError || (error instanceof Error && error.message === '원장 형식 오류');
        ledgerErrors.push({ signal: 'gate-verdict', source: gateVerdictSource,
          reason: formatError ? '원장 형식 오류' : unreadableReason(error) });
      }
    }
  }
  const waiverEvents = (raw.nodes ?? []).flatMap(node => node.waiver?.reason
    ? [`${oneLine(String(node.nodeId ?? '노드'))}: ${oneLine(String(node.waiver.reason))}${node.waiver.approvedBy ? ` · 승인 ${oneLine(String(node.waiver.approvedBy))}` : ''}`]
    : []);
  let landingFreeze: Extract<ContextFact, { kind: 'release' }>['landingFreeze'];
  try {
    const freeze = readLandingFreeze(ledgerRoot);
    landingFreeze = freeze ? { state: 'on', reason: oneLine(freeze.reason) } : { state: 'off' };
  } catch (error) {
    landingFreeze = { state: 'unknown' };
    ledgerErrors.push({ signal: 'landing-freeze', source: 'elanous://landing-freeze', reason: unreadableReason(error) });
  }
  let schedule: ReturnType<typeof getSchedule> = null;
  try { if (versioned) schedule = getSchedule(version, ledgerRoot); }
  catch (error) { ledgerErrors.push({ signal: 'schedule', source: scheduleFactSource, reason: unreadableReason(error) }); }
  if (!run && !runUnavailable) nextAction = schedule ? '예약 시각 대기' : landingFreeze?.state === 'on' ? '착지 동결 해제 대기' : '런 관측 대기';
  const runPublishAt = typeof raw.input?.publishAt === 'string' && Number.isFinite(Date.parse(raw.input.publishAt))
    ? new Date(raw.input.publishAt).toISOString() : null;
  const expectedPublishAt = schedule?.publishAt ?? runPublishAt;
  const parsedOutputs = (raw.nodes ?? []).flatMap(node => {
    const value = node.output;
    if (value && typeof value === 'object' && !Array.isArray(value)) return [{ nodeId: node.nodeId, output: value as Record<string, unknown> }];
    if (typeof value !== 'string') return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [{ nodeId: node.nodeId, output: parsed as Record<string, unknown> }] : [];
    } catch { return []; }
  });
  const etaSources = [raw, ...parsedOutputs.map(entry => entry.output)];
  const etaValue = etaSources.map(source => source.etaMinutes)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const etaTimestamp = etaSources.map(source => source.etaAt ?? source.estimatedCompletionAt)
    .find((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)));
  const etaMinutes = etaValue !== undefined ? Math.ceil(etaValue)
    : etaTimestamp !== undefined ? Math.max(0, Math.ceil((Date.parse(etaTimestamp) - now.getTime()) / 60_000)) : null;
  const auditMeasurement = parsedOutputs.filter(entry => entry.nodeId === 'receipt-audit').map(entry => entry.output.measurement)
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value))
    .at(-1);
  const auditTotal = auditMeasurement && Number.isSafeInteger(auditMeasurement.totalFiles)
    && Number(auditMeasurement.totalFiles) >= 0 ? Number(auditMeasurement.totalFiles) : null;
  const auditCovered = auditMeasurement && Number.isSafeInteger(auditMeasurement.coveredFiles)
    && Number(auditMeasurement.coveredFiles) >= 0 ? Number(auditMeasurement.coveredFiles) : null;
  const hasExplicitUnmeasured = !!auditMeasurement && Object.hasOwn(auditMeasurement, 'unmeasuredFiles');
  const explicitUnmeasured = auditMeasurement && Number.isSafeInteger(auditMeasurement.unmeasuredFiles)
    && Number(auditMeasurement.unmeasuredFiles) >= 0 ? Number(auditMeasurement.unmeasuredFiles) : null;
  const auditUnmeasured = hasExplicitUnmeasured ? explicitUnmeasured
    : auditTotal !== null && auditCovered !== null && auditCovered <= auditTotal ? auditTotal - auditCovered : null;
  const auditCoverage = auditTotal !== null && auditUnmeasured !== null && auditUnmeasured <= auditTotal
    ? { uncoveredFiles: auditUnmeasured, totalFiles: auditTotal } : null;
  const measuredNodeCount = (...keys: string[]): number | null => {
    const values = parsedOutputs.flatMap(entry => keys.map(key => entry.output[key]));
    const lists = values.filter(Array.isArray) as unknown[][];
    const validLists = lists.filter(list => list.every(value => typeof value === 'string'));
    const ids = new Set(validLists.flat().filter((value): value is string => typeof value === 'string'));
    const scalar = values.map(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)
      .filter((value): value is number => value !== null).at(-1) ?? null;
    return validLists.length ? Math.max(ids.size, scalar ?? 0) : scalar;
  };
  const residualRuns = run && rawReadable && !runUnavailable && Array.isArray(raw.nodes)
    ? raw.nodes.filter(node => node.nodeId === 'residual-run' && node.endedAt == null).length : null;
  let sweepCertificateAgeMinutes: number | null = null;
  const sweepCertificateSource = `elanous://release/${encodeURIComponent(version)}/sweep-certificate`;
  try {
    if (versioned) {
      const certificate = readSweepCertificate(join(ledgerRoot, 'release', version, 'gate-logs', 'cut', 'receipts'));
      if (certificate && certificate.measuredAt <= now.getTime()) sweepCertificateAgeMinutes = Math.floor((now.getTime() - certificate.measuredAt) / 60_000);
    }
  } catch (error) {
    ledgerErrors.push({ signal: 'sweep-certificate', source: sweepCertificateSource, reason: unreadableReason(error) });
  }
  const nodeIntroduced = measuredNodeCount('introduced');
  const nodePreexisting = measuredNodeCount('preexisting');
  const nodeUndetermined = measuredNodeCount('undetermined', 'unmeasured');
  const failureCounts = regressions || nodeIntroduced !== null || nodePreexisting !== null || nodeUndetermined !== null ? {
    introduced: regressions?.introduced ?? nodeIntroduced,
    preexisting: regressions?.preexisting ?? nodePreexisting,
    undetermined: nodeUndetermined,
  } : null;
  const progress = gateFile?.version === version ? { completed: terminalShards, total: gateFile.shards.length,
    failed: gateFile.shards.filter(shard => shard.state === 'failed' || shard.state === 'timeout' || (shard.state === 'done' && shard.rc !== undefined && shard.rc !== 0)).length } : null;
  if (ledgerErrors.some(error => error.signal === 'schedule-index')) sourceRefs.push({ signal: 'schedule-index', source: scheduleSource });
  if (ledgerErrors.some(error => error.signal === 'release-index')) sourceRefs.push({ signal: 'release-index', source: 'elanous://release' });
  if (progress) sourceRefs.push({ signal: 'gate-progress', source: gateShardsSource });
  if (arrival) sourceRefs.push({ signal: 'node-arrival', source: arrival.refs.source ?? arrival.refs.url ?? runSourceRef });
  if (regressions) sourceRefs.push({ signal: 'regressions', source: gate?.verdict ? gateShardsSource : gateVerdictSource });
  sourceRefs.push({ signal: 'receipt-status', source: gateVerdictSource },
    { signal: 'landing-freeze', source: 'elanous://landing-freeze' });
  if (waiverEvents.length) sourceRefs.push({ signal: 'waivers', source: runSourceRef });
  if (expectedPublishAt) sourceRefs.push({ signal: 'expected-publish-at', source: schedule?.publishAt ? scheduleFactSource : runSourceRef });
  if (auditMeasurement) sourceRefs.push({ signal: 'receipt-audit', source: runSourceRef });
  if (sweepCertificateAgeMinutes !== null) sourceRefs.push({ signal: 'sweep-certificate', source: sweepCertificateSource });
  if (!run && !schedule && landingFreeze?.state !== 'on' && !gateFile && !regressions && receiptStatus === 'absent' && !ledgerErrors.length) return null;
  const runNode = run ? `${nodeIndex}/${run.path.length}${run.path[nodeIndex - 1] ? ` ${oneLine(run.path[nodeIndex - 1]!)}` : ''}`
    : runUnavailable ? '런 관측 불가' : '런 없음';
  return { kind: 'release', version, node: runNode,
    status: oneLine(run?.status ?? (runUnavailable ? 'unknown' : 'no-run')), source: runSourceRef, phase: oneLine(phase), currentNode: current?.nodeId ?? arrivalNode ?? null,
    nextAction, gateProgress: progress, regressions, receiptStatus, waiverEvents,
    // The dedicated RLA emergency-publish switch is not in the current ledger yet; do not infer it from landing-freeze.
    emergencySwitch: { state: 'unknown' }, landingFreeze, expectedPublishAt, etaMinutes, auditCoverage, residualRuns,
    sweepCertificateAgeMinutes, failureCounts, sourceRefs, ledgerErrors };
}

function lateScheduleFact(now: Date): Extract<ContextFact, { kind: 'schedule-late' }> {
  const names = localLoopRows(now).filter(row => row.verdict === 'late').map(row => oneLine(row.name));
  return { kind: 'schedule-late', count: names.length, names, source: scheduleSource };
}

function unreadableReason(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error)) || '원천 조회 실패';
}

/** Read a bounded, source-labelled view of current ledgers, never a transcript or decision body. */
export function contextNow(options: { topic?: string; limit?: number; audience?: 'operator' | 'user' | 'public-demo' } = {}, deps: ContextNowDeps = {}): ContextNowAnswer {
  const now = (deps.now ?? (() => new Date()))();
  const at = `${now.toISOString().slice(0, 16)}:00.000Z`;
  const topic = options.topic?.trim() || null;
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit))) : 20;
  const version = (deps.version ?? devVersion)().replace(/-.*$/, '');
  const next = version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_, major: string, minor: string, patch: string) => `${major}.${minor}.${Number(patch) + 1}`);
  const facts: ContextFact[] = [];
  for (const v of [...new Set([version, next])]) {
    const checklist = (deps.checklist ?? listChecklist)(v);
    if (v === version) facts.push({ kind: 'version', version: v, source: `elanous://release/${v}/checklist` });
    for (const item of checklist.items) {
      if (item.status === 'done') continue;
      facts.push({ kind: 'cell', version: v, id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
        status: item.status, owner: item.owner ?? null, priority: item.priority ?? null,
        source: `elanous://release/${v}/checklist#${encodeURIComponent(item.id)}` });
    }
  }
  for (const item of (deps.decisions ?? (() => new DecisionLedger().list({ status: 'open' })))()) {
    if (item.status !== 'open') continue;
    facts.push({ kind: 'decision', id: item.id, title: redactSecretText(item.title.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
      status: item.status, dueAt: item.dueAt ?? null, source: `elanous://decisions/${encodeURIComponent(item.id)}` });
  }
  facts.push(...(deps.seatEntries ?? todaySeatEntries)(now).map(seatFact));
  const rawEvents = (deps.events ?? (since => listCoordEvents({ since })))(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const chronologicalEvents = rawEvents.slice().sort((a, b) => a.at.localeCompare(b.at));
  const matches = (text: string) => !topic || text.toLocaleLowerCase().includes(topic.toLocaleLowerCase());
  const operationsTopic = topic?.toLocaleLowerCase() === 'ops';
  const asksRelease = operationsTopic || Boolean(topic && /발행|출시|릴리스|release|게이트|gate/i.test(topic));
  const operational: ContextFact[] = [];
  if (options.audience !== 'public-demo') {
    try { operational.push(...(deps.runningRuns ?? (date => runningRunFacts(date, deps.queryRuns)))(now)); }
    catch (error) { operational.push({ kind: 'run', goal: '', phase: '', elapsed: '', source: runSource, unreadable: unreadableReason(error) }); }
    try {
      if (deps.releaseRun) {
        const release = deps.releaseRun();
        if (release) operational.push(release);
      } else operational.push(...releaseContextFacts(version, chronologicalEvents, now));
    } catch (error) { operational.push({ kind: 'release', version: '', node: '', status: '', source: releaseSource, unreadable: unreadableReason(error) }); }
    try { const schedules = (deps.lateSchedules ?? lateScheduleFact)(now); if (schedules) operational.push(schedules); }
    catch (error) { operational.push({ kind: 'schedule-late', count: null, names: [], source: scheduleSource, unreadable: unreadableReason(error) }); }
  }
  const selectedOperational = operational.filter(f => !topic || operationsTopic || ('unreadable' in f && !!f.unreadable) || (f.kind === 'run' && matches(`${f.goal} ${f.phase}`))
    || (f.kind === 'release' && (asksRelease || matches(`${f.version} ${f.node} ${f.status}`)))
    || (f.kind === 'schedule-late' && matches(f.names.join(' '))));
  const selectedFacts = facts.filter(f => !topic || (f.kind === 'cell' && matches(`${f.id} ${f.title}`))
    || (f.kind === 'seat' && matches(`${f.id ?? ''} ${f.title ?? ''}`)));
  const groups = (['version', 'cell', 'decision', 'seat'] as const).map(kind => selectedFacts.filter(f => f.kind === kind));
  groups[3]!.sort((a, b) => (a.kind === 'seat' && b.kind === 'seat' ? b.at.localeCompare(a.at) : 0));
  const nonEmpty = groups.filter(group => group.length > 0);
  const perKind = Math.floor(limit / nonEmpty.length);
  const chosen = groups.map(group => group.splice(0, perKind));
  let remaining = limit - chosen.reduce((total, group) => total + group.length, 0);
  for (const index of [2, 3, 0, 1]) {
    if (remaining <= 0) break;
    if (chosen[index]!.length === 0 && groups[index]!.length > 0) {
      chosen[index]!.push(...groups[index]!.splice(0, 1));
      remaining--;
    }
  }
  for (const index of [1, 2, 3, 0]) {
    if (remaining <= 0) break;
    const extra = groups[index]!.splice(0, remaining);
    chosen[index]!.push(...extra);
    remaining -= extra.length;
  }
  const boundedFacts = [...selectedOperational.slice(0, limit), ...chosen.flat()];
  const summaries = chronologicalEvents.map(event => ({
    at: event.at, kind: event.kind, summary: redactSecretText(event.summary.split(/\r?\n/, 1)[0] ?? '').slice(0, 120),
    source: event.refs.source ?? event.refs.url ?? `elanous://context/event/${encodeURIComponent(event.id)}`,
  }));
  const selectedEvents = summaries.filter(event => matches(event.summary)).reverse().slice(0, limit);
  const guide = summaries.filter(event => event.kind === 'guide-changed' || event.kind === 'guidance-changed' || event.summary.startsWith('📌안내'))
    .filter(event => matches(event.summary)).reverse().slice(0, limit)
    .map(event => `📌 ${event.summary} — ${event.source}`);
  const answer = { at, topic, facts: boundedFacts, events: selectedEvents, guide };
  debug.log('context.now', 'answer', { topic, facts: answer.facts, events: answer.events });
  return options.audience === 'public-demo' ? filterPublicDemoContext(answer, deps.brandCheck) : answer;
}

export type AskOpContextTopic = 'release' | 'required' | 'train' | 'incident' | 'decision' | 'general';
export type AskOpContextBundle = {
  queriedAt: string;
  topic: AskOpContextTopic;
  facts: Array<{ kind: string; summary: string; source: string; observedAt: string }>;
  gaps: Array<{ kind: string; reason: string }>;
};

function askOpTopic(question: string): AskOpContextTopic {
  const text = question.toLocaleLowerCase();
  if (/열차|착지|병합|merge|train|pull request|\bpr\b/.test(text)) return 'train';
  if (/사고|장애|incident|failure|실패|에러|오류/.test(text)) return 'incident';
  if (/결정|승인|decision|approval/.test(text)) return 'decision';
  if (/필수|p0|must|required|우선순위/.test(text)) return 'required';
  if (/발행|출시|릴리스|release|컷|cut|게이트|gate|이번 판|다음 판|판 진도|\b\d+\.\d+\.\d+\b/.test(text)) return 'release';
  return 'general';
}

/** A small evidence packet for an OP answer. A missing source stays a gap, never an inferred fact. */
export function buildAskOpContextBundle(
  question: string,
  snapshot: ContextNowAnswer,
  options: { audience?: 'operator' | 'public-demo'; limit?: number } = {},
): AskOpContextBundle {
  const answer = options.audience === 'public-demo' ? filterPublicDemoContext(snapshot) : snapshot;
  const topic = askOpTopic(question);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(20, Math.floor(options.limit))) : 8;
  const facts: AskOpContextBundle['facts'] = [];
  const gaps: AskOpContextBundle['gaps'] = [];
  const pushFact = (kind: string, summary: string, source: string, observedAt: string) => {
    if (facts.length < limit) facts.push({ kind, summary: oneLine(summary), source, observedAt });
  };
  const relevant = (kind: ContextFact['kind']) => topic === 'general'
    || (topic === 'release' && (kind === 'release' || kind === 'version'))
    || (topic === 'required' && kind === 'cell')
    || (topic === 'decision' && kind === 'decision')
    || (topic === 'incident' && kind === 'run');
  for (const fact of answer.facts) {
    if (!relevant(fact.kind)) continue;
    if ('unreadable' in fact && fact.unreadable) {
      gaps.push({ kind: fact.kind, reason: fact.unreadable });
      continue;
    }
    if (topic === 'required' && fact.kind === 'cell' && fact.priority !== 'P0') continue;
    if (topic === 'incident' && fact.kind === 'run' && !/fail|error|timeout|실패|오류|정지|중단/i.test(`${fact.phase} ${fact.goal}`)) continue;
    if (topic === 'train') continue;
    const summary = fact.kind === 'version' ? `판 ${fact.version}`
      : fact.kind === 'cell' ? `${fact.id} ${fact.status} ${fact.title}`
      : fact.kind === 'decision' ? `${fact.id} ${fact.status} ${fact.title}`
      : fact.kind === 'seat' ? `${fact.seat} ${fact.status} ${fact.id ?? ''}`
      : fact.kind === 'run' ? `${fact.goal} ${fact.phase} ${fact.elapsed}`
      : fact.kind === 'release' ? `${fact.version} ${fact.node} ${fact.status}`
      : `${fact.count ?? '미관측'}건 ${fact.names.join(', ')}`;
    pushFact(fact.kind, summary, fact.source, fact.kind === 'seat' ? fact.at : answer.at);
  }
  const eventMatches = (kind: string, summary: string) => topic === 'general'
    || (topic === 'train' && /train|열차|착지|병합|merge|\bpr\b/i.test(`${kind} ${summary}`))
    || (topic === 'incident' && /incident|사고|장애|failure|실패|에러|오류|timeout/i.test(`${kind} ${summary}`));
  for (const event of answer.events) {
    if (eventMatches(event.kind, event.summary)) pushFact(event.kind, event.summary, event.source, event.at);
  }
  if (topic === 'required' && !facts.length) {
    const cells = answer.facts.filter(fact => fact.kind === 'cell');
    if (cells.some(fact => fact.priority == null)) gaps.push({ kind: 'cell', reason: '우선순위 미관측' });
    else if (cells.length) gaps.push({ kind: 'cell', reason: '조회 범위에서 일치하는 P0 없음' });
  }
  if (!facts.length && !gaps.length) gaps.push({ kind: topic, reason: '미관측' });
  if (topic === 'release' && !answer.facts.some(fact => fact.kind === 'release' && !('unreadable' in fact && fact.unreadable))
    && !gaps.some(gap => gap.kind === 'release')) gaps.push({ kind: 'release', reason: '미관측' });
  return { queriedAt: answer.at, topic, facts, gaps: gaps.slice(0, 3) };
}

/** Worker scan keeps ledger IO away from the OP inbox turn; the packet itself is bounded. */
export async function askOpContextBundle(
  question: string,
  options: { audience?: 'operator' | 'public-demo'; limit?: number } = {},
  readSnapshot: () => Promise<ContextNowAnswer> = () => contextNowInWorker({ audience: 'operator', limit: 100 }),
): Promise<AskOpContextBundle> {
  try { return buildAskOpContextBundle(question, await readSnapshot(), { ...options, audience: options.audience ?? 'public-demo' }); }
  catch { return { queriedAt: new Date().toISOString(), topic: askOpTopic(question), facts: [], gaps: [{ kind: 'context', reason: '조회 실패' }] }; }
}

const workerAnswers = new Map<string, { promise: Promise<ContextNowAnswer>; expiresAt: number }>();
const WORKER_ANSWER_TTL_MS = 5_000;
const WORKER_SCAN_TIMEOUT_MS = 60_000;
let workerScanTail: Promise<void> = Promise.resolve();

/** Keep the ledger scan off the TUI event loop. Repeated identical reads share one scan. */
export function contextNowInWorker(options: Parameters<typeof contextNow>[0] = {}): Promise<ContextNowAnswer> {
  const stateRoot = process.env.ELANOUS_STATE_DIR;
  const selectedRoot = effectiveInstanceRoot();
  const key = JSON.stringify([selectedRoot, stateRoot ?? null, options.topic ?? null, options.limit ?? null, options.audience ?? null]);
  const now = Date.now();
  for (const [cachedKey, cached] of workerAnswers) {
    if (cached.expiresAt < now) workerAnswers.delete(cachedKey);
  }
  const cached = workerAnswers.get(key);
  if (cached) return cached.promise;
  // Distinct topics queue behind the active scan instead of multiplying the same costly ledger walk.
  const promise = workerScanTail.then(() => scanContextNowInWorker(options, stateRoot, selectedRoot));
  workerScanTail = promise.then(() => undefined, () => undefined);
  const entry = { promise, expiresAt: Infinity };
  workerAnswers.set(key, entry);
  void promise.then(() => { entry.expiresAt = Date.now() + WORKER_ANSWER_TTL_MS; }, () => { workerAnswers.delete(key); });
  return promise;
}

export function scanContextNowInWorker(options: Parameters<typeof contextNow>[0], stateRoot: string | undefined, selectedRoot: string,
  createWorker: () => Worker = () => new Worker(new URL(import.meta.url), { workerData: { kind: 'context-now' } }),
  timeoutMs = WORKER_SCAN_TIMEOUT_MS): Promise<ContextNowAnswer> {
  const worker = createWorker();
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      debug.log('context.now', 'worker-timeout', { timeoutMs, topic: options?.topic ?? null, selectedRoot });
      finish(new Error(`context_now worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error?: Error, answer?: ContextNowAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // 첫 호출 지연은 색인과 무관하게 «따로» 재야 판정선과 비교할 수 있다 — 스캔 자체의 ms 를 남긴다.
      debug.log('context.now', 'worker-answer', { topic: options?.topic ?? null, ok: !error, ms: Date.now() - startedAt });
      void worker.terminate();
      if (error) reject(error);
      else resolve(answer!);
    };
    worker.on('message', (message: { answer?: ContextNowAnswer; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else if (message.answer) finish(undefined, message.answer);
    });
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => { if (!settled) finish(new Error(`context_now worker exited before answering: ${code}`)); });
    // Preserve both caller roots: a programmatic config override is not inherited by workers.
    worker.postMessage({ options, stateRoot, selectedRoot });
  });
}

const contextWorkerPort = parentPort;
if (!isMainThread && contextWorkerPort && workerData?.kind === 'context-now') {
  contextWorkerPort.on('message', ({ options, stateRoot, selectedRoot }: { options: Parameters<typeof contextNow>[0]; stateRoot?: string; selectedRoot: string }) => {
    try {
      if (stateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = stateRoot;
      setElanousConfigDir(selectedRoot);
      contextWorkerPort.postMessage({ answer: contextNow(options) });
    }
    catch (error) { contextWorkerPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
