import type { GraphRunState } from '../../src/graph-runner/runner.js';
import { publicWaiverReason } from './known-issues-node.js';

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
