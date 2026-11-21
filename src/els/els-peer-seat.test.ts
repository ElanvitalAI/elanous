import { expect, test } from 'bun:test';
import { resolveElsPeerSeat, type ProcessIdentity } from './peer-seat.js';

const peer: ProcessIdentity = { pid: 42, ppid: 7, session: 3, tty: 9, start: '100:1', startedMs: 100000 };
const shell: ProcessIdentity = { pid: 7, ppid: 3, session: 3, tty: 9, start: '90:1', startedMs: 90000 };
const leader: ProcessIdentity = { pid: 3, ppid: 1, session: 3, tty: 9, start: '80:1', startedMs: 80000 };
const binding = { pane: 'p-op', pid: 7, seat: 'OP', generation: 'pty-1', start: '90:1' };

test('els pane ownership never identifies the actor, even with stable ancestry', () => {
  const run = (scenario: string) => {
    let snapshots = 0, peerReads = 0;
    const identity = (pid: number | undefined) => pid === 42
      ? (++peerReads > 1 && scenario === 'reused' ? { ...peer, start: '101:1' } : peer)
      : pid === 7 ? (scenario === 'wrong-session' ? { ...shell, session: 4 } : scenario === 'wrong-shell-generation' ? { ...shell, start: '91:1' } : shell) : pid === 3 ? leader : undefined;
    const bindings = () => {
      snapshots++;
      if (scenario === 'ambiguous') return [binding, { ...binding, pane: 'p-other' }];
      if (scenario === 'unrelated') return [{ ...binding, pid: 8 }];
      if (snapshots > 1 && scenario === 'owner-changed') return [{ ...binding, seat: 'OTHER' }];
      if (snapshots > 1 && scenario === 'replaced') return [{ ...binding, generation: 'pty-2' }];
      if (snapshots > 1 && scenario === 'closed') return [];
      return [binding];
    };
    return resolveElsPeerSeat(42, scenario === 'no-baseline' ? undefined : peer, bindings, { identity });
  };
  expect(run('ok')).toBeUndefined();
  for (const scenario of ['no-baseline', 'reused', 'ambiguous', 'replaced', 'closed', 'wrong-session', 'wrong-shell-generation', 'unrelated', 'owner-changed']) expect(run(scenario)).toBeUndefined();
});

test('pane owner is not the identity of its process, for OP and non-OP owners', () => {
  const identity = (pid: number | undefined) => pid === 42 ? peer : pid === 7 ? shell : pid === 3 ? leader : undefined;
  for (const seat of ['OP', 'RES-INFRA', 'HAND']) {
    expect(resolveElsPeerSeat(42, peer, () => [{ ...binding, seat }], { identity })).toBeUndefined();
  }
});

test('even a mutable owner binding cannot grant a peer seat', () => {
  const shared = { ...binding };
  let reads = 0;
  const bindings = () => { if (++reads === 2) shared.seat = 'OTHER'; return [shared]; };
  const identity = (pid: number | undefined) => pid === 42 ? peer : pid === 7 ? shell : pid === 3 ? leader : undefined;
  expect(resolveElsPeerSeat(42, peer, bindings, { identity })).toBeUndefined();
});
