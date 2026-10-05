import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTraffic, runTrafficTick, seatOfTree, trafficLine, trafficTick, withFinishAdvice, type TrafficProcess } from './traffic.js';
import { collectAuthorDepth, type AuthorCell } from './author-depth.js';
import { AuthorLedger } from './author-ledger.js';
import * as harnessQueue from '../../harness/harness-queue.js';
import { ORCHESTRATOR_DEFAULTS, buildUserConfig, saveUserConfig } from '../../user-config.js';

const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'orch-traffic-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('marker walks up to git root, overrides configured trees, and unknown trees stay unassigned', () => {
  const root = temp();
  const tree = join(root, 'tc');
  mkdirSync(join(tree, '.claude'), { recursive: true });
  writeFileSync(join(tree, '.git'), 'gitdir: elsewhere\n');
  writeFileSync(join(tree, '.claude', 'seat'), 'TC\n');
  const nested = join(tree, 'a', 'b'); mkdirSync(nested, { recursive: true });
  const cfg = { seatTrees: { MK: [tree], UX: [join(root, 'ux')] } };
  expect(seatOfTree(nested, cfg)).toBe('TC');
  expect(seatOfTree(join(root, 'ux', 'src'), cfg)).toBe('UX');
  expect(seatOfTree(join(root, 'unknown'), cfg)).toBeNull();
  writeFileSync(join(tree, '.claude', 'seat'), 'not-a-seat');
  expect(seatOfTree(nested, cfg)).toBeNull();
});

test('TC full, MK 2/6 idle for 40 minutes, UX unknown and OP unassigned; live hourly idempotency and shadow no writes', () => {
  const root = temp();
  const shadowRoot = temp();
  const now = new Date('2026-10-04T15:05:00.000Z');
  const launch = (seat: TrafficProcess['seat'], seconds: number): TrafficProcess => ({
    seat, elapsedSeconds: seconds, cwd: '/example', command: 'bun bin/elanous.mjs harness ask goal.md',
  });
  const processes = [
    ...Array.from({ length: 8 }, () => launch('TC', 3600)),
    launch('MK', 3600), launch('MK', 2400), launch(null, 7200),
    { ...launch('MK', 400), command: 'bun bin/elanous.mjs harness processes' },
  ];
  const cells = [
    { id: 'MK-1', title: 'first cell', status: 'yellow' as const, owner: 'MK' },
    { id: 'MK-2', title: 'second cell', status: 'red' as const, owner: 'MK/sub' },
    { id: 'TC-1', title: 'unrelated', status: 'yellow' as const, owner: 'TC' },
  ];
  const result = trafficTick({ processes, now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: cells });
  const [op, tc, mk, ux] = result.seats;
  expect([op?.running, tc?.running, mk?.running, ux?.running, result.unassigned]).toEqual([0, 8, 2, 0, 1]);
  expect(tc?.idle).toBe(false);
  expect(mk).toMatchObject({ cap: 6, idleFor: 40, idle: true, nextCell: cells[0] });
  expect(ux).toMatchObject({ idleFor: null, idle: false, nextCell: null });
  expect(op).toMatchObject({ idleFor: null, idle: false });
  expect(trafficTick({ processes: [], now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: cells,
    lastLaunchAt: { UX: new Date('2026-10-04T12:00:00Z') } }).seats[3]?.idle).toBe(false);
  expect(trafficLine(result, 'shadow')).toBe('traffic OP 0/4 · TC 8/8 · MK 2/6 · UX 0/6 · idle=MK · mode=shadow');
  const log: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const record = (category: string, event: string, data: Record<string, unknown>) => log.push({ category, event, data });
  expect(applyTraffic(result, { mode: 'live', root, log: record })).toBe(1);
  expect(applyTraffic(result, { mode: 'live', root, log: record })).toBe(0);
  const journal = join(root, 'seat-requests', 'requests.jsonl');
  const lines = readFileSync(journal, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ key: 'orch-traffic:MK:2026-10-04T15', receiptId: 'orch-traffic:MK:2026-10-04T15', seat: 'MK',
    text: '다음 칸 쏘라: MK-1 first cell (지금 2/6 · 40분 놂)', status: 'queued',
    queuedAt: now.toISOString(), source: 'orchestrator-traffic' });
  expect(applyTraffic(result, { root: shadowRoot, log: record })).toBe(0);
  expect(existsSync(join(shadowRoot, 'seat-requests'))).toBe(false);
  expect(log.filter(row => row.event === 'would-nudge' && row.category === 'loop.orchestrator')).toHaveLength(1);
  expect(log.filter(row => row.event === 'exchange').map(row => row.data.outcome)).toEqual(['queued', 'duplicate']);
});

test('exact 30 minutes does not nudge; a later launch resets the clock, without a cell no request is queued', () => {
  const now = new Date('2026-10-04T15:00:00Z');
  const mk = (elapsedSeconds: number): TrafficProcess => ({ seat: 'MK', command: 'bun bin/elanous.mjs harness say next', elapsedSeconds });
  const tick = (processes: TrafficProcess[]) => trafficTick({ processes, now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [] });
  expect(tick([mk(1800)]).seats[2]?.idle).toBe(false);
  expect(tick([mk(2400), mk(60)]).seats[2]?.idleFor).toBe(1);
  const result = tick([mk(2400)]);
  expect(result.seats[2]).toMatchObject({ idle: true, nextCell: null });
  const root = temp();
  expect(applyTraffic(result, { mode: 'live', root, log: () => {} })).toBe(0);
  expect(existsSync(join(root, 'seat-requests'))).toBe(false);
});

test('live only appends to an existing journal; shadow leaves its bytes unchanged', () => {
  const root = temp();
  const dir = join(root, 'seat-requests'); mkdirSync(dir);
  const path = join(dir, 'requests.jsonl');
  const existing = JSON.stringify({ key: 'previous', receiptId: 'previous', seat: 'TC', text: 'prior', status: 'queued', queuedAt: '2026-10-04T13:00:00Z' }) + '\n';
  writeFileSync(path, existing);
  const now = new Date('2026-10-04T15:05:00Z');
  const result = trafficTick({ processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 }],
    now, caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [{ id: 'MK-1', title: 'one', status: 'yellow', owner: 'MK' }] });
  expect(applyTraffic(result, { root, log: () => {} })).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(existing);
  expect(applyTraffic(result, { root, mode: 'live', log: () => {} })).toBe(1);
  expect(readFileSync(path, 'utf8').startsWith(existing)).toBe(true);
  expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('config defaults and explicit seat trees, caps, mode survive parsing and saving', () => {
  const root = temp(); const path = join(root, 'config.json');
  expect(buildUserConfig(path).loops?.orchestrator).toEqual(ORCHESTRATOR_DEFAULTS);
  writeFileSync(path, JSON.stringify({ loops: { orchestrator: { seatTrees: { MK: ['/tmp/mk', 42], UX: ['relative'] }, seatCaps: { TC: 4, MK: 3, UX: -1 }, trafficMode: 'live' } } }));
  const cfg = buildUserConfig(path);
  expect(cfg.loops?.orchestrator).toEqual({ mode: 'shadow', seatTrees: { MK: ['/tmp/mk'], UX: [] }, seatCaps: { TC: 4, MK: 3, UX: 6, OP: 4 }, trafficMode: 'live', idleRequest: 'shadow', finishGate: 'shadow' });
  saveUserConfig(cfg, path);
  expect(buildUserConfig(path).loops?.orchestrator).toEqual(cfg.loops?.orchestrator);
  writeFileSync(path, JSON.stringify({ loops: { orchestrator: { idleRequest: 'off' } } }));
  expect(buildUserConfig(path).loops?.orchestrator?.idleRequest).toBe('off');
  writeFileSync(path, JSON.stringify({ loops: { orchestrator: { idleRequest: 'live' } } }));
  expect(buildUserConfig(path).loops?.orchestrator?.idleRequest).toBe('live');
});

test('fake collectors append finish advice without changing seat decisions, and both modes only log rebalance', () => {
  const now = new Date('2026-10-04T16:00:00Z');
  const original = trafficTick({ processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 }],
    now, caps: { ...ORCHESTRATOR_DEFAULTS.seatCaps, TC: 4 }, openCells: [{ id: 'MK-1', title: 'one', status: 'yellow', owner: 'MK' }] });
  const result = withFinishAdvice(original, {
    listStarts: () => ({ starts: Array.from({ length: 40 }, (_, i) => ({ runId: `run-${i}`, startedAt: now.toISOString() })), unreadable: [] }),
    runGh: args => JSON.stringify(args.includes('merged')
      ? Array.from({ length: 12 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, mergedAt: now.toISOString() }))
      : args.includes('--draft')
        ? Array.from({ length: 30 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, createdAt: '2026-10-03T15:00:00Z', labels: i < 5 ? [{ name: 'elanous:superseded' }] : [] }))
        : Array.from({ length: 50 }, (_, i) => ({ number: i, headRefName: `self-impl/${i}`, mergeable: i < 30 ? 'CONFLICTING' : i < 40 ? 'MERGEABLE' : 'UNKNOWN' }))),
  });
  expect(result.seats).toEqual(original.seats);
  expect(result.unassigned).toBe(original.unassigned);
  expect(trafficLine(result, 'shadow')).toBe('traffic OP 0/4 · TC 0/4 · MK 1/6 · UX 0/6 · idle=MK · mode=shadow · finish rate=0.30 stale=25 conflict=0.75 → finish=6/20');
  expect(JSON.parse(JSON.stringify(result)).finish).toMatchObject({ metrics: { unknownMergeable: 10 }, advice: { state: 'backlogged', finishSlots: 6, launchSlots: 14 } });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const mode of ['shadow', 'live'] as const) {
    applyTraffic(result, { mode, root: temp(), log: (_category, event, data) => { events.push({ event, data }); } });
  }
  expect(events.filter(row => row.event === 'would-rebalance').map(row => row.data)).toEqual(Array(2).fill({ finishSlots: 6, launchSlots: 14, state: 'backlogged', reasons: ['landingRate below threshold', 'staleDrafts above threshold', 'conflictRatio above threshold'] }));
  const unavailable = withFinishAdvice(original, { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => { throw new Error('gh offline'); } });
  expect(trafficLine(unavailable, 'shadow')).toEndWith('finish rate=? stale=? conflict=? → finish=6/20');
  expect(unavailable.finish?.advice.state).toBe('unknown');
});

test('traffic entry runs one author shadow after traffic; directed and human cells persist without harness enqueue', () => {
  const root = temp();
  const now = new Date('2026-10-05T00:00:00Z');
  const ledger = new AuthorLedger({ path: join(root, 'author-ledger.sqlite'), now: () => now });
  const cells: AuthorCell[] = [
    { id: 'A-DIRECTED', title: 'src/foo.ts를 수정하세요', evidence: '사용자는 기록을 확인하고 싶다', owner: 'MK', status: 'yellow', version: '0.2.16' },
    { id: 'B-HUMAN', title: '사람이 요청한 기능', evidence: '사용자는 자신의 기록을 볼 수 있어야 한다', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ];
  const requests: string[] = [];
  const order: string[] = [];
  const enqueue = spyOn(harnessQueue, 'addHarnessQueue');
  let calls = 0;
  try {
    const tick = runTrafficTick({ now, processes: [{ seat: 'MK', command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 }],
      caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: cells, mode: 'shadow',
      finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
      applyDeps: { root, log: (_category, event) => { if (event === 'tick') order.push('traffic'); } },
      authorDeps: { seats: ['MK'], versions: () => ['0.2.16', '0.2.17'], queued: () => [],
        cells: version => cells.filter(cell => cell.version === version), overlaps: () => [], log: () => {},
        ledger: { request: input => { const receipt = ledger.request(input); requests.push(receipt.id); return receipt; } } },
      collectAuthor: deps => { calls++; order.push('author'); return collectAuthorDepth(deps); },
    });
    expect(calls).toBe(1);
    expect(order).toEqual(['traffic', 'author']);
    expect(tick.queued).toBe(0);
    expect(tick.authorShadow).toEqual({ cells: 2, held: 1, queuedForAuthor: 1, status: 'complete', receiptFailures: 0 });
    expect(JSON.parse(JSON.stringify({ ...tick.result, authorShadow: tick.authorShadow })).authorShadow)
      .toEqual({ cells: 2, held: 1, queuedForAuthor: 1, status: 'complete', receiptFailures: 0 });
    expect(requests.map(id => ledger.get(id).status)).toEqual(['held', 'queued-for-author']);
    expect(ledger.get(requests[0]!).check).toMatchObject({ verdict: 'resubmit' });
    expect(ledger.get(requests[1]!).check).toMatchObject({ verdict: 'approved' });
    expect(enqueue).toHaveBeenCalledTimes(0);
    expect(existsSync(join(root, 'seat-requests'))).toBe(false);
  } finally { enqueue.mockRestore(); }
});

test('one failed ledger request marks JSON author shadow incomplete but preserves traffic and never enqueues', () => {
  const root = temp();
  const now = new Date('2026-10-05T00:00:00Z');
  const ledger = new AuthorLedger({ path: join(root, 'author-ledger.sqlite'), now: () => now });
  const cells: AuthorCell[] = [
    { id: 'A-DIRECTED', title: 'src/foo.ts를 수정하세요', evidence: '사용자는 기록을 확인하고 싶다', owner: 'MK', status: 'yellow', version: '0.2.16' },
    { id: 'B-HUMAN', title: '사람이 요청한 기능', evidence: '사용자는 자신의 기록을 볼 수 있어야 한다', owner: 'MK', status: 'yellow', version: '0.2.16' },
  ];
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const enqueue = spyOn(harnessQueue, 'addHarnessQueue');
  const opts = { now, processes: [] as TrafficProcess[], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
    openCells: cells, mode: 'shadow' as const,
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    applyDeps: { root, log: () => {} },
    authorDeps: { seats: ['MK'] as const, versions: () => ['0.2.16', '0.2.17'] as const,
      queued: () => [], cells: (version: string) => cells.filter(cell => cell.version === version),
      overlaps: () => [], log: () => {}, ledger: { request: (input: Parameters<AuthorLedger['request']>[0]) => {
        if (input.cellId === 'B-HUMAN') throw new Error('ledger offline');
        return ledger.request(input);
      } } },
    log: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); } };
  try {
    const exitCode = process.exitCode;
    const healthy = runTrafficTick({ ...opts, authorDeps: { ...opts.authorDeps, ledger } });
    const broken = runTrafficTick(opts);
    expect(process.exitCode).toBe(exitCode);
    const json = JSON.parse(JSON.stringify({ ...broken.result, mode: opts.mode, queued: broken.queued, authorShadow: broken.authorShadow }));
    expect(json.authorShadow).toEqual({ cells: 2, held: 1, queuedForAuthor: 0, status: 'incomplete', receiptFailures: 1 });
    expect(healthy.authorShadow).toEqual({ cells: 2, held: 1, queuedForAuthor: 1, status: 'complete', receiptFailures: 0 });
    expect(broken.result).toEqual(healthy.result);
    expect(broken.queued).toBe(healthy.queued);
    expect(events).toEqual([{ category: 'loops.author-depth', event: 'shadow-failed',
      data: { unreadable: [{ source: 'author-ledger', reason: '0.2.16 B-HUMAN: ledger offline' }] } }]);
    expect(enqueue).toHaveBeenCalledTimes(0);
    expect(existsSync(join(root, 'seat-requests'))).toBe(false);
  } finally { enqueue.mockRestore(); }
});

test('throwing author shadow does not alter traffic output, queue count or exit path; only debug reason is logged', () => {
  const root = temp();
  const now = new Date('2026-10-05T00:00:00Z');
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const opts = { now, processes: [] as TrafficProcess[], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
    openCells: [], mode: 'shadow' as const,
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    applyDeps: { root, log: () => {} },
    log: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); } };
  const healthy = runTrafficTick({ ...opts, collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }) });
  const broken = runTrafficTick({ ...opts, collectAuthor: () => { throw new Error('shadow offline'); } });
  expect(broken.result).toEqual(healthy.result);
  expect(broken.queued).toBe(healthy.queued);
  expect(broken.authorShadow).toBeNull();
  expect(events).toEqual([{ category: 'loops.author-depth', event: 'shadow-failed', data: { reason: 'shadow offline' } }]);
});

test('runTrafficTick uses the finish-adjusted launch budget for seat base shares', () => {
  const cells = [{ id: 'MK-1', title: 'one', owner: 'MK', status: 'yellow' as const }];
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const { result } = runTrafficTick({ processes: [], now, caps, openCells: cells, nextRound: [], mode: 'shadow',
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    applyDeps: { log: () => {} },
    collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
  });
  expect(result.finish?.advice.launchSlots).toBe(6);
  expect(result.seats[2]?.baseShare).toBe(caps.MK);
  expect(result.seats.map(row => row.baseShare)).toEqual([0, 0, 4, 0]);
});

test('traffic records weighted base shares and lends idle capacity to queued seats within physical caps', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const openCells = [
    { id: 'TC-1', title: 'two', owner: 'TC', status: 'yellow' as const },
    { id: 'MK-1', title: 'three', owner: 'MK', status: 'yellow' as const },
  ];
  const nextRound = [
    { id: 'OP-1', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'OP-2', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'TC-2', title: 'next', owner: 'TC', status: 'yellow' as const },
  ];
  const launch = (seat: TrafficProcess['seat'], elapsedSeconds: number): TrafficProcess =>
    ({ seat, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds });
  const first = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound,
    processes: [launch('OP', 2400), launch('TC', 2400), launch('MK', 2400)] });
  expect(first.seats.map(({ seat, baseShare, borrowed, lent, launchCap }) =>
    ({ seat, baseShare, borrowed, lent, launchCap }))).toEqual([
    { seat: 'OP', baseShare: 2, borrowed: 0, lent: 0, launchCap: 2 },
    { seat: 'TC', baseShare: 4, borrowed: 0, lent: 0, launchCap: 4 },
    { seat: 'MK', baseShare: 2, borrowed: 0, lent: 0, launchCap: 2 },
    { seat: 'UX', baseShare: 0, borrowed: 0, lent: 0, launchCap: 0 },
  ]);
  const root = temp();
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  applyTraffic(first, { mode: 'shadow', root, log: (_category, event, data) => events.push({ event, data }) });
  expect(events.find(row => row.event === 'tick')?.data.seats).toEqual(first.seats.map(row => ({
    seat: row.seat, running: row.running, cap: row.cap, baseShare: row.baseShare,
    borrowed: row.borrowed, lent: row.lent, launchCap: row.launchCap, idleFor: row.idleFor, idle: row.idle,
  })));
  expect(existsSync(join(root, 'seat-requests'))).toBe(false);
  const rootLive = temp();
  const live = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound,
    processes: [launch('OP', 2400), launch('TC', 2400), launch('MK', 2400)] });
  expect(applyTraffic(live, { mode: 'live', root: rootLive, log: () => {} })).toBe(2);
  expect(readFileSync(join(rootLive, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  const atBorrowedLimit = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound,
    processes: [launch('OP', 2400), launch('TC', 2400), launch('MK', 2400), launch('MK', 2400), launch('MK', 2400)] });
  expect(atBorrowedLimit.seats[0]).toMatchObject({ lent: 1, launchCap: 1 });
  // The existing borrowed run still holds OP's loan; the same share cannot be lent twice.
  expect(atBorrowedLimit.seats[2]).toMatchObject({ running: 3, borrowed: 1, launchCap: 3, idle: false });
  expect(first.seats[2]).toMatchObject({ borrowed: 0, launchCap: 2, idle: true });
  const lenderNeedsWork = trafficTick({ now, caps, totalSlots: 8, nextRound,
    openCells: [...openCells, { id: 'OP-3', title: 'OP queued again', owner: 'OP', status: 'yellow' }],
    processes: [launch('OP', 2400), launch('TC', 2400), ...Array.from({ length: 3 }, () => launch('MK', 2400))] });
  expect(lenderNeedsWork.seats[0]).toMatchObject({ lent: 1, launchCap: 1, idle: false });
  expect(lenderNeedsWork.seats[2]).toMatchObject({ borrowed: 1, running: 3, launchCap: 3, idle: false });
  const afterReclaim = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound,
    processes: [launch('OP', 2400), launch('OP', 60), launch('TC', 2400), ...Array.from({ length: 3 }, () => launch('MK', 2400))] });
  expect(afterReclaim.seats[0]).toMatchObject({ running: 2, lent: 0, launchCap: 2 });
  expect(afterReclaim.seats[2]).toMatchObject({ running: 3, borrowed: 1, launchCap: 3, idle: false });
  const atPhysicalLimit = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound,
    processes: [launch('OP', 2400), launch('TC', 2400), ...Array.from({ length: 4 }, () => launch('MK', 2400))] });
  expect(atPhysicalLimit.seats[2]).toMatchObject({ running: 4, launchCap: 4, idle: false });
});

test('outstanding loan blocks a returning lender until the borrowed run finishes', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const nextRound = [
    { id: 'OP-N1', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'OP-N2', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'TC-N', title: 'next', owner: 'TC', status: 'yellow' as const },
  ];
  const launch = (seat: TrafficProcess['seat']): TrafficProcess =>
    ({ seat, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 });
  const cells = [
    { id: 'OP-1', title: 'returning', owner: 'OP', status: 'red' as const },
    { id: 'TC-1', title: 'busy', owner: 'TC', status: 'yellow' as const },
    { id: 'MK-1', title: 'borrowed', owner: 'MK', status: 'yellow' as const },
  ];
  const processes = [launch('OP'), ...Array.from({ length: 4 }, () => launch('TC')),
    ...Array.from({ length: 3 }, () => launch('MK'))];
  const occupied = trafficTick({ now, caps, totalSlots: 8, openCells: cells, nextRound, processes });
  expect(occupied.seats[0]).toMatchObject({ baseShare: 2, running: 1, lent: 1, launchCap: 1, idle: false });
  expect(occupied.seats[2]).toMatchObject({ baseShare: 2, running: 3, borrowed: 1, launchCap: 3 });
  const root = temp();
  expect(applyTraffic(occupied, { mode: 'live', root, log: () => {} })).toBe(0);
  expect(existsSync(join(root, 'seat-requests'))).toBe(false);
  const released = trafficTick({ now, caps, totalSlots: 8, openCells: cells, nextRound,
    processes: processes.slice(0, -1) });
  expect(released.seats[0]).toMatchObject({ lent: 0, launchCap: 2, idle: true, nextCell: cells[0] });
  expect(released.seats[2]).toMatchObject({ borrowed: 0, running: 2 });
  expect(applyTraffic(released, { mode: 'live', root, log: () => {} })).toBe(1);
});

test('unknown next round is not logged as a definitive base share', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const cells = [{ id: 'MK-1', title: 'now', owner: 'MK', status: 'yellow' as const }];
  const unknown = trafficTick({ now, caps, totalSlots: 8, openCells: cells, processes: [] });
  const knownEmpty = trafficTick({ now, caps, totalSlots: 8, openCells: cells, nextRound: [], processes: [] });
  expect(unknown.seats.map(row => row.baseShare)).toEqual([null, null, null, null]);
  expect(knownEmpty.seats[2]?.baseShare).toBe(4);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  applyTraffic(unknown, { log: (_category, event, data) => events.push({ event, data }) });
  expect((events.find(event => event.event === 'tick')?.data.seats as Array<{ baseShare: number | null }>).map(row => row.baseShare))
    .toEqual([null, null, null, null]);
});

test('non-yellow unfinished cell is queued work and cannot lend its seat share', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const nextRound = [
    { id: 'OP-N1', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'OP-N2', title: 'next', owner: 'OP', status: 'yellow' as const },
    { id: 'TC-N', title: 'next', owner: 'TC', status: 'yellow' as const },
  ];
  const launch = (seat: TrafficProcess['seat']): TrafficProcess =>
    ({ seat, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 });
  const processes = [launch('OP'), ...Array.from({ length: 4 }, () => launch('TC')),
    ...Array.from({ length: 2 }, () => launch('MK'))];
  const openCells = [
    { id: 'OP-1', title: 'needs work', owner: 'OP', status: 'red' as const },
    { id: 'TC-1', title: 'waiting', owner: 'TC', status: 'yellow' as const },
    { id: 'MK-1', title: 'waiting', owner: 'MK', status: 'yellow' as const },
  ];
  const result = trafficTick({ now, caps, totalSlots: 8, openCells, nextRound, processes });
  expect(result.seats[0]).toMatchObject({ baseShare: 2, lent: 0, launchCap: 2, idle: true, nextCell: openCells[0] });
  expect(result.seats[2]).toMatchObject({ running: 2, borrowed: 0 });
  const root = temp();
  expect(applyTraffic(result, { mode: 'live', root, log: () => {} })).toBe(1);
  expect(JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')).seat).toBe('OP');
});

test('seat requests never exceed the global remaining slots when multiple seats are ready', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  const caps = { OP: 2, TC: 4, MK: 4, UX: 2 };
  const processes: TrafficProcess[] = [
    { seat: null, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 },
    ...Array.from({ length: 3 }, () => ({ seat: 'TC' as const, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 })),
    ...Array.from({ length: 2 }, () => ({ seat: 'MK' as const, command: 'bun bin/elanous.mjs harness ask goal.md', elapsedSeconds: 2400 })),
  ];
  const openCells = [
    { id: 'TC-1', title: 'waiting', owner: 'TC', status: 'yellow' as const },
    { id: 'MK-1', title: 'waiting', owner: 'MK', status: 'yellow' as const },
  ];
  const nextRound = [
    { id: 'TC-N1', title: 'next', owner: 'TC', status: 'yellow' as const },
    { id: 'TC-N2', title: 'next', owner: 'TC', status: 'yellow' as const },
  ];
  const result = trafficTick({ now, caps, totalSlots: 7, openCells, nextRound, processes });
  expect(result.seats.map(row => row.baseShare)).toEqual([0, 4, 3, 0]);
  expect(result.seats.filter(row => row.idle && row.nextCell).map(row => row.seat)).toEqual(['TC']);
  const root = temp();
  expect(applyTraffic(result, { mode: 'live', root, log: () => {} })).toBe(1);
});

test('seat trees match by real path — a /private/var cwd matches a configured /var/folders tree (macOS)', () => {
  const base = mkdtempSync(join(tmpdir(), 'traffic-realpath-'));
  try {
    const tree = join(base, 'harvest');
    mkdirSync(tree);
    const link = join(base, 'link');
    symlinkSync(base, link);
    // configured through a symlinked path, observed as the real path (and the other way round)
    expect(seatOfTree(realpathSync(tree), { seatTrees: { UX: [join(link, 'harvest')] } })).toBe('UX');
    expect(seatOfTree(join(link, 'harvest'), { seatTrees: { UX: [realpathSync(tree)] } })).toBe('UX');
    expect(seatOfTree(join(base, 'other'), { seatTrees: { UX: [tree] } })).toBeNull();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
