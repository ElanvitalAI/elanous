import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { addHold, covers, expireDue, frozenBy, liftHold, mayChange, narrowHold, parseUnlock, readHoldEvents, readHolds, unregisteredCards, unlockMet } from './hold-ledger.js';
import { registerHoldCommands } from './hold-cli.js';
import { blockedOn, buildFedSnapshot, type FedSources } from '../fed-observe/snapshot.js';

const T0 = new Date('2026-11-27T00:44:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const root = () => mkdtempSync(join(tmpdir(), 'hold-ledger-'));
const quiet = { fact: null } as const;

describe('HOLD ledger — object, scope, expiry', () => {
  test('add needs scope, reason and unlock; default expiry 2h; wildcard capped at 2h; any HOLD at 24h', () => {
    const r = root();
    expect(() => addHold(r, { owner: 'TC', cells: [], reason: 'x', unlock: 'y', by: 'TC' }, { now: T0, ...quiet })).toThrow('scope');
    expect(() => addHold(r, { owner: 'TC', cells: ['A'], reason: ' ', unlock: 'y', by: 'TC' }, { now: T0, ...quiet })).toThrow('--reason');
    expect(() => addHold(r, { owner: 'TC', cells: ['A'], reason: 'x', unlock: '', by: 'TC' }, { now: T0, ...quiet })).toThrow('--unlock');
    const a = addHold(r, { owner: 'tc', cells: ['cell-a', 'CELL-A', 'b'], reason: 'isolation proof', unlock: 'merged:#40324', by: 'TC' }, { now: T0, ...quiet });
    expect(a).toMatchObject({ id: 'H-1', owner: 'TC', cells: ['B', 'CELL-A'], expiresAt: '2026-11-27T02:44:00.000Z', state: 'active' });
    const w = addHold(r, { owner: 'TC', cells: ['A', '*'], reason: 'broadcast', unlock: 'TC says go', ttlMs: 10 * 3_600_000, by: 'TC' }, { now: T0, ...quiet });
    expect(w).toMatchObject({ id: 'H-2', cells: ['*'], expiresAt: '2026-11-27T02:44:00.000Z' });
    const long = addHold(r, { owner: 'JUD', cells: ['C'], reason: 'r', unlock: 'u', ttlMs: 72 * 3_600_000, by: 'JUD' }, { now: T0, ...quiet });
    expect(long.expiresAt).toBe('2026-11-28T00:44:00.000Z');
  });

  test('covers: wildcard covers every cell; an expired HOLD covers nothing even before the sweep', () => {
    const r = root();
    const h = addHold(r, { owner: 'TC', cells: ['*'], reason: 'r', unlock: 'u', ttlMs: 30 * 60_000, by: 'TC' }, { now: T0, ...quiet });
    expect(covers(h, 'ANY-CELL', at(10))).toBe(true);
    expect(covers(h, 'ANY-CELL', at(31))).toBe(false);
    expect(readHolds(r, at(31))[0]).toMatchObject({ state: 'expired', closedBy: 'EXPIRY' });
  });

  test('narrow only narrows (cells ⊆ old · expiry ≤ old) and only owner / L0 may narrow — the judge-butler may not', () => {
    const r = root();
    addHold(r, { owner: 'TC', cells: ['A', 'B', 'C'], reason: 'r', unlock: 'u', by: 'TC' }, { now: T0, ...quiet });
    expect(() => narrowHold(r, 'H-1', { cells: ['A', 'Z'], by: 'TC' }, { now: at(1), ...quiet })).toThrow('narrow only narrows');
    expect(() => narrowHold(r, 'H-1', { ttlMs: 5 * 3_600_000, by: 'TC' }, { now: at(1), ...quiet })).toThrow('only shortens');
    expect(() => narrowHold(r, 'H-1', { cells: ['A'], by: 'JUD-BUTLER' }, { now: at(1), ...quiet })).toThrow('belongs to TC');
    expect(() => narrowHold(r, 'H-1', { cells: ['A'], by: 'POOL-2' }, { now: at(1), ...quiet })).toThrow('belongs to TC');
    // the butler only proposes and expires — even a HOLD it «owned» grants it nothing, and it cannot add one
    expect(mayChange({ ...readHolds(r, at(1))[0]!, owner: 'JUDGE-BUTLER' }, 'JUDGE-BUTLER')).toBe(false);
    expect(() => addHold(r, { owner: 'JUDGE-BUTLER', cells: ['A'], reason: 'r', unlock: 'u', by: 'JUDGE-BUTLER' }, { now: at(1), ...quiet })).toThrow('only proposes and expires');
    const n = narrowHold(r, 'H-1', { cells: ['A'], ttlMs: 30 * 60_000, by: 'JUD' }, { now: at(1), ...quiet });
    expect(n).toMatchObject({ cells: ['A'], expiresAt: iso(31), narrowed: 1 });
  });

  test('COORD-RIGHTS: a coordinator in the owner\'s scope narrows and lifts (audited by), one outside the scope cannot', () => {
    const r = root();
    const scope = { coordinatorsOf: (owner: string) => (owner === 'MOB-1' ? ['OP', 'UX'] : ['OP']) };
    addHold(r, { owner: 'MOB-1', cells: ['A', 'B'], reason: 'r', unlock: 'u', by: 'MOB-1' }, { now: T0, ...quiet });
    expect(() => narrowHold(r, 'H-1', { cells: ['A'], by: 'TC' }, { now: at(1), ...quiet, ...scope })).toThrow('only the owner, a coordinator in its scope');
    expect(narrowHold(r, 'H-1', { cells: ['A'], by: 'UX', reason: 'only A is risky' }, { now: at(1), ...quiet, ...scope })).toMatchObject({ cells: ['A'], narrowed: 1 });
    expect(() => liftHold(r, 'H-1', { by: 'TC', reason: 'x' }, { now: at(2), ...quiet, ...scope })).toThrow('belongs to MOB-1');
    expect(liftHold(r, 'H-1', { by: 'ux', reason: 'unblocked' }, { now: at(2), ...quiet, ...scope })).toMatchObject({ state: 'lifted' });
    expect(readHoldEvents(r).map(e => [e.op, e.by])).toEqual([['add', 'MOB-1'], ['narrow', 'UX'], ['lift', 'UX']]);
    // the judge-butler stays propose-only even when a scope lookup names it
    expect(mayChange({ ...readHolds(r, at(3))[0]!, owner: 'MOB-1' }, 'JUDGE-BUTLER', () => ['JUDGE-BUTLER'])).toBe(false);
  });

  test('lift and expire are terminal; the sweep writes one audit row per HOLD and is idempotent', () => {
    const r = root();
    addHold(r, { owner: 'TC', cells: ['A'], reason: 'r', unlock: 'u', ttlMs: 10 * 60_000, by: 'TC' }, { now: T0, ...quiet });
    addHold(r, { owner: 'OP', cells: ['B'], reason: 'r', unlock: 'merged:#40324', by: 'OP' }, { now: T0, ...quiet });
    addHold(r, { owner: 'OP', cells: ['C'], reason: 'r', unlock: 'u', by: 'OP' }, { now: T0, ...quiet });
    expect(liftHold(r, 'H-3', { by: 'OP', reason: 'done' }, { now: at(1), ...quiet }).state).toBe('lifted');
    expect(() => liftHold(r, 'H-3', { by: 'OP', reason: 'again' }, { now: at(2), ...quiet })).toThrow('already lifted');
    expect(expireDue(r, { by: 'JUD-BUTLER', dryRun: true }, { now: at(11), ...quiet })).toHaveLength(1);
    const swept = expireDue(r, { by: 'JUD-BUTLER', unlockFacts: { merged: new Set([40324]), green: new Set() } }, { now: at(11), ...quiet });
    expect(swept.map(x => `${x.id}:${x.reason}`)).toEqual(['H-1:expiry 2026-11-27T00:54:00.000Z passed', 'H-2:unlock met: #40324 merged']);
    expect(swept[0]!.audit).toBe('2026-11-27T00:55:00.000Z hold H-1 (TC · A) auto-lifted by JUD-BUTLER — expiry 2026-11-27T00:54:00.000Z passed');
    expect(expireDue(r, { by: 'JUD-BUTLER' }, { now: at(12), ...quiet })).toEqual([]);
    const events = readFileSync(join(r, 'hold-ledger', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { op: string });
    expect(events.map(e => e.op)).toEqual(['add', 'add', 'add', 'lift', 'expire', 'expire']);
  });

  test('unlock conditions: merged:#N · green:CELL · free text never auto-lifts', () => {
    expect(parseUnlock('merged:#40324')).toEqual({ kind: 'merged', pr: 40324 });
    expect(parseUnlock('green:jud-butler')).toEqual({ kind: 'green', cell: 'JUD-BUTLER' });
    expect(parseUnlock('TC confirms the OS sandbox')).toEqual({ kind: 'text', text: 'TC confirms the OS sandbox' });
    const r = root();
    const h = addHold(r, { owner: 'TC', cells: ['A'], reason: 'r', unlock: 'green:A', by: 'TC' }, { now: T0, ...quiet });
    expect(unlockMet(h, { merged: new Set(), green: new Set(['A']) })).toBe('unlock met: A green');
    expect(unlockMet({ ...h, unlock: 'when ready' }, { merged: new Set([1]), green: new Set(['A']) })).toBeNull();
  });
});

describe('HOLD ledger — frozen hands, snapshot, unregistered broadcasts', () => {
  const blocks = [
    { by: 'H1', on: 'TC', cell: 'A', reason: 'HOLD 유지', at: iso(-5) },
    { by: 'H2', on: 'TC', cell: 'B', reason: 'HOLD 유지', at: iso(-5) },
    { by: 'H3', on: 'TC', cell: 'C', reason: 'HOLD 유지', at: iso(-5) },
    { by: 'H4', on: 'OP', cell: 'D', reason: 'OP 금지', at: iso(-5) },
    { by: 'H5', on: 'OP', cell: 'E', reason: 'OP 금지', at: iso(-5) },
    { by: 'H6', on: 'OP', cell: 'F', reason: 'OP 금지', at: iso(-5) },
  ];

  test('frozenBy: a registered HOLD freezes only the hands whose cell it covers; others wait on an unregistered HOLD', () => {
    const r = root();
    addHold(r, { owner: 'TC', cells: ['*'], reason: 'broadcast', unlock: 'u', by: 'TC' }, { now: at(-10), ...quiet });
    const { frozen, unregistered } = frozenBy(readHolds(r, T0), blocks, T0);
    expect(frozen.map(f => `${f.hold.id}:${f.hands.join(',')}`)).toEqual(['H-1:H1,H2,H3']);
    expect([...unregistered]).toEqual([['OP', ['H4', 'H5', 'H6']]]);
    narrowHold(r, 'H-1', { cells: ['A'], by: 'TC' }, { now: at(-1), ...quiet });
    expect(frozenBy(readHolds(r, T0), blocks, T0).frozen.map(f => f.hands.join(','))).toEqual(['H1']);
  });

  test('fed snapshot: hold-freeze reads the ledger (scope ∩ cell); HOLD words without a registered HOLD = hold-unregistered (yellow)', () => {
    const r = root();
    addHold(r, { owner: 'TC', cells: ['*'], reason: 'isolation', unlock: 'u', by: 'TC' }, { now: at(-10), ...quiet });
    const src = (holdLedger: FedSources['holdLedger']): FedSources => ({ now: T0, installedSha: null, panes: [], pool: [], turns: [], errors: [], queues: [], mail: [], hands: [],
      blocks, holdLedger, landingFreeze: null, landHolds: [], commitments: null, land: null, judge: null, loops: null, release: null, kpi: null, unmeasured: [] });
    const s = buildFedSnapshot(src(readHolds(r, T0)));
    expect(s.anomalies.map(a => `${a.rule}:${a.seat}:${a.severity}`)).toEqual(['hold-freeze:TC:red', 'hold-unregistered:OP:yellow']);
    expect(s.anomalies[0]!.why).toContain('H-1');
    expect(s.holds.ledger).toEqual({ active: 1, ids: ['H-1'] });
    // narrowed to one cell → below the freeze threshold → no red
    narrowHold(r, 'H-1', { cells: ['A'], by: 'TC' }, { now: at(-1), ...quiet });
    expect(buildFedSnapshot(src(readHolds(r, T0))).anomalies.map(a => a.rule)).toEqual(['hold-unregistered']);
    // ledger unreadable → the old words rule (both red)
    expect(buildFedSnapshot(src(null)).anomalies.map(a => a.rule)).toEqual(['hold-freeze', 'hold-freeze']);
    expect(blockedOn(blocks, T0, []).every(g => !g.hold && g.unregistered)).toBe(true);
  });

  test('blockedOn: a registered HOLD on one cell never hides the same seat\'s unregistered HOLD hands (counted separately)', () => {
    const r = root();
    addHold(r, { owner: 'TC', cells: ['A'], reason: 'one cell', unlock: 'u', by: 'TC' }, { now: at(-10), ...quiet });
    const four = [
      { by: 'H1', on: 'TC', cell: 'A', reason: 'HOLD 유지', at: iso(-5) }, { by: 'H2', on: 'TC', cell: 'B', reason: 'HOLD 유지', at: iso(-5) },
      { by: 'H3', on: 'TC', cell: 'C', reason: 'HOLD 유지', at: iso(-5) }, { by: 'H4', on: 'TC', cell: 'D', reason: 'HOLD 유지', at: iso(-5) },
      { by: 'H5', on: 'TC', cell: 'E', reason: 'waiting on review', at: iso(-5) },
    ];
    const groups = blockedOn(four, T0, readHolds(r, T0));
    expect(groups.map(g => `${g.on}:${g.hands.join(',')}:${g.hold ? 'reg' : g.unregistered ? 'unreg' : 'other'}`)).toEqual(['TC:H2,H3,H4:unreg', 'TC:H1:reg', 'TC:H5:other']);
    const src: FedSources = { now: T0, installedSha: null, panes: [], pool: [], turns: [], errors: [], queues: [], mail: [], hands: [], blocks: four, holdLedger: readHolds(r, T0),
      landingFreeze: null, landHolds: [], commitments: null, land: null, judge: null, loops: null, release: null, kpi: null, unmeasured: [] };
    expect(buildFedSnapshot(src).anomalies.map(a => `${a.rule}:${a.seat}`)).toEqual(['hold-unregistered:TC']);
  });

  test('unregistered broadcast → one OP card only after 30 min, never for a registered or scoped one', () => {
    const r = root();
    const b = (msgId: number, ageMin: number, scoped = false) => ({ coordinator: 'tc', msgId, at: iso(-ageMin), frozen: ['H1', 'H2'], scoped, body: '시험·원격 HOLD' });
    addHold(r, { owner: 'TC', cells: ['A'], reason: 'r', unlock: 'u', sourceMsg: 3, by: 'TC' }, { now: T0, ...quiet });
    const cards = unregisteredCards([b(1, 29), b(2, 31), b(3, 45), b(4, 60, true)], readHolds(r, T0), T0.getTime());
    expect(cards.map(c => c.key)).toEqual(['hold-unregistered:2']);
    expect(cards[0]!.body).toContain('Register it (not void): eln hold add --owner TC');
    expect(cards[0]!.body).toContain('--from-msg 2');
  });
});

describe('eln hold — CLI door', () => {
  test('add → ls --cell → narrow → expire → ls --all, with the writer from --by', async () => {
    const r = root(); const out: string[] = []; const err: string[] = [];
    let now = T0;
    const program = new Command().exitOverride();
    const facts: string[] = [];
    registerHoldCommands(program, { stateRoot: () => r, now: () => now, print: l => out.push(l), error: l => err.push(l), caller: () => null, fact: e => facts.push(`${e.op}:${e.id}:${e.by}`) });
    const run = (...args: string[]) => program.parseAsync(['node', 'eln', 'hold', ...args]);
    await run('add', '--cells', 'A,B', '--reason', 'isolation proof', '--unlock', 'merged:#40324', '--by', 'TC', '--expires', '30m');
    expect(out.pop()).toStartWith('added H-1\tTC\tA,B\texpires 2026-11-27T01:14:00.000Z (30m)');
    await run('ls', '--cell', 'C');
    expect(out.pop()).toBe('no active HOLD covers C — proceed');
    await run('narrow', 'H-1', '--cells', 'A', '--by', 'JUD-BUTLER');
    expect(err.pop()).toContain('belongs to TC');
    await run('narrow', 'H-1', '--cells', 'A', '--by', 'TC');
    expect(out.pop()).toStartWith('narrowed H-1\tTC\tA\t');
    now = at(31);
    await run('expire');
    expect(out).toContain('hold expire: 1 lifted');
    await run('ls', '--all', '--json');
    expect(JSON.parse(out.pop()!)[0]).toMatchObject({ id: 'H-1', state: 'expired', closedBy: 'HOLD-SWEEP' });
    expect(facts).toEqual(['add:H-1:TC', 'narrow:H-1:TC', 'expire:H-1:HOLD-SWEEP']); // the injected sink, never the live facts.jsonl
    process.exitCode = 0;
  });
});
