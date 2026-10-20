import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTraffic, gateHaltedLaunchMinutes, gateLevelOf, isLaunchEligible, observeGateHalt, readDispatchLedger, readGateObservations24h, recordDispatchCycle, runTrafficTick, seatOfTree, trafficLine, trafficTick, withFinishAdvice, type DispatchCycle, type GateObservation, type TrafficProcess } from './traffic.js';
import { readTrafficSamples24h } from '../budget.js';
import { collectAuthorDepth, type AuthorCell } from './author-depth.js';
import { AuthorLedger } from './author-ledger.js';
import * as harnessQueue from '../../harness/harness-queue.js';
import { ORCHESTRATOR_DEFAULTS, buildUserConfig, saveUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';

const roots: string[] = [];
function temp(): string { const root = mkdtempSync(join(tmpdir(), 'orch-traffic-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('traffic dispatch records supply and capacity without changing request rows', () => {
  const root = temp();
  const at = new Date('2026-10-05T00:00:00Z');
  const cell = { id: 'MK-1', title: 'one', owner: 'MK', status: 'yellow' as const };
  const row = { nextCell: cell, running: 0, launchCap: 1 };
  expect(isLaunchEligible(row)).toBe(true);
  expect(isLaunchEligible({ ...row, nextCell: null })).toBe(false);
  expect(isLaunchEligible({ ...row, launchCap: 0 })).toBe(false);
  expect(isLaunchEligible(row, 'cap-deferred')).toBe(false);
  const input = { now: at, processes: [] as TrafficProcess[], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
    openCells: [cell], mode: 'shadow' as const, applyDeps: { root, log: () => {} },
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
  };
  runTrafficTick(input);
  runTrafficTick(input);
  const path = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'traffic', supply: 1, capacity: expect.any(Number), skipped: { 'no-supply': 3, 'not-idle': 1 } });
  expect(rows[0].capacity).toEqual(24);
  expect(existsSync(join(root, 'seat-requests'))).toBe(false);
});

test('a corrupt dispatch shadow ledger cannot change traffic decisions, queue count or exit status', () => {
  const root = temp();
  const path = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  mkdirSync(join(root, 'orchestrator'));
  writeFileSync(path, '{broken\n');
  const now = new Date('2026-10-05T00:00:00Z');
  const input = { now, processes: [] as TrafficProcess[], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
    openCells: [] as Array<{ id: string; title: string; owner: string; status: 'yellow' }>, mode: 'shadow' as const,
    applyDeps: { root, log: () => {} },
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
  };
  const logs = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const exitCode = process.exitCode;
    const broken = runTrafficTick(input);
    expect(process.exitCode).toBe(exitCode);
    expect(broken.queued).toBe(0);
    expect(broken.authorShadow?.status).toBe('complete');
    const rows = readFileSync(path, 'utf8').trim().split('\n');
    expect(rows[0]).toBe('{broken');
    expect(JSON.parse(rows[1]!)).toMatchObject({ source: 'traffic', mode: 'shadow', runId: expect.any(String) });
    runTrafficTick(input);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2); // valid runId is not appended twice
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
    expect(logs).toHaveBeenCalledWith('loop.orchestrator', 'dispatch-cycle-malformed', expect.objectContaining({ path }));
    expect(logs).not.toHaveBeenCalledWith('loop.orchestrator', 'dispatch-cycle-failed', expect.anything(), expect.anything());
    const healthyRoot = temp();
    const healthy = runTrafficTick({ ...input, applyDeps: { root: healthyRoot, log: () => {} } });
    expect(broken.result).toEqual(healthy.result);
    expect(broken.queued).toBe(healthy.queued);
  } finally { logs.mockRestore(); }
});

test('torn final dispatch row is separated, valid rows deduplicate, and later cycles keep recording', () => {
  const root = temp();
  const path = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  mkdirSync(join(root, 'orchestrator'));
  writeFileSync(path, '{torn');
  const input = { now: new Date('2026-10-05T00:00:00Z'), processes: [] as TrafficProcess[],
    caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [], mode: 'shadow' as const,
    applyDeps: { root, log: () => {} },
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
  };
  runTrafficTick(input);
  runTrafficTick(input); // same runId deduplicates despite the malformed row
  runTrafficTick({ ...input, now: new Date('2026-10-05T01:00:00Z') });
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  expect(lines[0]).toBe('{torn');
  expect(lines.slice(1).map(line => JSON.parse(line).runId)).toHaveLength(2);
  expect(new Set(lines.slice(1).map(line => JSON.parse(line).runId)).size).toBe(2);
});

test('live idle seat with a next cell retains its request even when its borrowed-out launch cap is zero', () => {
  const root = temp();
  const now = new Date('2026-10-05T00:00:00Z');
  const cell = { id: 'OP-1', title: 'one', owner: 'OP', status: 'yellow' as const };
  const result = trafficTick({ now, processes: [], caps: ORCHESTRATOR_DEFAULTS.seatCaps, openCells: [cell] });
  const op = result.seats.find(row => row.seat === 'OP')!;
  const borrowedOut = { ...result, seats: [{ ...op, idle: true, nextCell: cell, running: 0, launchCap: 0, lent: op.cap }] };
  expect(isLaunchEligible(borrowedOut.seats[0]!)).toBe(false);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  expect(applyTraffic(borrowedOut, { mode: 'live', root, log: (_category, event, data) => events.push({ event, data }) })).toBe(1);
  expect(JSON.parse(readFileSync(join(root, 'seat-requests', 'requests.jsonl'), 'utf8')))
    .toMatchObject({ key: 'orch-traffic:OP:2026-10-05T00', receiptId: 'orch-traffic:OP:2026-10-05T00', source: 'orchestrator-traffic' });
  expect(events.find(row => row.event === 'exchange')?.data.outcome).toBe('queued');
});

test('traffic resolves one implicit root for its request and dispatch journals', () => {
  const root = temp();
  setElanousConfigDir(root);
  try {
    const now = new Date('2026-10-05T00:00:00Z');
    const { queued } = runTrafficTick({ now, processes: [], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
      openCells: [{ id: 'MK-1', title: 'one', owner: 'MK', status: 'yellow' }], mode: 'shadow',
      finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
      collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
      applyDeps: { log: () => {} } });
    expect(queued).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'orchestrator', 'dispatch-ledger.jsonl'), 'utf8')))
      .toMatchObject({ source: 'traffic', supply: 1, mode: 'shadow' });
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  } finally { resetElanousConfigDir(); }
});

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
  expect(cfg.loops?.orchestrator).toEqual({ mode: 'shadow', seatTrees: { MK: ['/tmp/mk'], UX: [] }, seatCaps: { TC: 4, MK: 3, UX: 6, OP: 4 }, dispatch: ORCHESTRATOR_DEFAULTS.dispatch, trafficMode: 'live', idleRequest: 'shadow', finishGate: 'shadow' });
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

test('traffic defers the final launch decision to the shared budget while preserving explicit physical caps', () => {
  const caps = { OP: 2, TC: 4, MK: 6, UX: 2 };
  const now = new Date('2026-10-05T00:00:00Z');
  const processes = Array.from({ length: 4 }, () => ({ seat: 'MK' as const,
    command: 'bun bin/elanous.mjs harness ask goal', elapsedSeconds: 2400 }));
  const cells = [{ id: 'MK-1', title: 'one', owner: 'MK', status: 'yellow' as const }];
  expect(trafficTick({ processes, now, caps, openCells: cells, nextRound: [], totalSlots: 14 }).seats[2])
    .toMatchObject({ running: 4, cap: 6, launchCap: 6, idle: true, nextCell: cells[0] });
  expect(trafficTick({ processes: [...processes, ...processes.slice(0, 2)], now, caps, openCells: cells, nextRound: [], totalSlots: 14 }).seats[2])
    .toMatchObject({ running: 6, cap: 6, idle: false, nextCell: null });
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

test('gate-halt metric derives zero launch attempts from the verbatim dispatch ledger', () => {
  const root = temp();
  const now = new Date('2026-10-18T03:00:00Z');
  const cycle = (at: Date, eligible: number): DispatchCycle => ({
    at: at.toISOString(), source: 'tick', mode: 'shadow', runId: at.toISOString(),
    supply: 0, capacity: 4, eligible,
    skipped: eligible === 0 ? { 'degraded-skip': 4 } : {},
    dispatch: ORCHESTRATOR_DEFAULTS.dispatch,
  });
  // 원문 저널: recordDispatchCycle이 쓰는 그 형식의 줄들
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const ledgerPath = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  writeFileSync(ledgerPath, `${JSON.stringify(cycle(new Date(now.getTime() - 10 * 60_000), 0))}\n${JSON.stringify(cycle(now, 0))}\n`);
  const ledger = readDispatchLedger(root, now);
  expect(ledger).toHaveLength(2);
  expect(ledger[0].eligible).toBe(0);
  expect(ledger[0].skipped['degraded-skip']).toBe(4);
  // 게이트 활성 10분 동안 발사 시도 0: «게이트 동안 발사 멈춘 분»은 10분
  const gate: GateObservation[] = [
    { at: new Date(now.getTime() - 10 * 60_000).toISOString(), level: 'L1' },
    { at: now.toISOString(), level: 'L1' },
  ];
  expect(gateHaltedLaunchMinutes({ gate, ledger }))
    .toEqual({ minutes: 10, launchAttempts: 0, haltedTicks: 1, activeObservations: 2 });
  // 게이트가 꺼져 있으면 멈춘 분도 0
  expect(gateHaltedLaunchMinutes({ gate: [{ at: now.toISOString(), level: null }], ledger }))
    .toEqual({ minutes: 0, launchAttempts: 0, haltedTicks: 0, activeObservations: 0 });
  // 게이트 활성 구간에 발사 시도가 있던 원문이면 그 분은 «멈춘 분»에서 제외된다
  appendFileSync(ledgerPath, `${JSON.stringify(cycle(new Date(now.getTime() - 5 * 60_000), 2))}\n`);
  const ledger2 = readDispatchLedger(root, now);
  const active = gateHaltedLaunchMinutes({ gate, ledger: ledger2 });
  expect(active.launchAttempts).toBe(2);
  expect(active.minutes).toBe(0);
  // 24h 창 밖 시점에서는 원문이 모두 제외된다
  expect(readDispatchLedger(root, new Date(now.getTime() + 25 * 60 * 60_000))).toHaveLength(0);
});

test('observeGateHalt records the probe level into the 24h gate journal', () => {
  const root = temp();
  const quiet = () => {};
  expect(observeGateHalt(root, { signal: { llm: false, board: true }, log: quiet }).level).toBe('L1');
  expect(observeGateHalt(root, { signal: { llm: true, board: false }, log: quiet }).level).toBe('L2');
  expect(gateLevelOf({ llm: true, board: true })).toBeNull();
  const later = new Date(Date.now() + 60_000);
  const journal = readGateObservations24h(root, later);
  expect(journal).toHaveLength(2);
  expect(journal[1].level).toBe('L2');
  // 24h 창 밖 시점에서는 관측이 모두 제외된다
  expect(readGateObservations24h(root, new Date(Date.now() + 25 * 60 * 60_000))).toHaveLength(0);
});

test('runTrafficTick records a 24h sample of its seat rows for the metrics journal', () => {
  const root = temp();
  const now = new Date('2026-10-18T03:00:00Z');
  runTrafficTick({
    now, processes: [] as TrafficProcess[], caps: ORCHESTRATOR_DEFAULTS.seatCaps,
    openCells: [], mode: 'shadow',
    applyDeps: { root, log: () => {} },
    finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => '[]' },
    collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
  });
  const samples = readTrafficSamples24h(root, now);
  expect(samples).toHaveLength(1);
  expect(samples[0].seats).toHaveLength(4);
  expect(samples[0].seats.map(row => row.seat)).toEqual(['OP', 'TC', 'MK', 'UX']);
  expect(samples[0].seats.find(row => row.seat === 'TC')).toMatchObject({ seat: 'TC', cap: 8, running: 0 });
});

test('gate-halt minutes need the ledger degraded-skip reason, not just an active gate', () => {
  const root = temp();
  const now = new Date('2026-10-18T03:00:00Z');
  const cycle = (at: Date, skipped: Record<string, number>): DispatchCycle => ({
    at: at.toISOString(), source: 'tick', mode: 'shadow', runId: at.toISOString(),
    supply: 1, capacity: 4, eligible: 0, skipped,
    dispatch: ORCHESTRATOR_DEFAULTS.dispatch,
  });
  const gate: GateObservation[] = [
    { at: new Date(now.getTime() - 10 * 60_000).toISOString(), level: 'L2' },
    { at: now.toISOString(), level: 'L2' },
  ];
  // 원문 저널: recordDispatchCycle이 쓰는 그 형식의 줄
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  const ledgerPath = join(root, 'orchestrator', 'dispatch-ledger.jsonl');
  // 게이트가 켜져 있어도 원장이 수요 없음(no-supply)만 기록하면 «멈춘 분»이 아니다
  writeFileSync(ledgerPath, `${JSON.stringify(cycle(new Date(now.getTime() - 5 * 60_000), { 'no-supply': 1 }))}\n`);
  expect(gateHaltedLaunchMinutes({ gate, ledger: readDispatchLedger(root, now) }))
    .toEqual({ minutes: 0, launchAttempts: 0, haltedTicks: 0, activeObservations: 2 });
  // 원장의 degraded-skip 사유가 게이트가 실제로 발사를 막았다는 증거일 때만 계상한다
  appendFileSync(ledgerPath, `${JSON.stringify(cycle(new Date(now.getTime() - 4 * 60_000), { 'degraded-skip': 2 }))}\n`);
  const halted = gateHaltedLaunchMinutes({ gate, ledger: readDispatchLedger(root, now) });
  expect(halted).toEqual({ minutes: 10, launchAttempts: 0, haltedTicks: 1, activeObservations: 2 });
});

test('recordDispatchCycle observes the gate every standing cycle — a deduped dispatch still journals it', () => {
  const root = temp();
  const cycle: DispatchCycle = { at: new Date().toISOString(), source: 'tick', mode: 'shadow', runId: 'gate-standing-1',
    supply: 0, capacity: 4, eligible: 0, skipped: { 'degraded-skip': 4 }, dispatch: ORCHESTRATOR_DEFAULTS.dispatch };
  recordDispatchCycle(root, cycle);
  recordDispatchCycle(root, cycle); // 같은 runId: dispatch 줄은 중복 억제되어도 관측은 매 사이클 쌓인다
  expect(readFileSync(join(root, 'orchestrator', 'dispatch-ledger.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  const observations = readGateObservations24h(root, new Date(Date.now() + 60_000));
  expect(observations).toHaveLength(2);
  expect(observations.every(row => typeof row.at === 'string' && 'level' in row)).toBe(true);
});
