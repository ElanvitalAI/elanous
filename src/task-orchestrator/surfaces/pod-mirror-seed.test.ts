import { describe, expect, test } from 'bun:test';
import { GATE_POOL_MIRROR_PATH, resetMirrorSeedMemo, seedMirrorOnce, seedPoolMirrors } from './pod-mirror-seed.js';

const sha = 'e1783835d5b719e397b697452d1c2fe358b7c3f1';

describe('GATE-WARM-BOOT seedPoolMirrors', () => {
  test('pushes the cut commit to each distinct member mirror as refs/elanous/gate/<sha>', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const results = await seedPoolMirrors({ hosts: ['node-b', 'node-c', 'node-b', undefined], commit: sha, tree: '/tmp/cut',
      push: async (args, cwd) => { calls.push({ args, cwd }); return { rc: 0, output: '' }; } });
    expect(calls.map((call) => call.args)).toEqual([
      ['push', '--quiet', '--no-verify', `node-b:${GATE_POOL_MIRROR_PATH}`, `${sha}:refs/elanous/gate/${sha}`],
      ['push', '--quiet', '--no-verify', `node-c:${GATE_POOL_MIRROR_PATH}`, `${sha}:refs/elanous/gate/${sha}`],
    ]);
    expect(calls.every((call) => call.cwd === '/tmp/cut')).toBe(true);
    expect(results.map((result) => [result.host, result.ok])).toEqual([['node-b', true], ['node-c', true]]);
  });

  test('a failed or throwing push is recorded, never thrown — the Pod keeps its GitHub fetch path', async () => {
    const results = await seedPoolMirrors({ hosts: ['node-b', 'node-c'], commit: sha, tree: '/tmp/cut',
      push: async (args) => { if (args[3]!.startsWith('node-b')) return { rc: 128, output: 'fatal: no such repo' }; throw new Error('ssh down'); } });
    expect(results).toMatchObject([{ host: 'node-b', ok: false, detail: 'fatal: no such repo' }, { host: 'node-c', ok: false }]);
    expect(results[1]!.detail).toContain('ssh down');
  });

  test('rejects option-like hosts and a non-sha commit', async () => {
    const calls: string[][] = [];
    await seedPoolMirrors({ hosts: ['-oProxyCommand=x', 'ok-host'], commit: sha, tree: '/t', push: async (args) => { calls.push(args); return { rc: 0, output: '' }; } });
    expect(calls.map((args) => args[3])).toEqual([`ok-host:${GATE_POOL_MIRROR_PATH}`]);
    await expect(seedPoolMirrors({ hosts: ['node-b'], commit: 'HEAD', tree: '/t', push: async () => ({ rc: 0, output: '' }) })).rejects.toThrow('invalid gate commit');
  });

  test('seedMirrorOnce pushes once per host·commit however many Jobs await it', async () => {
    resetMirrorSeedMemo();
    let pushes = 0;
    const push = async () => { pushes += 1; await new Promise((r) => setTimeout(r, 5)); return { rc: 0, output: '' }; };
    const all = await Promise.all([1, 2, 3].map(() => seedMirrorOnce({ host: 'node-b', commit: sha, cwd: '/r', push })));
    await seedMirrorOnce({ host: 'node-c', commit: sha, cwd: '/r', push });
    expect(pushes).toBe(2);
    expect(all.every((result) => result?.ok)).toBe(true);
    resetMirrorSeedMemo();
  });

  test('a failed seed is not memoized and an invalid commit resolves ok:false instead of throwing', async () => {
    resetMirrorSeedMemo();
    let pushes = 0;
    const failing = async () => { pushes += 1; return { rc: 128, output: 'ssh: connect timed out' }; };
    expect((await seedMirrorOnce({ host: 'node-b', commit: sha, cwd: '/r', push: failing }))?.ok).toBe(false);
    expect((await seedMirrorOnce({ host: 'node-b', commit: sha, cwd: '/r', push: failing }))?.ok).toBe(false);
    expect(pushes).toBe(2);
    expect(await seedMirrorOnce({ host: 'node-b', commit: 'HEAD', cwd: '/r', push: failing })).toMatchObject({ ok: false, detail: expect.stringContaining('invalid gate commit') });
    resetMirrorSeedMemo();
  });
});
