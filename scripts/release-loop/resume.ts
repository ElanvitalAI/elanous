import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { publicWaiverReason } from './known-issues-node.js';
import { checkGateExecutorChoice, type GateExecutor } from './gate-executor.js';

export interface AcceptedRegression { id: string; note: string }

/** Merge explicit public issues with the saved release input without changing the ledger shape. */
export function releaseResumeAcceptedRegressions(state: GraphRunState, additions: AcceptedRegression[], from?: string): AcceptedRegression[] {
  if (!Array.isArray(additions) || additions.some((issue) => !issue || typeof issue.id !== 'string' || !issue.id.trim() || typeof issue.note !== 'string' || !issue.note.trim())) {
    throw new Error('acceptedRegressions must be an array of {id, note}');
  }
  const input = state.input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { version?: unknown }).version !== 'string') throw new Error('release run has no input');
  const existing = (input as { acceptedRegressions?: unknown }).acceptedRegressions;
  if (existing !== undefined && (!Array.isArray(existing) || existing.some((issue) => !issue || typeof issue.id !== 'string' || !issue.id.trim() || typeof issue.note !== 'string' || !issue.note.trim()))) {
    throw new Error('saved acceptedRegressions is invalid');
  }
  // A rerun of a formerly waived node supersedes only that node's recorded waiver;
  // independently supplied accepted issues (including similarly named IDs) are not inferred to be waivers.
  const prior = (existing ?? []) as AcceptedRegression[];
  // Every waived record at or after the restart boundary is cut from the ledger, so each one's issue retires too.
  const start = from === undefined ? -1 : state.path.indexOf(from);
  const retired = start < 0 ? [] : state.nodes.slice(start)
    .filter((record) => record.waiver && record.executed === false && record.ok === true)
    .map((record) => ({ id: `waive:${record.nodeId}`, note: record.waiver!.reason }));
  const combined = [...prior.filter((issue) => !retired.some((gone) => gone.id === issue.id && gone.note === issue.note)), ...additions];
  if (new Set(combined.map(({ id }) => id)).size !== combined.length) throw new Error('acceptedRegressions IDs must be unique');
  return combined;
}

/** Only the recorded failure at the restart boundary may be waived. `--from` is never a waiver. */
export function releaseResumeWaiver(
  state: GraphRunState,
  opts: { from: string; waive?: string; reason?: string; acceptedRegressions?: AcceptedRegression[] },
): { nodeId: string; reason: string; acceptedRegressions: AcceptedRegression[] } | undefined {
  if ((opts.waive === undefined) !== (opts.reason === undefined)) throw new Error('--waive <node> and --reason <text> must be supplied together');
  if (opts.waive !== undefined && !opts.waive.trim()) throw new Error('--waive must not be empty');
  if (opts.waive === undefined) return undefined;
  const reason = opts.reason?.trim();
  if (!reason) throw new Error('--reason must not be empty');
  publicWaiverReason(reason);
  if (opts.from !== opts.waive) throw new Error('--from must name the waived node; --from alone does not waive a failure');
  const index = state.path.indexOf(opts.waive);
  if (index < 0 || state.path.lastIndexOf(opts.waive) !== index || state.nodes[index]?.nodeId !== opts.waive || state.nodes[index]?.ok !== false ||
    state.nodes[index]?.executed !== true || state.path.at(-2) !== opts.waive || state.path.at(-1) !== 'failed' || state.nodes.at(-1)?.nodeId !== 'failed') {
    throw new Error(`--waive ${opts.waive} requires the failed executable node on the saved path`);
  }
  // Only user-visible, non-publication checks can become accepted regressions; build, safety and approval gates stay blocking.
  if (!['mac-smoke', 'tui'].includes(opts.waive)) {
    throw new Error(`--waive ${opts.waive} cannot waive a safety, side-effect or approval node`);
  }
  return { nodeId: opts.waive, reason, acceptedRegressions: releaseResumeAcceptedRegressions(state,
    [...(opts.acceptedRegressions ?? []), { id: `waive:${opts.waive}`, note: reason }]) };
}

/** GATE-HOST-EXECUTOR — one explicit executor switch, recorded on the run (`GraphRunState.inputOverrides`). */
export interface GateExecutorOverride {
  kind: 'gate-executor';
  at: string;
  from: string;
  set: { gateExecutor: GateExecutor; gateRemote?: string };
  /** Input keys removed — switching back to pod drops the host an earlier override added (the original had none). */
  unset?: Array<'gateRemote'>;
  previous: { gateExecutor: unknown; gateRemote: unknown };
}

/**
 * Switch the gate executor of a resumed release run. Not a waiver: the gate node runs again (the restart must be at or
 * before gate) and produces a normal verdict; only where its sweep runs changes.
 */
export function releaseResumeGateExecutor(state: GraphRunState, opts: { from: string; executor: unknown; host?: unknown; at?: string }): GateExecutorOverride {
  const input = state.input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { version?: unknown }).version !== 'string') throw new Error('release run has no input');
  const saved = input as { gateExecutor?: unknown; gateRemote?: unknown; gatePodPool?: unknown };
  // Host executor without --gate-host: the run's own gateRemote (release.loop.gateRemote when it started), like `release run`.
  const choice = checkGateExecutorChoice(opts.executor, opts.executor === 'host' && opts.host === undefined ? saved.gateRemote : opts.host);
  if (choice.executor === 'pod' && (typeof saved.gatePodPool !== 'string' || !saved.gatePodPool.trim())) {
    throw new Error('--gate-executor pod requires the saved run input gatePodPool');
  }
  const start = state.path.indexOf(opts.from);
  if (start < 0) throw new Error(`--from ${opts.from} is not a node on the saved path`);
  const gate = state.path.indexOf('gate');
  // A restart after gate keeps the recorded verdict — switching its executor there would record a choice nothing used.
  if (gate >= 0 && start > gate) throw new Error('--gate-executor needs a resume that re-runs gate (--from gate or earlier)');
  // Back to pod: restore the gateRemote the run started with (an earlier host override replaced it).
  const firstHost = choice.executor === 'pod' ? state.inputOverrides?.find((item) => item.kind === 'gate-executor' && item.set.gateRemote !== undefined) : undefined;
  const restored = firstHost ? firstHost.previous.gateRemote : undefined;
  return {
    kind: 'gate-executor', at: opts.at ?? new Date().toISOString(), from: opts.from,
    set: { gateExecutor: choice.executor, ...(choice.host ? { gateRemote: choice.host } : typeof restored === 'string' ? { gateRemote: restored } : {}) },
    ...(firstHost && typeof restored !== 'string' ? { unset: ['gateRemote' as const] } : {}),
    previous: { gateExecutor: saved.gateExecutor ?? null, gateRemote: saved.gateRemote ?? null },
  };
}
