/**
 * GH-PROXY-LAYER ② — the git fetch mirror's command node (graphs/triggers/gh-mirror.yaml · recipe `gh-mirror-refresh`) and its
 * one-command setup / status / teardown. Prints one JSON line `{ outcome, ... }` (the trigger runner routes on `outcome`).
 *
 *   bun src/kit/gh-proxy/mirror-node.ts refresh                                   # one tick (the trigger)
 *   bun src/kit/gh-proxy/mirror-node.ts setup --mirror <abs.git> --upstream <https …git> --consumer <git dir> [--consumer …]
 *   bun src/kit/gh-proxy/mirror-node.ts status
 *   bun src/kit/gh-proxy/mirror-node.ts teardown                                  # consumers back to GitHub (mirror kept)
 */
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { isFresh, mirrorTick, readMirrorState, realGit, setupMirror, teardownMirror, consumerUsesMirror, type MirrorDeps } from './mirror.js';
import { liveGhProxyPolicy } from './policy.js';

function deps(): MirrorDeps | null {
  const policy = liveGhProxyPolicy();
  if (!policy) return null;
  return { stateRoot: effectiveInstanceRoot(), policy, now: Date.now, git: realGit, sleep: (ms) => { Bun.sleepSync(ms); } };
}

function values(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[++i]!);
  return out;
}

export function runMirrorNode(argv: readonly string[]): number {
  const d = deps();
  const say = (o: unknown) => { console.log(JSON.stringify(o)); };
  if (!d) { say({ outcome: 'fail', error: 'gh-proxy policy unreadable (graphs/policies/gh-proxy.yaml)' }); return 1; }
  const cmd = argv[0] ?? 'refresh';
  if (cmd === 'refresh') {
    const r = mirrorTick(d);
    say(r);
    return 0; // the outcome field carries ok/fail for the runner; a failed refresh is not a crashed node
  }
  if (cmd === 'setup') {
    const [mirror] = values(argv, '--mirror'); const [upstream] = values(argv, '--upstream');
    const consumers = values(argv, '--consumer');
    if (!mirror || !upstream || consumers.length === 0) { say({ outcome: 'fail', error: 'setup needs --mirror --upstream --consumer' }); return 2; }
    const r = setupMirror(d, mirror, upstream, consumers);
    say({ outcome: r.ok ? 'ok' : 'fail', lines: r.lines });
    return r.ok ? 0 : 1;
  }
  if (cmd === 'teardown') {
    const r = teardownMirror(d);
    say({ outcome: r.ok ? 'ok' : 'fail', lines: r.lines });
    return r.ok ? 0 : 1;
  }
  if (cmd === 'status') {
    const s = readMirrorState(d.stateRoot);
    if (!s) { say({ outcome: 'ok', mirror: 'absent' }); return 0; }
    const now = d.now();
    say({
      outcome: 'ok', mirror: s.mirror, upstream: s.upstream, fresh: isFresh(s, d.policy, now),
      ageSec: s.lastOkAt === null ? null : Math.round((now - s.lastOkAt) / 1000), lastError: s.lastError, fallback: s.fallback,
      refreshes: s.refreshes, failures: s.failures,
      consumers: s.consumers.map(c => ({ gitDir: c, viaMirror: consumerUsesMirror(d.git, c, s) })),
    });
    return 0;
  }
  say({ outcome: 'fail', error: `unknown command ${cmd} (refresh · setup · status · teardown)` });
  return 2;
}

if (import.meta.main) process.exit(runMirrorNode(process.argv.slice(2)));
