import { expect, test } from 'bun:test';
import { inspectReadAncestry, type ProcessIdentity } from './peer-seat.js';

const proc = (pid: number, ppid: number): ProcessIdentity => ({ pid, ppid, session: 3, tty: 9, start: `${pid}:1`, startedMs: pid });

test('read ancestry distinguishes verified human, pane descendant and lookup failure', () => {
  const processes = new Map([[3, proc(3, 1)], [30, proc(30, 3)], [42, proc(42, 30)]]);
  const identity = (pid: number) => processes.get(pid);
  const baseline = processes.get(42)!;
  expect(inspectReadAncestry(42, baseline, [{ pane: 'p1', pid: 30 }], { identity })).toEqual({ kind: 'pane', pane: 'p1' });
  expect(inspectReadAncestry(42, baseline, [{ pane: 'p2', pid: 99 }], { identity })).toEqual({ kind: 'human' });
  processes.delete(30);
  expect(inspectReadAncestry(42, baseline, [{ pane: 'p2', pid: 99 }], { identity })).toEqual({ kind: 'unknown' });
  expect(inspectReadAncestry(undefined, undefined, [], { identity })).toEqual({ kind: 'unknown' });
});
