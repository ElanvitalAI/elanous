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
//   관측 = hand pool (liveHandPool) ⊕ current checklist (yellow · unowned · predecessors) ⊕ priority-order hints
//   판단 근거 = KPI idle_hands_with_ready_cells = min(idle unhinted hands, ready unhinted cells) ≤ 0 · cellDifficulty
//   수복과 인계 = assign (hint ⊕ model ⊕ pull mail ⊕ wake) / unassign (undo) · no ready cells = not this body's breach
import type { AgentCard } from '../card.js';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { livePost } from '../live.js';

export const AGENT_ID = 'hand-steward';
/** Same exclusion as op-next-action: umbrella/decision cells are never assigned. */
const NOT_ASSIGNABLE = new Set(['umbrella', 'decision']);
const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export interface Hand { readonly seat: string; readonly state: 'idle' | 'working' | 'no-pane'; readonly since?: number; readonly judge?: boolean; readonly cell?: string }
export interface Cell { readonly id: string; readonly title: string; readonly status: string; readonly owner?: string; readonly priority?: string; readonly predecessors?: readonly string[]; readonly dispatchKind?: string; readonly paths: readonly string[] }
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
}

export const isReady = (c: Cell, closed: ReadonlySet<string>): boolean =>
  c.status === 'yellow' && !c.owner && !NOT_ASSIGNABLE.has(c.dispatchKind ?? '') && (c.predecessors ?? []).every(p => closed.has(p));

/** Pairs (pure): longest-idle unhinted hand ↔ highest-priority unhinted ready cell. */
export function pairs(hands: readonly Hand[], cells: readonly Cell[], hints: Record<string, Hint>): Array<{ hand: Hand; cell: Cell }> {
  const hintedSeats = new Set(Object.values(hints).map(h => h.seat.toUpperCase()));
  const closed = new Set(cells.filter(c => c.status === 'green' || c.status === 'done').map(c => c.id));
  const idle = hands.filter(h => h.state === 'idle' && !h.judge && !h.cell && !hintedSeats.has(h.seat.toUpperCase()))
    .sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER) || a.seat.localeCompare(b.seat));
  const ready = cells.filter(c => isReady(c, closed) && !hints[c.id])
    .sort((a, b) => (PRIORITY_RANK[a.priority ?? ''] ?? 3) - (PRIORITY_RANK[b.priority ?? ''] ?? 3) || a.id.localeCompare(b.id));
  return idle.slice(0, ready.length).map((hand, i) => ({ hand, cell: ready[i]! }));
}

export const target = (cell: string, seat: string): string => `${cell}@${seat.toUpperCase()}`;
export const parseTarget = (t: string): { cell: string; seat: string } | null => { const m = /^(.+)@([A-Za-z0-9._-]+)$/u.exec(t.trim()); return m ? { cell: m[1]!, seat: m[2]!.toUpperCase() } : null; };

export function createBody(env: BodyEnv, deps: HandStewardDeps = liveDeps(env.stateRoot, env.card)): AgentBody {
  let lastHands: readonly Hand[] = []; let lastCells: readonly Cell[] = []; let lastHints: Record<string, Hint> = {}; let lastVersion = '';
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
      const idle = hands.filter(h => h.state === 'idle' && !h.judge && !h.cell);
      const idleFree = idle.filter(h => !hintedSeats.has(h.seat.toUpperCase()));
      const ready = board.cells.filter(c => isReady(c, closed));
      const readyFree = ready.filter(c => !hints[c.id]);
      const idleMin = Math.round(idle.reduce((s, h) => s + (h.since ? Math.max(0, nowMs - h.since) / 60_000 : 0), 0));
      facts.push(`판 ${board.version} · 놀고 있는 손 ${idle.length}(힌트 대기 ${idle.length - idleFree.length}) · 준비 칸 ${ready.length}(힌트 ${ready.length - readyFree.length}) · 유휴 손-분 ${idleMin}`);
      const subjects: Subject[] = [
        ...idleFree.map(h => ({ id: h.seat, kind: 'idle-hand', summary: `idle${h.since ? ` ${Math.round((nowMs - h.since) / 60_000)}분` : ''}`, ...(h.since ? { ageMin: (nowMs - h.since) / 60_000 } : {}) })),
        ...readyFree.slice(0, 10).map(c => ({ id: c.id, kind: 'ready-cell', summary: `${c.priority ?? '-'} ${c.title.slice(0, 60)}` })),
        ...Object.entries(hints).map(([cell, h]) => ({ id: target(cell, h.seat), kind: 'hinted', summary: `until ${h.until.slice(11, 16)}Z` })),
      ];
      return { kpi: Math.min(idleFree.length, readyFree.length), subjects, facts };
    },
    plan(): PlannedAction[] {
      return pairs(lastHands, lastCells, lastHints).map(({ hand, cell }) => ({ action: 'assign', target: target(cell.id, hand.seat),
        why: `${hand.seat} idle · ${cell.id} ${cell.priority ?? '-'} 준비(주인 없음 · 선행 닫힘)` }));
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
          if (!cell || !isReady(cell, closed)) return { ok: false, line: `${p.cell}: 주인 없는 준비 칸이 아니다` };
          if (lastHints[cell.id]) return { ok: false, line: `${p.cell}: 이미 ${lastHints[cell.id]!.seat} 에 힌트` };
          deps.hint(cell.id, p.seat, ctx.card.address, ctx.now);
          const model = deps.modelFor(p.seat, cell, ctx.now);
          // This is a pull request, not an ownership claim. Give the recipient a concrete response deadline.
          const due = new Date(ctx.now.getTime() + 30 * 60_000).toISOString();
          const id = deps.post(`hand-steward:${cell.id}:${p.seat}:${ctx.now.toISOString().slice(0, 13)}`, p.seat,
            `[${ctx.card.name} · pull] ${cell.id} «${cell.title.slice(0, 80)}» (${lastVersion}) 를 \`eln work next\` 로 잡아라 · 담당 ${p.seat} · 기한 ${due} · ${model.line}`);
          const woke = id !== null ? await deps.wake(p.seat, cell.id, id) : 'mail deduped · no wake';
          return { ok: true, line: `${cell.id} → ${p.seat} 힌트 · ${model.tier}${id !== null ? ` · 우편 #${id}` : ''} · ${woke}`, ref: `cell:${cell.id}`, undo: `unassign ${t}` };
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

// ── live ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export function liveDeps(stateRoot: string, card?: AgentCard): HandStewardDeps {
  const post = livePost(stateRoot, card, AGENT_ID);
  const instanceRoot = (): string => (require('../../instance/resolve.js') as typeof import('../../instance/resolve.js')).effectiveInstanceRoot();
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
        const { homedir } = require('node:os') as typeof import('node:os');
        const { join } = require('node:path') as typeof import('node:path');
        const cv = require('../../ops-dashboard/current-version.js') as typeof import('../../ops-dashboard/current-version.js');
        const cl = require('../../release-loop/checklist.js') as typeof import('../../release-loop/checklist.js');
        const { releaseLedgerRoot } = require('../../instance/resolve.js') as typeof import('../../instance/resolve.js');
        const version = cv.resolveCurrentVersion({ hqRoot: join(homedir(), 'elanous-hq'), graphVersion: cv.readReleaseGraphVersion() }).version.replace(/-.*$/u, '');
        // POOL-PULL-NEEDS-SPEC: `eln work next` skips an unowned cell without a done-when — never hint/wake a hand onto it
        // (the board steward lists it to OP as needs-spec).
        const { livePullRequiresDoneWhen } = require('../../seat/seat-assign-wip1.js') as typeof import('../../seat/seat-assign-wip1.js');
        const { needsSpec } = require('../../steward/space/work-next.js') as typeof import('../../steward/space/work-next.js');
        const requireDoneWhen = livePullRequiresDoneWhen();
        const cells = cl.listChecklist(version, releaseLedgerRoot()).items.filter(i => !requireDoneWhen || i.status !== 'yellow' || !needsSpec(i)).map(i => ({
          id: i.id, title: i.title, status: i.status, ...(i.owner ? { owner: i.owner } : {}), ...(i.priority ? { priority: i.priority } : {}),
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
      m.writeSeatModelDirective(instanceRoot(), d);
      return { line: m.directiveLine(d), tier: d.tier };
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
