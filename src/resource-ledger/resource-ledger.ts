import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { refuseProductionLedgerWriteInTest } from '../harness/ledger-write-guard.js';
import { acquireLockSync } from '../storage/file-lock.js';

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

export type ResourceLedgerEvent =
  | { event: 'lease-created'; at: string; lease: ResourceLease }
  | { event: 'lease-heartbeat'; at: string; id: string; heartbeatAt: string; resources?: ResourceLease['resources'] }
  | { event: 'lease-ended'; at: string; id: string; reason: string; stoppedBy: string }
  | { event: 'lease-reaped'; at: string; id: string; expectedHeartbeatAt: string; expectedExpiresAt: string; observedAt: string; reason: 'expired-and-absent' };

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

export function resourceLedgerPath(stateDir = elanousStateRoot()): string {
  return join(stateDir, LEDGER_FILE);
}

export function readResourceLedger(path = resourceLedgerPath()): ResourceLedgerEvent[] {
  if (!existsSync(path)) return [];
  return parseResourceLedgerEvents(readFileSync(path, 'utf8'));
}

export function parseResourceLedgerEvents(text: string): ResourceLedgerEvent[] {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`resource ledger malformed at line ${index + 1}`); }
    if (!value || typeof value !== 'object' || !['lease-created', 'lease-heartbeat', 'lease-ended', 'lease-reaped'].includes(String((value as { event?: unknown }).event))) {
      throw new Error(`resource ledger invalid event at line ${index + 1}`);
    }
    return value as ResourceLedgerEvent;
  });
}

export function activeResourceLeases(events: readonly ResourceLedgerEvent[]): ResourceLease[] {
  const leases = new Map<string, ResourceLease>();
  for (const event of events) {
    if (event.event === 'lease-created') leases.set(event.lease.id, event.lease);
    else if (event.event === 'lease-heartbeat') {
      const current = leases.get(event.id);
      if (current && !current.endedAt) leases.set(event.id, { ...current, heartbeatAt: event.heartbeatAt,
        ...(event.resources ? { resources: event.resources } : {}) });
    } else {
      const current = leases.get(event.id);
      if (current && !current.endedAt) leases.set(event.id, { ...current, endedAt: event.at,
        endReason: event.event === 'lease-reaped' ? event.reason : event.reason,
        stoppedBy: event.event === 'lease-reaped' ? 'guardian-reconcile' : event.stoppedBy });
    }
  }
  return [...leases.values()].filter(lease => !lease.endedAt);
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
export function reapResourceLeaseIfCurrent(input: { id: string; expectedHeartbeatAt: string; expectedExpiresAtMs: number; observedAtMs: number }, path?: string): boolean {
  if (!input.id.trim() || !Number.isFinite(Date.parse(input.expectedHeartbeatAt))
    || !Number.isSafeInteger(input.expectedExpiresAtMs) || !Number.isSafeInteger(input.observedAtMs)
    || input.observedAtMs < input.expectedExpiresAtMs) return false;
  const target = path ?? resourceLedgerPath();
  let reaped = false;
  withLedgerLock(target, () => {
    const current = activeResourceLeases(readResourceLedger(target)).find(lease => lease.id === input.id);
    if (!current || current.heartbeatAt !== input.expectedHeartbeatAt
      || Date.parse(current.heartbeatAt) + current.ttlMs !== input.expectedExpiresAtMs
      || input.observedAtMs < Date.parse(current.heartbeatAt) + current.ttlMs) return;
    const at = new Date(input.observedAtMs).toISOString();
    appendEvent({ event: 'lease-reaped', at, id: current.id, expectedHeartbeatAt: input.expectedHeartbeatAt,
      expectedExpiresAt: new Date(input.expectedExpiresAtMs).toISOString(), observedAt: at, reason: 'expired-and-absent' }, target);
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
