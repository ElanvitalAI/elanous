/**
 * Land graph — «judge → land» under judge-kingdom autonomy (대표 11-25 20:3x).
 *
 * Golden path = what Claude OP did by hand ~20× on 11-25 through seat-state/OPS/tools/coach-land.sh →
 * seat-state/OP/tools/op-direct-land-v2.sh:
 *   ① same-head pregate receipt (RES/evidence/PREGATE-GREEN/<PR>-<head12>-<host>/) whose focused raw says 0 fail
 *   ② ratchet · tsc · isolation preflight on the merge result (op-direct-land-v2.sh — the SAME command, not a copy)
 *   ③ Terra findings: only the security-4 classes bind (real bugs fixed by the author, edges → FU)
 *
 * JUD-RELAX (CEO 11-21…11-26 · 0.3.38 P0) — the land rule, exactly:
 *   land ⇔ same-head receipt ∧ (focused 0 fail ∨ baseline-name-diff introduced 0 ∨ L0 doc-only)
 *          ∧ no JUD veto (hold) ∧ (path ∉ security-4 ∨ Terra PASS/WARN on this head with no security finding)
 *   - focused 0 fail is also proven by the receipt's own focused step exit 0 when the host swept the raw (bun exits 0 ⇔ 0 fail).
 *   - no per-PR JUD «functional judgement» wait and no hot-file JUD review: JUD keeps the veto only (holds · JUD HOLD verdicts).
 *   - pregate's generic «security REVIEW_REQUIRED» is a warning; only the security-4 paths need a Terra review.
 *   ④ land (--match-head-commit) + post-notice to OP + COACH-ACTIONS ledger row
 * Every refusal is a typed class with one card to the PR author carrying the exact fix.
 *
 * Modes: `shadow` (default) records would-land / would-refuse and never merges; `live` only when config
 * `land.graph.mode = live`. Concurrency = `land.graph.slots` (default 2) lands per tick; a single tick lock.
 * JUD/OP can HOLD a PR (`eln land hold <PR> --reason`) — re-checked right before the merge.
 * Idempotent resume: a `landing` row without `landed` is resolved from the PR state on the next tick; a `landed` row
 * without `noticed` re-posts the notice. A PR is never landed twice (ledger + MERGED state both checked).
 *
 * State: <stateRoot>/land-graph/{ledger.jsonl, holds.json, tick.lock}.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { security4Hits } from '../judge-butler/done-when.js';
import { isDocOnly, noFocusedStage as noFocusedStageOf, preexistingOnly as preexistingOnlyOf } from './receipt-rules.js';
import { evaluateLandVetoes, landRefusalRecipient, type VetoKind, type VetoMark } from '../org/land-authority.js';
import type { OrgDeps } from '../org/org-map.js';
import type { CellMatch } from './cell-link.js';
import { agingCard, conflictEvidence, headAtOf, judgePrAging, type AgingStage, type HeadAtSource, type PrAgingPolicy } from '../kit/pr-aging/index.js';
import { autofixesPerHour, finishKindFor, readBook, runFinisher, settle, stalePrs, writeBook, type FinishCand, type FinishDeps, type FinishOutcome } from './finisher.js';
import { guardErrorClass, legacyGuardError, nextAction, redVerdict, TSC_LAND_RETRIES, tscUnmeasured, type NextAction } from './red-receipt.js';

export type Mode = 'shadow' | 'live';

export interface PrInfo {
  number: number; head: string; base: string; draft: boolean; state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string; author: string; files: string[];
  /** Head branch name (same-repo PRs) — the finisher merges fresh main into it. */
  headRef?: string;
  /** true = head lives in a fork; the finisher never pushes there. */
  crossRepo?: boolean;
  /** ISO creation time — STALE-PR-24H. */
  createdAt?: string;
  /** ISO last-activity time (gh updatedAt) — PR-ZOMBIE-AGING's head-age fallback when the head commit is not local. */
  updatedAt?: string;
  /** PR body — LAND-CELL-LINK reads its «칸: ID» line. */
  body?: string;
  /** Label names — part of the refusal context (LAND10-RESTICKY-REFUSAL) when the lister fetches them. */
  labels?: string[];
}
export interface Receipt {
  dir: string; head: string; host: string; focused: string[]; rawDir: string;
  /** exit of the receipt's own `focused` step (pregate records it in steps[]); null when the receipt has no focused step. */
  focusedExit?: number | null;
  /** rawSha256['focused.raw'] of the receipt — a local raw copy counts only when its SHA matches. */
  focusedSha?: string;
  /** pregate grade (L0 · L1 · L1d · L2 · L3); L0 = comment-or-doc-only, which runs no focused stage. */
  grade?: string;
  /** pregate A244 ③ focused-vs-main on the same host: failures of the head that also fail on main (newFailures = head-only names). */
  focusedBaseline?: { mine: number; onMain: number; newFailures: string[] };
  /** PATCHID-1127: patch-id of the PR-own change (diff merge-base(main, head)..head) the receipt was taken on. */
  patchId?: string;
  /** Set when this receipt was taken on an older head whose PR-own change is the same (only main was merged since). */
  reusedFrom?: string;
  /** How the older head's receipt was carried: same stable patch-id · or LAND10-FINISHER-WAIT own-diff (clean main merges only,
   *  PR-own +/- lines identical — main moving a context line next to a hunk no longer voids the receipt). */
  reusedVia?: 'patch-id' | 'own-diff';
  /** LAND-STEWARD RED-RECEIPT: the receipt came from PREGATE-RED — its failed steps (src/land-graph/red-receipt.ts). */
  red?: { failed: Array<{ name: string; exit: number }>; failure?: string };
}
/** A baseline failure-name diff receipt (land-name-diff-check.py format) for this head: every head failure also fails on main. */
export interface BaselineDiff { receipt: string; command: string; headPass: number; headFail: number }
/** The Terra review of this exact head (review-results/pr-<PR>-<head12>.json). */
export interface TerraReview { verdict: string; securityFindings: string[] }
/** Parsed bun summary of the focused raw · or `swept`: the raw is gone (pregate rawDir is a host temp dir) and only the receipt's step exit is left. */
export type Focused = { pass: number; fail: number } | { swept: true; exit: number } | 'unreadable';
export const focusedCounts = (f: Focused | null): { pass: number; fail: number } | null => (f && typeof f === 'object' && 'pass' in f ? f : null);

export type RefusalClass =
  | 'no-receipt' | 'stale-head' | 'focused-unreadable' | 'baseline-failing-focused' | 'no-focused-stage'
  | 'isolation-gate' | 'test-interference' | 'tsc' | 'merge-conflict' | 'base-not-main' | 'review-disposition'
  | 'security-finding' | 'review-required' | 'held' | 'stale-base-revert' | 'head-moved' | 'main-moved-overlap' | 'gh-error' | 'land-error'
  | 'needs-finisher' | 'tsc-timeout' | 'pregate-red';

export type Action = 'land' | 'refuse' | 'wait' | 'hold' | 'skip';
export interface Decision { action: Action; cls?: RefusalClass; why: string; lane?: 'L0-doc-only' | 'normal'; card?: Card }
export interface Card { to: string[]; body: string }

/** Terra finding categories that bind (memory rule 11-25: only security-4 bind; other findings → FU). */
export const SECURITY4 = ['secret', 'auth', 'injection', 'sandbox'];

/** Security-4 paths: ONE shared table with the judge-butler's green function (GREEN-DEFINITION-ONE · src/judge-butler/done-when.ts) —
 *  executable code only (tests · fixtures · docs never count) and the land path's authority boundary only. */
export { SECURITY4_PATHS, security4Hits } from '../judge-butler/done-when.js';
/** Terra review verdicts that clear a security-4 path (with no security finding). */
const TERRA_CLEAR = ['pass', 'warn'];

export { isDocOnly } from './receipt-rules.js'; // one definition with the judge-butler (BUTLER-SIGN-MERGED-PATCHID)

/** The exact fix each refusal class asks of the author (or the owner seat). */
export function fixFor(cls: RefusalClass, pr: PrInfo, extra = ''): { to: 'author' | 'JUD' | 'RES' | 'OP'; fix: string } {
  const h = pr.head.slice(0, 12);
  switch (cls) {
    case 'no-receipt': return { to: 'author', fix: `no pregate receipt for head ${h} — run \`pregate.py ${pr.number} --light\` on minim5` };
    case 'stale-head': return { to: 'author', fix: `receipt is for ${extra} but head is ${h} (pushed after pregate) — re-run \`pregate.py ${pr.number} --light\` for the current head` };
    case 'focused-unreadable': return { to: 'RES', fix: `focused raw of the receipt is unreadable (host down / ssh fail${extra ? ` · ${extra}` : ''}) — re-run pregate or restore the host` };
    case 'baseline-failing-focused': return { to: 'author', fix: `focused set has failing tests (${extra}) — if they already fail on main, re-scope focused to the changed files' tests; else fix them, push, re-run pregate` };
    case 'no-focused-stage': return { to: 'author', fix: 'receipt has no focused tests but the PR changes code — add the changed files\' tests to the focused set and re-run pregate' };
    case 'isolation-gate': return { to: 'author', fix: 'isolation gate failed on the merge result — replace homedir()/~ hardcodes with effectiveInstanceRoot()/config-dir paths, push, re-run pregate' };
    case 'test-interference': return { to: 'author', fix: 'test-interference ratchet failed — a test sets env/globals (process.env, cwd, timers) without restoring; save + restore in afterEach, push, re-run pregate' };
    case 'tsc': return { to: 'author', fix: 'tsc preflight failed on the merge result — `git merge origin/main`, fix type errors, push, re-run pregate' };
    case 'merge-conflict': return { to: 'author', fix: 'merge conflict / base moved — `git fetch && git merge origin/main`, resolve, push, re-run pregate' };
    case 'base-not-main': return { to: 'author', fix: `base is ${extra} (stacked PR) — land the base PR first or retarget to main` };
    case 'review-disposition': return { to: 'author', fix: 'Terra same-head findings lack dispositions — answer each finding (fixed-in-this-head / out-of-scope-followup …) in the waiver' };
    case 'security-finding': return { to: 'author', fix: `Terra security-4 finding(s) open: ${extra} — fix them (these bind); other findings stay FU` };
    case 'review-required': return { to: 'author', fix: `security-4 path changed (${extra}) — needs a Terra PASS/WARN with no security finding on this head: \`elanous self review ${pr.number} --model gpt-6.1-terra\`` };
    case 'held': return { to: 'OP', fix: `held: ${extra} — \`eln land unhold ${pr.number}\` when cleared` };
    case 'stale-base-revert': return { to: 'author', fix: `the merge result wipes out recent main commits (${extra}) — \`git fetch && git merge origin/main\`, keep their lines, push, re-run pregate` };
    case 'head-moved': return { to: 'author', fix: 'head moved during the land — the graph re-evaluates the new head after its pregate receipt' };
    case 'main-moved-overlap': return { to: 'OP', fix: 'another PR touching the same files landed this tick — re-preflight on the new main next tick' };
    case 'gh-error': return { to: 'OP', fix: `GitHub API error (${extra}) — retried next tick` };
    case 'land-error': return { to: 'OP', fix: `land command failed (${extra}) — read the land log` };
    case 'tsc-timeout': return { to: 'RES', fix: `tsc did not finish (timeout / unmeasured${extra ? ` · ${extra}` : ''}) — the land graph re-ran it on another host and it still did not finish; free a host or raise LAND_TSC_TIMEOUT` };
    case 'pregate-red': return { to: 'author', fix: `pregate RED at ${extra} — fix it, push, the graph re-pregates the new head` };
    case 'needs-finisher': return { to: 'author', fix: `the land graph could not finish this PR itself (${extra}) — resolve it by hand (merge origin/main, fix, push); the graph re-pregates the new head` };
  }
}

/** Refusal / exception mail: author cards cc the landing owner; seat cards go to the landing owner (org map · JUD-SPLIT-FU-CONSUMERS). */
function card(cls: RefusalClass, pr: PrInfo, extra: string, override?: string, org: OrgDeps = {}): Card {
  const f = fixFor(cls, pr, extra);
  const owner = landRefusalRecipient(org);
  const to = override ? [override] : f.to === 'author' ? [...new Set([pr.author, owner])] : [owner];
  return { to, body: `[land-graph · ${cls}] #${pr.number} «${pr.title.slice(0, 60)}» @${pr.head.slice(0, 12)} — ${f.fix}` };
}

export interface Facts {
  pr: PrInfo;
  receipt: Receipt | null;
  /** Head of the newest receipt for this PR when none matches the current head. */
  olderReceiptHead: string | null;
  focused: Focused | null;
  hold: string | null;
  security: string[];
  /** Terra review of this head (only read for security-4 paths); null = none on file. */
  terra?: TerraReview | null;
  /** Baseline failure-name diff for this head (focused has failures that already fail on main). */
  baselineDiff?: BaselineDiff | null;
  landedBefore: boolean;
  cardSeat?: string;
  org?: OrgDeps;
}

/** Pure pre-land decision (steps ①③ + routing). Preflight ② runs inside the land command (live). */
export function decide(f: Facts): Decision {
  const { pr } = f;
  const c = (cls: RefusalClass, extra = '') => card(cls, pr, extra, f.cardSeat, f.org);
  if (f.landedBefore || pr.state === 'MERGED') return { action: 'skip', why: 'already landed' };
  if (pr.state !== 'OPEN') return { action: 'skip', why: `state ${pr.state}` };
  if (pr.draft) return { action: 'skip', why: 'draft' };
  if (f.hold) return { action: 'hold', cls: 'held', why: f.hold, card: c('held', f.hold) };
  if (pr.base !== 'main') return { action: 'refuse', cls: 'base-not-main', why: `base ${pr.base}`, card: c('base-not-main', pr.base) };
  if (!f.receipt || f.receipt.head !== pr.head) {
    if (f.olderReceiptHead) return { action: 'refuse', cls: 'stale-head', why: `receipt ${f.olderReceiptHead.slice(0, 12)} ≠ head ${pr.head.slice(0, 12)}`, card: c('stale-head', f.olderReceiptHead.slice(0, 12)) };
    return { action: 'wait', cls: 'no-receipt', why: 'no same-head receipt', card: c('no-receipt') };
  }
  // RED-RECEIPT: a PREGATE-RED receipt counts only when its red steps are focused (+ baseline) and/or a tsc timeout.
  const red = redVerdict(f.receipt);
  if (red?.kind === 'other') return { action: 'refuse', cls: 'pregate-red', why: `pregate RED: ${red.other.join(', ')}`.slice(0, 200), card: c('pregate-red', red.other.join(', ')) };
  let lane: Decision['lane'] = 'normal';
  let focusedTxt = '';
  const swept = f.focused && typeof f.focused === 'object' && 'swept' in f.focused ? f.focused : null;
  const nd = f.baselineDiff ?? null;
  const ndTxt = nd ? `baseline-name-diff introduced 0 (${nd.headFail} fail also on main)` : '';
  // BASELINE-FAIL-NONBLOCK (CEO 11-27): pregate's same-host focused-vs-main found no head-only failure name → not a block.
  // The why carries no «N fail» / «baseline fail» words: the land command's name-diff check reads them as a waiver claim.
  const fb = f.receipt.focusedBaseline;
  const preexistingOnly = preexistingOnlyOf(fb);
  const fbTxt = fb ? `focused preexisting-only: name diff new 0 · ${fb.mine} also red on main (${fb.onMain})` : '';
  // L0 doc-only: the receipt ran no focused stage (empty focused set, or pregate graded it L0 and skipped the stage).
  const noFocusedStage = noFocusedStageOf({ focusedCount: f.receipt.focused.length, grade: f.receipt.grade, focusedExit: f.receipt.focusedExit });
  if (noFocusedStage) {
    if (!isDocOnly(pr.files)) return { action: 'refuse', cls: 'no-focused-stage', why: 'empty focused set on a code PR', card: c('no-focused-stage') };
    lane = 'L0-doc-only'; focusedTxt = 'doc-only L0';
  } else if (swept) {
    // The host swept the raw: the receipt's focused step exit is the evidence (bun test exits 0 ⇔ 0 fail).
    if (swept.exit === 0) focusedTxt = 'focused step exit 0 (raw swept)';
    else if (nd) focusedTxt = ndTxt;
    else if (preexistingOnly) focusedTxt = fbTxt;
    else return { action: 'refuse', cls: 'baseline-failing-focused', why: `focused step exit ${swept.exit} (raw swept)`, card: c('baseline-failing-focused', `exit ${swept.exit}`) };
  } else {
    if (f.focused === null || f.focused === 'unreadable') return { action: 'wait', cls: 'focused-unreadable', why: 'focused raw unreadable', card: c('focused-unreadable', f.receipt.host) };
    const fc = f.focused as { pass: number; fail: number };
    if (fc.fail > 0 && nd) focusedTxt = ndTxt;
    else if (fc.fail > 0 && preexistingOnly) focusedTxt = fbTxt;
    else if (fc.fail > 0 || fc.pass === 0) return { action: 'refuse', cls: 'baseline-failing-focused', why: `focused ${fc.pass} pass ${fc.fail} fail`, card: c('baseline-failing-focused', `${fc.fail} fail`) };
    else focusedTxt = `focused ${fc.pass}/0`;
  }
  // TSC-TIMEOUT: focused is fine but changed-tsc never finished on that host — the finisher re-runs pregate elsewhere.
  if (red?.tscTimeout) return { action: 'wait', cls: 'tsc-timeout', why: `pregate changed-tsc timeout on ${f.receipt.host} · ${focusedTxt}`, card: c('tsc-timeout', f.receipt.host) };
  if (f.security.length) return { action: 'refuse', cls: 'security-finding', why: f.security.join(','), card: c('security-finding', f.security.join(', ')) };
  // Security-4 paths only: a Terra PASS/WARN on this head with no security finding. Everything else needs no review.
  const sec4 = security4Hits(pr.files);
  let terraTxt = '';
  if (sec4.length) {
    const t = f.terra ?? null;
    const hit = sec4.slice(0, 3).join(', ');
    if (t && t.securityFindings.length) return { action: 'refuse', cls: 'security-finding', why: `terra ${t.verdict}: ${t.securityFindings.join(',')}`.slice(0, 200), card: c('security-finding', t.securityFindings.join(', ')) };
    if (!t || !TERRA_CLEAR.includes(t.verdict.toLowerCase())) return { action: 'wait', cls: 'review-required', why: `security-4 ${hit} · terra ${t ? t.verdict : 'none'}`, card: c('review-required', hit) };
    terraTxt = ` · security-4 terra ${t.verdict.toLowerCase()}`;
  }
  const reuse = f.receipt.reusedFrom ? ` · receipt reused via ${f.receipt.reusedVia ?? 'patch-id'} from ${f.receipt.reusedFrom.slice(0, 12)}` : '';
  return { action: 'land', lane, why: `same-head receipt ${f.receipt.dir.split('/').pop()}${reuse} · ${focusedTxt}${terraTxt}` };
}

/** op-direct-land-v2.sh / coach-land.sh exit code + output → refusal class (the STOP lines of 11-25). */
export function classifyLandExit(rc: number, text: string): RefusalClass | null {
  if (rc === 0) return null;
  // Only the STOP/REFUSE lines decide (OK lines of earlier checks mention the same check names).
  text = text.split('\n').filter(l => /^\s*(STOP|REFUSE)\b/.test(l)).join('\n');
  if (/verdict-hold/.test(text)) return 'held';
  if (/STOP 같은 head|pregate 영수 없음/.test(text)) return 'no-receipt';
  if (/STOP focused/.test(text)) return /[1-9]\d* fail/.test(text) ? 'baseline-failing-focused' : 'no-focused-stage';
  if (/baseline failure-name diff|baseline-name-diff/.test(text)) return 'baseline-failing-focused';
  if (tscUnmeasured(text)) return 'tsc-timeout';
  switch (rc) {
    case 4: return /REFUSE base=/.test(text) ? 'base-not-main' : 'no-focused-stage';
    case 5: return 'review-disposition';
    case 6: return 'test-interference';
    case 7: return 'merge-conflict';
    case 8: return 'baseline-failing-focused';
    case 9: return 'isolation-gate';
    case 10: return 'tsc';
    case 3: return 'merge-conflict';
    default: return 'land-error';
  }
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerRow {
  at: string; pr: number; head: string; mode: Mode;
  event: 'decision' | 'landing' | 'landed' | 'noticed' | 'refused' | 'card' | 'stall' | 'aging';
  /** `aging` rows (PR-ZOMBIE-AGING): which stage acted on this head (one row per PR · head · stage). */
  stage?: AgingStage;
  action?: Action; cls?: RefusalClass; why?: string; to?: string[]; body?: string; synthetic?: boolean;
  /** `landed` rows: the real merge time (`at` is the tick start · a tick with live lands runs tens of minutes). */
  doneAt?: string;
  /** NEXT-ACTION: who acts next on a non-land decision / refusal (the graph itself or a seat). */
  next?: NextAction;
  /** `refused` rows: refusalContext() at refusal time — a later tick with a different context re-judges the same head. */
  ctx?: string;
}

export const landHome = (stateRoot: string) => join(stateRoot, 'land-graph');
const ledgerPath = (s: string) => join(landHome(s), 'ledger.jsonl');
const holdsPath = (s: string) => join(landHome(s), 'holds.json');

export function readLedger(stateRoot: string): LedgerRow[] {
  const p = ledgerPath(stateRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as LedgerRow]; } catch { return []; } });
}
export function appendLedger(stateRoot: string, row: LedgerRow): void {
  mkdirSync(landHome(stateRoot), { recursive: true });
  appendFileSync(ledgerPath(stateRoot), JSON.stringify(row) + '\n');
}

export const holdKind = (reason: string): VetoKind => /no-?go/i.test(reason) ? 'no-go' : /security/i.test(reason) ? 'security-veto' : 'hold';
/** A hold is a veto mark; only the veto owner's (org duty «veto», JUD) blocks — other seats' marks are recorded and ignored. */
export function holdVerdict(h: { reason: string; by: string } | undefined, org: OrgDeps = {}): { block: string | null; ignored: string | null } {
  if (!h) return { block: null, ignored: null };
  const m: VetoMark = { seat: h.by, kind: holdKind(h.reason), reason: h.reason };
  const v = evaluateLandVetoes([m], org);
  return v.blocked ? { block: `${m.kind} by ${h.by}: ${h.reason}`, ignored: null } : { block: null, ignored: `${m.kind} by ${h.by} ignored (not veto owner)` };
}
export function readHolds(stateRoot: string): Record<string, { reason: string; by: string; at: string }> {
  try { return JSON.parse(readFileSync(holdsPath(stateRoot), 'utf8')); } catch { return {}; }
}
export function setHold(stateRoot: string, pr: number, reason: string, by: string, now = new Date()): void {
  if (!reason.trim()) throw new Error('hold needs --reason');
  const h = readHolds(stateRoot); h[String(pr)] = { reason, by, at: now.toISOString() };
  mkdirSync(landHome(stateRoot), { recursive: true }); writeFileSync(holdsPath(stateRoot), JSON.stringify(h, null, 2));
}
export function clearHold(stateRoot: string, pr: number, only?: (hold: { reason: string; by: string; at: string }) => boolean): boolean {
  const h = readHolds(stateRoot); if (!h[String(pr)]) return false;
  if (only && !only(h[String(pr)]!)) return false;
  delete h[String(pr)]; writeFileSync(holdsPath(stateRoot), JSON.stringify(h, null, 2)); return true;
}

/** Single tick lock (O_EXCL); a lock older than 60 min (file-system clock · > one live land of ≤ 40 min) is stale (crashed tick) and is taken over. */
/** kit/trigger-lock (DUPLICATION-MAP §1-2): a lock whose writer pid is gone is a dead tick's lock — take it over now, not after
 *  60 min. A live pid (or EPERM = alive, not ours) keeps it; an unreadable pid falls back to the 60-min age rule. */
export function lockHolderAlive(raw: string, isAlive: (pid: number) => boolean = pidAlive): boolean | null {
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? isAlive(pid) : null;
}
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function acquireLock(stateRoot: string, nowMs = Date.now(), isAlive: (pid: number) => boolean = pidAlive): (() => void) | null {
  mkdirSync(landHome(stateRoot), { recursive: true });
  const p = join(landHome(stateRoot), 'tick.lock');
  try {
    if (existsSync(p)) {
      let holder: boolean | null = null;
      try { holder = lockHolderAlive(readFileSync(p, 'utf8'), isAlive); } catch { holder = null; }
      if (holder === false || nowMs - statSync(p).mtimeMs > 60 * 60_000) rmSync(p, { force: true });
    }
    const fd = openSync(p, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd);
    return () => rmSync(p, { force: true });
  } catch { return null; }
}

// ── Tick ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LandDeps {
  now(): Date;
  stateRoot: string;
  mode: Mode;
  slots: number;
  cardSeat?: string;
  listPrs(): Promise<PrInfo[]>;
  prNow(pr: number): Promise<PrInfo | null>;
  receipt(pr: number, head: string): Receipt | null;
  olderReceiptHead(pr: number, head: string): string | null;
  focused(r: Receipt): Focused;
  security(pr: number, head: string): string[];
  /** Terra review of this exact head (security-4 paths); absent dep = none on file. */
  terra?(pr: number, head: string): TerraReview | null;
  /** Baseline failure-name diff receipt for this head (only asked when focused has failures). */
  baselineDiff?(pr: number, head: string): BaselineDiff | null;
  /** JUD veto verdicts on file for this head (JUD HOLD review results) — a veto like a hold. */
  judHold?(pr: number, head: string): { reason: string; by: string } | null;
  /** Live only: the golden-path land command (op-direct-land-v2.sh with the coach extra.json). */
  land(pr: PrInfo, r: Receipt, why: string, ctx?: { lane?: Decision['lane']; baselineDiff?: BaselineDiff | null; tscAttempt?: number }): Promise<{ rc: number; text: string }>;
  post(to: string, body: string): void;
  /** COACH-ACTIONS ledger row (live landed). */
  record(line: string): void;
  /** Stale-base revert guard (src/land-guard/stale-base-revert.ts) on the merge result — runs before every live merge. */
  staleRevert?(pr: PrInfo): { ok: boolean; why?: string };
  /** Org map deps for landing / veto routing (tests inject a map). */
  org?: OrgDeps;
  /** plan: decide only — no lock, no ledger, no cards. */
  dry?: boolean;
  /** Synthetic shadow injection: every row is tagged so it is never read as a real land. */
  synthetic?: boolean;
  /** LAND-OWNS-RECEIPT finisher (src/land-graph/finisher.ts): launches / pushes only in live mode; plan and shadow report «would-run». */
  finisher?: Omit<FinishDeps, 'now' | 'hasReceipt'>;
  /**
   * SMART-MERGE (src/git-smart): squash-landed heads the finisher may find inside a branch (stack parents) — wired =
   * stale-base-revert refusals are refreshed by the finisher too, and a retargeted stack child is rebuilt onto main.
   */
  smartMerge?: { mergedHeads(): readonly string[]; mergedBaseHead(pr: PrInfo): string | null };
  /** STACK-AUTO-RETARGET: the base branch's PR is merged (or the base is contained in main). */
  baseMerged?(pr: PrInfo): boolean;
  retargetToMain?(pr: PrInfo): { ok: boolean; why?: string };
  /** STALE-PR-24H reap: the PR's whole diff is already in main (merge-tree of head into main = main's tree). */
  superseded?(pr: PrInfo): boolean;
  closePr?(pr: PrInfo, comment: string): { ok: boolean; why?: string };
  /** LAND-CELL-LINK: the cell of the release in play this PR belongs to · null = none · undefined = no release/checklist (skip). */
  cellLink?(pr: PrInfo): CellMatch | null | undefined;
  /** Live, right before the merge: `checklist evidence add <cell> '#PR'`. */
  attachCell?(cell: string, pr: PrInfo): { ok: boolean; why?: string };
  /** `plan --reap`: 'dry' lists would-close · 'apply' closes. */
  reap?: 'dry' | 'apply';
  /** LAND-STEWARD train manager (src/land-graph/lane-order.ts · policies.yaml): land order over the open PRs · default landOrder. */
  order?(prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number): PrInfo[];
  /** PR-ZOMBIE-AGING (src/kit/pr-aging · graphs/policies/pr-aging.yaml) — absent / null = no aging this tick. */
  prAging?: PrAgingPolicy | null;
  /** Committer time (ms) of each head present in the local repo (no network) — absent head = its PR's updatedAt is the basis. */
  headTimes?(heads: readonly string[]): ReadonlyMap<string, number>;
  /** Names of the failed steps (exit ≠ 0) of this head's PREGATE-RED receipts. */
  redSteps?(pr: number, head: string): string[];
  /** Live: convert the PR to draft (`gh pr ready <N> --undo` — reversible). */
  toDraft?(pr: PrInfo): { ok: boolean; why?: string };
  /** LAND-STEWARD «세 평면»: the steward is the terminal owner of land refusals — no mail to the landing owner / OP
   *  (cards cc, seat cards, stall, post-land notice) except policy exceptions (security-4). Rows still record everything. */
  terminalOwner?: string;
}
/** Refusal classes that stay mail even under a terminal owner (policy: security-4 binds a human). */
export const POLICY_MAIL_CLASSES: RefusalClass[] = ['security-finding', 'review-required'];

export interface TickResult {
  mode: Mode; locked: boolean; decisions: Array<{ pr: number; head: string; action: Action; cls?: RefusalClass; why: string; next?: NextAction }>; landed: number[]; error?: string;
  /** GH-BUDGET-GOVERNOR ④: the open-PR read failed (GitHub cooldown · secondary limit · network) — a skipped tick, not an
   *  exception: `error` still names it (no KPI · no breach line · voice refuses to answer) and the next tick retries. */
  skipped?: 'gh-error';
  /** «ready to land» count this tick (every gate passes for the head). */
  ready?: number;
  finisher?: FinishOutcome[];
  /** LAND10-AUTOFIX-LANE KPI: autofix commits pushed in the last hour (finisher book). */
  autofixPerHour?: number;
  stale?: Array<{ pr: number; ageH: number; reason: string }>;
  reaped?: Array<{ pr: number; action: 'would-close' | 'closed' | 'close-failed'; why: string }>;
  /** PR-ZOMBIE-AGING: every aged open PR this tick and what the tick did about it (code never closes a PR). */
  aging?: AgingRow[];
  /** LAND-CELL-LINK per ready PR · `landed-no-cell` = no current-release cell matched. */
  cells?: Array<{ pr: number; cell: string | null; basis?: string; action: 'linked' | 'would-attach' | 'attached' | 'attach-failed' | 'landed-no-cell'; why?: string }>;
}

/** One aged PR in a tick: drafted / would-draft (non-live) / draft-failed / deferred (per-tick cap) · proposed / would-propose / proposed-before. */
export interface AgingRow {
  pr: number; head: string; stage: AgingStage; ageDays: number; basis: HeadAtSource; conflict: string | null;
  action: 'drafted' | 'would-draft' | 'draft-failed' | 'deferred' | 'proposed' | 'would-propose' | 'proposed-before'; why: string; to?: string[];
}

const STALL_MIN = 30;
const TRANSIENT: RefusalClass[] = ['head-moved', 'gh-error', 'main-moved-overlap', 'held', 'land-error', 'tsc-timeout'];
const tscTries = (rows: readonly LedgerRow[], pr: number, head: string) => rows.filter(x => x.pr === pr && x.head === head && x.event === 'refused' && x.cls === 'tsc-timeout').length;

/**
 * LAND10-RESTICKY-REFUSAL (11-27 #40516: refused stale-base-revert, the body then gained its «의도된 삭제» lines, and the
 * refusal stuck until a new head). A gate refusal sticks to (PR, head, context): the hash of what the land rule reads besides
 * the head — PR body (declared removals · waiver lines), labels, the receipt dir and the baseline-diff receipt. A changed
 * context re-judges the same head next tick. A HOLD set or cleared after the refusal (a `hold` decision row) re-judges too.
 * Rows written before this field (no ctx) keep sticking — no mass re-run of old refusals on deploy. Each distinct context
 * re-judges at most once: a refusal row of ANY earlier matching context binds (a receipt choice flipping between hosts settles).
 */
export function refusalContext(pr: Pick<PrInfo, 'body' | 'labels'>, receipt: Pick<Receipt, 'dir'> | null, baselineDiff?: Pick<BaselineDiff, 'receipt'> | null): string {
  const body = (pr.body ?? '').replace(/\r\n/g, '\n').trim();
  const labels = [...(pr.labels ?? [])].sort();
  return createHash('sha256').update(JSON.stringify([body, labels, receipt?.dir ?? null, baselineDiff?.receipt ?? null])).digest('hex').slice(0, 16);
}

/** The refusal that still binds this head: non-transient, same context (or a legacy row without one), no HOLD change since. */
export function stickyRefusal(rows: readonly LedgerRow[], pr: number, head: string, ctx: string): { binding?: LedgerRow; rejudged?: LedgerRow } {
  const refusals = rows.filter(x => x.pr === pr && x.head === head && x.event === 'refused' && x.cls && !legacyGuardError(x.cls, x.why)
    && (!TRANSIENT.includes(x.cls) || (x.cls === 'tsc-timeout' && tscTries(rows, pr, head) >= TSC_LAND_RETRIES)));
  const holdAfter = (r: LedgerRow) => rows.some(x => x.pr === pr && x.head === head && x.event === 'decision' && x.action === 'hold' && x.at > r.at);
  const binds = (r: LedgerRow) => (r.ctx === undefined || r.ctx === ctx) && !holdAfter(r);
  const binding = refusals.filter(binds).pop();
  return binding ? { binding } : { ...(refusals.length ? { rejudged: refusals[refusals.length - 1] } : {}) };
}

function lastFor(rows: LedgerRow[], pr: number, head: string, event: LedgerRow['event']): LedgerRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.pr === pr && rows[i]!.head === head && rows[i]!.event === event) return rows[i];
  return undefined;
}

/** The JUD veto on a PR: a holds.json mark by the veto owner, else a JUD HOLD verdict on file for this head. */
function vetoFor(d: LandDeps, holds: Record<string, { reason: string; by: string }>, pr: PrInfo): string | null {
  const own = holdVerdict(holds[String(pr.number)], d.org).block;
  if (own) return own;
  const jud = (() => { try { return d.judHold?.(pr.number, pr.head) ?? null; } catch { return null; } })();
  return jud ? holdVerdict(jud, d.org).block : null;
}

/** Refusal classes that mean «another PR on the same files moved main under this one» (hot-file churn). */
export const CHURN_REFUSALS: RefusalClass[] = ['stale-base-revert', 'merge-conflict', 'main-moved-overlap'];
const CHURN_WINDOW_MS = 2 * 3_600_000;

/**
 * Land order (THROUGHPUT-CONTROLLER · hot-file lanes · 11-26: #40285 refused 5× in one evening): a PR refused for churn
 * on an OLDER head in the last 2 h has since merged main — it is the freshest PR in its lane. It lands first, before a
 * lane-mate makes it stale again. The others keep PR-number order. The same-files overlap guard still lands one PR per
 * file per tick.
 */
export function landOrder(prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number): PrInfo[] {
  const refreshed = churnVictims(prs, rows, nowMs);
  return [...prs].sort((a, b) => (refreshed.get(b.number) ?? 0) - (refreshed.get(a.number) ?? 0) || a.number - b.number);
}
/** PR → churn refusals in the window, for PRs refused for churn on an OLDER head and not on the current one (fresh in their lane). */
export function churnVictims(prs: readonly PrInfo[], rows: readonly LedgerRow[], nowMs: number): Map<number, number> {
  const victims = new Map<number, number>();
  for (const r of rows) {
    if (r.event !== 'refused' || !r.cls || !CHURN_REFUSALS.includes(r.cls) || nowMs - Date.parse(r.at) > CHURN_WINDOW_MS) continue;
    victims.set(r.pr, (victims.get(r.pr) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (const p of prs) {
    if (!victims.has(p.number)) continue;
    if (rows.some(r => r.event === 'refused' && r.pr === p.number && r.head === p.head && r.cls && CHURN_REFUSALS.includes(r.cls))) continue;
    out.set(p.number, victims.get(p.number)!);
  }
  return out;
}

export async function tickLand(d: LandDeps): Promise<TickResult> {
  const now = d.now(); const at = now.toISOString();
  const release = d.dry ? () => {} : acquireLock(d.stateRoot);
  const out: TickResult = { mode: d.mode, locked: false, decisions: [], landed: [] };
  if (!release) return { ...out, locked: true };
  try {
    // Synthetic rows never count as real lands / cards for real PRs.
    const rows = readLedger(d.stateRoot).filter(r => !!r.synthetic === !!d.synthetic);
    const row = (r: Omit<LedgerRow, 'at' | 'mode'>) => {
      const full: LedgerRow = { at, mode: d.mode, ...r, ...(d.synthetic ? { synthetic: true } : {}) };
      if (!d.dry) appendLedger(d.stateRoot, full);
      rows.push(full);
    };
    const owner = landRefusalRecipient(d.org);
    // «세 평면»: under a terminal owner the landing owner / OP get no land mail (policy exceptions aside).
    // The PR author always keeps its own card (even when the author IS TC/OP); only the landing-owner / OP copies go.
    const authors = new Map<number, string>();
    const mailable = (to: string[], cls?: RefusalClass, author?: string) => (!d.terminalOwner || (cls && POLICY_MAIL_CLASSES.includes(cls)) ? to
      : to.filter(t => t === author || (t !== owner && t !== 'OP')));
    const sendCard = (pr: number, head: string, c: Card, key: RefusalClass) => {
      // One card per (PR, head, class): no flood on every tick.
      if (rows.some(x => x.event === 'card' && x.pr === pr && x.head === head && x.cls === key)) return;
      const to = mailable(c.to, key, authors.get(pr));
      if (!d.dry && (d.mode === 'live' || d.cardSeat)) for (const t of to) d.post(t, d.mode === 'shadow' ? `[shadow] ${c.body}` : c.body);
      row({ pr, head, event: 'card', cls: key, to, body: c.body, ...(d.terminalOwner && to.length < c.to.length ? { why: `terminal owner ${d.terminalOwner} keeps ${c.to.filter(t => !to.includes(t)).join(',')}` } : {}) });
    };
    const notice = (p: PrInfo, why: string) => {
      if (!d.terminalOwner) d.post(d.cardSeat ?? landRefusalRecipient(d.org), `[land-graph 착지 후통보] #${p.number} «${p.title}» @${p.head.slice(0, 12)} MERGED · ${why}`);
      d.record(`${at.slice(11, 16)} · #${p.number} «${p.title.slice(0, 60)}» · ${p.head.slice(0, 12)} · rc=0 · MERGED · land-graph · ${why}`);
      row({ pr: p.number, head: p.head, event: 'noticed' });
    };

    // Resume (live): landing without landed → resolve from the PR state; landed without noticed → notice.
    if (d.mode === 'live') {
      for (const r of rows.filter(x => x.event === 'landing' && x.mode === 'live')) {
        if (lastFor(rows, r.pr, r.head, 'landed') || lastFor(rows, r.pr, r.head, 'refused')) continue;
        const p = await d.prNow(r.pr).catch(() => null);
        if (p?.state === 'MERGED') { row({ pr: r.pr, head: r.head, event: 'landed', why: 'resumed: merged before crash' }); out.landed.push(r.pr); }
      }
      for (const r of rows.filter(x => x.event === 'landed' && x.mode === 'live')) {
        if (lastFor(rows, r.pr, r.head, 'noticed')) continue;
        const p = await d.prNow(r.pr).catch(() => null);
        notice(p ?? { number: r.pr, head: r.head, base: 'main', draft: false, state: 'MERGED', title: '', author: '', files: [] }, r.why ?? 'resumed');
      }
    }

    let prs: PrInfo[];
    try { prs = await d.listPrs(); for (const p of prs) authors.set(p.number, p.author); } catch (e) {
      out.error = `gh-error: ${e instanceof Error ? e.message : String(e)}`; out.skipped = 'gh-error';
      // GH-BUDGET-GOVERNOR ④ (11-28 21:4x 실측: cooldown 동안 runs «done» but this file stayed at the last full tick → «틱 정지»):
      // a skipped tick still stamps the tick file — the last full tick's numbers stay, `at` · `skipped` · `lastSkipped` say this wake.
      if (!d.dry && !d.synthetic) {
        const p = join(landHome(d.stateRoot), 'last-tick.json');
        let prev: Record<string, unknown> = {};
        try { prev = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { prev = {}; }
        try {
          mkdirSync(landHome(d.stateRoot), { recursive: true });
          writeFileSync(p, JSON.stringify({ ...prev, at, mode: d.mode, skipped: out.skipped, lastSkipped: { at, why: out.error.slice(0, 240) } }));
        } catch { /* a stamp failure must not turn a skipped tick into an exception */ }
      }
      return out;
    }
    const holds = readHolds(d.stateRoot);
    const landedPrs = new Set(rows.filter(r => r.event === 'landed').map(r => r.pr));
    const touched = new Set<string>(); let used = 0;
    const readyPrs = new Set<number>();
    const live = d.mode === 'live' && !d.dry && !d.synthetic;
    const reasons = new Map<number, string>();
    const cands: FinishCand[] = [];
    const redWhy = new Map<number, string>();
    let mergedHeadsMemo: readonly string[] | null = null;
    const parentHeads = (extra: readonly string[] = []): readonly string[] | undefined => {
      if (!d.smartMerge) return extra.length ? extra : undefined;
      if (mergedHeadsMemo === null) { try { mergedHeadsMemo = d.smartMerge.mergedHeads(); } catch { mergedHeadsMemo = []; } }
      const all = [...new Set([...extra, ...mergedHeadsMemo])];
      return all.length ? all : undefined;
    };
    const finOut: FinishOutcome[] = [];
    const cells: NonNullable<TickResult['cells']> = [];
    for (const pr0 of (d.order ?? landOrder)(prs, rows, now.getTime())) {
      let pr = pr0;
      // STACK-AUTO-RETARGET: a stacked PR whose base already merged is retargeted to main, then treated as normal.
      if (pr.base !== 'main' && pr.state === 'OPEN' && !pr.draft && d.baseMerged) {
        const merged = (() => { try { return d.baseMerged!(pr); } catch { return false; } })();
        if (merged) {
          const r = live && d.retargetToMain ? d.retargetToMain(pr) : null;
          if (!live || r?.ok) {
            finOut.push({ pr: pr.number, head: pr.head, kind: 'retarget', state: live ? 'retargeted' : 'would-run', why: `base ${pr.base} merged → main` });
            if (live) row({ pr: pr.number, head: pr.head, event: 'decision', action: 'wait', why: `retargeted ${pr.base} → main (base merged)` });
            // SMART-MERGE: the child still carries the parent's original commits — rebuild only its own onto main.
            if (d.smartMerge && d.finisher && !pr.crossRepo && pr.headRef) {
              const ph = (() => { try { return d.smartMerge!.mergedBaseHead(pr); } catch { return null; } })();
              cands.push({ pr: { ...pr, base: 'main' }, kind: 'rebuild', need: 'receipt', ...(parentHeads(ph ? [ph] : []) ? { parentHeads: parentHeads(ph ? [ph] : []) } : {}) });
              // The old head still carries the parent's commits: never land it — the rebuilt head is judged next tick.
              reasons.set(pr.number, 'wait · rebuild after retarget');
              out.decisions.push({ pr: pr.number, head: pr.head, action: 'wait', why: 'rebuild onto main after retarget', next: { owner: 'land-graph', action: 'finisher rebuild' } });
              continue;
            }
            pr = { ...pr, base: 'main' };
          } else finOut.push({ pr: pr.number, head: pr.head, kind: 'retarget', state: 'busy', why: `retarget failed: ${r?.why ?? 'no retarget dep'}` });
        }
      }
      const receipt = d.receipt(pr.number, pr.head);
      const focused = receipt && receipt.focused.length && !(receipt.grade === 'L0' && receipt.focusedExit == null) ? d.focused(receipt) : null;
      const failing = !!focused && typeof focused === 'object' && ('swept' in focused ? focused.exit !== 0 : focused.fail > 0);
      const facts: Facts = {
        pr, receipt, olderReceiptHead: receipt ? null : d.olderReceiptHead(pr.number, pr.head), focused,
        hold: vetoFor(d, holds, pr), security: d.security(pr.number, pr.head), ...(d.org ? { org: d.org } : {}),
        ...(receipt && d.terra && security4Hits(pr.files).length ? { terra: d.terra(pr.number, pr.head) } : {}),
        ...(failing && d.baselineDiff ? { baselineDiff: d.baselineDiff(pr.number, pr.head) } : {}),
        landedBefore: landedPrs.has(pr.number) && d.mode === 'live', ...(d.cardSeat ? { cardSeat: d.cardSeat } : {}),
      };
      let dec = decide(facts);
      // OUTCOME-DONE-ALARMS: «ready to land» = every gate passes for this head (before slots / overlap / in-flight waits).
      if (dec.action === 'land') readyPrs.add(pr.number);
      let cellRow: NonNullable<TickResult['cells']>[number] | null = null;
      if (dec.action === 'land' && d.cellLink) {
        const m = (() => { try { return d.cellLink!(pr); } catch { return undefined; } })();
        if (m !== undefined) {
          cellRow = m === null ? { pr: pr.number, cell: null, action: 'landed-no-cell' }
            : { pr: pr.number, cell: m.id, basis: m.basis, action: m.basis === 'already' ? 'linked' : 'would-attach' };
          cells.push(cellRow);
        }
      }
      // A gate refusal on this head sticks until a new head or a new context (no preflight re-run every tick); transient ones retry.
      const refusalCtx = refusalContext(pr, receipt, facts.baselineDiff);
      const { binding: gateRefusal, rejudged } = stickyRefusal(rows, pr.number, pr.head, refusalCtx);
      if (dec.action === 'land' && rejudged) dec = { ...dec, why: `${dec.why} · re-judge: context changed since refusal ${rejudged.cls} (body/labels/receipt/hold)` };
      const inFlight = rows.some(x => x.pr === pr.number && x.head === pr.head && x.event === 'landing')
        && !rows.some(x => x.pr === pr.number && x.head === pr.head && (x.event === 'landed' || x.event === 'refused'));
      if (dec.action === 'land' && inFlight && d.mode === 'live') dec = { action: 'wait', why: 'land in flight' };
      if (dec.action === 'land' && gateRefusal) dec = { action: 'refuse', cls: gateRefusal.cls!, why: `gate refused this head: ${gateRefusal.why ?? ''}` };
      if (dec.action === 'land' && pr.files.some(f => touched.has(f))) dec = { action: 'wait', cls: 'main-moved-overlap', why: 'same files landed this tick' };
      if (dec.action === 'land' && used >= d.slots) dec = { action: 'wait', why: `slots ${d.slots} full` };
      reasons.set(pr.number, `${dec.action}${dec.cls ? ` ${dec.cls}` : ''} · ${dec.why}`);
      if (dec.action === 'skip') continue;
      // LAND-OWNS-RECEIPT: the graph finishes mechanical last miles itself; the author card is only for what it cannot.
      const redSteps = dec.cls === 'pregate-red' && receipt?.red ? receipt.red.failed.map(s => s.name) : undefined;
      const fk = d.finisher ? finishKindFor(dec.cls, { noBaselineInReceipt: !!receipt && !receipt.focusedBaseline, ...(pr.crossRepo || !pr.headRef ? { crossRepo: true } : {}),
        ...(redSteps ? { redSteps, autofix: !!d.finisher.autofix } : {}) }) : null;
      if (fk && !cands.some(c => c.pr.number === pr.number && c.kind === 'rebuild')) { // a rebuild moves the head first
        const ph = fk === 'refresh' ? parentHeads() : undefined;
        cands.push({ pr, kind: fk, need: receipt && !receipt.red ? 'baseline' : 'receipt', ...(fk === 'pregate-retry' && receipt ? { avoidHost: receipt.host } : {}), ...(ph ? { parentHeads: ph } : {}),
          ...(fk === 'autofix' && receipt?.red ? { red: { dir: receipt.dir, failed: receipt.red.failed } } : {}) });
        if (fk === 'autofix') redWhy.set(pr.number, dec.why);
      }
      const next: NextAction | null = dec.action === 'land' ? null : dec.cls
        ? nextAction(dec.cls, pr, { finisher: fk, landingOwner: landRefusalRecipient(d.org), fixTo: fixFor(dec.cls, pr).to })
        : { owner: 'land-graph', action: 'retry next tick' }; // slots full · land in flight
      out.decisions.push({ pr: pr.number, head: pr.head, action: dec.action, ...(dec.cls ? { cls: dec.cls } : {}), why: dec.why, ...(next ? { next } : {}) });
      const prev = lastFor(rows, pr.number, pr.head, 'decision');
      if (!prev || prev.action !== dec.action || prev.cls !== dec.cls) row({ pr: pr.number, head: pr.head, event: 'decision', action: dec.action, ...(dec.cls ? { cls: dec.cls } : {}), why: dec.why, ...(next ? { next } : {}) });
      if (dec.card && dec.cls && !fk) sendCard(pr.number, pr.head, dec.card, dec.cls);
      // Stall: ready to land but not landed for 30 min → JUD + OP once.
      const firstReady = rows.find(x => x.pr === pr.number && x.head === pr.head && x.event === 'decision' && x.action === 'land');
      if (dec.action !== 'land' && firstReady && now.getTime() - Date.parse(firstReady.at) > STALL_MIN * 60_000 && !lastFor(rows, pr.number, pr.head, 'stall')) {
        row({ pr: pr.number, head: pr.head, event: 'stall', why: dec.why });
        if (!d.dry && (d.mode === 'live' || d.cardSeat)) for (const to of mailable(d.cardSeat ? [d.cardSeat] : [owner])) d.post(to, `[land-graph · stall] #${pr.number} ready ${STALL_MIN}+ min, not landed: ${dec.why}`);
      }
      if (dec.action !== 'land') continue;
      used++; pr.files.forEach(f => touched.add(f));
      if (d.mode === 'shadow' || d.dry) continue;

      // Live: re-check head and hold right before the merge (head moved / JUD hold mid-land).
      const fresh = await d.prNow(pr.number).catch(() => null);
      if (!fresh) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'gh-error', why: 'pr re-read failed' }); continue; }
      if (fresh.state !== 'OPEN' || fresh.draft) { row({ pr: pr.number, head: pr.head, event: 'refused', why: `flipped to ${fresh.draft ? 'draft' : fresh.state} mid-run` }); continue; }
      if (fresh.head !== pr.head) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'head-moved', why: `head → ${fresh.head.slice(0, 12)}` }); continue; }
      // The guard reads the re-read body (declared removals) — the refusal binds to that context.
      const ctxNow = refusalContext(fresh, receipt, facts.baselineDiff);
      const holdNow = vetoFor(d, readHolds(d.stateRoot), pr);
      if (holdNow) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'held', why: holdNow }); continue; }
      // Stale-base revert guard before every merge (fail closed: a throwing guard refuses).
      const sr = (() => { try { return d.staleRevert ? d.staleRevert(fresh) : { ok: true }; } catch (e) { return { ok: false, why: `guard error: ${String(e).slice(0, 300)}` }; } })();
      // GUARD-ERROR: a guard that could not run is not a stale-base revert — conflict → merge-conflict (finisher refresh) · else transient.
      const ge = sr.ok ? null : guardErrorClass(sr.why ?? '');
      if (ge) {
        row({ pr: pr.number, head: pr.head, event: 'refused', cls: ge, why: (sr.why ?? '').slice(0, 200), ctx: ctxNow });
        if (ge === 'merge-conflict' && d.finisher && !pr.crossRepo && pr.headRef) { const ph = parentHeads(); cands.push({ pr, kind: 'refresh', need: 'receipt', ...(ph ? { parentHeads: ph } : {}) }); }
        continue;
      }
      if (!sr.ok) {
        row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'stale-base-revert', why: sr.why ?? 'stale-base revert', ctx: ctxNow });
        // SMART-MERGE: the finisher rebuilds / merges main itself (its revert guard decides); the card only without it.
        if (d.smartMerge && d.finisher && !pr.crossRepo && pr.headRef) { const ph = parentHeads(); cands.push({ pr, kind: 'refresh', need: 'receipt', ...(ph ? { parentHeads: ph } : {}) }); }
        else sendCard(pr.number, pr.head, card('stale-base-revert', pr, sr.why ?? '', d.cardSeat, d.org), 'stale-base-revert');
        continue;
      }
      // LAND-CELL-LINK: attach the PR to its cell before the merge (never blocks the land).
      if (cellRow?.action === 'would-attach' && cellRow.cell && d.attachCell) {
        const a = (() => { try { return d.attachCell!(cellRow!.cell!, pr); } catch (e) { return { ok: false, why: String(e).slice(0, 120) }; } })();
        cellRow.action = a.ok ? 'attached' : 'attach-failed';
        if (a.why) cellRow.why = a.why;
      }
      row({ pr: pr.number, head: pr.head, event: 'landing' });
      const ctx = { ...(dec.lane ? { lane: dec.lane } : {}), baselineDiff: facts.baselineDiff ?? null, tscAttempt: tscTries(rows, pr.number, pr.head) };
      let res = await d.land(pr, receipt!, dec.why, ctx).catch(e => ({ rc: 99, text: String(e) }));
      let cls = classifyLandExit(res.rc, res.text);
      let after = await d.prNow(pr.number).catch(() => null);
      // Base changed mid-merge → retry once on the new main (the land command re-merges), then refuse with a card.
      // A JUD veto that arrived during the (long) land command stops the retry too.
      const holdRetry = cls === 'merge-conflict' && after?.state !== 'MERGED' ? vetoFor(d, readHolds(d.stateRoot), pr) : null;
      if (holdRetry) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'held', why: holdRetry, ctx: ctxNow }); continue; }
      if (cls === 'merge-conflict' && after?.state !== 'MERGED' && after?.head === pr.head) {
        row({ pr: pr.number, head: pr.head, event: 'decision', action: 'land', why: 'base changed mid-merge · retry once' });
        res = await d.land(pr, receipt!, `${dec.why} · retry`, ctx).catch(e => ({ rc: 99, text: String(e) }));
        cls = classifyLandExit(res.rc, res.text);
        after = await d.prNow(pr.number).catch(() => null);
      }
      if (cls && after?.state !== 'MERGED') {
        row({ pr: pr.number, head: pr.head, event: 'refused', cls, why: res.text.split('\n').filter(l => /STOP|REFUSE/.test(l)).pop() ?? `rc=${res.rc}`, ctx: ctxNow });
        // SMART-MERGE: a land-time conflict with main is the finisher's — smart refresh this tick (resolved push or a
        // needs-finisher card with the hunks), no author card.
        if ((cls === 'merge-conflict' || cls === 'stale-base-revert') && d.smartMerge && d.finisher && !pr.crossRepo && pr.headRef) {
          if (!cands.some(c => c.pr.number === pr.number && (c.kind === 'refresh' || c.kind === 'rebuild'))) { const ph = parentHeads(); cands.push({ pr, kind: 'refresh', need: 'receipt', ...(ph ? { parentHeads: ph } : {}) }); }
          continue;
        }
        // TSC-TIMEOUT at land time: retried next tick on the next host; the RES card only once the retries are spent.
        if (cls !== 'tsc-timeout' || tscTries(rows, pr.number, pr.head) >= TSC_LAND_RETRIES) sendCard(pr.number, pr.head, card(cls, pr, `rc=${res.rc}`, d.cardSeat, d.org), cls);
        continue;
      }
      row({ pr: pr.number, head: pr.head, event: 'landed', why: dec.why, doneAt: d.now().toISOString() }); out.landed.push(pr.number);
      notice(pr, dec.why);
    }
    // Finisher pass: settle running pregates, then launch / refresh this tick's candidates (bounded · deduped by head).
    if (d.finisher) {
      const book = readBook(d.stateRoot);
      const fd: FinishDeps = { ...d.finisher, now: d.now, hasReceipt: (n, h) => { try { const r = d.receipt(n, h); return r ? { baseline: !!r.focusedBaseline, tscTimeout: !!redVerdict(r)?.tscTimeout } : null; } catch { return null; } } };
      const cur = new Map(prs.map(p => [p.number, p] as const));
      for (const j of settle(book, { ...fd, headNow: n => cur.get(n)?.head })) {
        const p = cur.get(j.pr);
        if (j.state !== 'failed' || !p || p.head !== j.head) continue;
        if (j.kind === 'refresh' || j.kind === 'rebuild') sendCard(p.number, p.head, card('needs-finisher', p, j.why ?? 'LLM capsule failed', d.cardSeat, d.org), 'needs-finisher');
        else if (j.kind === 'pregate-retry') sendCard(p.number, p.head, card('tsc-timeout', p, `${j.avoidHost ?? '?'} and the retry host`, d.cardSeat, d.org), 'tsc-timeout');
        else sendCard(p.number, p.head, card('needs-finisher', p, j.why ?? 'pregate failed', d.cardSeat, d.org), 'needs-finisher');
      }
      for (const o of runFinisher(book, cands, fd, live)) {
        finOut.push(o);
        const p = cur.get(o.pr);
        // AUTOFIX: not mechanical, or the author is still on it → the author's own pregate-red card (deferred at decide time).
        if (o.kind === 'autofix' && (o.state === 'failed' || o.state === 'author-active') && p) sendCard(p.number, p.head, card('pregate-red', p, `${redWhy.get(p.number) ?? ''} · ${o.why}`.slice(0, 600), d.cardSeat, d.org), 'pregate-red');
        else if ((o.state === 'conflict' || o.state === 'failed') && p) sendCard(p.number, p.head, card('needs-finisher', p, o.why, d.cardSeat, d.org), 'needs-finisher');
      }
      out.autofixPerHour = autofixesPerHour(Object.values(book.jobs), now.getTime());
      if (live) writeBook(d.stateRoot, book);
    }
    out.finisher = finOut;
    out.cells = cells;
    out.ready = readyPrs.size;
    // STALE-PR-24H: every open PR older than 24 h with its reason · reap only what is provably already in main.
    out.stale = stalePrs(prs, reasons, now.getTime());
    if (d.reap && d.superseded) {
      out.reaped = [];
      const byNo = new Map(prs.map(p => [p.number, p] as const));
      for (const s of out.stale) {
        const p = byNo.get(s.pr)!;
        const sup = (() => { try { return d.superseded!(p); } catch { return false; } })();
        if (!sup) continue;
        const why = `open ${s.ageH}h · its whole diff is already in main (superseded)`;
        if (d.reap !== 'apply' || !d.closePr) { out.reaped.push({ pr: s.pr, action: 'would-close', why }); continue; }
        const r = d.closePr(p, `[land-graph · STALE-PR-24H] closing: ${why}. Reopen if something is missing.`);
        out.reaped.push({ pr: s.pr, action: r.ok ? 'closed' : 'close-failed', why: r.ok ? why : `${why} · ${r.why ?? ''}` });
      }
    }
    if (d.prAging) out.aging = ageZombies(d, prs, rows, row, now.getTime(), live);
    const agingBy = (a: AgingRow['action']) => (out.aging ?? []).filter(x => x.action === a).map(x => x.pr);
    if (!d.dry && !d.synthetic) writeFileSync(join(landHome(d.stateRoot), 'last-tick.json'), JSON.stringify({ at, mode: d.mode, decisions: out.decisions.length, landed: out.landed,
      ready: readyPrs.size, readyNotLanded: [...readyPrs].filter(pr => !out.landed.includes(pr)).length,
      ...(out.aging ? { aging: { drafted: agingBy('drafted'), wouldDraft: agingBy('would-draft'), draftFailed: agingBy('draft-failed'), deferred: agingBy('deferred'),
        closeProposals: [...agingBy('proposed'), ...agingBy('proposed-before'), ...agingBy('would-propose')] } } : {}) }));
    return out;
  } finally { release(); }
}

/**
 * PR-ZOMBIE-AGING: age every open PR with the kit's verdict (graphs/policies/pr-aging.yaml). to-draft → live: `toDraft` then
 * one card per (PR · head · stage) to the YAML's card_to · capped per tick; close-proposal → one card (never a close).
 * Non-live (shadow · plan · synthetic) reports would-draft / would-propose and writes nothing. A failed draft is retried next tick.
 */
function ageZombies(d: LandDeps, prs: readonly PrInfo[], rows: readonly LedgerRow[], row: (r: Omit<LedgerRow, 'at' | 'mode'>) => void, nowMs: number, live: boolean): AgingRow[] {
  const pol = d.prAging!;
  const open = prs.filter(p => p.state === 'OPEN');
  const times = (() => { try { return d.headTimes ? d.headTimes(open.map(p => p.head)) : new Map<string, number>(); } catch { return new Map<string, number>(); } })();
  const steps = (p: PrInfo) => { try { return d.redSteps ? d.redSteps(p.number, p.head) : []; } catch { return []; } };
  const verdicts = judgePrAging(open.map(p => ({
    pr: p.number, head: p.head, draft: p.draft, author: p.author, headAt: headAtOf(times.get(p.head), p.updatedAt),
    conflict: conflictEvidence({ redFailedSteps: steps(p), landRefusals: rows.filter(r => r.pr === p.number && r.head === p.head && r.event === 'refused' && r.cls).map(r => r.cls!) }, pol),
  })), pol, nowMs);
  const byNo = new Map(open.map(p => [p.number, p] as const));
  const owner = landRefusalRecipient(d.org);
  const out: AgingRow[] = [];
  let drafted = 0;
  for (const v of verdicts) {
    const p = byNo.get(v.pr)!;
    const base = { pr: v.pr, head: v.head, stage: v.stage, ageDays: v.ageDays, basis: v.basis, conflict: v.conflict, why: v.why };
    const roles = v.stage === 'to-draft' ? pol.toDraft.cardTo : pol.closeProposal.cardTo;
    const to = [...new Set(roles.map(r => (r === 'author' ? p.author || owner : owner)))];
    const carded = rows.some(r => r.event === 'aging' && r.pr === v.pr && r.head === v.head && r.stage === v.stage);
    const send = () => { for (const t of to) d.post(t, agingCard(v, p.title)); row({ pr: v.pr, head: v.head, event: 'aging', stage: v.stage, to, why: v.why }); };
    if (v.stage === 'close-proposal') {
      if (carded) out.push({ ...base, action: 'proposed-before' });
      else if (!live) out.push({ ...base, action: 'would-propose', to });
      else { send(); out.push({ ...base, action: 'proposed', to }); }
      continue;
    }
    if (!live || !d.toDraft) { out.push({ ...base, action: 'would-draft', to }); continue; }
    if (drafted >= pol.toDraft.maxPerTick) { out.push({ ...base, action: 'deferred', why: `${v.why} · per-tick cap ${pol.toDraft.maxPerTick}` }); continue; }
    const r = (() => { try { return d.toDraft!(p); } catch (e) { return { ok: false, why: String(e).slice(0, 160) }; } })();
    if (!r.ok) { out.push({ ...base, action: 'draft-failed', why: `${v.why} · ${r.why ?? 'gh failed'}` }); continue; }
    drafted++;
    if (!carded) send();
    out.push({ ...base, action: 'drafted', to });
  }
  return out;
}

// ── Replay (shadow comparison against 11-25 coach landings) ────────────────────────────────────────────────────

export interface ReplayRow { pr: number; attempt: string; actualRc: number; actual: string; graph: Action; cls?: RefusalClass; match: boolean; note?: string }

/** Graph decision for one recorded coach-land attempt: its STOP text / exit → class; rc 0 MERGED → land. */
export function replayAttempt(pr: number, attempt: string, rc: number, state: string, text: string, docOnly: boolean): ReplayRow {
  let cls = classifyLandExit(rc, text);
  if (rc !== 0 && /STOP focused 원문 불명\/실패:\s*$/m.test(text) && docOnly) cls = null; // L0 doc-only lane
  const merged = state === 'MERGED';
  // rc≠0 yet MERGED = a post-merge step (notice/refresh) failed — the land itself happened.
  const graph: Action = cls === null || merged ? 'land' : cls === 'no-receipt' || cls === 'focused-unreadable' ? 'wait' : cls === 'held' ? 'hold' : 'refuse';
  const actual = merged ? 'MERGED' : `STOP rc=${rc}`;
  const match = (graph === 'land') === merged;
  return { pr, attempt, actualRc: rc, actual, graph, ...(cls && !merged ? { cls } : {}), match, ...(!match && docOnly ? { note: 'intended: L0 doc-only lane lands with receipt' } : {}) };
}
