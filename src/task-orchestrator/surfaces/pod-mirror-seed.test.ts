import { describe, expect, test } from 'bun:test';
import { GATE_POOL_MIRROR_PATH, resetMirrorSeedMemo, resolveDefaultSourceHead, seedMirrorOnce, seedPoolMirrors } from './pod-mirror-seed.js';

const sha = 'e1783835d5b719e397b697452d1c2fe358b7c3f1';

describe('GATE-WARM-BOOT seedPoolMirrors', () => {
  test('pushes the cut commit to each distinct member mirror as refs/elanous/gate/<sha>', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const results = await seedPoolMirrors({ hosts: ['node-b', 'node-c', 'node-b', undefined], commit: sha, tree: '/tmp/cut',
      push: async (args, cwd) => { calls.push({ args, cwd }); return { rc: 0, output: '' }; } });
    const firstHost = 'node-b';
    const secondHost = 'node-c';
    expect(calls.map((call) => call.args)).toEqual([
      ['push', '--quiet', '--no-verify', `${firstHost}:${GATE_POOL_MIRROR_PATH}`, `${sha}:refs/elanous/gate/${sha}`],
      ['push', '--quiet', '--no-verify', `${secondHost}:${GATE_POOL_MIRROR_PATH}`, `${sha}:refs/elanous/gate/${sha}`],
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

describe('SI-SEED-DEFAULT resolveDefaultSourceHead', () => {
  const tip = 'd'.repeat(40);
  const git = (answers: Record<string, { rc: number; output?: string } | Array<{ rc: number; output?: string }>>) => {
    const calls: string[][] = [];
    const seen: Record<string, number> = {};
    const fn = async (args: string[]) => {
      calls.push(args);
      const answer = answers[args[0]!];
      if (!answer) throw new Error(`unexpected git ${args[0]}`);
      const pick = Array.isArray(answer) ? answer[Math.min((seen[args[0]!] = (seen[args[0]!] ?? -1) + 1), answer.length - 1)]! : answer;
      return { rc: pick.rc, output: pick.output ?? '' };
    };
    return { calls, fn };
  };

  test('resolves refs/heads/<base> (main by default) and uses the local commit without fetching', async () => {
    const g = git({ 'ls-remote': { rc: 0, output: `${tip}\trefs/heads/main\n` }, 'cat-file': { rc: 0 } });
    expect(await resolveDefaultSourceHead({ repoUrl: 'https://example.invalid/r', cwd: '/t', git: g.fn })).toEqual({ sha: tip, originCalls: 1 });
    expect(g.calls).toEqual([['ls-remote', '--', 'https://example.invalid/r', 'refs/heads/main'], ['cat-file', '-e', `${tip}^{commit}`]]);
    const b = git({ 'ls-remote': { rc: 0, output: `${tip}\trefs/heads/bench/x\n` }, 'cat-file': { rc: 0 } });
    await resolveDefaultSourceHead({ repoUrl: 'u', base: 'bench/x', cwd: '/t', git: b.fn });
    expect(b.calls[0]).toEqual(['ls-remote', '--', 'u', 'refs/heads/bench/x']);
  });

  test('a commit missing from the seeding tree is fetched by sha (objects only); every miss is a reason, never a throw', async () => {
    const fetched = git({ 'ls-remote': { rc: 0, output: `${tip}\trefs/heads/main\n` }, 'cat-file': [{ rc: 1 }, { rc: 0 }], fetch: { rc: 0 } });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: fetched.fn })).toEqual({ sha: tip, originCalls: 2 });
    expect(fetched.calls[2]).toEqual(['fetch', '--quiet', '--no-write-fetch-head', '--', 'u', tip]);
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: git({ 'ls-remote': { rc: 128 } }).fn })).toEqual({ reason: 'ls-remote-failed', originCalls: 1 });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: git({ 'ls-remote': { rc: 0, output: '' } }).fn })).toEqual({ reason: 'ls-remote-no-sha', originCalls: 1 });
    // Only the exact ref counts: a longer branch name listed first is not `main`.
    const other = 'e'.repeat(40);
    const exact = git({ 'ls-remote': { rc: 0, output: `${other}\trefs/heads/a/refs/heads/main\n${tip}\trefs/heads/main\n` }, 'cat-file': { rc: 0 } });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: exact.fn })).toEqual({ sha: tip, originCalls: 1 });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: git({ 'ls-remote': { rc: 0, output: `${other}\trefs/heads/a/refs/heads/main\n` } }).fn })).toEqual({ reason: 'ls-remote-no-sha', originCalls: 1 });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: git({ 'ls-remote': { rc: 0, output: `${tip}\trefs/heads/main\n` }, 'cat-file': { rc: 1 }, fetch: { rc: 1 } }).fn })).toEqual({ reason: 'commit-fetch-failed', originCalls: 2 });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: git({ 'ls-remote': { rc: 0, output: `${tip}\trefs/heads/main\n` }, 'cat-file': { rc: 1 }, fetch: { rc: 0 } }).fn })).toEqual({ reason: 'commit-not-local', originCalls: 2 });
    expect(await resolveDefaultSourceHead({ repoUrl: 'u', cwd: '/t', git: async () => { throw new Error('spawn'); } })).toEqual({ reason: 'resolve-threw', originCalls: 1 });
    for (const base of ['-x', 'a b', 'x;rm']) expect(await resolveDefaultSourceHead({ repoUrl: 'u', base, cwd: '/t', git: git({}).fn })).toEqual({ reason: 'invalid-ref', originCalls: 0 });
  });
});
