// GH-PROXY-LAYER kit — policy · cacheable / scope rules · real-gh resolution · the transparent door over a fake gh · mirror setup
// refusals. Expected values are literals (exit codes · call logs · keys), never re-derived from the kit.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyGhCall, parseGhGovernorPolicy, ghGovernorPolicyPath, type GovernorDeps } from '../gh-governor/index.js';
import { isCacheableRead, isGhShim, readScope, resolveRealGh, runGhDoor, type DoorIo } from './door.js';
import { realGit, setupMirror, type MirrorDeps } from './mirror.js';
import { ghProxyPolicyPath, parseGhProxyPolicy } from './policy.js';

const REPO = resolve(import.meta.dir, '../../..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gh-proxy-kit-')); dirs.push(d); return d; };
const proxyPolicy = () => parseGhProxyPolicy(readFileSync(ghProxyPolicyPath(REPO), 'utf8'));
const govPolicy = () => parseGhGovernorPolicy(readFileSync(ghGovernorPolicyPath(REPO), 'utf8'));

function fakeGh(root: string): { bin: string; calls: () => string[] } {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in\n  auth) echo "auth ok"; exit 0;;\n  pr) case "$2" in view) echo "view $3"; exit 0;; ready) echo "readied" >&2; exit 0;; esac;;\n  api) echo "boom" >&2; exit 4;;\nesac\nexit 9\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [] };
}
function capture(tty = false): DoorIo & { o: string; e: string } {
  const io = { o: '', e: '', stdoutIsTTY: tty, out: (b: Buffer) => { io.o += b.toString(); }, err: (b: Buffer) => { io.e += b.toString(); } };
  return io;
}

describe('gh-proxy policy', () => {
  test('the shipped YAML parses', () => {
    const p = proxyPolicy();
    expect(p.shim.readCacheSec).toBe(20);
    expect(p.mirror.refreshMinIntervalSec).toBe(60);
    expect(p.mirror.refspecs).toEqual(['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*', '+refs/pull/*/head:refs/pull/*/head']);
  });
  test('a broken refspec or number is refused', () => {
    const text = readFileSync(ghProxyPolicyPath(REPO), 'utf8');
    expect(() => parseGhProxyPolicy(text.replace("'+refs/tags/*:refs/tags/*'", "'refs/tags'"))).toThrow('mirror.refspecs');
    expect(() => parseGhProxyPolicy(text.replace(/refresh_min_interval_sec: \d+/, 'refresh_min_interval_sec: 0'))).toThrow('refresh_min_interval_sec');
  });
});

describe('cacheable reads and their scope', () => {
  test('reads are cacheable; writes, meta, watch, web and terminals are not', () => {
    const ok = (a: string[], tty = false) => isCacheableRead(classifyGhCall(a), a, tty);
    expect(ok(['pr', 'view', '7', '--json', 'state'])).toBe(true);
    expect(ok(['api', 'repos/o/r/compare/a...b'])).toBe(true);
    expect(ok(['pr', 'view', '7'], true)).toBe(false);
    expect(ok(['pr', 'ready', '7'])).toBe(false);
    expect(ok(['auth', 'status'])).toBe(false);
    expect(ok(['pr', 'checks', '7', '--watch'])).toBe(false);
    expect(ok(['run', 'watch', '12'])).toBe(false);
    expect(ok(['pr', 'view', '7', '--web'])).toBe(false);
    expect(ok(['api', '-X', 'POST', 'repos/o/r/issues'])).toBe(false);
  });
  test('repository scope is shared across worktrees; the current branch makes it per checkout', () => {
    const common = () => '/hq/repo.git';
    expect(readScope(['pr', 'view', '7'], '/hq/seats/A', {}, common)).toBe('git:/hq/repo.git');
    expect(readScope(['pr', 'view', '7'], '/hq/seats/B', {}, common)).toBe('git:/hq/repo.git');
    expect(readScope(['pr', 'view', '--json', 'state'], '/hq/seats/A', {}, common)).toBe('cwd:/hq/seats/A');
    expect(readScope(['pr', 'status'], '/hq/seats/A', {}, common)).toBe('cwd:/hq/seats/A');
    expect(readScope(['pr', 'list', '--repo', 'Acme/Widget'], '/x', {}, common)).toBe('repo:acme/widget');
    expect(readScope(['pr', 'list'], '/x', { GH_REPO: 'acme/widget' }, common)).toBe('repo:acme/widget');
    expect(readScope(['pr', 'list'], '/x', {}, () => null)).toBe('cwd:/x');
  });
});

describe('real gh resolution', () => {
  test('a shim on PATH is skipped; ELN_GH_REAL wins when it is real', () => {
    const root = tmp();
    const shimDir = join(root, 'shim'); mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'gh'), readFileSync(join(REPO, 'bin', 'gh-shim', 'gh')));
    chmodSync(join(shimDir, 'gh'), 0o755);
    const { bin } = fakeGh(root);
    expect(isGhShim(join(shimDir, 'gh'))).toBe(true);
    expect(isGhShim(join(bin, 'gh'))).toBe(false);
    expect(resolveRealGh({ PATH: `${shimDir}:${bin}` })).toBe(join(bin, 'gh'));
    expect(resolveRealGh({ PATH: `${shimDir}:${bin}`, ELN_GH_REAL: join(shimDir, 'gh') })).toBe(join(bin, 'gh'));
    expect(resolveRealGh({ PATH: shimDir })).toBeNull();
  });
});

describe('the transparent door', () => {
  const setup = () => {
    const root = tmp();
    const gh = fakeGh(root);
    let now = Date.parse('2026-11-28T12:00:00.000Z');
    const gov: GovernorDeps = { stateRoot: join(root, 'state'), now: () => now, seat: 'HAND-A', policy: govPolicy() };
    const env = { PATH: `${gh.bin}:/usr/bin:/bin` };
    return { root, gh, gov, env, tick: (ms: number) => { now += ms; } };
  };

  test('an identical read inside read_cache_sec is answered from the cache; after it, GitHub again', async () => {
    const { gh, gov, env, tick } = setup();
    const opts = { env, cwd: '/x', governor: gov, policy: proxyPolicy(), commonDir: () => null };
    const a = capture(); const b = capture(); const c = capture();
    expect(await runGhDoor(['pr', 'view', '7', '--json', 'state'], { ...opts, io: a })).toBe(0);
    tick(5_000);
    expect(await runGhDoor(['pr', 'view', '7', '--json', 'state'], { ...opts, io: b })).toBe(0);
    tick(21_000);
    expect(await runGhDoor(['pr', 'view', '7', '--json', 'state'], { ...opts, io: c })).toBe(0);
    expect([a.o, b.o, c.o]).toEqual(['view 7\n', 'view 7\n', 'view 7\n']);
    expect(gh.calls()).toEqual(['pr view 7 --json state', 'pr view 7 --json state']);
  });

  test('exit codes and stderr pass through; a failure is never cached; writes are never cached', async () => {
    const { gh, gov, env } = setup();
    const opts = { env, cwd: '/x', governor: gov, policy: proxyPolicy(), commonDir: () => null };
    const f1 = capture(); const f2 = capture(); const w1 = capture(); const w2 = capture();
    expect(await runGhDoor(['api', 'repos/o/r/pulls/1'], { ...opts, io: f1 })).toBe(4);
    expect(await runGhDoor(['api', 'repos/o/r/pulls/1'], { ...opts, io: f2 })).toBe(4);
    expect(f1.e).toBe('boom\n');
    expect(await runGhDoor(['pr', 'ready', '7'], { ...opts, io: w1 })).toBe(0);
    expect(await runGhDoor(['pr', 'ready', '7'], { ...opts, io: w2 })).toBe(0);
    expect(w1.e).toBe('readied\n');
    expect(gh.calls()).toEqual(['api repos/o/r/pulls/1', 'api repos/o/r/pulls/1', 'pr ready 7', 'pr ready 7']);
  });

  test('during a cooldown a read is refused without a call; auth status still passes through', async () => {
    const { gh, gov, env } = setup();
    mkdirSync(join(gov.stateRoot, 'gh-governor'), { recursive: true });
    writeFileSync(join(gov.stateRoot, 'gh-governor', 'cooldown.json'), JSON.stringify({ until: gov.now() + 60_000, at: gov.now(), durationSec: 60, reason: 'secondary rate limit', seat: 'JUD', label: 'pr list', hits: 1 }));
    const v = capture();
    expect(await runGhDoor(['pr', 'view', '7'], { env, cwd: '/x', governor: gov, policy: proxyPolicy(), io: v })).toBe(75);
    expect(v.o).toBe('');
    expect(v.e.startsWith('[gh-governor] SKIPPED pr view · GitHub cooldown until ')).toBe(true);
    expect(gh.calls()).toEqual([]);
    // auth is meta: stdio inherited (not captured here) — the call itself is what matters.
    expect(await runGhDoor(['auth', 'status'], { env, cwd: '/x', governor: gov, policy: proxyPolicy(), io: capture() })).toBe(0);
    expect(gh.calls()).toEqual(['auth status']);
  });

  test('no real gh → 127 with one line', async () => {
    const io = capture();
    expect(await runGhDoor(['pr', 'view', '1'], { env: { PATH: '/nonexistent' }, governor: null, policy: null, io })).toBe(127);
    expect(io.e).toBe('[gh-door] real gh not found on PATH (gh shims skipped) — install gh or fix PATH\n');
  });
});

describe('mirror setup refusals', () => {
  test('an explicit pushurl that the insteadOf would rewrite is refused; push stays GitHub otherwise', () => {
    const root = tmp();
    const consumer = join(root, 'seat.git');
    realGit(['init', '--quiet', '--bare', consumer]);
    realGit(['--git-dir', consumer, 'remote', 'add', 'origin', 'https://github.invalid/acme/widget.git']);
    realGit(['--git-dir', consumer, 'config', 'remote.origin.pushurl', 'https://github.invalid/acme/widget.git']);
    const d: MirrorDeps = { stateRoot: join(root, 'state'), policy: proxyPolicy(), now: Date.now, git: realGit, sleep: () => {} };
    const r = setupMirror(d, join(root, 'mirror.git'), 'https://github.invalid/acme/widget.git', [consumer]);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toStartWith(`REFUSE ${consumer}: explicit pushurl would follow the mirror`);
    expect(setupMirror(d, 'relative/mirror.git', 'https://github.invalid/acme/widget.git', [consumer]).lines).toEqual(['REFUSE mirror path must be absolute: relative/mirror.git']);
  });
});
