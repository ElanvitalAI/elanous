import { expect, test } from 'bun:test';
import { resolveElsPeerSeat, type ProcessIdentity } from './peer-seat.js';
import { authorizeRequest, type ServerRole } from './server-auth.js';

// core.seatBindings() maps an OP-owned worker's ownerSeat to this seat field.
// Synthetic identities exercise the same stable ancestry/generation checks without OS process spawning.
test('an OP-owned worker does not gain OP peer authority from ownership', () => {
  const peer: ProcessIdentity = { pid: 42, ppid: 7, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
  const shell: ProcessIdentity = { pid: 7, ppid: 3, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
  const leader: ProcessIdentity = { pid: 3, ppid: 1, session: 3, tty: 9, start: '80:1', startedMs: 80000 };
  const worker = { pane: 'worker', pid: 7, seat: 'OP', generation: 'pty-1', start: '90:1' };
  const identity = (pid: number | undefined) => pid === 42 ? peer : pid === 7 ? shell : pid === 3 ? leader : undefined;
  const resolved = resolveElsPeerSeat(42, peer, () => [worker], { identity });
  const role: ServerRole = resolved
    ? { kind: 'peer', pid: 42, uid: 501, pane: resolved.pane, seat: resolved.seat }
    : { kind: 'outsider', note: 'no pane credential' };
  // A tokenless worker must not acquire the supervisor's cross-workspace close privilege.
  expect(authorizeRequest(role, { op: 'close', pane: 'other' }, 'other-workspace', []).allow).toBe(false);
  expect(resolved).toBeUndefined();
});
