import { readResourceLedger, resourceLedgerPath, type HostReadinessHeartbeat } from './resource-ledger.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HostReadinessGrade = 'green' | 'yellow' | 'red' | 'black';
export type HostReadinessState = {
  host: string;
  grade?: HostReadinessGrade;
  symbol?: '🟢' | '🟡' | '🔴' | '⚫';
  verdict: 'READY' | 'BLOCKED' | 'UNMEASURED';
  at: string;
  stale?: boolean;
  freshness?: 'fresh' | 'stale' | 'down' | 'unmeasured';
  failed: string[];
  reason?: string;
  sample?: HostReadinessHeartbeat['sample'];
  tools?: Record<string, boolean>;
};

// Source: RESOURCE-HOST-HEARTBEAT-LEDGER owns the existing 24h historical-stale boundary.
const HOST_READINESS_STALE_MS = 24 * 60 * 60 * 1_000;
// Source: RESOURCE-HEARTBEAT-COLLECT-CRON 0.3.10 adds batch freshness without replacing that boundary.
const HOST_READINESS_BATCH_STALE_MS = 5 * 60 * 1_000;
const HOST_READINESS_DOWN_MS = 15 * 60 * 1_000;
// Source: BRIEF-LOCAL-FIRST-PLACEMENT-1111.md, rubric v1 thresholds for green/yellow host health.
const HOST_READINESS_RUBRIC = {
  green: { loadPercent: 40, load15Percent: 50, memoryAvailablePercent: 30, diskUsedPercent: 85 },
  yellow: { loadPercent: 70, load15Percent: 80, memoryAvailablePercent: 15, diskUsedPercent: 90 },
} as const;

function stateForHeartbeat(heartbeat: HostReadinessHeartbeat, now: Date): HostReadinessState {
  if (!heartbeat.sample) {
    const reason = heartbeat.gateProtected ? 'gate-protected' : heartbeat.maintenance ? 'maintenance'
      : !heartbeat.sshAvailable ? 'ssh-unavailable' : 'metrics-unavailable';
    const ageMs = now.getTime() - Date.parse(heartbeat.freshnessAt ?? heartbeat.at);
    if (ageMs < 0 || ageMs >= HOST_READINESS_STALE_MS) {
      const historicalReason = ageMs < 0 ? 'heartbeat-from-future' : 'heartbeat-stale';
      return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'UNMEASURED', at: heartbeat.at,
        stale: true, freshness: ageMs < 0 ? 'unmeasured' : 'down', failed: [historicalReason], reason: historicalReason, tools: heartbeat.tools };
    }
    const freshness = ageMs >= HOST_READINESS_DOWN_MS ? 'down'
      : ageMs >= HOST_READINESS_BATCH_STALE_MS ? 'stale' : 'unmeasured';
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: freshness === 'down' ? 'BLOCKED' : 'UNMEASURED', at: heartbeat.at,
      stale: false, freshness, failed: [reason], reason, tools: heartbeat.tools };
  }
  const ageMs = now.getTime() - Date.parse(heartbeat.freshnessAt ?? heartbeat.at);
  if (ageMs < 0) {
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'UNMEASURED', at: heartbeat.at,
      stale: true, freshness: 'unmeasured', failed: ['heartbeat-from-future'], reason: 'heartbeat-from-future',
      ...(heartbeat.sample ? { sample: heartbeat.sample } : {}), tools: heartbeat.tools };
  }
  if (ageMs >= HOST_READINESS_STALE_MS) {
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'UNMEASURED', at: heartbeat.at,
      stale: true, freshness: 'down', failed: ['heartbeat-stale'], reason: 'heartbeat-stale',
      ...(heartbeat.sample ? { sample: heartbeat.sample } : {}), tools: heartbeat.tools };
  }
  if (ageMs >= HOST_READINESS_DOWN_MS) {
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'BLOCKED', at: heartbeat.at,
      stale: false, freshness: 'down', failed: ['heartbeat-down'], reason: 'heartbeat-down',
      ...(heartbeat.sample ? { sample: heartbeat.sample } : {}), tools: heartbeat.tools };
  }
  if (ageMs >= HOST_READINESS_BATCH_STALE_MS) {
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'UNMEASURED', at: heartbeat.at,
      stale: false, freshness: 'stale', failed: ['heartbeat-stale'], reason: 'heartbeat-stale',
      ...(heartbeat.sample ? { sample: heartbeat.sample } : {}), tools: heartbeat.tools };
  }
  if (heartbeat.gateProtected || heartbeat.maintenance || !heartbeat.sshAvailable || !heartbeat.sample) {
    const reason = heartbeat.gateProtected ? 'gate-protected' : heartbeat.maintenance ? 'maintenance'
      : !heartbeat.sshAvailable ? 'ssh-unavailable' : 'metrics-unavailable';
    return { host: heartbeat.host, grade: 'black', symbol: '⚫', verdict: 'UNMEASURED', at: heartbeat.at,
      stale: false, freshness: 'fresh', failed: [reason], reason, ...(heartbeat.sample ? { sample: heartbeat.sample } : {}), tools: heartbeat.tools };
  }

  const { sample } = heartbeat;
  const diskUsedPercent = Math.max(sample.rootDiskUsedPercent, sample.tmpDiskUsedPercent);
  const withinGreen = sample.loadPercent < HOST_READINESS_RUBRIC.green.loadPercent
    && sample.load15Percent < HOST_READINESS_RUBRIC.green.load15Percent
    && sample.memoryAvailablePercent > HOST_READINESS_RUBRIC.green.memoryAvailablePercent
    && diskUsedPercent < HOST_READINESS_RUBRIC.green.diskUsedPercent;
  const withinYellow = sample.loadPercent < HOST_READINESS_RUBRIC.yellow.loadPercent
    && sample.load15Percent < HOST_READINESS_RUBRIC.yellow.load15Percent
    && sample.memoryAvailablePercent > HOST_READINESS_RUBRIC.yellow.memoryAvailablePercent
    && diskUsedPercent < HOST_READINESS_RUBRIC.yellow.diskUsedPercent;
  const grade: HostReadinessGrade = withinGreen ? 'green' : withinYellow ? 'yellow' : 'red';
  const symbol = grade === 'green' ? '🟢' : grade === 'yellow' ? '🟡' : '🔴';
  return { host: heartbeat.host, grade, symbol, verdict: grade === 'red' ? 'BLOCKED' : 'READY', at: heartbeat.at,
    stale: false, freshness: 'fresh', failed: grade === 'red' ? ['rubric-v1-threshold'] : [], sample, tools: heartbeat.tools };
}

/** Project the latest Nexus ledger heartbeat per host; stale or unavailable hosts never appear ready. */
export function projectHostReadiness(events: ReturnType<typeof readResourceLedger>, now = new Date()): HostReadinessState[] {
  const latest = new Map<string, HostReadinessHeartbeat>();
  for (const event of events) {
    if (event.event !== 'host-readiness-heartbeat') continue;
    const previous = latest.get(event.heartbeat.host);
    // Delayed delivery must not let an older healthy sample erase newer maintenance or gate state.
    if (!previous || Date.parse(event.heartbeat.at) >= Date.parse(previous.at)) latest.set(event.heartbeat.host, event.heartbeat);
  }
  return [...latest.values()].map(heartbeat => stateForHeartbeat(heartbeat, now));
}

function readLegacyHostReadiness(path: string): HostReadinessState[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (rows.shift() !== 'host\titem\tstatus\trepaired\tat\tdetail') throw new Error('host readiness ledger header invalid');
  const latest = new Map<string, HostReadinessState>();
  for (const row of rows) {
    const fields = row.split('\t');
    if (fields.length !== 6) throw new Error('host readiness ledger row invalid');
    const [host, item, status, , at, detail] = fields;
    if (item !== 'verdict') continue;
    if (!host || (status !== 'READY' && status !== 'BLOCKED' && status !== 'UNMEASURED') || !at || !Number.isFinite(Date.parse(at))) {
      throw new Error('host readiness verdict invalid');
    }
    const previous = latest.get(host);
    if (!previous || Date.parse(at) >= Date.parse(previous.at)) latest.set(host, { host, verdict: status, at,
      failed: status === 'BLOCKED' && detail ? detail.split(',').filter(Boolean) : [],
      ...(status === 'UNMEASURED' ? { reason: detail.replace(/^reason=/, '') } : {}) });
  }
  return [...latest.values()];
}

/** Read the Nexus ledger and preserve legacy readiness rows until a newer heartbeat replaces them. */
export function readHostReadiness(path = resourceLedgerPath()): HostReadinessState[] {
  return readHostReadinessFromPaths(path, process.env.ELANOUS_HOST_READINESS_LEDGER
    ?? join(homedir(), 'elanous-hq/seat-state/OP/host-readiness.tsv'));
}

function readHostReadinessFromPaths(path: string, legacyPath: string): HostReadinessState[] {
  const combined = new Map(readLegacyHostReadiness(legacyPath).map(state => [state.host, state]));
  for (const state of projectHostReadiness(readResourceLedger(path))) {
    const previous = combined.get(state.host);
    if (!previous || Date.parse(state.at) > Date.parse(previous.at)) combined.set(state.host, state);
  }
  return [...combined.values()];
}
