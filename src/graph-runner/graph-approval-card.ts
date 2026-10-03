import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { DecisionLedger, type DecisionEntry } from '../decisions/decision-ledger.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { decideGraphApproval, type GraphRunState } from './runner.js';

export interface GraphApprovalCardDeps {
  root?: string;
  ledger?: Pick<DecisionLedger, 'list' | 'raise'>;
}

type Pending = NonNullable<GraphRunState['pending']>;
const REF = /^graph-approval:([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*):([A-Za-z0-9][A-Za-z0-9._-]*):([1-9]\d*)$/;

function ledgerFor(deps: GraphApprovalCardDeps, root: string): Pick<DecisionLedger, 'list' | 'raise'> {
  return deps.ledger ?? new DecisionLedger({ stateDir: root });
}

function observation(event: 'raised' | 'dedup' | 'applied' | 'skipped', state: Pick<GraphRunState, 'graphId' | 'runId'> & { nodeId: string }, decisionId?: string, outcome?: string, reason?: string): void {
  debug.log('graph.approval-card', event, { graphId: state.graphId, runId: state.runId, nodeId: state.nodeId, decisionId, outcome, ...(reason ? { reason } : {}) });
}

export function raiseApprovalCard(state: GraphRunState, pending: Pending, deps: GraphApprovalCardDeps = {}): DecisionEntry | undefined {
  const root = deps.root ?? effectiveInstanceRoot();
  const nodeId = pending.nodeId;
  const identity = { graphId: state.graphId, runId: state.runId, nodeId };
  const visit = state.path.filter(node => node === nodeId).length;
  if (state.dryRun || state.status !== 'awaiting-approval' || state.pending?.nodeId !== nodeId ||
      state.pending.decision || state.path.at(-1) !== nodeId || visit < 1 ||
      existsSync(`${join(root, 'graph-runs', state.graphId, `${state.runId}.json`)}.${state.path.length}.decision.json`)) {
    observation('skipped', identity);
    return undefined;
  }
  const ref = `graph-approval:${state.graphId}:${state.runId}:${nodeId}:${visit}`;
  const ledger = ledgerFor(deps, root);
  const existing = ledger.list({ status: 'all' }).find(entry => entry.refs?.includes(ref));
  if (existing) {
    observation('dedup', identity, existing.id, existing.choice);
    return existing;
  }
  const publish = state.graphId === 'release-loop' && nodeId === 'approve-publish';
  const firstLine = pending.message.split(/\r?\n/, 1)[0]?.trim();
  const version = state.input && typeof state.input === 'object' && 'version' in state.input && typeof state.input.version === 'string'
    ? state.input.version : state.runId;
  const title = publish && firstLine ? firstLine : `${state.graphId} ${version} — ${nodeId} 승인`;
  const entry = ledger.raise({ title, category: publish ? 'publish' : 'scope',
    scqa: { s: `${state.graphId} / ${state.runId} 런이 ${nodeId} 승인에서 대기 중이다.`, c: pending.message.slice(0, 220) || '승인 대기 중이다.' },
    options: [{ key: 'a', label: '승인', consequence: `${nodeId} 승인 후 런을 계속할 수 있다` },
      { key: 'b', label: '거절', consequence: `${nodeId} 거절로 기록한다` }],
    recommendation: { skipped: true, reason: '사람 판단' }, raisedBy: { agent: 'graph-runner' }, refs: [ref] });
  observation('raised', identity, entry.id);
  return entry;
}

/** A card answer only claims the same pending visit; runner owns the atomic decision file. */
export function applyDecidedApprovals(deps: GraphApprovalCardDeps = {}): number {
  const root = deps.root ?? effectiveInstanceRoot();
  let applied = 0;
  for (const entry of ledgerFor(deps, root).list({ status: 'decided' })) {
    for (const ref of entry.refs ?? []) {
      const match = REF.exec(ref);
      if (!match) continue;
      const [, graphId, runId, nodeId, rawVisit] = match;
      const identity = { graphId: graphId!, runId: runId!, nodeId: nodeId! };
      // One unreadable run must not block every later card (L11 review round 1 should-fix).
      try { if (applyOne(entry, identity, Number(rawVisit), root)) applied++; }
      catch (error) {
        observation('skipped', identity, entry.id, entry.choice, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return applied;
}

function applyOne(entry: DecisionEntry, identity: { graphId: string; runId: string; nodeId: string }, visit: number, root: string): boolean {
  const { graphId, runId, nodeId } = identity;
  // Graph approvals gate irreversible steps (publish) — only a person's answer approves or rejects, never a delegated auto decision.
  if ((entry.choice !== 'a' && entry.choice !== 'b') || entry.decidedBy?.kind !== 'human' || !Number.isSafeInteger(visit)) {
    observation('skipped', identity, entry.id, entry.choice);
    return false;
  }
  const statePath = join(root, 'graph-runs', graphId, `${runId}.json`);
  let state: GraphRunState;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    observation('skipped', identity, entry.id, entry.choice);
    return false;
  }
  if (state.graphId !== graphId || state.runId !== runId || state.dryRun || state.status !== 'awaiting-approval' ||
      !state.pending || state.pending.nodeId !== nodeId || state.pending.decision || state.path.at(-1) !== nodeId ||
      state.path.filter(node => node === nodeId).length !== visit ||
      existsSync(`${statePath}.${state.path.length}.decision.json`)) {
    observation('skipped', identity, entry.id, entry.choice);
    return false;
  }
  const outcome = entry.choice === 'a' ? 'approved' : 'rejected';
  try { decideGraphApproval(graphId, runId, outcome, `owner:${entry.decidedBy.kind}`, root,
    { nodeId, visit: visit }); }
  catch (error) {
    // A CLI approver (or another notifier) may win the atomic hard-link claim.
    // A resumed run may also have left this visit before the writer reads it.
    const current = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    if (!existsSync(`${statePath}.${state.path.length}.decision.json`) &&
        current.status === 'awaiting-approval' && current.pending?.nodeId === nodeId && !current.pending.decision &&
        current.path.at(-1) === nodeId && current.path.filter(node => node === nodeId).length === visit) throw error;
    observation('skipped', identity, entry.id, outcome);
    return false;
  }
  observation('applied', identity, entry.id, outcome);
  return true;
}
