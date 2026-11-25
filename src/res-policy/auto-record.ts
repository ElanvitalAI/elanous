// GUARDIAN-FINDINGS-VISIBLE ① — automatic shadow pairs at the real decision points (대표 11-25 18:5x).
//
// Situation: the shadow comparison needs «guardian would» ⊕ «what was actually decided» pairs, but the only writer was a
// manual `eln res shadow record` — the RES tab recorded nothing (paired 0, samples 0/30) on the eve of the dormant flip.
// Now every place that actually decides (pregate.py slot admission · `eln hosts start` · cloud VM adapters used by the
// burst and the rehearsal) writes the pair itself, no human step.
//
// 세 얼굴: 관측 = `res.shadow agree|disagree {actor}` ⊕ paired rows in the resource ledger (`eln res shadow-report`) /
// 판단 근거 = the same ResPolicy the patrol reads, fed with live context (heartbeats · pregate inflight · patrol idleSince) /
// 수복과 인계 = recording never blocks or fails the decision it observes — on any error the decision stands and a
// `res.shadow record-failed` warn line is the trace.
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { readResourceLedger, recordResDecision, resourceLedgerPath, type ResDecisionRow } from '../resource-ledger/resource-ledger.js';
import { getUserConfig } from '../user-config/reader.js';
import { localPressure, type PatrolHost } from './patrol.js';
import { decideResAction, resolveResPolicy, type ResAction, type ResDecision, type ResPolicy, type ResVerdict } from './policy.js';

export type ShadowActionKind = ResAction['kind'];

/** What the guardian needs to judge an action the way the patrol would (all fields live-read by default). */
export interface ShadowContext {
  readonly policy: ResPolicy;
  readonly hosts: readonly PatrolHost[];
  readonly inflight: Readonly<Record<string, number>>;
  /** Cloud host → when the patrol first saw it idle (patrol state). */
  readonly idleSince: Readonly<Record<string, string>>;
  readonly spentTodayUsd: number;
  readonly now: Date;
}

export interface ShadowActionOverrides {
  readonly universe?: 'test' | 'ops';
  readonly inflight?: number;
  readonly idleMinutes?: number;
  readonly pressure?: boolean;
  readonly spentTodayUsd?: number;
}

/** Build the ResAction from live context; explicit overrides win (the CLI flags). */
export function contextAction(kind: ShadowActionKind, host: string, ctx: ShadowContext, overrides: ShadowActionOverrides = {}): ResAction {
  if (kind === 'test') return { kind, host, universe: overrides.universe ?? 'test' };
  if (kind === 'pregate') return { kind, host, inflight: overrides.inflight ?? ctx.inflight[host] ?? 0, inflightByHost: ctx.inflight };
  if (kind === 'vm-start') return { kind, host, pressure: overrides.pressure ?? localPressure(ctx.policy, ctx.hosts, ctx.inflight),
    spentTodayUsd: overrides.spentTodayUsd ?? ctx.spentTodayUsd };
  if (kind === 'vm-stop') {
    const since = ctx.idleSince[host];
    // Not seen idle by the patrol = 0 minutes: the guardian would not have stopped it — an honest disagreement.
    const observed = since ? Math.max(0, Math.floor((ctx.now.getTime() - Date.parse(since)) / 60_000)) : 0;
    return { kind, host, idleMinutes: overrides.idleMinutes ?? observed };
  }
  return { kind, host };
}

export interface ShadowPairInput {
  readonly action: ResAction;
  readonly actual: ResVerdict;
  /** Who took the actual decision (pregate.py · hosts-cli · fleet.cloud-burst · release.rehearsal · res-tab). */
  readonly actor: string;
  readonly ref?: string;
}

export interface ShadowPairResult { readonly pairId: string; readonly guardian: ResDecision; readonly actual: ResVerdict; readonly agree: boolean }

/** Write guardian «would» ⊕ actual with one pairId. Throws on ledger failure (callers that must not fail use autoRecord). */
export function writeShadowPair(input: ShadowPairInput, policy: ResPolicy, opts: { now?: Date; record?: (row: ResDecisionRow, at: Date) => void } = {}): ShadowPairResult {
  const now = opts.now ?? new Date();
  const record = opts.record ?? ((row: ResDecisionRow, at: Date) => recordResDecision(row, at));
  const guardian = decideResAction(policy, input.action);
  const pairId = randomUUID();
  const ref = input.ref?.trim() || undefined;
  const actor = input.actor.trim() || 'res-tab';
  record({ source: 'guardian', action: input.action.kind, host: input.action.host, decision: guardian.verdict, rule: guardian.rule,
    policyVersion: policy.version, pairId, ...(ref ? { ref } : {}) }, now);
  record({ source: 'res-tab', action: input.action.kind, host: input.action.host, decision: input.actual, rule: actor === 'res-tab' ? 'res-tab' : `actual:${actor}`,
    policyVersion: policy.version, pairId, ...(ref ? { ref } : {}), ...(actor !== 'res-tab' ? { actor } : {}) }, now);
  const agree = guardian.verdict === input.actual;
  debug.log('res.shadow', agree ? 'agree' : 'disagree', { pairId, actor, action: input.action.kind, host: input.action.host,
    guardian: guardian.verdict, actual: input.actual, rule: guardian.rule, ...(ref ? { ref } : {}) }, { level: agree ? 'info' : 'warn' });
  return { pairId, guardian, actual: input.actual, agree };
}

/** Live context: policy from config, heartbeats from the resource ledger, RES inflight locks, patrol idleSince. */
export async function liveShadowContext(opts: { excludePid?: number; now?: Date } = {}): Promise<ShadowContext> {
  const now = opts.now ?? new Date();
  const { defaultPatrolRunDeps, heartbeatHosts, pregateInflightExcept, readPatrolState } = await import('./patrol-run.js');
  const deps = defaultPatrolRunDeps();
  let hosts: PatrolHost[] = [];
  try { hosts = heartbeatHosts(readResourceLedger(resourceLedgerPath()), now); } catch { hosts = []; }
  let inflight: Record<string, number> = {};
  try { inflight = pregateInflightExcept(deps.inflightDir(), deps.alive, opts.excludePid); } catch { inflight = {}; }
  const state = readPatrolState(deps.statePath());
  // Spend is not re-measured here (provider inventory is a network call); the patrol's last estimate, else 0.
  return { policy: resolveResPolicy(getUserConfig().res), hosts, inflight, idleSince: state.idleSince, spentTodayUsd: state.vmSpentTodayUsd ?? 0, now };
}

/** Fire-and-forget form for decision points: never throws, never delays the decision beyond the ledger append. */
export async function autoRecordDecision(kind: ShadowActionKind, host: string, actual: ResVerdict, actor: string,
  opts: { ref?: string; overrides?: ShadowActionOverrides; excludePid?: number } = {}): Promise<ShadowPairResult | null> {
  try {
    const ctx = await liveShadowContext({ ...(opts.excludePid !== undefined ? { excludePid: opts.excludePid } : {}) });
    return writeShadowPair({ action: contextAction(kind, host, ctx, opts.overrides), actual, actor, ...(opts.ref ? { ref: opts.ref } : {}) }, ctx.policy, { now: ctx.now });
  } catch (error) {
    debug.log('res.shadow', 'record-failed', { actor, action: kind, host, actual, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return null;
  }
}

/** Wrap a cloud VM adapter so every real start/stop also writes a shadow pair (actual = allow: the caller decided to act). */
export function shadowedCloudVm<A extends { start(host: H): Promise<void>; stop(host: H): Promise<void> }, H extends string>(adapter: A, actor: string,
  record: typeof autoRecordDecision = autoRecordDecision): A {
  return {
    ...adapter,
    start: async (host: H) => { await record('vm-start', host, 'allow', actor, { ref: `${actor}:start` }); return adapter.start(host); },
    stop: async (host: H) => { await record('vm-stop', host, 'allow', actor, { ref: `${actor}:stop` }); return adapter.stop(host); },
  };
}
