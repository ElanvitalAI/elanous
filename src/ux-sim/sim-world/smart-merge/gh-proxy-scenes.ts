// SIM-WORLD smart-merge · GH-PROXY-LAYER (0.3.40 P0 · CEO 11-28 21:0x «git 문제가 너무 많이 · proxy 등 기본 조치»).
// Device GH-PROXY-WORLD = temp dirs with
//   · a fake GitHub for git: a bare upstream repository reachable only through the refresher's git runner (it rewrites the
//     GitHub URL to the upstream path and counts every fetch) — a consumer fetch that bypassed the mirror would hit
//     https://github.invalid and fail, so «GitHub fetches» = the runner's count;
//   · a fake gh binary (answers pr view / auth status, logs every call) behind the real PATH shim (bin/gh-shim/gh) and the real
//     `eln gh` door (bin/elanous.mjs → kit/gh-proxy/door.ts) over a temp state root.
// Expected values are literals from the scene (call counts · exit codes · URLs), never re-derived from src/kit/gh-proxy.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mirrorTick, readMirrorState, realGit, setupMirror, type GitRun, type MirrorDeps } from '../../../kit/gh-proxy/mirror.js';
import { ghProxyPolicyPath, parseGhProxyPolicy, type GhProxyPolicy } from '../../../kit/gh-proxy/policy.js';
import { stateDirSourceForChild } from '../../../agent/identity-env.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

export const GH_PROXY_DEVICE = 'GH-PROXY-WORLD';
export interface GhProxyDevice { tmp(): string; disposeAll(): void }

export const ghProxyDevice: SimWorldDeviceDef<GhProxyDevice> = {
  id: GH_PROXY_DEVICE,
  title: 'temp git upstream (fake GitHub · counted fetches) + bare mirror + consumer repos · fake gh behind the real PATH shim and eln gh door',
  create: () => {
    const all: string[] = [];
    return { tmp: () => { const r = mkdtempSync(join(tmpdir(), 'gh-proxy-world-')); all.push(r); return r; }, disposeAll: () => { for (const r of all.splice(0)) rmSync(r, { recursive: true, force: true }); } };
  },
};

const REPO = resolve(import.meta.dir, '../../../..');
const GITHUB = 'https://github.invalid/acme/widget.git';
const T0 = Date.parse('2026-11-28T12:10:00.000Z'); // 21:10 KST
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const policyText = () => readFileSync(ghProxyPolicyPath(REPO), 'utf8');
async function withWorld(ctx: SimWorldScenarioContext, body: (d: GhProxyDevice) => Promise<SimWorldScenarioOutcome>): Promise<SimWorldScenarioOutcome> {
  const d = ctx.device<GhProxyDevice>(GH_PROXY_DEVICE);
  try { return await body(d); } finally { d.disposeAll(); }
}

const git = (args: string[]) => {
  const r = realGit(args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const quietEnv = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };

/** Upstream (fake GitHub) with main + one PR head; returns the commit of main. */
function makeUpstream(root: string, tag: string): { upstream: string; work: string } {
  const upstream = join(root, 'github', 'widget.git');
  const work = join(root, 'author');
  mkdirSync(join(root, 'github'), { recursive: true });
  git(['init', '--quiet', '--bare', '--initial-branch=main', upstream]);
  git(['init', '--quiet', '--initial-branch=main', work]);
  writeFileSync(join(work, 'a.txt'), `one ${tag}\n`);
  git(['-C', work, '-c', 'user.name=sim', '-c', 'user.email=sim@invalid', 'add', 'a.txt']);
  git(['-C', work, '-c', 'user.name=sim', '-c', 'user.email=sim@invalid', 'commit', '--quiet', '-m', 'one']);
  git(['-C', work, 'push', '--quiet', upstream, 'HEAD:refs/heads/main', 'HEAD:refs/pull/7/head']);
  return { upstream, work };
}
function advanceUpstream(work: string, upstream: string, tag: string): string {
  writeFileSync(join(work, 'a.txt'), `two ${tag}\n`);
  git(['-C', work, '-c', 'user.name=sim', '-c', 'user.email=sim@invalid', 'commit', '--quiet', '-am', 'two']);
  git(['-C', work, 'push', '--quiet', upstream, 'HEAD:refs/heads/main']);
  return git(['-C', work, 'rev-parse', 'HEAD']);
}
/** The refresher's git: GitHub URL → the upstream path; every `fetch` of it counted; `down` = GitHub unreachable. */
function fakeGithubGit(upstream: string): { run: GitRun; fetches: () => number; reset(): void; down(v: boolean): void } {
  let n = 0; let isDown = false;
  const run: GitRun = (args, opts) => {
    // Only a fetch talks to GitHub; config values naming the GitHub URL (insteadOf · pushInsteadOf) stay as they are.
    if (!(args.includes(GITHUB) && args.includes('fetch'))) return realGit(args, opts);
    n++;
    if (isDown) return { status: 128, stdout: '', stderr: 'fatal: unable to access \'https://github.invalid/\': Could not resolve host' };
    return realGit(args.map(a => a === GITHUB ? upstream : a), opts);
  };
  return { run, fetches: () => n, reset: () => { n = 0; }, down: (v) => { isDown = v; } };
}
function makeConsumer(root: string, i: number): string {
  const dir = join(root, 'seats', `seat-${i}.git`);
  git(['init', '--quiet', '--bare', dir]);
  git(['--git-dir', dir, 'remote', 'add', 'origin', GITHUB]);
  git(['--git-dir', dir, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);
  return dir;
}
function runP(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const c = spawn(cmd, args, { env, ...(cwd ? { cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    c.once('close', (code) => done({ code, out, err }));
  });
}
const policyWith = (edit: (t: string) => string): GhProxyPolicy => parseGhProxyPolicy(edit(policyText()));

// ── gh shim world ───────────────────────────────────────────────────────────────────────────────────────────────────

interface ShimWorld { env: NodeJS.ProcessEnv; calls: () => string[]; state: string; cwd: string }
function makeShimWorld(root: string): ShimWorld {
  const fakeBin = join(root, 'real-bin'); const elnBin = join(root, 'eln-bin'); const state = join(root, 'state'); const cwd = join(root, 'hand');
  const shimA = join(root, 'shim-a'); const shimB = join(root, 'shim-b');
  for (const d of [fakeBin, elnBin, state, cwd, shimA, shimB]) mkdirSync(d, { recursive: true });
  const log = join(root, 'gh-calls.log');
  writeFileSync(join(fakeBin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in\n  auth) echo "Logged in to github.invalid (fake)"; exit 0;;\n  pr) [ "$2" = view ] && { echo "{\\"number\\":$3,\\"state\\":\\"OPEN\\"}"; exit 0; };;\nesac\necho "unexpected $*" >&2; exit 9\n`);
  chmodSync(join(fakeBin, 'gh'), 0o755);
  writeFileSync(join(elnBin, 'eln'), `#!/bin/sh\nexec '${process.execPath}' '${join(REPO, 'bin', 'elanous.mjs')}' "$@"\n`);
  chmodSync(join(elnBin, 'eln'), 0o755);
  // Two shim copies first on PATH: the shim must skip both (and itself) to find the real gh — never loop.
  for (const d of [shimA, shimB]) { copyFileSync(join(REPO, 'bin', 'gh-shim', 'gh'), join(d, 'gh')); chmodSync(join(d, 'gh'), 0o755); }
  const { ELN_GH_DOOR: _d, ELN_GH_SHIM_ACTIVE: _s, ELN_GH_REAL: _r, ELN_GH_ELN: _e, ...base } = process.env;
  const env = { ...base, PATH: [shimA, shimB, elnBin, fakeBin, '/usr/bin', '/bin'].join(':'), ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: stateDirSourceForChild(state) };
  return { env, state, cwd, calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [] };
}
function writeCooldown(state: string, untilMs: number, atMs: number): void {
  mkdirSync(join(state, 'gh-governor'), { recursive: true });
  writeFileSync(join(state, 'gh-governor', 'cooldown.json'), JSON.stringify({
    until: untilMs, at: atMs, durationSec: Math.round((untilMs - atMs) / 1000), reason: 'GraphQL: API rate limit already exceeded for user ID 1.', seat: 'LAND-STEWARD', label: 'pr list', hits: 1,
  }));
}

export const ghProxyScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SM-GH-MIRROR-20FETCH',
    title: 'GitHub main moves · one mirror refresh · 20 seat repositories fetch at once → GitHub fetches 1, every seat at the new main, push URL still GitHub',
    devices: [GH_PROXY_DEVICE],
    run: (ctx) => withWorld(ctx, async (d) => {
      const root = d.tmp();
      const tag = `s${ctx.seed}`;
      const { upstream, work } = makeUpstream(root, tag);
      const gh = fakeGithubGit(upstream);
      let now = T0;
      const policy = policyWith(t => t.replace(/refreshes_per_tick: \d+/, 'refreshes_per_tick: 1'));
      const deps: MirrorDeps = { stateRoot: join(root, 'state'), policy, now: () => now, git: gh.run, sleep: () => {} };
      const seats = Array.from({ length: 20 }, (_, i) => makeConsumer(root, i));
      const mirror = join(root, 'mirror', 'widget.git');
      const set = setupMirror(deps, mirror, GITHUB, seats);
      if (!set.ok) return fail('setup', set.lines.join(' | '));
      const main2 = advanceUpstream(work, upstream, tag);
      gh.reset();
      now = T0 + (61 + (ctx.seed % 5)) * 1000;
      const tick = mirrorTick(deps);
      const order = seats.map((s, i) => ({ s, i })).sort(() => ctx.random() - 0.5);
      const outs = await Promise.all(order.map(({ s }) => runP('git', ['--git-dir', s, 'fetch', '--quiet', 'origin'], { ...process.env, ...quietEnv })));
      const heads = seats.map(s => realGit(['--git-dir', s, 'rev-parse', 'refs/remotes/origin/main']).stdout.trim());
      const push = realGit(['--git-dir', seats[ctx.seed % 20]!, 'remote', 'get-url', '--push', 'origin']).stdout.trim();
      const pr = realGit(['--git-dir', seats[0]!, 'ls-remote', 'origin', 'refs/pull/7/head']).stdout.trim();
      ctx.recorder.event('smart-merge:gh-mirror-20fetch', { githubFetches: gh.fetches(), tick: tick.outcome, failed: outs.filter(o => o.code !== 0).length, push });
      if (tick.outcome !== 'ok' || tick.refreshes.length !== 1 || !tick.refreshes[0]!.fetched) return fail('tick', JSON.stringify(tick));
      if (outs.some(o => o.code !== 0)) return fail('seat-fetch', JSON.stringify(outs.filter(o => o.code !== 0).map(o => o.err.slice(0, 160))));
      if (gh.fetches() !== 1) return fail('github-fetches', String(gh.fetches()));
      if (!heads.every(h => h === main2)) return fail('heads', JSON.stringify({ main2, heads }));
      if (push !== GITHUB) return fail('push-url', push);
      return /\srefs\/pull\/7\/head$/.test(pr) ? { ok: true } : fail('pr-head-via-mirror', pr);
    }),
  },
  {
    id: 'SM-GH-MIRROR-STALE-FALLBACK',
    title: 'GitHub unreachable for the refresher past stale_fallback_min → every consumer fetches GitHub directly · GitHub back → the next tick restores the mirror',
    devices: [GH_PROXY_DEVICE],
    run: (ctx) => withWorld(ctx, async (d) => {
      const root = d.tmp();
      const { upstream } = makeUpstream(root, `s${ctx.seed}`);
      const gh = fakeGithubGit(upstream);
      let now = T0;
      const policy = policyWith(t => t.replace(/refreshes_per_tick: \d+/, 'refreshes_per_tick: 1').replace(/stale_fallback_min: \d+/, 'stale_fallback_min: 10'));
      const deps: MirrorDeps = { stateRoot: join(root, 'state'), policy, now: () => now, git: gh.run, sleep: () => {} };
      const seats = Array.from({ length: 2 + (ctx.seed % 5) }, (_, i) => makeConsumer(root, i));
      const mirror = join(root, 'mirror', 'widget.git');
      if (!setupMirror(deps, mirror, GITHUB, seats).ok) return fail('setup', 'refused');
      const urlOf = (s: string) => realGit(['--git-dir', s, 'ls-remote', '--get-url', 'origin']).stdout.trim();
      const before = seats.map(urlOf);
      gh.down(true);
      now = T0 + 5 * 60_000; // inside the window: still the mirror
      const t1 = mirrorTick(deps);
      const mid = seats.map(urlOf);
      now = T0 + (11 + (ctx.seed % 3)) * 60_000; // past stale_fallback_min (10)
      const t2 = mirrorTick(deps);
      const fallback = seats.map(urlOf);
      const st2 = readMirrorState(deps.stateRoot);
      gh.down(false);
      now += 2 * 60_000;
      const t3 = mirrorTick(deps);
      const after = seats.map(urlOf);
      ctx.recorder.event('smart-merge:gh-mirror-stale', { t1: t1.outcome, t2: t2.outcome, t3: t3.outcome, fallback: st2?.fallback ?? null });
      if (!before.every(u => u === mirror) || !mid.every(u => u === mirror)) return fail('not-mirror-before', JSON.stringify({ before, mid }));
      if (t1.outcome !== 'fail' || t1.fresh !== true) return fail('t1', JSON.stringify(t1));
      if (t2.outcome !== 'fail' || t2.fresh !== false || !t2.reconcile.every(r => r.change === 'to-github')) return fail('t2', JSON.stringify(t2));
      if (!fallback.every(u => u === GITHUB) || st2?.fallback !== true || !/Could not resolve host/.test(st2.lastError)) return fail('fallback', JSON.stringify({ fallback, st2 }));
      if (t3.outcome !== 'ok' || !t3.reconcile.every(r => r.change === 'to-mirror')) return fail('t3', JSON.stringify(t3));
      return after.every(u => u === mirror) && readMirrorState(deps.stateRoot)?.fallback === false ? { ok: true } : fail('restored', JSON.stringify(after));
    }),
  },
  {
    id: 'SM-GH-SHIM-COOLDOWN-VIEW',
    title: 'hand shell `gh pr view` during the GitHub cooldown → exit 75, one clean line, no GitHub call · `gh auth status` passes through · a door child (ELN_GH_DOOR) is not governed twice',
    devices: [GH_PROXY_DEVICE],
    run: (ctx) => withWorld(ctx, async (d) => {
      const w = makeShimWorld(d.tmp());
      const now = Date.now();
      writeCooldown(w.state, now + (120 + ctx.seed * 30) * 1000, now - 5_000);
      const n = 40000 + ctx.seed;
      const view = await runP('gh', ['pr', 'view', String(n), '--json', 'state'], w.env, w.cwd);
      const afterView = w.calls().length;
      const auth = await runP('gh', ['auth', 'status'], w.env, w.cwd);
      const door = await runP('gh', ['pr', 'view', String(n), '--json', 'state'], { ...w.env, ELN_GH_DOOR: '1' }, w.cwd);
      const calls = w.calls();
      ctx.recorder.event('smart-merge:gh-shim-cooldown', { view: view.code, auth: auth.code, door: door.code, calls });
      if (view.code !== 75 || view.out !== '') return fail('view-not-refused', JSON.stringify({ code: view.code, out: view.out.slice(0, 120) }));
      const lines = view.err.trim().split('\n');
      if (lines.length !== 1 || !lines[0]!.startsWith('[gh-governor] SKIPPED pr view · GitHub cooldown until ')) return fail('view-message', view.err.slice(0, 300));
      if (afterView !== 0) return fail('view-reached-github', JSON.stringify(calls));
      if (auth.code !== 0 || auth.out.trim() !== 'Logged in to github.invalid (fake)') return fail('auth-passthrough', JSON.stringify(auth));
      if (door.code !== 0 || door.out.trim() !== `{"number":${n},"state":"OPEN"}`) return fail('door-child', JSON.stringify(door));
      return JSON.stringify(calls) === JSON.stringify(['auth status', `pr view ${n} --json state`]) ? { ok: true } : fail('calls', JSON.stringify(calls));
    }),
  },
  {
    id: 'SM-GH-SHIM-100-VIEWS',
    title: 'hand shells run `gh pr view N` 100 times in a minute → GitHub reads ≤ 60 / read_cache_sec (one per cache window) · every answer identical',
    devices: [GH_PROXY_DEVICE],
    run: (ctx) => withWorld(ctx, async (d) => {
      const w = makeShimWorld(d.tmp());
      const n = 40100 + ctx.seed;
      const answers: { code: number | null; out: string }[] = [];
      const t0 = Date.now();
      for (let batch = 0; batch < 10; batch++) {
        answers.push(...await Promise.all(Array.from({ length: 10 }, () => runP('gh', ['pr', 'view', String(n), '--json', 'number,state'], w.env, w.cwd))));
      }
      const seconds = (Date.now() - t0) / 1000;
      const calls = w.calls();
      ctx.recorder.event('smart-merge:gh-shim-100', { calls: calls.length, seconds: Math.round(seconds) });
      if (answers.some(a => a.code !== 0 || a.out.trim() !== `{"number":${n},"state":"OPEN"}`)) return fail('answers', JSON.stringify(answers.filter(a => a.code !== 0).slice(0, 3)));
      if (seconds > 60) return fail('too-slow-for-a-minute', String(seconds));
      // read_cache_sec 20 → at most 3 windows in a minute (the scene runs well inside one or two).
      if (calls.length < 1 || calls.length > 3 || !calls.every(c => c === `pr view ${n} --json number,state`)) return fail('github-reads', JSON.stringify(calls));
      return { ok: true };
    }),
  },
];
