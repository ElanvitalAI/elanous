// GATE-WARM-BOOT (10-15) — put the cut commit into each pool host's git mirror before the shard Pods start.
//
// S: 0.2.29 gate Pods spent 750–840 s before the shard shell; the tests took 0–69 s. Every Pod clones from the host
//    mirror (`pod.hostMirror` → `/host-mirror`, podSourceScript), but the cut commit e1783835 was not in the node-b mirror
//    (the mirror's own fetch loop follows `main`; only the `--remote` host executor pushed `refs/elanous/gate/<sha>`).
//    So all 68 Pods fell to `git fetch --depth 1 origin <sha>` from GitHub, under load, one by one.
// A: push `<sha>:refs/elanous/gate/<sha>` to the placed pool member's mirror once per (host, commit) per process — podSourceScript's commit branch
//    then passes `git cat-file -e` and skips the GitHub fetch. Best effort: a failed push is recorded and the Pod keeps
//    its old path (fetch from GitHub) — never a silent use of another tree.
import { spawn } from 'node:child_process';
import { debug } from '../../debug/log.js';

/** Host-side mirror path (relative to the ssh user's home) — the k3d node binds `~/mirror` at `/mirror-host`. */
export const GATE_POOL_MIRROR_PATH = 'mirror/elanous-agent.git';
export const GATE_MIRROR_SEED_LIMIT_MS = 120_000;

export interface MirrorSeedResult { host: string; ok: boolean; ms: number; detail?: string }

type Push = (args: string[], cwd: string, limitMs: number) => Promise<{ rc: number; output: string }>;

export async function seedPoolMirrors(o: { hosts: readonly (string | undefined)[]; commit: string; tree: string; push: Push; mirrorPath?: string; limitMs?: number }): Promise<MirrorSeedResult[]> {
  if (!/^[0-9a-f]{40}$/.test(o.commit)) throw new Error('invalid gate commit');
  const mirror = o.mirrorPath ?? GATE_POOL_MIRROR_PATH;
  const hosts = [...new Set(o.hosts.filter((host): host is string => !!host && /^[\w.@-]+$/.test(host) && !host.startsWith('-')))];
  const results = await Promise.all(hosts.map(async (host): Promise<MirrorSeedResult> => {
    const start = Date.now();
    try {
      const run = await o.push(['push', '--quiet', '--no-verify', `${host}:${mirror}`, `${o.commit}:refs/elanous/gate/${o.commit}`], o.tree, o.limitMs ?? GATE_MIRROR_SEED_LIMIT_MS);
      const ms = Date.now() - start;
      return run.rc === 0 ? { host, ok: true, ms } : { host, ok: false, ms, detail: run.output.trim().slice(-300) };
    } catch (error) {
      return { host, ok: false, ms: Date.now() - start, detail: String(error).slice(0, 300) };
    }
  }));
  for (const result of results) {
    debug.log('release-loop.gate', result.ok ? 'pod-mirror-seeded' : 'pod-mirror-seed-failed', { ...result, commit: o.commit }, result.ok ? undefined : { level: 'warn' });
  }
  return results;
}

const seeded = new Map<string, Promise<MirrorSeedResult | undefined>>();

/** Bounded `git <args>` in `cwd` — killed after `limitMs`; never throws. */
export function gitWithin(args: string[], cwd: string, limitMs: number): Promise<{ rc: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try { child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ rc: 2, output: String(error) }); return; }
    const timer = setTimeout(() => { output += `\n[mirror-seed] timed out after ${limitMs} ms`; child.kill('SIGKILL'); }, limitMs);
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ rc: 2, output: `${output}\n${String(error)}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ rc: code ?? 2, output }); });
  });
}

/**
 * Seed once per (host, commit) in this process: every shard Job placed on the same member awaits the same push, so a
 * 28-shard gate pushes once per host. `cwd` must be a git tree that has the commit (the gate runs in the repo tree).
 */
export function seedMirrorOnce(o: { host: string; commit: string; cwd: string; push?: Push }): Promise<MirrorSeedResult | undefined> {
  const key = `${o.host}\0${o.commit}`;
  let pending = seeded.get(key);
  if (!pending) {
    // A failed seed is not memoized — the next Job on that host tries again (a transient ssh drop must not send the whole gate to GitHub).
    pending = seedPoolMirrors({ hosts: [o.host], commit: o.commit, tree: o.cwd, push: o.push ?? gitWithin })
      .then((results) => { if (!results[0]?.ok) seeded.delete(key); return results[0]; },
        (error: unknown) => { seeded.delete(key); return { host: o.host, ok: false, ms: 0, detail: String(error).slice(0, 300) }; });
    seeded.set(key, pending);
  }
  return pending;
}

/** Test seam — forget the per-process seed memo. */
export function resetMirrorSeedMemo(): void { seeded.clear(); }
