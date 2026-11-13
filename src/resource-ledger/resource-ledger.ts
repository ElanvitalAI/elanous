import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseMachinePoolDeclarations, type MachinePoolDeclaration } from './machine-pool-inventory.js';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { refuseProductionLedgerWriteInTest } from '../harness/ledger-write-guard.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { evaluateHostLeasePolicy, HOST_LEASE_ALTERNATIVE_HOSTS } from '../guardian/host-lease-policy.js';
import { debug } from '../debug/log.js';
import { isRecord } from '../primitives/guards.js';

export const RESOURCE_LANES = ['gate', 'train', 'ta', 'hand', 'warm', 'bench', 'unknown'] as const;
export type ResourceLane = typeof RESOURCE_LANES[number];

export interface ResourceLease {
  id: string;
  fp: string;
  host: string;
  lane: ResourceLane;
  resources: { cpu?: number; memoryBytes?: number; shards?: number; pods?: number };
  mission: { cell?: string; goalId?: string; pr?: number };
  ttlMs: number;
  heartbeatAt: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  stoppedBy?: string;
}

export interface WarmPoolPodReceipt {
  purpose: MachinePoolDeclaration['purpose'];
  host: string;
  podUid: string;
  digest: string;
  runtime: string;
  environment: string;
  skillPacks: Array<{ name: string; version: string }>;
  lastJob: string;
  cleanupResult: { state: 'clean' | 'unclean' | 'unknown'; procedure: string; reason: string; verifiedAt: string };
}

/** Durable host-scoped lease intent used by Guardian before remote work is dispatched. */
export interface GuardianHostLeaseRequest {
  requestId: string;
  runId: string;
  requestedBy: string;
  consumer: string;
  purpose: string;
  host: string;
  priority: string;
  expiresAt: string;
  releaseVersion?: string;
}

export type GuardianHostLeaseState = 'active' | 'released' | 'expired' | 'denied';
export interface GuardianHostLeaseRecord {
  leaseId: string;
  request: GuardianHostLeaseRequest;
  state: GuardianHostLeaseState;
  at: string;
  reason?: string;
  alternatives?: string[];
}

/** Human-authored, durable policy for the train worker supervisor. */
export interface TrainWorkerPolicy {
  minWorkers: number;
  maxWorkers: number;
  scaleDownCpuPercent: number;
  scaleUpCpuPercent: number;
  gateReserveWorkers: number;
}

/** A provider-reported cumulative monthly total; ingestion authority is established by its adapter. */
export interface GuardianCostSnapshot {
  measurementId: string;
  provider: string;
  month: string;
  spentKrw: number;
  measuredAt: string;
  evidenceRef: string;
}

export interface HostReadinessHeartbeat {
  host: string;
  at: string;
  /** Start of the current successful sample or failed-probe streak; at remains the latest observed tick. */
  freshnessAt?: string;
  sshAvailable: boolean;
  maintenance: boolean;
  gateProtected: boolean;
  tools: Record<string, boolean>;
  sample?: {
    loadPercent: number;
    load15Percent: number;
    memoryAvailablePercent: number;
    rootDiskUsedPercent: number;
    tmpDiskUsedPercent: number;
    rootDiskFreeGb?: number;
    tmpDiskFreeGb?: number;
  };
}

export type GuardianHostLeaseEvent = { event: 'guardian-host-lease'; at: string; record: GuardianHostLeaseRecord };
export type GuardianHostLeaseConflictEvent = { event: 'guardian-host-lease-conflict'; at: string; requestId: string; existingLeaseId: string; attemptedRequest: GuardianHostLeaseRequest };
export type GuardianHostLeaseAdmittedEvent = { event: 'guardian-host-lease-admitted'; at: string; leaseId: string; host: string; runId: string; consumer: string };
export type GuardianHostLeaseAdmissionDeniedEvent = { event: 'guardian-host-lease-admission-denied'; at: string; leaseId: string; host: string; runId: string; consumer: string; reason: 'lease-not-found' | 'lease-expired' | 'lease-not-active' | 'lease-owner-mismatch'; alternatives: string[] };

export type ResourceLedgerEvent =
  | { event: 'llm-proxy-call'; at: string; host: string; seat: string; purpose: string; pr?: number; model: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costBasis: 'subscription' | 'reported' | 'estimate' | 'unknown'; status: 'ok' | 'error' }
  | { event: 'lease-created'; at: string; lease: ResourceLease }
  | { event: 'lease-heartbeat'; at: string; id: string; heartbeatAt: string; resources?: ResourceLease['resources'] }
  | { event: 'lease-ended'; at: string; id: string; reason: string; stoppedBy: string }
  | { event: 'lease-reaped'; at: string; id: string; expectedHeartbeatAt: string; expectedExpiresAt: string; observedAt: string; reason: 'expired-and-absent' | 'machine-disappeared' }
  | { event: 'pool-declared'; at: string; pool: MachinePoolDeclaration }
  | { event: 'pool-pod-receipt'; at: string; receipt: WarmPoolPodReceipt }
  | GuardianHostLeaseEvent
  | GuardianHostLeaseConflictEvent
  | GuardianHostLeaseAdmittedEvent
  | GuardianHostLeaseAdmissionDeniedEvent
  | { event: 'train-worker-policy'; at: string; policy: TrainWorkerPolicy }
  | { event: 'guardian-cost-snapshot'; at: string; snapshot: GuardianCostSnapshot }
  | { event: 'host-readiness-heartbeat'; at: string; heartbeat: HostReadinessHeartbeat };

export interface ResourceMeasurement {
  host: string;
  observedAt: string;
  pods: Array<{ id: string; fp?: string; lane?: string; mission?: string; nodeName?: string; host?: string; scopeUnknown?: boolean; managed?: boolean; phase: string; cpu?: number; memoryBytes?: number; memoryUnknown?: boolean }>;
  processes: Array<{ id: string; fp?: string; lane?: string; mission?: string; command: string }>;
  errors: string[];
}

export interface ResourceFinding {
  kind: 'stale' | 'reaped-candidate' | 'orphan' | 'drift' | 'measurement-unavailable';
  host: string;
  id: string;
  fp?: string;
  detail: string;
  action: 'report-only';
  leaseHeartbeatAt?: string;
  leaseExpiresAtMs?: number;
  observedAtMs?: number;
  resourcePresent?: boolean;
}

export interface ResourceMatrixRow {
  host: string;
  lane: ResourceLane;
  capacity: number | null;
  leases: number;
  leasedCpu: number;
  leasedMemoryBytes: number;
  observedPodCpuRequests: number | null;
  observedPodMemoryRequestsBytes: number | null;
  deltaCpuRequests: number | null;
  deltaMemoryRequestsBytes: number | null;
  measuredPods: number | null;
  unknownPods: number | null;
  measuredProcesses: number | null;
  unknownProcesses: number | null;
  deltaLeasesVsPods: number | null;
}

const LEDGER_FILE = 'resource-ledger/events.jsonl';
const validHost = (host: string) => /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(host);
const validFp = (fp: string) => /^fp_[A-Za-z0-9_-]{6,128}$/.test(fp);
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validTimestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validResources(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([key, amount]) =>
    ['cpu', 'memoryBytes', 'shards', 'pods'].includes(key) && typeof amount === 'number' && Number.isFinite(amount) && amount >= 0);
}
function validGuardianRequest(value: unknown): value is GuardianHostLeaseRequest {
  if (!isRecord(value)) return false;
  return ['requestId', 'runId', 'requestedBy', 'consumer', 'purpose', 'host', 'priority'].every(key => validGuardianText(value[key]))
    && validHost(value.host as string) && validTimestamp(value.expiresAt)
    && (value.releaseVersion === undefined || validGuardianText(value.releaseVersion));
}

export function resourceLedgerPath(stateDir = elanousStateRoot()): string {
  return join(stateDir, LEDGER_FILE);
}

export interface UnknownResourceLedgerEventObservation { eventType: string; count: number }

export function readResourceLedger(path = resourceLedgerPath()): ResourceLedgerEvent[] {
  if (!existsSync(path)) return [];
  return parseResourceLedgerEvents(readFileSync(path, 'utf8'));
}

export function latestTrainWorkerPolicy(events: readonly ResourceLedgerEvent[]): TrainWorkerPolicy | undefined {
  return [...events].reverse().find((event): event is Extract<ResourceLedgerEvent, { event: 'train-worker-policy' }> =>
    event.event === 'train-worker-policy')?.policy;
}

export function recordTrainWorkerPolicy(policy: TrainWorkerPolicy, now = new Date(), path = resourceLedgerPath()): void {
  const event: ResourceLedgerEvent = { event: 'train-worker-policy', at: now.toISOString(), policy };
  parseResourceLedgerEvents(`${JSON.stringify(event)}\n`);
  withLedgerLock(path, () => appendEvent(event, path));
}

/** Persist one validated host readiness heartbeat into the Nexus resource ledger. */
export function recordHostReadinessHeartbeat(heartbeat: HostReadinessHeartbeat, path = resourceLedgerPath()): void {
  const event: ResourceLedgerEvent = { event: 'host-readiness-heartbeat', at: heartbeat.at, heartbeat };
  parseResourceLedgerEvents(`${JSON.stringify(event)}\n`);
  withLedgerLock(path, () => appendEvent(event, path));
}

/** Resource-ledger view for callers that need explicit forward-compatibility observations. */
export function readResourceLedgerWithObservations(path = resourceLedgerPath()): {
  events: ResourceLedgerEvent[];
  unknownEvents: UnknownResourceLedgerEventObservation[];
} {
  if (!existsSync(path)) return { events: [], unknownEvents: [] };
  const parsed = parseResourceLedgerEventsWithObservations(readFileSync(path, 'utf8'));
  logUnknownResourceLedgerEvents(parsed.unknownEvents);
  return parsed;
}

const KNOWN_RESOURCE_LEDGER_EVENT_TYPES = new Set([
  'llm-proxy-call',
  'lease-created', 'lease-heartbeat', 'lease-ended', 'lease-reaped', 'pool-declared', 'pool-pod-receipt',
  'guardian-host-lease', 'guardian-host-lease-conflict', 'guardian-host-lease-admitted', 'guardian-host-lease-admission-denied',
  'train-worker-policy', 'guardian-cost-snapshot', 'host-readiness-heartbeat',
]);

export function parseResourceLedgerEvents(text: string): ResourceLedgerEvent[] {
  const parsed = parseResourceLedgerEventsWithObservations(text);
  logUnknownResourceLedgerEvents(parsed.unknownEvents);
  return parsed.events;
}

function parseResourceLedgerEventsWithObservations(text: string): {
  events: ResourceLedgerEvent[];
  unknownEvents: UnknownResourceLedgerEventObservation[];
} {
  const events: ResourceLedgerEvent[] = [];
  const unknownCounts = new Map<string, number>();
  for (const [index, line] of text.split(/\r?\n/).filter(Boolean).entries()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`resource ledger malformed at line ${index + 1}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`resource ledger invalid event at line ${index + 1}`);
    }
    const eventType = (value as { event?: unknown }).event;
    if (typeof eventType !== 'string' || eventType.length === 0)
      throw new Error(`resource ledger invalid event at line ${index + 1}`);
    if (!KNOWN_RESOURCE_LEDGER_EVENT_TYPES.has(eventType)) {
      unknownCounts.set(eventType, (unknownCounts.get(eventType) ?? 0) + 1);
      continue;
    }
    const row = value as Record<string, unknown>;
    if (!validTimestamp(row.at)) throw new Error(`resource ledger invalid event at line ${index + 1}`);
    if (eventType === 'lease-created') {
      const lease = row.lease;
      if (!isRecord(lease) || !validGuardianText(lease.id) || !validFp(String(lease.fp ?? ''))
        || !validHost(String(lease.host ?? '')) || !RESOURCE_LANES.includes(lease.lane as ResourceLane)
        || !validResources(lease.resources) || !isRecord(lease.mission) || !positive(lease.ttlMs)
        || !validTimestamp(lease.heartbeatAt) || !validTimestamp(lease.startedAt)
        || (lease.mission.pr !== undefined && (!Number.isSafeInteger(lease.mission.pr) || Number(lease.mission.pr) < 1)))
        throw new Error(`resource ledger invalid lease creation at line ${index + 1}`);
    }
    if (eventType === 'llm-proxy-call') {
      const nullableCount = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
      if (!validHost(String(row.host ?? '')) || !validGuardianText(row.seat) || !validGuardianText(row.purpose)
        || typeof row.model !== 'string' || !nullableCount(row.inputTokens) || !nullableCount(row.outputTokens)
        || !(row.costUsd === null || (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) && row.costUsd >= 0))
        || !['ok', 'error'].includes(String(row.status)) || !['subscription', 'reported', 'estimate', 'unknown'].includes(String(row.costBasis))
        || (row.pr !== undefined && (!Number.isSafeInteger(row.pr) || Number(row.pr) < 1)))
        throw new Error(`resource ledger invalid LLM proxy call at line ${index + 1}`);
    }
    if (eventType === 'lease-heartbeat') {
      if (!validGuardianText(row.id) || !validTimestamp(row.heartbeatAt)
        || (row.resources !== undefined && !validResources(row.resources)))
        throw new Error(`resource ledger invalid lease heartbeat at line ${index + 1}`);
    }
    if (eventType === 'lease-ended') {
      if (!validGuardianText(row.id) || !validGuardianText(row.reason) || !validGuardianText(row.stoppedBy))
        throw new Error(`resource ledger invalid lease end at line ${index + 1}`);
    }
    if (eventType === 'lease-reaped') {
      if (!validGuardianText(row.id) || !validTimestamp(row.expectedHeartbeatAt) || !validTimestamp(row.expectedExpiresAt)
        || !validTimestamp(row.observedAt) || !['expired-and-absent', 'machine-disappeared'].includes(String(row.reason)))
        throw new Error(`resource ledger invalid lease reap at line ${index + 1}`);
    }
    if (eventType === 'pool-declared') {
      try { parseMachinePoolDeclarations({ pools: [row.pool] }); }
      catch { throw new Error(`resource ledger invalid pool declaration at line ${index + 1}`); }
    }
    if (eventType === 'pool-pod-receipt') {
      const receipt = row.receipt;
      if (!isRecord(receipt) || !validGuardianText(receipt.host) || !validGuardianText(receipt.podUid)
        || typeof receipt.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(receipt.digest)
        || !validGuardianText(receipt.runtime) || !validGuardianText(receipt.environment)
        || !validGuardianText(receipt.lastJob) || !Array.isArray(receipt.skillPacks)
        || !receipt.skillPacks.every(pack => isRecord(pack) && validGuardianText(pack.name) && validGuardianText(pack.version))
        || !isRecord(receipt.cleanupResult) || !['clean', 'unclean', 'unknown'].includes(String(receipt.cleanupResult.state))
        || !validGuardianText(receipt.cleanupResult.procedure) || !validGuardianText(receipt.cleanupResult.reason)
        || !validTimestamp(receipt.cleanupResult.verifiedAt))
        throw new Error(`resource ledger invalid Pod receipt at line ${index + 1}`);
    }
    if (eventType === 'guardian-host-lease') {
      const row = value as { at?: unknown; record?: Partial<GuardianHostLeaseRecord> };
      const request = row.record?.request;
      if (!validGuardianText(row.at) || !row.record || !validGuardianText(row.record.leaseId)
        || !['active', 'released', 'expired', 'denied'].includes(String(row.record.state))
        || !validGuardianRequest(request)
        || !validGuardianText(row.record.at)
        || (row.record.reason !== undefined && !validGuardianText(row.record.reason))
        || (row.record.alternatives !== undefined && (!Array.isArray(row.record.alternatives) || !row.record.alternatives.every(validGuardianText))))
        throw new Error(`resource ledger invalid Guardian host lease at line ${index + 1}`);
    }
    if (eventType === 'guardian-host-lease-conflict') {
      const row = value as Partial<GuardianHostLeaseConflictEvent>;
      if (!validGuardianText(row.at) || !validGuardianText(row.requestId) || !validGuardianText(row.existingLeaseId)
        || !validGuardianRequest(row.attemptedRequest))
        throw new Error(`resource ledger invalid Guardian host lease conflict at line ${index + 1}`);
    }
    if (eventType === 'guardian-host-lease-admitted') {
      const row = value as Partial<GuardianHostLeaseAdmittedEvent>;
      if (!validGuardianText(row.at) || !validGuardianText(row.leaseId) || !validGuardianText(row.host)
        || !validGuardianText(row.runId) || !validGuardianText(row.consumer))
        throw new Error(`resource ledger invalid Guardian host lease admission at line ${index + 1}`);
    }
    if (eventType === 'guardian-host-lease-admission-denied') {
      const row = value as Partial<GuardianHostLeaseAdmissionDeniedEvent>;
      if (!validGuardianText(row.at) || !validGuardianText(row.leaseId) || !validGuardianText(row.host)
        || !validGuardianText(row.runId) || !validGuardianText(row.consumer) || !validGuardianText(row.reason)
        || !Array.isArray(row.alternatives) || !row.alternatives.every(validGuardianText))
        throw new Error(`resource ledger invalid Guardian host lease admission denial at line ${index + 1}`);
    }
    if (eventType === 'host-readiness-heartbeat') {
      const heartbeat = row.heartbeat;
      const freshnessAt = isRecord(heartbeat) ? heartbeat.freshnessAt : undefined;
      // Readiness load-per-core may exceed 100%; memory and disk percentages stay within 0–100.
      const isPercent = (sample: unknown) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample <= 100;
      const isNonNegativeMetric = (sample: unknown) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0;
      const sample = isRecord(heartbeat) && isRecord(heartbeat.sample) ? heartbeat.sample : undefined;
      if (!isRecord(heartbeat) || !validHost(String(heartbeat.host ?? '')) || !validTimestamp(heartbeat.at)
        || (freshnessAt !== undefined && (typeof freshnessAt !== 'string' || !validTimestamp(freshnessAt)
          || Date.parse(freshnessAt) > Date.parse(String(heartbeat.at))))
        || heartbeat.at !== row.at || typeof heartbeat.sshAvailable !== 'boolean'
        || typeof heartbeat.maintenance !== 'boolean' || typeof heartbeat.gateProtected !== 'boolean'
        || !isRecord(heartbeat.tools) || !Object.entries(heartbeat.tools).every(([tool, available]) => validGuardianText(tool) && typeof available === 'boolean')
        || (heartbeat.sample !== undefined && (!sample
          || !isNonNegativeMetric(sample.loadPercent) || !isNonNegativeMetric(sample.load15Percent)
          || !isPercent(sample.memoryAvailablePercent) || !isPercent(sample.rootDiskUsedPercent)
          || !isPercent(sample.tmpDiskUsedPercent)
          || ['rootDiskFreeGb', 'tmpDiskFreeGb'].some(key => sample[key] !== undefined
            && (!Number.isFinite(sample[key]) || Number(sample[key]) < 0)))))
        throw new Error(`resource ledger invalid host readiness heartbeat at line ${index + 1}`);
    }
    if (eventType === 'train-worker-policy') {
      const policy = row.policy;
      // Source: worker counts are nonnegative integers and CPU utilization is a percentage on the 0–100 scale.
      if (!isRecord(policy) || !Number.isSafeInteger(policy.minWorkers) || Number(policy.minWorkers) < 0
        || !Number.isSafeInteger(policy.maxWorkers) || Number(policy.maxWorkers) < Number(policy.minWorkers)
        || !Number.isFinite(policy.scaleDownCpuPercent) || Number(policy.scaleDownCpuPercent) < 0 || Number(policy.scaleDownCpuPercent) > 100
        || !Number.isFinite(policy.scaleUpCpuPercent) || Number(policy.scaleUpCpuPercent) < 0 || Number(policy.scaleUpCpuPercent) > 100
        || Number(policy.scaleUpCpuPercent) >= Number(policy.scaleDownCpuPercent)
        || !Number.isSafeInteger(policy.gateReserveWorkers) || Number(policy.gateReserveWorkers) < 0)
        throw new Error(`resource ledger invalid train worker policy at line ${index + 1}`);
    }
    if (eventType === 'guardian-cost-snapshot' && !validGuardianCostSnapshot(row.snapshot))
      throw new Error(`resource ledger invalid Guardian cost snapshot at line ${index + 1}`);
    events.push(value as ResourceLedgerEvent);
  }
  return { events, unknownEvents: [...unknownCounts].map(([eventType, count]) => ({ eventType, count })) };
}

function logUnknownResourceLedgerEvents(unknownEvents: readonly UnknownResourceLedgerEventObservation[]): void {
  if (unknownEvents.length === 0) return;
  debug.log('resource-ledger', 'unknown-events-skipped', {
    total: unknownEvents.reduce((sum, observation) => sum + observation.count, 0),
    eventTypes: unknownEvents.map(({ eventType, count }) => ({ eventTypeJson: JSON.stringify(eventType), count })),
  }, { level: 'warn' });
}

/** Latest durable Guardian decision per host lease request. */
export function guardianHostLeaseRecords(events: readonly ResourceLedgerEvent[]): GuardianHostLeaseRecord[] {
  const records = new Map<string, GuardianHostLeaseRecord>();
  for (const event of events) if (event.event === 'guardian-host-lease') records.set(event.record.request.requestId, event.record);
  return [...records.values()];
}

const validGuardianText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validGuardianCostSnapshot = (value: unknown): value is GuardianCostSnapshot => isRecord(value)
  && Object.keys(value).length === 6
  && typeof value.measurementId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.measurementId)
  && typeof value.provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.provider)
  && typeof value.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)
  && Number.isSafeInteger(value.spentKrw) && Number(value.spentKrw) >= 0
  && typeof value.measuredAt === 'string' && validTimestamp(value.measuredAt)
  && value.month <= new Date(Date.parse(value.measuredAt)).toISOString().slice(0, 7)
  && typeof value.evidenceRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:#-]{0,255}$/.test(value.evidenceRef);

/** Missing or stale provider reports stay unknown; estimates are never silently counted as measured KRW. */
export function guardianMonthlyCost(events: readonly ResourceLedgerEvent[], month: string, providers: readonly string[],
  now = new Date(), maxAgeMs = 24 * 60 * 60 * 1000) { // Source: #35378
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || providers.length === 0 || new Set(providers).size !== providers.length ||
    providers.some(provider => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider)) ||
    !Number.isFinite(now.getTime()) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
    throw new Error('invalid Guardian cost query');
  const latest = new Map<string, GuardianCostSnapshot>();
  const measurementIds = new Map<string, GuardianCostSnapshot>();
  for (const event of events) if (event.event === 'guardian-cost-snapshot') {
    if (!validGuardianCostSnapshot(event.snapshot)) throw new Error('invalid Guardian cost snapshot in query');
    const existing = measurementIds.get(event.snapshot.measurementId);
    if (existing && (['measurementId', 'provider', 'month', 'spentKrw', 'measuredAt', 'evidenceRef'] as const)
      .some(key => existing[key] !== event.snapshot[key])) throw new Error('Guardian cost measurement ID conflict');
    measurementIds.set(event.snapshot.measurementId, event.snapshot);
    if (event.snapshot.month !== month || !providers.includes(event.snapshot.provider)) continue;
    const prior = latest.get(event.snapshot.provider);
    // Equal timestamps resolve to the lexicographically larger measurement ID, independent of input order.
    if (!prior || Date.parse(event.snapshot.measuredAt) > Date.parse(prior.measuredAt) ||
      (event.snapshot.measuredAt === prior.measuredAt && event.snapshot.measurementId > prior.measurementId))
      latest.set(event.snapshot.provider, event.snapshot);
  }
  const missingProviders = providers.filter(provider => !latest.has(provider));
  const staleProviders = providers.filter(provider => {
    const snapshot = latest.get(provider);
    return snapshot && (Date.parse(snapshot.measuredAt) > now.getTime() || now.getTime() - Date.parse(snapshot.measuredAt) > maxAgeMs);
  });
  if (missingProviders.length || staleProviders.length)
    return { status: 'unknown' as const, totalKrw: null, missingProviders, staleProviders };
  const totalKrw = providers.reduce((sum, provider) => sum + latest.get(provider)!.spentKrw, 0);
  if (!Number.isSafeInteger(totalKrw)) throw new Error('Guardian monthly cost exceeds safe integer range');
  return { status: 'measured' as const, totalKrw,
    missingProviders: [], staleProviders: [] };
}

/** The adapter supplies provider evidence; this writer deduplicates IDs and preserves the raw report. */
export function recordGuardianCostSnapshot(snapshot: GuardianCostSnapshot, now = new Date(), path = resourceLedgerPath()): void {
  if (!validGuardianCostSnapshot(snapshot) || !Number.isFinite(now.getTime()) || Date.parse(snapshot.measuredAt) > now.getTime() ||
    snapshot.month > new Date(Date.parse(snapshot.measuredAt)).toISOString().slice(0, 7))
    throw new Error('invalid Guardian cost snapshot');
  withLedgerLock(path, () => {
    const prior = readResourceLedger(path).find((event): event is Extract<ResourceLedgerEvent, { event: 'guardian-cost-snapshot' }> =>
      event.event === 'guardian-cost-snapshot' &&
      event.snapshot.measurementId === snapshot.measurementId);
    if (prior) {
      if (Object.entries(snapshot).some(([key, value]) => prior.snapshot[key as keyof GuardianCostSnapshot] !== value))
        throw new Error('Guardian cost measurement ID conflict');
      return;
    }
    appendEvent({ event: 'guardian-cost-snapshot', at: now.toISOString(), snapshot }, path);
  });
}
/** Atomically persist the host-policy decision in the Nexus resource ledger before dispatch. */
export function requestGuardianHostLease(request: GuardianHostLeaseRequest, now = new Date(), path?: string): GuardianHostLeaseRecord {
  const target = path ?? resourceLedgerPath();
  if (![request.requestId, request.runId, request.requestedBy, request.consumer, request.purpose, request.host, request.priority].every(validGuardianText)
    || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now.getTime())
    throw new Error('invalid Guardian host lease request');
  let result!: GuardianHostLeaseRecord;
  withLedgerLock(target, () => {
    const records = guardianHostLeaseRecords(readResourceLedger(target));
    const prior = records.find(item => item.request.requestId === request.requestId);
    if (prior) {
      result = JSON.stringify(prior.request) === JSON.stringify(request) ? prior : {
        leaseId: `guardian:${request.requestId}`, request: { ...request }, state: 'denied', at: now.toISOString(),
        reason: 'request-id-conflict', alternatives: [],
      };
      if (result !== prior) appendEvent({ event: 'guardian-host-lease-conflict', at: result.at,
        requestId: request.requestId, existingLeaseId: prior.leaseId, attemptedRequest: { ...request } }, target);
      return;
    }
    for (const lease of records) if (lease.state === 'active' && Date.parse(lease.request.expiresAt) <= now.getTime()) {
      const expired = { ...lease, state: 'expired' as const, at: now.toISOString(), reason: 'lease-expired' };
      appendEvent({ event: 'guardian-host-lease', at: expired.at, record: expired }, target);
    }
    const policy = evaluateHostLeasePolicy(request);
    let reason = policy.reason;
    if (!reason && policy.exclusive && records.some(lease => lease.state === 'active' && Date.parse(lease.request.expiresAt) > now.getTime() && lease.request.host === request.host
      && (lease.request.consumer !== request.consumer || lease.request.runId !== request.runId))) reason = 'exclusive-lease-conflict';
    result = { leaseId: `guardian:${request.requestId}`, request: { ...request }, state: reason ? 'denied' : 'active',
      at: now.toISOString(), ...(reason ? { reason, alternatives: [...policy.alternatives] } : {}) };
    appendEvent({ event: 'guardian-host-lease', at: result.at, record: result }, target);
  });
  return result;
}

/** Admission is fail-closed: the durable lease must still be active and match all identity fields. */
export function admitGuardianHostLease(input: { leaseId: string; host: string; runId: string; consumer: string }, now = new Date(), path?: string): boolean {
  if (![input.leaseId, input.host, input.runId, input.consumer].every(validGuardianText))
    throw new Error('invalid Guardian host lease admission identity');
  const target = path ?? resourceLedgerPath();
  let admitted = false;
  withLedgerLock(target, () => {
    const current = guardianHostLeaseRecords(readResourceLedger(target)).find(record => record.leaseId === input.leaseId);
    if (current?.state === 'active' && Date.parse(current.request.expiresAt) > now.getTime() && current.request.host === input.host
      && current.request.runId === input.runId && current.request.consumer === input.consumer) {
      appendEvent({ event: 'guardian-host-lease-admitted', at: now.toISOString(), leaseId: current.leaseId,
        host: input.host, runId: input.runId, consumer: input.consumer }, target);
      admitted = true;
      return;
    }
    const expired = current?.state === 'active' && Date.parse(current.request.expiresAt) <= now.getTime();
    if (current && expired) {
      const record: GuardianHostLeaseRecord = { ...current, state: 'expired', at: now.toISOString(), reason: 'lease-expired' };
      appendEvent({ event: 'guardian-host-lease', at: record.at, record }, target);
    }
    const policy = evaluateHostLeasePolicy({ host: input.host, consumer: input.consumer, purpose: current?.request.purpose ?? '' });
    const reason = !current ? 'lease-not-found' : expired ? 'lease-expired'
      : current.state !== 'active' ? 'lease-not-active' : 'lease-owner-mismatch';
    appendEvent({ event: 'guardian-host-lease-admission-denied', at: now.toISOString(), leaseId: input.leaseId,
      host: input.host, runId: input.runId, consumer: input.consumer, reason,
      alternatives: policy.alternatives.length ? policy.alternatives : [...HOST_LEASE_ALTERNATIVE_HOSTS] }, target);
  });
  return admitted;
}

export function renewGuardianHostLease(leaseId: string, expiresAt: string, now = new Date(), path?: string): boolean {
  if (!leaseId.trim() || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())
    throw new Error('Guardian host lease renewal requires a future expiry');
  const target = path ?? resourceLedgerPath();
  let renewed = false;
  withLedgerLock(target, () => {
    const current = guardianHostLeaseRecords(readResourceLedger(target)).find(record => record.leaseId === leaseId);
    if (!current || current.state !== 'active' || Date.parse(current.request.expiresAt) <= now.getTime()) return;
    const next: GuardianHostLeaseRecord = { ...current, request: { ...current.request, expiresAt }, at: now.toISOString() };
    delete next.reason;
    delete next.alternatives;
    appendEvent({ event: 'guardian-host-lease', at: next.at, record: next }, target);
    renewed = true;
  });
  return renewed;
}

export function endGuardianHostLease(leaseId: string, reason: string, now = new Date(), path?: string): boolean {
  if (!leaseId.trim() || !reason.trim()) throw new Error('Guardian host lease release requires leaseId and reason');
  const target = path ?? resourceLedgerPath();
  let ended = false;
  withLedgerLock(target, () => {
    const current = guardianHostLeaseRecords(readResourceLedger(target)).find(record => record.leaseId === leaseId);
    if (!current || current.state !== 'active') return;
    const released: GuardianHostLeaseRecord = { ...current, state: 'released', at: now.toISOString(), reason: reason.trim() };
    appendEvent({ event: 'guardian-host-lease', at: released.at, record: released }, target);
    ended = true;
  });
  return ended;
}

export function activeResourceLeases(events: readonly ResourceLedgerEvent[]): ResourceLease[] {
  const leases = new Map<string, ResourceLease>();
  for (const event of events) {
    if (event.event === 'lease-created') leases.set(event.lease.id, event.lease);
    else if (event.event === 'lease-heartbeat') {
      const current = leases.get(event.id);
      if (current && !current.endedAt) leases.set(event.id, { ...current, heartbeatAt: event.heartbeatAt,
        ...(event.resources ? { resources: event.resources } : {}) });
    } else if (event.event === 'lease-ended' || event.event === 'lease-reaped') {
      const current = leases.get(event.id);
      if (current && !current.endedAt) leases.set(event.id, { ...current, endedAt: event.at,
        endReason: event.event === 'lease-reaped' ? event.reason : event.reason,
        stoppedBy: event.event === 'lease-reaped' ? 'guardian-reconcile' : event.stoppedBy });
    }
  }
  return [...leases.values()].filter(lease => !lease.endedAt);
}



/** Latest authoritative machine-pool declarations from the Nexus resource ledger. */
export function activeResourcePools(events: readonly ResourceLedgerEvent[]): MachinePoolDeclaration[] {
  const pools = new Map<string, MachinePoolDeclaration>();
  for (const event of events) if (event.event === 'pool-declared') {
    const pool = parseMachinePoolDeclarations({ pools: [event.pool] })[0]!;
    pools.set(pool.purpose + '/' + pool.fanoutGroupId, pool);
  }
  return [...pools.values()];
}

/** Machine-scoped read view shared by the Nexus route and simulator. */
export function resourcePoolsForMachine(events: readonly ResourceLedgerEvent[], machine: string): MachinePoolDeclaration[] {
  return activeResourcePools(events).filter(pool => pool.members.some(member => member.host === machine));
}

/** Most recent per-Pod image/runtime/environment/job/cleanup identity from the Nexus resource ledger. */
export function latestWarmPoolPodReceipts(events: readonly ResourceLedgerEvent[]): WarmPoolPodReceipt[] {
  const receipts = new Map<string, WarmPoolPodReceipt>();
  for (const event of events) if (event.event === 'pool-pod-receipt')
    receipts.set(event.receipt.host + '/' + event.receipt.podUid, event.receipt);
  return [...receipts.values()];
}

/** Append a structured per-Pod receipt; cleanup state is explicit and cannot be inferred from a missing field. */
export function recordWarmPoolPodReceipt(receipt: WarmPoolPodReceipt, now = new Date(), path?: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(receipt.host) || !receipt.podUid.trim()
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.digest) || !receipt.runtime.trim() || !receipt.environment.trim()
    || !receipt.lastJob.trim() || !receipt.cleanupResult.procedure.trim() || !receipt.cleanupResult.reason.trim()
    || !Number.isFinite(Date.parse(receipt.cleanupResult.verifiedAt))
    || !['clean', 'unclean', 'unknown'].includes(receipt.cleanupResult.state))
    throw new Error('invalid warm-pool Pod receipt');
  const target = path ?? resourceLedgerPath();
  withLedgerLock(target, () => appendEvent({ event: 'pool-pod-receipt', at: now.toISOString(), receipt }, target));
}

/** Append a validated pool declaration to the shared resource ledger (Nexus owns this file). */
export function declareResourcePool(pool: MachinePoolDeclaration, now = new Date(), path?: string): boolean {
  const validated = parseMachinePoolDeclarations({ pools: [pool] })[0]!;
  const target = path ?? resourceLedgerPath();
  let created = false;
  withLedgerLock(target, () => {
    const current = activeResourcePools(readResourceLedger(target)).find(row => row.purpose === validated.purpose
      && row.fanoutGroupId === validated.fanoutGroupId);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(validated)) throw new Error('conflicting resource pool declaration');
      return;
    }
    appendEvent({ event: 'pool-declared', at: now.toISOString(), pool: validated }, target);
    created = true;
  });
  return created;
}

/** Replace one declaration with a compare-and-swap against the exact previous value. */
export function replaceResourcePool(pool: MachinePoolDeclaration, expectedPool: MachinePoolDeclaration,
  now = new Date(), path?: string): boolean {
  const replacement = parseMachinePoolDeclarations({ pools: [pool] })[0]!;
  const expected = parseMachinePoolDeclarations({ pools: [expectedPool] })[0]!;
  if (replacement.purpose !== expected.purpose || replacement.fanoutGroupId !== expected.fanoutGroupId)
    throw new Error('resource pool replacement identity mismatch');
  const target = path ?? resourceLedgerPath();
  let replaced = false;
  withLedgerLock(target, () => {
    const events = readResourceLedger(target);
    const current = activeResourcePools(events).find(row => row.purpose === replacement.purpose
      && row.fanoutGroupId === replacement.fanoutGroupId);
    if (!current) throw new Error('resource pool replacement target missing');
    if (JSON.stringify(current) === JSON.stringify(replacement)) {
      const declarations = events.filter((row): row is Extract<ResourceLedgerEvent, { event: 'pool-declared' }> => row.event === 'pool-declared'
        && row.pool.purpose === replacement.purpose && row.pool.fanoutGroupId === replacement.fanoutGroupId);
      if (declarations.length > 1 && JSON.stringify(declarations.at(-2)!.pool) === JSON.stringify(expected)) return;
      throw new Error('resource pool replacement stale');
    }
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('resource pool replacement stale');
    appendEvent({ event: 'pool-declared', at: now.toISOString(), pool: replacement }, target);
    replaced = true;
  });
  return replaced;
}

/** Reassign active pool declarations when an HQ host is promoted; append-only history stays auditable. */
export function reassignResourcePools(fromHost: string, toHost: string, now = new Date(), path?: string): number {
  if (!validHost(fromHost) || !validHost(toHost) || fromHost === toHost) throw new Error('invalid resource pool host reassignment');
  const target = path ?? resourceLedgerPath();
  let updated = 0;
  withLedgerLock(target, () => {
    const pools = activeResourcePools(readResourceLedger(target));
    for (const pool of pools) {
      if (!pool.members.some(member => member.host === fromHost)) continue;
      const reassigned = parseMachinePoolDeclarations({ pools: [{ ...pool,
        members: pool.members.map(member => member.host === fromHost ? { ...member, host: toHost } : member) }] })[0]!;
      appendEvent({ event: 'pool-declared', at: now.toISOString(), pool: reassigned }, target);
      updated++;
    }
  });
  return updated;
}

function withLedgerLock(path: string, action: () => void): void {
  const dir = dirname(path);
  if (refuseProductionLedgerWriteInTest(dir, 'resource-ledger')) return;
  mkdirSync(dir, { recursive: true });
  const release = acquireLockSync(`${path}.lock`, { staleMs: 30_000, breakDeadHolder: true });
  try { action(); } finally { release(); }
}

function appendEvent(event: ResourceLedgerEvent, path: string): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
}

/** Persist one admitted proxy invocation before the response is returned. */
export function recordLlmProxyCall(event: Extract<ResourceLedgerEvent, { event: 'llm-proxy-call' }>, path = resourceLedgerPath()): void {
  withLedgerLock(path, () => appendEvent(event, path));
}

export function beginResourceLease(input: Omit<ResourceLease, 'id' | 'startedAt' | 'heartbeatAt' | 'endedAt' | 'endReason' | 'stoppedBy'> & { now?: Date }, path?: string): ResourceLease {
  if (!validFp(input.fp) || !validHost(input.host) || !RESOURCE_LANES.includes(input.lane) || !positive(input.ttlMs)) throw new Error('invalid resource lease identity or ttl');
  if (Object.values(input.resources).some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) throw new Error('invalid resource lease quantity');
  if (input.mission.pr !== undefined && (!Number.isSafeInteger(input.mission.pr) || input.mission.pr < 1)) throw new Error('invalid resource lease PR');
  const now = input.now ?? new Date();
  const lease: ResourceLease = { id: input.fp, fp: input.fp, host: input.host, lane: input.lane,
    resources: input.resources, mission: input.mission, ttlMs: input.ttlMs,
    heartbeatAt: now.toISOString(), startedAt: now.toISOString() };
  withLedgerLock(path ?? resourceLedgerPath(), () => {
    const target = path ?? resourceLedgerPath();
    const prior = activeResourceLeases(readResourceLedger(target)).find(item => item.id === lease.id);
    if (prior) throw new Error(`resource lease already active: ${lease.id}`);
    appendEvent({ event: 'lease-created', at: now.toISOString(), lease }, target);
  });
  return lease;
}

export function heartbeatResourceLease(id: string, resources?: ResourceLease['resources'], now = new Date(), path?: string): void {
  if (resources && Object.values(resources).some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) {
    throw new Error('invalid resource lease quantity');
  }
  const target = path ?? resourceLedgerPath();
  withLedgerLock(target, () => {
    if (!activeResourceLeases(readResourceLedger(target)).some(lease => lease.id === id)) throw new Error(`active resource lease not found: ${id}`);
    appendEvent({ event: 'lease-heartbeat', at: now.toISOString(), id, heartbeatAt: now.toISOString(), ...(resources ? { resources } : {}) }, target);
  });
}

export function endResourceLease(id: string, reason: string, stoppedBy: string, now = new Date(), path?: string): void {
  if (!reason.trim() || !stoppedBy.trim()) throw new Error('resource lease end requires reason and stoppedBy');
  const target = path ?? resourceLedgerPath();
  withLedgerLock(target, () => {
    if (!activeResourceLeases(readResourceLedger(target)).some(lease => lease.id === id)) throw new Error(`active resource lease not found: ${id}`);
    appendEvent({ event: 'lease-ended', at: now.toISOString(), id, reason: reason.trim(), stoppedBy: stoppedBy.trim() }, target);
  });
}

/** Append the final reaped event only if the observed lease version is still current under the ledger lock. */
export function reapResourceLeaseIfCurrent(input: { id: string; expectedHeartbeatAt: string; expectedExpiresAtMs: number; observedAtMs: number; reason?: 'expired-and-absent' | 'machine-disappeared' }, path?: string): boolean {
  if (!input.id.trim() || !Number.isFinite(Date.parse(input.expectedHeartbeatAt))
    || !Number.isSafeInteger(input.expectedExpiresAtMs) || !Number.isSafeInteger(input.observedAtMs)
    || (input.reason === 'machine-disappeared' && input.observedAtMs < Date.parse(input.expectedHeartbeatAt))
    || (input.reason !== 'machine-disappeared' && input.observedAtMs < input.expectedExpiresAtMs)) return false;
  const target = path ?? resourceLedgerPath();
  let reaped = false;
  withLedgerLock(target, () => {
    const current = activeResourceLeases(readResourceLedger(target)).find(lease => lease.id === input.id);
    if (!current || current.heartbeatAt !== input.expectedHeartbeatAt
      || Date.parse(current.heartbeatAt) + current.ttlMs !== input.expectedExpiresAtMs
      || (input.reason === 'machine-disappeared' && input.observedAtMs < Date.parse(current.heartbeatAt))
      || (input.reason !== 'machine-disappeared'
        && input.observedAtMs < Date.parse(current.heartbeatAt) + current.ttlMs)) return;
    const at = new Date(input.observedAtMs).toISOString();
    appendEvent({ event: 'lease-reaped', at, id: current.id, expectedHeartbeatAt: input.expectedHeartbeatAt,
      expectedExpiresAt: new Date(input.expectedExpiresAtMs).toISOString(), observedAt: at, reason: input.reason ?? 'expired-and-absent' }, target);
    reaped = true;
  });
  return reaped;
}

export function reconcileResourceLeases(input: { leases: readonly ResourceLease[]; measurements: readonly ResourceMeasurement[]; now?: Date }): ResourceFinding[] {
  const now = (input.now ?? new Date()).getTime();
  const findings: ResourceFinding[] = [];
  const measurements = new Map(input.measurements.map(row => [row.host, row]));
  const known = new Map(input.leases.map(lease => [lease.fp, lease]));
  for (const lease of input.leases) {
    const measured = measurements.get(lease.host);
    const lastBeat = Date.parse(lease.heartbeatAt);
    const stale = !Number.isFinite(lastBeat) || now - lastBeat > lease.ttlMs;
    if (stale) findings.push({ kind: 'stale', host: lease.host, id: lease.id, fp: lease.fp,
      leaseHeartbeatAt: lease.heartbeatAt, leaseExpiresAtMs: Number.isFinite(lastBeat) ? lastBeat + lease.ttlMs : undefined,
      observedAtMs: now,
      detail: `heartbeat age ${Number.isFinite(lastBeat) ? Math.max(0, now - lastBeat) : 'unknown'}ms exceeds ttl ${lease.ttlMs}ms`, action: 'report-only' });
    if (!measured) continue;
    const observed = [...measured.pods, ...measured.processes].filter(item => item.fp === lease.fp);
    if (stale && measured.errors.length === 0 && observed.length === 0) findings.push({ kind: 'reaped-candidate', host: lease.host, id: lease.id, fp: lease.fp,
      leaseHeartbeatAt: lease.heartbeatAt, leaseExpiresAtMs: Number.isFinite(lastBeat) ? lastBeat + lease.ttlMs : undefined,
      observedAtMs: now, resourcePresent: false,
      detail: 'expired lease absent from measured Pod/process inventory; no deletion performed', action: 'report-only' });
    for (const item of observed) {
      const pod = !item.id.startsWith('pid:');
      const expectedMission = lease.mission.cell ?? lease.mission.goalId;
      const laneDrift = (pod || item.lane !== undefined) && item.lane !== lease.lane;
      const missionDrift = expectedMission !== undefined && (pod || item.mission !== undefined) && item.mission !== expectedMission;
      if (!('scopeUnknown' in item && item.scopeUnknown) && (!('host' in item) || item.host !== 'unknown')
        && (lease.host !== measured.host || laneDrift || missionDrift)) {
        findings.push({ kind: 'drift', host: lease.host, id: item.id, fp: lease.fp,
          detail: `lease=${lease.host}/${lease.lane}/${expectedMission ?? 'unknown'} observed=${measured.host}/${item.lane ?? 'unknown'}/${item.mission ?? 'unknown'}`, action: 'report-only' });
      }
    }
  }
  const measuredHosts = new Set(input.measurements.map(row => row.host));
  for (const host of new Set(input.leases.filter(lease => !measuredHosts.has(lease.host)).map(lease => lease.host))) findings.push({
    kind: 'measurement-unavailable', host, id: host, detail: 'host measurement unavailable', action: 'report-only' });
  for (const measurement of input.measurements) {
    if (measurement.errors.length) findings.push({ kind: 'measurement-unavailable', host: measurement.host, id: measurement.host,
      detail: measurement.errors.join('; '), action: 'report-only' });
    for (const item of [...measurement.pods.filter(pod => pod.managed), ...measurement.processes.filter(process => process.fp)]) {
      const owner = item.fp ? known.get(item.fp) : undefined;
      if (owner && owner.host !== measurement.host) findings.push({ kind: 'drift', host: measurement.host, id: item.id, fp: owner.fp,
        detail: `lease host=${owner.host} observed host=${measurement.host}`, action: 'report-only' });
      else if (!item.fp || !owner) findings.push({ kind: 'orphan', host: measurement.host, id: item.id,
        ...(item.fp ? { fp: item.fp } : {}), detail: item.fp ? 'observed fingerprint has no active lease' : 'observed Pod/process has no fingerprint', action: 'report-only' });
    }
  }
  return findings;
}

export function resourceMatrix(input: { hosts: readonly { host: string; capacity?: Partial<Record<ResourceLane, number>> }[]; leases: readonly ResourceLease[]; measurements: readonly ResourceMeasurement[] }): ResourceMatrixRow[] {
  const measured = new Map(input.measurements.map(row => [row.host, row]));
  return input.hosts.flatMap(({ host, capacity }) => RESOURCE_LANES.map(lane => {
    const leases = input.leases.filter(lease => lease.host === host && lease.lane === lane);
    const measurement = measured.get(host);
    const pods = measurement && !measurement.errors.length ? measurement.pods.filter(pod => pod.managed && pod.host !== 'unknown' && pod.lane === lane) : null;
    const podCpu = pods ? pods.reduce((sum, pod) => sum + (pod.cpu ?? 0), 0) : null;
    const podMemory = pods ? pods.reduce((sum, pod) => sum + (pod.memoryBytes ?? 0), 0) : null;
    const leasedCpu = leases.reduce((sum, lease) => sum + (lease.resources.cpu ?? 0), 0);
    const leasedMemoryBytes = leases.reduce((sum, lease) => sum + (lease.resources.memoryBytes ?? 0), 0);
    return { host, lane, capacity: capacity?.[lane] ?? null, leases: leases.length,
      leasedCpu, leasedMemoryBytes,
      observedPodCpuRequests: podCpu, observedPodMemoryRequestsBytes: podMemory,
      deltaCpuRequests: podCpu === null ? null : leasedCpu - podCpu,
      deltaMemoryRequestsBytes: podMemory === null ? null : leasedMemoryBytes - podMemory,
      measuredPods: pods?.length ?? null,
      unknownPods: measurement ? measurement.pods.filter(pod => pod.scopeUnknown || pod.host === 'unknown').length : null,
      measuredProcesses: measurement && !measurement.errors.length
        ? measurement.processes.filter(process => process.fp && leases.some(lease => lease.fp === process.fp)).length : null,
      unknownProcesses: measurement && !measurement.errors.some(error => error.startsWith('ps:'))
        ? measurement.processes.filter(process => !process.fp).length : null,
      deltaLeasesVsPods: pods ? leases.length - pods.length : null };
  }));
}
