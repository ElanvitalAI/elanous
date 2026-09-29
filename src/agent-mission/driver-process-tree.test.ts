import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { terminateMissionProcessTree } from './driver.js';

const table = () => execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
const descendantsOf = (root: number): number[] => {
  const children = new Map<number, number[]>();
  for (const line of table().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const descendants: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (descendants.includes(child)) continue;
      descendants.push(child);
      walk(child);
    }
  };
  walk(root);
  return descendants;
};
const running = (pid: number) => {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return state.length > 0 && !state.startsWith('Z');
  }
  catch { return false; }
};

describe('terminateMissionProcessTree', () => {
  test('snapshots nested descendants, terminates children before parent, and kills only survivors after two seconds', async () => {
    const sent: Array<[number, string | number]> = [];
    const alive = new Set([10, 11, 12, 13]);
    let waited = 0;
    await terminateMissionProcessTree(10, {
      processTable: () => '10 1\n11 10\n12 11\n13 10\n44 99\n',
      signal: (pid, signal) => {
        sent.push([pid, signal]);
        if (!alive.has(pid)) throw new Error('ESRCH');
        if (signal === 'SIGTERM' && pid !== 12) alive.delete(pid);
      },
      wait: async (ms) => { waited = ms; expect(sent.map(([pid]) => pid)).toEqual([12, 11, 13, 10]); },
    });
    expect(waited).toBe(2000);
    expect(sent).toEqual([
      [12, 'SIGTERM'], [11, 'SIGTERM'], [13, 'SIGTERM'], [10, 'SIGTERM'],
      [12, 0], [12, 'SIGKILL'], [11, 0], [13, 0], [10, 0],
    ]);
  });

  test('a real shell with a TERM-resistant child leaves neither the root nor its descendant running', async () => {
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; /bin/sh -c 'trap \"\" TERM; while :; do sleep 1; done' & wait"], { stdio: 'ignore' });
    const root = child.pid!;
    let descendants: number[] = [];
    try {
      for (let i = 0; i < 50; i++) {
        descendants = descendantsOf(root);
        if (descendants.length >= 2) break;
        await Bun.sleep(20);
      }
      expect(descendants.length).toBeGreaterThanOrEqual(2);
      await terminateMissionProcessTree(root);
      expect(running(root)).toBe(false);
      for (const pid of descendants) expect(running(pid)).toBe(false);
    } finally {
      for (const pid of [...descendants, root]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  }, 10000);
});
