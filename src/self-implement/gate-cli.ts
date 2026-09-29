import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path/posix';
import { prepareDeterministicChildEnvironment } from '../../scripts/lib/deterministic-env.js';
import { runIsolationHardcodeGate } from '../../scripts/ci-isolation-hardcode-gate.js';
import { runModelHardcodeGate } from '../../scripts/ci-model-hardcode-gate.js';
import { runDaemonPortGate } from '../../scripts/ci-daemon-port-gate.js';
import { runAndroidUnitTestGate } from '../../scripts/ci-android-unit-tests.js';
import { runIosUnitTestGate } from '../../scripts/ci-ios-unit-tests.js';
import { runMockModuleRestoreGate } from '../../scripts/ci-mock-module-restore-gate.js';
import { parseReviewDepthFromFilesJson } from '../agent-mission/review-depth.js';
import { buildGateBaselineReport, calculateGateTestCountChange, formatGateBaselineNote, formatGateTestCountNote, isGateTestFile, runGateBaseline, type BaselineProcessResult, type BaselineProcessStatus, type GateTestFailure } from './gate-baseline.js';
import { resolveGateScope } from './gate-scope.js';
import { debug } from '../debug/log.js';
import { buildDocumentGuardianIndex, formatDocumentGuardians } from './document-guardian-index.js';
import { buildImporterTestIndex, isTestPath, type ImporterTestIndex } from './importer-test-index.js';
import { gitChangedFiles, observeGateBaselineLocation } from './seams.js';
import {
  collectBaseLandingCommits,
  overlapWithCurrentChanges,
} from '../cli/pr-granularity.js';
import { listWorktrees } from '../git-fs/worktree.js';

interface SelfGateCliOptions {
  base?: string;
  pr?: string;
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
  runCommand?: (command: string, args: string[], cwd: string) => ProcessResult;
  readFile?: (path: string) => string | undefined;
  runTests?: (cwd: string, files: readonly string[]) => ProcessResult;
  runBaseline?: (cwd: string, files: readonly string[], baseRef: string) => BaselineProcessResult;
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
  listPrWorktrees?: (cwd: string) => PrWorktreeListEntry[] | { lookupFailed: string };
  inspectWorktreeDirtiness?: (path: string) => { dirty: boolean } | { lookupFailed: string };
}

interface GateOutput {
  args?: string[];
  cwd: string;
  log: (message: string) => void;
  error: (message: string) => void;
}

interface SelfGateCliResult {
  exitCode: number;
  lines: string[];
  changedFiles: string[];
  testFiles: string[];
  unverified: readonly string[];
  documentPaths: readonly string[];
  documentsWithoutDerivedTests: readonly string[];
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
      isolated = prepareDeterministicChildEnvironment('elanous-gate-cli-test-env-');
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
  const commits = collectBaseLandingCommits(run, cwd, { since: '0', baseRef: `${baseOid}..${baseRefName}` });
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
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;

function buildGateImporterTestIndex(
  changed: readonly string[],
  cwd: string,
  runCommand: SelfGateCliDeps['runCommand'],
): ImporterTestIndex | null | { readonly lookupFailed: string } {
  const sources = changed.filter((path) => SOURCE_PATH_RE.test(path) && !isTestPath(path));
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

export function runSelfGateCli(cwd: string, options: SelfGateCliOptions = {}, deps: SelfGateCliDeps = {}): SelfGateCliResult {
  if (options.base && options.pr) throw new Error('use either --base <ref> or --pr <number>, not both');
  const selection = (deps.changedFiles ?? ((dir, input) => defaultChangedFiles(dir, input, deps.runCommand)))(cwd, options);
  const exists = deps.exists ?? ((path) => existsSync(`${cwd}/${path}`));
  const importerIndex = buildGateImporterTestIndex(selection.files, cwd, deps.runCommand);
  const lookupFailed = importerIndex && 'lookupFailed' in importerIndex ? importerIndex.lookupFailed : undefined;
  const scope = resolveGateScope(selection.files, exists, importerIndex && !('lookupFailed' in importerIndex) ? importerIndex : undefined);
  const testFiles = [...(scope.testArgs ?? [])];
  const unrunImporterTotal = lookupFailed ? null : (scope.importerTestsNotRun?.total ?? 0);
  const importerLookupFailed = Boolean(lookupFailed);
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
    formatUnrunImporterTests(scope.importerTestsNotRun, lookupFailed),
    changedTestCountNote(cwd, selection.files, selection.baseRef, deps.runCommand, deps.readFile),
  ];
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

  if (scope.skipTestStep) {
    const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
    logGateCliBaseline(cwd, { ...ZERO_GATE_BASELINE, unrunImporterTotal, lookupFailed: importerLookupFailed });
    return { exitCode: androidPassed && iosPassed && policyPassed ? 0 : 1, lines, changedFiles: selection.files, testFiles: [], unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests };
  }

  const test = (deps.runTests ?? ((dir, files) => (deps.runCommand ?? defaultRunCommand)('bun', ['test', ...files], dir)))(cwd, testFiles);
  const worktreeLog = formatProcessOutput(test);
  if (test.status === 0 && !test.error) {
    lines.push(formatPartialObservationNote(unrunImporterTotal ?? 0, `tests: pass (${testFiles.length} files)`));
    const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
    logGateCliBaseline(cwd, { ...ZERO_GATE_BASELINE, unrunImporterTotal, lookupFailed: importerLookupFailed });
    return { exitCode: policyPassed && androidPassed && iosPassed ? 0 : 1, lines, changedFiles: selection.files, testFiles, unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests };
  }

  if (worktreeLog.includes('deterministic environment setup failed')) lines.push(worktreeLog);
  const baseline = (deps.runBaseline ?? runGateBaseline)(cwd, testFiles, selection.baseRef);
  const report = buildGateBaselineReport(worktreeLog, baseline);
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
  const policyPassed = runPolicyGates(selection.files, cwd, lines, deps);
  const exitCode = !androidPassed || !iosPassed || !policyPassed || report.introduced > 0 || report.unknown > 0 || report.preconditionUnmet > 0 ? 1 : 0;
  return { exitCode, lines, changedFiles: selection.files, testFiles, unverified: scope.unverified, documentPaths: scope.documentPaths, documentsWithoutDerivedTests: scope.documentsWithoutDerivedTests };
}
