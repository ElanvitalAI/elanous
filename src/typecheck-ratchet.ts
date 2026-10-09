import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TYPECHECK_GATE_CONFIG = 'tsconfig.gate.json';

/**
 * ⛔⭐ tsc 에 «명시» 힙을 준다 (ci-typecheck-changed · 하니스 seams · seam-wiring-check 가 같이 쓴다) — V8 기본(≈4GB)은 이 저장소에 이미 모자란다.
 *   🩸 2026-09-23: 🅢·🅕·🅣 세 창이 같은 날 `heap out of memory` 로 착지가 막혔다. 📏 통과한 판의 최대 RSS **5.0GB**
 *   (128GB 기계 · 부하와 무관하게 재현 — 🅕 「로드 ~7 로 내려간 뒤에도 났다」). 우회 12288 로 🅢 착지 19건 PASS.
 *   ⇒ 부하 탓이 아니라 «자란 프로젝트»다. 값을 사람이 기억해 붙이는 우회를 도구가 스스로 갖는다.
 *   🩸 2026-10-08: 12288 로도 호스트 재게이트·`pr land` 가 OOM 으로 «못 잼»(#25177 · #25248 · TC 수확 4건 — 전부 20480 에서 PASS) → 20480.
 * ⚠️ 호출자가 이미 `--max-old-space-size` 를 줬으면 «그것을» 존중한다(덮지 않는다).
 */
export const TSC_HEAP_MB = 20480;
export function tscEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cur = base.NODE_OPTIONS ?? '';
  if (/--max-old-space-size[= ]/.test(cur)) return base;
  return { ...base, NODE_OPTIONS: `${cur} --max-old-space-size=${TSC_HEAP_MB}`.trim() };
}

/** Declarative rulers consulted when deciding whether typecheck work is complete; this does not alter gate execution. */
export const TYPECHECK_COMPLETION_RULERS = [
  { name: 'root TypeScript project', config: 'tsconfig.json' },
  { name: 'changed-file typecheck gate', config: TYPECHECK_GATE_CONFIG },
  // PWA is excluded from the root gate scope and remains separately observed, not newly gated here.
  { name: 'PWA workspace', config: 'apps/pwa/tsconfig.json' },
] as const;

export const TEST_TYPECHECK_BASELINE = 'test-typecheck-baseline.txt';

export interface TypecheckError {
  file: string;
  line: string;
  /** TypeScript diagnostic code when produced by parseTypecheckErrors. */
  code?: string;
}

export interface FieldWiringClassification {
  field: string;
  injectionSites: { test: number; nonTest: number };
  readSites: { test: number; nonTest: number };
  status: 'unwired' | 'unread' | 'wired';
}

export interface TypecheckOutsideChangedFile {
  file: string;
  count: number;
}

export interface TypecheckRatchetResult {
  failing: TypecheckError[];
  exempted: TypecheckError[];
  /** Diagnostics dropped solely because the file is outside `changedFiles`, aggregated by file. Baseline-registered files are excluded. */
  outsideChanged: TypecheckOutsideChangedFile[];
}

export interface TypecheckDiagnosticDiff {
  added: TypecheckError[];
  existing: TypecheckError[];
  removed: TypecheckError[];
}

/** Raw result from either changed-file tsc caller. */
export interface TypecheckExecutionResult {
  out: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
  durationMs: number;
}

export interface TypecheckExecutionAssessment {
  executed: boolean;
  diagnostics: TypecheckError[];
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: unknown;
  durationMs: number;
  failureLog: string;
}

export type TypecheckNoInspectionReason = 'no-typecheckable-changed-files' | 'missing-typecheck-gate-config' | 'no-typescript-config';

export interface MissingTypecheckGateConfig {
  config: typeof TYPECHECK_GATE_CONFIG;
  path: string;
}

export const TYPECHECK_PROJECT_CONFIG = 'tsconfig.json';

export interface ResolvedTypecheckConfig {
  config: typeof TYPECHECK_GATE_CONFIG | typeof TYPECHECK_PROJECT_CONFIG;
  path: string;
}

/** Picks the typecheck config for a work tree: tsconfig.gate.json, else tsconfig.json, else none. */
export function resolveTypecheckConfig(cwd: string): ResolvedTypecheckConfig | null {
  const gatePath = join(cwd, TYPECHECK_GATE_CONFIG);
  if (existsSync(gatePath)) return { config: TYPECHECK_GATE_CONFIG, path: gatePath };
  const projectPath = join(cwd, TYPECHECK_PROJECT_CONFIG);
  if (existsSync(projectPath)) return { config: TYPECHECK_PROJECT_CONFIG, path: projectPath };
  return null;
}

/** Identifies the repository-specific changed-file gate configuration before invoking its compiler. */
export function missingTypecheckGateConfig(cwd: string): MissingTypecheckGateConfig | null {
  const path = join(cwd, TYPECHECK_GATE_CONFIG);
  return existsSync(path) ? null : { config: TYPECHECK_GATE_CONFIG, path };
}

export type TypecheckCompletionRuler = (typeof TYPECHECK_COMPLETION_RULERS)[number];
export type TypecheckCompletionRulerStatus = 'clean' | 'diagnostics' | 'unavailable';
export type TypecheckCompletionStatus = TypecheckCompletionRulerStatus;

export interface TypecheckCompletionRulerResult {
  ruler: TypecheckCompletionRuler;
  status: TypecheckCompletionRulerStatus;
  assessment: TypecheckExecutionAssessment;
}

export interface TypecheckCompletionJudgment {
  status: TypecheckCompletionStatus;
  clean: boolean;
  rulers: TypecheckCompletionRulerResult[];
}

export type TypecheckCompletionExecutor = (config: string) => TypecheckExecutionResult;

export function normalizeTypecheckPath(file: string): string {
  return file.replace(/^\.\//, '').trim();
}

export function parseTypecheckErrors(output: string): TypecheckError[] {
  const errors: TypecheckError[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?\.[cm]?tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):/);
    if (match) errors.push({ file: normalizeTypecheckPath(match[1]!), line: line.trimEnd(), code: match[4]! });
  }
  return errors;
}

/** Returns whether a diagnostic belongs to either repository test-path convention. */
export function isTypecheckTestFile(file: string): boolean {
  const normalized = normalizeTypecheckPath(file);
  return normalized.startsWith('test/') || /\.test\.tsx?$/.test(normalized);
}

/**
 * Counts deletion-run TS2353 and never-substitution-run TS2345 field injections, plus
 * deletion-run TS2339 field reads, by test versus non-test source. The optional second
 * diagnostic list preserves the existing single-list call shape.
 * This only detects zero versus nonzero wiring; it cannot detect partial wiring when some
 * of multiple injection sites still omit the field.
 */
export function classifyFieldWiring(
  field: string,
  deletionErrors: readonly TypecheckError[],
  neverSubstitutionErrors: readonly TypecheckError[] = [],
): FieldWiringClassification {
  const injectionSites = { test: 0, nonTest: 0 };
  const readSites = { test: 0, nonTest: 0 };
  const injectionSiteKeys = new Set<string>();
  const countSites = (
    errors: readonly TypecheckError[],
    code: string,
    sites: typeof injectionSites,
    deduplicate?: Set<string>,
  ): void => {
    for (const error of errors) {
      const namesField = code === 'TS2345' ? error.line.includes(field) : error.line.includes(`'${field}'`);
      const location = error.line.match(/^.+?\(\d+,\d+\)/)?.[0] ?? error.line;
      const siteKey = `${error.file}:${location}`;
      if (error.code === code && namesField && (!deduplicate || !deduplicate.has(siteKey))) {
        deduplicate?.add(siteKey);
        sites[isTypecheckTestFile(error.file) ? 'test' : 'nonTest'] += 1;
      }
    }
  };
  countSites(deletionErrors, 'TS2353', injectionSites, injectionSiteKeys);
  countSites(neverSubstitutionErrors, 'TS2345', injectionSites, injectionSiteKeys);
  countSites(deletionErrors, 'TS2339', readSites);
  const status = injectionSites.nonTest === 0
    ? 'unwired'
    : readSites.nonTest === 0
      ? 'unread'
      : 'wired';
  return { field, injectionSites, readSites, status };
}

/** Shared by the self-implement and CI changed-file gates so an unmeasured tsc run cannot be green. */
export function assessTypecheckExecution(execution: TypecheckExecutionResult): TypecheckExecutionAssessment {
  const diagnostics = parseTypecheckErrors(execution.out);
  const executed = !execution.error
    && !execution.signal
    && (execution.status === 0 || (execution.status !== null && execution.status !== 0 && diagnostics.length > 0));
  // ⛔ `error`(spawn 자체 실패 — ENOENT 등)는 **가장 진단적인 경우**라 로그에 담는다.
  //    리뷰 지적(2026-07-30): 반환만 하고 아무도 안 쓰면 죽은 표면이다. ⇒ 지우지 않고 **소비**한다.
  // ⛔ 한 줄 로그 계약(골 요구) — `error.message` 에 개행이 있으면 여러 줄이 된다. 정규화한다.
  //    리뷰 should-fix(2026-07-30 3차). 공백 압축까지 하지 않는 이유: 원문 식별성을 남긴다.
  const rawError = execution.error instanceof Error
    ? execution.error.message
    : execution.error === undefined ? 'none' : String(execution.error);
  const errorText = rawError.replace(/\r?\n/g, ' ⏎ ');
  const failureLog = executed
    ? ''
    : `[tsc: 타입 검사 실행 실패 (status=${execution.status ?? 'null'}, signal=${execution.signal ?? 'none'}, error=${errorText}, durationMs=${execution.durationMs}) — tsc 설정·실행 파일·시간 제한을 확인한 뒤 다시 실행하라.]`;
  return { ...execution, executed, diagnostics, failureLog };
}

/** Maps one completed or unavailable tsc execution into a completion-ruler result. */
export function assessTypecheckCompletionRuler(
  ruler: TypecheckCompletionRuler,
  execution: TypecheckExecutionResult,
): TypecheckCompletionRulerResult {
  const assessment = assessTypecheckExecution(execution);
  const status: TypecheckCompletionRulerStatus = !assessment.executed
    ? 'unavailable'
    : assessment.diagnostics.length > 0 ? 'diagnostics' : 'clean';
  return { ruler, status, assessment };
}

/** Reduces the exact declared ruler sequence; unavailable takes precedence over diagnostics, then clean. */
export function judgeTypecheckCompletion(
  rulers: readonly TypecheckCompletionRulerResult[],
): TypecheckCompletionJudgment {
  const completeRulerSet = rulers.length === TYPECHECK_COMPLETION_RULERS.length
    && rulers.every((result, index) => result.ruler === TYPECHECK_COMPLETION_RULERS[index]);
  const status: TypecheckCompletionStatus = !completeRulerSet || rulers.some((ruler) => ruler.status === 'unavailable')
    ? 'unavailable'
    : rulers.some((ruler) => ruler.status === 'diagnostics') ? 'diagnostics' : 'clean';
  return { status, clean: status === 'clean', rulers: [...rulers] };
}

/** Collects only the declarative completion rulers; it is observational and does not alter gate execution. */
export function collectTypecheckCompletion(execute: TypecheckCompletionExecutor): TypecheckCompletionJudgment {
  const rulers = TYPECHECK_COMPLETION_RULERS.map((ruler) => {
    try {
      return assessTypecheckCompletionRuler(ruler, execute(ruler.config));
    } catch (error) {
      return assessTypecheckCompletionRuler(ruler, {
        out: '', status: null, signal: null, error, durationMs: 0,
      });
    }
  });
  return judgeTypecheckCompletion(rulers);
}

/**
 * Exempts only each test file's recorded diagnostic count. Counts deliberately ignore
 * line numbers: unrelated edits move locations, while an added diagnostic increases the
 * count and must fail. Source and script errors remain touch-clean failures.
 */
/** 기준선 예외를 받을 수 있는 «테스트 파일»인가.
 *
 *  ⛔ 2026-08-14 — 종전엔 `test/` 와 `apps/pwa/test/` 만 인정했다. 그런데 실제 PWA 테스트는
 *  `apps/pwa/src/**` 아래에 산다(실측: subject-list 17 · control-signals-api 2 · chat-runtime 2).
 *  게이트가 `apps/pwa` 를 보게 된 뒤(#8784) 그 파일을 «한 글자만» 건드려도 남의 기존 오류로 막혔다.
 *  ⭐ 그래서 `apps/pwa/src` 아래는 «파일 이름이 테스트임을 드러낼 때만» 인정한다 —
 *     제품 코드는 어떤 경우에도 예외를 못 받는다(그러면 회귀가 조용히 통과한다). */
export function isBaselineExemptTestFile(file: string): boolean {
  if (file.startsWith('test/') || file.startsWith('apps/pwa/test/')) return true;
  if (!file.startsWith('apps/pwa/src/')) return false;
  return /\.(test|spec)\.tsx?$/.test(file);
}

/**
 * Separates diagnostics introduced after a baseline from diagnostics already in it.
 * File identity, diagnostic code, and message form the key; locations are intentionally
 * excluded because unrelated edits move a diagnostic without making it new. Multiplicity
 * is preserved so a duplicate newly introduced diagnostic still fails.
 */
export function diffTypecheckDiagnostics(current: readonly TypecheckError[], baseline: readonly TypecheckError[]): TypecheckDiagnosticDiff {
  const diagnosticMessage = (error: TypecheckError) => {
    const match = error.line.match(/^.+?\(\d+,\d+\):\s+error\s+TS\d+:\s+([\s\S]*)$/);
    return match?.[1] ?? error.line;
  };
  const key = (error: TypecheckError) => JSON.stringify([normalizeTypecheckPath(error.file), error.code ?? '', diagnosticMessage(error)]);
  const remainingBaseline = new Map<string, number>();
  const remainingCurrent = new Map<string, number>();
  for (const error of baseline) {
    const diagnosticKey = key(error);
    remainingBaseline.set(diagnosticKey, (remainingBaseline.get(diagnosticKey) ?? 0) + 1);
  }
  for (const error of current) {
    const diagnosticKey = key(error);
    remainingCurrent.set(diagnosticKey, (remainingCurrent.get(diagnosticKey) ?? 0) + 1);
  }
  const added: TypecheckError[] = [];
  const existing: TypecheckError[] = [];
  for (const error of current) {
    const diagnosticKey = key(error);
    const count = remainingBaseline.get(diagnosticKey) ?? 0;
    if (count > 0) {
      existing.push(error);
      remainingBaseline.set(diagnosticKey, count - 1);
    } else added.push(error);
  }
  const removed: TypecheckError[] = [];
  for (const error of baseline) {
    const diagnosticKey = key(error);
    const count = remainingCurrent.get(diagnosticKey) ?? 0;
    if (count > 0) remainingCurrent.set(diagnosticKey, count - 1);
    else removed.push(error);
  }
  return { added, existing, removed };
}

/** Selects newly diagnosed consumers outside the changed-file set for a project scope. */
export function promotedConsumersFromDiff(
  diff: TypecheckDiagnosticDiff,
  changed: ReadonlySet<string>,
  include: (file: string) => boolean,
): Set<string> {
  const promoted = new Set<string>();
  const normalizedChanged = new Set([...changed].map(normalizeTypecheckPath));
  for (const error of diff.added) {
    const file = normalizeTypecheckPath(error.file);
    if (!normalizedChanged.has(file) && include(file)) promoted.add(file);
  }
  return promoted;
}

export function classifyTypecheckErrors(
  errors: readonly TypecheckError[],
  changedFiles: ReadonlySet<string>,
  testBaseline: ReadonlyMap<string, number>,
): TypecheckRatchetResult {
  const failing: TypecheckError[] = [];
  const exempted: TypecheckError[] = [];
  const outsideCounts = new Map<string, number>();
  const remaining = new Map(testBaseline);
  for (const error of errors) {
    const file = normalizeTypecheckPath(error.file);
    if (!changedFiles.has(file)) {
      if (!testBaseline.has(file)) outsideCounts.set(file, (outsideCounts.get(file) ?? 0) + 1);
      continue;
    }
    const allowed = remaining.get(file) ?? 0;
    if (isBaselineExemptTestFile(file) && allowed > 0) {
      exempted.push(error);
      remaining.set(file, allowed - 1);
    } else {
      failing.push(error);
    }
  }
  const outsideChanged = [...outsideCounts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((left, right) => left.file.localeCompare(right.file));
  return { failing, exempted, outsideChanged };
}

/** Reads `test path<TAB>diagnostic count` entries generated by the explicit baseline script. */
export function readTestTypecheckBaseline(cwd: string): Map<string, number> {
  const path = join(cwd, TEST_TYPECHECK_BASELINE);
  if (!existsSync(path)) return new Map();
  const baseline = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [rawFile, rawCount, extra] = line.split('\t');
    const file = normalizeTypecheckPath(rawFile ?? '');
    // ⛔ `Number('')` 과 `Number('   ')` 은 **0** 이다 — 빈 count 를 "0건 면제" 로 받으면
    //    그 파일이 조용히 래칫 대상이 되고 **기존 부채가 갑자기 실패로 바뀐다**(리뷰 must-fix).
    //    ⇒ 원문이 **명시적 정수 문자열**인지 먼저 본다.
    const countText = (rawCount ?? '').trim();
    const count = Number(countText);
    const countIsExplicitInteger = /^\d+$/.test(countText);
    if (!file || extra !== undefined || !countIsExplicitInteger || !Number.isInteger(count) || count < 0) {
      throw new Error(`[tsc-ratchet] invalid baseline entry: ${line}`);
    }
    baseline.set(file, count);
  }
  return baseline;
}
