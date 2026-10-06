import { expect, spyOn, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { debug } from '../debug/log.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import * as runningRunsModule from '../self-implement/running-runs.js';
import { dispatchHook } from '../hooks/dispatch.js';
import { openMsgStore } from '../msg/msg-store.js';
import { answerCrossCheck, askSeat, hasSeatAnswer, seatCrossChecks, seatQuestions } from '../seat-dispatch/seat-questions.js';
import * as checklistModule from '../release-loop/checklist.js';
import { listChecklist, setItem } from '../release-loop/checklist.js';
import { importJson } from '../release-loop/feature-store.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import type { Checklist } from '../release-loop/checklist.js';
import { buildUserConfig, parseEventsConfig } from '../user-config.js';
import { PersonaRegistry } from '../persona/registry.js';
import { writePersonaTodos } from '../persona/persona-todo.js';
import { alreadyHandled, gatherSeatInputs, personaShadowLedgerPath, pickNext, planAction, runPersonaLoopOnce, runSeatLoopOnce, runSeatLoopTurn, seatLedgerPath, seatLoopTickLine, type SeatDeps } from './seat-loop.js';
// The owner mark is assembled at runtime so the public export carries no literal (LEAK1).
const CEO = '\u{1F451}';

const now = new Date('2026-10-02T23:20:00Z');
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-loop-'));
  const requests = join(root, 'seat-requests');
  mkdirSync(requests);
  const read = (path: string) => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  // Tests stand in for the release ledger DB with per-version JSON fixtures under the temp root.
  const checklistItems = (version: string) => {
    const raw = read(join(root, 'release', version, 'checklist.json'));
    return raw ? (JSON.parse(raw) as { items: Array<{ id: string; title: string; status: string; owner?: string; evidence?: string }> }).items : [];
  };
  // Every fixture version is open (cut far ahead) unless a test passes its own schedules.
  const schedules = () => ['0.2.5', '0.2.9', '0.2.10', '0.2.11', '0.2.12'].map((version) => ({ version, cutAt: '2099-01-01T00:00:00Z' }));
  const deps: SeatDeps = { root, repo: root, now: () => now, read, versions: () => ['0.2.10', '0.2.9'], checklistItems, schedules };
  return { root, deps, close: () => rmSync(root, { recursive: true, force: true }) };
};
const checklist = (f: ReturnType<typeof fixture>, version: string, items: unknown[]) => {
  const dir = join(f.root, 'release', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ items }));
};
const entries = (f: ReturnType<typeof fixture>) => f.deps.read!(seatLedgerPath('TC', f.root, now)).trim().split('\n').map((v) => JSON.parse(v));

const neighborConfig = (mode: 'shadow' | 'live-safe') => ({ mode, seats: ['MK'], neighbors: { MK: [
  { id: 'op-seat', exchange: ['status' as const], heartbeat: { everyMinutes: 10, missedTicks: 2 },
    onAbsent: { action: 'escalate' as const, delegateTo: 'orchestrator' } },
] } });

test('live-safe request names the OP shadow-only implementation and emits one downgrade log', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopTurn('OP', { ...f.deps, config: { mode: 'live-safe', seats: ['OP'] },
      schedules: () => [], pendingDecisions: () => [], run: async () => { throw Error('OP executed'); } });
    expect(seatLoopTickLine(result)).toBe('seat loop OP: shadow (live-safe 요청 · 이유: OP 판정은 shadow 기록만 구현)');
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded'))
      .toEqual([['seat-loop', 'mode-downgraded', { seat: 'OP', requested: 'live-safe', effective: 'shadow', reason: 'OP 판정은 shadow 기록만 구현' }]]);
    expect(result.status).toBe('shadow');
  } finally { spy.mockRestore(); f.close(); }
});

test('live-safe seat outside the configured list remains skipped-off and names why without claiming shadow work', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['MK'] },
      read: () => { throw Error('read a disabled seat'); },
      append: () => { throw Error('appended for a disabled seat'); },
      run: async () => { throw Error('ran a disabled seat'); } });
    expect(result).toEqual({ seat: 'TC', status: 'skipped-off', modeDowngradeReason: '자리 목록에 없음 (loops.seat.seats)' });
    expect(seatLoopTickLine(result)).toBe('seat loop TC: skipped-off (live-safe 요청 · 이유: 자리 목록에 없음 (loops.seat.seats))');
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded'))
      .toEqual([['seat-loop', 'mode-downgraded', { seat: 'TC', requested: 'live-safe', effective: 'skipped-off', reason: '자리 목록에 없음 (loops.seat.seats)' }]]);
    expect(existsSync(seatLedgerPath('TC', f.root, now))).toBe(false);
  } finally { spy.mockRestore(); f.close(); }
});

test('TC PR judgment shadow uses its own downgrade reason, not an OP candidate guess', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      pullRequests: async () => [{ number: 101, title: 'TC1 landing', state: 'MERGED', isDraft: false,
        createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-02T10:00:00Z' }],
      checklistItems: () => [{ id: 'TC1', title: '검증', status: 'yellow', owner: 'TC' }], versions: () => [] });
    const reason = 'TC PR 판정은 shadow 기록만 구현';
    expect(seatLoopTickLine(result)).toBe(`seat loop TC: shadow (live-safe 요청 · 이유: ${reason})`);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded'))
      .toEqual([['seat-loop', 'mode-downgraded', { seat: 'TC', requested: 'live-safe', effective: 'shadow', reason }]]);
  } finally { spy.mockRestore(); f.close(); }
});

test('TC other-seat defect shadow names its unimplemented ask rather than the PR judgment', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      pullRequests: async () => [], checklistItems: () => [{ id: 'UX1', title: '결함', status: 'red', owner: 'UX' }], versions: () => [] });
    const reason = 'TC 타 자리 결함 질문은 shadow 기록만 구현';
    expect(seatLoopTickLine(result)).toBe(`seat loop TC: shadow (live-safe 요청 · 이유: ${reason})`);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded'))
      .toEqual([['seat-loop', 'mode-downgraded', { seat: 'TC', requested: 'live-safe', effective: 'shadow', reason }]]);
  } finally { spy.mockRestore(); f.close(); }
});

test('live-safe pending question shadow names its unmet delivery prerequisite even with a TC candidate', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    askSeat(f.root, 'UX', 'TC', '근거가 있나요?');
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      pullRequests: async () => [{ number: 101, title: 'publish', state: 'OPEN', isDraft: false,
        createdAt: '2026-10-02T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED', readyAt: '2026-10-02T00:00:00Z',
        approvalWaitAt: '2026-10-02T00:00:00Z', paths: ['release/public/guide.md'] }],
      reply: () => ({ answer: '확인한 근거' }) });
    const reason = '질문 전달 선행 조건 미충족 (questions shadow)';
    expect(seatLoopTickLine(result)).toBe(`seat loop TC: shadow (live-safe 요청 · 이유: ${reason})`);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded'))
      .toEqual([['seat-loop', 'mode-downgraded', { seat: 'TC', requested: 'live-safe', effective: 'shadow', reason }]]);
  } finally { spy.mockRestore(); f.close(); }
});

test('matching shadow and live-safe modes preserve the original tick line without downgrade logs', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const shadow = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, versions: () => [] });
    const live = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] }, versions: () => [], queueItems: () => [] });
    expect(seatLoopTickLine(shadow)).toBe('seat loop TC: skipped-empty');
    expect(seatLoopTickLine(live)).toBe('seat loop TC: skipped-empty');
    const excluded = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'shadow', seats: ['MK'] },
      read: () => { throw Error('read a disabled seat'); } });
    expect(excluded).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect(seatLoopTickLine(excluded)).toBe('seat loop TC: skipped-off');
    expect(seatLoopTickLine({ seat: 'TC', at: now.toISOString(), status: 'launched', runId: 'run-1' })).toBe('seat loop TC: launched run-1');
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'mode-downgraded')).toHaveLength(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('seat tick judges stale context-bus neighbor in shadow without taking action', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'context:session', direction: 'outbound', kind: 'task-done',
      text: 'OP update', refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('shadow'), versions: () => [],
      run: async (args) => { calls.push(args); throw Error('shadow action'); } };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(calls).toEqual([]);
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'loop.neighbors' && event === 'tick').map(([, , data]) => data))
      .toEqual([{ seat: 'MK', neighbor: 'op-seat', state: 'absent', action: null, plannedAction: 'escalate', mode: 'shadow' }]);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
});

test('seat tick drafts exactly one decision card for a stale neighbor in live-safe', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'coord:channel', direction: 'outbound', kind: 'asked',
      text: 'OP update', refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('live-safe'), versions: () => [],
      queueItems: () => [], run: async (args) => { calls.push(args); throw Error('unexpected command'); } };
    await runSeatLoopOnce('MK', deps);
    await runSeatLoopOnce('MK', deps);
    const cards = new DecisionLedger({ stateDir: f.root }).list();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: 'open', raisedBy: { agent: 'seat-loop' }, refs: [expect.stringContaining('neighbor:MK:op-seat')] });
    expect(calls).toEqual([]);
    expect(cards[0]!.scqa.q?.trim()).not.toBe('');
    expect(cards[0]!.scqa.a?.trim()).not.toBe('');
    expect(cards[0]!.recommendation).toMatchObject({ option: 'b', why: expect.stringContaining('대행하지 않는다') });
    for (const label of ['무엇:', '지금까지:', '지금 상태 재측:', '선택지 a', '선택지 b', '권고:', '확신:', '그냥 두면:', '근거:'])
      expect(cards[0]!.pendingQuestion).toContain(label);
    expect(spy.mock.calls.filter(([category, event]) => category === 'loop.neighbors' && event === 'tick').map(([, , data]) => data))
      .toEqual(Array(2).fill({ seat: 'MK', neighbor: 'op-seat', state: 'absent', action: 'decision-card', plannedAction: 'escalate', mode: 'live-safe' }));
  } finally { bus.close(); spy.mockRestore(); f.close(); }
}, 30_000); // real DecisionLedger resolves the release version from repository history (~6s on a full clone)

test('a neighbor event arriving during a long live-safe turn is present at judgment, not escalated', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'context:session', direction: 'outbound', kind: 'task-done',
      text: 'OP earlier', refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    let clock = now;
    let checkedDuringTurn = false;
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('live-safe'), versions: () => [], now: () => clock,
      queueItems: () => {
        checkedDuringTurn = true;
        recordEvent(bus, { surface: 'coord:channel', direction: 'outbound', kind: 'asked',
          text: 'OP active during turn', refs: JSON.stringify({ seat: 'OP' }),
          ts: new Date(now.getTime() + 60_000).toISOString() });
        clock = new Date(now.getTime() + 2 * 60_000);
        return [];
      },
      run: async () => { throw Error('unexpected command'); } };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(checkedDuringTurn).toBe(true);
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'loop.neighbors' && event === 'tick').map(([, , data]) => data))
      .toEqual([{ seat: 'MK', neighbor: 'op-seat', state: 'present', action: null, plannedAction: null, mode: 'live-safe' }]);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
}, 30_000);

test('seat neighbor configuration parses without admitting malformed heartbeats', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'config.json');
    writeFileSync(path, JSON.stringify({ loops: { seat: { ...neighborConfig('shadow'), neighbors: {
      MK: [...neighborConfig('shadow').neighbors.MK, { id: 'tc-seat', exchange: ['status'],
        heartbeat: { everyMinutes: 0, missedTicks: 2 }, onAbsent: { action: 'delegate', delegateTo: 'OP' } }],
    } } } }));
    expect(buildUserConfig(path).loops?.seat?.neighbors?.MK).toEqual(neighborConfig('shadow').neighbors.MK);
  } finally { f.close(); }
});

test('live-safe does not delegate or defer a missing neighbor, and a fresh neighbor is present', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'context:session', direction: 'outbound', kind: 'task-claimed',
      text: 'OP update', refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    const config = neighborConfig('live-safe');
    const neighbor = config.neighbors.MK[0]!;
    const deps: SeatDeps = { ...f.deps, config: { ...config, neighbors: { MK: [
      { ...neighbor, onAbsent: { ...neighbor.onAbsent, action: 'defer' } },
    ] } }, versions: () => [], schedules: () => [], queueItems: () => [],
      run: async () => { throw Error('unexpected action'); } };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
    recordEvent(bus, { surface: 'coord:channel', direction: 'outbound', kind: 'asked',
      text: 'OP fresh', refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 2 * 60_000).toISOString() });
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(spy.mock.calls.filter(([category, event]) => category === 'loop.neighbors' && event === 'tick').map(([, , data]) => data))
      .toEqual([{ seat: 'MK', neighbor: 'op-seat', state: 'absent', action: null, plannedAction: 'defer', mode: 'live-safe' },
        { seat: 'MK', neighbor: 'op-seat', state: 'present', action: null, plannedAction: null, mode: 'live-safe' }]);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
}, 60_000);

test('neighbor judgment failure cannot replace a completed turn or skip stall escalation', async () => {
  const f = fixture();
  const logs: Array<{ category: string; event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'loop.neighbors' && event === 'judged') throw Error('judgment unavailable');
    logs.push({ category, event, data });
  });
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'context:session', direction: 'outbound', kind: 'task-done', text: 'OP old',
      refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R-neighbor', title: 'red', status: 'red', owner: 'MK',
        updatedAt: new Date(now.getTime() - 45 * 60_000).toISOString(), updatedBy: 'MK' }] };
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('shadow'), versions: () => [],
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(logs.some((row) => row.category === 'seat.loop' && row.event === 'neighbor-judgment-failed'
      && (row.data as { neighbor?: string }).neighbor === 'op-seat'
      && String((row.data as { error?: string }).error).includes('judgment unavailable'))).toBe(true);
    expect(logs.some((row) => row.category === 'loop.neighbors' && row.event === 'tick'
      && (row.data as { state?: string; action?: unknown }).state === 'unknown'
      && (row.data as { action?: unknown }).action === null)).toBe(true);
    expect(logs.some((row) => row.category === 'org.stall' && row.event === 'escalate'
      && (row.data as { item?: string }).item === 'R-neighbor')).toBe(true);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
});

test('failed neighbor decision-card write preserves the turn and still escalates a stall', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'coord:channel', direction: 'outbound', kind: 'asked', text: 'OP old',
      refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    // A regular file at the decision directory makes raiseOnce fail without mocking the judgment.
    writeFileSync(join(f.root, 'decisions'), 'unwritable directory');
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R-card', title: 'red', status: 'red', owner: 'MK',
        updatedAt: new Date(now.getTime() - 45 * 60_000).toISOString(), updatedBy: 'MK' }] };
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('live-safe'), versions: () => [], queueItems: () => [],
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(spy.mock.calls.some(([category, event, data]) => category === 'seat.loop' && event === 'neighbor-judgment-failed'
      && (data as { neighbor?: string }).neighbor === 'op-seat'
      && String((data as { error?: string }).error).includes('decisions'))).toBe(true);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'org.stall' && event === 'escalate'
      && (data as { item?: string }).item === 'R-card')).toBe(true);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'loop.neighbors' && event === 'tick'
      && (data as { neighbor?: string; state?: string; action?: unknown }).neighbor === 'op-seat'
      && (data as { state?: string }).state === 'unknown'
      && (data as { action?: unknown }).action === null)).toBe(true);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'loop.neighbors' && event === 'tick'
      && (data as { action?: string }).action === 'decision-card')).toBe(false);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
});

test('unreadable neighbor event source is observed as unknown without changing the seat result', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    writeFileSync(join(f.root, 'surface_events.db'), 'not sqlite');
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('live-safe'), versions: () => [], queueItems: () => [] };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
    expect(spy.mock.calls.some(([category, event]) => category === 'seat.loop' && event === 'neighbor-source-unreadable')).toBe(true);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'loop.neighbors' && event === 'tick'
      && (data as { state?: string; action?: unknown }).state === 'unknown'
      && (data as { action?: unknown }).action === null)).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('one failed neighbor judgment does not skip the next neighbor', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'loop.neighbors' && event === 'judged'
      && (data as { neighbor?: string }).neighbor === 'op-seat') throw Error('OP judgment unavailable');
  });
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    for (const seat of ['OP', 'TC']) recordEvent(bus, { surface: 'context:session', direction: 'outbound',
      kind: 'task-done', text: `${seat} old`, refs: JSON.stringify({ seat }),
      ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    const config = neighborConfig('shadow');
    const deps: SeatDeps = { ...f.deps, config: { ...config, neighbors: { MK: [
      ...config.neighbors.MK, { ...config.neighbors.MK[0]!, id: 'tc-seat' },
    ] } }, versions: () => [] };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('skipped-empty');
    expect(spy.mock.calls.some(([category, event, data]) => category === 'seat.loop' && event === 'neighbor-judgment-failed'
      && (data as { neighbor?: string }).neighbor === 'op-seat')).toBe(true);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'loop.neighbors' && event === 'tick'
      && (data as { neighbor?: string; state?: string }).neighbor === 'tc-seat'
      && (data as { state?: string }).state === 'absent')).toBe(true);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
});

test('neighbor judgment error does not replace an existing seat failure', async () => {
  const f = fixture();
  const seatError = Error('seat action failed');
  const spy = spyOn(debug, 'log').mockImplementation((category, event) => {
    if (category === 'loop.neighbors' && event === 'judged') throw Error('judgment unavailable');
  });
  const bus = openSurfaceEventsDb(join(f.root, 'surface_events.db'));
  try {
    recordEvent(bus, { surface: 'context:session', direction: 'outbound', kind: 'task-done', text: 'OP old',
      refs: JSON.stringify({ seat: 'OP' }), ts: new Date(now.getTime() - 21 * 60_000).toISOString() });
    checklist(f, '0.2.9', [{ id: 'K-fail', owner: 'MK', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('shadow'),
      append: () => { throw seatError; } };
    let caught: unknown;
    try { await runSeatLoopOnce('MK', deps); } catch (error) { caught = error; }
    expect(caught).toBe(seatError);
    expect(spy.mock.calls.some(([category, event]) => category === 'seat.loop' && event === 'neighbor-judgment-failed')).toBe(true);
  } finally { bus.close(); spy.mockRestore(); f.close(); }
});

test('seat tick with no readable neighbor timestamp judges unknown and performs no action', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: neighborConfig('live-safe'), versions: () => [],
      queueItems: () => [], run: async (args) => { calls.push(args); throw Error('unexpected command'); } };
    await runSeatLoopOnce('MK', deps);
    expect(calls).toEqual([]);
    expect(new DecisionLedger({ stateDir: f.root }).list()).toEqual([]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'loop.neighbors' && event === 'tick').map(([, , data]) => data))
      .toEqual([{ seat: 'MK', neighbor: 'op-seat', state: 'unknown', action: null, plannedAction: null, mode: 'live-safe' }]);
  } finally { spy.mockRestore(); f.close(); }
});

const xcheckFixture = (evidence?: string) => {
  const f = fixture();
  f.root = realpathSync(f.root);
  f.deps.root = f.root;
  let clock = now;
  const calls: string[][] = [];
  const path = seatLedgerPath('MK', f.root, now);
  const deps: SeatDeps = { ...f.deps, now: () => clock, versions: () => ['0.2.9'],
    config: { mode: 'on', questions: 'on', seats: ['MK', 'OP'] },
    checklistItems: () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', ...(evidence === undefined ? {} : { evidence }) }],
    inquire: () => ({ to: 'CEO', question: '화면 문구를 승인할까요?' }),
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'decisions') {
        mkdirSync(join(f.root, 'decisions'), { recursive: true });
        writeFileSync(join(f.root, 'decisions', 'decisions.jsonl'), JSON.stringify({ type: 'raised', entry: {
          id: 'D-test', title: 'MK: 화면 문구를 승인할까요?', status: 'open', category: 'other',
          refs: [args[args.indexOf('--ref') + 1]], raisedAt: now.toISOString(), history: [],
        } }) + '\n');
      }
      return '';
    } };
  const ledger = () => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { ...f, deps, calls, ledger, advance: (minutes: number) => { clock = new Date(now.getTime() + minutes * 60_000); } };
};

for (const [label, answer, expectedStatus] of [
  ['dissent', { agree: false, note: '화면 문구 미정', resolves: false }, 'hitl'],
  ['resolution', { agree: true, note: 'OP가 문구 확정', resolves: true }, 'awaiting-resolution'],
] as const) {
  test(`CEO inquiry cross-check ${label} waits for OP and only raises unresolved cards`, async () => {
    const f = xcheckFixture('검토 문서 #M1');
    const spy = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
      expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
      const [question] = seatCrossChecks(f.root, 'OP');
      expect(seatCrossChecks(f.root, 'OP')).toHaveLength(1);
      expect(question).toMatchObject({ from: 'MK', to: 'OP', kind: 'seat-xcheck', body: expect.stringContaining('근거: 검토 문서 #M1') });
      expect(f.ledger().at(-1)).toMatchObject({ status: 'awaiting-xcheck', xcheckRequestedAt: now.toISOString(), xcheckQuestionId: question!.id });
      expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
      expect(seatCrossChecks(f.root, 'OP')).toHaveLength(1);
      const op = { ...f.deps, config: { mode: 'on' as const, questions: 'on' as const, seats: ['OP'] },
        crossCheck: () => answer, run: async () => { throw Error('OP acted on checklist before cross-check'); } };
      expect((await runSeatLoopOnce('OP', op)).status).toBe('answered');
      expect((await runSeatLoopOnce('MK', f.deps)).status).toBe(expectedStatus);
      const raises = f.calls.filter((args) => args[0] === 'decisions');
      if (label === 'dissent') {
        expect(raises).toHaveLength(1);
        for (const flag of ['--q', '--a', '--pending-question', '--recommend', '--why']) expect(raises[0]![raises[0]!.indexOf(flag) + 1]?.trim()).toBeTruthy();
        expect(raises[0]![raises[0]!.indexOf('--pending-question') + 1]).toContain('지금 상태 재측:');
        expect(raises[0]!.slice(raises[0]!.indexOf('--xcheck'), raises[0]!.indexOf('--xcheck') + 2)).toEqual(['--xcheck', 'OP:화면 문구 미정']);
        expect(raises[0]!.slice(raises[0]!.indexOf('--dissent'), raises[0]!.indexOf('--dissent') + 2)).toEqual(['--dissent', 'OP: 화면 문구 미정']);
      } else {
        expect(raises).toHaveLength(0);
        expect(f.ledger().at(-1).xcheckNote).toBe('OP가 문구 확정');
        expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('skipped-empty');
        expect(f.ledger().some((row) => row.status === 'resolved-by-neighbor')).toBe(false);
        expect((await gatherSeatInputs('MK', f.deps)).checklist).toMatchObject([{ id: 'M1', status: 'yellow' }]);
      }
      expect(spy.mock.calls.some(([category, event]) => category === 'decisions.xcheck' && event === (label === 'dissent' ? 'raised' : 'answered'))).toBe(true);
    } finally { spy.mockRestore(); f.close(); }
  });
}

test('an OP proposal cannot resolve an actual yellow MK release-ledger cell', async () => {
  const f = xcheckFixture('검토 원장');
  const version = '0.2.9';
  const releaseDir = join(f.root, 'release', version);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'checklist.json'), JSON.stringify({ version, released: '0.2.8', dev: version,
    history: [], items: [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence: '검토 원장',
      updatedAt: now.toISOString(), updatedBy: 'MK' }] }));
  setElanousConfigDir(f.root);
  try {
    expect(importJson(version)).toBe(true);
    delete f.deps.checklistItems;
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    const op: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['OP'] },
      crossCheck: () => ({ agree: true, note: 'OP가 해결 가능', resolves: true }),
      run: async () => { throw Error('OP acted on checklist before cross-check'); } };
    expect((await runSeatLoopOnce('OP', op)).status).toBe('answered');
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    expect(listChecklist(version, f.root).items.find((item) => item.id === 'M1')?.status).toBe('yellow');
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('skipped-empty');
    expect(f.ledger().some((row) => row.status === 'resolved-by-neighbor')).toBe(false);
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
    expect((await gatherSeatInputs('MK', f.deps)).checklist).toMatchObject([{ id: 'M1', status: 'yellow' }]);
    setItem(version, 'M1', { evidence: '이웃 제안 검토 근거' }, 'MK');
    const resumed = await runSeatLoopOnce('MK', { ...f.deps, inquire: () => null,
      run: async (args) => args[0] === 'harness' && args[1] === 'budget' ? '{"outcome":"wait-reset"}' : '' });
    expect(resumed).toMatchObject({ status: 'skipped-budget', item: { id: 'M1', evidence: '이웃 제안 검토 근거' } });
    expect(listChecklist(version, f.root).items.find((item) => item.id === 'M1')?.status).toBe('yellow');
    setItem(version, 'M1', { status: 'green' }, 'MK');
    expect(listChecklist(version, f.root).items.find((item) => item.id === 'M1')?.status).toBe('green');
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('resolved-by-neighbor');
    expect(f.ledger().at(-1)).toMatchObject({ status: 'resolved-by-neighbor', xcheckNote: 'OP가 해결 가능' });
  } finally { resetElanousConfigDir(); f.close(); }
});

test('an updated unresolved checklist snapshot remains eligible after a neighbor proposal', async () => {
  const f = xcheckFixture('초기 근거');
  let evidence = '초기 근거';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '보완 제안', resolves: true });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    evidence = '이웃 메모 검토 후 추가 근거';
    expect((await runSeatLoopOnce('MK', { ...f.deps, inquire: () => null, run: async (args) => args[0] === 'harness' && args[1] === 'budget' ? '{"outcome":"wait-reset"}' : '' })).status).toBe('skipped-budget');
    expect((await gatherSeatInputs('MK', f.deps)).checklist).toMatchObject([{ id: 'M1', status: 'yellow', evidence }]);
    expect(f.ledger().some((row) => row.status === 'resolved-by-neighbor')).toBe(false);
  } finally { f.close(); }
});

test('revised forbidden-action cell cannot bypass its pending cross-check through the generic decision path', async () => {
  const f = xcheckFixture('초기 근거');
  let evidence = '초기 근거';
  f.deps.checklistItems = () => [{ id: 'M1', title: '공개 발행 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: '이웃 해결 제안', resolves: true });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    evidence = '추가 검토 근거';
    const next = await runSeatLoopOnce('MK', { ...f.deps, run: async (args) => {
      if (args[0] === 'harness' && args[1] === 'budget') return '{"outcome":"proceed"}';
      throw Error(`generic path ran ${args[0]}`);
    } });
    expect(next.status).toBe('awaiting-resolution');
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
    expect(f.ledger().some((row) => row.status === 'resolved-by-neighbor')).toBe(false);
  } finally { f.close(); }
});

test('neighbor resolution proposal becomes resolved only after the checklist cell is green', async () => {
  const f = xcheckFixture('검토 원장');
  let status = 'yellow';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status, owner: 'MK', evidence: '검토 원장' }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: 'OP 해결 제안', resolves: true });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('skipped-empty');
    expect(f.ledger().some((row) => row.status === 'resolved-by-neighbor')).toBe(false);
    status = 'green';
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('resolved-by-neighbor');
    expect(f.ledger().at(-1)).toMatchObject({ status: 'resolved-by-neighbor', xcheckNote: 'OP 해결 제안' });
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
  } finally { f.close(); }
});

test('revised checklist evidence while awaiting cross-check keeps the delivered draft and processes the reply', async () => {
  const f = xcheckFixture('초기 근거');
  let evidence = '초기 근거';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    const [question] = seatCrossChecks(f.root, 'OP');
    expect(question!.body).toContain('근거: 초기 근거');
    evidence = '수정된 근거';
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    expect(seatCrossChecks(f.root, 'OP')).toEqual([question]);
    answerCrossCheck(f.root, question!, { agree: false, note: '화면 문구 미정', resolves: false });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(1);
    expect(f.calls.find((args) => args[0] === 'decisions')).toContain('OP:화면 문구 미정');
  } finally { f.close(); }
});

test('removed checklist evidence while awaiting cross-check still accepts the delivered reply', async () => {
  const f = xcheckFixture('초기 근거');
  let evidence = '초기 근거';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    const [question] = seatCrossChecks(f.root, 'OP');
    evidence = '';
    answerCrossCheck(f.root, question!, { agree: true, note: 'OP가 문구 확정', resolves: true });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    expect(seatCrossChecks(f.root, 'OP')).toEqual([question]);
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
  } finally { f.close(); }
});

test('revised checklist evidence while awaiting cross-check still times out without redelivery', async () => {
  const f = xcheckFixture('초기 근거');
  let evidence = '초기 근거';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    evidence = '수정된 근거';
    f.advance(121);
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    expect(seatCrossChecks(f.root, 'OP')).toHaveLength(1);
    expect(f.calls.find((args) => args[0] === 'decisions')).toContain('이웃 OP 무응답 120분');
  } finally { f.close(); }
});

test('CEO inquiry without evidence is rejected before cross-check or decision delivery', async () => {
  const f = xcheckFixture('  ');
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('rejected-no-evidence');
    expect(f.ledger().at(-1)).toMatchObject({ status: 'rejected-no-evidence', action: 'decision' });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('skipped-empty');
    expect(seatCrossChecks(f.root, 'OP')).toHaveLength(0);
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
  } finally { f.close(); }
});

test('rejected evidence-free item is retried when its evidence appears, but not while unchanged', async () => {
  const f = xcheckFixture('');
  let evidence = '';
  f.deps.checklistItems = () => [{ id: 'M1', title: '문구 승인', status: 'yellow', owner: 'MK', evidence }];
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('rejected-no-evidence');
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('skipped-empty');
    evidence = '새 검토 원장';
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    expect(seatCrossChecks(f.root, 'OP')).toMatchObject([{ body: expect.stringContaining('근거: 새 검토 원장') }]);
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
  } finally { f.close(); }
});

test('a delivered neighbor remains authoritative when the configuration changes before the answer', async () => {
  const f = xcheckFixture('검토 원장');
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    const [question] = seatCrossChecks(f.root, 'OP');
    f.deps.decisionsConfig = { linearProjection: { enabled: false }, requireCrossCheck: false,
      crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'UX', UX: 'OP' }, crossCheckWaitMinutes: 120 };
    answerCrossCheck(f.root, question!, { agree: false, note: '화면 문구 미정', resolves: false });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    expect(seatCrossChecks(f.root, 'UX')).toHaveLength(0);
    const args = f.calls.find((call) => call[0] === 'decisions')!;
    expect(args).toContain('OP:화면 문구 미정');
    expect(args).toContain('OP: 화면 문구 미정');
  } finally { f.close(); }
});

test('a delivered neighbor remains authoritative when the configuration changes before timeout', async () => {
  const f = xcheckFixture('검토 원장');
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    f.deps.decisionsConfig = { linearProjection: { enabled: false }, requireCrossCheck: false,
      crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'UX', UX: 'OP' }, crossCheckWaitMinutes: 5 };
    f.advance(121);
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    expect(f.calls.find((call) => call[0] === 'decisions')).toContain('이웃 OP 무응답 120분');
    expect(seatCrossChecks(f.root, 'UX')).toHaveLength(0);
  } finally { f.close(); }
});

test('a failed receiving judgment does not starve other work and retries only when evidence changes', async () => {
  const f = xcheckFixture('검토 원장');
  try {
    await runSeatLoopOnce('MK', f.deps);
    let judgmentCalls = 0;
    let evidence = '';
    const op: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['OP'] },
      checklistItems: () => [{ id: 'OP-work', title: '검토', status: 'yellow', owner: 'OP', evidence }],
      pendingDecisions: () => [], crossCheck: () => { judgmentCalls++; return null; } };
    expect((await runSeatLoopOnce('OP', op)).status).toBe('awaiting-xcheck');
    expect((await runSeatLoopOnce('OP', op)).status).toBe('shadow');
    expect(judgmentCalls).toBe(1);
    evidence = '신규 OP 검토 근거';
    expect((await runSeatLoopOnce('OP', op)).status).toBe('awaiting-xcheck');
    expect(judgmentCalls).toBe(2);
    expect((await runSeatLoopOnce('OP', op)).status).toBe('shadow');
    f.advance(121);
    expect((await runSeatLoopOnce('OP', op)).status).toBe('shadow');
    expect(judgmentCalls).toBe(2);
  } finally { f.close(); }
});

test('an unanswerable cross-check does not starve the next ordinary seat question', async () => {
  const f = xcheckFixture('검토 원장');
  try {
    f.deps.decisionsConfig = { linearProjection: { enabled: false }, requireCrossCheck: false,
      crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'UX', UX: 'OP' }, crossCheckWaitMinutes: 120 };
    await runSeatLoopOnce('MK', f.deps);
    const question = askSeat(f.root, 'TC', 'UX', 'UX 판단 근거?');
    const ux: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['UX'] },
      checklistItems: () => [], crossCheck: () => null, reply: () => ({ answer: 'UX 기존 근거' }) };
    expect((await runSeatLoopOnce('UX', ux)).status).toBe('awaiting-xcheck');
    expect((await runSeatLoopOnce('UX', ux)).status).toBe('answered');
    expect(hasSeatAnswer(f.root, question)).toBe(true);
  } finally { f.close(); }
});

test('CEO inquiry times out only after the configured wait and records its no-xcheck reason', async () => {
  const f = xcheckFixture('검토 문서 #M1');
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    f.advance(121);
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    const raise = f.calls.find((args) => args[0] === 'decisions')!;
    expect(raise.slice(raise.indexOf('--no-xcheck'), raise.indexOf('--no-xcheck') + 2)).toEqual(['--no-xcheck', '이웃 OP 무응답 120분']);
    expect(seatCrossChecks(f.root, 'OP')).toHaveLength(1);
  } finally { f.close(); }
});

test('configured neighbor and wait control the delivered request and timeout reason', async () => {
  const f = xcheckFixture('검토 문서 #M1');
  f.deps.decisionsConfig = { linearProjection: { enabled: false }, requireCrossCheck: false,
    crossCheckNeighbor: { OP: 'TC', TC: 'OP', MK: 'UX', UX: 'OP' }, crossCheckWaitMinutes: 5 };
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    expect(seatCrossChecks(f.root, 'UX')).toHaveLength(1);
    expect(seatCrossChecks(f.root, 'OP')).toHaveLength(0);
    f.advance(4);
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    f.advance(6);
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('hitl');
    const raise = f.calls.find((args) => args[0] === 'decisions')!;
    expect(raise.slice(raise.indexOf('--no-xcheck'), raise.indexOf('--no-xcheck') + 2)).toEqual(['--no-xcheck', '이웃 UX 무응답 5분']);
  } finally { f.close(); }
});

test('failed receiving judgment leaves the cross-check unanswered and records observation', async () => {
  const f = xcheckFixture('검토 문서 #M1');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    await runSeatLoopOnce('MK', f.deps);
    const op: SeatDeps = { ...f.deps, config: { mode: 'on', questions: 'on', seats: ['OP'] },
      crossCheck: () => { throw Error('judgment unavailable'); } };
    expect((await runSeatLoopOnce('OP', op)).status).toBe('awaiting-xcheck');
    expect(spy.mock.calls.some(([category, event, data]) => category === 'decisions.xcheck' && event === 'answered'
      && String((data as { outcome?: string }).outcome).includes('judgment-failed'))).toBe(true);
    expect(f.calls).toEqual([]);
  } finally { spy.mockRestore(); f.close(); }
});

test('question shadow does not deliver cross-check or decision card', async () => {
  const f = xcheckFixture('검토 문서 #M1');
  try {
    const deps = { ...f.deps, config: { mode: 'on' as const, questions: 'shadow' as const, seats: ['MK'] } };
    expect((await runSeatLoopOnce('MK', deps)).status).toBe('shadow');
    expect(seatCrossChecks(f.root, 'OP')).toHaveLength(0);
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});


test('persona opt-in shadows two independent next todos after an unchanged TC seat turn', async () => {
  const f = fixture();
  try {
    const personaDir = join(f.root, 'personas');
    mkdirSync(personaDir);
    const profile = (id: string) => `personaId: ${id}\ndisplayName: ${id}\nsystemPrompt: You are ${id}.\n`;
    writeFileSync(join(personaDir, 'alice.yaml'), profile('alice'));
    writeFileSync(join(personaDir, 'bob.yaml'), profile('bob'));
    writePersonaTodos(personaDir, 'alice', [
      { id: 'done', title: 'Finished', status: 'done', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'later', title: 'Later', status: 'open', createdAt: '2026-10-02T00:00:00Z' },
      { id: 'first', title: 'First', status: 'open', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    writePersonaTodos(personaDir, 'bob', [
      { id: 'bob-first', title: 'Bob first', status: 'open', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    checklist(f, '0.2.9', [{ id: 'TC1', owner: 'TC', title: '자리 그대로', status: 'yellow' }]);
    const calls: string[][] = [];
    const configPath = join(f.root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ loops: { seat: { mode: 'shadow', seats: ['TC'] }, persona: { enabled: true } } }));
    expect(buildUserConfig(configPath).loops?.persona).toEqual({ enabled: true });
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, personaConfig: buildUserConfig(configPath).loops?.persona,
      run: async (args) => { calls.push(args); throw Error('shadow may not run'); } };
    const seat = await runSeatLoopTurn('TC', deps);
    expect(seat).toMatchObject({ seat: 'TC', status: 'shadow', item: { id: 'TC1' }, action: 'harness' });
    expect(entries(f)).toHaveLength(1);
    expect(calls).toEqual([]);
    for (const [id, todoId] of [['alice', 'first'], ['bob', 'bob-first']]) {
      const rows = readFileSync(personaShadowLedgerPath(id!, f.root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toEqual([{ personaId: id, ts: now.toISOString(), status: 'shadow', todo: expect.objectContaining({ id: todoId }) }]);
    }
    expect(readFileSync(join(f.root, 'personas', 'alice.todo.jsonl'), 'utf8')).toContain('"status":"open"');
  } finally { f.close(); }
});

test('named persona loop picks its own highest priority earliest due todo without invoking seat execution', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const dir = join(f.root, 'personas');
    mkdirSync(dir);
    writeFileSync(join(dir, 'alice.yaml'), 'personaId: alice\ndisplayName: Alice\ntodo: alice.todo.jsonl\n');
    writeFileSync(join(dir, 'bob.yaml'), 'personaId: bob\ndisplayName: Bob\n');
    writePersonaTodos(dir, 'alice', [
      { id: 'low', title: 'Low', status: 'open', priority: 1, dueAt: '2026-10-01T00:00:00Z', createdAt: now.toISOString() },
      { id: 'later', title: 'Later', status: 'open', priority: 2, dueAt: '2026-10-10T00:00:00Z', createdAt: now.toISOString() },
      { id: 'chosen', title: 'Chosen', status: 'open', priority: 2, dueAt: '2026-10-04T00:00:00Z', createdAt: now.toISOString() },
    ]);
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, run: async () => { calls++; throw Error('shadow executed'); } };
    const chosen = await runPersonaLoopOnce('Alice', deps);
    expect(chosen).toMatchObject({ personaId: 'alice', status: 'shadow', todo: { id: 'chosen' }, action: 'harness', what: 'chosen Chosen' });
    expect(readFileSync(personaShadowLedgerPath('alice', f.root, now), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(personaShadowLedgerPath('bob', f.root, now))).toBe(false);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'persona.loop' && event === 'picked'
      && (data as { todoId?: string }).todoId === 'chosen')).toBe(true);
    expect((await runPersonaLoopOnce('bob', deps)).status).toBe('skipped-empty');
    expect(JSON.parse(readFileSync(personaShadowLedgerPath('bob', f.root, now), 'utf8'))).toMatchObject({ status: 'skipped-empty', todo: null });
    expect(calls).toBe(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('persona disabled by default or explicitly false writes zero lines and preserves the seat result', async () => {
  const f = fixture();
  try {
    const registry = new PersonaRegistry();
    const personaDir = join(f.root, 'personas');
    mkdirSync(personaDir);
    writeFileSync(join(personaDir, 'alice.yaml'), 'personaId: alice\ndisplayName: Alice\nsystemPrompt: Alice.\n');
    await registry.loadDir(personaDir);
    writePersonaTodos(personaDir, 'alice', [{ id: 'work', title: 'Work', status: 'open', createdAt: now.toISOString() }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'off' }, personaRegistry: registry,
      read: () => { throw Error('seat off read'); } };
    expect(buildUserConfig(join(f.root, 'missing.json')).loops?.persona).toEqual({ enabled: false });
    writeFileSync(join(f.root, 'config.json'), JSON.stringify({ loops: { persona: { enabled: false } } }));
    expect(await runSeatLoopTurn('TC', { ...deps, personaConfig: buildUserConfig(join(f.root, 'config.json')).loops?.persona })).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect(existsSync(personaShadowLedgerPath('alice', f.root, now))).toBe(false);
    expect(await runSeatLoopTurn('TC', { ...deps, personaConfig: buildUserConfig(join(f.root, 'missing.json')).loops?.persona })).toEqual({ seat: 'TC', status: 'skipped-off' });
    expect(existsSync(personaShadowLedgerPath('alice', f.root, now))).toBe(false);
  } finally { f.close(); }
});

test('persona shadow failure is observed without changing a completed seat turn', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const registry = new PersonaRegistry();
    const dir = join(f.root, 'personas');
    mkdirSync(dir);
    writeFileSync(join(dir, 'alice.yaml'), 'personaId: alice\ndisplayName: Alice\nsystemPrompt: Alice.\n');
    await registry.loadDir(dir);
    const result = await runSeatLoopTurn('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] },
      personaConfig: { enabled: true }, personaRegistry: registry, appendPersona: () => { throw Error('ledger unavailable'); } });
    expect(result).toMatchObject({ seat: 'TC', status: 'skipped-empty' });
    expect(entries(f)).toHaveLength(1);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'seat.loop' && event === 'persona-shadow-error'
      && String((data as { error?: string }).error).includes('ledger unavailable'))).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('end of live seat turns sends one mailbox message per stall even after 30 seconds, including emoji IDs', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const old = new Date(now.getTime() - 45 * 60_000).toISOString();
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R1🚦', title: 'blocked deployment', status: 'red', owner: 'TC', updatedAt: old, updatedBy: 'TC' }] };
    let clock = now;
    const deps: SeatDeps = { ...f.deps, now: () => clock, config: { mode: 'on', seats: ['TC'] },
      versions: () => [], schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot };
    await runSeatLoopOnce('TC', deps);
    await runSeatLoopOnce('TC', deps); // Same-clock retry also covers the emoji ID's exact key.
    clock = new Date(clock.getTime() + 30_000);
    await runSeatLoopOnce('TC', deps);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try {
      const messages = store.listByRecipient('OP');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ from: 'TC', to: 'OP', kind: 'stall-escalation' });
      expect(messages[0]!.body).toContain('R1🚦');
    } finally { store.close(); }
    const events = spy.mock.calls.filter(([category, event]) => category === 'org.stall' && event === 'escalate');
    expect(events).toHaveLength(1);
    expect(events[0]?.[2]).toMatchObject({ item: 'R1🚦', from: 'TC', to: 'OP', stalledMin: 45 });
  } finally { spy.mockRestore(); f.close(); }
});

test('a stall crossing its age threshold during a turn escalates at the end of that turn', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R-turn', title: 'threshold crossed during execution', status: 'red', owner: 'TC',
        updatedAt: new Date(now.getTime() - 29 * 60_000).toISOString(), updatedBy: 'TC' }] };
    checklist(f, '0.2.9', [snapshot.items[0]]);
    let clock = now;
    const result = await runSeatLoopOnce('TC', { ...f.deps, now: () => clock,
      config: { mode: 'on', seats: ['TC'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot,
      run: async () => { clock = new Date(clock.getTime() + 2 * 60_000); return '{"outcome":"wait-reset"}'; } });
    expect(result.status).toBe('skipped-budget');
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('OP')).toMatchObject([{ from: 'TC', to: 'OP', kind: 'stall-escalation' }]); }
    finally { store.close(); }
    expect(spy.mock.calls.find(([category, event]) => category === 'org.stall' && event === 'escalate')?.[2])
      .toMatchObject({ item: 'R-turn', from: 'TC', to: 'OP', stalledMin: 31 });
  } finally { spy.mockRestore(); f.close(); }
});

test('default stall checklist reads the same ledger root as the schedules (deps.root)', async () => {
  const f = fixture();
  const roots: Array<string | undefined> = [];
  const listSpy = spyOn(checklistModule, 'listChecklist').mockImplementation((version: string, root?: string) => {
    roots.push(root);
    return { version, released: '0.2.8', dev: version, history: [], items: [] };
  });
  try {
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, versions: () => [], schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }] });
    expect(roots).toContain(f.root);
  } finally { listSpy.mockRestore(); f.close(); }
});

test('shadow seat turn observes a stalled item without sending a mailbox message', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R2', title: 'waiting', status: 'red', owner: 'TC',
        updatedAt: new Date(now.getTime() - 35 * 60_000).toISOString(), updatedBy: 'TC' }] };
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, versions: () => [], schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot });
    // The webhook card input (E1) may open the mailbox in any mode; what must not exist is a stall message.
    const db = join(f.root, 'msg', 'messages.db');
    if (existsSync(db)) {
      const mailbox = openMsgStore(db);
      try { expect(['OP', 'COO', 'TC', 'UX', 'MK'].flatMap((to) => mailbox.listByRecipient(to)).filter((m) => m.kind === 'stall-escalation')).toEqual([]); }
      finally { mailbox.close(); }
    }
    expect(spy.mock.calls.find(([category, event]) => category === 'org.stall' && event === 'escalate')?.[2])
      .toMatchObject({ item: 'R2', from: 'TC', to: 'OP', stalledMin: 35, mode: 'shadow' });
  } finally { spy.mockRestore(); f.close(); }
});

test('a blocked sub-seat cell uses configured parent and age limit after a budget-skipped turn', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.9', [{ id: 'B1', owner: 'TC', title: 'implementation', status: 'yellow' }]);
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'B1', title: 'blocked by upstream', status: 'yellow', disposition: 'block', owner: 'TC/rel',
        updatedAt: new Date(now.getTime() - 12 * 60_000).toISOString(), updatedBy: 'TC' }] };
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps,
      config: { mode: 'on', seats: ['TC'], stall: { parents: { TC: 'UX' }, blockedMinutes: 10 } },
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot,
      run: async (args) => { calls.push(args); return '{"outcome":"wait-reset"}'; } });
    expect(result.status).toBe('skipped-budget');
    expect(calls.map((args) => args[1])).toEqual(['budget']);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('UX')).toMatchObject([{ from: 'TC', to: 'UX', kind: 'stall-escalation' }]); }
    finally { store.close(); }
    expect(spy.mock.calls.find(([category, event]) => category === 'org.stall' && event === 'escalate')?.[2])
      .toMatchObject({ item: 'B1', from: 'TC', to: 'UX', stalledMin: 12, reason: 'blocked' });
  } finally { spy.mockRestore(); f.close(); }
});

test('a failed checklist read does not block another release and the caller sees the unsent escalation', async () => {
  const f = fixture();
  try {
    const snapshot: Checklist = { version: '0.2.10', released: '0.2.8', dev: '0.2.10', history: [],
      items: [{ id: 'R-good', title: 'red', status: 'red', owner: 'TC',
        updatedAt: new Date(now.getTime() - 45 * 60_000).toISOString(), updatedBy: 'TC' }] };
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, versions: () => [],
      schedules: () => ['0.2.9', '0.2.10'].map((version) => ({ version, cutAt: '2099-01-01T00:00:00Z' })),
      stallChecklist: (version) => { if (version === '0.2.9') throw Error('read failed'); return snapshot; } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('stall checklist 0.2.9: Error: read failed');
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('OP')).toMatchObject([{ from: 'TC', to: 'OP', body: expect.stringContaining('R-good') }]); }
    finally { store.close(); }
  } finally { f.close(); }
});

test('a failed mailbox save does not block another item or release and remains retryable', async () => {
  const f = fixture();
  try {
    const old = new Date(now.getTime() - 45 * 60_000).toISOString();
    const snapshot = (version: string, ids: string[]): Checklist => ({ version, released: '0.2.8', dev: version, history: [],
      items: ids.map((id) => ({ id, title: id, status: 'red', owner: 'TC', updatedAt: old, updatedBy: 'TC' })) });
    let fail = true;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, versions: () => [],
      schedules: () => ['0.2.9', '0.2.10'].map((version) => ({ version, cutAt: '2099-01-01T00:00:00Z' })),
      stallChecklist: (version) => snapshot(version, version === '0.2.9' ? ['R-bad', 'R-sibling'] : ['R-next']),
      stallDelivery: (message, key, root) => {
        if (fail && message.body.includes('R-bad')) throw Error('save failed');
        const store = openMsgStore(join(root, 'msg', 'messages.db'));
        try {
          store.db.exec('BEGIN IMMEDIATE');
          store.db.exec('CREATE TABLE IF NOT EXISTS seat_stall_deliveries (key TEXT PRIMARY KEY)');
          const inserted = store.db.query('INSERT OR IGNORE INTO seat_stall_deliveries (key) VALUES (?)').run(key);
          if (inserted.changes) store.append(message);
          store.db.exec('COMMIT');
          return inserted.changes !== 0;
        } finally { store.close(); }
      } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('stall escalation 0.2.9/R-bad: Error: save failed');
    let store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('OP').map((row) => row.body)).toEqual([
      expect.stringContaining('R-sibling'), expect.stringContaining('R-next')]); }
    finally { store.close(); }
    fail = false;
    await runSeatLoopOnce('TC', deps);
    store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try {
      const bodies = store.listByRecipient('OP').map((row) => row.body);
      expect(bodies).toHaveLength(3);
      expect(bodies.filter((body) => body.includes('R-bad'))).toHaveLength(1);
    } finally { store.close(); }
  } finally { f.close(); }
});

test('seat action failure and unsent escalation both reach the caller', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: 'implement', status: 'yellow' }]);
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R-failed', title: 'red', status: 'red', owner: 'TC',
        updatedAt: new Date(now.getTime() - 45 * 60_000).toISOString(), updatedBy: 'TC' }] };
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }], stallChecklist: () => snapshot,
      stallDelivery: () => { throw Error('mailbox unavailable'); },
      run: async (args) => args[1] === 'budget' ? '{"outcome":"proceed"}' : Promise.reject(Error('harness unavailable')) };
    try {
      await runSeatLoopOnce('TC', deps);
      throw Error('expected both failures');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect(String((error as AggregateError).errors[0])).toContain('harness unavailable');
      expect(String((error as AggregateError).errors[1])).toContain('stall escalation 0.2.9/R-failed');
    }
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
  } finally { f.close(); }
});

test('closed and shipped releases are not escalated', async () => {
  const f = fixture();
  try {
    const snapshot: Checklist = { version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
      items: [{ id: 'R1', title: 'old', status: 'red', owner: 'TC',
        updatedAt: new Date(now.getTime() - 45 * 60_000).toISOString(), updatedBy: 'TC' }] };
    checklist(f, '0.2.9', [snapshot.items[0]]);
    checklist(f, '0.2.10', [snapshot.items[0]]);
    writeFileSync(join(f.root, 'release', '0.2.9', 'release.json'), JSON.stringify({ version: '0.2.9', publishedAt: now.toISOString() }));
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, versions: () => [],
      schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }, { version: '0.2.10', cutAt: '2026-10-02T00:00:00Z' }],
      stallChecklist: () => snapshot });
    // The webhook card input (E1) may open the mailbox in any mode; what must not exist is a stall message.
    const db = join(f.root, 'msg', 'messages.db');
    if (existsSync(db)) {
      const mailbox = openMsgStore(db);
      try { expect(['OP', 'COO', 'TC', 'UX', 'MK'].flatMap((to) => mailbox.listByRecipient(to)).filter((m) => m.kind === 'stall-escalation')).toEqual([]); }
      finally { mailbox.close(); }
    }
  } finally { f.close(); }
});

test('OP shadow: release readiness, unassigned cell and pending delegation each write one judgment; no action even in on mode', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.9', [
      { id: 'R1', owner: 'TC', title: '막힌 칸', status: 'red' },
      { id: 'Y1', owner: 'MK', title: '미결 처분', status: 'yellow' },
      { id: 'U1', title: '담당 빈 칸', status: 'yellow' },
    ]);
    checklist(f, '0.2.10', [{ id: 'X1', title: '닫힌 판', status: 'red' }]);
    mkdirSync(join(f.root, 'decisions'), { recursive: true });
    const decision = (id: string, status: 'open' | 'decided', category: 'scope' | 'money', dueAt: string) =>
      ({ type: 'raised', entry: { id, title: `${id} 결정`, category, dueAt, status, raisedAt: now.toISOString(), history: [] } });
    writeFileSync(join(f.root, 'decisions', 'decisions.jsonl'), [
      decision('D-later', 'open', 'money', '2026-10-05T00:00:00Z'),
      decision('D-first', 'open', 'scope', '2026-10-04T00:00:00Z'),
      decision('D-closed', 'decided', 'scope', '2026-10-03T00:00:00Z'),
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-04T00:00:00Z', landBy: '2026-10-05T00:00:00Z' }, { version: '0.2.10', cutAt: '2026-10-02T00:00:00Z' }],
      run: async () => { calls++; throw Error('OP executed'); } };
    const result = await runSeatLoopOnce('OP', deps);
    expect(result.status).toBe('shadow');
    const path = seatLedgerPath('OP', f.root, now);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.candidate)).toEqual([
      { kind: 'release-readiness', version: '0.2.9', verdict: 'not-ready', cutAt: '2026-10-04T00:00:00Z', landBy: '2026-10-05T00:00:00Z', red: ['R1'], undecided: ['U1', 'Y1'], blocked: [] },
      { kind: 'unassigned-cell', version: '0.2.9', id: 'U1', title: '담당 빈 칸', status: 'yellow', verdict: 'assign' },
      { kind: 'decision-delegation', id: 'D-first', title: 'D-first 결정', category: 'scope', dueAt: '2026-10-04T00:00:00Z', verdict: 'review-delegation' },
    ]);
    expect(rows.every((row) => row.status === 'shadow' && row.action === undefined)).toBe(true);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'op-judgment-shadow')).toHaveLength(3);
    await runSeatLoopOnce('OP', deps);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(calls).toBe(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('OP shadow: only open releases count, and an empty source is not mistaken for ready or delegated', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'OLD', title: 'old', status: 'red' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('OP', { ...f.deps, config: { mode: 'shadow', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-02T00:00:00Z' }],
      run: async () => { calls++; return ''; } });
    expect(result.status).toBe('shadow');
    const rows = readFileSync(seatLedgerPath('OP', f.root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((row) => row.candidate)).toEqual([
      { kind: 'release-readiness', version: null, verdict: 'no-open-release', red: [], undecided: [], blocked: [] },
      { kind: 'unassigned-cell', version: null, id: null, verdict: 'none' },
      { kind: 'decision-delegation', id: null, verdict: 'none' },
    ]);
    expect(calls).toBe(0);
  } finally { f.close(); }
});

test('OP shadow: an open release with an absent or empty checklist is not ready in ledger or log', async () => {
  for (const collected of [false, true]) {
    const f = fixture();
    const spy = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      if (collected) checklist(f, '0.2.9', []);
      let calls = 0;
      await runSeatLoopOnce('OP', { ...f.deps, config: { mode: 'on', seats: ['OP'] },
        schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }],
        pendingDecisions: () => [], run: async () => { calls++; throw Error('action'); } });
      const rows = readFileSync(seatLedgerPath('OP', f.root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ status: 'shadow', candidate: { kind: 'release-readiness', version: '0.2.9', verdict: 'not-ready', red: [], undecided: [], blocked: [] } });
      const judgments = spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'op-judgment-shadow');
      expect(judgments).toHaveLength(3);
      expect(judgments[0]?.[2]).toMatchObject({ candidate: { kind: 'release-readiness', verdict: 'not-ready' } });
      expect(calls).toBe(0);
    } finally { spy.mockRestore(); f.close(); }
  }
});

test('OP shadow: an unknown checklist status cannot make an open release ready', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const items = [
      { id: 'G1', title: 'green', status: 'green' },
      { id: 'D1', title: 'done', status: 'done' },
      { id: 'M1', title: 'moved', status: 'yellow', disposition: 'move' },
      { id: 'U1', title: 'unrecognized', status: 'pending' },
    ];
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }],
      checklistItems: () => items, pendingDecisions: () => [],
      run: async () => { calls++; throw Error('action'); } };
    await runSeatLoopOnce('OP', deps);
    const path = seatLedgerPath('OP', f.root, now);
    let rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows[0].candidate).toMatchObject({ kind: 'release-readiness', verdict: 'not-ready', red: [], undecided: [], blocked: [] });
    expect(spy.mock.calls.find(([category, event, data]) => category === 'seat.loop' && event === 'op-judgment-shadow' && (data as { candidate?: { kind?: string } }).candidate?.kind === 'release-readiness')?.[2])
      .toMatchObject({ candidate: { verdict: 'not-ready' } });
    expect(calls).toBe(0);
    items.pop();
    await runSeatLoopOnce('OP', deps);
    rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(4);
    expect(rows[3].candidate).toMatchObject({ kind: 'release-readiness', verdict: 'ready' });
    expect(calls).toBe(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('OP shadow: green release is ready; deadlines take precedence over undated cards', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'G1', owner: 'TC', title: 'ready', status: 'green' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }],
      pendingDecisions: () => [
        { id: 'D-undated', title: 'undated', category: 'other' },
        { id: 'D-urgent', title: 'urgent', category: 'scope', dueAt: '2026-10-04T00:00:00Z' },
      ] };
    await runSeatLoopOnce('OP', deps);
    const rows = readFileSync(seatLedgerPath('OP', f.root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0].candidate).toMatchObject({ verdict: 'ready', red: [], undecided: [], blocked: [] });
    expect(rows[2].candidate).toMatchObject({ id: 'D-urgent', dueAt: '2026-10-04T00:00:00Z' });
  } finally { f.close(); }
});

test('OP shadow: shipped versions are excluded and changed judgments append only the affected line', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'OLD', title: 'published', status: 'red' }]);
    writeFileSync(join(f.root, 'release', '0.2.9', 'release.json'), JSON.stringify({ version: '0.2.9', publishedAt: '2026-10-02T00:00:00Z' }));
    checklist(f, '0.2.10', [{ id: 'NEW', title: 'unassigned', status: 'yellow' }]);
    const state: { status: string; owner?: string } = { status: 'yellow' };
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }, { version: '0.2.10', cutAt: '2026-10-06T00:00:00Z' }],
      checklistItems: (version) => version === '0.2.9' ? [{ id: 'OLD', title: 'published', status: 'red' }] : [{ id: 'NEW', title: 'unassigned', ...state }] };
    await runSeatLoopOnce('OP', deps);
    const path = seatLedgerPath('OP', f.root, now);
    let rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0].candidate).toMatchObject({ version: '0.2.10', red: [], undecided: ['NEW'] });
    expect(rows[1].candidate).toMatchObject({ version: '0.2.10', id: 'NEW' });
    state.owner = 'TC';
    await runSeatLoopOnce('OP', deps);
    rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(4);
    expect(rows[3].candidate).toEqual({ kind: 'unassigned-cell', version: null, id: null, verdict: 'none' });
  } finally { f.close(); }
});

test('OP shadow: unreadable schedules do not produce invented judgments or call actions', async () => {
  const f = fixture();
  try {
    let calls = 0;
    await expect(runSeatLoopOnce('OP', { ...f.deps, config: { mode: 'on', seats: ['OP'] },
      schedules: () => { throw Error('unreadable schedules'); },
      run: async () => { calls++; return ''; } })).rejects.toThrow('unreadable schedules');
    expect(existsSync(seatLedgerPath('OP', f.root, now))).toBe(false);
    expect(calls).toBe(0);
  } finally { f.close(); }
});

test('OP off reads no release or decision source and writes no judgment', async () => {
  const f = fixture();
  try {
    const result = await runSeatLoopOnce('OP', { ...f.deps, config: { mode: 'off', seats: ['OP'] },
      schedules: () => { throw Error('read schedules'); }, pendingDecisions: () => { throw Error('read decisions'); },
      run: async () => { throw Error('action'); } });
    expect(result).toEqual({ seat: 'OP', status: 'skipped-off' });
    expect(existsSync(seatLedgerPath('OP', f.root, now))).toBe(false);
  } finally { f.close(); }
});

test('shadow: TC 칸 둘, 이른 판 먼저 · 실행 0 · 날짜 원장 한 줄', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.10', [{ id: 'K1', owner: 'TC', title: '나중 판', status: 'red' }]);
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '먼저 판', status: 'yellow' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, run: async () => { calls++; return ''; } });
    expect(result.status).toBe('shadow');
    expect(entries(f)).toHaveLength(1);
    expect(entries(f)[0].item).toMatchObject({ id: 'K2', version: '0.2.9' });
    expect(entries(f)[0].action).toBe('harness');
    expect(calls).toBe(0);
    expect(seatLedgerPath('TC', f.root, now)).toContain('2026-10-03.jsonl');
  } finally { f.close(); }
});

test('shipped 0.2.5 cells are skipped; current 0.2.11 precedes 0.2.12', async () => {
  const f = fixture();
  const skipped: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'seat.loop' && event === 'skip-shipped-version') skipped.push(data);
  });
  try {
    checklist(f, '0.2.5', [
      { id: 'K9', owner: 'TC', title: 'shipped TC', status: 'yellow' },
      { id: 'M1', owner: 'MK', title: 'shipped MK', status: 'red' },
      { id: 'K8', owner: 'TC', title: 'done', status: 'done' },
    ]);
    writeFileSync(join(f.root, 'release', '0.2.5', 'release.json'), JSON.stringify({ version: '0.2.5', publishedAt: '2026-09-30T00:00:00Z' }));
    checklist(f, '0.2.11', [{ id: 'K11', owner: 'TC', title: 'current', status: 'red' }]);
    checklist(f, '0.2.12', [{ id: 'K12', owner: 'TC', title: 'next', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.12', '0.2.5', '0.2.11'], config: { mode: 'shadow', seats: ['TC'] } };
    const inputs = await gatherSeatInputs('TC', deps);
    expect(inputs.checklist.map((item) => [item.version, item.id])).toEqual([['0.2.11', 'K11'], ['0.2.12', 'K12']]);
    expect(inputs.checklist.filter((item) => item.version === '0.2.5')).toHaveLength(0);
    expect(pickNext(inputs, [])).toMatchObject({ id: 'K11', version: '0.2.11' });
    expect(pickNext(inputs, [{ seat: 'TC', at: now.toISOString(), status: 'launched', item: inputs.checklist[0] }])).toMatchObject({ id: 'K12', version: '0.2.12' });
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('shadow');
    expect(entries(f)[0].item).toMatchObject({ id: 'K11', version: '0.2.11' });
    expect(skipped).toContainEqual({ version: '0.2.5', cells: 1 });
  } finally { spy.mockRestore(); f.close(); }
});

test('a shadowed K9 moved from 0.2.11 to 0.2.12 is skipped unless its evidence or title changes', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const old = { id: 'K9', owner: 'TC', title: 'carry K9', status: 'yellow', evidence: 'same evidence' };
    checklist(f, '0.2.11', [old]);
    let carried = false;
    const history: NonNullable<SeatDeps['checklistHistory']> = (id) => id === 'K9' && carried ? [{
      id, at: now.toISOString(), by: 'TC', field: 'move', from: '0.2.11', to: '0.2.12',
      version: '0.2.12', seq: 1, released: '0.2.10', dev: '0.2.12', reason: 'carry forward',
    }] : [];
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.11', '0.2.12'], config: { mode: 'shadow', seats: ['TC'] }, checklistHistory: history };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('shadow');
    carried = true;
    checklist(f, '0.2.11', []);
    checklist(f, '0.2.12', [old, { id: 'Z10', owner: 'TC', title: 'next', status: 'yellow' }]);
    const inputs = await gatherSeatInputs('TC', deps);
    const ledger = entries(f);
    expect(alreadyHandled(inputs.checklist[0]!, ledger)).toBe(false);
    expect(pickNext(inputs, ledger, { shadow: true, history })?.id).toBe('Z10');
    expect(spy.mock.calls).toContainEqual(['seat.loop', 'skip-carried', { id: 'K9', from: '0.2.11', version: '0.2.12' }]);
    expect((await runSeatLoopOnce('TC', deps) as { item?: { id: string } }).item?.id).toBe('Z10');
    checklist(f, '0.2.12', [{ ...old, evidence: 'changed evidence' }]);
    const changed = await gatherSeatInputs('TC', deps);
    expect(alreadyHandled(changed.checklist[0]!, entries(f))).toBe(false);
    expect(pickNext(changed, entries(f), { shadow: true, history })?.id).toBe('K9');
    expect((await runSeatLoopOnce('TC', deps) as { item?: { id: string } }).item?.id).toBe('K9');
    checklist(f, '0.2.12', [{ ...old, title: 'retitled K9' }]);
    const retitled = await gatherSeatInputs('TC', deps);
    expect(alreadyHandled(retitled.checklist[0]!, entries(f))).toBe(false);
    expect(pickNext(retitled, entries(f), { shadow: true, history })?.id).toBe('K9');
  } finally { spy.mockRestore(); f.close(); }
});

test('carry selection requires an actual move and prior shadow with unchanged evidence', () => {
  const item = { source: 'checklist' as const, id: 'K9', version: '0.2.12', seat: 'TC', title: 'carry', text: 'carry',
    evidenceHash: 'same', asOf: now.toISOString() };
  const before = new Date(now.getTime() - 60_000).toISOString();
  const moved = new Date(now.getTime() - 30_000).toISOString();
  const row = { seat: 'TC', at: before, status: 'shadow' as const, action: 'harness' as const,
    item: { ...item, version: '0.2.11' } };
  const history: NonNullable<SeatDeps['checklistHistory']> = () => [{ id: 'K9', at: moved, by: 'TC', field: 'move',
    from: '0.2.11', to: '0.2.12', version: '0.2.12', seq: 1, released: '0.2.10', dev: '0.2.12' }];
  const inputs = { requests: [], checklist: [item], role: '' };
  expect(pickNext(inputs, [row], { shadow: true, history })).toBeNull();
  expect(pickNext(inputs, [row], { shadow: true, history: () => [] })).toEqual(item);
  expect(pickNext(inputs, [{ ...row, status: 'launched' }], { history })).toEqual(item);
  expect(pickNext(inputs, [{ ...row, item: { ...row.item, title: 'old title' } }], { shadow: true, history })).toEqual(item);
  expect(pickNext(inputs, [{ ...row, item: { ...row.item, evidenceHash: 'old' } }], { shadow: true, history })).toEqual(item);
  expect(pickNext(inputs, [{ ...row, at: now.toISOString() }], { shadow: true, history })).toEqual(item);
  expect(pickNext(inputs, [row, { ...row, at: now.toISOString(), item: { ...row.item, evidenceHash: 'old' } }],
    { shadow: true, history })).toEqual(item);
  expect(pickNext(inputs, [row], { shadow: true, history: () => [{ ...history('K9')[0]!, to: '0.2.13' }] })).toEqual(item);
});

test('carried cells with unchanged evidence are reconsidered after the seven-day shadow window', () => {
  const item = { source: 'checklist' as const, id: 'K9', version: '0.2.12', seat: 'TC', title: 'carry', text: 'carry',
    evidenceHash: 'same', asOf: now.toISOString() };
  const moved = new Date(now.getTime() - 86400_000).toISOString();
  const history: NonNullable<SeatDeps['checklistHistory']> = () => [{ id: 'K9', at: moved, by: 'TC', field: 'move',
    from: '0.2.11', to: '0.2.12', version: '0.2.12', seq: 1, released: '0.2.10', dev: '0.2.12' }];
  const oldShadow = { seat: 'TC', at: new Date(now.getTime() - 8 * 86400_000).toISOString(), status: 'shadow' as const,
    action: 'harness' as const, item: { ...item, version: '0.2.11' } };
  const inputs = { requests: [], checklist: [item], role: '' };
  expect(pickNext(inputs, [oldShadow], { shadow: true, history })).toEqual(item);
  expect(pickNext(inputs, [{ ...oldShadow, at: new Date(now.getTime() - 7 * 86400_000).toISOString() }],
    { shadow: true, history })).toBeNull();
});

test('alreadyHandled only matches the same seat, recent shadow or launch, id, title and evidence hash', () => {
  const item = { source: 'checklist' as const, id: 'K9', version: '0.2.12', title: 'carry', text: 'carry',
    seat: 'TC', evidenceHash: 'hash', asOf: now.toISOString() };
  const row = { seat: 'TC', at: now.toISOString(), status: 'launched' as const, item };
  expect(alreadyHandled(item, [{ ...row, item: { ...item, version: '0.2.11' } }])).toBe(false);
  expect(alreadyHandled(item, [row])).toBe(true);
  expect(alreadyHandled(item, [{ ...row, status: 'shadow' }])).toBe(true);
  expect(alreadyHandled(item, [{ ...row, seat: 'MK' }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, item: { ...row.item, id: 'other' } }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, status: 'skipped-budget' }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, at: new Date(now.getTime() - 7 * 86400_000).toISOString() }])).toBe(true);
  expect(alreadyHandled(item, [{ ...row, at: new Date(now.getTime() - 8 * 86400_000).toISOString() }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, item: { ...row.item, evidenceHash: 'other' } }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, item: { ...row.item, title: 'other' } }])).toBe(false);
  expect(alreadyHandled(item, [{ ...row, item: { ...row.item, evidenceHash: undefined } }])).toBe(false);
  expect(alreadyHandled({ ...item, evidenceHash: undefined }, [{ ...row, item: { ...row.item, evidenceHash: undefined } }])).toBe(false);
});

test('later shipped versions exclude every older version and count only eligible seat cells', async () => {
  const f = fixture();
  const skipped: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'seat.loop' && event === 'skip-shipped-version') skipped.push(data);
  });
  try {
    checklist(f, '0.2.5', [{ id: 'K9', owner: 'TC', title: 'old', status: 'yellow' }]);
    checklist(f, '0.2.11', [{ id: 'K11', owner: 'TC', title: 'released', status: 'red' }]);
    checklist(f, '0.2.12', [{ id: 'K12', owner: 'TC', title: 'unreleased', status: 'yellow' }]);
    writeFileSync(join(f.root, 'release', '0.2.11', 'release.json'), JSON.stringify({ version: '0.2.11', publishedAt: '2026-10-03T00:00:00Z' }));
    expect((await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.12', '0.2.11', '0.2.5'] })).checklist.map((item) => item.id)).toEqual(['K12']);
    expect(skipped).toEqual([{ version: '0.2.5', cells: 1 }, { version: '0.2.11', cells: 1 }]);
  } finally { spy.mockRestore(); f.close(); }
});

test('unreadable published-version ledger keeps the former version order and warns once', async () => {
  const f = fixture();
  const warnings: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((message) => { warnings.push(String(message)); });
  try {
    writeFileSync(join(f.root, 'release'), 'not a directory');
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.12', '0.2.5', '0.2.11'], checklistItems: (version) => [
      { id: `K${version}`, owner: 'TC', title: version, status: 'yellow' },
    ] };
    const inputs = await gatherSeatInputs('TC', deps);
    expect(inputs.checklist.map((item) => item.version)).toEqual(['0.2.5', '0.2.11', '0.2.12']);
    expect(pickNext(inputs, [])?.version).toBe('0.2.5');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('seat loop: cannot read published versions; retaining previous order');
  } finally { spy.mockRestore(); f.close(); }
});

test('only versions whose cut is still ahead are open — closed versions share one log line', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.10', [{ id: 'K10', owner: 'TC', title: 'cut already', status: 'yellow' }]);
    checklist(f, '0.2.11', [{ id: 'K11', owner: 'TC', title: 'cut tomorrow', status: 'red' }]);
    const schedules = () => [{ version: '0.2.10', cutAt: '2026-10-02T22:00:00Z' }, { version: '0.2.11', cutAt: '2026-10-03T23:00:00Z' }];
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.12', '0.2.11', '0.2.10'], schedules });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['K11']);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-versions'))
      .toEqual([['seat.loop', 'skip-closed-versions', { seat: 'TC', count: 2, newest: '0.2.12', oldest: '0.2.10' }]]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-version')).toHaveLength(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('no closed versions write no skip-closed-versions log line', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.11', [{ id: 'K11', owner: 'TC', title: 'open', status: 'red' }]);
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.11'],
      schedules: () => [{ version: '0.2.11', cutAt: '2026-10-03T23:00:00Z' }] });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['K11']);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-versions')).toHaveLength(0);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-version')).toHaveLength(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('unreadable schedules pick no checklist cell (fail closed) and warn once', async () => {
  const f = fixture();
  const warnings: string[] = [];
  const spy = spyOn(console, 'warn').mockImplementation((message) => { warnings.push(String(message)); });
  const logSpy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.11', [{ id: 'K11', owner: 'TC', title: 'current', status: 'red' }]);
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.11'], schedules: () => { throw new Error('ledger locked'); } });
    expect(inputs.checklist).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cannot read release schedules');
    expect(logSpy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'schedule-unreadable'))
      .toEqual([['seat.loop', 'schedule-unreadable', { seat: 'TC', error: 'Error: ledger locked' }]]);
    expect(logSpy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-versions')).toHaveLength(0);
  } finally { logSpy.mockRestore(); spy.mockRestore(); f.close(); }
});

test('unreadable checklist logs the version and does not block another open version', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.11', '0.2.12'],
      checklistItems: (version) => {
        if (version === '0.2.11') throw new Error('checklist locked');
        return [{ id: 'K12', owner: 'TC', title: 'open', status: 'red' }];
      } });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['K12']);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'checklist-unreadable'))
      .toEqual([['seat.loop', 'checklist-unreadable', { seat: 'TC', version: '0.2.11', error: 'Error: checklist locked' }]]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'skip-closed-versions')).toHaveLength(0);
  } finally { spy.mockRestore(); f.close(); }
});

test('role excerpt is at most 4,000 characters', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'docs', 'roles'), { recursive: true });
    writeFileSync(join(f.root, 'docs', 'roles', 'TC.md'), 'T'.repeat(5000));
    const inputs = await gatherSeatInputs('TC', f.deps);
    expect(inputs.role).toBe('T'.repeat(4000));
    expect(inputs).not.toHaveProperty('seat');
  } finally { f.close(); }
});

test('requests precede checklist, oldest first; status updates and launched keys do not repeat', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), [
      { key: 'b', seat: 'TC', text: 'new', status: 'queued', queuedAt: '2026-10-02T01:00:00Z' },
      { key: 'a', seat: 'TC', text: 'old', status: 'pending', queuedAt: '2026-10-01T01:00:00Z' },
      { key: 'x', seat: 'UX', text: 'other', status: 'queued', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'moved', seat: 'TC', text: 'old assignment', status: 'pending', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'moved', seat: 'UX', text: 'new assignment', status: 'queued', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'closed', seat: 'TC', text: 'old request', status: 'pending', queuedAt: '2026-09-01T01:00:00Z' },
      { key: 'closed', seat: 'TC', text: 'old request', status: 'done', queuedAt: '2026-09-01T01:00:00Z' },
    ].map((v) => JSON.stringify(v)).join('\n'));
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: 'cell', status: 'yellow' }]);
    const input = await gatherSeatInputs('TC', f.deps);
    expect(input.requests.map((v) => v.id)).toEqual(['a', 'b']);
    expect(input.checklist.map((v) => v.id)).toEqual(['K2']);
    expect(pickNext(input, [])?.id).toBe('a');
    expect(pickNext(input, [{ seat: 'TC', at: '', status: 'launched', item: input.requests[0] }])?.id).toBe('b');
  } finally { f.close(); }
});

test('forbidden 게시 문면은 decision, on 에서 하니스 0 · 재상정 0', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '마켓에 게시', status: 'yellow' }]);
    mkdirSync(join(f.root, 'docs', 'roles'), { recursive: true });
    writeFileSync(join(f.root, 'docs', 'roles', 'TC.md'), 'TC 역할 지침');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); return args[1] === 'budget' ? '{"outcome":"proceed"}' : '{"id":"dec-test"}'; } };
    expect(planAction({ source: 'checklist', id: 'K2', title: '마켓에 게시', text: '마켓에 게시' }).kind).toBe('decision');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    await runSeatLoopOnce('TC', deps);
    expect(calls.filter((v) => v[0] === 'decisions')).toHaveLength(1);
    expect(calls.find((v) => v[0] === 'decisions')).toContain('raise');
    expect(calls.find((v) => v[0] === 'decisions')).toContain('--category');
    expect(calls.find((v) => v[0] === 'decisions')).toContain('--option');
    const raise = calls.find((v) => v[0] === 'decisions')!;
    expect(raise[raise.indexOf('--s') + 1]).toContain('역할: TC 역할 지침');
    expect(calls.filter((v) => v[0] === 'harness' && v[1] === 'say')).toHaveLength(0);
    expect(entries(f).filter((v) => v.status === 'hitl')).toHaveLength(1);
  } finally { f.close(); }
});

test('repeat stop remeasures a recovered checklist cell before raising a card and closes only that cell', async () => {
  const f = fixture();
  try {
    let status = 'yellow';
    let reads = 0;
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.9'], config: { mode: 'live-safe', seats: ['TC'], repeatStop: 1 },
      checklistItems: () => { reads++; return [{ id: 'K-stop', owner: 'TC', title: '검사 구현', status }]; },
      queueItems: () => [], queueOutcome: () => 'failed' as never,
      run: async (args) => { calls.push(args); if (args[1] === 'budget') { status = 'green'; return '{"outcome":"proceed"}'; } throw Error('recovered cell launched'); } };
    const item = (await gatherSeatInputs('TC', deps)).checklist[0]!;
    const ledgerPath = seatLedgerPath('TC', f.root, now);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'refused', item, action: 'harness', reason: 'prior failure' }) + '\n');
    const result = await runSeatLoopOnce('TC', deps);
    expect(result).toMatchObject({ status: 'resolved', item: { id: 'K-stop' }, reason: expect.stringContaining('green') });
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ status: 'resolved', item: { id: 'K-stop' } });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(calls.map(args => args[1])).toEqual(['budget']);
    expect(new DecisionLedger({ stateDir: f.root }).list()).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('repeat stop remeasures a completed request and raises no card', async () => {
  const f = fixture();
  try {
    let lines = [JSON.stringify({ key: 'req-stop', seat: 'TC', text: '검사 구현', status: 'pending', queuedAt: now.toISOString() })];
    const requests = join(f.root, 'seat-requests', 'requests.jsonl');
    writeFileSync(requests, lines.join('\n') + '\n');
    const deps: SeatDeps = { ...f.deps, versions: () => [], config: { mode: 'live-safe', seats: ['TC'], repeatStop: 1 },
      queueItems: () => [], queueOutcome: () => 'failed' as never,
      run: async (args) => {
        if (args[1] === 'budget') {
          lines = [...lines, JSON.stringify({ key: 'req-stop', seat: 'TC', text: '검사 구현', status: 'done', queuedAt: now.toISOString() })];
          writeFileSync(requests, lines.join('\n') + '\n');
          return '{"outcome":"proceed"}';
        }
        throw Error('completed request launched');
      } };
    const item = (await gatherSeatInputs('TC', deps)).requests[0]!;
    const path = seatLedgerPath('TC', f.root, now);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'refused', item, action: 'harness', reason: 'prior failure' }) + '\n');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('resolved');
    expect(new DecisionLedger({ stateDir: f.root }).list()).toHaveLength(0);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('repeat stop with an unresolved cell raises one fully grounded recommended card', async () => {
  const f = fixture();
  try {
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.9'], config: { mode: 'live-safe', seats: ['TC'], repeatStop: 1 },
      checklistItems: () => [{ id: 'K-stop', owner: 'TC', title: '검사 구현', status: 'yellow', evidence: '테스트 실패 기록' }],
      queueItems: () => [], queueOutcome: () => 'failed' as never,
      resolveDecisionVersion: () => ({ released: null, dev: null, codename: null }),
      run: async (args) => args[1] === 'budget' ? '{"outcome":"proceed"}' : Promise.reject(Error('must not launch')) };
    const item = (await gatherSeatInputs('TC', deps)).checklist[0]!;
    const path = seatLedgerPath('TC', f.root, now);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'refused', item, action: 'harness', reason: 'prior failure' }) + '\n');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('held');
    const cards = new DecisionLedger({ stateDir: f.root }).list();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.scqa.q?.trim()).not.toBe('');
    expect(cards[0]!.scqa.a?.trim()).not.toBe('');
    expect(cards[0]!.recommendation).toMatchObject({ option: 'b', why: expect.stringContaining('중복') });
    for (const label of ['무엇:', '지금까지:', '지금 상태 재측:', '선택지 a', '선택지 b', '권고:', '확신:', '그냥 두면:', '근거:'])
      expect(cards[0]!.pendingQuestion).toContain(label);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(new DecisionLedger({ stateDir: f.root }).list()).toHaveLength(1);
  } finally { f.close(); }
});

test('topic of merge repair does not raise a forbidden card; an explicit merge request carries the matched word and judgment material', async () => {
  const f = fixture();
  try {
    const calls: string[][] = [];
    checklist(f, '0.2.9', [{ id: 'K-merge', owner: 'TC', title: '병합 경로에 동결 검사를 더하는', status: 'yellow' }]);
    expect(planAction({ source: 'checklist', id: 'K-merge', title: '병합 경로에 동결 검사를 더하는', text: '병합 경로에 동결 검사를 더하는' }).kind).toBe('harness');
    expect(planAction({ source: 'checklist', id: 'K-merge', title: '병합 경로에 동결 검사를 더하는', text: '병합 경로에 동결 검사를 더하는', evidence: 'main 에 병합해라 예시를 막는다' }).kind).toBe('harness');
    expect(planAction({ source: 'checklist', id: 'K-merge', title: 'main 에 병합해라', text: '동결 검사 구현' }).kind).toBe('harness');
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : args[1] === 'say'
        ? '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]' : '{"id":"dec-test"}';
    } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    expect(calls.filter(args => args[1] === 'raise')).toHaveLength(0);
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'), JSON.stringify({ key: 'merge-now', seat: 'TC', text: 'main 에 병합해라', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    const raises = calls.filter(args => args[1] === 'raise');
    expect(raises).toHaveLength(1);
    const value = (flag: string) => raises[0]![raises[0]!.indexOf(flag) + 1]!;
    expect(value('--pending-question')).toContain('걸린 낱말 병합');
    for (const flag of ['--q', '--a', '--recommend', '--why']) expect(value(flag).trim()).not.toBe('');
    for (const label of ['무엇:', '지금까지:', '지금 상태 재측:', '선택지 a', '선택지 b', '권고:', '확신:', '그냥 두면:', '근거:', 'Q:', 'A:'])
      expect(value('--pending-question')).toContain(label);
  } finally { f.close(); }
});

test('plan table separates publication, preparation and physical measurement across item text and evidence', () => {
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const cases = [
      { title: '마켓에 게시', kind: 'decision', reason: '마켓에 게시' },
      { title: '레지스트리에 등록', kind: 'decision', reason: '레지스트리에 등록' },
      { title: '사이트 운영 반영', kind: 'decision', reason: '사이트 운영 반영' },
      { title: 'SNS에 업로드', kind: 'decision', reason: 'SNS에 업로드' },
      { title: '공개 발행', kind: 'decision', reason: '공개 발행' },
      { title: '마켓 게시 준비', kind: 'harness', reason: '마켓 게시 준비' },
      { title: '레지스트리 등록용 코드', kind: 'harness', reason: '레지스트리 등록용 코드' },
      { title: 'SNS 게시 초안', kind: 'harness', reason: 'SNS 게시 초안' },
      { title: '사람 기기 실측 대기', kind: 'wait', reason: '사람 기기 실측' },
      { title: '실물 측정', kind: 'wait', reason: '실물 측정' },
      { title: '\u{1F451} 확인 대기 후 공개 발행', kind: 'wait', reason: '\u{1F451} 확인 대기' },
    ] as const;
    for (const { title, kind, reason } of cases) {
      const planned = planAction({ source: 'checklist', id: 'K', title, text: title }, 'MK');
      expect(planned.kind).toBe(kind);
      expect(planned.reason).toBe(reason);
      expect(spy.mock.calls.at(-1)).toEqual(['seat.loop', 'plan', { kind, reason }]);
    }
    expect(planAction({ source: 'request', id: 'r', title: '작업', text: '게시 준비' }, 'MK').kind).toBe('harness');
    expect(planAction({ source: 'checklist', id: 'K', title: '점검', text: '점검', evidence: '\u{1F451} 확인 대기' }, 'MK'))
      .toMatchObject({ kind: 'wait', reason: '\u{1F451} 확인 대기' });
    expect(planAction({ source: 'checklist', id: 'K', title: '실물 측정 대기', text: '실물 측정 대기', evidence: '실측 완료' }, 'MK').kind)
      .toBe('harness');
    expect(planAction({ source: 'request', id: 'r', title: '작업', text: '배포' }, 'MK'))
      .toMatchObject({ kind: 'decision', reason: '배포' });
    expect(planAction({ source: 'request', id: 'r', title: '작업', text: '구현' }, 'MK'))
      .toMatchObject({ kind: 'harness', text: '[MK 자리 · 자리 요청 r · 역할 docs/roles/MK.md] 작업' });
    expect(planAction({ source: 'request', id: 'r', title: '삭제', text: '삭제' }, 'MK'))
      .toMatchObject({ kind: 'decision', reason: '삭제' });
    expect(planAction({ source: 'request', id: 'r', title: '구현', text: '구현', evidence: '기존 배포 기록' }, 'MK'))
      .toMatchObject({ kind: 'harness', text: '[MK 자리 · 자리 요청 r · 역할 docs/roles/MK.md] 구현' });
    expect(planAction({ source: 'request', id: 'r', title: '검토', text: '검토', evidence: 'SNS에 게시' }, 'MK').kind).toBe('harness');
    expect(planAction({ source: 'request', id: 'r', title: '마켓에 게시', text: '마켓에 게시', evidence: '마켓 게시 준비 완료' }, 'MK').kind)
      .toBe('decision');
    for (const text of ['마켓 게시 준비 후 마켓에 게시', '삭제 후 게시 준비', '마켓 게시 준비 후 배포', '마켓 게시 준비 후 SNS에 업로드']) {
      expect(planAction({ source: 'request', id: 'r', title: text, text }, 'MK').kind).toBe('decision');
    }
    expect(planAction({ source: 'request', id: 'r', title: '마켓 게시 준비', text: '마켓 게시 준비' }, 'MK').kind).toBe('harness');
  } finally { spy.mockRestore(); }
});

test('preparation with destination particles stays harness, but a separate publishing instruction is a decision', () => {
  for (const title of ['마켓에 게시 준비', 'SNS에 게시 초안', '마켓에 게시 준비 조사', 'SNS에 게시 초안 조사']) {
    expect(planAction({ source: 'checklist', id: 'K', title, text: title }).kind).toBe('harness');
  }
  for (const title of ['마켓에 게시 준비 후 마켓에 게시', 'SNS에 게시 초안 작성 후 SNS에 게시']) {
    expect(planAction({ source: 'request', id: 'r', title, text: title }).kind).toBe('decision');
  }
});

test('measurement completion cannot resolve a separate royal confirmation wait', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: `실물 측정 대기 및 ${CEO} 확인 대기`, status: 'yellow', evidence: `실측 완료 · ${CEO} 확인 대기` }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); throw Error('pending confirmation must not execute'); } });
    expect(result).toMatchObject({ status: 'wait', action: 'wait', reason: `${CEO} 확인 대기` });
    expect(calls).toEqual([]);
    expect(planAction({ source: 'request', id: 'r', title: `${CEO} 확인 대기`, text: `${CEO} 확인 대기`, evidence: '실측 완료' }).kind).toBe('wait');
    expect(planAction({ source: 'request', id: 'r', title: '실측 대기', text: '실측 대기', evidence: `${CEO} 확인 완료` }).kind).toBe('wait');
    expect(planAction({ source: 'request', id: 'r', title: `실측 대기 · ${CEO} 확인 대기`, text: `실측 대기 · ${CEO} 확인 대기`, evidence: `실측 완료 · ${CEO} 확인 완료` }).kind).toBe('harness');
  } finally { f.close(); }
});

test('on: mixed preparation and publication raises a decision without launching harness work', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '마켓 게시 준비 후 마켓에 게시', status: 'yellow' }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : '{"id":"dec-mixed"}';
    } });
    expect(result).toMatchObject({ status: 'hitl', action: 'decision' });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([['harness', 'budget'], ['decisions', 'raise']]);
    expect(calls[1]).toContain('--no-xcheck');
    expect(calls[1]?.[calls[1].indexOf('--no-xcheck') + 1]).toBe('자리 루프 · 이웃 교환은 DEC-XCHECK ②');
    expect(entries(f).at(-1)).toMatchObject({ status: 'hitl', action: 'decision' });
  } finally { f.close(); }
});

test('request evidence reaches the plan without changing ordinary request fields', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'),
      JSON.stringify({ key: 'req-1', seat: 'MK', text: '확인', evidence: '\u{1F451} 확인 대기', status: 'pending', queuedAt: '2026-10-02T09:00:00.000Z' }) + '\n');
    const inputs = await gatherSeatInputs('MK', f.deps);
    expect(inputs.requests[0]).toMatchObject({ id: 'req-1', title: '확인', text: '확인', evidence: '\u{1F451} 확인 대기', createdAt: '2026-10-02T09:00:00.000Z' });
    expect(planAction(inputs.requests[0]!, 'MK')).toMatchObject({ kind: 'wait', reason: '\u{1F451} 확인 대기' });
  } finally { f.close(); }
});

test('on: measurement evidence waits with a reason and makes no budget, decision or harness call', async () => {
  const f = fixture();
  try {
    const evidence = '실물 측정 대기 · 사람 기기';
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, versions: () => ['0.2.9'],
      checklistItems: () => [{ id: 'K2', owner: 'TC', title: '기기 검증', status: 'yellow', evidence }],
      config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); throw Error('wait must not execute'); } };
    const inputs = await gatherSeatInputs('TC', deps);
    expect(inputs.checklist).toHaveLength(1);
    expect(inputs.checklist[0]?.evidence).toBe(evidence);
    expect(planAction(inputs.checklist[0]!, 'TC')).toMatchObject({ kind: 'wait', reason: '실물 측정' });
    const result = await runSeatLoopOnce('TC', deps);
    expect(result).toMatchObject({ status: 'wait', action: 'wait', reason: '실물 측정', item: { evidence } });
    expect(entries(f)).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(calls).toEqual([]);
  } finally { f.close(); }
}, 30_000);

test('on: wait rechecks changed measurement evidence and then launches only once', async () => {
  const f = fixture();
  try {
    let evidence = '실물 측정 대기';
    let status = 'yellow';
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      checklistItems: () => [{ id: 'K2', owner: 'TC', title: '기기 검증', status, evidence }],
      versions: () => ['0.2.9'],
      run: async (args) => { calls.push(args); return args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]'; } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('wait');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(calls).toEqual([]);
    status = 'red';
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('wait');
    expect(calls).toEqual([]);
    evidence = '실물 측정 완료';
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(calls.map((args) => args[1])).toEqual(['budget', 'say']);
    expect(entries(f).map((entry) => entry.status)).toEqual(['wait', 'skipped-empty', 'wait', 'attempting', 'launched', 'skipped-empty']);
  } finally { f.close(); }
});

test('on: publication preparation uses harness even when it names a prohibited publishing verb', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '마켓 게시 준비', status: 'yellow' }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } });
    expect(result.status).toBe('launched');
    expect(calls.map((args) => args[1])).toEqual(['budget', 'say']);
    expect(entries(f).at(-1)).toMatchObject({ status: 'launched', action: 'harness', reason: '마켓 게시 준비' });
  } finally { f.close(); }
});

test('decision raise without a receipt is observed and does not starve the next item', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    checklist(f, '0.2.9', [
      { id: 'K2', owner: 'TC', title: '마켓에 게시', status: 'yellow' },
      { id: 'K3', owner: 'TC', title: 'SNS에 게시', status: 'yellow' },
    ]);
    const raises: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] }, queueItems: () => [], run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      raises.push(args);
      if (raises.length === 1) throw Error('decision ledger unavailable');
      return '{"id":"dec-good"}';
    } };
    expect(await runSeatLoopOnce('TC', deps)).toMatchObject({ status: 'hitl', item: { id: 'K3' } });
    expect(raises).toHaveLength(2);
    expect(entries(f).map((entry) => [entry.item?.id, entry.status])).toEqual([
      ['K2', 'attempting'], ['K2', 'outcome-unknown'], ['K3', 'attempting'], ['K3', 'hitl'],
    ]);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'decision-raise-failed'))
      .toEqual([['seat-loop', 'decision-raise-failed', { source: 'seat-loop:TC:checklist%3A0.2.9%3AK2', error: 'Error: decision ledger unavailable' }]]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { spy.mockRestore(); f.close(); }
});

test('a failed decision raise with no remaining work returns its failed outcome instead of an empty tick', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const source = 'coord:5970836854:TC';
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'),
      JSON.stringify({ key: source, seat: 'TC', text: '마켓에 게시', status: 'pending', queuedAt: now.toISOString() }) + '\n');
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] }, queueItems: () => [], run: async (args) => {
      calls.push(args);
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      throw Error('decision ledger unavailable');
    } };
    const result = await runSeatLoopOnce('TC', deps);
    expect(result).toMatchObject({ status: 'outcome-unknown', action: 'decision', item: { id: source } });
    expect(entries(f).map((row) => row.status)).toEqual(['attempting', 'outcome-unknown']);
    expect(calls.map((args) => args[1])).toEqual(['budget', 'raise']);
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat-loop' && event === 'decision-raise-failed'))
      .toEqual([['seat-loop', 'decision-raise-failed', { source, error: 'Error: decision ledger unavailable' }]]);
  } finally { spy.mockRestore(); f.close(); }
});

test('600-character four-sentence coord request raises one bounded card with its original comment id as source', async () => {
  const f = fixture();
  try {
    const source = 'coord:5970836854:TC';
    const request = Array.from({ length: 4 }, (_, i) => `요청 ${i + 1} ${'긴문장'.repeat(50)}.`).join(' ');
    expect(Array.from(request).length).toBeGreaterThanOrEqual(600);
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'),
      JSON.stringify({ key: source, seat: 'TC', text: `마켓에 게시 ${request}`, status: 'pending', queuedAt: now.toISOString() }) + '\n');
    mkdirSync(join(f.root, 'docs', 'roles'), { recursive: true });
    writeFileSync(join(f.root, 'docs', 'roles', 'TC.md'), '역할: ' + '지침.'.repeat(300));
    const cards = new DecisionLedger({ stateDir: f.root, now: () => now, resolveVersion: () => ({ released: '0.2.8', dev: '0.2.9', codename: null }) });
    const raises: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] }, queueItems: () => [], run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      raises.push(args);
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      const card = cards.raise({ title: value('--title'), category: 'other',
        scqa: { s: value('--s'), c: value('--c'), q: value('--q'), a: value('--a') },
        pendingQuestion: value('--pending-question'),
        options: [{ key: 'a', label: '승인', consequence: '별도 집행' }, { key: 'b', label: '보류', consequence: '집행하지 않음' }],
        recommendation: { option: value('--recommend'), why: value('--why') }, raisedBy: { agent: 'seat-loop' }, refs: [value('--ref')] });
      return JSON.stringify({ id: card.id });
    } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('hitl');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(raises).toHaveLength(1);
    expect(cards.list()).toHaveLength(1);
    const [card] = cards.list();
    expect(card!.refs).toContain(source);
    expect(card!.scqa.q).toContain('승인할까?');
    expect(card!.scqa.a).toContain('보류한다');
    expect(card!.recommendation).toMatchObject({ option: 'b', why: expect.stringContaining('보류한다') });
    expect(card!.pendingQuestion).toContain('걸린 낱말 마켓에 게시');
    expect(raises[0]).toContain(source);
    for (const field of Object.values(card!.scqa)) {
      expect(Array.from(field).length).toBeLessThanOrEqual(240);
      expect(field.split(/[.!?。！？]+(?:\s+|$)/).filter(Boolean).length).toBeLessThanOrEqual(2);
    }
    expect(card!.scqa.s).not.toContain(request);
  } finally { f.close(); }
});

test('seat quota denies a launch, records skipped-budget, and escalates exactly one line to its parent', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const raised: Array<{ parent: string; line: string }> = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      budgetConfig: { org: { budget: { TC: { dailyGoals: 0 } } } }, running: () => [],
      escalate: async (parent, line) => { raised.push({ parent, line }); },
      run: async (args) => { calls.push(args); return '{"outcome":"proceed"}'; } };
    const result = await runSeatLoopOnce('TC', deps);
    expect(result).toMatchObject({ status: 'skipped-budget', reason: 'TC daily goals budget reached (0/0)' });
    expect(entries(f)).toHaveLength(1);
    expect(entries(f)[0]).toMatchObject({ status: 'skipped-budget', action: 'skipped-budget', reason: 'TC daily goals budget reached (0/0)' });
    expect(calls).toEqual([['harness', 'budget', '--json']]);
    expect(raised).toEqual([{ parent: 'OP', line: '[TC → OP] K2: TC daily goals budget reached (0/0)' }]);
    await runSeatLoopOnce('TC', deps);
    expect(raised).toHaveLength(1);
    expect(calls.filter((args) => args[1] === 'say')).toHaveLength(0);
  } finally { f.close(); }
});

test('default denial reaches the parent seat inbox through the message store', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      budgetConfig: { org: { budget: { TC: { dailyGoals: 0 } } } }, running: () => [],
      run: async (args) => { calls.push(args); return '{"outcome":"proceed"}'; } });
    expect(result.status).toBe('skipped-budget');
    expect(calls).toEqual([['harness', 'budget', '--json']]);
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('OP')).toMatchObject([{ from: 'TC', to: 'OP', kind: 'seat-budget-escalation', body: '[TC → OP] K2: TC daily goals budget reached (0/0)' }]); }
    finally { store.close(); }
  } finally { f.close(); }
});

test('running Pod quota denies launch without mislabelling an unknown substrate', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const raised: string[] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      running: () => [{ seat: 'TC', substrate: 'pod' }, { seat: 'TC' }],
      escalate: async (_parent, line) => { raised.push(line); },
      run: async (args) => { calls.push(args); return '{"outcome":"proceed"}'; } });
    expect(result).toMatchObject({ status: 'skipped-budget', reason: 'TC concurrent Pods budget cannot be verified (1 confirmed, 1 unknown; limit 2)' });
    expect(calls).toHaveLength(1);
    expect(raised).toHaveLength(1);
  } finally { f.close(); }
});

// TC harvest #23272 — through the DEFAULT observation path (no deps.running): a Pod launched yesterday and still
// running counts against today's concurrent budget; uncertain liveness is «cannot verify», never a confirmed Pod.
const queried = (statusById: Record<string, string>) => spyOn(runningRunsModule, 'queryRunningRuns').mockImplementation(((options: { runIds?: readonly string[] }) => ({
  completeness: 'complete', pty: { unreadable: [] },
  entries: (options.runIds ?? []).filter((id) => statusById[id]).map((runId) => ({ runId, status: statusById[runId] })),
})) as never);
const launchedYesterday = (f: ReturnType<typeof fixture>, runIds: string[]) => {
  const yesterday = new Date(now.getTime() - 24 * 3600_000);
  const path = seatLedgerPath('TC', f.root, yesterday);
  mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
  writeFileSync(path, runIds.map((runId, i) => JSON.stringify({ seat: 'TC', at: yesterday.toISOString(), status: 'launched', runId,
    item: { source: 'request', id: `y-${i}`, title: 'yesterday', text: 'yesterday' } })).join('\n') + '\n');
};

test('default observation counts Pods launched yesterday that are still running', async () => {
  const f = fixture();
  const spy = queried({ 'run-y1': 'running', 'run-y2': 'running' });
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    launchedYesterday(f, ['run-y1', 'run-y2']);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, escalate: async () => {},
      run: async (args) => { calls.push(args); return '{"outcome":"proceed"}'; } });
    expect(result).toMatchObject({ status: 'skipped-budget', reason: 'TC concurrent Pods budget reached (2/2)' });
    expect(calls.some((args) => args[0] === 'harness' && args[1] === 'say')).toBe(false);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ runIds: ['run-y1', 'run-y2'] });
  } finally { spy.mockRestore(); f.close(); }
});

test('default observation keeps uncertain liveness unknown instead of a confirmed Pod', async () => {
  const f = fixture();
  const spy = queried({ 'run-y1': 'running', 'run-y2': 'probable-running' });
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    launchedYesterday(f, ['run-y1', 'run-y2']);
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, escalate: async () => {},
      run: async () => '{"outcome":"proceed"}' });
    expect(result).toMatchObject({ status: 'skipped-budget', reason: 'TC concurrent Pods budget cannot be verified (1 confirmed, 1 unknown; limit 2)' });
  } finally { spy.mockRestore(); f.close(); }
});

test('a failed budget escalation is retried on the next turn; a delivered one is not repeated', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let attempts = 0;
    const delivered: string[] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, budgetConfig: { org: { budget: { TC: { dailyGoals: 0 } } } }, running: () => [],
      escalate: async (_parent, line) => { attempts += 1; if (attempts === 1) throw new Error('inbox down'); delivered.push(line); },
      run: async () => '{"outcome":"proceed"}' };
    expect(await runSeatLoopOnce('TC', deps)).toMatchObject({ status: 'skipped-budget', escalated: false });
    expect(await runSeatLoopOnce('TC', deps)).toMatchObject({ status: 'skipped-budget', escalated: true });
    await runSeatLoopOnce('TC', deps);
    expect(attempts).toBe(2);
    expect(delivered).toHaveLength(1);
  } finally { f.close(); }
});

test('quota counts only successful launches today, and refuses the seventh before harness say', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const path = seatLedgerPath('TC', f.root, now);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, Array.from({ length: 6 }, (_, i) => JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'launched', item: { source: 'request', id: `prior-${i}`, title: 'earlier', text: 'earlier' } })).join('\n') + '\n');
    const calls: string[][] = [];
    const denied = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, running: () => [],
      escalate: async () => {}, run: async (args) => { calls.push(args); return '{"outcome":"proceed"}'; } });
    expect(denied).toMatchObject({ status: 'skipped-budget', reason: 'TC daily goals budget reached (6/6)' });
    expect(calls).toEqual([['harness', 'budget', '--json']]);
    expect(entries(f).at(-1)).toMatchObject({ status: 'skipped-budget', action: 'skipped-budget' });
  } finally { f.close(); }
});

test('consumed hook work card does not enter the next seat input, even after another event arrives', async () => {
  const f = fixture();
  try {
    const config = parseEventsConfig({ mode: 'on', routes: [{ source: 'linear', kind: 'Issue:create', seat: 'TC', loop: 'seat' }] });
    const event = (id: string) => ({ provider: 'linear' as const, eventId: id, kind: 'Issue:create',
      task: { eventId: id, title: `Implement ${id}`, external: { provider: 'linear' as const, ref: id } } });
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) =>
      args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]' };
    await dispatchHook(event('first'), f.root, config, async () => {});
    const firstInput = await gatherSeatInputs('TC', deps);
    expect(firstInput.requests.map(item => item.title)).toEqual([expect.stringContaining('Implement first')]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(store.db.query('SELECT woken FROM hook_work_cards').all()).toEqual([{ woken: 1 }]); }
    finally { store.close(); }
    expect((await gatherSeatInputs('TC', deps)).requests).toEqual([]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    await dispatchHook(event('second'), f.root, config, async () => {});
    const nextInput = await gatherSeatInputs('TC', deps);
    expect(nextInput.requests.map(item => item.title)).toEqual([expect.stringContaining('Implement second')]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    expect(entries(f).filter(entry => entry.status === 'launched').map(entry => entry.item.title))
      .toEqual([expect.stringContaining('Implement first'), expect.stringContaining('Implement second')]);
  } finally { f.close(); }
});

test('budget cannot proceed: no launch, skipped-budget', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => { calls.push(args); return '{"outcome":"wait-reset"}'; } });
    expect(result.status).toBe('skipped-budget');
    expect(calls).toHaveLength(1);
  } finally { f.close(); }
});

test('failed budget observation never authorizes a launch', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => { calls++; throw Error('budget unavailable'); } });
    expect(result.status).toBe('skipped-budget');
    expect(calls).toBe(1);
  } finally { f.close(); }
});

test('on: harness say once, runId recorded, next loop does not reselect same cell', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'], podPool: 'test-pool' }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    await runSeatLoopOnce('TC', deps);
    expect(calls.filter((v) => v[1] === 'say')).toEqual([['harness', 'say', '[TC 자리 · 0.2.9 체크리스트 칸 K2 · 역할 docs/roles/TC.md] 구현', '--substrate', 'pod', '--pod-pool', 'test-pool', '--base', 'main', '--json']]);
    expect(entries(f).find((entry) => entry.status === 'launched')?.runId).toBe('run-12345678-1234-1234-1234-123456789abc');
  } finally { f.close(); }
});

for (const [title, command, receipt, expected] of [
  ['구현', 'say', '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]', 'launched'],
  ['마켓에 게시', 'raise', '{"id":"dec-test"}', 'hitl'],
] as const) {
  test(`concurrent same-seat loops serialize ${command} across ledger read and external call`, async () => {
    const f = fixture();
    try {
      checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title, status: 'yellow' }]);
      let started!: () => void;
      let release!: () => void;
      const inCommand = new Promise<void>((resolve) => { started = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[][] = [];
      const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
        calls.push(args);
        if (args[1] === 'budget') return '{"outcome":"proceed"}';
        started();
        await held;
        return receipt;
      } };
      const first = runSeatLoopOnce('TC', deps);
      await inCommand;
      const second = runSeatLoopOnce('TC', deps);
      release();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.status)).toEqual([expected, 'skipped-empty']);
      expect(calls.filter((args) => args[1] === command)).toHaveLength(1);
      expect(entries(f).filter((entry) => entry.status === expected)).toHaveLength(1);
    } finally { f.close(); }
  });
}

test('different processes contend on the same seat lock before reading the ledger', async () => {
  const f = fixture();
  const child = promisify(execFile);
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let started!: () => void;
    let release!: () => void;
    const inCommand = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      started();
      await held;
      return '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } });
    await inCommand;
    const signal = join(f.root, 'lock-contended');
    const external = join(f.root, 'external-called');
    const script = `import { writeFileSync } from 'node:fs';
      import { runSeatLoopOnce } from './src/seat-loop/seat-loop.ts';
      const result = await runSeatLoopOnce('TC', {
        root: process.argv[1], now: () => new Date('2026-10-02T23:20:00Z'),
        repo: process.argv[1], versions: () => ['0.2.9'], checklistItems: () => [], config: { mode: 'on', seats: ['TC'] },
        lockContended: () => writeFileSync(process.argv[2], 'contended'),
        run: async () => { writeFileSync(process.argv[3], 'called'); throw Error('duplicate external call'); },
      });
      console.log(result.status);`;
    const second = child('bun', ['-e', script, f.root, signal, external], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
    try {
      const deadline = Date.now() + 8_000;
      while (!existsSync(signal) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      expect(readFileSync(signal, 'utf8')).toBe('contended');
      expect(existsSync(external)).toBe(false);
      expect(f.deps.read!(seatLedgerPath('TC', f.root, now))).toContain('"status":"attempting"');
    } finally { release(); }
    const [parent, worker] = await Promise.all([first, second]);
    expect(parent.status).toBe('launched');
    expect(worker.stdout.trim()).toBe('skipped-empty');
    expect(existsSync(external)).toBe(false);
    expect(entries(f).filter((entry) => entry.status === 'launched')).toHaveLength(1);
  } finally { f.close(); }
});

test('a harness response without a runId cannot be recorded as launched', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => args[1] === 'budget'
      ? '{"outcome":"proceed"}' : '[{"status":"done"}]' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('no runId');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a harness response that cannot be parsed leaves an unknown outcome', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) =>
      args[1] === 'budget' ? '{"outcome":"proceed"}' : 'not-json' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow();
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a harness call that throws leaves a durable unknown outcome and cannot be retried', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    let launches = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      if (args[1] === 'budget') return '{"outcome":"proceed"}';
      launches++;
      throw Error('response lost after launch');
    } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('response lost after launch');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(launches).toBe(1);
  } finally { f.close(); }
});

test('a failed harness result carrying a runId is not recorded as launched', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => args[1] === 'budget'
      ? '{"outcome":"proceed"}' : '[{"status":"failed","runId":"run-12345678-1234-1234-1234-123456789abc"}]' };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('did not complete successfully');
    expect(entries(f).map((entry) => entry.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('a launch on a previous KST date remains handled on the next day', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    const yesterday = new Date('2026-10-02T10:00:00Z');
    const path = seatLedgerPath('TC', f.root, yesterday);
    const original = (await gatherSeatInputs('TC', f.deps)).checklist[0]!;
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: yesterday.toISOString(), status: 'launched', item: original, runId: 'run-12345678-1234-1234-1234-123456789abc' }) + '\n');
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => { calls++; throw Error('launched again'); } });
    expect(result.status).toBe('skipped-empty');
    expect(calls).toBe(0);
    const moved = (await gatherSeatInputs('TC', f.deps)).checklist[0]!;
    const legacy = { seat: 'TC', at: yesterday.toISOString(), status: 'launched' as const,
      item: { source: 'checklist' as const, version: '0.2.9', id: 'K2', title: '구현', text: '구현' } };
    expect(alreadyHandled({ ...moved, version: '0.2.12' }, [legacy])).toBe(false);
    expect(pickNext({ requests: [], checklist: [{ ...moved, version: '0.2.12' }], role: '' }, [legacy])?.id).toBe('K2');
  } finally { f.close(); }
});

test('a launched cell is skipped until its evidence or title changes in the same version', async () => {
  const f = fixture();
  try {
    const cell = { id: 'K2', owner: 'TC', title: '구현', evidence: 'initial', status: 'yellow' };
    checklist(f, '0.2.9', [cell]);
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) => {
      calls.push(args);
      return args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]';
    } };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    checklist(f, '0.2.9', [{ ...cell, evidence: 'revised' }]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    checklist(f, '0.2.9', [{ ...cell, title: '새 구현', evidence: 'revised' }]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('launched');
    expect(calls.filter((args) => args[1] === 'say')).toHaveLength(3);
  } finally { f.close(); }
});

test('an attempt without a launched receipt still prevents a changed cell from retrying', async () => {
  const f = fixture();
  try {
    const old = { id: 'K2', owner: 'TC', title: '구현', evidence: 'initial', status: 'yellow' };
    checklist(f, '0.2.9', [old]);
    const original = (await gatherSeatInputs('TC', f.deps)).checklist[0]!;
    const path = seatLedgerPath('TC', f.root, now);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'attempting', item: original }) + '\n');
    checklist(f, '0.2.9', [{ ...old, evidence: 'revised' }]);
    let calls = 0;
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] },
      run: async () => { calls++; throw Error('duplicate call'); } });
    expect(result.status).toBe('skipped-empty');
    expect(calls).toBe(0);
  } finally { f.close(); }
});

test('a legacy launch without an evidence hash cannot prove the same-title cell has unchanged evidence', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', evidence: 'new evidence', status: 'yellow' }]);
    const previous = new Date('2026-10-02T10:00:00Z');
    const path = seatLedgerPath('TC', f.root, previous);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: previous.toISOString(), status: 'launched',
      item: { source: 'checklist', version: '0.2.9', id: 'K2', title: '구현', text: '구현' } }) + '\n');
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['TC'] } };
    expect((await runSeatLoopOnce('TC', deps) as { item?: { id: string; evidenceHash?: string } }).item)
      .toMatchObject({ id: 'K2', evidenceHash: expect.any(String) });
  } finally { f.close(); }
});

test('a legacy launch without an evidence hash cannot hide a retitled cell in the same version', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: 'new title', status: 'yellow' }]);
    const previous = new Date('2026-10-02T10:00:00Z');
    const path = seatLedgerPath('TC', f.root, previous);
    mkdirSync(join(f.root, 'seat-loop', 'TC'), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: previous.toISOString(), status: 'launched',
      item: { source: 'checklist', version: '0.2.9', id: 'K2', title: 'old title', text: 'old title' } }) + '\n');
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['TC'] } };
    const inputs = await gatherSeatInputs('TC', deps);
    expect(alreadyHandled(inputs.checklist[0]!, [{ seat: 'TC', at: previous.toISOString(), status: 'launched',
      item: { source: 'checklist', version: '0.2.9', id: 'K2', title: 'old title', text: 'old title' } }])).toBe(false);
    expect((await runSeatLoopOnce('TC', deps) as { item?: { id: string; title: string } }).item)
      .toMatchObject({ id: 'K2', title: 'new title' });
  } finally { f.close(); }
});

test('off never reads inputs, launches or writes a ledger', async () => {
  const f = fixture();
  try {
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'off' }, run: async () => { throw Error('spawned'); }, read: () => { throw Error('read'); } });
    expect(result).toEqual({ seat: 'TC', status: 'skipped-off' });
  } finally { f.close(); }
});

test('V3 shadow day: each loop walks to the next item, planned door recorded, still no process', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }, { id: 'K3', owner: 'TC', title: '마켓에 게시', status: 'yellow' }]);
    let calls = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['TC'] }, run: async () => { calls++; return ''; } };
    for (let i = 0; i < 3; i++) await runSeatLoopOnce('TC', deps);
    expect(entries(f).map((e) => [e.status, e.item?.id, e.action])).toEqual([['shadow', 'K2', 'harness'], ['shadow', 'K3', 'decision'], ['skipped-empty', undefined, 'skipped-empty']]);
    expect(calls).toBe(0);
  } finally { f.close(); }
});

test('a shadowed unchanged cell remains handled after switching the seat on', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'shadow', seats: ['TC'] } });
    const on: SeatDeps = { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async (args) =>
      args[1] === 'budget' ? '{"outcome":"proceed"}' : '[{"status":"done","runId":"run-12345678-1234-1234-1234-123456789abc"}]' };
    expect((await runSeatLoopOnce('TC', on)).status).toBe('skipped-empty');
  } finally { f.close(); }
});

test('same-named items in different seats or releases launch distinct sentences', () => {
  const item = (version: string) => ({ source: 'checklist' as const, id: 'K2', title: '구현', text: '구현', version });
  expect(planAction(item('0.2.9'), 'TC').text).not.toBe(planAction(item('0.2.10'), 'TC').text);
  expect(planAction(item('0.2.9'), 'TC').text).not.toBe(planAction(item('0.2.9'), 'UX').text);
  expect(planAction({ source: 'request', id: 'r1', title: '정리', text: '정리' }, 'MK').text).toBe('[MK 자리 · 자리 요청 r1 · 역할 docs/roles/MK.md] 정리');
});

test('V3 ledger row shape (MK 18:54 · METHOD-v3-shadow-compare): ts · item.id · item.kind · item.createdAt · action · reason', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'seat-requests', 'requests.jsonl'),
      JSON.stringify({ key: 'req-1', seat: 'MK', text: '보도자료 초안', status: 'pending', queuedAt: '2026-10-02T09:00:00.000Z' }) + '\n');
    checklist(f, '0.2.10', [{ id: 'M1', owner: 'MK', title: '마켓에 게시', status: 'yellow' }]);
    const deps: SeatDeps = { ...f.deps, config: { mode: 'shadow', seats: ['MK'] } };
    for (let i = 0; i < 3; i++) await runSeatLoopOnce('MK', deps);
    const path = seatLedgerPath('MK', f.root, now);
    expect(path).toBe(join(f.root, 'seat-loop', 'MK', '2026-10-03.jsonl'));
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((v) => JSON.parse(v));
    expect(rows.map((r) => r.ts)).toEqual([now.toISOString(), now.toISOString(), now.toISOString()]);
    expect(rows[0]).toMatchObject({ action: 'harness', item: { id: 'req-1', kind: 'request', createdAt: '2026-10-02T09:00:00.000Z' } });
    expect(rows[0].reason).toBeUndefined();
    expect(rows[1]).toMatchObject({ action: 'decision', reason: '마켓에 게시', item: { id: 'M1', kind: 'cell' } });
    expect(rows[1].item.createdAt).toBeUndefined();
    expect(rows[2]).toMatchObject({ action: 'skipped-empty' });
  } finally { f.close(); }
});

test('budget skip records action skipped-budget', async () => {
  const f = fixture();
  try {
    checklist(f, '0.2.9', [{ id: 'K2', owner: 'TC', title: '구현', status: 'yellow' }]);
    await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'on', seats: ['TC'] }, run: async () => '{"outcome":"stop"}' });
    expect(entries(f)[0]).toMatchObject({ status: 'skipped-budget', action: 'skipped-budget' });
  } finally { f.close(); }
});

test('checklist items come from the injected ledger reader, not checklist.json (REL5b: the DB is the source)', async () => {
  const f = fixture();
  try {
    // A stale legacy file says TC owns K9; the ledger reader says TC owns K10 — only the ledger counts.
    const dir = join(f.root, 'release', '0.2.10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checklist.json'), JSON.stringify({ items: [{ id: 'K9', owner: 'TC', title: 'stale', status: 'yellow' }] }));
    const inputs = await gatherSeatInputs('TC', { ...f.deps, versions: () => ['0.2.10'], checklistItems: () => [{ id: 'K10', owner: 'TC', title: 'ledger', status: 'yellow' }] });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['K10']);
  } finally { f.close(); }
});

test('a neighbor resolution that is not delivered within the wait escalates to a CEO card (review round 3 ①)', async () => {
  const f = xcheckFixture('검토 근거');
  try {
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: 'OP가 해결 가능', resolves: true });
    expect((await runSeatLoopOnce('MK', f.deps)).status).toBe('awaiting-resolution');
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
    f.advance(121);
    const escalated = await runSeatLoopOnce('MK', f.deps);
    expect(escalated.status).toBe('hitl');
    const raise = f.calls.find((args) => args[0] === 'decisions')!;
    expect(raise[raise.indexOf('--xcheck') + 1]).toContain('OP:OP가 해결 가능');
    expect(raise[raise.indexOf('--xcheck') + 1]).toContain('120분 안 해소 안 됨');
  } finally { f.close(); }
});

test('a seat question left awaiting a neighbor resolution escalates to a CEO card after the wait (review round 3 ②)', async () => {
  const f = xcheckFixture('검토 근거');
  try {
    askSeat(f.root, 'UX', 'MK', '이 문구 써도 되나요?', 'ask:UX:test');
    const mk: SeatDeps = { ...f.deps, reply: async () => ({ to: 'CEO' as const, question: '이 문구를 승인할까요?' }) };
    expect((await runSeatLoopOnce('MK', mk)).status).toBe('awaiting-xcheck');
    answerCrossCheck(f.root, seatCrossChecks(f.root, 'OP')[0]!, { agree: true, note: 'OP 가이드 3절에 이미 있음', resolves: true });
    expect((await runSeatLoopOnce('MK', mk)).status).toBe('awaiting-resolution');
    expect(f.calls.filter((args) => args[0] === 'decisions')).toHaveLength(0);
    f.advance(121);
    expect((await runSeatLoopOnce('MK', mk)).status).toBe('hitl');
    const raise = f.calls.find((args) => args[0] === 'decisions')!;
    expect(raise[raise.indexOf('--xcheck') + 1]).toContain('120분 안 해소 안 됨');
  } finally { f.close(); }
});
