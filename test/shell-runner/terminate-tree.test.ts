import { describe, test, expect, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';

import { terminateTree } from '../../src/shell-primitive/terminate-tree.js';
import { createFileCaptureEngine } from '../../src/shell-runner/file-engine.js';
import type { RunCtx } from '../../src/shell-runner/types.js';

// Only PIDs created inside this file are ever signalled.
// login shell startup can exceed 1s; the command's pid must be printed before the timeout fires.
const LOGIN_SHELL_TIMEOUT_MS = Number('4000');
const created: number[] = [];
afterEach(() => {
  for (const pid of created.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !alive(pid);
}

describe('terminateTree', () => {
  test('kills leader and grandchild of a detached group', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 300 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    created.push(child.pid!);
    const gpid = await new Promise<number>((res) => child.stdout!.once('data', (b) => res(Number(String(b).trim()))));
    created.push(gpid);
    expect(alive(gpid)).toBe(true);
    const r = await terminateTree(child, { group: true, graceMs: 1500 });
    expect(r.terminated).toBe(true);
    expect(r.errors).toEqual([]);
    expect(await waitDead(gpid, 2000)).toBe(true);
    expect(await waitDead(child.pid!, 2000)).toBe(true);
  }, 15_000);

  test('escalates to SIGKILL when SIGTERM is trapped', async () => {
    const child = spawn('/bin/sh', ['-c', "trap '' TERM; echo ready; while :; do sleep 1; done"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    created.push(child.pid!);
    await new Promise<void>((res) => child.stdout!.once('data', () => res()));
    const r = await terminateTree(child, { group: true, graceMs: 300 });
    expect(r.escalated).toBe(true);
    expect(r.terminated).toBe(true);
    expect(await waitDead(child.pid!, 2000)).toBe(true);
  }, 15_000);

  test('already-dead pid is success with no errors', async () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => child.once('exit', r));
    const r = await terminateTree({ pid: child.pid }, { group: true, graceMs: 100 });
    expect(r).toEqual({ terminated: true, escalated: false, errors: [] });
  });

  test('unsafe pids (0, 1, -1, NaN) are never signalled', async () => {
    const sent: number[] = [];
    for (const pid of [0, 1, -1, Number.NaN]) {
      const r = await terminateTree({ pid }, { group: true, graceMs: 20, sendSignal: (p) => { sent.push(p); } });
      expect(r.errors).toEqual(['no usable pid and no kill()']);
    }
    expect(sent).toEqual([]);
  });

  test('all signals succeed but target persists -> terminated:false with explicit error', async () => {
    const calls: Array<[number, string | number]> = [];
    const r = await terminateTree({ pid: 4242 }, {
      group: true, graceMs: 0, killWaitMs: 60,
      sendSignal: (p, sig) => { calls.push([p, sig]); },
    });
    expect(r.escalated).toBe(true);
    expect(r.terminated).toBe(false);
    expect(r.errors).toEqual(['SIGKILL: target still present']);
    expect(calls[0]).toEqual([-4242, 'SIGTERM']);
    expect(calls.some(([, sig]) => sig === 'SIGKILL')).toBe(true);
    expect(calls.some(([, sig]) => sig === 0)).toBe(true);
  });

  test('firstSignal SIGKILL sends -pgid SIGKILL first and never SIGTERM', async () => {
    const calls: Array<[number, string | number]> = [];
    let dead = false;
    const r = await terminateTree({ pid: 4242 }, {
      group: true, firstSignal: 'SIGKILL',
      sendSignal: (p, sig) => {
        calls.push([p, sig]);
        if (sig === 'SIGKILL') dead = true;
        else if (dead) { const e: NodeJS.ErrnoException = new Error('gone'); e.code = 'ESRCH'; throw e; }
      },
    });
    expect(calls[0]).toEqual([-4242, 'SIGKILL']);
    expect(calls.some(([, sig]) => sig === 'SIGTERM')).toBe(false);
    expect(r).toEqual({ terminated: true, escalated: false, errors: [] });
  });

  const errno = (code: string) => { const e: NodeJS.ErrnoException = new Error(code); e.code = code; return e; };
  for (const code of ['EINVAL', 'EIO']) {
    test(`probe failing with ${code} is unconfirmed, not gone`, async () => {
      const r = await terminateTree({ pid: 4242 }, {
        group: true, graceMs: 0, killWaitMs: 40,
        sendSignal: (_p, sig) => { if (sig === 0) throw errno(code); },
      });
      expect(r.terminated).toBe(false);
      expect(r.errors).toEqual([`cannot confirm exit: probe ${code}`]);
    });
  }

  test('probe ESRCH means gone', async () => {
    const r = await terminateTree({ pid: 4242 }, {
      group: true, graceMs: 0, killWaitMs: 40,
      sendSignal: (_p, sig) => { if (sig === 0) throw errno('ESRCH'); },
    });
    expect(r).toEqual({ terminated: true, escalated: false, errors: [] });
  });

  test('probe EPERM means still alive', async () => {
    const r = await terminateTree({ pid: 4242 }, {
      group: true, graceMs: 0, killWaitMs: 40,
      sendSignal: (_p, sig) => { if (sig === 0) throw errno('EPERM'); },
    });
    expect(r.terminated).toBe(false);
    expect(r.errors).toEqual(['SIGKILL: target still present']);
  });

  test('no-pid child whose kill() throws ESRCH is unconfirmed, not terminated', async () => {
    const r = await terminateTree({ kill: () => { throw errno('ESRCH'); } }, { group: true, graceMs: 10 });
    expect(r.terminated).toBe(false);
    expect(r.errors).toEqual(['cannot confirm exit: no pid probe']);
  });

  test('no-pid child whose kill() succeeds stays terminated:false', async () => {
    const r = await terminateTree({ kill: () => true }, { group: true, graceMs: 10 });
    expect(r.terminated).toBe(false);
    expect(r.errors).toEqual(['cannot confirm exit: no pid probe']);
  });

  test('pid child whose group send throws ESRCH is terminated:true (unchanged)', async () => {
    const r = await terminateTree({ pid: 4242 }, {
      group: true, graceMs: 10,
      sendSignal: () => { throw errno('ESRCH'); },
    });
    expect(r).toEqual({ terminated: true, escalated: false, errors: [] });
  });

  test('EPERM is reported in errors, not thrown', async () => {
    const r = await terminateTree({ pid: 4242 }, {
      group: false, graceMs: 20,
      sendSignal: () => { const e: NodeJS.ErrnoException = new Error('x'); e.code = 'EPERM'; throw e; },
    });
    expect(r.terminated).toBe(false);
    expect(r.errors).toEqual(['SIGTERM: EPERM']);
  });
});

describe('file-engine timeout leaves no descendants', () => {
  test('grandchild of a timed-out command is killed', async () => {
    const engine = createFileCaptureEngine();
    const ctx = {} as RunCtx;
    const h = engine.run({ command: 'sleep 300 & echo $!; wait', timeoutMs: LOGIN_SHELL_TIMEOUT_MS }, ctx);
    const r = await h.result;
    const m = /^(\d+)/.exec(r.stdout.text.trim());
    expect(m).not.toBeNull();
    const gpid = Number(m![1]);
    created.push(gpid);
    expect(r.outcome).toBe('timeout');
    expect(await waitDead(gpid, 4000)).toBe(true);
  }, 30_000);
});

describe('file-engine kill(SIGKILL) takes the whole group', () => {
  for (const sig of ['SIGKILL', 'SIGTERM'] as const) {
    test(`${sig}: grandchild dies with the root`, async () => {
      const engine = createFileCaptureEngine();
      const ctx = {} as RunCtx;
      const h = engine.run({ command: 'sleep 300 & echo $!; wait', timeoutMs: 60_000 }, ctx);
      let seen = '';
      const gpid = await new Promise<number>((res) => {
        h.onChunk((c) => { seen += c.bytes; const m = /^(\d+)/m.exec(seen); if (m) res(Number(m[1])); });
      });
      created.push(gpid);
      expect(alive(gpid)).toBe(true);
      h.kill(sig);
      const r = await h.result;
      expect(r.outcome).toBe('aborted');
      expect(await waitDead(gpid, 4000)).toBe(true);
    }, 30_000);
  }
});

describe('terminateTree pidFallback (KILL-TREE-ONE call-site migration)', () => {
  test('group address gone (ESRCH) → signals the exact pid, reports terminated after the pid is gone', async () => {
    const calls: Array<[number, string | number]> = [];
    let pidAlive = true;
    const sendSignal = (pid: number, sig: NodeJS.Signals | 0) => {
      calls.push([pid, sig]);
      if (pid < 0) throw Object.assign(new Error('no group'), { code: 'ESRCH' });
      if (sig === 0) { if (!pidAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return; }
      pidAlive = false;
    };
    const r = await terminateTree({ pid: 4321 }, { group: true, pidFallback: true, graceMs: 200, sendSignal });
    expect(r).toEqual({ terminated: true, escalated: false, errors: [] });
    expect(calls[0]).toEqual([-4321, 'SIGTERM']);
    expect(calls[1]).toEqual([4321, 'SIGTERM']);
  });
  test('without pidFallback an ESRCH group is "already gone" and the pid is never signalled', async () => {
    const calls: number[] = [];
    const sendSignal = (pid: number) => { calls.push(pid); throw Object.assign(new Error('no group'), { code: 'ESRCH' }); };
    const r = await terminateTree({ pid: 4321 }, { group: true, graceMs: 100, sendSignal });
    expect(r.terminated).toBe(true);
    expect(calls).toEqual([-4321]);
  });
  test('pidFallback never widens beyond the validated pid (pid <= 1 uses the fallback kill, no signal sent)', async () => {
    const calls: number[] = [];
    const r = await terminateTree({ pid: 1, kill: () => true }, { group: true, pidFallback: true, graceMs: 50, sendSignal: (p) => { calls.push(p); } });
    expect(calls).toEqual([]);
    expect(r.terminated).toBe(false);
  });
});
