// COND-WATCH sweep 시험 — 가짜 시계 · 임시 깨우개 디렉터리 · 가짜 탐침 · 가짜 notice. 기대값은 독립 리터럴(제품 상수 재사용 0).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommitmentLedger } from './ledger.js';
import { findPregateReceipt } from './pregate-receipt-dir.js';
import { listOpenConditions, loadConditionSweepPolicy, parseConditionSweepPolicy, sweepConditions, writeSweepReport } from './condition-sweep.js';
import { armWaker, listWakers, retireStaleWaker, type SelfTimerDeps, type WaitProbes } from '../msg/self-timer-watch.js';
import { registerCommitmentCommands } from '../cli/commitment-cli.js';
import { watchSweep } from '../loops/trigger-nodes.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const T0 = Date.parse('2026-11-28T00:00:00.000Z');
const MIN = 60_000; // 출처: #40586 — one minute in ms (the scenario clock unit, not a bound)

function world(probe: Partial<WaitProbes> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cond-sweep-')); roots.push(root);
  const greenDir = join(root, 'PREGATE-GREEN');
  mkdirSync(greenDir, { recursive: true });
  let nowMs = T0;
  let cid = 0, wid = 0;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const notices: { seat: string; body: string }[] = [];
  const now = () => new Date(nowMs);
  const emit = (_c: string, event: string, data: Record<string, unknown>) => { events.push({ event, data }); };
  const ledger = new CommitmentLedger({ root: join(root, 'ledger'), now, newId: () => `c-${++cid}`, emit });
  const probes: WaitProbes = {
    prMerged: async () => false, reviewArrived: async () => false, mailReplied: async () => false, fileExists: async () => false,
    pregateReceipt: async (pr, head) => { const lane = findPregateReceipt(greenDir, pr, head); return lane ? `receipt ${lane}` : null; },
    cellStatus: async () => ({ status: 'yellow' }),
    ...probe,
  };
  const alivePids = new Set<number>();
  const deps: SelfTimerDeps = {
    root: join(root, 'wakers'), ledger, now, emit, probes, newId: () => `w-${++wid}`,
    sleep: async (ms) => { nowMs += ms; },
    postNotice: async (seat, body) => { notices.push({ seat, body }); return 500 + notices.length; },
    pid: 77, isPidAlive: (pid) => alivePids.has(pid),
  };
  const arm = (seat: string, condition: string, withinMs: number, autoClose = true) => {
    const entry = ledger.add({ seat, sessionId: `msg:${cid + 1}`, text: `Watch ${condition}`, evidence: 'MsgPost' }).entry;
    return armWaker({ seat, commitmentId: entry.id, condition, withinMs, autoClose }, deps).waker;
  };
  return { root, greenDir, deps, ledger, events, notices, alivePids, arm, advance: (ms: number) => { nowMs += ms; } };
}

describe('stale backlog — recorded, nobody woken', () => {
  test('a stale local-ledger watch that holds now closes the commitment done silently', async () => {
    const w = world({ cellStatus: async () => ({ status: 'green' }) });
    const waker = w.arm('TC', 'cell-status:LAND-QUEUE-1=green', 60 * MIN);
    w.advance(3 * 60 * MIN); // horizon passed 2 h ago
    const r = await sweepConditions({}, w.deps);
    expect(r.counts).toEqual({ 'stale-satisfied': 1 });
    expect(r.wakes).toBe(0);
    expect(w.notices).toHaveLength(0);
    expect(listWakers('TC', w.deps)[0]!.status).toBe('fired');
    const entry = w.ledger.get('TC', waker.commitmentId)!;
    expect(entry.status).toBe('done');
    expect(entry.doneEvidence).toBe('watch cell-status:LAND-QUEUE-1=green: cell LAND-QUEUE-1 status=green');
    const sat = w.events.filter(e => e.event === 'commitment.watch.satisfied');
    expect(sat).toHaveLength(1);
    expect(sat[0]!.data.silent).toBe(true);
  });

  test('a stale reply-wait is cancelled with a reason, the commitment stays open, no wake', async () => {
    const w = world({ mailReplied: async () => { throw new Error('must not be probed'); } });
    const waker = w.arm('OP', 'mail-reply:188001', 10 * MIN, false);
    w.advance(50 * MIN);
    const r = await sweepConditions({}, w.deps);
    expect(r.counts).toEqual({ 'stale-cancelled': 1 });
    expect(w.notices).toHaveLength(0);
    const after = listWakers('OP', w.deps)[0]!;
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason!.startsWith('stale: horizon 2026-11-28T00:10:00.000Z passed unmeasured')).toBe(true);
    expect(w.ledger.get('OP', waker.commitmentId)!.status).toBe('open');
  });

  test('retireStaleWaker on a closed waker is a no-op', async () => {
    const w = world();
    const waker = w.arm('OP', 'pr-merged:40600', 10 * MIN);
    w.advance(60 * MIN);
    expect((await retireStaleWaker('OP', waker.id, w.deps)).outcome).toBe('stale-cancelled');
    expect((await retireStaleWaker('OP', waker.id, w.deps)).outcome).toBe('closed');
  });
});

describe('live conditions — one wake when met or expired', () => {
  test('a receipt that appears closes the commitment with evidence and wakes the owner once', async () => {
    const w = world();
    const waker = w.arm('OP', 'pregate-receipt:40600', 120 * MIN);
    expect((await sweepConditions({}, w.deps)).counts).toEqual({ pending: 1 });
    mkdirSync(join(w.greenDir, '40600-0123456789ab-node-b'));
    const r = await sweepConditions({}, w.deps);
    expect(r.counts).toEqual({ fired: 1 });
    expect(r.wakes).toBe(1);
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.body.startsWith('✅ watch satisfied · pregate-receipt:40600 · receipt 40600-0123456789ab-node-b')).toBe(true);
    expect(w.ledger.get('OP', waker.commitmentId)!.status).toBe('done');
    // the next sweep sees nothing armed — never a second wake
    expect((await sweepConditions({}, w.deps)).armed).toBe(0);
    expect(w.notices).toHaveLength(1);
  });

  test('a horizon passed inside the stale window expires loudly once', async () => {
    const w = world();
    w.arm('UX', 'pr-merged:40601', 20 * MIN);
    w.advance(25 * MIN);
    const r = await sweepConditions({}, w.deps);
    expect(r.counts).toEqual({ expired: 1 });
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]!.body.startsWith('⌛')).toBe(true);
  });

  test('a waker another live process watches is skipped', async () => {
    const w = world({ cellStatus: async () => ({ status: 'green' }) });
    const waker = w.arm('TC', 'cell-status:X-1=green', 60 * MIN);
    // simulate a detached watcher alive on pid 4242
    const file = join(w.deps.root!, 'TC.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { wakers: Record<string, unknown>[] };
    doc.wakers[0]!.watcherPid = 4242;
    await Bun.write(file, JSON.stringify(doc));
    w.alivePids.add(4242);
    expect((await sweepConditions({}, w.deps)).counts).toEqual({ 'watched-elsewhere': 1 });
    expect(listWakers('TC', w.deps).find(x => x.id === waker.id)!.status).toBe('armed');
    w.alivePids.delete(4242); // the watcher died → the sweep measures it
    expect((await sweepConditions({}, w.deps)).counts).toEqual({ fired: 1 });
  });

  test('the wake cap defers the rest to the next tick', async () => {
    const w = world({ cellStatus: async () => ({ status: 'green' }) });
    for (const id of ['A-1', 'A-2', 'A-3']) w.arm('TC', `cell-status:${id}=green`, 60 * MIN);
    const first = await sweepConditions({ maxWakes: 2 }, w.deps);
    expect(first.counts).toEqual({ fired: 2, deferred: 1 });
    expect(w.notices).toHaveLength(2);
    const second = await sweepConditions({ maxWakes: 2 }, w.deps);
    expect(second.counts).toEqual({ fired: 1 });
    expect(w.notices).toHaveLength(3);
  });
});

describe('shadow (dry-run) and the open-condition table', () => {
  test('dry-run judges without writing or waking', async () => {
    const w = world({ cellStatus: async (cell) => ({ status: cell === 'G-1' ? 'green' : 'yellow' }) });
    w.arm('TC', 'cell-status:G-1=green', 60 * MIN);
    w.arm('TC', 'cell-status:Y-1=green', 60 * MIN);
    w.arm('OP', 'mail-reply:9', 1 * MIN, false);
    w.advance(40 * MIN); // the reply-wait is 39 min past → stale
    const r = await sweepConditions({ dryRun: true }, w.deps);
    expect(r.dryRun).toBe(true);
    expect(r.counts).toEqual({ 'would-retire': 1, 'would-fire': 1, pending: 1 });
    expect(r.line).toBe('👁 cond-watch sweep (shadow) · armed 3 · would fire 1 · would expire 0 · would retire stale 1 · pending 1 · watched elsewhere 0 · deferred 0');
    expect(w.notices).toHaveLength(0);
    expect([...listWakers('TC', w.deps), ...listWakers('OP', w.deps)].every(x => x.status === 'armed')).toBe(true);
  });

  test('listOpenConditions marks open · overdue · stale', () => {
    const w = world();
    w.arm('OP', 'pr-merged:1', 60 * MIN);
    w.arm('OP', 'pr-merged:2', 10 * MIN);
    w.arm('TC', 'cell-status:Z-9=green', 5 * MIN);
    w.advance(20 * MIN);
    const rows = listOpenConditions({}, w.deps);
    expect(rows.map(r => `${r.state} ${r.seat} ${r.condition} ${r.overdueMin}`)).toEqual([
      'overdue TC cell-status:Z-9=green 15',
      'overdue OP pr-merged:2 10',
      'open OP pr-merged:1 -40',
    ]);
    w.advance(30 * MIN);
    expect(listOpenConditions({ seat: 'tc' }, w.deps).map(r => r.state)).toEqual(['stale']);
    expect(listOpenConditions({}, w.deps)[1]!.awaits).toBe('PR #2 merged');
  });

  test('eln commitment watches lists open conditions', async () => {
    const w = world();
    w.arm('OP', 'pr-merged:40602', 60 * MIN);
    const stdout: string[] = [];
    const program = new Command().exitOverride();
    registerCommitmentCommands(program, { ledger: w.ledger, timer: w.deps, out: { log: l => stdout.push(l), error: () => {} }, setExitCode: () => {} });
    await program.parseAsync(['node', 'elanous', 'commitment', 'watches']);
    expect(stdout[0]).toBe('Open conditions 1 · open 1 · overdue 0 · stale 0');
    expect(stdout[1]).toBe('open OP/w-1 · pr-merged:40602 · awaits PR #40602 merged · 60m left · commitment c-1 · auto-close');
  });

  test('the trigger node runs dry in shadow and writes the goal file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cond-sweep-node-')); roots.push(dir);
    const seen: boolean[] = [];
    const out = await watchSweep({ input: { stage: 'shadow', vars: { stateRoot: dir, seatState: dir } } as never }, {
      sweep: async (opts) => { seen.push(opts?.dryRun === true); return { at: 'x', dryRun: true, armed: 0, wakes: 0, counts: {}, rows: [], line: 'l' }; },
    });
    expect(seen).toEqual([true]);
    expect(out.outcome).toBe('ok');
    expect(existsSync(join(dir, 'commitments', 'watch-sweep.json'))).toBe(true);
    await watchSweep({ input: { stage: 'live', vars: { stateRoot: dir, seatState: dir } } as never }, {
      sweep: async (opts) => { seen.push(opts?.dryRun === true); return { at: 'x', dryRun: false, armed: 0, wakes: 0, counts: {}, rows: [], line: 'l' }; },
    });
    expect(seen).toEqual([true, false]);
  });
});

describe('sim — the 11-28 backlog shape', () => {
  test('hundreds of stale wakers + a few live ones: stale retired silently, wakes stay under the cap', async () => {
    const w = world({ cellStatus: async (cell) => ({ status: cell.startsWith('G') ? 'green' : 'yellow' }), mailReplied: async () => false });
    for (let i = 0; i < 240; i++) w.arm('TC', `mail-reply:${100000 + i}`, 10 * MIN, false);
    for (let i = 0; i < 40; i++) w.arm('UX', `cell-status:${i % 2 ? 'G' : 'Y'}-${i}=green`, 30 * MIN);
    w.advance(3 * 60 * MIN); // all of the above are hours past their horizon
    for (let i = 0; i < 30; i++) w.arm('OP', `cell-status:G-LIVE-${i}=green`, 60 * MIN); // live and met
    w.arm('OP', 'pr-merged:40603', 60 * MIN); // live, not met
    const r = await sweepConditions({ maxWakes: 20 }, w.deps);
    expect(r.armed).toBe(311);
    expect(r.counts).toEqual({ 'stale-cancelled': 260, 'stale-satisfied': 20, fired: 20, deferred: 11 });
    expect(w.notices).toHaveLength(20);
    const next = await sweepConditions({ maxWakes: 20 }, w.deps);
    expect(next.counts).toEqual({ fired: 10, pending: 1 });
    expect(w.notices).toHaveLength(30);
    const file = join(w.root, 'report.json');
    writeSweepReport(file, r);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { rows: unknown[]; rowsOmitted: number };
    expect(saved.rows).toHaveLength(200);
    expect(saved.rowsOmitted).toBe(111);
  });
});

describe('sweep policy pack (graphs/policies/condition-sweep.yaml · YAML-FIRST)', () => {
  test('the shipped pack parses: 30 min stale · 20 wakes · 60 probes', () => {
    expect(loadConditionSweepPolicy()).toEqual({ staleMs: 1_800_000, maxWakes: 20, maxProbes: 60 }); // 출처: #40586 graphs/policies/condition-sweep.yaml (pins the shipped YAML values)
  });
  test('a malformed pack throws — no silent default', () => {
    expect(() => parseConditionSweepPolicy('version: 1\nsweep: { stale_min: 30, max_wakes: 20 }\n')).toThrow('sweep.max_probes');
    expect(() => parseConditionSweepPolicy('version: 2\nsweep: { stale_min: 30, max_wakes: 20, max_probes: 60 }\n')).toThrow('version');
    expect(() => parseConditionSweepPolicy('version: 1\nsweep: { stale_min: -1, max_wakes: 20, max_probes: 60 }\n')).toThrow('sweep.stale_min');
  });
});
