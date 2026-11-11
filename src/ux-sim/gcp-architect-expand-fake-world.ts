/** Offline contract simulation. This module has no Google Cloud SDK, CLI or network access. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { activeResourceLeases, beginResourceLease, endResourceLease, readResourceLedger,
  reconcileResourceLeases } from '../resource-ledger/resource-ledger.js';

type Signal = { cpuUsed: number; memoryUsed: number; diskUsed: number; queued: number; observedAt: string };
type Proposal = { id: string; signal: Signal; architecture: 'batch-spot'; region: string;
  estimate: { formula: string; skuSource: string; price: 'unpriced'; usage: { vcpuHours: number; gibHours: number } };
  idleTtlMs: number };
type Approval = { proposalHash: string; actor: string; expiresAt: string; maximumSpend: string };
type FakeProject = { id: string; provider: 'fake-gcp'; region: string; state: 'created' | 'running' | 'stopped';
  stateHistory: Array<'created' | 'running' | 'stopped'>; startedAt?: string; lastActivityAt?: string; stoppedAt?: string };
type CostEvent = { event: 'estimate' | 'usage' | 'stopped'; at: string; proposalId: string;
  amount: 'unpriced'; formula?: string; usage?: { vcpuHours: number; gibHours: number } };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = new Date('2026-11-10T04:00:00.000Z');
const source = 'https://cloud.google.com/compute/all-pricing';

function detect(s: Signal): string[] {
  if (!Number.isFinite(Date.parse(s.observedAt)) || now.getTime() - Date.parse(s.observedAt) > 60_000) return ['unknown'];
  return ([s.cpuUsed >= 0.85 && 'cpu', s.memoryUsed >= 0.85 && 'memory',
    s.diskUsed >= 0.9 && 'disk', s.queued >= 10 && 'queue'].filter(Boolean) as string[]);
}

function propose(signal: Signal): Proposal {
  const shortage = detect(signal);
  if (shortage.length === 0 || shortage.includes('unknown')) throw new Error('fresh shortage required');
  return { id: 'proposal-fake-1', signal, architecture: 'batch-spot', region: 'us-central1',
    estimate: { formula: 'vcpuHours × official regional Spot vCPU SKU + gibHours × official regional Spot memory SKU + disk + network + logs',
      skuSource: source, price: 'unpriced', usage: { vcpuHours: 4, gibHours: 8 } }, idleTtlMs: 60_000 };
}

function assertApproval(proposal: Proposal, approval?: Approval): void {
  const expiresAt = approval ? Date.parse(approval.expiresAt) : Number.NaN;
  if (!approval || approval.proposalHash !== hash(proposal) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()
    || !approval.actor.trim() || !approval.maximumSpend.trim()) throw new Error('HITL approval required');
}

function startFakeProject(project: FakeProject, at: Date): void {
  if (project.state !== 'created') throw new Error(`fake project cannot start from ${project.state}`);
  project.state = 'running';
  project.stateHistory.push(project.state);
  project.startedAt = at.toISOString();
  project.lastActivityAt = at.toISOString();
}

function recordFakeProjectActivity(project: FakeProject, at: Date): void {
  if (project.state !== 'running') throw new Error(`fake project cannot receive activity from ${project.state}`);
  project.lastActivityAt = at.toISOString();
}

function stopFakeProjectIfIdle(project: FakeProject, at: Date, idleTtlMs: number): boolean {
  const lastActivityAt = project.lastActivityAt ? Date.parse(project.lastActivityAt) : Number.NaN;
  if (project.state !== 'running' || !Number.isFinite(lastActivityAt) || at.getTime() < lastActivityAt
    || at.getTime() - lastActivityAt < idleTtlMs) return false;
  project.state = 'stopped';
  project.stateHistory.push(project.state);
  project.stoppedAt = at.toISOString();
  return true;
}

function runFakeWorld(proposal: Proposal, approval?: Approval) {
  assertApproval(proposal, approval); // First side effect follows this line.
  const root = mkdtempSync(join(tmpdir(), 'gcp-architect-fake-'));
  const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
  const costPath = join(root, 'cost-events.jsonl');
  const events: CostEvent[] = [];
  const append = (event: CostEvent) => { events.push(event); writeFileSync(costPath, events.map((entry) => JSON.stringify(entry)).join('\n') + '\n'); };
  try {
    const project: FakeProject = { id: 'fake-project-1', provider: 'fake-gcp', region: proposal.region,
      state: 'created', stateHistory: ['created'] };
    append({ event: 'estimate', at: now.toISOString(), proposalId: proposal.id, amount: 'unpriced', formula: proposal.estimate.formula });
    const lease = beginResourceLease({ fp: 'fp_fakegcp001', host: `gcp.${project.id}.${project.region}`,
      lane: 'unknown', resources: { cpu: 2, memoryBytes: 2 * 1024 ** 3 }, mission: { cell: proposal.id },
      ttlMs: proposal.idleTtlMs, now }, ledgerPath);
    startFakeProject(project, now);
    const activityAt = new Date(now.getTime() + 30_000);
    recordFakeProjectActivity(project, activityAt);
    append({ event: 'usage', at: activityAt.toISOString(), proposalId: proposal.id,
      amount: 'unpriced', usage: { vcpuHours: 2 / 60, gibHours: 2 / 60 } });
    const findings = reconcileResourceLeases({ leases: activeResourceLeases(readResourceLedger(ledgerPath)),
      measurements: [{ host: lease.host, observedAt: now.toISOString(), pods: [], processes: [], errors: [] }], now });
    const nonIdleCheckAt = new Date(now.getTime() + proposal.idleTtlMs);
    const nonIdleStopTriggered = stopFakeProjectIfIdle(project, nonIdleCheckAt, proposal.idleTtlMs);
    const stateAfterNonIdleCheck = project.state;
    const idleStopAt = new Date(Date.parse(project.lastActivityAt!) + proposal.idleTtlMs);
    const stateBeforeIdleStopAt = new Date(idleStopAt.getTime() - 1);
    const stateBeforeIdleStop = project.state;
    const stoppedBeforeIdleTtl = stopFakeProjectIfIdle(project, stateBeforeIdleStopAt, proposal.idleTtlMs);
    const idleStopTriggered = stopFakeProjectIfIdle(project, idleStopAt, proposal.idleTtlMs);
    if (nonIdleStopTriggered || stateAfterNonIdleCheck !== 'running' || stoppedBeforeIdleTtl || !idleStopTriggered) {
      throw new Error('fake project must stop only after reaching its idle TTL');
    }
    endResourceLease(lease.id, 'idle TTL', 'fake-world', idleStopAt, ledgerPath);
    append({ event: 'stopped', at: project.stoppedAt!, proposalId: proposal.id, amount: 'unpriced' });
    const active = activeResourceLeases(readResourceLedger(ledgerPath));
    return { project, nonIdleCheckAt: nonIdleCheckAt.toISOString(), nonIdleStopTriggered, stateAfterNonIdleCheck,
      projectStateBeforeIdleStopAt: stateBeforeIdleStopAt.toISOString(), stoppedBeforeIdleTtl,
      projectStateBeforeIdleStop: stateBeforeIdleStop, idleStopTriggered, projectStateAfterIdleStop: project.state,
      shortage: detect(proposal.signal), approval: approval!.actor, findings,
      costLedger: readFileSync(costPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)), activeLeases: active.length,
      realGcpCalls: 0 };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const signal: Signal = { cpuUsed: 0.93, memoryUsed: 0.91, diskUsed: 0.92, queued: 14, observedAt: now.toISOString() };
const proposal = propose(signal);
let deniedBeforeSideEffect = false;
try { runFakeWorld(proposal); } catch (error) { deniedBeforeSideEffect = (error as Error).message === 'HITL approval required'; }
if (!deniedBeforeSideEffect) throw new Error('missing approval was not denied');
const approval: Approval = { proposalHash: hash(proposal), actor: 'fake-user', expiresAt: '2026-11-10T05:00:00.000Z', maximumSpend: 'fake-policy-only' };
let invalidApprovalsDeniedBeforeSideEffect = true;
for (const invalid of [
  { ...approval, expiresAt: now.toISOString() },
  { ...approval, expiresAt: 'not-a-date' },
  { ...approval, proposalHash: 'changed-proposal' },
]) {
  let blocked = false;
  try { runFakeWorld(proposal, invalid); } catch (error) { blocked = (error as Error).message === 'HITL approval required'; }
  if (!blocked) invalidApprovalsDeniedBeforeSideEffect = false;
}
const result = runFakeWorld(proposal, approval);
if (result.activeLeases !== 0 || result.realGcpCalls !== 0 || result.costLedger.length !== 3
  || result.nonIdleStopTriggered || result.stateAfterNonIdleCheck !== 'running' || result.stoppedBeforeIdleTtl
  || !result.idleStopTriggered || result.projectStateBeforeIdleStop !== 'running'
  || result.projectStateAfterIdleStop !== 'stopped') {
  throw new Error('fake lifecycle invariant failed');
}
console.log(JSON.stringify({ deniedBeforeSideEffect, invalidApprovalsDeniedBeforeSideEffect, ...result }, null, 2));
