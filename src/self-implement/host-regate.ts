import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { getUserConfig } from '../user-config.js';
import { publicExposureFiles, runExposeGate } from './expose-gate.js';
import { admitLandingMerge } from './frozen-merges.js';
import { releaseGitDiffPaths, releasePathHold, releasePathHoldShouldPost, releasePathHoldComment, releasePathHoldCommentsArgs, RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { detectTestInterference, failedNamesFromStreams, parseFailureCount, runBunTest, type MeasuredRun } from '../../scripts/detect-test-interference.js';
import { MAX_INSPECTED_TEST_FILES, runTestInterferenceGate } from '../../scripts/ci-test-interference-gate.js';
import { pwaGraph, pwaReach } from '../../scripts/ci-pwa-build-gate.js';
import { changedPathPairs, changedTsFiles, readGitFile, requiredExportFieldsInChanges } from '../../scripts/ci-typecheck-changed.js';
import { classifyMergeFailure, clipRegateDetail, parseConflictFiles, type HostRegateFailure } from './regate-detail.js';
import { buildImporterTestIndex, isTestPath } from './importer-test-index.js';
import type { GateReceipt, GateReceiptIdentity } from './gate-receipt-registry.js';

/** Use pr-land's PWA reachability (including its undecidable-graph build fallback), not a blanket src/** trigger. */
export function needsPwaBuild(files: readonly string[], repoRoot: string, graph: (root: string) => ReturnType<typeof pwaGraph> = pwaGraph): boolean {
  return pwaReach(files, () => graph(repoRoot)).reaches;
}

/**
 * Give a temporary checkout the source checkout's dependencies: link `<dir>/node_modules` when it is really installed
 * there (its `marker` package exists), otherwise install into the candidate. Shared by host regate and the task agent's
 * land worktree (TA-LAND-WORKTREE).
 */
export function provideCheckoutDependencies(candidate: string, sourceRoot: string, dir: string, marker: string, install: (cwd: string) => void): void {
  const candidateModules = join(candidate, dir, 'node_modules');
  const candidateMarker = join(candidateModules, marker, 'package.json');
  const sourceModules = join(sourceRoot, dir, 'node_modules');
  if (existsSync(candidateMarker)) return;
  if (existsSync(join(sourceModules, marker, 'package.json'))) {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try { stat = lstatSync(candidateModules); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) {
        // A dangling or stale link can block symlinkSync with EEXIST; unlink only the link itself.
        try { unlinkSync(candidateModules); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else if (stat.isDirectory() && readdirSync(candidateModules).length === 0) {
        try { rmdirSync(candidateModules); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
            install(join(candidate, dir));
            return;
          }
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      else {
        install(join(candidate, dir));
        return;
      }
    }
    try {
      symlinkSync(sourceModules, candidateModules, 'dir');
    } catch (error) {
      // Concurrent host regates may provision the same checked-out worktree. The first link wins;
      // accept EEXIST only after confirming its package marker is now visible.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !existsSync(candidateMarker)) throw error;
    }
  } else install(join(candidate, dir));
}

export interface HostRegateInput { prNumber: number; headCommit: string; repoRoot: string; goalFile?: string; verifyOnly?: boolean; /** STOP-HEAL-WINNOW: measurement only on a preserved draft; never valid for landing. */ allowDraft?: true; /** TA-LIVE-LAND-2: run the full landing gates (release-path hold · neighbours · PR re-read) but stop before the freeze admission and `gh pr merge` — the task agent lands it later via `pr land --expected-head`. */ noMerge?: true; /** Called by a resume sweep that already holds this PR's claim. */ resumed?: true }
export interface HostRegateResult { passed: boolean; failures: HostRegateFailure[]; os: string; status?: 'passed' | 'failed' | 'unmeasured' | 'frozen'; /** verifyOnly: 실제로 얹어 잰 base 끝 */ baseCommit?: string }
/** Only a missing host repository is recoverable by selecting the run's recorded root. Gate failures are final. */
export function hostRepositoryUnavailable(result: HostRegateResult): boolean {
  return !result.passed && result.status === 'unmeasured'
    && result.failures[0]?.step === 'host-regate'
    && result.failures[0].detail === 'host repository unavailable';
}
export type InterferenceVerdict = { passed: boolean; detail?: string; unmeasured?: boolean; /** neighbour tests left out so the selection fits the inspection cap */ neighborsTrimmed?: number; /** importer tests left out after changed tests and all selected neighbors take priority */ importerTrimmed?: number };
export type HostRegateDeps = {
  command?: (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string };
  interference?: (files: readonly string[], cwd: string) => Promise<InterferenceVerdict>;
  /** Legacy injection for callers that supply an ephemeral worktree instead of a locked slot. */
  makeTemp?: () => string;
  removeTemp?: (path: string) => void;
  acquire?: (repoRoot: string) => Promise<() => void>;
  log?: (event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => void;
  freezeRoot?: string;
  /** Test seam for the operational freeze authority; production always uses the host root. */
  prodFreezeRoot?: string;
  runExposeGate?: typeof runExposeGate;
  syncMergedChecklist?: typeof import('../release-loop/merged-pr-checklist.js').syncMergedPrChecklist;
  /** GATE-ONCE-PER-HEAD (OP 10-27 23:0x): persistent passed-receipt registry file. Default: <git-common-dir>/elanous-host-regate/gate-receipts.json. */
  gateReceiptPath?: string;
  /** Environment the receipt fingerprint reads; production uses the host process env. */
  gateReceiptEnv?: NodeJS.ProcessEnv;
};

/**
 * REGATE-PWA-DEPS-FOR-TSC (#26698 → #27484 must-fix): the typecheck gate requires apps/pwa dependencies for
 * `runsPwa || wholeRepository` — present .ts/.tsx under apps/pwa/ in its own changed set, or any of its
 * whole-repository promotion triggers (필수 export 필드 추가 · exported 심볼 삭제 · exported 함수 매개변수 증가,
 * in ANY changed file). Decide it with the gate's own collectors — changedTsFiles ⊕ changedPathPairs ⊕
 * requiredExportFieldsInChanges — against the candidate worktree and the same TSC_BASE_REF the gate receives,
 * so dependency provision and restoration can never be narrower than the real typecheck scope. Git observation
 * goes through the regate's injectable `command` seam (hermetic tests); changedTsFiles composes whitespace-token
 * command strings, so its shell runner just splits them into (bin, args).
 */
export function typecheckGateTouchesPwa(
  worktree: string,
  typecheckBase: string,
  command: NonNullable<HostRegateDeps['command']>,
): boolean {
  const git = (bin: string, args: readonly string[]): unknown => {
    const r = command(bin, args, worktree);
    if (r.status !== 0) throw Object.assign(new Error((r.stderr || r.stdout || `${bin} exited ${String(r.status)}`).trim()), { status: r.status });
    return r.stdout;
  };
  const changed = changedTsFiles((cmd) => {
    const [bin, ...args] = cmd.split(' ');
    return git(bin, args) as string;
  }, { ...process.env, TSC_BASE_REF: typecheckBase }, worktree);
  // Collection failures make the gate exit(1) before its dependency requirement; an empty changed set makes it
  // pass without running tsc — neither path can demand apps/pwa dependencies.
  if ((changed.failures?.length ?? 0) > 0 || changed.files.size === 0) return false;
  // runsPwa: a present .ts/.tsx under apps/pwa/ in the gate's own changed set.
  if ([...changed.files].some((file) => file.startsWith('apps/pwa/'))) return true;
  const triggers = requiredExportFieldsInChanges(
    changed.files,
    changed.base,
    changedPathPairs(changed.base, git),
    (ref, path) => readGitFile(ref, path, git),
    (file) => readFileSync(join(worktree, file), 'utf8'),
  );
  // A judgement failure makes the gate exit(1) before its dependency requirement, like the collection failures above.
  if (triggers.failure) return false;
  // wholeRepository: any promotion trigger widens the inspection to the whole repository, apps/pwa included.
  return triggers.fields.length > 0 || triggers.removedSymbols.length > 0 || triggers.parameterIncreases.length > 0;
}

const SPAWN_MAX_BUFFER = 256 * 1024 * 1024;

const defaultCommand: NonNullable<HostRegateDeps['command']> = (bin, args, cwd, env) => {
  // bun ≥1.4 applies Node's 1MB default maxBuffer and silently truncates — test output here is often larger.
  const r = spawnSync(bin, [...args], { cwd, env: env ?? process.env, encoding: 'utf8', timeout: 600_000, maxBuffer: SPAWN_MAX_BUFFER });
  const overflow = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS';
  return { status: overflow ? null : r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? `${r.error.message} (${overflow ? `output exceeded ${SPAWN_MAX_BUFFER} bytes` : 'command unavailable'})` : '') };
};

/** Keep the failure identity in both the returned detail and the host-regate ledger event. */
function failureNames(runs: readonly MeasuredRun[], fileCap: number, testCap: number): string {
  const failed = runs.filter((run) => run.fail !== null && run.fail > 0);
  if (!failed.length) return 'none';
  const files = [...new Set(failed.flatMap((run) => run.failedFiles ?? []))];
  const tests = [...new Set(failed.flatMap((run) => run.failedTests ?? []))];
  const bounded = (names: string[], cap: number): string => names.length
    ? `${names.slice(0, cap).map((name) => name.slice(0, 120)).join(' | ')}${names.length > cap ? ` | +${names.length - cap} more` : ''}`
    : 'unknown';
  return `files=${bounded(files, fileCap)}; tests=${bounded(tests, testCap)}`;
}

/** The informational pr-land gate always returns zero; enforce its measured report and the combined test result instead. */
export async function defaultInterference(files: readonly string[], cwd: string, opts: {
  neighbors?: boolean;
  detect?: typeof detectTestInterference;
  run?: (files: readonly string[], cwd: string) => ReturnType<typeof runBunTest>;
  buildImporterTestIndex?: typeof buildImporterTestIndex;
} = {}): Promise<InterferenceVerdict> {
  const tests = [...new Set(files.filter((file) => /\.test\.tsx?$/.test(file)))].sort();
  const changed = new Set(tests);
  const changedSources = [...new Set(files.filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file) && !isTestPath(file)))].sort();
  const importers = new Set<string>();
  const neighbors = new Set<string>();
  let importerIndexFailed = false;

  // verifyOnly measures changed tests only; it deliberately does not construct or add importer/folder tests.
  if (opts.neighbors !== false && changedSources.length > 0) {
    try {
      const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (listed.status !== 0 || listed.error) importerIndexFailed = true;
      else {
        const paths = listed.stdout.split('\0').filter(Boolean);
        const testPaths = paths.filter(isTestPath);
        const sourcePaths = [...new Set([
          ...paths.filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path) && !isTestPath(path)),
          ...changedSources,
        ])];
        const index = (opts.buildImporterTestIndex ?? buildImporterTestIndex)(cwd, testPaths, sourcePaths);
        if (!index) importerIndexFailed = true;
        else for (const source of changedSources) {
          for (const test of index.testsBySource.get(source) ?? []) if (!changed.has(test)) importers.add(test);
        }
      }
    } catch {
      importerIndexFailed = true;
    }
  }

  // Existing folder neighbors remain the final, lowest-priority selection tier.
  if (opts.neighbors !== false) for (const file of tests) {
    for (const sibling of readdirSync(join(cwd, dirname(file)))) {
      const path = join(dirname(file), sibling);
      if (/\.test\.tsx?$/.test(sibling) && !changed.has(path)) neighbors.add(path);
    }
  }
  for (const importer of importers) neighbors.delete(importer);

  const sortedImporters = [...importers].sort();
  const sortedNeighbors = [...neighbors].sort();
  const room = Math.max(0, MAX_INSPECTED_TEST_FILES - tests.length);
  const keptImporters = sortedImporters.slice(0, room);
  const importerTrimmed = sortedImporters.length - keptImporters.length;
  const neighborRoom = Math.max(0, room - keptImporters.length);
  const keptNeighbors = sortedNeighbors.slice(0, neighborRoom);
  const neighborsTrimmed = sortedNeighbors.length - keptNeighbors.length;
  const trimmedCount = importerTrimmed + neighborsTrimmed;
  const trimmed = {
    ...(neighborsTrimmed > 0 ? { neighborsTrimmed } : {}),
    ...(importerTrimmed > 0 ? { importerTrimmed } : {}),
  };
  const trimSummary = [
    ...(neighborsTrimmed > 0 ? [`neighbours trimmed ${neighborsTrimmed}`] : []),
    ...(importerTrimmed > 0 ? [`importer tests trimmed ${importerTrimmed}`] : []),
  ].join(', ');
  const trimNote = trimmedCount > 0 ? ` · ${trimSummary} to fit inspection cap ${MAX_INSPECTED_TEST_FILES}` : '';
  const selected = [...tests, ...keptImporters, ...keptNeighbors].sort();
  debug.log('harness.host-regate', 'test-select', {
    changed: tests.length,
    importers: keptImporters.length,
    neighbors: keptNeighbors.length,
    trimmed: trimmedCount,
    ...(importerIndexFailed ? { observation: 'importer 못 셌다' } : {}),
    ...(importerTrimmed > 0 ? { importerTrimmed } : {}),
  });
  if (!selected.length) return { passed: true };
  // 간섭 관문은 시험 파일이 둘 이상일 때만 잰다 — 하나면 간섭이라는 말이 없으니 그 파일을 한 번 돌려 실패 수로 본다.
  if (selected.length === 1) {
    const run = await (opts.run ?? ((paths, dir) => runBunTest(paths, undefined, dir)))(selected, cwd);
    const fail = run.signal || run.exitCode === null ? null : parseFailureCount(`${run.stdout}${run.stderr}`);
    if (fail === null) return { passed: false, unmeasured: true, ...trimmed, detail: `single test run unmeasured: ${selected[0]}` };
    if (fail === 0) return { passed: true, ...trimmed };
    const names = failedNamesFromStreams(run);
    return { passed: false, ...trimmed, detail: `single=${fail} fail; ${failureNames([{ files: selected, fail, status: 'measured', failedFiles: names.files, failedTests: names.tests }], 8, 20)}` };
  }
  // The informational pr-land gate always returns zero; its measured report is the verdict.
  let report: Awaited<ReturnType<typeof detectTestInterference>> | undefined;
  await runTestInterferenceGate({
    args: ['--changed-files', ...selected], log: () => {},
    detect: async (paths) => (report = await (opts.detect ?? detectTestInterference)(paths, (batch) => (opts.run ?? ((selectedPaths, dir) => runBunTest(selectedPaths, undefined, dir)))(batch, cwd))),
  });
  if (!report || report.status === 'unmeasurable' || selected.length > report.order.length) return { passed: false, unmeasured: true, ...trimmed, detail: `test interference measurement unavailable or truncated (selected ${selected.length}, changed tests ${tests.length}, cap ${MAX_INSPECTED_TEST_FILES})${trimNote}` };
  if (report.isolatedFailures !== 0 || report.combinedFailures !== 0 || report.status === 'interference') {
    const bothFailed = report.isolatedFailures! > 0 && report.combinedFailures! > 0;
    const isolatedNames = failureNames(report.isolated, bothFailed ? 4 : 8, bothFailed ? 10 : 20);
    const combinedNames = failureNames([report.combined], bothFailed ? 4 : 8, bothFailed ? 10 : 20);
    return { passed: false, ...trimmed, detail: `isolated=${report.isolatedFailures}, combined=${report.combinedFailures}, interference=${report.status}; isolated ${isolatedNames}; combined ${combinedNames}${trimNote}` };
  }
  return { passed: true, ...trimmed, ...(trimNote ? { detail: trimNote.slice(3) } : {}) };
}

const SLOT_WAIT_MS = 30 * 60_000;

function slotOwnerAlive(slot: string): boolean {
  try {
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireSlot(repoRoot: string, opts: { waitMs?: number; pollMs?: number; now?: () => number } = {}): Promise<(() => void) & { worktree: string }> {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (gitDir.status !== 0 || !gitDir.stdout.trim()) throw new Error('git common directory unavailable for host regate lock');
  const root = join(gitDir.stdout.trim(), 'elanous-host-regate');
  mkdirSync(root, { recursive: true });
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? SLOT_WAIT_MS);
  for (;;) {
    for (let i = 0; i < 2; i++) {
      const slot = join(root, `slot-${i}`);
      try {
        mkdirSync(slot);
        writeFileSync(join(slot, 'pid'), String(process.pid));
        return Object.assign(() => rmSync(slot, { recursive: true, force: true }), { worktree: join(root, `worktree-${i}`) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A slot left by a crashed host process would otherwise block every later run.
        // A slot without a pid file yet may be mid-acquire; only reclaim once its owner is known dead.
        if (existsSync(join(slot, 'pid')) && !slotOwnerAlive(slot)) {
          rmSync(slot, { recursive: true, force: true });
          debug.log('harness.host-regate', 'slot-reclaimed', { slot: `slot-${i}` });
        }
      }
    }
    if (now() >= deadline) throw new Error(`host regate slots busy for ${Math.round((opts.waitMs ?? SLOT_WAIT_MS) / 60_000)}m`);
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 250));
  }
}

function removeBrokenSlotRegistration(repoRoot: string, worktree: string): void {
  const gitDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (gitDir.status !== 0 || !gitDir.stdout.trim()) throw new Error('git common directory unavailable for slot repair');
  const registrations = join(gitDir.stdout.trim(), 'worktrees');
  if (!existsSync(registrations)) return;
  for (const name of readdirSync(registrations)) {
    const registration = join(registrations, name);
    if (!lstatSync(registration).isDirectory()) continue;
    const pointer = join(registration, 'gitdir');
    if (!existsSync(pointer) || lstatSync(pointer).isSymbolicLink()) continue;
    if (resolve(readFileSync(pointer, 'utf8').trim()) !== resolve(worktree, '.git')) continue;
    rmSync(registration, { recursive: true });
  }
}

/** GATE-ONCE-PER-HEAD: 생산 등록부는 host-regate 슬롯과 같은 Git common directory 에 산다. 못 찾으면 승계 없이 원래 검사로 연다. */
function defaultGateReceiptPath(repoRoot: string, command: NonNullable<HostRegateDeps['command']>): string | undefined {
  const r = command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
  const dir = r.status === 0 ? r.stdout.trim() : '';
  return dir ? join(dir, 'elanous-host-regate', 'gate-receipts.json') : undefined;
}

/** 영수증의 Bun 식별값 — 검사를 실제로 돌릴 그 Bun. 못 재면 null 로 승계를 닫는다(빈 값으로 흐리지 않는다). */
function commandBunVersion(command: NonNullable<HostRegateDeps['command']>, cwd: string): string | null {
  const r = command('bun', ['--version'], cwd);
  const version = r.status === 0 ? r.stdout.trim() : '';
  return version || null;
}

/** Callers: podSelfImplementSpawn in src/task-orchestrator/surfaces/self-implement-pod.ts calls
 *  (options.hostRegate ?? runHostRegate)({ prNumber, headCommit, repoRoot: hostRoot, ... });
 *  sweepFrozenMerges in frozen-merges.ts also calls runHostRegate(entry); landing queue serialization stays there. */
export async function runHostRegate(input: HostRegateInput, deps: HostRegateDeps = {}): Promise<HostRegateResult> {
  const command = deps.command ?? defaultCommand;
  const log = deps.log ?? ((event: 'passed' | 'failed' | 'unmeasured' | 'base-raced', data: Record<string, unknown>) => debug.log('harness.host-regate', event, data));
  const failures: HostRegateResult['failures'] = [];
  let files: string[] = [];
  let base = '';
  let worktree: string | undefined;
  let attached = false;
  let ephemeral = false;
  let slotCommonDir: string | undefined;
  const verifySlot = (): void => {
    if (!worktree || !slotCommonDir || lstatSync(worktree).isSymbolicLink() || !lstatSync(worktree).isDirectory()) throw new Error('slot worktree mismatch');
    const pointer = join(worktree, '.git');
    if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error('slot worktree mismatch');
    const common = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree));
    const registration = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-dir'], worktree));
    if (common !== slotCommonDir || dirname(registration) !== join(slotCommonDir, 'worktrees')
      || resolve(readFileSync(join(registration, 'gitdir'), 'utf8').trim()) !== resolve(pointer)
      || resolve(readFileSync(pointer, 'utf8').trim().replace(/^gitdir: /, '')) !== registration
      || run('git', ['rev-parse', '--show-toplevel'], worktree) !== worktree) throw new Error('slot worktree mismatch');
  };
  let release: (() => void) | undefined;
  let endLanding: ((merged?: boolean) => void) | undefined;
  let landed = false;
  let verifiedBase: string | undefined;
  // Two host-regate slots may fetch in the same repository at once. FETCH_HEAD is shared;
  // each measurement needs its own ref so another fetch cannot replace its evidence.
  const fetchNamespace = `refs/elanous/regate/${process.pid}-${randomUUID()}`;
  const fetchedRefs = new Set<string>();
  let interferenceNote: Record<string, unknown> = {};
  // HOST-REGATE-REASON-LOST: `facts` carries the expected/actual head, conflict files and merge failure kind of the
  //   pr-head · merge-conflict · merge steps; the detail keeps a bounded head ⊕ tail instead of the first 300 characters.
  const result = (event: 'passed' | 'failed' | 'unmeasured', step?: string, detail?: string, facts: Omit<HostRegateFailure, 'step' | 'detail'> = {}): HostRegateResult => {
    if (step) failures.push({ step, detail: clipRegateDetail(detail ?? 'unknown'), ...facts });
    log(event, { pr: input.prNumber, files, os: process.platform, ...interferenceNote, ...(step ? { failedStep: step, detail: clipRegateDetail(detail ?? 'unknown'), ...facts } : {}) });
    // TA-REGATE-UNMEASURED — noMerge(TA 재게이트) 도 status 를 싣는다: draft `pr-head` 거부 같은 «못 잼»을 «실패»와 가르게.
    return { passed: event === 'passed', failures, os: process.platform,
      ...(input.verifyOnly || input.noMerge ? { status: event } : {}),
      ...(input.verifyOnly && verifiedBase ? { baseCommit: verifiedBase } : {}) };
  };
  const run = (bin: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string => {
    const r = command(bin, args, cwd, env);
    if (r.status !== 0) throw new Error(clipRegateDetail((r.stderr || r.stdout || `${bin} exited ${r.status}`).trim()));
    return r.stdout.trim();
  };
  const fetchRef = (source: string, name: 'base' | 'head'): string => {
    const ref = `${fetchNamespace}/${name}`;
    fetchedRefs.add(ref);
    run('git', ['fetch', '--no-write-fetch-head', 'origin', `+${source}:${ref}`], input.repoRoot);
    return run('git', ['rev-parse', ref], input.repoRoot);
  };
  try {
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !/^[0-9a-f]{40}$/i.test(input.headCommit) || (input.allowDraft && !input.verifyOnly)) return result('unmeasured', 'input', 'invalid PR number, checked head SHA, or draft measurement mode');
    release = await (deps.acquire ?? acquireSlot)(input.repoRoot);
    type PrView = { headRefOid?: string; baseRefName?: string; baseRefOid?: string; state?: string; isDraft?: boolean };
    const readPr = (): PrView => JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'headRefOid,baseRefName,baseRefOid,state,isDraft'], input.repoRoot));
    const prHeadFailure = (seen: PrView): HostRegateResult => result('unmeasured', 'pr-head',
      `PR head, base commit, ready state or open state unavailable or changed (state=${seen.state ?? 'unknown'} · isDraft=${String(seen.isDraft)} · base=${seen.baseRefName ?? 'unknown'}@${seen.baseRefOid ?? 'unknown'})`,
      { expectedHead: input.headCommit, actualHead: typeof seen.headRefOid === 'string' ? seen.headRefOid : null });
    let view: PrView;
    try { view = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (view.headRefOid !== input.headCommit || view.state !== 'OPEN' || (view.isDraft !== false && !(input.allowDraft && view.isDraft === true)) || !view.baseRefName || !/^[0-9a-f]{40}$/i.test(view.baseRefOid ?? '')) return prHeadFailure(view);
    const baseRefName = view.baseRefName;
    // verifyOnly(승인 탭): PR 에 기록된 base(baseRefOid)는 main 의 «지금 끝»보다 늙을 수 있다 — 지금 끝에 얹어 잰다.
    let baseCommit = view.baseRefOid!;
    // REGATE-STALE-BASE: GitHub's baseRefOid can stay at the PR-open tip after main moves. After the bounded re-reads the
    // regate measures on the fetched base tip (what the squash merge lands on) and records the stale PR base instead of failing.
    // The closing PR re-read must still show the last PR base seen here (a PR that changed again is not the PR we measured).
    let stalePrBase: string | undefined;
    const initialPrBase = baseCommit;
    let buildPwa = false;
    let typecheckBase = '';
    // REGATE-PWA-DEPS-FOR-TSC (#26698 → #27484 must-fix): the typecheck gate picks its own changed set and its own
    // whole-repository promotion triggers — TSC_BASE_REF..HEAD — which can carry apps/pwa files that landed on
    // main after this PR branched, and root-file export changes that widen the inspection to the whole repository.
    // Set in the worktree phase below.
    let typecheckTouchesPwa = false;
    try {
      let fetchedBase = fetchRef(`refs/heads/${baseRefName}`, 'base');
      if (input.verifyOnly) { baseCommit = fetchedBase; verifiedBase = fetchedBase; }
      else {
        for (let attempt = 1; fetchedBase !== baseCommit; attempt++) {
          debug.log('harness.host-regate', 'base-moved-retry', { pr: input.prNumber, attempt, checked: baseCommit, fetched: fetchedBase });
          if (attempt === 3) {
            stalePrBase = baseCommit;
            debug.log('harness.host-regate', 'base-stale', { pr: input.prNumber, prBaseRefOidInitial: initialPrBase, prBaseRefOid: baseCommit, fetched: fetchedBase, candidateBase: fetchedBase });
            baseCommit = fetchedBase;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          view = readPr();
          if (view.headRefOid !== input.headCommit || view.state !== 'OPEN' || view.isDraft !== false || view.baseRefName !== baseRefName || !/^[0-9a-f]{40}$/i.test(view.baseRefOid ?? '')) {
            return prHeadFailure(view);
          }
          baseCommit = view.baseRefOid!;
          fetchedBase = fetchRef(`refs/heads/${baseRefName}`, 'base');
        }
      }
      if (fetchRef(`refs/pull/${input.prNumber}/head`, 'head') !== input.headCommit) throw new Error('fetched PR head differs from checked SHA');
      const slotWorktree = (release as (() => void) & { worktree?: string }).worktree;
      ephemeral = !!deps.makeTemp || !slotWorktree;
      worktree = deps.makeTemp?.() ?? slotWorktree ?? mkdtempSync(join(tmpdir(), 'host-regate-'));
      if (ephemeral && slotWorktree && resolve(worktree) === resolve(slotWorktree)) throw new Error('temporary worktree overlaps locked slot');
      if (!ephemeral && !deps.acquire) {
        slotCommonDir = realpathSync(run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], input.repoRoot));
      }
      if (!ephemeral && existsSync(worktree)) {
        if (slotCommonDir) verifySlot();
        attached = true;
        // A previous host may have died mid-merge; never carry its index or untracked files into this run.
        run('git', ['reset', '--hard'], worktree);
        run('git', ['clean', '-fdx', '-e', 'node_modules', '-e', '.next', '-e', '*.tsbuildinfo'], worktree);
        run('git', ['checkout', '--detach', baseCommit], worktree);
      }
      if (!attached) {
        if (!ephemeral && !deps.acquire) removeBrokenSlotRegistration(input.repoRoot, worktree);
        run('git', ['worktree', 'add', '--detach', worktree, baseCommit], input.repoRoot);
        attached = true;
      }
      if (run('git', ['rev-parse', 'HEAD'], worktree) !== baseCommit) throw new Error('worktree base HEAD mismatch');
      base = run('git', ['merge-base', baseCommit, input.headCommit], worktree);
      files = run('git', ['diff', '--name-only', base, input.headCommit], worktree).split('\n').filter(Boolean);
      if (!files.length) throw new Error('changed files unavailable');
      if (!input.verifyOnly) {
        // --name-only lists only the destination of a rename. Inspect both sides without
        // changing the gate's existing changed-file list or its test selection.
        const guardPaths = releaseGitDiffPaths(run('git', ['diff', '--find-renames', '--name-status', '-z', base, input.headCommit], worktree));
        const heldPath = releasePathHold(guardPaths);
        if (heldPath) {
          debug.log('self-dev.merge', 'release-path-hold', { number: input.prNumber, path: heldPath, label: RELEASE_PATH_LABEL, surface: 'host-regate' });
          try {
            const existing: unknown = JSON.parse(run('gh', ['label', 'list', '--search', RELEASE_PATH_LABEL, '--json', 'name'], input.repoRoot));
            if (!Array.isArray(existing)) throw new Error('invalid label list');
            if (!existing.some((item: unknown) => !!item && typeof item === 'object' && 'name' in item && item.name === RELEASE_PATH_LABEL)) {
              run('gh', ['label', 'create', RELEASE_PATH_LABEL, '--color', 'D93F0B', '--description', 'Release path requires OP approval'], input.repoRoot);
            }
            run('gh', ['pr', 'edit', String(input.prNumber), '--add-label', RELEASE_PATH_LABEL], input.repoRoot);
          } catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { number: input.prNumber, action: 'label', error: String(error) }); }
          try { if (releasePathHoldShouldPost(() => JSON.parse(run('gh', releasePathHoldCommentsArgs(input.prNumber), input.repoRoot)))) run('gh', ['pr', 'comment', String(input.prNumber), '--body', releasePathHoldComment(heldPath)], input.repoRoot); }
          catch (error) { debug.log('self-dev.merge', 'release-path-annotation-failed', { number: input.prNumber, action: 'comment', error: String(error) }); }
          return result('failed', 'release-path-hold', `OP approval required: ${heldPath}`);
        }
      }
      // Materialize the proposed merge of this exact PR head into the observed base.
      // A clean head checkout cannot expose integration breaks introduced by the base.
      // Parse the raw merge output before bounding the failure detail; a middle CONFLICT line can vanish from a 4KB head+tail clip.
      let mergeOutput: string | undefined;
      try {
        const merge = command('git', ['merge', '--no-ff', '--no-commit', input.headCommit], worktree);
        if (merge.status !== 0) {
          mergeOutput = ([merge.stdout, merge.stderr].filter(Boolean).join('\n') || `git merge exited ${merge.status}`).trim();
          throw new Error(mergeOutput);
        }
      }
      catch (e) {
        // Read the unmerged paths before the finally block resets the slot; fall back to the CONFLICT lines.
        let unmerged: string[] = [];
        // -z keeps exact paths; bypass run() because its stdout.trim() would alter a leading/trailing space in a filename.
        try {
          const diff = command('git', ['diff', '--name-only', '-z', '--diff-filter=U'], worktree);
          if (diff.status === 0) unmerged = diff.stdout.split('\0').filter(Boolean);
        } catch { /* fall back below */ }
        const detail = mergeOutput ?? String(e);
        const conflictFiles = unmerged.length ? [...new Set(unmerged)].sort() : parseConflictFiles(detail);
        // No unmerged path and no CONFLICT line (e.g. unrelated histories) is not called a conflict.
        const kind = conflictFiles.length ? 'conflict' as const : classifyMergeFailure(detail);
        return result('failed', 'merge-conflict', detail, { expectedHead: input.headCommit, conflictFiles, mergeFailureKind: kind });
      }
      run('git', ['-c', 'user.name=elanous host regate', '-c', 'user.email=regate@localhost', 'commit', '-m', 'host regate integration candidate'], worktree);
      if (run('git', ['rev-parse', 'HEAD^1'], worktree) !== baseCommit || run('git', ['rev-parse', 'HEAD^2'], worktree) !== input.headCommit) throw new Error('integration parents do not match PR base and checked head');
      if (!deps.command && !existsSync(join(worktree, 'scripts/ci-typecheck-changed.ts'))) throw new Error('typecheck gate unavailable in checked worktree');
      // Borrow the source checkout's dependencies only when they are really installed. The daemon's install source can be
      // a temporary checkout whose node_modules is empty or purged; linking it turned every gate into
      // «Cannot find package 'typescript'» (unmeasured · 2026-09-29 #21239). Install into the candidate instead.
      const candidate = worktree;
      const provide = (dir: string, marker: string): void => provideCheckoutDependencies(candidate, input.repoRoot, dir, marker, (cwd) => { run('bun', ['install', '--frozen-lockfile'], cwd); });
      provide('', 'typescript');
      buildPwa = needsPwaBuild(files, worktree);
      // REGATE-PWA-DEPS-FOR-TSC (#26698 → #27484 must-fix): provide('apps/pwa') must also fire when the typecheck
      // gate's own scope — the same TSC_BASE_REF..HEAD it receives below — holds present .ts/.tsx files under
      // apps/pwa/ OR any of its whole-repository promotion triggers (필수 export 필드 추가 · exported 심볼 삭제 ·
      // exported 함수 매개변수 증가, in ANY changed file), even when buildPwa never turns on: without app deps
      // the gate fails such runs as «의존성 없음» for environment reasons, not code defects.
      typecheckBase = input.verifyOnly ? baseCommit : base;
      typecheckTouchesPwa = typecheckGateTouchesPwa(worktree, typecheckBase, command);
      if ((buildPwa || typecheckTouchesPwa) && existsSync(join(worktree, 'apps/pwa'))) provide('apps/pwa', 'next');
    } catch (e) { return result('unmeasured', 'worktree', String(e)); }
    // GATE-ONCE-PER-HEAD (0.2.40 첫 조각 · OP 10-27 23:0x 지시): 입장 검사(PR open/ready·head/base 재검증)와
    // 통합 후보 구성이 끝난 뒤, 지속 등록부에서 이 측정의 key 로 통과 영수증을 찾는다. 정확히 같은
    // head·측정 base·Bun/lockfile·radius·검사 범위·환경의 통과 영수증만 아래 비용 큰 검사를 승계하고,
    // 불일치·결손·불완전·실패/측정불가 영수증은 원래 검사를 그대로 실행한다 — 영수증이 커버하지 않는
    // 검사는 승계하지 않는다. 등록부를 못 쓰는 경우도 검사 쪽으로 실패 열린다.
    const gateReceiptPath = deps.gateReceiptPath ?? defaultGateReceiptPath(input.repoRoot, command);
    // Gate receipt support is optional for this host path. Keep its registry and test-env helpers
    // outside the Next TUI's static startup closure, loading them only when receipt lookup is enabled.
    const gateReceiptRegistry = gateReceiptPath ? await import('./gate-receipt-registry.js') : null;
    const gateChecks = [
      `test-interference:${input.verifyOnly ? 'changed-only' : 'with-neighbours'}`,
      ...(publicExposureFiles(files).length > 0 ? ['expose'] : []),
      `typecheck@${typecheckBase}`,
      ...((deps.command || existsSync(join(worktree, 'scripts/ci-isolation-hardcode-gate.ts'))) ? ['isolation-gate'] : []),
      ...(buildPwa ? ['nexus-build'] : []),
    ];
    let gateReceiptIdentity: GateReceiptIdentity | undefined;
    let gateReceiptKey = '';
    let gateReceiptReused = false;
    let gateReceiptDecline = 'gate receipt registry unavailable';
    if (gateReceiptPath) {
      try {
        const bunVersion = commandBunVersion(command, worktree);
        if (bunVersion === null) gateReceiptDecline = 'bun version unavailable';
        else {
          gateReceiptIdentity = {
            headCommit: input.headCommit,
            baseCommit,
            bunVersion,
            lockfileHash: gateReceiptRegistry!.gateLockfileHash(worktree),
            radiusFiles: [...new Set(files)].sort(),
            checks: gateChecks,
            envFingerprint: gateReceiptRegistry!.gateEnvFingerprint(deps.gateReceiptEnv ?? process.env),
          };
          gateReceiptKey = gateReceiptRegistry!.computeReceiptKey(gateReceiptIdentity, 'passed');
          const registry = gateReceiptRegistry!.loadGateReceipts(gateReceiptPath);
          const stored = registry[gateReceiptKey];
          if (stored && gateReceiptRegistry!.gateReceiptSelfKey(stored) === gateReceiptKey) gateReceiptReused = true;
          else gateReceiptDecline = stored ? 'stored receipt does not recompute to its own key' : gateReceiptRegistry!.describeGateReceiptDecline(gateReceiptIdentity, registry);
        }
      } catch (e) { gateReceiptDecline = `gate receipt lookup failed: ${String(e).slice(0, 200)}`; }
    }
    if (gateReceiptReused) debug.log('harness.host-regate', 'gate-receipt-reuse', { pr: input.prNumber, key: gateReceiptKey, checks: gateChecks });
    else debug.log('harness.host-regate', 'gate-receipt-decline', { pr: input.prNumber, ...(gateReceiptKey ? { key: gateReceiptKey } : {}), reason: gateReceiptDecline });
    if (!gateReceiptReused) {
      try {
        const interferenceOptions = { neighbors: !input.verifyOnly };
        const interference = await (deps.interference ?? ((f: readonly string[], c: string) => defaultInterference(f, c, interferenceOptions)))(files, worktree);
        if (interference.neighborsTrimmed || interference.importerTrimmed) interferenceNote = {
          ...(interference.neighborsTrimmed ? { neighborsTrimmed: interference.neighborsTrimmed } : {}),
          ...(interference.importerTrimmed ? { importerTrimmed: interference.importerTrimmed } : {}),
          interferenceDetail: (interference.detail ?? '').slice(0, 300),
        };
        if (!interference.passed) return result(interference.unmeasured ? 'unmeasured' : 'failed', 'test-interference', interference.detail);
      } catch (e) { return result('unmeasured', 'test-interference', String(e)); }
      // Landing can also be initiated by the host after the child gate; judge the checked PR here too.
      if (publicExposureFiles(files).length > 0) {
        const exposure = (deps.runExposeGate ?? runExposeGate)(worktree, files,
          getUserConfig().harness?.exposeGate === 'strict' ? 'strict' : 'warn',
          (bin, args, dir) => command(bin, args, dir));
        if (!exposure.passed) return result('failed', 'expose', exposure.log);
      }
      // The checked checkout is shared with interference/exposure gates. Verify dependencies at the
      // typecheck boundary as well: a missing PWA link here made #27414 fail as an unmeasured host regate.
      if ((buildPwa || typecheckTouchesPwa) && !existsSync(join(worktree, 'apps/pwa/node_modules'))) {
        let failure: string | null = null;
        try {
          if (existsSync(join(worktree, 'apps/pwa'))) {
            provideCheckoutDependencies(worktree, input.repoRoot, 'apps/pwa', 'next', (cwd) => { run('bun', ['install', '--frozen-lockfile'], cwd); });
          } else failure = 'apps/pwa absent before typecheck';
        } catch (e) { failure = String(e); }
        const ready = existsSync(join(worktree, 'apps/pwa/node_modules'));
        if (!ready && !failure) failure = 'apps/pwa/node_modules absent after provision before typecheck';
        try { debug.log('harness.host-regate', 'pwa-dependencies-before-typecheck', { pr: input.prNumber, restored: ready, failure }); } catch { /* observation must not block regate */ }
        if (!ready) return result('unmeasured', 'dependencies', failure!);
      }
      // verifyOnly: 통합 후보는 «지금 main 끝»(baseCommit)에 얹은 것이다 — 옛 merge-base 로 비교하면 그사이 main 착지분
      //   수백 파일이 «이 PR 의 변경»으로 잡혀 저장소 전체 검사로 승격된다(2026-09-28 #21239 실측: 456파일 · PWA 636건).
      try { run('bun', ['scripts/ci-typecheck-changed.ts'], worktree, { ...process.env, TSC_BASE_REF: typecheckBase }); }
      catch (e) { return result(String(e).includes('error TS') ? 'failed' : 'unmeasured', 'typecheck', String(e)); }
      // ⛔ 2026-09-28: a Pod landing brought `join(home, '.elanous', …)` into main without this gate, and every human
      //    `pr land` after it failed the isolation gate regardless of its own files (#21336 → #21343).
      if (deps.command || existsSync(join(worktree, 'scripts/ci-isolation-hardcode-gate.ts'))) {
        try { run('bun', ['scripts/ci-isolation-hardcode-gate.ts', '--changed-files', ...files], worktree); }
        catch (e) { return result(/\[isolation-gate\] FAIL/.test(String(e)) ? 'failed' : 'unmeasured', 'isolation-gate', String(e)); }
      }
      if (buildPwa) {
        try { run('bun', ['bin/elanous.mjs', '--test', 'nexus', 'build'], worktree); }
        catch (e) { return result(String(e).includes('command unavailable') ? 'unmeasured' : 'failed', 'nexus-build', String(e)); }
      }
      // 원래 검사가 모두 통과했다 — 이 측정의 통과 영수증을 지속 등록부에 원자적으로 남긴다.
      // 저장 실패는 영수증 최적화의 실패일 뿐 게이트 판정이 아니므로 관측만 남긴다.
      if (gateReceiptPath && gateReceiptIdentity && gateReceiptRegistry) {
        try {
          const receipt: GateReceipt = { ...gateReceiptIdentity, schema: gateReceiptRegistry.GATE_RECEIPT_SCHEMA, key: gateReceiptRegistry.computeReceiptKey(gateReceiptIdentity, 'passed'), verdict: 'passed', savedAt: new Date().toISOString() };
          gateReceiptRegistry.saveGateReceipt(gateReceiptPath, receipt);
          debug.log('harness.host-regate', 'gate-receipt-saved', { pr: input.prNumber, key: receipt.key, checks: gateChecks });
        } catch (e) { debug.log('harness.host-regate', 'gate-receipt-save-failed', { pr: input.prNumber, error: String(e).slice(0, 200) }); }
      }
    }
    let current: PrView;
    try { current = readPr(); }
    catch (e) { return result('unmeasured', 'pr-view', String(e)); }
    if (current.headRefOid !== input.headCommit || current.baseRefName !== baseRefName || (!input.verifyOnly && current.baseRefOid !== (stalePrBase ?? baseCommit)) || current.state !== 'OPEN' || current.isDraft !== view.isDraft) {
      return result('unmeasured', 'pr-base-changed', 'PR head or base changed during host regate; rerun against the new base');
    }
    // --match-head-commit pins the head. gh has no base pin, so the base was re-read just
    // above; the seconds between that read and the merge are checked after the fact below.
    if (input.verifyOnly) return result('passed');
    // TA-REJUDGE-ON-HEAD — 병합 없는 재게이트는 «잰 base 끝»을 같이 낸다(겹침 증거의 gate.baseCommit).
    if (input.noMerge) return { ...result('passed'), status: 'passed', baseCommit };
    const landing = admitLandingMerge({ prNumber: input.prNumber, headCommit: input.headCommit, repoRoot: input.repoRoot, ...(input.goalFile ? { goalFile: input.goalFile } : {}) }, deps.freezeRoot, {}, input.resumed ? undefined : { prNumber: input.prNumber, repoRoot: input.repoRoot, headCommit: input.headCommit }, { prodFreezeRoot: deps.prodFreezeRoot });
    if (landing.kind !== 'merge') {
      debug.log('harness.merge', 'frozen', { pr: input.prNumber, ...(landing.kind === 'held' ? { reason: landing.freeze.reason, until: landing.freeze.until } : { resumedElsewhere: true }) });
      return { passed: true, failures: [], os: process.platform, status: 'frozen' };
    }
    // The marker and claim are held through the merge «and» its confirmation; released in the outer finally.
    endLanding = landing.end;
    try { run('gh', ['pr', 'merge', String(input.prNumber), '--squash', '--match-head-commit', input.headCommit], input.repoRoot); }
    catch (e) {
      // Tell a base race from a moved head from a conflict: re-read the PR head once (null = could not read).
      let actualHead: string | null = null;
      try { const after = readPr(); actualHead = typeof after.headRefOid === 'string' ? after.headRefOid : null; } catch { /* stays null */ }
      const detail = String(e);
      return result('failed', 'merge', detail, { expectedHead: input.headCommit, actualHead, mergeFailureKind: classifyMergeFailure(detail, input.headCommit, actualHead) });
    }
    type MergedView = { state?: string; mergeCommit?: { oid?: string } | null };
    let merged: MergedView;
    try { merged = JSON.parse(run('gh', ['pr', 'view', String(input.prNumber), '--json', 'state,mergeCommit'], input.repoRoot)); }
    catch (e) { return result('unmeasured', 'merge-confirm', String(e)); }
    if (merged.state !== 'MERGED') return result('unmeasured', 'merge-confirm', `PR state after merge is ${merged.state ?? 'unknown'}`);
    landed = true;
    try {
      const sync = deps.syncMergedChecklist ?? (await import('../release-loop/merged-pr-checklist.js')).syncMergedPrChecklistWithFeedback;
      await sync(input.prNumber, input.repoRoot, input.goalFile);
    } catch (error) {
      debug.log('release.checklist', 'merged-pr-sync-failed', { pr: input.prNumber, error: String(error) });
    }
    const mergeCommit = merged.mergeCommit?.oid ?? '';
    let mergedOnto = '';
    try {
      run('git', ['fetch', 'origin', mergeCommit], input.repoRoot);
      mergedOnto = run('git', ['rev-parse', `${mergeCommit}^1`], input.repoRoot);
    } catch (e) {
      // Merged, but the parent could not be read: "unknown" is not "raced".
      log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'merge-parent', mergeCommit: mergeCommit || null, detail: String(e).slice(0, 200) });
    }
    if (mergedOnto && mergedOnto !== baseCommit) {
      log('base-raced', { pr: input.prNumber, files, os: process.platform, checkedBase: baseCommit, mergedOnto, mergeCommit });
    }
    return result('passed');
  } catch (e) {
    return result('unmeasured', 'host-regate', String(e));
  } finally {
    try { endLanding?.(landed); } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'landing-release', detail: String(e) }); }
    for (const ref of fetchedRefs) {
      try { run('git', ['update-ref', '-d', ref], input.repoRoot); }
      catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'fetch-ref-cleanup', detail: String(e) }); }
    }
    try {
      if (attached && worktree) {
        if (slotCommonDir) verifySlot();
        run('git', ['reset', '--hard'], worktree);
        run('git', ['clean', '-fdx', '-e', 'node_modules', '-e', '.next', '-e', '*.tsbuildinfo'], worktree);
      }
    } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    if (ephemeral && worktree) {
      try {
        if (attached) run('git', ['worktree', 'remove', '--force', worktree], input.repoRoot);
      } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
      try {
        if (deps.removeTemp) deps.removeTemp(worktree);
        else rmSync(worktree, { recursive: true, force: true });
      } catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'cleanup', detail: String(e) }); }
    }
    try { release?.(); }
    catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'lock', detail: String(e) }); }
    if (failures.length && failures[0]?.step !== 'release-path-hold') {
      const { step, detail, mergeFailureKind, conflictFiles, expectedHead, actualHead } = failures[0]!;
      const facts = [mergeFailureKind ? `kind=${mergeFailureKind}` : '',
        expectedHead ? `expectedHead=${expectedHead}` : '',
        actualHead !== undefined ? `actualHead=${actualHead ?? 'unreadable'}` : '',
        conflictFiles?.length ? `conflicts=${conflictFiles.slice(0, 5).join(',')}${conflictFiles.length > 5 ? ` +${conflictFiles.length - 5} more (total ${conflictFiles.length})` : ''}` : '',
      ].filter(Boolean).join(' · ');
      const body = `호스트 재게이트 실패(${process.platform}): ${step}${facts ? ` [${facts}]` : ''} — ${clipRegateDetail(detail.replace(/\s+/g, ' '))}`;
      try { run('gh', ['pr', 'comment', String(input.prNumber), '--body', body], input.repoRoot); }
      catch (e) { log('unmeasured', { pr: input.prNumber, files, os: process.platform, failedStep: 'comment', detail: String(e) }); }
    }
  }
}
