/**
 * Land graph — «judge → land» under judge-kingdom autonomy (대표 11-25 20:3x).
 *
 * Golden path = what Claude OP did by hand ~20× on 11-25 through seat-state/OPS/tools/coach-land.sh →
 * seat-state/OP/tools/op-direct-land-v2.sh:
 *   ① same-head pregate receipt (RES/evidence/PREGATE-GREEN/<PR>-<head12>-<host>/) whose focused raw says 0 fail
 *   ② ratchet · tsc · isolation preflight on the merge result (op-direct-land-v2.sh — the SAME command, not a copy)
 *   ③ Terra findings: only the security-4 classes bind (real bugs fixed by the author, edges → FU)
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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateLandVetoes, landRefusalRecipient, type VetoKind, type VetoMark } from '../org/land-authority.js';
import type { OrgDeps } from '../org/org-map.js';

export type Mode = 'shadow' | 'live';

export interface PrInfo {
  number: number; head: string; base: string; draft: boolean; state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string; author: string; files: string[];
}
export interface Receipt {
  dir: string; head: string; host: string; focused: string[]; rawDir: string;
  /** exit of the receipt's own `focused` step (pregate records it in steps[]); null when the receipt has no focused step. */
  focusedExit?: number | null;
  /** rawSha256['focused.raw'] of the receipt — a local raw copy counts only when its SHA matches. */
  focusedSha?: string;
}
/** Parsed bun summary of the focused raw · or `swept`: the raw is gone (pregate rawDir is a host temp dir) and only the receipt's step exit is left. */
export type Focused = { pass: number; fail: number } | { swept: true; exit: number } | 'unreadable';
export const focusedCounts = (f: Focused | null): { pass: number; fail: number } | null => (f && typeof f === 'object' && 'pass' in f ? f : null);

export type RefusalClass =
  | 'no-receipt' | 'stale-head' | 'focused-unreadable' | 'baseline-failing-focused' | 'no-focused-stage'
  | 'isolation-gate' | 'test-interference' | 'tsc' | 'merge-conflict' | 'base-not-main' | 'review-disposition'
  | 'security-finding' | 'review-required' | 'held' | 'stale-base-revert' | 'head-moved' | 'main-moved-overlap' | 'gh-error' | 'land-error';

export type Action = 'land' | 'refuse' | 'wait' | 'hold' | 'skip';
export interface Decision { action: Action; cls?: RefusalClass; why: string; lane?: 'L0-doc-only' | 'normal'; card?: Card }
export interface Card { to: string[]; body: string }

/** Files whose change needs a JUD review before autonomy lands it (L3 hot files). */
export const HOT_FILES = ['src/index.ts', 'src/entry.ts', 'bin/elanous.mjs', 'package.json'];
/** Terra finding categories that bind (memory rule 11-25: only security-4 bind; other findings → FU). */
export const SECURITY4 = ['secret', 'auth', 'injection', 'sandbox'];

export const isDocOnly = (files: string[]) => files.length > 0 && files.every(f => /\.md$/i.test(f) || f.startsWith('docs/'));

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
    case 'review-required': return { to: 'JUD', fix: `L3 hot file changed (${extra}) — JUD review verdict needed before autonomy lands it` };
    case 'held': return { to: 'OP', fix: `held: ${extra} — \`eln land unhold ${pr.number}\` when cleared` };
    case 'stale-base-revert': return { to: 'author', fix: `the merge result wipes out recent main commits (${extra}) — \`git fetch && git merge origin/main\`, keep their lines, push, re-run pregate` };
    case 'head-moved': return { to: 'author', fix: 'head moved during the land — the graph re-evaluates the new head after its pregate receipt' };
    case 'main-moved-overlap': return { to: 'OP', fix: 'another PR touching the same files landed this tick — re-preflight on the new main next tick' };
    case 'gh-error': return { to: 'OP', fix: `GitHub API error (${extra}) — retried next tick` };
    case 'land-error': return { to: 'OP', fix: `land command failed (${extra}) — read the land log` };
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
  let lane: Decision['lane'] = 'normal';
  if (f.receipt.focused.length === 0) {
    if (!isDocOnly(pr.files)) return { action: 'refuse', cls: 'no-focused-stage', why: 'empty focused set on a code PR', card: c('no-focused-stage') };
    lane = 'L0-doc-only';
  } else {
    if (f.focused && typeof f.focused === 'object' && 'swept' in f.focused) {
      if (f.focused.exit !== 0) return { action: 'refuse', cls: 'baseline-failing-focused', why: `focused step exit ${f.focused.exit} (raw swept)`, card: c('baseline-failing-focused', `exit ${f.focused.exit}`) };
      return { action: 'wait', cls: 'focused-unreadable', why: 'focused raw swept (receipt step exit 0) — re-run pregate', card: c('focused-unreadable', `${f.receipt.host} temp rawDir swept`) };
    }
    if (f.focused === null || f.focused === 'unreadable') return { action: 'wait', cls: 'focused-unreadable', why: 'focused raw unreadable', card: c('focused-unreadable', f.receipt.host) };
    if (f.focused.fail > 0 || f.focused.pass === 0) return { action: 'refuse', cls: 'baseline-failing-focused', why: `focused ${f.focused.pass} pass ${f.focused.fail} fail`, card: c('baseline-failing-focused', `${f.focused.fail} fail`) };
  }
  if (f.security.length) return { action: 'refuse', cls: 'security-finding', why: f.security.join(','), card: c('security-finding', f.security.join(', ')) };
  const hot = pr.files.filter(x => HOT_FILES.includes(x));
  if (hot.length) return { action: 'refuse', cls: 'review-required', why: `hot ${hot.join(',')}`, card: c('review-required', hot.join(', ')) };
  const counts = focusedCounts(f.focused);
  const focusedTxt = counts ? `focused ${counts.pass}/0` : 'doc-only L0';
  return { action: 'land', lane, why: `same-head receipt ${f.receipt.dir.split('/').pop()} · ${focusedTxt}` };
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
  event: 'decision' | 'landing' | 'landed' | 'noticed' | 'refused' | 'card' | 'stall';
  action?: Action; cls?: RefusalClass; why?: string; to?: string[]; body?: string; synthetic?: boolean;
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
export function clearHold(stateRoot: string, pr: number): boolean {
  const h = readHolds(stateRoot); if (!h[String(pr)]) return false;
  delete h[String(pr)]; writeFileSync(holdsPath(stateRoot), JSON.stringify(h, null, 2)); return true;
}

/** Single tick lock (O_EXCL); a lock older than 60 min (file-system clock · > one live land of ≤ 40 min) is stale (crashed tick) and is taken over. */
export function acquireLock(stateRoot: string, nowMs = Date.now()): (() => void) | null {
  mkdirSync(landHome(stateRoot), { recursive: true });
  const p = join(landHome(stateRoot), 'tick.lock');
  try {
    if (existsSync(p) && nowMs - statSync(p).mtimeMs > 60 * 60_000) rmSync(p, { force: true });
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
  /** Live only: the golden-path land command (op-direct-land-v2.sh with the coach extra.json). */
  land(pr: PrInfo, r: Receipt, why: string): Promise<{ rc: number; text: string }>;
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
}

export interface TickResult { mode: Mode; locked: boolean; decisions: Array<{ pr: number; head: string; action: Action; cls?: RefusalClass; why: string }>; landed: number[]; error?: string }

const STALL_MIN = 30;
const TRANSIENT: RefusalClass[] = ['head-moved', 'gh-error', 'main-moved-overlap', 'held', 'land-error'];

function lastFor(rows: LedgerRow[], pr: number, head: string, event: LedgerRow['event']): LedgerRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.pr === pr && rows[i]!.head === head && rows[i]!.event === event) return rows[i];
  return undefined;
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
    const sendCard = (pr: number, head: string, c: Card, key: RefusalClass) => {
      // One card per (PR, head, class): no flood on every tick.
      if (rows.some(x => x.event === 'card' && x.pr === pr && x.head === head && x.cls === key)) return;
      if (!d.dry && (d.mode === 'live' || d.cardSeat)) for (const to of c.to) d.post(to, d.mode === 'shadow' ? `[shadow] ${c.body}` : c.body);
      row({ pr, head, event: 'card', cls: key, to: c.to, body: c.body });
    };
    const notice = (p: PrInfo, why: string) => {
      d.post(d.cardSeat ?? landRefusalRecipient(d.org), `[land-graph 착지 후통보] #${p.number} «${p.title}» @${p.head.slice(0, 12)} MERGED · ${why}`);
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
    try { prs = await d.listPrs(); } catch (e) {
      out.error = `gh-error: ${e instanceof Error ? e.message : String(e)}`; return out;
    }
    const holds = readHolds(d.stateRoot);
    const landedPrs = new Set(rows.filter(r => r.event === 'landed').map(r => r.pr));
    const touched = new Set<string>(); let used = 0;
    for (const pr of prs.sort((a, b) => a.number - b.number)) {
      const receipt = d.receipt(pr.number, pr.head);
      const facts: Facts = {
        pr, receipt, olderReceiptHead: receipt ? null : d.olderReceiptHead(pr.number, pr.head),
        focused: receipt && receipt.focused.length ? d.focused(receipt) : null,
        hold: holdVerdict(holds[String(pr.number)], d.org).block, security: d.security(pr.number, pr.head), ...(d.org ? { org: d.org } : {}),
        landedBefore: landedPrs.has(pr.number) && d.mode === 'live', ...(d.cardSeat ? { cardSeat: d.cardSeat } : {}),
      };
      let dec = decide(facts);
      // A gate refusal on this head sticks until a new head (no preflight re-run every tick); transient ones retry.
      const gateRefusal = rows.filter(x => x.pr === pr.number && x.head === pr.head && x.event === 'refused' && x.cls && !TRANSIENT.includes(x.cls)).pop();
      const inFlight = rows.some(x => x.pr === pr.number && x.head === pr.head && x.event === 'landing')
        && !rows.some(x => x.pr === pr.number && x.head === pr.head && (x.event === 'landed' || x.event === 'refused'));
      if (dec.action === 'land' && inFlight && d.mode === 'live') dec = { action: 'wait', why: 'land in flight' };
      if (dec.action === 'land' && gateRefusal) dec = { action: 'refuse', cls: gateRefusal.cls!, why: `gate refused this head: ${gateRefusal.why ?? ''}` };
      if (dec.action === 'land' && pr.files.some(f => touched.has(f))) dec = { action: 'wait', cls: 'main-moved-overlap', why: 'same files landed this tick' };
      if (dec.action === 'land' && used >= d.slots) dec = { action: 'wait', why: `slots ${d.slots} full` };
      if (dec.action === 'skip') continue;
      out.decisions.push({ pr: pr.number, head: pr.head, action: dec.action, ...(dec.cls ? { cls: dec.cls } : {}), why: dec.why });
      const prev = lastFor(rows, pr.number, pr.head, 'decision');
      if (!prev || prev.action !== dec.action || prev.cls !== dec.cls) row({ pr: pr.number, head: pr.head, event: 'decision', action: dec.action, ...(dec.cls ? { cls: dec.cls } : {}), why: dec.why });
      if (dec.card && dec.cls) sendCard(pr.number, pr.head, dec.card, dec.cls);
      // Stall: ready to land but not landed for 30 min → JUD + OP once.
      const firstReady = rows.find(x => x.pr === pr.number && x.head === pr.head && x.event === 'decision' && x.action === 'land');
      if (dec.action !== 'land' && firstReady && now.getTime() - Date.parse(firstReady.at) > STALL_MIN * 60_000 && !lastFor(rows, pr.number, pr.head, 'stall')) {
        row({ pr: pr.number, head: pr.head, event: 'stall', why: dec.why });
        if (!d.dry && (d.mode === 'live' || d.cardSeat)) for (const to of d.cardSeat ? [d.cardSeat] : [landRefusalRecipient(d.org)]) d.post(to, `[land-graph · stall] #${pr.number} ready ${STALL_MIN}+ min, not landed: ${dec.why}`);
      }
      if (dec.action !== 'land') continue;
      used++; pr.files.forEach(f => touched.add(f));
      if (d.mode === 'shadow' || d.dry) continue;

      // Live: re-check head and hold right before the merge (head moved / JUD hold mid-land).
      const fresh = await d.prNow(pr.number).catch(() => null);
      if (!fresh) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'gh-error', why: 'pr re-read failed' }); continue; }
      if (fresh.state !== 'OPEN' || fresh.draft) { row({ pr: pr.number, head: pr.head, event: 'refused', why: `flipped to ${fresh.draft ? 'draft' : fresh.state} mid-run` }); continue; }
      if (fresh.head !== pr.head) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'head-moved', why: `head → ${fresh.head.slice(0, 12)}` }); continue; }
      const holdNow = holdVerdict(readHolds(d.stateRoot)[String(pr.number)], d.org).block;
      if (holdNow) { row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'held', why: holdNow }); continue; }
      // Stale-base revert guard before every merge (fail closed: a throwing guard refuses).
      const sr = (() => { try { return d.staleRevert ? d.staleRevert(fresh) : { ok: true }; } catch (e) { return { ok: false, why: `guard error: ${String(e).slice(0, 120)}` }; } })();
      if (!sr.ok) {
        row({ pr: pr.number, head: pr.head, event: 'refused', cls: 'stale-base-revert', why: sr.why ?? 'stale-base revert' });
        sendCard(pr.number, pr.head, card('stale-base-revert', pr, sr.why ?? '', d.cardSeat, d.org), 'stale-base-revert');
        continue;
      }
      row({ pr: pr.number, head: pr.head, event: 'landing' });
      let res = await d.land(pr, receipt!, dec.why).catch(e => ({ rc: 99, text: String(e) }));
      let cls = classifyLandExit(res.rc, res.text);
      let after = await d.prNow(pr.number).catch(() => null);
      // Base changed mid-merge → retry once on the new main (the land command re-merges), then refuse with a card.
      if (cls === 'merge-conflict' && after?.state !== 'MERGED' && after?.head === pr.head) {
        row({ pr: pr.number, head: pr.head, event: 'decision', action: 'land', why: 'base changed mid-merge · retry once' });
        res = await d.land(pr, receipt!, `${dec.why} · retry`).catch(e => ({ rc: 99, text: String(e) }));
        cls = classifyLandExit(res.rc, res.text);
        after = await d.prNow(pr.number).catch(() => null);
      }
      if (cls && after?.state !== 'MERGED') {
        row({ pr: pr.number, head: pr.head, event: 'refused', cls, why: res.text.split('\n').filter(l => /STOP|REFUSE/.test(l)).pop() ?? `rc=${res.rc}` });
        sendCard(pr.number, pr.head, card(cls, pr, `rc=${res.rc}`, d.cardSeat, d.org), cls);
        continue;
      }
      row({ pr: pr.number, head: pr.head, event: 'landed', why: dec.why }); out.landed.push(pr.number);
      notice(pr, dec.why);
    }
    if (!d.dry && !d.synthetic) writeFileSync(join(landHome(d.stateRoot), 'last-tick.json'), JSON.stringify({ at, mode: d.mode, decisions: out.decisions.length, landed: out.landed }));
    return out;
  } finally { release(); }
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
