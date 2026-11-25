import { expect, test } from 'bun:test';
import { runSeatControl, SEAT_STOP_OWNER_WINDOW_MS } from '../cli/seat-control-cli.js';
import { updateAllElsTabs, updatePreview, updateSummary, updateInstallProgress, updateResultsTable, type UpdateAllDeps, type UpdateSeatRow } from './update-all.js';

const desired = 'a'.repeat(40);
const pane = (seat: string, address = `node-b:w/t/${seat}`) => ({ address, host: 'node-b', reach: 'local', seat, state: 'working', cwd: `/seats/${seat}`, pid: 10, kind: 'pty' });

test('preview counts distinct older seats per host and marks unknown hosts', () => {
  const listing = { hosts: [{ name: 'mshq', reach: 'local' }, { name: 'node-b', reach: 'up' }, { name: 'minim5', reach: 'down' }], panes: [
    { ...pane('TC', 'mshq:w/t/a'), host: 'mshq', build: { age: 'older', desired } },
    { ...pane('TC', 'mshq:w/t/b'), host: 'mshq', build: { age: 'older', desired } },
    { ...pane('TC', 'node-b:w/t/c'), host: 'node-b', reach: 'up', build: { age: 'older', desired } },
    { ...pane('UX', 'node-b:w/t/d'), host: 'node-b', reach: 'up', build: { age: 'current', desired } },
  ] };
  expect(updatePreview(listing, '0.3.33', 'a'.repeat(40), 'a'.repeat(40))).toBe('This Mac already has 0.3.33 (aaaaaaaa). At least 2 seats are still on an older build (this Mac 1 · node-b 1 · minim5 0+). Some seat or build information is unavailable. Each switches to the new build when its current turn ends. Continue? [y/N] ');
  expect(updateSummary([
    { tab: 'mshq:w/t/1', seat: 'TC', result: 'updated', detail: 'ok' },
    { tab: 'mshq:w/t/2', seat: 'TC', result: 'updated', detail: 'ok' },
    { tab: 'node-b:w/t/3', seat: 'TC', result: 'waiting', detail: 'turn running' },
    { tab: 'minim5:*', seat: '', result: 'failed', detail: 'down' },
  ])).toBe('Done: migrated 1 · waiting 1 (node-b:TC: turn running) · unreachable 0 · unreachable hosts 1 (minim5:*)\neln tabs: migrated 2 / waiting 1 / unreachable 0 · other runtimes: 0 (no migration needed)');
  expect(updateSummary([
    { tab: 'mshq:w/t/1', seat: 'TC', result: 'waiting', detail: 'waiting' },
    { tab: 'mshq:w/t/2', seat: 'TC', result: 'failed', detail: 'ambiguous' },
  ])).toBe('Done: migrated 0 · waiting 0 · unreachable 1 (mshq:TC)\neln tabs: migrated 0 / waiting 1 / unreachable 1 · other runtimes: 0 (no migration needed)');
});

test('results table has the English literal header and explicit runtime', () => {
  expect(updateResultsTable([{ tab: 'host:tab', seat: 'TC', runtime: 'eln', result: 'updated', detail: 'ok' }])).toBe(
    '| Tab | Seat | Runtime | Result | Detail |\n|---|---|---|---|---|\n| host:tab | TC | eln | updated | ok |',
  );
});

test('a changed desired SHA refuses local update-all before listing or migration', async () => {
  let listed = 0;
  const result = await updateAllElsTabs({
    sender: () => 'RES-INFRA', expectedDesired: desired, target: () => ({ desired: 'b'.repeat(40), installed: 'b'.repeat(40) }),
    list: async () => { listed++; return { hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }; },
    seats: () => [], migrate: async () => { throw new Error('unexpected migration'); }, sleep: async () => {}, now: () => 0,
  });
  expect(result.reason).toBe('approved-desired-changed');
  expect(listed).toBe(0);
});

test('local OP update calls the real migrate door once per seat, waits for turn end and verifies same session on desired build', async () => {
  let rows: UpdateSeatRow[] = [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: 'b'.repeat(40), source: 'installed' } }];
  const sent: unknown[] = [];
  let ticks = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => rows,
    migrate: (seat, expected) => runSeatControl(seat, 'migrate', { sender: () => 'OP', rows: () => rows,
      send: async (...args) => { sent.push(args); return { status: 'success', reason: 'waiting' }; } }, expected),
    sleep: async () => { ticks++; rows = [{ id: 'tui:11', ownerPid: 11, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: desired, source: 'installed' } }]; },
    now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  expect(result.ok).toBe(true);
  expect(result.rows.map(row => row.result)).toEqual(['updated']);
  expect(sent).toEqual([['tui:10', 'seat-stop', { mode: 'migrate', sender: 'OP', expected: {
    id: 'tui:10', ownerPid: 10, sessionId: 'same-session', workdir: '/seats/TC',
  } }, { timeoutMs: SEAT_STOP_OWNER_WINDOW_MS }]]);
  expect(updateResultsTable(result.rows)).toBe('| Tab | Seat | Runtime | Result | Detail |\n|---|---|---|---|---|\n| node-b:w/t/TC | TC | eln | updated | aaaaaaaaaaaa |');
});

test('another pane in the same seat directory cannot migrate or claim the TUI', async () => {
  let migrated = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [{ ...pane('TC'), pid: 12 }] }),
    seats: () => [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same' }],
    migrate: async () => { migrated++; return { status: 'success', reason: 'waiting' }; },
    sleep: async () => {}, now: () => 0,
  });
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'live TUI missing' });
  expect(updateResultsTable(result.rows)).toBe('| Tab | Seat | Runtime | Result | Detail |\n|---|---|---|---|---|\n| node-b:w/t/TC | TC | unknown | failed | live TUI missing |');
  expect(migrated).toBe(0);
});

test('second run after a migration still finds the eln seat when the live TUI is a descendant of the pane (OP #134152)', async () => {
  let rows: UpdateSeatRow[] = [{ id: 'tui:105', ownerPid: 105, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: 'b'.repeat(40), source: 'installed' } }];
  const sent: unknown[] = [];
  let ticks = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => rows,
    processTree: () => new Map([[105, 104], [104, 10]]),
    migrate: (seat, expected) => runSeatControl(seat, 'migrate', { sender: () => 'OP', rows: () => rows,
      send: async (...args) => { sent.push(args); return { status: 'success', reason: 'waiting' }; } }, expected),
    sleep: async () => { ticks++; rows = [{ id: 'tui:106', ownerPid: 106, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: desired, source: 'installed' } }]; },
    now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  expect(result.ok).toBe(true);
  expect(result.rows.map(row => row.result)).toEqual(['updated']);
  expect(sent).toEqual([['tui:105', 'seat-stop', { mode: 'migrate', sender: 'OP', expected: {
    id: 'tui:105', ownerPid: 105, sessionId: 'same-session', workdir: '/seats/TC',
  } }, { timeoutMs: SEAT_STOP_OWNER_WINDOW_MS }]]);
});

test('immediate rerun after a real migration: both update-all calls report the seat updated on the desired build, never live TUI missing (JUD-C #134453 · OP #134505)', async () => {
  // One universe, two real calls — the f7b completion line (rehearsal-1500 run4): migrate, then an
  // immediate second update-all in the same universe. Each seat-stop hands over like the real TUI
  // relaunch: the next TUI generation is a descendant of the pane pid, not the pane pid itself.
  const tree = new Map([[104, 10], [105, 10], [106, 104], [107, 105]]);
  const generations: UpdateSeatRow[] = [
    { id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: 'b'.repeat(40), source: 'installed' } },
    { id: 'tui:106', ownerPid: 106, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: desired, source: 'installed' } },
    { id: 'tui:107', ownerPid: 107, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same-session', build: { sha: desired, source: 'installed' } },
  ];
  let generation = 0; let ticks = 0;
  const sent: unknown[] = [];
  // Typed return so the object literal keeps UpdateAllDeps contextual typing — without it the
  // migrate callback's (seat, expected) parameters fall to implicit any (TS7006, poller preflight).
  const deps = (): UpdateAllDeps => ({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [generations[Math.min(generation, generations.length - 1)]!],
    processTree: () => tree,
    migrate: (seat, expected) => runSeatControl(seat, 'migrate', {
      sender: () => 'OP', rows: () => [generations[Math.min(generation, generations.length - 1)]!],
      send: async (...args) => { sent.push(args); return { status: 'success', reason: 'waiting' }; },
    }, expected),
    sleep: async () => { ticks++; generation++; },
    now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  const first = await updateAllElsTabs(deps());
  const second = await updateAllElsTabs(deps());  // 즉시 재실행 — 같은 시험 우주에서 두 번째 호출 (f7b)
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(first.rows.map(row => row.result)).toEqual(['updated']);
  expect(second.rows.map(row => row.result)).toEqual(['updated']);
  expect(second.rows[0]?.detail).toBe(desired.slice(0, 12));  // 두 번째 결과도 최신: desired 빌드 12자리
  expect([...first.rows, ...second.rows].filter(row => row.detail.includes('live TUI missing'))).toEqual([]);  // live TUI missing 0
  expect(sent).toEqual([['tui:10', 'seat-stop', { mode: 'migrate', sender: 'OP', expected: {
    id: 'tui:10', ownerPid: 10, sessionId: 'same-session', workdir: '/seats/TC',
  } }, { timeoutMs: SEAT_STOP_OWNER_WINDOW_MS }], ['tui:106', 'seat-stop', { mode: 'migrate', sender: 'OP', expected: {
    id: 'tui:106', ownerPid: 106, sessionId: 'same-session', workdir: '/seats/TC',
  } }, { timeoutMs: SEAT_STOP_OWNER_WINDOW_MS }]]);
});

test('a child TUI under a different pane never matches, with or without a process tree', async () => {
  let migrated = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [{ ...pane('TC'), pid: 12 }] }),
    seats: () => [{ id: 'tui:105', ownerPid: 105, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same' }],
    processTree: () => new Map([[105, 104], [104, 10]]),
    migrate: async () => { migrated++; return { status: 'success', reason: 'waiting' }; },
    sleep: async () => {}, now: () => 0,
  });
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'live TUI missing' });
  expect(migrated).toBe(0);
});

test('migrate refuses a ledger row replaced after pane PID/cwd verification', async () => {
  let reads = 0; const sent: unknown[] = [];
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [{ id: reads++ ? 'tui:20' : 'tui:10', ownerPid: reads > 1 ? 20 : 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same' }],
    migrate: (seat, expected) => runSeatControl(seat, 'migrate', { sender: () => 'OP', rows: () => [{ id: 'tui:20', ownerPid: 20, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same' }],
      send: async (...args) => { sent.push(args); return { status: 'success', reason: 'waiting' }; } }, expected),
    sleep: async () => {}, now: () => 0, timeoutMs: 0,
  });
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'target-changed' });
  expect(sent).toEqual([]);
});

test('ordinary panes remain skipped; an unconfigured remote host is a named failure', async () => {
  let ticks = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }, { name: 'mbp', reach: 'up' }],
      panes: [pane('TC'), { ...pane('TC', 'node-b:w/t/shell'), seat: null, pid: 12 }, { ...pane('UX', 'mbp:w/t/UX'), host: 'mbp', reach: 'up' }] }),
    seats: () => [{ id: `tui:${ticks ? 11 : 10}`, ownerPid: ticks ? 11 : 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same', build: { sha: desired, source: 'installed' } }],
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async () => { ticks++; }, now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  expect(result.ok).toBe(false);
  expect(result.rows.map(row => row.result)).toEqual(['failed', 'failed', 'updated', 'skipped']);
});

test('request acceptance is not completion: same process, changed session and timeout stay unverified', async () => {
  let ticks = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: ticks ? 'different' : 'original', build: { sha: desired, source: 'installed' } }],
    migrate: async () => ({ status: 'success', reason: 'accepted' }),
    sleep: async () => { ticks++; }, now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  expect(result.ok).toBe(false);
  expect(result.rows[0]?.result).toBe('waiting');
  expect(result.rows[0]?.detail).toContain('unverified');
});

test('authorization and installed target gate all effects; remote and missing local seat are named failures', async () => {
  let migrated = 0;
  const deps = {
    sender: () => 'TC-H-CX-13', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }, { name: 'mbp', reach: 'down' }], panes: [pane('TC'), { ...pane('UX', 'mbp:w/t/p'), host: 'mbp', reach: 'up' }] }),
    seats: () => [] as UpdateSeatRow[], migrate: async () => { migrated++; return { status: 'success', reason: 'waiting' }; },
    sleep: async () => {}, now: () => 0,
  };
  expect((await updateAllElsTabs(deps)).reason).toBe('operator-seat-required');
  expect((await updateAllElsTabs({ ...deps, sender: () => 'OP', target: () => ({ desired, installed: 'b'.repeat(40) }) })).reason).toBe('desired-build-not-installed');
  const result = await updateAllElsTabs({ ...deps, sender: () => 'OP' });
  expect(result.ok).toBe(false);
  expect(result.rows.map(row => row.detail)).toEqual(['remote host unavailable', 'remote result unavailable', 'live TUI missing']);
  expect(migrated).toBe(0);
});

test('registered remote host is updated once and returns verified host and pane rows', async () => {
  const calls: string[] = [];
  const address = 'aws1:w1/t1/p1';
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'mshq', reach: 'local' }, { name: 'aws1', reach: 'up' }],
      panes: [{ ...pane('TC', address), host: 'aws1', reach: 'up' }] }),
    seats: () => [], migrate: async () => { throw new Error('remote pane must not use local ledger'); },
    remoteUpdate: async (host, panes, target) => {
      calls.push(host.name);
      expect(panes.map((row) => row.address)).toEqual([address]);
      expect(target).toBe(desired);
      return { result: 'updated', detail: `old→${desired.slice(0, 12)}`,
        panes: [{ tab: address, seat: 'TC', result: 'updated', detail: desired.slice(0, 12) }] };
    },
    sleep: async () => {}, now: () => 0,
  });
  expect(calls).toEqual(['aws1']);
  expect(result.ok).toBe(true);
  expect(result.rows.map((row) => [row.tab, row.result])).toEqual([['aws1:*', 'updated'], [address, 'updated']]);
});

test('a remote receipt for another pane cannot claim success', async () => {
  const address = 'aws1:w1/t1/p1';
  const result = await updateAllElsTabs({
    sender: () => 'RES-INFRA', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'mshq', reach: 'local' }, { name: 'aws1', reach: 'up' }],
      panes: [{ ...pane('TC', address), host: 'aws1', reach: 'up' }] }),
    seats: () => [], migrate: async () => { throw new Error('must not migrate the other host locally'); },
    remoteUpdate: async () => ({ result: 'updated', detail: 'claimed',
      panes: [{ tab: 'aws1:w1/t1/other', seat: 'TC', result: 'updated', detail: 'claimed' }] }),
    sleep: async () => {}, now: () => 0,
  });
  expect(result.ok).toBe(false);
  expect(result.rows.map(row => row.result)).toEqual(['failed', 'failed']);
  expect(result.rows[0]?.detail).toContain('does not match listed panes');
});

test('verification ledger failure after the request is a failed row, not a successful migration', async () => {
  let calls = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => { if (++calls > 1) throw new Error('disk read failed'); return [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'original' }]; },
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async () => {}, now: () => 0, timeoutMs: 1_000,
  });
  expect(result.ok).toBe(false);
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'verification failed: disk read failed' });
});

test('a seat label with a different working directory cannot migrate another seat process', async () => {
  let called = false;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [{ id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/other', sessionId: 'other' }],
    migrate: async () => { called = true; return { status: 'success', reason: 'waiting' }; },
    sleep: async () => {}, now: () => 0,
  });
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'live TUI missing' });
  expect(called).toBe(false);
});

test('a desired build change before reporting revokes an otherwise verified row', async () => {
  let ticks = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired: ticks ? 'c'.repeat(40) : desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [{ id: `tui:${ticks ? 11 : 10}`, ownerPid: ticks ? 11 : 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 'same', build: { sha: ticks ? desired : 'b'.repeat(40), source: 'installed' } }],
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async () => { ticks++; }, now: () => ticks * 1_000, timeoutMs: 2_000,
  });
  expect(result.reason).toBe('desired-build-changed');
  expect(result.rows[0]).toMatchObject({ result: 'failed', detail: 'desired or installed build changed during migration' });
});

test('synthetic clock reports each local request and shrinking pending seats every 30 seconds', async () => {
  let time = 0; const progress: string[] = [];
  const old = ['TC', 'UX'].map(seat => ({ id: `tui:${seat}`, ownerPid: 10, alive: true, kind: 'tui', seat, workdir: `/seats/${seat}`, sessionId: seat }));
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC'), pane('UX')] }),
    seats: () => old.map(row => row.seat === 'TC' && time >= 31_000 ? { ...row, ownerPid: 11, build: { sha: desired, source: 'installed' } } : row),
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async ms => { time += ms; }, now: () => time, timeoutMs: 65_000,
    progress: message => progress.push(message),
  });
  expect(progress).toEqual(['Migration requested: node-b:w/t/TC · TC', 'Migration requested: node-b:w/t/UX · UX',
    'Remaining seats: 2 · 35s remaining', 'Seat done: TC · unknown→aaaaaaaaaaaa', 'Remaining seats: 1 · 5s remaining',
    'Stragglers at deadline: UX (still unknown)']);
  expect(result.rows.map(row => row.result)).toEqual(['updated', 'waiting']);
  expect(result.ok).toBe(true);
});

test('synthetic remote delay reports countdown and always clears its timer on failure', async () => {
  let time = 0; let tick = () => {}; let stopped = false; const progress: string[] = [];
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'mshq', reach: 'local' }, { name: 'mbp', reach: 'up' }], panes: [{ ...pane('TC', 'mbp:w/t/TC'), host: 'mbp', reach: 'up' }] }),
    seats: () => [], migrate: async () => { throw new Error('unexpected'); },
    every: (cb, ms) => { expect(ms).toBe(30_000); tick = cb; return () => { stopped = true; }; },
    remoteUpdate: async () => { time = 30_000; tick(); time = 60_000; tick(); throw new Error('offline'); },
    progress: message => progress.push(message), sleep: async () => {}, now: () => time,
  });
  expect(progress).toEqual(['Remote update requested: mbp · 1 seats awaiting confirmation', 'Remote mbp · 1 seats awaiting confirmation · 1830s remaining', 'Remote mbp · 1 seats awaiting confirmation · 1800s remaining']);
  expect(stopped).toBe(true);
  expect(result.ok).toBe(false);
});

test('a desired change mid-run stops further seat migrations onto the stale pinned build (#133752)', async () => {
  const migrated: string[] = [];
  let flipped = false;
  let clock = 0;
  const result = await updateAllElsTabs({
    sender: () => 'OP',
    target: () => flipped ? { desired: 'c'.repeat(40), installed: 'c'.repeat(40) } : { desired, installed: desired },
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC'), { ...pane('UX'), pid: 20 }] }),
    seats: () => [
      { id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 's1' },
      { id: 'tui:20', ownerPid: 20, alive: true, kind: 'tui', seat: 'UX', workdir: '/seats/UX', sessionId: 's2' },
    ],
    migrate: async (seat: string) => { migrated.push(seat); flipped = true; return { status: 'success', reason: 'waiting' }; },
    sleep: async () => { clock += 31 * 60 * 1000 + 1; },  // 출처: #133752 — 검증 루프 즉시 종료(기본 30분 deadline 초과 점프)
    now: () => clock,
  });
  expect(migrated).toEqual(['TC']);  // UX 는 낡은 desired 로 더 이상 이전하지 않는다
  expect(result.rows.filter((row) => row.detail === 'desired-build-changed').map((row) => row.tab)).toEqual(['node-b:w/t/UX']);
});

test('other runtimes are skipped without attempting migration and summarized separately', async () => {
  const calls: string[] = [];
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [
      { ...pane('TC', 'node-b:w/t/a'), kind: 'codex' },
      { ...pane('UX', 'node-b:w/t/b'), kind: 'claude' },
      { ...pane('REL', 'node-b:w/t/c'), kind: 'grok' },
      { ...pane('OP', 'node-b:w/t/d'), kind: 'shell' },
    ] }),
    seats: () => [], migrate: async seat => { calls.push(seat); return { status: 'success', reason: 'waiting' }; },
    sleep: async () => {}, now: () => 0,
  });
  expect(calls).toEqual([]);
  expect(result.rows.map(row => [row.runtime, row.result, row.detail])).toEqual([
    ['codex', 'skipped', 'codex tab, uses new install on next command'],
    ['claude', 'skipped', 'claude tab, uses new install on next command'],
    ['grok', 'skipped', 'grok tab, uses new install on next command'],
    ['shell', 'skipped', 'shell tab, uses new install on next command'],
  ]);
  expect(updateSummary(result.rows)).toBe('Done: migrated 0 · waiting 0 · unreachable 0\neln tabs: migrated 0 / waiting 0 / unreachable 0 · other runtimes: 4 (no migration needed)');
});

test('installation progress uses the literal request count, never a guessed count', () => {
  expect(updateInstallProgress('already up to date (skipped)', 3)).toBe('Install: already up to date (skipped) · Migration requested for 3 seats · Progress every 30s');
  expect(updateInstallProgress('updated', undefined)).toBe('Install: updated · Migration requested for an unknown number of seats · Progress every 30s');
});

// ELS-UPDATE-ALL-REMAINING-STUCK (대표 11-25 20:4x): the TUI restarts via execve in place, so the pid never changes.
test('exec-in-place restart (same pid, newer registration) counts as done and exits before the deadline', async () => {
  let time = 0; const progress: string[] = [];
  const oldRow = { id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 's-TC', startedAt: 1000,
    build: { sha: 'b'.repeat(40), source: 'installed' } };
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [time >= 3_000 ? { ...oldRow, startedAt: 5000, build: { sha: desired, source: 'installed' } } : oldRow],
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async ms => { time += ms; }, now: () => time, timeoutMs: 600_000,
    progress: message => progress.push(message),
  });
  expect(time).toBe(3_000);
  expect(result.ok).toBe(true);
  expect(result.rows.map(row => row.result)).toEqual(['updated']);
  expect(progress).toEqual(['Migration requested: node-b:w/t/TC · TC', 'Seat done: TC · bbbbbbbbbbbb→aaaaaaaaaaaa']);
});

test('same pid with the same registration time is not a restart and stays a straggler', async () => {
  let time = 0; const progress: string[] = [];
  const row = { id: 'tui:10', ownerPid: 10, alive: true, kind: 'tui', seat: 'TC', workdir: '/seats/TC', sessionId: 's-TC', startedAt: 1000,
    build: { sha: desired, source: 'installed' } };
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }], panes: [pane('TC')] }),
    seats: () => [row], migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async ms => { time += ms; }, now: () => time, timeoutMs: 5_000,
    progress: message => progress.push(message),
  });
  expect(result.rows.map(r => r.result)).toEqual(['waiting']);
  expect(progress.at(-1)).toBe('Stragglers at deadline: TC (still aaaaaaaaaaaa)');
});

test('three fake seats: slow done, exited skipped, remote unreachable fails the run', async () => {
  let time = 0; const progress: string[] = [];
  const slow = { id: 'tui:20', ownerPid: 20, alive: true, kind: 'tui', seat: 'SLOW', workdir: '/seats/SLOW', sessionId: 's-SLOW', startedAt: 100,
    build: { sha: 'c'.repeat(40), source: 'installed' } };
  const result = await updateAllElsTabs({
    sender: () => 'OP', target: () => ({ desired, installed: desired }),
    list: async () => ({ hosts: [{ name: 'node-b', reach: 'local' }, { name: 'far', reach: 'down' }], panes: [
      { ...pane('SLOW'), pid: 20 },
      { ...pane('GONE'), state: 'exited' },
      { address: 'far:w/t/R', host: 'far', reach: 'down', seat: 'REMOTE', state: 'working', cwd: '/seats/REMOTE', pid: 30, kind: 'pty' },
    ] }),
    seats: () => [time >= 40_000 ? { ...slow, startedAt: 900, build: { sha: desired, source: 'installed' } } : slow],
    migrate: async () => ({ status: 'success', reason: 'waiting' }),
    sleep: async ms => { time += ms; }, now: () => time, timeoutMs: 600_000,
    progress: message => progress.push(message),
  });
  expect(time).toBe(40_000);
  expect(result.ok).toBe(false);
  expect(result.rows.map(r => `${r.tab}=${r.result}`)).toEqual(['far:*=failed', 'far:w/t/R=failed', 'node-b:w/t/SLOW=updated', 'node-b:w/t/GONE=skipped']);
  expect(progress).toEqual(['Migration requested: node-b:w/t/SLOW · SLOW', 'Seat skipped: GONE · node-b:w/t/GONE (exited)',
    'Remaining seats: 1 · 570s remaining', 'Seat done: SLOW · cccccccccccc→aaaaaaaaaaaa']);
});
