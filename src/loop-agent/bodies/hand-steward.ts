// hand-steward (행정관 · L0 OP) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 «행정관·보드»).
//
// S: six loops watch «idle hands» (board-steward · steward-space · op-next-action · tf-hq-wake · seat-inbox · work-feeder)
//    and most of them end in a card to OP («OP planner 가 배정» — 4/28 answered). Idle hands sit next to unowned ready cells.
// C: the pairing is mechanical — an idle non-judge hand, an unowned yellow cell whose predecessors are closed — and the
//    federation already has the pull path for it (OP-PUSH-BUDGET 11-27: priorityOrder ⊕ a pull hint · the hand claims on
//    `eln work next`) and the model-by-difficulty directive (seat-model/<SEAT>.json).
// Q: who closes «idle hand ↔ unowned cell» without another card to OP?
// A: per tick pair the longest-idle hand with the highest-priority ready cell; `assign` = the op-next-action (b) path —
//    pull hint (addPullHints) ⊕ model directive by difficulty ⊕ one pull mail ⊕ one shared-ledger wake. Undo =
//    `unassign` (drop the hint; the hand has not claimed). A hint lives one lease (45 min) and then expires by itself.
//
// 세 얼굴:
//   관측 = hand pool (liveHandPool) ⊕ current checklist (yellow · unowned or coordinator-held · predecessors) ⊕ hints
//          STEWARD-HQ 11-28: «ready» = the `eln work next` board — unowned OR held by a coordinator (HQ · ladder depth 2).
//          0.3.39 roster cells sit under OP/TC (53 ready · 48 P0/P1) and the 19 unowned ones lack a done-when, so the
//          unowned-only reading said ready 0 → KPI «충족» while hands idled (false green).
//          STEWARD-READY-LANES 11-28: the same green-triage lane rule as `eln work next` / the space steward (cell-wait.ts) —
//          a lane-a cell («merged ⊕ receipt → judge now») is JUD's, never hinted to a hand (21 of 0.3.39's yellow cells).
//   판단 근거 = KPI idle_hands_with_ready_cells = min(idle unhinted hands, ready unhinted cells) ≤ 0 · cellDifficulty
//   수복과 인계 = assign (hint ⊕ model ⊕ pull mail ⊕ wake) / unassign (undo) · no ready cells = not this body's breach
//          SUPERVISORS-EXECUTE-NOT-PROPOSE (대표 11-28 17:3x · L4: 4 idle hands with ready cells since 07:48Z — hints sat untaken):
//          a hint the hand has not taken in claim_after_hint_min → claim-for: the steward claims that cell FOR the hand through
//          the same `eln work next` door (writer/owner lease · work-pull writer.lease_min) and wakes it once — never a second
//          hint. Undo = unclaim (compare-and-set back) · the lease also lapses by itself. A HOLD over the cell → no claim.
import { pickByArea } from '../../kit/seat-area/index.js';
import type { AgentCard } from '../card.js';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { livePost } from '../live.js';
import { pn } from '../policy-context.js';

export const AGENT_ID = 'hand-steward';
/** Same exclusion as op-next-action: umbrella/decision cells are never assigned. */
const NOT_ASSIGNABLE = new Set(['umbrella', 'decision']);
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export interface Hand { readonly seat: string; readonly state: 'idle' | 'working' | 'no-pane'; readonly since?: number; readonly judge?: boolean; readonly cell?: string }
export interface Cell { readonly id: string; readonly title: string; readonly status: string; readonly owner?: string; readonly priority?: string; readonly predecessors?: readonly string[]; readonly dispatchKind?: string; readonly paths: readonly string[];
  /** The owner is a coordinator (HQ or ladder depth 2) — the cell is on the board, same as `eln work next` (leaders route, hands work). */
  readonly coordinatorHeld?: boolean;
  /** green-triage lane (cell-wait.ts HandLane): judge = lane a (JUD signs · not hand work) · evidence = lane b. Absent = supply. */
  readonly lane?: 'judge' | 'evidence';
  /** WORK-PULL-REACHES-ROSTER — place in the shared order (kit/work-pull comparePull: roster class → roster rank → priority ·
   *  0 = first). Absent = by priority. */
  readonly rank?: number }
export interface Hint { readonly seat: string; readonly until: string }

export interface HandStewardDeps {
  /** Federation hand pool (null = unreadable). */
  readHands(now: Date): Promise<readonly Hand[] | null> | readonly Hand[] | null;
  /** The current release's cells (null = unreadable). */
  readCells(): { readonly version: string; readonly cells: readonly Cell[] } | null;
  /** Live (unexpired) pull hints by cell (null = unreadable → treated as none). */
  readHints(now: Date): Record<string, Hint> | null;
  hint(cell: string, seat: string, by: string, now: Date): void;
  /** Drop one hint; false when there was none. */
  unhint(cell: string): boolean;
  /** Write the seat's model directive for the cell; returns the assignment line. */
  modelFor(seat: string, cell: Cell, now: Date): { line: string; tier: string };
  /** One mail (the runtime's ports.post, deduped). */
  post(key: string, to: string, body: string): number | string | null;
  /** One wake through the shared wake ledger (types into an idle pane). */
  wake(seat: string, cell: string, mailId: number | string): Promise<string> | string;
  /** SUPERVISORS-EXECUTE-NOT-PROPOSE: claim the hand's next cell through `eln work next` (the hinted cell ranks first for it) —
   *  the claimed cell id, or why not. Absent (a world without the claim door) = hints only, as before. */
  claimFor?(seat: string, now: Date): { ok: true; cell: string; line: string } | { ok: false; line: string };
  /** Undo of claimFor: compare-and-set the cell's writer / owner `seat` → none (false = it is no longer the hand's). */
  unclaim?(cell: string, seat: string): boolean;
  /** SEAT-AREA-GUARD (graphs/policies/seat-roles.yaml · kit/seat-area seatTakesCell): may this hand be handed this cell?
   *  Absent = every pair fits (pre-policy). */
  seatFit?(seat: string, cell: Cell): { ok: true; rule: string; area?: boolean } | { ok: false; reason: string };
}

export const isReady = (c: Cell, closed: ReadonlySet<string>): boolean =>
  c.status === 'yellow' && (!c.owner || c.coordinatorHeld === true) && c.lane !== 'judge' && !NOT_ASSIGNABLE.has(c.dispatchKind ?? '') && (c.predecessors ?? []).every(p => closed.has(p));

/** Pairs (pure): longest-idle unhinted hand ↔ highest-priority unhinted ready cell. */
export function pairs(hands: readonly Hand[], cells: readonly Cell[], hints: Record<string, Hint>): Array<{ hand: Hand; cell: Cell }> {
  return pairsFitting(hands, cells, hints);
}

/** SEAT-AREA-GUARD — the same pairing with a fit: each ready cell (priority order) → the longest-idle unhinted hand that fits
 *  it by area, else the longest-idle general hand (kit/seat-area pickByArea · absent fit = longest-idle hand ↔ top cell). */
function pairsFitting(hands: readonly Hand[], cells: readonly Cell[], hints: Record<string, Hint>, fit?: (seat: string, cell: Cell) => { ok: boolean; area?: boolean }): Array<{ hand: Hand; cell: Cell }> {
  const hintedSeats = new Set(Object.values(hints).map(h => h.seat.toUpperCase()));
  const closed = new Set(cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id));
  const idle = hands.filter(h => h.state === 'idle' && !h.judge && !h.cell && !hintedSeats.has(h.seat.toUpperCase()))
    .sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER) || a.seat.localeCompare(b.seat));
  const ready = cells.filter(c => isReady(c, closed) && !hints[c.id])
    .sort((a, b) => (a.rank !== undefined && b.rank !== undefined ? a.rank - b.rank : (PRIORITY_RANK[a.priority ?? ''] ?? 3) - (PRIORITY_RANK[b.priority ?? ''] ?? 3)) || a.id.localeCompare(b.id));
  const out: Array<{ hand: Hand; cell: Cell }> = [];
  for (const cell of ready) {
    const i = pickByArea(idle, h => h.seat, fit ? seat => fit(seat, cell) : undefined);
    if (i < 0) continue;
    out.push({ hand: idle[i]!, cell });
    idle.splice(i, 1);
    if (!idle.length) break;
  }
  return out;
}

export const target = (cell: string, seat: string): string => `${cell}@${seat.toUpperCase()}`;
/** Seats the steward claimed a cell for within claim_hold_min (their work is in flight even if the pane still reads idle). */
const claimedSeats = (acted: Readonly<Record<string, string>>, nowMs: number, holdMin: number): Set<string> =>
  new Set(Object.entries(acted).filter(([k, at]) => k.startsWith('claim-for:') && nowMs - Date.parse(at) < holdMin * 60_000).map(([k]) => (parseTarget(k.slice('claim-for:'.length))?.seat ?? '')));
/** The steward's own hints a hand has not taken for claim_after_hint_min (the hand still idle, the cell still ready). */
function staleHints(hints: Record<string, Hint>, acted: Readonly<Record<string, string>>, hands: readonly Hand[], cells: readonly Cell[], nowMs: number, graceMin: number): Array<{ cell: Cell; hand: Hand; ageMin: number }> {
  const closed = new Set(cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id));
  return Object.entries(hints).flatMap(([cellId, h]) => {
    const at = acted[`assign:${target(cellId, h.seat)}`];
    const ageMin = at ? (nowMs - Date.parse(at)) / 60_000 : -1;
    const hand = hands.find(x => x.seat.toUpperCase() === h.seat.toUpperCase());
    const cell = cells.find(c => c.id === cellId);
    return ageMin >= graceMin && hand && hand.state === 'idle' && !hand.judge && !hand.cell && cell && isReady(cell, closed) ? [{ cell, hand, ageMin }] : [];
  });
}
export const parseTarget = (t: string): { cell: string; seat: string } | null => { const m = /^(.+)@([A-Za-z0-9._-]+)$/u.exec(t.trim()); return m ? { cell: m[1]!, seat: m[2]!.toUpperCase() } : null; };

export function createBody(env: BodyEnv, deps: HandStewardDeps = liveDeps(env.stateRoot, env.card)): AgentBody {
  let lastHands: readonly Hand[] = []; let lastCells: readonly Cell[] = []; let lastHints: Record<string, Hint> = {}; let lastVersion = '';
  let lastStale: Array<{ cell: Cell; hand: Hand; ageMin: number }> = [];
  return {
    async observe(ctx): Promise<Observation> {
      const nowMs = ctx.now.getTime();
      const hands = await deps.readHands(ctx.now);
      const board = deps.readCells();
      const hints = deps.readHints(ctx.now) ?? {};
      lastHands = hands ?? []; lastCells = board?.cells ?? []; lastHints = hints; lastVersion = board?.version ?? '';
      const facts: string[] = [];
      if (!hands) facts.push('손 풀(hand pool) 을 읽지 못함 — KPI 모름');
      if (!board) facts.push('체크리스트를 읽지 못함 — KPI 모름');
      if (!hands || !board) return { kpi: null, subjects: [], facts };
      const hintedSeats = new Set(Object.values(hints).map(h => h.seat.toUpperCase()));
      const closed = new Set(board.cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id));
      const claimed = deps.claimFor ? claimedSeats(ctx.state.acted, nowMs, pn('claim_hold_min')) : new Set<string>();
      const idle = hands.filter(h => h.state === 'idle' && !h.judge && !h.cell && !claimed.has(h.seat.toUpperCase()));
      lastStale = !deps.claimFor ? [] : staleHints(hints, ctx.state.acted, hands, board.cells, nowMs, pn('claim_after_hint_min'));
      const idleFree = idle.filter(h => !hintedSeats.has(h.seat.toUpperCase()));
      const ready = board.cells.filter(c => isReady(c, closed));
      const readyFree = ready.filter(c => !hints[c.id]);
      const idleMin = Math.round(idle.reduce((s, h) => s + (h.since ? Math.max(0, nowMs - h.since) / 60_000 : 0), 0));
      const held = ready.filter(c => c.coordinatorHeld).length;
      const judgeLane = board.cells.filter(c => c.status === 'yellow' && c.lane === 'judge').length;
      facts.push(`판 ${board.version} · 놀고 있는 손 ${idle.length}(힌트 대기 ${idle.length - idleFree.length}) · 준비 칸 ${ready.length}(조율자 보유 ${held} · 힌트 ${ready.length - readyFree.length}) · 유휴 손-분 ${idleMin}${judgeLane ? ` · 판정 줄(a) ${judgeLane} 제외(JUD)` : ''}`);
      const subjects: Subject[] = [
        ...idleFree.map(h => ({ id: h.seat, kind: 'idle-hand', summary: `idle${h.since ? ` ${Math.round((nowMs - h.since) / 60_000)}분` : ''}`, ...(h.since ? { ageMin: (nowMs - h.since) / 60_000 } : {}) })),
        ...readyFree.slice(0, 10).map(c => ({ id: c.id, kind: 'ready-cell', summary: `${c.priority ?? '-'} ${c.title.slice(0, 60)}` })),
        ...Object.entries(hints).map(([cell, h]) => ({ id: target(cell, h.seat), kind: lastStale.some(x => x.cell.id === cell) ? 'hint-stale' : 'hinted', summary: `until ${h.until.slice(11, 16)}Z` })),
      ];
      if (lastStale.length) facts.push(`안 잡힌 힌트 ${lastStale.length}(${pn('claim_after_hint_min')}분+) → 대신 잡음`);
      return { kpi: Math.min(idleFree.length, readyFree.length), subjects, facts };
    },
    plan(_obs, ctx): PlannedAction[] {
      // an untaken hint → claim it for the hand (never a second hint); the other idle hands get their first hint
      const claim = lastStale.map(({ cell, hand, ageMin }) => ({ action: 'claim-for', target: target(cell.id, hand.seat), why: `${hand.seat} 가 ${cell.id} 힌트를 ${Math.round(ageMin)}분 안 잡음 — 대신 잡고 깨움` }));
      const claimed = deps.claimFor ? claimedSeats(ctx.state.acted, ctx.now.getTime(), pn('claim_hold_min')) : new Set<string>();
      const hands = lastHands.filter(h => !claimed.has(h.seat.toUpperCase()));
      const fit = deps.seatFit ? (seat: string, cell: Cell) => deps.seatFit!(seat, cell) : undefined;
      return [...claim, ...pairsFitting(hands, lastCells, lastHints, fit).map(({ hand, cell }) => {
        const f = fit?.(hand.seat, cell);
        return { action: 'assign', target: target(cell.id, hand.seat),
          why: `${hand.seat} idle · ${cell.id} ${cell.priority ?? '-'} 준비(${cell.coordinatorHeld ? `조율자 ${cell.owner} 보유` : '주인 없음'} · 선행 닫힘)${f?.ok ? ` · area match: ${f.rule}` : ''}` };
      })];
    },
    actions: {
      assign: {
        describe: '놀고 있는 손 하나에 주인 없는 준비 칸 하나를 pull 힌트로 건다(난이도별 모델 지시 ⊕ pull 우편 ⊕ 깨움 1회 · 되돌림: unassign <칸>@<손>)',
        async run(t, ctx): Promise<ActionResult> {
          const p = parseTarget(t);
          if (!p) return { ok: false, line: `${t}: 대상은 <칸>@<손>` };
          const hand = lastHands.find(h => h.seat.toUpperCase() === p.seat);
          const cell = lastCells.find(c => c.id === p.cell);
          const closed = new Set(lastCells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id));
          if (!hand || hand.state !== 'idle' || hand.judge || hand.cell) return { ok: false, line: `${p.seat}: 지금 놀고 있는 구현 손이 아니다` };
          if (!cell || !isReady(cell, closed)) return { ok: false, line: `${p.cell}: 준비 칸(주인 없음 · 조율자 보유)이 아니다` };
          if (lastHints[cell.id]) return { ok: false, line: `${p.cell}: 이미 ${lastHints[cell.id]!.seat} 에 힌트` };
          // SEAT-AREA-GUARD — a coordinator (MK · UX) only gets cells inside its areas; a non-pool seat none.
          let area = '';
          try { const f = deps.seatFit?.(p.seat, cell); if (f && !f.ok) return { ok: false, line: `${p.cell}: ${f.reason}` }; if (f?.ok) area = ` · area match: ${f.rule}`; } catch { /* guard unavailable — the pre-policy hint */ }
          deps.hint(cell.id, p.seat, ctx.card.address, ctx.now);
          const model = deps.modelFor(p.seat, cell, ctx.now);
          // This is a pull request, not an ownership claim. Give the recipient a concrete response deadline.
          const due = new Date(ctx.now.getTime() + 30 * 60_000).toISOString();
          const id = deps.post(`hand-steward:${cell.id}:${p.seat}:${ctx.now.toISOString().slice(0, 13)}`, p.seat,
            `[${ctx.card.name} · pull] ${cell.id} «${cell.title.slice(0, 80)}» (${lastVersion}) 를 \`eln work next\` 로 잡아라 · 담당 ${p.seat} · 기한 ${due}${area} · ${model.line}`);
          const woke = id !== null ? await deps.wake(p.seat, cell.id, id) : 'mail deduped · no wake';
          return { ok: true, line: `${cell.id} → ${p.seat} 힌트 · ${model.tier}${id !== null ? ` · 우편 #${id}` : ''} · ${woke}`, ref: `cell:${cell.id}`, undo: `unassign ${t}` };
        },
      },
      'claim-for': {
        describe: '안 잡힌 힌트(claim_after_hint_min 넘김)의 칸을 그 손 대신 `eln work next` 문으로 잡고(임대 = work-pull writer.lease_min) 한 번 깨운다 · 두 번째 힌트 없음 · 되돌림: unclaim <칸>@<손>',
        async run(t, ctx): Promise<ActionResult> {
          const p = parseTarget(t);
          if (!p) return { ok: false, line: `${t}: 대상은 <칸>@<손>` };
          const st = lastStale.find(x => x.cell.id === p.cell && x.hand.seat.toUpperCase() === p.seat);
          if (!st) return { ok: false, line: `${t}: 안 잡힌 힌트가 아니다(손이 움직였거나 칸이 준비 아님)` };
          if (!deps.claimFor) return { ok: false, line: `${t}: 대신 잡기 문 없음` };
          const c = deps.claimFor(p.seat, ctx.now);
          if (!c.ok) return { ok: false, line: `${t}: 대신 잡기 실패 — ${c.line}` };
          deps.unhint(p.cell); // the hint did its job (or another cell was first for the hand) — never re-hinted
          const id = deps.post(`hand-steward-claim:${c.cell}:${p.seat}`, p.seat,
            `[${ctx.card.name} · 대신 잡음] ${c.cell} 를 네 이름으로 잡았다(${lastVersion} · 힌트 ${Math.round(st.ageMin)}분 무응답 · 임대 ${pn('claim_hold_min')}분 — 진행 신호가 없으면 보드로 돌아간다). 지금 시작: eln release checklist evidence ${c.cell} --json · 못 하면 eln work block ${c.cell}`);
          const woke = id !== null ? await deps.wake(p.seat, c.cell, id) : 'mail deduped · no wake';
          return { ok: true, line: `${c.cell} → ${p.seat} 대신 잡음(${c.line})${id !== null ? ` · 우편 #${id}` : ''} · ${woke}`, ref: `cell:${c.cell}`, undo: `unclaim ${target(c.cell, p.seat)}`,
            before: `hint ${p.cell}@${p.seat} ${Math.round(st.ageMin)}분 무응답`, after: `claimed ${c.cell} by ${p.seat}` };
        },
      },
      unclaim: {
        describe: 'claim-for 의 되돌림 — 그 손이 아직 그 칸의 writer/주인이면 비운다(compare-and-set · 이미 진행 중이면 안 건드림)',
        run(t): ActionResult {
          const p = parseTarget(t);
          if (!p) return { ok: false, line: `${t}: 대상은 <칸>@<손>` };
          return deps.unclaim?.(p.cell, p.seat) ? { ok: true, line: `${p.cell} 를 ${p.seat} 에게서 비움`, ref: `cell:${p.cell}`, undo: `claim-for ${t}` }
            : { ok: false, line: `${p.cell}: 이제 ${p.seat} 의 칸이 아니다(이미 바뀜)` };
        },
      },
      unassign: {
        describe: '손에 건 pull 힌트를 거둔다(assign 의 되돌림 · 이미 잡은 칸은 안 건드림)',
        run(t): ActionResult {
          const p = parseTarget(t);
          if (!p) return { ok: false, line: `${t}: 대상은 <칸>@<손>` };
          const h = lastHints[p.cell];
          if (h && h.seat.toUpperCase() !== p.seat) return { ok: false, line: `${p.cell}: 힌트 주인은 ${h.seat}` };
          if (!deps.unhint(p.cell)) return { ok: false, line: `${p.cell}: 힌트 없음(이미 잡았거나 만료)` };
          return { ok: true, line: `${p.cell} 힌트 거둠(${p.seat})`, ref: `cell:${p.cell}`, undo: `assign ${t}` };
        },
      },
    },
  };
}

/** `owner` → is it a coordinator seat (HQ or ladder depth 2)? An unreadable ladder knows none (unowned-only, as before). */
export function coordinatorTest(ladder: { hq: string; depthOf(seat: string): number } | null, depths?: readonly number[]): (owner: string) => boolean {
  if (!ladder) return () => false;
  return (owner) => {
    const seat = owner.split('/')[0]!.trim().toUpperCase();
    // WORK-PULL-REACHES-ROSTER — the shared policy's coordinator_depths when given (same test as `eln work next`).
    return !!seat && (depths ? depths.includes(ladder.depthOf(seat)) : (seat === ladder.hq.toUpperCase() || ladder.depthOf(seat) === 2));
  };
}

function liveCoordinatorTest(): (owner: string) => boolean {
  try {
    const { loadFederationLadder } = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
    const { livePullPolicy } = require('../../kit/work-pull/index.js') as typeof import('../../kit/work-pull/index.js');
    const live = livePullPolicy();
    return coordinatorTest(loadFederationLadder(), live.error ? undefined : live.policy.coordinatorDepths);
  } catch { return coordinatorTest(null); }
}

// ── live ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function liveDeps(stateRoot: string, card?: AgentCard): HandStewardDeps {
  const post = livePost(stateRoot, card, AGENT_ID);
  const instanceRoot = (): string => (require('../../instance/resolve.js') as typeof import('../../instance/resolve.js')).effectiveInstanceRoot();
  /** The board in play (current-version resolver · «-dev.N» dropped) — readCells and unclaim read the same one. */
  const boardVersion = (): string => {
    const { homedir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const cv = require('../../ops-dashboard/current-version.js') as typeof import('../../ops-dashboard/current-version.js');
    return cv.resolveCurrentVersion({ hqRoot: join(homedir(), 'elanous-hq'), graphVersion: cv.readReleaseGraphVersion() }).version.replace(/-.*$/u, '');
  };
  return {
    async readHands(now) {
      try {
        const { liveHandPool } = require('../../seat/hand-pool-live.js') as typeof import('../../seat/hand-pool-live.js');
        const { isJudgeHand } = require('../../seat/hand-pool.js') as typeof import('../../seat/hand-pool.js');
        return (await liveHandPool({ now: now.getTime() })).map(h => ({ seat: h.seat, state: h.state, ...(h.since !== undefined ? { since: h.since } : {}),
          ...(isJudgeHand(h.seat) ? { judge: true } : {}), ...(h.cell ? { cell: h.cell } : {}) }));
      } catch { return null; }
    },
    readCells() {
      try {
        const cl = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
        const { releaseLedgerRoot } = require('../../instance/resolve.js') as typeof import('../../instance/resolve.js');
        const version = boardVersion();
        // POOL-PULL-NEEDS-SPEC: `eln work next` skips an unowned cell without a done-when — never hint/wake a hand onto it
        // (the board steward lists it to OP as needs-spec).
        const { livePullRequiresDoneWhen } = require('../../seat/seat-assign-wip1.js') as typeof import('../../seat/seat-assign-wip1.js');
        const { needsSpec } = require('../../steward/space/work-next.js') as typeof import('../../steward/space/work-next.js');
        const requireDoneWhen = livePullRequiresDoneWhen();
        const isCoordinator = liveCoordinatorTest();
        const items = cl.listChecklist(version, releaseLedgerRoot()).items;
        // STEWARD-READY-LANES — the shared lane reader (unreadable → no lanes: the pre-lane board).
        const lanes = (() => { try { return (require('../../steward/space/sources.js') as typeof import('../../steward/space/sources.js')).liveCellLanes(version, items).cells; } catch { return {}; } })();
        // WORK-PULL-REACHES-ROSTER — the shared order ⊕ «[WIP 잔류 …]» never ⊕ a cell a hand is writing is that hand's
        // (writer claim younger than the lease · the hand's activity is the hand pool's, not read here).
        const pp = require('../../kit/work-pull/index.js') as typeof import('../../kit/work-pull/index.js');
        const live = pp.livePullPolicy();
        const rosterRank = live.error ? undefined : pp.rosterRank(pp.readRoster(instanceRoot()), version);
        const nowMs = Date.now();
        const writing = (i: (typeof items)[number]): boolean => !live.error && !!i.writer && pp.claimUntilMs({ claim: Date.parse(i.writer.at), 'cell-change': Date.parse(i.updatedAt) }, live.policy) >= nowMs;
        const kept = items.filter(i => live.error || i.status !== 'yellow' || (pp.pullClass(i.evidence, live.policy) !== 'never' && !writing(i)));
        const order = live.error ? new Map<string, number>() : new Map([...kept].sort((a, b) => pp.comparePull(a, b, live.policy, rosterRank) || a.id.localeCompare(b.id)).map((i, n) => [i.id, n]));
        const cells = kept.filter(i => !requireDoneWhen || i.status !== 'yellow' || !needsSpec(i)).map(i => ({
          ...(order.has(i.id) ? { rank: order.get(i.id)! } : {}),
          id: i.id, title: i.title, status: i.status, ...(i.owner ? { owner: i.owner } : {}), ...(i.priority ? { priority: i.priority } : {}),
          ...(i.owner && isCoordinator(i.owner) ? { coordinatorHeld: true } : {}), ...(lanes[i.id] ? { lane: lanes[i.id] } : {}),
          ...(i.predecessors ? { predecessors: i.predecessors } : {}), ...(i.dispatchKind ? { dispatchKind: i.dispatchKind } : {}),
          paths: (() => { try { return cl.parseChecklistTargetPaths([i.body ?? '', i.doneCriterion ?? ''].join('\n')); } catch { return []; } })(),
        }));
        return { version, cells };
      } catch { return null; }
    },
    readHints(now) {
      try {
        const { readPriorityOrder } = require('../../steward/space/work-next-cli.js') as typeof import('../../steward/space/work-next-cli.js');
        const out: Record<string, Hint> = {};
        for (const [cell, h] of Object.entries(readPriorityOrder(instanceRoot()).hints ?? {})) if (Date.parse(h.until) > now.getTime()) out[cell] = { seat: h.seat, until: h.until };
        return out;
      } catch { return null; }
    },
    hint(cell, seat, by, now) {
      const { addPullHints } = require('../../steward/space/work-next-cli.js') as typeof import('../../steward/space/work-next-cli.js');
      addPullHints(instanceRoot(), [{ cell, seat }], by, now.getTime());
    },
    unhint(cell) {
      const { readPriorityOrder, priorityOrderPath } = require('../../steward/space/work-next-cli.js') as typeof import('../../steward/space/work-next-cli.js');
      const { renameSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
      const root = instanceRoot();
      const cur = readPriorityOrder(root);
      if (!cur.hints?.[cell]) return false;
      const hints = { ...cur.hints }; delete hints[cell];
      const path = priorityOrderPath(root);
      // Same row shape addPullHints writes; the cell keeps its place in priorityOrder (only the seat hint goes).
      writeFileSync(`${path}.tmp`, `${JSON.stringify({ order: cur.order, at: new Date().toISOString(), by: AGENT_ID.toUpperCase(), hints })}\n`);
      renameSync(`${path}.tmp`, path);
      return true;
    },
    modelFor(seat, cell, now) {
      const m = require('../../seat/model-by-difficulty.js') as typeof import('../../seat/model-by-difficulty.js');
      const { priorAttempts } = require('../../seat/seat-assign-live.js') as typeof import('../../seat/seat-assign-live.js');
      const d = m.directiveFor({ seat, cell: cell.id, facts: { cellId: cell.id, paths: cell.paths, priorAttempts: priorAttempts(cell.id) }, usedShare: m.liveUsedShare, by: AGENT_ID, now });
      if (!d) { m.noModelFallback({ root: instanceRoot(), seat, cell: cell.id, note: 'no acceptable model under the budget', by: AGENT_ID, now }); return { line: 'model: no acceptable model under the budget — your tab returns to its default model (no paid bypass)', tier: m.cellDifficulty({ cellId: cell.id, paths: cell.paths }).tier }; }
      m.writeSeatModelDirective(instanceRoot(), d);
      return { line: m.directiveLine(d), tier: d.tier };
    },
    claimFor(seat, now) {
      try {
        const { workNext } = require('../../steward/space/work-next.js') as typeof import('../../steward/space/work-next.js');
        const { liveWorkNextDeps } = require('../../steward/space/work-next-cli.js') as typeof import('../../steward/space/work-next-cli.js');
        const r = workNext(seat, liveWorkNextDeps(seat, { now: now.getTime() }));
        return r.code === 0 ? { ok: true, cell: r.cell.id, line: `work next${r.from ? ` · from ${r.from}` : ''}` } : { ok: false, line: `work next rc ${r.code} — ${r.line.slice(0, 120)}` };
      } catch (e) { return { ok: false, line: (e instanceof Error ? e.message : String(e)).slice(0, 120) }; }
    },
    seatFit(seat, cell) {
      const sa = require('../../kit/seat-area/index.js') as typeof import('../../kit/seat-area/index.js');
      const f = sa.liveSeatFit()(seat, cell);
      return f.ok ? { ok: true, rule: f.rule, area: f.area } : { ok: false, reason: f.reason };
    },
    unclaim(cell, seat) {
      const cl = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
      const { releaseLedgerRoot } = require('../../instance/resolve.js') as typeof import('../../instance/resolve.js');
      const version = boardVersion();
      const item = cl.listChecklist(version, releaseLedgerRoot()).items.find(i => i.id === cell);
      if (!item) return false;
      const reason = `hand-steward unclaim (undo of claim-for ${cell}@${seat})`;
      if (item.writer?.seat?.toUpperCase() === seat) return cl.setWriterIf(version, cell, { expectedOwner: item.owner ?? null, expectedWriter: item.writer.seat, to: null, actor: AGENT_ID.toUpperCase(), reason }).outcome === 'swapped';
      if ((item.owner ?? '').split('/')[0]!.toUpperCase() === seat) return cl.swapOwnerIf(version, cell, { expectedOwner: item.owner!, to: null, actor: AGENT_ID.toUpperCase(), reason }).outcome === 'swapped';
      return false;
    },
    post: (key, to, body) => post(key, to, body, 'coord'),
    async wake(seat, cell, mailId) {
      try {
        const { claimSeatWake, defaultWakeLedgerPath } = require('../../seat/wake-ledger.js') as typeof import('../../seat/wake-ledger.js');
        const claim = claimSeatWake(defaultWakeLedgerPath(), { seat, cell, by: AGENT_ID.toUpperCase(), atMs: Date.now() });
        if (!claim.ok) return `wake skipped (${claim.line})`;
        const { wakeRecipient } = require('../../loops/msg-wake.js') as typeof import('../../loops/msg-wake.js');
        const woke = await wakeRecipient(seat, Number(mailId), { from: AGENT_ID.toUpperCase(), kind: 'coord' });
        return `wake ${woke.result}${woke.reason ? ` (${woke.reason})` : ''}`;
      } catch (e) { return `wake failed (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`; }
    },
  };
}
