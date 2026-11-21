import { expect, test } from 'bun:test';
import { resolvePeerSeatWithAnchor, type ProcessIdentity } from './peer-seat.js';

test('captures the verified pane shell generation, not the session leader', async () => {
  const leader: ProcessIdentity = { pid: 3, ppid: 1, session: 3, tty: 9, start: '10:1', startedMs: 10000 };
  const shell: ProcessIdentity = { pid: 30, ppid: 3, session: 3, tty: 9, start: '20:1', startedMs: 20000 };
  const peer: ProcessIdentity = { pid: 42, ppid: 30, session: 3, tty: 9, start: '30:1', startedMs: 30000 };
  const procs = new Map([[3, leader], [30, shell], [42, peer]]);
  const deps = { identity: (pid: number | undefined) => pid === undefined ? undefined : procs.get(pid), ledger: async () => 'OP\tw1:p2\n', paneInfo: async () => ({ pane_id: 'w1:p2', shell_pid: 30 }) };
  const match = await resolvePeerSeatWithAnchor(42, peer, 'isolated', deps);
  expect(match).toEqual({ seat: 'OP', pane: 'w1:p2', anchor: shell });
  expect(await resolvePeerSeatWithAnchor(shell.pid, shell, 'isolated', deps)).toEqual(match);
  procs.set(30, { ...shell, start: '21:1' });
  expect(await resolvePeerSeatWithAnchor(shell.pid, shell, 'isolated', deps)).toBeUndefined();
});
