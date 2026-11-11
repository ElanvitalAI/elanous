/** Offline contract simulation. This module has no Google Cloud SDK, CLI or network access. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { activeResourceLeases, beginResourceLease, endResourceLease, readResourceLedger,
  reconcileResourceLeases } from '../../../src/resource-ledger/resource-ledger.js';
import { validateProposalPressure, type ProposalPressure } from '../demo/pressure-input.js';

type Signal = ProposalPressure;
type Proposal = { id: string; signal: Signal; architecture: 'batch-spot' | 'cloud-run'; region: string;
  signalSource?: string;
  estimate: { formula: string; skuSource: string; price: 'unpriced'; usage: { vcpuHours: number; gibHours: number } };
  idleTtlMs: number };
type Approval = { proposalHash: string; actor: string; expiresAt: string; maximumSpend: string };
type CostEvent = { event: 'estimate' | 'usage' | 'stopped'; at: string; proposalId: string;
  amount: 'unpriced'; formula?: string; usage?: { vcpuHours: number; gibHours: number } };

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const suppliedPath = process.argv[2] === '--proposal' ? process.argv[3] : undefined;
const suppliedRaw: Proposal | undefined = suppliedPath ? JSON.parse(readFileSync(suppliedPath, 'utf8')) : undefined;
const suppliedSignal = suppliedRaw?.signal as unknown as Record<string, unknown> | undefined;
const suppliedProposal: Proposal | undefined = suppliedRaw && suppliedSignal &&
  typeof suppliedSignal.cpuUsed === 'number' && typeof suppliedSignal.source !== 'string'
  ? { ...suppliedRaw, signal: { ...suppliedSignal,
      source: suppliedRaw.signalSource ?? 'legacy-synthetic-proposal' } as Signal } : suppliedRaw;
const now = suppliedProposal ? new Date(suppliedProposal.signal.observedAt) : new Date('2026-11-10T04:00:00.000Z');
if (!Number.isFinite(now.getTime())) throw new Error('invalid simulated observation time');
const source = 'https://cloud.google.com/compute/all-pricing';

function detect(s: Signal): string[] {
  if (!Number.isFinite(Date.parse(s.observedAt)) || now.getTime() - Date.parse(s.observedAt) > 60_000) return ['unknown'];
  try { return validateProposalPressure(s).shortage; } catch { return ['unknown']; }
}

function propose(signal: Signal): Proposal {
  const shortage = detect(signal);
  if (shortage.length === 0 || shortage.includes('unknown')) throw new Error('fresh shortage required');
  return { id: 'proposal-fake-1', signal, architecture: 'batch-spot', region: 'us-central1',
    estimate: { formula: 'vcpuHours × official regional Spot vCPU SKU + gibHours × official regional Spot memory SKU + disk + network + logs',
      skuSource: source, price: 'unpriced', usage: { vcpuHours: 4, gibHours: 8 } }, idleTtlMs: 60_000 };
}

function assertApproval(proposal: Proposal, approval?: Approval): void {
  const expiry = approval ? Date.parse(approval.expiresAt) : NaN;
  if (!approval || approval.proposalHash !== hash(proposal) || !Number.isFinite(expiry) || expiry <= now.getTime()
    || !approval.actor.trim() || !approval.maximumSpend.trim()) throw new Error('HITL approval required');
}

function runFakeWorld(proposal: Proposal, approval?: Approval) {
  const shortage = detect(proposal.signal);
  if (shortage.length === 0 || shortage.includes('unknown')) throw new Error('fresh shortage required');
  assertApproval(proposal, approval); // First side effect follows this line.
  const root = mkdtempSync(join(tmpdir(), 'gcp-architect-fake-'));
  const ledgerPath = join(root, 'resource-ledger', 'events.jsonl');
  const costPath = join(root, 'cost-events.jsonl');
  const events: CostEvent[] = [];
  const append = (event: CostEvent) => { events.push(event); writeFileSync(costPath, events.map(row => JSON.stringify(row)).join('\n') + '\n'); };
  try {
    const project = { id: 'fake-project-1', provider: 'fake-gcp', region: proposal.region };
    append({ event: 'estimate', at: now.toISOString(), proposalId: proposal.id, amount: 'unpriced', formula: proposal.estimate.formula });
    const lease = beginResourceLease({ fp: 'fp_fakegcp001', host: `gcp.${project.id}.${project.region}`,
      lane: 'unknown', resources: { cpu: 2, memoryBytes: 2 * 1024 ** 3 }, mission: { cell: proposal.id },
      ttlMs: proposal.idleTtlMs, now }, ledgerPath);
    append({ event: 'usage', at: new Date(now.getTime() + 30_000).toISOString(), proposalId: proposal.id,
      amount: 'unpriced', usage: { vcpuHours: 2 / 60, gibHours: 2 / 60 } });
    const findings = reconcileResourceLeases({ leases: activeResourceLeases(readResourceLedger(ledgerPath)),
      measurements: [{ host: lease.host, observedAt: now.toISOString(), pods: [], processes: [], errors: [] }], now });
    endResourceLease(lease.id, 'idle TTL', 'fake-world', new Date(now.getTime() + proposal.idleTtlMs), ledgerPath);
    append({ event: 'stopped', at: new Date(now.getTime() + proposal.idleTtlMs).toISOString(), proposalId: proposal.id, amount: 'unpriced' });
    const active = activeResourceLeases(readResourceLedger(ledgerPath));
    return { project, proposalId: proposal.id, architecture: proposal.architecture,
      shortage: detect(proposal.signal), approval: approval!.actor, findings,
      costLedger: readFileSync(costPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)), activeLeases: active.length,
      realGcpCalls: 0 };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const signal: Signal = { cpuUsed: 0.93, memoryUsed: 0.91, diskUsed: 0.92, queued: 14,
  observedAt: now.toISOString(), source: 'synthetic-demo-fixture' };
const proposal: Proposal = suppliedProposal ?? propose(signal);
let deniedBeforeSideEffect = false;
try { runFakeWorld(proposal); } catch (error) { deniedBeforeSideEffect = (error as Error).message === 'HITL approval required'; }
if (!deniedBeforeSideEffect) throw new Error('missing approval was not denied');
const approval: Approval = { proposalHash: hash(proposal), actor: 'fake-user',
  expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(), maximumSpend: 'fake-policy-only' };
for (const invalid of [{ ...approval, expiresAt: now.toISOString() }, { ...approval, expiresAt: 'not-a-date' },
  { ...approval, proposalHash: 'changed-proposal' }]) {
  let blocked = false;
  try { runFakeWorld(proposal, invalid); } catch (error) { blocked = (error as Error).message === 'HITL approval required'; }
  if (!blocked) throw new Error('invalid approval was not denied');
}
const result = runFakeWorld(proposal, approval);
if (result.activeLeases !== 0 || result.realGcpCalls !== 0 || result.costLedger.length !== 3) throw new Error('fake lifecycle invariant failed');
console.log(JSON.stringify({ deniedBeforeSideEffect, syntheticApproval: true, ...result }, null, 2));
