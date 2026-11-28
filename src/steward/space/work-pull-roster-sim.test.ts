// SIM — WORK-PULL-REACHES-ROSTER (0.3.39 P0 · audit 11-28 00:47–01:47Z). The live shape: 149 `eln work next` claims on 54
// cells and none of the ~37 OP-held 0.3.39 roster cells (OP is ladder depth 1 · only depth-2 seats counted as
// coordinators) · 93 of the 149 were the same hand re-taking a cell it had just parked with `work block`, because any later
// mail from the awaited seat to the hand «answered» the block (PWA-ELN-CONTRACT 8× by TC-H-CX-4) · OP's table handed out
// P2 while steward:hq paired only P0/P1. Seeded worlds (OP-held roster cells · TC hands) through the ONE policy
// (graphs/policies/work-pull.yaml · the shipped file) and two engines per scene: A = the pure board (in-memory compare-and-
// set), B = the real checklist ledger (addItem · setWriterIf · swapOwnerIf · listChecklist in a temp config dir) ⊕ a real
// msg store for block answers. Expectations are literals or counted from the fixture (rule 11), never product constants.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { MsgStore } from '../../msg/msg-store.js';
import { addItem, checklistHistory, listChecklist, setItem, setWriterIf, swapOwnerIf } from '../../release-loop/checklist.js';
import { blockState, openBlocks, workBlock, type CellBlockRow } from './cell-block.js';
import { hasCoordinatorAuthority, legacyPullPolicy, loadPullPolicy, parsePullPolicy, readRoster, rosterRank, writeRoster, type PullPolicy } from '../../kit/work-pull/index.js';
import { blockRepliesAtMs, firstBlockReplies, type BlockReplyRow } from './work-next-cli.js';
import { workNext, type BoardCell, type WorkNextDeps } from './work-next.js';

const V = '9.9.9';
const ONE_MINUTE = 60_000;
const NOW = Date.parse('2026-11-28T01:00:00.000Z');
const SEEDS = [1, 7, 42, 1127, 2026];
const iso = (ms: number): string => new Date(ms).toISOString();
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const ladder = buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC-1', 'TC-2', 'TC-3', 'TC-4'] }, { coordinator: 'JUD', seats: ['JUD-1'] }] });
const POLICY = (): PullPolicy => loadPullPolicy();

interface Seed { id: string; owner?: string; priority?: 'P0' | 'P1' | 'P2'; evidence?: string }
interface Engine {
  readonly name: 'A' | 'B';
  /** Scene clock origin: A = a fixed instant · B = the real clock after the board is written (the ledger stamps real time). */
  t0: number;
  now: number;
  cells(): BoardCell[];
  swap: (id: string, input: { expectedOwner: string | null; to: string | null; actor: string; reason: string }) => { outcome: 'swapped' | 'lost' | 'missing' };
  setWriter: NonNullable<WorkNextDeps['setWriter']>;
  /** writer events of one cell (B = the ledger history · A = the in-memory log). */
  writerEvents(id: string): number;
}

let root = '';
const roots: string[] = [];
/** A fresh temp config dir (engine B writes its board there) — one per world. */
function freshRoot(): void { root = mkdtempSync(join(tmpdir(), 'work-pull-roster-sim-')); roots.push(root); setElanousConfigDir(root); }
beforeEach(() => { freshRoot(); });
afterEach(() => { resetElanousConfigDir(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function engineA(board: Seed[]): Engine {
  type Mut = { id: string; title: string; status: string; owner?: string | null; priority?: string; evidence?: string; doneCriterion: string; updatedAt: string; updatedBy?: string; writer?: { seat: string; at: string } };
  const items: Mut[] =
    board.map((c, i) => ({ id: c.id, title: c.id, status: 'yellow', ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}),
      ...(c.evidence ? { evidence: c.evidence } : {}), doneCriterion: `${c.id} done`, updatedAt: iso(NOW - (60 + i) * ONE_MINUTE), updatedBy: 'OP' }));
  const log: string[] = [];
  const e: Engine = {
    name: 'A', t0: NOW, now: NOW,
    cells: () => items.map((c) => { const { owner, ...rest } = c; return { ...rest, ...(owner ? { owner } : {}) } as BoardCell; }),
    swap: (id, input) => {
      const c = items.find((x) => x.id === id);
      if (!c) return { outcome: 'missing' };
      if ((c.owner ?? null) !== input.expectedOwner) return { outcome: 'lost' };
      c.owner = input.to; delete c.writer; c.updatedAt = iso(e.now); c.updatedBy = input.actor;
      return { outcome: 'swapped' };
    },
    setWriter: (id, input) => {
      const c = items.find((x) => x.id === id);
      if (!c) return { outcome: 'missing' };
      if ((c.owner ?? null) !== input.expectedOwner || (c.writer?.seat ?? null) !== input.expectedWriter) return { outcome: 'lost' };
      if (input.to === null) delete c.writer; else c.writer = { seat: input.to, at: iso(e.now) };
      c.updatedAt = iso(e.now); c.updatedBy = input.actor; log.push(id);
      return { outcome: 'swapped' };
    },
    writerEvents: (id) => log.filter((x) => x === id).length,
  };
  return e;
}

function engineB(board: Seed[]): Engine {
  for (const c of board) {
    addItem(V, { id: c.id, title: c.id, ...(c.owner ? { owner: c.owner } : {}), ...(c.priority ? { priority: c.priority } : {}), doneCriterion: `${c.id} done` });
    if (c.evidence) setItem(V, c.id, { evidence: c.evidence }, 'OP');
  }
  const t0 = Date.now();
  return {
    name: 'B', t0, now: t0,
    cells: () => listChecklist(V).items as unknown as BoardCell[],
    swap: (id, input) => swapOwnerIf(V, id, input),
    setWriter: (id, input) => setWriterIf(V, id, input),
    writerEvents: (id) => checklistHistory(id).filter((h) => h.field === 'writer' && h.to !== null).length,
  };
}

const ENGINES = [['A', engineA], ['B', engineB]] as const;

/** `eln work next` deps on an engine: the shipped policy (or the pre-policy board when `policy` is null). */
function deps(e: Engine, active: Record<string, number | undefined>, policy: PullPolicy | null, extra: Partial<WorkNextDeps> = {}): WorkNextDeps {
  const p = policy ?? legacyPullPolicy();
  return {
    now: () => e.now, version: V, cells: () => e.cells(), scopeOf: (s) => ladder.parentOf(s).toUpperCase(),
    lastActiveMs: (s) => active[s], swap: e.swap,
    ...(policy ? { policy: () => policy, setWriter: e.setWriter } : {}),
    // pre-policy = the live wiring before this PR (ladder depth 2 only)
    isCoordinator: (s) => (policy ? hasCoordinatorAuthority(ladder.depthOf(s), p) : ladder.depthOf(s) === 2),
    ...extra,
  };
}
const pull = (e: Engine, seat: string, active: Record<string, number | undefined>, policy: PullPolicy | null = POLICY(), extra: Partial<WorkNextDeps> = {}): string => {
  const r = workNext(seat, deps(e, active, policy, extra));
  return r.code === 0 ? r.cell.id : r.code === 4 ? `wip ${r.cell.id}` : `code ${r.code}`;
};
const cell = (e: Engine, id: string): BoardCell => e.cells().find((c) => c.id === id)!;

/** 2–5 OP-held roster P0 cells (OP · OP/claude alternating) — the 0.3.39 roster's shape. */
function opRoster(seed: number): Seed[] {
  const n = 2 + Math.floor(rng(seed)() * 4);
  return Array.from({ length: n }, (_, i) => ({ id: `ROS-${i}`, owner: i % 2 ? 'OP/claude' : 'OP', priority: 'P0' as const, evidence: `roster ${i} · supply` }));
}

describe('SIM WORK-PULL-REACHES-ROSTER — seeds 1 · 7 · 42 · 1127 · 2026 · engines A (pure board) · B (checklist ledger)', () => {
  test('the shipped policy: HQ ⊕ space coordinators hold the board · P0 > P1 > P2 · reserve / WIP-leftover markers · progress signals · block answers', () => {
    const p = POLICY();
    expect(p.coordinatorDepths).toEqual([1, 2]);
    expect(p.priorities).toEqual(['P0', 'P1', 'P2']);
    expect(p.reserveMarkers).toEqual(['[예비 ']);
    expect(p.neverMarkers).toEqual(['[WIP 잔류 ']);
    expect(p.writerLeaseMin).toBe(45);
    expect(p.progress).toEqual(['claim', 'cell-change', 'activity', 'pr-update']);
    expect(p.blockResolve).toEqual(['reply-to', 'cell-ref', 'cell-touch']);
    expect(['OP', 'TC', 'JUD', 'TC-1'].map((s) => hasCoordinatorAuthority(ladder.depthOf(s), p))).toEqual([true, true, true, false]);
  });

  test('a wrong policy file says what is wrong (the live reader then falls back to the pre-policy board)', () => {
    const ok = 'coordinator_depths: [1, 2]\norder: {priorities: [P0]}\nwriter: {lease_min: 45, progress: [claim]}\nblock: {resolve_on: [reply-to]}';
    expect(parsePullPolicy(ok).coordinatorDepths).toEqual([1, 2]);
    expect(() => parsePullPolicy(ok.replace('[claim]', '[heartbeat]'))).toThrow('writer.progress has unknown heartbeat');
    expect(() => parsePullPolicy(ok.replace('[1, 2]', '[0]'))).toThrow('coordinator_depths');
    expect(() => parsePullPolicy(ok.replace('lease_min: 45', 'lease_min: 0'))).toThrow('writer.lease_min');
    expect(() => parsePullPolicy(ok.replace('[reply-to]', '[any-mail]'))).toThrow('block.resolve_on has unknown any-mail');
  });

  for (const seed of SEEDS) {
    for (const [name, make] of ENGINES) {
      test(`seed ${seed} · ${name} · S1 an OP-held roster cell is claimed by an idle hand in ONE work next — writer = the hand, owner stays OP (pre-policy: 일감 0)`, () => {
        const board = opRoster(seed);
        const e = make(board);
        const active = { 'TC-1': e.t0 };
        expect(pull(e, 'TC-1', active, null)).toBe('code 3');
        const got = pull(e, 'TC-1', active);
        const owners = Object.fromEntries(board.map((c) => [c.id, c.owner]));
        expect(Object.keys(owners)).toContain(got);
        const c = cell(e, got);
        expect(c.owner).toBe(owners[got]);
        expect(c.writer?.seat).toBe('TC-1');
        // Every other OP cell is untouched (no owner change anywhere).
        expect(e.cells().map((x) => x.owner)).toEqual(board.map((x) => x.owner));
        // The hand's next call continues its own writer cell (WIP 1).
        expect(pull(e, 'TC-1', active)).toBe(`wip ${got}`);
      });

      test(`seed ${seed} · ${name} · S2 a second hand never re-claims the cell while the first shows progress (activity · then a PR update)`, () => {
        const board = opRoster(seed);
        const e = make(board);
        const first = pull(e, 'TC-1', { 'TC-1': e.t0 });
        const others = board.length - 1;
        // +30 / +44 / +90 min with every hand that claimed still active: TC-2 · TC-3 · TC-4 take other cells or none —
        // never TC-1's, and never each other's.
        const seen: string[] = [];
        for (const [k, seat] of [[30, 'TC-2'], [44, 'TC-3'], [90, 'TC-4']] as const) {
          e.now = e.t0 + k * ONE_MINUTE;
          seen.push(pull(e, seat, { 'TC-1': e.now, 'TC-2': e.now, 'TC-3': e.now, 'TC-4': e.now }));
        }
        expect(seen).not.toContain(first);
        const got = seen.filter((x) => x.startsWith('ROS-'));
        expect(got.length).toBe(Math.min(3, others));
        expect(new Set(got).size).toBe(got.length);
        expect(seen.filter((x) => x === 'code 3').length).toBe(3 - Math.min(3, others));
        expect(e.writerEvents(first)).toBe(1);
        // Progress through a PR only: TC-1 quiet since the claim, its PR updated at +60 → at +100 still TC-1's.
        freshRoot();
        const e2 = make(board.map((c) => ({ ...c, id: `${c.id}-PR` })));
        const one = pull(e2, 'TC-1', { 'TC-1': e2.t0 });
        e2.now = e2.t0 + 100 * ONE_MINUTE;
        const prUpdatedMs = (c: BoardCell): number | undefined => (c.id === one ? e2.t0 + 60 * ONE_MINUTE : undefined);
        const next = pull(e2, 'TC-2', { 'TC-1': e2.t0, 'TC-2': e2.now }, POLICY(), { prUpdatedMs });
        expect(next).not.toBe(one);
        expect(next.startsWith('ROS-')).toBe(true);
        // Without the PR signal the same quiet writer's claim (+0) would be past 45 min at +100.
        expect(claimOverAt(e2, one)).toBe(true);
      });

      test(`seed ${seed} · ${name} · S3 a silent writer's claim is released after the lease → reclaimable ONCE`, () => {
        const r = rng(seed);
        const e = make([{ id: 'ROS-ONLY', owner: r() < 0.5 ? 'OP' : 'OP/claude', priority: 'P0', evidence: 'roster · supply' }]);
        expect(pull(e, 'TC-1', { 'TC-1': e.t0 })).toBe('ROS-ONLY');
        e.now = e.t0 + 30 * ONE_MINUTE;
        expect(pull(e, 'TC-2', { 'TC-1': e.t0, 'TC-2': e.now })).toBe('code 3');
        // TC-1 silent since the claim; +46 min: TC-2 takes it (one writer swap naming TC-1) · TC-3 at the same minute: none.
        e.now = e.t0 + 46 * ONE_MINUTE;
        const quiet = { 'TC-1': e.t0, 'TC-2': e.now, 'TC-3': e.now };
        expect(pull(e, 'TC-2', quiet)).toBe('ROS-ONLY');
        expect(pull(e, 'TC-3', quiet)).toBe('code 3');
        expect(pull(e, 'TC-1', quiet)).toBe('code 3');
        expect(cell(e, 'ROS-ONLY').writer?.seat).toBe('TC-2');
        expect(e.writerEvents('ROS-ONLY')).toBe(2);
      });

      test(`seed ${seed} · ${name} · S4 roster P0 before roster P2 before reserve · WIP leftover never · OP's roster rank leads`, () => {
        const r = rng(seed);
        const cells: Seed[] = [
          { id: 'R-P2', owner: 'OP', priority: 'P2', evidence: 'roster · P2' },
          { id: 'R-P0', owner: 'OP/claude', priority: 'P0', evidence: 'roster · P0' },
          { id: 'V-P0', owner: 'OP', priority: 'P0', evidence: '[예비 0.3.39] reserve' },
          { id: 'W-P0', owner: 'TC', priority: 'P0', evidence: '[WIP 잔류 0.3.39] its PR finishes it' },
        ];
        const shuffled = cells.map((c) => ({ c, k: r() })).sort((a, b) => a.k - b.k).map((x) => x.c);
        const e = make(shuffled);
        const a = (seat: string) => pull(e, seat, { [seat]: e.now });
        expect(['TC-1', 'TC-2', 'TC-3', 'TC-4'].map(a)).toEqual(['R-P0', 'R-P2', 'V-P0', 'code 3']);
        // OP's roster rank (`eln work roster R-P2 R-P0`): rank first, then priority.
        writeRoster(root, { version: V, cells: ['R-P2', 'R-P0'], by: 'OP', nowMs: NOW });
        const rank = rosterRank(readRoster(root), V);
        expect([...rank!.entries()]).toEqual([['R-P2', 0], ['R-P0', 1]]);
        freshRoot();
        const e2 = make(shuffled.map((c) => ({ ...c, id: `${c.id}-K` })));
        const rankK = new Map([...rank!].map(([id, n]) => [`${id}-K`, n]));
        const b = (seat: string) => pull(e2, seat, { [seat]: e2.now }, POLICY(), { rosterRank: () => rankK });
        expect(['TC-1', 'TC-2', 'TC-3', 'TC-4'].map(b)).toEqual(['R-P2-K', 'R-P0-K', 'V-P0-K', 'code 3']);
      });

      test(`seed ${seed} · ${name} · S5 a parked writer cell comes back only on an answer ABOUT it (pre-policy: any mail re-offered it)`, () => {
        const r = rng(seed);
        const e = make([{ id: 'BLK', owner: 'OP', priority: 'P0', evidence: 'roster · waits on a decision' }]);
        expect(pull(e, 'TC-1', { 'TC-1': e.t0 })).toBe('BLK');
        const rows: CellBlockRow[] = [];
        const blocked = workBlock('TC-1', 'BLK', { on: 'TC', reason: 'needs the contract decision' }, {
          now: () => e.now, version: V, cells: () => e.cells(), scopeOf: (s) => ladder.parentOf(s).toUpperCase(), blocks: () => rows,
          swap: e.swap, setWriter: e.setWriter, mail: () => 7001, record: (row) => rows.push(row), hq: 'OP' });
        expect(blocked.code).toBe(0);
        expect(cell(e, 'BLK').owner).toBe('OP');
        expect(cell(e, 'BLK').writer).toBeUndefined();
        const block = openBlocks(rows, V).get('BLK')!;
        // TC mails TC-1 about something else 3–8 min later (the hourly shape: TC talks to its hands all the time).
        const later = iso(Date.parse(block.at) + (3 + Math.floor(r() * 6)) * ONE_MINUTE);
        const answers = (resolve: readonly ('reply-to' | 'cell-ref' | 'cell-touch' | 'addressed-mail')[], mails: Array<{ id: number; at: string; replyTo?: number; refs?: string[] }>) => {
          if (e.name === 'A') {
            const list: BlockReplyRow[] = mails.map((m) => ({ id: m.id, sender: 'TC', recipient: 'TC-1', reply_to: m.replyTo ?? null, created_at: m.at, refs_json: JSON.stringify(m.refs ?? []) }));
            return firstBlockReplies([{ cell: 'BLK', block, board: 'OP' }], list, resolve).get('BLK');
          }
          const store = new MsgStore(join(root, `m-${seed}-${mails.length}-${resolve.length}.db`), { now: () => new Date(Date.parse(block.at) + ONE_MINUTE) });
          const ids: number[] = [];
          for (const m of mails) ids.push(store.append({ from: 'TC', to: 'TC-1', body: `note ${m.id}`, ...(m.refs ? { refs: m.refs } : {}) }).id);
          // The real store numbers its own ids from 1: the block's exception-mail anchor is 0 there.
          try { return blockRepliesAtMs(store.db, [{ cell: 'BLK', block: { ...block, mailId: 0 }, board: 'OP' }], resolve).get('BLK'); }
          finally { store.close(); }
        };
        const noise = [{ id: 7100, at: later }];
        const stateFor = (resolve: Parameters<typeof answers>[0], mails: Parameters<typeof answers>[1]) => blockState(block, 'TC-1', answers(resolve, mails), e.now);
        // The shipped policy: the unrelated mail does not answer the block → still blocked, nobody re-takes BLK.
        expect(stateFor(POLICY().blockResolve, noise)).toBe('blocked');
        // The pre-policy rule (addressed-mail): the same mail re-offers it to TC-1 — the 93-claim churn.
        expect(stateFor(['reply-to', 'addressed-mail'], noise)).toBe('reoffer');
        // A mail about BLK (refs cell:BLK) answers it → re-offered to TC-1, which claims it once.
        expect(stateFor(POLICY().blockResolve, [...noise, { id: 7101, at: later, refs: ['cell:BLK'] }])).toBe('reoffer');
        const blockOf = (c: BoardCell) => (c.id === 'BLK' ? 'reoffer' as const : undefined);
        expect(pull(e, 'TC-1', { 'TC-1': e.now }, POLICY(), { blockOf })).toBe('BLK');
        expect(cell(e, 'BLK').writer?.seat).toBe('TC-1');
        expect(cell(e, 'BLK').owner).toBe('OP');
      });

      test(`seed ${seed} · ${name} · S6 equivalence — a board with no HQ-held / marked / written cells claims the same under the policy and before it`, () => {
        const r = rng(seed);
        const owners = ['TC', undefined, 'TC', 'JUD', undefined];
        const prios = ['P0', 'P1', 'P2', undefined] as const;
        const board: Seed[] = Array.from({ length: 6 + Math.floor(r() * 4) }, (_, i) => {
          const o = owners[Math.floor(r() * owners.length)];
          const p = prios[Math.floor(r() * prios.length)];
          return { id: `EQ-${i}`, ...(o ? { owner: o } : {}), ...(p ? { priority: p } : {}) };
        });
        const ea = make(board);
        const before = ['TC-1', 'TC-2', 'TC-3', 'TC-4'].map((s) => pull(ea, s, { [s]: ea.now }, null));
        freshRoot();
        const eb = make(board);
        const after = ['TC-1', 'TC-2', 'TC-3', 'TC-4'].map((s) => pull(eb, s, { [s]: eb.now }));
        expect(after).toEqual(before);
        // Coordinator-held TC cells (depth 2) are claimed by owner swap before the policy and by writer after it.
        const tcClaims = before.filter((id) => board.find((c) => c.id === id)?.owner === 'TC').length;
        expect(eb.cells().filter((c) => c.writer).length).toBe(tcClaims);
      });
    }
  }
});

/** True when the cell's writer claim (claim · its own cell change · no activity · no PR) has run out at the engine's now. */
function claimOverAt(e: Engine, id: string): boolean {
  const c = cell(e, id);
  const until = Math.max(Date.parse(c.writer!.at), Date.parse(c.updatedAt)) + 45 * ONE_MINUTE;
  return until < e.now;
}
