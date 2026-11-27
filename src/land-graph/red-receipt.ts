/**
 * LAND-STEWARD body cases — what the stopgap queue runner (seat-state/OP/tools/land-queue-runner-1127.sh → coach-land.sh)
 * landed by hand on 11-27 because the land graph refused or never saw them:
 *
 *   RED-RECEIPT        pregate writes a RED run to RES/evidence/PREGATE-RED/<PR>-<head12>-<host>/ — the graph read only
 *                      PREGATE-GREEN, so a RED whose only red steps are focused (+ its baseline) looked like «no receipt» and
 *                      the finisher re-ran pregate forever. Now: focused-only RED = a receipt with failing focused, landable by
 *                      the existing rule (baseline name diff introduced 0 · pregate focusedBaseline new 0) — e.g. #39891.
 *                      Any other red step (ratchets · merge-main · interference · diff-check · leak · no steps) = `pregate-red`.
 *   TSC-TIMEOUT        `changed-tsc` exit 124 on an overloaded host is «unmeasured», not a type error — the graph re-runs
 *                      pregate once on another host (`pregate-retry`); a second timeout goes to RES.
 *                      Land-time tsc preflight «unmeasured» (enqueue-tsc-preflight rc 2 → v2 STOP tsc-preflight rc=2) is the
 *                      same class: retried next tick on the next host (LAND_TSC_HOSTS rotation), twice at most.
 *   GUARD-ERROR        the stale-base-revert guard threw — `git merge-tree --write-tree` exits 1 on a conflict (→ merge-conflict ·
 *                      the finisher refreshes the branch) · a fetch / ref-lock / object error is transient (→ gh-error). 9 of 11
 *                      «stale-base-revert» refusals on 11-26 were this, and they stuck to the head.
 *   NEXT-ACTION        every non-land decision names who acts next (the graph itself via the finisher, or a seat) — the steward's
 *                      KPI «refusals without a next action = 0».
 */
import type { PrInfo, Receipt, RefusalClass } from './land-graph.js';
import { filterRoutable, hostsFor, resourceFacts, type ResourceFacts } from '../kit/resource-facts/index.js';

/** Steps of a focused failure and its own same-host baseline run. */
export const FOCUSED_STEPS = new Set(['focused', 'baseline-install', 'baseline-focused']);
export const TSC_STEP = 'changed-tsc';
export const TIMEOUT_EXIT = 124;

export type RedKind = 'focused-only' | 'tsc-timeout' | 'other';
export interface RedVerdict { kind: RedKind; tscTimeout: boolean; focusedRed: boolean; other: string[] }

/** RED receipt → which red it is. Fail closed: a RED with no failed step recorded is `other`. */
export function redVerdict(r: Pick<Receipt, 'red'>): RedVerdict | null {
  if (!r.red) return null;
  const failed = r.red.failed;
  const tscTimeout = failed.some(s => s.name === TSC_STEP && s.exit === TIMEOUT_EXIT);
  const focusedRed = failed.some(s => FOCUSED_STEPS.has(s.name));
  const other = failed.filter(s => !FOCUSED_STEPS.has(s.name) && !(s.name === TSC_STEP && s.exit === TIMEOUT_EXIT)).map(s => `${s.name}=${s.exit}`);
  if (!failed.length) other.push(`no failed step recorded${r.red.failure ? ` (${r.red.failure})` : ''}`);
  const kind: RedKind = other.length ? 'other' : tscTimeout ? 'tsc-timeout' : 'focused-only';
  return { kind, tscTimeout, focusedRed, other };
}

/** Stale-base-revert guard error text → refusal class (null = a real stale-base revert). */
export function guardErrorClass(why: string): RefusalClass | null {
  if (!/^(guard error|fetch failed)/.test(why)) return null;
  // merge-tree exits 1 on conflicts with an empty stderr («… failed:» and nothing after) — a real conflict with main.
  if (/merge-tree --write-tree \S+ \S+ failed:\s*$/.test(why)) return 'merge-conflict';
  return 'gh-error';
}

/** Legacy ledger rows (before GUARD-ERROR) that stuck a guard error to a head as «stale-base-revert». */
export const legacyGuardError = (cls: RefusalClass | undefined, why: string | undefined): boolean =>
  cls === 'stale-base-revert' && /^(gate refused this head: )?(guard error|fetch failed)/.test(why ?? '');

/** Land command output → «tsc preflight unmeasured» (enqueue-tsc-preflight rc 2 = timeout / ssh / no result line). */
export const tscUnmeasured = (text: string): boolean => /STOP tsc-preflight rc=2\b/.test(text);

/** Default host rotation for re-runs — the registry's retryHosts (resource facts) minus any host it rules out for tsc;
 *  when every listed host is out, the registry's tsc hosts (RESOURCE-FACTS-FROM-LEDGER · no fixed list). */
export function defaultRetryHosts(facts: ResourceFacts = resourceFacts()): string[] {
  const listed = filterRoutable(facts.retryHosts, 'tsc', facts);
  return listed.length ? listed : hostsFor('tsc', { facts });
}

/** The next host after `avoid` in the rotation (never `avoid` itself unless it is the only one). '' = no routable host
 *  (every tsc host is unhealthy / reserved / off in the registry) — the caller must not retry onto a blocked host. */
export function nextHost(avoid: string | undefined, hosts: readonly string[] = defaultRetryHosts(), skip = 0): string {
  const pool = hosts.filter(h => h !== avoid);
  const list = pool.length ? pool : [...hosts];
  return list.length ? list[skip % list.length]! : '';
}

/** LAND_TSC_HOSTS for the n-th land attempt of a head (n = earlier tsc-unmeasured refusals): rotate the list. */
export function tscHostsFor(attempt: number, hosts: readonly string[] = defaultRetryHosts()): string {
  if (!hosts.length) return hostsFor('tsc')[0] ?? '';
  const k = attempt % hosts.length;
  return [...hosts.slice(k), ...hosts.slice(0, k)].join(' ');
}
/** Land-time tsc unmeasured retries per head before it becomes a RES card. */
export const TSC_LAND_RETRIES = 2;

export interface NextAction { owner: string; action: string }
/** Who acts next on a non-land decision. `finisher` = the graph does it itself this / next tick. */
export function nextAction(cls: RefusalClass | undefined, pr: Pick<PrInfo, 'author'>, o: { finisher?: string | null; landingOwner: string; fixTo?: 'author' | 'JUD' | 'RES' | 'OP' }): NextAction | null {
  if (!cls) return null;
  if (o.finisher) return { owner: 'land-graph', action: `finisher ${o.finisher}` };
  switch (cls) {
    case 'main-moved-overlap': case 'gh-error': case 'head-moved': return { owner: 'land-graph', action: 'retry next tick' };
    case 'held': return { owner: 'JUD', action: 'lift or keep the veto' };
    case 'no-receipt': case 'stale-head': return { owner: 'land-graph', action: 'finisher pregate (needs the finisher dep)' };
    default: break;
  }
  const to = o.fixTo ?? 'author';
  return { owner: to === 'author' ? pr.author : to === 'OP' ? o.landingOwner : to, action: cls };
}
