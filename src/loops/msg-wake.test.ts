import { afterEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { spawn } from 'node:child_process';
import { claimWake, resolveWake, wakeLine, wakeRecipient, WAKE_DEBOUNCE_MS, type WakeDeps } from './msg-wake.js';

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
