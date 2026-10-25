/** GATE-REMOTE (0.2.18 · 10-06) — run a heavy pre-landing check (self gate · changed-file tsc · public-export test run)
 *  on a remote host at the SAME commit and bring back only its result (exit code · stdout · stderr).
 *  Reach: the release gate's bare mirror (`~/mirror/elanous-agent.git`, refs/elanous/gate/<sha>) — copied minimally from
 *  scripts/release-loop/gate-node.ts (RELGUARD path, not edited); gate-node could later switch to this module. */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { loadavg } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { gateHostReservationRoot, inspectReleaseGateHost } from '../release-loop/gate-host-reservation.js';
import type { GateRemoteConfig } from '../user-config.js';

export type GateRemoteTool = 'self-gate' | 'ci-typecheck-changed' | 'public-export-test-run';

export interface GateRemoteSettings {
  enabled: boolean;
  host: string;
  loadThreshold: number;
  hostCap: number;
  hostCaps?: Record<string, number>;
  mirror: string;
  slotWaitSeconds: number;
}

export const MAX_HOST_CAP = 8;

export const GATE_REMOTE_DEFAULTS: GateRemoteSettings = {
  enabled: true, host: 'node-b', loadThreshold: 20, hostCap: 2, hostCaps: {}, mirror: '~/mirror/elanous-agent.git', slotWaitSeconds: 600,
};

const hostPattern = /^(?:[\w.-]+@)?[\w.-]+$/;
export const isValidGateHost = (host: string): boolean => hostPattern.test(host) && !host.startsWith('-');
const mirrorPattern = /^(?:\/|~\/)[\w./-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

/** config > env > default (user-config hierarchy). Env: ELANOUS_GATE_REMOTE=off|on · ELANOUS_GATE_REMOTE_HOST · ELANOUS_GATE_REMOTE_LOAD. */
export function resolveGateRemoteSettings(config: GateRemoteConfig | undefined, env: NodeJS.ProcessEnv = process.env): GateRemoteSettings {
  const envEnabled = env.ELANOUS_GATE_REMOTE === 'off' || env.ELANOUS_GATE_REMOTE === '0' ? false
    : env.ELANOUS_GATE_REMOTE === 'on' || env.ELANOUS_GATE_REMOTE === '1' ? true : undefined;
  const envLoadRaw = env.ELANOUS_GATE_REMOTE_LOAD && /^\d+(?:\.\d+)?$/.test(env.ELANOUS_GATE_REMOTE_LOAD) ? Number(env.ELANOUS_GATE_REMOTE_LOAD) : undefined;
  const envLoad = envLoadRaw !== undefined && Number.isFinite(envLoadRaw) ? envLoadRaw : undefined;
  const host = config?.host ?? env.ELANOUS_GATE_REMOTE_HOST?.trim() ?? GATE_REMOTE_DEFAULTS.host;
  const mirror = config?.mirror ?? GATE_REMOTE_DEFAULTS.mirror;
  return {
    enabled: config?.enabled ?? envEnabled ?? GATE_REMOTE_DEFAULTS.enabled,
    host: isValidGateHost(host) ? host : GATE_REMOTE_DEFAULTS.host,
    loadThreshold: config?.loadThreshold ?? envLoad ?? GATE_REMOTE_DEFAULTS.loadThreshold,
    hostCap: Math.min(GATE_REMOTE_DEFAULTS.hostCap, Math.max(1, Math.floor(config?.hostCap ?? GATE_REMOTE_DEFAULTS.hostCap))),
    hostCaps: Object.fromEntries(Object.entries(config?.hostCaps ?? {}).filter(([key, value]) =>
      isValidGateHost(key) && Number.isSafeInteger(value) && value >= 1 && value <= MAX_HOST_CAP)),
    mirror: mirrorPattern.test(mirror) && !mirror.split('/').includes('..') ? mirror : GATE_REMOTE_DEFAULTS.mirror,
    slotWaitSeconds: config?.slotWaitSeconds ?? GATE_REMOTE_DEFAULTS.slotWaitSeconds,
  };
}

/** Explicit and rerouted hosts use their own slot budget; absent entries retain the default cap. */
export function gateRemoteHostCap(settings: GateRemoteSettings, host: string): number {
  const caps = settings.hostCaps;
  const bareHost = host.split('@').at(-1)!;
  const configured = caps && Object.hasOwn(caps, host) ? caps[host]
    : caps && Object.hasOwn(caps, bareHost) ? caps[bareHost] : undefined;
  return Math.min(MAX_HOST_CAP, Math.max(1, Math.floor(configured ?? settings.hostCap)));
}

/** The token after a bare `--remote` is its host when it is a valid ssh destination that is not an existing path and does
 *  not look like a test/list file — so `--remote node-b.lan a.test.ts` takes the host and `--remote a.test.ts` keeps the file. */
export function looksLikeHost(token: string, exists: (path: string) => boolean = existsSync): boolean {
  if (!isValidGateHost(token) || exists(token)) return false;
  return !/\.(?:test\.)?(?:[cm]?[jt]sx?|txt|json|md)$/i.test(token);
}

export interface GateRemoteFlags { remote?: string | true; local: boolean; rest: string[]; error?: string }

/** Pull `--remote [host]` / `--remote=<host>` / `--local` out of argv; everything else is left for the tool. */
export function extractGateRemoteFlags(argv: readonly string[]): GateRemoteFlags {
  const out: GateRemoteFlags = { local: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--local') out.local = true;
    else if (arg.startsWith('--remote=')) out.remote = arg.slice('--remote='.length);
    else if (arg === '--remote') {
      const next = argv[i + 1];
      if (next !== undefined && looksLikeHost(next)) { out.remote = next; i++; } else out.remote = true;
    } else out.rest.push(arg);
  }
  if (typeof out.remote === 'string' && !isValidGateHost(out.remote)) out.error = `invalid --remote host: ${out.remote}`;
  if (out.remote !== undefined && out.local) out.error = '--remote and --local cannot be combined';
  return out;
}

/** A remote importer sweep must not silently become one large test process. The measured planner may grow this
 *  starting count further when the observed RSS needs more memory-bounded bundles. */
export function remoteSelfGateArgv(input: {
  changed?: boolean;
  base?: string;
  shards?: number;
  fixedShardDistribution?: boolean;
  includeImporters?: boolean;
  artifactDir?: string;
}, sha: (ref: string) => string): string[] {
  const shards = input.shards ?? (input.includeImporters ? 2 : undefined);
  return ['bun', 'bin/elanous.mjs', 'self', 'gate', '--local', ...(input.changed ? ['--changed'] : []),
    ...(input.base ? ['--base', input.base === 'origin/main' ? input.base : sha(input.base)] : []),
    ...(shards !== undefined ? ['--shards', String(shards)] : []),
    ...(input.fixedShardDistribution ? ['--fixed-shard-distribution'] : []),
    ...(input.includeImporters ? ['--include-importers'] : []),
    ...(input.artifactDir ? ['--artifact-dir', input.artifactDir] : [])];
}

export interface GateDispatchDecision { mode: 'local' | 'remote'; host?: string; reason: string; load1: number }

export function decideGateDispatch(input: { flags: Pick<GateRemoteFlags, 'remote' | 'local'>; settings: GateRemoteSettings; load1: number; env?: NodeJS.ProcessEnv }): GateDispatchDecision {
  const { flags, settings, load1 } = input;
  const env = input.env ?? process.env;
  if (flags.local) return { mode: 'local', reason: 'flag-local', load1 };
  if (env.ELANOUS_GATE_REMOTE_CHILD === '1') return { mode: 'local', reason: 'remote-child', load1 };
  if (flags.remote !== undefined) return { mode: 'remote', host: flags.remote === true ? settings.host : flags.remote, reason: 'flag-remote', load1 };
  if (!settings.enabled) return { mode: 'local', reason: 'config-off', load1 };
  // Tests never reach a real host on their own (an explicit --remote with an injected runner still can).
  if (env.NODE_ENV === 'test') return { mode: 'local', reason: 'test-env', load1 };
  if (load1 > settings.loadThreshold) return { mode: 'remote', host: settings.host, reason: `load ${load1.toFixed(1)} > ${settings.loadThreshold}`, load1 };
  return { mode: 'local', reason: `load ${load1.toFixed(1)} <= ${settings.loadThreshold}`, load1 };
}

// ── host lock (on the remote host, cap N) ───────────────────────
// The slots live on the host itself, so every machine that dispatches there shares one cap. Each slot is a kernel file
// lock (flock(1) / BSD lockf(1)) held for exactly the life of the run — a crashed or killed run releases it, so there is
// no staleness guess and no reclaim race.

export const SLOT_DIR = '/tmp/elanous-gate-remote-slots';
const BUSY = '__GATE_REMOTE_BUSY';

/** Shell lines that run "$W/run.sh" under the first free of `cap` slot locks, or print the busy marker and exit 98.
 *  run.sh must create "$W/started" first: that is how a lock refusal is told apart from the run's own exit code. */
export type SlotLockTool = 'flock' | 'lockf';
const SLOT_LOCK = { flock: 'flock -n', lockf: 'lockf -k -s -t 0' } as const;

/** `tools` is the preference order (default: Linux flock, then BSD/macOS lockf); a test can pin one path. */
function hostSlotScriptWithSlot(cap: number, dir: string, tools: readonly SlotLockTool[], passSlot: boolean): string[] {
  const n = Math.min(MAX_HOST_CAP, Math.max(1, Math.floor(cap)));
  const pick = tools.map((tool, i) => `${i ? 'elif' : 'if'} command -v ${tool} >/dev/null 2>&1; then GL="${SLOT_LOCK[tool]}"; `).join('');
  return [
    `GS=${quote(dir)}; mkdir -p "$GS" || infra slots`,
    `${pick}else infra lock-tool; fi`,
    'load1() { if [ -r /proc/loadavg ]; then awk \'NR==1 {print $1}\' /proc/loadavg; elif command -v sysctl >/dev/null 2>&1; then sysctl -n vm.loadavg 2>/dev/null | awk \'{gsub(/[{}]/, ""); print $1}\'; else echo unknown; fi; }',
    `n=1; while [ $n -le ${n} ]; do $GL "$GS/slot$n" ${passSlot ? 'env GATE_REMOTE_SLOT="$n" ' : ''}sh "$W/run.sh"; s=$?; [ -f "$W/started" ] && exit $s; n=$((n+1)); done`,
    `echo "${BUSY}=$((n-1));load1=$(load1)" >&2; exit 98`,
  ];
}

export function hostSlotScript(cap: number, dir = SLOT_DIR, tools: readonly SlotLockTool[] = ['flock', 'lockf']): string[] {
  return hostSlotScriptWithSlot(cap, dir, tools, false);
}

// ── remote execution ───────────────────────────────────────────────

export interface ExecResult { rc: number | null; stdout: string; stderr: string; error?: string }
/** Raw bytes from the host — the tool's output is passed on byte for byte (strings are accepted from test runners). */
export interface SshResult { rc: number | null; stdout: Buffer | string; stderr: Buffer | string; error?: string }
export interface GateRemoteRunner {
  /** Run a command locally (git rev-parse · status · push). */
  local(cmd: string, args: string[], cwd: string, options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): ExecResult;
  /** Run a shell script on the host over ssh. */
  ssh(host: string, script: string, timeoutMs: number): SshResult;
}

export const realGateRemoteRunner: GateRemoteRunner = {
  local(cmd, args, cwd, options) {
    const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      ...(options?.env ? { env: options.env } : {}), ...(options?.timeoutMs ? { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const } : {}) });
    return { rc: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', ...(run.error ? { error: String(run.error) } : {}) };
  },
  ssh(host, script, timeoutMs) {
    const run = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'sh', '-s'], {
      input: script, cwd: '/tmp', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
    });
    return { rc: run.status, stdout: run.stdout ?? Buffer.alloc(0), stderr: run.stderr ?? Buffer.alloc(0), ...(run.error ? { error: String(run.error) } : {}) };
  },
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const INFRA = '__GATE_REMOTE_INFRA=';
const RC = '__GATE_REMOTE_RC=';
export const PUSH_TIMEOUT_MS = 10 * 60_000;

export type RemoteRunOutcome =
  | { kind: 'ran'; rc: number; stdout: Buffer; stderr: Buffer; commit: string; host: string; ms: number }
  | { kind: 'busy'; occupied?: number; load1?: number | null; rc?: number }
  | { kind: 'infra'; reason: string; stage?: string; rc?: number | null; stderr?: string };

export interface RemoteRunOptions {
  repo: string;
  host: string;
  mirror: string;
  /** Exact local commit to run instead of HEAD; permits a dirty worktree. */
  commit?: string;
  /** argv run from the remote checkout root, e.g. ['bun', 'bin/elanous.mjs', 'self', 'gate', ...]; a function receives
   *  `sha(ref)` for each of `refs` so the remote command names the exact commit, not a ref the host may not have. */
  argv: RemoteArgv;
  hostCap?: number;
  /** Host-side slot lock directory (default SLOT_DIR) — tests point it at a scratch dir. */
  slotDir?: string;
  /** Extra local refs whose commits must exist remotely (e.g. a --base ref). Resolved to shas. */
  refs?: string[];
  installPwa?: boolean;
  /** An exclusive slot checkout path allows the opt-in TypeScript graph cache to survive scratch runs. */
  stableCheckout?: boolean;
  timeoutMs?: number;
  /** Files the remote run needs from this machine (e.g. the private export redaction table): sent over ssh stdin, written
   *  mode 600 inside the scratch directory, exposed to the tool via `env`, removed with it. Never on argv. */
  payloadFiles?: PayloadFile[];
}

export interface PayloadFile { env: string; content: string }
export type RemoteArgv = string[] | ((sha: (ref: string) => string) => string[]);

/** Build the remote shell script (exported for tests). Every setup failure ends in an INFRA marker, the tool's rc in an RC marker. */
export function remoteScript(input: { mirror: string; commit: string; fetchShas: string[]; mainSha?: string; argv: string[]; installPwa: boolean; stableCheckout?: boolean; payloadFiles?: PayloadFile[]; hostCap?: number; slotDir?: string }): string {
  const mirror = input.mirror.startsWith('~/') ? `"$HOME"/${quote(input.mirror.slice(2))}` : quote(input.mirror);
  const fetches = input.fetchShas.map((sha) => `refs/elanous/gate/${sha}:refs/elanous/gate/${sha}`).join(' ');
  const payloads = (input.payloadFiles ?? []).filter((file) => /^[A-Z_][A-Z0-9_]*$/.test(file.env));
  const payloadLines = payloads.flatMap((file, i) => {
    const delimiter = `__GATE_REMOTE_PAYLOAD_${i}__`;
    if (file.content.split('\n').includes(delimiter)) throw new Error('payload contains its delimiter');
    return [`cat > "$W/payload-${i}" <<'${delimiter}' || infra payload`, file.content.replace(/\n$/, ''), delimiter];
  });
  const payloadEnv = payloads.map((file, i) => `${file.env}="$W/payload-${i}" `).join('');
  // One brace group: sh parses the whole script off stdin before running anything, so no child can swallow the rest of it.
  // The work itself is written to "$W/run.sh" and runs under a host slot lock.
  const RUN = '__GATE_REMOTE_RUN__';
  const work = [
    `infra() { echo "${INFRA}$1" >&2; exit 97; }`,
    ': > "$W/started"',
    ...(input.stableCheckout ? [
      'T="$HOME/.cache/elanous/gate-remote/slot$GATE_REMOTE_SLOT/checkout"',
      'mkdir -p "$(dirname "$T")" || infra stable-dir',
      'if [ -d "$T/.git" ]; then',
      '  git -C "$T" reset --hard -q >>"$W/setup.log" 2>&1 || infra stable-reset',
      '  git -C "$T" clean -ffd -q >>"$W/setup.log" 2>&1 || infra stable-clean',
      `  git -C "$T" remote set-url origin ${mirror} >>"$W/setup.log" 2>&1 || infra stable-origin`,
      'else',
      '  rm -rf "$T" || infra stable-remove',
      `  git clone -q --shared --no-checkout ${mirror} "$T" >"$W/setup.log" 2>&1 || infra clone`,
      'fi',
      'rm -rf "$T/apps/pwa/.next" || infra pwa-build-clean',
      'rm -f "$T/apps/pwa/"*.tsbuildinfo || infra pwa-buildinfo-clean',
      'ELANOUS_TSC_CACHE_DIR="$HOME/.cache/elanous/gate-remote/slot$GATE_REMOTE_SLOT/cache"; export ELANOUS_TSC_CACHE_DIR',
    ] : [
      'T="$W/t"',
      `git clone -q --shared --no-checkout ${mirror} "$T" >"$W/setup.log" 2>&1 || infra clone`,
    ]),
    'cd "$T" || infra cd',
    `git fetch -q origin ${fetches} >>"$W/setup.log" 2>&1 || infra fetch`,
    `git checkout -q --detach ${input.commit} >>"$W/setup.log" 2>&1 || infra checkout`,
    ...(input.mainSha ? [`git update-ref refs/remotes/origin/main ${input.mainSha} || infra origin-main`] : []),
    'bun install >>"$W/setup.log" 2>&1 || infra bun-install',
    ...(input.installPwa ? ['(cd apps/pwa && bun install) >>"$W/setup.log" 2>&1 || infra bun-install-pwa'] : []),
    // A scratch universe: the remote run never touches the host's operational ~/.elanous state.
    'mkdir -p "$W/state" || infra scratch',
    `${payloadEnv}ELANOUS_STATE_DIR="$W/state" ELANOUS_GATE_REMOTE_CHILD=1 ${input.argv.map(quote).join(' ')} </dev/null`,
    // The marker always starts on its own line, whatever the tool's stderr ended with; the parser strips that newline.
    `rc=$?; printf '\\n%s%s\\n' '${RC}' "$rc" >&2`,
    'exit 0',
  ];
  // Any argument line equal to the delimiter would end run.sh early and run the rest outside the slot lock.
  if (work.join('\n').split('\n').includes(RUN)) throw new Error('run script contains its delimiter');
  return [
    '{',
    'umask 077',
    'PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"; export PATH',
    `infra() { echo "${INFRA}$1" >&2; exit 97; }`,
    // `/tmp` is a 20 GiB tmpfs on WSL. One baseline checkout can exhaust it before any shard starts.
    // Keep the entire child temp tree on the host disk; a low-space host yields infra fallback.
    'TMPDIR=/var/tmp; export TMPDIR',
    'free_kib=$(df -Pk "$TMPDIR" 2>/dev/null | awk \'NR==2 {print $4}\')',
    'case "$free_kib" in ""|*[!0-9]*) infra disk-unmeasured;; esac',
    'if [ "$free_kib" -lt 8388608 ]; then infra "disk-low:${free_kib}KiB"; fi',
    'W=$(mktemp -d /var/tmp/elanous-gate-remote-XXXXXXXX) || infra mktemp',
    'export W',
    'trap \'rm -rf "$W"\' EXIT',
    ...payloadLines,
    `cat > "$W/run.sh" <<'${RUN}' || infra run-script`,
    ...work,
    RUN,
    ...hostSlotScriptWithSlot(input.hostCap ?? GATE_REMOTE_DEFAULTS.hostCap, input.slotDir ?? SLOT_DIR, ['flock', 'lockf'], !!input.stableCheckout),
    '}',
    '',
  ].join('\n');
}

function revParse(runner: GateRemoteRunner, repo: string, ref: string): string | undefined {
  const r = runner.local('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
  const sha = r.stdout.trim();
  return r.rc === 0 && shaPattern.test(sha) ? sha : undefined;
}

export function runOnRemote(opts: RemoteRunOptions, runner: GateRemoteRunner = realGateRemoteRunner): RemoteRunOutcome {
  const started = Date.now();
  let commit: string;
  if (opts.commit !== undefined) {
    if (!shaPattern.test(opts.commit)) return { kind: 'infra', reason: 'invalid-commit' };
    const object = runner.local('git', ['cat-file', '-t', opts.commit], opts.repo);
    if (object.rc !== 0 || object.stdout.trim() !== 'commit') return { kind: 'infra', reason: 'commit-missing' };
    commit = opts.commit;
  } else {
    const status = runner.local('git', ['status', '--porcelain'], opts.repo);
    if (status.rc !== 0) return { kind: 'infra', reason: 'git-status-failed' };
    // A remote checkout can only reproduce a commit — uncommitted or untracked files would silently not be measured.
    if (status.stdout.trim()) return { kind: 'infra', reason: 'dirty-tree' };
    const head = revParse(runner, opts.repo, 'HEAD');
    if (!head) return { kind: 'infra', reason: 'head-unresolved' };
    commit = head;
  }
  // Every check measures against merge-base(origin/main); without the local one the host would fall back to its mirror's
  // (possibly stale) branch — not the same measurement.
  const mainSha = revParse(runner, opts.repo, 'origin/main');
  if (!mainSha) return { kind: 'infra', reason: 'origin-main-unresolved' };
  const resolved = new Map<string, string>();
  for (const ref of opts.refs ?? []) {
    const sha = revParse(runner, opts.repo, ref);
    if (!sha) return { kind: 'infra', reason: `ref-unresolved:${ref}` };
    resolved.set(ref, sha);
  }
  const extra = [...resolved.values()];
  let argv: string[];
  try {
    argv = typeof opts.argv === 'function' ? opts.argv((ref) => {
      const sha = resolved.get(ref);
      if (!sha) throw new Error(`ref not declared: ${ref}`);
      return sha;
    }) : opts.argv;
  } catch (error) { return { kind: 'infra', reason: `argv: ${error instanceof Error ? error.message : String(error)}` }; }
  const shas = [...new Set([commit, mainSha, ...extra])];
  const pushTarget = `${opts.host}:${opts.mirror.startsWith('~/') ? opts.mirror.slice(2) : opts.mirror}`;
  // Non-interactive and time-bounded: a stuck connection or auth prompt must end without hanging.
  const push = runner.local('git', ['push', '--quiet', pushTarget, ...shas.map((sha) => `${sha}:refs/elanous/gate/${sha}`)], opts.repo, {
    timeoutMs: PUSH_TIMEOUT_MS,
    env: { ...process.env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10', GIT_TERMINAL_PROMPT: '0' },
  });
  if (push.rc !== 0 || push.error) return { kind: 'infra', stage: 'push', rc: push.rc, stderr: push.stderr || push.error || '', reason: `push-failed rc=${push.rc}: ${(push.stderr || push.error || '').trim().split('\n').slice(-2).join(' | ')}` };
  const script = remoteScript({ mirror: opts.mirror, commit, fetchShas: shas, mainSha, argv, installPwa: opts.installPwa ?? false, stableCheckout: opts.stableCheckout, payloadFiles: opts.payloadFiles, hostCap: opts.hostCap, slotDir: opts.slotDir });
  const run = runner.ssh(opts.host, script, opts.timeoutMs ?? 120 * 60_000);
  // The script prints "\n<marker><rc>\n": everything before that leading newline is the tool's own stderr, byte for byte.
  const stdoutBytes = Buffer.from(run.stdout);
  const stderrBytes = Buffer.from(run.stderr);
  const stderrText = stderrBytes.toString('utf8');
  const marker = stderrBytes.lastIndexOf(Buffer.from(`\n${RC}`));
  // Busy (98) and setup failure (97) are the script's own exits, each with its marker as the last stderr line. A completed
  // run exits 0 after the rc marker, and its stderr belongs to the tool — never scanned for markers.
  if (!(run.rc === 0 && marker >= 0)) {
    const last = stderrText.trimEnd().split('\n').at(-1) ?? '';
    if (run.rc === 98) {
      const busy = /^__GATE_REMOTE_BUSY(?:=(\d+))?(?:;load1=(unknown|\d+(?:\.\d+)?|))?$/.exec(last);
      if (busy) return { kind: 'busy', rc: run.rc,
        ...(busy[1] !== undefined ? { occupied: Number(busy[1]) } : {}),
        ...(busy[2] !== undefined ? { load1: busy[2] === '' || busy[2] === 'unknown' ? null : Number(busy[2]) } : {}) };
    }
    if (run.rc === 97 && last.startsWith(INFRA)) return { kind: 'infra', stage: last.slice(INFRA.length).trim(), rc: run.rc, stderr: stderrText, reason: `remote-${last.slice(INFRA.length).trim()}` };
  }
  // No marker, or ssh did not end cleanly after it (the script always exits 0 once the marker is written): output may be cut.
  if (marker < 0) return { kind: 'infra', stage: 'ssh', rc: run.rc, stderr: stderrText, reason: `ssh rc=${run.rc}${run.error ? ` ${run.error}` : ''}: ${stderrText.trim().split('\n').slice(-2).join(' | ')}` };
  if (run.rc !== 0 || run.error) return { kind: 'infra', stage: 'ssh-incomplete', rc: run.rc, stderr: stderrText, reason: `ssh-incomplete rc=${run.rc}${run.error ? ` ${run.error}` : ''}` };
  // The marker is the last thing the script writes: exactly "\n<marker><digits>\n". Anything else (empty, cut) is infra.
  const tail = /^\n__GATE_REMOTE_RC=(\d{1,3})\n$/.exec(stderrBytes.subarray(marker).toString('utf8'));
  const rc = tail ? Number(tail[1]) : NaN;
  if (!(rc >= 0 && rc <= 255)) return { kind: 'infra', stage: 'rc-unparsed', rc: run.rc, stderr: stderrText, reason: 'rc-unparsed' };
  // The tool's stderr is exactly what came before the marker line.
  return { kind: 'ran', rc, stdout: stdoutBytes, stderr: stderrBytes.subarray(0, marker), commit, host: opts.host, ms: Date.now() - started };
}

/** An absolute argument outside the repo names a file the remote checkout does not have — such a run is not reproducible. */
export function outsideRepoArgs(args: readonly string[], repo: string): string[] {
  // The tool resolves file arguments against the repository root; anything that lands outside it (absolute or ../) is not
  // in the remote checkout.
  return args.filter((arg) => {
    if (arg.startsWith('-')) return false;
    const rel = relative(repo, resolve(repo, arg));
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  });
}

/** File arguments the remote checkout cannot reproduce: outside the repo (by string or after symlinks resolve), or not
 *  tracked at HEAD (ignored/untracked files are not in the pushed commit). `tracked` defaults to `git ls-files`. */
export function unreproducibleArgs(paths: readonly string[], repo: string, tracked: (path: string) => boolean = (path) =>
  spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repo, stdio: 'ignore', maxBuffer: 1024 * 1024 }).status === 0): string[] {
  let realRepo = repo;
  try { realRepo = realpathSync(repo); } catch { /* keep as given */ }
  return paths.filter((arg) => {
    if (outsideRepoArgs([arg], repo).length) return true;
    const abs = resolve(repo, arg);
    if (!tracked(relative(repo, abs))) return true;
    // Conservative: any symlink on the way (the file itself or a directory above it, inside the repo) means local —
    // a link's target may be untracked, outside, looped or dangling, and none of that is worth reproducing remotely.
    const parts = relative(repo, abs).split(sep);
    let walk = realRepo;
    for (const part of parts) {
      walk = join(walk, part);
      try { if (lstatSync(walk).isSymbolicLink()) return true; } catch { return false; } // missing locally: tracked() already answered
    }
    return false;
  });
}

/** Rewrite absolute paths under the repo to repo-relative so they mean the same file in the remote checkout. */
export function relativizeArgs(args: readonly string[], repo: string): string[] {
  return args.map((arg) => {
    if (!isAbsolute(arg)) return arg;
    const rel = relative(repo, arg);
    return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : arg;
  });
}

/** For a JSON object stdout: add `host` and `remote: true` by splicing them in before the closing brace — every other byte
 *  of the tool's output (spacing, escapes, key order, trailing newline) is kept. Anything else passes through unchanged. */
export function annotateJsonStdout(stdout: string, host: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return stdout;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return stdout;
  } catch { return stdout; }
  const close = stdout.lastIndexOf('}');
  const empty = Object.keys(JSON.parse(trimmed) as object).length === 0;
  return `${stdout.slice(0, close)}${empty ? '' : ','}"host":${JSON.stringify(host)},"remote":true${stdout.slice(close)}`;
}

export interface DispatchOptions {
  tool: GateRemoteTool;
  repo: string;
  flags: Pick<GateRemoteFlags, 'remote' | 'local'>;
  /** argv for the remote run (the tool re-invoked with `--local` so it never recurses). */
  remoteArgv: RemoteArgv;
  refs?: string[];
  /** Exact commit to run remotely instead of the repo's HEAD (RELEASE-DAILY-LIGHT-RC ① — light-rc measures origin/main,
   *  not the seat tree it was started from). */
  commit?: string;
  installPwa?: boolean;
  payloadFiles?: PayloadFile[];
  json?: boolean;
  /** Set when this invocation cannot be reproduced remotely (e.g. self gate without --base): automatic placement
   *  falls back with this reason; an explicit self gate --remote reports an unmeasured check instead. */
  localOnlyReason?: string;
  /** Explicit or caller-required remote measurement must never become a local fallback. */
  explicitRemoteOnly?: boolean;
  /** Keep the remote checkout and TypeScript cache per host slot across repeated checks. */
  stableCheckout?: boolean;
  /** Self gate CLI only: name the host for both automatic and explicit remote execution. */
  reportRemoteHost?: boolean;
  /** Release gate host reservations shared by self gate and changed typecheck. */
  reservationRoot?: string;
  runLocal: () => number | Promise<number>;
  /** Called once with the final remote outcome (never on a local decision), before its output passes through or the
   *  local fallback runs — e.g. `self gate --artifact-dir` fetches (ran) or removes (infra) the host-side artifact dir.
   *  A throw is logged and swallowed: the hook never changes the check's rc. */
  onRemoteOutcome?: (outcome: RemoteRunOutcome, host: string, runner: GateRemoteRunner) => void;
}

export interface DispatchDeps {
  runner?: GateRemoteRunner;
  settings?: GateRemoteSettings;
  load1?: number;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam for gate.remote events; production defaults to the structured debug log. */
  log?: (event: string, data: Record<string, unknown>) => void;
  write?: { out: (data: string | Uint8Array) => void; err: (data: string | Uint8Array) => void };
}

async function loadSettings(): Promise<GateRemoteSettings> {
  try {
    const { getUserConfig } = await import('../user-config.js');
    return resolveGateRemoteSettings(getUserConfig().gateRemote);
  } catch { return resolveGateRemoteSettings(undefined); }
}

/** Decide local/remote, run, and return the tool's exit code. Self gate remote failures are never local measurements. */
export async function dispatchHeavyCheck(opts: DispatchOptions, deps: DispatchDeps = {}): Promise<number> {
  const settings = deps.settings ?? await loadSettings();
  const env = deps.env ?? process.env;
  const write = deps.write ?? { out: (d: string | Uint8Array) => process.stdout.write(d), err: (d: string | Uint8Array) => process.stderr.write(d) };
  const flags = opts.tool === 'self-gate' && !opts.flags.local ? { ...opts.flags, remote: opts.flags.remote ?? true } : opts.flags;
  const decision = decideGateDispatch({ flags, settings, load1: deps.load1 ?? loadavg()[0]!, env });
  debug.log('gate.remote', 'decision', { tool: opts.tool, mode: decision.mode, host: decision.host, reason: decision.reason, load1: decision.load1 });
  if (decision.mode === 'local') {
    if (opts.tool === 'self-gate' && !opts.flags.local) {
      const host = typeof flags.remote === 'string' ? flags.remote : settings.host;
      debug.log('gate.remote', 'remote-unmeasured', { tool: opts.tool, host, reason: decision.reason, stage: 'placement', rc: null });
      write.err(`[gate.remote] remote unmeasured on ${host} (stage=placement, rc=unknown) — ${decision.reason}\n`);
      return 1;
    }
    if (opts.explicitRemoteOnly && opts.flags.remote !== undefined && decision.reason !== 'flag-local') {
      write.err(`[gate.remote] remote unmeasured — ${decision.reason}\n`);
      return 1;
    }
    return opts.runLocal();
  }
  let host = decision.host!;
  const reservationRoot = opts.tool === 'self-gate' || opts.tool === 'ci-typecheck-changed'
    ? opts.reservationRoot ?? (deps.runner ? undefined : gateHostReservationRoot()) : undefined;
  if (reservationRoot) {
    const reservationHost = host.split('@').at(-1)!;
    const first = inspectReleaseGateHost(reservationRoot, reservationHost);
    if (first.status !== 'free') {
      // Changed typecheck has a fixed node-b placement; a release reservation makes it unmeasured.
      const alternate = opts.tool === 'self-gate' && reservationHost === 'node-b' ? 'node-c' : null;
      const other = alternate ? inspectReleaseGateHost(reservationRoot, alternate) : null;
      if (alternate && other?.status === 'free') {
        debug.log('gate.remote', 'host-reserved-reroute', { from: host, to: alternate, reason: first.reason, status: first.status });
        write.err(`[gate.remote] ${host} reserved (${first.reason}) — using ${alternate}\n`);
        host = alternate;
      } else {
        const reason = `host-reserved: ${host} (${first.reason}); alternate ${alternate ?? '(none)'} ${other?.status ?? 'unavailable'}`;
        debug.log('gate.remote', 'host-reserved-unmeasured', { host, reason });
        write.err(opts.tool === 'self-gate'
          ? `[gate.remote] remote unmeasured on ${host} (stage=host-reserved, rc=unknown) — ${reason}\n`
          : `[gate.remote] remote unmeasured — ${reason}\n`);
        return 1;
      }
    }
  }
  const fallback = (reason: string, failure?: { stage?: string; rc?: number | null; stderr?: string }) => {
    const selfGateInfrastructureFailure = opts.tool === 'self-gate' && failure?.stage !== 'reproducibility';
    if (selfGateInfrastructureFailure || (opts.explicitRemoteOnly && opts.flags.remote !== undefined)) {
      debug.log('gate.remote', 'remote-unmeasured', { tool: opts.tool, host, reason, ...(opts.tool === 'self-gate' ? { stage: failure?.stage, rc: failure?.rc, stderr: failure?.stderr } : {}) });
      write.err(`[gate.remote] remote unmeasured on ${host}${opts.tool === 'self-gate' && failure?.stage ? ` (stage=${failure.stage}, rc=${failure.rc ?? 'unknown'})` : ''} — ${reason.replace(/\s+/g, ' ').trim()}\n`);
      if (opts.tool === 'self-gate' && failure?.stderr) write.err(failure.stderr.endsWith('\n') ? failure.stderr : `${failure.stderr}\n`);
      return 1;
    }
    debug.log('gate.remote', 'fallback', { tool: opts.tool, host, reason });
    write.err(`[gate.remote] fallback to local — ${reason}\n`);
    return opts.runLocal();
  };
  if (opts.localOnlyReason) return fallback(opts.localOnlyReason, { stage: 'reproducibility', rc: null });
  const hostCap = gateRemoteHostCap(settings, host);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + settings.slotWaitSeconds * 1000;
  let waitStartedAt: number | undefined;
  const logWait = deps.log ?? ((event: string, data: Record<string, unknown>) => debug.log('gate.remote', event, data));
  let waitedForSlot = false;
  debug.log('gate.remote', 'dispatch', { tool: opts.tool, host, reason: decision.reason });
  let outcome: RemoteRunOutcome;
  for (;;) {
    try {
      outcome = runOnRemote({ repo: opts.repo, host, mirror: settings.mirror, argv: opts.remoteArgv, refs: opts.refs, ...(opts.commit !== undefined ? { commit: opts.commit } : {}), installPwa: opts.installPwa, payloadFiles: opts.payloadFiles, stableCheckout: opts.stableCheckout, hostCap }, deps.runner);
    } catch (error) {
      outcome = { kind: 'infra', reason: `exception: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (outcome.kind !== 'busy') break;
    waitedForSlot = true;
    waitStartedAt ??= now();
    const waitData = {
      tool: opts.tool, host, reason: 'host-busy', load1: outcome.load1 ?? null, loadThreshold: settings.loadThreshold,
      occupied: outcome.occupied ?? null, cap: hostCap, elapsedMs: Math.max(0, now() - waitStartedAt),
    };
    logWait('wait-reason', waitData);
    write.err(`[gate.remote] waiting on ${host} — reason=host-busy load=${outcome.load1 ?? 'unknown'}/${settings.loadThreshold} slots=${outcome.occupied ?? 'unknown'}/${hostCap} elapsed=${Math.floor(waitData.elapsedMs / 1000)}s\n`);
    debug.log('gate.remote', 'host-busy', { tool: opts.tool, host, cap: hostCap, occupied: outcome.occupied ?? null });
    // Never start an attempt past the deadline: an expired self gate wait remains unmeasured.
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(15_000, left));
    if (now() >= deadline) break;
  }
  if (waitedForSlot) {
    const resolution = outcome.kind === 'ran' ? 'slot-open' : outcome.kind === 'busy' ? 'deadline-slot-still-busy'
      : `remote-infra: ${outcome.reason}`;
    const waitData = { tool: opts.tool, host, reason: resolution, elapsedMs: Math.max(0, now() - waitStartedAt!),
      ...(outcome.kind === 'busy' ? { occupied: outcome.occupied ?? null, cap: hostCap } : {}) };
    logWait('wait-ended', waitData);
    write.err(`[gate.remote] wait ended on ${host} — reason=${resolution} elapsed=${Math.floor(waitData.elapsedMs / 1000)}s${outcome.kind === 'busy' ? ` slots=${outcome.occupied ?? 'unknown'}/${hostCap}` : ''}\n`);
  }
  if (opts.onRemoteOutcome) {
    try { opts.onRemoteOutcome(outcome, host, deps.runner ?? realGateRemoteRunner); }
    catch (error) { debug.log('gate.remote', 'outcome-hook-failed', { tool: opts.tool, host, error: error instanceof Error ? error.message : String(error) }); }
  }
  if (outcome.kind === 'busy') return fallback(`host-busy (occupied ${outcome.occupied ?? 'unknown'}/${hostCap}, held for ${settings.slotWaitSeconds}s)`, { stage: 'host-busy', rc: outcome.rc });
  if (outcome.kind === 'infra') return fallback(outcome.reason, { ...outcome, stage: outcome.stage ?? 'preflight', rc: outcome.rc ?? null });
  // Parity: the tool's own stdout/stderr/rc pass through unchanged; JSON gains host · remote:true,
  // and the self gate CLI appends a host diagnostic to human-readable stderr.
  debug.log('gate.remote', 'result', { tool: opts.tool, host: outcome.host, commit: outcome.commit, rc: outcome.rc, ms: outcome.ms });
  // Tool bytes pass through untouched; only a JSON object stdout is re-serialised (to add host · remote:true).
  const text = opts.json ? outcome.stdout.toString('utf8') : undefined;
  const annotated = text !== undefined ? annotateJsonStdout(text, outcome.host) : undefined;
  write.out(annotated !== undefined && annotated !== text ? annotated : outcome.stdout);
  write.err(outcome.stderr);
  if (opts.reportRemoteHost && !opts.json) write.err(`[gate.remote] executed on ${outcome.host} (rc=${outcome.rc})\n`);
  return outcome.rc;
}
