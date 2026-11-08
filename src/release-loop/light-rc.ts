/** LIGHT-RC (0.2.19) — a light release-candidate check between cuts: the changed-file self gate over everything that
 *  landed since the previous release's cut, plus an always-run test list (release/light-rc-always.txt), on the remote
 *  gate host (GATE-REMOTE). It reads the previous published version and persists remote gate receipts in the release ledger.
 *  It does not touch the landing freeze or launch Pods. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { runSelfGateCliAsync, type SelfGateCliOptions, type SelfGateCliResult } from '../self-implement/gate-cli.js';
import { dispatchHeavyCheck, isValidGateHost, type DispatchDeps, type DispatchOptions } from '../self-implement/gate-remote.js';
import { latestPublishedPreviousVersion } from '../../scripts/release-loop/unattended-release.js';
import { baseVersion, isReleaseVersion } from '../../scripts/release-loop/release-version.js';
import type { GateOptions, GateResult, GateRunner } from '../../scripts/release-loop/gate-types.js';
import { executeTuiNodeCheck, type ExecutedTuiCheck } from '../../scripts/release-loop/tui-node-checks.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { gateBaselineReceipt, gateGraphPins } from '../../scripts/release-loop/gate-baseline-receipt.js';

export const LIGHT_RC_ALWAYS_FILE = 'release/light-rc-always.txt';
export const LIGHT_RC_DEFAULT_SHARDS = 4;
export const LIGHT_RC_NO_PREVIOUS_CUT = '직전 판 컷을 못 찾았다 — --base 로 준다';
/** RELEASE-DAILY-LIGHT-RC ① — what light-rc measures by default: main as it is on origin, not the tree it started in
 *  (10-12: the seat tree measured changed=2, a main worktree 52). */
export const LIGHT_RC_DEFAULT_HEAD = 'origin/main';

export interface LightRcOptions {
  base?: string;
  /** Commit to measure (RELEASE-DAILY-LIGHT-RC ①). Absent = `origin/main` after `git fetch origin main`. */
  head?: string;
  /** Gate host; absent = config gateRemote.host (the dispatch's own default). */
  remote?: string;
  /** Compare the pre-recipe remote path; intentionally hidden from normal CLI help. */
  legacySelfGate?: boolean;
  /** Run on this machine (the remote child is re-invoked with it). */
  local?: boolean;
  shards?: number;
  /** Maximum simultaneously active gate bundles, including per-file RSS samples (default three). */
  shardConcurrency?: number;
  /** OP FU — pass `--fixed-shard-distribution` to self gate (sorted round-robin into `shards`, no RSS pre-measurement).
   *  Opt-in; absent = the measured planner, unchanged. Also carried to the remote child. */
  fixedShardDistribution?: boolean;
  /** Release ledger root for the previous-version lookup (release run's deps.ledgerRoot). */
  ledgerRoot?: string;
  /** Current release-loop graph run; binds the rehearsal's reusable receipt to its pinned graph/recipe. */
  graphRunId?: string;
  log?: (line: string) => void;
  /** Rehearsal-only TUI screen check; other light-rc callers keep their current defaults. */
  rehearsalTui?: boolean;
}

/** Keep only a complete, identity-bound cut proof from the disposable host-gate instance. */
function persistHostReceiptArtifacts(instanceRoot: string, ledgerRoot: string, version: string, graphRunId: string | undefined): boolean {
  const versionRoot = join(instanceRoot, 'release', version);
  let verdict: Record<string, unknown>;
  let receipt: { valid?: unknown; executionIdentity?: unknown; commit?: unknown; graphSha?: unknown; recipeSha?: unknown; envFingerprint?: unknown } | undefined;
  try {
    verdict = JSON.parse(readFileSync(join(versionRoot, 'gate-verdict.json'), 'utf8')) as Record<string, unknown>;
    receipt = verdict.baselineReceipt as typeof receipt;
  } catch { return false; }
  if (receipt?.valid !== true || !receipt.executionIdentity || typeof receipt.commit !== 'string'
    || typeof receipt.graphSha !== 'string' || typeof receipt.recipeSha !== 'string' || typeof receipt.envFingerprint !== 'string') return false;
  const source = join(versionRoot, 'gate-logs', 'cut');
  if (!existsSync(source)) return false;
  let failures: { commit: string; failures: string[]; errors: string[] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(versionRoot, 'gate-failures.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const row = parsed as { commit?: unknown; failures?: unknown; errors?: unknown };
    const errors = row.errors === undefined ? [] : row.errors;
    if (row.commit !== receipt.commit || !Array.isArray(row.failures) || !row.failures.every((item) => typeof item === 'string')
      || !Array.isArray(errors) || !errors.every((item) => typeof item === 'string') || errors.length > 0) return false;
    failures = { commit: row.commit as string, failures: row.failures as string[], errors: errors as string[] };
  } catch { return false; }
  const pins = gateGraphPins(ledgerRoot, graphRunId);
  if (!pins || pins.graphSha !== receipt.graphSha || pins.recipeSha !== receipt.recipeSha) return false;
  const versionLedger = join(ledgerRoot, 'release', version);
  const verdictPath = join(versionLedger, 'gate-verdict.json');
  const evidenceParent = join(versionLedger, 'light-rc-receipts');
  const finalRoot = join(evidenceParent, `${graphRunId}-${randomUUID()}`);
  const artifactPath = relative(ledgerRoot, finalRoot);
  const parent = evidenceParent;
  let stagingRoot: string | undefined;
  try {
    mkdirSync(parent, { recursive: true });
    stagingRoot = mkdtempSync(join(parent, '.incoming-light-rc-'));
    mkdirSync(join(stagingRoot, 'gate-logs'), { recursive: true });
    cpSync(source, join(stagingRoot, 'gate-logs', 'cut'), { recursive: true, errorOnExist: true });
    writeFileSync(join(stagingRoot, 'gate-failures.json'), JSON.stringify(failures, null, 2) + '\n', { mode: 0o600 });
    renameSync(stagingRoot, finalRoot);
    const persisted = gateBaselineReceipt({ root: ledgerRoot, version, commit: receipt.commit, fullSweep: true,
      graphPins: pins, envFingerprint: receipt.envFingerprint, artifactPath });
    if (!persisted.valid || !persisted.executionIdentity || JSON.stringify(persisted.executionIdentity) !== JSON.stringify(receipt.executionIdentity)) {
      return false;
    }
    const temp = join(versionLedger, `.gate-verdict-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify({ ...verdict, baselineReceipt: persisted }, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, verdictPath);
    } finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
    return true;
  } catch (error) {
    debug.log('release.light-rc', 'receipt-copy-failed', { version, graphRunId: graphRunId ?? null,
      error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  finally { if (stagingRoot && existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true }); }
}

function copyReleaseGraphRun(ledgerRoot: string, instanceRoot: string, runId: string | undefined): void {
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) return;
  const source = join(ledgerRoot, 'graph-runs', 'release-loop', `${runId}.json`);
  if (!existsSync(source)) return;
  const targetDir = join(instanceRoot, 'graph-runs', 'release-loop');
  mkdirSync(targetDir, { recursive: true });
  const temp = join(targetDir, `.${runId}-${randomUUID()}.tmp`);
  try { cpSync(source, temp); renameSync(temp, join(targetDir, `${runId}.json`)); }
  finally { if (existsSync(temp)) rmSync(temp, { force: true }); }
}

function activeReleaseGraphRunId(): string | undefined {
  const contextPath = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!contextPath) return undefined;
  try {
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { graphId?: unknown; runId?: unknown };
    return context.graphId === 'release-loop' && typeof context.runId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context.runId) ? context.runId : undefined;
  } catch { return undefined; }
}

function configuredGatePodPool(): string | undefined {
  try {
    const { getUserConfig } = require('../user-config.js') as typeof import('../user-config.js');
    const pool = getUserConfig().harness?.podPool;
    return typeof pool === 'string' && pool.trim() ? pool.trim() : undefined;
  } catch { return undefined; }
}

export interface LightRcResult {
  version: string;
  base: string;
  /** The commit the gate measured (RELEASE-DAILY-LIGHT-RC ①) — origin/main unless --head was given. */
  measuredCommit: string;
  /** HEAD of the tree light-rc was started from; differs from measuredCommit when it ran from a seat/work tree. */
  worktreeHead: string | null;
  /** RELEASE-DAILY-LIGHT-RC ② — tests added because they import a changed source; null = not reported. */
  importerTests: number | null;
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
  /** LIGHT-RC-MEASURE ③ — why the gate produced no measurement (e.g. `shard-2`); null = it measured. Carried in the
   *  JSON so the reason reaches the caller even when the remote child's human lines (stderr) do not. */
  unmeasured: string | null;
  rehearsalTui?: ExecutedTuiCheck;
}

export interface LightRcDeps {
  cwd?: string;
  git?: (args: string[], cwd: string) => { rc: number | null; stdout: string };
  previousVersion?: (version: string, ledgerRoot?: string) => string;
  readFile?: (path: string) => string | undefined;
  runGate?: (cwd: string, options: SelfGateCliOptions) => SelfGateCliResult | Promise<SelfGateCliResult>;
  /** Release gate recipe seam for explicitly selected remote rehearsal hosts. */
  runFormalHostGate?: (options: GateOptions, runner?: GateRunner) => Promise<GateResult>;
  /** Test seam; production resolves the remote rehearsal Pod pool from harness.podPool. */
  gatePodPool?: string;
  /** Optional runner injection for tests that exercise judgeGate itself without remote side effects. */
  formalHostGateRunner?: GateRunner;
  dispatch?: (opts: DispatchOptions, deps?: DispatchDeps) => Promise<number>;
  /** Extra dispatch deps (runner · settings) — tests drive the real dispatch with a fake host. */
  dispatchDeps?: Omit<DispatchDeps, 'write'>;
  tuiCheck?: typeof executeTuiNodeCheck;
  /** Detached checkout of `sha` for a local run whose tree is not at the measured commit (default: git worktree add
   *  --detach in a temp dir ⊕ bun install); `cleanup` removes it. */
  checkout?: (sha: string, repo: string, log: (line: string) => void) => { dir: string; cleanup: () => void };
}

/** Shown when the gate ran remotely but the host name did not come back. */
export const LIGHT_RC_UNKNOWN_HOST = '(remote · host unknown)';
/** No measurement came back and the gate named no reason (an older gate, or a result without the field). */
export const LIGHT_RC_REASON_NOT_REPORTED = 'reason not reported';

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

const SHA_RE = /^[0-9a-f]{40}$/;

/** RELEASE-DAILY-LIGHT-RC ① — the commit to measure. Default: fetch origin main, then origin/main (a failed fetch is
 *  said, and the local origin/main is measured — never silently the tree's HEAD). */
export function resolveMeasuredCommit(cwd: string, head: string | undefined, deps: LightRcDeps, log: (line: string) => void): { measuredCommit: string; worktreeHead: string | null } {
  const git = deps.git ?? defaultGit;
  const ref = head ?? LIGHT_RC_DEFAULT_HEAD;
  if (head === undefined) {
    const fetch = git(['fetch', '--quiet', 'origin', 'main'], cwd);
    if (fetch.rc !== 0) {
      log(`⚠️ light-rc: git fetch origin main rc=${fetch.rc} — measuring the local ${LIGHT_RC_DEFAULT_HEAD} (may be stale)`);
      debug.log('release.light-rc', 'fetch-failed', { rc: fetch.rc });
    }
  }
  const parsed = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  const measuredCommit = parsed.stdout.trim();
  if (parsed.rc !== 0 || !SHA_RE.test(measuredCommit)) throw new Error(`release light-rc: cannot resolve ${ref} to a commit (rc=${parsed.rc})`);
  const top = git(['rev-parse', 'HEAD'], cwd);
  const worktreeHead = top.rc === 0 && SHA_RE.test(top.stdout.trim()) ? top.stdout.trim() : null;
  if (worktreeHead !== measuredCommit) {
    log(`ⓘ light-rc measures ${measuredCommit.slice(0, 12)} (${ref}) — this tree's HEAD ${worktreeHead?.slice(0, 12) ?? '(unresolved)'} is not what is measured`);
    debug.log('release.light-rc', 'measured-commit-differs', { ref, measuredCommit, worktreeHead, cwd });
  }
  return { measuredCommit, worktreeHead };
}

function defaultCheckout(sha: string, repo: string, log: (line: string) => void): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-light-rc-'));
  const run = (cmd: string, args: string[], cwd: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = () => {
    run('git', ['worktree', 'remove', '--force', dir], repo);
    rmSync(dir, { recursive: true, force: true });
    run('git', ['worktree', 'prune'], repo);
  };
  const add = run('git', ['worktree', 'add', '--detach', dir, sha], repo);
  if (add.status !== 0) { cleanup(); throw new Error(`release light-rc: git worktree add ${sha.slice(0, 12)} failed: ${(add.stderr ?? '').trim()}`); }
  log(`light-rc: detached checkout of ${sha.slice(0, 12)} at ${dir} — installing dependencies`);
  for (const sub of ['.', 'apps/pwa']) {
    if (!existsSync(join(dir, sub, 'package.json'))) continue;
    const install = run('bun', ['install', '--frozen-lockfile'], join(dir, sub));
    if (install.status !== 0) { cleanup(); throw new Error(`release light-rc: bun install (${sub}) failed in the checkout: ${(install.stderr ?? '').trim().slice(-400)}`); }
  }
  return { dir, cleanup };
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
  if (opts.shardConcurrency !== undefined && (!Number.isSafeInteger(opts.shardConcurrency) || opts.shardConcurrency < 1 || opts.shardConcurrency > 4)) throw new Error(`invalid --shard-concurrency: ${opts.shardConcurrency}`);
  if (opts.remote !== undefined && !isValidGateHost(opts.remote)) throw new Error(`invalid --remote host: ${opts.remote}`);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cwd = repoRoot(deps);
  const { measuredCommit, worktreeHead } = resolveMeasuredCommit(cwd, opts.head, deps, log);
  const base = opts.base ?? previousCutBase(version, { ...deps, cwd, ledgerRoot: opts.ledgerRoot });
  const readList = (dir: string) => {
    const text = (deps.readFile ?? ((path: string) => existsSync(path) ? readFileSync(path, 'utf8') : undefined))(join(dir, LIGHT_RC_ALWAYS_FILE));
    if (text === undefined) throw new Error(`release light-rc: ${LIGHT_RC_ALWAYS_FILE} not found`);
    return parseAlwaysIncludeList(text);
  };
  let alwaysInclude = readList(cwd);

  // A named remote rehearsal must measure with the release graph's host gate recipe. The public light-rc result shape
  // stays the same; only its execution path changes. Host gate shard assignment is currently the graph's four groups.
  if (opts.remote !== undefined && !opts.legacySelfGate) {
    if (shards !== LIGHT_RC_DEFAULT_SHARDS) return {
      version, base, measuredCommit, worktreeHead, importerTests: null, introduced: null, preexisting: null,
      unclassified: null, alwaysInclude: alwaysInclude.length, alwaysIncludeMissing: [], shards, remote: opts.remote,
      gateExitCode: 2, ok: false, unmeasured: 'host-gate-shard-contract-mismatch',
    };
    const resolvedBase = (deps.git ?? defaultGit)(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd);
    const base40 = resolvedBase.stdout.trim();
    if (resolvedBase.rc !== 0 || !SHA_RE.test(base40)) throw new Error(`release light-rc: --base does not resolve to a commit (${base})`);
    const scratch = mkdtempSync(join(tmpdir(), 'elanous-light-rc-host-gate-'));
    try {
      const graphRunId = opts.graphRunId ?? activeReleaseGraphRunId();
      const ledgerRoot = opts.ledgerRoot ?? releaseLedgerRoot();
      copyReleaseGraphRun(ledgerRoot, scratch, graphRunId);
      const gatePodPool = opts.remote ? deps.gatePodPool ?? configuredGatePodPool() : undefined;
      const previous = (() => { try { return (deps.previousVersion ?? latestPublishedPreviousVersion)(baseVersion(version), opts.ledgerRoot); } catch { return undefined; } })();
      const options: GateOptions = {
        commit: measuredCommit, version, baselineCommit: base40, ...(previous ? { baselineVersion: previous } : {}),
        ...(graphRunId ? { graphRunId } : {}),
        ...(gatePodPool ? { pod: { pool: gatePodPool, shards } } : {}),
        executor: 'host', remote: opts.remote, full: true, rehearsalTui: opts.rehearsalTui,
        // Keep the gate's disposable instance state isolated, but persist its receipt in the release ledger so the
        // cut gate can inherit same-head/changed-radius evidence after this rehearsal returns.
        repo: cwd, instanceRoot: scratch, ledgerRoot: scratch, shardLedgerRoot: ledgerRoot, scratchOnly: true,
      };
      const gate = deps.runFormalHostGate
        ? await deps.runFormalHostGate(options, deps.formalHostGateRunner)
        : await import('../../scripts/release-loop/gate-api-leaf.js').then(({ judgeGate }) => judgeGate(options, deps.formalHostGateRunner));
      if (persistHostReceiptArtifacts(scratch, ledgerRoot, version, graphRunId)) {
        debug.log('release.light-rc', 'receipt-preserved', { version, commit: measuredCommit, graphRunId: graphRunId ?? null });
      }
      const unclassifiedCount = (gate.stalledShards?.length ?? 0) + (gate.unmeasuredErrors?.length ?? 0)
        + (gate.unmeasuredRecheckFiles?.length ?? 0) + gate.stalledEnv.length;
      const alwaysIncludeMissing = alwaysInclude.filter((path) => !existsSync(join(cwd, path)));
      const rehearsalTui = opts.rehearsalTui ? gate.rehearsalTui ?? { outcome: 'unmeasured' as const, detail: 'release host gate runner did not return remote TUI evidence' } : undefined;
      return {
        version, base: base40, measuredCommit, worktreeHead, importerTests: null,
        introduced: gate.outcome === 'error' ? null : gate.introduced.length,
        preexisting: gate.outcome === 'error' ? null : gate.preexisting,
        unclassified: gate.outcome === 'error' ? null : unclassifiedCount,
        alwaysInclude: alwaysInclude.length, alwaysIncludeMissing, shards, remote: opts.remote,
        gateExitCode: rehearsalTui && rehearsalTui.outcome !== 'ok' ? 2 : gate.outcome === 'ok' ? 0 : gate.outcome === 'regression' ? 1 : 2,
        ok: gate.outcome === 'ok' && unclassifiedCount === 0 && (!rehearsalTui || rehearsalTui.outcome === 'ok'),
        unmeasured: gate.outcome === 'error' ? gate.error ?? 'host-gate-unmeasured' : null,
        ...(rehearsalTui ? { rehearsalTui } : {}),
      };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }

  let local: SelfGateCliResult | undefined;
  let localTui: ExecutedTuiCheck | undefined;
  const runLocal = async () => {
    // ① The gate scopes by its tree's HEAD — so a tree that is not at the measured commit runs in a detached checkout of it.
    const checkout = worktreeHead === measuredCommit ? undefined : (deps.checkout ?? defaultCheckout)(measuredCommit, cwd, log);
    try {
      const dir = checkout?.dir ?? cwd;
      if (checkout) alwaysInclude = readList(dir);
      local = await (deps.runGate ?? runSelfGateCliAsync)(dir, { base, shards, ...(opts.shardConcurrency !== undefined ? { shardConcurrency: opts.shardConcurrency } : {}), ...(opts.fixedShardDistribution ? { fixedShardDistribution: true } : {}), alwaysInclude, includeImporterTests: true });
      if (opts.rehearsalTui) {
        const command = async (cmd: string, args: string[], tree: string, limitMs?: number) => {
          const run = spawnSync(cmd, args, { cwd: tree, encoding: 'utf8', timeout: limitMs });
          return { rc: run.status ?? 2, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` };
        };
        localTui = await (deps.tuiCheck ?? executeTuiNodeCheck)(measuredCommit, dir, command);
      }
    } finally { checkout?.cleanup(); }
    for (const line of local.lines) log(line);
    return local.exitCode;
  };
  const captured: Buffer[] = [];
  const rc = await (deps.dispatch ?? dispatchHeavyCheck)({
    // Keep the self-gate contract: an unavailable remote leaves this release check unmeasured; do not start a heavy gate locally.
    tool: 'self-gate', repo: cwd, installPwa: true, refs: [base], json: true, commit: measuredCommit,
    // The host re-runs this command with --local (and ELANOUS_GATE_REMOTE_CHILD=1), so it never recurses.
    remoteArgv: (sha) => ['bun', 'bin/elanous.mjs', 'release', 'light-rc', '--version', version, '--base', sha(base), '--head', measuredCommit, '--shards', String(shards), ...(opts.shardConcurrency !== undefined ? ['--shard-concurrency', String(opts.shardConcurrency)] : []), ...(opts.fixedShardDistribution ? ['--fixed-shard-distribution'] : []), '--local', '--json', ...(opts.rehearsalTui ? ['--rehearsal-tui'] : [])],
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
      version, base, measuredCommit, worktreeHead,
      importerTests: local.importerTestsAdded ? local.importerTestsAdded.length : null,
      introduced: local.baseline?.introduced ?? null,
      preexisting: local.baseline?.preexisting ?? null,
      unclassified: local.baseline ? local.baseline.unknown + local.baseline.preconditionUnmet : null,
      alwaysInclude: alwaysInclude.length,
      alwaysIncludeMissing: [...local.alwaysIncludeMissing],
      shards, remote: null, gateExitCode: local.exitCode, ok: false,
      unmeasured: local.unmeasuredReason ?? (local.baseline ? null : LIGHT_RC_REASON_NOT_REPORTED),
    };
  } else {
    const remote = parseRemoteResult(Buffer.concat(captured).toString('utf8'));
    if (!remote) throw new Error(`release light-rc: remote gate returned no result (rc=${rc})`);
    const host = (remote as { host?: unknown }).host;
    result = {
      version, base, measuredCommit, worktreeHead,
      importerTests: typeof remote.importerTests === 'number' ? remote.importerTests : null,
      introduced: typeof remote.introduced === 'number' ? remote.introduced : null,
      preexisting: typeof remote.preexisting === 'number' ? remote.preexisting : null,
      unclassified: typeof remote.unclassified === 'number' ? remote.unclassified : null,
      alwaysInclude: alwaysInclude.length,
      alwaysIncludeMissing: Array.isArray(remote.alwaysIncludeMissing) ? remote.alwaysIncludeMissing.map(String) : [],
      shards, remote: typeof host === 'string' && host ? host : opts.remote ?? LIGHT_RC_UNKNOWN_HOST,
      gateExitCode: typeof remote.gateExitCode === 'number' ? remote.gateExitCode : rc, ok: false,
      unmeasured: typeof remote.unmeasured === 'string' && remote.unmeasured
        ? remote.unmeasured
        : typeof remote.introduced === 'number' ? null : LIGHT_RC_REASON_NOT_REPORTED,
      ...(remote.rehearsalTui ? { rehearsalTui: remote.rehearsalTui } : {}),
    };
  }
  // Unmeasured (null) or unclassified failures are never green; policy-gate findings in the gate output are reported
  // (gate rc), not a regression.
  if (opts.rehearsalTui) {
    if (local) {
      result.rehearsalTui = localTui ?? { outcome: 'unmeasured', detail: 'local TUI screen result missing' };
    } else {
      const tui = result.rehearsalTui;
      result.rehearsalTui = tui && ['ok', 'fail', 'unmeasured'].includes(tui.outcome) && typeof tui.detail === 'string' && tui.detail.length > 0
        ? tui : { outcome: 'unmeasured', detail: 'remote TUI screen result missing' };
    }
  }
  result.ok = result.introduced === 0 && result.unclassified === 0 && result.unmeasured === null
    && (!opts.rehearsalTui || result.rehearsalTui?.outcome === 'ok');
  debug.log('release.light-rc', 'done', { version, base, measuredCommit, worktreeHead, importerTests: result.importerTests, introduced: result.introduced, preexisting: result.preexisting, unclassified: result.unclassified, shards, remote: result.remote, unmeasured: result.unmeasured });
  return result;
}

export function formatLightRc(result: LightRcResult): string[] {
  return [
    `${result.ok ? '✅' : '⛔'} light-rc ${result.version} · base ${result.base.slice(0, 12)} · measured ${result.measuredCommit.slice(0, 12)} · ${result.remote ? `host ${result.remote}` : 'local'} · shards ${result.shards}`,
    `  introduced ${result.introduced ?? '못 쟀다'} · preexisting ${result.preexisting ?? '못 쟀다'} · unclassified ${result.unclassified ?? '못 쟀다'} · importer tests ${result.importerTests ?? '못 쟀다'} · always-include ${result.alwaysInclude}${result.alwaysIncludeMissing.length ? ` (missing: ${result.alwaysIncludeMissing.join(', ')})` : ''} · gate rc ${result.gateExitCode}`,
    ...(result.unmeasured !== null ? [`  shards: unmeasured (${result.unmeasured})`] : []),
    ...(result.rehearsalTui ? [`  TUI screens: ${result.rehearsalTui.outcome} (${result.rehearsalTui.detail})`] : []),
  ];
}
