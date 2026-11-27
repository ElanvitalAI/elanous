/**
 * BOARD-STEWARD command node (graphs/triggers/board-steward.yaml · `cmd:board-steward-tick`). Live wiring of the pure
 * tick (tick.ts): checklist ledger · els panes · federation ladder · op-pulse state · priority-order ledger · gh release.
 * Every probe fails open (an unreadable source = an empty/neutral value, never a wrong owner change).
 * Stage `live` = effects; anything else = shadow (files under {stateRoot}/loops/shadow/board-steward only).
 * Prints one JSON line `{ outcome, ... }` and appends the window goal line to {stateRoot}/loops/board-steward.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { appendOnce, loadFederationLadder, spawnHandDecision } from '../../msg/hand-raise-ladder.js';
import { broadcastHolds, escalationStep, unackedBySeat, unackedLine } from '../../msg/hand-escalation-step.js';
import { defaultMsgStorePath, openMsgStore } from '../../msg/msg-store.js';
import { readHolds as readHoldLedger, unregisteredCards } from '../../hold-ledger/hold-ledger.js';
import { listChecklist, swapOwnerIf } from '../../release-loop/checklist.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { PULSE_PHASES, pulsePaths, readPulseState, writePulseState, type PulsePhase } from '../../loops/op-pulse.js';
import { cellBlocksPath, openBlocks, readCellBlockRows } from '../space/cell-block.js';
import { liveSources, parsePanes } from '../space/sources.js';
import { priorityOrderPath, readPriorityOrder } from '../space/work-next-cli.js';
import { getUserConfig } from '../../user-config/reader.js';
import { livePullRequiresDoneWhen } from '../../seat/seat-assign-wip1.js';
import { BOARD_ACTOR, boardTick, type BoardDeps } from './tick.js';
import type { BoardCellIn, HandIn } from './model.js';

const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export function nextPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : v;
}

/** `loops.boardSteward.owner` (default OP). */
export function boardOwner(): string {
  const raw = safe(() => (getUserConfig() as { loops?: { boardSteward?: { owner?: unknown } } }).loops?.boardSteward?.owner, undefined);
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : 'OP';
}

export function liveBoardDeps(input: { live: boolean; stateRoot: string; seatState: string; dir: string; now?: Date }): BoardDeps {
  const now = input.now ?? new Date();
  const root = effectiveInstanceRoot();
  const ladder = safe(() => loadFederationLadder(), null);
  const scopeOf = (s: string): string => (ladder ? ladder.parentOf(s) : 'OP').toUpperCase();
  const pulseState = pulsePaths(input.seatState, input.stateRoot, now.toISOString().slice(0, 10)).state;
  return {
    dir: input.dir, live: input.live, now: () => now,
    version: () => safe(() => activeBoardVersion().replace(/-dev.*$/, ''), '0.0.0'),
    nextVersion: nextPatch,
    phase: () => { const p = safe(() => readPulseState(pulseState).lastPhase, null); return p && PULSE_PHASES.includes(p) ? p : 'build'; },
    cells: (v) => safe(() => listChecklist(v).items as unknown as BoardCellIn[], [] as BoardCellIn[]),
    hands: () => safe(() => {
      const src = liveSources(undefined, now.getTime());
      return parsePanes(src.panes(), now.getTime(), src.sessionActivity)
        .filter((s) => !ladder || ladder.depthOf(s.seat) === 3)
        .map((s): HandIn => ({ seat: s.seat, space: scopeOf(s.seat), idle: s.activity === 'idle' }));
    }, [] as HandIn[]),
    scopeOf,
    isCoordinator: (s) => !!ladder && ladder.depthOf(s) <= 2,
    waitingOn: (() => {
      let blocks: Map<string, { on: string }> | null = null;
      return (c: BoardCellIn) => {
        blocks ??= safe(() => openBlocks(readCellBlockRows(cellBlocksPath(root)), activeBoardVersion()) as Map<string, { on: string }>, new Map());
        return blocks.get(c.id)?.on ?? null;
      };
    })(),
    readOrder: () => readPriorityOrder(root),
    writeOrder: (order) => {
      const path = priorityOrderPath(root); mkdirSync(join(root, 'steward'), { recursive: true });
      writeFileSync(`${path}.tmp`, `${JSON.stringify({ order, at: now.toISOString(), by: 'BOARD' })}\n`); renameSync(`${path}.tmp`, path);
    },
    publishedAt: (v) => safe(() => {
      const r = spawnSync('gh', ['release', 'view', `v${v}`, '--repo', 'ElanvitalAI/elanous', '--json', 'publishedAt,isDraft'], { encoding: 'utf8', timeout: 20_000 });
      if (r.status !== 0) return null;
      const j = JSON.parse(r.stdout) as { publishedAt?: string; isDraft?: boolean };
      return j.publishedAt && !j.isDraft ? j.publishedAt : null;
    }, null),
    resetPhase: (phase: PulsePhase) => safe(() => writePulseState(pulseState, { lastPulseAt: null, lastPhase: phase }), undefined),
    returnCell: (v, id, owner) => safe(() => swapOwnerIf(v, id, { expectedOwner: owner, to: null, actor: BOARD_ACTOR, reason: 'WIP-1: extra cell returned to the board' }).outcome === 'swapped', false),
    owner: () => boardOwner(),
    requireDoneWhen: livePullRequiresDoneWhen,
    // ADMIN-RESOLVE-NOT-NAG — a board breach is a fact line, not an ask: steward-space r1 assigns free hands and wakes
    // holders on their own cells; to OP it rides the 30-min machine digest (SIGNAL-DIET), never as a decision item.
    card: (line, to) => safe(() => { const st = openMsgStore(defaultMsgStorePath()); try { st.append({ from: 'ORCHESTRATOR', to, body: line, kind: 'board-notice', intent: 'info', refs: ['board-steward'] }); } finally { st.close(); } }, undefined),
  };
}

interface Ctx { graphId?: string; runId?: string; input?: { window?: string; stage?: string; shadowDir?: string; vars?: { stateRoot?: string; seatState?: string } } }

export function runBoardNode(ctx: Ctx): Record<string, unknown> {
  const input = ctx.input ?? {};
  const stateRoot = input.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot();
  const seatState = input.vars?.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state');
  const live = input.stage === 'live';
  const dir = live ? join(effectiveInstanceRoot(), 'steward', 'board') : (input.shadowDir ?? join(stateRoot, 'loops', 'shadow', 'board-steward'));
  const r = boardTick(liveBoardDeps({ live, stateRoot, seatState, dir }));
  const window = input.window ?? 'manual';
  // FEDERATION MAIL WATCH (CEO 11-26 23:xx) — ✋ escalation past a silent coordinator / OP (live only writes), unacked per
  // seat, coordinator broadcast holds with frozen hands. Fail-open: the board tick result stands either way.
  const mail = safe(() => {
    const ladder = loadFederationLadder();
    const store = openMsgStore(defaultMsgStorePath());
    try {
      const now = Date.now();
      const escalated = escalationStep(store, { ladder, now: () => now, raiseDecision: spawnHandDecision, live,
        log: (event, data) => { try { appendFileSync(join(stateRoot, 'loops', 'fed-mail-watch.jsonl'), `${JSON.stringify({ at: new Date(now).toISOString(), event, ...data })}\n`); } catch { /* fail-open */ } } });
      const unacked = unackedBySeat(store, now);
      const holds = broadcastHolds(store, { ladder, nowMs: now });
      // HOLD-AS-LEDGER-OBJECT (eln OP 00:1x): an unscoped broadcast nobody registered → ONE OP card after 30 min (never «void»).
      const unregistered = safe(() => unregisteredCards(holds, readHoldLedger(stateRoot, new Date(now)), now), [] as ReturnType<typeof unregisteredCards>);
      if (live) for (const c of unregistered) safe(() => appendOnce(store, c.key, () => ({ from: 'HOLD-LEDGER', to: 'OP', kind: 'request', intent: 'decision', refs: [c.key, `hold-msg:${c.msgId}`], body: c.body })), null);
      return { escalated: escalated.filter(e => e.fresh).map(e => `#${e.msgId} ${e.hop} ${e.waitedMin}m`), unacked: unackedLine(unacked),
        holds: holds.map(h => `${h.frozen.length} hands frozen by ${h.coordinator} #${h.msgId}${h.scoped ? '' : ' (no cells · no expiry)'}`),
        unregisteredHolds: unregistered.map(c => `#${c.msgId}`) };
    } finally { store.close(); }
  }, { escalated: [] as string[], unacked: 'unmeasured', holds: [] as string[], unregisteredHolds: [] as string[] });
  const ledger = join(stateRoot, 'loops', 'board-steward.jsonl'); mkdirSync(join(stateRoot, 'loops'), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify({ goal: 'met', window, live, digest: r.digest, mail })}\n`);
  return { outcome: r.outcome, owner: r.owner, live, digest: r.digest, cards: r.cards.length, needsSpec: r.needsSpec.length, returned: r.returned.length, leaderFlag: r.leaderFlag, cut: r.cut?.counts ?? null, opened: r.opened?.version ?? null,
    mail };
}

if (import.meta.main) {
  try {
    const path = process.env.ELANOUS_GRAPH_CONTEXT;
    const ctx = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ctx : {};
    console.log(JSON.stringify(runBoardNode(ctx)));
  } catch (error) {
    console.log(JSON.stringify({ outcome: 'error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
