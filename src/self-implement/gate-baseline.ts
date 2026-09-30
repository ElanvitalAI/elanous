import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareDeterministicChildEnvironment } from '../../scripts/lib/deterministic-env.js';
import { debug } from '../debug/log.js';
import { runGitCommand } from '../git-fs/runner.js';
import { linkWorktreeDependencies } from '../git-fs/worktree.js';

export type GateFailureAttribution = 'introduced' | 'preexisting' | 'unknown' | 'precondition-unmet' | 'flaky-timeout' | 'flaky-rerun';
export type GateBaselinePresence = 'present' | 'missing' | 'unknown';
export type TimeoutVariability = 'may-vary' | 'same' | 'unknown';

export interface GateFailurePrecondition {
  name: string;
  remediation: string;
}

export interface GateTestFailure {
  name: string;
  file: string | undefined;
  /** 실패에 귀속된 진단문(있을 때만). bun 단정 오류는 `(fail)` **앞**, 타임아웃 표지는 `(fail)` **뒤**.
   *  ⭐ 전제 판별이 **여기**를 봐야 한다 — 실제 전제 메시지는 테스트 이름이 아니라 이 안에 온다. */
  diagnostic?: string;
  attribution: GateFailureAttribution;
  /** 기준선 실행 산출과 기존 missingAtBase 입력에서 독립적으로 도출한 파일 존재 상태. */
  baselinePresence: GateBaselinePresence;
  attributedBy?: 'name-across-files';
  precondition?: GateFailurePrecondition;
  /** 같은 gate 실행 안에서 같은 시험의 통과 기록이 있으면 `may-vary`로 보존한다. 타임아웃은 재실행 결과 변동성도 함께 표현한다. */
  timeoutVariability?: TimeoutVariability;
  /** 시간 초과한 정확한 시험이 base 로그에서는 통과해 자식 회귀로 귀속됐는지 나타낸다. */
  timeoutRegression?: 'passed-at-base';
}

export interface GateBaselineSummary {
  introduced: number;
  preexisting: number;
  unknown: number;
  preconditionUnmet: number;
  missingAtBase: number;
  timedOut: number;
  timeoutPassedAtBase: number;
  /** 재실행에서 통과해 `introduced`에서 강등된 비타임아웃 실패 수. 게이트 통과가 아니다. */
  flakyRerun: number;
  /** `introduced`로 재실행 대상이었으나 상한 때문에 돌리지 않은 수. */
  rerunNotRun: number;
}

export interface GateBaselineReport extends GateBaselineSummary {
  /** 현재 타임아웃이지만 기준선에서는 통과했던 실패 수. */
  timeoutPassedAtBase: number;
  /** `flaky-timeout`이 아닌 실패 중 같은 실행에서 통과해 변동 가능성이 확인된 수. */
  mayVaryNonTimeout: number;
  /** 실제 재실행 관측을 얻은 실패 이름 수. */
  rerunAttempted: number;
  /** 실제 재실행 관측 중 하나 이상이 통과한 실패 이름 수. */
  rerunRecovered: number;
  /** `introduced` 재실행 상한 때문에 돌리지 않은 대상 수. 0이면 생략하지 않고 그대로 싣는다. */
  rerunNotRun: number;
  /** flaky-timeout 실패의 재실행 변동성 분포. */
  timeoutVariabilityCounts: { mayVary: number; same: number; unknown: number };
  /** 남은 실패가 전부 flaky-timeout·flaky-rerun·preexisting 이고 흔들림이 하나 이상일 때만 확정하는 자식 면책 결론. */
  childResponsibility?: 'none';
  /** worktree 로그에서 **실패를 하나라도 읽어냈나.** false 면 무죄를 주장할 근거가 없다. */
  worktreeFailuresParsed: boolean;
  failures: GateTestFailure[];
  files: string[];
  baselineStatus: BaselineProcessStatus;
  log: string;
}

interface GateTestCountChange {
  base: number;
  current: number;
  decrease: number;
}

export type BaselineProcessStatus = 'pass' | 'test-fail' | 'unknown';

/** 동일 테스트를 다시 관측했을 때의 타임아웃 변동성 결론. */
export type TimeoutRerunVariability = '달라질 수 있다' | '항상 시간 초과' | '관측 부족';

/** 동일 테스트의 한 번의 실행 결과. */
export type TimeoutRerunObservation = 'pass' | 'timeout' | 'failure';

/** 같은 테스트의 재실행 결과. 키는 `extractGateTestFailures`가 만드는 안정 시험 이름이다. */
export type GateRerunObservations = ReadonlyMap<string, readonly TimeoutRerunObservation[]> | Readonly<Record<string, readonly TimeoutRerunObservation[]>>;

function escapeRegexSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bun의 단일 시험 필터는 suite와 test 이름을 공백으로 연결한다. */
export function buildBunSingleTestPattern(testName: string): string {
  return `^${testName.split(' > ').map(escapeRegexSegment).join(' ')}$`;
}

const BUN_SINGLE_TEST_SUMMARY_RE = /Ran (\d+) tests? across (\d+) files?\./;
const BUN_MATCHED_ZERO_TESTS_RE = /matched 0 tests/i;

/**
 * 동일 테스트의 재실행 관측만으로 타임아웃이 변동하는지 분류한다.
 * 타임아웃과 다른 결과가 함께 관측되면 변동 가능성을 확정하고, 둘 이상이 모두 시간 초과면
 * 반복 시간 초과를 확정한다. 한 번의 시간 초과만으로는 관측 부족으로 남긴다.
 */
export function classifyTimeoutRerunVariability(
  observations: readonly TimeoutRerunObservation[],
): TimeoutRerunVariability {
  const hasTimeout = observations.includes('timeout');
  if (hasTimeout && observations.some((observation) => observation !== 'timeout')) return '달라질 수 있다';
  if (observations.length >= 2 && observations.every((observation) => observation === 'timeout')) return '항상 시간 초과';
  return '관측 부족';
}

/**
 * 개별 시험 진단문이 타임아웃인가. 프로세스 전체 `/timeout/i` 전제와는 다른 자리 —
 * 실행마다 달라지므로 baseline 대조로 회귀를 단정할 수 없다.
 * 2026-08-28 코퍼스: 실패 261건 중 error: 줄 10건(4%)
 */
export function isTimeoutDiagnostic(diagnostic: string | undefined): boolean {
  if (!diagnostic) return false;
  return /\btimed out\b|\btimeout (?:exceeded|expired|reached)\b/i.test(diagnostic);
}

function isTimeoutAttributedEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const diagnostic = (entry as { diagnostic?: unknown }).diagnostic;
  return typeof diagnostic === 'string' ? isTimeoutDiagnostic(diagnostic) : false;
}

/**
 * 기준선의 같은 항목은 횟수만큼만 면제하고 나머지를 새 회귀로 귀속한다.
 * gate-baseline과 다른 전체-진단 검증기가 같은 기준선 자를 사용한다.
 * 타임아웃 진단은 baseline 유무와 무관하게 `timedOut` 으로만 간다 — 기존 호출자가
 * `timedOut` 을 안 읽어도 `preexisting`/`introduced` 의미는 그대로다.
 */
export function classifyAgainstBaseline<T>(
  baseline: readonly T[],
  current: readonly T[],
  key: (entry: T) => string,
): { preexisting: T[]; introduced: T[]; timedOut: T[] } {
  const remaining = new Map<string, number>();
  for (const entry of baseline) {
    if (isTimeoutAttributedEntry(entry)) continue;
    const entryKey = key(entry);
    remaining.set(entryKey, (remaining.get(entryKey) ?? 0) + 1);
  }
  const preexisting: T[] = [];
  const introduced: T[] = [];
  const timedOut: T[] = [];
  for (const entry of current) {
    if (isTimeoutAttributedEntry(entry)) {
      timedOut.push(entry);
      continue;
    }
    const entryKey = key(entry);
    const available = remaining.get(entryKey) ?? 0;
    if (available > 0) {
      remaining.set(entryKey, available - 1);
      preexisting.push(entry);
    } else {
      introduced.push(entry);
    }
  }
  return { preexisting, introduced, timedOut };
}

const GATE_TEST_PATH_RE = /(?:^|\/)\S+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GATE_TEST_CASE_RE = /\b(?:test|it)\s*\(/g;

export function calculateGateTestCountChange(baseContent: string, currentContent: string): GateTestCountChange {
  const count = (content: string): number => content.match(GATE_TEST_CASE_RE)?.length ?? 0;
  const base = count(baseContent);
  const current = count(currentContent);
  return { base, current, decrease: Math.max(0, base - current) };
}

export function isGateTestFile(path: string): boolean {
  return GATE_TEST_PATH_RE.test(path);
}

export function formatGateTestCountNote(files: number, base: number, current: number, decrease: number): string {
  return `[test-count] changed-test-files=${files}, test-cases=${base}→${current}, decrease=${decrease}; test case=test()/it() call`;
}

type BaselineUnknownReason = 'module-load-error' | 'infrastructure-failure' | 'test-result-unavailable' | 'budget-exceeded';

const BASELINE_TIMEOUT_PER_FILE_MS = 300_000;
const BASELINE_TIMEOUT_TOTAL_CAP_MS = 600_000;

export function baselineTimeoutForFiles(fileCount: number): number {
  return Math.min(Math.max(1, fileCount) * BASELINE_TIMEOUT_PER_FILE_MS, BASELINE_TIMEOUT_TOTAL_CAP_MS);
}

export interface GatePassedTestEvidence {
  status: 'available' | 'unavailable';
  tests?: readonly Pick<GateTestFailure, 'file' | 'name'>[];
  reason?: string;
}

export interface BaselineProcessResult {
  status: BaselineProcessStatus;
  unknownReason?: BaselineUnknownReason;
  baselineBudgetMs?: number;
  baselineFileCount?: number;
  childResponsibility?: 'none';
  output?: string;
  log: string;
  missingAtBase?: readonly string[];
  passedTestEvidence?: GatePassedTestEvidence;
}

type VerifyByBreakingClassification = 'distinguishes' | 'does-not-distinguish' | 'unknown' | 'missing-at-base';

interface VerifyByBreakingFileResult {
  file: string;
  classification: VerifyByBreakingClassification;
  base: BaselineProcessResult;
}

type BaselineDefaultBranchAncestry = 'ancestor' | 'not-ancestor' | 'unknown';

interface VerifyByBreakingResult {
  files: VerifyByBreakingFileResult[];
  baseStatuses: Record<BaselineProcessStatus, number>;
  baselineDefaultBranchAncestry?: BaselineDefaultBranchAncestry;
}

interface ReverseVerifyByBreakingResult {
  ran: boolean;
  files: Array<{ file: string; head: BaselineProcessResult }>;
  headStatuses: Record<BaselineProcessStatus, number>;
}

function flattenControlChars(text: string): string {
  return text.replace(/[\r\n]+/g, ' ⏎ ').replace(/[\u0000-\u001F\u007F]/g, '·');
}

export function isTestAssetPath(file: string): boolean {
  if (/\.(test|spec)\.[cm]?[tj]sx?$/.test(file)) return true;
  return file.split('/').some((segment) => segment === 'test' || segment === 'tests' || segment === '__tests__' || segment === '__snapshots__' || segment === 'fixtures');
}

const VERIFY_BY_BREAKING_OUTPUT_LIMIT = 1_200;
const VERIFY_BY_BREAKING_FAILURE_DETAILS_LIMIT = 1_200;

interface ProcessResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error & { code?: string };
  signal?: string | null;
}

const TEST_FILE_RE = /(?:^|\s)([\w@+~./-]+\.(?:test|spec)\.[cm]?[tj]sx?)(?::|\s*>|$)/;
const MODULE_LOAD_ERROR_RE = /(?:export named ['"`][^'"`]+['"`] not found in module\b|the requested module ['"`][^'"`]+['"`] does not provide an export named ['"`][^'"`]+['"`])/i;

function unknownReasonForUnavailableResult(output: string): BaselineUnknownReason {
  return MODULE_LOAD_ERROR_RE.test(output) ? 'module-load-error' : 'test-result-unavailable';
}

export function hasModuleLoadFailure(output: string): boolean {
  return MODULE_LOAD_ERROR_RE.test(output);
}

const INFRASTRUCTURE_ERROR_RE = [
  /cannot find package/i,
  /cannot find module/i,
  /module not found/i,
  /failed to resolve (?:module|package|import)/i,
  /could not resolve (?:module|package|import)/i,
  /module resolution failed/i,
  /error while loading (?:module|config)/i,
  /failed to load (?:module|config)/i,
  /(?:spawn|exec).*\b(?:enoent|eacces)\b/i,
  /command not found/i,
  /no such file or directory/i,
  /timed? ?out/i,
  /timeout/i,
];
const RUNNER_LOADER_ERROR_RE = /^(?:error|syntaxerror):\s/i;
const DIAGNOSTIC_LINE_BUDGET = 40;
const TEST_FAILURE_LINE_RE = /^\s*(?:\(fail\)|[✗×])\s+/u;
const TEST_OUTPUT_BOUNDARY_RE = /^\s*(?:[\w@+~./-]+\.(?:test|spec)\.[cm]?[tj]sx?:|\d+\s+(?:pass|fail)\b)/i;
const TIMEOUT_MARKER_RE = /^\s*\^ this test timed out/;

interface GatePreconditionRule extends GateFailurePrecondition {
  pattern: RegExp;
}

const GATE_PRECONDITION_RULES: readonly GatePreconditionRule[] = [
  {
    pattern: /requires an explicit tool cwd[\s\S]{0,120}?ELANOUS_TOOL_CWD/i,
    name: 'ELANOUS_TOOL_CWD 미설정',
    remediation: 'ELANOUS_TOOL_CWD를 대상 작업 디렉터리로 설정한 뒤 게이트를 다시 실행하세요.',
  },
];

function errorDiagnosticLines(text: string): string {
  return text.split('\n').filter((line) => /^\s*(?:error|uncaught\s+error)\s*:/i.test(line)).join('\n');
}

function matchedGatePrecondition(diagnostic: string): GateFailurePrecondition | undefined {
  const errors = errorDiagnosticLines(diagnostic);
  if (!errors) return undefined;
  const rule = GATE_PRECONDITION_RULES.find(({ pattern }) => pattern.test(errors));
  return rule && { name: rule.name, remediation: rule.remediation };
}

export function gateBaselineLogLevel(report: GateBaselineReport, nonTestStepsPassed: boolean): 'info' | 'warn' {
  return nonTestStepsPassed && allowsBaselineOnlyFailure(report) ? 'info' : 'warn';
}

function hasInfrastructureFailure(...streams: string[]): boolean {
  for (const stream of streams) {
    let inTestDiagnostic = false;
    for (const line of stripAnsi(stream).split('\n')) {
      if (TEST_FAILURE_LINE_RE.test(line)) {
        inTestDiagnostic = true;
        continue;
      }
      if (TEST_OUTPUT_BOUNDARY_RE.test(line)) inTestDiagnostic = false;
      if (!inTestDiagnostic && RUNNER_LOADER_ERROR_RE.test(line)
        && INFRASTRUCTURE_ERROR_RE.some((pattern) => pattern.test(line))) return true;
    }
  }
  return false;
}

function normalizeFailureName(name: string): string {
  return name.replace(/\s+\[[\d.]+m?s\]$/, '').trim();
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

export function extractGateTestFailures(log: string): Array<Omit<GateTestFailure, 'attribution' | 'baselinePresence'>> {
  const failures: Array<Omit<GateTestFailure, 'attribution' | 'baselinePresence'>> = [];
  const lines = stripAnsi(log).split('\n');
  let currentFile: string | undefined;
  let lastBoundary = -1;
  const failRe = /^\s*(?:\(fail\)|[✗×])\s+(.+?)\s*$/u;
  const headerOf = (line: string): string | undefined =>
    line.trim().match(/^([\w@+~./-]+\.(?:test|spec)\.[cm]?[tj]sx?):$/)?.[1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headerFile = headerOf(line);
    if (headerFile) {
      currentFile = headerFile;
      lastBoundary = i;
      continue;
    }
    if (TEST_OUTPUT_BOUNDARY_RE.test(line)) {
      lastBoundary = i;
      continue;
    }
    const match = line.match(failRe);
    if (!match) continue;

    const front: string[] = [];
    for (let k = lastBoundary + 1; k < i; k++) {
      const candidate = lines[k]!;
      if (TIMEOUT_MARKER_RE.test(candidate)) continue;
      if (TEST_OUTPUT_BOUNDARY_RE.test(candidate)) continue;
      front.push(candidate);
    }

    let timeoutLine: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (headerOf(next) || failRe.test(next) || TEST_OUTPUT_BOUNDARY_RE.test(next)) break;
      if (TIMEOUT_MARKER_RE.test(next)) {
        timeoutLine = next;
        break;
      }
    }

    const frontBudget = timeoutLine ? Math.max(0, DIAGNOSTIC_LINE_BUDGET - 1) : DIAGNOSTIC_LINE_BUDGET;
    const diagnosticLines = timeoutLine
      ? [...front.slice(0, frontBudget), timeoutLine]
      : front.slice(0, DIAGNOSTIC_LINE_BUDGET);
    const diagnostic = diagnosticLines.join('\n').trim();
    const rawName = normalizeFailureName(match[1]!);
    const inlineFile = rawName.match(TEST_FILE_RE)?.[1];
    const file = inlineFile ?? currentFile;
    const testName = inlineFile
      ? rawName.replace(new RegExp(`^${inlineFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>?\\s*`), '')
      : rawName;
    const entry = { name: file ? `${file} > ${testName}` : testName, file };
    failures.push(diagnostic ? { ...entry, diagnostic } : entry);
    lastBoundary = i;
  }
  return failures;
}

type GateTestIdentitySource = Pick<GateTestFailure, 'file' | 'name'>;

function gateTestIdentity({ file, name }: GateTestIdentitySource): string | undefined {
  if (!file) return undefined;
  const prefix = `${file} > `;
  const testName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${file}\u0000${testName}`;
}

function extractGatePassedTests(log: string): Array<Pick<GateTestFailure, 'file' | 'name'>> {
  const tests: Array<Pick<GateTestFailure, 'file' | 'name'>> = [];
  const lines = stripAnsi(log).split('\n');
  let currentFile: string | undefined;
  const passRe = /^\s*(?:\(pass\)|[✓✔])\s+(.+?)\s*$/u;
  const headerOf = (line: string): string | undefined =>
    line.trim().match(/^([\w@+~./-]+\.(?:test|spec)\.[cm]?[tj]sx?):$/)?.[1];
  for (const line of lines) {
    const headerFile = headerOf(line);
    if (headerFile) {
      currentFile = headerFile;
      continue;
    }
    const match = line.match(passRe);
    if (!match) continue;
    const rawName = normalizeFailureName(match[1]!);
    const inlineFile = rawName.match(TEST_FILE_RE)?.[1];
    const file = inlineFile ?? currentFile;
    const testName = inlineFile
      ? rawName.replace(new RegExp(`^${inlineFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>?\\s*`), '')
      : rawName;
    tests.push({ file, name: file ? `${file} > ${testName}` : testName });
  }
  return tests;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[entity]!);
}

export function extractJUnitPassedTests(xml: string): Array<Pick<GateTestFailure, 'file' | 'name'>> {
  const tests: Array<Pick<GateTestFailure, 'file' | 'name'>> = [];
  const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcaseRe)) {
    const [, attributes, body = ''] = match;
    if (/<(?:failure|error|skipped)\b/.test(body)) continue;
    const attribute = (key: string): string | undefined => attributes.match(new RegExp(`\\b${key}=(?:\"([^\"]*)\"|'([^']*)')`))?.slice(1).find((value) => value !== undefined);
    const testName = attribute('name');
    const file = attribute('file') ?? attribute('classname');
    if (!testName || !file) continue;
    const decodedFile = decodeXmlEntities(file);
    tests.push({ file: decodedFile, name: `${decodedFile} > ${decodeXmlEntities(testName)}` });
  }
  return tests;
}

function passedIdentities(tests: readonly Pick<GateTestFailure, 'file' | 'name'>[]): Set<string> {
  return new Set(tests.flatMap((test) => {
    const identity = gateTestIdentity(test);
    return identity ? [identity] : [];
  }));
}

export function classifyGateTestFailures(
  worktreeLog: string,
  baselineLog: string | undefined,
  missingAtBase: readonly string[] = [],
  rerunObservations?: GateRerunObservations,
  baselinePassedEvidence?: GatePassedTestEvidence,
): GateTestFailure[] {
  const missing = new Set(missingAtBase);
  const observationsFor = (name: string): readonly TimeoutRerunObservation[] => {
    if (!rerunObservations) return [];
    if (rerunObservations instanceof Map) return rerunObservations.get(name) ?? [];
    return (rerunObservations as Readonly<Record<string, readonly TimeoutRerunObservation[]>>)[name] ?? [];
  };
  const worktreeFailures = extractGateTestFailures(worktreeLog);
  const baselineFailures = baselineLog === undefined ? [] : extractGateTestFailures(baselineLog);
  const testPath = ({ file, name }: GateTestIdentitySource): string | undefined =>
    file && name.startsWith(`${file} > `) ? name.slice(file.length + 3) : undefined;
  // A Bun failure header can point at a newly added file even when the stack still points at the original test.
  // Names alone are not identities: independent files may declare identically named suites and cases.
  const testSource = (diagnostic: string | undefined, file: string): string | undefined => {
    const escaped = escapeRegexSegment(file);
    const locations = [...(diagnostic ?? '').matchAll(new RegExp(`(?:^|[\\s(])(${escaped}:\\d+:\\d+)(?=[\\s)]|$)`, 'gm'))];
    return locations.length === 1 ? locations[0]![1] : undefined;
  };
  const failuresAcrossFiles = new Map<string, Array<{ file: string; source: string | undefined; diagnostic: string | undefined }>>();
  for (const failure of baselineFailures) {
    const path = testPath(failure);
    if (path && failure.file && !isTimeoutDiagnostic(failure.diagnostic)) {
      const matches = failuresAcrossFiles.get(path) ?? [];
      matches.push({ file: failure.file, source: testSource(failure.diagnostic, failure.file), diagnostic: failure.diagnostic });
      failuresAcrossFiles.set(path, matches);
    }
  }
  const baselinePassed = baselinePassedEvidence?.status === 'available'
    ? passedIdentities(baselinePassedEvidence.tests ?? [])
    : baselinePassedEvidence?.status === 'unavailable' || baselineLog === undefined
      ? new Set<string>()
      : passedIdentities(extractGatePassedTests(baselineLog));
  const baselineTimedOut = new Set(baselineFailures
    .filter((failure) => isTimeoutDiagnostic(failure.diagnostic))
    .flatMap((failure) => {
      const identity = gateTestIdentity(failure);
      return identity ? [identity] : [];
    }));
  const comparable = worktreeFailures.filter((failure) => !isTimeoutDiagnostic(failure.diagnostic) && !matchedGatePrecondition(failure.diagnostic ?? '') && !(failure.file && missing.has(failure.file)) && baselineLog !== undefined && Boolean(failure.file));
  const comparison = classifyAgainstBaseline(baselineFailures, comparable, (failure) => failure.name);
  const preexisting = new Set(comparison.preexisting);
  const nonTimeoutOutcomesByName = new Map<string, number>();
  const passedOutcomesByName = new Map<string, number>();
  const timeoutOutcomesByName = new Map<string, number>();
  for (const failure of worktreeFailures) {
    if (isTimeoutDiagnostic(failure.diagnostic)) {
      timeoutOutcomesByName.set(failure.name, (timeoutOutcomesByName.get(failure.name) ?? 0) + 1);
    } else {
      nonTimeoutOutcomesByName.set(failure.name, (nonTimeoutOutcomesByName.get(failure.name) ?? 0) + 1);
    }
  }
  for (const passed of extractGatePassedTests(worktreeLog)) {
    nonTimeoutOutcomesByName.set(passed.name, (nonTimeoutOutcomesByName.get(passed.name) ?? 0) + 1);
    passedOutcomesByName.set(passed.name, (passedOutcomesByName.get(passed.name) ?? 0) + 1);
  }
  return worktreeFailures.map((failure) => {
    const baselinePresence: GateBaselinePresence = baselineLog === undefined || !failure.file
      ? 'unknown'
      : missing.has(failure.file) ? 'missing' : 'present';
    const precondition = matchedGatePrecondition(failure.diagnostic ?? '');
    if (precondition) return { ...failure, attribution: 'precondition-unmet' as const, baselinePresence, precondition };
    if (isTimeoutDiagnostic(failure.diagnostic)) {
      const hasNonTimeoutOutcome = (nonTimeoutOutcomesByName.get(failure.name) ?? 0) > 0;
      const hasTimeoutOutcome = (timeoutOutcomesByName.get(failure.name) ?? 0) > 0;
      const observations: TimeoutRerunObservation[] = [
        ...(hasTimeoutOutcome ? ['timeout' as const] : []),
        ...(hasNonTimeoutOutcome ? ['failure' as const] : []),
        ...observationsFor(failure.name),
      ];
      const variability = classifyTimeoutRerunVariability(observations);
      const timeoutVariability: TimeoutVariability = (() => {
        switch (variability) {
          case '달라질 수 있다': return 'may-vary';
          case '항상 시간 초과': return 'same';
          case '관측 부족': return 'unknown';
        }
      })();
      const identity = gateTestIdentity(failure);
      if (failure.file && identity && !missing.has(failure.file) && baselinePassed.has(identity) && !baselineTimedOut.has(identity)) {
        return { ...failure, attribution: 'introduced' as const, baselinePresence, timeoutRegression: 'passed-at-base' as const };
      }
      return { ...failure, attribution: 'flaky-timeout' as const, baselinePresence, timeoutVariability };
    }
    const timeoutVariability: TimeoutVariability | undefined = (passedOutcomesByName.get(failure.name) ?? 0) > 0
      ? 'may-vary'
      : undefined;
    if (timeoutVariability) return { ...failure, attribution: 'unknown' as const, baselinePresence, timeoutVariability };
    if (failure.file && missing.has(failure.file)) {
      const path = testPath(failure);
      const matches = path ? failuresAcrossFiles.get(path) : undefined;
      const baseline = matches?.length === 1 ? matches[0] : undefined;
      const source = baseline ? testSource(failure.diagnostic, baseline.file) : undefined;
      if (baseline && path && worktreeFailures.filter((entry) => testPath(entry) === path).length === 1
        && baseline.file !== failure.file && baseline.source && baseline.source === source
        && baseline.diagnostic === failure.diagnostic) {
        debug.log('self-implement.gate', 'attributed-across-files', { name: path, file: failure.file, baselineFile: baseline.file });
        return { ...failure, attribution: 'preexisting' as const, attributedBy: 'name-across-files' as const, baselinePresence };
      }
      return { ...failure, attribution: 'introduced' as const, baselinePresence };
    }
    if (baselineLog === undefined || !failure.file) return { ...failure, attribution: 'unknown' as const, baselinePresence };
    const attribution = preexisting.has(failure) ? 'preexisting' as const : 'introduced' as const;
    // 재실행 관측이 `pass`일 때만 흔들림으로 강등한다. 관측이 없거나 실패면 원래 귀속을 유지한다.
    if (attribution === 'introduced' && observationsFor(failure.name).includes('pass')) {
      return { ...failure, attribution: 'flaky-rerun' as const, baselinePresence };
    }
    return { ...failure, attribution, baselinePresence };
  });
}

function summarizeGateBaseline(failures: readonly GateTestFailure[]): GateBaselineSummary {
  return failures.reduce<GateBaselineSummary>(
    (counts, failure) => {
      const withPresence = failure.baselinePresence === 'missing'
        ? { ...counts, missingAtBase: counts.missingAtBase + 1 }
        : counts;
      if (failure.attribution === 'precondition-unmet') {
        return { ...withPresence, preconditionUnmet: withPresence.preconditionUnmet + 1 };
      }
      if (failure.attribution === 'flaky-timeout') {
        return { ...withPresence, timedOut: withPresence.timedOut + 1 };
      }
      if (failure.attribution === 'flaky-rerun') {
        return { ...withPresence, flakyRerun: withPresence.flakyRerun + 1 };
      }
      const withTimeoutRegression = failure.timeoutRegression === 'passed-at-base'
        ? { ...withPresence, timeoutPassedAtBase: withPresence.timeoutPassedAtBase + 1 }
        : withPresence;
      return { ...withTimeoutRegression, [failure.attribution]: withTimeoutRegression[failure.attribution] + 1 };
    },
    { introduced: 0, preexisting: 0, unknown: 0, preconditionUnmet: 0, missingAtBase: 0, timedOut: 0, timeoutPassedAtBase: 0, flakyRerun: 0, rerunNotRun: 0 },
  );
}

export function classifyBunSingleTestRerun(result: ProcessResult): TimeoutRerunObservation | undefined {
  if (result.error || result.signal || result.status === null) return undefined;
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  if (BUN_MATCHED_ZERO_TESTS_RE.test(output)) return undefined;
  const summary = output.match(BUN_SINGLE_TEST_SUMMARY_RE);
  if (!summary || summary[1] !== '1' || summary[2] !== '1') return undefined;
  if (result.status === 0) return 'pass';
  return isTimeoutDiagnostic(extractGateTestFailures(output)[0]?.diagnostic) ? 'timeout' : 'failure';
}

/** Re-run one timeout failure with Bun's exact name filter and retain only a verified one-test result. */
export function rerunBunSingleTest(cwd: string, file: string, testName: string, timeout: number): TimeoutRerunObservation | undefined {
  const result = runIsolatedBunTest(cwd, ['--test-name-pattern', buildBunSingleTestPattern(testName), file], timeout);
  return classifyBunSingleTestRerun(result);
}

/** `introduced` 재실행 상한. 초과분은 돌리지 않고 보고서에 남긴다. 부하로 건너뛰지 않는다. */
export const INTRODUCED_RERUN_CAP = 8;

export interface GateRerunResult {
  observations: Map<string, TimeoutRerunObservation[]>;
  /** 상한 때문에 재실행하지 않은 `introduced` 대상 수. */
  rerunNotRun: number;
}

function isIntroducedRerunCandidate(
  failure: Pick<GateTestFailure, 'name' | 'file' | 'diagnostic'>,
  baselineLog: string | undefined,
  missingAtBase: readonly string[],
): boolean {
  if (!failure.file || isTimeoutDiagnostic(failure.diagnostic) || matchedGatePrecondition(failure.diagnostic ?? '')) return false;
  if (baselineLog === undefined || missingAtBase.includes(failure.file)) return false;
  const prefix = `${failure.file} > `;
  if (!failure.name.startsWith(prefix)) return false;
  const baselineFailures = extractGateTestFailures(baselineLog);
  return !baselineFailures.some((baseline) => baseline.name === failure.name);
}

/**
 * 타임아웃 실패는 전부, `introduced`로 판정될 비타임아웃 실패는 앞의 N개만 한 번씩 재실행한다.
 * 관측을 못 얻은 실패는 맵에 넣지 않는다 — 원래 귀속을 유지하기 위함이다.
 */
export function rerunBunTimeoutFailures(
  cwd: string,
  failures: readonly Pick<GateTestFailure, 'name' | 'file' | 'diagnostic'>[],
  timeout = 30_000,
  baselineLog?: string,
  missingAtBase: readonly string[] = [],
  rerun: typeof rerunBunSingleTest = rerunBunSingleTest,
): GateRerunResult {
  const observations = new Map<string, TimeoutRerunObservation[]>();
  const seen = new Set<string>();
  let introducedSelected = 0;
  let rerunNotRun = 0;
  for (const failure of failures) {
    if (!failure.file || seen.has(failure.name)) continue;
    const timeoutFailure = isTimeoutDiagnostic(failure.diagnostic);
    const introducedFailure = !timeoutFailure && isIntroducedRerunCandidate(failure, baselineLog, missingAtBase);
    if (!timeoutFailure && !introducedFailure) continue;
    const prefix = `${failure.file} > `;
    if (!failure.name.startsWith(prefix)) continue;
    seen.add(failure.name);
    if (introducedFailure && introducedSelected >= INTRODUCED_RERUN_CAP) {
      rerunNotRun += 1;
      continue;
    }
    if (introducedFailure) introducedSelected += 1;
    const observation = rerun(cwd, failure.file, failure.name.slice(prefix.length), timeout);
    if (observation) observations.set(failure.name, [observation]);
  }
  return { observations, rerunNotRun };
}

function runIsolatedBunTest(cwd: string, args: string[], timeout: number): ProcessResult {
  let isolated: ReturnType<typeof prepareDeterministicChildEnvironment>;
  try {
    isolated = prepareDeterministicChildEnvironment('elanous-gate-test-env-');
  } catch (error) {
    const message = `deterministic environment setup failed: ${String(error)}`;
    return { status: null, stdout: '', stderr: message, error: error instanceof Error ? error : new Error(message) };
  }
  try {
    // SIGKILL — a test that traps SIGTERM while blocked in a native wait never runs its handler, so spawnSync
    // waited forever and its drive grandchildren lived on as ppid=1 orphans (09-30 O1: 19 processes, up to 11h).
    return spawnSync('bun', ['test', ...args], { cwd, env: isolated.env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
  } finally {
    isolated.cleanup();
  }
}

function junitReportTemporaryDirectory(): string {
  return process.env.ELANOUS_GATE_JUNIT_TMPDIR || tmpdir();
}

function runBaselineBunTest(cwd: string, args: string[], timeout: number): ProcessResult & { passedTestEvidence: GatePassedTestEvidence } {
  let reportDir: string;
  try {
    reportDir = mkdtempSync(join(junitReportTemporaryDirectory(), 'elanous-gate-junit-'));
  } catch (error) {
    const process = runIsolatedBunTest(cwd, args, timeout);
    return { ...process, passedTestEvidence: { status: 'unavailable', reason: `JUnit passed-test evidence unavailable: could not create reporter directory: ${String(error)}` } };
  }
  const reportPath = join(reportDir, 'report.xml');
  try {
    const process = runIsolatedBunTest(cwd, ['--reporter=junit', `--reporter-outfile=${reportPath}`, ...args], timeout);
    try {
      if (!existsSync(reportPath)) {
        return { ...process, passedTestEvidence: { status: 'unavailable', reason: 'JUnit passed-test evidence unavailable: reporter outfile was not created' } };
      }
      return { ...process, passedTestEvidence: { status: 'available', tests: extractJUnitPassedTests(readFileSync(reportPath, 'utf8')) } };
    } catch (error) {
      return { ...process, passedTestEvidence: { status: 'unavailable', reason: `JUnit passed-test evidence unreadable: ${String(error)}` } };
    }
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

export function classifyBaselineProcess(result: ProcessResult, budget?: { timeoutMs: number; fileCount: number }): BaselineProcessResult {
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const output = `${stdout}\n${stderr}`;
  if (result.status === 0 && !result.error?.code && !result.signal) {
    return { status: 'pass', log: 'baseline tests passed', output };
  }
  if (result.error?.code === 'ETIMEDOUT' && budget) {
    return {
      status: 'unknown',
      unknownReason: 'budget-exceeded',
      baselineBudgetMs: budget.timeoutMs,
      baselineFileCount: budget.fileCount,
      childResponsibility: 'none',
      log: `baseline budget exceeded: ${budget.timeoutMs}ms across ${budget.fileCount} file(s)`,
      output,
    };
  }
  const infrastructureFailure = result.error?.code
    || result.signal
    || hasInfrastructureFailure(stdout, stderr);
  if (infrastructureFailure) {
    return {
      status: 'unknown',
      unknownReason: 'infrastructure-failure',
      childResponsibility: 'none',
      log: `baseline infrastructure failure: ${String(result.error?.code ?? result.signal ?? 'loader/resolve/timeout')}`,
      output,
    };
  }
  if (result.status === 0) return { status: 'pass', log: 'baseline tests passed', output };
  if (result.status !== null && extractGateTestFailures(output).length > 0) {
    return { status: 'test-fail', log: `baseline tests failed with code ${result.status}`, output };
  }
  const unknownReason = unknownReasonForUnavailableResult(output);
  return {
    status: 'unknown',
    unknownReason,
    childResponsibility: 'none',
    log: unknownReason === 'module-load-error'
      ? 'baseline module-load-error: base lacks an export imported by the edited test; child cannot repair base'
      : `baseline test result unavailable (code ${String(result.status)})`,
    output,
  };
}

function withBaselineWorktree<T>(cwd: string, baseRef: string, run: (baselineDir: string) => T): T | BaselineProcessResult {
  const baselineDir = mkdtempSync(join(tmpdir(), 'elanous-gate-baseline-'));
  let attached = false;
  try {
    const add = runGitCommand(cwd, ['worktree', 'add', '--detach', baselineDir, baseRef], { encoding: 'utf8', timeout: 60_000 });
    if (add.status !== 0) return classifyBaselineProcess({ status: add.status, stdout: add.stdout, stderr: add.stderr });
    attached = true;
    linkDependencies(cwd, baselineDir);
    return run(baselineDir);
  } catch (error) {
    return {
      status: 'unknown',
      unknownReason: 'infrastructure-failure',
      childResponsibility: 'none',
      log: `baseline setup failed: ${String(error)}`,
    };
  } finally {
    if (attached) runGitCommand(cwd, ['worktree', 'remove', '--force', baselineDir], { encoding: 'utf8', timeout: 60_000 });
    rmSync(baselineDir, { recursive: true, force: true });
  }
}

function linkDependencies(cwd: string, dir: string): void {
  const dependencyLinks = linkWorktreeDependencies(cwd, dir, ['node_modules']);
  debug.log('self-implement', 'gate.baseline.dependencies', { cwd, dir, dependencyLinks });
}

function withVerifyWorktree<T>(cwd: string, baseRef: string, run: (dir: string) => T): T | BaselineProcessResult {
  let dir = '';
  let attached = false;
  try {
    dir = mkdtempSync(join(tmpdir(), 'elanous-gate-baseline-'));
    const add = runGitCommand(cwd, ['worktree', 'add', '--detach', dir, baseRef], { encoding: 'utf8', timeout: 60_000 });
    if (add.status !== 0) return classifyBaselineProcess({ status: add.status, stdout: add.stdout, stderr: add.stderr });
    attached = true;
    linkDependencies(cwd, dir);
    return run(dir);
  } catch (error) {
    const reason = `baseline setup failed: ${String(error)}`;
    return { status: 'unknown', log: reason, output: reason };
  } finally {
    try {
      const removed = attached
        ? runGitCommand(cwd, ['worktree', 'remove', '--force', dir], { encoding: 'utf8', timeout: 60_000 })
        : undefined;
      if (removed && removed.status !== 0) {
        debug.log('self-implement', 'gate.verify-by-breaking.cleanup', {
          stage: 'worktree-remove', dir, status: removed.status, stderr: (removed.stderr ?? '').slice(0, 300),
        }, { level: 'warn' });
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      debug.log('self-implement', 'gate.verify-by-breaking.cleanup', {
        stage: 'exception', dir, error: String(error).slice(0, 300),
      }, { level: 'warn' });
    }
  }
}

export function runGateBaseline(cwd: string, failedFiles: readonly string[], baseRef = 'HEAD'): BaselineProcessResult {
  const files = [...new Set(failedFiles.filter(Boolean))];
  if (files.length === 0) return { status: 'unknown', log: 'baseline skipped: failed test files could not be identified' };
  const result = withBaselineWorktree(cwd, baseRef, (baselineDir) => {
    const missingAtBase = files.filter((f) => {
      const probe = runGitCommand(cwd, ['cat-file', '-e', `${baseRef}:${f}`], { encoding: 'utf8', timeout: 15_000 });
      return probe.status === 1;
    });
    const timeoutMs = baselineTimeoutForFiles(files.length);
    const process = runBaselineBunTest(baselineDir, files, timeoutMs);
    const baseline = classifyBaselineProcess(process, { timeoutMs, fileCount: files.length });
    return {
      ...baseline,
      log: process.passedTestEvidence.status === 'unavailable'
        ? `${baseline.log}; ${process.passedTestEvidence.reason}`
        : baseline.log,
      missingAtBase,
      passedTestEvidence: process.passedTestEvidence,
    };
  });
  return result as BaselineProcessResult;
}

function classifyVerifyByBreaking(base: BaselineProcessStatus): VerifyByBreakingClassification {
  if (base === 'unknown') return 'unknown';
  if (base === 'test-fail') return 'distinguishes';
  return 'does-not-distinguish';
}

type BaseTestFilePresence = 'present' | 'missing' | 'unknown';

function probeBaseTestFilePresence(cwd: string, baseRef: string, file: string): BaseTestFilePresence {
  const probe = runGitCommand(cwd, ['ls-tree', '-z', baseRef, '--', `:(literal)${file}`], { encoding: 'utf8', timeout: 15_000 });
  if (probe.status !== 0) return 'unknown';
  const output = probe.stdout ?? '';
  if (output === '') return 'missing';
  if (!output.endsWith('\0')) return 'unknown';
  const records = output.slice(0, -1).split('\0');
  for (const record of records) {
    const tab = record.indexOf('\t');
    if (tab < 0) return 'unknown';
    const header = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (header.length !== 3 || !/^\d+$/.test(header[0]!) || !/^[0-9a-f]+$/i.test(header[2]!) || path === '') return 'unknown';
    if (path === file && header[1] === 'blob') return 'present';
  }
  return 'missing';
}

function assertInsideBaseline(baselineDir: string, target: string, file: string): void {
  const root = realpathSync(baselineDir);
  let probe = dirname(target);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw new Error(`refusing to copy: no existing ancestor for ${file}`);
    probe = parent;
  }
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(`${root}/`)) {
    throw new Error(`refusing to copy outside baseline worktree: ${real}`);
  }
}

function baselineDefaultBranchAncestry(cwd: string, baseRef: string): BaselineDefaultBranchAncestry {
  const head = runGitCommand(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', timeout: 20_000 });
  if (head.status !== 0) return 'unknown';
  const defaultRef = `${head.stdout ?? ''}`.trim().replace(/^refs\/remotes\//, '');
  if (!defaultRef || runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', defaultRef], { encoding: 'utf8', timeout: 20_000 }).status !== 0) return 'unknown';
  const result = runGitCommand(cwd, ['merge-base', '--is-ancestor', baseRef, defaultRef], { encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 ? 'ancestor' : result.status === 1 ? 'not-ancestor' : 'unknown';
}

export function runVerifyByBreaking(cwd: string, testFiles: readonly string[], baseRef = 'HEAD'): VerifyByBreakingResult {
  const files = [...new Set(testFiles.filter(Boolean))];
  const ancestry = baselineDefaultBranchAncestry(cwd, baseRef);
  if (files.length === 0) return { files: [], baseStatuses: { pass: 0, 'test-fail': 0, unknown: 0 }, baselineDefaultBranchAncestry: ancestry };
  const baseTestFilePresence = new Map(files.map((file) => [file, probeBaseTestFilePresence(cwd, baseRef, file)]));
  const startedAt = Date.now();
  const result = withVerifyWorktree(cwd, baseRef, (baselineDir) => {
    const copyFailures = new Map<string, string>();
    for (const file of files) {
      if (Date.now() >= deadlineFor(startedAt)) {
        copyFailures.set(file, 'verify-by-breaking skipped: budget exhausted before copy');
        continue;
      }
      try {
        const source = join(cwd, file);
        const target = join(baselineDir, file);
        assertInsideBaseline(baselineDir, target, file);
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`refusing to overwrite symlink: ${file}`);
        rmSync(target, { recursive: true, force: true });
        copyFileSync(source, target);
      } catch (error) {
        copyFailures.set(file, `verify-by-breaking setup failed: ${String(error)}`);
      }
    }
    const deadline = deadlineFor(startedAt);
    return files.map((file) => {
      if (Date.now() >= deadline) {
        const over = `verify-by-breaking skipped: total budget ${VERIFY_BY_BREAKING_TOTAL_BUDGET_MS}ms exhausted`;
        return { file, classification: 'unknown' as const, base: { status: 'unknown' as const, log: over, output: over } };
      }
      const failure = copyFailures.get(file);
      if (failure !== undefined) {
        return { file, classification: 'unknown' as const, base: { status: 'unknown' as const, log: failure, output: failure } };
      }
      const remaining = deadline - Date.now();
      if (remaining < VERIFY_BY_BREAKING_MIN_RUN_MS) {
        const over = `verify-by-breaking skipped: remaining budget ${Math.max(0, remaining)}ms < ${VERIFY_BY_BREAKING_MIN_RUN_MS}ms`;
        return { file, classification: 'unknown' as const, base: { status: 'unknown' as const, log: over, output: over } };
      }
      const process = runBaselineBunTest(baselineDir, ['--', file], remaining);
      const base = { ...classifyBaselineProcess(process), passedTestEvidence: process.passedTestEvidence };
      const presence = baseTestFilePresence.get(file);
      if (presence === 'missing') return { file, classification: 'missing-at-base' as const, base };
      if (presence === 'unknown') {
        const log = `verify-by-breaking base test presence could not be determined for ${file}`;
        return { file, classification: 'unknown' as const, base: { status: 'unknown' as const, log, output: log } };
      }
      return { file, classification: classifyVerifyByBreaking(base.status), base };
    });
  });
  if (!Array.isArray(result)) {
    return { files: files.map((file) => ({ file, classification: 'unknown' as const, base: result })), baseStatuses: { pass: 0, 'test-fail': 0, unknown: files.length }, baselineDefaultBranchAncestry: ancestry };
  }
  const baseStatuses = result.reduce<Record<BaselineProcessStatus, number>>((counts, entry) => entry.classification === 'missing-at-base'
    ? counts
    : { ...counts, [entry.base.status]: counts[entry.base.status] + 1 }, { pass: 0, 'test-fail': 0, unknown: 0 });
  return { files: result, baseStatuses, baselineDefaultBranchAncestry: ancestry };
}

export function runReverseVerifyByBreaking(
  cwd: string,
  testFiles: readonly string[],
  changedSourceFiles: readonly string[],
  baseRef = 'HEAD',
): ReverseVerifyByBreakingResult {
  const files = [...new Set(testFiles.filter(Boolean))];
  const sources = [...new Set(changedSourceFiles.filter(Boolean))].filter((f) => !isTestAssetPath(f));
  const empty: Record<BaselineProcessStatus, number> = { pass: 0, 'test-fail': 0, unknown: 0 };
  if (files.length === 0) return { ran: false, files: [], headStatuses: { ...empty } };
  const startedAt = Date.now();
  let spawned = 0;
  const outcome = withVerifyWorktree(cwd, baseRef, (dir) => {
    const setupFailures = new Map<string, string>();
    const stageSources = (): void => {
      for (const file of sources) {
        try {
          const target = join(dir, file);
          assertInsideBaseline(dir, target, file);
          mkdirSync(dirname(target), { recursive: true });
          let liveStat: ReturnType<typeof lstatSync> | undefined;
          try {
            liveStat = lstatSync(join(cwd, file));
          } catch (e) {
            if ((e as { code?: string }).code !== 'ENOENT') throw e;
            rmSync(target, { force: true, recursive: true });
            continue;
          }
          const sourceStat = liveStat;
          if (sourceStat.isSymbolicLink()) throw new Error(`symlink source is not staged into the isolated worktree (would let the run escape it): ${file}`);
          if (!sourceStat.isFile()) throw new Error(`non-regular source is not staged into the isolated worktree: ${file}`);
          rmSync(target, { force: true, recursive: true });
          copyFileSync(join(cwd, file), target);
        } catch (error) {
          setupFailures.set(file, String(error));
        }
      }
    };
    stageSources();
    const removed = runGitCommand(cwd, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=D', baseRef], { encoding: 'utf8', timeout: 30_000 });
    const applyDeletions = (): void => {
      if (removed.status === 0 && typeof removed.stdout === 'string') {
        for (const file of removed.stdout.split('\0').filter(Boolean)) {
          if (isTestAssetPath(file)) continue;
          try {
            const target = join(dir, file);
            assertInsideBaseline(dir, target, file);
            rmSync(target, { force: true, recursive: true });
          } catch (error) {
            setupFailures.set(file, String(error));
          }
        }
      } else {
        setupFailures.set('<deleted-paths>', `git diff --diff-filter=D failed (status=${String(removed.status)})`);
      }
    };
    applyDeletions();
    const renamedFrom = new Map<string, string>();
    const renames = runGitCommand(cwd, ['diff', '-z', '--name-status', '--find-renames', baseRef], { encoding: 'utf8', timeout: 30_000 });
    if (renames.status === 0 && typeof renames.stdout === 'string') {
      const fields = renames.stdout.split('\0');
      for (let i = 0; i < fields.length; i += 1) {
        const status = fields[i];
        if (status === undefined || status === '') continue;
        if (status.startsWith('R') || status.startsWith('C')) {
          const from = fields[i + 1];
          const to = fields[i + 2];
          if (from && to) renamedFrom.set(to, from);
          i += 2;
        } else {
          i += 1;
        }
      }
    }
    return files.map((file, index) => {
      if (setupFailures.size > 0) {
        const reason = `reverse verify-by-breaking setup failed: could not stage current sources (${[...setupFailures.entries()].map(([f, e]) => `${f}: ${e}`).join('; ')})`;
        return { file, head: { status: 'unknown' as const, log: reason, output: reason } };
      }
      const remaining = deadlineFor(startedAt) - Date.now();
      if (remaining < VERIFY_BY_BREAKING_MIN_RUN_MS) {
        const over = `reverse verify-by-breaking skipped: remaining budget ${Math.max(0, remaining)}ms < ${VERIFY_BY_BREAKING_MIN_RUN_MS}ms`;
        return { file, head: { status: 'unknown' as const, log: over, output: over } };
      }
      if (index > 0) {
        const restored = runGitCommand(dir, ['checkout', '--', '.'], { encoding: 'utf8', timeout: 60_000 });
        const cleaned = runGitCommand(dir, ['clean', '-fdq', '-e', 'node_modules'], { encoding: 'utf8', timeout: 60_000 });
        if (restored.status !== 0 || cleaned.status !== 0) {
          const reason = `reverse verify-by-breaking skipped: could not reset the isolated worktree before ${file}`
            + ` (checkout=${String(restored.status)} clean=${String(cleaned.status)})`;
          return { file, head: { status: 'unknown' as const, log: reason, output: reason } };
        }
        stageSources();
        applyDeletions();
        if (setupFailures.size > 0) {
          const reason = `reverse verify-by-breaking setup failed after reset (${[...setupFailures.entries()].map(([f, e]) => `${f}: ${e}`).join('; ')})`;
          return { file, head: { status: 'unknown' as const, log: reason, output: reason } };
        }
      }
      const basePath = existsSync(join(dir, file)) ? file : renamedFrom.get(file);
      if (basePath === undefined || !existsSync(join(dir, basePath))) {
        const reason = `reverse verify-by-breaking skipped: base test unavailable for ${file}`;
        return { file, head: { status: 'unknown' as const, log: reason, output: reason } };
      }
      spawned += 1;
      return { file, head: classifyBaselineProcess(runIsolatedBunTest(dir, ['--', basePath], remaining)) };
    });
  });
  if (!Array.isArray(outcome)) {
    return { ran: false, files: files.map((file) => ({ file, head: outcome })), headStatuses: { ...empty, [outcome.status]: files.length } };
  }
  const headStatuses = outcome.reduce<Record<BaselineProcessStatus, number>>((counts, entry) => ({ ...counts, [entry.head.status]: counts[entry.head.status] + 1 }), { ...empty });
  return { ran: spawned > 0, files: outcome, headStatuses };
}

function outputExcerpt(output: string | undefined): string {
  const original = output ?? '';
  const originalChars = original.length;
  const text = original.replace(/\r?\n/g, ' ⏎ ').replace(/[\u0000-\u001F\u007F]/g, '·');
  return text.length <= VERIFY_BY_BREAKING_OUTPUT_LIMIT ? text : `${text.slice(0, VERIFY_BY_BREAKING_OUTPUT_LIMIT)} [truncated; originalChars=${originalChars}]`;
}

function failureDetails(output: string | undefined): string {
  const details = extractGateTestFailures(output ?? '')
    .map((failure) => `${failure.name}: ${failure.diagnostic ?? '(failure line only)'}`)
    .join(' | ')
    .replace(/\r?\n/g, ' ⏎ ')
    .replace(/[\u0000-\u001F\u007F]/g, '·');
  if (details.length <= VERIFY_BY_BREAKING_FAILURE_DETAILS_LIMIT) return details;
  return `${details.slice(0, VERIFY_BY_BREAKING_FAILURE_DETAILS_LIMIT)} [truncated; originalChars=${details.length}]`;
}

const VERIFY_BY_BREAKING_NOTE_LIMIT = 6_000;
const VERIFY_BY_BREAKING_TOTAL_BUDGET_MS = 600_000;
const VERIFY_BY_BREAKING_MIN_RUN_MS = 5_000;

function deadlineFor(startedAt: number): number {
  return startedAt + VERIFY_BY_BREAKING_TOTAL_BUDGET_MS;
}

const REVERSE_NOTE_RESERVE = 3_400;

function formatReverseVerifyByBreakingNote(result: ReverseVerifyByBreakingResult, budget?: number): string {
  const statuses = result.headStatuses;
  const flatten = flattenControlChars;
  const entries = result.files.map(({ file, head }) => {
    const failures = failureDetails(head.output);
    return `${flatten(file)}; head=${head.status}; output=${outputExcerpt(head.output)}${failures ? `; failures=${failures}` : ''}`;
  });
  const head = `Reverse verify-by-breaking: ran=${result.ran}; head-pass=${statuses.pass}, head-test-fail=${statuses['test-fail']}, head-unknown=${statuses.unknown}`;
  const full = `${head}; files=[${entries.join(', ')}]`;
  if (budget === undefined || full.length <= budget) return full;
  const ordered = [...entries.keys()]
    .sort((a, b) => {
      const rank = (i: number): number => (result.files[i]!.head.status === 'pass' ? 1 : 0);
      return rank(a) - rank(b) || a - b;
    })
    .map((i) => entries[i]!);
  entries.length = 0;
  entries.push(...ordered);
  for (let keep = entries.length - 1; keep >= 0; keep -= 1) {
    const omitted = entries.length - keep;
    const candidate = `${head}; files=[${entries.slice(0, keep).join(', ')}${keep > 0 ? ', ' : ''}… ${omitted} omitted]`;
    if (candidate.length <= budget) return candidate;
  }
  if (entries.length > 0) {
    const omitted = entries.length - 1;
    const tail = `${omitted > 0 ? `, … ${omitted} omitted` : ''}]`;
    const mark = ' [entry truncated]';
    const room = Math.max(0, budget - head.length - '; files=['.length - tail.length - mark.length);
    return `${head}; files=[${entries[0]!.slice(0, room)}${mark}${tail}`;
  }
  return `${head}; files=[]`;
}

export function formatVerifyByBreakingNote(result: VerifyByBreakingResult, reverse?: ReverseVerifyByBreakingResult): string {
  const finish = (note: string): string => {
    const singleLine = flattenControlChars(note);
    if (singleLine.length <= VERIFY_BY_BREAKING_NOTE_LIMIT) return singleLine;
    const marker = ` [note truncated; originalChars=${singleLine.length}]`;
    return `${singleLine.slice(0, Math.max(0, VERIFY_BY_BREAKING_NOTE_LIMIT - marker.length))}${marker}`;
  };
  const reverseNote = reverse ? formatReverseVerifyByBreakingNote(reverse, REVERSE_NOTE_RESERVE) : '';
  const forwardLimit = reverseNote ? Math.max(0, VERIFY_BY_BREAKING_NOTE_LIMIT - reverseNote.length - 2) : VERIFY_BY_BREAKING_NOTE_LIMIT;
  const withReverse = (note: string): string => {
    const singleLine = flattenControlChars;
    if (!reverseNote) return finish(note);
    const forward = singleLine(note);
    const marker = ` [note truncated; originalChars=${forward.length}]`;
    const kept = forward.length <= forwardLimit
      ? forward
      : `${forward.slice(0, Math.max(0, forwardLimit - marker.length))}${marker}`;
    return `${kept}; ${reverseNote}`;
  };
  const counts = result.files.reduce<Record<VerifyByBreakingClassification, number>>((acc, entry) => ({ ...acc, [entry.classification]: acc[entry.classification] + 1 }), { distinguishes: 0, 'does-not-distinguish': 0, unknown: 0, 'missing-at-base': 0 });
  const flatten = flattenControlChars;
  const details = result.files.map((entry) => {
    const failures = failureDetails(entry.base.output);
    return `${flatten(entry.file)}=${entry.classification}; base=${entry.base.status}; output=${outputExcerpt(entry.base.output)}${failures ? `; failures=${failures}` : ''}`;
  }).join(' | ');
  const reasonOf = (entry: VerifyByBreakingFileResult): string => {
    if (entry.classification !== 'unknown') return '';
    const responsibility = entry.base.childResponsibility ? `; child-responsibility=${entry.base.childResponsibility}` : '';
    const raw = `${entry.base.unknownReason ?? 'unknown'}${responsibility}; ${(entry.base.log ?? '').replace(/\s+/g, ' ')}`;
    if (!raw) return '(unknown)';
    const LIMIT = 120;
    return raw.length <= LIMIT ? `(${raw})` : `(${raw.slice(0, LIMIT)}…[${raw.length}자에서 잘림])`;
  };
  const roster = result.files.map((entry) => `${flatten(entry.file)}=${entry.classification}${reasonOf(entry)}`).join(', ');
  const measurement = result.baselineDefaultBranchAncestry === 'not-ancestor'
    ? '; baseline-default-branch=not-ancestor (measurement baseline is not an ancestor of the default branch)'
    : result.baselineDefaultBranchAncestry
      ? `; baseline-default-branch=${result.baselineDefaultBranchAncestry}`
      : '';
  const head = `Verify-by-breaking: distinguishes=${counts.distinguishes}, does-not-distinguish=${counts['does-not-distinguish']}, unknown=${counts.unknown}, missing-at-base=${counts['missing-at-base']}${measurement}; files=[${roster}]; `;
  const line = `${head}${details}`;
  if (line.length <= VERIFY_BY_BREAKING_NOTE_LIMIT) return withReverse(line);
  const marker = ` [note truncated; originalChars=${line.length}; files=${result.files.length}]`;
  const room = Math.max(0, VERIFY_BY_BREAKING_NOTE_LIMIT - marker.length);
  if (head.length <= room) return withReverse(`${head}${details.slice(0, Math.max(0, room - head.length))}${marker}`);
  const entryOf = (entry: VerifyByBreakingFileResult): string => `${flatten(entry.file)}=${entry.classification}${reasonOf(entry)}`;
  const mustSee = result.files.filter((e) => e.classification !== 'distinguishes').map(entryOf);
  const rest = result.files.filter((e) => e.classification === 'distinguishes').map(entryOf);
  const names = [...mustSee, ...rest];
  const headOf = (keep: number): string => {
    const dropped = names.length - keep;
    return `Verify-by-breaking: distinguishes=${counts.distinguishes}, does-not-distinguish=${counts['does-not-distinguish']}, unknown=${counts.unknown}${measurement};`
      + ` files=[${names.slice(0, keep).join(', ')}]${dropped > 0 ? ` [+${dropped} files omitted]` : ''}`
      + ` [note truncated; originalChars=${line.length}]`;
  };
  for (let keep = names.length; keep >= 0; keep -= 1) {
    const candidate = headOf(keep);
    if (candidate.length <= VERIFY_BY_BREAKING_NOTE_LIMIT) return withReverse(candidate);
  }
  return withReverse(`Verify-by-breaking: [all ${names.length} files omitted — note limit ${VERIFY_BY_BREAKING_NOTE_LIMIT}]`);
}

const CHILD_EXEMPT_ATTRIBUTIONS = new Set<GateFailureAttribution>(['flaky-timeout', 'flaky-rerun', 'preexisting']);

export function canExemptChildForTimeoutFailures(failures: readonly GateTestFailure[]): boolean {
  if (failures.length === 0) return false;
  if (!failures.every((failure) => CHILD_EXEMPT_ATTRIBUTIONS.has(failure.attribution))) return false;
  if (failures.some((failure) => failure.timeoutVariability === 'same')) return false;
  return failures.some((failure) =>
    failure.attribution === 'flaky-rerun'
    || (failure.attribution === 'flaky-timeout' && failure.timeoutVariability === 'may-vary'));
}

export function decideGateChildResponsibility(
  baseline: Pick<BaselineProcessResult, 'childResponsibility'>,
  introduced: number,
  failures: readonly GateTestFailure[],
): 'none' | undefined {
  if (introduced > 0) return undefined;
  const hasRepeatedSameTimeout = failures.some((failure) => failure.timeoutVariability === 'same');
  if (!hasRepeatedSameTimeout && baseline.childResponsibility === 'none') return 'none';
  return canExemptChildForTimeoutFailures(failures) ? 'none' : undefined;
}

export function buildGateBaselineReport(
  worktreeLog: string,
  baseline: BaselineProcessResult,
  rerunObservations?: GateRerunObservations,
  rerunNotRun = 0,
): GateBaselineReport {
  let failures = classifyGateTestFailures(
    worktreeLog,
    baseline.status === 'unknown' ? undefined : (baseline.output ?? ''),
    baseline.missingAtBase ?? [],
    rerunObservations,
    baseline.passedTestEvidence,
  );
  const worktreeFailuresParsed = failures.length > 0;
  if (!worktreeFailuresParsed) {
    failures = [{ name: '(unparsed test failure)', file: undefined, attribution: 'unknown', baselinePresence: 'unknown' }];
  }
  const summary = summarizeGateBaseline(failures);
  const observationsFor = (name: string): readonly TimeoutRerunObservation[] => {
    if (!rerunObservations) return [];
    if (rerunObservations instanceof Map) return rerunObservations.get(name) ?? [];
    return (rerunObservations as Readonly<Record<string, readonly TimeoutRerunObservation[]>>)[name] ?? [];
  };
  const failureNames = [...new Set(failures.map((failure) => failure.name))];
  const rerunAttemptedNames = failureNames.filter((name) => observationsFor(name).length > 0);
  const timeoutVariabilityCounts = failures.reduce(
    (counts, failure) => {
      if (failure.attribution !== 'flaky-timeout') return counts;
      switch (failure.timeoutVariability ?? 'unknown') {
        case 'may-vary': counts.mayVary += 1; break;
        case 'same': counts.same += 1; break;
        case 'unknown': counts.unknown += 1; break;
      }
      return counts;
    },
    { mayVary: 0, same: 0, unknown: 0 },
  );
  const childResponsibility = decideGateChildResponsibility(baseline, summary.introduced, failures);
  return {
    ...summary,
    timeoutPassedAtBase: failures.filter((failure) => failure.timeoutRegression === 'passed-at-base').length,
    mayVaryNonTimeout: failures.filter((failure) => failure.attribution !== 'flaky-timeout' && failure.timeoutVariability === 'may-vary').length,
    rerunAttempted: rerunAttemptedNames.length,
    rerunRecovered: rerunAttemptedNames.filter((name) => observationsFor(name).includes('pass')).length,
    rerunNotRun,
    timeoutVariabilityCounts,
    ...(childResponsibility ? { childResponsibility } : {}),
    failures,
    worktreeFailuresParsed,
    files: [...new Set(failures.flatMap((failure) => failure.file ? [failure.file] : []))],
    baselineStatus: baseline.status,
    log: baseline.log,
  };
}

export function formatGateBaselineNote(report: GateBaselineReport, unrunImporterTotal: number, runId?: string): string {
  const includesBaselinePresence = report.missingAtBase > 0 || report.failures.some((failure) => failure.baselinePresence === 'unknown');
  const introduced = report.baselineStatus === 'unknown' ? 'uncomputed' : String(report.introduced);
  const unrunNote = unrunImporterTotal > 0 ? ` (unrun importer tests: ${unrunImporterTotal})` : '';
  const head = `[gate-baseline] introduced=${introduced}${unrunNote}, preexisting=${report.preexisting}`
    + `, unknown=${report.unknown}, precondition-unmet=${report.preconditionUnmet}`
    + (report.timedOut > 0 ? `, timed-out=${report.timedOut}` : '')
    + (report.flakyRerun > 0 ? `, flaky-rerun=${report.flakyRerun}` : '')
    + (runId ? `, run=${runId}` : '')
    + (report.missingAtBase > 0 ? `, missing-at-base=${report.missingAtBase}` : '');
  const lines = report.failures.map((failure) => `- ${failure.attribution}: ${failure.name}`
    + (includesBaselinePresence ? ` [baseline=${failure.baselinePresence}]` : '')
    + (failure.precondition ? ` (${failure.precondition.name}; ${failure.precondition.remediation})` : ''));
  const timedOutFailures = report.failures.filter((failure) => failure.attribution === 'flaky-timeout');
  const { mayVary, same, unknown } = report.timeoutVariabilityCounts;
  const timedOutLine = timedOutFailures.length > 0
    ? `\n[gate-baseline] timed-out=${timedOutFailures.length} (may-vary=${mayVary}, same=${same}, unknown=${unknown}; ⚠ 회귀 아님 — 실행마다 다름${report.childResponsibility === 'none' ? ' · 자식이 고칠 수 없음' : ''}): ${timedOutFailures.map((failure) => failure.name).join(', ')}`
    : '';
  const mayVaryNonTimeoutFailures = report.failures.filter((failure) => failure.attribution !== 'flaky-timeout' && failure.timeoutVariability === 'may-vary');
  const mayVaryNonTimeoutLine = report.mayVaryNonTimeout > 0
    ? `\n[gate-baseline] may-vary-non-timeout=${report.mayVaryNonTimeout}: ${mayVaryNonTimeoutFailures.map((failure) => failure.name).join(', ')}`
    : '';
  const rerunLine = report.rerunAttempted > 0
    ? `\n[gate-baseline] rerun attempted=${report.rerunAttempted} recovered=${report.rerunRecovered} not-run=${report.rerunNotRun}`
    : report.rerunNotRun > 0
      ? `\n[gate-baseline] rerun not-run=${report.rerunNotRun}`
      : '';
  return `${head}\n${lines.join('\n')}\n${report.log}`
    + timedOutLine
    + mayVaryNonTimeoutLine
    + rerunLine
    + (report.preexisting > 0 ? '\n⚠️ preexisting 실패는 base에서도 재현됨 — 이 PR의 책임이 아니다.' : '');
}

export function formatVerifyByBreakingSkipNote(reason: string, report?: GateBaselineReport): string {
  const responsibility = report?.introduced === 0 ? '; child-responsibility=none' : '';
  return `Verify-by-breaking: skipped; reason=${reason}${responsibility}`;
}

export function formatVerifyByBreakingScopeSkipNote(reason: string, changedFiles: readonly string[]): string {
  return `${formatVerifyByBreakingSkipNote(reason)}; evaluated-changes=[${changedFiles.join(', ')}]; test-step=scope-skipped`;
}

export function allowsBaselineOnlyFailure(report: GateBaselineReport): boolean {
  if (report.baselineStatus === 'unknown') return false;
  if (!report.worktreeFailuresParsed) return false;
  return report.introduced === 0 && report.preconditionUnmet === 0 && report.timedOut === 0 && report.flakyRerun === 0;
}
