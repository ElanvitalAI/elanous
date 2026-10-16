import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { MsgStore } from '../msg/msg-store.js';
import { spawn } from 'node:child_process';
import { claimWake, MAX_REDELIVER_ATTEMPTS, PENDING_WAKE_TTL_MS, redeliverLine, redeliverPendingWakes, resolveWake, startPendingWakePoller, wakeLine, wakeRecipient, WAKE_DEBOUNCE_MS, type WakeDeps } from './msg-wake.js';

// Real Bun subprocesses can exceed Bun's 5 s default under gate-pod load.
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(over: Partial<WakeDeps> = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'msg-wake-'));
  dirs.push(stateRoot);
  const injected: Array<[string, string]> = [];
  const herdr: Array<[string, string]> = [];
  const warned: string[] = [];
  let now = 1_000_000;
  let turn: 'busy' | 'idle' | undefined = 'idle';
  let paneStatus = 'idle';
  const deps: WakeDeps = {
    stateRoot, seatStateRoot: join(stateRoot, 'seats'), live: true, now: () => now,
    listPtys: () => [{ id: 'tui:1', nickname: 'opt', alive: true, ...(turn ? { turnState: turn } : {}) }],
    readPane: path => path.endsWith(join('MK', 'herdr.pane')) ? 'wJ:p1' : null,
    // Focused tests opt every seat in; the human-pane guard has its own tests below.
    hasOptIn: () => true,
    ptyInjector: async () => async (id, line) => { injected.push([id, line]); },
    herdrStatus: async () => paneStatus,
    herdrInject: async (id, line) => { herdr.push([id, line]); },
    warn: line => warned.push(line),
    ...over,
  };
  return { deps, injected, herdr, warned,
    advance: (ms: number) => { now += ms; },
    setTurn: (value: typeof turn) => { turn = value; },
    setPane: (value: string) => { paneStatus = value; } };
}

test('resolves loop rows from the table, seats by exact pty name, then herdr pane, else unknown none', () => {
  const f = fixture();
  expect(resolveWake('COORDINATOR', f.deps)).toEqual({ wake: 'cron', source: 'loop-table' });
  expect(resolveWake('GUARDIAN', f.deps)).toEqual({ wake: 'none', source: 'loop-table' });
  expect(resolveWake('OPT', f.deps)).toEqual({ wake: 'pty-inject', target: 'tui:1', source: 'pty-name', optIn: true });
  // `op` is a substring of `opt` — never wake the neighbouring seat.
  expect(resolveWake('OP', f.deps)).toMatchObject({ wake: 'none', source: 'unresolved' });
  expect(resolveWake('MK', f.deps)).toEqual({ wake: 'herdr', target: 'wJ:p1', source: 'herdr.pane', optIn: true });
  // seat-inbox.sh's pty.ref wins over herdr when it names a live row exactly; a dead ref falls through.
  const withRef = fixture({ readPane: path => path.endsWith(join('TC', 'pty.ref')) ? 'TUI:1' : path.endsWith(join('UX', 'pty.ref')) ? 'tui:404' : null });
  expect(resolveWake('TC', withRef.deps)).toEqual({ wake: 'pty-inject', target: 'tui:1', source: 'pty.ref', optIn: true });
  expect(resolveWake('UX', withRef.deps)).toMatchObject({ wake: 'none', source: 'unresolved' });
  // An address outside the table is never resolved on the host, even with a same-named pty.
  const stray = fixture({ listPtys: () => [{ id: 'tui:9', nickname: 'wakeprobe', alive: true, turnState: 'idle' }] });
  expect(resolveWake('WAKEPROBE', stray.deps)).toEqual({ wake: 'none', source: 'unresolved', reason: 'undeclared-address' });
});

test('post wakes an idle pty once, logs msg.wake, and debounces the address for five minutes', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log');
  try {
    const first = await wakeRecipient('OPT', 7, { from: 'OP' }, f.deps);
    expect(first.result).toBe('injected');
    expect(f.injected).toEqual([['tui:1', wakeLine('OP', 'OPT', 7)]]);
    expect(f.injected[0]![1]).toBe('[우편 깨움] OP → OPT #7 — eln msg list --to OPT 로 읽고 처리');
    expect(log.mock.calls.filter(call => call[0] === 'msg.wake')).toEqual([
      ['msg.wake', 'pty-inject', { address: 'OPT', msgId: 7, wake: 'pty-inject', result: 'injected', reason: 'pty-name', target: 'tui:1' }],
    ]);
    expect((await wakeRecipient('OPT', 8, { from: 'OP' }, f.deps)).result).toBe('debounced');
    f.advance(WAKE_DEBOUNCE_MS);
    expect((await wakeRecipient('OPT', 9, { from: 'OP' }, f.deps)).result).toBe('injected');
    expect(f.injected).toHaveLength(2);
  } finally { log.mockRestore(); }
});

test('busy or unrecorded turn and non-idle herdr panes inject nothing', async () => {
  const f = fixture();
  f.setTurn('busy');
  expect(await wakeRecipient('OPT', 1, { from: 'OP' }, f.deps)).toMatchObject({ result: 'busy', reason: 'turn=busy' });
  f.setTurn(undefined);
  expect(await wakeRecipient('OPT', 2, { from: 'OP' }, f.deps)).toMatchObject({ result: 'busy', reason: 'turn=unknown' });
  f.setPane('working');
  expect(await wakeRecipient('MK', 3, { from: 'OP' }, f.deps)).toMatchObject({ wake: 'herdr', result: 'busy', reason: 'agent_status=working' });
  expect(f.injected).toEqual([]);
  expect(f.herdr).toEqual([]);
  f.setPane('idle');
  expect((await wakeRecipient('MK', 4, { from: 'OP' }, f.deps)).result).toBe('injected');
  expect(f.herdr).toEqual([['wJ:p1', wakeLine('OP', 'MK', 4)]]);
});

test('replies and self-addressed notes never wake; cron defers; the test universe never calls pty or herdr', async () => {
  const f = fixture();
  expect((await wakeRecipient('OPT', 1, { from: 'OP', kind: 'reply' }, f.deps)).result).toBe('skipped-reply');
  expect((await wakeRecipient('OPT', 2, { from: 'opt' }, f.deps)).result).toBe('skipped-self');
  expect((await wakeRecipient('COORDINATOR', 3, { from: 'OP' }, f.deps)).result).toBe('wake-deferred');
  const isolated = fixture({ live: false });
  expect((await wakeRecipient('OPT', 4, { from: 'OP' }, isolated.deps)).result).toBe('skipped-test-universe');
  expect([...f.injected, ...isolated.injected]).toEqual([]);
});

test('an unresolved seat is none plus «모름», a known none says so, and failures or hangs only return a result', async () => {
  const f = fixture();
  expect(await wakeRecipient('UX', 1, { from: 'OP' }, f.deps)).toMatchObject({ wake: 'none', source: 'unresolved', result: 'no-wake' });
  expect(f.warned.at(-1)).toContain('모름');
  expect((await wakeRecipient('GUARDIAN', 2, { from: 'OP' }, f.deps)).result).toBe('no-wake');
  expect(f.warned.at(-1)).not.toContain('모름');
  const failing = fixture({ ptyInjector: async () => async () => { throw new Error('denied'); } });
  expect(await wakeRecipient('OPT', 3, { from: 'OP' }, failing.deps)).toMatchObject({ result: 'failed', reason: 'denied' });
  const hanging = fixture({ timeoutMs: 20, ptyInjector: async () => () => new Promise(() => {}) });
  expect((await wakeRecipient('OPT', 4, { from: 'OP' }, hanging.deps)).result).toBe('timeout');
  // An injection that hung is «unknown» — the window is returned so the next post knocks again.
  const next = fixture({ stateRoot: hanging.deps.stateRoot });
  expect((await wakeRecipient('OPT', 5, { from: 'OP' }, next.deps)).result).toBe('injected');
  // A throwing reporter still yields an outcome, not an exception.
  expect((await wakeRecipient('UX', 6, { from: 'OP' }, fixture({ warn: () => { throw new Error('stderr closed'); } }).deps)).result).toBe('no-wake');
});

test('concurrent posts to one address inject once — the claim is atomic, not read-then-write', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2, 3, 4].map(id => wakeRecipient('OPT', id, { from: 'OP' }, f.deps)));
  expect(results.map(result => result.result).sort()).toEqual(['debounced', 'debounced', 'debounced', 'injected']);
  expect(f.injected).toHaveLength(1);
  // A second deps object (another process) sharing the state root sees the same claim.
  const other = fixture({ stateRoot: f.deps.stateRoot });
  expect((await wakeRecipient('OPT', 5, { from: 'OP' }, other.deps)).result).toBe('debounced');
});

test('a timeout stops a late injection and gives the window back even when the status query never settles', async () => {
  let release: (status: string) => void = () => {};
  const slow = fixture({ timeoutMs: 10, herdrStatus: () => new Promise(resolve => { release = resolve; }) });
  expect((await wakeRecipient('MK', 1, { from: 'OP' }, slow.deps)).result).toBe('timeout');
  const hung = fixture({ stateRoot: slow.deps.stateRoot, timeoutMs: 10, herdrStatus: () => new Promise(() => {}) });
  expect((await wakeRecipient('MK', 2, { from: 'OP' }, hung.deps)).result).toBe('timeout');
  // The window was returned at the timeout itself — the hung query is never awaited for it.
  const fast = fixture({ stateRoot: slow.deps.stateRoot });
  expect((await wakeRecipient('MK', 3, { from: 'OP' }, fast.deps)).result).toBe('injected');
  release('idle');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(slow.herdr).toEqual([]);
  fast.setTurn('busy');
  expect((await wakeRecipient('OPT', 4, { from: 'OP' }, fast.deps)).result).toBe('busy');
  fast.setTurn('idle');
  expect((await wakeRecipient('OPT', 5, { from: 'OP' }, fast.deps)).result).toBe('injected');
});

test('a turn that becomes busy while the pty module loads gets no injection', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({ ptyInjector: async () => { f.setTurn('busy'); return async (id, line) => { f.injected.push([id, line]); }; } });
  expect(await wakeRecipient('OPT', 1, { from: 'OP' }, f.deps)).toMatchObject({ result: 'busy', reason: 'turn=busy' });
  expect(f.injected).toEqual([]);
});

test('a seat name that moves to another pty while the module loads gets no injection', async () => {
  let rows = [{ id: 'tui:1', nickname: 'opt', alive: true, turnState: 'idle' as const }, { id: 'tui:2', nickname: 'old', alive: true, turnState: 'idle' as const }];
  const f = fixture({ listPtys: () => rows, ptyInjector: async () => {
    rows = [{ id: 'tui:1', nickname: 'old', alive: true, turnState: 'idle' }, { id: 'tui:2', nickname: 'opt', alive: true, turnState: 'idle' }];
    return async (id, line) => { f.injected.push([id, line]); };
  } });
  expect(await wakeRecipient('OPT', 1, { from: 'OP' }, f.deps)).toMatchObject({ result: 'busy', reason: 'target-moved:tui:2' });
  expect(f.injected).toEqual([]);
});

test('a herdr pane that changes during the status query gets no injection into the old pane', async () => {
  let pane = 'wJ:p1';
  const f = fixture({ readPane: path => path.endsWith(join('MK', 'herdr.pane')) ? pane : null,
    herdrStatus: async () => { pane = 'wJ:p9'; return 'idle'; } });
  expect(await wakeRecipient('MK', 1, { from: 'OP' }, f.deps)).toMatchObject({ result: 'busy', reason: 'target-moved:wJ:p9' });
  expect(f.herdr).toEqual([]);
  expect(resolveWake('ALL', f.deps)).toEqual({ wake: 'none', source: 'unresolved', reason: 'topic' });
});

test('a re-resolution that runs past the deadline starts no herdr injection', async () => {
  let reads = 0;
  const f = fixture({ timeoutMs: 30, readPane: path => {
    if (!path.endsWith(join('MK', 'herdr.pane'))) return null;
    if (++reads === 2) { const end = Date.now() + 60; while (Date.now() < end) { /* a slow seat folder */ } }
    return 'wJ:p1';
  } });
  expect((await wakeRecipient('MK', 1, { from: 'OP' }, f.deps)).result).toBe('timeout');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.herdr).toEqual([]);
});

test('a slow pty module load past the deadline starts no injection and returns the window', async () => {
  const injected: string[] = [];
  const slow = fixture({ timeoutMs: 10, ptyInjector: async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return async (_id, line) => { injected.push(line); };
  } });
  expect((await wakeRecipient('OPT', 1, { from: 'OP' }, slow.deps)).result).toBe('timeout');
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(injected).toEqual([]);
  const fast = fixture({ stateRoot: slow.deps.stateRoot });
  expect((await wakeRecipient('OPT', 2, { from: 'OP' }, fast.deps)).result).toBe('injected');
});

test('separate processes racing for an expired claim produce exactly one winner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msg-wake-race-'));
  dirs.push(dir);
  const db = join(dir, 'wake-claims.db');
  const start = 10_000_000;
  expect(claimWake(db, 'OPT', start)).not.toBeNull();
  const later = start + WAKE_DEBOUNCE_MS + 1;
  const script = `import { claimWake } from ${JSON.stringify(join(import.meta.dir, 'msg-wake.ts'))};
    console.log(claimWake(${JSON.stringify(db)}, 'OPT', ${later}) ? 'won' : 'lost');`;
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim()));
  })));
  expect(outputs.sort()).toEqual(['lost', 'lost', 'lost', 'lost', 'lost', 'won']);
});

test('a human pane without the wake-inject opt-in gets no injection, only msg.wake skipped{reason}', async () => {
  const log = spyOn(debug, 'log');
  try {
    for (const address of ['OPT', 'MK'] as const) {
      const f = fixture({ hasOptIn: () => false });
      const outcome = await wakeRecipient(address, 1, { from: 'UX' }, f.deps);
      expect(outcome).toMatchObject({ result: 'skipped', reason: 'human-pane-no-opt-in', optIn: false });
      expect([...f.injected, ...f.herdr]).toEqual([]);
    }
    const skipped = log.mock.calls.filter(call => call[0] === 'msg.wake' && call[1] === 'skipped');
    expect(skipped.map(call => call[2])).toEqual([
      { address: 'OPT', msgId: 1, wake: 'pty-inject', result: 'skipped', reason: 'human-pane-no-opt-in', target: 'tui:1' },
      { address: 'MK', msgId: 1, wake: 'herdr', result: 'skipped', reason: 'human-pane-no-opt-in', target: 'wJ:p1' },
    ]);
  } finally { log.mockRestore(); }
});

test('the opt-in is the seat-folder wake-inject file: present injects once, absent never', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'MK'), { recursive: true });
  writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p1\n');
  const off = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined });
  expect((await wakeRecipient('MK', 1, { from: 'UX' }, off.deps)).result).toBe('skipped');
  expect(off.herdr).toEqual([]);
  writeFileSync(join(seats, 'MK', 'wake-inject'), '');
  const on = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined });
  expect(await wakeRecipient('MK', 2, { from: 'UX' }, on.deps)).toMatchObject({ result: 'injected', optIn: true });
  expect(on.herdr).toEqual([['wJ:p1', wakeLine('UX', 'MK', 2)]]);
});

test('a real wake-inject file deleted while waiting means no injection and a skipped log, even if the target moved', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-del-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'MK'), { recursive: true });
  writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p1\n');
  writeFileSync(join(seats, 'MK', 'wake-inject'), '');
  const log = spyOn(debug, 'log');
  try {
    const f = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined, herdrStatus: async () => {
      rmSync(join(seats, 'MK', 'wake-inject'));
      writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p9\n');
      return 'idle';
    } });
    expect(await wakeRecipient('MK', 1, { from: 'UX' }, f.deps)).toMatchObject({ result: 'skipped', reason: 'human-pane-no-opt-in', optIn: false });
    expect(f.herdr).toEqual([]);
    expect(log.mock.calls.filter(call => call[0] === 'msg.wake' && call[1] === 'skipped').map(call => call[2]))
      .toEqual([{ address: 'MK', msgId: 1, wake: 'herdr', result: 'skipped', reason: 'human-pane-no-opt-in', target: 'wJ:p1' }]);
  } finally { log.mockRestore(); }
  // The pty path re-checks the same way after its module load.
  mkdirSync(join(seats, 'OPT'), { recursive: true });
  writeFileSync(join(seats, 'OPT', 'wake-inject'), '');
  let pty: ReturnType<typeof fixture>;
  pty = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined, ptyInjector: async () => {
    rmSync(join(seats, 'OPT', 'wake-inject'));
    return async (id, line) => { pty.injected.push([id, line]); };
  } });
  expect(await wakeRecipient('OPT', 2, { from: 'UX' }, pty.deps)).toMatchObject({ result: 'skipped', optIn: false });
  expect(pty.injected).toEqual([]);
});

test('a directory named wake-inject is not an opt-in', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-dir-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'MK', 'wake-inject'), { recursive: true });
  writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p1\n');
  const f = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined });
  expect(await wakeRecipient('MK', 1, { from: 'UX' }, f.deps)).toMatchObject({ result: 'skipped', optIn: false });
  expect(f.herdr).toEqual([]);
});

test('pty targets follow the same wake-inject file: named pty and pty.ref inject only with it', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-pty-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'OPT'), { recursive: true });
  mkdirSync(join(seats, 'TC'), { recursive: true });
  writeFileSync(join(seats, 'TC', 'pty.ref'), 'tui:1\n');
  for (const address of ['OPT', 'TC'] as const) {
    const off = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined,
      listPtys: () => [{ id: 'tui:1', nickname: address === 'OPT' ? 'opt' : 'other', alive: true, turnState: 'idle' }] });
    expect((await wakeRecipient(address, 1, { from: 'UX' }, off.deps)).result).toBe('skipped');
    expect(off.injected).toEqual([]);
    writeFileSync(join(seats, address, 'wake-inject'), '');
    const on = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined,
      listPtys: () => [{ id: 'tui:1', nickname: address === 'OPT' ? 'opt' : 'other', alive: true, turnState: 'idle' }] });
    expect(await wakeRecipient(address, 2, { from: 'UX' }, on.deps)).toMatchObject({ result: 'injected', source: address === 'OPT' ? 'pty-name' : 'pty.ref' });
    expect(on.injected).toHaveLength(1);
  }
});

test('the default (no wake-inject anywhere) calls no pty text or herdr input at all', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-default-'));
  dirs.push(seats);
  for (const seat of ['OP', 'TC', 'MK', 'UX', 'OPC', 'OPT']) {
    mkdirSync(join(seats, seat), { recursive: true });
    writeFileSync(join(seats, seat, 'herdr.pane'), `w:${seat}\n`);
  }
  writeFileSync(join(seats, 'TC', 'pty.ref'), 'tui:1\n');
  let ptyCalls = 0;
  let herdrCalls = 0;
  const f = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined,
    listPtys: () => [{ id: 'tui:1', nickname: 'opt', alive: true, turnState: 'idle' }],
    ptyInjector: async () => async () => { ptyCalls++; },
    herdrStatus: async () => 'idle', herdrInject: async () => { herdrCalls++; } });
  for (const [index, seat] of ['OP', 'TC', 'MK', 'UX', 'OPC', 'OPT'].entries()) {
    expect((await wakeRecipient(seat, index + 1, { from: 'GUARDIAN' }, f.deps)).result).toBe('skipped');
  }
  expect({ ptyCalls, herdrCalls }).toEqual({ ptyCalls: 0, herdrCalls: 0 });
});

test('opt-in and target removed together while waiting still reads as skipped, not a moved target', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-both-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'MK'), { recursive: true });
  writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p1\n');
  writeFileSync(join(seats, 'MK', 'wake-inject'), '');
  const log = spyOn(debug, 'log');
  try {
    const f = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined, herdrStatus: async () => {
      rmSync(join(seats, 'MK', 'wake-inject'));
      rmSync(join(seats, 'MK', 'herdr.pane'));
      return 'idle';
    } });
    expect(await wakeRecipient('MK', 1, { from: 'UX' }, f.deps)).toMatchObject({ result: 'skipped', reason: 'human-pane-no-opt-in', optIn: false });
    expect(f.herdr).toEqual([]);
    mkdirSync(join(seats, 'OPT'), { recursive: true });
    writeFileSync(join(seats, 'OPT', 'wake-inject'), '');
    let pty: ReturnType<typeof fixture>;
    pty = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined, ptyInjector: async () => {
      rmSync(join(seats, 'OPT', 'wake-inject'));
      return async (id, line) => { pty.injected.push([id, line]); };
    } });
    expect((await wakeRecipient('OPT', 2, { from: 'UX' }, pty.deps)).result).toBe('skipped');
    expect(pty.injected).toEqual([]);
    expect(log.mock.calls.filter(call => call[0] === 'msg.wake' && call[1] === 'skipped').map(call => (call[2] as { address: string; reason: string })))
      .toEqual([expect.objectContaining({ address: 'MK', reason: 'human-pane-no-opt-in' }), expect.objectContaining({ address: 'OPT', reason: 'human-pane-no-opt-in' })]);
  } finally { log.mockRestore(); }
});

test('a symlink named wake-inject is not an opt-in, even when it points at a regular file', async () => {
  const seats = mkdtempSync(join(tmpdir(), 'msg-wake-seats-link-'));
  dirs.push(seats);
  mkdirSync(join(seats, 'MK'), { recursive: true });
  writeFileSync(join(seats, 'MK', 'herdr.pane'), 'wJ:p1\n');
  writeFileSync(join(seats, 'real-file'), '');
  symlinkSync(join(seats, 'real-file'), join(seats, 'MK', 'wake-inject'));
  const f = fixture({ seatStateRoot: seats, readPane: undefined, hasOptIn: undefined });
  expect(await wakeRecipient('MK', 1, { from: 'UX' }, f.deps)).toMatchObject({ result: 'skipped', reason: 'human-pane-no-opt-in', optIn: false });
  expect(f.herdr).toEqual([]);
});

// ── 미룬 깨움(TUI-H4) — 버리지 않고 미뤘다가 idle 뒤 한 번 ─────────────────────

const pendingEvents = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.filter(call => call[0] === 'loops.msg-wake').map(call => [call[1], (call[2] as { seat: string; count: number }).seat, (call[2] as { count: number }).count]);

test('a wake that meets a busy TUI is deferred, then redelivered exactly once after the turn is recorded idle', async () => {
  const f = fixture();
  const log = spyOn(debug, 'log');
  try {
    f.setTurn('busy');
    expect((await wakeRecipient('OPT', 11, { from: 'OP' }, f.deps)).result).toBe('busy');
    expect(pendingEvents(log)).toEqual([['deferred', 'OPT', 1]]);
    // 아직 턴 중 — 그대로 미룸(주입 0 · 로그 0).
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'waiting', count: 1, reason: 'turn=busy' }]);
    expect(f.injected).toEqual([]);
    f.setTurn('idle');
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 1 }]);
    expect(f.injected).toEqual([['tui:1', '[우편 깨움 · 미룬 1통] OP → OPT #11 — eln msg list --to OPT 로 읽고 처리']]);
    expect(pendingEvents(log)).toEqual([['deferred', 'OPT', 1], ['redelivered', 'OPT', 1]]);
    // 한 번만 — 다음 틱은 할 일이 없다.
    f.advance(WAKE_DEBOUNCE_MS);
    expect(await redeliverPendingWakes(f.deps)).toEqual([]);
    expect(f.injected).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test('several posts inside the debounce window fold into one redelivery that waits for the window too', async () => {
  const f = fixture();
  expect((await wakeRecipient('OPT', 20, { from: 'OP' }, f.deps)).result).toBe('injected');
  expect((await wakeRecipient('OPT', 21, { from: 'OP' }, f.deps)).result).toBe('debounced');
  expect((await wakeRecipient('OPT', 22, { from: 'MK' }, f.deps)).result).toBe('debounced');
  // idle 이어도 5분 창 안이면 버림이 아니라 미룸.
  expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'waiting', count: 2, reason: 'debounced' }]);
  expect(f.injected).toHaveLength(1);
  f.advance(WAKE_DEBOUNCE_MS);
  expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 2 }]);
  expect(f.injected.at(-1)).toEqual(['tui:1', '[우편 깨움 · 미룬 2통] MK → OPT #21..#22 — eln msg list --to OPT 로 읽고 처리']);
  f.advance(WAKE_DEBOUNCE_MS);
  expect(await redeliverPendingWakes(f.deps)).toEqual([]);
  expect(f.injected).toHaveLength(2);
});

test('a fresh injected wake absorbs what was pending; the poller only re-knocks its own pty', async () => {
  const f = fixture();
  f.setTurn('busy');
  await wakeRecipient('OPT', 30, { from: 'OP' }, f.deps);
  expect(await redeliverPendingWakes(f.deps, { target: 'tui:other' })).toEqual([]);
  f.setTurn('idle');
  expect((await wakeRecipient('OPT', 31, { from: 'OP' }, f.deps)).result).toBe('injected');
  f.advance(WAKE_DEBOUNCE_MS);
  expect(await redeliverPendingWakes(f.deps)).toEqual([]);
  expect(f.injected).toEqual([['tui:1', wakeLine('OP', 'OPT', 31)]]);
});

test('failed re-knocks count toward the cap and then give up; a stale deferral gives up by TTL', async () => {
  let fail = true;
  const f = fixture({ ptyInjector: async () => async () => { if (fail) throw new Error('denied'); } });
  const log = spyOn(debug, 'log');
  try {
    f.setTurn('busy');
    await wakeRecipient('OPT', 40, { from: 'OP' }, f.deps);
    f.setTurn('idle');
    for (let i = 1; i < MAX_REDELIVER_ATTEMPTS; i++) {
      expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'failed', count: 1, reason: 'denied' }]);
    }
    // 상한째 실패는 «그 틱에» gave-up 으로 닫힌다.
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'gave-up', count: 1, reason: `attempts>=${MAX_REDELIVER_ATTEMPTS}:denied` }]);
    expect(pendingEvents(log).at(-1)).toEqual(['gave-up', 'OPT', 1]);
    expect(await redeliverPendingWakes(f.deps)).toEqual([]);
    fail = false;
    f.setTurn('busy');
    await wakeRecipient('OPT', 41, { from: 'OP' }, f.deps);
    f.advance(PENDING_WAKE_TTL_MS + 1);
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'gave-up', count: 1, reason: 'ttl' }]);
    // 폴러가 없어도(TUI 가 안 돌아옴) 다음 post 가 낡은 줄을 거둔다.
    await wakeRecipient('OPT', 42, { from: 'OP' }, f.deps);
    f.advance(PENDING_WAKE_TTL_MS + 1);
    const before = pendingEvents(log).length;
    await wakeRecipient('COORDINATOR', 43, { from: 'OP' }, f.deps);
    expect(pendingEvents(log).slice(before)).toEqual([['gave-up', 'OPT', 1]]);
    expect(await redeliverPendingWakes(f.deps)).toEqual([]);
  } finally { log.mockRestore(); }
});

test('the test universe never records or redelivers deferrals; the poller re-knocks on its tick', async () => {
  const isolated = fixture({ live: false });
  isolated.setTurn('busy');
  await wakeRecipient('OPT', 50, { from: 'OP' }, isolated.deps);
  expect(await redeliverPendingWakes({ ...isolated.deps, live: true })).toEqual([]);
  const f = fixture();
  f.setTurn('busy');
  await wakeRecipient('OPT', 51, { from: 'OP' }, f.deps);
  f.setTurn('idle');
  const stop = startPendingWakePoller('tui:1', f.deps, 5);
  try {
    for (let i = 0; i < 100 && f.injected.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  } finally { stop(); }
  expect(f.injected).toEqual([['tui:1', redeliverLine({ address: 'OPT', last_from: 'OP', first_msg_id: 51, last_msg_id: 51, count: 1 })]]);
});

test('a slow fresh wake only absorbs what was stored before it — a later deferral survives and is redelivered', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const injected: string[] = [];
  const f = fixture({ ptyInjector: async () => async (_id, line) => { injected.push(line); if (injected.length === 1) await gate; } });
  // B(#60) 주입이 끝나기 전에 A(#61) 가 창에 막혀 미뤄진다 — B 의 늦은 정리가 A 를 지우면 안 된다.
  const slow = wakeRecipient('OPT', 60, { from: 'OP' }, { ...f.deps, timeoutMs: 5_000 });
  for (let i = 0; i < 100 && injected.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await wakeRecipient('OPT', 61, { from: 'MK' }, f.deps)).result).toBe('debounced');
  release();
  expect((await slow).result).toBe('injected');
  f.advance(WAKE_DEBOUNCE_MS);
  expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 1 }]);
  expect(injected.at(-1)).toBe('[우편 깨움 · 미룬 1통] MK → OPT #61 — eln msg list --to OPT 로 읽고 처리');
});

test('concurrent deferrals that land in reverse id order still show the id range and the newest sender', async () => {
  const f = fixture();
  f.setTurn('busy');
  await wakeRecipient('OPT', 72, { from: 'MK' }, f.deps);
  await wakeRecipient('OPT', 71, { from: 'OP' }, f.deps);
  f.setTurn('idle');
  expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 2 }]);
  expect(f.injected).toEqual([['tui:1', '[우편 깨움 · 미룬 2통] MK → OPT #71..#72 — eln msg list --to OPT 로 읽고 처리']]);
});

test('a new letter merged during the capped failing re-knock is not given up — it gets fresh attempts', async () => {
  let fail = true;
  let merge = false;
  const injected: string[] = [];
  const holder: { f?: ReturnType<typeof fixture> } = {};
  const f = fixture({ ptyInjector: async () => async (_id, line) => {
    if (merge) { merge = false; holder.f!.setTurn('busy'); await wakeRecipient('OPT', 81, { from: 'MK' }, holder.f!.deps); holder.f!.setTurn('idle'); }
    if (fail) throw new Error('denied');
    injected.push(line);
  } });
  holder.f = f;
  const log = spyOn(debug, 'log');
  try {
    f.setTurn('busy');
    await wakeRecipient('OPT', 80, { from: 'OP' }, f.deps);
    f.setTurn('idle');
    for (let i = 1; i < MAX_REDELIVER_ATTEMPTS; i++) await redeliverPendingWakes(f.deps);
    merge = true;
    // 상한째 실패 — 그러나 그 사이 #81 이 합쳐져 묶음이 바뀌었다: gave-up 기록 0 · 줄은 남는다.
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'waiting', count: 1, reason: 'batch-changed' }]);
    expect(pendingEvents(log).filter(event => event[0] === 'gave-up')).toEqual([]);
    fail = false;
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 2 }]);
    expect(injected).toEqual(['[우편 깨움 · 미룬 2통] MK → OPT #80..#81 — eln msg list --to OPT 로 읽고 처리']);
  } finally { log.mockRestore(); }
});

// ── H4-FOLLOW ③ — 재두드림 전에 미읽음을 잰다(10-16 OPT 가 이미 ack 한 #9250 재두드림) ──

test('a deferred wake whose letters were already read (unread 0) is dropped, not re-knocked — dropped-read', async () => {
  let unread: number | null = 0;
  const f = fixture({ readUnread: () => unread });
  const log = spyOn(debug, 'log');
  try {
    f.setTurn('busy');
    await wakeRecipient('OPT', 90, { from: 'OP' }, f.deps);
    f.setTurn('idle');
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'dropped-read', count: 1 }]);
    expect(f.injected).toEqual([]);
    expect(pendingEvents(log)).toEqual([['deferred', 'OPT', 1], ['dropped-read', 'OPT', 1]]);
    // 줄이 지워졌다 — 다음 틱은 할 일이 없다.
    expect(await redeliverPendingWakes(f.deps)).toEqual([]);
    // 반증: 미읽음 > 0 이면 그대로 재두드림 · «모름»(null)도 지우지 않는다.
    for (const value of [2, null]) {
      unread = value;
      f.setTurn('busy');
      await wakeRecipient('OPT', 91, { from: 'OP' }, f.deps);
      f.setTurn('idle');
      f.advance(WAKE_DEBOUNCE_MS);
      expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'redelivered', count: 1 }]);
    }
    expect(f.injected).toHaveLength(2);
  } finally { log.mockRestore(); }
});

test('without an injected reader the re-knock reads the real msg ledger beside the claims db', async () => {
  const f = fixture();
  mkdirSync(join(f.deps.stateRoot!, 'msg'), { recursive: true });
  const store = new MsgStore(join(f.deps.stateRoot!, 'msg', 'messages.db'));
  try {
    const posted = store.post({ from: 'OP', to: 'OPT', body: 'hello' });
    f.setTurn('busy');
    await wakeRecipient('OPT', posted.id, { from: 'OP' }, f.deps);
    store.ack('OPT', posted.id);
    f.setTurn('idle');
    expect(await redeliverPendingWakes(f.deps)).toEqual([{ seat: 'OPT', result: 'dropped-read', count: 1 }]);
    expect(f.injected).toEqual([]);
  } finally { store.close(); }
});
