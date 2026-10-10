import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { setUserConfigOverlay } from '../user-config.js';
import { runSeatLoopTurn, seatLedgerPath, type SeatDeps } from './seat-loop.js';

const now = new Date('2026-10-02T23:20:00Z');
const runId = 'run-12345678-1234-1234-1234-123456789abc';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'seat-observe-'));
  mkdirSync(join(root, 'seat-requests'));
  const deps: SeatDeps = { root, repo: root, now: () => now,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } },
    versions: () => [], schedules: () => [] };
  return { root, deps, close: () => rmSync(root, { force: true, recursive: true }) };
}

function observations(log: ReturnType<typeof spyOn<typeof debug, 'log'>>, seat: string) {
  // #24224 NBR1 — 이웃 런타임이 같은 카테고리에 heartbeat 를 남긴다(돈 턴마다 둘). 이 시험은 «틱» 계약만 센다.
  return log.mock.calls.filter(([category, event]) => category === `loop.${seat.toLowerCase()}-seat` && event !== 'heartbeat')
    .map(([, event, data]) => ({ event, data }));
}

test('each completed off, shadow, on and launched turn emits exactly one tick with real outcome, profile and role source', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect(await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'off' } })).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect(await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'on', seats: ['MK'] } })).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect((await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] } })).status).toBe('skipped-empty');
    expect((await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] } })).status).toBe('skipped-empty');
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'one', seat: 'TC', text: '구현', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      run: async (args) => args[1] === 'budget' ? '{"outcome":"proceed"}' : JSON.stringify([{ status: 'done', runId }]) });
    expect(result).toMatchObject({ status: 'launched', runId });
    const ticks = observations(log, 'TC');
    expect(ticks).toHaveLength(5);
    expect(ticks.every(({ event }) => event === 'tick')).toBe(true);
    expect(ticks.map(({ data }) => (data as { outcome: string }).outcome)).toEqual(['skipped-off', 'skipped-off', 'skipped-empty', 'skipped-empty', 'launched']);
    expect(ticks.map(({ data }) => (data as { profile: string }).profile)).toEqual(['off', 'off', 'shadow', 'on', 'on']);
    for (const { data } of ticks) expect(data).toMatchObject({ loopId: 'tc-seat', sourceRef: 'docs/roles/TC.md', missingRequired: [], runId: expect.any(String) });
    expect(ticks[4]?.data).toMatchObject({ runId });
  } finally { log.mockRestore(); f.close(); }
});

test('budget requeue emits exchange without inventing delegation or changing the seat ledger', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'one', seat: 'MK', text: '구현', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const result = await runSeatLoopTurn('MK', { ...f.deps, config: { mode: 'on', seats: ['MK'] },
      run: async () => '{"outcome":"wait-reset"}' });
    expect(result.status).toBe('skipped-budget');
    const events = observations(log, 'MK');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'tick', data: { outcome: 'skipped-budget', profile: 'on', sourceRef: 'docs/roles/MK.md', missingRequired: [] } });
    expect(events[1]).toMatchObject({ event: 'exchange', data: { reason: 'requeue', itemId: 'one', sourceRef: 'docs/roles/MK.md', missingRequired: [] } });
    const ledger = JSON.parse(readFileSync(seatLedgerPath('MK', f.root, now), 'utf8'));
    expect(ledger).toMatchObject({ status: 'skipped-budget', item: { id: 'one' } });
    expect(ledger).not.toHaveProperty('runId');
  } finally { log.mockRestore(); f.close(); }
});

test('delivered seat question emits one delegation exchange and retains asked outcome', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'one', seat: 'MK', text: '구현', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const result = await runSeatLoopTurn('MK', { ...f.deps, config: { mode: 'on', seats: ['MK'], questions: 'on' },
      inquire: () => ({ to: 'TC', question: '근거를 알려 주세요' }) });
    expect(result).toMatchObject({ status: 'asked', inquiry: { to: 'TC', question: '근거를 알려 주세요' } });
    const events = observations(log, 'MK');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'tick', data: { outcome: 'asked', profile: 'on', missingRequired: [] } });
    expect(events[1]).toMatchObject({ event: 'exchange', data: { reason: 'delegation', from: 'MK', to: 'TC', itemId: 'one', missingRequired: [] } });
    expect(JSON.parse(readFileSync(seatLedgerPath('MK', f.root, now), 'utf8').trim().split('\n').at(-1)!))
      .toMatchObject({ status: 'asked', action: 'seat-question' });
  } finally { log.mockRestore(); f.close(); }
});

test('budget delegation without injected config records the user-configured parent actually receiving it', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const delivered: string[] = [];
  setUserConfigOverlay((base) => ({ ...base, loops: { ...base.loops,
    seat: { mode: 'on', seats: ['TC'], stall: { parents: { TC: 'UX' } } } } }));
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'one', seat: 'TC', text: '구현', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const result = await runSeatLoopTurn('TC', { ...f.deps,
      budgetConfig: { org: { budget: { TC: { dailyGoals: 0 } } } }, running: () => [],
      escalate: async (parent) => { delivered.push(parent); }, run: async () => '{"outcome":"proceed"}' });
    expect(result).toMatchObject({ status: 'skipped-budget', escalated: true });
    expect(delivered).toEqual(['UX']);
    expect(observations(log, 'TC').filter(({ event }) => event === 'exchange'))
      .toMatchObject([{ data: { reason: 'delegation', from: 'TC', to: 'UX', itemId: 'one', missingRequired: [] } }]);
  } finally { setUserConfigOverlay(null); log.mockRestore(); f.close(); }
});

test('delivered budget delegation emits exchange to configured parent, not a requeue exchange', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'one', seat: 'TC', text: '구현', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'], stall: { parents: { TC: 'UX' } } },
      budgetConfig: { org: { budget: { TC: { dailyGoals: 0 } } } }, running: () => [],
      escalate: async () => {}, run: async () => '{"outcome":"proceed"}' });
    expect(result).toMatchObject({ status: 'skipped-budget', escalated: true });
    expect(observations(log, 'TC').filter(({ event }) => event === 'exchange'))
      .toMatchObject([{ data: { reason: 'delegation', from: 'TC', to: 'UX', itemId: 'one', missingRequired: [] } }]);
  } finally { log.mockRestore(); f.close(); }
});
