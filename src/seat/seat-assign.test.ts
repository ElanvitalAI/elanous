// OP-HANDLES-L2b ⊕ L5 — `eln seat assign` / SeatAssign: one step (owner ⊕ mail ⊕ idle wake), built-in writer check that
// refuses only on another seat's LIVE writer, pre-approved resource line in the mail. Fake ledgers; literal expectations.
import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { attributeWriter, cellTargetPaths, pathTouches, seatAssign, type SeatAssignDeps, type WriterRow } from './seat-assign.js';
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
    pool: () => ({ hosts: ['minim5', 'node-b', 'node-c'], scope: 'read-only test-universe runs', source: 'code-default' }),
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
    expect(mail.body).toContain('resources: pre-approved pool minim5 · node-b · node-c — read-only test-universe runs need no RES approval');
    expect(calls.logs).toEqual(['seat.assign']);
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
    expect(pool).toEqual({ hosts: ['minim5', 'node-b', 'node-c'], scope: 'read-only test-universe runs', source: 'code-default' });
  });
  test('the RES ledger replaces the default — only preApproved=true rows', () => {
    const ledger = preapprovedPool('/state', () => JSON.stringify({ hosts: [{ host: 'minim5', preApproved: true }, { host: 'node-b', preApproved: false }, { host: 'aws1', preApproved: true }] }));
    expect(ledger).toEqual({ hosts: ['minim5', 'aws1'], scope: 'read-only test-universe runs', source: '/state/RES/PREGATE-HOSTS.json' });
  });
  test('only read-only test-universe runs on pool hosts skip RES', () => {
    expect(runNeedsResApproval({ host: 'minim5', universe: 'test', readOnly: true }, pool)).toEqual({ needsResApproval: false, reason: 'pre-approved: read-only test-universe runs on minim5' });
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
  test('a live TC 행정관 owns assignment: OP is refused, --p0 passes, the steward itself passes, TC itself passes', async () => {
    const op = harness({ liveStewardScope: liveTc });
    const refused = await seatAssign({ seat: 'TC-H-CX-7', cellId: 'IDLE-1', actor: 'OP' }, op.deps);
    expect(refused).toEqual({ ok: false, code: 'steward-owns', reason: 'seat assign: steward:TC owns assignment; use --p0 for P0 (hands pull with `eln work next`)' });
    expect(op.calls.assign).toEqual([]);
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
