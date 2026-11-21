import { expect, test } from 'bun:test';
import { verifyPanePeer, type ProcessIdentity } from './peer-seat.js';

const peer: ProcessIdentity = { pid: 42, ppid: 7, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
const shell: ProcessIdentity = { pid: 7, ppid: 3, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
const binding = { pid: 7, start: '90:1', generation: 'generation-a' };
const identity = (pid: number | undefined) => pid === 42 ? peer : pid === 7 ? shell : undefined;
const shells = () => [{ pane: 'worker', pid: 7 }];

test('pane token binds to actual live peer ancestry and generation, not a claimed PID', () => {
  const check = (pid = 42, baseline: ProcessIdentity | undefined = peer) => verifyPanePeer(pid, baseline, 'worker', () => binding, shells, identity);
  expect(check()).toBe(true);
  expect(check(43)).toBe(false);
  expect(verifyPanePeer(42, undefined, 'worker', () => binding, shells, identity)).toBe(false);
  expect(verifyPanePeer(42, peer, 'op-pane', () => binding, shells, identity)).toBe(false);
  expect(verifyPanePeer(42, { ...peer, start: 'stale' }, 'worker', () => binding, shells, identity)).toBe(false);
  expect(verifyPanePeer(42, peer, 'worker', () => ({ ...binding, start: 'stale' }), shells, identity)).toBe(false);
  expect(verifyPanePeer(42, peer, 'worker', () => binding, () => [{ pane: 'other', pid: 42 }, ...shells()], identity)).toBe(false);
});

test('a legitimate child remains valid when process ids wrap', () => {
  const wrappedPeer = { ...peer, pid: 5, ppid: 42 };
  const wrappedShell = { ...shell, pid: 42 };
  const wrappedIdentity = (pid: number | undefined) => pid === 5 ? wrappedPeer : pid === 42 ? wrappedShell : undefined;
  expect(verifyPanePeer(5, wrappedPeer, 'worker', () => ({ ...binding, pid: 42 }), () => [{ pane: 'worker', pid: 42 }], wrappedIdentity)).toBe(true);
});

test('shell ancestry mapping must remain unchanged during verification', () => {
  let reads = 0;
  const changedShells = () => ++reads === 1 ? shells() : [{ pane: 'other', pid: 42 }, ...shells()];
  expect(verifyPanePeer(42, peer, 'worker', () => binding, changedShells, identity)).toBe(false);
});

test('changed or vanished peer, shell or pane generation fails closed', () => {
  let calls = 0;
  expect(verifyPanePeer(42, peer, 'worker', () => ++calls === 1 ? binding : { ...binding, generation: 'new' }, shells, identity)).toBe(false);
  let reads = 0;
  const changed = (pid: number | undefined) => pid === 42 && ++reads === 2 ? { ...peer, start: 'reused' } : identity(pid);
  expect(verifyPanePeer(42, peer, 'worker', () => binding, shells, changed)).toBe(false);
  expect(verifyPanePeer(42, peer, 'worker', () => undefined, shells, identity)).toBe(false);
  expect(verifyPanePeer(42, peer, 'worker', () => binding, shells, () => { throw Error('unavailable'); })).toBe(false);
});
