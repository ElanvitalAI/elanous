import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { listSeatRequests } from '../seat-dispatch/seat-request-ledger.js';
import { askSeat } from '../seat-dispatch/seat-questions.js';
import type { RunningRunAssessment } from '../self-implement/running-runs.js';
import { runSeatLoopOnce, seatLedgerPath, seatDay, type SeatDeps } from './seat-loop.js';

const clock = new Date('2026-10-05T03:00:00Z');
const runningId = 'run-12345678-1234-1234-1234-123456789abc';
const version = '0.2.9';
const base = () => {
  const root = mkdtempSync(join(tmpdir(), 'op-cutoff-'));
  const landBy = new Date(clock.getTime() + 90 * 60_000).toISOString();
  const deps: SeatDeps = { root, repo: root, now: () => clock, config: { mode: 'live-safe', seats: ['OP'] },
    versions: () => [version], schedules: () => [{ version, cutAt: '2099-01-01T00:00:00Z', landBy }],
    checklistItems: () => [
      { id: 'K1', title: '도는 런', status: 'yellow', owner: 'TC', evidence: `작업 ${runningId}` },
      { id: 'K2', title: '주인 있는 칸', status: 'yellow', owner: 'MK', evidence: '근거만 있음' },
      { id: 'K3', title: '미배정 칸', status: 'yellow', evidence: '' },
      { id: 'K4', title: '빨강', status: 'red', owner: 'UX' },
    ],
    cutoffRuns: () => ({ completeness: 'complete', pty: { unreadable: [], refs: [], observedRefCount: 0, withoutRunIdCount: 0, notCountedRefCount: 0 },
      entries: [{ runId: runningId, status: 'running', presence: 'ledger-live-and-pty-observed', reason: 'ledger-live-and-pty-alive',
        lifecycle: 'live', lastActivityTimestamp: clock.toISOString(), ptyUpdatedAt: clock.getTime(), ledgerDirectories: [], ptyRefs: [] } satisfies RunningRunAssessment] }),
    pendingDecisions: () => [], stallChecklist: () => ({ version, released: '0.2.8', dev: version, history: [], items: [] }),
    run: async () => { throw Error('OP must not execute'); }, enqueue: async () => { throw Error('OP must not queue'); } };
  return { root, landBy, deps, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('OP live-safe 90 minutes before landing collects two run-free yellow cells into one daily request without executing or raising a card', async () => {
  const f = base();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect((await runSeatLoopOnce('OP', f.deps)).status).toBe('shadow');
    expect((await runSeatLoopOnce('OP', f.deps)).status).toBe('shadow');
    const requests = listSeatRequests(f.root, { seat: 'OP' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ key: `seat-loop:op-cutoff:${version}:${seatDay(clock)}`, status: 'pending',
      version, landBy: f.landBy, candidates: [
        { id: 'K2', title: '주인 있는 칸', owner: 'MK' }, { id: 'K3', title: '미배정 칸', owner: '미배정' },
      ] });
    expect(requests[0]!.text).toContain('다음 판으로 옮길지 OP 판단');
    expect(requests[0]!.text).toContain('K2 · 주인 있는 칸 · 주인 MK');
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'op-cutoff-check'))
      .toEqual(Array(2).fill(['seat-loop', 'op-cutoff-check', { version, landBy: f.landBy, candidates: requests[0]!.candidates }]));
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
  } finally { spy.mockRestore(); f.close(); }
});

test('OP live-safe landing check also runs when a seat question is unanswered', async () => {
  const f = base();
  try {
    askSeat(f.root, 'TC', 'OP', '판 근거를 확인해 주세요');
    expect((await runSeatLoopOnce('OP', f.deps)).status).toBe('shadow');
    expect(listSeatRequests(f.root, { seat: 'OP' })).toMatchObject([{
      key: `seat-loop:op-cutoff:${version}:${seatDay(clock)}`, candidates: [{ id: 'K2' }, { id: 'K3' }],
    }]);
    expect((await runSeatLoopOnce('OP', f.deps)).status).toBe('shadow');
    expect(listSeatRequests(f.root, { seat: 'OP' })).toHaveLength(1);
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
  } finally { f.close(); }
});

test('OP live-safe three hours before landing keeps the shadow downgrade without a request', async () => {
  const f = base();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopOnce('OP', { ...f.deps,
      schedules: () => [{ version, cutAt: '2099-01-01T00:00:00Z', landBy: new Date(clock.getTime() + 3 * 60 * 60_000).toISOString() }] });
    expect(result).toMatchObject({ status: 'shadow', modeDowngradeReason: 'OP 판정은 shadow 기록만 구현' });
    expect(listSeatRequests(f.root)).toEqual([]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'op-cutoff-check')).toHaveLength(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('OP live-safe records one cannot-read line instead of inventing candidates when the checklist is unreadable', async () => {
  const f = base();
  try {
    const result = await runSeatLoopOnce('OP', { ...f.deps, checklistItems: () => { throw Error('ledger locked'); } });
    expect(result).toMatchObject({ status: 'shadow', reason: expect.stringContaining('체크리스트 못 읽음'),
      modeDowngradeReason: 'OP 판정은 shadow 기록만 구현' });
    const path = seatLedgerPath('OP', f.root, clock);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(listSeatRequests(f.root)).toEqual([]);
    expect(existsSync(join(f.root, 'decisions', 'decisions.jsonl'))).toBe(false);
  } finally { f.close(); }
});
