// RELEASE-PWA-NODE-RESILIENCE ① — the pwa node runs its suite on an SSH host and the host's JSON reaches the ledger.
// Device: `withFakeBins` (src/ux-sim/fake-bin.ts) — a fake `ssh` and a fake `git push`; every other git call is real.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFakeBins } from '../../src/ux-sim/fake-bin.js';
import { pwaNodeArgs } from './node-verdict.js';
import { checkPwaRemote, PWA_REMOTE_LIMIT_SECONDS, PWA_REMOTE_TIMEOUT_MS, remoteRunScript, runPwaRemote, type PwaRemoteSpawn } from './pwa-remote.js';
import { buildReleaseRunInput } from './unattended-release.js';
import { parseArgs } from './pwa-scenarios-node.js';

const REPO = join(import.meta.dir, '../..');
const REAL_GIT = Bun.which('git')!;
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const HOST_JSON = JSON.stringify({ verdict: 'flaky', commit: SHA, withCostly: true, cells: [
  { id: 'T1b', first: 'fail', reruns: ['pass'], final: 'flaky' },
  { id: 'N5a', first: 'pass', reruns: [], final: 'pass' },
] });
const fakeGitPush = { whenArgsStartWith: ['push'], otherwise: REAL_GIT };

test('remote run: ssh → push → one ssh run; the host JSON is the node output (executor host)', async () => {
  await withFakeBins({ ssh: { stdout: `[pwa-node] build ${SHA}\n${HOST_JSON}\n`, stderr: 'remote progress\n' }, git: fakeGitPush }, (bins) => {
    const result = runPwaRemote({ host: 'node-b', commit: SHA, withCostly: true, reruns: 2, repo: REPO });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ verdict: 'flaky', executor: 'host', host: 'node-b', commit: SHA });
    expect((result.output.cells as Array<{ id: string }>).map((c) => c.id)).toEqual(['T1b', 'N5a']);
    const calls = bins.calls();
    expect(calls.map((c) => `${c.name} ${c.argv[0]}`)).toEqual(['ssh --', 'git push', 'ssh --']);
    expect(calls[0]!.argv[1]).toBe('node-b');
    expect(calls[1]!.argv.slice(3, 5)).toEqual(['--', 'node-b:mirror/elanous-agent.git']);
    expect(calls[1]!.argv).toContain(`node-b:mirror/elanous-agent.git`);
    expect(calls[1]!.argv).toContain(`${SHA}:refs/elanous/pwa/${SHA}`);
    const script = calls[2]!.argv[2]!;
    expect(script).toContain('pwa-scenarios-node.ts');
    expect(script).toContain('--with-costly');
    expect(script).not.toContain('--remote'); // the host runs the local mode — no recursion
  });
});

test('unreachable host: error with the ssh words, exit 2, nothing pushed, no local fallback', async () => {
  const sshWords = 'ssh: connect to host node-b port 22: Operation timed out';
  await withFakeBins({ ssh: { stderr: `${sshWords}\n`, exitCode: 255 }, git: fakeGitPush, bun: { stdout: 'LOCAL FALLBACK' } }, (bins) => {
    const result = runPwaRemote({ host: 'node-b', commit: SHA, withCostly: false, reruns: 2, repo: REPO });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatchObject({ verdict: 'error', executor: 'host', host: 'node-b', cells: [], remote: { stage: 'mirror', rc: 255 } });
    expect(String(result.output.error)).toContain(sshWords);
    expect(String(result.output.error)).toContain('폴백하지 않는다');
    expect(bins.calls().map((c) => c.name)).toEqual(['ssh']);
  });
});

test('remote run stage failure keeps stage and tail; a remote fail verdict is exit 1', () => {
  const seen: string[] = [];
  const spawnWith = (run: { rc: number; stdout: string; stderr: string }): PwaRemoteSpawn => (cmd, args) => {
    seen.push(`${cmd} ${args[1]}`);
    return cmd === 'ssh' && seen.filter((s) => s.startsWith('ssh')).length === 2 ? run : { rc: 0, stdout: '', stderr: '' };
  };
  const broken = runPwaRemote({ host: 'node-b', commit: SHA, withCostly: false, reruns: 2, repo: REPO },
    spawnWith({ rc: 2, stdout: '', stderr: 'error: lockfile had changes, but lockfile is frozen' }));
  expect(broken.exitCode).toBe(2);
  expect(broken.output).toMatchObject({ verdict: 'error', remote: { stage: 'run', rc: 2 } });
  expect(String(broken.output.error)).toContain('lockfile is frozen');

  seen.length = 0;
  const failed = runPwaRemote({ host: 'node-b', commit: SHA, withCostly: false, reruns: 2, repo: REPO },
    spawnWith({ rc: 1, stdout: `${JSON.stringify({ verdict: 'fail', cells: [{ id: 'T1b', first: 'fail', reruns: ['fail', 'fail'], final: 'fail' }] })}\n`, stderr: '' }));
  expect(failed.exitCode).toBe(1);
  expect(failed.output).toMatchObject({ verdict: 'fail', host: 'node-b', executor: 'host' });
});

test('entry point: `pwa-scenarios-node.ts --remote` prints the host verdict as its last JSON line', async () => {
  await withFakeBins({ ssh: { stdout: `${HOST_JSON}\n` }, git: fakeGitPush }, (bins) => {
    const run = spawnSync('bun', ['scripts/release-loop/pwa-scenarios-node.ts', '--commit', SHA, '--with-costly', '--json', '--remote', 'node-b'],
      { cwd: REPO, env: bins.env, encoding: 'utf8', timeout: 90_000 });
    expect(run.status).toBe(0);
    const last = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(last).toMatchObject({ verdict: 'flaky', executor: 'host', host: 'node-b' });
    expect(bins.calls().filter((c) => c.name === 'ssh')).toHaveLength(2);
  });
}, 120_000);

test('release.loop.pwaRemote is the one setting: absent = today argv, set = --remote', () => {
  expect(pwaNodeArgs(SHA, {})).toEqual(['scripts/release-loop/pwa-scenarios-node.ts', '--commit', SHA, '--with-costly', '--json']);
  expect(pwaNodeArgs(SHA, { pwaRemote: ' node-b ' })).toEqual(['scripts/release-loop/pwa-scenarios-node.ts', '--commit', SHA, '--with-costly', '--json', '--remote', 'node-b']);
  expect(() => pwaNodeArgs(SHA, { pwaRemote: '' })).toThrow('release.loop.pwaRemote');
});

test('host and mirror are validated before anything spawns', () => {
  expect(() => checkPwaRemote('node-b; rm -rf /', undefined)).toThrow('invalid pwa remote host');
  // option injection: ssh/git would read these as options
  expect(() => checkPwaRemote('-v', undefined)).toThrow('leading «-»');
  expect(() => checkPwaRemote('-oProxyCommand=x', undefined)).toThrow('leading «-»');
  expect(() => parseArgs(['--commit', SHA, '--remote', '-oProxyCommand=x'])).toThrow('leading «-»');
  expect(() => checkPwaRemote('node-b', '~/../etc')).toThrow('invalid pwa remote mirror');
  expect(() => parseArgs(['--commit', SHA, '--remote-mirror', '/m.git'])).toThrow('--remote-mirror requires --remote');
  expect(parseArgs(['--commit', SHA, '--remote', 'user@node-b'])).toMatchObject({ remote: 'user@node-b' });
  expect(remoteRunScript({ commit: SHA, mirror: '/srv/m.git', withCostly: false, reruns: 0 })).toContain('git clone --quiet --shared --no-checkout');
});

test('commit must be a full 40-hex sha: anything else is an input error before any spawn', () => {
  const spawned: string[] = [];
  const result = runPwaRemote({ host: 'node-b', commit: 'abcdef1', withCostly: false, reruns: 2, repo: REPO }, (cmd) => { spawned.push(cmd); return { rc: 0, stdout: '', stderr: '' }; });
  expect(result.exitCode).toBe(2);
  expect(result.output).toMatchObject({ verdict: 'error', executor: 'host', host: 'node-b', remote: { stage: 'input' } });
  expect(String(result.output.error)).toContain('40-hex');
  expect(spawned).toEqual([]);
});

test('remote script: host limit shorter than the local backstop · cleanup traps · own mirror ref deleted', () => {
  const script = remoteRunScript({ commit: SHA, mirror: '~/mirror/elanous-agent.git', withCostly: false, reruns: 2 });
  expect(PWA_REMOTE_LIMIT_SECONDS * 1000).toBeLessThan(PWA_REMOTE_TIMEOUT_MS);
  expect(script).toContain(`setpgrp(0, 0)`);
  expect(script).toContain(`kill 9, -$pid`);
  expect(script).toContain(`exit 124`);
  expect(script).toContain(`${PWA_REMOTE_LIMIT_SECONDS} "$@"`);
  for (const signal of ['EXIT', 'HUP', 'INT', 'TERM']) expect(script).toMatch(new RegExp(`trap '[^']*cleanup[^']*' ${signal}$`, 'm'));
  expect(script).toContain(`update-ref -d 'refs/elanous/pwa/${SHA}'`);
});

test('remote limit starts after child group setup, even when setup is delayed past the limit', () => {
  const script = remoteRunScript({ commit: SHA, mirror: '/tmp/mirror.git', withCostly: false, reruns: 0, limitSeconds: 1 });
  const limit = script.split('\n').find((line) => line.startsWith('lim() {'))!;
  // Inject two seconds of scheduling delay before setpgrp. An alarm armed at fork would fire
  // before the group exists, miss kill(-pid), and let the command write the marker.
  const delayed = limit.replace('defined(setpgrp(0, 0))', 'sleep 2; defined(setpgrp(0, 0))');
  expect(delayed).not.toBe(limit);
  const root = mkdtempSync(join(tmpdir(), 'pwa-group-ready-'));
  try {
    const marker = join(root, 'survived');
    const run = spawnSync('sh', ['-c', `${delayed}\nlim sh -c 'sleep 8; echo survived > ${marker}'`], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(124);
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25_000);

test('remote script really runs: the limit stops a hung node, the temp clone and the mirror ref are gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pwa-remote-script-'));
  try {
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const src = join(root, 'src');
    mkdirSync(join(src, 'apps/pwa'), { recursive: true });
    writeFileSync(join(src, 'apps/pwa/.keep'), '');
    git(root, 'init', '--quiet', src);
    git(src, 'add', '.');
    git(src, 'commit', '--quiet', '-m', 'seed');
    const sha = git(src, 'rev-parse', 'HEAD');
    const mirror = join(root, 'mirror.git');
    git(root, 'init', '--quiet', '--bare', mirror);
    git(src, 'push', '--quiet', mirror, `${sha}:refs/elanous/pwa/${sha}`);
    const tmp = join(root, 'tmp');
    mkdirSync(tmp);
    // `bun install` succeeds at once; the node itself hangs — the host limit must stop it.
    // A distinct sleep duration makes a surviving grandchild visible after the shell exits.
    await withFakeBins({ bun: { whenArgsStartWith: ['scripts/release-loop/pwa-scenarios-node.ts'], otherwise: '/usr/bin/true', sleepSeconds: 3777 }, mktemp: { stdout: `${join(tmp, 'pwa-node-remote-x')}\n` } }, (bins) => {
      mkdirSync(join(tmp, 'pwa-node-remote-x'));
      const script = remoteRunScript({ commit: sha, mirror, withCostly: false, reruns: 0, limitSeconds: 2 });
      const started = Date.now();
      const run = spawnSync('sh', ['-c', script], { cwd: root, env: { ...bins.env, HOME: root, PATH: `${bins.dir}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin` }, encoding: 'utf8', timeout: 40_000 });
      expect(run.status).toBe(124);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(existsSync(join(tmp, 'pwa-node-remote-x'))).toBe(false);
      const processes = spawnSync('ps', ['-A', '-o', 'stat=', '-o', 'comm=', '-o', 'args='], { encoding: 'utf8' }).stdout;
      expect(processes.split('\n').filter((line) => /^\s*[^Z\s]\S*\s+\S*sleep\s+sleep 3777(?:\s|$)/.test(line))).toEqual([]);
      const refs = spawnSync(REAL_GIT, ['--git-dir', mirror, 'show-ref'], { encoding: 'utf8' });
      expect(refs.stdout).not.toContain(`refs/elanous/pwa/${sha}`);
      expect(bins.calls().some((c) => c.name === 'bun' && c.argv.includes('scripts/release-loop/pwa-scenarios-node.ts'))).toBe(true);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('config → argv: buildReleaseRunInput({ pwaRemote }) reaches pwaNodeArgs as --remote', () => {
  const ledger = mkdtempSync(join(tmpdir(), 'pwa-remote-ledger-'));
  try {
    mkdirSync(join(ledger, 'release', '0.2.35'), { recursive: true });
    writeFileSync(join(ledger, 'release', '0.2.35', 'release.json'), JSON.stringify({ version: '0.2.35', publishedAt: '2026-10-20T06:00:00Z' }));
    const input = buildReleaseRunInput('0.2.36', { ledgerRoot: ledger, config: { gatePodPool: 'k3d-elanous-pool:4', pwaRemote: 'node-b' } });
    expect(input.pwaRemote).toBe('node-b');
    expect(pwaNodeArgs(SHA, input as unknown as Record<string, unknown>)).toEqual(['scripts/release-loop/pwa-scenarios-node.ts', '--commit', SHA, '--with-costly', '--json', '--remote', 'node-b']);
    const without = buildReleaseRunInput('0.2.36', { ledgerRoot: ledger, config: { gatePodPool: 'k3d-elanous-pool:4' } });
    expect(pwaNodeArgs(SHA, without as unknown as Record<string, unknown>)).not.toContain('--remote');
  } finally { rmSync(ledger, { recursive: true, force: true }); }
});
