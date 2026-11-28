/**
 * Land finisher — the land graph owns the last mile of a PR (CEO 11-27 07:5x «정책 문제·구조 문제»).
 *
 * S: landing stays < 10/h while land ticks are fine (4–8 min · ceiling 15/h). Of 37 queued PRs < 5 were landable:
 *    no-receipt 13 · baseline-failing-focused 4 · stale-base/stack 7 · RED 6 — every one waits on a hand that does not come.
 * C: the last mile (receipt, fresh main, retarget) is mechanical; waiting for the author is the bottleneck.
 * A: the tick does it itself —
 *    LAND-OWNS-RECEIPT   eligible but no same-head receipt (none · stale head · old receipt without the A244 name diff)
 *                        → launch `pregate <PR> --light` (least-loaded host · pregate merges fresh main itself) ·
 *                        ≤ FINISH_CONCURRENCY running · one job per (PR, head) · PASS = landable next tick.
 *    REFRESH             merge-conflict / stale-base-revert refusal on a same-repo branch → merge origin/main into the
 *                        branch (clean only, never force) → new head → the line above. Conflict → «needs-finisher» card.
 *    STACK-AUTO-RETARGET base-not-main whose base PR already merged → `gh pr edit --base main`, then REBUILD.
 *    SMART-MERGE         REFRESH / REBUILD run src/git-smart/smart-refresh.ts: a squash-landed head inside the branch →
 *                        rebuild (only the PR's own commits onto main, published as a fast-forward merge commit · never
 *                        force) · else merge main · conflicts → rerere → structural → (hunks left) a detached LLM capsule
 *                        (`eln land smart-merge <pr> --llm`, state «resolving») → pregate decides · revert guard before
 *                        every push · what the ladder cannot resolve → «needs-finisher» card with the hunks.
 *    PREGATE-RETRY       a receipt whose only red is `changed-tsc` exit 124 (overloaded host) → `pregate <PR> --light --host <next>`
 *                        once per head, on a host other than the one that timed out (src/land-graph/red-receipt.ts nextHost).
 *                        Still no measured receipt → `tsc-timeout` card to RES.
 *    AUTOFIX             pregate RED whose every red step is mechanical (diff-check whitespace · NUMGUARD source comment ·
 *                        public-export identifier key) → one fix commit on the branch (src/land-graph/autofix.ts · plain push ·
 *                        only once the author is quiet ≥ 30 min) → new head → the pregate line above. A merge-main-only RED →
 *                        REFRESH. Semantic → no push, the author's pregate-red card (LAND10-AUTOFIX-LANE · KPI autofix/h).
 *    STALE-PR-24H        open > 24 h with the reason · `plan --reap --apply` closes only PRs whose whole diff is already
 *                        in main (merge-tree of head into main = main's tree).
 *
 * State: <stateRoot>/land-graph/finisher.json { jobs: { "<pr>@<head>": FinishJob } }.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrInfo, RefusalClass } from './land-graph.js';

/** Pregate steps whose red the autofix lane may read (src/land-graph/autofix.ts · anything else red = not mechanical). */
export const AUTOFIX_STEPS: ReadonlySet<string> = new Set(['diff-check', 'rules-and-ratchets', 'public-leak-check']);

export const FINISH_CONCURRENCY = 3;
/** A pregate light run is ≤ ~15 min; a job still «running» after this is dead/stuck and counts as failed. */
export const FINISH_JOB_MAX_MS = 75 * 60_000;
export const STALE_PR_MS = 24 * 3_600_000;

export type FinishKind = 'pregate' | 'refresh' | 'retarget' | 'pregate-retry' | 'rebuild' | 'autofix';
export type FinishState = 'running' | 'pass' | 'failed' | 'refreshed' | 'conflict' | 'retargeted' | 'resolving' | 'fixed';
export interface FinishJob {
  pr: number; head: string; kind: FinishKind; state: FinishState; at: string; pid?: number; log?: string; newHead?: string; why?: string;
  /** 'baseline' = the head already had a receipt without the A244 name diff: PASS needs a receipt that carries it. */
  need?: 'receipt' | 'baseline';
  /** pregate-retry: the host whose changed-tsc timed out (the retry runs elsewhere). */
  avoidHost?: string;
  /** refresh / rebuild run by the SMART-MERGE ladder (absent = an older plain-merge job). */
  smart?: boolean;
}
export interface FinishBook { jobs: Record<string, FinishJob> }

// SMART-MERGE-REFRESH-ALL (11-27 15:4x): refresh / rebuild jobs get their own key — before, a `pass` pregate job on the
// same head (`pr@head`) shadowed the refresh, so a PR refused for merge-conflict AFTER its green pregate never got one.
export const jobKey = (pr: number, head: string, kind?: FinishKind) =>
  `${pr}@${head}${kind === 'pregate-retry' ? '#retry' : kind === 'refresh' || kind === 'rebuild' ? '#refresh' : kind === 'autofix' ? '#autofix' : ''}`;
/** A refresh that ended in conflict is retried after this (main moved; the ladder may resolve it now). */
export const REFRESH_RETRY_MS = 60 * 60_000;
/** Refresh jobs written before SMART-MERGE (plain merge, gave up on any conflict) have no `smart` mark: retried once. */
const staleRefreshJob = (j: FinishJob, nowMs: number) => (j.kind === 'refresh' || j.kind === 'rebuild')
  && (j.state === 'conflict' || j.state === 'failed') && (!j.smart || nowMs - Date.parse(j.at) > REFRESH_RETRY_MS);
const bookPath = (stateRoot: string) => join(stateRoot, 'land-graph', 'finisher.json');

export function readBook(stateRoot: string): FinishBook {
  try { const j = JSON.parse(readFileSync(bookPath(stateRoot), 'utf8')) as FinishBook; return j && typeof j.jobs === 'object' ? j : { jobs: {} }; } catch { return { jobs: {} }; }
}
export function writeBook(stateRoot: string, b: FinishBook): void {
  mkdirSync(join(stateRoot, 'land-graph'), { recursive: true });
  // Keep the book small: finished jobs older than 7 days go.
  const cut = Date.now() - 7 * 86_400_000;
  for (const [k, j] of Object.entries(b.jobs)) if (j.state !== 'running' && Date.parse(j.at) < cut) delete b.jobs[k];
  writeFileSync(bookPath(stateRoot), JSON.stringify(b, null, 2));
}
export const bookExists = (stateRoot: string) => existsSync(bookPath(stateRoot));

/** Which finisher job a decision asks for (null = none: the hand or the gate owns it). */
export function finishKindFor(cls: RefusalClass | undefined, o: { noBaselineInReceipt?: boolean; crossRepo?: boolean; redSteps?: readonly string[]; autofix?: boolean }): FinishKind | null {
  if (cls === 'no-receipt' || cls === 'stale-head') return 'pregate';
  // LAND10-AUTOFIX-LANE: a pregate RED on mechanical steps only — merge-main → smart-merge refresh · ratchets → autofix.
  if (cls === 'pregate-red' && !o.crossRepo && o.redSteps?.length) {
    if (o.redSteps.every(s => s === 'merge-main')) return 'refresh';
    if (o.autofix && o.redSteps.every(s => AUTOFIX_STEPS.has(s))) return 'autofix';
  }
  if (cls === 'tsc-timeout') return 'pregate-retry';
  // An old receipt (before pregate A244 ③) has no focused-vs-main name diff: a fresh pregate records it.
  if (cls === 'baseline-failing-focused' && o.noBaselineInReceipt) return 'pregate';
  if ((cls === 'merge-conflict' || cls === 'stale-base-revert') && !o.crossRepo) return 'refresh';
  return null;
}

export interface FinishDeps {
  now(): Date;
  /** Detached `pregate <PR> --light` (least-loaded host). */
  launchPregate(pr: PrInfo, opts?: { avoidHost?: string }): { ok: boolean; pid?: number; log?: string; why?: string };
  alive(pid: number): boolean;
  /** Same-head receipt on file now (the job's PASS evidence) · `baseline` = it carries pregate's focused-vs-main name diff. */
  hasReceipt(pr: number, head: string): { baseline: boolean; tscTimeout?: boolean } | null;
  /** SMART-MERGE (src/git-smart): rebuild after a squash or merge main · rerere + structural ladder · revert guard · plain push. */
  refresh(pr: PrInfo, ctx?: { parentHeads?: readonly string[] }): { result: RefreshResult; newHead?: string; why?: string };
  /** Detached LLM capsule for the hunks rerere / structural left (`eln land smart-merge <pr> --llm`). */
  launchResolve?(pr: PrInfo, ctx?: { parentHeads?: readonly string[] }): { ok: boolean; pid?: number; log?: string; why?: string };
  /** LAND10-AUTOFIX-LANE (src/land-graph/autofix.ts): fix the mechanical red of this RED receipt on the branch · plain push. */
  autofix?(pr: PrInfo, red: { dir: string; failed: ReadonlyArray<{ name: string; exit: number }> }): { result: AutofixOutcome; newHead?: string; why?: string };
}
/** fixed = a fix commit pushed · semantic = not mechanical (the author's card) · author-active = the hand is still on it ·
 *  the rest are transient (retried next tick). */
export type AutofixOutcome = 'fixed' | 'semantic' | 'author-active' | 'head-moved' | 'closed' | 'busy' | 'error';
export type RefreshResult = 'merged' | 'rebuilt' | 'up-to-date' | 'conflict' | 'guard' | 'needs-llm' | 'head-moved' | 'closed' | 'busy' | 'error';

export interface FinishOutcome { pr: number; head: string; kind: FinishKind; state: FinishState | 'queued' | 'would-run' | 'busy' | 'author-active'; why: string }

/** Settle running jobs: dead pid / too old → pass (receipt on file) or failed. Returns the jobs that just finished. */
export function settle(book: FinishBook, d: Pick<FinishDeps, 'alive' | 'hasReceipt' | 'now'> & { headNow?(pr: number): string | undefined }): FinishJob[] {
  const done: FinishJob[] = [];
  const nowMs = d.now().getTime();
  for (const j of Object.values(book.jobs)) {
    if (j.state === 'resolving') {
      // LLM capsule: finished once its pid is gone (or past the bound) — a new head on the PR = it pushed a resolution.
      const old = nowMs - Date.parse(j.at) > FINISH_JOB_MAX_MS;
      if (typeof j.pid === 'number' && d.alive(j.pid) && !old) continue;
      const now = d.headNow?.(j.pr);
      if (now && now !== j.head) { j.state = 'refreshed'; j.newHead = now; j.why = `LLM capsule resolved → ${now.slice(0, 12)} (pregate decides)`; }
      else { j.state = 'failed'; j.why = `LLM capsule left the conflict unresolved${j.log ? ` (log ${j.log})` : ''}`; }
      done.push(j); continue;
    }
    if (j.state !== 'running' || (j.kind !== 'pregate' && j.kind !== 'pregate-retry')) continue;
    const r = d.hasReceipt(j.pr, j.head);
    const receipt = !!r && (j.need !== 'baseline' || r.baseline) && (j.kind !== 'pregate-retry' || !r.tscTimeout);
    const old = nowMs - Date.parse(j.at) > FINISH_JOB_MAX_MS;
    const alive = typeof j.pid === 'number' && d.alive(j.pid);
    if (receipt) { j.state = 'pass'; j.why = 'same-head receipt on file'; done.push(j); continue; }
    if (!alive || old) { j.state = 'failed'; j.why = old ? 'pregate ran past the bound' : `pregate exited without a green receipt${j.log ? ` (log ${j.log})` : ''}`; done.push(j); }
  }
  return done;
}

/**
 * One finisher pass over this tick's candidates (in land order). `apply` = live: launch / push; otherwise report only.
 * Dedupe by (PR, head): a head that already had a job never gets a second one (a failed pregate → needs-finisher card).
 */
export interface FinishCand { pr: PrInfo; kind: FinishKind; need?: 'receipt' | 'baseline'; avoidHost?: string; parentHeads?: readonly string[]; red?: { dir: string; failed: ReadonlyArray<{ name: string; exit: number }> } }
export function runFinisher(book: FinishBook, cands: FinishCand[], d: FinishDeps, apply: boolean): FinishOutcome[] {
  const out: FinishOutcome[] = [];
  let running = Object.values(book.jobs).filter(j => j.state === 'running' || j.state === 'resolving').length;
  let refreshes = 0;
  let autofixes = 0;
  const at = d.now().toISOString();
  for (const { pr, kind, need, avoidHost, parentHeads, red } of cands) {
    const key = jobKey(pr.number, pr.head, kind);
    // Old book rows: a refresh used to live under `pr@head` too — only a refresh/rebuild row there counts as a refresh.
    const legacy = (kind === 'refresh' || kind === 'rebuild') ? book.jobs[jobKey(pr.number, pr.head)] : undefined;
    let prev: FinishJob | undefined = book.jobs[key] ?? (legacy && (legacy.kind === 'refresh' || legacy.kind === 'rebuild') ? legacy : undefined);
    if (prev && staleRefreshJob(prev, d.now().getTime())) prev = undefined;
    if (prev) { out.push({ pr: pr.number, head: pr.head, kind: prev.kind, state: prev.state, why: prev.why ?? prev.state }); continue; }
    if (kind === 'autofix') {
      if (!red || !d.autofix) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: 'autofix dep or RED receipt missing' }); continue; }
      if (autofixes >= FINISH_CONCURRENCY) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: 'autofix cap this tick' }); continue; }
      autofixes++;
      if (!apply) { out.push({ pr: pr.number, head: pr.head, kind, state: 'would-run', why: `would autofix ${red.failed.map(s => s.name).join(', ')}` }); continue; }
      const r = d.autofix(pr, red);
      if (r.result === 'fixed') {
        const why = `autofix pushed → ${r.newHead?.slice(0, 12)}${r.why ? ` · ${r.why}` : ''}`;
        book.jobs[key] = { pr: pr.number, head: pr.head, kind, state: 'fixed', at, why, ...(r.newHead ? { newHead: r.newHead } : {}) };
        out.push({ pr: pr.number, head: pr.head, kind, state: 'fixed', why });
      } else if (r.result === 'semantic') {
        const why = `not mechanical: ${r.why ?? '?'}`;
        book.jobs[key] = { pr: pr.number, head: pr.head, kind, state: 'failed', at, why };
        out.push({ pr: pr.number, head: pr.head, kind, state: 'failed', why });
      } else out.push({ pr: pr.number, head: pr.head, kind, state: r.result === 'author-active' ? 'author-active' : 'busy', why: `autofix ${r.result}: ${r.why ?? '?'}` });
      continue;
    }
    if (kind === 'pregate' || kind === 'pregate-retry') {
      const what = kind === 'pregate-retry' ? `pregate --light retry (not ${avoidHost ?? '?'})` : 'pregate --light';
      if (running >= FINISH_CONCURRENCY) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: `finisher ${running}/${FINISH_CONCURRENCY} running` }); continue; }
      if (!apply) { out.push({ pr: pr.number, head: pr.head, kind, state: 'would-run', why: `would launch ${what}` }); running++; continue; }
      const r = d.launchPregate(pr, kind === 'pregate-retry' && avoidHost ? { avoidHost } : undefined);
      if (!r.ok) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: `launch failed: ${r.why ?? '?'}` }); continue; }
      book.jobs[key] = { pr: pr.number, head: pr.head, kind, state: 'running', at, ...(need ? { need } : {}), ...(avoidHost ? { avoidHost } : {}), ...(r.pid ? { pid: r.pid } : {}), ...(r.log ? { log: r.log } : {}), why: `${what} running` };
      running++;
      out.push({ pr: pr.number, head: pr.head, kind, state: 'queued', why: `${what} launched${r.pid ? ` pid ${r.pid}` : ''}` });
    } else if (kind === 'refresh' || kind === 'rebuild') {
      if (refreshes >= FINISH_CONCURRENCY) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: 'refresh cap this tick' }); continue; }
      refreshes++;
      if (!apply) { out.push({ pr: pr.number, head: pr.head, kind, state: 'would-run', why: kind === 'rebuild' ? 'would rebuild the stack child onto main' : 'would merge origin/main into the branch' }); continue; }
      const ctx = parentHeads?.length ? { parentHeads } : undefined;
      const r = d.refresh(pr, ctx);
      // transient: retried next tick (a moved / closed head is a new decision next tick anyway)
      if (r.result === 'error' || r.result === 'busy' || r.result === 'head-moved' || r.result === 'closed') { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: `smart-merge ${r.result}: ${r.why ?? '?'}` }); continue; }
      if (r.result === 'needs-llm' && d.launchResolve && running < FINISH_CONCURRENCY) {
        const l = d.launchResolve(pr, ctx);
        if (l.ok) {
          running++;
          const why = `LLM capsule resolving ${r.why ?? 'conflict hunks'}${l.pid ? ` pid ${l.pid}` : ''}`;
          book.jobs[key] = { pr: pr.number, head: pr.head, kind, state: 'resolving', at, why, smart: true, ...(l.pid ? { pid: l.pid } : {}), ...(l.log ? { log: l.log } : {}) };
          out.push({ pr: pr.number, head: pr.head, kind, state: 'resolving', why });
          continue;
        }
      }
      if (r.result === 'needs-llm' && d.launchResolve && running >= FINISH_CONCURRENCY) { out.push({ pr: pr.number, head: pr.head, kind, state: 'busy', why: `finisher ${running}/${FINISH_CONCURRENCY} running` }); continue; }
      const state: FinishState = r.result === 'conflict' || r.result === 'guard' || r.result === 'needs-llm' ? 'conflict'
        : r.result === 'merged' || r.result === 'rebuilt' ? 'refreshed' : kind === 'rebuild' ? 'pass' : 'failed';
      const why = r.result === 'merged' ? `merged origin/main → ${r.newHead?.slice(0, 12)}`
        : r.result === 'rebuilt' ? `rebuilt own commits onto main → ${r.newHead?.slice(0, 12)}`
          : r.result === 'conflict' || r.result === 'needs-llm' ? `merge with main conflicts${r.why ? `: ${r.why}` : ''}`
            : r.result === 'guard' ? `revert guard refused the result${r.why ? `: ${r.why}` : ''}`
              : kind === 'rebuild' ? 'already on main' : 'branch already contains main — the refusal is not stale base';
      book.jobs[key] = { pr: pr.number, head: pr.head, kind, state, at, why, smart: true, ...(r.newHead ? { newHead: r.newHead } : {}) };
      out.push({ pr: pr.number, head: pr.head, kind, state, why });
    }
  }
  return out;
}

/** STALE-PR-24H: open PRs older than 24 h with their current reason. */
export function stalePrs(prs: readonly PrInfo[], reasons: ReadonlyMap<number, string>, nowMs: number): Array<{ pr: number; ageH: number; reason: string }> {
  return prs.filter(p => p.state === 'OPEN' && p.createdAt && nowMs - Date.parse(p.createdAt) > STALE_PR_MS)
    .map(p => ({ pr: p.number, ageH: Math.floor((nowMs - Date.parse(p.createdAt!)) / 3_600_000), reason: reasons.get(p.number) ?? (p.draft ? 'draft' : 'unknown') }))
    .sort((a, b) => b.ageH - a.ageH);
}

/** KPI: autofix commits pushed in the hour before `nowMs` (finisher book rows kind «autofix» state «fixed»). */
export function autofixesPerHour(jobs: Iterable<{ kind: string; state: string; at: string }>, nowMs: number): number {
  let n = 0;
  for (const j of jobs) if (j.kind === 'autofix' && j.state === 'fixed' && nowMs - Date.parse(j.at) <= 3_600_000 && nowMs >= Date.parse(j.at)) n++;
  return n;
}
