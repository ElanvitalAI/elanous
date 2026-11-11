import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readGraphContext, finishNode, errorResult } from './node-verdict.js';
import { ResourceLedger } from '../../src/control-plane/ledger.js';
import { hasApprovedGraphNodeInput } from '../../src/graph-runner/runner.js';
import { CLOUD_ELASTIC_MONTHLY_CAP_KRW } from '../../src/release-loop/cloud-elastic.js';

export interface CloudElasticToolRequest {
  readonly id: string; readonly event: string; readonly purpose: string; readonly provider: 'aws' | 'gcp';
  readonly hostType: string; readonly host: string; readonly expectedHours: number; readonly hourlyCostKrw: number;
}
interface MonthlySpendSnapshot { readonly spendKrw: number; readonly measuredAt: string }
export type CloudElasticToolEnv = Record<string, string | undefined>;
export interface CloudElasticToolResult { readonly outcome: 'ok' | 'fail' | 'partial'; readonly summary: string; readonly host?: string; readonly costKrw?: number; readonly deadlineAt?: number }
export interface CloudElasticHandToolResult { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }
export interface CloudElasticToolDeps {
  readonly ledger?: ResourceLedger; readonly now?: () => number; readonly monthlyCapKrw?: number; readonly initialMonthlySpendKrw?: number;
  readonly monthlySpendMeasuredAt?: number;
  /** Test seam; production sets this only after verifying a durable graph HITL decision. */
  readonly approvalVerified?: boolean;
  readonly runHandTool?: (operation: 'join' | 'leave', host: string, waitMinutes: number, timeoutMs?: number) => Promise<CloudElasticHandToolResult>;
  /** Test seam. Production reads the OP-maintained host map and rate table. */
  readonly trustedHourlyRateKrw?: (request: CloudElasticToolRequest) => number | undefined;
  /** Internal join compensation may wait for and then acquire its own stop after an early leave. */
  readonly authorizedJoinToken?: string;
}

const OWNER = 'RLA';
const SESSION_PREFIX = 'release-loop-cloud-elastic:session:';
const EVENT_RECORD_TYPE = 'release-loop-cloud-elastic-event';
const HOUR_MS = 60 * 60 * 1_000;
const CLOUD_LEAVE_TOOL_TIMEOUT_MS = 75 * 60 * 1_000;
const CLOUD_LEAVE_RESERVE_MS = CLOUD_LEAVE_TOOL_TIMEOUT_MS;
const CLOUD_JOIN_MAX_MS = 90 * 60 * 1_000;
function failure(summary: string): CloudElasticToolResult { return { outcome: 'fail', summary }; }
function parseRequest(raw: string | undefined): CloudElasticToolRequest | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('ELANOUS_CLOUD_REQUEST_JSON must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cloud request must be an object');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(row.id)) throw new Error('cloud request id must be a safe identifier');
  if (typeof row.event !== 'string' || !row.event.trim() || typeof row.purpose !== 'string' || !row.purpose.trim()) throw new Error('cloud request event and purpose are required');
  if (row.provider !== 'aws' && row.provider !== 'gcp') throw new Error('cloud request provider must be aws or gcp');
  if (typeof row.hostType !== 'string' || !row.hostType.trim() || typeof row.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.host)) throw new Error('cloud request hostType and safe host are required');
  if (typeof row.expectedHours !== 'number' || !Number.isFinite(row.expectedHours) || row.expectedHours <= 0
    || typeof row.hourlyCostKrw !== 'number' || !Number.isFinite(row.hourlyCostKrw) || row.hourlyCostKrw <= 0) throw new Error('cloud request expectedHours and hourlyCostKrw must be positive');
  return row as unknown as CloudElasticToolRequest;
}
function eventName(type: string): string { return `release-loop.cloud-elastic/${type}`; }
function trustedHourlyRateKrw(request: CloudElasticToolRequest, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const rateFile = env.ELANOUS_CLOUD_RATE_TABLE ?? join(homedir(), 'elanous-hq/seat-state/OP/cloud-rates.tsv');
  let map: string;
  if (env.ELANOUS_CLOUD_HOST_MAP) map = readFileSync(env.ELANOUS_CLOUD_HOST_MAP, 'utf8');
  else {
    const script = join(homedir(), 'elanous-hq/seat-state/OP/tools/cloud-vm.sh');
    const result = spawnSync('zsh', [script, 'map'], { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0) return undefined;
    map = result.stdout;
  }
  const host = map.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#') && line.split('\t')[0] === request.host)?.split('\t');
  if (!host || host[1] !== request.provider || host[4] !== request.hostType) return undefined;
  const region = host[3]; const os = host[5];
  let rows: string[][];
  try { rows = readFileSync(rateFile, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t')); }
  catch { return undefined; }
  const matchesRegion = (rateRegion: string) => region === rateRegion || region.startsWith(`${rateRegion}-`);
  const vm = rows.find(row => row[0] === 'vm' && row[1] === request.hostType && row[2] && matchesRegion(row[2]) && row[3] === os && row[5] === 'hour');
  const fx = rows.find(row => row[0] === 'fx' && row[1] === 'USDKRW' && row[5] === 'KRW');
  if (!vm || !fx) return undefined;
  const usd = Number(vm[4]); const usdKrw = Number(fx[4]);
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(usdKrw) || usdKrw <= 0) return undefined;
  return Math.ceil(usd * usdKrw);
}
function checkedHourlyRate(request: CloudElasticToolRequest, deps: Pick<CloudElasticToolDeps, 'trustedHourlyRateKrw'> = {}): number | undefined {
  const rate = deps.trustedHourlyRateKrw ? deps.trustedHourlyRateKrw(request) : trustedHourlyRateKrw(request);
  return Number.isSafeInteger(rate) && rate! > 0 && request.hourlyCostKrw === rate ? rate : undefined;
}
function recordEvent(ledger: ResourceLedger, requestId: string, event: Record<string, unknown>, at: number): void {
  const type = String(event.type);
  ledger.register({ id: `release-loop-cloud-elastic:${requestId}:${randomUUID()}`, kind: 'universe', machine: 'nexus',
    name: eventName(type), owner: OWNER, attrs: { ...event, recordType: EVENT_RECORD_TYPE, eventType: type, eventName: eventName(type) },
    observedAt: at, ttlMs: 90 * 24 * 60 * 60 * 1_000 }, OWNER);
}
function writeSession(ledger: ResourceLedger, request: CloudElasticToolRequest, status: 'starting' | 'joined' | 'stopping' | 'left' | 'orphaned', startAt: number, costKrw: number, at: number, graphRunId?: string, lifecycle: Record<string, unknown> = {}): void {
  ledger.register({ id: `${SESSION_PREFIX}${request.id}`, kind: 'universe', machine: request.host, name: 'release-loop.cloud-elastic/session', owner: OWNER,
    attrs: { type: 'release-loop-cloud-elastic-session', requestId: request.id, host: request.host, provider: request.provider,
      hourlyCostKrw: request.hourlyCostKrw, startAt, status, ...(graphRunId ? { graphRunId } : {}),
      expectedCostKrw: request.expectedHours * request.hourlyCostKrw,
      joinInFlight: status === 'starting' || (status === 'stopping' && lifecycle.joinInFlight === true),
      reservedKrw: status === 'left' ? 0 : request.expectedHours * request.hourlyCostKrw, costKrw,
      ...lifecycle },
    // Active/orphaned VM liabilities must remain visible until an explicit leave records stop.
    observedAt: at, ttlMs: Number.MAX_SAFE_INTEGER }, OWNER);
}
function currentPidNamespace(): string | undefined {
  try {
    const namespace = readlinkSync('/proc/self/ns/pid');
    return /^pid:\[[0-9]+\]$/.test(namespace) ? namespace : undefined;
  } catch { return undefined; }
}
function remoteProcessProbe(host: string, pid: number, namespace: string): boolean | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) return undefined;
  const script = 'ns=$(readlink "/proc/$1/ns/pid" 2>/dev/null) || { echo UNKNOWN; exit 0; }; '
    + '[ "$ns" = "$2" ] || { echo UNKNOWN; exit 0; }; '
    + 'if kill -0 "$1" 2>/dev/null; then echo ALIVE; else echo DEAD; fi';
  // Source: .rules/30-harness/testing-gates.md — bounded SSH probe must fail closed on timeout.
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1', host,
    'sh', '-c', script, 'cloud-elastic-probe', String(pid), namespace], { encoding: 'utf8', timeout: 2_000 });
  if (result.error || result.status !== 0) return undefined;
  if (result.stdout.trim() === 'ALIVE') return true;
  if (result.stdout.trim() === 'DEAD') return false;
  return undefined;
}
export function processIsAlive(
  attrs: Record<string, unknown>, prefix: 'join' | 'leave',
  probe: (host: string, pid: number, namespace: string) => boolean | undefined = remoteProcessProbe,
): boolean {
  const pid = attrs[`${prefix}OwnerPid`]; const host = attrs[`${prefix}OwnerHost`];
  const ownerPending = prefix === 'join'
    ? attrs.joinInFlight === true
    : typeof attrs.leaveOperationToken === 'string';
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof host !== 'string') return ownerPending;
  if (host !== hostname()) {
    const namespace = attrs[`${prefix}OwnerPidNamespace`];
    if (typeof namespace !== 'string' || !/^pid:\[[0-9]+\]$/.test(namespace)) return true;
    // Unknown host reachability or PID namespace is not proof of death: keep the reservation fail-closed.
    return probe(host, pid, namespace) ?? true;
  }
  const namespace = attrs[`${prefix}OwnerPidNamespace`];
  if (typeof namespace === 'string' && namespace !== currentPidNamespace()) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function monthlySpend(ledger: ResourceLedger, now: number, snapshotMeasuredAt?: number): number {
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const rows = ledger.list({ kind: 'universe' }, now);
  const currentMonthRows = rows.filter(row => row.observedAt >= monthStart);
  const allLeaveEvents = currentMonthRows.filter(row => row.attrs.recordType === EVENT_RECORD_TYPE && row.attrs.eventType === 'leave');
  // The measured snapshot already includes completed leave costs observed at or before its timestamp.
  const leaveEvents = allLeaveEvents.filter(row => snapshotMeasuredAt === undefined || row.observedAt > snapshotMeasuredAt);
  const leaveRequestIds = new Set(allLeaveEvents.map(row => String(row.attrs.id)));
  const eventSpend = leaveEvents.reduce((sum, row) => sum + Math.max(0, Number(row.attrs.costKrw) || 0), 0);
  return rows.reduce((total, row) => {
    if (row.name !== 'release-loop.cloud-elastic/session') return total;
    // An active lease remains a commitment when it crosses a calendar boundary.
    if (row.attrs.status === 'starting' || row.attrs.status === 'joined' || row.attrs.status === 'stopping' || row.attrs.status === 'orphaned') {
      const hourly = Math.max(0, Number(row.attrs.hourlyCostKrw) || 0);
      const started = Number(row.attrs.startAt);
      const accrued = Number.isFinite(started) ? Math.max(0, now - started) / HOUR_MS * hourly : 0;
      return total + Math.max(0, Number(row.attrs.reservedKrw) || 0, accrued);
    }
    if (row.attrs.status === 'left' && row.observedAt >= monthStart && !leaveRequestIds.has(String(row.attrs.requestId)))
      return total + Math.max(0, Number(row.attrs.costKrw) || 0);
    return total;
  }, eventSpend);
}

export function inputFromReleaseContext(operation: 'join' | 'leave' | 'approval-check', env: NodeJS.ProcessEnv): { request?: CloudElasticToolRequest; approved: boolean; monthlySpendSnapshot?: MonthlySpendSnapshot; nodeId: string; runId?: string; summary?: string } {
  const context = readGraphContext(env);
  const expectedNode = operation === 'join' ? 'cloud-join' : operation === 'approval-check' ? 'cloud-approval-check' : context.nodeId;
  if (context.nodeId !== expectedNode || (operation === 'leave' && !['cloud-leave-ok', 'cloud-leave-fail', 'cloud-leave-error', 'cloud-leave-join-fail'].includes(context.nodeId ?? '')))
    throw new Error(`cloud-elastic graph context mismatch: ${context.nodeId ?? 'missing'}`);
  const value = context.input.cloudElastic;
  if (value === undefined) return { approved: false, nodeId: context.nodeId!, ...(context.runId ? { runId: context.runId } : {}) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cloudElastic graph input must be an object');
  const cloud = value as Record<string, unknown>;
  if (cloud.request === undefined) return { approved: false, nodeId: context.nodeId!, ...(context.runId ? { runId: context.runId } : {}) };
  const request = parseRequest(JSON.stringify(cloud.request));
  if (!request) return { approved: false, nodeId: context.nodeId!, ...(context.runId ? { runId: context.runId } : {}) };
  const monthlySpendSnapshot = freshMonthlySpendSnapshot(cloud.monthlySpendSnapshot, Date.now());
  const approved = operation === 'join' && context.graphId !== undefined && context.runId !== undefined
    && hasApprovedGraphNodeInput({ graphId: context.graphId, runId: context.runId, nodeId: 'approve-cloud-elastic',
      inputPath: 'cloudElastic', inputSha256: createHash('sha256').update(JSON.stringify(cloud)).digest('hex'),
      maxAgeMs: 24 * HOUR_MS }); // Source: freshMonthlySpendSnapshot enforces this same maximum age for the approved cost basis.
  return { request, approved, ...(monthlySpendSnapshot ? { monthlySpendSnapshot } : {}), nodeId: context.nodeId!,
    ...(context.runId ? { runId: context.runId } : {}), ...(approved ? {} : { summary: 'cloud-elastic: request lacks matching OP approval' }) };
}

export function freshMonthlySpendSnapshot(value: unknown, now: number): MonthlySpendSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.spendKrw !== 'number' || !Number.isFinite(snapshot.spendKrw) || snapshot.spendKrw < 0 ||
      typeof snapshot.measuredAt !== 'string' || !Number.isFinite(Date.parse(snapshot.measuredAt))) return undefined;
  const measuredAt = Date.parse(snapshot.measuredAt);
  if (measuredAt > now || now - measuredAt > 24 * HOUR_MS) return undefined;
  const measuredMonth = new Date(measuredAt);
  const currentMonth = new Date(now);
  if (measuredMonth.getUTCFullYear() !== currentMonth.getUTCFullYear() || measuredMonth.getUTCMonth() !== currentMonth.getUTCMonth()) return undefined;
  return { spendKrw: snapshot.spendKrw, measuredAt: snapshot.measuredAt };
}

function approvalCheck(env: NodeJS.ProcessEnv, now = Date.now(), deps: Pick<CloudElasticToolDeps, 'trustedHourlyRateKrw'> = {}): CloudElasticToolResult {
  const context = readGraphContext(env);
  if (context.nodeId !== 'cloud-approval-check') return failure('cloud-elastic: approval check graph context mismatch');
  const cloud = context.input.cloudElastic;
  if (cloud === undefined) return { outcome: 'ok', summary: 'cloud-elastic: no VM request' };
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return failure('cloud-elastic: cloudElastic input must be an object');
  const request = parseRequest(JSON.stringify((cloud as Record<string, unknown>).request));
  if (!request) return failure('cloud-elastic: VM request missing');
  const hourlyRate = checkedHourlyRate(request, deps);
  if (hourlyRate === undefined) return failure('cloud-elastic: hourly rate does not match trusted host/provider/hostType rate; refusing request');
  const snapshot = freshMonthlySpendSnapshot((cloud as Record<string, unknown>).monthlySpendSnapshot, now);
  if (!snapshot)
    return failure('cloud-elastic: monthly spend snapshot missing or older than 24h; refusing to assume zero');
  const estimate = request.expectedHours * hourlyRate;
  if (snapshot.spendKrw + estimate > CLOUD_ELASTIC_MONTHLY_CAP_KRW) return failure(`cloud-elastic: monthly cap ${snapshot.spendKrw + estimate} exceeds ${CLOUD_ELASTIC_MONTHLY_CAP_KRW}`);
  return { outcome: 'partial', summary: `cloud-elastic: OP approval required for ${request.host} · estimate=${estimate} KRW · monthlySpend=${snapshot.spendKrw} KRW at ${snapshot.measuredAt} · request=${request.id}` };
}
async function defaultRunHandTool(operation: 'join' | 'leave', host: string, waitMinutes: number, timeoutMs?: number): Promise<CloudElasticHandToolResult> {
  const script = join(homedir(), 'elanous-hq/seat-state/OP/tools', operation === 'join' ? 'cloud-join.sh' : 'cloud-leave.sh');
  const args = operation === 'join' ? [script, host] : [script, host, '--wait-min', String(waitMinutes)];
  const result = spawnSync('zsh', args, { encoding: 'utf8', timeout: timeoutMs ?? (operation === 'join' ? CLOUD_JOIN_MAX_MS : CLOUD_LEAVE_TOOL_TIMEOUT_MS) });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.error?.message ?? result.stderr };
}

/** Commands invoked by release graph recipe nodes; cloud effects are behind an injected hand-tool boundary. */
export async function runCloudElasticToolNode(
  operation: 'join' | 'leave', env: CloudElasticToolEnv, deps: CloudElasticToolDeps = {},
): Promise<CloudElasticToolResult> {
  const request = parseRequest(env.ELANOUS_CLOUD_REQUEST_JSON);
  if (!request) return { outcome: 'ok', summary: `cloud-${operation}: no VM request` };
  const ledger = deps.ledger ?? new ResourceLedger(); const now = deps.now ?? Date.now;
  const at = now(); const cap = deps.monthlyCapKrw ?? CLOUD_ELASTIC_MONTHLY_CAP_KRW;
  const initialSpend = deps.initialMonthlySpendKrw;
  if (!Number.isFinite(cap) || cap < 0 || (initialSpend !== undefined && (!Number.isFinite(initialSpend) || initialSpend < 0))) return failure('cloud-elastic: monthly budget inputs are invalid');
  if (operation === 'join' && initialSpend === undefined) return failure('cloud-elastic: measured monthly cloud spend is unavailable; refusing to assume zero');
  if (operation === 'join' && deps.approvalVerified !== true) {
    recordEvent(ledger, request.id, { type: 'request', id: request.id, event: request.event, purpose: request.purpose,
      provider: request.provider, hostType: request.hostType, expectedHours: request.expectedHours,
      hourlyCostKrw: request.hourlyCostKrw, estimatedCostKrw: request.expectedHours * request.hourlyCostKrw }, at);
    recordEvent(ledger, request.id, { type: 'start-denied', id: request.id, detail: 'OP approval missing' }, at);
    return failure('cloud-elastic: OP approval missing');
  }
  if (env.ELANOUS_CLOUD_HOST && env.ELANOUS_CLOUD_HOST !== request.host) return failure('cloud-elastic: approved host does not match request');
  const sessionId = `${SESSION_PREFIX}${request.id}`;
  const session = ledger.list({ kind: 'universe' }, at).find(row => row.id === sessionId);
  const runHandTool = deps.runHandTool ?? defaultRunHandTool;
  const waitMinutes = Number(env.ELANOUS_CLOUD_LEAVE_WAIT_MIN ?? '30');
  if (!Number.isSafeInteger(waitMinutes) || waitMinutes < 1 || waitMinutes > 30) return failure('cloud-elastic: leave wait must be 1..30 minutes');

  if (operation === 'join') {
    const hourlyRate = checkedHourlyRate(request, deps);
    if (hourlyRate === undefined) return failure('cloud-elastic: hourly rate does not match trusted host/provider/hostType rate; refusing VM start');
    const estimate = request.expectedHours * hourlyRate;
    const joinTimeoutMs = Math.min(CLOUD_JOIN_MAX_MS, request.expectedHours * HOUR_MS - CLOUD_LEAVE_RESERVE_MS);
    const startAt = now();
    const joinToken = randomUUID();
    const reservation = await ledger.withSerializedMutation(() => {
      const latestAt = now();
      const sessions = ledger.list({ kind: 'universe' }, latestAt).filter(row => row.name === 'release-loop.cloud-elastic/session');
      const existing = sessions.find(row => row.id === sessionId);
      if (existing) return { error: `cloud-elastic: request ${request.id} already has a ${String(existing.attrs.status)} session` };
      const hostBusy = sessions.find(row => row.machine === request.host && ['starting', 'joined', 'stopping', 'orphaned'].includes(String(row.attrs.status)));
      if (hostBusy) return { error: `cloud-elastic: host ${request.host} already has active request ${String(hostBusy.attrs.requestId)} (${String(hostBusy.attrs.status)})` };
      const currentSpend = initialSpend! + monthlySpend(ledger, latestAt, deps.monthlySpendMeasuredAt);
      if (joinTimeoutMs <= 0) {
        recordEvent(ledger, request.id, { type: 'request', id: request.id, event: request.event, purpose: request.purpose,
          provider: request.provider, hostType: request.hostType, expectedHours: request.expectedHours,
          hourlyCostKrw: request.hourlyCostKrw, estimatedCostKrw: estimate }, latestAt);
        recordEvent(ledger, request.id, { type: 'start-denied', id: request.id, detail: 'expected VM time must exceed the 75-minute leave reserve' }, latestAt);
        return { error: 'cloud-elastic: expected VM time must exceed 75-minute leave reserve' };
      }
      if (currentSpend + estimate > cap) {
        recordEvent(ledger, request.id, { type: 'request', id: request.id, event: request.event, purpose: request.purpose,
          provider: request.provider, hostType: request.hostType, expectedHours: request.expectedHours,
          hourlyCostKrw: request.hourlyCostKrw, estimatedCostKrw: estimate }, latestAt);
        recordEvent(ledger, request.id, { type: 'start-denied', id: request.id, detail: `monthly cap ${currentSpend + estimate} > ${cap}` }, latestAt);
        return { error: `cloud-elastic: monthly cap exceeded (${currentSpend + estimate} > ${cap})` };
      }
      recordEvent(ledger, request.id, { type: 'request', id: request.id, event: request.event, purpose: request.purpose,
        provider: request.provider, hostType: request.hostType, expectedHours: request.expectedHours, hourlyCostKrw: request.hourlyCostKrw,
        estimatedCostKrw: estimate }, latestAt);
      const ownerPidNamespace = currentPidNamespace();
      writeSession(ledger, request, 'starting', startAt, 0, startAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID,
        { joinToken, joinOwnerHost: hostname(), joinOwnerPid: process.pid,
          ...(ownerPidNamespace ? { joinOwnerPidNamespace: ownerPidNamespace } : {}) });
      recordEvent(ledger, request.id, { type: 'start', id: request.id, host: request.host, at: startAt }, startAt);
      return { error: undefined };
    });
    if (reservation.error) return failure(reservation.error);
    const joined = await runHandTool('join', request.host, waitMinutes, joinTimeoutMs);
    if (joined.exitCode !== 0) {
      const cleanup = await runCloudElasticToolNode('leave', {
        ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_HOST: env.ELANOUS_CLOUD_HOST,
        ELANOUS_CLOUD_LEAVE_WAIT_MIN: env.ELANOUS_CLOUD_LEAVE_WAIT_MIN,
        ELANOUS_CLOUD_GRAPH_RUN_ID: env.ELANOUS_CLOUD_GRAPH_RUN_ID,
      }, { ...deps, ledger, now, authorizedJoinToken: joinToken });
      if (cleanup.outcome === 'ok') return failure(`cloud-elastic: join failed and temporary VM was stopped (${joined.stderr ?? joined.exitCode})`);
      return failure(`cloud-elastic: orphan VM ${request.host} after join failure: ${cleanup.summary}`);
    }
    const joinedAt = now();
    try {
      const transition = await ledger.withSerializedMutation(() => {
        const latest = ledger.list({ kind: 'universe' }, joinedAt).find(row => row.id === sessionId);
        if (latest?.attrs.status !== 'starting') return latest?.attrs.status;
        writeSession(ledger, request, 'joined', startAt, 0, joinedAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID);
        recordEvent(ledger, request.id, { type: 'join', id: request.id, host: request.host, at: joinedAt }, joinedAt);
        return 'joined';
      });
      if (transition !== 'joined') {
        const cleanup = await runCloudElasticToolNode('leave', {
          ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_HOST: env.ELANOUS_CLOUD_HOST,
          ELANOUS_CLOUD_LEAVE_WAIT_MIN: env.ELANOUS_CLOUD_LEAVE_WAIT_MIN,
          ELANOUS_CLOUD_GRAPH_RUN_ID: env.ELANOUS_CLOUD_GRAPH_RUN_ID,
        }, { ...deps, ledger, now, authorizedJoinToken: joinToken });
        if (cleanup.outcome === 'ok') {
          return failure(`cloud-elastic: join completed after session was ${String(transition ?? 'removed')}; stopped ${request.host}`);
        }
        // Source: .rules/30-harness/testing-gates.md — failed compensation cannot clear an active VM liability.
        return failure(`cloud-elastic: join completed after session was ${String(transition ?? 'removed')} and cleanup failed: ${cleanup.summary}`);
      }
    } catch (ledgerError) {
      const cleanup = await runCloudElasticToolNode('leave', {
        ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_HOST: env.ELANOUS_CLOUD_HOST,
        ELANOUS_CLOUD_LEAVE_WAIT_MIN: env.ELANOUS_CLOUD_LEAVE_WAIT_MIN,
        ELANOUS_CLOUD_GRAPH_RUN_ID: env.ELANOUS_CLOUD_GRAPH_RUN_ID,
      }, { ...deps, ledger, now, authorizedJoinToken: joinToken });
      if (cleanup.outcome === 'ok') {
        const stoppedAt = now(); const costKrw = Math.max(0, stoppedAt - startAt) / HOUR_MS * request.hourlyCostKrw;
        try { writeSession(ledger, request, 'left', startAt, costKrw, stoppedAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID); } catch { /* external leave succeeded; retain the primary ledger error */ }
        try { recordEvent(ledger, request.id, { type: 'leave', id: request.id, at: stoppedAt, costKrw, detail: 'cleanup after ledger failure' }, stoppedAt); } catch { /* VM is stopped even if the event sink is unavailable */ }
        return failure(`cloud-elastic: Nexus write failed; stopped ${request.host} (${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)})`);
      }
      try { writeSession(ledger, request, 'orphaned', startAt, 0, now(), env.ELANOUS_CLOUD_GRAPH_RUN_ID); } catch { /* preserve the tool failure below */ }
      try { recordEvent(ledger, request.id, { type: 'orphan', id: request.id, host: request.host, detail: 'Nexus write failed and cleanup failed' }, now()); } catch { /* stdout retains the blocker */ }
      return failure(`cloud-elastic: orphan VM ${request.host}; Nexus write and cleanup both failed`);
    }
    return { outcome: 'ok', summary: `cloud-elastic: joined ${request.host}`, host: request.host,
      deadlineAt: startAt + request.expectedHours * HOUR_MS - CLOUD_LEAVE_RESERVE_MS };
  }

  if (!session || !['starting', 'joined', 'stopping', 'orphaned', 'left'].includes(String(session.attrs.status))) return failure(`cloud-elastic: no active session for ${request.id}`);
  if (session.attrs.graphRunId !== env.ELANOUS_CLOUD_GRAPH_RUN_ID) return failure(`cloud-elastic: active session ${request.id} belongs to another graph run`);
  if (session.attrs.host !== request.host || session.attrs.hourlyCostKrw !== request.hourlyCostKrw) return failure('cloud-elastic: leave request differs from joined request');

  const leaveToken = randomUUID();
  let claimed: { kind: 'claimed'; startAt: number; joinToken?: string } | { kind: 'left' } | { kind: 'busy'; detail: string } | { kind: 'failed'; detail: string };
  const claimDeadline = Date.now() + CLOUD_LEAVE_TOOL_TIMEOUT_MS + 10_000;
  while (true) {
    claimed = await ledger.withSerializedMutation(() => {
      const latest = ledger.list({ kind: 'universe' }, now()).find(row => row.id === sessionId);
      if (!latest || !['starting', 'joined', 'stopping', 'orphaned', 'left'].includes(String(latest.attrs.status)))
        return { kind: 'failed', detail: `cloud-elastic: no active session for ${request.id}` };
      if (latest.attrs.graphRunId !== env.ELANOUS_CLOUD_GRAPH_RUN_ID)
        return { kind: 'failed', detail: `cloud-elastic: active session ${request.id} belongs to another graph run` };
      if (latest.attrs.host !== request.host || latest.attrs.hourlyCostKrw !== request.hourlyCostKrw)
        return { kind: 'failed', detail: 'cloud-elastic: leave request differs from joined request' };
      if (latest.attrs.status === 'left' && typeof deps.authorizedJoinToken !== 'string') return { kind: 'left' };
      if (processIsAlive(latest.attrs, 'leave')) return { kind: 'busy', detail: 'another leave operation owns this session' };
      const joinPending = latest.attrs.joinInFlight === true && processIsAlive(latest.attrs, 'join');
      const ownsJoin = typeof deps.authorizedJoinToken === 'string' && deps.authorizedJoinToken === latest.attrs.joinToken;
      if (latest.attrs.status === 'stopping' && joinPending && !ownsJoin)
        return { kind: 'busy', detail: 'the owning join is still settling' };
      const startAt = Number(latest.attrs.startAt) || at;
      const joinToken = joinPending && typeof latest.attrs.joinToken === 'string' ? latest.attrs.joinToken : undefined;
      // Source: .rules/30-harness/testing-gates.md - persist one stop owner before any external stop work.
      const ownerPidNamespace = currentPidNamespace();
      writeSession(ledger, request, 'stopping', startAt, 0, now(), env.ELANOUS_CLOUD_GRAPH_RUN_ID, {
        joinInFlight: joinPending, ...(joinPending ? { joinToken, joinOwnerHost: latest.attrs.joinOwnerHost,
          joinOwnerPid: latest.attrs.joinOwnerPid, joinOwnerPidNamespace: latest.attrs.joinOwnerPidNamespace } : {}),
        leaveOperationToken: leaveToken, leaveOwnerHost: hostname(), leaveOwnerPid: process.pid,
        ...(ownerPidNamespace ? { leaveOwnerPidNamespace: ownerPidNamespace } : {}),
      });
      return { kind: 'claimed', startAt, ...(joinToken ? { joinToken } : {}) };
    });
    if (claimed.kind !== 'busy') break;
    if (typeof deps.authorizedJoinToken !== 'string' || deps.authorizedJoinToken !== session.attrs.joinToken || Date.now() >= claimDeadline)
      return failure(`cloud-elastic: ${claimed.detail}`);
    await pause(25);
  }
  if (claimed.kind === 'left') return { outcome: 'ok', summary: `cloud-elastic: ${request.host} was already stopped`, host: request.host };
  if (claimed.kind === 'failed') return failure(claimed.detail);

  const left = await runHandTool('leave', request.host, waitMinutes, CLOUD_LEAVE_TOOL_TIMEOUT_MS);
  if (left.exitCode !== 0) {
    const detail = left.stderr ?? `cloud-leave exit ${left.exitCode}`;
    const failedAt = now();
    await ledger.withSerializedMutation(() => {
      const latest = ledger.list({ kind: 'universe' }, failedAt).find(row => row.id === sessionId);
      if (latest?.attrs.leaveOperationToken === leaveToken) {
        const joinPending = latest.attrs.joinInFlight === true && processIsAlive(latest.attrs, 'join');
        writeSession(ledger, request, 'orphaned', claimed.startAt, 0, failedAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID,
          joinPending ? { joinInFlight: true, joinToken: latest.attrs.joinToken, joinOwnerHost: latest.attrs.joinOwnerHost,
            joinOwnerPid: latest.attrs.joinOwnerPid, joinOwnerPidNamespace: latest.attrs.joinOwnerPidNamespace } : {});
        recordEvent(ledger, request.id, { type: 'orphan', id: request.id, host: request.host, detail }, failedAt);
      }
    });
    return failure(`cloud-elastic: orphan VM ${request.host}; ${detail}`);
  }
  const stoppedAt = now(); const startAt = claimed.startAt;
  const costKrw = Math.max(0, stoppedAt - startAt) / HOUR_MS * request.hourlyCostKrw;
  await ledger.withSerializedMutation(() => {
    const latest = ledger.list({ kind: 'universe' }, stoppedAt).find(row => row.id === sessionId);
    if (latest?.attrs.leaveOperationToken !== leaveToken) return;
    const ownsJoin = typeof deps.authorizedJoinToken === 'string' && deps.authorizedJoinToken === latest.attrs.joinToken;
    const joinPending = !ownsJoin
      && latest.attrs.joinInFlight === true && processIsAlive(latest.attrs, 'join');
    if (joinPending) {
      // The pending join may start a VM after this stop; reserve the host until its compensation finishes.
      writeSession(ledger, request, 'stopping', startAt, 0, stoppedAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID, {
        joinInFlight: true, joinToken: latest.attrs.joinToken, joinOwnerHost: latest.attrs.joinOwnerHost,
        joinOwnerPid: latest.attrs.joinOwnerPid, joinOwnerPidNamespace: latest.attrs.joinOwnerPidNamespace,
        leaveCompletedAt: stoppedAt,
      });
      return;
    }
    writeSession(ledger, request, 'left', startAt, costKrw, stoppedAt, env.ELANOUS_CLOUD_GRAPH_RUN_ID);
    recordEvent(ledger, request.id, { type: 'leave', id: request.id, host: request.host, at: stoppedAt, costKrw,
      detail: `startAt=${startAt}; stopAt=${stoppedAt}` }, stoppedAt);
  });
  const spentAfter = (initialSpend ?? 0) + monthlySpend(ledger, stoppedAt, deps.monthlySpendMeasuredAt);
  if (spentAfter > cap) return failure(`cloud-elastic: VM stopped but estimated monthly spend exceeded cap (${spentAfter} > ${cap})`);
  return { outcome: 'ok', summary: `cloud-elastic: stopped ${request.host}`, host: request.host, costKrw };
}

if (import.meta.main) {
  const operation = process.argv[2];
  if (operation !== 'join' && operation !== 'leave' && operation !== 'approval-check') {
    console.error('usage: cloud-elastic-node.ts <approval-check|join|leave>'); process.exitCode = 2;
  } else {
    try {
      if (operation === 'approval-check') {
        const checked = approvalCheck(process.env);
        process.exitCode = finishNode('cloud-approval-check', '', { ...checked, verdict: checked.outcome === 'fail' ? 'fail' : 'pass' });
      } else {
        const input = inputFromReleaseContext(operation, process.env);
        if (!input.request) {
          process.exitCode = finishNode(input.nodeId, '', { outcome: 'ok', verdict: 'pass', summary: `cloud-${operation}: no VM request` });
        } else if (operation === 'join' && !input.approved) {
          const result = failure(input.summary ?? 'cloud-elastic: request lacks matching OP approval');
          process.exitCode = finishNode(input.nodeId, '', { ...result, verdict: 'fail' });
        } else {
          const result = await runCloudElasticToolNode(operation, {
            ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(input.request),
            ELANOUS_CLOUD_HOST: process.env.ELANOUS_CLOUD_HOST,
            ELANOUS_CLOUD_LEAVE_WAIT_MIN: process.env.ELANOUS_CLOUD_LEAVE_WAIT_MIN,
            ELANOUS_CLOUD_GRAPH_RUN_ID: input.runId,
          }, { approvalVerified: input.approved, initialMonthlySpendKrw: input.monthlySpendSnapshot?.spendKrw,
            monthlySpendMeasuredAt: input.monthlySpendSnapshot ? Date.parse(input.monthlySpendSnapshot.measuredAt) : undefined });
          process.exitCode = finishNode(input.nodeId, '', { ...result, verdict: result.outcome === 'ok' ? 'pass' : 'fail' });
        }
      }
    } catch (error) {
      const result = errorResult(error);
      const nodeId = operation === 'approval-check' ? 'cloud-approval-check' : operation === 'join' ? 'cloud-join' : 'cloud-leave';
      process.exitCode = finishNode(nodeId, '', result);
    }
  }
}
