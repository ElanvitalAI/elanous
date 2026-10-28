import { readFileSync } from 'node:fs';
import { lastJsonObject, STOPPED_NODE_ERROR, type GraphRunState } from '../../src/graph-runner/runner.js';
import { publicWaiverReason } from './known-issues-node.js';
import { checkGateExecutorChoice, type GateExecutor } from './gate-executor.js';

export interface AcceptedRegression { id: string; note: string }

/** Match the graph runner's approval boundary before release resume performs tip refresh or writes an attempt. */
export function assertReleaseResumeApprovalBoundary(state: GraphRunState, from: string): void {
  if (!Array.isArray(state.path)) return;
  const start = state.path.indexOf(from);
  if (start < 0 || state.path.lastIndexOf(from) !== start) {
    return;
  }
  for (let index = 0; index < state.nodes.length; index++) {
    const record = state.nodes[index]!;
    if (typeof record.decidedAt !== 'string') continue;
    if (index >= start) throw new Error('cannot restart across an approval decision — start a new release run with the full gate');
    if (!record.ok) throw new Error('cannot preserve a failed predecessor when resuming');
    let decision: { nodeId?: unknown; decision?: unknown; decidedAt?: unknown };
    try { decision = JSON.parse(readFileSync(`${state.statePath}.${index + 1}.decision.json`, 'utf8')); }
    catch { throw new Error(`missing approval decision for ${record.nodeId}`); }
    if (decision.nodeId !== record.nodeId || decision.decision !== 'approved' || decision.decidedAt !== record.decidedAt) {
      throw new Error(`invalid approval decision for ${record.nodeId}`);
    }
  }
}

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

const SWEEP_INCOMPLETE = /^(?:pod sweep incomplete|sweep incomplete|[\w-]+ shard incomplete)\b/;

/**
 * RELEASE-WAIVE-UNMEASURED — why the saved gate record at `index` carries no verdict, or undefined when it does (or may).
 * Fail-closed: only three shapes count, each read from what the runner and gate-node actually write:
 *  ① stopped — `graph runs stop` wrote {ok:false, executed:false, exit:null, error:STOPPED_NODE_ERROR} as the run's last record;
 *  ② no verdict — the gate process ended with exit null (signal, idle timeout, or a spawn that failed) and printed no result line at
 *     all (no output line is a JSON object with an `outcome`), so the run went gate → failed (possibly through the
 *     release-only gate-triage shadow). A verdict followed by more
 *     log lines and then a kill is still a verdict: refused;
 *  ③ sweep incomplete — gate-node printed outcome `error` (no verdict: the baseline comparison never ran, so `introduced`
 *     is still the empty initial list) and the error is an incomplete sweep (stalled shards / no tests ran). The finished
 *     shards' counts go into the detail. Any other error (cleanup, baseline persistence, …) may follow a verdict: refused.
 * An `outcome: fail` (introduced > 0), an introduced list that is not empty, or an already-waived record is never unmeasured.
 */
/** Any output line that is a JSON object naming an `outcome` — a verdict was printed, whatever came after it. */
function printedVerdict(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  return output.split('\n').some((line) => {
    const text = line.trim();
    if (!text.startsWith('{')) return false;
    try { const value = JSON.parse(text) as unknown; return !!value && typeof value === 'object' && 'outcome' in value; } catch { return false; }
  });
}

/** A failed release may execute its warning-only traffic restore before the terminal failure. */
function failedAfterTrafficRestore(state: GraphRunState, index: number): boolean {
  if (state.nodes.length !== state.path.length || state.path.at(-1) !== 'failed' || state.nodes.at(-1)?.nodeId !== 'failed') return false;
  if (index === state.path.length - 2) return true;
  return index === state.path.length - 3 && state.path[index + 1] === 'traffic-failed-restore'
    && state.nodes[index + 1]?.nodeId === 'traffic-failed-restore' && state.nodes[index + 1]?.executed === true;
}

/** Gate may also pass through its executed triage shadow before the traffic restore. */
function failedAfterGate(state: GraphRunState, index: number): boolean {
  if (failedAfterTrafficRestore(state, index)) return true;
  return state.path[index + 1] === 'gate-triage'
    && state.nodes[index + 1]?.nodeId === 'gate-triage' && state.nodes[index + 1]?.executed === true
    && failedAfterTrafficRestore(state, index + 1);
}

export function gateUnmeasuredDetail(state: GraphRunState, index: number): string | undefined {
  const record = state.nodes[index];
  if (!record || record.nodeId !== 'gate' || state.path[index] !== 'gate' || record.ok !== false || record.waiver !== undefined) return undefined;
  if (state.nodes.some((saved) => saved.nodeId === 'gate' && saved !== record)) return undefined;
  const last = index === state.path.length - 1 && index === state.nodes.length - 1;
  if (last && record.executed === false && record.exit === null && record.error === STOPPED_NODE_ERROR && record.output === undefined) {
    return `stopped: ${STOPPED_NODE_ERROR}${typeof record.seconds === 'number' ? ` after ${record.seconds}s` : ''}`;
  }
  if (!failedAfterGate(state, index) || record.executed !== true) return undefined;
  const result = lastJsonObject(record.output);
  if (result === undefined) {
    if (record.exit !== null || printedVerdict(record.output)) return undefined;
    return `no-verdict: gate process ended with exit null and no result line${record.error ? ` — ${record.error.split('\n')[0]!.slice(0, 120)}` : ''}`;
  }
  if (result.outcome !== 'error' || !Array.isArray(result.introduced) || result.introduced.length !== 0) return undefined;
  const error = typeof result.error === 'string' ? result.error : '';
  if (!SWEEP_INCOMPLETE.test(error)) return undefined;
  // The detail keeps what WAS measured: each stalled shard's reason and the finished shards' counts (failures there are
  // not yet split into introduced vs pre-existing — the baseline comparison never ran).
  const stalled = Array.isArray(result.stalledShards) ? result.stalledShards as Array<{ reason?: unknown }> : [];
  const reasons = new Map<string, number>();
  for (const shard of stalled) reasons.set(String(shard?.reason ?? 'unknown'), (reasons.get(String(shard?.reason ?? 'unknown')) ?? 0) + 1);
  const summary = result.partialSummary as { pass?: unknown; fail?: unknown; errors?: unknown; ran?: unknown } | undefined;
  const measured = summary && typeof summary === 'object'
    ? ` · finished shards measured pass ${String(summary.pass)} fail ${String(summary.fail)} errors ${String(summary.errors)} ran ${String(summary.ran)}` : '';
  return `sweep incomplete: ${error.split('\n')[0]!.slice(0, 200)}`
    + (stalled.length ? ` · stalled shards ${stalled.length} (${[...reasons].map(([reason, count]) => `${reason}×${count}`).join(', ')})` : '') + measured;
}

/** Only the recorded failure at the restart boundary may be waived. `--from` is never a waiver. */
export function releaseResumeWaiver(
  state: GraphRunState,
  opts: { from: string; waive?: string; reason?: string; acceptedRegressions?: AcceptedRegression[] },
): { nodeId: string; reason: string; acceptedRegressions: AcceptedRegression[]; unmeasured?: string } | undefined {
  if ((opts.waive === undefined) !== (opts.reason === undefined)) throw new Error('--waive <node> and --reason <text> must be supplied together');
  if (opts.waive !== undefined && !opts.waive.trim()) throw new Error('--waive must not be empty');
  if (opts.waive === undefined) return undefined;
  const reason = opts.reason?.trim();
  if (!reason) throw new Error('--reason must not be empty');
  publicWaiverReason(reason);
  if (opts.from !== opts.waive) throw new Error('--from must name the waived node; --from alone does not waive a failure');
  const index = state.path.indexOf(opts.waive);
  const unique = index >= 0 && state.path.lastIndexOf(opts.waive) === index;
  // RELEASE-WAIVE-UNMEASURED (OP 10-12): a gate cut before any verdict is the only gate that may be waived — a measured gate
  // failure or an already-waived gate stays refused (fail-closed below), and the ledger records why it was unmeasured.
  const unmeasured = opts.waive === 'gate' && unique ? gateUnmeasuredDetail(state, index) : undefined;
  if (unmeasured !== undefined) {
    return { nodeId: opts.waive, reason, unmeasured, acceptedRegressions: releaseResumeAcceptedRegressions(state,
      [...(opts.acceptedRegressions ?? []), { id: `waive:${opts.waive}`, note: reason }]) };
  }
  if (!unique || state.path.lastIndexOf(opts.waive) !== index || state.nodes[index]?.nodeId !== opts.waive || state.nodes[index]?.ok !== false ||
    state.nodes[index]?.executed !== true || (opts.waive === 'gate' ? !failedAfterGate(state, index)
      : !failedAfterTrafficRestore(state, index))) {
    throw new Error(`--waive ${opts.waive} requires the failed executable node on the saved path`);
  }
  // Only user-visible, non-publication checks can become accepted regressions; build, safety and approval gates stay blocking.
  // A measured gate failure (outcome fail / introduced > 0, or any error that is not an incomplete sweep) lands here too.
  if (!['mac-smoke', 'tui'].includes(opts.waive)) {
    throw new Error(`--waive ${opts.waive} cannot waive a safety, side-effect or approval node`
      + (opts.waive === 'gate' ? ' (only an unmeasured gate — stopped, killed or sweep incomplete — may be waived)' : ''));
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

/** RESUME-GATE-POOL-OVERRIDE — replace the saved pool for a gate that will be re-run. */
export interface GatePodPoolOverride {
  kind: 'gate-pod-pool';
  at: string;
  from: string;
  set: { gatePodPool: string };
  previous: { gatePodPool: unknown };
}

/** One shard keeps its component identity while the run-time scheduler chooses a compatible member. */
export interface GateShardRerouteOverride {
  kind: 'gate-shard-reroute'; at: string; from: string;
  set: { gateRerouteShard: string; gateShardHost?: string; gateShardCapabilities?: Record<string, { os: 'darwin' | 'linux' }> };
  previous: { gateRerouteShard: unknown; gateShardHost: unknown; gateShardCapabilities: unknown };
}

export function releaseResumeGateShardReroute(state: GraphRunState, opts: {
  from: string; shard: unknown; host?: unknown; os?: unknown; at?: string;
}): GateShardRerouteOverride {
  const input = state.input as Record<string, unknown> | undefined;
  if (!input || typeof input.gatePodPool !== 'string' || !input.gatePodPool.trim())
    throw new Error('shard reroute requires the saved Pod gate pool');
  if (opts.from !== 'gate' || !state.path.includes('gate')) throw new Error('shard reroute requires --from gate');
  if (typeof opts.shard !== 'string' || !/^(?:auto|pod-\d+)$/.test(opts.shard))
    throw new Error('--reroute-shard requires auto or pod-N');
  if (opts.host !== undefined && (typeof opts.host !== 'string' || !opts.host.trim())) throw new Error('--shard-host requires a pool context');
  if (opts.os !== undefined && (opts.shard === 'auto' || opts.os !== 'darwin' && opts.os !== 'linux'))
    throw new Error('--shard-os requires pod-N and darwin or linux');
  return { kind: 'gate-shard-reroute', at: opts.at ?? new Date().toISOString(), from: opts.from,
    set: { gateRerouteShard: opts.shard, ...(opts.host ? { gateShardHost: opts.host.trim() } : {}),
      ...(opts.os ? { gateShardCapabilities: { [opts.shard]: { os: opts.os } } } : {}) },
    previous: { gateRerouteShard: input.gateRerouteShard ?? null, gateShardHost: input.gateShardHost ?? null,
      gateShardCapabilities: input.gateShardCapabilities ?? null } };
}

export function releaseResumeGatePodPool(state: GraphRunState, opts: { from: string; pool: unknown; at?: string }): GatePodPoolOverride {
  const input = state.input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { version?: unknown }).version !== 'string') throw new Error('release run has no input');
  if (typeof opts.pool !== 'string' || !opts.pool.trim()) throw new Error('--gate-pod-pool must not be empty');
  const start = state.path.indexOf(opts.from);
  if (start < 0) throw new Error(`--from ${opts.from} is not a node on the saved path`);
  const gate = state.path.indexOf('gate');
  if (gate >= 0 && start > gate) throw new Error('--gate-pod-pool needs a resume that re-runs gate (--from gate or earlier)');
  const saved = input as { gatePodPool?: unknown };
  return { kind: 'gate-pod-pool', at: opts.at ?? new Date().toISOString(), from: opts.from,
    set: { gatePodPool: opts.pool.trim() }, previous: { gatePodPool: saved.gatePodPool ?? null } };
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
  const firstHost = choice.executor === 'pod' ? state.inputOverrides?.find((item): item is GateExecutorOverride =>
    item.kind === 'gate-executor' && item.set.gateRemote !== undefined) : undefined;
  const restored = firstHost ? firstHost.previous.gateRemote : undefined;
  return {
    kind: 'gate-executor', at: opts.at ?? new Date().toISOString(), from: opts.from,
    set: { gateExecutor: choice.executor, ...(choice.host ? { gateRemote: choice.host } : typeof restored === 'string' ? { gateRemote: restored } : {}) },
    ...(firstHost && typeof restored !== 'string' ? { unset: ['gateRemote' as const] } : {}),
    previous: { gateExecutor: saved.gateExecutor ?? null, gateRemote: saved.gateRemote ?? null },
  };
}
