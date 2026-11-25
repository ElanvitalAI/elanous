// BOARD-STEWARD tick — one deterministic pass (model.ts rules) over the federation board. Shadow = rows and files under
// the shadow dir only (no order write, no owner change, no card). Live = writes priority-order.json (the ledger
// `eln work next` reads), the cut list for the release graph L-0, WIP returns (compare-and-set) and ≤3 OP cards/10 min.
// Interfaces: Board→Release = `<root>/steward/board/cut-list-<v>.json` · Release→Board = the L-8 publish signal
// (`publishedAt(version)`) → next board opens ⊕ pulse phase reset · Board→RES reservation unchanged (not touched here).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PulsePhase } from '../../loops/op-pulse.js';
import {
  boardHealth, breaches, cmpVersion, cardsAllowed, cutList, digestLine, leaderWrite, nextBoard, rankBoard,
  type BoardCellIn, type CutList, type HandIn, type OrderLedger,
} from './model.js';

export const BOARD_ACTOR = 'steward:BOARD';

export interface BoardState { version: string | null; published: string[]; cards: Array<{ at: number; key: string }>; lastPhase: PulsePhase | null }

export interface BoardDeps {
  readonly dir: string; // <root>/steward/board (live) or a shadow dir
  readonly now: () => Date;
  readonly live: boolean;
  readonly version: () => string;
  readonly nextVersion: (v: string) => string;
  readonly phase: () => PulsePhase;
  readonly cells: (version: string) => readonly BoardCellIn[];
  readonly hands: () => readonly HandIn[];
  readonly scopeOf: (seat: string) => string;
  readonly isCoordinator: (seat: string) => boolean;
  readonly waitingOn: (c: BoardCellIn) => string | null;
  readonly readOrder: () => OrderLedger;
  readonly writeOrder: (order: readonly string[]) => void;
  /** L-8 signal: ISO time the version was published, or null. */
  readonly publishedAt: (version: string) => string | null;
  readonly resetPhase: (phase: PulsePhase) => void;
  readonly returnCell: (version: string, id: string, owner: string) => boolean;
  /** Owner seat (config `loops.boardSteward.owner`, default OP — TC works too): cards go here, its order writes are not leader writes. */
  readonly owner?: () => string;
  /** Scratch board for ops synthetic events: only then are `synthetic`-tagged cells read. A real board never sees them. */
  readonly synthetic?: boolean;
  readonly card: (line: string, to: string) => void;
}

export interface BoardTickResult {
  readonly outcome: 'ok' | 'fail';
  readonly live: boolean;
  readonly version: string;
  readonly phase: PulsePhase;
  readonly order: readonly string[];
  readonly cut: CutList | null;
  readonly opened: { version: string; carried: string[]; fresh: string[] } | null;
  readonly returned: ReadonlyArray<{ seat: string; id: string; ok: boolean }>;
  readonly leaderFlag: string | null;
  readonly cards: readonly string[];
  readonly digest: string;
  readonly owner: string;
}

const statePath = (dir: string): string => join(dir, 'board-state.json');
export const cutListPath = (dir: string, version: string): string => join(dir, `cut-list-${version}.json`);
export const digestPath = (dir: string): string => join(dir, 'board-digest.jsonl');

function atomic(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); }

export function readBoardState(dir: string): BoardState {
  try {
    const raw = JSON.parse(readFileSync(statePath(dir), 'utf8')) as Partial<BoardState>;
    return { version: raw.version ?? null, published: Array.isArray(raw.published) ? raw.published : [], cards: Array.isArray(raw.cards) ? raw.cards : [], lastPhase: raw.lastPhase ?? null };
  } catch { return { version: null, published: [], cards: [], lastPhase: null }; }
}

const CUT_PHASES: readonly PulsePhase[] = ['pre-cut', 'release-window'];

export function boardTick(deps: BoardDeps): BoardTickResult {
  const now = deps.now(); const nowMs = now.getTime();
  const state = readBoardState(deps.dir);
  const cur = deps.version();
  let version = state.version && cmpVersion(state.version, cur) > 0 ? state.version : cur;
  let phase = deps.phase();
  const keep = (c: BoardCellIn): boolean => (deps.synthetic ? (c.tags ?? []).includes('synthetic') : !(c.tags ?? []).includes('synthetic'));
  const cellsOf = (v: string): BoardCellIn[] => deps.cells(v).filter(keep);
  // Release→Board (L-8): a published board opens the next one (carry-over ⊕ new) and resets the pulse phase.
  let opened: BoardTickResult['opened'] = null;
  const pubAt = state.published.includes(version) ? null : deps.publishedAt(version);
  if (pubAt) {
    const next = deps.nextVersion(version);
    opened = nextBoard([...cellsOf(version), ...cellsOf(next)], version, next);
    state.published = [...state.published, version].slice(-10);
    version = next; phase = 'post-release';
    if (deps.live) deps.resetPhase('post-release');
  }
  const cells = cellsOf(version);
  const order = rankBoard(cells, phase, version);
  const ledger = deps.readOrder();
  const owner = (deps.owner?.() ?? 'OP').trim().toUpperCase() || 'OP';
  const leader = leaderWrite(ledger, owner);
  const same = ledger.order.length === order.length && ledger.order.every((x, i) => x === order[i]);
  if (deps.live && (!same || leader.flagged)) deps.writeOrder(order);
  // Board→Release (L-0): the cut list while the phase is pre-cut/release-window.
  const cut = CUT_PHASES.includes(phase) ? cutList(cells, version, now.toISOString(), deps.scopeOf) : null;
  if (cut) atomic(cutListPath(deps.dir, version), `${JSON.stringify(cut, null, 1)}\n`);
  const health = boardHealth({ cells, hands: deps.hands(), order, scopeOf: deps.scopeOf, waitingOn: deps.waitingOn, isCoordinator: deps.isCoordinator });
  const returned: Array<{ seat: string; id: string; ok: boolean }> = [];
  for (const w of health.wip) for (const id of w.giveBack) returned.push({ seat: w.seat, id, ok: deps.live ? deps.returnCell(version, id, w.seat) : false });
  const allowed = cardsAllowed(breaches({ health, leader, cut, phaseChanged: state.lastPhase !== null && state.lastPhase !== phase }), state.cards, nowMs);
  const cards: string[] = [];
  for (const b of allowed) {
    const line = `[BOARD 행정관] ${b.line}`;
    if (deps.live) deps.card(line, owner);
    cards.push(line); state.cards.push({ at: nowMs, key: b.key });
  }
  state.cards = state.cards.filter((c) => nowMs - c.at < 60 * 60_000);
  state.version = version; state.lastPhase = phase;
  atomic(statePath(deps.dir), `${JSON.stringify(state)}\n`);
  const digest = digestLine({ phase, version, order, health, cut });
  mkdirSync(deps.dir, { recursive: true });
  appendFileSync(digestPath(deps.dir), `${JSON.stringify({ at: now.toISOString(), owner, live: deps.live, digest, order: order.slice(0, 10), spaces: health.spaces, blocked: health.blocked.length,
    wip: health.wip.map((w) => ({ seat: w.seat, held: w.held })), returned: returned.length, leaderFlag: leader.flagged ? leader.by : null, cards: cards.length, opened: opened?.version ?? null })}\n`);
  return { outcome: 'ok', live: deps.live, version, phase, order, cut, opened, returned, leaderFlag: leader.flagged ? leader.by : null, cards, digest, owner };
}

export function readCutList(dir: string, version: string): CutList | null {
  const p = cutListPath(dir, version);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as CutList; } catch { return null; }
}
