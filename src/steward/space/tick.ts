import { liveStewardCaps } from '../live-caps.js';
// STEWARD-SPACE (행정관) — the graph node runner for `graphs/steward/space.yaml`. Every node is `cmd:` and deterministic.
//   r0 snapshot → r1 match → r2 receipt → r3 judge → r4 land (hand-off) → r5 watch → r6 digest → x exceptions
// Input (graph `--input` or event payload): { scope?: "<coordinator seat>", shadow?: true, seat?: "<seat>" }. No scope =
// every scope the federation ladder knows (sub-coordinators first, HQ last — HQ reads the cells they could not staff). A scope runs
// only when its mode is shadow/live (config `loops.stewardSpace`), or when the input says shadow.
// Shadow = rows («would do») and the scope's shadow state/ledger only: no mail, no owner change, no pregate.
// Degrade (LOOP-AGENTS §2 rule 8): a run that never reached `x` counts as a failed tick; two in a row → one mail to HQ
// «[행정관] steward L1 stopped» (only when some scope is live), cleared by the next complete tick.

import { hqBlockLines } from '../../fed-state/kpi.js';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { spawnElanousSync } from '../../instance/spawn-elanous.js';
import { defaultMsgStorePath, openMsgStore } from '../../msg/msg-store.js';
import { loadHqPolicy, loadLiveR1Policy, recordHqShadow } from './hq-shadow.js';
import { parseSeatAssignOutput } from '../../resource-opt/steward-live.js';
import { STEWARD_UNAVAILABLE } from '../../resource-opt/steward.js';
import { listChecklist, swapOwnerIf } from '../../release-loop/checklist.js';
import { claimSeatWake, defaultWakeLedgerPath } from '../../seat/wake-ledger.js';
import { lastTurnAt } from '../../msg/diverted-mail.js';
import { getUserConfig } from '../../user-config/reader.js';
import { PROFILE_NODES, resolveScope, STEWARD_SPACE_DEFAULTS as D, type ResolvedScope, type StewardSpaceConfig } from './config.js';
import {
  digestCounts, digestDue, emptyScopeState, EXCEPTION_ACTIONS, exceptionCard, poolImbalanceLine, exceptionRows, judgeKey, planHandoff, planJudge, planMatch, planReceipts, planWatch,
  rollupLine, scopeOf, scopesOf, type Row, type ScopeState, type Snapshot,
} from './model.js';
import { buildSnapshot, liveSources, missingFor, type SnapshotSources } from './sources.js';
import { filterRoutable, hostsFor } from '../../kit/resource-facts/index.js';

export const STEWARD_SPACE_NODES = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'x'] as const;
export type StewardSpaceNode = typeof STEWARD_SPACE_NODES[number];
export const STEWARD_SENDER = 'ORCHESTRATOR';

export interface StewardMail { to: string; body: string; kind: string; intent: 'request' | 'info' | 'alert'; refs: string[] }

/** Everything that changes the world. Shadow never calls these. */
export interface StewardEffects {
  mail(mail: StewardMail): void;
  /** Owner change ⊕ structured assignment mail. */
  assignCell(input: { version: string; cellId: string; seat: string; actor: string; why: string }): { ok: true; via: string } | { ok: false; error: string };
  dispatchPregate(input: { pr: number; head12: string; host: string; logPath: string }): { ok: true } | { ok: false; error: string };
  /** Lease reclaim: owner → none, only while the owner is still `owner` (compare-and-set). */
  releaseCell(input: { version: string; cellId: string; owner: string; actor: string; why: string }): { ok: true } | { ok: false; error: string };
  /** SHARED-WAKE-LEDGER claim (20 min, any waker). Absent = no shared ledger (tests, older callers). */
  /**
   * BEACON-LADDER — OP 행정관 = 봉화 감시: scan every space's open ✋, fire the single OP exception card ⊕ dormant
   * auto-answer (src/msg/hand-raise-ladder.ts beaconHands). Absent = no watch (tests, older callers).
   */
  /** WRITER-CHECK-RESOLVER — answers the writer/handover/worktree/slot/RES ✋ family itself before the beacon (writer-resolver.ts). */
  writerCheck?(input: { live: boolean }): { line: string; resolved: number; cards: number };
  beacon?(input: { live: boolean }): { line: string; fired: readonly { leadId: number; leader: string; seat: string; why: string; cardId: number }[] };
  claimWake?(input: { seat: string; cell: string; by: string; lastActivityMs?: number | null }): { ok: true } | { ok: false; line: string; unanswered?: { count: number; raise: boolean } };
  /** OP-TAB-FIRST (STEWARD-HQ-LIVE-ALIGN): the cell's owner and the hand's cells NOW (a fresh board read) — absent = no
   *  re-check (tests, older callers). */
  boardNow?(version: string): readonly { id: string; status: string; owner?: string }[];
}

/** Before a live assign: did OP's tab (or anyone) change the cell, or give the hand a cell, since the snapshot? A reason
 *  string = skip (OP's tab wins · a hand already holding work is never re-assigned) · null = go. */
export function recheckAssign(board: readonly { id: string; status: string; owner?: string }[], input: { cellId: string; expectedOwner: string | undefined; seat: string; heldAtSnapshot?: readonly string[] }): string | null {
  const norm = (o: string | undefined): string => { const s = (o ?? '').split('/')[0]!.trim().toUpperCase(); return s === '-' || s === 'NONE' ? '' : s; };
  const cell = board.find((c) => c.id === input.cellId);
  if (!cell) return 'cell-gone';
  if (cell.status !== 'yellow') return `status-now:${cell.status}`;
  if (norm(cell.owner) !== norm(input.expectedOwner)) return `owner-now:${norm(cell.owner) || 'none'}`;
  // A cell the hand already held in the snapshot (e.g. one waiting on JUD — the planner counted it as no work) is not new;
  // only a cell it got since the snapshot (OP's tab) stops this assign.
  const before = new Set(input.heldAtSnapshot ?? []);
  const held = board.find((c) => c.status === 'yellow' && c.id !== input.cellId && !before.has(c.id) && norm(c.owner) === input.seat.trim().toUpperCase());
  return held ? `hand-holds:${held.id}` : null;
}

export interface TickDeps {
  readonly root: string;
  readonly now: () => Date;
  readonly config: StewardSpaceConfig | undefined;
  readonly sources: (config: StewardSpaceConfig | undefined, nowMs: number) => SnapshotSources;
  /** Verified pool-based reclaim limit; null or a thrown lookup means unknown and skips reclaim. */
  readonly reclaimLimit?: () => number | null;
  readonly effects: StewardEffects;
  /** The live R1 policy read (absent = graphs/policies/steward-hq.yaml via loadLiveR1Policy) — sims inject a broken file. */
  readonly liveR1?: () => ReturnType<typeof loadLiveR1Policy>;
}

export interface TickInput { readonly runId: string; readonly scope?: string; readonly shadow?: boolean; readonly seat?: string }

interface ScopeTick { idleLeft: string[]; escalations: Row[]; wanting?: string[]; rollup?: string }
interface RunFile { runId: string; startedAt: string; input: TickInput; scopes: ResolvedScope[]; snapshot: Snapshot; rows: Row[]; ticks: Record<string, ScopeTick> }
interface RunStreak { consecutive: number; open?: { runId: string; at: string }; alertedAt?: string }

/**
 * RAIL30 ⑤ — the seat's last activity from the snapshot: working now · idle since (now − idle) · the model clock.
 * Absent seat = unknown (no field: the ledger does not count the wake as unanswered).
 */
export function seatActivityField(snap: Pick<Snapshot, 'seats' | 'nowMs'>, seat: string): { lastActivityMs?: number | null } {
  const view = snap.seats.find((s) => s.seat === seat.trim().toUpperCase());
  if (!view) return {};
  if (view.activity === 'working') return { lastActivityMs: snap.nowMs };
  const idleSince = view.idleForMs !== null && view.idleForMs !== undefined ? snap.nowMs - view.idleForMs : null;
  const model = typeof view.lastActiveMs === 'number' ? view.lastActiveMs : null;
  const at = idleSince === null ? model : model === null ? idleSince : Math.max(idleSince, model);
  return { lastActivityMs: at };
}

/** The later of two activity marks; undefined stays «cannot tell» only when both sides are. */
export function latestActivity(fromSnapshot: number | null | undefined, turnStamp: number | null): { lastActivityMs?: number | null } {
  if (fromSnapshot === undefined && turnStamp === null) return {};
  const marks = [fromSnapshot ?? null, turnStamp].filter((v): v is number => typeof v === 'number');
  return { lastActivityMs: marks.length ? Math.max(...marks) : null };
}

const base = (root: string): string => join(root, 'steward', 'space');
const runPath = (root: string, runId: string): string => join(base(root), 'runs', `${runId.replace(/[^\w.-]/g, '_')}.json`);
const scopeDir = (root: string, scope: string): string => join(base(root), scope.replace(/[^\w.-]/g, '_'));
export const statePath = (root: string, scope: string, mode: 'shadow' | 'live'): string => join(scopeDir(root, scope), `state.${mode}.json`);
export const ledgerPath = (root: string, scope: string): string => join(scopeDir(root, scope), 'ledger.jsonl');
const markerDir = (root: string): string => join(base(root), 'dispatch');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}
function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

export function readScopeState(root: string, scope: string, mode: 'shadow' | 'live'): ScopeState {
  return { ...emptyScopeState(), ...readJson<Partial<ScopeState>>(statePath(root, scope, mode), {}) };
}
const modeOf = (s: ResolvedScope): 'shadow' | 'live' => (s.mode === 'live' ? 'live' : 'shadow');

/** Live dispatch markers (any scope): `<pr>-<head12>` → host, for global dedupe and per-host in-flight slots. */
function markers(root: string, nowMs: number, snap: Snapshot): { all: Set<string>; inflight: Map<string, number> } {
  const all = new Set<string>();
  const inflight = new Map<string, number>();
  if (!existsSync(markerDir(root))) return { all, inflight };
  for (const name of readdirSync(markerDir(root))) {
    if (!name.endsWith('.json')) continue;
    const key = name.slice(0, -5);
    const m = readJson<{ host?: string; at?: string }>(join(markerDir(root), name), {});
    all.add(key);
    const [pr, head12] = key.split('-');
    const fresh = nowMs - Date.parse(m.at ?? '') < D.pregateStuckMinutes * 60_000;
    if (m.host && fresh && !snap.receipts.some((r) => String(r.pr) === pr && r.head12 === head12)) inflight.set(m.host, (inflight.get(m.host) ?? 0) + 1);
  }
  return { all, inflight };
}

function claimMarker(root: string, key: string, host: string, at: string): boolean {
  mkdirSync(markerDir(root), { recursive: true });
  try {
    const fd = openSync(join(markerDir(root), `${key}.json`), 'wx');
    writeFileSync(fd, JSON.stringify({ host, at }));
    closeSync(fd);
    return true;
  } catch { return false; }
}

const out = (outcome: 'ok' | 'fail', data: Record<string, unknown>) => ({ outcome, ...data });

export function runStewardSpaceNode(node: StewardSpaceNode, input: TickInput, deps: TickDeps): { outcome: 'ok' | 'fail'; [key: string]: unknown } {
  const now = deps.now();
  const at = now.toISOString();
  if (node === 'r0') return snapshotNode(input, deps, now);
  const run = readJson<RunFile | null>(runPath(deps.root, input.runId), null);
  if (!run) return out('fail', { error: 'no snapshot for this run (r0 did not run)' });
  const snap = run.snapshot;
  const counts: Record<string, Record<string, number>> = {};
  const add = (rows: Row[]): void => {
    run.rows.push(...rows);
    for (const r of rows) { counts[r.scope] ??= {}; counts[r.scope]![r.action] = (counts[r.scope]![r.action] ?? 0) + 1; }
  };
  let r1Policy: ReturnType<typeof loadLiveR1Policy> | undefined;
  const boards = new Map<string, readonly { id: string; status: string; owner?: string }[]>();
  // One fresh board read per release per node run; a live assign re-reads after another assign changed it.
  const boardOf = (version: string): readonly { id: string; status: string; owner?: string }[] => {
    const hit = boards.get(version);
    if (hit) return hit;
    const read = deps.effects.boardNow!(version);
    boards.set(version, read);
    return read;
  };
  for (const scope of run.scopes) {
    const uses = node === 'x' || PROFILE_NODES[scope.profile].has(node);
    if (!uses) continue;
    const missing = node === 'x' ? [] : missingFor(node, snap);
    if (missing.length) { add([{ node, scope: scope.scope, action: 'defer', target: '-', reason: `source-missing:${missing.join(',')}`, mode: modeOf(scope) }]); continue; }
    const mode = modeOf(scope);
    const state = readScopeState(deps.root, scope.scope, mode);
    const live = mode === 'live';
    const tick = (run.ticks[scope.scope] ??= { idleLeft: [], escalations: [] });
    let rows: Row[] = [];
    if (node === 'r1') {
      const hq = scope.scope === snap.hq ? hqInputs(run, deps, now.getTime()) : {};
      // STEWARD-HQ-LIVE-ALIGN — graphs/policies/steward-hq.yaml `live` (fail-open to the same defaults) · seats another
      // scope already acted on in this run are not lent again.
      r1Policy ??= (deps.liveR1 ?? (() => loadLiveR1Policy()))();
      if (r1Policy.error) debug.log('steward.space', 'live-r1-policy-default', { error: r1Policy.error });
      const busySeats = new Set(run.rows.filter((r) => r.node === 'r1' && r.scope !== scope.scope && (r.action === 'assign' || r.action === 'wake') && r.seat).map((r) => r.seat!));
      let reclaimLimit: number | null | undefined;
      if (deps.reclaimLimit) {
        try { reclaimLimit = deps.reclaimLimit(); } catch { reclaimLimit = null; }
      }
      const plan = planMatch(snap, { scope, state, ...hq, r1: r1Policy.policy, busySeats, ...(deps.reclaimLimit ? { reclaimLimit: reclaimLimit ?? null } : {}) });
      // STEWARD-HQ (§5a): the HQ instance also records its cross-scope «would pair» rows (shadow ledger only · fail-open).
      if (scope.scope === snap.hq) {
        try { recordHqShadow(deps.root, snap, { at, runId: run.runId }, loadHqPolicy()); } catch (error) { debug.log('steward.space', 'hq-shadow-failed', { error: String(error).slice(0, 200) }); }
      }
      tick.idleLeft = plan.idleLeft;
      tick.wanting = plan.wanting;
      state.woken ??= {};
      for (const seat of plan.wake.answered) delete state.woken[seat];
      rows = plan.rows.map((row) => {
        if (row.action === 'reclaim') {
          if (!live) return row;
          const result = deps.effects.releaseCell({ version: snap.version, cellId: row.target, owner: row.owner ?? row.seat!, actor: scope.scope,
            why: `[행정관 · ${scope.scope}] lease expired (${row.reason.replace(/^lease-expired:/, '')} past) — back to the board` });
          if (!result.ok) return { ...row, action: 'reject' as const, reason: `reclaim-failed:${result.error}`.slice(0, 160), done: false };
          deps.effects.mail({ to: row.seat!, kind: 'info', intent: 'info', refs: [`cell:${row.target}`, `steward:${scope.scope}`],
            body: `[행정관 · ${scope.scope}] ${row.target} 임대 만료(활동 없음 ${row.reason.replace(/^lease-expired:/, '')} 초과) → 보드로 반환. 계속하려면 \`eln work next\` · 회신 불필요` });
          return { ...row, done: true };
        }
        if (row.action === 'wake' && live && deps.effects.claimWake) {
          const claim = deps.effects.claimWake({ seat: row.seat!, cell: row.target === row.seat ? '-' : row.target, by: `steward:${scope.scope}`,
            ...seatActivityField(snap, row.seat!) });
          // RAIL30 ⑤ — 2 unanswered wakes for this cause: stop waking · ONE exception line (the scope card) · then quiet.
          if (!claim.ok && claim.unanswered) {
            return claim.unanswered.raise
              ? { ...row, action: 'ambiguous' as const, target: row.seat!, reason: `wake-unanswered:${claim.unanswered.count}x:${row.target}`.slice(0, 160) }
              : { ...row, action: 'defer' as const, reason: `wake-unanswered-raised:${row.target}`.slice(0, 160) };
          }
          if (!claim.ok) return { ...row, action: 'defer' as const, reason: `already-woken:${claim.line}`.slice(0, 160) };
        }
        if (row.action === 'wake' && row.target === row.seat) {
          // A free hand that did not pull: one structured nudge to pull (no cell is pushed at it).
          if (live) deps.effects.mail({ to: row.seat!, kind: 'assign', intent: 'request', refs: [`steward:${scope.scope}`, 'work-next'],
            body: row.reason.startsWith('idle-all-waiting:')
              ? `[행정관 · ${scope.scope}] idle ${row.reason.replace(/^idle-all-waiting:/, '')} — 맡은 칸이 모두 남을 기다리는 중(판정·영수·HOLD)입니다. 기다리는 동안 \`eln work next\` 로 다음 칸을 가져가세요 (판정이 오면 그 칸으로 돌아갑니다 · 없으면 exit 3 = 일감 0).`
              : `[행정관 · ${scope.scope}] idle ${row.reason.replace(/^idle-no-pull:/, '')} — 보드에 일감이 있습니다. \`eln work next\` 로 한 칸 가져가세요 (없으면 exit 3 = 일감 0).` });
          state.woken![row.seat!] = { at, cell: '-', count: plan.wake.counts[row.seat!] ?? 1 };
          return live ? { ...row, done: true } : row;
        }
        if (row.action === 'wake') {
          // `eln seat assign` on the seat's own cell = owner unchanged ⊕ assignment mail ⊕ idle wake (non-reassigning).
          if (live) {
            const why = `wake: idle ${row.reason.replace(/^idle-owner:/, '')} on own cell`;
            const result = deps.effects.assignCell({ version: snap.version, cellId: row.target, seat: row.seat!, actor: scope.scope, why });
            if (!result.ok) return { ...row, action: 'reject' as const, reason: `wake-failed:${result.error}`.slice(0, 160), done: false };
          }
          state.woken![row.seat!] = { at, cell: row.target, count: plan.wake.counts[row.seat!] ?? 1 };
          return live ? { ...row, done: true } : row;
        }
        if (row.action !== 'assign') return row;
        if (live && deps.effects.boardNow) {
          // OP-TAB-FIRST: the snapshot is seconds old; OP's tab may have moved this cell or this hand in between.
          let why: string | null = null;
          const seatUp = row.seat!.trim().toUpperCase();
          const heldAtSnapshot = snap.cells.filter((c) => c.status === 'yellow' && (c.owner ?? '').split('/')[0]!.trim().toUpperCase() === seatUp).map((c) => c.id);
          try { why = recheckAssign(boardOf(snap.version), { cellId: row.target, expectedOwner: snap.cells.find((c) => c.id === row.target)?.owner, seat: row.seat!, heldAtSnapshot }); }
          catch (error) { why = `board-unreadable:${String(error).slice(0, 80)}`; }
          if (why) return { ...row, action: 'defer' as const, reason: `op-tab-first:${why}`.slice(0, 160), done: false };
        }
        state.assigned[row.target] = { seat: row.seat!, at };
        state.seatCooldown[row.seat!] = at;
        if (!live) return row;
        const why = `[행정관 · ${scope.scope}] ${row.reason}${row.lentFrom ? ` · lent from ${row.lentFrom}` : ''}`;
        const result = deps.effects.assignCell({ version: snap.version, cellId: row.target, seat: row.seat!, actor: scope.scope, why });
        if (result.ok) { boards.delete(snap.version); return { ...row, done: true }; }
        // ADMIN-RESOLVE-NOT-NAG — the cell left this release (unknown in both its release and the default one, or now
        // off-target): deterministic, nothing to decide → a defer row (no exception card); the board drops it next tick.
        if (/^(unknown-cell|off-target):/u.test(result.error)) return { ...row, action: 'defer' as const, reason: `cell-moved:${result.error}`.slice(0, 160), done: false };
        // SEAT-AREA-GUARD — the hand is outside the cell's area (seat-roles.yaml): capacity, not a decision → defer.
        if (/^off-area:/u.test(result.error)) return { ...row, action: 'defer' as const, reason: `off-area:${result.error.slice(9)}`.slice(0, 160), done: false };
        return { ...row, action: 'reject' as const, reason: `assign-failed:${result.error}`.slice(0, 160), done: false };
      });
    } else if (node === 'r2') {
      const marks = markers(deps.root, now.getTime(), snap);
      const dispatched = new Set([...marks.all, ...Object.entries(state.dispatched).map(([pr, d]) => `${pr}-${d.head12}`)]);
      rows = planReceipts(snap, { scope, state, hosts: deps.config?.pregateHosts ? filterRoutable(deps.config.pregateHosts, 'pregate') : hostsFor('pregate'), hostSlots: deps.config?.hostSlots ?? D.hostSlots,
        maxLoadPerCore: deps.config?.maxLoadPerCore ?? D.maxLoadPerCore, dispatchedAnywhere: dispatched, inflightByHost: marks.inflight })
        .map((row) => {
          if (row.action !== 'dispatch') return row;
          const pr = Number(row.target.slice(1));
          state.dispatched[String(pr)] = { head12: row.head12!, host: row.host!, at, ...(row.seat ? { seat: row.seat } : {}) };
          if (!live) return row;
          if (!claimMarker(deps.root, `${pr}-${row.head12}`, row.host!, at)) return { ...row, action: 'defer' as const, reason: 'raced' };
          const logPath = join(base(deps.root), 'pregate-logs', `${pr}-${row.head12}-${row.host}.log`);
          const result = deps.effects.dispatchPregate({ pr, head12: row.head12!, host: row.host!, logPath });
          if (!result.ok) return { ...row, action: 'reject' as const, reason: `dispatch-failed:${result.error}`.slice(0, 160), done: false };
          if (row.seat) deps.effects.mail({ to: row.seat, kind: 'info', intent: 'info', refs: [`pr:${pr}`, `head:${row.head12}`, `steward:${scope.scope}`],
            body: `[행정관 · ${scope.scope}] #${pr}@${row.head12} 같은 head 영수 없음 → pregate --light 디스패치(${row.host}). 영수는 PREGATE-GREEN 에 생깁니다 · 회신 불필요` });
          return { ...row, done: true };
        });
    } else if (node === 'r3') {
      // JUD-HAND-DISCOVERY: one mail per judge hand carrying its whole batch (cells first) — not one PR per hand per 30 min.
      rows = planJudge(snap, { scope, state }).map((row) => {
        if (row.action !== 'judge-assign') return row;
        state.judgeAssigned[judgeKey(row)] = { seat: row.seat!, at };
        state.seatCooldown[row.seat!] = at;
        return live ? { ...row, done: true } : row;
      });
      if (live) {
        const bySeat = new Map<string, Row[]>();
        for (const row of rows) if (row.action === 'judge-assign') bySeat.set(row.seat!, [...(bySeat.get(row.seat!) ?? []), row]);
        const cellWhy = new Map((snap.judgeCells ?? []).map((c) => [c.cell, c]));
        for (const [seat, batch] of bySeat) {
          const lines = batch.map((row) => {
            if (row.target.startsWith('#')) {
              const pr = row.target.slice(1);
              return `- PR ${row.target}@${row.head12} — 같은 head GREEN 영수, 판정 파일 없음 ${D.judgeWaitMinutes}분+${row.reason.endsWith('security-4') ? ' · 보안 4종 경로(보안 판정 포함)' : ''} · 결과 = review-results/judb-${pr}-${row.head12}.json`;
            }
            const c = cellWhy.get(row.target);
            const how = c?.kind === 'security-4'
              ? `보안 4종 — Terra 리뷰(eln self review <PR>) PASS/WARN·보안 지적 0 확인 뒤 서명`
              : `거부권 섰음 — 거부 근거가 아직 맞는지 판정(맞으면 이유 한 줄 회신 · 풀렸으면 서명)`;
            return `- 칸 ${row.target}${c?.prs.length ? ` (${c.prs.map((n) => `#${n}`).join(' ')})` : ''} — ${how} · 판정 집사: ${(c?.why ?? '').slice(0, 140)}`;
          });
          deps.effects.mail({ to: seat, kind: 'assign', intent: 'request',
            refs: [...batch.map((row) => (row.target.startsWith('#') ? `pr:${row.target.slice(1)}` : `cell:${row.target}`)), `steward:${scope.scope}`],
            body: [`[행정관 · ${scope.scope}] 판정 묶음 ${batch.length}건 — 칸 서명 = \`eln release checklist set <칸> --status green --evidence '<현재 근거>⏎JUD ${seat} 판정 …'\`(--evidence 는 덮어쓰기 · 현재 값과 합친다)`, ...lines].join('\n') });
        }
      }
    } else if (node === 'r4') {
      // Hand-off only: the existing chain poller/train lands PASS heads. Non-judge profiles count, judge carries rows.
      const handoff = planHandoff(snap, { scope });
      rows = scope.profile === 'judge' ? handoff : [];
      counts[scope.scope] = { ...(counts[scope.scope] ?? {}), handoffSeen: handoff.length };
    } else if (node === 'r5') {
      const watch = planWatch(snap, { scope, state, cutTimes: deps.config?.cutTimes ?? D.cutTimes, cutWindowMinutes: deps.config?.cutWindowMinutes ?? D.cutWindowMinutes });
      for (const id of watch.resolvedCells) delete state.assigned[id];
      rows = watch.rows.map((row) => {
        if (row.action === 'watch' && live) {
          const seat = state.dispatched[row.target.slice(1)]?.seat;
          if (seat) deps.effects.mail({ to: seat, kind: 'info', intent: 'info', refs: [`pr:${row.target.slice(1)}`, `head:${row.head12}`, `steward:${scope.scope}`],
            body: `[행정관 · ${scope.scope}] ${row.target}@${row.head12} pregate 영수 도착(${row.host} · ${row.reason.slice('receipt:'.length)}) · 회신 불필요` });
          return { ...row, done: true };
        }
        return row;
      });
      for (const pr of watch.resolvedPrs) delete state.dispatched[pr];
    } else if (node === 'r6') {
      const r1 = run.rows.filter((r) => r.scope === scope.scope && r.node === 'r1');
      const line = rollupLine(scope.scope, { ...digestCounts(snap, scope.scope), woken: r1.filter((r) => r.action === 'wake').length,
        reclaimed: r1.filter((r) => r.action === 'reclaim' && r.done !== false).length });
      tick.rollup = line;
      if (digestDue(state, now.getTime())) {
        state.lastDigestAt = at;
        const rollups = scope.scope === snap.hq ? allRollups(run, deps, scope.scope) : [];
        const blocked = scope.scope === snap.hq ? hqBlockLines(now.getTime()) : [];
        rows = [{ node, scope: scope.scope, action: 'digest', target: scope.scope, reason: line, mode, done: live }];
        if (live) deps.effects.mail({ to: scope.scope, kind: 'info', intent: 'info', refs: [`steward:${scope.scope}`, 'steward-digest'],
          body: [`[행정관 · ${scope.scope}] 30분 숫자 — ${line}`, ...(rollups.length ? ['범위별:', ...rollups.map((l) => `- ${l}`)] : []), ...(blocked.length ? [`막힌 칸(30분 · fed-state · 우편 대신): ${blocked.length}`, ...blocked.map((l) => `- ${l}`)] : [])].join('\n') });
      }
    } else if (node === 'x') {
      const card = exceptionCard(scope.scope, snap.hq, run.rows, state, now.getTime());
      if (card) {
        for (const key of card.keys) state.cards[key] = at;
        if (live) deps.effects.mail({ to: card.to, kind: 'steward-exception', intent: 'request', refs: [`steward:${scope.scope}`, `run:${run.runId}`], body: card.body });
        rows = [{ node, scope: scope.scope, action: 'digest', target: card.to, reason: card.title, mode, done: live }];
      }
      if (scope.scope === snap.hq) {
        // Pool [B]: hands pull across spaces themselves; HQ only reports the imbalance — one card per tick, the same line
        // not again within cardRepeatMinutes (coach-mail budget).
        const line = poolImbalanceLine(snap);
        const key = line ? `pool-imbalance:${line}` : '';
        if (line && !(state.cards[key] && now.getTime() - Date.parse(state.cards[key]!) < D.cardRepeatMinutes * 60_000)) {
          state.cards[key] = at;
          if (live) deps.effects.mail({ to: snap.hq, kind: 'info', intent: 'info', refs: [`steward:${scope.scope}`, 'pool-imbalance'],
            body: `[행정관 · ${scope.scope}] pool imbalance — ${line}. Hands pull across spaces (\`eln work next\`); \`eln work priority\` sets the pool order · 회신 불필요` });
          rows = [...rows, { node, scope: scope.scope, action: 'digest', target: snap.hq, reason: `pool-imbalance: ${line}`.slice(0, 160), mode, done: live }];
        }
      }
      if (scope.scope === snap.hq && deps.effects.writerCheck) {
        try {
          const resolver = deps.effects.writerCheck({ live });
          tick.rollup = `${tick.rollup ?? ''}${tick.rollup ? ' · ' : ''}${resolver.line}`;
          if (resolver.resolved || resolver.cards) rows = [...rows, { node, scope: scope.scope, action: 'digest' as const, target: snap.hq, reason: resolver.line, mode, done: live }];
        } catch (error) { debug.log('steward.space', 'writer-check-failed', { error: String(error).slice(0, 200) }); }
      }
      if (scope.scope === snap.hq && deps.effects.beacon) {
        try {
          const beacon = deps.effects.beacon({ live });
          tick.rollup = `${tick.rollup ?? ''}${tick.rollup ? ' · ' : ''}${beacon.line}`;
          rows = [...rows, ...beacon.fired.map((f) => ({ node, scope: scope.scope, action: 'digest' as const, target: snap.hq,
            reason: `beacon ✋ #${f.leadId} ${f.seat}@${f.leader}: ${f.why}`.slice(0, 160), mode, done: live }))];
        } catch (error) { debug.log('steward.space', 'beacon-failed', { error: String(error).slice(0, 200) }); }
      }
      const mine = run.rows.filter((r) => r.scope === scope.scope);
      const byAction: Record<string, number> = {};
      for (const r of mine) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
      tick.escalations = exceptionRows(scope.scope, run.rows);
      state.lastTick = { at, runId: run.runId, counts: byAction, idleLeft: tick.idleLeft, escalations: tick.escalations, wanting: tick.wanting ?? [], rollup: tick.rollup ?? '' };
      mkdirSync(scopeDir(deps.root, scope.scope), { recursive: true });
      writeFileSync(ledgerPath(deps.root, scope.scope), [...mine, ...rows].map((r) => JSON.stringify({ at, runId: run.runId, instance: scope.instanceId, ...r })).join('\n') + (mine.length + rows.length ? '\n' : ''), { flag: 'a' });
    }
    add(rows);
    writeJson(statePath(deps.root, scope.scope, mode), state);
  }
  writeJson(runPath(deps.root, input.runId), run);
  if (node === 'x') closeRun(deps.root, input.runId);
  debug.log('steward.space', node, { runId: input.runId, counts });
  return out('ok', { node, counts, exceptions: run.rows.filter((r) => EXCEPTION_ACTIONS.has(r.action)).length });
}

/** HQ inputs: cells the sub-scopes could not staff and their idle hands — this run's, else their own latest fresh tick
 *  (≤ 15 min). A tick written before `wanting` existed carried those cells as r1 `escalate` rows. */
function hqInputs(run: RunFile, deps: TickDeps, nowMs: number): { wanting: string[]; lendable: { seat: string; from: string }[] } {
  const wanting: string[] = [];
  const lendable: { seat: string; from: string }[] = [];
  for (const scope of scopesOf(run.snapshot).filter((s) => s !== run.snapshot.hq)) {
    let tick: { idleLeft: string[]; escalations: Row[]; wanting?: string[] } | undefined = run.ticks[scope];
    if (!tick) {
      const resolved = resolveScope(scope, run.snapshot.hq, deps.config);
      if (resolved.mode === 'off') continue;
      const last = readScopeState(deps.root, scope, modeOf(resolved)).lastTick;
      if (last && nowMs - Date.parse(last.at) <= 15 * 60_000) tick = last;
    }
    if (!tick) continue;
    wanting.push(...(tick.wanting ?? tick.escalations.filter((r) => r.node === 'r1' && r.action === 'escalate').map((r) => r.target)));
    lendable.push(...tick.idleLeft.map((seat) => ({ seat, from: scope })));
  }
  return { wanting, lendable };
}

function allRollups(run: RunFile, deps: TickDeps, hq: string): string[] {
  return scopesOf(run.snapshot).filter((s) => s !== hq).flatMap((scope) => {
    const line = run.ticks[scope]?.rollup;
    if (line) return [line];
    const resolved = resolveScope(scope, hq, deps.config);
    return [rollupLine(scope, digestCounts(run.snapshot, scope)) + (resolved.mode === 'off' ? ' · steward off' : '')];
  });
}

function snapshotNode(input: TickInput, deps: TickDeps, now: Date) {
  const snap = buildSnapshot(deps.sources(deps.config, now.getTime()), now.getTime());
  const wanted = input.scope ? [input.scope.trim().toUpperCase()]
    : input.seat ? [scopeOf(snap, input.seat)] : scopesOf(snap);
  const unknown = wanted.filter((s) => s !== snap.hq && !snap.coordinators.includes(s));
  const scopes = wanted.filter((s) => !unknown.includes(s)).map((s) => resolveScope(s, snap.hq, deps.config, input.shadow === true)).filter((s) => s.mode !== 'off');
  // Degrade: a previous run that never reached x is a failed tick.
  const streakPath = join(base(deps.root), 'streak.json');
  const streak = readJson<RunStreak>(streakPath, { consecutive: 0 });
  if (streak.open && streak.open.runId !== input.runId) streak.consecutive += 1;
  let alerted = false;
  const anyLive = [...new Set([...scopes, ...scopesOf(snap).map((s) => resolveScope(s, snap.hq, deps.config))].map((s) => s.mode))].includes('live');
  if (streak.consecutive >= 2 && !streak.alertedAt && anyLive) {
    deps.effects.mail({ to: snap.hq, kind: 'alert', intent: 'alert', refs: ['steward-space-degrade'],
      body: `[행정관] steward L1 stopped — ${streak.consecutive} ticks in a row did not finish (last open run ${streak.open?.runId ?? '?'}). 교통정리는 수동 모드로: OP 가 배정·영수·판정 대기를 직접 봅니다. 상태 = eln steward space status` });
    streak.alertedAt = now.toISOString();
    alerted = true;
  }
  streak.open = { runId: input.runId, at: now.toISOString() };
  writeJson(streakPath, streak);
  const run: RunFile = { runId: input.runId, startedAt: now.toISOString(), input, scopes, snapshot: snap, rows: [], ticks: {} };
  writeJson(runPath(deps.root, input.runId), run);
  pruneRuns(deps.root);
  const blind = ['panes', 'checklist', 'prs'].every((name) => snap.sourceErrors.some((e) => e.startsWith(`${name}:`)));
  return out(blind ? 'fail' : 'ok', { node: 'r0', hq: snap.hq, scopes: scopes.map((s) => `${s.instanceId}:${s.mode}:${s.profile}`), unknownScopes: unknown,
    seats: snap.seats.length, cells: snap.cells.length, prs: snap.prs.length, receipts: snap.receipts.length, sourceErrors: snap.sourceErrors,
    consecutiveFailed: streak.consecutive, degradeAlerted: alerted });
}

function closeRun(root: string, runId: string): void {
  const path = join(base(root), 'streak.json');
  const streak = readJson<RunStreak>(path, { consecutive: 0 });
  if (streak.open?.runId === runId) writeJson(path, { consecutive: 0 } satisfies RunStreak);
}

function pruneRuns(root: string): void {
  const dir = join(base(root), 'runs');
  try {
    const files = readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const f of files.slice(48)) unlinkSync(join(dir, f.n));
  } catch { /* nothing to prune */ }
}

// ── live wiring ────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PREGATE_TOOL = join(homedir(), 'elanous-hq/seat-state/RES/tools/pregate.py');

export function liveEffects(config: StewardSpaceConfig | undefined): StewardEffects {
  const mail = (m: StewardMail): void => {
    const store = openMsgStore(defaultMsgStorePath());
    try { store.append({ from: STEWARD_SENDER, to: m.to, body: m.body, kind: m.kind, intent: m.intent, refs: m.refs }); } finally { store.close(); }
  };
  return {
    mail,
    writerCheck: ({ live }) => {
      const ladderModule = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
      const resolverModule = require('./writer-resolver.js') as typeof import('./writer-resolver.js');
      const liveModule = require('./writer-resolver-live.js') as typeof import('./writer-resolver-live.js');
      const ladder = ladderModule.loadFederationLadder();
      const store = openMsgStore(defaultMsgStorePath());
      try {
        const report = resolverModule.runWriterCheckResolver(store, { ladder, now: () => Date.now(), raiseDecision: ladderModule.spawnHandDecision, live,
          ports: liveModule.liveWriterCheckPorts([...new Set([...Object.keys((() => { try { return ladderModule.loadDeclaredSeatRoles(); } catch { return {}; } })()), ...liveModule.BASE_SEATS])]), log: (event, data) => { try { debug.log('needhuman', event, data); } catch { /* fail-open */ } } });
        return { line: resolverModule.resolverLine(report), resolved: report.resolved.length, cards: report.cards.length };
      } finally { store.close(); }
    },
    beacon: ({ live }) => {
      const ladderModule = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
      const ladder = ladderModule.loadFederationLadder();
      const store = openMsgStore(defaultMsgStorePath());
      try {
        const watchModule = require('../../kit/mail-route/dormant-watch.js') as typeof import('../../kit/mail-route/dormant-watch.js');
        // GUARDIAN-HAND-SLA — before the beacon: ✋ open at a loop-agent address past its SLA go back to their domain owner
        // (hand-routes.yaml loopHands); what is left for HQ is carded by the beacon below.
        let loopLine = '';
        try {
          const sla = watchModule.sweepLoopHandSla(store, { live, hq: ladder.hq, parentOf: ladder.parentOf, log: (event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } } });
          if (sla.moved.length > 0) loopLine = ` · ${sla.line}`;
        } catch (error) { try { debug.log('msg', 'msg.loop-hand-sla', { phase: 'sweep-failed', error: String(error).slice(0, 200) }); } catch { /* fail-open */ } }
        const report = ladderModule.beaconHands(store, { ladder, now: () => Date.now(), raiseDecision: ladderModule.spawnHandDecision, live,
          dormantSeats: liveDormantSeats(), log: (event, data) => { try { debug.log('needhuman', event, data); } catch { /* fail-open */ } } });
        // DORMANT-SEAT-ROUTE — the same tick: mail rerouted from a dormant seat with no answer in 10 min → one OP card.
        let dormantLine = loopLine;
        try {
          const watch = watchModule.sweepDormantUnanswered(store, { live, log: (event, data) => { try { debug.log('msg', event, data); } catch { /* fail-open */ } } });
          if (watch.overdue.length > 0) dormantLine = ` · ${watch.line}`;
        } catch (error) { try { debug.log('msg', 'msg.dormant-watch', { phase: 'sweep-failed', error: String(error).slice(0, 200) }); } catch { /* fail-open */ } }
        return { line: `${ladderModule.beaconLine(report)}${dormantLine}`, fired: report.fired };
      } finally { store.close(); }
    },
    assignCell: ({ version, cellId, seat, actor, why }) => {
      // `eln seat assign` (#40072 · writer check ⊕ coordinator check ⊕ structured mail ⊕ wake) — the same call and parse as
      // the resource-opt steward (#40084): a refusal is the only exception row; «not installed» falls back below.
      const seatAssign = (v: string | undefined) => {
        const r = spawnElanousSync(['seat', 'assign', seat, cellId, '--from', actor, '--steward', '--json', '--why', why, ...(v ? ['--version', v] : [])], { encoding: 'utf8', timeout: 60_000 });
        return parseSeatAssignOutput(String(r.stdout ?? ''), r.status);
      };
      // ADMIN-RESOLVE-NOT-NAG — assign in the snapshot's release; «unknown-cell» there means the cell moved release →
      // follow it once (seat assign's default release) instead of raising an «assign-failed:unknown-cell» card.
      const followed = assignFollowingCell(version, seatAssign);
      const parsed = followed.parsed;
      if (parsed.ok) return { ok: true, via: followed.followed ? 'seat-assign-followed' : 'seat-assign' };
      if (parsed.code !== STEWARD_UNAVAILABLE) return { ok: false, error: `${parsed.code ?? 'refused'}:${parsed.reason}` };
      const set = spawnElanousSync(['release', 'checklist', 'set', cellId, '--owner', seat, '--version', version], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELANOUS_TRACK: actor } });
      if (set.status !== 0) return { ok: false, error: String(set.stderr ?? '').trim().split('\n').pop() ?? 'checklist set failed' };
      const due = new Date(Date.now() + 30 * 60_000).toISOString();
      const store = openMsgStore(defaultMsgStorePath());
      try {
        store.append({ from: STEWARD_SENDER, to: seat, kind: 'assign', intent: 'request', refs: [`cell:${cellId}`, `steward:${actor}`], deadlineAt: due,
          doneWhen: `칸 ${cellId} 에 PR 또는 근거 갱신`,
          body: `${why}\n배정: 칸 ${cellId} (판 ${version}) → ${seat}\n완료 = 칸 근거 갱신 또는 PR · 기한 ${due.slice(11, 16)}Z\n못 하면 «reject: <사유>» 한 줄 회신 — 다음 틱이 다른 손을 찾습니다.` });
      } finally { store.close(); }
      return { ok: true, via: 'internal' };
    },
    claimWake: ({ seat, cell, by, lastActivityMs }) => claimSeatWake(defaultWakeLedgerPath(), { seat, cell, by, atMs: Date.now(),
      ...latestActivity(lastActivityMs, (() => { try { return lastTurnAt(seat); } catch { return null; } })()) }),
    boardNow: (version) => listChecklist(version).items.map((i) => ({ id: i.id, status: i.status, ...(i.owner ? { owner: i.owner } : {}) })),
    releaseCell: ({ version, cellId, owner, actor, why }) => {
      try {
        const swapped = swapOwnerIf(version, cellId, { expectedOwner: owner, to: null, actor, reason: why });
        return swapped.outcome === 'swapped' ? { ok: true } : { ok: false, error: `${swapped.outcome}:owner=${swapped.owner ?? 'none'}` };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    dispatchPregate: ({ pr, host, logPath }) => {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        const fd = openSync(logPath, 'a');
        const child = spawn('python3', [config?.pregateTool ?? DEFAULT_PREGATE_TOOL, String(pr), '--host', host, '--light'], { detached: true, stdio: ['ignore', fd, fd] });
        child.unref();
        closeSync(fd);
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
  };
}

/** Seats whose answer can never come: absorbed kingdoms (res.dormant → RES · ELANOUS_DORMANT_SEATS extra, comma list). */
/** Pure: assign in `version`; on «unknown-cell» retry once in seat assign's default release (the cell moved release). */
export function assignFollowingCell<P extends { ok: boolean; code?: string | null }>(version: string, run: (version: string | undefined) => P): { parsed: P; followed: boolean } {
  const first = run(version);
  if (first.ok || first.code !== 'unknown-cell') return { parsed: first, followed: false };
  const again = run(undefined);
  return { parsed: again.ok ? again : first, followed: again.ok };
}

export function liveDormantSeats(): string[] {
  const out: string[] = [];
  try { if ((getUserConfig() as { res?: { dormant?: boolean } }).res?.dormant === true) out.push('RES'); } catch { /* none */ }
  for (const s of (process.env.ELANOUS_DORMANT_SEATS ?? '').split(',')) if (s.trim()) out.push(s.trim().toUpperCase());
  return [...new Set(out)];
}

export function liveTickDeps(config: StewardSpaceConfig | undefined, reclaimLimit: number | null = null): TickDeps {
  return { root: effectiveInstanceRoot(), now: () => new Date(), config, sources: liveSources, effects: liveEffects(config), reclaimLimit: () => reclaimLimit };
}

/** Graph context → tick input: graph `--input` or the event payload; runId from the runner. */
export function inputFromGraphContext(context: { runId?: unknown; input?: unknown }): TickInput {
  const raw = context.input && typeof context.input === 'object' && !Array.isArray(context.input) ? context.input as Record<string, unknown> : {};
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v) ? v.toUpperCase() : undefined);
  const scope = pick(raw.scope);
  const seat = pick(raw.seat);
  return { runId: typeof context.runId === 'string' && context.runId ? context.runId : `manual-${Date.now()}`,
    ...(scope ? { scope } : {}), ...(seat ? { seat } : {}), ...(raw.shadow === true ? { shadow: true } : {}) };
}

if (import.meta.main) {
  const node = process.argv[2] as StewardSpaceNode;
  if (!STEWARD_SPACE_NODES.includes(node)) { console.log(JSON.stringify({ outcome: 'fail', error: `unknown node ${process.argv[2]}` })); process.exit(1); }
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  const context = contextPath ? readJson<{ runId?: unknown; input?: unknown }>(contextPath, {}) : {};
  const config = getUserConfig().loops?.stewardSpace;
  try {
    const caps = node === 'r1' ? await liveStewardCaps() : null;
    const result = runStewardSpaceNode(node, inputFromGraphContext(context), liveTickDeps(config, caps?.reclaim ?? null));
    console.log(JSON.stringify(result));
    process.exit(result.outcome === 'ok' ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'fail', node, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}
