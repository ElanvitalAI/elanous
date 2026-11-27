// OP-HANDLES-L2b ⊕ L5 — `eln seat assign` / SeatAssign: one step (owner ⊕ mail ⊕ idle wake), built-in writer check that
// refuses only on another seat's LIVE writer, pre-approved resource line in the mail. Fake ledgers; literal expectations.
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { attributeWriter, cellTargetPaths, opDirectAssignOpen, pathTouches, seatAssign, type SeatAssignDeps, type WriterRow } from './seat-assign.js';
import type { HandPoolEntry } from './hand-pool.js';
import { seatVeto, type SeatVetoDeps } from './seat-veto.js';
import { preapprovedPool, runNeedsResApproval } from './resource-preapproval.js';
import { buildSeatAssignTool, dispatchSeatAssign } from '../skills/tools/seat-assign-tool.js';

const NOW = new Date('2026-11-25T05:00:00.000Z');
const CELL: ChecklistItem = {
  id: 'IDLE-1', title: '대상 경로: src/els/server-auth.ts · src/cli/seat-cli.ts', status: 'yellow', owner: 'TC', priority: 'P1',
  body: 'grant input/new; also touches scripts/x.sh', doneCriterion: 'ElsControl send from OP returns 0', updatedAt: '2026-11-25T00:00:00.000Z', updatedBy: 'OP',
};

function harness(over: Partial<SeatAssignDeps> = {}, writers: readonly WriterRow[] = []) {
  const calls = { assign: [] as unknown[], post: [] as { from: string; to: string; body: string; kind: string; deadlineAt: string; refs: string[] }[], wake: [] as unknown[], logs: [] as string[] };
  const deps: SeatAssignDeps = {
    now: () => NOW,
    coordinators: () => ({ hq: 'OP', spaces: ['TC', 'UX'] }),
    federationSeats: () => new Set(['OP', 'TC', 'UX', 'HAND-ELN-ELS', 'TC-H-CX-7']),
    findCell: (id) => id === 'IDLE-1' ? { version: '0.3.36', item: CELL } : undefined,
    writers: () => writers,
    assign: (version, id, seat, options) => { calls.assign.push([version, id, seat, options]); return { from: 'TC', outcome: 'assigned' }; },
    post: (mail) => { calls.post.push(mail); return { id: 777 }; },
    wake: async (seat, id, from) => { calls.wake.push([seat, id, from]); return { result: 'injected' }; },
    pool: () => ({ hosts: ['minim5', 'node-b', 'node-c'], scope: 'test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host)', source: 'code-default' }),
    log: (event) => { calls.logs.push(event); },
    ...over,
  };
  return { deps, calls };
}

describe('seatAssign', () => {
  test('happy path: owner, one structured mail (+30m due), wake — in one call', async () => {
    const { deps, calls } = harness();
    const result = await seatAssign({ seat: 'hand-eln-els', cellId: 'IDLE-1', actor: 'op', why: 'idle 40m, P1 open' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mailId).toBe(777);
    expect(result.dueAt).toBe('2026-11-25T05:30:00.000Z');
    expect(result.wake).toBe('injected');
    expect(calls.assign).toEqual([['0.3.36', 'IDLE-1', 'HAND-ELN-ELS', { actor: 'OP', reason: 'idle 40m, P1 open' }]]);
    expect(calls.wake).toEqual([['HAND-ELN-ELS', 777, 'OP']]);
    const mail = calls.post[0]!;
    expect(mail.from).toBe('OP');
    expect(mail.to).toBe('HAND-ELN-ELS');
    expect(mail.kind).toBe('assign');
    expect(mail.deadlineAt).toBe('2026-11-25T05:30:00.000Z');
    expect(mail.refs).toEqual(['cell:IDLE-1']);
    expect(mail.body).toContain('[SEAT-ASSIGN] cell IDLE-1 (0.3.36 · P1) → HAND-ELN-ELS · by OP');
    expect(mail.body).toContain('done-when: ElsControl send from OP returns 0');
    expect(mail.body).toContain("writer check is built in: open PRs/recent commits on the cell's paths shown below (checked)");
    expect(mail.body).toContain('resources: pre-approved pool minim5 · node-b · node-c — test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host) need no RES approval and no per-case authorization');
    expect(calls.logs).toEqual(['seat.assign']);
  });

  test('COORD-RIGHTS: --force passes a live writer — assigned, audited in the history reason and a force-past-writer log', async () => {
    const live: WriterRow = { kind: 'pr', ref: '#40100', title: 'fix(els): grant', updatedAt: '2026-11-25T04:30:00.000Z', branch: 'tc-h-cx-7/els-grant', paths: ['src/els/server-auth.ts'] };
    const { deps, calls } = harness({}, [live]);
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP', force: true, why: 'reassign' }, deps);
    expect(result.ok).toBe(true);
    expect(calls.assign).toEqual([['0.3.36', 'IDLE-1', 'HAND-ELN-ELS', { actor: 'OP', reason: 'reassign · force past live writer TC-H-CX-7 #40100' }]]);
    expect(calls.logs).toEqual(['seat.assign.force-past-writer', 'seat.assign']);
  });

  test("refuses only when another seat's live PR holds the paths — and names it", async () => {
    const live: WriterRow = { kind: 'pr', ref: '#40100', title: 'fix(els): grant', updatedAt: '2026-11-25T04:30:00.000Z', branch: 'tc-h-cx-7/els-grant', paths: ['src/els/server-auth.ts'] };
    const { deps, calls } = harness({}, [live]);
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result).toMatchObject({ ok: false, code: 'live-writer', reason: "seat assign: another live writer holds IDLE-1's paths — TC-H-CX-7 #40100 (tc-h-cx-7/els-grant)" });
    expect(calls.assign).toEqual([]);
    expect(calls.post).toEqual([]);
  });

  test('stale PRs, landed commits and the seat\'s own PR do not block; they are listed in the mail', async () => {
    const rows: WriterRow[] = [
      { kind: 'pr', ref: '#39000', title: 'old', updatedAt: '2026-11-24T20:00:00.000Z', branch: 'x/old', paths: ['src/cli/seat-cli.ts'] },
      { kind: 'commit', ref: 'abc1234', title: 'feat: landed', updatedAt: '2026-11-25T04:59:00.000Z', paths: [] },
      { kind: 'pr', ref: '#40101', title: '[HAND-ELN-ELS] wip', updatedAt: '2026-11-25T04:50:00.000Z', branch: 'w/1', paths: ['src/els/server-auth.ts'] },
    ];
    const { deps, calls } = harness({}, rows);
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok).toBe(true);
    expect(calls.post[0]!.body).toContain('- PR #39000 · seat ? · stale');
    expect(calls.post[0]!.body).toContain('- commit abc1234 · seat ? · landed');
    expect(calls.post[0]!.body).toContain('- PR #40101 · HAND-ELN-ELS · LIVE');
  });

  test('an unavailable writer check never blocks; the mail says so', async () => {
    const { deps, calls } = harness({ writers: () => { throw new Error('gh pr list failed: offline'); } });
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok).toBe(true);
    expect(calls.post[0]!.body).toContain('(writer check unavailable: gh pr list failed: offline)');
  });

  test('a space coordinator may assign; a hand may not; unknown seat / cell are refused', async () => {
    expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'TC' }, harness().deps)).ok).toBe(true);
    expect(await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'HAND-ELN-ELS' }, harness().deps)).toEqual({ ok: false, code: 'not-coordinator',
      reason: 'seat assign: HAND-ELN-ELS is not a coordinator (OP · TC · UX) — pass --from <coordinator seat>' });
    const live = harness({ coordinators: () => ({ hq: 'OP', spaces: [], isCoordinator: (seat: string) => seat === 'MK' }) }).deps;
    expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'MK' }, live)).ok).toBe(true);
    expect(await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'JUD' }, live)).toEqual({ ok: false, code: 'not-coordinator',
      reason: 'seat assign: JUD is not a coordinator (OP · space coordinators) — pass --from <coordinator seat>' });
    expect(await seatAssign({ seat: 'NOBODY', cellId: 'IDLE-1', actor: 'OP' }, harness().deps)).toEqual({ ok: false, code: 'unknown-seat',
      reason: 'seat assign: NOBODY is not a registered federation seat (seat registry ⊕ federation.yaml)' });
    expect(await seatAssign({ seat: 'TC-H-CX-7', cellId: 'NOPE', actor: 'OP' }, harness().deps)).toEqual({ ok: false, code: 'unknown-cell', reason: 'seat assign: no cell NOPE' });
  });

  test('a busy pane is not typed into — the wake result says busy, the assignment still stands', async () => {
    const { deps } = harness({ wake: async () => ({ result: 'busy', reason: 'els-working:input=true:' }) });
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok && result.wake).toBe('busy (els-working:input=true:)');
  });
});

describe('writer helpers', () => {
  test('target paths: labelled line ⊕ repo paths in the body', () => {
    expect(cellTargetPaths(CELL)).toEqual(['src/els/server-auth.ts', 'src/cli/seat-cli.ts', 'scripts/x.sh']);
  });
  test('pathTouches: same file, or one path contains the other', () => {
    expect(pathTouches('src/els/server.ts', 'src/els')).toBe(true);
    expect(pathTouches('src/els', 'src/els/server.ts')).toBe(true);
    expect(pathTouches('src/elsewhere.ts', 'src/els')).toBe(false);
  });
  test('attribution takes the longest whole seat token', () => {
    const row: WriterRow = { kind: 'pr', ref: '#1', title: 'x', updatedAt: '2026-11-25T04:00:00.000Z', branch: 'tc-h-cx-7/fix', paths: [] };
    expect(attributeWriter(row, new Set(['TC', 'TC-H-CX-7']), NOW)).toMatchObject({ seat: 'TC-H-CX-7', live: true });
  });
});

describe('pre-approved pool (L5)', () => {
  const pool = preapprovedPool('/nowhere', () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); });
  test('code default when the RES ledger is absent', () => {
    expect(pool).toEqual({ hosts: ['minim5', 'node-b', 'node-c'], scope: 'test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host)', source: 'code-default' });
  });
  test('the RES ledger replaces the default — only preApproved=true rows', () => {
    const ledger = preapprovedPool('/state', () => JSON.stringify({ hosts: [{ host: 'minim5', preApproved: true }, { host: 'node-b', preApproved: false }, { host: 'aws1', preApproved: true }] }));
    expect(ledger).toEqual({ hosts: ['minim5', 'aws1'], scope: 'test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host)', source: '/state/RES/PREGATE-HOSTS.json' });
  });
  test('only test-universe runs on pool hosts skip RES (isolated temp writes count as read-only)', () => {
    expect(runNeedsResApproval({ host: 'minim5', universe: 'test', readOnly: true }, pool)).toEqual({ needsResApproval: false, reason: 'pre-approved: test-universe runs (own temp HOME/TMPDIR · mkdtemp · SQLite/file writes there · head fetch/push to the pool host) on minim5' });
    expect(runNeedsResApproval({ host: 'MSB1', universe: 'sim', readOnly: true }, pool).needsResApproval).toBe(false);
    expect(runNeedsResApproval({ host: 'node-c', universe: 'prod', readOnly: true }, pool)).toEqual({ needsResApproval: true, reason: 'the production universe is never pre-approved' });
    expect(runNeedsResApproval({ host: 'minim5', universe: 'test', readOnly: false }, pool)).toEqual({ needsResApproval: true, reason: 'a run that writes shared state is never pre-approved' });
    expect(runNeedsResApproval({ host: 'mshq', universe: 'test', readOnly: true }, pool)).toEqual({ needsResApproval: true, reason: 'host mshq is not in the pre-approved pool (minim5 · node-b · node-c)' });
  });
});

describe('SeatAssign tool', () => {
  test('spec name and required args', () => {
    const spec = buildSeatAssignTool();
    expect(spec.name).toBe('SeatAssign');
    expect((spec.parameters as { required: string[] }).required).toEqual(['seat', 'cellId']);
  });
  test('dispatch: the host-bound actor wins over a from argument; output = the CLI lines', async () => {
    const { deps, calls } = harness();
    const out = await dispatchSeatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', from: 'HAND-ELN-ELS' }, { assignDeps: deps, actor: 'OP' });
    expect(out.result.ok).toBe(true);
    expect(calls.post[0]!.from).toBe('OP');
    // due HH:MM is local wall time (host TZ varies): only the minute is fixed.
    expect(out.output.split('\n')[0]).toMatch(/^✅ IDLE-1 → HAND-ELN-ELS \(owner TC → HAND-ELN-ELS\) · mail #777 · due \d\d:30 · wake injected$/);
  });
});

describe('PULL default ⊕ shared wake ledger (11-25 17:3x)', () => {
  const liveTc = (seat: string): string | null => (seat === 'TC-H-CX-7' ? 'TC' : null);
  test('COORD-RIGHTS: a live TC 행정관 no longer refuses OP (even with no idle hand) — audited op-direct; --p0, the steward, TC itself pass as before', async () => {
    const op = harness({ liveStewardScope: liveTc, handPool: () => [], readyCells: () => 4 });
    const passed = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP' }, op.deps);
    expect(passed.ok && passed.opDirect).toEqual({ steward: 'TC', pressure: { idle: 0, idleUnclaimed: 0, ready: 4 }, by: 'op-direct' });
    expect(op.calls.assign.length).toBe(1);
    expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP', p0: true }, harness({ liveStewardScope: liveTc }).deps)).ok).toBe(true);
    expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP', steward: true }, harness({ liveStewardScope: liveTc }).deps)).ok).toBe(true);
    expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'TC' }, harness({ liveStewardScope: liveTc }).deps)).ok).toBe(true);
    // A hand outside any live scope: unchanged.
    expect((await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, harness({ liveStewardScope: liveTc }).deps)).ok).toBe(true);
  });

  test('a seat woken by another source inside 20 min is not woken again; the assignment itself still lands', async () => {
    const { deps, calls } = harness({ claimWake: () => ({ ok: false, line: 'already woken by steward:TC at 14:21 (CELL-X)' }) });
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok && result.wake).toBe('skipped (already woken by steward:TC at 14:21 (CELL-X))');
    expect(calls.wake).toEqual([]);
    expect(calls.assign.length).toBe(1);
  });
});

describe('ASSIGN-IDEMPOTENT (11-25 17:5x · OP loop: one cell to MVP-B 9× in 11 min)', () => {
  test('same seat+cell assigned 6 min ago, unanswered → «already assigned #<mail> at HH:MM», no mail, no wake, no owner write', async () => {
    const at = new Date(NOW.getTime() - 6 * 60_000);
    const { deps, calls } = harness({ recentAssign: () => ({ id: 1234, atMs: at.getTime(), answered: false }) });
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    const hh = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    expect(result.ok && result.lines).toEqual([`↺ already assigned #1234 at ${hh} — IDLE-1 → HAND-ELN-ELS (unanswered; no new mail, no wake)`]);
    expect(result.ok && result.already).toBe(true);
    expect([calls.post.length, calls.wake.length, calls.assign.length]).toEqual([0, 0, 0]);
  });

  test('the earlier mail was answered → a real new assignment (mail + wake)', async () => {
    const { deps, calls } = harness({ recentAssign: () => ({ id: 1234, atMs: NOW.getTime() - 6 * 60_000, answered: true }) });
    const result = await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok && result.mailId).toBe(777);
    expect([calls.post.length, calls.wake.length]).toEqual([1, 1]);
  });

  test('the window is 30 min: the lookup asks from now − 30 min', async () => {
    const asked: number[] = [];
    const { deps } = harness({ recentAssign: (_s, _c, since) => { asked.push(since); return null; } });
    await seatAssign({ seat: 'HAND-ELN-ELS', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(asked).toEqual([Date.parse('2026-11-25T04:30:00.000Z')]);
  });
});

describe('OP-DIRECT-ASSIGN (CEO 11-26 18:2x)', () => {
  const liveTc = (seat: string): string | null => (seat === 'TC-H-CX-7' || seat === 'HAND-ELN-ELS' ? 'TC' : null);
  const idleHand = (seat: string): HandPoolEntry => ({ seat, home: 'TC', state: 'idle', lent: false, closeCandidate: false });
  const busyHand = (seat: string): HandPoolEntry => ({ seat, home: 'TC', state: 'working', scope: 'TC', cell: 'X-1', lent: false, closeCandidate: false });

  test('the rule: an idle hand with no claimed cell, or ready < 2 × idle — no idle hand = closed', () => {
    expect(opDirectAssignOpen({ idle: 1, idleUnclaimed: 1, ready: 40 })).toBe(true);
    expect(opDirectAssignOpen({ idle: 3, idleUnclaimed: 0, ready: 5 })).toBe(true);
    expect(opDirectAssignOpen({ idle: 3, idleUnclaimed: 0, ready: 6 })).toBe(false);
    expect(opDirectAssignOpen({ idle: 0, idleUnclaimed: 0, ready: 0 })).toBe(false);
  });

  test('OP assigns a P1 cell to an idle hand past a live steward:TC — allowed, logged op-direct, veto line printed', async () => {
    const { deps, calls } = harness({ liveStewardScope: liveTc, handPool: () => [idleHand('TC-H-CX-7'), busyHand('HAND-ELN-ELS')], readyCells: () => 9 });
    const result = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP', why: 'idle 40m' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(CELL.priority).toBe('P1');
    expect(result.opDirect).toEqual({ steward: 'TC', pressure: { idle: 1, idleUnclaimed: 1, ready: 9 }, by: 'op-direct' });
    expect(calls.assign).toEqual([['0.3.36', 'IDLE-1', 'TC-H-CX-7', { actor: 'OP', reason: 'idle 40m · pool.lend TC→OP · op-direct past steward:TC (idle 1 · ready 9)' }]]);
    expect(calls.logs).toEqual(['seat.assign.op-direct', 'pool.lend', 'seat.assign']);
    expect(result.lines).toContain('⚡ op-direct past steward:TC (idle 1 · ready 9) — veto: eln seat veto IDLE-1 --from TC --reason <line> [--to <seat>]');
    expect(calls.post.length).toBe(1);
  });

  test('COORD-RIGHTS: a non-OP coordinator (UX) borrows a TC hand past steward:TC — audited coord-direct, veto line printed', async () => {
    const { deps, calls } = harness({ liveStewardScope: liveTc, handPool: () => [idleHand('TC-H-CX-7')], readyCells: () => 0 });
    const result = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'UX' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.opDirect).toEqual({ steward: 'TC', pressure: { idle: 1, idleUnclaimed: 1, ready: 0 }, by: 'coord-direct' });
    expect(calls.logs[0]).toBe('seat.assign.coord-direct');
    expect((calls.assign[0] as unknown[])[3]).toMatchObject({ actor: 'UX', reason: expect.stringContaining('coord-direct past steward:TC (idle 1 · ready 0)') });
    expect(result.lines.some(l => l.startsWith('⚡ coord-direct past steward:TC'))).toBe(true);
  });

  test('COORD-RIGHTS: every hand busy and ready ≥ 2 × idle → OP still passes (audited, no idle-pressure gate)', async () => {
    const { deps } = harness({ liveStewardScope: liveTc, handPool: () => [busyHand('TC-H-CX-7')], readyCells: () => 3 });
    const result = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP' }, deps);
    expect(result.ok).toBe(true);
  });
});

describe('seat veto (OP-DIRECT-ASSIGN · steward keeps a veto)', () => {
  const owned: ChecklistItem = { ...CELL, owner: 'TC-H-CX-7' };
  function veto(over: Partial<SeatVetoDeps> = {}) {
    const calls = { swap: [] as unknown[], post: [] as { from: string; to: string; body: string; kind: string; refs: string[] }[], logs: [] as string[] };
    const deps: SeatVetoDeps = {
      findCell: (id) => id === 'IDLE-1' ? { version: '0.3.38', item: owned } : undefined,
      liveStewardScope: (seat) => (seat === 'TC-H-CX-7' ? 'TC' : null),
      federationSeats: () => new Set(['OP', 'TC', 'UX', 'HAND-ELN-ELS', 'TC-H-CX-7']),
      swapOwner: (version, id, input) => { calls.swap.push([version, id, input]); return { outcome: 'swapped', owner: input.to }; },
      post: (mail) => { calls.post.push(mail); return { id: 901 }; },
      hq: 'OP',
      log: (event) => { calls.logs.push(event); },
      ...over,
    };
    return { deps, calls };
  }

  test('TC vetoes and reassigns: compare-and-set owner with an audit reason, one mail to OP', () => {
    const { deps, calls } = veto();
    const result = seatVeto({ cellId: 'IDLE-1', actor: 'tc', reason: 'TC-H-CX-7 is mid-review on #40100', to: 'hand-eln-els' }, deps);
    expect(result).toEqual({ ok: true, cellId: 'IDLE-1', version: '0.3.38', from: 'TC-H-CX-7', to: 'HAND-ELN-ELS', mailId: 901,
      audit: 'veto by steward:TC: TC-H-CX-7 is mid-review on #40100',
      lines: ['⛔ veto IDLE-1: reassigned TC-H-CX-7 → HAND-ELN-ELS · audit «veto by steward:TC: TC-H-CX-7 is mid-review on #40100» · mail #901 → OP'] });
    expect(calls.swap).toEqual([['0.3.38', 'IDLE-1', { expectedOwner: 'TC-H-CX-7', to: 'HAND-ELN-ELS', actor: 'TC', reason: 'veto by steward:TC: TC-H-CX-7 is mid-review on #40100' }]]);
    expect(calls.post.length).toBe(1);
    expect(calls.post[0]!.from).toBe('TC');
    expect(calls.post[0]!.to).toBe('OP');
    expect(calls.post[0]!.refs).toEqual(['cell:IDLE-1']);
    expect(calls.post[0]!.body.split('\n')[0]).toBe('[SEAT-VETO] cell IDLE-1 (0.3.38) reassigned TC-H-CX-7 → HAND-ELN-ELS · by steward:TC');
    expect(calls.logs).toEqual(['seat.veto']);
  });

  test('unassign without --to: the owner goes back to the board (to = null)', () => {
    const { deps, calls } = veto();
    const result = seatVeto({ cellId: 'IDLE-1', actor: 'TC', reason: 'wrong scope' }, deps);
    expect(result.ok && result.to).toBe(null);
    expect(calls.swap).toEqual([['0.3.38', 'IDLE-1', { expectedOwner: 'TC-H-CX-7', to: null, actor: 'TC', reason: 'veto by steward:TC: wrong scope' }]]);
    expect(calls.post[0]!.body).toContain('unassigned TC-H-CX-7 (back to the board)');
  });

  test('COORD-RIGHTS: HQ (OP) overrides — reassigns without being the steward; audit «override by HQ:OP», mail to the steward', () => {
    const { deps, calls } = veto();
    const result = seatVeto({ cellId: 'IDLE-1', actor: 'op', reason: 'P0 needs this hand', to: 'HAND-ELN-ELS' }, deps);
    expect(result).toMatchObject({ ok: true, from: 'TC-H-CX-7', to: 'HAND-ELN-ELS', audit: 'override by HQ:OP: P0 needs this hand' });
    expect(calls.swap).toEqual([['0.3.38', 'IDLE-1', { expectedOwner: 'TC-H-CX-7', to: 'HAND-ELN-ELS', actor: 'OP', reason: 'override by HQ:OP: P0 needs this hand' }]]);
    expect(calls.post[0]!.to).toBe('TC');
    expect(calls.post[0]!.body.split('\n')[0]).toBe('[SEAT-VETO] cell IDLE-1 (0.3.38) reassigned TC-H-CX-7 → HAND-ELN-ELS · by HQ:OP');
    // No live steward: OP still overrides; the mail goes to the previous owner.
    const none = veto({ liveStewardScope: () => null });
    expect(seatVeto({ cellId: 'IDLE-1', actor: 'OP', reason: 'stuck' }, none.deps)).toMatchObject({ ok: true, to: null });
    expect(none.calls.post[0]!.to).toBe('TC-H-CX-7');
  });

  test('OP-HELPERS-STABILIZE: HQ returning its OWN cell to the board mails nobody (no self-notice) · the audit row stays', () => {
    const opCell: ChecklistItem = { ...CELL, owner: 'OP' };
    const { deps, calls } = veto({ findCell: (id) => id === 'IDLE-1' ? { version: '0.3.38', item: opCell } : undefined, liveStewardScope: () => null });
    const result = seatVeto({ cellId: 'IDLE-1', actor: 'OP', reason: 'hands pull it' }, deps);
    expect(result).toEqual({ ok: true, cellId: 'IDLE-1', version: '0.3.38', from: 'OP', to: null, mailId: null,
      audit: 'override by HQ:OP: hands pull it',
      lines: ['⛔ veto IDLE-1: unassigned OP (back to the board) · audit «override by HQ:OP: hands pull it» · no mail (OP is the actor)'] });
    expect(calls.swap).toEqual([['0.3.38', 'IDLE-1', { expectedOwner: 'OP', to: null, actor: 'OP', reason: 'override by HQ:OP: hands pull it' }]]);
    expect(calls.post).toEqual([]);
    expect(calls.logs).toEqual(['seat.veto']);
    // Reassigning its own cell to a hand: still no mail to itself (the new owner learns through the board / work next).
    const re = veto({ findCell: (id) => id === 'IDLE-1' ? { version: '0.3.38', item: opCell } : undefined, liveStewardScope: () => null });
    expect(seatVeto({ cellId: 'IDLE-1', actor: 'OP', reason: 'to the hand', to: 'TC-H-CX-7' }, re.deps)).toMatchObject({ ok: true, to: 'TC-H-CX-7', mailId: null });
    expect(re.calls.post).toEqual([]);
  });

  test('refusals: no reason · not the steward (UX) · a lost race — no write, no mail', () => {
    const { deps, calls } = veto();
    expect(seatVeto({ cellId: 'IDLE-1', actor: 'TC', reason: '  ' }, deps)).toEqual({ ok: false, code: 'no-reason', reason: 'seat veto: a reason is required (--reason <line>)' });
    expect(seatVeto({ cellId: 'IDLE-1', actor: 'UX', reason: 'x' }, deps)).toEqual({ ok: false, code: 'not-steward', reason: "seat veto: only the live steward of TC-H-CX-7's scope may veto (steward:TC) — UX may not" });
    expect(calls.swap).toEqual([]);
    const lost = veto({ swapOwner: () => ({ outcome: 'lost', owner: 'UX-H-1' }) });
    expect(seatVeto({ cellId: 'IDLE-1', actor: 'TC', reason: 'x' }, lost.deps)).toMatchObject({ ok: false, code: 'lost' });
    expect(lost.calls.post).toEqual([]);
    expect(calls.post).toEqual([]);
  });
});

describe('OP-DIRECT-ASSIGN sim world (seeds 1–5 · 40 assign tries each)', () => {
  // A seeded federation hour: random hand states and ready counts under a live steward:TC. Invariant per try:
  // COORD-RIGHTS: OP, UX (a space coordinator) and TC (the steward) always pass; OP/UX passes are audited past the steward.
  function rng(seed: number): () => number { let x = seed * 2654435761 >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32); }
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      let opPassed = 0; let opRefused = 0;
      for (let i = 0; i < 40; i += 1) {
        const hands: HandPoolEntry[] = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => ({ seat: `TC-H-${k}`, home: 'TC', lent: false, closeCandidate: false,
          ...(r() < 0.35 ? { state: 'idle' as const } : { state: 'working' as const, scope: 'TC', cell: `C-${k}` }) }));
        const ready = Math.floor(r() * 10);
        const idle = hands.filter(h => h.state === 'idle').length;
        expect(typeof opDirectAssignOpen({ idle, idleUnclaimed: idle, ready })).toBe('boolean');
        const deps = (): SeatAssignDeps => harness({ liveStewardScope: () => 'TC', handPool: () => hands, readyCells: () => ready }).deps;
        const op = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP' }, deps());
        expect(op.ok).toBe(true);
        expect(op.ok && op.opDirect?.by).toBe('op-direct');
        if (op.ok) opPassed += 1; else opRefused += 1;
        const ux = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'UX' }, deps());
        expect(ux.ok && ux.opDirect?.by).toBe('coord-direct');
        expect((await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'TC' }, deps())).ok).toBe(true);
      }
      expect(opPassed + opRefused).toBe(40);
    });
  }
});
