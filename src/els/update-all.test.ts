import { expect, test } from 'bun:test';
import { runSeatControl } from '../cli/seat-control-cli.js';
import { updateAllElsTabs, updateResultsTable, type UpdateSeatRow } from './update-all.js';

const desired = 'a'.repeat(40);
const pane = (seat: string, address = `node-b:w/t/${seat}`) => ({ address, host: 'node-b', reach: 'local', seat, state: 'working', cwd: `/seats/${seat}`, pid: 10, kind: 'pty' });

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
  } }]]);
  expect(updateResultsTable(result.rows)).toContain('| node-b:w/t/TC | TC | updated | aaaaaaaaaaaa |');
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
