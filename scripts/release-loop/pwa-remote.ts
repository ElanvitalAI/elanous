// RELEASE-PWA-NODE-RESILIENCE ① (0.2.36 · 대표 10-20 «PWA 단계도 원격에서»): the release `pwa` node can run its
// scenario suite on an SSH host (`release.loop.pwaRemote`, e.g. node-b) instead of the busy release machine.
// 0.2.34 (10-20 18:50~19:13): at 1-min load 100+ on mbp the CDP attach went past 5s and T1b failed twice on reruns,
// while the same commit alone passed — the release machine's load, not the PWA, decided the verdict.
//
// Same shape as the gate's host executor (`--gate-executor host` · `gateRemote` · `gateRemoteMirror`):
//   ① ensure the bare mirror on the host  ② push the commit to `refs/elanous/pwa/<sha>`
//   ③ one ssh call: clone the mirror at <sha> into a temp dir, install, run THAT commit's
//      `pwa-scenarios-node.ts` locally there, print its JSON verdict, remove the temp dir.
// ⛔ No silent fallback: when any step fails the node reports `error` with the stage and the host's own words
// and exits 2. It never reruns the suite on the release machine.
import { spawnSync } from 'node:child_process';
import { debug } from '../../src/debug/log.js';

/** `[user@]host`. A leading `-` is refused separately (ssh/git would read it as an option — `-oProxyCommand=…`). */
export const PWA_REMOTE_HOST_PATTERN = /^(?:[\w.-]+@)?[\w.-]+$/;
export const DEFAULT_PWA_REMOTE_MIRROR = '~/mirror/elanous-agent.git';
/** Build (≤15m) + boot + warm-up + suite + reruns on the host; the local ssh deadline is only a backstop. */
export const PWA_REMOTE_TIMEOUT_MS = 75 * 60_000;
/** The host kills its own work first (shorter than the local backstop) so the temp clone and the ref are cleaned there. */
export const PWA_REMOTE_LIMIT_SECONDS = 70 * 60;
/** rc of a run the Perl supervisor stopped after its deadline. */
const LIMIT_RCS = new Set([124]);

export type PwaRemoteStage = 'input' | 'mirror' | 'push' | 'run' | 'timeout' | 'parse';

export interface PwaRemoteOptions {
  host: string;
  commit: string;
  withCostly: boolean;
  reruns: number;
  /** Bare mirror on the host (absolute or `~/…`). Default = the gate's mirror. */
  mirror?: string;
  /** Local repository that holds `commit` (pushed from here). */
  repo: string;
  timeoutMs?: number;
}

export interface PwaRemoteResult {
  /** Exit code for the graph node: 0 pass/flaky · 1 fail · 2 could not run. */
  exitCode: 0 | 1 | 2;
  output: Record<string, unknown>;
}

interface Spawned { rc: number; stdout: string; stderr: string; error?: string }
export type PwaRemoteSpawn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Spawned;

const defaultSpawn: PwaRemoteSpawn = (cmd, args, opts) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)));
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env, encoding: 'utf8', timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  return { rc: r.status ?? 255, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: String(r.error) } : {}) };
};

export const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Validate the host and mirror before anything is spawned. */
export function checkPwaRemote(host: unknown, mirror: unknown): { host: string; mirror: string } {
  if (typeof host === 'string' && host.trim().startsWith('-')) throw new Error(`invalid pwa remote host: ${host.trim()} — a leading «-» would be read as an ssh/git option`);
  if (typeof host !== 'string' || !PWA_REMOTE_HOST_PATTERN.test(host.trim())) throw new Error(`invalid pwa remote host: ${String(host)}`);
  const m = mirror === undefined ? DEFAULT_PWA_REMOTE_MIRROR : mirror;
  if (typeof m !== 'string' || !/^(?:\/|~\/)[\w./-]+$/.test(m) || m.split('/').includes('..')) throw new Error(`invalid pwa remote mirror path: ${String(m)}`);
  return { host: host.trim(), mirror: m };
}

/** `~/x` stays unquoted at the front so the remote shell expands it; the rest is quoted. */
function remotePath(path: string): string {
  return path.startsWith('~/') ? `"$HOME"/${shQuote(path.slice(2))}` : shQuote(path);
}

/**
 * The single remote script for step ③ — `sh -c` so the remote login shell (zsh on node-b) does not change its meaning.
 * - Limit: Perl supervises a separate process group at PWA_REMOTE_LIMIT_SECONDS.
 *   On timeout it kills the group, including the shell's children, then exits 124.
 * - Cleanup: traps on EXIT · HUP · INT · TERM remove the temp clone and this run's mirror ref `refs/elanous/pwa/<sha>`
 *   on success and failure alike — the ref only had to live until the clone fetched it, and deleting «our own» ref
 *   (not a sweep of `refs/elanous/pwa/*`) cannot race another run on a different commit.
 */
export function remoteRunScript(opts: { commit: string; mirror: string; withCostly: boolean; reruns: number; limitSeconds?: number }): string {
  const sha = shQuote(opts.commit);
  const ref = shQuote(`refs/elanous/pwa/${opts.commit}`);
  const limit = String(opts.limitSeconds ?? PWA_REMOTE_LIMIT_SECONDS);
  const nodeArgs = ['--commit', opts.commit, '--json', '--reruns', String(opts.reruns), ...(opts.withCostly ? ['--with-costly'] : [])].map(shQuote).join(' ');
  const body = [
    `git clone --quiet --shared --no-checkout ${remotePath(opts.mirror)} "$1/repo" >&2 || exit 2`,
    `cd "$1/repo" && git fetch --quiet origin ${ref} >&2 && git checkout --quiet --detach ${sha} >&2 || exit 2`,
    'bun install --frozen-lockfile >&2 || exit 2',
    '(cd apps/pwa && bun install --frozen-lockfile) >&2 || exit 2',
    `exec bun scripts/release-loop/pwa-scenarios-node.ts ${nodeArgs}`,
  ].join('\n');
  // Arm the deadline only after the child confirms its new group exists. Otherwise a busy host
  // can deliver SIGALRM between fork and setpgrp, making kill(-pid) miss every descendant.
  const supervisor = [
    'my $seconds = shift;',
    'pipe(my $ready_r, my $ready_w) or exit 127;',
    'my $pid = fork(); defined($pid) or exit 127;',
    'if ($pid == 0) { close $ready_r; defined(setpgrp(0, 0)) or exit 127; syswrite($ready_w, "1") == 1 or exit 127; close $ready_w; exec @ARGV or exit 127; }',
    'close $ready_w; my $ready = ""; unless (read($ready_r, $ready, 1) == 1) { kill 9, -$pid; kill 9, $pid; waitpid($pid, 0); exit 127; } close $ready_r;',
    'local $SIG{ALRM} = sub { kill 9, -$pid; waitpid($pid, 0); exit 124; };',
    'alarm $seconds; waitpid($pid, 0); alarm 0;',
    'exit(($? & 127) ? 128 + ($? & 127) : ($? >> 8));',
  ].join(' ');
  return [
    'PATH=$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH; export PATH',
    'command -v perl >/dev/null 2>&1 || { echo "pwa remote requires perl" >&2; exit 127; }',
    'D=$(mktemp -d /tmp/pwa-node-remote-XXXXXX) || exit 2',
    `cleanup() { cd /tmp; rm -rf "$D"; git --git-dir=${remotePath(opts.mirror)} update-ref -d ${ref} 2>/dev/null; }`,
    `trap 'cleanup' EXIT`,
    `trap 'cleanup; trap - EXIT; exit 129' HUP`,
    `trap 'cleanup; trap - EXIT; exit 130' INT`,
    `trap 'cleanup; trap - EXIT; exit 143' TERM`,
    `lim() { perl -e ${shQuote(supervisor)} ${limit} "$@"; }`,
    `lim sh -c ${shQuote(body)} pwa-node "$D"`,
  ].join('\n');
}

const COMMIT_40 = /^[0-9a-f]{40}$/;

const tail = (text: string, n = 600): string => text.trim().slice(-n);

function lastJson(stdout: string): Record<string, unknown> | undefined {
  const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Run the PWA scenario node on `host`. Never falls back to the local machine. */
export function runPwaRemote(opts: PwaRemoteOptions, spawn: PwaRemoteSpawn = defaultSpawn): PwaRemoteResult {
  const { host, mirror } = checkPwaRemote(opts.host, opts.mirror);
  if (!COMMIT_40.test(opts.commit)) {
    const error = `remote ${host} input refused: commit must be a full 40-hex sha (got ${JSON.stringify(opts.commit)}) — a short sha can name a different commit on the host mirror`;
    debug.log('release-loop.pwa', 'remote-failed', { host, stage: 'input', rc: null, detail: error }, { level: 'warn' });
    return { exitCode: 2, output: { verdict: 'error', commit: opts.commit, withCostly: opts.withCostly, executor: 'host', host, cells: [], error, remote: { stage: 'input', rc: null } } };
  }
  const timeoutMs = opts.timeoutMs ?? PWA_REMOTE_TIMEOUT_MS;
  const base = { commit: opts.commit, withCostly: opts.withCostly, executor: 'host', host };
  const started = Date.now();
  debug.log('release-loop.pwa', 'remote-start', { host, mirror, commit: opts.commit, withCostly: opts.withCostly, reruns: opts.reruns });
  const fail = (stage: PwaRemoteStage, run: Spawned | undefined, detail: string): PwaRemoteResult => {
    const error = `remote ${host} ${stage} failed${run ? ` (rc=${run.rc})` : ''}: ${detail || 'no output'} — 원격 실패는 mbp 로 폴백하지 않는다`;
    debug.log('release-loop.pwa', 'remote-failed', { host, stage, rc: run?.rc ?? null, detail: detail.slice(0, 600), elapsedMs: Date.now() - started }, { level: 'warn' });
    return { exitCode: 2, output: { verdict: 'error', ...base, cells: [], error, remote: { stage, rc: run?.rc ?? null } } };
  };

  // ① mirror — a bare repo the commit can be pushed to (the gate uses the same one).
  const ensure = `test -d ${remotePath(mirror)} || { mkdir -p "$(dirname ${remotePath(mirror)})" && git init --quiet --bare ${remotePath(mirror)}; }`;
  const m = spawn('ssh', ['--', host, `sh -c ${shQuote(ensure)}`], { cwd: '/tmp', timeoutMs: 120_000 });
  if (m.rc !== 0) return fail('mirror', m, tail(`${m.stderr}\n${m.error ?? ''}`));

  // ② push the commit from the release machine.
  const pushTarget = mirror.startsWith('~/') ? mirror.slice(2) : mirror;
  const p = spawn('git', ['push', '--quiet', '--force', '--', `${host}:${pushTarget}`, `${opts.commit}:refs/elanous/pwa/${opts.commit}`], { cwd: opts.repo, timeoutMs: 600_000 });
  if (p.rc !== 0) return fail('push', p, tail(`${p.stderr}\n${p.error ?? ''}`));

  // ③ one call: clone · install · run the commit's own node there.
  const script = remoteRunScript({ commit: opts.commit, mirror, withCostly: opts.withCostly, reruns: opts.reruns });
  const r = spawn('ssh', ['--', host, `sh -c ${shQuote(script)}`], { cwd: '/tmp', timeoutMs });
  const data = lastJson(r.stdout);
  if (!data) return fail(r.rc === 0 ? 'parse' : LIMIT_RCS.has(r.rc) ? 'timeout' : 'run', r, tail(`${r.stderr}\n${r.error ?? ''}`));
  const verdict = data.verdict;
  const exitCode: 0 | 1 | 2 = verdict === 'pass' || verdict === 'flaky' ? (r.rc === 0 ? 0 : 2) : verdict === 'fail' ? 1 : 2;
  debug.log('release-loop.pwa', 'remote-result', { host, verdict: typeof verdict === 'string' ? verdict : null, rc: r.rc, exitCode, elapsedMs: Date.now() - started });
  return { exitCode, output: { ...data, ...base, ...(exitCode === 2 && typeof data.error !== 'string' ? { error: `remote ${host} run rc=${r.rc} verdict=${String(verdict)}: ${tail(r.stderr, 300)}` } : {}) } };
}
