import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { askSeat } from '../seat-dispatch/seat-questions.js';
import { openMsgStore } from '../msg/msg-store.js';
import { gatherSeatInputs, pickNext, runSeatLoopOnce, type SeatDeps } from './seat-loop.js';
import { readHandedCells, readTrafficSignal } from './traffic-signal.js';

const at = new Date('2026-10-10T00:00:00Z');
const cell = (id: string, owner = 'TC', status = 'yellow') => ({ id, title: id, owner, status });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-signal-'));
  const cells: Record<string, ReturnType<typeof cell>[]> = {
    '0.2.23': [cell('GATE-LIVE-OBS-RC-WORDING'), cell('BRAIN-FAST'), cell('LOG-BUSY-LOST')],
    '0.2.24': [cell('NEXT')],
  };
  const read = (path: string) => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  const deps: SeatDeps = { root, repo: root, read, now: () => at, config: { mode: 'shadow', seats: ['TC'] },
    versions: () => ['0.2.24', '0.2.23'],
    schedules: () => ['0.2.23', '0.2.24'].map((version) => ({ version, cutAt: '2099-01-01T00:00:00Z' })),
    checklistItems: (version) => cells[version] ?? [],
    handedCells: new Set(),
  };
  return { root, cells, deps, close: () => rmSync(root, { recursive: true, force: true }) };
};

// os.homedir() caches HOME on Bun; a child process gets a fresh home for the default-path probe.
test('traffic and handed readers prefer explicit path, then environment, then home; missing differs from invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-signal-path-'));
  const probeDefault = () => JSON.parse(execFileSync('bun', ['-e', `import {readTrafficSignal, readHandedCells} from './src/seat-loop/traffic-signal.ts'; console.log(JSON.stringify({signal:readTrafficSignal(),handed:[...readHandedCells()]}))`],
    { cwd: join(import.meta.dir, '../..'), env: { ...process.env, HOME: root, ELANOUS_TRAFFIC_SIGNAL: undefined, ELANOUS_HANDED_CELLS: undefined }, encoding: 'utf8' }));
  try {
    const base = join(root, 'elanous-hq', 'seat-state', 'OP');
    expect(probeDefault()).toEqual({ signal: null, handed: [] });
    mkdirSync(join(base, 'feeder'), { recursive: true });
    const signal = join(base, 'traffic.json');
    const handed = join(base, 'feeder', 'handed.txt');
    writeFileSync(signal, JSON.stringify({ global: 'green', versions: ['0.2.23'], hold: ['H'], paused: { TC: true } }));
    writeFileSync(handed, 'H\nH\r\n  BRAIN-FAST \n\n');
    expect(probeDefault()).toEqual({ signal: { global: 'green', versions: ['0.2.23'], hold: ['H'], paused: { TC: true } }, handed: ['H', 'BRAIN-FAST'] });
    const envSignal = join(root, 'env-signal.json');
    const envHanded = join(root, 'env-handed.txt');
    writeFileSync(envSignal, '{"global":"yellow"}');
    writeFileSync(envHanded, 'ENV\n');
    const envResult = JSON.parse(execFileSync('bun', ['-e', `import {readTrafficSignal, readHandedCells} from './src/seat-loop/traffic-signal.ts'; console.log(JSON.stringify({signal:readTrafficSignal(),handed:[...readHandedCells()]}))`],
      { cwd: join(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_TRAFFIC_SIGNAL: envSignal, ELANOUS_HANDED_CELLS: envHanded }, encoding: 'utf8' }));
    expect(envResult).toEqual({ signal: { global: 'yellow' }, handed: ['ENV'] });
    expect(readTrafficSignal(signal)).toEqual({ global: 'green', versions: ['0.2.23'], hold: ['H'], paused: { TC: true } });
    expect([...readHandedCells(handed)]).toEqual(['H', 'BRAIN-FAST']);
    expect(readTrafficSignal(join(root, 'absent'))).toBeNull();
    expect([...readHandedCells(join(root, 'absent'))]).toEqual([]);
    writeFileSync(envSignal, 'invalid JSON');
    expect(readTrafficSignal(envSignal)).toEqual({ unreadable: true });
    writeFileSync(envSignal, '{"global":"green","hold":"not an array"}');
    expect(readTrafficSignal(envSignal)).toEqual({ unreadable: true });
    expect(readTrafficSignal(root)).toEqual({ unreadable: true });
    expect(() => readHandedCells(root)).toThrow();
    expect(readFileSync(signal, 'utf8')).toContain('"global":"green"');
    expect(readFileSync(handed, 'utf8')).toBe('H\nH\r\n  BRAIN-FAST \n\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('injected green signal selects only the in-version cell not held or handed; observes each skip', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const deps: SeatDeps = { ...f.deps,
      trafficSignal: { global: 'green', versions: ['0.2.23'], hold: ['GATE-LIVE-OBS-RC-WORDING'] },
      handedCells: new Set(['BRAIN-FAST']) };
    const inputs = await gatherSeatInputs('TC', deps);
    expect(inputs.checklist.map((item) => item.id)).toEqual(['LOG-BUSY-LOST']);
    expect(pickNext(inputs, [])?.id).toBe('LOG-BUSY-LOST');
    expect((await runSeatLoopOnce('TC', deps))).toMatchObject({ status: 'shadow', item: { id: 'LOG-BUSY-LOST' } });
    for (const [event, data] of [
      ['skip-signal-version', { version: '0.2.24' }],
      ['skip-signal-cell', { id: 'GATE-LIVE-OBS-RC-WORDING', why: 'hold' }],
      ['skip-signal-cell', { id: 'BRAIN-FAST', why: 'handed' }],
    ] as const) expect(spy.mock.calls).toContainEqual(['seat.loop', event, data]);
  } finally { spy.mockRestore(); f.close(); }
});

test('unreadable, non-green and paused each stop checklist and record their own reason', async () => {
  const f = fixture();
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    for (const [signal, event] of [
      [{ unreadable: true }, 'signal-unreadable'],
      [{ global: 'yellow' }, 'signal-not-green'],
      [{ global: 'green', paused: { TC: true } }, 'signal-seat-paused'],
    ] as const) {
      const inputs = await gatherSeatInputs('TC', { ...f.deps, trafficSignal: signal });
      expect(inputs.checklist).toEqual([]);
      expect(spy.mock.calls).toContainEqual(['seat.loop', event, { seat: 'TC' }]);
    }
  } finally { spy.mockRestore(); f.close(); }
});

test('missing signal preserves the old yellow/red owner-and-open-version selection', async () => {
  const f = fixture();
  try {
    f.cells['0.2.24']!.push(cell('RED', 'TC', 'red'), cell('GREEN', 'TC', 'green'), cell('OTHER', 'UX'));
    const inputs = await gatherSeatInputs('TC', { ...f.deps, trafficSignal: null, handedCells: new Set(['BRAIN-FAST']) });
    expect(inputs.checklist.map((item) => item.id)).toEqual(['BRAIN-FAST', 'GATE-LIVE-OBS-RC-WORDING', 'LOG-BUSY-LOST', 'NEXT', 'RED']);
  } finally { f.close(); }
});

test('signal restrictions do not remove hook cards or incoming seat questions', async () => {
  const f = fixture();
  try {
    const question = askSeat(f.root, 'UX', 'TC', '근거가 있나요?');
    const store = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { store.append({ from: 'UX', to: 'TC', body: 'hook work', kind: 'hook-task' }); }
    finally { store.close(); }
    const inputs = await gatherSeatInputs('TC', { ...f.deps, trafficSignal: { unreadable: true } });
    expect(inputs.checklist).toEqual([]);
    expect(inputs.requests.map((item) => item.source)).toEqual(['seat-question', 'hook']);
    expect(inputs.requests[0]?.id).toBe(String(question.id));
    expect(inputs.requests[1]?.title).toBe('hook work');
    expect(await runSeatLoopOnce('TC', { ...f.deps, trafficSignal: { unreadable: true }, reply: () => ({ answer: '확인' }) }))
      .toMatchObject({ status: 'shadow', item: { source: 'seat-question', id: String(question.id) }, action: 'seat-answer' });
    const hookOnly = await gatherSeatInputs('TC', { ...f.deps, trafficSignal: { unreadable: true } }, [
      { seat: 'TC', at: at.toISOString(), status: 'answered', action: 'seat-answer', item: inputs.requests[0] },
    ]);
    expect(pickNext(hookOnly, [])?.source).toBe('hook');
  } finally { f.close(); }
});

test('default readers are wired into checklist selection with isolated env files', async () => {
  const f = fixture();
  const signalPath = join(f.root, 'traffic.json');
  const handedPath = join(f.root, 'handed.txt');
  const previousSignal = process.env.ELANOUS_TRAFFIC_SIGNAL;
  const previousHanded = process.env.ELANOUS_HANDED_CELLS;
  try {
    process.env.ELANOUS_TRAFFIC_SIGNAL = signalPath;
    process.env.ELANOUS_HANDED_CELLS = handedPath;
    writeFileSync(signalPath, '{"global":"green","versions":["0.2.23"],"hold":["GATE-LIVE-OBS-RC-WORDING"]}');
    writeFileSync(handedPath, 'BRAIN-FAST\n');
    const deps = { ...f.deps, handedCells: undefined };
    expect((await gatherSeatInputs('TC', deps)).checklist.map((item) => item.id)).toEqual(['LOG-BUSY-LOST']);
    writeFileSync(signalPath, 'bad json');
    expect((await gatherSeatInputs('TC', deps)).checklist).toEqual([]);
  } finally {
    if (previousSignal === undefined) delete process.env.ELANOUS_TRAFFIC_SIGNAL;
    else process.env.ELANOUS_TRAFFIC_SIGNAL = previousSignal;
    if (previousHanded === undefined) delete process.env.ELANOUS_HANDED_CELLS;
    else process.env.ELANOUS_HANDED_CELLS = previousHanded;
    f.close();
  }
});

test('an unreadable handed ledger does not mask a non-green signal, and fails closed only when the signal is green', async () => {
  const f = fixture();
  const previousHanded = process.env.ELANOUS_HANDED_CELLS;
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    process.env.ELANOUS_HANDED_CELLS = f.root; // a directory: readHandedCells throws (not ENOENT)
    const deps = { ...f.deps, handedCells: undefined };
    expect((await gatherSeatInputs('TC', { ...deps, trafficSignal: { global: 'yellow' } })).checklist).toEqual([]);
    expect(spy.mock.calls).toContainEqual(['seat.loop', 'signal-not-green', { seat: 'TC' }]);
    expect(spy.mock.calls.some((call) => call[1] === 'signal-unreadable')).toBe(false);
    expect((await gatherSeatInputs('TC', { ...deps, trafficSignal: { global: 'green' } })).checklist).toEqual([]);
    expect(spy.mock.calls).toContainEqual(['seat.loop', 'signal-unreadable', { seat: 'TC', source: 'handed' }]);
  } finally {
    if (previousHanded === undefined) delete process.env.ELANOUS_HANDED_CELLS;
    else process.env.ELANOUS_HANDED_CELLS = previousHanded;
    spy.mockRestore(); f.close();
  }
});
