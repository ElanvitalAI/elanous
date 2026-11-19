import { expect, test } from 'bun:test';
import { runSeatControl } from './seat-control-cli.js';

test('seat control uses one live local TUI and a transport-derived sender', async () => {
  const calls: unknown[] = [];
  const deps = { sender: () => 'OP', rows: () => [{ id: 'tui:123', kind: 'tui', seat: 'TC', alive: true }],
    send: async (...args: unknown[]) => { calls.push(args); return { status: 'success' as const, reason: 'waiting' }; } };
  expect(await runSeatControl('TC', 'migrate', deps)).toEqual({ status: 'success', reason: 'waiting' });
  expect(calls).toEqual([['tui:123', 'seat-stop', { mode: 'migrate', sender: 'OP' }]]);
});

test('unknown sender, unauthorized caller, invalid mode and ambiguous targets never send', async () => {
  let calls = 0;
  const rows = () => [{ id: 'tui:1', kind: 'tui', seat: 'TC', alive: true }];
  const send = async () => { calls++; return { status: 'success' as const }; };
  expect(await runSeatControl('TC', 'quit', { sender: () => null, rows, send })).toEqual({ status: 'denied', reason: 'sender-unavailable' });
  expect(await runSeatControl('TC', 'quit', { sender: () => 'OTHER', rows, send })).toEqual({ status: 'denied', reason: 'seat-control-not-authorized' });
  expect(await runSeatControl('TC', 'restart', { sender: () => 'OP', rows, send })).toEqual({ status: 'denied', reason: 'invalid-mode' });
  expect(await runSeatControl('TC', 'force', { sender: () => 'OP', rows: () => [...rows(), ...rows()], send })).toEqual({ status: 'denied', reason: 'ambiguous-seat' });
  expect(calls).toBe(0);
});

test('a live TUI whose build predates seat control (no seat on its row) is named, not «not running» — and nothing is sent (RES #100614)', async () => {
  let calls = 0;
  const send = async () => { calls++; return { status: 'success' as const }; };
  const rows = () => [{ id: 'tui:53576', kind: 'tui', seat: 'JUD-B', alive: false, ownerPid: 53576 }, { id: 'tui:51820', kind: 'tui', alive: true, ownerPid: 51820 }];
  const seatOfPid = (pid: number) => pid === 51820 ? 'JUD-B' : undefined;
  expect(await runSeatControl('JUD-B', 'migrate', { sender: () => 'OP', rows, send, seatOfPid })).toEqual({ status: 'unknown-pty', reason: 'seat-build-predates-control',
    policy: 'restart JUD-B: its TUI (tui:51820, pid 51820) runs a build from before seat control and cannot take migrate' });
  expect(await runSeatControl('JUD-B', 'migrate', { sender: () => 'OP', rows, send, seatOfPid: () => 'OTHER' })).toEqual({ status: 'unknown-pty', reason: 'seat-not-running' });
  expect(calls).toBe(0);
});
