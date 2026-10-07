/** LIGHT-RC (0.2.19) — a light release-candidate check between cuts: the changed-file self gate over everything that
 *  landed since the previous release's cut, plus an always-run test list (release/light-rc-always.txt), on the remote
 *  gate host (GATE-REMOTE). Read-only for the release ledger: it reads the previous published version and never writes.
 *  It does not touch the landing freeze or launch Pods. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfGateCli, type SelfGateCliOptions, type SelfGateCliResult } from '../self-implement/gate-cli.js';
import { dispatchHeavyCheck, isValidGateHost, type DispatchDeps, type DispatchOptions } from '../self-implement/gate-remote.js';
import { latestPublishedPreviousVersion } from '../../scripts/release-loop/unattended-release.js';
import { baseVersion, isReleaseVersion } from '../../scripts/release-loop/release-version.js';

export const LIGHT_RC_ALWAYS_FILE = 'release/light-rc-always.txt';
export const LIGHT_RC_DEFAULT_SHARDS = 4;
export const LIGHT_RC_NO_PREVIOUS_CUT = '직전 판 컷을 못 찾았다 — --base 로 준다';

export interface LightRcOptions {
  base?: string;
  /** Gate host; absent = config gateRemote.host (the dispatch's own default). */
  remote?: string;
  /** Run on this machine (the remote child is re-invoked with it). */
  local?: boolean;
  shards?: number;
  /** Release ledger root for the previous-version lookup (release run's deps.ledgerRoot). */
  ledgerRoot?: string;
  log?: (line: string) => void;
}

export interface LightRcResult {
  version: string;
  base: string;
  /** New failures vs. the base; null = the gate produced no measurement (never read as green). */
  introduced: number | null;
  preexisting: number | null;
  /** Failures the baseline could not classify (unknown + precondition-unmet); null = unmeasured. Non-zero is not green. */
  unclassified: number | null;
  alwaysInclude: number;
  alwaysIncludeMissing: string[];
  shards: number;
  /** Host the gate ran on; null = this machine. */
  remote: string | null;
  gateExitCode: number;
  ok: boolean;
}

export interface LightRcDeps {
  cwd?: string;
  git?: (args: string[], cwd: string) => { rc: number | null; stdout: string };
  previousVersion?: (version: string, ledgerRoot?: string) => string;
  readFile?: (path: string) => string | undefined;
  runGate?: (cwd: string, options: SelfGateCliOptions) => SelfGateCliResult;
  dispatch?: (opts: DispatchOptions, deps?: DispatchDeps) => Promise<number>;
  /** Extra dispatch deps (runner · settings) — tests drive the real dispatch with a fake host. */
  dispatchDeps?: Omit<DispatchDeps, 'write'>;
}

/** Shown when the gate ran remotely but the host name did not come back. */
export const LIGHT_RC_UNKNOWN_HOST = '(remote · host unknown)';

const defaultGit = (args: string[], cwd: string) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { rc: run.error ? null : run.status, stdout: run.stdout ?? '' };
};

/** One repository-relative path per line; `#` starts a comment; blank lines are skipped. */
export function parseAlwaysIncludeList(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean))];
}

/** The previous release's cut: merge-base of origin/main and origin/release/<previous published version>. */
export function previousCutBase(version: string, deps: LightRcDeps & { cwd: string; ledgerRoot?: string }): string {
  let previous: string;
  try {
    previous = (deps.previousVersion ?? latestPublishedPreviousVersion)(baseVersion(version), deps.ledgerRoot);
  } catch (error) {
    throw new Error(`${LIGHT_RC_NO_PREVIOUS_CUT} (${error instanceof Error ? error.message : String(error)})`);
  }
  const mergeBase = (deps.git ?? defaultGit)(['merge-base', 'origin/main', `origin/release/${previous}`], deps.cwd);
  const sha = mergeBase.stdout.trim();
  if (mergeBase.rc !== 0 || !sha) throw new Error(`${LIGHT_RC_NO_PREVIOUS_CUT} (git merge-base origin/main origin/release/${previous} rc=${mergeBase.rc})`);
  return sha;
}

function repoRoot(deps: LightRcDeps): string {
  if (deps.cwd) return deps.cwd;
  const top = defaultGit(['rev-parse', '--show-toplevel'], process.cwd());
  if (top.rc !== 0 || !top.stdout.trim()) throw new Error('release light-rc: not inside a git repository');
  return top.stdout.trim();
}

function parseRemoteResult(stdout: string): Partial<LightRcResult> | undefined {
  const line = stdout.split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{'));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line) as Partial<LightRcResult> & { host?: unknown };
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch { return undefined; }
}

export async function runLightRc(version: string, opts: LightRcOptions = {}, deps: LightRcDeps = {}): Promise<LightRcResult> {
  if (!isReleaseVersion(version)) throw new Error(`release version must be x.y.z: ${version}`);
  const shards = opts.shards ?? LIGHT_RC_DEFAULT_SHARDS;
  if (!Number.isSafeInteger(shards) || shards < 1) throw new Error(`invalid --shards count: ${opts.shards}`);
  if (opts.remote !== undefined && !isValidGateHost(opts.remote)) throw new Error(`invalid --remote host: ${opts.remote}`);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cwd = repoRoot(deps);
  const base = opts.base ?? previousCutBase(version, { ...deps, cwd, ledgerRoot: opts.ledgerRoot });
  const listPath = join(cwd, LIGHT_RC_ALWAYS_FILE);
  const listText = (deps.readFile ?? ((path: string) => existsSync(path) ? readFileSync(path, 'utf8') : undefined))(listPath);
  if (listText === undefined) throw new Error(`release light-rc: ${LIGHT_RC_ALWAYS_FILE} not found`);
  const alwaysInclude = parseAlwaysIncludeList(listText);

  let local: SelfGateCliResult | undefined;
  const runLocal = () => {
    local = (deps.runGate ?? runSelfGateCli)(cwd, { base, shards, alwaysInclude });
    for (const line of local.lines) log(line);
    return local.exitCode;
  };
  const captured: Buffer[] = [];
  const rc = await (deps.dispatch ?? dispatchHeavyCheck)({
    tool: 'self-gate', repo: cwd, installPwa: true, refs: [base], json: true,
    // The host re-runs this command with --local (and ELANOUS_GATE_REMOTE_CHILD=1), so it never recurses.
    remoteArgv: (sha) => ['bun', 'bin/elanous.mjs', 'release', 'light-rc', '--version', version, '--base', sha(base), '--shards', String(shards), '--local', '--json'],
    flags: { remote: opts.local ? undefined : opts.remote ?? true, local: !!opts.local },
    runLocal,
  }, {
    ...deps.dispatchDeps,
    write: {
      out: (data) => { captured.push(Buffer.from(data)); },
      err: (data) => { process.stderr.write(data); },
    },
  });

  let result: LightRcResult;
  if (local) {
    result = {
      version, base,
      introduced: local.baseline?.introduced ?? null,
      preexisting: local.baseline?.preexisting ?? null,
      unclassified: local.baseline ? local.baseline.unknown + local.baseline.preconditionUnmet : null,
      alwaysInclude: alwaysInclude.length,
      alwaysIncludeMissing: [...local.alwaysIncludeMissing],
      shards, remote: null, gateExitCode: local.exitCode, ok: false,
    };
  } else {
    const remote = parseRemoteResult(Buffer.concat(captured).toString('utf8'));
    if (!remote) throw new Error(`release light-rc: remote gate returned no result (rc=${rc})`);
    const host = (remote as { host?: unknown }).host;
    result = {
      version, base,
      introduced: typeof remote.introduced === 'number' ? remote.introduced : null,
      preexisting: typeof remote.preexisting === 'number' ? remote.preexisting : null,
      unclassified: typeof remote.unclassified === 'number' ? remote.unclassified : null,
      alwaysInclude: alwaysInclude.length,
      alwaysIncludeMissing: Array.isArray(remote.alwaysIncludeMissing) ? remote.alwaysIncludeMissing.map(String) : [],
      shards, remote: typeof host === 'string' && host ? host : opts.remote ?? LIGHT_RC_UNKNOWN_HOST,
      gateExitCode: typeof remote.gateExitCode === 'number' ? remote.gateExitCode : rc, ok: false,
    };
  }
  // Unmeasured (null) or unclassified failures are never green; policy-gate findings in the gate output are reported
  // (gate rc), not a regression.
  result.ok = result.introduced === 0 && result.unclassified === 0;
  debug.log('release.light-rc', 'done', { version, base, introduced: result.introduced, preexisting: result.preexisting, unclassified: result.unclassified, shards, remote: result.remote });
  return result;
}

export function formatLightRc(result: LightRcResult): string[] {
  return [
    `${result.ok ? '✅' : '⛔'} light-rc ${result.version} · base ${result.base.slice(0, 12)} · ${result.remote ? `host ${result.remote}` : 'local'} · shards ${result.shards}`,
    `  introduced ${result.introduced ?? '못 쟀다'} · preexisting ${result.preexisting ?? '못 쟀다'} · unclassified ${result.unclassified ?? '못 쟀다'} · always-include ${result.alwaysInclude}${result.alwaysIncludeMissing.length ? ` (missing: ${result.alwaysIncludeMissing.join(', ')})` : ''} · gate rc ${result.gateExitCode}`,
  ];
}
