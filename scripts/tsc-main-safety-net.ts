import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../src/debug/log.js';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import { GATE_REMOTE_DEFAULTS, isValidGateHost, resolveGateRemoteSettings, runOnRemote, type ExecResult, type RemoteRunOptions, type RemoteRunOutcome } from '../src/self-implement/gate-remote.js';
import { getUserConfig } from '../src/user-config.js';
import { parseTypecheckErrors, tscEnv } from '../src/typecheck-ratchet.js';
import { compareDiagnostics, normalizeDiagnostics, type NormalizedDiagnostic } from './tsc-baseline-comparison.js';

const TSC_ARGV = ['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.gate.json', '--incremental', 'false'];
const COMMIT = /^[0-9a-f]{40}$/i;
const UNMEASURABLE = /\berror TS(?:2688|5083|6053):/;

export interface SafetyNetEntry {
  at: string;
  commit: string;
  outcome: 'clean' | 'added' | 'unmeasured' | 'baseline';
  total: number;
  added: NormalizedDiagnostic[];
  removed: number;
  ms: number;
  host: string;
  /** Full measured snapshot: `added` alone cannot serve as the next day's baseline. */
  diagnostics?: NormalizedDiagnostic[];
}

export interface SafetyNetDeps {
  local?: (cmd: string, args: string[], cwd: string, options?: { env?: NodeJS.ProcessEnv }) => ExecResult;
  remote?: (options: RemoteRunOptions) => RemoteRunOutcome;
  compare?: typeof compareDiagnostics;
  exists?: (path: string) => boolean;
  instanceRoot?: () => string;
  settings?: () => ReturnType<typeof resolveGateRemoteSettings>;
  now?: () => number;
  observed?: (entry: { commit: string; outcome: SafetyNetEntry['outcome']; total: number; added: number; removed: number; ms: number; host: string }) => void;
}

const realLocal: NonNullable<SafetyNetDeps['local']> = (cmd, args, cwd, options) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(options?.env ? { env: options.env } : {}) });
  return { rc: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: String(result.error) } : {}) };
};

function flags(argv: readonly string[]): { local: boolean; host?: string; ledger?: string; json: boolean } {
  let local = false;
  let host: string | undefined;
  let ledger: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--local') local = true;
    else if (arg === '--json') json = true;
    else if (arg === '--remote' || arg === '--ledger') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--remote') host = value;
      else ledger = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (local && host) throw new Error('--local and --remote cannot be combined');
  if (host && !isValidGateHost(host)) throw new Error(`invalid --remote host: ${host}`);
  return { local, host, ledger, json };
}

function measuredSnapshot(path: string): NormalizedDiagnostic[] | undefined {
  if (!existsSync(path)) return undefined;
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = rows.length - 1; i >= 0; i--) {
    const entry = JSON.parse(rows[i]!) as SafetyNetEntry;
    if (entry.outcome === 'unmeasured') continue;
    if (!Array.isArray(entry.diagnostics) || !entry.diagnostics.every((d) => d && typeof d.file === 'string' && typeof d.code === 'string' && typeof d.message === 'string')) {
      throw new Error('last measured ledger entry has no valid diagnostic snapshot');
    }
    return entry.diagnostics;
  }
  return undefined;
}

function diagnosticsOf(result: { rc: number | null; stdout: string; stderr: string; error?: string }, root: string): NormalizedDiagnostic[] | undefined {
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error || result.rc === null || (result.rc !== 0 && result.rc !== 1 && result.rc !== 2) || UNMEASURABLE.test(output)
    || /heap out of memory|Ineffective mark-compacts near heap limit/i.test(output)) return undefined;
  const parsed = parseTypecheckErrors(output);
  const errorLines = output.split(/\r?\n/).filter((line) => /\berror TS\d+:/.test(line));
  if (parsed.length !== errorLines.length || (result.rc === 0 && errorLines.length > 0) || (result.rc !== 0 && parsed.length === 0)) return undefined;
  if (output.split(/\r?\n/).some((line) => line.trim() && !/^.+\(\d+,\d+\):\s+error\s+TS\d+:/.test(line) && !/^\s+/.test(line)
    && !/^Found \d+ errors?\.?$/.test(line))) return undefined;
  return normalizeDiagnostics(parsed, root);
}

export async function runSafetyNet(repo: string, argv: readonly string[] = [], deps: SafetyNetDeps = {}): Promise<{ exitCode: number; entry: SafetyNetEntry; json: boolean }> {
  const input = flags(argv);
  const run = deps.local ?? realLocal;
  const remote = deps.remote ?? runOnRemote;
  const exists = deps.exists ?? existsSync;
  const root = deps.instanceRoot?.() ?? effectiveInstanceRoot();
  const settings = deps.settings?.() ?? (input.local ? GATE_REMOTE_DEFAULTS : resolveGateRemoteSettings(getUserConfig().gateRemote));
  const host = input.local ? 'local' : (input.host ?? settings.host ?? GATE_REMOTE_DEFAULTS.host);
  if (host !== 'local' && !isValidGateHost(host)) throw new Error(`invalid gateRemote host: ${host}`);
  const ledger = resolve(input.ledger ?? join(root, 'tsc-safety-net', 'ledger.jsonl'));
  const worktree = join(root, 'tsc-safety-net', 'worktree');
  const started = (deps.now ?? Date.now)();
  let commit = '';
  let diagnostics: NormalizedDiagnostic[] | undefined;
  let reason: string | undefined;
  let dependencyFailed = false;
  const git = (args: string[], cwd: string): ExecResult => {
    const env = { ...process.env };
    delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_COMMON_DIR;
    return run('git', args, cwd, { env });
  };
  const checked = (args: string[], cwd: string): ExecResult => {
    const result = git(args, cwd);
    if (result.error || result.rc !== 0) throw new Error(`git ${args.join(' ')}: ${result.error ?? result.stderr ?? `rc=${result.rc}`}`);
    return result;
  };
  try {
    checked(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], repo);
    commit = checked(['rev-parse', '--verify', 'origin/main^{commit}'], repo).stdout.trim();
    if (!COMMIT.test(commit)) throw new Error('origin/main did not resolve to a commit');
    if (!exists(worktree)) {
      mkdirSync(dirname(worktree), { recursive: true });
      checked(['worktree', 'add', '--detach', worktree, commit], repo);
    } else {
      const listed = checked(['worktree', 'list', '--porcelain'], repo).stdout;
      if (!listed.split('\n').some((line) => line === `worktree ${worktree}`)) throw new Error('worktree path is not a registered git worktree');
    }
    const status = checked(['status', '--porcelain'], worktree).stdout;
    if (status.trim()) checked(['reset', '--hard'], worktree);
    // Porcelain status omits ignored files, including stale .ts files from a previous measurement.
    checked(['clean', '-fdx', '-e', 'node_modules'], worktree);
    checked(['checkout', '--detach', 'origin/main'], worktree);
    if (checked(['rev-parse', 'HEAD'], worktree).stdout.trim() !== commit || checked(['status', '--porcelain'], worktree).stdout.trim()) throw new Error('worktree is not clean at origin/main');
    if (input.local) {
      // The retained node_modules may belong to yesterday's lockfile; frozen install reconciles it to this checkout.
      dependencyFailed = true;
      const install = run('bun', ['install', '--frozen-lockfile'], worktree);
      if (install.rc !== 0 || install.error || !exists(join(worktree, 'node_modules'))) {
        throw new Error(`local dependencies unavailable: ${install.error ?? install.stderr ?? `rc=${install.rc}`}`);
      }
      dependencyFailed = false;
      const result = run(TSC_ARGV[0]!, TSC_ARGV.slice(1), worktree, { env: tscEnv() });
      diagnostics = diagnosticsOf(result, worktree);
      if (!diagnostics) reason = 'local tsc did not produce a complete measurement';
    } else {
      const result = remote({ repo: worktree, host, mirror: settings.mirror, hostCap: settings.hostCap, argv: TSC_ARGV });
      if (result.kind === 'ran') {
        if (result.commit !== commit) throw new Error('remote measured a different commit');
        diagnostics = diagnosticsOf({ rc: result.rc, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }, worktree);
        if (!diagnostics) reason = 'remote tsc did not produce a complete measurement';
      } else reason = result.kind === 'busy' ? 'remote busy' : `remote infra: ${result.reason}`;
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  let previous: NormalizedDiagnostic[] | undefined;
  try { previous = measuredSnapshot(ledger); }
  catch (error) { diagnostics = undefined; reason = `ledger unreadable: ${error instanceof Error ? error.message : String(error)}`; }
  const comparison = diagnostics && previous ? (deps.compare ?? compareDiagnostics)(diagnostics, previous) : undefined;
  if (comparison?.kind === 'unavailable') reason = `comparison unavailable: ${comparison.reason}`;
  const outcome: SafetyNetEntry['outcome'] = !diagnostics || comparison?.kind === 'unavailable'
    ? 'unmeasured' : !previous ? 'baseline' : comparison?.kind === 'added' ? 'added' : 'clean';
  const entry: SafetyNetEntry = {
    at: new Date((deps.now ?? Date.now)()).toISOString(), commit, outcome, total: diagnostics?.length ?? 0,
    added: comparison && comparison.kind !== 'unavailable' ? comparison.added : [],
    removed: comparison && comparison.kind !== 'unavailable' ? comparison.removed.length : 0,
    ms: (deps.now ?? Date.now)() - started, host,
    ...(outcome !== 'unmeasured' && diagnostics ? { diagnostics } : {}),
  };
  if (!dependencyFailed) {
    mkdirSync(dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  }
  const observation = { commit, outcome, total: entry.total, added: entry.added.length, removed: entry.removed, ms: entry.ms, host };
  (deps.observed ?? ((data) => debug.log('tsc.safety-net', 'run', data)))(observation);
  if (reason) console.error(`[tsc.safety-net] ${reason}`);
  return { exitCode: outcome === 'unmeasured' ? 2 : outcome === 'added' ? 1 : 0, entry, json: input.json };
}

if (import.meta.main) {
  try {
    const result = await runSafetyNet(process.cwd(), process.argv.slice(2));
    console.log(result.json ? JSON.stringify(result.entry) : `[tsc.safety-net] ${result.entry.outcome} commit=${result.entry.commit} total=${result.entry.total} added=${result.entry.added.length} removed=${result.entry.removed} host=${result.entry.host}`);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`[tsc.safety-net] unmeasured: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
