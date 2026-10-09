import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSeatLoopOnce, seatLedgerPath, type SeatDeps } from './seat-loop.js';

const start = new Date('2026-10-03T00:00:00Z');
const runId = 'run-12345678-1234-1234-1234-123456789abc';
const schedules = [
  { version: '0.2.16', cutAt: '2026-10-02T00:00:00Z' },
  { version: '0.2.17', cutAt: '2026-10-04T00:00:00Z' },
  { version: '0.2.18', cutAt: '2026-10-05T00:00:00Z' },
];
const cell = (id: string, owner: string, evidence = '') => ({ id, owner, title: `${id} 구현`, status: 'yellow', evidence });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'idle-ladder-'));
  let clock = start;
  let releases = schedules;
  const items: Record<string, ReturnType<typeof cell>[]> = {
    '0.2.16': [cell('landed', 'MK', '착지 run 완료')],
    '0.2.17': [], '0.2.18': [],
  };
  const deps: SeatDeps = {
    root, repo: root, now: () => clock, config: { mode: 'shadow', seats: ['MK', 'UX', 'TC', 'OP'], idleLadder: 'shadow' },
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } },
    versions: () => releases.map((row) => row.version), schedules: () => releases,
    checklistItems: (version) => items[version] ?? [], queueItems: () => [],
    pendingDecisions: () => [], pullRequests: async () => [],
  };
  const ledger = (seat: string) => readFileSync(seatLedgerPath(seat, root, clock), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const seed = (seat: string, rows: unknown[]) => {
    const path = seatLedgerPath(seat, root, clock);
    mkdirSync(join(root, 'seat-loop', seat), { recursive: true });
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };
  return { root, deps, items, ledger, seed, time: (minutes: number) => { clock = new Date(start.getTime() + minutes * 60_000); },
    releases: (rows: typeof schedules) => { releases = rows; }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('empty seat walks landed yellow, next release authoring, recurring work, then busiest unlaunched neighbor without transferring ownership', async () => {
  const f = fixture();
  try {
    f.items['0.2.17'] = [cell('UX1', 'UX'), cell('UX2', 'UX'), cell('TC1', 'TC')];
    const first = await runSeatLoopOnce('MK', f.deps);
    expect(first).toMatchObject({ status: 'shadow', emptyQueueMinutes: 0, item: { id: 'landed', idleRung: 2, version: '0.2.16' } });
    const second = await runSeatLoopOnce('MK', f.deps);
    expect(second).toMatchObject({ item: { id: 'author:MK', idleRung: 3, version: '0.2.18', title: expect.stringContaining('자율성·효율성·동시성') } });
    const third = await runSeatLoopOnce('MK', f.deps);
    expect(third).toMatchObject({ item: { idleRung: 4, title: expect.stringContaining('문서 최적화') } });
    const fourth = await runSeatLoopOnce('MK', f.deps);
    expect(fourth).toMatchObject({ item: { idleRung: 5, id: 'borrow:UX:UX1', seat: 'UX', title: expect.stringContaining('주인 UX 유지') } });
    expect(f.items['0.2.17'][0]?.owner).toBe('UX');
    expect(f.ledger('MK').map((row) => row.item?.idleRung)).toEqual([2, 3, 4, 5]);
  } finally { f.close(); }
});

test('ordinary queue is picked first; after it drains, idle minutes accumulate until new ordinary work resets them', async () => {
  const f = fixture();
  try {
    f.items['0.2.17'] = [cell('MK1', 'MK')];
    expect(await runSeatLoopOnce('MK', f.deps)).toMatchObject({ item: { id: 'MK1', source: 'checklist' } });
    f.time(60);
    expect(await runSeatLoopOnce('MK', f.deps)).toMatchObject({ item: { idleRung: 2 }, emptyQueueMinutes: 60 });
    f.time(90);
    expect(await runSeatLoopOnce('MK', f.deps)).toMatchObject({ item: { idleRung: 3 }, emptyQueueMinutes: 90 });
    f.items['0.2.17']!.push(cell('MK2', 'MK'));
    expect(await runSeatLoopOnce('MK', f.deps)).toMatchObject({ item: { id: 'MK2', source: 'checklist' } });
    f.time(100);
    expect(await runSeatLoopOnce('MK', f.deps)).toMatchObject({ emptyQueueMinutes: 10 });
    expect(f.ledger('MK').at(-1)?.emptyQueueMinutes).toBe(10);
  } finally { f.close(); }
});

test('live-safe next tick enqueues one recurring idle goal, not another copy on the following tick', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    f.items['0.2.16'] = [];
    f.releases(schedules.slice(0, 2));
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['UX'], idleLadder: 'live' },
      run: async () => '{"outcome":"proceed"}',
      enqueue: async (_seat, text) => { calls.push(text); return { id: `hq-${runId.slice(4)}` }; },
      queueOutcome: () => 'pending', queueItems: () => [] };
    expect(await runSeatLoopOnce('UX', deps)).toMatchObject({ status: 'queued', item: { idleRung: 4, title: expect.stringContaining('멀티 서피스') }, emptyQueueMinutes: 0 });
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('skipped-empty');
    expect(calls).toHaveLength(1);
    expect(f.ledger('UX').at(-1)?.emptyQueueMinutes).toBe(0);
  } finally { f.close(); }
});

test('a rung five cell with a live owner receipt is excluded, and an incomplete run observation never proves absence', async () => {
  const f = fixture();
  try {
    f.items['0.2.16'] = [];
    f.releases(schedules.slice(0, 2));
    f.items['0.2.17'] = [cell('UX1', 'UX'), cell('UX2', 'UX', runId), cell('TC1', 'TC')];
    f.seed('MK', [{ seat: 'MK', at: start.toISOString(), status: 'shadow', item: { source: 'idle', id: 'recurring:MK:2026-10-03', title: '문서 최적화: 현재 문서의 탐색·명료성·검색 유입을 실물 근거로 개선', text: '문서 최적화: 현재 문서의 탐색·명료성·검색 유입을 실물 근거로 개선' } }]);
    f.seed('UX', [{ seat: 'UX', at: start.toISOString(), status: 'queued', item: { source: 'checklist', id: 'UX1', version: '0.2.17' } }]);
    const deps: SeatDeps = { ...f.deps, cutoffRuns: () => ({ completeness: 'partial', pty: { unreadable: [] }, entries: [] }) as never };
    expect(await runSeatLoopOnce('MK', deps)).toMatchObject({ item: { idleRung: 5, id: 'borrow:TC:TC1' } });
    expect(f.items['0.2.17'][2]?.owner).toBe('TC');
  } finally { f.close(); }
});

test('live-safe with idleLadder shadow records the idle pick as shadow and never enqueues', async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    f.items['0.2.16'] = [];
    f.releases(schedules.slice(0, 2));
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['UX'], idleLadder: 'shadow' },
      run: async () => '{"outcome":"proceed"}',
      enqueue: async (_seat, text) => { calls.push(text); return { id: `hq-${runId.slice(4)}` }; },
      queueOutcome: () => 'pending', queueItems: () => [] };
    expect(await runSeatLoopOnce('UX', deps)).toMatchObject({ status: 'shadow', item: { idleRung: 4, title: expect.stringContaining('멀티 서피스') } });
    expect((await runSeatLoopOnce('UX', deps)).status).toBe('skipped-empty');
    expect(calls).toHaveLength(0);
  } finally { f.close(); }
});

test('without loops.seat.idleLadder the ladder is off: an empty seat stays skipped-empty but still records empty-queue minutes', async () => {
  const f = fixture();
  try {
    f.items['0.2.17'] = [cell('UX1', 'UX')];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['MK'] } };
    expect(await runSeatLoopOnce('MK', deps)).toMatchObject({ status: 'skipped-empty', emptyQueueMinutes: 0 });
  } finally { f.close(); }
});
