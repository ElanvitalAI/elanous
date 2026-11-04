import type { DaemonClient } from './daemon-client';

export type TrainRejectReason = 'typecheck' | 'ratchet' | 'introduced' | 'setup-unmeasured' | 'authorization' | 'lock-owner' | 'other';
export interface TrainThroughputTotals {
  assigned: number; assignedPrs: number; completed: number; succeeded: number; rejected: number; failed: number;
  rejectedByReason: Record<TrainRejectReason, number>; unmeasured: number; landed: number | null; averageWaitSeconds: number | null;
}
export interface TrainThroughput {
  date: string; generatedAt: string; sourceIncomplete?: boolean; hosts: Record<string, TrainThroughputTotals>;
  hours: Record<string, TrainThroughputTotals>; attempts: Array<{ host: string; runId: string; stage: string; prs: number[];
    assignedAt: string; finishedAt?: string; rc?: number; detail?: string }>;
}


export type OpsResult<T> = { kind: 'ready'; data: T } | { kind: 'forbidden' } | { kind: 'error'; status: number };
// startedAt/endedAt 은 GRAPH-NODE-TIMES(0.2.19 TC) 가 원장에 넣는다 — 그 전엔 없다(화면은 «시각 미기록»).
export interface ReleaseNode { nodeId: string; ok: boolean | null; summary: string; startedAt?: string | null; endedAt?: string | null }
// GATE-LIVE-OBS — 데몬이 «지금 gate 노드인 런»에만 싣는 조각 표(발행 원장 shards.json · src/release-loop/gate-shards.ts 가 계약).
export type GateShardState = 'pending' | 'running' | 'done' | 'retry' | 'timeout' | 'failed';
export interface GateShard {
  id: string; state: GateShardState; startedAt?: string; endedAt?: string;
  installSec?: number; rc?: number; waitReason?: string; plannedMin?: number;
}
export interface GateShards {
  version: string; updatedAt: string; shards: GateShard[];
  summary: { total: number; counts: Record<GateShardState, number>; waitReasons: Array<{ reason: string; count: number }>; etaMin: number | null; staleMin: number | null; overrunMin?: number; doneWithFailures?: number;
    /** 게이트 노드 판정(기존/새로). null·없음 = «판정 전» — 「새 실패 0」과 다르다(src/release-loop/gate-shards.ts). */
    verdict?: { introduced: number; preexisting: number } | null };
}
export interface ReleaseRun {
  runId: string;
  status: string;
  startedAt: string;
  version: string | null;
  path: string[];
  nodes: ReleaseNode[];
  gateShards?: GateShards;
}
// 모르는 상태값(예: 앞으로 생길 blocked)은 버리지 않고 그대로 싣는다 — 칸 하나 때문에 화면 전체가 오류가 되지 않게.
export type ChecklistStatus = 'green' | 'yellow' | 'red' | 'done' | (string & {});
export interface OpsChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  owner?: string;
  updatedAt: string;
  evidence?: string;
}
export interface OpsSeat {
  seat: 'OP' | 'MK' | 'TC' | 'UX';
  role?: string;
  now: { text: string; at: string } | null;
  landed: Array<{ pr: number; title: string; at: string; checklistId: string | null }> | null;
  blocked: Array<{ id: string; title: string; status: 'red' }> | null;
  pendingDecisions: number | null;
  checklist: { green: number; yellow: number; red: number; done: number } | null;
  subSeats?: Array<{ id: string; title: string; open: number | null; landed: number | null; blocked: Array<{ id: string; title: string }> | null }> | null;
}
export interface OpsSeats { date: string; seats: OpsSeat[] }

export interface OpsChecklist {
  version: string;
  codename?: string;
  schedule?: { cutAt: string; landBy: string | null } | null;
  items: OpsChecklistItem[];
  green: number;
  yellow: number;
  red: number;
  done: number;
  blocked?: string[];
  byOwner?: Record<string, number>;
  history?: unknown[];
}

export interface ResourceLedger {
  observedAt: string;
  readStatus: 'ok';
  matrix: Array<{ host: string; lane: string; capacity: number | null; leases: number; leasedCpu: number; leasedMemoryBytes: number;
    observedPodCpuRequests: number | null; observedPodMemoryRequestsBytes: number | null; measuredPods: number | null;
    unknownPods: number | null; measuredProcesses: number | null; unknownProcesses: number | null; deltaLeasesVsPods: number | null }>;
  leases: Array<{ id: string; fp: string; host: string; lane: string; resources: { cpu?: number; memoryBytes?: number; shards?: number; pods?: number };
    mission: { cell?: string; goalId?: string; pr?: number }; heartbeatAt: string; startedAt: string }>;
  recentReclaims?: Array<{ id: string; fp: string; host: string; lane: string; at: string; kind: 'lease-ended' | 'lease-reaped'; reason: string; stoppedBy: string }>;
  measurements: Array<{ host: string; observedAt: string; pods: Array<{ id: string; phase: string; fp?: string; lane?: string; mission?: string }>;
    processes: Array<{ id: string; fp?: string; lane?: string; mission?: string }>; errors: string[] }>;
  findings: Array<{ kind: string; host: string; id: string; fp?: string; detail: string; action: 'report-only' }>;
}
export interface ResourceGuardianSnapshot {
  state: 'pending' | 'ready' | 'stale' | 'failed'; stale: boolean; observedAt: string | null;
  staleReason?: string; lastFailureAt?: string;
  findings: Array<{ kind: string; host: string; id: string; fp?: string; detail: string; action: 'report-only' }>;
  cleanup: { reaped: number; skipped: number; errors: number };
  releaseReservation?: { status: string; reason: string };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown): value is string { return typeof value === 'string'; }
function utcIso(value: unknown): value is string {
  return string(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function node(value: unknown): value is ReleaseNode {
  return record(value) && string(value.nodeId) && (value.ok === null || typeof value.ok === 'boolean') && string(value.summary)
    && (value.startedAt === undefined || value.startedAt === null || string(value.startedAt))
    && (value.endedAt === undefined || value.endedAt === null || string(value.endedAt));
}
const SHARD_STATES = new Set(['pending', 'running', 'done', 'retry', 'timeout', 'failed']);
const finiteOrMissing = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value));
function gateShards(value: unknown): value is GateShards {
  if (!record(value) || !string(value.version) || !string(value.updatedAt) || !Array.isArray(value.shards) || !record(value.summary)) return false;
  const summary = value.summary;
  return value.shards.every((shard: unknown) => record(shard) && string(shard.id) && SHARD_STATES.has(shard.state as string)
      && finiteOrMissing(shard.plannedMin) && finiteOrMissing(shard.installSec) && finiteOrMissing(shard.rc)
      && (shard.waitReason === undefined || string(shard.waitReason)))
    && Number.isInteger(summary.total) && record(summary.counts) && [...SHARD_STATES].every((key) => Number.isInteger((summary.counts as Record<string, unknown>)[key]))
    && Array.isArray(summary.waitReasons) && summary.waitReasons.every((row: unknown) => record(row) && string(row.reason) && Number.isInteger(row.count))
    && (summary.etaMin === null || typeof summary.etaMin === 'number') && (summary.staleMin === null || typeof summary.staleMin === 'number')
    && (summary.overrunMin === undefined || typeof summary.overrunMin === 'number');
}
function run(value: unknown): value is ReleaseRun {
  if (!(record(value) && string(value.runId) && string(value.status) && string(value.startedAt)
    && (value.version === null || string(value.version))
    && Array.isArray(value.path) && value.path.every(string)
    && Array.isArray(value.nodes) && value.nodes.every(node))) return false;
  // 조각 표가 깨졌으면 그 표만 버린다 — 런 목록 전체를 오류로 만들지 않는다.
  if (value.gateShards !== undefined && !gateShards(value.gateShards)) delete value.gateShards;
  return true;
}
function item(value: unknown): value is OpsChecklistItem {
  return record(value) && string(value.id) && string(value.title)
    && string(value.status)
    && (value.owner === undefined || string(value.owner)) && string(value.updatedAt)
    && (value.evidence === undefined || string(value.evidence));
}
function checklist(value: unknown): value is OpsChecklist {
  return record(value) && string(value.version) && (value.codename === undefined || string(value.codename))
    && Array.isArray(value.items) && value.items.every(item)
    && (['green', 'yellow', 'red', 'done'] as const).every((key) => value[key] === undefined || (Number.isInteger(value[key]) && (value[key] as number) >= 0))
    && (value.blocked === undefined || (Array.isArray(value.blocked) && value.blocked.every(string)))
    && (value.byOwner === undefined || (record(value.byOwner) && Object.values(value.byOwner).every((count) => Number.isInteger(count) && (count as number) >= 0)))
    && (value.history === undefined || Array.isArray(value.history));
}

const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
function subSeat(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.title)
    && (value.open === null || count(value.open)) && (value.landed === null || count(value.landed))
    && (value.blocked === null || (Array.isArray(value.blocked) && value.blocked.every((row: unknown) =>
      record(row) && string(row.id) && string(row.title))));
}
function seat(value: unknown): value is OpsSeat {
  return record(value) && ['OP', 'MK', 'TC', 'UX'].includes(value.seat as string)
    && (value.role === undefined || string(value.role))
    && (value.now === null || (record(value.now) && string(value.now.text) && string(value.now.at)))
    && (value.landed === null || (Array.isArray(value.landed) && value.landed.every((row: unknown) =>
      record(row) && count(row.pr) && string(row.title) && string(row.at) && (row.checklistId === null || string(row.checklistId)))))
    && (value.blocked === null || (Array.isArray(value.blocked) && value.blocked.every((row: unknown) =>
      record(row) && string(row.id) && string(row.title) && row.status === 'red')))
    && (value.pendingDecisions === null || count(value.pendingDecisions))
    && (value.checklist === null || (record(value.checklist) && (['green', 'yellow', 'red', 'done'] as const).every((key) => count((value.checklist as Record<string, unknown>)[key]))))
    && (value.subSeats === undefined || value.subSeats === null || (Array.isArray(value.subSeats) && value.subSeats.every(subSeat)));
}

async function get<T>(client: DaemonClient, path: string, parse: (value: unknown) => T | null): Promise<OpsResult<T>> {
  try {
    const response = await client.fetchResponse(path, { method: 'GET' });
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'error', status: response.status };
    const data = parse(await response.json());
    return data === null ? { kind: 'error', status: response.status } : { kind: 'ready', data };
  } catch {
    return { kind: 'error', status: 0 };
  }
}

export function getSeats(client: DaemonClient, date?: string): Promise<OpsResult<OpsSeats>> {
  return get(client, `/v1/ops/seats${date ? `?date=${encodeURIComponent(date)}` : ''}`,
    (value) => record(value) && string(value.date) && Array.isArray(value.seats) && value.seats.every(seat)
      && new Set(value.seats.map((row: OpsSeat) => row.seat)).size === value.seats.length ? { date: value.date, seats: value.seats } : null);
}

export function getReleaseRuns(client: DaemonClient, version?: string): Promise<OpsResult<ReleaseRun[]>> {
  return get(client, `/v1/ops/release/runs${version ? `?version=${encodeURIComponent(version)}` : ''}`,
    (value) => Array.isArray(value) && value.every(run) ? value : null);
}
export function getReleaseNodeLog(client: DaemonClient, runId: string, nodeId: string): Promise<OpsResult<{ log: string }>> {
  return get(client, `/v1/ops/release/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/log`,
    (value) => record(value) && string(value.log) ? { log: value.log } : null);
}
export function getOpsChecklist(client: DaemonClient, version: string): Promise<OpsResult<OpsChecklist>> {
  return get(client, `/v1/ops/checklist?version=${encodeURIComponent(version)}`, (value) => {
    if (!checklist(value)) return null;
    const counts = { green: 0, yellow: 0, red: 0, done: 0 };
    for (const entry of value.items) if (entry.status in counts) counts[entry.status as keyof typeof counts]++;
    return {
      version: value.version, ...(value.codename !== undefined ? { codename: value.codename } : {}),
      schedule: record(value.schedule) && utcIso(value.schedule.cutAt)
        && (value.schedule.landBy === null || utcIso(value.schedule.landBy))
        ? { cutAt: value.schedule.cutAt, landBy: value.schedule.landBy } : null,
      items: value.items,
      green: value.green ?? counts.green, yellow: value.yellow ?? counts.yellow,
      red: value.red ?? counts.red, done: value.done ?? counts.done,
      ...(value.blocked !== undefined ? { blocked: value.blocked } : {}),
      ...(value.byOwner !== undefined ? { byOwner: value.byOwner } : {}),
      ...(value.history !== undefined ? { history: value.history } : {}),
    };
  });
}

export function getResourceLedger(client: DaemonClient): Promise<OpsResult<ResourceLedger>> {
  return get(client, '/v1/ops/resources/ledger', (value) => {
    if (!record(value) || !string(value.observedAt) || value.readStatus !== 'ok'
      || !Array.isArray(value.matrix) || !Array.isArray(value.leases) || !Array.isArray(value.measurements) || !Array.isArray(value.findings)) return null;
    const numberOrNull = (input: unknown) => input === null || (typeof input === 'number' && Number.isFinite(input));
    const matrix = value.matrix;
    if (!matrix.every((row: unknown) => record(row) && string(row.host) && string(row.lane) && numberOrNull(row.capacity)
      && Number.isInteger(row.leases) && typeof row.leasedCpu === 'number' && typeof row.leasedMemoryBytes === 'number'
      && numberOrNull(row.observedPodCpuRequests) && numberOrNull(row.observedPodMemoryRequestsBytes)
      && numberOrNull(row.measuredPods) && numberOrNull(row.unknownPods) && numberOrNull(row.measuredProcesses)
      && numberOrNull(row.unknownProcesses) && numberOrNull(row.deltaLeasesVsPods))) return null;
    if (!value.leases.every((lease: unknown) => record(lease) && string(lease.id) && string(lease.fp) && string(lease.host)
      && string(lease.lane) && record(lease.resources) && record(lease.mission) && string(lease.heartbeatAt) && string(lease.startedAt))) return null;
    if (value.recentReclaims !== undefined && (!Array.isArray(value.recentReclaims) || !value.recentReclaims.every((row: unknown) => record(row) && string(row.id)
      && string(row.fp) && string(row.host) && string(row.lane) && string(row.at)
      && (row.kind === 'lease-ended' || row.kind === 'lease-reaped') && string(row.reason) && string(row.stoppedBy)))) return null;
    if (!value.measurements.every((measurement: unknown) => record(measurement) && string(measurement.host) && string(measurement.observedAt)
      && Array.isArray(measurement.pods) && Array.isArray(measurement.processes) && Array.isArray(measurement.errors)
      && measurement.errors.every(string))) return null;
    if (!value.findings.every((finding: unknown) => record(finding) && string(finding.kind) && string(finding.host)
      && string(finding.id) && string(finding.detail) && finding.action === 'report-only')) return null;
    return value as unknown as ResourceLedger;
  });
}

export function getResourceGuardian(client: DaemonClient): Promise<OpsResult<ResourceGuardianSnapshot>> {
  return get(client, '/v1/ops/resources/guardian', (value) => {
    if (!record(value) || !['pending', 'ready', 'stale', 'failed'].includes(value.state as string)
      || typeof value.stale !== 'boolean' || (value.observedAt !== null && !string(value.observedAt))
      || (value.staleReason !== undefined && !string(value.staleReason))
      || (value.lastFailureAt !== undefined && !string(value.lastFailureAt))
      || !Array.isArray(value.findings) || !record(value.cleanup)) return null;
    const count = (input: unknown) => Number.isSafeInteger(input) && (input as number) >= 0;
    if (!value.findings.every((finding: unknown) => record(finding) && string(finding.kind) && string(finding.host)
      && string(finding.id) && (finding.fp === undefined || string(finding.fp)) && string(finding.detail)
      && finding.action === 'report-only')) return null;
    if (!count(value.cleanup.reaped) || !count(value.cleanup.skipped) || !count(value.cleanup.errors)) return null;
    if (value.releaseReservation !== undefined && !(record(value.releaseReservation)
      && string(value.releaseReservation.status) && string(value.releaseReservation.reason))) return null;
    if (value.state === 'pending' && value.observedAt !== null) return null;
    if (value.state === 'ready' && (value.stale || value.observedAt === null)) return null;
    if (value.state === 'stale' && !value.stale) return null;
    if (value.state === 'failed' && (!value.stale || value.observedAt !== null || !string(value.lastFailureAt))) return null;
    return value as unknown as ResourceGuardianSnapshot;
  });
}

export function getTrainThroughput(client: DaemonClient, date: string): Promise<OpsResult<TrainThroughput>> {
  return get(client, `/v1/ops/train-throughput?date=${encodeURIComponent(date)}`, (value) => {
    if (!record(value) || !string(value.date) || !string(value.generatedAt) || (value.sourceIncomplete !== undefined && typeof value.sourceIncomplete !== 'boolean') || !record(value.hosts) || !record(value.hours) || !Array.isArray(value.attempts)) return null;
    const totals = (row: unknown): row is TrainThroughputTotals => {
      if (!record(row)) return false;
      const reasons = row.rejectedByReason;
      return ['assigned','assignedPrs','completed','succeeded','rejected','failed','unmeasured'].every(key => count(row[key]))
        && (row.landed === null || count(row.landed)) && (row.averageWaitSeconds === null || count(row.averageWaitSeconds))
        && record(reasons) && ['typecheck','ratchet','introduced','setup-unmeasured','authorization','lock-owner','other'].every(key => count(reasons[key]));
    };
    if (!Object.values(value.hosts).every(totals) || !Object.values(value.hours).every(totals)) return null;
    return value as unknown as TrainThroughput;
  });
}
