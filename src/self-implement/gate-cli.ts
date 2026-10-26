import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path/posix';
import { prepareDeterministicChildEnvironment } from '../../scripts/lib/deterministic-env.js';
import { audit as auditEntryBudget, entryBudgetAffected } from '../../scripts/ratchets/next-tui-entry-budget.js';
import { withGateTestEnv } from '../../scripts/lib/gate-test-env.js';
import { runIsolationHardcodeGate } from '../../scripts/ci-isolation-hardcode-gate.js';
import { runModelHardcodeGate } from '../../scripts/ci-model-hardcode-gate.js';
import { runDaemonPortGate } from '../../scripts/ci-daemon-port-gate.js';
import { runAndroidUnitTestGate } from '../../scripts/ci-android-unit-tests.js';
import { runIosUnitTestGate } from '../../scripts/ci-ios-unit-tests.js';
import { runPwaBuildGate } from '../../scripts/ci-pwa-build-gate.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { parseReviewDepthFromFilesJson } from '../agent-mission/review-depth.js';
import { buildGateBaselineReport, calculateGateTestCountChange, formatGateBaselineNote, formatGateTestCountNote, isGateTestFile, recheckTimeoutOnlyIntroducedFailures, runGateBaseline, type BaselineProcessResult, type BaselineProcessStatus, type GateTestFailure, type TimeoutRecheckRecord, type TimeoutRerunObservation } from './gate-baseline.js';
import { resolveGateScope } from './gate-scope.js';
import { publicExposureFiles, runExposeGate } from './expose-gate.js';
import { getUserConfig } from '../user-config.js';
import { debug, redactSecretText } from '../debug/log.js';
import { buildDocumentGuardianIndex, formatDocumentGuardians } from './document-guardian-index.js';
import { buildImporterTestIndex, importerTestsNotInRunSet, isTestPath, type ImporterTestIndex } from './importer-test-index.js';
import { isCommentOnlySourceChange } from './comment-only-source.js';
import { buildRouteConsumerTestIndex } from './route-consumer-test-index.js';
import { gitChangedFiles, observeGateBaselineLocation } from './seams.js';
import {
  collectBaseLandingCommits,
  overlapWithCurrentChanges,
} from '../cli/pr-granularity.js';
import { listWorktrees } from '../git-fs/worktree.js';
import { runShardedGateTests, runShardedGateTestsAsync, writeShardFailureEvidence, remoteShardArgv, type ShardRunProgress, type ShardRunResult } from '../self-dev/shard-run.js';
import { planGateRemoteShards, shardPlanOrchestrationId, type GateRemoteShard } from '../self-dev/shard-plan.js';
import { parseGateScenario, readGateScenarioFile } from './gate-scenario.js';
import { isGateSpawnLaneFile } from '../self-dev/spawn-lane-files.js';
import { defaultGateEnvKey, defaultRevResolver, resolveArtifactDir, writeGateArtifacts, type GateArtifactCounts, type GateArtifactsUnavailable, type RevResolver } from './gate-artifacts.js';

export interface SelfGateCliOptions {
  base?: string;
  pr?: string;
  shards?: number;
  /** Live shard bundle concurrency; default three, bounded to one through four. */
  shardConcurrency?: number;
  /** OP FU (LAND-TRAIN-LIVE side) — opt-in with `shards`: sorted round-robin into exactly that N, no RSS pre-measurement.
   *  Every other output (shardsDetail · baseline · artifacts · exit) keeps its shape; absent = measured planner unchanged. */
  fixedShardDistribution?: boolean;
  /** LIGHT-RC (0.2.19) — repository-relative test paths run on every call, whatever changed. Existing ones join the
   *  run (deduplicated, same introduced/preexisting baseline as the rest); missing ones go to `alwaysIncludeMissing`. */
  alwaysInclude?: readonly string[];
  /** RELEASE-DAILY-LIGHT-RC ② — run every tracked test that imports a changed (non-test) source, past the caller cap
   *  (importer index · reason=changed-source-importer). Off by default: the plain `self gate` scope is unchanged. */
  includeImporterTests?: boolean;
  /** Optional v0 scenario JSON. Adds selected tests only after binding base/head/diff. */
  scenario?: unknown;
  scenarioFile?: string;
  /** SIDE-VERIFY — 조각별 지금/기준 JUnit ⊕ summary.json 을 이 디렉토리에 «쓰기만» 한다(판정·exit·기존 줄 불변). */
  artifactDir?: string;
}

interface ProcessResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

interface ChangedFileSelection {
  files: string[];
  baseRef: string;
  ignoredDirtyPaths?: string[];
  prHeadRefName?: string;
  prBaseRefName?: string;
}

interface PrWorktreeListEntry {
  path: string;
  branch: string | null;
}

type PrWorktreeObservation =
  | { status: 'dirty'; paths: string[] }
  | { status: 'clean/absent' }
  | { status: 'unavailable'; reason: string };

type PrFileOverlapObservation =
  | { status: 'overlap'; files: string[] }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

export interface DirtyWorktreePath {
  path: string;
  kind: 'tracked' | 'untracked';
}

export interface DirtyWorktreeClassification {
  overlapping: DirtyWorktreePath[];
  unrelated: DirtyWorktreePath[];
}

interface SelfGateCliDeps {
  changedFiles?: (cwd: string, options: SelfGateCliOptions) => ChangedFileSelection;
  exists?: (path: string) => boolean;
  isRegularFile?: (cwd: string, path: string) => boolean;
  runCommand?: (command: string, args: string[], cwd: string) => ProcessResult;
  readFile?: (path: string) => string | undefined;
  runTests?: (cwd: string, files: readonly string[]) => ProcessResult;
  runBaseline?: (cwd: string, files: readonly string[], baseRef: string) => BaselineProcessResult;
  runTimeoutRecheck?: (cwd: string, file: string, name: string, timeoutMs: number) => { observation?: TimeoutRerunObservation; elapsedMs: number; output: string };
  runShards?: typeof runShardedGateTests;
  runShardsAsync?: typeof runShardedGateTestsAsync;
  /** Test seam for the live progress line. */
  writeProgressStderr?: (line: string) => void;
  now?: () => number;
  runIsolationGate?: (out: GateOutput) => number;
  runMockModuleRestoreGate?: (out: GateOutput) => number;
  /** 모델 이름 하드코딩 래칫(🅕 #20521) — `pr land` 만 물고 하니스 무인 병합은 안 물면 위반이 main 에 들어가 남의 착지를 막는다(🅣 2026-09-25). */
  runModelHardcodeGate?: (out: GateOutput) => number;
  /** 데몬 포트 리터럴 래칫 — 공용 `runDaemonPortGate` 를 부른다(새 스캐너 금지). */
  runDaemonPortGate?: (out: GateOutput) => number;
  /** 안드로이드 단위 시험 게이트 심(시험 주입용). */
  runAndroidGate?: (out: GateOutput) => number;
  /** iOS 순수-로직 시험 게이트 심(시험 주입용). */
  runIosGate?: (out: GateOutput) => number;
  runPwaGate?: (out: GateOutput) => number;
  runEntryBudgetGate?: (cwd: string, changedFiles: readonly string[]) => { affected: boolean; errors: string[] };
  listPrWorktrees?: (cwd: string) => PrWorktreeListEntry[] | { lookupFailed: string };
  inspectWorktreeDirtiness?: (path: string) => { dirty: boolean } | { lookupFailed: string };
  /** `--artifact-dir` 전용 심 — 커밋 sha 해석(실패 = null) · 환경 키. */
  resolveRev?: RevResolver;
  envKey?: () => string;
}

/** `--artifact-dir` 가 쓸 재료 — 판정 경로가 «채우기만» 하고 읽지 않는다. */
interface GateArtifactCapture {
  baseRef?: string;
  testFiles?: readonly string[];
  sharded?: ReturnType<typeof runShardedGateTests>;
  verdict?: string;
  verdictLine?: string;
  unmeasuredReason?: string;
  unshardedRc?: number | null;
  artifactsUnavailable?: GateArtifactsUnavailable;
  /** `unrun importer tests: N` 의 N — 색인 조회 실패면 null(그 이유가 importerLookupFailed). */
  unrunImporters?: number | null;
  importerLookupFailed?: string;
  timeoutRechecks?: readonly TimeoutRecheckRecord[];
}

/** SIDE-VERIFY ③ — summary 정수 칸: 게이트가 이미 낸 `result.baseline` ⊕ `unrunImporterTotal` 을 «옮기기만» 한다.
 *  baseline 이 없으면(조각 unmeasured) 넷은 null — 「0」으로 접지 않는다. */
export function gateArtifactCounts(result: Pick<SelfGateCliResult, 'baseline'>, capture: Pick<GateArtifactCapture, 'unrunImporters' | 'importerLookupFailed' | 'unmeasuredReason'>):
  { counts: GateArtifactCounts; reason?: string } {
  const baseline = result.baseline;
  const unrunImporters = capture.unrunImporters ?? null;
  const reasons: string[] = [];
  if (!baseline) reasons.push(capture.unmeasuredReason !== undefined ? `shards unmeasured (${capture.unmeasuredReason})` : 'test step produced no measurement');
  if (unrunImporters === null) reasons.push(`importer lookup failed${capture.importerLookupFailed ? ` (${capture.importerLookupFailed})` : ''}`);
  return {
    counts: {
      introduced: baseline?.introduced ?? null,
      preexisting: baseline?.preexisting ?? null,
      unknown: baseline?.unknown ?? null,
      preconditionUnmet: baseline?.preconditionUnmet ?? null,
      unrunImporters,
    },
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
  };
}

interface GateOutput {
  args?: string[];
  cwd: string;
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface SelfGateCliResult {
  exitCode: number;
  lines: string[];
  changedFiles: string[];
  testFiles: string[];
  unverified: readonly string[];
  documentPaths: readonly string[];
  documentsWithoutDerivedTests: readonly string[];
  /** `alwaysInclude` paths that do not exist in the tree (empty when none were given). */
  alwaysIncludeMissing: readonly string[];
  /** RELEASE-DAILY-LIGHT-RC ② — importer tests added because `includeImporterTests` was set (empty otherwise). */
  importerTestsAdded?: readonly string[];
  /** New vs. already-present failures (unknown/preconditionUnmet = failures it could not classify). Absent = the test
   *  step did not produce a measurement (e.g. shards unmeasured). */
  baseline?: { introduced: number; preexisting: number; unknown: number; preconditionUnmet: number };
  /** LIGHT-RC-MEASURE ③ — why the sharded test step produced no measurement (the same text as the
   *  `shards: unmeasured (…)` line). Absent when it measured, or on the unsharded path. */
  unmeasuredReason?: string;
}

/** 시험 단계와 독립인 정책 관문 넷. skipTestStep 이든 시험 통과든 같은 함수를 부른다. */
function runPolicyGates(
  files: readonly string[],
  cwd: string,
  lines: string[],
  deps: SelfGateCliDeps,
): boolean {
  const shouldRunAdditionalGates = deps.runIsolationGate !== undefined
    || deps.runMockModuleRestoreGate !== undefined
    || deps.runModelHardcodeGate !== undefined
    || deps.runDaemonPortGate !== undefined
    || existsSync(join(cwd, 'scripts'));
  if (!shouldRunAdditionalGates) return true;
  const isolationPassed = runAdditionalGate('isolation-gate', deps.runIsolationGate ?? runIsolationHardcodeGate, files, cwd, lines);
  const mockModuleRestorePassed = runAdditionalGate('mock-module-restore-gate', deps.runMockModuleRestoreGate ?? runMockModuleRestoreGate, files, cwd, lines);
  const modelHardcodePassed = runAdditionalGate('model-hardcode-gate', deps.runModelHardcodeGate ?? runModelHardcodeGate, files, cwd, lines);
  const daemonPortPassed = runAdditionalGate('daemon-port-gate', deps.runDaemonPortGate ?? ((out) => runDaemonPortGate({ log: out.log, error: out.error, cwd: out.cwd, args: [] })), files, cwd, lines);
  return isolationPassed && mockModuleRestorePassed && modelHardcodePassed && daemonPortPassed;
}

function runAdditionalGate(
  name: string,
  gate: (out: GateOutput) => number,
  changedFiles: readonly string[],
  cwd: string,
  lines: string[],
): boolean {
  const output: string[] = [];
  const out: GateOutput = {
    args: ['--changed-files', ...changedFiles],
    cwd,
    log: (message) => output.push(message),
    error: (message) => output.push(message),
  };
  try {
    const exitCode = gate(out);
    lines.push(...output);
    if (exitCode === 0) return true;
    lines.push(`✗ ${name}: violation detected`);
    return false;
  } catch (error) {
    lines.push(...output, `⚠ ${name}: 게이트가 «못 쟀다» — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function defaultRunCommand(command: string, args: string[], cwd: string): ProcessResult {
  if (command === 'bun' && args[0] === 'test') {
    let isolated: ReturnType<typeof prepareDeterministicChildEnvironment>;
    try {
      isolated = prepareDeterministicChildEnvironment('elanous-gate-cli-test-env-', { env: withGateTestEnv(process.env) });
    } catch (error) {
      const message = `deterministic environment setup failed: ${String(error)}`;
      return { status: null, stdout: '', stderr: message, error: error instanceof Error ? error : new Error(message) };
    }
    try {
      const result = spawnSync(command, args, { cwd, env: isolated.env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
    } finally {
      isolated.cleanup();
    }
  }
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function requireOutput(runCommand: SelfGateCliDeps['runCommand'], command: string, args: string[], cwd: string): string {
  const result = (runCommand ?? defaultRunCommand)(command, args, cwd);
  if (result.status !== 0 || result.error) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr ?? result.error?.message ?? '').trim()}`);
  return result.stdout ?? '';
}

function ensureCommitAvailable(runCommand: SelfGateCliDeps['runCommand'], cwd: string, sha: string): void {
  const available = (runCommand ?? defaultRunCommand)('git', ['cat-file', '-e', `${sha}^{commit}`], cwd);
  if (available.status === 0 && !available.error) return;
  requireOutput(runCommand, 'git', ['fetch', 'origin', sha], cwd);
  requireOutput(runCommand, 'git', ['cat-file', '-e', `${sha}^{commit}`], cwd);
}

function normalizeGatePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function parseDirtyWorktreePaths(porcelain: string): DirtyWorktreePath[] {
  const fields = porcelain.split('\0');
  const paths: DirtyWorktreePath[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const entry = fields[index++]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = normalizeGatePath(entry.slice(3));
    const kind = status === '??' ? 'untracked' : 'tracked';
    if (path) paths.push({ path, kind });
    if (status.includes('R') || status.includes('C')) {
      const original = normalizeGatePath(fields[index++] ?? '');
      if (original) paths.push({ path: original, kind });
    }
  }
  return paths;
}

function pathsOverlap(dirtyPath: string, targetPath: string): boolean {
  return dirtyPath === targetPath || dirtyPath.startsWith(`${targetPath}/`) || targetPath.startsWith(`${dirtyPath}/`);
}

export function classifyDirtyWorktreePaths(porcelain: string, targetFiles: readonly string[]): DirtyWorktreeClassification {
  const normalizedTargets = targetFiles.map(normalizeGatePath).filter(Boolean);
  const overlapping: DirtyWorktreePath[] = [];
  const unrelated: DirtyWorktreePath[] = [];
  for (const dirty of parseDirtyWorktreePaths(porcelain)) {
    (normalizedTargets.some((target) => pathsOverlap(dirty.path, target)) ? overlapping : unrelated).push(dirty);
  }
  return { overlapping, unrelated };
}

function assertScopeCleanWorktree(runCommand: SelfGateCliDeps['runCommand'], cwd: string, targetFiles: readonly string[]): string[] {
  const porcelain = requireOutput(runCommand, 'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const { overlapping, unrelated } = classifyDirtyWorktreePaths(porcelain, targetFiles);
  if (overlapping.length > 0) {
    const tracked = overlapping.filter(({ kind }) => kind === 'tracked').map(({ path }) => path);
    const untracked = overlapping.filter(({ kind }) => kind === 'untracked').map(({ path }) => path);
    const details = [
      tracked.length > 0 ? `tracked changes: ${tracked.join(', ')}` : '',
      untracked.length > 0 ? `untracked files: ${untracked.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`self gate requires no worktree changes overlapping the selected scope for --base/--pr; ${details}`);
  }
  return [...new Set(unrelated.map(({ path }) => path))];
}

function commandFailureReason(result: ProcessResult, fallback: string): string {
  return (result.stderr ?? result.error?.message ?? fallback).trim() || fallback;
}

function listPrWorktreesDefault(cwd: string): PrWorktreeListEntry[] | { lookupFailed: string } {
  try {
    return listWorktrees(cwd).map((entry) => ({ path: entry.path, branch: entry.branch }));
  } catch (error) {
    return { lookupFailed: error instanceof Error ? error.message : String(error) };
  }
}

function inspectWorktreeDirtinessViaCommand(
  runCommand: SelfGateCliDeps['runCommand'],
  path: string,
): { dirty: boolean } | { lookupFailed: string } {
  let result: ProcessResult;
  try {
    result = (runCommand ?? defaultRunCommand)('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], path);
  } catch (error) {
    return { lookupFailed: error instanceof Error ? error.message : String(error) };
  }
  if (result.status !== 0 || result.error) {
    return { lookupFailed: commandFailureReason(result, 'git status failed') };
  }
  return { dirty: parseDirtyWorktreePaths(result.stdout ?? '').length > 0 };
}

function normalizeBranchName(name: string): string {
  return name.trim().replace(/^refs\/heads\//, '');
}

export function observePrWorktreeDirtiness(
  cwd: string,
  branch: string | undefined,
  deps: Pick<SelfGateCliDeps, 'runCommand' | 'listPrWorktrees' | 'inspectWorktreeDirtiness'> = {},
): PrWorktreeObservation {
  const wanted = branch ? normalizeBranchName(branch) : '';
  if (!wanted) return { status: 'unavailable', reason: 'PR headRefName missing' };
  let listed: PrWorktreeListEntry[] | { lookupFailed: string };
  try {
    listed = (deps.listPrWorktrees ?? listPrWorktreesDefault)(cwd);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  if ('lookupFailed' in listed) return { status: 'unavailable', reason: listed.lookupFailed };
  const matching = listed.filter((entry) => entry.branch !== null && normalizeBranchName(entry.branch) === wanted);
  if (matching.length === 0) return { status: 'clean/absent' };
  const dirtyPaths: string[] = [];
  for (const entry of matching) {
    const inspected = deps.inspectWorktreeDirtiness
      ? deps.inspectWorktreeDirtiness(entry.path)
      : inspectWorktreeDirtinessViaCommand(deps.runCommand, entry.path);
    if ('lookupFailed' in inspected) return { status: 'unavailable', reason: inspected.lookupFailed };
    if (inspected.dirty) dirtyPaths.push(entry.path);
  }
  return dirtyPaths.length > 0 ? { status: 'dirty', paths: dirtyPaths } : { status: 'clean/absent' };
}

export function observePrFileOverlap(
  cwd: string,
  files: readonly string[],
  baseOid: string,
  baseRefName: string,
  runCommand: SelfGateCliDeps['runCommand'],
): PrFileOverlapObservation {
  const run = (command: string, args: readonly string[], opts?: { cwd?: string }) => {
    try {
      const result = (runCommand ?? defaultRunCommand)(command, [...args], opts?.cwd ?? cwd);
      if (result.status !== 0 || result.error) {
        return { ok: false as const, out: '', err: commandFailureReason(result, `${command} failed`) };
      }
      return { ok: true as const, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
    } catch (error) {
      return { ok: false as const, out: '', err: error instanceof Error ? error.message : String(error) };
    }
  };
  // The resolved base range is the complete scope; a time cutoff can hide a
  // just-created commit when a gate shard is slow.
  const commits = collectBaseLandingCommits(run, cwd, { since: null, baseRef: `${baseOid}..${baseRefName}` });
  if (commits === null) return { status: 'unavailable', reason: 'git log failed' };
  const overlaps = overlapWithCurrentChanges(commits, files);
  return overlaps.length > 0
    ? { status: 'overlap', files: overlaps.map((entry) => entry.path) }
    : { status: 'none' };
}

export function formatPrWorktreeObservation(observation: PrWorktreeObservation): string {
  if (observation.status === 'dirty') {
    return `pr worktree: dirty (${observation.paths.join(', ')})`;
  }
  if (observation.status === 'unavailable') {
    return `pr worktree: lookup failed (${observation.reason})`;
  }
  return 'pr worktree: clean/absent';
}

export function formatPrFileOverlapObservation(observation: PrFileOverlapObservation): string {
  if (observation.status === 'overlap') {
    return `pr file overlap: ${observation.files.join(', ')}`;
  }
  if (observation.status === 'unavailable') {
    return `pr file overlap: lookup failed (${observation.reason})`;
  }
  return 'pr file overlap: none';
}

function selectChangedFiles(cwd: string, options: SelfGateCliOptions, runCommand: SelfGateCliDeps['runCommand']): ChangedFileSelection {
  if (options.pr) {
    const payload = requireOutput(runCommand, 'gh', ['pr', 'view', options.pr, '--json', 'files,baseRefOid,headRefOid,headRefName,baseRefName'], cwd);
    const parsed = parseReviewDepthFromFilesJson(payload);
    const metadata = JSON.parse(payload) as { baseRefOid?: string; headRefOid?: string; headRefName?: string; baseRefName?: string };
    if (!metadata.baseRefOid || !metadata.headRefOid) throw new Error(`PR #${options.pr} did not return baseRefOid and headRefOid`);
    const currentHead = requireOutput(runCommand, 'git', ['rev-parse', 'HEAD'], cwd).trim();
    if (currentHead !== metadata.headRefOid) {
      throw new Error(`PR #${options.pr} head ${metadata.headRefOid} does not match current HEAD ${currentHead}; checkout the PR head before running self gate`);
    }
    ensureCommitAvailable(runCommand, cwd, metadata.baseRefOid);
    return {
      files: [...parsed.changedFiles],
      baseRef: metadata.baseRefOid,
      prHeadRefName: metadata.headRefName?.trim() || undefined,
      prBaseRefName: metadata.baseRefName?.trim() || undefined,
    };
  }
  if (options.base) {
    return {
      files: requireOutput(runCommand, 'git', ['diff', '--name-only', `${options.base}...HEAD`], cwd).split('\n').map((line) => line.trim()).filter(Boolean),
      baseRef: options.base,
    };
  }
  return { files: gitChangedFiles(cwd), baseRef: 'HEAD' };
}

function defaultChangedFiles(cwd: string, options: SelfGateCliOptions, runCommand: SelfGateCliDeps['runCommand']): ChangedFileSelection {
  const selection = selectChangedFiles(cwd, options, runCommand);
  if (options.pr || options.base) selection.ignoredDirtyPaths = assertScopeCleanWorktree(runCommand, cwd, selection.files);
  return selection;
}

function formatProcessOutput(result: ProcessResult): string {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function changedTestCountNote(
  cwd: string,
  files: readonly string[],
  baseRef: string,
  runCommand: SelfGateCliDeps['runCommand'],
  readFile: SelfGateCliDeps['readFile'],
): string {
  const testFiles = files.filter(isGateTestFile);
  const readCurrent = readFile ?? ((path: string) => existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  let base = 0;
  let current = 0;
  let decrease = 0;
  for (const file of testFiles) {
    const baseResult = (runCommand ?? defaultRunCommand)('git', ['show', `${baseRef}:${file}`], cwd);
    const baseContent = baseResult.status === 0 && !baseResult.error ? baseResult.stdout ?? '' : '';
    const currentContent = readCurrent(join(cwd, file)) ?? '';
    const change = calculateGateTestCountChange(baseContent, currentContent);
    base += change.base;
    current += change.current;
    decrease += change.decrease;
  }
  return formatGateTestCountNote(testFiles.length, base, current, decrease);
}

const IMPORTER_GREP_PATHS = ['*.test.ts', '*.test.tsx', '*.test.mts', '*.test.mtsx', '*.test.cts', '*.test.ctsx', '*.test.js', '*.test.jsx', '*.test.mjs', '*.test.mjsx', '*.test.cjs', '*.test.cjsx'];
const SOURCE_PATH_RE = /^src\/.+\.(?:[cm]?[jt]sx?)$/;
const SCRIPT_SOURCE_PATH_RE = /^scripts\/.+\.(?:[cm]?[jt]sx?)$/;
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

function buildGateImporterTestIndex(
  changed: readonly string[],
  cwd: string,
  runCommand: SelfGateCliDeps['runCommand'],
): ImporterTestIndex | null | { readonly lookupFailed: string } {
  const sources = changed.filter((path) => (SOURCE_PATH_RE.test(path) || SCRIPT_SOURCE_PATH_RE.test(path)) && !isTestPath(path));
  if (sources.length === 0) return null;
  const result = (runCommand ?? defaultRunCommand)('git', ['grep', '-l', '-e', '', '--', ...IMPORTER_GREP_PATHS], cwd);
  if ((result.status !== 0 && result.status !== 1) || result.error) {
    return { lookupFailed: (result.stderr ?? result.error?.message ?? 'git grep failed').trim() || 'git grep failed' };
  }
  const tracked = (runCommand ?? defaultRunCommand)('git', ['ls-files'], cwd);
  if (tracked.status !== 0 || tracked.error) {
    return { lookupFailed: (tracked.stderr ?? tracked.error?.message ?? 'git ls-files failed').trim() || 'git ls-files failed' };
  }
  const testPaths = (result.stdout ?? '').split('\n').map((path) => path.trim()).filter(isTestPath);
  const sourcePaths = [...new Set([...(tracked.stdout ?? '').split('\n').map((path) => path.trim()).filter((path) => SOURCE_FILE_RE.test(path)), ...sources])];
  return buildImporterTestIndex(cwd, testPaths, sourcePaths);
}

/** 추적되는 시험 경로 — ⛔ `buildGateImporterTestIndex` 와 «같은 조회»를 쓴다.
 *
 *  ⛔⭐ 여기서 다른 목록을 만들면 그 순간 「같은 질문에 자가 둘」이 된다
 *  (이 파일이 오늘 정확히 그 이유로 −90 줄 고쳐졌다 · `#12654`). */
function trackedTestPaths(
  cwd: string,
  runCommand: SelfGateCliDeps['runCommand'],
): { readonly paths: readonly string[] } | { readonly lookupFailed: string } {
  // ⛔⭐ 조회가 실패하면 «빈 목록»으로 물러나지 않는다 — 그러면 「지킴이 0」이라는
  //   ***거짓 음성***이 되고, 그것이 이 저장소가 반복해 데인 「못 잰 0」이다.
  //   ⇒ `formatUnrunImporterTests` 의 `lookup failed` 와 «같은 규율»을 쓴다.
  let result: ProcessResult;
  try {
    result = (runCommand ?? defaultRunCommand)('git', ['grep', '-l', '-e', '', '--', ...IMPORTER_GREP_PATHS], cwd);
  } catch (error) {
    return { lookupFailed: error instanceof Error ? error.message : String(error) };
  }
  if ((result.status !== 0 && result.status !== 1) || result.error) {
    return { lookupFailed: (result.stderr ?? result.error?.message ?? 'git grep failed').trim() || 'git grep failed' };
  }
  return { paths: (result.stdout ?? '').split('\n').map((path) => path.trim()).filter(isTestPath) };
}

/** 🅣 정책(2026-08-25 · 채널 `#12577`) — ***「보고한다. 막지 않는다.」***
 *
 *  ⛔ 「문서 → 시험」은 «유도»가 원리상 불가능하다 — `AGENTS.md` 와 `rules-contract.test.ts` 는
 *  이름이 안 닮는다. 그래서 «역방향 스캔»으로 「이 문서를 «읽는» 시험」을 찾아 «말만» 한다.
 *  📄 근거 = 내부 문서 `FINDING-the-document-guardian-map-must-be-scanned-not-derived-2026-08-25` */
function documentGuardianLine(
  cwd: string,
  documentPaths: readonly string[],
  runCommand: SelfGateCliDeps['runCommand'],
): string {
  if (documentPaths.length === 0) return formatDocumentGuardians({ guardiansByDocument: new Map(), unreadableTests: 0 }, []);
  const listed = trackedTestPaths(cwd, runCommand);
  if ('lookupFailed' in listed) return `document guardians: lookup failed (${listed.lookupFailed})`;
  return formatDocumentGuardians(buildDocumentGuardianIndex(cwd, listed.paths, documentPaths), documentPaths);
}

/** `bun test` 가 «원리상» 실행할 수 없는 확장자 — 이 게이트의 러너가 JS/TS 뿐이기 때문이다. */
const BUN_TEST_RUNNABLE_RE = /\.(?:[cm]?[jt]sx?)$/;

/** 이 변경을 «다른 축의 게이트»가 책임지는가. 그 축이 있으면 사각지대가 «아니다». */
const CLAIMED_BY_ANOTHER_GATE: readonly { readonly prefix: string; readonly gate: string }[] = [
  { prefix: 'apps/android/', gate: 'android-gate' },
];

/**
 * 🚨 **이 게이트가 «구조적으로» 못 보는 변경을 이름 댄다** (2026-09-07 · `#15673` 취지 · `OBS-T418`).
 *
 * ⛔ 왜: 러너가 `bun test` 라 ***JS/TS 밖 확장자는 「통과」가 아니라 「안 쟀다」***인데,
 *    지금까지 그 자리에서 ***아무 말도 안 했다***. 그래서 Kotlin 시험이 컴파일도 안 되는 채로
 *    리뷰 PASS ⊕ 무인 병합으로 들어왔다(`#15941`).
 * ⭐ 정책은 형제들과 같다 — ***「보고한다. 막지 않는다.」***
 *    막으면 문서·설정 변경마다 빨강이 되고, 그런 게이트는 결국 «꺼진다».
 * ⚠️ 다른 축의 게이트가 책임지는 경로는 «사각지대가 아니다» — 그렇게 세면 수가 늘 부풀어
 *    이 줄이 «읽히지 않는 소음»이 된다.
 */
export function formatUnrunnableChangeKinds(changed: readonly string[]): string {
  const blind = changed.filter((f) =>
    !BUN_TEST_RUNNABLE_RE.test(f) && !CLAIMED_BY_ANOTHER_GATE.some((c) => f.startsWith(c.prefix)));
  if (blind.length === 0) return 'changes outside the bun test runner: (none)';
  const byExt = new Map<string, number>();
  for (const f of blind) {
    const dot = f.lastIndexOf('.');
    const slash = f.lastIndexOf('/');
    const ext = dot > slash ? f.slice(dot) : '(no extension)';
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const parts = [...byExt.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`);
  return `changes outside the bun test runner: ${blind.length} — ${parts.join(' ')}`
    + '  ⚠️ 이 파일들은 이 게이트가 «원리상» 못 잰다 — 「통과」가 아니라 「안 쟀다」다';
}

export function formatUnrunImporterTests(importerTestsNotRun: NonNullable<ReturnType<typeof resolveGateScope>['importerTestsNotRun']> | null, lookupFailed?: string): string {
  if (lookupFailed) return `unrun importer tests: lookup failed (${lookupFailed})`;
  if (!importerTestsNotRun) return 'unrun importer tests: 0';
  const shown = importerTestsNotRun.files.length;
  const overflow = importerTestsNotRun.total - shown;
  const truncated = importerTestsNotRun.truncated && overflow > 0
    ? `, showing ${shown}/${importerTestsNotRun.total}`
    : '';
  const files = shown ? ` (${importerTestsNotRun.files.join(', ')}${truncated})` : '';
  return `unrun importer tests: ${importerTestsNotRun.total}${files}; unresolved relative specifiers: ${importerTestsNotRun.unresolvedRelativeSpecifiers}`;
}

/** gate 출력 한 줄에 실리는 미등재 spawn-lane 시험의 최대 표시 수 — 실측 드리프트(57건)를 전부 나열하면
 *  «읽히지 않는 소음»이 된다(`formatUnrunImporterTests` 의 잘림 정책과 같은 취지). */
const UNLISTED_SPAWN_LANE_DISPLAY_LIMIT = 10;

/** ⛔⭐ 소비자 배선(무인 리뷰 must-fix) — `resolveGateScope` 이 채우는 `runtimeEdgeImpact` 를 읽는 곳이
 *  없으면 그 측정은 어디에도 드러나지 않는다. 정책은 형제들과 같다 — ***「보고한다. 막지 않는다.」***
 *  손으로 관리하는 `GATE_SPAWN_LANE_FILES` 가 실측에서 빠뜨린 spawn-lane 시험을 알린다. */
export function formatUnlistedSpawnLaneTests(impact: ReturnType<typeof resolveGateScope>['runtimeEdgeImpact']): string {
  if (!impact) return 'unlisted spawn-lane tests: (not measured — no importer index)';
  if (!impact.measured) return 'unlisted spawn-lane tests: (not measured)';
  const total = impact.unlistedSpawnLaneTests.length;
  if (total === 0) return 'unlisted spawn-lane tests: 0';
  const shown = impact.unlistedSpawnLaneTests.slice(0, UNLISTED_SPAWN_LANE_DISPLAY_LIMIT);
  const truncated = total > shown.length ? `, showing ${shown.length}/${total}` : '';
  return `unlisted spawn-lane tests: ${total} (${shown.join(', ')}${truncated})`
    + '  ⚠️ GATE_SPAWN_LANE_FILES 가 빠뜨린 실측 spawn-lane 시험 — 「보고만 한다. 막지 않는다.」';
}

export function formatPartialObservationNote(unrunImporterTotal: number, note: string): string {
  if (unrunImporterTotal <= 0) return note;
  return `partial observation: ${unrunImporterTotal} unrun importer tests; ${note}`;
}

interface GateCliBaselinePayload {
  introduced: number;
  preexisting: number;
  unknown: number;
  preconditionUnmet: number;
  timedOut: number;
  timeoutPassedAtBase: number;
  failures: readonly GateTestFailure[];
  baselineFiles: readonly string[];
  baselineStatus: BaselineProcessStatus;
  unrunImporterTotal: number | null;
  lookupFailed: boolean;
}

const ZERO_GATE_BASELINE: GateCliBaselinePayload = {
  introduced: 0,
  preexisting: 0,
  unknown: 0,
  preconditionUnmet: 0,
  timedOut: 0,
  timeoutPassedAtBase: 0,
  failures: [],
  baselineFiles: [],
  baselineStatus: 'pass',
  unrunImporterTotal: 0,
  lookupFailed: false,
};

function logGateCliBaseline(cwd: string, payload: GateCliBaselinePayload): void {
  try {
    const location = observeGateBaselineLocation(cwd);
    debug.log('self-implement', 'gate.baseline', {
      introduced: payload.introduced,
      preexisting: payload.preexisting,
      unknown: payload.unknown,
      preconditionUnmet: payload.preconditionUnmet,
      timedOut: payload.timedOut,
      timeoutPassedAtBase: payload.timeoutPassedAtBase,
      failures: payload.failures,
      baselineFiles: payload.baselineFiles,
      baselineStatus: payload.baselineStatus,
      unrunImporterTotal: payload.unrunImporterTotal,
      lookupFailed: payload.lookupFailed,
      branch: location.branch,
      workdir: location.workdir,
      source: 'gate-cli',
    });
  } catch {
    // Observation must not change gate judgment or exitCode.
  }
}

type GateSelectionOptions = Pick<SelfGateCliOptions, 'base' | 'pr' | 'alwaysInclude' | 'includeImporterTests' | 'scenario' | 'scenarioFile'>;
type GateSelectionDeps = Pick<SelfGateCliDeps, 'changedFiles' | 'exists' | 'isRegularFile' | 'runCommand'>;

function commentOnlyChangedSources(selection: ChangedFileSelection, cwd: string, runCommand: SelfGateCliDeps['runCommand']): string[] {
  const run = runCommand ?? defaultRunCommand;
  // Fail closed: an unreadable base, source or Git command keeps the normal importer set.
  const base = selection.baseRef === 'HEAD'
    ? 'HEAD'
    : (() => {
      try {
        const result = run('git', ['merge-base', selection.baseRef, 'HEAD'], cwd);
        return result.status === 0 && !result.error ? result.stdout?.trim() : undefined;
      } catch { return undefined; }
    })();
  if (!base) return [];
  const commentOnly: string[] = [];
  for (const path of selection.files) {
    if (!/^(?:src|scripts)\/.+\.(?:[cm]?[jt]sx?)$/.test(path) || isTestPath(path)) continue;
    try {
      const prior = run('git', ['show', `${base}:${path}`], cwd);
      if (prior.status !== 0 || prior.error || prior.stdout === undefined) continue;
      if (isCommentOnlySourceChange(prior.stdout, readFileSync(join(cwd, path), 'utf8'), path)) commentOnly.push(path);
    } catch { /* A failed comparison must retain importer coverage. */ }
  }
  return commentOnly;
}

function prepareGateTestSelection(cwd: string, options: GateSelectionOptions, deps: GateSelectionDeps) {
  const selection = (deps.changedFiles ?? ((dir, input) => defaultChangedFiles(dir, input, deps.runCommand)))(cwd, options);
  const exists = deps.exists ?? ((path) => existsSync(`${cwd}/${path}`));
  // Caller: src/release-loop/light-rc.ts runLightRc → runSelfGateCli(dir, { ..., includeImporterTests: true }).
  // scripts/ joins the existing importer index only for that opt-in path.
  const importerIndex = buildGateImporterTestIndex(options.includeImporterTests
    ? selection.files : selection.files.filter((path) => !SCRIPT_SOURCE_PATH_RE.test(path)), cwd, deps.runCommand);
  const lookupFailed = importerIndex && 'lookupFailed' in importerIndex ? importerIndex.lookupFailed : undefined;
  const originalIndex = importerIndex && !('lookupFailed' in importerIndex) ? importerIndex : undefined;
  const commentOnlySources = options.includeImporterTests && originalIndex
    ? commentOnlyChangedSources(selection, cwd, deps.runCommand) : [];
  // testPaths is the independent full tracked-test inventory; only the changed-source
  // reverse edges are filtered. Other consumers still need that complete inventory.
  const availableIndex = originalIndex && commentOnlySources.length
    ? { ...originalIndex, testsBySource: new Map([...originalIndex.testsBySource].filter(([source]) => !commentOnlySources.includes(source))) }
    : originalIndex;
  const routeIndex = availableIndex?.testPaths
    ? buildRouteConsumerTestIndex(cwd, availableIndex.testPaths, selection.files.filter((path) => !commentOnlySources.includes(path)), selection.baseRef) : null;
  const scope = resolveGateScope(selection.files, exists, availableIndex,
    { routeConsumerTestIndex: routeIndex ?? undefined });
  return { selection, exists, lookupFailed, availableIndex, commentOnlySources, routeIndex, scope };
}

function finishGateTestSelection(prepared: ReturnType<typeof prepareGateTestSelection>, options: GateSelectionOptions, cwd: string, deps: GateSelectionDeps) {
  const { selection, exists, lookupFailed, availableIndex, commentOnlySources, routeIndex, scope } = prepared;
  const alwaysInclude = [...new Set((options.alwaysInclude ?? []).map(normalizeGatePath).filter(Boolean))];
  const alwaysIncludeMissing = alwaysInclude.filter((path) => !exists(path));
  const scopedTests = scope.testArgs ?? [];
  const alwaysIncludeExtra = alwaysInclude.filter((path) => exists(path) && !scopedTests.includes(path));
  let scenarioTests: string[] = [];
  if (options.scenario !== undefined || options.scenarioFile !== undefined) {
    if (options.scenario !== undefined && options.scenarioFile !== undefined) throw new Error('choose scenario or scenarioFile');
    const run = deps.runCommand ?? defaultRunCommand;
    const headSha = requireOutput(run, 'git', ['rev-parse', 'HEAD'], cwd).trim();
    const baseSha = options.base
      ? requireOutput(run, 'git', ['merge-base', options.base, 'HEAD'], cwd).trim()
      : requireOutput(run, 'git', ['rev-parse', selection.baseRef], cwd).trim();
    const scenario = parseGateScenario(options.scenarioFile === undefined ? options.scenario : readGateScenarioFile(options.scenarioFile), { baseSha, headSha, changedFiles: selection.files });
    scenarioTests = scenario.selectedTests.map(({ path }) => path);
    if (scenarioTests.some((path) => !exists(path))) throw new Error('gate scenario invalid: selected test missing');
    const isRegularFile = deps.isRegularFile ?? ((dir: string, path: string) => {
      try {
        const root = realpathSync(dir);
        const target = join(dir, path);
        return lstatSync(target).isFile() && realpathSync(target).startsWith(`${root}/`);
      } catch { return false; }
    });
    if (scenarioTests.some((path) => !isRegularFile(cwd, path))) throw new Error('gate scenario invalid: selected test is not a regular file');
  }
  // RELEASE-DAILY-LIGHT-RC ② — the scope already runs importer tests as callers, but capped (GATE_CALLER_TEST_LIMIT);
  // a day of landings overflows that cap and source-only regressions went unrun (0.2.24: 20). Opt-in: every importer.
  const changedSources = selection.files.filter((path) => !isTestPath(path));
  const importerSources = changedSources.filter((path) => !commentOnlySources.includes(path));
  const importerTestsAdded = options.includeImporterTests && availableIndex
    ? [...new Set(importerSources.flatMap((source) => availableIndex.testsBySource.get(source) ?? []))]
      .filter((path) => exists(path) && !scopedTests.includes(path) && !alwaysIncludeExtra.includes(path)).sort()
    : [];
  const defaultTests = [...scopedTests, ...alwaysIncludeExtra, ...importerTestsAdded];
  const testFiles = scenarioTests.length ? [...new Set([...defaultTests, ...scenarioTests])] : defaultTests;
  const skipTestStep = scope.skipTestStep && alwaysIncludeExtra.length === 0 && importerTestsAdded.length === 0 && scenarioTests.length === 0;
  const importerTestsNotRun = (options.includeImporterTests || scenarioTests.length > 0) && availableIndex
    ? importerTestsNotInRunSet(availableIndex, importerSources, testFiles) : scope.importerTestsNotRun;
  const unrunImporterTotal = lookupFailed ? null : (importerTestsNotRun?.total ?? 0);
  // Overflowed callers that ② ran anyway are not «not run».
  const callerTestsOverflow = scope.callerTestsOverflow.filter(({ file }) => !importerTestsAdded.includes(file) && !scenarioTests.includes(file));
  const importerLookupFailed = Boolean(lookupFailed);
  return { ...prepared, alwaysInclude, alwaysIncludeMissing, alwaysIncludeExtra, importerTestsAdded, commentOnlySources, scenarioTests,
    testFiles, skipTestStep, importerTestsNotRun, unrunImporterTotal, callerTestsOverflow, importerLookupFailed };
}

/** Read-only preflight for the same changed-file → importer → scope selection used by `self gate`. */
export function selectGateTestFiles(cwd: string, options: GateSelectionOptions = {}, deps: GateSelectionDeps = {}) {
  if (options.base && options.pr) throw new Error('use either --base <ref> or --pr <number>, not both');
  const picked = finishGateTestSelection(prepareGateTestSelection(cwd, options, deps), options, cwd, deps);
  return {
    changedFiles: picked.selection.files,
    baseRef: picked.selection.baseRef,
    reason: picked.scope.reason,
    testFiles: picked.testFiles,
    skipTestStep: picked.skipTestStep,
    unverified: picked.scope.unverified,
    alwaysIncludeMissing: picked.alwaysIncludeMissing,
    importerTestsAdded: picked.importerTestsAdded,
    importerTestsNotRun: picked.importerTestsNotRun,
    unrunImporterTotal: picked.unrunImporterTotal,
    lookupFailed: picked.lookupFailed,
    routeLookupFailures: picked.routeIndex?.lookupFailures ?? [],
    callerTestsOverflow: picked.callerTestsOverflow,
  };
}

export function runSelfGateCli(cwd: string, options: SelfGateCliOptions = {}, deps: SelfGateCliDeps = {}): SelfGateCliResult {
  const capture: GateArtifactCapture = {};
  const result = runSelfGateCliCore(cwd, options, deps, capture, false) as SelfGateCliResult;
  if (options.artifactDir !== undefined) emitGateArtifacts(cwd, options.artifactDir, result, capture, deps);
  return result;
}

/** Production path: shard bundles use async Bun children; all non-shard policy and timeout logic is shared. */
export async function runSelfGateCliAsync(cwd: string, options: SelfGateCliOptions = {}, deps: SelfGateCliDeps = {}): Promise<SelfGateCliResult> {
  const capture: GateArtifactCapture = {};
  const result = await runSelfGateCliCore(cwd, options, deps, capture, true);
  if (options.artifactDir !== undefined) emitGateArtifacts(cwd, options.artifactDir, result, capture, deps);
  return result;
}

/** 쓰기 실패는 «경고 한 줄»로만 접는다 — 판정·exit 코드는 그대로다. */
function emitGateArtifacts(cwd: string, artifactDir: string, result: SelfGateCliResult, capture: GateArtifactCapture, deps: SelfGateCliDeps): void {
  if (!artifactDir.trim()) {
    result.lines.push('⚠ artifacts: --artifact-dir 가 빈 경로라 안 썼다 (판정은 그대로다)');
    return;
  }
  const dir = resolveArtifactDir(artifactDir, cwd);
  try {
    const resolveRev = deps.resolveRev ?? defaultRevResolver(cwd);
    const counts = gateArtifactCounts(result, capture);
    const written = writeGateArtifacts({
      dir,
      head40: resolveRev('HEAD'),
      base40: capture.baseRef ? resolveRev(capture.baseRef) : null,
      envKey: (deps.envKey ?? defaultGateEnvKey)(),
      testFiles: capture.testFiles ?? result.testFiles,
      verdict: capture.verdict ?? null,
      ...(capture.verdictLine !== undefined ? { verdictLine: capture.verdictLine } : {}),
      ...(capture.timeoutRechecks ? { timeoutRechecks: capture.timeoutRechecks } : {}),
      exitCode: result.exitCode,
      counts: counts.counts,
      ...(counts.reason !== undefined ? { countsUnavailableReason: counts.reason } : {}),
      ...(capture.unmeasuredReason !== undefined ? { unmeasuredReason: capture.unmeasuredReason } : {}),
      ...(capture.sharded ? { sharded: capture.sharded } : {}),
      ...(capture.unshardedRc !== undefined ? { unshardedRc: capture.unshardedRc } : {}),
      ...(capture.artifactsUnavailable ? { artifactsUnavailable: capture.artifactsUnavailable } : {}),
    });
    result.lines.push(`artifacts: ${written.summaryPath} (junit ${written.junitFiles.length}${capture.artifactsUnavailable ? ` · unavailable=${capture.artifactsUnavailable}` : ''})`);
  } catch (error) {
    result.lines.push(`⚠ artifacts: ${dir} 에 못 썼다 — ${error instanceof Error ? error.message : String(error)} (판정은 그대로다)`);
  }
}

/** A completed bundle is observed immediately, before the synchronous runner returns. Each sink is best effort. */
function shardProgressObserver(cwd: string, options: SelfGateCliOptions, deps: SelfGateCliDeps): (progress: ShardRunProgress) => void {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  return (progress) => {
    const elapsedMs = Math.max(0, now() - startedAt);
    const estimatedRemainingMs = progress.completedShards > 0
      ? Math.round(elapsedMs * (progress.totalShards - progress.completedShards) / progress.completedShards) : null;
    const snapshot = { ...progress, elapsedMs, estimatedRemainingMs };
    const line = `gate shard progress: bundles ${progress.completedShards}/${progress.totalShards} · files ${progress.completedFiles}/${progress.totalFiles} · elapsed ${Math.round(elapsedMs / 1000)}s · remaining ~${estimatedRemainingMs === null ? '?' : Math.round(estimatedRemainingMs / 1000) + 's'}\n`;
    try { (deps.writeProgressStderr ?? ((value) => { process.stderr.write(value); }))(line); } catch { /* observation only */ }
    try { debug.log('gate.cli', 'shard-progress', snapshot); } catch { /* observation only */ }
    if (!options.artifactDir?.trim()) return;
    let temporary: string | undefined;
    try {
      const dir = resolveArtifactDir(options.artifactDir, cwd);
      mkdirSync(dir, { recursive: true });
      temporary = join(dir, `.progress.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
      renameSync(temporary, join(dir, 'progress.json'));
    } catch { /* artifact failure must not affect the gate verdict */ }
    finally { if (temporary) { try { rmSync(temporary, { force: true }); } catch { /* observation only */ } } }
  };
}

function runSelfGateCliCore(cwd: string, options: SelfGateCliOptions, deps: SelfGateCliDeps, capture: GateArtifactCapture, asyncShards: boolean): SelfGateCliResult | Promise<SelfGateCliResult> {
  if (options.base && options.pr) throw new Error('use either --base <ref> or --pr <number>, not both');
  if (options.shards !== undefined && (!Number.isSafeInteger(options.shards) || options.shards < 1)) throw new Error('invalid --shards count');
  if (options.shardConcurrency !== undefined && (!Number.isSafeInteger(options.shardConcurrency) || options.shardConcurrency < 1 || options.shardConcurrency > 4)) throw new Error('invalid shard concurrency (expected 1–4)');
  if (options.fixedShardDistribution && options.shards === undefined) throw new Error('--fixed-shard-distribution requires --shards <n>');
  const prepared = prepareGateTestSelection(cwd, options, deps);
  const { selection, lookupFailed, routeIndex, scope } = prepared;
  const expose = publicExposureFiles(selection.files).length > 0
    ? runExposeGate(cwd, selection.files, getUserConfig().harness?.exposeGate === 'strict' ? 'strict' : 'warn', deps.runCommand)
    : { passed: true, log: '' };
  const { alwaysInclude, alwaysIncludeMissing, alwaysIncludeExtra, importerTestsAdded, commentOnlySources, scenarioTests, testFiles,
    skipTestStep, importerTestsNotRun, unrunImporterTotal, callerTestsOverflow, importerLookupFailed } = finishGateTestSelection(prepared, options, cwd, deps);
  const lines = [
    // ⛔⭐ 「changed=0」을 «초록»으로 읽는 사고가 났다(2026-09-02 · 🅕 보고 · 🅣 재현).
    //   커밋 «전»에 돌리면 작업 트리 변경은 «안 세므로» changed=0 이 나오는데,
    //   그것은 「통과」가 아니라 ***「아무것도 «안» 쟀다」***다. 그래서 그 자리에서 «말한다».
    `[self gate] changed=${selection.files.length} base=${selection.baseRef} reason=${scope.reason}`
      + (selection.files.length === 0 && (selection.ignoredDirtyPaths?.length ?? 0) > 0
        ? `  ⚠️ 센 것이 0인데 «커밋 안 된» 변경 ${selection.ignoredDirtyPaths!.length}개가 있다 — 「통과」가 아니라 「안 쟀다」다(커밋 뒤 다시 돌려라)`
        : ''),
    `scope: ${scope.testArgs?.join(', ') ?? '(test step skipped)'}`,
    `ignored unrelated worktree changes: ${selection.ignoredDirtyPaths === undefined ? '(not checked)' : selection.ignoredDirtyPaths.join(', ') || '(none)'}`,
    `unverified: ${scope.unverified.length} (${scope.unverified.join(', ') || '(none)'})`,
    `elanous runtime artifacts: ${scope.elanousRuntimeArtifacts.length} (${scope.elanousRuntimeArtifacts.join(', ') || '(none)'})`,
    `document paths: ${scope.documentPaths.join(', ') || '(none)'}`,
    `documents without derived tests: ${scope.documentsWithoutDerivedTests.join(', ') || '(none)'}`,
    // ⭐ 🅣 정책(2026-08-25 · 채널 #12577) — ***「보고한다. 막지 않는다.」***
    //   ⛔ 「문서 → 시험」은 «유도»가 원리상 불가능하다(`AGENTS.md` ↔ `rules-contract.test.ts`
    //   는 이름이 안 닮는다). 그래서 «역방향 스캔»으로 「이 문서를 «읽는» 시험」을 찾아 «말만» 한다.
    //   📄 근거 = 내부 문서 `FINDING-the-document-guardian-map-must-be-scanned-not-derived-2026-08-25`
    documentGuardianLine(cwd, scope.documentPaths, deps.runCommand),
    // 🚨 러너 우주 «밖» — 형제들과 같은 정책으로 «말만» 한다(`OBS-T418`).
    formatUnrunnableChangeKinds(selection.files),
    formatUnrunImporterTests(importerTestsNotRun, lookupFailed),
    // ⛔⭐ 무인 리뷰 must-fix — 죽은 필드 배선: `resolveGateScope` 이 채운 `runtimeEdgeImpact` 을
    //   실제로 읽어 출력하는 소비자(이 줄이 없으면 그 측정은 어디에도 드러나지 않는다).
    formatUnlistedSpawnLaneTests(scope.runtimeEdgeImpact),
    `caller tests: ${lookupFailed ? `lookup failed (${lookupFailed})` : scope.callerTests.map(({ file, reasons }) => `${file} (${reasons.join('+')})`).join(', ') || (routeIndex?.lookupFailures.length ? 'route lookup incomplete' : '(none)')}`,
    ...(routeIndex?.lookupFailures.length ? [`⚠️ caller route base lookup failed — unmeasured: ${routeIndex.lookupFailures.map(({ source, reason }) => `${source} (${reason})`).join(', ')}`] : []),
    ...(callerTestsOverflow.length ? [`⚠️ caller test cap exceeded — not run: ${callerTestsOverflow.map(({ file, reasons }) => `${file} (${reasons.join('+')})`).join(', ')}`] : []),
    changedTestCountNote(cwd, selection.files, selection.baseRef, deps.runCommand, deps.readFile),
    // Only printed when the caller asked for always-include paths — the plain `self gate` output is unchanged.
    ...(options.alwaysInclude !== undefined
      ? [`always include: ${alwaysInclude.length - alwaysIncludeMissing.length}/${alwaysInclude.length} (added ${alwaysIncludeExtra.length}${alwaysIncludeMissing.length ? ` · missing: ${alwaysIncludeMissing.join(', ')}` : ''})`]
      : []),
    ...(options.includeImporterTests
      ? [`importer tests added: ${lookupFailed ? `lookup failed (${lookupFailed})` : `${importerTestsAdded.length} (reason=changed-source-importer${importerTestsAdded.length ? ` · ${importerTestsAdded.join(', ')}` : ''})`}`]
      : []),
    ...(commentOnlySources.length ? [`comment-only importer expansion excluded: ${commentOnlySources.join(', ')}`] : []),
    ...(options.scenario !== undefined || options.scenarioFile !== undefined ? [`scenario tests: ${scenarioTests.length} (${scenarioTests.join(', ')})`] : []),
  ];
  if (expose.log) lines.push(expose.log);
  capture.baseRef = selection.baseRef;
  capture.testFiles = skipTestStep ? [] : testFiles;
  capture.unrunImporters = unrunImporterTotal;
  if (lookupFailed) capture.importerLookupFailed = lookupFailed;
  if (options.pr) {
    const worktreeObservation = observePrWorktreeDirtiness(cwd, selection.prHeadRefName, {
      runCommand: deps.runCommand,
      listPrWorktrees: deps.listPrWorktrees,
      inspectWorktreeDirtiness: deps.inspectWorktreeDirtiness,
    });
    const overlapObservation = selection.prBaseRefName
      ? observePrFileOverlap(cwd, selection.files, selection.baseRef, selection.prBaseRefName, deps.runCommand)
      : { status: 'unavailable' as const, reason: 'PR baseRefName missing' };
    lines.push(formatPrWorktreeObservation(worktreeObservation), formatPrFileOverlapObservation(overlapObservation));
  }
  // 🚨 안드로이드 게이트는 «여기» 있어야 한다 — skipTestStep 조기 리턴 «앞»이다.
  //    ⛔ Kotlin 만 바꾼 PR 은 testArgs 가 비어 skipTestStep 으로 «검사 없이» 0 을 내고 나간다.
  //       #15941 이 정확히 그 경로로 들어와, 컴파일도 안 되는 시험이 main 에 앉아 있었다.
  //    ⇒ 그러므로 bun 시험의 성패와 «무관하게» 이 축을 먼저 판정한다.
  const androidPassed = runAdditionalGate('android-gate', deps.runAndroidGate ?? runAndroidUnitTestGate, selection.files, cwd, lines);
  // 🍎 iOS 축 — 안드로이드와 «같은 자리»에 둔다(skipTestStep 앞). Swift 만 바뀐 PR 도 여기서 조기 리턴한다.
  const iosPassed = runAdditionalGate('ios-gate', deps.runIosGate ?? runIosUnitTestGate, selection.files, cwd, lines);
  const pwaPassed = runAdditionalGate('pwa-gate', deps.runPwaGate ?? runPwaBuildGate, selection.files, cwd, lines);
  let entryBudgetPassed = false;
  try {
    const budget = (deps.runEntryBudgetGate ?? ((dir, files) => {
      const affected = entryBudgetAffected(files);
      return { affected, errors: affected ? auditEntryBudget(dir).errors : [] };
    }))(cwd, selection.files);
    entryBudgetPassed = budget.errors.length === 0;
    lines.push(budget.affected
      ? `next-tui-entry-budget: ${entryBudgetPassed ? 'pass' : `FAIL ${budget.errors.join('; ')}`}`
      : 'next-tui-entry-budget: skip (unrelated changes)');
  } catch (error) {
    lines.push(`next-tui-entry-budget: UNMEASURED ${error instanceof Error ? error.message : String(error)}`);
  }

  if (skipTestStep) {
    const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
    logGateCliBaseline(cwd, { ...ZERO_GATE_BASELINE, unrunImporterTotal, lookupFailed: importerLookupFailed });
    Object.assign(capture, { verdict: 'skipped', artifactsUnavailable: 'no-tests' } satisfies GateArtifactCapture);
    return { exitCode: androidPassed && iosPassed && pwaPassed && entryBudgetPassed && policyPassed && expose.passed ? 0 : 1, lines, changedFiles: selection.files, testFiles: [], unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests, alwaysIncludeMissing, importerTestsAdded, baseline: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 } };
  }

  // The default direct Bun path has one process and one 300s limit. Route real child/PTY tests through
  // the separated shard runner even when the caller did not request --shards.
  if (options.shards !== undefined || testFiles.some(isGateSpawnLaneFile)) {
    const spawnFileCount = testFiles.filter(isGateSpawnLaneFile).length;
    const shardCount = options.shards ?? (Math.min(3, spawnFileCount) + Number(testFiles.length > spawnFileCount));
    const onShardComplete = shardProgressObserver(cwd, options, deps);
    const mode = { ...(options.fixedShardDistribution ? { fixedDistribution: true } : {}), onShardComplete,
      ...(options.shardConcurrency !== undefined ? { concurrency: options.shardConcurrency } : {}) };
    const runResult = asyncShards
      ? (deps.runShardsAsync ?? runShardedGateTestsAsync)(cwd, testFiles, selection.baseRef, shardCount, undefined, undefined, undefined, mode)
      : (deps.runShards ?? runShardedGateTests)(cwd, testFiles, selection.baseRef, shardCount, undefined, undefined, undefined, mode);
    const finishShardedGate = (sharded: ShardRunResult): SelfGateCliResult => {
      capture.sharded = sharded;
      capture.verdict = sharded.aggregate.status;
      lines.push(`shards: ${sharded.shards.length} (${sharded.shards.map((shard) => `${shard.id}=${shard.files.join(',')}`).join('; ')})${sharded.expandedFrom !== undefined ? ` · RSS 예산상 ${sharded.expandedFrom}→${sharded.shards.length} 자동 확장` : ''}${sharded.measurementFailures ? ` · 측정 실패 ${sharded.measurementFailures}` : ''}${options.fixedShardDistribution ? ' · 고정 분배(사전 측정 없음)' : ''}${sharded.distribution === 'fixed-cap-fallback' ? ` · 호스트 상한 자동 고정 분배(${sharded.fallbackReason})` : ''}${sharded.concurrency !== undefined ? ` · 동시성 ${sharded.concurrency} (${sharded.concurrencyReason ?? 'reason unavailable'})` : ''}${sharded.measurementMs !== undefined ? ` · RSS 사전 측정 ${(sharded.measurementMs / 1000).toFixed(1)}s · 묶음 ${((sharded.bundleMs ?? 0) / 1000).toFixed(1)}s · currentΣ ${((sharded.currentProcessMs ?? 0) / 1000).toFixed(1)}s · baselineΣ ${((sharded.baselineProcessMs ?? 0) / 1000).toFixed(1)}s` : ''}`);
      // 조각이 «못 쟀다»일 때 이유가 줄에 없으면 자리·시간 초과·죽음을 가를 수 없다(OP 10-09 light RC) — 종료 코드·신호를 같이 싣는다.
      const side = (code: number | null, signal: string | null | undefined, junit: string | undefined) => signal ? `signal ${signal}` : code === null ? 'exit ?' : `exit ${code}${junit === undefined ? ' · junit 없음' : ''}`;
      for (const attempt of sharded.attempts) {
        const plannedFiles = sharded.shards.find((shard) => shard.id === attempt.shardId)?.files;
        const baselineFiles = attempt.baselineFiles;
        const baselineDifference = baselineFiles && plannedFiles && (baselineFiles.length !== plannedFiles.length || baselineFiles.some((file, index) => file !== plannedFiles[index]))
          ? ` · 기준 파일 ${baselineFiles.join(',') || '(none)'}` : '';
        lines.push(`shard attempt: ${attempt.shardId} #${attempt.attempt} · 지금 ${side(attempt.currentExitCode, attempt.currentSignal, attempt.currentJUnit)} · 기준 ${side(attempt.baselineExitCode, attempt.baselineSignal, attempt.baselineJUnit)} · 파일 ${plannedFiles?.join(',') ?? '(unknown)'}${baselineDifference}`);
        const renderDiagnostic = (value: string): string => redactSecretText(value).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').slice(0, 500);
        if (attempt.currentJUnit === undefined && attempt.currentDiagnostic) lines.push(`shard diagnostic: ${attempt.shardId} #${attempt.attempt} 지금 · ${renderDiagnostic(attempt.currentDiagnostic)}`);
        if (attempt.baselineJUnit === undefined && attempt.baselineDiagnostic) lines.push(`shard diagnostic: ${attempt.shardId} #${attempt.attempt} 기준 · ${renderDiagnostic(attempt.baselineDiagnostic)}`);
      }
      // OP FU (MK #8178 shard-9) — 실패 조각의 자식 출력 꼬리 ⊕ exit/signal 을 파일로 남긴다(관측만 · 판정·exit 불변).
      // --artifact-dir 이 있으면 그 아래, 없으면 임시 디렉토리(JUnit 임시 디렉토리 옆 tmpdir)에.
      if (sharded.failureEvidence?.length) {
        try {
          const evidenceDir = options.artifactDir?.trim() ? resolveArtifactDir(options.artifactDir, cwd) : mkdtempSync(join(tmpdir(), 'elanous-shard-failure-'));
          for (const path of writeShardFailureEvidence(evidenceDir, sharded.failureEvidence)) lines.push(`shard failure evidence: ${path}`);
        } catch (error) {
          lines.push(`⚠ shard failure evidence: 못 썼다 — ${error instanceof Error ? error.message : String(error)} (판정은 그대로다)`);
        }
      }
      const { aggregate } = sharded;
      let shardBaseline: SelfGateCliResult['baseline'];
      let unmeasuredReason: string | undefined;
      if (aggregate.status === 'unmeasured') {
        unmeasuredReason = sharded.reason
          ? redactSecretText(sharded.reason).replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').slice(0, 500)
          : aggregate.retryShardIds.join(', ') || 'no complete JUnit';
        for (const shardId of aggregate.retryShardIds) {
          lines.push(`shard unmeasured: ${shardId} · ${sharded.unmeasuredByShard?.[shardId] ?? sharded.reason ?? 'cause unavailable'}`);
        }
        lines.push(`shards: unmeasured (${unmeasuredReason})`);
        if (sharded.baselineStderrTail) lines.push(`baseline worktree-add git stderr: ${sharded.baselineStderrTail}`);
        capture.unmeasuredReason = unmeasuredReason;
      }
      else if (aggregate.report) {
        const report = recheckTimeoutOnlyIntroducedFailures(cwd, aggregate.report, deps.runTimeoutRecheck);
        capture.timeoutRechecks = report.timeoutRechecks;
        const timeoutRecheckResolvedFailure = aggregate.status === 'failed'
          && (report.loadTimeout ?? 0) > 0
          && report.introduced === 0 && report.unknown === 0 && report.preconditionUnmet === 0
          && report.timedOut === 0 && report.flakyRerun === 0 && report.worktreeFailuresParsed
          && report.baselineStatus !== 'unknown';
        const effectiveStatus = timeoutRecheckResolvedFailure ? 'passed' : aggregate.status;
        capture.verdict = effectiveStatus;
        logGateCliBaseline(cwd, {
          introduced: report.introduced, preexisting: report.preexisting, unknown: report.unknown,
          preconditionUnmet: report.preconditionUnmet, timedOut: report.timedOut,
          timeoutPassedAtBase: report.timeoutPassedAtBase, failures: report.failures.slice(0, 20),
          baselineFiles: report.files, baselineStatus: report.baselineStatus, unrunImporterTotal, lookupFailed: importerLookupFailed,
        });
        lines.push(formatPartialObservationNote(unrunImporterTotal ?? 0, formatGateBaselineNote(report, unrunImporterTotal ?? 0)));
        shardBaseline = { introduced: report.introduced, preexisting: report.preexisting, unknown: report.unknown, preconditionUnmet: report.preconditionUnmet };
      } else {
        lines.push(formatPartialObservationNote(unrunImporterTotal ?? 0, `tests: pass (${testFiles.length} files)`));
        logGateCliBaseline(cwd, { ...ZERO_GATE_BASELINE, unrunImporterTotal, lookupFailed: importerLookupFailed });
        shardBaseline = { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 };
      }
      capture.verdictLine = lines[lines.length - 1];
      const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
      return {
        exitCode: capture.verdict !== 'passed' || !policyPassed || !androidPassed || !iosPassed || !pwaPassed || !entryBudgetPassed || !expose.passed ? 1 : 0,
        lines, changedFiles: selection.files, testFiles, unverified: scope.unverified,
        documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests,
        alwaysIncludeMissing, importerTestsAdded, ...(shardBaseline ? { baseline: shardBaseline } : {}),
        ...(unmeasuredReason !== undefined ? { unmeasuredReason } : {}),
      };
    };
    return runResult instanceof Promise ? runResult.then(finishShardedGate) : finishShardedGate(runResult);
  }

  const test = (deps.runTests ?? ((dir, files) => (deps.runCommand ?? defaultRunCommand)('bun', ['test', ...files], dir)))(cwd, testFiles);
  const worktreeLog = formatProcessOutput(test);
  Object.assign(capture, { unshardedRc: test.status, artifactsUnavailable: 'unsharded' } satisfies GateArtifactCapture);
  if (test.status === 0 && !test.error) {
    lines.push(formatPartialObservationNote(unrunImporterTotal ?? 0, `tests: pass (${testFiles.length} files)`));
    Object.assign(capture, { verdict: 'passed', verdictLine: lines[lines.length - 1] } satisfies GateArtifactCapture);
    const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
    logGateCliBaseline(cwd, { ...ZERO_GATE_BASELINE, unrunImporterTotal, lookupFailed: importerLookupFailed });
    return { exitCode: policyPassed && androidPassed && iosPassed && pwaPassed && entryBudgetPassed && expose.passed ? 0 : 1, lines, changedFiles: selection.files, testFiles, unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests, alwaysIncludeMissing, importerTestsAdded, baseline: { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0 } };
  }

  if (worktreeLog.includes('deterministic environment setup failed')) lines.push(worktreeLog);
  const baseline = (deps.runBaseline ?? runGateBaseline)(cwd, testFiles, selection.baseRef);
  const report = recheckTimeoutOnlyIntroducedFailures(cwd, buildGateBaselineReport(worktreeLog, baseline), deps.runTimeoutRecheck);
  capture.timeoutRechecks = report.timeoutRechecks;
  logGateCliBaseline(cwd, {
    introduced: report.introduced,
    preexisting: report.preexisting,
    unknown: report.unknown,
    preconditionUnmet: report.preconditionUnmet,
    failures: report.failures.slice(0, 20),
    baselineFiles: report.files,
    baselineStatus: report.baselineStatus,
    timedOut: report.timedOut,
    timeoutPassedAtBase: report.timeoutPassedAtBase,
    unrunImporterTotal,
    lookupFailed: importerLookupFailed,
  });
  lines.push(formatPartialObservationNote(unrunImporterTotal ?? 0, formatGateBaselineNote(report, unrunImporterTotal ?? 0)));
  Object.assign(capture, {
    verdict: report.introduced > 0 || report.unknown > 0 || report.preconditionUnmet > 0 ? 'failed' : 'passed',
    verdictLine: lines[lines.length - 1],
  } satisfies GateArtifactCapture);
  const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
  const exitCode = !androidPassed || !iosPassed || !pwaPassed || !entryBudgetPassed || !policyPassed || !expose.passed || report.introduced > 0 || report.unknown > 0 || report.preconditionUnmet > 0 ? 1 : 0;
  return { exitCode, lines, changedFiles: selection.files, testFiles, unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests, alwaysIncludeMissing, importerTestsAdded, baseline: { introduced: report.introduced, preexisting: report.preexisting, unknown: report.unknown, preconditionUnmet: report.preconditionUnmet } };
}

/** GATE-REMOTE-SHARD-PLAN — a shard plan plus the ready-to-run remote command for each shard. */
export interface RemoteGateShardPlan {
  orchestrationId: string;
  shards: GateRemoteShard[];
  commands: string[][];
}

/** Turn a changed-file list into identity-carrying shards and their remote gate commands (shard-plan → shard-run wiring). */
export function planRemoteGateShardCommands(
  files: readonly string[],
  shardCount: number,
  options?: { planFile?: string; orchestrationId?: string },
): RemoteGateShardPlan {
  const orchestrationId = options?.orchestrationId ?? shardPlanOrchestrationId(files);
  const shards = planGateRemoteShards(files, shardCount, orchestrationId);
  return { orchestrationId, shards, commands: shards.map((shard) => remoteShardArgv(shard, options)) };
}
