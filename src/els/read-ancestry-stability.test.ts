import { expect, test } from 'bun:test';
import { inspectReadAncestry, type ProcessIdentity } from './peer-seat.js';

const id = (pid: number, ppid: number): ProcessIdentity => ({ pid, ppid, session: 10, tty: 7, start: `s${pid}`, startedMs: 1 });
test('uncredentialed human read denies an ancestry that changes during lookup', () => {
  const peer = id(30, 20), parent = id(20, 10), leader = id(10, 1);
  let peerReads = 0;
  const result = inspectReadAncestry(30, peer, [], { identity: pid => {
    if (pid === 30) return ++peerReads === 1 ? peer : { ...peer, ppid: 99 };
    return pid === 20 ? parent : pid === 10 ? leader : undefined;
  } });
  expect(result.kind).toBe('unknown');
});
test('baseline parent mismatch is rejected', () => {
  const peer = id(30, 20);
  expect(inspectReadAncestry(30, peer, [], { identity: () => ({ ...peer, ppid: 10 }) }).kind).toBe('unknown');
});

test.each(['parent-changed', 'leader-missing'] as const)('rejects unstable intermediate ancestry: %s', scenario => {
  const peer = id(30, 20), parent = id(20, 10), leader = id(10, 1);
  const calls = new Map<number, number>();
  const nodes = new Map([peer, parent, leader].map(p => [p.pid, p]));
  const result = inspectReadAncestry(30, peer, [], { identity: pid => {
    const n = (calls.get(pid) ?? 0) + 1;
    calls.set(pid, n);
    if (pid === 20 && n === 2 && scenario === 'parent-changed') return { ...parent, start: 'recycled' };
    if (pid === 10 && n === 2 && scenario === 'leader-missing') return undefined;
    return nodes.get(pid);
  } });
  expect(result.kind).toBe('unknown');
});

test('unchanged complete human ancestry is accepted', () => {
  const peer = id(30, 20), parent = id(20, 10), leader = id(10, 1);
  const nodes = new Map([peer, parent, leader].map(p => [p.pid, p]));
  expect(inspectReadAncestry(30, peer, [], { identity: pid => nodes.get(pid) }).kind).toBe('human');
});
