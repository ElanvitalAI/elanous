import { classifyObservation } from '../design/behaviour-signal.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { groundMissionInCodebase, isRepositoryImplementationCandidate, type CodebaseGrounding } from '../autopilot/mission-codebase-gate.js';
import { extractSlugSource, generateMissionSlug, slugify } from '../autopilot/mission-registry.js';
import { enhancePrompt, type EnhanceOpts, type EnhanceResult } from '../prompt-enhance/enhance.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import { debug } from '../debug/log.js';

function observeGoalAuthor(
  category: 'goal-author' | 'goal-author.clarify',
  event: string,
  data: unknown,
): void {
  debug.log(category, event, data);
  debug.log(category === 'goal-author' ? 'harness.author' : 'harness.author.clarify', event, data);
}
import { getUserConfig } from '../user-config.js';

export type GoalAuthorGrade = 'full' | 'lite';
export type GoalAuthorGradeSource = 'flag' | 'env' | 'config' | 'default';
export interface GoalAuthorGradeSelection { grade: GoalAuthorGrade; source: GoalAuthorGradeSource }

/**
 * Precedence flag > env (`ELANOUS_AUTHOR_GRADE`) > config > default(full). Malformed env or
 * configuration values are ignored and keep the full pipeline. The env seam lets the Pod carry the
 * grade without a CLI flag an older in-Pod elanous would reject (AUTHOR-LITE2-POD).
 */
export function resolveGoalAuthorGrade(flag?: GoalAuthorGrade, configured?: unknown, env: unknown = process.env.ELANOUS_AUTHOR_GRADE): GoalAuthorGradeSelection {
  if (flag !== undefined) return { grade: flag, source: 'flag' };
  if (env === 'lite' || env === 'full') return { grade: env, source: 'env' };
  if (configured === 'lite' || configured === 'full') return { grade: configured, source: 'config' };
  return { grade: 'full', source: 'default' };
}
import type { ObserveOnlySource } from './observe-only.js';
import type { Question } from '../ask-user-question/types.js';
import { requestTestScenario as defaultRequestTestScenario, type TestScenarioRequestInput, type TestScenarioRequestResult } from './test-scenario-request.js';
import { resolveGoalAuthorClarification, parseGoalDocumentClarifications, serializeGoalAuthorParent, type GoalAuthorClarificationResponse, type GoalAuthorParent, type GoalAuthorSelfResolution } from './goal-author-clarification.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { createRepositoryReferencedFileReader, type ReferencedFileReadResult } from './goal-file-reader.js';
import { extractGoalDocSections, type GoalDocSourceLine } from './goal-doc/section.js';
import { isGoalAuthorFileName } from './goal-document.js';
import { resolveGoalDocumentsDir } from './goal-documents-dir.js';
import { REQUIRED_EVIDENCE_COMMAND_SEPARATOR } from './off-diff-evidence.js';
import { renderLaunchPreflight, siblingTestPath, type LaunchPreflightResult } from '../self-dev/launch-preflight.js';
import { quoteShellArg } from '../cli/logs-cli.js';
import type { HarnessGroundingProvenance } from './context-capsule.js';
import { hasGoalStepCodeName } from './goal-step-code-name.js';
import { targetScopedGoalText } from './goal-text-path-scope.js';
import { parseReleaseNoteSection } from '../release-loop/release-note.js';

// ⭐ `situation`/`complication` 은 **선택**이다 — 안 오면 `scqaNarrative` 가 종전 문면을 쓴다.
//   ⛔ 필수로 만들지 않는다: 그러면 인핸싱이 폴백으로 떨어진 저작(LLM 실패·`disabled`)이 전부 죽는다.
type GoalEnhancement = Omit<Pick<EnhanceResult, 'original' | 'checklist' | 'verbatimPreserved' | 'situation' | 'complication' | 'decisionSignal'>, 'decisionSignal'> & {
  decisionSignal?: EnhanceResult['decisionSignal'] & { numericSource?: string; numericCoverage?: string };
  enhancedBy?: EnhanceResult['enhancedBy'];
};

export interface GoalAuthorDeps {
  ground: (ask: string, groundingDeps?: GoalAuthorGroundingDeps) => Promise<CodebaseGrounding>;
  persistentGrounding?: GoalAuthorGroundingDeps;
  authorGrade?: GoalAuthorGradeSelection;
  enhance: (ask: string, opts?: EnhanceOpts) => Promise<GoalEnhancement>;
  /** Additive enhancer options supplied by the file-writing entrypoint. */
  enhanceOpts?: EnhanceOpts;
  /** Repository root used to distinguish safe new target files from unmatched candidates. */
  repositoryRoot?: string;
  /** Answers keyed by the clarification IDs rendered into the authored goal. */
  clarificationAnswers?: Readonly<Record<string, string | undefined>>;
  /** Elanousic answer author used only during this authoring run; omitted keeps tests and callers offline. */
  selfResolveClarification?: (context: import('./goal-author-clarification.js').GoalAuthorSelfResolutionContext) => Promise<GoalAuthorSelfResolution>;
  /** 검증 시나리오 «의뢰» 심. 기본은 test-scenario-request 의 순수 생성기다(RFC T3). */
  requestTestScenario?: (input: TestScenarioRequestInput) => TestScenarioRequestResult;
  /** Originating goal document and unresolved clarification ID, supplied together or omitted together. */
  parent?: GoalAuthorParent;
  /** Source document paired with `parent` when a child goal is authored. */
  parentDocument?: string;
  /** Root purpose for a new root or a legacy parent that predates RootIntent metadata. */
  rootIntent?: string;
  /** Explicit document title; the ask remains verbatim provenance and is never wrapped to provide a title. */
  goalTitle?: string;
  /** Required-section profile written into the authored goal; omitted means implement. */
  goalType?: GoalType;
  /** Stable identity inherited by an explicitly declared superseding revision. */
  goalId?: string;
  /**
   * Repository-relative ask-file path written as the lineage key beside GoalId.
   * Omitted means the header has no AskFile line (inline asks stay unchanged).
   */
  askFile?: string;
  /** Goal filename's English-summary slug seam; defaults to the mission-id generator. */
  slugFn?: (goal: string) => Promise<string>;
  /** Repository-bounded reader used to expose ask-mentioned symbol signatures in Complication. */
  readSourceFile?: (repositoryRelativePath: string) => string | null | ReferencedFileReadResult;
  /** Optional read-only argv executor for validated inline `bun bin/elanous.mjs … --help` capability probes. */
  runHelpProbe?: (argv: readonly string[]) => GoalCommandExecutionResult | Promise<GoalCommandExecutionResult>;
  /** Bounded additive evidence rendered in PROBLEM; never changes the verbatim ask. */
  groundingEvidence?: readonly string[];
  /** Optional externally decomposed plan steps rendered verbatim into the authored goal; the author never generates them. */
  steps?: readonly string[];
  /** Optional injected decomposition seam; omitted means authoring never invokes an LLM or decomposition. */
  decomposeSteps?: (objective: string, opts?: { context?: string; runId?: string }) => Promise<readonly string[]>;
  /** Optional launch preflight result supplied by the caller; authoring never reads the ledger or logs itself. */
  launchPreflight?: LaunchPreflightResult;
  /** Optional in-process notification for each authored-goal phase transition. */
  onProgress?: (phase: GoalAuthorPhase, event: 'start' | 'end') => void;
}

export type GoalAuthorGroundingPath = 'groundMissionInCodebase';

export interface GoalAuthorGroundingDeps {
  /** Omit to preserve persistent grounding; false makes the authoring experiment opt out. */
  persistent?: false;
  groundMission?: (ask: string, deps: { cwd: string; seedPaths?: readonly string[]; persistent?: false }) => Promise<CodebaseGrounding>;
}

export interface GoalAuthorGroundingResult {
  path: GoalAuthorGroundingPath;
  facts: CodebaseGrounding;
}

export interface GoalAuthorPersistentGroundingDecision {
  readonly enabled: boolean;
  readonly source: ObserveOnlySource;
  readonly authorRunId?: string;
  readonly grounded?: boolean;
  readonly groundingError?: boolean;
  readonly fileCount?: number;
  readonly persistentEvidenceCount?: number;
  readonly contextChars?: number;
  readonly persistentStopReason?: string;
  readonly codeChannel?: CodebaseGrounding['codeChannel'];
  /** ⭐ 접지가 «어떤 종류»의 파일을 봤나 — 확장자별 수(`{'.ts': 12, '.kt': 5}`).
   *  ⛔ 경로 «배열»을 남기지 않는다: 이 저장소의 debug.log 는 배열을 6에서 잘라 `{_more:N}` 을
   *  붙이므로 ***분모가 깨진다***. 히스토그램은 안 잘리고 「무슨 종류를 봤나」에 그대로 답한다. */
  readonly fileKinds?: Readonly<Record<string, number>>;
}

type GoalAuthorPersistentGroundingMetrics = Pick<GoalAuthorPersistentGroundingDecision,
  'authorRunId' | 'grounded' | 'groundingError' | 'fileCount' | 'persistentEvidenceCount' | 'contextChars' | 'persistentStopReason' | 'codeChannel' | 'fileKinds'
>;

type GoalAuthorPersistentGroundingConfigReader = () => boolean | undefined;
type GoalAuthorGroundingObserver = (decision: GoalAuthorPersistentGroundingDecision) => void;

/**
 * 🚨 **접지가 «어떤 종류»의 파일을 봤나** (2026-09-07 · `OBS-T417` 의 「재는 명령 ②」를 답하려고 넣었다).
 *
 * ⛔ 왜 필요했나: `apps/` 골이 `persistentEvidenceCount: 0` 으로 끝나는 일이 잦은데
 *    (실측 09-05~07: `apps/` **64%** ↔ `src/` 15%), ***「그럼 접지가 Kotlin 을 읽기는 했나」***를
 *    원장으로 «답할 수가 없었다» — 파일 목록을 아무도 안 남겼기 때문이다.
 *    ⇒ 그래서 `OBS-T417` 은 「Kotlin 을 안 본다」를 ***추측으로*** 남겨야 했다.
 *
 * ⛔ 경로 «배열»이 아니라 히스토그램인 이유: 이 저장소의 `debug.log` 는 배열을 **6에서 자르고**
 *    `{_more:N}` 을 붙인다 ⇒ 배열 length 를 분모로 쓰면 틀린다. 히스토그램은 잘리지 않는다.
 * ⚠️ 확장자가 «없는» 파일도 버리지 않는다 — 버리면 합이 `fileCount` 와 안 맞고,
 *    그러면 이 값으로 분모를 만들 수 없다.
 */
export function summarizeGroundingFileKinds(files: readonly string[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const file of files) {
    const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    const dot = file.lastIndexOf('.');
    const kind = dot > slash + 1 ? file.slice(dot).toLowerCase() : '(no extension)';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

function readGoalAuthorPersistentGroundingConfig(): boolean | undefined {
  return getUserConfig().tools?.selfImplement?.goalAuthorPersistentGrounding;
}

function observeGoalAuthorPersistentGrounding(decision: GoalAuthorPersistentGroundingDecision): void {
  try {
    observeGoalAuthor('goal-author', 'persistent-grounding-decision', decision);
  } catch { /* observation is fail-soft */ }
}

function goalAuthorPersistentGroundingMetrics(
  facts: CodebaseGrounding | null,
  groundingError: boolean,
  authorRunId: string,
): GoalAuthorPersistentGroundingMetrics {
  return {
    authorRunId,
    grounded: facts?.grounded ?? false,
    groundingError,
    fileCount: facts?.files.length ?? 0,
    fileKinds: summarizeGroundingFileKinds(facts?.files ?? []),
    persistentEvidenceCount: facts?.persistentEvidence?.length ?? 0,
    contextChars: facts?.context.length ?? 0,
    ...(facts?.persistentStopReason === undefined ? {} : { persistentStopReason: facts.persistentStopReason }),
    ...(facts?.codeChannel === undefined ? {} : { codeChannel: facts.codeChannel }),
  };
}

let goalAuthorPersistentGroundingConfigReader: GoalAuthorPersistentGroundingConfigReader = readGoalAuthorPersistentGroundingConfig;
let goalAuthorGroundingObserver: GoalAuthorGroundingObserver = observeGoalAuthorPersistentGrounding;

function observeGoalAuthorPersistentGroundingResult(
  decision: GoalAuthorPersistentGroundingDecision,
  metrics: GoalAuthorPersistentGroundingMetrics,
): void {
  goalAuthorGroundingObserver({ ...decision, ...metrics });
}

export function resolveGoalAuthorPersistentGrounding(
  direct?: GoalAuthorGroundingDeps,
): { decision: GoalAuthorPersistentGroundingDecision; deps: GoalAuthorGroundingDeps } {
  const decision = direct?.persistent === false
    ? { enabled: false, source: 'flag' as const }
    : goalAuthorPersistentGroundingConfigReader() === false
      ? { enabled: false, source: 'config' as const }
      : { enabled: true, source: 'default' as const };
  goalAuthorGroundingObserver(decision);
  return { decision, deps: decision.enabled ? (direct ?? {}) : { ...direct, persistent: false } };
}

export function _setGoalAuthorPersistentGroundingDepsForTesting(
  configReader?: GoalAuthorPersistentGroundingConfigReader,
  observer?: GoalAuthorGroundingObserver,
): void {
  goalAuthorPersistentGroundingConfigReader = configReader ?? readGoalAuthorPersistentGroundingConfig;
  goalAuthorGroundingObserver = observer ?? observeGoalAuthorPersistentGrounding;
}

const MAX_COLLISION_RETRIES = 50;
const SUPERSESSION_LOCK_STALE_MS = 30_000;
const GOAL_AUTHOR_HELP_PROBE_TIMEOUT_MS = 3_000;
const GOAL_AUTHOR_HELP_PROBE_STDERR_MAX_CHARS = 4_000;
export const EVIDENCE_LOCATION_REQUIREMENT = 'For every acceptance criterion, state where evidence that it was met appears in the diff or which line of the report shows it. Evidence visible only on an execution screen and left in neither the diff nor the report is not evidence.';
export const REQUIRED_BLOCKS = ['## PROBLEM', '## WHAT TO BUILD', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE', '## TRACED PATHS', '## SCOPE BOUNDARY', '## 답하지 못하는 것', '## 불변식', '## 판정 신호'] as const;
export const ERROR_REQUIRED_BLOCKS = new Set<string>(['## PROBLEM', '## ACCEPTANCE CRITERIA', '## REQUIRED EVIDENCE']);

/** `STEPS` is injected after WHAT TO BUILD, never generated by the author. */
function canonicalGoalHeadings(requiredBlocks: readonly string[], hasSteps: boolean): string[] {
  return hasSteps
    ? [...requiredBlocks.slice(0, 2), '## STEPS', ...requiredBlocks.slice(2)]
    : [...requiredBlocks];
}
export const GOAL_TYPES = ['implement', 'research', 'document', 'operate'] as const;
export type GoalType = typeof GOAL_TYPES[number];

const NON_IMPLEMENT_REQUIRED_BLOCKS = REQUIRED_BLOCKS.filter((block) => block !== '## TRACED PATHS');

export function requiredBlocksForGoalType(goalType: GoalType): readonly string[] {
  return goalType === 'implement' ? REQUIRED_BLOCKS : NON_IMPLEMENT_REQUIRED_BLOCKS;
}

/** Renders the canonical goal-section skeleton directly from the lint contract. */
export function formatGoalTemplate(goalType: GoalType = 'implement'): string {
  return requiredBlocksForGoalType(goalType)
    .map((block) => `${ERROR_REQUIRED_BLOCKS.has(block) ? 'ERROR' : 'WARN'} ${block}`)
    .join('\n');
}
const GOAL_ID_LINE = /^- GoalId:\s*([0-9a-f]{16})\s*$/;
const ROOT_INTENT_LINE = /^- RootIntent:[ \t]*(.*)$/;
const GOAL_TYPE_LINE = /^- GoalType:[ \t]*(.*)$/;
const ASK_FILE_LINE = /^- AskFile:[ \t]*(.*)$/;

export function parseGoalType(document: string): GoalType | null {
  const values = leadingGoalMetadata(document)
    .map((line) => GOAL_TYPE_LINE.exec(line)?.[1].trim())
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) return 'implement';
  if (values.length !== 1 || !GOAL_TYPES.includes(values[0] as GoalType)) return null;
  return values[0] as GoalType;
}
/** ask 가 골 종류를 «어떻게» 다뤘나 — 원장에 실리는 축.
 *
 *  ⛔⭐ 원장의 `goalTypeSource` 로는 이것을 «못 가른다». 그 축은 저작된 GOAL 문서를 읽는데
 *    저작기가 «언제나» `- GoalType:` 줄을 써서 항상 `declared` 가 된다
 *    (2026-09-08 실측: 표본 7건 «전부» declared · 다른 값 0 ⇒ 그 축은 이 질문에 퇴화했다).
 *
 *  ⛔ 「안 썼다」와 「잘못 썼다」를 접지 않는다 — 처방이 다르다(앞은 「쓰라」, 뒤는 「고치라」). */
export type AskGoalTypeDeclaration = GoalType | 'absent' | 'malformed';

export function askGoalTypeDeclaration(ask: string): AskGoalTypeDeclaration {
  const declared = declaredGoalType(ask);
  if (declared !== null) return declared;
  return leadingGoalMetadata(ask).some((line) => GOAL_TYPE_LINE.test(line)) ? 'malformed' : 'absent';
}

/** ask·골 문서가 골 종류를 «선언했나» — `parseGoalType` 과 «다른 질문»이다.
 *  ⛔ `parseGoalType` 은 선언이 없으면 `implement` 를 낸다(정식 기본값). 그래서 그것으로는
 *    「선언했다」와 「안 했다」를 «가를 수 없다». 넘길지 말지를 정하려면 이 함수를 쓴다. */
export function declaredGoalType(document: string): GoalType | null {
  const values = leadingGoalMetadata(document)
    .map((line) => GOAL_TYPE_LINE.exec(line)?.[1].trim())
    .filter((value): value is string => value !== undefined);
  if (values.length !== 1) return null;
  return GOAL_TYPES.includes(values[0] as GoalType) ? (values[0] as GoalType) : null;
}

const ROOT_INTENT_DECLARATION = /^- RootIntent(?:\b|[ \t])/;
export const SUPERSEDED_BY_LINE = /^- Superseded-By:\s*(\S.*?)\s*$/;
const REQUESTED_CRITERION_LINE = /^- Checkable requested criterion:/;
const TARGET_PATH_LABEL = /^대상 경로:\s*(.+)$/;
const METADATA_LINE_BOUNDARY = /\r\n|[\n\r\u2028\u2029]/;
const METADATA_LINE_BOUNDARY_GLOBAL = /\r\n|[\n\r\u2028\u2029]/g;
const REQUIRED_EVIDENCE_ENTRY = /^- \[([^\]\r\n]*)\][ \t]+(.*)$/;

/**
 * ⛔⭐ `## REQUIRED EVIDENCE` 안에서 **주석 줄**을 여는 접두. 태그 요구(`- [tag] …`)에서 제외된다.
 *
 * 저작기 자신이 넣는 줄이라 저자가 고칠 수 없다 — 그런데 같은 절의 린터가 ERROR 로 막았고,
 * `dev-pipeline` 이 ERROR 에서 발사를 **거부**해 「방법론을 따른 골만 못 뜨는」 역설이 생겼다
 * (2026-08-03 · `[T]` 실물 보고 · `GOAL-T24`).
 * ⛔ 생성부(`requiredEvidenceInformation`)와 린터가 **이 상수 하나에서 파생**한다 — 손으로 복제하지 마라.
 */
const REQUIRED_EVIDENCE_ANNOTATION_PREFIX = '- Information:';

/** 태그 계약의 대상인 항목인가 — 저작기가 넣는 주석 줄은 대상이 아니다. */
function isRequiredEvidenceEntryLine(line: string): boolean {
  return /^- /.test(line) && !line.startsWith(REQUIRED_EVIDENCE_ANNOTATION_PREFIX);
}
const SCOPE_BOUNDARY_MAX_CHARS = 1_800;
const UNANSWERED_CLARIFICATION_QUESTION_MAX_CHARS = 240;
const UNANSWERED_CLARIFICATION_OPTIONS_MAX_CHARS = 360;
const SCOPE_BOUNDARY_CANDIDATES_MARKER = 'Scope-boundary candidates selected by document relevance:';
const SCOPE_BOUNDARY_CANDIDATES_FOOTER = '- If adopted, state each boundary as an intentional goal decision with its reason; do not create a must-fix solely from that boundary.';
const GOAL_AUTHOR_PHASES = ['ground', 'enhance', 'assemble', 'lint'] as const;
export type GoalAuthorPhase = typeof GOAL_AUTHOR_PHASES[number];
const GOAL_AUTHOR_ASSEMBLE_SUBPHASES = ['assemble-inputs', 'assemble-sections', 'assemble-document'] as const;
type GoalAuthorAssembleSubphase = typeof GOAL_AUTHOR_ASSEMBLE_SUBPHASES[number];
type GoalAuthorTimedPhase = GoalAuthorPhase | GoalAuthorAssembleSubphase;

// ⛔⭐⭐ 저작 관측에 «조인 키»가 없었다 — `phase-end` 는 `elapsedMs` 를 내는데 그 값을 «어느 골»에
//   붙일지가 어디에도 없었다(📏 2026-08-07 실측: phase-end 83건 중 goalId 보유 «0» · plan-signals 는 43 중 31).
//   ⛔ `goalId` 를 그대로 쓸 수는 없다 — 그것은 `assemble` «중»에 정해지므로 `ground`·`enhance` 시점엔
//      «원리상 존재하지 않는다». ⇒ 저작 «런» id 를 맨 앞에서 만들어 전 페이즈에 싣고,
//      goalId 가 정해지는 자리에서 «둘을 잇는 한 줄»(`goal-id-assigned`)을 낸다.
function startGoalAuthorPhase(phase: GoalAuthorTimedPhase, authorRunId: string, onProgress?: GoalAuthorDeps['onProgress']): number {
  observeGoalAuthor('goal-author', 'phase-start', { phase, authorRunId });
  if (GOAL_AUTHOR_PHASES.includes(phase as GoalAuthorPhase)) {
    if (onProgress) onProgress(phase as GoalAuthorPhase, 'start');
    else process.stderr.write(`[goal-author] ${phase} started\n`);
  }
  return Date.now();
}

type GoalAuthorTokens = { inputTokens: number | null; outputTokens: number | null };
const UNKNOWN_GOAL_AUTHOR_TOKENS: GoalAuthorTokens = { inputTokens: null, outputTokens: null };

function endGoalAuthorPhase(phase: GoalAuthorTimedPhase, startedAt: number, authorRunId: string, onProgress?: GoalAuthorDeps['onProgress'], tokens: GoalAuthorTokens = UNKNOWN_GOAL_AUTHOR_TOKENS): void {
  const elapsedMs = Date.now() - startedAt;
  observeGoalAuthor('goal-author', 'phase-end', { phase, authorRunId, elapsedMs, ...tokens });
  if (GOAL_AUTHOR_PHASES.includes(phase as GoalAuthorPhase)) {
    if (onProgress) onProgress(phase as GoalAuthorPhase, 'end');
    else process.stderr.write(`[goal-author] ${phase} ended in ${elapsedMs}ms\n`);
  }
}

export type GoalFileLintLevel = 'ERROR' | 'WARN';

export type GoalFileLintTag = 'canonical-structure' | 'evidence-section' | 'boundary-size' | 'launch-branch' | 'unanswered-clarification' | 'shell-damage' | 'traced-path' | 'grounding-evidence' | 'empty-result-population' | 'decision-signal-numeric-source' | 'decision-signal-numeric-coverage' | 'decision-signal-proxy-expectation' | 'out-of-target-requirement' | 'heading-form-marker' | 'blanket-invariant' | 'self-question-subject' | 'artifact-launch-declaration' | 'all-negative-signals' | 'unreadable-signals' | 'alternative-signals' | 'count-observation' | 'identifier-name-observation' | 'self-reported-observation' | 'default-invocation-observation' | 'release-note';

type GoalFileLintOrigin =
  | { readonly kind: 'known-incident'; readonly incident: string; readonly reference: string }
  | { readonly kind: 'unknown-origin'; readonly label: 'ORIGIN-UNKNOWN' };

/**
 * Why each closed goal-file lint tag exists. Unknown is explicit rather than a blank or inferred history.
 * `satisfies Record<GoalFileLintTag, GoalFileLintOrigin>` makes adding a tag require an origin slot.
 */
export const GOAL_FILE_LINT_ORIGINS: Record<GoalFileLintTag, GoalFileLintOrigin> = {
  'canonical-structure': { kind: 'known-incident', incident: 'nine required sections blocked handwritten goals', reference: 'git:d2c18dd58 (#6789)' },
  'evidence-section': { kind: 'known-incident', incident: 'goal documents omitted required evidence per acceptance criterion', reference: 'git:dfe0b41a9 (#6387)' },
  'boundary-size': { kind: 'known-incident', incident: 'unselected candidate lists inflated scope boundaries', reference: 'git:c28fd5fbe (#6406)' },
  'launch-branch': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'unanswered-clarification': { kind: 'known-incident', incident: 'deferred clarifications passed lint and later killed launch', reference: 'git:50dc445cc (#6703)' },
  'shell-damage': { kind: 'known-incident', incident: 'code fences were read as empty inline code', reference: 'git:92937e8f3 (#6403)' },
  'traced-path': { kind: 'known-incident', incident: 'missing files and lines escaped pre-launch validation', reference: 'git:777973f23 (#6423)' },
  'grounding-evidence': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'empty-result-population': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'decision-signal-numeric-source': { kind: 'known-incident', incident: 'authored Expected result omitted numeric source and coverage', reference: 'git:7e6c02799 (#9847)' },
  'decision-signal-numeric-coverage': { kind: 'known-incident', incident: 'authored Expected result omitted numeric source and coverage', reference: 'git:7e6c02799 (#9847)' },
  'decision-signal-proxy-expectation': { kind: 'known-incident', incident: 'proxy expectation detector captured only 1.6% of its target', reference: 'git:97aa711fb (#9801)' },
  'out-of-target-requirement': { kind: 'known-incident', incident: 'boundary and topology facts were copied into requested criteria', reference: 'git:92c373ab8 (#8595)' },
  'heading-form-marker': { kind: 'known-incident', incident: 'heading-form invariant markers were not recognized as markers', reference: 'git:ddb8657ad (#9499)' },
  'blanket-invariant': { kind: 'known-incident', incident: 'blanket invariants required both broadness and named-target gates', reference: 'git:feb10f17c (#9774)' },
  'self-question-subject': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'artifact-launch-declaration': { kind: 'known-incident', incident: 'artifact launch declarations appeared only on the feature landing day and never afterward, including goals with executable-artifact signals', reference: 'git:e3a4b32235 (#10532)' },
  'all-negative-signals': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'unreadable-signals': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'alternative-signals': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'count-observation': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
  'identifier-name-observation': { kind: 'known-incident', incident: "an authored observation of 'the list of test names this file registers' produced a test that greps its own source for test-name strings, which passes with every named test body emptied; 59 of 3164 goal documents carried the same wording", reference: 'PR #15791 (closed; superseded by #15802); docs/harness/observability/ISSUES.md OBS-T415' },
  'self-reported-observation': { kind: 'known-incident', incident: "an authored observation of 'the captureScope field of the emitted JSON' stayed green across two failed implementations: a Chrome CLI flag Chrome silently ignores (capture stayed 1280x900 against a true 4651) and a CDP call that timed out leaving no file at all, both of which still emitted captureScope:'full-page'", reference: 'docs/manual/MANUAL-web-clone-to-reproducible-resource-2026-09-08.md section 6b; PR #16201; measured 2026-09-08: 190 of 2867 goal documents that carry a decision signal match this shape, three times the 63 that match identifier-name-observation' },
  'default-invocation-observation': { kind: 'known-incident', incident: 'a scripts/*.ts checker landed green from fixture tests and, run once with no arguments from the repository root, reported covered 1 and uncovered 22 because its default catalog path never opened the map the goal named', reference: 'PR #19126; measured 2026-09-20 against the same-day controls #19123 and #19127' },
  'release-note': { kind: 'unknown-origin', label: 'ORIGIN-UNKNOWN' },
} as const satisfies Record<GoalFileLintTag, GoalFileLintOrigin>;

/** Machine-countable reason for a finding that retains the canonical-structure tag. */
export type GoalFileLintCheckDetail = 'invalid-goal-type' | 'missing-required-section' | 'required-section-order' | 'ask-section-relationship';

export type GoalFileLintOrderCause = 'missing-required-section' | 'present-section-order';

export interface GoalFileLintFinding {
  level: GoalFileLintLevel;
  tag: GoalFileLintTag;
  message: string;
  /** Optional sub-check: existing tags, levels, and messages remain the compatibility contract. */
  check?: GoalFileLintCheckDetail;
  /** Non-enumerable cause for required-section-order findings so launch can keep real reversals blocking. */
  orderCause?: GoalFileLintOrderCause;
}

/** Builds a canonical-structure finding without expanding the closed lint-tag vocabulary. */
export function canonicalStructureFinding(
  check: GoalFileLintCheckDetail,
  level: GoalFileLintLevel,
  message: string,
  orderCause?: GoalFileLintOrderCause,
): GoalFileLintFinding {
  const finding: GoalFileLintFinding = { level, tag: 'canonical-structure', message };
  Object.defineProperty(finding, 'check', { value: check, enumerable: false });
  if (orderCause) Object.defineProperty(finding, 'orderCause', { value: orderCause, enumerable: false });
  return finding;
}

export type GoalCommandExecutionKind = 'success' | 'missing-command' | 'argument-problem' | 'execution-failure';

export interface GoalCommandExecutionResult {
  readonly status: number | null;
  readonly stderr: string;
}

export interface GoalCommandExecutionClassification {
  readonly kind: GoalCommandExecutionKind;
  readonly log: string;
}

/** Classifies an already-observed Commander result without executing a command. */
export function classifyGoalCommandExecution(result: GoalCommandExecutionResult): GoalCommandExecutionClassification {
  // A clean exit is authoritative: stderr text from a successful command is not a failure signal.
  if (result.status === 0) return { kind: 'success', log: 'command completed successfully' };

  const stderr = result.stderr;
  if (stderr.includes('unknown command') || stderr.includes('unknown option')) {
    return { kind: 'missing-command', log: 'command is not recognized; this may be not yet implemented rather than a defect' };
  }
  if (stderr.includes('missing required argument') || stderr.includes('required option')) {
    return { kind: 'argument-problem', log: 'command requires a missing argument or option' };
  }
  return { kind: 'execution-failure', log: `command execution failed with code ${String(result.status)}` };
}

/** Optional repository-bounded source reader. Legacy null means the referenced path is missing. */
export interface GoalFileLintDeps {
  readReferencedFile?: (repositoryRelativePath: string) => string | null | ReferencedFileReadResult;
}

/** Return document lines outside line-start CommonMark-style fenced code blocks.
 *
 * ⭐ export 인 이유: 「펜스 밖인가」를 묻는 자가 둘이 되면 규칙이 갈린다.
 *   `src/self-dev/ask-launch-flow.ts` 가 기록을 넣을 자리를 고를 때 «이 규칙»을 그대로 쓴다
 *   (2026-08-20: 그쪽이 약한 중복 규칙을 따로 갖고 있었고 `~~~` 펜스를 못 봤다). */
export function linesOutsideFencedCode(document: string): GoalDocSourceLine[] {
  let fence: { marker: string; length: number } | null = null;
  const outside: GoalDocSourceLine[] = [];
  // ⛔⭐ 줄 분리는 `split(/\r?\n/)` 와 «정확히 같아야» 한다 — 종전 `matchAll` 은 빈 매치를
  //   건너뛰어 문서 끝 빈 줄을 잃었고 절 본문이 `"body\n"` → `"body"` 로 바뀌었다.
  const parts = document.split(/(\r?\n)/);
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? '';
    const lineStart = cursor;
    cursor += text.length + (parts[index + 1]?.length ?? 0);
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence && (marker !== '`' || !fenceMatch[2].includes('`'))) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence && marker === fence.marker && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') {
        fence = null;
      }
      continue;
    }
    if (!fence) outside.push({ text, start: lineStart });
  }
  return outside;
}

// CommonMark 펜스는 **한 종류의 문자**가 3개 이상 이어진 런이다 — `[`~]{3,}` 는 혼합(백틱+틸드)까지
// 펜스로 인정해 진짜 진양성을 펜스 안으로 숨긴다(리뷰 must-fix). 열기/닫기 모두 이 하나를 쓴다.
const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FOLDED_FENCE_RUN = /(`{3,}|~{3,})[ \t]*$/;

/**
 * 인라인 판정에 넘길 **블록 목록**을 낸다. ⛔ 인라인 코드 스팬은 블록을 넘지 못하므로(CommonMark)
 * 빈 줄뿐 아니라 **제목·thematic break·펜스·들여쓴 코드블록**도 경계다. 경계를 안 두면 블록 양쪽의
 * 짝 없는 런이 짝지어져 **진양성이 숨는다**(리뷰 must-fix).
 */
function shellDamageBlocks(document: string): string[] {
  const lines = document.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => { if (current.length) { blocks.push(current.join('\n')); current = []; } };
  let fence: { marker: string; length: number } | null = null;
  let indentedCode = false;

  // 닫는 펜스는 같은 문자·같거나 긴 런이고 **그 뒤가 공백뿐**이어야 한다(CommonMark). 임의 suffix 를
  // 허용하면 info 문자열이 붙은 **여는 펜스**를 닫힘으로 오인해 그 사이 진양성이 통째로 숨는다(리뷰 must-fix).
  // ⛔ 백틱 펜스의 info 문자열에는 **백틱이 올 수 없다**(CommonMark). 인정해 버리면 그 줄의 펜스 밖
  //   진양성이 펜스 안으로 숨는다(리뷰 must-fix). 틸드 펜스는 info 에 백틱을 허용한다.
  const openingFence = (line: string) => {
    const run = FENCE_RUN.exec(line);
    if (!run) return null;
    if (run[1][0] === '`' && run[2].includes('`')) return null;
    return run;
  };

  const matchingClosingFence = (line: string, candidate: { marker: string; length: number }) => {
    const run = FENCE_RUN.exec(line);
    if (!run || run[1][0] !== candidate.marker || run[1].length < candidate.length) return null;
    return run[2].trim() === '' ? run : null;
  };

  // ⛔ 들여쓴 코드블록은 **단락을 중단하지 못한다**(CommonMark). 앞줄이 본문이면 네 칸 들여쓰기는
  //   코드가 아니라 **그 단락의 이어짐**이라, 무조건 제외하면 그 줄의 진양성이 숨는다(리뷰 must-fix).
  let inParagraph = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = matchingClosingFence(line, fence);
      if (closing) { fence = null; inParagraph = false; flush(); }
      continue;
    }
    // 들여쓰기 네 칸은 **열 기준**이다 — 탭 하나는 다음 4열 경계까지이므로 `   \t`(공백 셋+탭)도 코드다.
    if (/^(?: {4}|\t| {1,3}\t)/.test(line) && (indentedCode || !inParagraph)) {
      if (!indentedCode) flush();
      indentedCode = true;
      continue;
    }
    if (indentedCode) {
      if (line === '') continue;
      indentedCode = false;
      flush();
    }
    // ⛔ **모든 비어 있지 않은 줄이 단락은 아니다.** 제목 뒤·펜스 뒤의 들여쓴 줄은 코드블록이고,
    //   여기서 단락으로 오인하면 그 코드가 본문으로 검사돼 오탐이 난다(리뷰 must-fix).
    // ⛔ block quote 는 **컨테이너**다 — 안의 내용은 그 자체로 문서라 같은 규칙(펜스·제목·인라인)이 다시 든다.
    //   마커를 벗겨 **재귀**로 판정하면 인용 안 펜스가 인정되고(오탐 제거), 인용 밖 런과 짝지어지지도 않는다
    //   (거짓 음성 제거). 실측: 골 문서 340개 중 22개가 인용문 줄을 갖는다(리뷰 must-fix).
    if (/^ {0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (/^ {0,3}>/.test(candidate)) {
          quoted.push(candidate.replace(/^ {0,3}>[ \t]?/, ''));
        } else if (quoted.length > 0 && candidate.trim() !== '' && !/^ {0,3}(?:#{1,6}(?:\s|$)|(`{3,}|~{3,}))/.test(candidate)) {
          // ⭐ **lazy continuation** — 인용 안 단락은 `>` 없는 다음 줄로 이어진다(CommonMark).
          //   빼면 인용 안에서 여러 줄에 걸친 코드 스팬이 갈려 오탐이 난다(리뷰 must-fix).
          quoted.push(candidate);
        } else break;
        index += 1;
      }
      index -= 1;
      blocks.push(...shellDamageBlocks(quoted.join('\n')));
      inParagraph = false;
      continue;
    }

    // ⛔ **목록 항목은 컨테이너**다 — 항목마다 자기 블록이어야 짝 없는 런이 서로 짝지어지지 않고
    //   (거짓 음성), 항목 **안의 들여쓴 펜스**도 인정돼야 오탐이 안 난다. 실측: 골 문서 343개 중
    //   항목 뒤 들여쓴 펜스가 **7건** 있다(리뷰 must-fix — 처음엔 같은 줄 펜스만 세어 0으로 오판했다).
    // ⛔ 마커 뒤 공백이 **5칸 이상**이면 내용은 **한 칸 뒤**에서 시작하고 나머지는 항목 안 들여쓴
    //   코드블록이다(CommonMark). 공백을 전부 들여쓰기로 먹으면 그 코드가 본문으로 검사돼 오탐이 난다.
    const listItem = /^( {0,3}(?:[-*+]|(\d{1,9})[.)]))([ \t]+|$)(.*)$/.exec(line);
    // ⛔ **1 이 아닌 순서 목록은 단락을 중단하지 못한다**(CommonMark). 그래도 새 블록으로 가르면
    //   `text ``foo` 다음 줄의 `2. bar``` 가 갈려 정상 코드 스팬이 오탐이 된다(리뷰 must-fix).
    //   실측: 골 문서 343개에 그 구조가 468줄 있다 — 흔하다.
    //   ⊕ **빈 목록 항목도 단락을 중단하지 못한다**(CommonMark) — `text ``foo` / `-` / `bar``` 는 정상 스팬이다.
    const interruptsParagraph = !inParagraph
      || ((!listItem?.[2] || listItem[2] === '1') && (listItem?.[4] ?? '').trim() !== '');
    if (listItem && interruptsParagraph) {
      flush();
      const markerWidth = listItem[1].length;
      const padding = listItem[3] ?? '';
      const contentIndent = padding.length >= 5 ? markerWidth + 1 : markerWidth + padding.length;
      const item: string[] = [padding.length >= 5 ? padding.slice(1) + listItem[4] : listItem[4]];
      let sawBlank = false;
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() === '') { item.push(''); sawBlank = true; index += 1; continue; }
        if (next.length > contentIndent && /^\s+$/.test(next.slice(0, contentIndent))) { item.push(next.slice(contentIndent)); sawBlank = false; index += 1; continue; }
        // ⭐ **lazy continuation** — 항목 안 단락은 들여쓰기 없는 다음 줄로 이어진다(CommonMark).
        //   빼면 항목 안에서 여러 줄에 걸친 코드 스팬이 갈려 오탐이 난다(리뷰 must-fix · 인용문과 같은 형태).
        //   ⛔ 빈 줄 뒤에는 이어지지 않고, 새 컨테이너·제목·펜스도 이어짐이 아니다.
        if (!sawBlank && !/^ {0,3}(?:>|#{1,6}(?:\s|$)|(`{3,}|~{3,})|(?:[-*+]|\d{1,9}[.)])(?:\s|$))/.test(next)) {
          item.push(next); index += 1; continue;
        }
        break;
      }
      blocks.push(...shellDamageBlocks(item.join('\n')));
      inParagraph = false;
      continue;
    }
    const isHeading = /^ {0,3}#{1,6}(?:\s|$)/.test(line);
    const isThematicBreak = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
    // ⛔ setext 제목 밑줄(`===`·`---`)은 **앞 단락을 닫는다**. 안 닫으면 제목과 뒤 본문의 런이 짝지어져
    //   진양성이 숨는다(리뷰 must-fix). `---` 는 위 thematic break 와도 겹치지만 여기서 함께 닫힌다.
    const isSetextUnderline = inParagraph && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line);
    if (line.trim() === '' || isHeading || isThematicBreak) flush();
    inParagraph = line.trim() !== '' && !isHeading && !isThematicBreak;
    if (isHeading) {
      // 제목 줄 자체도 검사 대상이지만 **자기 블록**이다 — 뒤 단락과 합치면 런이 짝지어진다.
      current.push(line);
      flush();
      continue;
    }
    if (isSetextUnderline) {
      current.push(line);
      flush();
      inParagraph = false;
      continue;
    }

    const lineStartFence = openingFence(line);
    if (lineStartFence) {
      flush();
      fence = { marker: lineStartFence[1][0], length: lineStartFence[1].length };
      continue;
    }

    const foldedFence = FOLDED_FENCE_RUN.exec(line);
    // ⛔ 혼합 런의 **동종 suffix** 를 펜스로 세지 않는다. `FOLDED_FENCE_RUN` 은 줄머리에 고정돼 있지
    //   않아 `prefix ~```” 의 끝 백틱 셋만 잡는데, 그러면 `~``` ` 라는 **혼합 런**이 펜스가 되어
    //   그 뒤의 진양성이 통째로 숨는다(리뷰 must-fix — 줄머리 경로엔 이미 반영됐고 여기만 빠져 있었다).
    // ⚠️ 런 앞 문자가 **같은** 마커일 수는 없다(정규식이 greedy 라 이미 먹었다) ⇒ 남는 경우는
    //   **다른** 마커뿐이고, 그것이 곧 혼합 런이다.
    const foldedIsMixedSuffix = foldedFence !== null
      && foldedFence.index > 0
      && (line[foldedFence.index - 1] === '`' || line[foldedFence.index - 1] === '~');
    if (foldedFence && !foldedIsMixedSuffix) {
      const candidate = { marker: foldedFence[1][0], length: foldedFence[1].length };
      // ⛔ 닫힘 후보도 **뒤가 공백뿐**이어야 한다 — `` ``` lang `` 같은 **여는 펜스**를 닫힘으로 오인하면
      //   그 사이의 진양성이 통째로 숨는다(리뷰 must-fix).
      const hasClosingFence = lines.slice(index + 1).some((followingLine) => matchingClosingFence(followingLine, candidate));
      if (hasClosingFence) {
        current.push(line.slice(0, foldedFence.index));
        flush();
        fence = { ...candidate };
        continue;
      }
      // ⛔ 닫는 펜스가 없으면 이것은 펜스가 아니라 **본문의 백틱 런**이다. 그대로 밖에 두되,
      //   아래 판정이 짝 없는 런을 발화시키지 않으므로 오탐이 되지 않는다.
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * 한 **블록** 안에서 빈 인라인 코드 스팬을 찾는다 — 여는 런과 닫는 런의 길이가 같고 사이가 빈 경우.
 * ⛔ 블록을 넘어 짝짓지 않는 것이 핵심이라, 경계 판정은 호출자(`shellDamageBlocks`)가 한다.
 * ⛔ 짝 없는 런은 코드 스팬이 아니지만 **길이 정확히 2** 는 셸이 인용을 먹고 남긴 손상 자국이라 발화시킨다.
 */
function containsEmptyInlineCode(document: string): boolean {
  const runs = [...document.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index];
    const openingEnd = (opening.index ?? 0) + opening[0].length;
    const closingIndex = runs.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate[0].length === opening[0].length);
    if (closingIndex === -1) {
      if (opening[0].length === 2) return true;
      continue;
    }
    const closing = runs[closingIndex];
    if (document.slice(openingEnd, closing.index).trim() === '') return true;
    index = closingIndex;
  }
  return false;
}

/** Extract a level-two section outside fenced code, ending at the next same-or-higher heading. */
export function markdownSection(document: string, title: string): string | null {
  return extractGoalDocSections(document, {
    search: 'exact-trimmed-line',
    heading: `## ${title}`,
    lines: linesOutsideFencedCode,
    endHeading: /^#{1,2}(?:\s|$)/,
  })[0]?.body ?? null;
}

const ARTIFACT_LAUNCH_SECTION = '산출물을 어떻게 켜나';
type ArtifactLaunchDeclarationSource = 'heading' | 'label';
// Shared by label-form section boundaries and field extraction: accept human indentation
// so an indented field neither ends the declaration early nor becomes unrecognized.
const ARTIFACT_LAUNCH_LABEL = /^\s*(?:-\s*)?(Entrypoint|Port|Environment):\s*(.*)$/;

/**
 * Accept the canonical H2 declaration first, then the equivalent colon label outside
 * fenced code. A label declaration contains only its recognized launch fields and
 * blank separators; another label, prose, or an H1/H2 heading begins the next ask item.
 */
interface ArtifactLaunchDeclarationSection {
  readonly source: ArtifactLaunchDeclarationSource;
  readonly body: string;
  readonly stoppedAt?: { readonly start: number; readonly text: string };
}

function firstRawLineAfter(document: string, line: GoalDocSourceLine): GoalDocSourceLine | undefined {
  const nextStart = line.start + line.text.length;
  const lineBreak = document.slice(nextStart, nextStart + 2) === '\r\n' ? 2 : document[nextStart] === '\n' ? 1 : 0;
  if (lineBreak === 0 || nextStart + lineBreak >= document.length) return undefined;
  const start = nextStart + lineBreak;
  const end = document.indexOf('\n', start);
  return { start, text: document.slice(start, end < 0 ? undefined : end).replace(/\r$/, '') };
}

function artifactLaunchDeclarationSection(document: string): ArtifactLaunchDeclarationSection | null {
  const lines = linesOutsideFencedCode(document);
  const headingIndex = lines.findIndex((line) => line.text.trim() === `## ${ARTIFACT_LAUNCH_SECTION}`);
  if (headingIndex >= 0) {
    let boundaryIndex = headingIndex + 1;
    while (boundaryIndex < lines.length) {
      const previous = lines[boundaryIndex - 1]!;
      const current = lines[boundaryIndex]!;
      if (current.start !== previous.start + previous.text.length + 1 && current.start !== previous.start + previous.text.length + 2) break;
      if (/^#{1,2}(?:\s|$)/.test(current.text)) break;
      if (current.text.trim() !== '' && !ARTIFACT_LAUNCH_LABEL.test(current.text)) break;
      boundaryIndex += 1;
    }
    const previous = lines[boundaryIndex - 1]!;
    const next = lines[boundaryIndex];
    const stoppedLine = next !== undefined
      && (next.start === previous.start + previous.text.length + 1 || next.start === previous.start + previous.text.length + 2)
      ? next
      : firstRawLineAfter(document, previous);
    const bodyLines = lines.slice(headingIndex + 1, boundaryIndex);
    return {
      source: 'heading',
      body: bodyLines.map((line) => line.text).join('\n'),
      ...(stoppedLine !== undefined && { stoppedAt: { start: stoppedLine.start, text: stoppedLine.text } }),
    };
  }

  const labelIndex = lines.findIndex((line) => line.text.trim() === `${ARTIFACT_LAUNCH_SECTION}:`);
  if (labelIndex < 0) return null;
  let boundaryIndex = labelIndex + 1;
  while (boundaryIndex < lines.length) {
    const previous = lines[boundaryIndex - 1]!;
    const current = lines[boundaryIndex]!;
    // `linesOutsideFencedCode` excludes fence lines and their bodies; do not let that
    // filtering make source text on opposite sides of a fence look adjacent.
    if (current.start !== previous.start + previous.text.length + 1 && current.start !== previous.start + previous.text.length + 2) break;
    const text = current.text;
    if (/^#{1,2}(?:\s|$)/.test(text)) break;
    if (text.trim() !== '' && !ARTIFACT_LAUNCH_LABEL.test(text)) break;
    boundaryIndex += 1;
  }
  const previous = lines[boundaryIndex - 1]!;
  const next = lines[boundaryIndex];
  const stoppedLine = next !== undefined
    && (next.start === previous.start + previous.text.length + 1 || next.start === previous.start + previous.text.length + 2)
    ? next
    : firstRawLineAfter(document, previous);
  const bodyLines = lines.slice(labelIndex + 1, boundaryIndex);
  return {
    source: 'label',
    body: bodyLines.map((line) => line.text).join('\n'),
    ...(stoppedLine !== undefined && { stoppedAt: { start: stoppedLine.start, text: stoppedLine.text } }),
  };
}

/** ⛔ 검증 시나리오 절 제목 — `markdownSection` 이 exact-trimmed-line 으로 찾는다.
 *  ⛔ 꼬리를 붙이면 «절이 없는 것»이 된다. 생성기와 이 목록이 «같은 문자열»을 써야 한다. */
export const TEST_SCENARIO_SECTION_TITLES = ['## 검증 시나리오', '## L. 라이브', '## 결과 보고 양식'] as const;

export interface ArtifactLaunchDeclaration {
  readonly entrypoint?: string;
  readonly port?: number;
  readonly environment: readonly string[];
  readonly errors: readonly string[];
}

export interface ArtifactLaunchDeclarationStopPosition {
  readonly line: number;
  readonly text: string;
}

export interface ArtifactLaunchDeclarationInspection {
  readonly declared: boolean;
  readonly extracted: boolean;
  readonly declaration?: ArtifactLaunchDeclaration;
  /** First non-label declaration-section line; following prose is intentionally not parsed. */
  readonly stoppedAt?: ArtifactLaunchDeclarationStopPosition;
}

export type ArtifactLaunchDeclarationClassification = 'declared' | 'absent-without-signal' | 'absent-with-signal';

const SERVER_ENTRY_PATH = /(?:^|\/)server[^/]*\.(?:[cm]?[jt]sx?)$/i;
const LOOPBACK_ADDRESS_WITH_PORT = /(?<![\p{L}\p{N}.-])(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)(?![\p{L}\p{N}_])/iu;

function declaredTargetPaths(document: string): string[] {
  return linesOutsideFencedCode(document).flatMap(({ text }) => {
    const match = TARGET_PATH_LABEL.exec(text.trim());
    return match ? askPathTokens(match[1]) : [];
  });
}

export function artifactLaunchDeclarationClassification(document: string): ArtifactLaunchDeclarationClassification {
  if (parseArtifactLaunchDeclaration(document) !== null) return 'declared';
  const originalAsk = verbatimOriginalAsk(document);
  const targetPaths = [
    ...tracedPathReferences(document).map(({ path }) => path),
    ...declaredTargetPaths(document),
    ...(originalAsk === null ? [] : declaredTargetPaths(originalAsk)),
  ];
  const hasServerEntryPath = targetPaths.some((path) => SERVER_ENTRY_PATH.test(path));
  const hasLoopbackAddressWithPort = LOOPBACK_ADDRESS_WITH_PORT.test(document);
  return hasServerEntryPath || hasLoopbackAddressWithPort ? 'absent-with-signal' : 'absent-without-signal';
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Reads the optional H2 or colon-label artifact launch declaration. It accepts names only,
 * never commands or environment values, and retains malformed entries as errors.
 */
function artifactLaunchDeclarationForDocument(document: string): ArtifactLaunchDeclarationSection | null {
  const deployed = artifactLaunchDeclarationSection(document);
  if (deployed !== null) return deployed;

  // Authored goal files preserve the human ask in a fenced provenance block. Only after
  // finding no deployed declaration do we inspect that explicit source; arbitrary fenced
  // blocks remain excluded by artifactLaunchDeclarationSection. `range.start` converts
  // the fallback section's ask-local position back to the enclosing document position.
  const originalAsk = extractVerbatimOriginalAsk(document);
  if (originalAsk === null) return null;
  const fallback = artifactLaunchDeclarationSection(originalAsk.ask);
  if (fallback === null) return null;
  const originalAskStart = originalAsk.range?.start ?? 0;
  return {
    ...fallback,
    ...(fallback.stoppedAt !== undefined && { stoppedAt: { ...fallback.stoppedAt, start: fallback.stoppedAt.start + originalAskStart } }),
  };
}

export function parseArtifactLaunchDeclaration(document: string): ArtifactLaunchDeclaration | null {
  const declarationSection = artifactLaunchDeclarationForDocument(document);
  if (declarationSection === null) return null;
  const { body: section } = declarationSection;

  let entrypoint: string | undefined;
  let port: number | undefined;
  const environment: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of section.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const match = ARTIFACT_LAUNCH_LABEL.exec(rawLine);
    if (!match) break;
    const [, label, rawValue] = match;
    const value = rawValue.trim();
    if (value === '') {
      errors.push(`${label} must not be empty`);
      continue;
    }
    if (label === 'Entrypoint') {
      if (entrypoint !== undefined) errors.push('Entrypoint must appear at most once');
      else entrypoint = value;
      continue;
    }
    if (label === 'Port') {
      const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) errors.push('Port must be an integer from 1 through 65535');
      else if (port !== undefined) errors.push('Port must appear at most once');
      else port = parsed;
      continue;
    }
    for (const name of value.split(',').map((item) => item.trim())) {
      if (!ENVIRONMENT_NAME.test(name)) errors.push(`Environment must name a variable, not a value: ${name || '(empty)'}`);
      else if (seen.has(name)) errors.push(`Environment must not repeat: ${name}`);
      else {
        seen.add(name);
        environment.push(name);
      }
    }
  }
  if (entrypoint === undefined && port === undefined && environment.length === 0 && errors.length === 0) {
    errors.push('launch declaration must contain an Entrypoint, Port, or Environment entry');
  }
  return { ...(entrypoint !== undefined && { entrypoint }), ...(port !== undefined && { port }), environment, errors };
}

/** Inspect the deployed optional launch-declaration section without authoring a goal document. */
export function inspectArtifactLaunchDeclaration(document: string): ArtifactLaunchDeclarationInspection {
  const declaration = parseArtifactLaunchDeclaration(document);
  if (declaration === null) return { declared: false, extracted: false };
  const declarationSection = artifactLaunchDeclarationForDocument(document);
  const stoppedAt = declarationSection?.stoppedAt === undefined
    ? undefined
    : {
      line: document.slice(0, declarationSection.stoppedAt.start).split(/\r?\n/).length,
      text: declarationSection.stoppedAt.text,
    };
  return { declared: true, extracted: declaration.errors.length === 0, declaration, ...(stoppedAt !== undefined && { stoppedAt }) };
}

/** Promote a parser-recognized declaration without interpreting or repairing its source text. */
function promotedArtifactLaunchDeclaration(document: string, authorRunId: string): string[] {
  const declarationSection = artifactLaunchDeclarationSection(document);
  if (declarationSection === null || parseArtifactLaunchDeclaration(document) === null) return [];
  try {
    observeGoalAuthor('goal-author', 'artifact-launch-declaration-source', { authorRunId, source: declarationSection.source });
  } catch { /* observation is fail-soft */ }
  return ['## 산출물을 어떻게 켜나', declarationSection.body.trimEnd(), ''];
}

const TEST_SCENARIO_METHODOLOGY_REGISTRY: readonly string[] = ['deliverable-verify'];
const TEST_SCENARIO_RESERVED_DELIVERABLE_TYPES = new Set(['unknown', 'ambiguous']);
const TEST_SCENARIO_UNMEASURED_REASONS = new Set([
  'no-launch-declaration',
  'no-methodology',
  'ambiguous-methodology',
  'ambiguous-command-source',
  'no-command-source',
  'methodology-cannot-run',
]);

export interface TestScenarioAggregate {
  /** `unexecuted` is the formal `-` token; it is distinct from a measured zero. */
  readonly green: number | 'unexecuted';
  readonly red: number | 'unexecuted';
  readonly unmeasured: number | 'unexecuted';
  readonly state: 'unexecuted' | 'partial' | 'measured';
}

export interface TestScenarioDeclaration {
  readonly deliverableType?: string;
  readonly liveStatus?: 'measured' | 'unmeasured' | 'n/a';
  /** Result-report aggregate, exposed so consumers can distinguish not-run from zero-case execution. */
  readonly aggregate?: TestScenarioAggregate;
  readonly methodology?: string;
  readonly commandSource?: string;
  readonly startup?: string;
  readonly observer?: string;
  readonly expectation?: string;
  readonly reason?: string;
  readonly candidates: readonly string[];
  readonly prerequisite?: string;
  readonly errors: readonly string[];
}

export interface TestScenarioDeclarationInspection {
  readonly declared: boolean;
  readonly extracted: boolean;
  readonly declaration: TestScenarioDeclaration;
}

function scenarioField(section: string, label: string): { value?: string; errors: string[] } {
  const values: string[] = [];
  let occurrences = 0;
  const errors: string[] = [];
  const expression = new RegExp(`^(?:-\\s*)?${label}:\\s*(.*)$`);
  for (const line of section.split(/\r?\n/)) {
    const match = expression.exec(line);
    if (!match) continue;
    occurrences += 1;
    const value = match[1].trim().replace(/^`([\s\S]*)`$/, '$1').trim();
    if (value === '') errors.push(`${label} must not be empty`);
    else values.push(value);
  }
  if (occurrences > 1) errors.push(`${label} must appear at most once`);
  return { ...(values[0] !== undefined && { value: values[0] }), errors };
}

function scenarioCandidates(section: string): { values: string[]; occurrences: number; errors: string[] } {
  const values: string[] = [];
  const errors: string[] = [];
  let occurrences = 0;
  const expression = /^(?:-\s*)?후보 목록:\s*(.*)$/;
  for (const line of section.split(/\r?\n/)) {
    const match = expression.exec(line);
    if (!match) continue;
    occurrences += 1;
    const value = match[1].trim().replace(/^`([\s\S]*)`$/, '$1').trim();
    if (value === '') {
      errors.push('후보 목록 must not be empty');
      continue;
    }
    const items = value.split(',').map((item) => item.trim());
    if (items.some((item) => item === '')) errors.push('Candidates must not contain empty entries');
    values.push(...items);
  }
  if (occurrences > 1) errors.push('후보 목록 must appear at most once');
  return { values, occurrences, errors };
}

function testScenarioAggregate(resultReport: string | null): TestScenarioAggregate | undefined {
  const aggregates = [...(resultReport ?? '').matchAll(/^\*\*집계\*\*:\s*(.*)$/gm)].map((match) => match[0]);
  if (aggregates.length !== 1) return undefined;
  const match = /^\*\*집계\*\*:\s*초록\s+`(\d+|-)`\s*\/\s*빨강\s+`(\d+|-)`\s*\/\s*\*\*못 잼\s+`(\d+|-)`\*\*\s*$/.exec(aggregates[0]);
  if (!match) return undefined;
  const values = match.slice(1).map((value) => value === '-' ? 'unexecuted' : Number(value)) as [number | 'unexecuted', number | 'unexecuted', number | 'unexecuted'];
  if (values.some((value) => typeof value === 'number' && !Number.isSafeInteger(value))) return undefined;
  const state = values.every((value) => value === 'unexecuted')
    ? 'unexecuted'
    : values.every((value) => typeof value === 'number')
      ? 'measured'
      : 'partial';
  return { green: values[0], red: values[1], unmeasured: values[2], state };
}

function testScenarioDeliverableTypes(document: string): { value?: string; errors: string[] } {
  const values: string[] = [];
  const errors: string[] = [];
  let occurrences = 0;
  for (const line of document.split(/\r?\n/)) {
    const match = /^(?:>\s*)?\*\*산출물 종류\*\*:\s*(.*)$/.exec(line);
    if (!match) continue;
    occurrences += 1;
    const value = match[1].trim().replace(/^`([\s\S]*)`$/, '$1').trim();
    if (value === '') errors.push('test scenario requires a deliverable type');
    else values.push(value);
  }
  if (occurrences === 0) errors.push('test scenario requires a deliverable type');
  else if (occurrences !== 1) errors.push('deliverable type must appear exactly once');
  for (const value of values) {
    if (!TEST_SCENARIO_RESERVED_DELIVERABLE_TYPES.has(value) && !TEST_SCENARIO_METHODOLOGY_REGISTRY.includes(value)) {
      errors.push(`deliverable type must be a registered methodology or reserved value: ${value}`);
    }
  }
  return { ...(values[0] !== undefined && { value: values[0] }), errors };
}

/** Parses the scenario declaration without inventing methodology vocabulary outside its registry. */
export function parseTestScenarioDeclaration(document: string): TestScenarioDeclaration {
  const deliverable = testScenarioDeliverableTypes(document);
  const errors = [...deliverable.errors];
  const deliverableType = deliverable.value;

  const live = markdownSection(document, 'L. 라이브');
  if (live === null) errors.push('test scenario must contain an L. 라이브 section');
  const liveBody = live ?? '';
  const statuses = [...liveBody.matchAll(/^###\s+상태\s+`?(.*?)`?\s*$/gm)].map((match) => match[1].trim());
  if (live !== null && statuses.length !== 1) errors.push('live scenario Status must appear exactly once');
  const liveStatus = statuses[0] as TestScenarioDeclaration['liveStatus'] | undefined;
  if (live !== null && (statuses.length === 0 || !['measured', 'unmeasured', 'n/a'].includes(liveStatus ?? ''))) {
    errors.push('live scenario requires a status of measured, unmeasured, or n/a');
  }

  const labels = {
    methodology: scenarioField(liveBody, '방법론'),
    commandSource: scenarioField(liveBody, '명령 출처'),
    startup: scenarioField(liveBody, '기동'),
    observer: scenarioField(liveBody, '눈'),
    expectation: scenarioField(liveBody, '기대'),
    reason: scenarioField(liveBody, '사유'),
    prerequisite: scenarioField(liveBody, '무엇이 있었으면 됐나'),
    candidates: scenarioCandidates(liveBody),
  };
  errors.push(...Object.values(labels).flatMap((field) => field.errors));
  const values = {
    ...(labels.methodology.value !== undefined && { methodology: labels.methodology.value }),
    ...(labels.commandSource.value !== undefined && { commandSource: labels.commandSource.value }),
    ...(labels.startup.value !== undefined && { startup: labels.startup.value }),
    ...(labels.observer.value !== undefined && { observer: labels.observer.value }),
    ...(labels.expectation.value !== undefined && { expectation: labels.expectation.value }),
    ...(labels.reason.value !== undefined && { reason: labels.reason.value }),
    ...(labels.prerequisite.value !== undefined && { prerequisite: labels.prerequisite.value }),
  };
  const prohibited = (status: string, fields: readonly [string, boolean][]) => {
    for (const [label, present] of fields) if (present) errors.push(`${status} live scenario must not contain ${label}`);
  };

  if (liveStatus === 'measured') {
    for (const [label, value] of [['Methodology', labels.methodology.value], ['Command source', labels.commandSource.value], ['Startup', labels.startup.value], ['Observer', labels.observer.value], ['Expectation', labels.expectation.value]] as const) {
      if (!value) errors.push(`measured live scenario requires ${label}`);
    }
    prohibited('measured', [['Reason', labels.reason.value !== undefined], ['Candidates', labels.candidates.occurrences > 0], ['Prerequisite', labels.prerequisite.value !== undefined]]);
    if (labels.methodology.value && !TEST_SCENARIO_METHODOLOGY_REGISTRY.includes(labels.methodology.value)) errors.push(`measured live scenario requires a registered Methodology: ${labels.methodology.value}`);
    if (labels.methodology.value && deliverableType && labels.methodology.value !== deliverableType) errors.push('measured live scenario Methodology must match deliverable type');
  } else if (liveStatus === 'unmeasured') {
    if (!labels.reason.value) errors.push('unmeasured live scenario requires Reason');
    else if (!TEST_SCENARIO_UNMEASURED_REASONS.has(labels.reason.value)) errors.push(`unmeasured live scenario Reason is not recognized: ${labels.reason.value}`);
    if (!labels.prerequisite.value) errors.push('unmeasured live scenario requires Prerequisite');
    prohibited('unmeasured', [['Methodology', labels.methodology.value !== undefined], ['Command source', labels.commandSource.value !== undefined], ['Startup', labels.startup.value !== undefined], ['Observer', labels.observer.value !== undefined], ['Expectation', labels.expectation.value !== undefined]]);
    if (labels.reason.value?.startsWith('ambiguous-') && new Set(labels.candidates.values).size < 2) errors.push('ambiguous reason requires at least two distinct Candidates');
    if (!labels.reason.value?.startsWith('ambiguous-') && labels.candidates.occurrences > 0) errors.push('unmeasured live scenario must not contain Candidates');
    if (labels.reason.value === 'ambiguous-methodology' && labels.candidates.values.some((candidate) => !TEST_SCENARIO_METHODOLOGY_REGISTRY.includes(candidate))) errors.push(`ambiguous-methodology Candidates must be registered methodologies: ${labels.candidates.values.join(', ')}`);
    if (labels.reason.value === 'ambiguous-command-source' && labels.candidates.values.some((candidate) => !/^[^:\s]+:[^:\s]+$/.test(candidate))) errors.push(`ambiguous-command-source Candidates must be file:key values: ${labels.candidates.values.join(', ')}`);
  } else if (liveStatus === 'n/a') {
    if (!labels.methodology.value) errors.push('n/a live scenario requires Methodology');
    else if (!TEST_SCENARIO_METHODOLOGY_REGISTRY.includes(labels.methodology.value)) errors.push(`n/a live scenario requires a registered Methodology: ${labels.methodology.value}`);
    prohibited('n/a', [['Command source', labels.commandSource.value !== undefined], ['Startup', labels.startup.value !== undefined], ['Observer', labels.observer.value !== undefined], ['Expectation', labels.expectation.value !== undefined], ['Reason', labels.reason.value !== undefined], ['Candidates', labels.candidates.occurrences > 0], ['Prerequisite', labels.prerequisite.value !== undefined]]);
  }
  if (deliverableType && TEST_SCENARIO_RESERVED_DELIVERABLE_TYPES.has(deliverableType) && liveStatus && liveStatus !== 'unmeasured') errors.push(`reserved deliverable type ${deliverableType} only permits unmeasured live status`);
  const resultReport = markdownSection(document, '결과 보고 양식');
  const aggregateLines = [...(resultReport ?? '').matchAll(/^\*\*집계\*\*:\s*(.*)$/gm)];
  if (aggregateLines.length !== 1) errors.push('result report aggregate must appear exactly once');
  const aggregate = testScenarioAggregate(resultReport);
  if (!aggregate) errors.push('result report must contain an Unmeasured aggregate field');
  return { ...(deliverableType !== undefined && { deliverableType }), ...(liveStatus !== undefined && { liveStatus }), ...(aggregate !== undefined && { aggregate }), ...values, candidates: labels.candidates.values, errors };
}

/** Inspects a scenario document read-only, matching the sibling declaration inspection shape. */
export function inspectTestScenarioDeclaration(document: string): TestScenarioDeclarationInspection {
  const declaration = parseTestScenarioDeclaration(document);
  return { declared: markdownSection(document, 'L. 라이브') !== null, extracted: declaration.errors.length === 0, declaration };
}

const ASK_CONSTRAINT_MARKERS = ['해야 한다.', '하지 않는다.', '일 때만.', '기본값.', '정확히 한 번.'] as const;

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Count ask constraint markers absent from authored goal sections, excluding verbatim ask provenance. */
export function countMissingAuthoredConstraintMarkers(ask: string, document: string): {
  totalMarkers: number;
  missingMarkers: number;
} {
  const authoredText = ['WHAT TO BUILD', 'ACCEPTANCE CRITERIA', 'SCOPE BOUNDARY', '답하지 못하는 것', '불변식']
    .map((title) => markdownSection(document, title) ?? '')
    .join('\n');
  let totalMarkers = 0;
  let missingMarkers = 0;
  for (const marker of ASK_CONSTRAINT_MARKERS) {
    const askCount = countOccurrences(ask, marker);
    totalMarkers += askCount;
    missingMarkers += Math.max(askCount - countOccurrences(authoredText, marker), 0);
  }
  return { totalMarkers, missingMarkers };
}

/** Observe constraint-marker retention after a goal document has been written; never block authoring. */
function observeAuthoredConstraintMarkers(ask: string, document: string, authorRunId: string): void {
  try {
    const { totalMarkers, missingMarkers } = countMissingAuthoredConstraintMarkers(ask, document);
    observeGoalAuthor('goal-author', 'authored-constraint-marker-count', { authorRunId, totalMarkers, missingMarkers });
  } catch {
    // Constraint-marker measurement is observation only and must never stop authoring.
  }
}

/** Measure how many authored level-two sections each grounded path spans. */
export function countAuthoredGroundingPathSections(document: string, paths: readonly string[]): {
  averageSectionsPerPath: number;
  multiSectionPathCount: number;
  countedPaths: number;
} {
  const headings = canonicalBlocks(document).map((heading) => heading.slice(3));
  const validPaths = paths.filter((path) => path !== '');
  const sectionCount = validPaths.reduce((total, path) => total + headings.reduce(
    (count, heading) => count + Number((markdownSection(document, heading) ?? '').includes(path)),
    0,
  ), 0);
  const multiSectionPathCount = validPaths.filter((path) => headings.reduce(
    (count, heading) => count + Number((markdownSection(document, heading) ?? '').includes(path)),
    0,
  ) >= 2).length;
  return {
    averageSectionsPerPath: validPaths.length === 0 ? 0 : sectionCount / validPaths.length,
    multiSectionPathCount,
    countedPaths: validPaths.length,
  };
}

/** Observe grounded-path section reuse after a goal document has been written; never block authoring. */
function observeAuthoredGroundingPathSections(document: string, paths: readonly string[], authorRunId: string): void {
  try {
    observeGoalAuthor('goal-author', 'authored-grounding-path-section-count', {
      authorRunId,
      ...countAuthoredGroundingPathSections(document, paths),
    });
  } catch {
    // Grounding-path measurement is observation only and must never stop authoring.
  }
}

function authoredGoalSectionChars(document: string): Record<string, number> {
  const headings = linesOutsideFencedCode(document)
    .filter(({ text }) => /^## (?:\S)/.test(text))
    .map(({ text, start }) => ({ heading: text.slice(3).trim(), start }));
  const sections: Record<string, number> = { preamble: [...document.slice(0, headings[0]?.start ?? document.length)].length };
  for (let index = 0; index < headings.length; index += 1) {
    const { heading, start } = headings[index];
    sections[heading] = (sections[heading] ?? 0) + [...document.slice(start, headings[index + 1]?.start ?? document.length)].length;
  }
  for (const heading of ['PROBLEM', 'WHAT TO BUILD', 'ACCEPTANCE CRITERIA', 'TRACED PATHS', 'SCOPE BOUNDARY', 'STEPS', '답하지 못하는 것']) {
    sections[heading] ??= 0;
  }
  return sections;
}

function canonicalBlocks(document: string): string[] {
  return linesOutsideFencedCode(document)
    .filter((line) => /^##(?:\s|$)/.test(line.text))
    .map((line) => line.text.trim());
}

interface TracedPathReference {
  path: string;
  line: number | null;
  /** End of a `:start-end` range, or null when the reference names a single line or none. */
  endLine: number | null;
}

/**
 * Count lines an editor would address. A file's terminating newline closes the last line rather
 * than opening a new one, so `"one\n"` is one addressable line — counting the split remainder
 * would accept a `:2` reference that no editor can show. An empty file has no line to address,
 * but a file holding only a newline has one empty line, so the two cases differ.
 */
function countAddressableLines(contents: string): number {
  if (contents === '') return 0;
  const body = contents.replace(/\r?\n$/, '');
  return body === '' ? 1 : body.split(/\r?\n/).length;
}

const TRACED_PATH_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
// ⛔⭐⭐⭐ 2026-08-11 — 이 문면은 «통하지 않는 처방»을 첫 번째로 권하고 있었다.
//   옛 문면: *"Re-authoring the same input may produce different evidence; **retry before changing the ask**."*
//   📏 실측(두 트랙 합산): 그 말대로 «재저작»만 반복했더니 ***0/4***. ask 에 «식별자 앵커»를 넣자 ***2/2***.
//   ⛔ 즉 정답(ask 를 고치는 것)을 «하지 말라»고 안내했고, 저작 한 번이 100초 넘으니 시간 비용이었다.
//   ⚠️ 그리고 같은 상황의 «되묻기»(`implementation_anchor`)는 이미 앵커를 요구한다 —
//      ***문장과 되묻기가 서로 다른 말을 하고 있었다.***
//   ⭐ 앵커는 «그 파일이 내보내는 이름»이어야 한다 — 파일 «안»의 비공개 상수를 앵커로 준 시도는 실패했다.
//   ⛔⭐⭐ 그리고 «앵커만으로는 부족하다»(같은 날 🅣 실측 0/3): 서술 → 줄번호+지역변수 → export 식별자를
//     차례로 줘도 «셋 다» 같은 실패였다. 이 문면이 처음부터 그 이유를 말하고 있었다 —
//     *"identifies locations and exported facts, but does not establish behavior, causation, or call path"*.
//     ⇒ ***요구는 「식별자」가 아니라 「지금 무엇을 하고 그게 왜 문제인가」다.***
//     📌 그래서 ***「필드를 하나 더 실어라」 같은 «순수 추가» 골은 인과가 «없어» 여기서 자주 막힌다.***
//     (🅢 골 셋이 통과한 이유도 앵커가 아니라 「지금 이렇게 도는데 그게 문제다」를 적었기 때문이다.)
//   📚 그리고 방법론 문서에 답이 이미 있었는데 이 문장이 그것을 «한 글자도» 안 가리켰다.
const TRACED_PATHS_EVIDENCE_UNAVAILABLE = 'Evidence unavailable — grounding found no persistent evidence and the cause remains undifferentiated. Grounding needs behavior and causation, not only locations: state what the target code does today and why that is a problem, and name a function, constant, or type that the target file exports. A pure-addition ask ("also record field X") often fails here because it names no current behavior to ground. Re-authoring the same input may also produce different evidence, but try that first. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
const TRACED_PATHS_PERSISTENT_CHANNEL_UNAVAILABLE = /^Evidence unavailable — grounding found \d+ categorized evidence items, but no persistent evidence; only the persistent channel is empty\. Strengthening the ask's prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead\. See docs\/manual\/MANUAL-goal-authoring-method-2026-08-03\.md$/;

function tracedPathsEvidenceUnavailable(evidenceCount: number, groundedCount: number): string {
  return evidenceCount > 0 && groundedCount === 0
    ? `Evidence unavailable — grounding found ${evidenceCount} categorized evidence items, but no persistent evidence; only the persistent channel is empty. Strengthening the ask's prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md`
    : TRACED_PATHS_EVIDENCE_UNAVAILABLE;
}

type GroundingFailureRoot = 'request-needs-current-behavior' | 'working-directory-not-repository' | 'grounding-query-failed' | 'grounding-query-incomplete' | 'undifferentiated';

interface GroundingFailureClassificationInput {
  categorizedEvidenceCount: number;
  persistentEvidenceCount: number;
  persistentStopReason?: string;
  codeChannel?: CodebaseGrounding['codeChannel'];
  /** A caller-observed search-root classification; absent observations are not inferred. */
  workingDirectory?: 'repository' | 'outside-repository';
}

interface GroundingFailureClassification {
  root: GroundingFailureRoot;
  prescription: string;
}

const REQUEST_NEEDS_CURRENT_BEHAVIOR_PRESCRIPTION = 'Grounding completed in the repository but found no persistent evidence. Revise the request to state the target code’s current behavior and why it is a problem; do not rely on locations alone.';
const WORKING_DIRECTORY_NOT_REPOSITORY_PRESCRIPTION = 'Grounding completed outside the repository worktree. Correct the grounding working directory and retry; do not revise the request.';
const GROUNDING_QUERY_FAILED_PRESCRIPTION = 'Grounding query failed. Restore the grounding query and retry; do not revise the request.';
const GROUNDING_QUERY_INCOMPLETE_PRESCRIPTION = 'Grounding query did not complete. Retry or restore the grounding query; do not revise the request.';

/**
 * Classify only mutually consistent, directly observed grounding failure signals.
 * The undifferentiated branch deliberately retains the legacy diagnostic because
 * missing or contradictory signals cannot safely prescribe a request rewrite.
 */
export function classifyGroundingFailure(input: GroundingFailureClassificationInput): GroundingFailureClassification {
  const legacyPrescription = tracedPathsEvidenceUnavailable(input.categorizedEvidenceCount, input.persistentEvidenceCount);
  const noPersistentEvidence = input.persistentEvidenceCount === 0;
  const completed = input.codeChannel === 'ok' && input.persistentStopReason === 'goal_complete';

  if (input.codeChannel === 'failed' && input.persistentStopReason === undefined) {
    return { root: 'grounding-query-failed', prescription: GROUNDING_QUERY_FAILED_PRESCRIPTION };
  }
  if (input.codeChannel === 'incomplete' && input.persistentStopReason !== undefined && input.persistentStopReason !== 'goal_complete') {
    return { root: 'grounding-query-incomplete', prescription: GROUNDING_QUERY_INCOMPLETE_PRESCRIPTION };
  }
  if (completed && noPersistentEvidence && input.workingDirectory === 'outside-repository') {
    return { root: 'working-directory-not-repository', prescription: WORKING_DIRECTORY_NOT_REPOSITORY_PRESCRIPTION };
  }
  if (completed && input.categorizedEvidenceCount === 0 && noPersistentEvidence && input.workingDirectory === 'repository') {
    return { root: 'request-needs-current-behavior', prescription: REQUEST_NEEDS_CURRENT_BEHAVIOR_PRESCRIPTION };
  }
  return { root: 'undifferentiated', prescription: legacyPrescription };
}

function isTracedPathsEvidenceUnavailable(entry: string): boolean {
  return entry === TRACED_PATHS_EVIDENCE_UNAVAILABLE || TRACED_PATHS_PERSISTENT_CHANNEL_UNAVAILABLE.test(entry);
}
// ⭐ 행 **범위**(`:736-737`)까지 받는다 — 안 받으면 범위가 경로에 붙어 실재 파일을 missing 으로 읽는다.
//   `[T]` 원장 `GOAL-T10` 실측: *"정확히 쓸수록 벌받는다"*(표기를 흐리게 해야 통과했다).
const TRACED_PATH_LINE = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/;
const INLINE_CODE_WRAPPED = /^(`+)([^`]*)\1$/;
const TRACED_PATH_DESCRIPTION_DELIMITER = /\s+(?:—|-)\s+|:\s+/;
/** 저작기가 「관련 있어 보이지만 여기가 아니다」를 말하려고 적은 항목 — 추적 경로가 아니다.
 *  ⚠️ 지금은 영어 문면만 문다(저작기 산출이 영어다). 한국어 배제 문장은 아직 안 잡는다. */
const TRACED_PATH_EXCLUSION_DESCRIPTION = /\b(?:related|relevant)\b.*\b(?:but|however)\b.*\b(?:not here|elsewhere|another (?:location|place|path))\b|\b(?:not here|elsewhere|another (?:location|place|path))\b.*\b(?:related|relevant)\b/i;

function isTracedPathExclusionDescription(item: string): boolean {
  const description = item.split(TRACED_PATH_DESCRIPTION_DELIMITER).slice(1).join(' — ').trim();
  return description.length > 0 && TRACED_PATH_EXCLUSION_DESCRIPTION.test(description);
}

/**
 * Strip a matched pair of markdown inline-code backticks that wraps the whole field, if present.
 *
 * ⛔ 벗긴 결과가 비면 **벗지 않는다**. 빈 인라인 코드(`` `` ``)를 빈 경로로 만들면 호출부의
 * `if (!path) continue` 에 걸려 **검사 자체가 건너뛰어진다** — 벗기기 도입 전에는 missing ERROR 였다.
 * 관대한 파싱이 검사를 무르게 하면 안 된다(리뷰 must-fix · 2026-08-02).
 */
function stripInlineCode(field: string): string {
  const inner = INLINE_CODE_WRAPPED.exec(field)?.[2].trim();
  return inner ? inner : field;
}

function outOfTargetRequirementPaths(document: string): string[] {
  const [firstLine] = document.split(METADATA_LINE_BOUNDARY);
  const targetPaths = TARGET_PATH_LABEL.exec(firstLine ?? '')?.[1]
    .split('·')
    .map((path) => path.trim())
    .filter(Boolean);
  if (!targetPaths?.length) return [];

  const paths = new Set<string>();
  for (const line of document.split(METADATA_LINE_BOUNDARY)) {
    if (!REQUESTED_CRITERION_LINE.test(line)) continue;
    for (const match of line.matchAll(SOURCE_PATH)) {
      const path = match[0];
      if (!targetPaths.includes(path)) paths.add(path);
    }
  }
  return [...paths];
}

export function tracedPathReferences(document: string): TracedPathReference[] {
  const section = markdownSection(document, 'TRACED PATHS');
  if (!section) return [];
  const references: TracedPathReference[] = [];
  for (const line of section.split(/\r?\n/)) {
    const item = TRACED_PATH_LIST_ITEM.exec(line)?.[1];
    if (!item) continue;
    const evidence = item.replace(/^\[(?:code|skill|memory|doc|pty|unknown)\]\s+/, '');
    if (isTracedPathsEvidenceUnavailable(evidence) || isTracedPathExclusionDescription(evidence)) continue;
    // 설명 구분자는 **공백으로 둘러싼** em dash 또는 hyphen 뿐이다 — 파일명 안의 dash 를 설명 구분자로 오인하지 않는다.
    // 경로 칸 안의 복수 경로는 **공백으로 둘러싼** 가운뎃점만 본다 — 파일명 안의 `·` 를 가르지 않는다.
    // ⭐ 인라인 코드 표기(`path`)를 벗긴다 — 저작기는 맨 경로를 쓰지만 사람이 쓴 골과 이 레포의 다른 문서는
    //   백틱을 쓴다. 안 벗기면 실재하는 파일을 "does not exist" 로 판정해 **자가 거짓 ERROR 를 낸다**(실측 2026-08-02).
    const pathField = evidence.split(TRACED_PATH_DESCRIPTION_DELIMITER, 1)[0].trim();
    for (const fragment of pathField.split(' · ')) {
      const trimmed = fragment.trim();
      if (!trimmed) continue;
      const unwrapped = stripInlineCode(trimmed);
      const match = TRACED_PATH_LINE.exec(unwrapped);
      // 두 번 벗긴다 — 줄번호가 백틱 **안**(`p:42`)일 수도 **밖**(`p`:42)일 수도 있다.
      const path = match ? stripInlineCode(match[1].trim()) : undefined;
      if (!path) continue;
      references.push({ path, line: match?.[2] ? Number(match[2]) : null, endLine: match?.[3] ? Number(match[3]) : null });
    }
  }
  return references;
}

/**
 * AUTO-TARGET (10-08 canary · TSC-HEAP run-446cdc71): an authored goal whose `## PROBLEM` Situation line says
 * NOT-GROUNDED has no persistent (Read-verified) evidence — `scqaNarrative` writes NOT-GROUNDED exactly when that
 * channel is empty, and `## TRACED PATHS` then carries no path. Such a goal is a scope card, not an implementation
 * goal: any target path it carries was not verified by grounding. Callers that know a path was machine-suggested
 * (not written by the human) must not launch on it. Lite goals have no Situation line and return false.
 */
export function isNotGroundedWithoutPersistentEvidence(document: string): boolean {
  const problem = markdownSection(document, 'PROBLEM');
  if (problem === null) return false;
  const situation = problem.split(/\r?\n/).find((line) => line.startsWith('Situation: '));
  return situation !== undefined && situation.startsWith('Situation: NOT-GROUNDED') && tracedPathReferences(document).length === 0;
}

/** Inspect supplied goal text and branch name, optionally validating traced paths through an injected reader. */
/**
 * Lint findings plus the number of inline invariant markers recognized for judgment candidates.
 * The count deliberately excludes heading-form markers, which remain diagnostic-only WARNs.
 */
export interface SelfQuestionSubjectViolation {
  readonly clause: string;
  readonly subject: string;
}

const SELF_QUESTION_CLAUSE_BOUNDARY = /[.!?\n:;,]+|(?:^|[\s.!?\n:;,])(?:그리고|그러나|하지만|또한|한편|다만|따라서|그래서)(?=\s)\s*/;
const SELF_QUESTION_PREDICATE = '(?:다시\\s*)?(?:조사(?:·확인)?|확인(?:·조사)?)(?:을|를)?\\s*(?:해야(?:\\s*(?:한다|합니다))?|한다|합니다)';
const SELF_QUESTION_PREDICATE_GLOBAL = new RegExp(SELF_QUESTION_PREDICATE, 'g');
const SELF_QUESTION_SUBJECT = /(?:^|\s)(?:(?<goal>이 골)이|(?<target>이 목표)가)\s*$/;

/** Detect inquiry or verification clauses whose actor is the goal itself. */
export function detectSelfQuestionSubjectViolations(document: string): SelfQuestionSubjectViolation[] {
  const violations: SelfQuestionSubjectViolation[] = [];
  for (const candidate of document.split(SELF_QUESTION_CLAUSE_BOUNDARY)) {
    let clauseStart = 0;
    for (const predicate of candidate.matchAll(SELF_QUESTION_PREDICATE_GLOBAL)) {
      const subjectCandidate = candidate.slice(clauseStart, predicate.index).trim();
      clauseStart = (predicate.index ?? 0) + predicate[0].length;
      const subjectGroups = SELF_QUESTION_SUBJECT.exec(subjectCandidate)?.groups;
      const subject = subjectGroups?.goal ?? subjectGroups?.target;
      if (!subject) continue;
      violations.push({ clause: `${subjectCandidate} ${predicate[0]}`.trim(), subject });
    }
  }
  return violations;
}

export interface GoalFileLintResult extends Array<GoalFileLintFinding> {
  readonly recognizedInvariantCount: number;
  /** Heading-form author labels are observational only; they never become recognized markers. */
  readonly headingFormMarkerLabels: readonly string[];
  readonly prohibitionSymbolStartingLineCount: number;
  readonly permissionSymbolStartingLineCount: number;
  readonly mixedSymbolLineCount: number;
  /** Count-only observation of exhaustive-request wording in the verbatim ask. */
  readonly exhaustiveRequestWordingCount: number;
  /** Count-only observation of blanket behavior-preservation clauses without named targets. */
  readonly blanketBehaviorPreservationCount: number;
  /** Count-only observation of behavior-preservation clauses with named targets. */
  readonly namedPreservationTargetCount: number;
  /** Count-only observation of removal-form conditions in verbatim ask decision signals. */
  readonly removalFormDecisionConditionCount: number;
  /** 진단 전용: `## TRACED PATHS` 항목 중 «배제 설명»으로 분류된 수.
   *  ⛔ 선택형은 «의도»다 — 필수 export 필드는 tsc 게이트를 저장소 전체 범위로 승격시키고,
   *  그러면 이 변경과 무관한 `test/**` 기존 부채에 막힌다(2026-08-24 실측 76건 · 이 변경엔 0건). */
  readonly tracedPathExclusionCount?: number;
  /** Diagnostic-only count of inquiry clauses whose subject is the goal itself. */
  readonly selfQuestionSubjectViolationCount?: number;
  /** Optional observation of lint tags with a known provenance; populated by the execution path when available. */
  readonly knownOriginTagCount?: number;
  /** Optional observation of lint tags whose provenance is a documented incident. */
  readonly knownIncidentOriginTagCount?: number;
  /** Local launch-declaration classification observed while linting the current document. */
  readonly artifactLaunchDeclarationClassification?: ArtifactLaunchDeclarationClassification;
}

export function lintGoalFile(document: string, branch: string, deps: GoalFileLintDeps = {}): GoalFileLintResult {
  const findings: GoalFileLintFinding[] = [];
  const ask = verbatimOriginalAsk(document) ?? '';
  const recognizedInvariantCount = recognizedInvariantCandidates(ask).length;
  const headingFormMarkerLabels = recognizedInvariantCount === 0 ? collectHeadingFormMarkerLabels(ask) : [];
  const { prohibitionSymbolStartingLineCount, permissionSymbolStartingLineCount, mixedSymbolLineCount } = symbolStartingLineCounts(document);
  const { exhaustiveRequestWordingCount, blanketBehaviorPreservationCount, namedPreservationTargetCount, removalFormDecisionConditionCount } = goalAuthorKnownShapeCounts(ask);
  const tracedPathExclusionCount = (markdownSection(document, 'TRACED PATHS')?.split(/\r?\n/) ?? [])
    .map((line) => TRACED_PATH_LIST_ITEM.exec(line)?.[1])
    .filter((item): item is string => item !== undefined
      && isTracedPathExclusionDescription(item.replace(/^\[(?:code|skill|memory|doc|pty|unknown)\]\s+/, ''))).length;
  const selfQuestionSubjectViolations = detectSelfQuestionSubjectViolations(document);
  const launchDeclarationClassification = artifactLaunchDeclarationClassification(document);
  const headings = canonicalBlocks(document);
  const goalType = parseGoalType(document);
  if (goalType === null) {
    findings.push(canonicalStructureFinding('invalid-goal-type', 'ERROR', `GoalType must be one of: ${GOAL_TYPES.join(', ')}`));
  }
  const expected = [...requiredBlocksForGoalType(goalType ?? 'implement')];
  const missing = expected.filter((heading) => !headings.includes(heading));
  for (const heading of missing) {
    findings.push(canonicalStructureFinding(
      'missing-required-section',
      ERROR_REQUIRED_BLOCKS.has(heading) ? 'ERROR' : 'WARN',
      `missing required section: ${heading}`,
    ));
  }
  const canonicalHeadings = canonicalGoalHeadings(expected, headings.includes('## STEPS'));
  const firstRequired = headings.indexOf(expected[0]);
  const actualStructure = headings.slice(firstRequired, firstRequired + canonicalHeadings.length);
  // ⛔⭐ **창(window) 밖은 이 비교가 «안 본다»** — `slice` 는 고정 길이라 정상 위치 `## STEPS` 를
  //   둔 채 문서 «앞»이나 «끝»에 하나 더 놓으면 창에 안 들어와 «조용히» 통과했다(무인 리뷰 must-fix ①②).
  //   ⇒ 그래서 순서만이 아니라 ***개수***를 같은 조건에 넣는다. 선택 절은 「한 번만, 지정 위치에만」이다.
  const stepsHeadingCount = headings.filter((heading) => heading === '## STEPS').length;
  const expectedStepsCount = canonicalHeadings.includes('## STEPS') ? 1 : 0;
  const presentCanonicalHeadings = canonicalHeadings.filter((heading) => headings.includes(heading));
  const hasPresentSectionOrderInversion = presentCanonicalHeadings.some((heading, index) => {
    if (index === 0) return false;
    return headings.indexOf(heading) < headings.indexOf(presentCanonicalHeadings[index - 1] as string);
  });
  if (firstRequired < 0 || actualStructure.length !== canonicalHeadings.length
    || actualStructure.some((heading, index) => heading !== canonicalHeadings[index])
    || stepsHeadingCount !== expectedStepsCount) {
    findings.push(canonicalStructureFinding(
      'required-section-order',
      'ERROR',
      `required sections must appear in canonical order: ${canonicalHeadings.join(' → ')}`,
      hasPresentSectionOrderInversion || stepsHeadingCount !== expectedStepsCount ? 'present-section-order' : 'missing-required-section',
    ));
  }
  const evidence = markdownSection(document, 'REQUIRED EVIDENCE');
  // ⛔ 존재성 검사(`.some`)가 아니다 — 유효 항목 하나가 다른 무태그 항목의 누락을 가린다(리뷰 must-fix).
  //   섹션의 모든 목록 항목을 개별 파싱해 각각 비어 있지 않은 [태그]와 설명을 요구한다.
  const listItems = (evidence?.split(/\r?\n/) ?? []).filter(isRequiredEvidenceEntryLine);
  const untaggedItems = listItems.filter((line) => {
    const match = REQUIRED_EVIDENCE_ENTRY.exec(line);
    return !(match?.[1].trim() && match[2].trim());
  });
  if (untaggedItems.length === listItems.length) {
    findings.push({ level: 'ERROR', tag: 'evidence-section', message: '## REQUIRED EVIDENCE must contain at least one - [tag] description entry' });
  } else if (untaggedItems.length) {
    findings.push({ level: 'ERROR', tag: 'evidence-section', message: `## REQUIRED EVIDENCE has entries missing a - [tag] description: ${untaggedItems.map((line) => line.trim()).join(' | ')}` });
  }
  for (const finding of askSectionCountLintFindings(document)) findings.push(finding);
  for (const finding of headingFormMarkerLintFindings(document)) findings.push(finding);
  for (const finding of blanketInvariantLintFindings(document)) findings.push(finding);
  const releaseNote = parseReleaseNoteSection(document);
  for (const problem of releaseNote.problems) {
    findings.push({
      level: 'WARN', tag: 'release-note',
      message: `## 릴리스 노트 ${problem} invalid or missing; use - 한 줄: English summary, - 종류: feat|fix|security|internal (feature → feat), - 문서: path or 없음(이유), - 대상: next|later`,
    });
  }
  if (releaseNote.fragment || releaseNote.problems.length) {
    const section = markdownSection(document, '릴리스 노트') ?? '';
    const kind = releaseNote.fragment?.kind ?? /^[ \t]*- 종류:[ \t]*(.*?)[ \t]*$/m.exec(section)?.[1];
    const line = releaseNote.fragment?.line ?? /^[ \t]*- 한 줄:[ \t]*(.*?)[ \t]*$/m.exec(section)?.[1];
    if (kind && ['feat', 'fix', 'security'].includes(kind) && line && /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(line)) {
      findings.push({ level: 'WARN', tag: 'release-note', message: '## 릴리스 노트 한 줄: 공개 노트에 실리는 문장은 영어로(internal 은 한국어 무방)' });
    }
  }
  for (const violation of selfQuestionSubjectViolations) {
    findings.push({
      level: 'WARN',
      tag: 'self-question-subject',
      message: `inquiry or verification clause must not use the goal itself as its subject: ${violation.clause}`,
    });
  }
  if (launchDeclarationClassification === 'absent-with-signal') {
    findings.push({
      level: 'WARN',
      tag: 'artifact-launch-declaration',
      message: 'goal has a structured server entry path or loopback address with port but no artifact launch declaration',
    });
  }
  const boundary = markdownSection(document, 'SCOPE BOUNDARY');
  if (boundary !== null) {
    const boundaryLines = boundary.split(/\r?\n/);
    const candidateStart = boundaryLines.findIndex((line) => line.includes(SCOPE_BOUNDARY_CANDIDATES_MARKER));
    const candidateEnd = candidateStart < 0 ? -1 : boundaryLines.findIndex((line, index) => index > candidateStart && line === SCOPE_BOUNDARY_CANDIDATES_FOOTER);
    const hasCandidates = candidateStart >= 0;
    const boundaryDecisionCount = boundaryLines.filter((line) => line.startsWith('- Boundary decision:')).length;
    if (hasCandidates && boundaryDecisionCount === 0) {
      findings.push({ level: 'WARN', tag: 'boundary-size', message: '## SCOPE BOUNDARY contains unselected scope-boundary candidates; select decisions before evaluating boundary size' });
    }
    // Candidate-excluded boundary size: the advisory block is generated context, not a human boundary decision.
    // Its marker through footer is excluded so the unchanged 1,800-character limit measures only selected decisions.
    const measuredBoundary = candidateEnd >= candidateStart
      ? [...boundaryLines.slice(0, candidateStart), ...boundaryLines.slice(candidateEnd + 1)].join('\n')
      : boundary;
    if (measuredBoundary.trim().length > SCOPE_BOUNDARY_MAX_CHARS) {
      findings.push({ level: 'WARN', tag: 'boundary-size', message: `## SCOPE BOUNDARY exceeds ${SCOPE_BOUNDARY_MAX_CHARS} characters` });
    }
  }
  if (branch !== 'main') findings.push({ level: 'WARN', tag: 'launch-branch', message: `current branch is ${branch || '(detached)'}, not main` });
  const outOfTargetPaths = outOfTargetRequirementPaths(document);
  if (outOfTargetPaths.length) {
    findings.push({
      level: 'WARN',
      tag: 'out-of-target-requirement',
      message: `requested criterion references path outside 대상 경로: ${outOfTargetPaths.join(', ')}`,
    });
  }
  const unansweredClarifications = parseGoalDocumentClarifications(document).filter((clarification) => !clarification.answered);
  if (unansweredClarifications.length) {
    const truncate = (value: string, maxChars: number): { value: string; truncated: boolean } => {
      const truncated = value.length > maxChars;
      return { value: truncated ? `${value.slice(0, maxChars)}…` : value, truncated };
    };
    const renderedClarifications = unansweredClarifications.map((clarification) => {
      const question = truncate(clarification.question, UNANSWERED_CLARIFICATION_QUESTION_MAX_CHARS);
      const optionText = clarification.options.map((option) => `${option.label}: ${option.description}`).join(' | ');
      const options = truncate(optionText, UNANSWERED_CLARIFICATION_OPTIONS_MAX_CHARS);
      return `${clarification.questionId} { question="${question.value}"; questionTruncated=${question.truncated}; options=${optionText ? `"${options.value}"` : 'none'}; optionsTruncated=${options.truncated} }`;
    });
    findings.push({
      level: 'WARN',
      tag: 'unanswered-clarification',
      message: `${unansweredClarifications.length} unanswered clarification${unansweredClarifications.length === 1 ? '' : 's'}: ${renderedClarifications.join(', ')}`,
    });
  }
  if (shellDamageBlocks(document).some(containsEmptyInlineCode)) findings.push({ level: 'WARN', tag: 'shell-damage', message: 'goal file contains empty inline code' });
  const decisionSignal = markdownSection(document, '판정 신호') ?? '';
  // 저자 행동은 판정 결과를 선언한 `Expected result` 행의 수에만 요구한다. 관측 경로·줄번호와
  // 명령 옵션은 그 행 밖에 있어 수용 기준 숫자로 해석되지 않는다.
  const expectedResults = [...decisionSignal.matchAll(/^\s*-\s*Expected result:\s*(.+)$/gm)].map((match) => match[1]);
  const acceptanceNumbers = expectedResults.flatMap((expectedResult) => expectedResult.match(/\d+/g) ?? []);
  if (acceptanceNumbers.length) {
    const hasNumericSource = /^\s*-\s*(?:(?:수용\s*기준|숫자|numeric)\s+)?(?:숫자\s+)?(?:출처|source)\s*:\s*\S/mui.test(decisionSignal);
    const hasNumericCoverage = /^\s*-\s*(?:(?:수용\s*기준|숫자|numeric)\s+)?(?:숫자\s+)?(?:적용\s*범위|coverage)\s*:\s*\S/mui.test(decisionSignal);
    if (!hasNumericSource) {
      findings.push({
        level: 'WARN',
        tag: 'decision-signal-numeric-source',
        message: '## 판정 신호 uses Arabic digits in Expected result without a non-empty source entry (for example, `- 숫자 출처: measurement output`).',
      });
    }
    if (!hasNumericCoverage) {
      findings.push({
        level: 'WARN',
        tag: 'decision-signal-numeric-coverage',
        message: '## 판정 신호 uses Arabic digits in Expected result without a non-empty coverage entry (for example, `- 숫자 적용 범위: all matching documents`).',
      });
    }
  }
  const claimsEmptyResultPass = /(?:0\s*건|영\s*건|zero\s+(?:results?|items?))\s*(?:이면|일\s*때|when|if)?\s*(?:통과|pass)/i.test(decisionSignal);
  const declaresPopulation = /(?:후보|대상|모집단|셀\s*대상)\s*(?:가|은|는)?\s*(?:하나\s*이상|1\s*(?:개|건)\s*이상|one\s+or\s+more|at\s+least\s+one)/i.test(decisionSignal);
  if (claimsEmptyResultPass && !declaresPopulation) {
    findings.push({
      level: 'WARN',
      tag: 'empty-result-population',
      message: '## 판정 신호 permits an empty result to pass without declaring a population',
    });
  }
  const proxyExpectationLiterals = ['두 값이 서로 다르다', '값이 바뀐다', '필드가 채워진다', '함수가 존재한다', '호출이 한 번이다'];
  const proxyExpectationPatterns = [/`?0\s*fail(?:ed|ure)?s?`?/i, /(?:테스트(?:가|는)?|tests?)\s*(?:결과(?:가|는)?\s*)?(?:모두\s*)?(?:통과|pass(?:ed)?)/i, /(?:exit\s*(?:code\s*)?0|종료\s*코드\s*0)/i];
  const proxyExpectations = [
    ...proxyExpectationLiterals.filter((literal) => expectedResults.some((expectedResult) => expectedResult.includes(literal))),
    ...proxyExpectationPatterns.flatMap((pattern) => expectedResults.flatMap((expectedResult) => expectedResult.match(pattern) ?? [])),
  ];
  for (const proxyExpectation of proxyExpectations) {
    findings.push({
      level: 'WARN',
      tag: 'decision-signal-proxy-expectation',
      message: `## 판정 신호 Expected result uses proxy metric \`${proxyExpectation}\`; replace it with the intended outcome (for example, final-consumer delivery, comparative cost, or directional behavior).`,
    });
  }
  const decisionSignalShape = inspectAskDecisionSignalMarker(ask || document);
  const hasUnambiguousPresenceExpectation = decisionSignalShape.matches.some(
    (match) => match.expectsPresence === true || match.expectsPresence === null,
  );
  if (decisionSignalShape.extracted && !hasUnambiguousPresenceExpectation) {
    findings.push(decisionSignalShape.unreadableCount > 0
      ? {
          level: 'WARN',
          tag: 'unreadable-signals',
          message: unreadableSignalsLintMessage(),
        }
      : {
          level: 'WARN',
          tag: 'all-negative-signals',
          message: allNegativeSignalsLintMessage(),
        });
  }
  if (decisionSignalShape.anyAlternatives) {
    findings.push({
      level: 'WARN',
      tag: 'alternative-signals',
      message: '## 판정 신호 expected result opens alternative branches',
    });
  }
  if (decisionSignalShape.anyObservesCount) {
    findings.push({
      level: 'WARN',
      tag: 'count-observation',
      message: '## 판정 신호 observation measures a count rather than content',
    });
  }
  if (decisionSignalShape.anyObservesSelfReportedField) {
    findings.push({
      level: 'WARN',
      tag: 'self-reported-observation',
      message: '## 판정 신호 observation measures a value the implementation fills in itself (a field, flag, or return value), so a child passes by writing that value even when the behavior never happens. Observe a result the implementation cannot fake instead: a pixel height, a byte count, a file that exists, an exit code.',
    });
  }
  if (decisionSignalShape.anyObservesIdentifierNames) {
    findings.push({
      level: 'WARN',
      tag: 'identifier-name-observation',
      message: '## 판정 신호 observation measures the presence of identifier names (test/function/field names) rather than behavior; a child satisfies it most cheaply with a test that greps its own source, which passes even if every named test body is emptied. Observe what those names are supposed to do instead.',
    });
  }
  const missingDefaultInvocation = runnableScriptEntriesMissingDefaultInvocation(document);
  if (missingDefaultInvocation.length) {
    findings.push({
      level: 'WARN',
      tag: 'default-invocation-observation',
      message: defaultInvocationObservationMessage(missingDefaultInvocation),
    });
  }
  const unavailableTracedPathEvidence = markdownSection(document, 'TRACED PATHS')?.split(/\r?\n/)
    .map((line) => TRACED_PATH_LIST_ITEM.exec(line)?.[1])
    .find((item): item is string => item !== undefined && isTracedPathsEvidenceUnavailable(item));
  if (unavailableTracedPathEvidence) {
    const requiresTracedPaths = goalType === null || goalType === 'implement';
    findings.push({
      level: requiresTracedPaths ? 'ERROR' : 'WARN',
      tag: 'grounding-evidence',
      message: requiresTracedPaths
        ? unavailableTracedPathEvidence
        : `${unavailableTracedPathEvidence} GoalType ${goalType} does not require ## TRACED PATHS.`,
    });
  }
  if (deps.readReferencedFile) {
    for (const reference of tracedPathReferences(document)) {
      const result = deps.readReferencedFile(reference.path);
      const normalized = typeof result === 'string' ? { kind: 'ok' as const, contents: result }
        : result === null ? { kind: 'missing' as const }
        : result;
      if (normalized.kind === 'missing') {
        findings.push({ level: 'ERROR', tag: 'traced-path', message: `traced path does not exist: ${reference.path}` });
      } else if (normalized.kind === 'outside-repository') {
        findings.push({ level: 'ERROR', tag: 'traced-path', message: `traced path is outside repository: ${reference.path}` });
      } else if (normalized.kind === 'directory') {
        findings.push({ level: 'WARN', tag: 'traced-path', message: `traced path is a directory: ${reference.path}` });
      } else if (normalized.kind === 'read-error') {
        findings.push({ level: 'ERROR', tag: 'traced-path', message: `traced path could not be read: ${reference.path}` });
      } else if (normalized.kind === 'ok' && reference.line !== null) {
        const lineCount = countAddressableLines(normalized.contents);
        // 범위(`:start-end`)는 **양 끝을 다 검사**한다 — 시작만 보면 끝이 파일 밖이어도 통과한다.
        const outOfRange = [reference.line, reference.endLine].filter((n): n is number => n !== null && (n < 1 || n > lineCount));
        for (const n of outOfRange) {
          findings.push({ level: 'ERROR', tag: 'traced-path', message: `traced path line ${n} is out of range: ${reference.path}` });
        }
        if (!outOfRange.length && reference.endLine !== null && reference.endLine < reference.line) {
          findings.push({ level: 'ERROR', tag: 'traced-path', message: `traced path line range ${reference.line}-${reference.endLine} is inverted: ${reference.path}` });
        }
      }
    }
  }
  const knownOriginTagCount = Object.values(GOAL_FILE_LINT_ORIGINS)
    .filter((origin) => origin.kind === 'known-incident').length;
  const knownIncidentOriginTagCount = knownOriginTagCount;
  Object.defineProperties(findings, {
    recognizedInvariantCount: { value: recognizedInvariantCount, enumerable: false },
    headingFormMarkerLabels: { value: headingFormMarkerLabels, enumerable: false },
    prohibitionSymbolStartingLineCount: { value: prohibitionSymbolStartingLineCount, enumerable: false },
    permissionSymbolStartingLineCount: { value: permissionSymbolStartingLineCount, enumerable: false },
    mixedSymbolLineCount: { value: mixedSymbolLineCount, enumerable: false },
    exhaustiveRequestWordingCount: { value: exhaustiveRequestWordingCount, enumerable: false },
    blanketBehaviorPreservationCount: { value: blanketBehaviorPreservationCount, enumerable: false },
    namedPreservationTargetCount: { value: namedPreservationTargetCount, enumerable: false },
    removalFormDecisionConditionCount: { value: removalFormDecisionConditionCount, enumerable: false },
    tracedPathExclusionCount: { value: tracedPathExclusionCount, enumerable: false },
    selfQuestionSubjectViolationCount: { value: selfQuestionSubjectViolations.length, enumerable: false },
    artifactLaunchDeclarationClassification: { value: launchDeclarationClassification, enumerable: false },
    knownOriginTagCount: { value: knownOriginTagCount, enumerable: false },
    knownIncidentOriginTagCount: { value: knownIncidentOriginTagCount, enumerable: false },
  });
  return findings as GoalFileLintResult;
}

function symbolStartingLineCounts(document: string): {
  prohibitionSymbolStartingLineCount: number;
  permissionSymbolStartingLineCount: number;
  mixedSymbolLineCount: number;
} {
  let prohibitionSymbolStartingLineCount = 0;
  let permissionSymbolStartingLineCount = 0;
  let mixedSymbolLineCount = 0;
  for (const line of document.split(/\r\n|[\n\r\u2028\u2029]/)) {
    const trimmed = line.trimStart();
    const startsWithProhibitionSymbol = trimmed.startsWith('⛔');
    const startsWithPermissionSymbol = trimmed.startsWith('✅');
    if (!startsWithProhibitionSymbol && !startsWithPermissionSymbol) continue;
    if (trimmed.includes('⛔') && trimmed.includes('✅')) {
      mixedSymbolLineCount++;
    } else if (startsWithProhibitionSymbol) {
      prohibitionSymbolStartingLineCount++;
    } else {
      permissionSymbolStartingLineCount++;
    }
  }
  return { prohibitionSymbolStartingLineCount, permissionSymbolStartingLineCount, mixedSymbolLineCount };
}

/** Parser-recognized inline invariants are exactly the candidates supplied to invariant judgment. */
function recognizedInvariantCandidates(ask: string): AskMatch<string>[] {
  return orderedAskMatches([
    ...askInvariantCandidates(ask),
    ...normalizeUnparsedMarkerSegments(ask, ASK_INVARIANT_MARKER, '불변식', ASK_INVARIANT),
  ]);
}

function goalAuthorKnownShapeCounts(ask: string): {
  exhaustiveRequestWordingCount: number;
  blanketBehaviorPreservationCount: number;
  namedPreservationTargetCount: number;
  removalFormDecisionConditionCount: number;
} {
  const clauses = preservationClauses(ask);
  const preservation = clauses.filter(isBehaviorPreservationClause);
  return {
    exhaustiveRequestWordingCount: (ask.match(/전수로|모두\s*찾|빠짐없이/gu) ?? []).length,
    blanketBehaviorPreservationCount: preservation.filter((clause) => isBlanketBehaviorPreservationClause(clause) && !namesPreservationTarget(clause)).length,
    namedPreservationTargetCount: preservation.filter(namesPreservationTarget).length,
    removalFormDecisionConditionCount: [...ask.matchAll(/(?:^|\n)\s*(?:[-*+]\s*)?(?:판정\s*신호\s*:\s*)?조건\s*=\s*[^\n]*(?:제거(?:한|된)?|없앤?\s*(?:뒤|후)?)/gmu)].length,
  };
}

function isBehaviorPreservationClause(clause: string): boolean {
  return /(?:동작|기능|행동|behavior|behaviors).{0,40}(?:바꾸지\s*않|변경하지\s*않|유지|보존|remain)|(?:유지|보존|바꾸지\s*않|변경하지\s*않|remains?\s+unchanged).{0,40}(?:모든|전체)?\s*(?:동작|기능|행동|behavior|behaviors)/iu.test(clause);
}

function blanketInvariantLintFindings(document: string): GoalFileLintFinding[] {
  const ask = verbatimOriginalAsk(document);
  if (ask === null) return [];
  const clauses = preservationClauses(ask);
  return clauses
    .filter((clause, index) => isBlanketInvariant(clause)
      && !namesPreservationTarget(clause)
      && !namesScopeFollowingClause(clauses[index - 1]))
    .map(() => ({
      level: 'WARN' as const,
      tag: 'blanket-invariant' as const,
      message: '통짜 보존 약속은 이름으로 한정한 보존 대상을 지정해야 하며, 이름 있는 대상은 별도 절로 분리해야 한다',
    }));
}

function preservationClauses(ask: string): string[] {
  const maskedCodeSpans = ask.replace(/`[^`]*`/gu, (span) => `\`${'¤'.repeat(Math.max(0, span.length - 2))}\``);
  const boundaries = /[.!?。]|(?:하며|하고)\s*[,，]?|[,，]/gu;
  const clauses: string[] = [];
  let start = 0;
  for (const match of maskedCodeSpans.matchAll(boundaries)) {
    const end = match.index! + match[0].length;
    const clause = ask.slice(start, end).trim();
    if (clause) clauses.push(clause);
    start = end;
  }
  const trailing = ask.slice(start).trim();
  if (trailing) clauses.push(trailing);
  return clauses;
}

function namesScopeFollowingClause(clause: string | undefined): boolean {
  return clause !== undefined
    && namesPreservationTarget(clause)
    && /(?:에\s*한(?:해|해서)|만|(?:을|를)\s*대상으로)\s*(?:하고|하며)?\s*[,，]?\s*$/u.test(clause);
}

function isBlanketBehaviorPreservationClause(clause: string): boolean {
  return /(?:모든|전체)\s*(?:동작|기능|행동|값|반환\s*값)?.{0,30}(?:그대로\s*)?(?:유지|보존|바꾸지\s*않|변경하지\s*않)/u.test(clause);
}

function isBlanketInvariant(clause: string): boolean {
  return /(?:모든|전체)\s*(?:동작|기능|행동|값|반환\s*값)?.{0,30}(?:그대로\s*)?(?:유지|보존)|(?:모든|전체).{0,30}변경하지\s*않/u.test(clause);
}

function namesPreservationTarget(clause: string): boolean {
  return /`[^`]+`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/u.test(clause);
}

export function formatGoalFileLintFinding(finding: GoalFileLintFinding): string {
  const origin = GOAL_FILE_LINT_ORIGINS[finding.tag];
  const renderedOrigin = origin.kind === 'known-incident'
    ? `${origin.incident} (reference: ${origin.reference})`
    : origin.label;
  return `${finding.level} [${finding.tag}] ${finding.message} — origin: ${renderedOrigin}`;
}

interface PlanGateSignals {
  /** Stable authored-goal identity when the document has leading GoalId metadata. */
  goalId: string | null;
  /** Unique persistent-evidence paths that match a known target path; null means no target path was readable. */
  persistentEvidenceTargetPathCount: number | null;
  /** Unique persistent-evidence paths that do not match a known target path; null means no target path was readable. */
  persistentEvidenceOutsideTargetPathCount: number | null;
  tracedPathMissing: number;
  tracedPathOutside: number;
  unansweredClarification: number;
  unverifiable: number;
  unverifiableInvariantCandidates: number;
  normalizedMarkerSuccess: number;
  normalizedMarkerFailure: number;
  requestedCriteria: number;
  contradiction: number;
  unverifiableLines: string[];
  contradictionLines: string[];
}

const REQUESTED_CRITERION_PREFIX = '- Checkable requested criterion:';
const PRESERVATION_CRITERION_PREFIX = '- Checkable preservation criterion:';
const AUTHORED_UNVERIFIABLE_PREFIX = '- UNVERIFIABLE:';
const PRESERVATION_NEGATION = /\b(?:no|not|never|without)\s+((?:\S+\s*){0,3})/i;

function normalizedRepositoryPath(path: string): string | null {
  const trimmed = path.trim().replaceAll('\\', '/');
  if (!trimmed || isAbsolute(trimmed)) return null;
  const normalized = normalize(trimmed).replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized && normalized !== '.' && !normalized.startsWith('../') ? normalized : null;
}

function targetPathReferences(document: string): string[] {
  const ask = verbatimOriginalAsk(document);
  const labeledTargets = ask?.split(METADATA_LINE_BOUNDARY, 1)[0].match(TARGET_PATH_LABEL)?.[1]
    ?.split('·')
    .map((path) => path.trim())
    .filter(Boolean) ?? [];
  return [...labeledTargets, ...tracedPathReferences(document).map((reference) => reference.path)];
}

function persistentEvidencePathReferences(document: string): string[] {
  const problem = markdownSection(document, 'PROBLEM');
  if (!problem) return [];
  const entries: string[] = [];
  let inPersistentEvidence = false;
  for (const line of problem.split(METADATA_LINE_BOUNDARY)) {
    if (line.startsWith('- Persistent grounding evidence ')) {
      inPersistentEvidence = true;
      continue;
    }
    if (inPersistentEvidence && line.startsWith('- ')) break;
    if (inPersistentEvidence && line.startsWith('  - ')) entries.push(line.slice(4));
  }
  if (entries.length) return entries.flatMap(evidencePaths);
  if (problem.includes('Persistent grounding evidence is listed in the traced-path section below.')) {
    return (markdownSection(document, 'TRACED PATHS') ?? '')
      .split(METADATA_LINE_BOUNDARY)
      .flatMap((line) => /^\d+\.\s+(.+)$/.exec(line)?.[1] ? evidencePaths(/^\d+\.\s+(.+)$/.exec(line)![1]) : []);
  }
  return [];
}

function targetPathOverlapSignals(document: string): Pick<PlanGateSignals, 'persistentEvidenceTargetPathCount' | 'persistentEvidenceOutsideTargetPathCount'> {
  const targets = new Set(targetPathReferences(document)
    .map(normalizedRepositoryPath)
    .filter((path): path is string => path !== null));
  if (!targets.size) return { persistentEvidenceTargetPathCount: null, persistentEvidenceOutsideTargetPathCount: null };
  const evidence = new Set(persistentEvidencePathReferences(document)
    .map(normalizedRepositoryPath)
    .filter((path): path is string => path !== null));
  let persistentEvidenceTargetPathCount = 0;
  let persistentEvidenceOutsideTargetPathCount = 0;
  for (const path of evidence) {
    if (targets.has(path)) persistentEvidenceTargetPathCount += 1;
    else persistentEvidenceOutsideTargetPathCount += 1;
  }
  return { persistentEvidenceTargetPathCount, persistentEvidenceOutsideTargetPathCount };
}

/** Summarize authored-plan gate inputs without changing lint findings or performing I/O. */
export function planGateSignals(document: string, findings: readonly GoalFileLintFinding[]): PlanGateSignals {
  const lines = document.split(/\r\n|[\n\r\u2028\u2029]/);
  const requestedCriteria = lines.filter((line) => line.startsWith(REQUESTED_CRITERION_PREFIX));
  const requestedLowercase = requestedCriteria.map((line) => line.toLowerCase());
  const contradictionLines = lines.filter((line) => {
    if (!line.startsWith(PRESERVATION_CRITERION_PREFIX)) return false;
    const followingWords = PRESERVATION_NEGATION.exec(line)?.[1];
    if (!followingWords) return false;
    const tokens = followingWords.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    return tokens.some((token) => requestedLowercase.some((criterion) => criterion.includes(token)));
  });
  const unverifiableLines = lines.filter((line) => line.startsWith(AUTHORED_UNVERIFIABLE_PREFIX));
  let unverifiableInvariantCandidates = 0;
  let inInvariantCandidate = false;
  for (const line of lines) {
    if (line.startsWith('- Invariant candidate:')) {
      inInvariantCandidate = true;
    } else if (line.startsWith('- ') && !line.startsWith('  - ')) {
      inInvariantCandidate = false;
    }
    if (inInvariantCandidate && line.trimStart().startsWith(AUTHORED_UNVERIFIABLE_PREFIX)) {
      unverifiableInvariantCandidates += 1;
      inInvariantCandidate = false;
    }
  }
  const normalizedMarkerSuccess = lines.filter((line) => line.trimStart().startsWith('- Normalized ask marker:')).length;
  const normalizedMarkerFailure = unverifiableLines.filter((line) => line.includes('invariant marker') || line.includes('boundary marker')).length;
  const signals = {
    goalId: parseGoalId(document),
    ...targetPathOverlapSignals(document),
    tracedPathMissing: findings.filter((finding) => finding.tag === 'traced-path' && finding.message.includes('does not exist')).length,
    tracedPathOutside: findings.filter((finding) => finding.tag === 'traced-path' && finding.message.includes('outside repository')).length,
    unansweredClarification: parseGoalDocumentClarifications(document).filter((clarification) => !clarification.answered).length,
    unverifiable: unverifiableLines.length,
    unverifiableInvariantCandidates,
    normalizedMarkerSuccess,
    normalizedMarkerFailure,
    requestedCriteria: requestedCriteria.length,
    contradiction: contradictionLines.length,
    unverifiableLines,
    contradictionLines,
  };
  observeGoalAuthor('goal-author', 'plan-signals', signals);
  return signals;
}

/** The generated title plus its contiguous non-empty metadata lines, excluding document body examples. */
export function leadingGoalMetadata(document: string): string[] {
  const lines = document.split(METADATA_LINE_BOUNDARY);
  if (!lines[0]?.trim()) return [];
  const metadata: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) break;
    metadata.push(line);
  }
  return metadata;
}

/** Parse a stable authored-goal identity from the generated leading metadata block. */
export function parseGoalId(document: string): string | null {
  return GOAL_ID_LINE.exec(leadingGoalMetadata(document)[0] ?? '')?.[1] ?? null;
}

/**
 * Parse the repository-relative ask-file lineage key from the leading metadata block.
 * Same shape as `parseRootIntent`: one well-formed line, or `null` when the line is absent.
 */
export function parseAskFile(document: string): string | null {
  const askFileLines = leadingGoalMetadata(document).flatMap((line) => {
    const match = ASK_FILE_LINE.exec(line);
    return match ? [match[1].trim()] : [];
  });
  if (askFileLines.length > 1) throw new Error('goal file has duplicate AskFile');
  if (askFileLines.length === 0) return null;
  const askFile = askFileLines[0];
  if (!askFile) throw new Error('goal file has invalid AskFile');
  return askFile;
}

/** Parse the literal root purpose from the generated leading metadata block. */
export function parseRootIntent(document: string): string | null {
  const rootIntentLines = leadingGoalMetadata(document).flatMap((line) => {
    if (!ROOT_INTENT_DECLARATION.test(line)) return [];
    const match = ROOT_INTENT_LINE.exec(line);
    if (!match) throw new Error('goal file has invalid RootIntent');
    return [match[1]];
  });
  if (rootIntentLines.length > 1) throw new Error('goal file has duplicate RootIntent');
  if (rootIntentLines.length === 0) return null;
  try {
    return validateRootIntent(rootIntentLines[0]);
  } catch {
    throw new Error('goal file has invalid RootIntent');
  }
}

/** Reject external RootIntent input that cannot occupy exactly one metadata line. */
function validateRootIntent(rootIntent: string): string {
  if (METADATA_LINE_BOUNDARY.test(rootIntent) || !rootIntent.trim() || rootIntent !== rootIntent.trim()) {
    throw new Error('rootIntent must be a non-blank single line without surrounding whitespace');
  }
  return rootIntent;
}

/** Reject an ask-file path that cannot occupy exactly one metadata line. */
function validateAskFile(askFile: string): string {
  if (METADATA_LINE_BOUNDARY.test(askFile) || !askFile.trim() || askFile !== askFile.trim()) {
    throw new Error('askFile must be a non-blank single line without surrounding whitespace');
  }
  return askFile;
}

function supersededByCount(document: string): number {
  return leadingGoalMetadata(document).filter((line) => SUPERSEDED_BY_LINE.test(line)).length;
}

function looksLikeGoalDocument(document: string): boolean {
  const goalType = parseGoalType(document);
  return goalType !== null
    && parseGoalId(document) !== null
    && requiredBlocksForGoalType(goalType).every((block) => document.split(/\r?\n/).includes(block));
}

function requestedCriterionCount(document: string): number {
  const lines = document.split(/\r?\n/);
  let openFence = 0;
  let openMarker = '';
  let inAcceptanceCriteria = false;
  let count = 0;
  for (const line of lines) {
    const fence = /^ {0,3}([`~]{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      if (openFence === 0) { openFence = fence[1].length; openMarker = marker; }
      else if (marker === openMarker && fence[1].length >= openFence && /^[ \t]*$/.test(fence[2])) { openFence = 0; openMarker = ''; }
      continue;
    }
    if (openFence !== 0) continue;
    if (line === '## ACCEPTANCE CRITERIA') { inAcceptanceCriteria = true; continue; }
    if (line === '## REQUIRED EVIDENCE') break;
    if (inAcceptanceCriteria && REQUESTED_CRITERION_LINE.test(line)) count += 1;
  }
  return count;
}

/** Fail-soft, human-facing supersession context; it never changes the authored artifact or blocks the revision. */
function emitSupersessionWarning(ask: string, supersededDocument: string, successorDocument: string): void {
  try {
    const inputGoalDocument = looksLikeGoalDocument(ask);
    const answeredClarifications = parseGoalDocumentClarifications(supersededDocument).some(({ answered }) => answered);
    const oldRequestedCriteria = requestedCriterionCount(supersededDocument);
    const newRequestedCriteria = requestedCriterionCount(successorDocument);
    const notice = `[goal-author] supersession warning: input-goal-document=${inputGoalDocument ? 'yes' : 'no'}; answered-clarifications=${answeredClarifications ? 'yes' : 'no'}; requested-criteria old=${oldRequestedCriteria} new=${newRequestedCriteria}\n`;
    process.stderr.write(notice);
    observeGoalAuthor('goal-author', 'supersession-warning', {
      inputGoalDocument,
      answeredClarifications,
      oldRequestedCriteria,
      newRequestedCriteria,
    });
  } catch {
    try { observeGoalAuthor('goal-author', 'supersession-warning-detection-failed', {}); } catch { /* observation is fail-soft */ }
  }
}

function generateGoalId(): string {
  return randomBytes(8).toString('hex');
}

function addSupersededBy(document: string, successorPath: string): string {
  const newline = document.includes('\r\n') ? '\r\n' : '\n';
  const lines = document.split(/\r?\n/);
  const goalIdIndex = lines.findIndex((line, index) => index > 0 && GOAL_ID_LINE.test(line));
  if (goalIdIndex < 0) throw new Error('superseded goal file has no GoalId');
  lines.splice(goalIdIndex + 1, 0, `- Superseded-By: ${successorPath}`);
  return lines.join(newline);
}

function repositoryRelativeGoalPath(cwd: string, path: string): string {
  const result = relative(resolve(cwd), resolve(path));
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error('successor goal file must stay within cwd');
  }
  return result.split(sep).join('/');
}

function validateLockedSupersededPath(cwd: string, path: string): void {
  const repositoryRoot = realpathSync(resolve(cwd));
  const sourcePath = realpathSync(path);
  const relation = relative(repositoryRoot, sourcePath);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('superseded goal file must stay within cwd');
  }
}

function atomicRewrite(sourcePath: string, document: string, rename: (from: string, to: string) => void = renameSync): void {
  const temporaryPath = `${sourcePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporaryPath, document, { flag: 'wx' });
    rename(temporaryPath, sourcePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function defaultSupersessionLock(sourcePath: string): () => void {
  try {
    return acquireLockSync(`${sourcePath}.supersede-lock`, {
      staleMs: SUPERSESSION_LOCK_STALE_MS,
      maxTries: 2,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('acquireLockSync: timed out')) {
      throw new Error('superseded goal file is being superseded');
    }
    throw error;
  }
}

export interface AuthoredGoal {
  document: string;
  facts: CodebaseGrounding | null;
  grounded: boolean;
  authorRunId: string;
}

export interface GoalFileDeps {
  mkdir?: (path: string) => void;
  /** ⚠️ 원자적 배타 생성이어야 한다 — 이미 있으면 `code:'EEXIST'` 로 던진다. */
  write?: (path: string, document: string) => void;
  /** Atomically claims a source-specific supersession lock; returns a release function. */
  acquireSupersessionLock?: (sourcePath: string) => () => void;
  /** Re-reads the source inside the supersession lock before validation and backlinking. */
  read?: (path: string) => string;
  now?: () => Date;
  /** 신원 머리말의 `agent`·`session` 출처. 주입하지 않으면 `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Existing document path for an explicitly declared superseding revision. */
  supersedes?: { path: string };
  /** Renames the completed temporary backlink file over its predecessor. */
  rename?: (from: string, to: string) => void;
  /** Rewrites a superseded source after the successor file is created. */
  rewrite?: (path: string, document: string) => void;
  /** Removes a created successor when its source backlink cannot be committed. */
  remove?: (path: string) => void;
  /** Optional supersession notice seam; notification failures must not affect the completed revision. */
  emitSupersessionWarning?: (ask: string, supersededDocument: string, successorDocument: string) => void;
}

// The authored `## RULES` section was removed because it cost 1,215 characters per
// generated document in the existing corpus. The policy remains here, unchanged:
// child entrypoints serialize this array into ELANOUS_HARNESS_POLICY instead of
// duplicating it in every goal artifact.
const CONSTANT_DOCUMENT_INSTRUCTION_POLICY = [
  '- If this change touches code: name the focused test file(s) it adds or touches, run only those, and report each summary-line pass count. If it does not touch code: name the artifact produced and the command or query that shows it exists.',
  '- Verify by breaking it: change the one rule that matters for THIS goal, show the named check fails, restore it, show it passes. Report the failing check verbatim. If nothing can be broken, say why in one line rather than skipping this.',
  `- ${EVIDENCE_LOCATION_REQUIREMENT}`,
  'In the child completion summary, write `EVIDENCE: [requested] <claim> || <verify command>`.',
  'Immediately next, write `RESULT: <the one-line result from that verify command>`.',
  'In the child completion summary, write `EVIDENCE: [preservation] <claim> || <verify command>`.',
  'Immediately next, write `RESULT: <the one-line result from that verify command>`.',
  'Fill `<claim>` with what this tag proves and `<verify command>` with the command or query that reproduces it; neither may be empty.',
] as const;

export const GOAL_RULES_POLICY = [
  '- Do not run the whole test suite. If tests apply, name the focused file(s) and read only each summary line; a full suite can exhaust the implementer context window.',
  '- Do not infer a code path from a symbol grep. Trace a candidate before naming it as an implementation target.',
  '- Do not create a planner, milestones, steps, task decomposition, worktree, PR, mission, daemon call, or dev-pipeline hand-off; this artifact is authoring only.',
  '- Do not write an acceptance criterion that cannot hold at the same time as another one. Naming a field to add while demanding that same return value stay completely unchanged is a trap, not a contract: name the fields and values that must stay identical.',
  '- Do not fabricate repository evidence. Facts absent from grounding remain unverified.',
  '- Do not replace, rewrite, summarize, truncate, translate, or clean up the verbatim ask.',
  ...CONSTANT_DOCUMENT_INSTRUCTION_POLICY,
] as const;

/** 내용 안 최장 백틱 런보다 긴 울타리(최소 3). */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function evidenceSection(label: string, entries: string[]): string[] {
  return entries.length ? [`- ${label}`, ...entries.map((entry) => `  - ${entry}`)] : [];
}

type PersistentEvidenceSourceKind = HarnessGroundingProvenance | 'unknown';

interface PersistentEvidenceItem {
  readonly text: string;
  readonly source: PersistentEvidenceSourceKind;
}

const PERSISTENT_EVIDENCE_SOURCE_KINDS = ['code', 'skill', 'memory', 'doc', 'pty', 'unknown'] as const satisfies readonly PersistentEvidenceSourceKind[];

function persistentEvidenceSourceKind(sourceKind: string | undefined): PersistentEvidenceSourceKind {
  return PERSISTENT_EVIDENCE_SOURCE_KINDS.includes(sourceKind as PersistentEvidenceSourceKind)
    ? sourceKind as PersistentEvidenceSourceKind
    : 'unknown';
}

/** Preserve every evidence occurrence and classify only by its own explicit source association. */
function persistentEvidenceItems(facts: CodebaseGrounding | null): PersistentEvidenceItem[] {
  const associated = facts?.persistentEvidenceItems ?? [];
  const associatedOccurrences = new Map<string, number>();
  for (const { text } of associated) {
    associatedOccurrences.set(text, (associatedOccurrences.get(text) ?? 0) + 1);
  }
  const unassociated = (facts?.persistentEvidence ?? []).flatMap((text): PersistentEvidenceItem[] => {
    const remainingAssociated = associatedOccurrences.get(text) ?? 0;
    if (remainingAssociated > 0) {
      associatedOccurrences.set(text, remainingAssociated - 1);
      return [];
    }
    return [{ text, source: 'unknown' }];
  });
  return [
    ...associated.map(({ text, sourceKind }): PersistentEvidenceItem => ({ text, source: persistentEvidenceSourceKind(sourceKind) })),
    ...unassociated,
  ];
}

function renderPersistentEvidence(item: PersistentEvidenceItem): string {
  return `[${item.source}] ${item.text}`;
}

function observePersistentEvidenceSourceKinds(facts: CodebaseGrounding | null, authorRunId: string): void {
  const counts = Object.fromEntries(PERSISTENT_EVIDENCE_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<PersistentEvidenceSourceKind, number>;
  for (const item of persistentEvidenceItems(facts)) counts[item.source] += 1;
  observeGoalAuthor('goal-author', 'persistent-grounding-evidence-source-count', { authorRunId, counts });
}

function tracedPathsSection(facts: CodebaseGrounding | null, unavailableEvidence: string): string[] {
  const evidence = persistentEvidenceItems(facts);
  return evidence.length
    ? evidence.map(({ text, source }, index) => `${index + 1}. ${renderPersistentEvidence({ text, source })}`)
    : [`- ${unavailableEvidence}`];
}

const IDENTITY_PREFIX = /^(agent|session|submitted|authored-by|track|roadmap):/i;
const REQUEST_LABEL = /^(?:request|goal|요청|목표)\s*:\s*(.+)$/i;
const REQUEST_LABEL_ONLY = /^(?:request|goal|요청|목표)\s*:?\s*$/i;
const MARKDOWN_HEADING = /^#{1,6}\s*(.*?)\s*#*\s*$/;
const LABEL_ONLY = /^(?:context|request|goal|요청|목표)\s*:?\s*$/i;
const MARKDOWN_HORIZONTAL_RULE = /^(?:[-*_]\s*){3,}$/;
const CODE_FENCE = /^\s*([`~])\1{2,}.*$/;
const FALLBACK_GOAL_SUMMARY = 'Untitled goal request';

function validGoalSummary(candidate: string): string | null {
  const summary = candidate.replace(METADATA_LINE_BOUNDARY_GLOBAL, ' ').replace(/\s+/g, ' ').trim();
  return summary && !IDENTITY_PREFIX.test(summary) ? summary : null;
}

function headingContent(line: string): string {
  return MARKDOWN_HEADING.exec(line.trim())?.[1] ?? line.trim();
}

function substantiveLine(line: string): string | null {
  const candidate = headingContent(line);
  const labeled = REQUEST_LABEL.exec(candidate);
  if (labeled) return validGoalSummary(labeled[1]);
  return !candidate || IDENTITY_PREFIX.test(candidate) || LABEL_ONLY.test(candidate)
    || MARKDOWN_HORIZONTAL_RULE.test(candidate) || CODE_FENCE.test(candidate)
    ? null
    : validGoalSummary(candidate);
}

function isSectionBoundary(line: string): boolean {
  return LABEL_ONLY.test(headingContent(line));
}

function requestContent(lines: string[], index: number): string | null {
  const label = headingContent(lines[index]);
  const labeled = REQUEST_LABEL.exec(label);
  if (labeled) return validGoalSummary(labeled[1]);
  if (!REQUEST_LABEL_ONLY.test(label)) return null;
  for (const line of lines.slice(index + 1)) {
    if (isSectionBoundary(line)) break;
    const content = substantiveLine(line);
    if (content) return content;
  }
  return null;
}

function goalSummary(ask: string): string {
  const lines = ask.split(/\r?\n/);
  const requestLabels = /^(?:request|요청)\s*:?\s*$/i;
  const goalLabels = /^(?:goal|목표)\s*:?\s*$/i;
  const requested = [requestLabels, goalLabels].flatMap((label) => lines.flatMap((line, index) => {
    if (!label.test(headingContent(line))) return [];
    const content = requestContent(lines, index);
    return content ? [content] : [];
  }))[0];
  const extracted = requested ?? lines.map(substantiveLine)
    .find((candidate): candidate is string => candidate !== null);
  return extracted ?? FALLBACK_GOAL_SUMMARY;
}

function implementationCandidates(facts: CodebaseGrounding): string[] {
  return facts.files.filter(isRepositoryImplementationCandidate);
}

export function goalContextEvidence(root: string): string[] {
  const directory = join(root, 'docs', 'goal-context');
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap((name) => {
      const content = readFileSync(join(directory, name), 'utf8');
      const fence = fenceFor(content);
      return [`- [goal-context:${name}]`, fence, content, fence];
    });
}

function groundedProblem(facts: CodebaseGrounding, tracedPathsIncluded: boolean): string[] {
  const persistentEvidence = persistentEvidenceItems(facts);
  return [
    '- The ask identifies a repository problem, but grounding verifies only the categorized evidence below; missing behavior, causation, and call paths remain unverified.',
    ...(tracedPathsIncluded && persistentEvidence.length
      ? ['- Persistent grounding evidence is listed in the traced-path section below.']
      : evidenceSection('Persistent grounding evidence (verbatim Read-verified completion statements):', persistentEvidence.map(renderPersistentEvidence))),
    ...evidenceSection('Local document evidence (reference knowledge; not a repository file-existence claim):', facts.refFacts),
  ];
}

function observeProblemBackgroundEvidence(facts: CodebaseGrounding, authorRunId: string): void {
  const implementationCandidates = facts.files.filter(isRepositoryImplementationCandidate);
  observeGoalAuthor('goal-author', 'problem-background-evidence', {
    authorRunId,
    documentFacts: { count: facts.documentFacts.length, identifiers: facts.documentFacts },
    skillFacts: { count: facts.skillFacts.length, identifiers: facts.skillFacts },
    memoryFacts: { count: facts.memoryFacts.length, identifiers: facts.memoryFacts },
    ptyFacts: { count: facts.ptyFacts.length, identifiers: facts.ptyFacts },
    implementationCandidates: { count: implementationCandidates.length, identifiers: implementationCandidates },
    codeFacts: { count: facts.codeFacts.length, identifiers: facts.codeFacts },
  });
}

/** 골에 «렌더»되는 접지 파일 목록의 상한.
 *  ⛔ 「접지를 줄인다」가 아니다 — «보여 주는 줄»만 자른다(수는 참값). 
 *  📏 근거: 전수 N=3,253 골에서 75%가 3개 이하다 — 20이면 «거의 전부»를 그대로 보여 준다. */
const GROUNDING_FILE_LIST_MAX = 20;

function groundedFilesNotMentionedInAsk(facts: CodebaseGrounding, ask: string): string[] {
  const askPaths = new Set(askPathTokens(ask));
  return facts.files.filter((path) => !askPaths.has(path));
}

export function groundedFilesNotMentionedInAskNarrative(facts: CodebaseGrounding | null, ask: string): string | null {
  if (!facts) return null;
  const files = groundedFilesNotMentionedInAsk(facts, ask);
  if (files.length === 0) return '- Grounding files not mentioned in ask (0): 없다.';
  // ⛔⭐ 목록에 «상한»을 둔다 — 수는 «참값 그대로».
  //   🩸 실측 2026-09-08(🅣 가 잼): 이 줄이 ***531,411자***가 된 골이 있었고 그 골 전체의 ***96%***였다
  //     (접지 파일 ***6,625***개). 전수 N=3,253 골: 중앙값 2 · 75% 3 · 최대 6,625 · 1000 초과 9건.
  //   🔑 이 저장소의 «저작 규율»은 이미 *"근거 목록은 「수 ⊕ 그 수를 내는 명령」으로 쓴다"* 인데,
  //     ***그 규율이 「기계가 골에 쓰는 것」에는 안 걸려 있었다.***
  //   ⛔ 수(`(${files.length})`)는 «자르지 않는다» — `dev-pipeline` 이 그 수를 정규식으로 읽는다.
  //     ⇒ 잘리는 것은 «보여 주는 목록»뿐이고 계측은 무손상이다.
  const shown = files.slice(0, GROUNDING_FILE_LIST_MAX);
  const rendered = shown.map((path) => `\`${path}\``).join(', ');
  const omitted = files.length - shown.length;
  return omitted === 0
    ? `- Grounding files not mentioned in ask (${files.length}): ${rendered}`
    : `- Grounding files not mentioned in ask (${files.length}): ${rendered}`
      + ` … 외 ${omitted}개 — 전체 목록은 «재는 명령»으로: \`elanous self recall\` 또는 골의 접지 기록.`;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function askMentionsSymbol(ask: string, symbol: string): boolean {
  const escapedSymbol = escapeRegularExpression(symbol);
  return new RegExp(`(?:^|[^\\p{ID_Continue}$])${escapedSymbol}(?![\\p{ID_Continue}$])`, 'u').test(ask);
}

interface CodeFactSymbol {
  path: string;
  symbol: string;
  fact: string;
}

function codeFactSymbolEntries(facts: CodebaseGrounding, ask: string): CodeFactSymbol[] {
  return facts.codeFacts.flatMap((fact) => {
    const match = /^\[code:([^\]]+)]\s*(.*)$/.exec(fact);
    if (!match) return [];
    return match[2].split(',').map((symbol) => symbol.trim())
      .filter((symbol) => symbol.length > 0 && askMentionsSymbol(ask, symbol))
      .map((symbol) => ({ path: match[1], symbol, fact }));
  });
}

function codeFactSymbols(facts: CodebaseGrounding, ask: string): Array<{ path: string; symbol: string }> {
  return codeFactSymbolEntries(facts, ask).map(({ path, symbol }) => ({ path, symbol }));
}

function readerFailureNarrative(path: string, symbol: string, result: Exclude<ReferencedFileReadResult, { kind: 'ok'; contents: string }>): string {
  const reason = result.kind === 'missing'
    ? 'file was not found'
    : result.kind === 'outside-repository'
      ? 'path is outside the repository'
      // ⛔ 이미지는 「읽기 실패」가 아니다 — 읽혔는데 «서명을 뽑을 텍스트가 아닐» 뿐이다(`P4b`).
      //   그것을 「could not be read」로 적으면 저작자가 없는 결함을 쫓는다(`#7486` 리뷰 should-fix).
      : result.kind === 'image'
        ? 'file is an image, so no source signature can be extracted'
        : 'file could not be read';
  return `- Signature unavailable for \`${symbol}\` in \`${path}\`: ${reason}.`;
}


/**
 * ⛔⭐⭐ **「선언 «한 줄»」이다 — 선언의 «끝»을 계산하지 않는다.**
 *
 * 이 골의 경계는 *"문자열 검색으로 하고 타입스크립트 파서나 LSP 를 끌어오지 않는다"* 였다.
 * 초판은 파서를 «끌어오지 않고 직접 만들었다» — 괄호·중괄호 카운팅, 주석/문자열 마스킹,
 * 화살표 함수 탐지로 «선언의 끝»을 찾았고, 리뷰가 그 기계장치에서 결함 «셋»을 냈다:
 *   ⑴ `class|interface|type|enum` 에 종료 경계가 없어 **파일 끝까지** 삼킨다
 *   ⑵ `function foo(): { x: string } {` 의 «반환 타입» 중괄호를 본문 시작으로 오인한다
 *   ⑶ 그 경계들을 무는 회귀가 없어 150 통과가 그 결함을 «못 잡았다»
 * ⇒ ⭐ 셋 다 «끝을 계산했기 때문»에 생겼다. 골이 요구한 것은 «매치된 그 줄» 하나이고,
 *    그 줄만 내면 셋이 모두 사라진다. 여러 줄에 걸친 시그니처는 «첫 줄»만 보이며,
 *    그것으로 「내가 넘길 것과 이것이 받는 것이 같은가」라는 이 값의 목적은 대개 답해진다.
 * ⚠️ **안 되는 것을 적어 둔다**: 파라미터가 다음 줄부터 시작하는 선언은 첫 줄에 타입이 안 보인다.
 *    그때는 `## TRACED PATHS` 의 경로를 사람이 열면 된다 — 이 값은 «열어 볼 곳을 가리키는 것»이지
 *    «열지 않아도 되게 하는 것»이 아니다.
 */
function firstDeclarationLine(contents: string, symbol: string): { line: string; number: number } | null {
  const escapedSymbol = escapeRegularExpression(symbol);
  const declaration = new RegExp(`^\\s*(?:(?:export|default|declare|async|abstract)\\s+)*(?:function|class|interface|type|const|let|var|enum)\\s+${escapedSymbol}(?![\\p{ID_Continue}$])`, 'u');
  // ⛔⭐⭐⭐ **원문 줄에서 «그대로» 찾는다 — 주석·문자열 마스킹을 «쓰지 않는다».**
  //   초판은 `sourceLinesWithoutCommentsOrStrings` 로 가린 줄에서 찾았는데, 그 마스커는
  //   ***정규식 리터럴 안의 따옴표·backtick 을 «문자열 시작»으로 읽는다.*** 실측(2026-08-05):
  //     `const runs = [...document.matchAll(/`+/g)];`  ← 이 줄에서 backtick 상태가 «열리고»
  //     그 뒤 «350여 줄»이 통째로 문자열로 가려져 `export function lintGoalFile` 이 «안 보였다».
  //   ⇒ ⛔ 즉 이 기능이 «정규식 리터럴이 있는 파일»에서 대부분 「declaration line was not found」를 냈다.
  //      단위 테스트는 fixture 가 작고 정규식이 없어 이것을 «구조적으로» 못 잡았다(라이브가 잡았다).
  //   ⭐ 그래서 마스킹을 지운다. 대가는 «주석·문자열 «안»의 선언문이 매치될 수 있다»는 것이고,
  //      그 대가는 싸다 — 산출이 `path:line` 을 같이 내므로 사람이 열어 «확인»할 수 있다.
  //      반대로 마스킹의 대가(존재하는 선언을 「없다」고 말하는 것)는 이 값의 목적을 «무효로 만든다».
  const originalLines = contents.replace(/\r\n/g, '\n').split('\n');
  for (let lineIndex = 0; lineIndex < originalLines.length; lineIndex += 1) {
    if (!declaration.test(originalLines[lineIndex])) continue;
    return { line: originalLines[lineIndex].trim(), number: lineIndex + 1 };
  }
  return null;
}

function askMentionedSymbolSignaturesNarrative(
  facts: CodebaseGrounding | null,
  ask: string,
  readSourceFile: GoalAuthorDeps['readSourceFile'],
): string[] {
  if (!facts) return [];
  const symbols = codeFactSymbols(facts, ask);
  if (!symbols.length) return [];
  if (!readSourceFile) return symbols.map(({ path, symbol }) =>
    `- Signature unavailable for \`${symbol}\` in \`${path}\`: source reader was not supplied, so the signature could not be read.`,
  );
  return symbols.map(({ path, symbol }) => {
    const result = readSourceFile(path);
    if (result === null) return `- Signature unavailable for \`${symbol}\` in \`${path}\`: file was not found.`;
    if (typeof result !== 'string' && result.kind !== 'ok') return readerFailureNarrative(path, symbol, result);
    const declaration = firstDeclarationLine(typeof result === 'string' ? result : result.contents, symbol);
    return declaration === null
      ? `- Signature unavailable for \`${symbol}\` in \`${path}\`: declaration line was not found.`
      : `- Signature declaration \`${path}:${declaration.number}\` — ${declaration.line}`;
  });
}

const ELANOUS_HELP_PROBE_PREFIX = ['bun', 'bin/elanous.mjs'] as const;
const SAFE_ELANOUS_HELP_PROBE_TOKEN = /^[A-Za-z0-9_./:=@+,-]+$/;

interface InlineElanousCommand {
  readonly command: string;
  readonly argv: readonly string[] | null;
}

function inlineCodeContents(markdown: string): string[] {
  let fence: { marker: string; length: number } | null = null;
  const outsideBlocks = markdown.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part;

    const fenceMatch = FENCE_RUN.exec(part);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') fence = null;
      return ' '.repeat(part.length);
    }
    if (fence || /^(?: {4}|\t)/.test(part)) return ' '.repeat(part.length);
    return part;
  }).join('');

  return Array.from(outsideBlocks.matchAll(/`([^`]+)`/g), ([, code]) => code);
}

function inlineElanousCommands(ask: string): InlineElanousCommand[] {
  return inlineCodeContents(ask).map((code) => code.trim())
    .filter((code) => code.startsWith('bun bin/elanous.mjs'))
    .map((command) => {
      const argv = command.split(/\s+/);
      const safe = !/[\r\n]/.test(command)
        && argv.length >= ELANOUS_HELP_PROBE_PREFIX.length
        && ELANOUS_HELP_PROBE_PREFIX.every((token, index) => argv[index] === token)
        && argv.every((token) => token !== '--' && SAFE_ELANOUS_HELP_PROBE_TOKEN.test(token));
      return { command, argv: safe ? [...argv, '--help'] : null };
    });
}

const EXPORTED_SYMBOL_FACT = /^\[code:[^\]]+]\s*(.*)$/;
const INLINE_EXPORTED_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Observe ask-named exports against the already-grounded code-fact block without changing the authored document. */
function observeAskExportGrounding(ask: string, facts: CodebaseGrounding | null, authorRunId: string): void {
  if (!facts?.codeFacts.length) return;
  try {
    const exported = new Set(facts.codeFacts.flatMap((fact) => {
      const names = EXPORTED_SYMBOL_FACT.exec(fact)?.[1];
      return names ? names.split(',').map((name) => name.trim()).filter(Boolean) : [];
    }));
    const names = Array.from(new Set(inlineCodeContents(ask)
      .map((code) => code.trim())
      .filter((name) => INLINE_EXPORTED_NAME.test(name))));
    const missingNames = names.filter((name) => !exported.has(name));
    observeGoalAuthor('goal-author', 'ask-export-grounding', {
      authorRunId,
      missingCount: missingNames.length,
      missingNames: missingNames.slice(0, 5),
    });
  } catch {
    // Export comparison is observation only and must never stop authoring.
  }
}

async function inlineElanousCommandProbeNarrative(
  ask: string,
  runHelpProbe: GoalAuthorDeps['runHelpProbe'],
): Promise<string[]> {
  const commands = inlineElanousCommands(ask);
  if (!commands.length) return ['- Command help probe: no inline `bun bin/elanous.mjs` command was named in the ask.'];

  return Promise.all(commands.map(async ({ command, argv }) => {
    const helpCommand = `${command} --help`;
    if (!argv) return `- Command help probe: \`${helpCommand}\` — rejected — command contains unsafe shell syntax and was not executed.`;
    if (!runHelpProbe) return `- Command help probe: \`${helpCommand}\` — unavailable — no execution capability was provided.`;
    try {
      const classification = classifyGoalCommandExecution(await runHelpProbe(argv));
      return `- Command help probe: \`${helpCommand}\` — ${classification.kind} — ${classification.log}.`;
    } catch {
      return `- Command help probe: \`${helpCommand}\` — probe-failure — execution capability threw before the command could be classified.`;
    }
  }));
}

/**
 * ⭐⭐ `S`·`C` 를 «요약»으로 쓰되, 없으면 종전 문면으로 되돌아간다.
 *
 * ⛔ 왜 이 갈래가 있나(2026-08-08 실측): 종전엔 `Situation` 이 ask 를 되풀이하고 개수를 붙였고,
 *   `Complication` 은 `persistentEvidence.join(' ')` 였다. 접지 5건 저작에서 그 한 줄이 **1,236자**였고
 *   그 안의 문장은 근거 절·`TRACED PATHS` 에 **글자 그대로** 다시 나왔다.
 *   ⇒ SCQA 는 문제를 «기술»하려고 쓰는 틀인데, 그 두 자리에 «나열»이 들어가 있었다.
 * ⭐ 요약은 `enhance` 가 만든다(그 모듈이 이 경로의 유일한 LLM 단계다). 접지 문장을 옮겨 적은 요약은
 *   그 모듈이 «버리므로» 여기 오지 않는다 — 이 함수는 「오면 쓰고 안 오면 옛 문면」만 정한다.
 */
/** Points noncanonical prose to the sole block that preserves the human request verbatim. */
function verbatimOriginalAskPointer(): string {
  return 'the canonical verbatim request block below (Original ask)';
}

function scqaNarrative(
  ask: string,
  facts: CodebaseGrounding | null,
  groundingError: boolean,
  clarificationAnswers: Readonly<Record<string, string | undefined>>,
  clarificationQuestions: readonly Question[],
  readSourceFile: GoalAuthorDeps['readSourceFile'],
  summary: { situation?: string; complication?: string } = {},
): { problem: string[]; whatToBuild: string[]; tracedPathsUnavailableEvidence: string } {
  const originalAsk = verbatimOriginalAskPointer();
  const persistentEvidence = facts?.persistentEvidence ?? [];
  const evidenceCount = facts
    ? [
      ...implementationCandidates(facts),
      ...facts.documentFacts,
      ...facts.codeFacts,
      ...facts.skillFacts,
      ...facts.memoryFacts,
      ...facts.refFacts,
      ...facts.ptyFacts,
    ].length
    : 0;
  const hasPersistentEvidence = persistentEvidence.length > 0;
  // ⛔⭐⭐ GROUNDED 갈래의 «폴백»은 종전 문면으로 돌아가지 않는다 — 무인 리뷰 must-fix(2026-08-08).
  //
  //   내 초안은 「요약이 없으면 옛 문면」이었다. 그런데 옛 문면이 바로 이 변경이 없애려던 것이다
  //   (`persistentEvidence.join(' ')` = 근거 전문 나열 · 1,236자 · 근거 절과 글자 그대로 중복).
  //   ⇒ 🚨 ***폴백이 목표를 되돌린다.*** 리뷰 문면: *"echo 가드가 버린 직후 호출자가 동일 근거
  //     원문을 다시 삽입하는 구조라서 코드 수준 중복 방지가 실제로는 보장되지 않는다."*
  //
  //   🩹 그래서 폴백도 «중복이 없다». 요약을 못 얻었으면 그것을 «말한다» — 근거는 아래 절에 있고
  //     여기서 다시 적지 않는다. ⭐ 이것이 「모른다를 정직하게」 규율의 이 자리 판본이다:
  //     「요약이 있었다」와 「없었다」가 문면으로 구별되므로, 문서만 보고도 배선 상태를 안다.
  const groundedCount = persistentEvidence.length;
  const evidenceItems = `${groundedCount} Read-verified evidence item${groundedCount === 1 ? '' : 's'}`;
  const tracedPathsUnavailableEvidence = tracedPathsEvidenceUnavailable(evidenceCount, groundedCount);
  const situation = hasPersistentEvidence
    ? summary.situation !== undefined
      ? `Situation: GROUNDED — ${summary.situation}`
      : `Situation: GROUNDED — The request is preserved verbatim in ${originalAsk}; no authored state summary was produced for this revision, so the grounded state remains recorded as ${evidenceItems} in the Persistent grounding evidence section below.`
    : facts?.grounded
      ? `Situation: NOT-GROUNDED — The request is preserved verbatim in ${originalAsk}; grounding currently provides ${evidenceCount} categorized evidence item${evidenceCount === 1 ? '' : 's'} for context.`
      : `Situation: NOT-GROUNDED — The request is preserved verbatim in ${originalAsk}; no repository facts were grounded, so the reported repository state remains unverified.`;
  const complication = hasPersistentEvidence
    ? summary.complication !== undefined
      ? `Complication: GROUNDED — ${summary.complication}`
      : `Complication: GROUNDED — No authored problem summary was produced for this revision; read the Persistent grounding evidence section below to determine what is wrong. This line does not restate that evidence.`
    : facts?.grounded
      ? 'Complication: NOT-GROUNDED — The available evidence identifies locations and exported facts, but it does not establish the reported behavior, causation, or call path.'
      : `Complication: NOT-GROUNDED — ${groundingError ? 'Grounding failed' : 'No qualifying evidence was found'}, so a recipient cannot determine the reported failure beyond the verbatim request.`;

  const clarification = clarificationQuestions[0];
  const answer = clarification === undefined ? undefined : clarificationAnswers[clarification.id];
  const answered = answer !== undefined && !answer.startsWith('DEFERRED-UNTIL:');
  const fallback = hasPersistentEvidence
    ? [
      'Question: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct question.',
      'Answer: UNANSWERED — Same as Complication; Read-verified evidence adds no distinct answer.',
    ]
    : [
      'Question: UNANSWERED — Same as Original ask; no distinct question was grounded.',
      'Answer: UNANSWERED — Same as Original ask; no distinct answer was grounded.',
    ];

  const unmentionedGroundingFiles = groundedFilesNotMentionedInAskNarrative(facts, ask);
  const signatures = askMentionedSymbolSignaturesNarrative(facts, ask, readSourceFile);

  return {
    problem: [situation, complication, ...signatures, ...(unmentionedGroundingFiles ? [unmentionedGroundingFiles] : [])],
    tracedPathsUnavailableEvidence,
    whatToBuild: clarification === undefined
      ? fallback
      : [
        `Question: ${hasPersistentEvidence ? 'GROUNDED' : 'NOT-GROUNDED'} — ${clarification.question}`,
        !answered
          ? `Answer: UNANSWERED — ${clarification.id}`
          : `Answer: ${hasPersistentEvidence ? 'GROUNDED' : 'NOT-GROUNDED'} — ${renderClarificationValue(answer)}`,
      ],
  };
}

const GENERIC_DOCUMENT_TERMS = new Set([
  'add', 'and', 'code', 'docs', 'file', 'goal', 'implement', 'the', 'this', 'with',
  '가이드', '계획', '구현', '내용', '문서', '문서화', '변경', '범위', '작업', '저작기', '추가', '코드', '테스트', '파일', '항목', '후보', '기능',
]);

const SCOPE_BOUNDARY_NOT_GROUNDED = 'SCOPE-BOUNDARY-NOT-GROUNDED';

interface ScopeBoundaryCandidates {
  lines: string[];
  paths: string[];
}

function scopeBoundaryCandidates(facts: CodebaseGrounding): ScopeBoundaryCandidates {
  const knownDocuments = new Set(facts.documentFacts);
  const matches = (facts.documentMatches ?? []).filter((match) =>
    knownDocuments.has(match.path) && match.score > 0
      && match.matchedTerms.some((term) => term.length >= 3 && !GENERIC_DOCUMENT_TERMS.has(term)) && match.excerpt,
  ).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const threshold = matches.length ? Math.max(10, matches[0].score * 0.7) : Infinity;
  const paths = matches.filter((match) => match.score >= threshold).map((match) => match.path);
  if (!paths.length) return { lines: [], paths };
  return {
    lines: [
      `- ${SCOPE_BOUNDARY_CANDIDATES_MARKER}`,
      `- ${paths.length} scope-boundary candidate(s) were selected by document relevance; their identifiers are retained in the \`scope-boundary-candidates\` observation.`,
      SCOPE_BOUNDARY_CANDIDATES_FOOTER,
    ],
    paths,
  };
}

// 🩸 2026-09-24: 옛 문면은 「실패하는 시험 파일명 · 오류 한 줄」만 답으로 받았다 — 버그 전용이라 «새 기능» 요청엔
//    저장소 증거로 답할 것이 원리상 없었고, 무인 자기 답변은 매번 거절됐다(🅞 관측 4/4). 후보 경로 하나도 답으로 받는다.
export const IMPLEMENTATION_TARGET_CLARIFICATION = 'Clarification needed before treating any candidate as an implementation target: provide the one repository file path (from the code candidates) that this change belongs in, or one failing test filename, or one line from the error message, to narrow the repository scope.';

const IMPLEMENTATION_TARGET_QUESTION_ID = 'implementation_target';
/** ⛔ 코드 접지 «채널»이 실패했을 때의 문면 — 사람의 ask 를 탓하지 않는다.
 *  ⭐ 처방이 반대다: ***ask 를 고치지 말고 다시 친다***(고치면 다음 저작이 「다른 골」이 된다). */
const CODE_CHANNEL_FAILED_QUESTION_ID = 'code_channel_failed';
const CODE_CHANNEL_FAILED_CLARIFICATION = 'The code grounding channel did NOT complete for this authoring run (it failed, or it stopped before finishing its goal), so the empty code candidate list means "not measured", not "not present". Do NOT rewrite the ask to add anchors — that changes the goal without fixing the cause. Re-run the same ask; if it keeps happening, check the grounding channel (elanous logs --category grounding.persistent) before editing anything.';
const IMPLEMENTATION_ANCHOR_QUESTION_ID = 'implementation_anchor';
const IMPLEMENTATION_ANCHOR_CLARIFICATION = 'Grounding did not find a code candidate matching a path named in the ask. Provide an identifier anchor: which function, which constant, or which line should the implementation target contain?';
const IMPLEMENTATION_ANCHOR_OPTIONS: Question['options'] = [
  {
    label: 'Function or constant',
    description: 'Provide the function or constant that identifies the intended implementation target.',
  },
  {
    label: 'Relevant source line',
    description: 'Provide the source line that identifies the intended implementation target.',
  },
];

type ImplementationTargetRule = 'single-candidate' | 'ask-path-token' | 'first-ask-path-token';

interface ImplementationTargetSelection {
  path: string;
  rule: ImplementationTargetRule;
}

type AbsentFirstPathPresence = 'exists' | 'missing' | 'uninspectable' | 'not-a-path';

interface AbsentFirstImplementationPath {
  path: string;
  candidateCount: number;
  presence: AbsentFirstPathPresence;
}

function askPathTokens(ask: string): string[] {
  return ask.split(/\s+/)
    .map((token) => token.replace(/^[`\p{P}]+|[`\p{P}]+$/gu, ''))
    .filter((token) => token.includes('/') && /\.[^./]+$/.test(token));
}

const ASK_QUANTITY_WORDS = new Set(['모든', '무조건', '전부', '아래의']);
const ASK_PATH_TOKEN_EDGE_PUNCTUATION = /^[([{]|[.,;:!?…。！？)\]}]+$/g;

interface AskDirectoryCount {
  path: string;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
}

function askDirectoryCountCandidates(ask: string): string[] {
  return ask.split(/\r?\n|(?<=[!?。！？])|(?<=\.)\s+/).flatMap((sentence) => {
    const tokens = sentence.trim().split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => ASK_QUANTITY_WORDS.has(token.replace(ASK_PATH_TOKEN_EDGE_PUNCTUATION, '')))) return [];
    const pathToken = tokens.find((token) => token.includes('/'));
    if (!pathToken || /[`"']/.test(pathToken)) return [];
    const path = pathToken.replace(ASK_PATH_TOKEN_EDGE_PUNCTUATION, '');
    return path.includes('/') ? [path] : [];
  });
}

function isSameOrNestedPath(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function countAskDirectory(path: string, cwd: string): AskDirectoryCount | null {
  const repositoryRoot = resolve(cwd);
  const absolutePath = resolve(repositoryRoot, path);
  if (!isSameOrNestedPath(absolutePath, repositoryRoot) || !existsSync(absolutePath)) return null;
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const realPath = realpathSync(absolutePath);
  if (!isSameOrNestedPath(realPath, realRepositoryRoot)) return null;
  const entries = readdirSync(realPath, { withFileTypes: true });
  return {
    path,
    fileCount: entries.filter((entry) => entry.isFile()).length,
    directoryCount: entries.filter((entry) => entry.isDirectory()).length,
    symlinkCount: entries.filter((entry) => entry.isSymbolicLink()).length,
  };
}

function observeAskDirectoryCounts(ask: string, cwd: string): AskDirectoryCount[] {
  const counts: AskDirectoryCount[] = [];
  for (const path of askDirectoryCountCandidates(ask)) {
    try {
      const count = countAskDirectory(path, cwd);
      if (count) {
        observeGoalAuthor('goal-author', 'ask-directory-count', count);
        counts.push(count);
      }
    } catch {
      // Directory measurement must never stop authoring.
    }
  }
  return counts;
}

function askDirectoryMeasurementLine(counts: readonly AskDirectoryCount[]): string | undefined {
  if (!counts.length) return undefined;
  return counts.map((count) => `${count.path}: top-level files ${count.fileCount}, direct directories ${count.directoryCount}, symbolic links ${count.symlinkCount}`).join('; ');
}

function firstAskPathTokenIndex(ask: string, path: string): number | null {
  const tokens = askPathTokens(ask);
  const index = tokens.indexOf(path);
  return index === -1 ? null : index;
}

interface NewTargetFile {
  paths: readonly string[];
}

export function isAskPathLocatorToken(path: string): boolean {
  // Evidence (`file.ts:line`) and prefixed (`ref:path`) tokens are not file paths.
  // This plate discards them; it does not strip the colon and retry the remainder.
  return path.split(/[\\/]/).some((component) => component.includes(':'));
}

export function classifyAbsentFirstPathPresence(path: string, repositoryRoot?: string): AbsentFirstPathPresence {
  if (isAskPathLocatorToken(path)) return 'not-a-path';
  if (!repositoryRoot) return 'uninspectable';
  // Absolute tokens and `../` escapes are not repository-internal relative
  // paths. Do not inspect them, and do not fold them into `missing`.
  if (isAbsolute(path)) return 'uninspectable';
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = realpathSync(resolve(repositoryRoot));
  } catch {
    return 'uninspectable';
  }
  const absolutePath = resolve(realRepositoryRoot, path);
  // ⛔ 어휘적 포함만으로는 «부재»를 단정할 수 없다 — 중간 조상이 저장소 «밖»으로 나가는
  //    심볼릭 링크면 `resolve()` 는 안쪽처럼 보이는 문자열을 내고 `lstatSync` 는 ENOENT 를 낸다.
  //    그 둘을 합쳐 `missing` 이라 하면 ***저장소 밖 경로를 「이 골이 만들 새 파일」이라고 자신 있게 말한다.***
  //    ⇒ 「실재를 확인했다」와 「확인할 자격이 없었다」를 가른다(이 파일이 여는 바로 그 축).
  if (!isSameOrNestedPath(absolutePath, realRepositoryRoot)) return 'uninspectable';
  if (!isRealAncestorInsideRepository(absolutePath, realRepositoryRoot)) return 'uninspectable';
  try {
    lstatSync(absolutePath);
    return 'exists';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'uninspectable';
  }
}

/**
 * 가장 가까운 «실재하는» 조상의 realpath 가 저장소 안인가.
 *
 * ⛔ 조상이 하나도 안 잡히거나 realpath 를 못 읽으면 «안전 쪽»(false)으로 답한다 —
 *    「모르면 통과」로 두면 이 함수가 막으려는 그 오분류가 그대로 난다.
 */
function isRealAncestorInsideRepository(absolutePath: string, realRepositoryRoot: string): boolean {
  let current = absolutePath;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return false;
    try {
      const realParent = realpathSync(parent);
      return isSameOrNestedPath(realParent, realRepositoryRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      current = parent;
    }
  }
}

function absentFirstImplementationPathLine(absent: AbsentFirstImplementationPath): string {
  switch (absent.presence) {
    case 'exists':
      return `- Implementation target not narrowed: ask names ${absent.path} first, and that path exists in the repository, but it lost grounded-candidate selection.`;
    case 'missing':
      return `- Implementation target not narrowed: ask names ${absent.path} first, which does not exist in the repository, so there is nothing to narrow; this is a new-file target.`;
    case 'uninspectable':
      return `- Implementation target not narrowed: ask names ${absent.path} first, but it is not among grounded candidates; repository existence could not be inspected.`;
    case 'not-a-path':
      return `- Implementation target not narrowed: ask names ${absent.path} first, but that token is not a file path (location qualifier or reference prefix); repository existence does not apply.`;
  }
}

function isSafeNewTargetPath(path: string, repositoryRoot: string): boolean {
  if (isAbsolute(path)) return false;
  if (isAskPathLocatorToken(path)) return false;
  const absolutePath = resolve(repositoryRoot, path);
  if (!isSameOrNestedPath(absolutePath, repositoryRoot) || existsSync(absolutePath)) return false;

  let current = repositoryRoot;
  for (const component of relative(repositoryRoot, absolutePath).split(sep)) {
    if (!component || component === '.') continue;
    current = join(current, component);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      // A missing component is valid only after every existing component was safe.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      return false;
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory()) return false;
      continue;
    }
    try {
      const resolved = realpathSync(current);
      if (!isSameOrNestedPath(resolved, repositoryRoot) || !lstatSync(resolved).isDirectory()) return false;
      current = resolved;
    } catch {
      // A dangling symbolic link is not a safe parent for a new repository file.
      return false;
    }
  }
  return true;
}

const NEW_TARGET_PATH_TOKEN = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+$/;

function newTargetFiles(ask: string, repositoryRoot?: string): NewTargetFile | null {
  if (!repositoryRoot) return null;
  let realRepositoryRoot: string;
  try {
    realRepositoryRoot = realpathSync(resolve(repositoryRoot));
  } catch {
    return null;
  }
  // 🩸 2026-09-24(🅞 표본): 산문의 백틱 조각(`원장(`docs/…md`)이` · `docs/`·`*.md`)이 «새 구현 대상 파일»로 뽑혔다 —
  //   `askPathTokens` 는 앞뒤 문장부호만 뗀다. 새 파일 후보는 «경로 문자만으로 된» 토큰만 받는다(백틱·한글·괄호·글롭 거름).
  const paths = askPathTokens(targetScopedGoalText(ask))
    .filter((path) => NEW_TARGET_PATH_TOKEN.test(path))
    .filter((path) => isSafeNewTargetPath(path, realRepositoryRoot));
  return paths.length ? { paths } : null;
}

function absentFirstImplementationPath(
  facts: CodebaseGrounding | null,
  ask: string,
  groundingError = false,
  repositoryRoot?: string,
): AbsentFirstImplementationPath | null {
  if (groundingError || !facts || facts.genericSearchScope) return null;
  const candidates = implementationCandidates(facts);
  if (candidates.length <= 1) return null;
  const firstPath = askPathTokens(ask)[0];
  return firstPath && !candidates.includes(firstPath)
    ? {
      path: firstPath,
      candidateCount: candidates.length,
      presence: classifyAbsentFirstPathPresence(firstPath, repositoryRoot),
    }
    : null;
}

function selectImplementationTarget(facts: CodebaseGrounding | null, ask: string, groundingError = false): ImplementationTargetSelection | null {
  if (groundingError || !facts || facts.genericSearchScope) return null;
  const candidates = implementationCandidates(facts);
  if (candidates.length === 1) return { path: candidates[0], rule: 'single-candidate' };
  if (absentFirstImplementationPath(facts, ask, groundingError)) return null;
  const tokenMatches = candidates
    .map((path) => ({ path, index: firstAskPathTokenIndex(ask, path) }))
    .filter((match): match is { path: string; index: number } => match.index !== null);
  if (tokenMatches.length === 1) return { path: tokenMatches[0].path, rule: 'ask-path-token' };
  if (tokenMatches.length > 1) {
    const firstMatch = tokenMatches.reduce((first, match) => match.index < first.index ? match : first);
    return { path: firstMatch.path, rule: 'first-ask-path-token' };
  }
  return null;
}

function implementationTargetSelectionLine(selection: ImplementationTargetSelection): string {
  const rule = selection.rule === 'single-candidate'
    ? 'rule one'
    : selection.rule === 'ask-path-token'
      ? 'rule two'
      : 'rule three';
  return `- Implementation target narrowed by ${rule}: ${selection.path}`;
}
const PRESERVATION_CONTRACT_QUESTION_ID = 'preservation_contract';
const PRESERVATION_AMBIGUITY_QUESTION_ID = 'preservation_ambiguity';
const PRESERVATION_CONTRACT_CLARIFICATION = 'Clarification required before adding a preservation criterion: grounded code facts identify exported symbols only, not the behavior, signature, compatibility, or call path that must remain unchanged. Provide a failing test filename or one line from the error message that identifies the existing contract. If nothing currently fails, provide the current contract as a command and its output, for example `bun test src/self-implement/goal-author.test.ts` → `0 fail`.';
const PRESERVATION_AMBIGUITY_CLARIFICATION = 'Persistent grounding evidence contains an explicit unmet requirement but remains a preservation contract. Clarify the implementation requirement before launch. If nothing currently fails, provide the current contract as a command and its output, for example `bun test src/self-implement/goal-author.test.ts` → `0 fail`.';

const DEFAULT_CLARIFICATION_OPTIONS: Question['options'] = [
  {
    label: 'Failing test filename',
    description: 'Provide the focused test file that demonstrates the failure.',
  },
  {
    label: 'One error-message line',
    description: 'Provide one error line that identifies the existing contract.',
  },
  {
    label: 'Command and its current output',
    description: 'Use the Other free-form response to provide one command and the current output it produces; selecting this label alone is not an answer.',
  },
];

function clarificationQuestion(id: string, question: string, options: Question['options'] = DEFAULT_CLARIFICATION_OPTIONS): Question {
  return {
    id,
    header: 'Clarification',
    question,
    options,
    includeOther: true,
  };
}

/** Keep externally supplied answers within one Markdown list item. */
function renderClarificationValue(value: string): string {
  return /[\r\n]/.test(value) ? JSON.stringify(value) : value;
}

function renderClarification(
  question: Question,
  response: GoalAuthorClarificationResponse | undefined,
): string[] {
  const answerValue = response?.answer === null || response === undefined
    ? `DEFERRED-UNTIL: ${question.question}`
    : renderClarificationValue(response.answer);
  const provenance = response?.provenance;
  return [
    '- Clarification:',
    `  - id: ${question.id}`,
    `  - header: ${question.header}`,
    `  - question: ${question.question}`,
    '  - options:',
    ...question.options.flatMap((option) => [
      `    - label: ${option.label}`,
      `      description: ${option.description}`,
    ]),
    `  - includeOther: ${question.includeOther !== false}`,
    `  - answer: ${answerValue}`,
    ...(provenance ? [`  - provenance.source: ${provenance.source}`] : []),
    ...(provenance?.evidence ?? []).map((evidence) => `  - evidence: ${renderClarificationValue(evidence)}`),
  ];
}

/** General-search files and exports are leads, not traced implementation targets. */
export function requiresImplementationTargetClarification(facts: CodebaseGrounding | null, groundingError?: boolean): boolean;
export function requiresImplementationTargetClarification(facts: CodebaseGrounding | null, ask: string, groundingError?: boolean, repositoryRoot?: string): boolean;
export function requiresImplementationTargetClarification(
  facts: CodebaseGrounding | null,
  askOrGroundingError?: string | boolean,
  groundingError = false,
  repositoryRoot?: string,
): boolean {
  if (typeof askOrGroundingError !== 'string') {
    const legacyGroundingError = askOrGroundingError ?? groundingError;
    return !legacyGroundingError
      && !!facts
      && Boolean(facts.genericSearchScope)
      && implementationCandidates(facts).length > 0;
  }

  return !groundingError
    && (facts ? implementationCandidates(facts).length > 0 : false)
    && newTargetFiles(askOrGroundingError, repositoryRoot) === null
    && selectImplementationTarget(facts, askOrGroundingError, groundingError) === null;
}

function renderedClarification(
  questions: readonly Question[],
  questionId: string,
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  const question = questions.find((candidate) => candidate.id === questionId);
  return question === undefined ? [] : renderClarification(question, clarificationResponses[question.id]);
}

function genericSearchScopePrompt(
  clarificationQuestions: readonly Question[],
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  return renderedClarification(clarificationQuestions, IMPLEMENTATION_TARGET_QUESTION_ID, clarificationResponses);
}

/** ⛔ 이 «한 칸»에 들어갈 수 있는 물음이 «둘»이다 — 앵커 요구(사람 축) 또는 채널 실패 통지(도구 축).
 *  ⛔ 렌더는 id 를 «지목»하므로, 새 물음을 만들고 여기를 안 고치면 그 물음은 문서에 «영영 안 실린다»
 *  (2026-08-11 72차: 이 함수를 안 고쳐서 새 물음이 통째로 사라졌고, 그 회귀를 시험이 잡았다). */
function implementationAnchorPrompt(
  clarificationQuestions: readonly Question[],
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  const anchor = renderedClarification(clarificationQuestions, IMPLEMENTATION_ANCHOR_QUESTION_ID, clarificationResponses);
  return anchor.length ? anchor : renderedClarification(clarificationQuestions, CODE_CHANNEL_FAILED_QUESTION_ID, clarificationResponses);
}

function implementationTargetGrounding(
  facts: CodebaseGrounding | null,
  ask: string,
  groundingError: boolean,
  clarificationAnswers: Readonly<Record<string, string | undefined>>,
  repositoryRoot?: string,
): string[] {
  const selection = selectImplementationTarget(facts, ask, groundingError);
  const newFiles = newTargetFiles(ask, repositoryRoot);
  const lines = newFiles
    ? newFiles.paths.map((path) => `- Implementation target is a new repository file: ${path}`)
    : [];
  if (selection) {
    lines.push(implementationTargetSelectionLine(selection));
    return lines;
  }

  const absentFirstPath = absentFirstImplementationPath(facts, ask, groundingError, repositoryRoot);
  if (absentFirstPath) {
    lines.push(absentFirstImplementationPathLine(absentFirstPath));
  }

  const answer = clarificationAnswers[IMPLEMENTATION_TARGET_QUESTION_ID];
  if (requiresImplementationTargetClarification(facts, ask, groundingError) && answer) {
    lines.push(`- Clarification-grounded implementation target: ${renderClarificationValue(answer)}`);
  }
  return lines;
}

function groundedSummary(facts: CodebaseGrounding | null, groundingError: boolean): string[] {
  if (groundingError || !facts?.genericSearchScope) return [];
  const count = implementationCandidates(facts).length;
  return [`grounded: ${count} unverified code candidate${count === 1 ? '' : 's'} (general search scope)`];
}

function genericSearchScopeNotice(facts: CodebaseGrounding | null, groundingError: boolean): string[] {
  if (groundingError || !facts?.genericSearchScope) return [];
  return ['- Search-scope notice: the ask contains no repository-specific identifier, so grounding used general search terms. An empty or omitted result means the repository scope is unknown, not that the behavior is absent.'];
}

export const ORIGINAL_ASK_MARKER = 'Original ask (verbatim, unmodified):';

/** Attach the authoring evidence contract unless the document already has it as an independent requirement. */
export function appendEvidenceLocationRequirement(document: string): string {
  const hasRequirement = document.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === EVIDENCE_LOCATION_REQUIREMENT || trimmed === `- ${EVIDENCE_LOCATION_REQUIREMENT}`;
  });
  if (hasRequirement) return document;
  const newline = document.includes('\r\n') ? '\r\n' : '\n';
  return `${document}${newline}${newline}${EVIDENCE_LOCATION_REQUIREMENT}`;
}

type EvidenceKind = 'requested' | 'preservation' | 'wiring' | 'default';

type AcceptanceCriterionEvidenceType = 'tsc' | 'test' | 'live' | 'log' | 'mutation' | 'default';

const ACCEPTANCE_CRITERION_EVIDENCE_MARKERS: Readonly<Record<Exclude<AcceptanceCriterionEvidenceType, 'default'>, readonly string[]>> = {
  tsc: ['tsc', 'ci-typecheck-changed.ts'],
  test: ['bun test'],
  live: ['elanous dev', 'elanous self screen'],
  log: ['elanous logs'],
  mutation: ['mutation'],
};

/** Classify a criterion only by a closed list of literal tool and command names it contains. */
export function classifyAcceptanceCriterionEvidence(criterion: string): AcceptanceCriterionEvidenceType {
  const normalized = criterion.toLowerCase();
  for (const [evidenceType, markers] of Object.entries(ACCEPTANCE_CRITERION_EVIDENCE_MARKERS) as Array<[Exclude<AcceptanceCriterionEvidenceType, 'default'>, readonly string[]]>) {
    if (markers.some((marker) => normalized.includes(marker))) return evidenceType;
  }
  return 'default';
}

interface CheckableCriterion {
  line: string;
  evidenceKind: EvidenceKind;
}

interface RequiredEvidenceCriterion {
  tag: EvidenceKind;
  evidence: string;
}

const EVIDENCE_KIND_DESCRIPTIONS: Record<EvidenceKind, string> = {
  requested: 'Evidence that the requested acceptance criteria are met as a group.',
  preservation: 'Evidence that the grounded preservation criteria remain true as a group.',
  wiring: 'Evidence that the changed unit is reached from an existing execution path: name the caller (file and function) and show that call in the diff.',
  default: 'Evidence that the default acceptance criterion is met when no criterion can be classified.',
};

/** Collapse criterion instances into the finite evidence-kind contract; never classify prose by vocabulary. */
function collapseEvidenceKinds(criteria: readonly CheckableCriterion[]): RequiredEvidenceCriterion[] {
  const kinds = new Set(criteria.map(({ evidenceKind }) => evidenceKind));
  return (Object.keys(EVIDENCE_KIND_DESCRIPTIONS) as EvidenceKind[])
    .filter((kind) => kinds.has(kind))
    .map((tag) => ({ tag, evidence: EVIDENCE_KIND_DESCRIPTIONS[tag] }));
}

const LIVE_SURFACE_FORMS = [
  /^\s*TUI\s*나\s*화면을\s*띄운다\s*[.!?]?\s*$/i,
  /^\s*키를\s*넣는다\s*[.!?]?\s*$/,
  /^\s*화면을\s*눈으로\s*본다\s*[.!?]?\s*$/,
  /^\s*실행\s*중인\s*외부\s*표면을\s*조회한다\s*[.!?]?\s*$/,
] as const;

function isLiveSurfaceCriterion(criterion: string): boolean {
  return LIVE_SURFACE_FORMS.some((form) => form.test(criterion));
}

function liveSurfaceBoundary(criteria: readonly string[]): string[] {
  return criteria.map(boundaryDecisionLine);
}

interface SourceCoordinate {
  path: string;
  symbol: string;
}

const SOURCE_PATH = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md|py|rs|go)\b/g;
const SYMBOL_NAME = /\b[A-Z][A-Za-z0-9_$]*\b/g;
const EXPLICIT_SYMBOL_NAME = /#([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
const BARE_LOWER_CAMEL_SYMBOL_NAME = /\b[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g;

function coordinatesIn(text: string): SourceCoordinate[] {
  const paths = Array.from(text.matchAll(SOURCE_PATH));
  return paths.flatMap((match, index) => {
    const path = match[0];
    const start = (match.index ?? 0) + path.length;
    const end = index + 1 < paths.length ? (paths[index + 1].index ?? text.length) : text.length;
    const localText = text.slice(start, end);
    const symbols = new Set([
      ...(localText.match(SYMBOL_NAME) ?? []),
      ...(localText.match(BARE_LOWER_CAMEL_SYMBOL_NAME) ?? []),
      ...Array.from(localText.matchAll(EXPLICIT_SYMBOL_NAME), ([, symbol]) => symbol),
    ]);
    return [...symbols]
      .filter((symbol) => !GENERIC_DOCUMENT_TERMS.has(symbol.toLowerCase()))
      .map((symbol) => ({ path, symbol }));
  });
}

function sharedCoordinates(candidate: string, requested: readonly string[]): SourceCoordinate[] {
  const candidateCoordinates = coordinatesIn(candidate);
  const requestedCoordinates = new Set(requested.flatMap(coordinatesIn).map(({ path, symbol }) => `${path}\u0000${symbol}`));
  return candidateCoordinates.filter(({ path, symbol }) => requestedCoordinates.has(`${path}\u0000${symbol}`));
}

function isMeasuredQuantity(text: string): boolean {
  return /\b\d+(?:[,.]\d+)?(?:\s*[-–]\s*\d+)?(?:\s*[-–]\s*)?(?:entry|entries|item|items|count|counts|file|files|line|lines)\b|\d+(?:[,.]\d+)?\s*(?:개|건|개수|항목)/i.test(text);
}

function rejectedPreservationCriterion(candidate: string, requested: readonly string[]): SourceCoordinate[] {
  const overlaps = sharedCoordinates(candidate, requested);
  return overlaps.length && isMeasuredQuantity(candidate) ? overlaps : [];
}

function persistentEvidenceHasTracedPath(criterion: string): boolean {
  return Array.from(criterion.matchAll(SOURCE_PATH)).length > 0;
}

// ⛔⭐ `wire` 라는 낱말을 쓰지 «않는다» — 이 줄은 골 문서에 실려 무인-리뷰 위험 판정의 스캔 대상이 되고,
//   그 판정의 금전 패턴이 `\b…|transfer|wire)\b` 라 ***「wire transfer」로 오인***한다.
//   📏 실측 2026-08-11: `autoreview.decision declined` 의 riskHits 중 `match:"wire"` 가 ***38건***이고
//     그 sentence 가 «이 줄»이었다(종전 문면 *"If the goal decides not to w-i-r-e it…"* → reason: 실주문/금전 거래).
//     ⛔ 이 주석에 그 낱말을 «그대로» 적지 않는다 — 주석도 파일에 남고, 무엇보다 치환 실수를 부른다(실측).
//   ⇒ 📌 ***저작기가 스스로 넣은 문면이 자기 골을 무인 리뷰에서 떨어뜨렸다.***
//   ⭐ 그리고 `connect` 가 이 자리에서 «더 정확한» 영어다 — 정규식을 피하려고 뜻을 굽힌 것이 아니다.
//   ⚠️ 같은 계열의 나머지(`rewrite` 184 · `production` 220)는 «여기서 안 고친다» —
//     `GOAL_RULES_POLICY` 의 *"Do not replace, rewrite, …the verbatim ask"* 에서 `rewrite` 는
//     ***그 자리에 정확한 낱말***이라 정규식 때문에 왜곡하지 않는다. 그쪽은 판정기(🅣)가 고칠 자리다.
/** ⭐ 테스트가 «배포 코드»를 물게 export 한다 — 문자열을 복사한 시험은 소스를 되돌려도 통과한다(vacuous). */
export const WIRING_CRITERION_LINE = '- Checkable wiring criterion: every unit this goal adds or changes must be reached from an existing execution path — name the caller (file and function) and show that call in the diff. If the goal decides not to connect it, state that as an intentional boundary with its reason.';

/** ⛔ 「배선」 기준을 넣을 수 있는가 — ***채울 수 없으면 넣지 않는다***.
 *
 *  ⭐ 왜 있나(2026-08-11 72차 실측): 무인 리뷰의 «반사 기각»이 *"파서가 실행 경로에 배선되지 않았다"* 를
 *  찾고도 ***"goal 이 배선하라고 요구하지 않았다"*** 로 놓아준다. `review-reflect` 기각 사유 73건 중
 *  ***9건***이 그 형태였고, 두 갈래(「goal 이 요구 안 함」 14 · 「missingEvidence=[] 등가계약 밖」 59)가
 *  ***둘 다 골의 계약으로 되돌아온다*** — `requiredEvidenceFromGoal` 이 required evidence 를 골 문면에서
 *  파생시키기 때문이다(`off-diff-evidence.ts`). ⇒ 레버는 「판사에 예외를 넣기」가 아니라 ***골이 «항상» 요구하기***다.
 *
 *  ⛔ 두 경우엔 넣지 않는다(넣으면 ***채울 수 없는 요구***가 된다):
 *   ⑴ 접지된 코드 후보가 «하나도» 없다 — caller 를 댈 근거가 없다
 *   ⑵ ask 가 «문서만» 가리킨다(명시 경로가 전부 `docs/` 또는 `.md`) */
export function wiringCriterionApplies(ask: string, facts: CodebaseGrounding | null): boolean {
  if (!facts || implementationCandidates(facts).length === 0) return false;
  const named = askPathTokens(ask);
  if (named.length > 0 && named.every((path) => path.startsWith('docs/') || path.endsWith('.md'))) return false;
  return true;
}

function checkableCriteria(
  ask: string,
  checklist: string[],
  facts: CodebaseGrounding | null,
  groundingError: boolean,
  fallbackWhenEmpty: boolean,
  tracedPathsIncluded: boolean,
): CheckableCriterion[] {
  const requested = checklist.length
    ? checklist
    : fallbackWhenEmpty
      ? ['no additional acceptance criterion was extracted; retain the verbatim ask as the authority.']
      : [];
  const requestedCriteria = requested.map((criterion) => ({
    line: requestedCriterionLine(criterion),
    evidenceKind: checklist.length ? 'requested' as const : 'default' as const,
  }));
  const persistentEvidence = facts?.persistentEvidence ?? [];
  const preservationEvidence = persistentEvidence.map((criterion) => ({
    criterion,
    overlaps: rejectedPreservationCriterion(criterion, requested),
    tracedPath: tracedPathsIncluded && persistentEvidenceHasTracedPath(criterion),
  }));
  const preservationCriteria: CheckableCriterion[] = groundingError ? [] : [
    ...(preservationEvidence.some(({ overlaps, tracedPath }) => tracedPath && overlaps.length === 0)
      ? [{
          line: '- Checkable preservation criterion: Current-state observation from grounding is listed in the traced-path section; if it conflicts with this goal\'s requested criteria, the requested criteria take priority.',
          evidenceKind: 'preservation' as const,
        }]
      : []),
    ...preservationEvidence.flatMap(({ criterion, overlaps, tracedPath }): CheckableCriterion[] => {
      if (overlaps.length) {
        const coordinates = overlaps.map(({ path, symbol }) => `${path}#${symbol}`).join(', ');
        return [{ line: `- Preservation criterion rejected: ${criterion} — overlaps requested coordinate(s): ${coordinates}.`, evidenceKind: 'default' }];
      }
      if (tracedPath) return [];
      return [{
        line: `- Checkable preservation criterion: Current-state observation from grounding; if it conflicts with this goal's requested criteria, the requested criteria take priority. ${criterion}`,
        evidenceKind: 'preservation',
      }];
    }),
  ];
  const wiringCriteria: CheckableCriterion[] = !groundingError && wiringCriterionApplies(ask, facts)
    ? [{ line: WIRING_CRITERION_LINE, evidenceKind: 'wiring' }]
    : [];
  return [...requestedCriteria, ...preservationCriteria, ...wiringCriteria];
}

const DECISION_SIGNAL_EVIDENCE = /^(?:decision signal|판정 신호)\s*:\s*(?<![\p{L}\p{N}_])(?:condition|조건)(?![\p{L}\p{N}_])\s*=\s*(.+?)\s*;\s*(?<![\p{L}\p{N}_])(?:observation|관측)(?![\p{L}\p{N}_])\s*=\s*(.+?)\s*;\s*(?<![\p{L}\p{N}_])(?:expected result|기대)(?![\p{L}\p{N}_])\s*=\s*(.+)$/iu;
const ASK_INVARIANT = /(?:^|\s)불변식\s*:\s*(\S(?:.*?\S)?)(?=\s+(?:불변식|판정 신호)\s*:|\n|$)/g;
// ⛔⭐ 이름을 표지와 콜론 **사이**에 넣는 형태(`불변식 rotation-proof: …`)도 표지로 본다.
//    `[S]` 가 2026-08-02 에 **여섯 번** 그렇게 썼고 여섯 번 다 조용히 UNVERIFIABLE 이 됐다.
//    ⚠️ 탐지 전용이라 오탐 비용이 낮다 — 잘못 잡으면 「형식을 확인하라」 한 줄이 더 붙을 뿐이다.
//    ⛔ 파싱 규칙(`ASK_INVARIANT`)은 넓히지 않는다 — 넓히면 계약이 흐려진다.
export const ASK_INVARIANT_MARKER = /(?:^|\s)불변식(?:\s*(?::|은|는)|\s+[^\s:][^:\n]{0,60}:)/gu;
const DECISION_SIGNAL_FIELD_NAMES = ['조건', '관측', '기대'] as const;
const [DECISION_SIGNAL_CONDITION, DECISION_SIGNAL_OBSERVATION, DECISION_SIGNAL_EXPECTED_RESULT] = DECISION_SIGNAL_FIELD_NAMES;
const ASK_DECISION_SIGNAL = new RegExp(
  `(?:^|\\s)(?:판정 신호|decision signal)\\s*:\\s*(?:(?!\\s+(?:판정 신호|decision signal)\\s*:)[^\\r\\n])*?(?<![\\p{L}\\p{N}_])(?:condition|${DECISION_SIGNAL_CONDITION})(?![\\p{L}\\p{N}_])\\s*=\\s*(.+?)\\s*;\\s*(?<![\\p{L}\\p{N}_])(?:observation|${DECISION_SIGNAL_OBSERVATION})(?![\\p{L}\\p{N}_])\\s*=\\s*(.+?)\\s*;\\s*(?<![\\p{L}\\p{N}_])(?:expected result|${DECISION_SIGNAL_EXPECTED_RESULT})(?![\\p{L}\\p{N}_])\\s*=\\s*(.+?)(?=\\s+(?:판정 신호|decision signal)\\s*:|\\r?\\n|$)`,
  'gu',
);
export const ASK_DECISION_SIGNAL_MARKER = /(?:^|\s)(?:decision signal(?:\s*:|\s+is\b)|판정 신호(?:\s*(?::|는)|\s+[^\s:][^:\n]{0,60}:))/giu;
const ASK_BOUNDARY = /(?:^|\s)경계\s*:\s*(\S(?:.*?\S)?)(?=\s+경계\s*:|\r?\n|$)/gu;
// ⛔ 파싱 규칙(`ASK_BOUNDARY`)은 넓히지 않는다. 수식어가 든 표지는 감지해 형식 소견만 낸다.
export const ASK_BOUNDARY_MARKER = /(?:^|\s)경계(?:[^\S\r\n]*:|[^\S\r\n]+[^\s:][^:\n]{0,60}:)/gu;
type DedicatedSectionLabel = '불변식' | '경계' | '답하지 못하는 것' | '한계로 두는 것';
const ASK_LIMITATION_LABELS = ['답하지 못하는 것', '한계로 두는 것'] as const;
const ASK_LIMITATION_LABEL = `(?:${ASK_LIMITATION_LABELS.join('|')})`;
const ASK_LIMITATION = new RegExp(`(?:^|\\s)${ASK_LIMITATION_LABEL}\\s*:\\s*(\\S(?:.*?\\S)?)(?=\\s+${ASK_LIMITATION_LABEL}\\s*:|\\r?\\n|$)`, 'gu');
export const ASK_LIMITATION_MARKER = new RegExp(`(?:^|\\s)${ASK_LIMITATION_LABEL}(?:\\s*:|\\s+[^\\s:][^:\\n]{0,60}:)`, 'gu');

const ASK_MARKERS = [ASK_INVARIANT_MARKER, ASK_DECISION_SIGNAL_MARKER, ASK_BOUNDARY_MARKER, ASK_LIMITATION_MARKER] as const;

interface MarkerGuidance {
  label: string;
  requiredFormat: string;
  correctedExample: string;
}

function decisionSignalFormat(values: readonly string[]): string {
  return `판정 신호: ${DECISION_SIGNAL_FIELD_NAMES.map((field, index) => `${field} = ${values[index]}`).join('; ')}`;
}

export const DECISION_SIGNAL_MARKER_GUIDANCE: MarkerGuidance = {
  label: '판정 신호:',
  requiredFormat: decisionSignalFormat(['<condition>', '<command>', '<result>']),
  correctedExample: decisionSignalFormat(['malformed marker exists', 'bun test src/example.test.ts', 'diagnostic is rendered.']),
};
const INVARIANT_MARKER_GUIDANCE: MarkerGuidance = {
  label: '불변식:',
  requiredFormat: '불변식: <preservation statement>',
  correctedExample: '불변식: src/example.ts remains unchanged.',
};
const BOUNDARY_MARKER_GUIDANCE: MarkerGuidance = {
  label: '경계:',
  requiredFormat: '경계: <intentional boundary decision>',
  correctedExample: '경계: src/example.ts만 고친다.',
};

interface AskMarkerInspection {
  matched: boolean;
  marker: boolean;
  extracted: boolean;
  matches: string[];
}

type InvariantGroundingInspection = 'not-attempted' | 'attempted';
type InvariantPathStatus =
  | 'inspection-not-attempted'
  | 'zero-invariants'
  | 'no-invariant-paths-supplied'
  | 'all-supplied-paths-matched'
  | 'partial-supplied-paths-matched'
  | 'invariant-grounding-mismatch'
  | 'absent-declared-new-target-paths';

interface AskInvariantMarkerInspection extends AskMarkerInspection {
  pathEvidence: boolean | 'unknown';
  unmatchedEvidencePaths: string[];
  // ⭐ optional 이 아니다 — «모든» 반환 경로가 항상 싣는다. 타입이 그 계약을 말하게 둔다.
  groundingInspection: InvariantGroundingInspection;
  invariantPathStatus: InvariantPathStatus;
  // ⭐ 새 갈래에 해당하는 경로를 «이름»으로 낸다. 개수만으로는 사람이 못 고친다.
  //    기존 다섯 갈래에서는 빈 배열 — 필드가 빠지면 소비자가 갈래를 못 읽는다.
  absentDeclaredNewTargetPaths: string[];
}

interface AskBoundaryMarkerInspection extends AskMarkerInspection {
  pathEvidence: 'not-applicable';
}

type ExpectedResultClassification = 'structural' | 'output' | 'indeterminate';
/** true = presence, false = absence, null = both vocabularies matched, 'unreadable' = neither matched. */
type ExpectsPresence = boolean | null | 'unreadable';

interface DecisionSignalInspectionMatch {
  match: string;
  expectsPresence: ExpectsPresence;
  expectsAlternatives: boolean;
  observesCount: boolean;
  observesIdentifierNames: boolean;
  /** 관측이 «구현이 스스로 채우는 값»인가 — 값만 넣고 통과할 수 있다. */
  observesSelfReportedField: boolean;
}

interface AskDecisionSignalMarkerInspection extends Omit<AskMarkerInspection, 'matches'> {
  matches: DecisionSignalInspectionMatch[];
  allNegative: boolean;
  unreadableCount: number;
  anyAlternatives: boolean;
  anyObservesCount: boolean;
  anyObservesIdentifierNames: boolean;
  /** 어느 신호든 «구현이 스스로 채우는 값»을 관측하는가. */
  anyObservesSelfReportedField: boolean;
  condition?: string;
  observation?: string;
  expectedResult?: string;
  expectedResultClassification?: ExpectedResultClassification;
}

const STRUCTURAL_EXPECTED_RESULT_VERB = /부른다|호출한다|불린다|지나간다|실행된다/u;
const OUTPUT_EXPECTED_RESULT_VERB = /뜬다|실린다|난다|줄어든다|늘어난다|보인다|기록된다/u;
const ABSENCE_EXPECTATION = /없다|(?<!\d)0(?!\d)|아니다|사라졌다/u;
const PRESENCE_EXPECTATION = /있다|여전히|유지|크다|이상/u;
const ALTERNATIVE_EXPECTATION = /또는|중 하나|아무거나/u;
const STANDALONE_GEONA = /(?<![가-힣])거나/u;
const ATTACHED_GEONA = /[가-힣]거나\s+(\S+)/gu;
const HANGUL_SYLLABLE_BASE = 0xAC00;
const HANGUL_SYLLABLE_LAST = 0xD7A3;
const JONGSEONG_NIEUN = 4;
const JONGSEONG_RIEUL = 8;
const COUNT_OBSERVATION = /개수|건수|(?<![\p{L}\p{N}_])(?:수|N)(?![\p{L}\p{N}_])/u;
const COUNT_OBSERVATION_EN = /(?<![\p{L}\p{N}_])count(?![\p{L}\p{N}_])/iu;

// ⛔⭐ 「수를 잰다」의 «형제» — 관측이 «식별자 목록»(시험 이름·심볼 이름·필드 이름)이면
//    자식이 만드는 가장 싼 통과 경로가 ***「소스를 읽어 그 이름 문자열이 있는지 보는 시험」***이 된다.
//    그런 시험은 그 이름이 붙은 시험들의 «본문을 전부 비워도» 통과한다.
//    🩸 실물(2026-09-07 · #15791): 내가 판정 신호에 「관측=그 파일이 «등록한 시험 이름 목록»」이라 적었고,
//       자식은 그것을 정확히 구현했다 — `for (const name of preserved) expect(src).toContain(name)`.
//       무인 리뷰가 그것을 GOODHART 로 잡았지만, ***그때는 이미 착지 직전이었다.***
//       ⊕ 같은 문면이 그날 골 문서 «24개»에 있었다(전수: rg "관측=.*시험 이름|관측=.*이름 목록" docs/goals/).
//    ⇒ 그래서 저작 시점에 말한다. ⛔ 이것은 「이름을 쓰지 마라」가 아니라
//       ***「이름의 «존재»를 관측으로 삼지 마라」***다 — 이름이 조건 칸에 있는 것은 문제가 아니다.
const IDENTIFIER_LIST_OBSERVATION = /(?:시험|테스트|test|함수|심볼|필드|키|메서드)\s*(?:의\s*)?이름|이름\s*목록|name\s+list|list\s+of\s+(?:test|function|symbol|field)\s+names/iu;

function presenceExpectationTerms(pattern: RegExp = PRESENCE_EXPECTATION): string[] {
  const decoded = pattern.source
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  return decoded.split('|').filter((term) => term.length > 0);
}

/** Lint copy for all-negative decision signals; vocabulary is derived from the classifier regex. */
export function allNegativeSignalsLintMessage(pattern: RegExp = PRESENCE_EXPECTATION): string {
  const terms = presenceExpectationTerms(pattern).map((term) => `\`${term}\``).join(', ');
  return `## 판정 신호 explicitly expects only absence; revise the signal to require the intended presence or persistence outcome (for example, ${terms})`;
}

/** Lint copy when the existing classifier cannot recognize one or more decision-signal expectations. */
export function unreadableSignalsLintMessage(): string {
  return '## 판정 신호 includes expectation text this classifier cannot read; it distinguishes absence (`없다`, `0`, `아니다`, `사라졌다`) and presence/persistence (`있다`, `여전히`, `유지`, `크다`, `이상`) vocabulary. If the sentence is already correct, do not insert this vocabulary; report the classifier limitation instead.';
}

function classifyExpectedResultPredicate(expectedResult: string): ExpectedResultClassification {
  const structural = STRUCTURAL_EXPECTED_RESULT_VERB.test(expectedResult);
  const output = OUTPUT_EXPECTED_RESULT_VERB.test(expectedResult);
  return structural === output ? 'indeterminate' : structural ? 'structural' : 'output';
}

/** Presence vs absence expected by a decision-signal 기대 문면. Observation only — never a gate. */
const VALUE_ZERO_EXPECTATION = /(?:(?:종료\s*코드|exit\s*code|(?<![가-힣])값)\s*(?:가|는|은|이)?\s*(?:=|is|가|는|은|이)?\s*0\s*(?:(?:이\s*)?아니다|이다|입니다|임)?|0을\s*반환한다)/giu;

function classifyExpectsPresence(expectedResult: string): ExpectsPresence {
  const absence = ABSENCE_EXPECTATION.test(expectedResult.replace(VALUE_ZERO_EXPECTATION, ''));
  const presence = PRESENCE_EXPECTATION.test(expectedResult);
  if (presence === absence) return presence ? null : 'unreadable';
  return presence;
}

function isCoordinatedAttributive(word: string): boolean {
  if (!/^[가-힣]+$/u.test(word) || /다$/u.test(word)) return false;
  const last = [...word].at(-1);
  const code = last?.codePointAt(0);
  if (code === undefined || code < HANGUL_SYLLABLE_BASE || code > HANGUL_SYLLABLE_LAST) return false;
  const jongseong = (code - HANGUL_SYLLABLE_BASE) % 28;
  return jongseong === JONGSEONG_NIEUN || jongseong === JONGSEONG_RIEUL || /[은는던을]$/u.test(word);
}

/** Whether a 기대 문면 names alternative branches. Observation only — never a gate. Unknown or conjunction stays false. */
function classifyExpectsAlternatives(expectedResult: string): boolean {
  if (ALTERNATIVE_EXPECTATION.test(expectedResult) || STANDALONE_GEONA.test(expectedResult)) return true;
  for (const match of expectedResult.matchAll(ATTACHED_GEONA)) {
    const next = match[1];
    if (next !== undefined && !isCoordinatedAttributive(next)) return true;
  }
  return false;
}

/** Whether a 관측 문면 measures a count rather than content. Observation only — never a gate. Unisolated observation stays false. */
function classifyObservesCount(observation: string): boolean {
  return COUNT_OBSERVATION.test(observation) || COUNT_OBSERVATION_EN.test(observation);
}

/** 관측 칸이 «식별자 이름의 존재»를 재는가 — 그러면 본문이 비어도 통과하는 시험을 주문한 것이다. */
function classifyObservesIdentifierNames(observation: string): boolean {
  return IDENTIFIER_LIST_OBSERVATION.test(observation);
}

/** Directly runnable script entries (`scripts/x.ts`), not their tests. */
const RUNNABLE_SCRIPT_ENTRY = /^scripts\/(?!.*\.test\.ts$)[^/\s]+\.ts$/;

/**
 * A decision signal requires the count from running that entry with no arguments
 * from the repository root. Korean and English share the same shape: the entry
 * path, a no-argument invocation, and a recorded count.
 */
function signalRequiresDefaultInvocationCount(signal: string, entry: string): boolean {
  if (!signal.includes(entry)) return false;
  const noArgs = /(?:인자\s*없이|인수\s*없이|no\s+args|no\s+arguments|without\s+(?:any\s+)?args|without\s+(?:any\s+)?arguments)/iu.test(signal);
  const recordsCount = /(?:나온\s*수|수를\s|개수|건수|(?<![\p{L}\p{N}_])count(?![\p{L}\p{N}_])|\d+)/iu.test(signal);
  return noArgs && recordsCount;
}

/** Replacement wording, not prohibition alone. */
export function defaultInvocationObservationMessage(entries: readonly string[]): string {
  const replacements = entries.map((entry) => `put the count from running \`${entry}\` with no args at the repo root into the decision signal (「${entry}을 인자 없이 저장소 루트에서 돌려 나온 수를 판정 신호로 둔다」)`);
  return `## 판정 신호 does not require the count from running ${entries.join(', ')} with default arguments from the repository root. ${replacements.join(' ')}`;
}

/**
 * Runnable `scripts/*.ts` targets whose decision signals never require the
 * no-argument repository-root count. Test files and non-script targets stay quiet.
 */
export function runnableScriptEntriesMissingDefaultInvocation(document: string): string[] {
  const originalAsk = verbatimOriginalAsk(document);
  const targets = [
    ...declaredTargetPaths(document),
    ...(originalAsk === null ? [] : declaredTargetPaths(originalAsk)),
  ];
  const entries = [...new Set(targets.filter((path) => RUNNABLE_SCRIPT_ENTRY.test(path)))];
  if (!entries.length) return [];
  const decisionSignal = markdownSection(document, '판정 신호') ?? '';
  const signals = [
    ...decisionSignal.split(/\r?\n/),
    ...(originalAsk === null ? [] : originalAsk.split(/\r?\n/).filter((line) => /(?:판정 신호|decision signal)\s*:/iu.test(line))),
  ];
  return entries.filter((entry) => !signals.some((signal) => signalRequiresDefaultInvocationCount(signal, entry)));
}

/**
 * 관측 칸이 «구현이 스스로 채우는 값»(필드·플래그·반환값)을 재는가.
 *
 * 🩸 2026-09-08: `관측 = 산출 JSON 의 captureScope 필드; 기대 = 그 값이 full-page 이다` 로 쏜 골이
 *    ***같은 자리에서 두 번*** 죽었는데 ***두 번 다 이 신호는 초록***이었다. 1차는 Chrome 이 조용히 무시한
 *    CLI 플래그였고(캡처 1280×900 ↔ 실제 4651), 수리 1차는 CDP 타임아웃으로 파일조차 안 남았는데
 *    산출은 여전히 `captureScope:'full-page'` 를 «말했다».
 * ⛔ 위 `classifyObservesIdentifierNames` 는 이 문면을 «안 문다»(실측: observesIdentifierNames=false).
 * ⭐ 어휘를 새로 만들지 않고 `design/behaviour-signal` 의 분류기를 그대로 쓴다 — 그쪽이 「둘 다 걸리면
 *    외부 결과 쪽」 같은 우선순위를 이미 시험으로 못 박아 두었다.
 */
function classifyObservesSelfReportedField(observation: string): boolean {
  return classifyObservation(observation) === 'self-reported';
}

function inspectAskMarker(ask: string, marker: RegExp, extracted: readonly AskMatch<unknown>[]): AskMarkerInspection {
  const markerPattern = new RegExp(marker.source, marker.flags);
  const matches = Array.from(ask.matchAll(markerPattern), (match) => match[0]);
  const matched = matches.length > 0;
  return { matched, marker: matched, extracted: extracted.length > 0, matches };
}

function annotateDecisionSignalMatches(
  ask: string,
  matches: readonly string[],
  signals: readonly AskMatch<DecisionSignalCandidate>[],
): DecisionSignalInspectionMatch[] {
  const markerPattern = new RegExp(ASK_DECISION_SIGNAL_MARKER.source, ASK_DECISION_SIGNAL_MARKER.flags);
  const spans = Array.from(ask.matchAll(markerPattern), (match) => {
    const start = match.index ?? 0;
    return { text: match[0], start };
  });
  return matches.map((text, index) => {
    const start = spans[index]?.start ?? 0;
    const nextStart = spans[index + 1]?.start ?? ask.length;
    const extracted = signals.find((signal) => signal.start >= start && signal.start < nextStart);
    return {
      match: text,
      expectsPresence: extracted ? classifyExpectsPresence(extracted.value.expectedResult) : null,
      expectsAlternatives: extracted ? classifyExpectsAlternatives(extracted.value.expectedResult) : false,
      observesCount: extracted ? classifyObservesCount(extracted.value.observation) : false,
      observesIdentifierNames: extracted ? classifyObservesIdentifierNames(extracted.value.observation) : false,
      observesSelfReportedField: extracted ? classifyObservesSelfReportedField(extracted.value.observation) : false,
    };
  });
}

/** Inspect deployed decision-signal marker and extraction behavior without authoring a goal document. */
export function inspectAskDecisionSignalMarker(ask: string): AskDecisionSignalMarkerInspection {
  const signals = parseAskDecisionSignals(ask);
  const signal = signals[0]?.value;
  const inspection = inspectAskMarker(ask, ASK_DECISION_SIGNAL_MARKER, signals);
  const matches = annotateDecisionSignalMatches(ask, inspection.matches, signals);
  return {
    ...inspection,
    matches,
    allNegative: matches.every((match) => match.expectsPresence !== true),
    unreadableCount: matches.filter((match) => match.expectsPresence === 'unreadable').length,
    anyAlternatives: matches.some((match) => match.expectsAlternatives),
    anyObservesCount: matches.some((match) => match.observesCount),
    anyObservesIdentifierNames: matches.some((match) => match.observesIdentifierNames),
    anyObservesSelfReportedField: matches.some((match) => match.observesSelfReportedField),
    ...(signal && {
      condition: signal.condition,
      observation: signal.observation,
      expectedResult: signal.expectedResult,
      expectedResultClassification: classifyExpectedResultPredicate(signal.expectedResult),
    }),
  };
}

function declaredSafeNewTargetPaths(ask: string, repositoryRoot?: string): string[] {
  const declared = new Set(declaredTargetPaths(ask));
  if (declared.size === 0) return [];
  return (newTargetFiles(ask, repositoryRoot)?.paths ?? []).filter((path) => declared.has(path));
}

function absentDeclaredNewTargetEvidencePaths(
  unmatchedEvidencePaths: readonly string[],
  declaredSafeNewTargets: readonly string[],
): string[] {
  if (declaredSafeNewTargets.length === 0) return [];
  const declared = new Set(declaredSafeNewTargets);
  return unmatchedEvidencePaths.filter((path) => declared.has(path));
}

/** Inspect deployed invariant marker, extraction, and supplied grounding evidence without authoring or grounding. */
export function inspectAskInvariantMarker(
  ask: string,
  facts: CodebaseGrounding | null = null,
  repositoryRoot?: string,
): AskInvariantMarkerInspection {
  const invariants = recognizedInvariantCandidates(ask);
  const inspection = inspectAskMarker(ask, ASK_INVARIANT_MARKER, invariants);
  // ⛔ 여기에 「마커 없음」 이른 반환을 두지 마라 — 아래 본 경로가 «이미» 그 경우를 옳게 다룬다:
  //    invariants 가 비면 unmatchedEvidencePaths 는 [] 이고 pathEvidence 는 기존 분기를 그대로 탄다.
  //    🩸 실물(2026-09-01): 이른 반환이 `facts !== null` 이면 무조건 false 를 내서,
  //       「facts 는 있는데 persistentEvidence 가 «0»」인 경우의 기존 값 'unknown' 을 «바꿨다».
  //       ⇒ 그것은 이 판의 불변식(기존 값의 «뜻»을 안 바꾼다) 위반이고, 새 필드도 안 실렸다.
  const availableEvidencePaths = new Set((facts?.persistentEvidence ?? []).flatMap(evidencePaths));
  const invariantEvidencePaths = [...new Set(invariants.flatMap(({ value }) => evidencePaths(value)))];
  const unmatchedEvidencePaths = invariantEvidencePaths
    .filter((path) => !availableEvidencePaths.has(path));
  const groundingInspection = facts === null || availableEvidencePaths.size === 0
    ? 'not-attempted'
    : 'attempted';
  const pathEvidence = groundingInspection === 'not-attempted'
    ? 'unknown'
    : invariants.length > 0 && invariants.every(({ value }) => matchingPersistentEvidence(value, facts).length > 0);
  const absentDeclaredNewTargetPaths = groundingInspection === 'attempted' && unmatchedEvidencePaths.length > 0
    ? absentDeclaredNewTargetEvidencePaths(
      unmatchedEvidencePaths,
      declaredSafeNewTargetPaths(ask, repositoryRoot ?? process.cwd()),
    )
    : [];
  const invariantPathStatus = invariants.length === 0
    ? 'zero-invariants'
    : invariantEvidencePaths.length === 0
      ? 'no-invariant-paths-supplied'
      : groundingInspection === 'not-attempted'
        ? 'inspection-not-attempted'
        : unmatchedEvidencePaths.length > 0 && unmatchedEvidencePaths.length < invariantEvidencePaths.length
          ? 'partial-supplied-paths-matched'
          : pathEvidence
            ? 'all-supplied-paths-matched'
            : absentDeclaredNewTargetPaths.length > 0
              && absentDeclaredNewTargetPaths.length === unmatchedEvidencePaths.length
              ? 'absent-declared-new-target-paths'
              : 'invariant-grounding-mismatch';
  return {
    ...inspection,
    pathEvidence,
    unmatchedEvidencePaths,
    groundingInspection,
    invariantPathStatus,
    absentDeclaredNewTargetPaths,
  };
}

/** Inspect deployed boundary marker and extraction behavior without authoring or grounding. */
export function inspectAskBoundaryMarker(ask: string): AskBoundaryMarkerInspection {
  const boundaries = orderedAskMatches([
    ...askBoundaryDecisions(ask),
  ]);
  const inspection = inspectAskMarker(ask, ASK_BOUNDARY_MARKER, boundaries);
  return { ...inspection, pathEvidence: 'not-applicable' };
}

function formatEarlyMarkerWarnings(ask: string): string[] {
  const inspections = [
    [DECISION_SIGNAL_MARKER_GUIDANCE, inspectAskDecisionSignalMarker(ask)],
    [INVARIANT_MARKER_GUIDANCE, inspectAskInvariantMarker(ask)],
    [BOUNDARY_MARKER_GUIDANCE, inspectAskBoundaryMarker(ask)],
  ] as const;
  const unparsedWarnings = inspections.flatMap(([guidance, inspection]) => {
    if (!inspection.marker || inspection.extracted) return [];
    const renderedGuidance = renderUnparsedMarker(
      guidance.label,
      '',
      guidance.requiredFormat,
      guidance.correctedExample,
    );
    const formatAndExample = renderedGuidance.slice(renderedGuidance.indexOf('; ') + 2);
    return [`[goal-author] marker warning: ${guidance.label} marker is present but could not be extracted; ${formatAndExample}\n`];
  });
  const wrappedInvariantMarkerSources = headingFormMarkerSources(
    ask,
    '불변식',
    recognizedInvariantCandidates(ask),
  );
  const headingWarnings = wrappedInvariantMarkerSources
    .map((source) => `[goal-author] marker warning: ${renderWrappedInvariantMarkerWarning(source)}\n`);
  return [...unparsedWarnings, ...headingWarnings];
}

const UNPARSED_INVARIANT_MARKER = '- UNVERIFIABLE: Ask contains an invariant marker, but at least one entry did not match the required invariant format.';
const UNPARSED_DECISION_SIGNAL_MARKER = '- UNVERIFIABLE: Ask contains a decision-signal marker, but at least one entry did not match the required condition/observation/expected result format.';
const UNPARSED_BOUNDARY_MARKER = '- UNVERIFIABLE: Ask contains a boundary marker, but at least one entry did not match the required boundary format.';
const UNPARSED_LIMITATION_MARKER = '- UNVERIFIABLE: Ask contains a limitation marker, but at least one entry did not match the required limitation format.';
const UNPARSED_SOURCE_LIMIT = 240;
const ABSENT_INVARIANT_EVIDENCE = '- UNVERIFIABLE: No Read-verified invariant evidence with condition, observation, and expected result is available.';
const ABSENT_DECISION_SIGNAL_EVIDENCE = '- UNVERIFIABLE: No Read-verified decision signal with condition, observation, and expected result is available.';

function substringCount(value: string, substring: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(substring, start);
    if (index === -1) return count;
    count += 1;
    start = index + substring.length;
  }
}

export function askSectionCountInformation(
  label: string,
  ask: string,
  renderedCount: number,
  alwaysRender = false,
  marker?: RegExp,
  phraseCount = substringCount(ask, label),
): string[] {
  const askCount = marker
    ? Array.from(ask.matchAll(new RegExp(marker.source, marker.flags))).length
    : substringCount(ask, label);
  if (!(alwaysRender || askCount !== renderedCount)) return [];
  const counted = marker
    ? describeFormatMatchingAskCount(label, askCount, phraseCount)
    : `ask contains the phrase "${label}" ${askCount} time(s)`;
  return [`- Information: ${counted}; this section contains ${renderedCount} item(s).`];
}

function describeFormatMatchingAskCount(label: string, askCount: number, phraseCount: number): string {
  const formatted = `ask has ${askCount} format-matching "${label}" item(s)`;
  if (phraseCount === 0) return `${formatted} (the phrase "${label}" does not appear)`;
  if (phraseCount === askCount) return formatted;
  if (askCount === 0) {
    return `${formatted} (the phrase "${label}" appears ${phraseCount} time(s) but not in marker form)`;
  }
  return `${formatted} (the phrase "${label}" appears ${phraseCount} time(s))`;
}

/** ⭐ 골 문서에서 ***사람이 쓴 ask 원문만*** 떼어 낸다(없으면 `null` — 던지지 않는다).
 *
 *  ⛔⭐ **왜 export 하나**(2026-08-11 73차): 골 문서는 세 종류의 텍스트가 «다른 절»에 있다 —
 *  ⓐ 사람의 ask · ⓑ 저작기가 넣은 정책·기준 · ⓒ 접지가 쓴 근거 프로즈.
 *  그런데 소비자들이 그것을 ***평평하게*** 읽어 ⓑⓒ 의 낱말이 ⓐ 의 «의도»로 오인된다.
 *  📏 실측: 무인 리뷰 위험 판정의 riskHits ***643 중 442(68.7%)***가 ⓑⓒ 에서 왔다
 *    (`production` 220 = 접지 프로즈 · `rewrite` 184 = 저작기 정책 한 줄 · `wire` 38 = 배선 기준).
 *  ⇒ 📌 그 판정이 ***이 함수를 써서 ⓐ 만 보면*** 그 442 가 사라진다.
 *  ⚠️ 같은 추출이 `goal-author-cli.ts:extractOriginalAsk` 에도 «따로» 있다(그쪽은 던진다).
 *    ⛔ 이 창에서는 «합치지 않았다» — 오류 계약이 달라 합치는 것은 별개 착지다. */
export interface VerbatimOriginalAsk {
  ask: string;
  /** Omitted when normalization means the document substring cannot equal `ask` exactly. */
  range?: { start: number; end: number };
}

/** Extract the original ask and its already-known offsets in the goal document. */
export function extractVerbatimOriginalAsk(document: string): VerbatimOriginalAsk | null {
  const lines = [...document.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => ({ text: match[1], start: match.index!, end: match.index! + match[0].length, contentEnd: match.index! + match[1].length }));
  // ⛔ 문자열을 다시 쓰지 않는다 — 같은 파일이 export 하는 상수 하나에서 파생한다(2026-08-11: 하드코딩이었다).
  const heading = lines.findIndex(({ text }) => text === ORIGINAL_ASK_MARKER);
  if (heading < 0) return null;
  const opening = /^(\s*)(`{3,})[^`]*\s*$/.exec(lines[heading + 1]?.text ?? '');
  if (!opening) return null;
  const [, indentation, fence] = opening;
  const closing = new RegExp(`^${escapeRegularExpression(indentation)}${escapeRegularExpression(fence)}\\s*$`);
  const end = lines.findIndex(({ text }, index) => index > heading + 1 && closing.test(text));
  if (end < 0) return null;

  const start = lines[heading + 1].end;
  const range = { start, end: end === heading + 2 ? lines[end].start : lines[end - 1].contentEnd };
  return { ask: document.slice(range.start, range.end), range };
}

/** Backward-compatible string-only view of extractVerbatimOriginalAsk. */
export function verbatimOriginalAsk(document: string): string | null {
  return extractVerbatimOriginalAsk(document)?.ask ?? null;
}

/** One header under which a fragment copies its parent document's `경계:` lines verbatim.
 *  Not a markdown heading: a `##` line inside SCOPE BOUNDARY splits the required-block order. */
export const PARENT_BOUNDARY_HEADER = 'Parent boundary lines:';

/** `경계:` lines of one document, in source order, with surrounding whitespace removed and nothing else rewritten. */
export function boundaryLinesVerbatim(document: string): string[] {
  const ask = verbatimOriginalAsk(document) ?? document;
  return ask.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('경계:') ? [trimmed] : [];
  });
}

/** When a fragment has a parent, one header followed by that parent's `경계:` lines; otherwise nothing. */
export function parentBoundaryLines(parentDocument: string | undefined): string[] {
  if (parentDocument === undefined) return [];
  const lines = boundaryLinesVerbatim(parentDocument);
  return lines.length === 0 ? [] : [PARENT_BOUNDARY_HEADER, ...lines];
}

/** 재저작이 «사람의 ask» 를 지켰는지 — 부모 골과 자식 골의 원래 ask 블록을 마주 세운다.
 *
 *  ⭐ 왜 있나(2026-08-11 72차): 되묻기에 답하면 재저작이 «일어나는» 것까지는 관측(`ask-reauthored`)이
 *  증명했지만, 그 자식 골의 ask 가 ***저작기 자신의 질문***으로 바뀌어 있었다(`#8230` → `#8236`).
 *  ⇒ 📌 ***레코드는 「그 사건이 났다」를 증명하지 「그 사건이 «옳았다»」를 증명하지 않는다***(`JDG-T35` 3단 ⑶).
 *  그 ⑶ 을 «사람 눈»에서 «값»으로 옮기는 것이 이 함수다.
 *
 *  ⛔ 「같지 않다」와 「못 쟀다」를 ***다른 값***으로 낸다 — 어느 쪽 문서에서든 블록을 못 읽으면
 *  `unmeasurable` 이지 `replaced` 가 아니다(부재와 미지를 같은 값에 두지 않는다).
 *  ⛔ 임계도 유사도도 없다 — 문자열 동치 하나다. */
export type ReauthoredAskFidelity = 'preserved' | 'replaced' | 'unmeasurable';

export function classifyReauthoredAsk(parentDocument: string, childDocument: string): ReauthoredAskFidelity {
  const parentAsk = verbatimOriginalAsk(parentDocument);
  const childAsk = verbatimOriginalAsk(childDocument);
  if (parentAsk === null || childAsk === null) return 'unmeasurable';
  return parentAsk.trim() === childAsk.trim() ? 'preserved' : 'replaced';
}

function askSectionCountLintFindings(document: string): GoalFileLintFinding[] {
  const ask = verbatimOriginalAsk(document);
  if (ask === null) return [];
  const sections: ReadonlyArray<readonly [string, string, RegExp, (section: string) => number]> = [
    ['SCOPE BOUNDARY', '경계', ASK_BOUNDARY_MARKER, (section) => section.split(/\r?\n/).filter((line) => line.startsWith('- Boundary decision:')).length],
    ['답하지 못하는 것', '답하지 못하는 것', ASK_LIMITATION_MARKER, (section) => section.split(/\r?\n/).filter((line) => line.startsWith('- Author limitation:')).length],
    ['불변식', '불변식', ASK_INVARIANT_MARKER, (section) => section.split(/\r?\n/).filter((line) => line.startsWith('- Invariant candidate:')).length],
    ['판정 신호', '판정 신호', ASK_DECISION_SIGNAL_MARKER, (section) => section.split(/\r?\n/).filter((line) => line === '- Candidate decision signal:').length],
  ];
  return sections.flatMap(([heading, label, marker, count]) => {
    const section = markdownSection(document, heading);
    if (section === null) return [];
    return askSectionCountInformation(label, ask, count(section), false, marker, substringCount(ask, label))
      .map((message) => canonicalStructureFinding('ask-section-relationship', 'WARN', message.slice(2)));
  });
}

interface DecisionSignalCandidate {
  evidence: string;
  condition: string;
  observation: string;
  expectedResult: string;
  numericSource?: string;
  numericCoverage?: string;
}

function parseDecisionSignal(entry: string, pattern: RegExp): DecisionSignalCandidate | null {
  const match = pattern.exec(entry);
  if (!match) return null;
  const [, rawCondition, rawObservation, rawExpectedResult] = match;
  const condition = rawCondition.trim();
  const observation = rawObservation.trim();
  const expectedResult = rawExpectedResult.trim();
  return condition && observation && expectedResult
    ? { evidence: entry, condition, observation, expectedResult }
    : null;
}

function evidenceDecisionSignalCandidates(facts: CodebaseGrounding | null): DecisionSignalCandidate[] {
  return (facts?.persistentEvidence ?? []).flatMap((entry) => {
    const candidate = parseDecisionSignal(entry, DECISION_SIGNAL_EVIDENCE);
    return candidate ? [candidate] : [];
  });
}

interface AskMatch<T> {
  value: T;
  start: number;
  end: number;
}

interface AskMarkerSegment {
  source: string;
  start: number;
  markerEnd: number;
  end: number;
}

function askMarkerSpans(ask: string, marker: RegExp): Array<{ start: number; end: number }> {
  return Array.from(ask.matchAll(marker), (match) => {
    const rawStart = match.index ?? 0;
    const start = rawStart + (match[0].search(/\S/u) || 0);
    return { start, end: rawStart + match[0].length };
  });
}

function boundedAskMarkerSegments(ask: string, marker: RegExp): AskMarkerSegment[] {
  const allMarkerStarts = ASK_MARKERS.flatMap((pattern) => askMarkerSpans(ask, pattern).map(({ start }) => start))
    .sort((left, right) => left - right);
  return askMarkerSpans(ask, marker).map(({ start, end: markerEnd }) => {
    const nextMarker = allMarkerStarts.find((markerStart) => markerStart > start) ?? ask.length;
    const lineEnd = ask.indexOf('\n', start);
    const end = Math.min(nextMarker, lineEnd === -1 ? ask.length : lineEnd);
    return { source: ask.slice(start, end).trim(), start, markerEnd, end };
  });
}

function orderedAskMatches<T extends AskMatch<unknown>>(matches: readonly T[]): T[] {
  return [...matches].sort((left, right) => left.start - right.start);
}

function markerOutsideMatches(ask: string, marker: RegExp, matches: readonly AskMatch<unknown>[]): string[] {
  return boundedAskMarkerSegments(ask, marker).flatMap(({ source, start, markerEnd }) => {
    const consumed = matches.some((candidate) => start >= candidate.start && markerEnd <= candidate.end);
    return consumed || !source ? [] : [source];
  });
}

function renderUnparsedMarker(
  marker: string,
  source: string,
  requiredFormat: string,
  correctedExample: string,
): string {
  const truncated = source.length > UNPARSED_SOURCE_LIMIT;
  const renderedSource = truncated ? `${source.slice(0, UNPARSED_SOURCE_LIMIT)}…` : source;
  return `${marker} source=${JSON.stringify(renderedSource)} truncated=${truncated}; required format: ${requiredFormat}; corrected example: ${correctedExample}`;
}

/** H1–H3 labels with section content are author-intent hints, not extractable ask markers. */
function normalizedMarkerContent(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

const PARSED_MARKER_LABELS = ['판정 신호', '경계', '불변식', '답하지 못하는 것', '대상 경로'] as const;

function headingFormMarkerSources(
  ask: string,
  label: '불변식' | '경계' | '답하지 못하는 것',
  inlineCandidates: readonly AskMatch<string>[],
): string[] {
  const inlineContents = new Set(inlineCandidates.map(({ value }) => normalizedMarkerContent(value)));
  const parsedMarkerLine = new RegExp(`^(?:${PARSED_MARKER_LABELS.join('|')})\\s*:\\s*`, 'u');
  const heading = new RegExp(`^#{1,3} ${label}[^\\S\\r\\n]*$`, 'gmu');
  const nextHeading = /^#{1,6}\s/mu;
  const sources: string[] = [];

  for (const match of ask.matchAll(heading)) {
    const start = match.index ?? 0;
    const headingText = match[0];
    const headingEnd = start + match[0].length;
    const following = ask.slice(headingEnd);
    const separator = /\r\n|[\n\r\u2028\u2029]/u.exec(following);
    const bodyStart = separator ? headingEnd + separator[0].length : headingEnd;
    const next = nextHeading.exec(ask.slice(bodyStart));
    const nextStart = next ? bodyStart + (next.index ?? 0) : ask.length;
    const terminalSeparator = /(?:\r\n|[\n\r\u2028\u2029])$/u.exec(ask.slice(bodyStart, nextStart));
    const end = nextStart - (terminalSeparator?.[0].length ?? 0);
    const bodyParts: Array<{ text: string; newline: string }> = [];
    let rest = ask.slice(bodyStart, end);
    const lineBreak = /\r\n|[\n\r\u2028\u2029]/u;
    while (rest.length) {
      const breakMatch = lineBreak.exec(rest);
      if (!breakMatch) {
        bodyParts.push({ text: rest, newline: '' });
        break;
      }
      bodyParts.push({ text: rest.slice(0, breakMatch.index), newline: breakMatch[0] });
      rest = rest.slice(breakMatch.index + breakMatch[0].length);
    }
    const kept = bodyParts.filter((part) => {
      const content = part.text.trim();
      return Boolean(content) && !parsedMarkerLine.test(content) && !inlineContents.has(normalizedMarkerContent(part.text));
    });
    if (!kept.length) continue;
    sources.push(`${headingText}${separator?.[0] ?? ''}${kept.map((part, index) => (
      index < kept.length - 1 ? `${part.text}${part.newline}` : part.text
    )).join('')}`);
  }

  return sources;
}

/** ⛔ `UNPARSED_SOURCE_LIMIT` 를 «반드시» 탄다 — 감싼 마커의 «버려지는 문면»은 ask 본문만큼 길 수 있고,
 *    제한이 없으면 stderr 로 그 전문이 쏟아진다(`renderHeadingFormMarker` 가 같은 이유로 이미 제한한다).
 *  ⭐ 이 절단은 «표시»만 줄인다 — 판정에는 쓰이지 않는다. */
function renderWrappedInvariantMarkerWarning(source: string): string {
  const [marker, ...discardedLines] = source.split(/\r\n|[\n\r\u2028\u2029]/u);
  const joined = discardedLines.join(' ').trim();
  const discardedProse = joined.length > UNPARSED_SOURCE_LIMIT
    ? `${joined.slice(0, UNPARSED_SOURCE_LIMIT)}…`
    : joined;
  return `감싼 마커 — ${marker.trim()}; 버려지는 문면: ${discardedProse}`;
}

function renderHeadingFormMarker(label: 'invariant' | 'boundary' | 'limitation', source: string, correctedExample: string): string {
  const truncated = source.length > UNPARSED_SOURCE_LIMIT;
  const renderedSource = truncated ? `${source.slice(0, UNPARSED_SOURCE_LIMIT)}…` : source;
  return `- UNVERIFIABLE: Ask uses a heading-form ${label}; headings are diagnostic only and do not create a ${label} candidate. source=${JSON.stringify(renderedSource)} truncated=${truncated}; corrected example: ${correctedExample}`;
}

function collectHeadingFormMarkerLabels(ask: string): string[] {
  const markers: ReadonlyArray<readonly [label: '불변식' | '경계' | '답하지 못하는 것', candidates: readonly AskMatch<string>[]]> = [
    ['불변식', orderedAskMatches([...askInvariantCandidates(ask), ...normalizeUnparsedMarkerSegments(ask, ASK_INVARIANT_MARKER, '불변식', ASK_INVARIANT)])],
    ['경계', orderedAskMatches([...askBoundaryDecisions(ask), ...normalizeUnparsedMarkerSegments(ask, ASK_BOUNDARY_MARKER, '경계', ASK_BOUNDARY)])],
    ['답하지 못하는 것', orderedAskMatches([...askLimitationCandidates(ask), ...normalizedAskLimitationCandidates(ask)])],
  ];
  return markers.flatMap(([label, candidates]) => headingFormMarkerSources(ask, label, candidates).length ? [label] : []);
}

function headingFormMarkerLintFindings(document: string): GoalFileLintFinding[] {
  const ask = verbatimOriginalAsk(document);
  if (ask === null) return [];
  const markers: ReadonlyArray<readonly [label: '불변식' | '경계' | '답하지 못하는 것', lintLabel: 'invariant' | 'boundary' | 'limitation', candidates: readonly AskMatch<string>[], correctedExample: string]> = [
    ['불변식', 'invariant', orderedAskMatches([...askInvariantCandidates(ask), ...normalizeUnparsedMarkerSegments(ask, ASK_INVARIANT_MARKER, '불변식', ASK_INVARIANT)]), '불변식: src/example.ts remains unchanged.'],
    ['경계', 'boundary', orderedAskMatches([...askBoundaryDecisions(ask), ...normalizeUnparsedMarkerSegments(ask, ASK_BOUNDARY_MARKER, '경계', ASK_BOUNDARY)]), '경계: src/example.ts만 고친다.'],
    ['답하지 못하는 것', 'limitation', orderedAskMatches([...askLimitationCandidates(ask), ...normalizedAskLimitationCandidates(ask)]), '답하지 못하는 것: 이 골의 대상 안에서는 판별할 수 없다.'],
  ];
  return markers.flatMap(([label, lintLabel, candidates, correctedExample]) => headingFormMarkerSources(ask, label, candidates)
    .map((source) => ({
      level: 'WARN' as const,
      tag: 'heading-form-marker' as const,
      message: renderHeadingFormMarker(lintLabel, source, correctedExample).slice('- UNVERIFIABLE: '.length),
    })));
}

function parseAskDecisionSignals(ask: string): AskMatch<DecisionSignalCandidate>[] {
  return Array.from(ask.matchAll(ASK_DECISION_SIGNAL)).flatMap((match) => {
    const [, rawCondition, rawObservation, rawExpectedResult] = match;
    const condition = rawCondition.trim();
    const observation = rawObservation.trim();
    const expectedResult = rawExpectedResult.trim();
    const start = match.index ?? 0;
    return condition && observation && expectedResult
      ? [{ value: { evidence: match[0], condition, observation, expectedResult }, start, end: start + match[0].length }]
      : [];
  });
}

interface NormalizedAskMatch extends AskMatch<string> {
  original: string;
  normalized: string;
}

interface HeadingMarkerSection {
  original: string;
  start: number;
  end: number;
  value: string;
}

function isNormalizedAskMatch(candidate: AskMatch<string> | NormalizedAskMatch): candidate is NormalizedAskMatch {
  return 'original' in candidate;
}

function headingMarkerSections(ask: string, label: '불변식' | '경계'): HeadingMarkerSection[] {
  const heading = new RegExp(`^## ${label}\\s*$`, 'mu');
  const nextHeading = /^#{1,6}\s/mu;
  const sections: HeadingMarkerSection[] = [];
  for (const match of ask.matchAll(new RegExp(heading.source, heading.flags.replace('u', 'gu')))) {
    const start = match.index ?? 0;
    const headingEnd = start + match[0].length;
    const following = ask.slice(headingEnd);
    const separator = /\r\n|[\n\r\u2028\u2029]/u.exec(following);
    const bodyStart = separator ? headingEnd + separator[0].length : headingEnd;
    const next = nextHeading.exec(ask.slice(bodyStart));
    const nextStart = next ? bodyStart + (next.index ?? 0) : ask.length;
    const terminalSeparator = /(?:\r\n|[\n\r\u2028\u2029])$/u.exec(ask.slice(bodyStart, nextStart));
    const end = nextStart - (terminalSeparator?.[0].length ?? 0);
    const original = ask.slice(start, end);
    const value = ask.slice(bodyStart, end).trim();
    sections.push({ original, start, end, value });
  }
  return sections;
}

function emptyHeadingMarkerDiagnostics(ask: string, label: '불변식' | '경계'): string[] {
  return headingMarkerSections(ask, label)
    .filter((section) => !section.value)
    .map((section) => `- UNVERIFIABLE: ${label === '불변식' ? 'invariant' : 'boundary'} marker heading has an empty body and did not create a candidate. source=${JSON.stringify(section.original)}`);
}

function normalizedMarkerSource(source: string, label: DedicatedSectionLabel): string | null {
  const pattern = new RegExp(`^${label}[ \\t]+\\([^()\\r\\n]+\\):[ \\t]*`, 'u');
  return pattern.test(source) ? source.replace(pattern, `${label}: `) : null;
}

function normalizeUnparsedMarkerSegments(
  ask: string,
  marker: RegExp,
  label: DedicatedSectionLabel,
  parser: RegExp,
): NormalizedAskMatch[] {
  return boundedAskMarkerSegments(ask, marker).flatMap((segment) => {
    const normalized = normalizedMarkerSource(segment.source, label);
    if (!normalized) return [];
    const match = Array.from(normalized.matchAll(parser))[0];
    if (!match) return [];
    return [{
      value: match[1],
      original: segment.source,
      normalized,
      start: segment.start,
      end: segment.end,
    }];
  });
}

function askInvariantCandidates(ask: string): AskMatch<string>[] {
  return Array.from(ask.matchAll(ASK_INVARIANT), (match) => {
    const start = match.index ?? 0;
    return { value: match[1], start, end: start + match[0].length };
  });
}

function askBoundaryDecisions(ask: string): AskMatch<string>[] {
  const marker = new RegExp(ASK_BOUNDARY_MARKER.source, ASK_BOUNDARY_MARKER.flags);
  const boundary = new RegExp(ASK_BOUNDARY.source, ASK_BOUNDARY.flags);
  return boundedAskMarkerSegments(ask, marker).flatMap((segment) => {
    const match = Array.from(`\n${segment.source}`.matchAll(boundary))[0];
    if (!match) return [];
    const relativeStart = Math.max(0, (match.index ?? 0) - 1);
    const matchLength = match[0].length - (match.index === 0 ? 1 : 0);
    return [{
      value: match[1],
      start: segment.start + relativeStart,
      end: segment.start + relativeStart + matchLength,
    }];
  });
}

function askLimitationCandidates(ask: string): AskMatch<string>[] {
  return boundedAskMarkerSegments(ask, ASK_LIMITATION_MARKER).flatMap((segment) => {
    const match = Array.from(segment.source.matchAll(ASK_LIMITATION))[0];
    if (!match) return [];
    const relativeStart = match.index ?? 0;
    return [{
      value: match[1],
      start: segment.start + relativeStart,
      end: segment.start + relativeStart + match[0].length,
    }];
  });
}

function normalizedAskLimitationCandidates(ask: string): NormalizedAskMatch[] {
  return ASK_LIMITATION_LABELS.flatMap((label) => (
    normalizeUnparsedMarkerSegments(ask, ASK_LIMITATION_MARKER, label, ASK_LIMITATION)
  ));
}

/** Values rendered by dedicated sections must not also consume acceptance-criterion budget. */
function dedicatedSectionMatches(ask: string): AskMatch<string | DecisionSignalCandidate>[] {
  return [
    ...askInvariantCandidates(ask),
    ...normalizeUnparsedMarkerSegments(ask, ASK_INVARIANT_MARKER, '불변식', ASK_INVARIANT),
    ...askBoundaryDecisions(ask),
    ...normalizeUnparsedMarkerSegments(ask, ASK_BOUNDARY_MARKER, '경계', ASK_BOUNDARY),
    ...askLimitationCandidates(ask),
    ...normalizedAskLimitationCandidates(ask),
    ...parseAskDecisionSignals(ask),
  ];
}

function stripDedicatedSectionSources(ask: string): string {
  const ranges = dedicatedSectionMatches(ask)
    .map(({ start, end }) => ({ start, end }))
    .filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= ask.length)
    .sort((left, right) => left.start - right.start)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
      return merged;
    }, []);
  if (ranges.length === 0) return ask;
  let cursor = 0;
  let source = '';
  for (const range of ranges) {
    source += ask.slice(cursor, range.start);
    cursor = range.end;
  }
  return `${source}${ask.slice(cursor)}`.trim();
}

function dedicatedSectionCriterionValues(ask: string): Set<string> {
  const values = new Set<string>();
  const add = (value: string) => values.add(value.trim());
  for (const candidate of dedicatedSectionMatches(ask)) {
    add(ask.slice(candidate.start, candidate.end));
    add(typeof candidate.value === 'string' ? candidate.value : candidate.value.evidence);
  }
  return values;
}

function withoutDedicatedSectionDuplicates(checklist: readonly string[], ask: string): string[] {
  const dedicatedValues = dedicatedSectionCriterionValues(ask);
  return checklist.filter((criterion) => {
    const normalized = criterion.trim().replace(/^-\s+/, '');
    return !dedicatedValues.has(normalized);
  });
}

function preservationContractInvariants(
  clarificationAnswers: Readonly<Record<string, string | undefined>>,
): string[] {
  const answer = clarificationAnswers[PRESERVATION_CONTRACT_QUESTION_ID];
  return answer ? [`- Invariant candidate: Clarification-grounded preservation contract: ${renderClarificationValue(answer)}`] : [];
}

interface RenderedSectionSlot {
  filled: boolean;
  unfilledReason?: string;
}

interface SectionSlotRender {
  lines: string[];
  slots: number;
  filled: number;
  unfilled: number;
  unfilledReasons: string[];
  invariantBranches?: Record<string, number>;
}

/** Derive the observed counts from the same rendered slot outcomes that selected section lines. */
function renderSectionSlots(lines: string[], renderedSlots: readonly RenderedSectionSlot[]): SectionSlotRender {
  const slots = renderedSlots.length || 1;
  const filled = renderedSlots.filter((slot) => slot.filled).length;
  return {
    lines,
    slots,
    filled,
    unfilled: slots - filled,
    unfilledReasons: renderedSlots.flatMap((slot) => slot.filled || !slot.unfilledReason ? [] : [slot.unfilledReason]),
  };
}

const PERSISTENT_EVIDENCE_PATH = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/g;
const PATH_TRAILING_PUNCTUATION = /[.,;:!?)}\]]+$/g;
const ASK_PRESERVATION_INVARIANT = /\b(?:preserve|remain|retain|keep|maintain|unchanged|untouched|intact|stable|must not|do not)\b|(?:안\s*바뀌|안\s*바뀐|바꾸지\s*않|새로\s*만들지\s*않|안\s*죽|보존|유지|금지)/i;

type AskInvariantBranch = 'path-evidence' | 'pathless-preservation' | 'pathless-unclassified';

function askInvariantBranch(invariant: string): AskInvariantBranch {
  if (evidencePaths(invariant).length) return 'path-evidence';
  return ASK_PRESERVATION_INVARIANT.test(invariant) ? 'pathless-preservation' : 'pathless-unclassified';
}

function evidencePaths(entry: string): string[] {
  return Array.from(entry.matchAll(PERSISTENT_EVIDENCE_PATH), (match) => match[0].replace(PATH_TRAILING_PUNCTUATION, ''));
}

function matchingPersistentEvidence(invariant: string, facts: CodebaseGrounding | null): string[] {
  const names = new Set(evidencePaths(invariant));
  if (!names.size) return [];
  const matchedNames = new Set<string>();
  const selected = new Set<string>();
  for (const entry of facts?.persistentEvidence ?? []) {
    const matchingNames = evidencePaths(entry).filter((path) => names.has(path));
    if (!matchingNames.length) continue;
    for (const name of matchingNames) matchedNames.add(name);
    selected.add(entry);
  }
  return matchedNames.size === names.size ? [...selected] : [];
}

/** Avoid grounding prose on short or ordinary-word symbols while retaining code-shaped public names. */
function isSafeInvariantCodeFactSymbol(symbol: string): boolean {
  return symbol.length >= 4 && /[A-Z0-9_]/.test(symbol);
}

function matchingCodeFactEvidence(invariant: string, facts: CodebaseGrounding | null): string[] {
  if (!facts) return [];
  return [...new Set(
    codeFactSymbolEntries(facts, invariant)
      .filter(({ symbol }) => isSafeInvariantCodeFactSymbol(symbol))
      .map(({ fact }) => fact),
  )];
}

function isDottedAccessExpression(invariant: string): boolean {
  return !invariant.includes('/') && /\b[a-z_$][\w$]*\.[a-z_$][\w$]*[A-Z][\w$]*\b/.test(invariant);
}

function limitationSection(ask: string): string[] {
  const parsedAskCandidates = askLimitationCandidates(ask);
  const normalizedAskCandidates = normalizedAskLimitationCandidates(ask);
  const askCandidates = orderedAskMatches([...parsedAskCandidates, ...normalizedAskCandidates]);
  const unparsedMarkers = markerOutsideMatches(ask, ASK_LIMITATION_MARKER, askCandidates);
  const unparsedDiagnostics = unparsedMarkers.map((source) => renderUnparsedMarker(
    UNPARSED_LIMITATION_MARKER,
    source,
    '답하지 못하는 것: <author limitation>',
    '답하지 못하는 것: 이 골의 대상 안에서는 판별할 수 없다.',
  ));
  const headingDiagnostics = headingFormMarkerSources(ask, '답하지 못하는 것', askCandidates)
    .map((source) => renderHeadingFormMarker('limitation', source, '답하지 못하는 것: 이 골의 대상 안에서는 판별할 수 없다.'));
  return askCandidates.length
    ? [
      ...askCandidates.flatMap((candidate) => [
        `- Author limitation: ${candidate.value}`,
        ...(isNormalizedAskMatch(candidate) ? [`  - Normalized ask marker: original=${JSON.stringify(candidate.original)}; normalized=${JSON.stringify(candidate.normalized)}`] : []),
      ]),
      ...unparsedDiagnostics,
      ...headingDiagnostics,
    ]
    : unparsedMarkers.length || headingDiagnostics.length
      ? [...unparsedDiagnostics, ...headingDiagnostics]
      : ['- 없다.'];
}

function invariantSection(
  facts: CodebaseGrounding | null,
  ask: string,
  clarificationAnswers: Readonly<Record<string, string | undefined>>,
): SectionSlotRender {
  const parsedAskCandidates = askInvariantCandidates(ask);
  const normalizedAskCandidates = [
    ...normalizeUnparsedMarkerSegments(ask, ASK_INVARIANT_MARKER, '불변식', ASK_INVARIANT),
  ];
  const askCandidates = orderedAskMatches([...parsedAskCandidates, ...normalizedAskCandidates]);
  const evidenceCandidates = facts?.persistentEvidence ?? [];
  const askLines = askCandidates.flatMap((candidate) => {
    const { value } = candidate;
    const branch = askInvariantBranch(value);
    const pathEvidence = branch === 'path-evidence' ? matchingPersistentEvidence(value, facts) : [];
    const codeFactEvidence = pathEvidence.length ? [] : matchingCodeFactEvidence(value, facts);
    const evidence = pathEvidence.length ? pathEvidence : codeFactEvidence;
    const unverifiable = branch === 'pathless-preservation'
      ? '  - UNVERIFIABLE: Pathless preservation invariant was classified without path evidence; human or child must confirm preservation evidence.'
      : branch === 'path-evidence' && isDottedAccessExpression(value)
        ? '  - UNVERIFIABLE: A dotted expression was interpreted as a path candidate, but no persistent path or code-symbol evidence matched this invariant; human or child must confirm new evidence.'
        : '  - UNVERIFIABLE: No persistent evidence mentions a path named by this invariant; human or child must confirm new evidence.';
    return [
      `- Invariant candidate: ${value}`,
      ...(isNormalizedAskMatch(candidate) ? [`  - Normalized ask marker: original=${JSON.stringify(candidate.original)}; normalized=${JSON.stringify(candidate.normalized)}`] : []),
      ...(evidence.length
        ? evidence.map((entry) => `  - Candidate evidence (unverified; human or child must confirm): ${entry}`)
        : [unverifiable]),
    ];
  });
  const renderedCandidates = askLines;
  const contractInvariants = preservationContractInvariants(clarificationAnswers);
  const unparsedMarkers = markerOutsideMatches(ask, ASK_INVARIANT_MARKER, askCandidates);
  const renderedUnparsedMarkers = contractInvariants.length ? [] : unparsedMarkers;
  const unparsedDiagnostics = renderedUnparsedMarkers.map((source) => renderUnparsedMarker(
    UNPARSED_INVARIANT_MARKER,
    source,
    INVARIANT_MARKER_GUIDANCE.requiredFormat,
    INVARIANT_MARKER_GUIDANCE.correctedExample,
  ));
  const headingDiagnostics = [
    ...headingFormMarkerSources(ask, '불변식', askCandidates)
      .map((source) => renderHeadingFormMarker('invariant', source, '불변식: src/example.ts remains unchanged.')),
    ...emptyHeadingMarkerDiagnostics(ask, '불변식'),
  ];
  const emptyHeadingMarkers = emptyHeadingMarkerDiagnostics(ask, '불변식');
  const hasRenderedCandidate = renderedCandidates.length + contractInvariants.length > 0;
  const section = hasRenderedCandidate
    ? [...renderedCandidates, ...contractInvariants, ...unparsedDiagnostics, ...headingDiagnostics]
    : renderedUnparsedMarkers.length || headingDiagnostics.length
      ? [...unparsedDiagnostics, ...headingDiagnostics]
      : [ABSENT_INVARIANT_EVIDENCE];
  const renderedSlots: RenderedSectionSlot[] = [
    ...askCandidates.map(({ value }) => {
      const branch = askInvariantBranch(value);
      const pathEvidence = branch === 'path-evidence' ? matchingPersistentEvidence(value, facts) : [];
      const matched = pathEvidence.length > 0 || matchingCodeFactEvidence(value, facts).length > 0;
      const unfilledReason = branch === 'pathless-preservation'
        ? `pathless preservation invariant classified without path evidence: ${value}`
        : `no persistent evidence mentions a path named by invariant: ${value}`;
      return {
        filled: matched,
        ...(!matched && { unfilledReason }),
      };
    }),
    ...contractInvariants.map(() => ({ filled: true })),
    ...renderedUnparsedMarkers.map(() => ({ filled: false, unfilledReason: 'an invariant marker did not render as an invariant candidate' })),
    ...emptyHeadingMarkers.map(() => ({ filled: false, unfilledReason: 'an invariant marker heading has an empty body and did not create a candidate' })),
  ];
  if (!renderedSlots.length) {
    renderedSlots.push({ filled: false, unfilledReason: 'no invariant candidate or persistent evidence is available' });
  }
  return {
    ...renderSectionSlots(
      section,
      renderedSlots,
    ),
    invariantBranches: askCandidates.reduce<Record<AskInvariantBranch, number>>((branches, { value }) => {
      const branch = askInvariantBranch(value);
      branches[branch] += 1;
      return branches;
    }, { 'path-evidence': 0, 'pathless-preservation': 0, 'pathless-unclassified': 0 }),
  };
}

/** 저작 LLM 이 만든 후보 — 근거 문자열이 없다(`evidence` 는 접지·ask 후보에만 있다). */
type AuthoredDecisionSignal = Omit<DecisionSignalCandidate, 'evidence'>;

interface DecisionSignalSelection {
  askMatches: AskMatch<DecisionSignalCandidate>[];
  candidates: DecisionSignalCandidate[];
  /** 저작 LLM 이 후보를 «만들었나» — 채택 여부와 «다른 축»이다. */
  authoringOffered: boolean;
  /** 그 후보가 실제로 «쓰였나». ⛔ `authoringOffered` 와 같은 값으로 세지 마라. */
  authoringAdopted: boolean;
}

/**
 * ⛔⭐⭐ 선택과 관측이 «같은 식»을 쓰게 하는 자리.
 *
 * 초판은 렌더 쪽에서 후보를 고르고 관측 쪽에서 `enhancement.decisionSignal !== undefined` 를
 * 따로 셌다. 그래서 ***ask·접지 후보가 있어 저작 후보가 «버려져도» `fromAuthoring: 1`*** 이었다
 * — 무인 리뷰가 잡았다(2026-08-08). ⇒ ***자가 「생성」을 「채택」이라 말했다.***
 * 두 쪽이 이 함수를 부르므로 이제 갈릴 수 없다.
 */
function decisionSignalSelection(
  facts: CodebaseGrounding | null,
  ask: string,
  authored?: AuthoredDecisionSignal,
): DecisionSignalSelection {
  const askMatches = parseAskDecisionSignals(ask);
  const askCandidates = askMatches.map((match) => match.value);
  const evidenceCandidates = evidenceDecisionSignalCandidates(facts);
  // ⛔ 사람·접지 후보가 «하나라도» 있으면 저작 후보를 안 쓴다 — 지어낸 것이 실측을 밀어내지 않게.
  const authoringAdopted = authored !== undefined && evidenceCandidates.length === 0 && askCandidates.length === 0;
  return {
    askMatches,
    candidates: [...evidenceCandidates, ...askCandidates, ...(authoringAdopted ? [{ ...authored, evidence: '' }] : [])],
    authoringOffered: authored !== undefined,
    authoringAdopted,
  };
}

/**
 * ⭐⭐ 판정 신호 후보의 출처는 «셋»이다 — ask · 접지 · 그리고 저작 LLM.
 *
 * ⛔ 셋째가 없던 동안(2026-08-08 이전) 사람이 이 세 칸을 «매번 손으로» 썼다. 짧은 자연어로 저작한
 *   세 판 전부 `extracted=false` 였고, 사람이 쓴 판만 `true` 였다.
 * ⚠️ 그리고 이것을 «휴리스틱»으로 만들려던 시도가 5라운드 UNCONVERGEABLE 로 끝났다(run-92822cd2):
 *   *"의미 연결이 공통 토큰 2개라는 휴리스틱뿐이라 일반어가 겹친 무관한 것에서도 신호를 생성한다"*
 *   ⇒ ***의미를 잇는 일은 규칙으로 안 된다.*** 그래서 이 경로의 유일한 LLM 단계(`enhance`)가 만든다.
 * ⛔⭐ 사람·접지 후보가 «하나라도» 있으면 저작 후보는 «아예 제외»된다 — 순서로 지는 것이 아니라
 *   후보 목록에 안 들어간다. `enhance` 후보는 «없을 때 채우는» 자리다.
 *   만들 수 없으면 안 만들고 종전 UNVERIFIABLE 이 남는다.
 */
type AcceptanceDistinctionSupport =
  | { status: 'not-requested'; observations: [] }
  | { status: 'supported'; observations: readonly AcceptanceDistinctionObservation[] }
  | { status: 'missing-value'; observations: readonly AcceptanceDistinctionObservation[] }
  | { status: 'same-value'; observations: readonly AcceptanceDistinctionObservation[] }
  | { status: 'ambiguous-or-conflicting'; observations: readonly AcceptanceDistinctionObservation[] };

interface AcceptanceDistinctionObservation {
  state: string;
  value: string;
  source: string;
  raw: string;
}

const ACCEPTANCE_DISTINCTION = /(?:acceptance\s+distinction|수용\s*구별)\s*:\s*state\s*=\s*([^;]+);\s*value\s*=\s*([^;]+);\s*source\s*=\s*([^;\n]+)/gi;

/** Normalize only explicit state/value/source observations; semantic similarity is intentionally not inferred. */
function normalizeAcceptanceDistinctionSupport(
  ask: string,
  persistentEvidence: readonly string[],
): AcceptanceDistinctionSupport {
  const requested = /(?:acceptance\s+distinction|수용\s*구별)/i.test(ask);
  if (!requested) return { status: 'not-requested', observations: [] };
  const observations = persistentEvidence.flatMap((raw) => Array.from(raw.matchAll(ACCEPTANCE_DISTINCTION)).flatMap((match) => {
    const state = match[1]?.trim();
    const value = match[2]?.trim();
    const source = match[3]?.trim();
    return state && value && source ? [{ state, value, source, raw }] : [];
  }));
  if (!observations.length) return { status: 'missing-value', observations };
  const states = new Set(observations.map(({ state }) => state));
  const values = new Set(observations.map(({ value }) => value));
  const sources = new Set(observations.map(({ source }) => source));
  if (states.size < 2) return { status: 'ambiguous-or-conflicting', observations };
  if (values.size === 1) return { status: 'same-value', observations };
  if (sources.size !== 1 || observations.length !== states.size || values.size !== states.size) return { status: 'ambiguous-or-conflicting', observations };
  return { status: 'supported', observations };
}

function enhancerObservationStatus(enhancement: GoalEnhancement): 'enhancer-response' | 'enhancer-fallback' | 'enhancer-no-response' {
  if (enhancement.enhancedBy === 'llm') return 'enhancer-response';
  if (enhancement.enhancedBy === 'fallback') return 'enhancer-fallback';
  return 'enhancer-no-response';
}

function acceptanceDistinctionSection(support: AcceptanceDistinctionSupport, enhancement: GoalEnhancement): string[] {
  const status = support.status;
  const observations = support.observations.map(({ state, value, source, raw }) =>
    `- Observed mapping: state=${JSON.stringify(state)}; value=${JSON.stringify(value)}; source=${JSON.stringify(source)}; raw=${JSON.stringify(raw)}`,
  );
  const enhancer = enhancerObservationStatus(enhancement);
  const advisory = '- Advisory only: this is observed material, not a proof of support or impossibility; a child must not invent a discriminator or manual input absent from the producer observations.';
  if (status === 'not-requested') return ['- Status: not-requested — no explicit acceptance distinction was authored.', advisory];
  if (status === 'supported') return [`- Status: supported — explicit producer observations contain distinct values for distinct states. ${enhancer}.`, ...observations, advisory];
  if (status === 'missing-value') return [`- Status: missing-value — a distinction was requested but no explicit state/value/source producer observation was grounded. ${enhancer}.`, advisory];
  if (status === 'same-value') return [`- Status: same-value — explicit producer observations map the requested states to one value. ${enhancer}.`, ...observations, advisory];
  return [`- Status: ambiguous-or-conflicting — explicit observations are incomplete, duplicate a state, or disagree on source; normalize conservatively as unsupported. ${enhancer}.`, ...observations, advisory];
}

function decisionSignalSection(
  facts: CodebaseGrounding | null,
  ask: string,
  authored?: AuthoredDecisionSignal,
): SectionSlotRender {
  const { askMatches, candidates } = decisionSignalSelection(facts, ask, authored);
  const unparsedMarkers = markerOutsideMatches(ask, ASK_DECISION_SIGNAL_MARKER, askMatches);
  const unparsedDiagnostics = unparsedMarkers.map((source) => renderUnparsedMarker(
    UNPARSED_DECISION_SIGNAL_MARKER,
    source,
    DECISION_SIGNAL_MARKER_GUIDANCE.requiredFormat,
    DECISION_SIGNAL_MARKER_GUIDANCE.correctedExample,
  ));
  const numericCandidates = candidates.filter((candidate) => /\d/u.test(candidate.expectedResult));
  const numericSourceReason = 'UNVERIFIABLE: no numeric source evidence was supplied for this decision signal.';
  const numericCoverageReason = 'UNVERIFIABLE: no numeric coverage evidence was supplied for this decision signal.';
  const numericSource = (candidate: DecisionSignalCandidate): string => {
    const supplied = candidate.numericSource?.trim();
    if (supplied) return supplied;
    return candidate.numericSource === undefined ? candidate.evidence.trim() || numericSourceReason : numericSourceReason;
  };
  const numericCoverage = (candidate: DecisionSignalCandidate): string => candidate.numericCoverage?.trim() || numericCoverageReason;
  const renderedCandidates = candidates.flatMap((candidate) => [
    '- Candidate decision signal:',
    `  - Condition: ${candidate.condition}`,
    `  - Observation: ${candidate.observation}`,
    `  - Expected result: ${candidate.expectedResult}`,
    ...(/\d/u.test(candidate.expectedResult)
      ? [
        `  - 숫자 출처: ${numericSource(candidate)}`,
        `  - 숫자 적용 범위: ${numericCoverage(candidate)}`,
      ]
      : []),
  ]);
  const section = renderedCandidates.length
    ? [...renderedCandidates, ...unparsedDiagnostics]
    : unparsedMarkers.length
      ? unparsedDiagnostics
      : [ABSENT_DECISION_SIGNAL_EVIDENCE];
  const renderedSlots: RenderedSectionSlot[] = [
    ...candidates.map(() => ({ filled: true })),
    ...numericCandidates.flatMap((candidate) => [
      numericSource(candidate) === numericSourceReason
        ? { filled: false, unfilledReason: numericSourceReason }
        : { filled: true },
      numericCoverage(candidate) === numericCoverageReason
        ? { filled: false, unfilledReason: numericCoverageReason }
        : { filled: true },
    ]),
    ...unparsedMarkers.map(() => ({ filled: false, unfilledReason: 'a decision-signal marker did not render as a complete decision signal' })),
  ];
  if (!renderedSlots.length) {
    renderedSlots.push({ filled: false, unfilledReason: 'no persistent evidence contains an observation path candidate' });
  }
  return renderSectionSlots(
    section,
    renderedSlots,
  );
}

function preservationClarification(
  clarificationQuestions: readonly Question[],
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  return renderedClarification(clarificationQuestions, PRESERVATION_CONTRACT_QUESTION_ID, clarificationResponses);
}

const EXPLICIT_OBLIGATION_MODAL = /\b(?:must|should|needs?\s+to|is\s+required\s+to)\s+/gi;
const OBLIGATION_HARD_BOUNDARY = /[.;!?]|\s+but\s+|\s+(?:although|because|while)\s+/i;
const COORDINATED_OBLIGATION = /\s+(?:and|or)\s+|,\s*(?:(?:and|or)\s+)?/i;
const OBLIGATION_VERB = /^([a-z]+)/i;
const PRESERVATION_OBLIGATION_VERB = /^(?:preserve|remain|retain|keep|maintain)$/i;
// ⛔⭐ 수동태 보존(`must be preserved` · `should be unchanged`)은 동사가 `be` 라 위 배제를 빠져나간다.
//    실측 2026-08-03: `this behavior should be preserved across releases` 가 요구로 오탐됐다.
//    ⚠️ 오탐 비용이 낮지 않다 — 이 판정은 clarification 을 만들고, 미답 clarification 은
//    발사 전 도달 경로를 태운다(`RUN-S13`). ⇒ `be` 뒤의 분사만 좁게 더 본다.
const PRESERVATION_PARTICIPLE = /^(?:preserved|retained|kept|maintained|unchanged|intact|stable)$/i;

/** Return finite, explicitly modal verb phrases, including verbs that share a modal through coordination. */
function explicitObligationVerbs(evidence: string): string[] {
  const modals = Array.from(evidence.matchAll(EXPLICIT_OBLIGATION_MODAL));
  return modals.flatMap((modal, index) => {
    const start = (modal.index ?? 0) + modal[0].length;
    const nextModal = modals[index + 1]?.index ?? evidence.length;
    const remaining = evidence.slice(start, nextModal);
    const boundary = remaining.search(OBLIGATION_HARD_BOUNDARY);
    const obligation = remaining.slice(0, boundary === -1 ? remaining.length : boundary);
    return obligation.split(COORDINATED_OBLIGATION).flatMap((phrase) => {
      const verb = OBLIGATION_VERB.exec(phrase.trim())?.[1];
      return verb ? [verb] : [];
    });
  });
}

/** Persistent evidence remains a preservation contract; only preservation verbs are excluded from explicit modal obligations. */
/** ⭐ 테스트가 **배포 코드**를 물게 export 한다 — 종전 회귀는 정규식을 복사해 vacuous 였다(`[T]` 반증 자기검증). */
export function hasUnmetRequirementOutsidePreservationClause(evidence: string): boolean {
  return explicitObligationPhrases(evidence).some((phrase) => {
    const [verb, next] = phrase.trim().split(/\s+/, 2);
    if (!verb) return false;
    if (PRESERVATION_OBLIGATION_VERB.test(verb)) return false;
    // `be preserved` / `be unchanged` 처럼 수동태로 쓴 보존은 요구가 아니다.
    if (/^be$/i.test(verb) && next && PRESERVATION_PARTICIPLE.test(next)) return false;
    return true;
  });
}

/** 배제 판정에 `be <분사>` 를 보려면 동사 하나가 아니라 구가 필요하다. `explicitObligationVerbs` 의 형제. */
function explicitObligationPhrases(evidence: string): string[] {
  const modals = Array.from(evidence.matchAll(EXPLICIT_OBLIGATION_MODAL));
  return modals.flatMap((modal, index) => {
    const start = (modal.index ?? 0) + modal[0].length;
    const nextModal = modals[index + 1]?.index ?? evidence.length;
    const remaining = evidence.slice(start, nextModal);
    const boundary = remaining.search(OBLIGATION_HARD_BOUNDARY);
    const obligation = remaining.slice(0, boundary === -1 ? remaining.length : boundary);
    return obligation.split(COORDINATED_OBLIGATION).map((phrase) => phrase.trim()).filter(Boolean);
  });
}

function preservationAmbiguities(facts: CodebaseGrounding | null, groundingError: boolean): string[] {
  if (groundingError) return [];
  return (facts?.persistentEvidence ?? []).filter(hasUnmetRequirementOutsidePreservationClause);
}

function preservationAmbiguityNotice(ambiguities: readonly string[]): string[] {
  return ambiguities.map((evidence) =>
    `- Preservation ambiguity: this item remains a preservation criterion, but its explicit unmet requirement must be addressed rather than silently treated as preservation only: ${evidence}`,
  );
}

function preservationAmbiguityClarification(
  clarificationQuestions: readonly Question[],
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  return renderedClarification(clarificationQuestions, PRESERVATION_AMBIGUITY_QUESTION_ID, clarificationResponses);
}

function scqaClarificationQuestions(
  facts: CodebaseGrounding | null,
  ask: string,
  groundingError: boolean,
  ambiguities: readonly string[],
  repositoryRoot?: string,
): Question[] {
  const questions: Question[] = [];
  if (requiresImplementationTargetClarification(facts, ask, groundingError, repositoryRoot)) {
    questions.push(clarificationQuestion(IMPLEMENTATION_TARGET_QUESTION_ID, IMPLEMENTATION_TARGET_CLARIFICATION));
  }
  const candidates = facts ? implementationCandidates(facts) : [];
  const namedPaths = askPathTokens(ask);
  const lacksNamedCandidate = namedPaths.length > 0
    ? !namedPaths.some((path) => candidates.includes(path))
    : candidates.length === 0;
  // ⛔⭐ 코드 접지 «채널이 실패»했으면 사람에게 앵커를 묻지 않는다 — 그 0 은 「없다」가 «아니다».
  //   📏 2026-08-11 72차 실측: 제공자 과부하로 채널이 죽은 저작이 절반이었고(persistent failed ⟺ code=0,
  //   상관 17/17), 도구는 그것을 *"Provide an identifier anchor"* 로 말했다. 두 트랙이 그 문면을 믿고
  //   같은 ask 를 여러 번 다시 썼다(합쳐 두 시간 이상). ⇒ ***묻는 대상이 사람이 아니라 재시도다.***
  //   ⛔ 자동 재시도·임계는 만들지 않는다. 「무엇이 일어났는지」만 정직하게 말한다.
  // ⛔ 「실패」와 「완주 못 함」은 «다른 사건»이지만 사람에게 줄 처방은 «같다» — ask 를 고치지 말고 다시 쳐라.
  //   📏 72차 전수: 후보 0인 finished 다섯이 전부 `end_turn` 이었다(목표를 못 끝낸 것).
  const codeChannelFailed = facts?.codeChannel === 'failed' || facts?.codeChannel === 'incomplete';
  if (!groundingError && facts?.grounded && lacksNamedCandidate) {
    questions.push(codeChannelFailed
      ? clarificationQuestion(CODE_CHANNEL_FAILED_QUESTION_ID, CODE_CHANNEL_FAILED_CLARIFICATION)
      : clarificationQuestion(
        IMPLEMENTATION_ANCHOR_QUESTION_ID,
        IMPLEMENTATION_ANCHOR_CLARIFICATION,
        IMPLEMENTATION_ANCHOR_OPTIONS,
      ));
  }
  if (!groundingError && facts?.grounded && facts.codeFacts.length && (facts.persistentEvidence?.length ?? 0) === 0) {
    questions.push(clarificationQuestion(PRESERVATION_CONTRACT_QUESTION_ID, PRESERVATION_CONTRACT_CLARIFICATION));
  }
  if (ambiguities.length) {
    questions.push(clarificationQuestion(
      PRESERVATION_AMBIGUITY_QUESTION_ID,
      `${PRESERVATION_AMBIGUITY_CLARIFICATION} Evidence: ${ambiguities.join(' | ')}`,
    ));
  }
  return questions;
}

function preservationAmbiguityCriteria(
  ambiguities: readonly string[],
  clarificationAnswers: Readonly<Record<string, string | undefined>>,
): string[] {
  const answer = clarificationAnswers[PRESERVATION_AMBIGUITY_QUESTION_ID];
  return ambiguities.length && answer
    ? [`- Checkable clarification criterion: resolve the preservation ambiguity according to: ${renderClarificationValue(answer)}`]
    : [];
}

function requiredEvidenceInformation(criteria: readonly CheckableCriterion[]): string[] {
  const counts = new Map<AcceptanceCriterionEvidenceType, number>();
  for (const { line, evidenceKind } of criteria) {
    if (evidenceKind !== 'requested') continue;
    const type = classifyAcceptanceCriterionEvidence(line);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  if (!counts.size || (counts.size === 1 && counts.has('default'))) return [];
  return [`${REQUIRED_EVIDENCE_ANNOTATION_PREFIX} acceptance-criterion evidence kinds: ${[...counts.entries()].map(([type, count]) => `${type} ${count}`).join(', ')}.`];
}

function requiredEvidence(criteria: readonly CheckableCriterion[], targetPaths: readonly string[], authorRunId: string): string[] {
  const lines = [
    ...collapseEvidenceKinds(criteria).map(({ tag, evidence }) => `- [${tag}] ${evidence}`),
    ...requiredEvidenceInformation(criteria),
  ];
  const siblingTests = [...new Set(targetPaths.flatMap((path) => {
    const sibling = siblingTestPath(path);
    return sibling ? [sibling] : [];
  }))];
  const firstEvidenceLine = lines.findIndex((line) => line.startsWith('- ['));
  const appendedSiblingTestCount = siblingTests.length && firstEvidenceLine >= 0 ? siblingTests.length : 0;
  if (appendedSiblingTestCount) {
    lines[firstEvidenceLine] += ` ${REQUIRED_EVIDENCE_COMMAND_SEPARATOR} bun test -- ${siblingTests.map(quoteShellArg).join(' ')}`;
  }
  try {
    observeGoalAuthor('goal-author', 'required-evidence-sibling-test-count', {
      authorRunId,
      targetPathCount: targetPaths.length,
      derivedSiblingTestCount: siblingTests.length,
      appendedSiblingTestCount,
    });
  } catch { /* observation is fail-soft */ }
  return lines;
}

function requestedCriterionLine(criterion: string): string {
  return `- Checkable requested criterion: ${criterion}`;
}

function boundaryDecisionLine(criterion: string): string {
  return `- Boundary decision: ${criterion} — Reason: this exact live-surface form requires a surface outside the child worktree.`;
}

export function markUntranscribedCriteria(
  checklist: readonly string[],
  acceptanceSection: string[],
  scopeBoundarySection: string[],
): string[] {
  const untranscribed = checklist.filter((item) => {
    const isBoundaryCriterion = isLiveSurfaceCriterion(item);
    const section = isBoundaryCriterion ? scopeBoundarySection : acceptanceSection;
    const expectedLine = isBoundaryCriterion ? boundaryDecisionLine(item) : requestedCriterionLine(item);
    return !section.some((line) => line === expectedLine);
  });
  for (const item of untranscribed) {
    const section = isLiveSurfaceCriterion(item) ? scopeBoundarySection : acceptanceSection;
    section.push(`- UNTRANSCRIBED requested criterion: ${item}`);
  }
  return untranscribed;
}

/** rfc-goal 산문 절의 최대 인용 길이 — 사람이 한눈에 읽는 자리라 길면 그 목적을 잃는다. */
const RFC_PROSE_ASK_MAX_CHARS = 300;
const RFC_PROSE_FILE_SAMPLE = 3;

/**
 * ⛔⭐⭐⭐⭐ **은퇴한 절 — 이 산출은 «문서에 안 실린다»**(대표 2026-08-09).
 *
 * ⚠️ 옛 문면은 *"사람이 읽는 「왜」 절 — 골 절 «앞»에 온다"* 였다. 그 전제가 실측으로 무너졌다:
 *   ⑴ 이 절을 파싱하는 코드가 `goal-author` **밖에 «0»** 이었다.
 *   ⑵ 「사람이 읽는 자리」라고 선언했지만 그 사람을 특정한 **표면도 «0»** 이었다.
 *   ⑶ 그리고 절 스스로 중복을 자백했다 — *"… 원문은 아래 절에 그대로 있다"*.
 *
 * ✅ **지금 이 함수의 용도는 «관측»이다.** 호출부가 산출을 문서에 넣지 않고, 그 길이와 값을
 *    `goal-summary-omitted` 로 남긴다. ⛔ 「없앤 글자 수」를 상수로 쓰면 그 관측이 거짓이 되므로
 *    ***실제로 생략되는 문자열을 여기서 만들어 세는 것***이 이 함수가 남아 있는 이유다.
 *
 * ⛔ 아래 계약은 «그대로 유지한다» — 관측 값의 계약이기 때문이다:
 *   · 골 절 «이름»을 본문에 쓰지 않는다(판정층이 본문 안의 이름도 계약으로 읽는다).
 *   · 값은 «저작기가 이미 아는 것»만 쓴다. 지어내지 않는다 — 모르는 칸은 「모른다」로 적는다.
 *   · 「폈나」와 「잘랐나」를 둘 다 표기하고, 자는 «코드 포인트»로 센다.
 * ⚠️ 배치 계약(골 절 «앞»)은 이제 «해당 없음»이다 — 문서에 안 들어가므로.
 */
export function rfcGoalProseSection(input: {
  readonly ask: string;
  readonly groundedFiles: readonly string[];
  readonly grounded: boolean;
  readonly narrowedPath: string | null;
  readonly narrowedRule: string | null;
  readonly boundaryDecisionCount: number;
}): string[] {
  // ⛔⭐ 여기서 «공백을 편다» — 그러므로 이 줄을 「원문 그대로」라고 부르면 «거짓»이다(무인 리뷰 must-fix).
  //   진짜 verbatim 은 아래 골 절 안에 이미 그대로 실려 있고, 이 줄은 «사람이 한눈에 보는 요약»이다.
  const askOneLine = input.ask.replace(/\s+/g, ' ').trim();
  // ⛔ 비교 대상은 «원문 그 자체»다 — trim() 과 비교하면 앞뒤 공백을 지우고도 「그대로」라 부른다(2R must-fix).
  const askReflowed = askOneLine !== input.ask;
  // ⛔ 자른 것은 «편 문자열»이므로 그 길이를 「원문 N자」라 부르면 거짓이다 — 둘을 «따로» 적는다(2R must-fix).
  // ⛔⭐ 「자」는 «코드 포인트»로 센다 — String.length 는 UTF-16 단위라 이모지 하나를 2로 세고,
  //   slice 는 서로게이트 쌍을 «쪼개» 깨진 글자를 남긴다(5R must-fix · 이 저장소 ask 는 이모지를 상시 쓴다).
  //   ⚠️ 코드 포인트도 «자소 묶음»(ZWJ·결합 문자)은 안 센다 — 여기서는 그 한계를 받아들인다.
  const askPoints = [...askOneLine];
  const askTruncated = askPoints.length > RFC_PROSE_ASK_MAX_CHARS;
  const askQuoted = askTruncated
    ? `${askPoints.slice(0, RFC_PROSE_ASK_MAX_CHARS).join('')}… (편 뒤 ${askPoints.length}자 중 앞 ${RFC_PROSE_ASK_MAX_CHARS}자 · 원문 ${[...input.ask].length}자)`
    : askOneLine;
  // ⛔ 표기는 «폈나»와 «잘랐나» 둘 다를 반영한다 — 하나만 보면 300자 넘는 공백 없는 요청이
  //   잘렸는데도 「원문 그대로」가 된다(4R must-fix).
  const askProvenance = askReflowed && askTruncated ? '공백을 폈고 앞부분만 · 원문은 아래 절에 그대로 있다'
    : askReflowed ? '공백을 한 줄로 폈다 · 원문은 아래 절에 그대로 있다'
      : askTruncated ? '앞부분만 · 원문은 아래 절에 그대로 있다'
        : '원문 그대로';
  const files = input.groundedFiles.slice(0, RFC_PROSE_FILE_SAMPLE);
  const groundedLine = !input.grounded
    ? '- 접지: 근거 없음 — 이 골의 사실 주장은 아직 확인되지 않았다.'
    : input.groundedFiles.length === 0
      ? '- 접지: 파일 0개 — 접지는 돌았으나 연 파일이 없다.'
      : `- 접지가 연 파일: ${input.groundedFiles.length}개${files.length ? ` (앞 ${files.length}: ${files.join(' · ')})` : ''}`;
  const narrowedLine = input.narrowedPath
    // ⛔ 규칙을 «조용히 생략»하지 않는다 — 부재와 미지를 같은 값으로 두면 거짓을 생산한다(무인 리뷰 must-fix).
    ? `- 저작기가 좁힌 구현 대상: \`${input.narrowedPath}\` (${input.narrowedRule ?? '규칙 모름'})`
    // ⛔ 「아래 절들이 대상을 말한다」는 «보장이 없다» — 아는 것만 적는다(2R must-fix).
    : '- 저작기가 구현 대상을 «안 좁혔다».';
  const boundaryLine = input.boundaryDecisionCount > 0
    ? `- 이 골이 «안 하는 것»: ${input.boundaryDecisionCount}개를 아래에 결정으로 적었다.`
    : '- 이 골이 «안 하는 것»: 사람이 경계를 안 적었다 — 자식이 스스로 좁히면 그것은 결정이 아니라 추정이다.';
  return [
    '## 왜 이 골인가',
    '',
    '- 형식: `rfc-goal` — 이 문서 하나가 사람에게는 RFC 이고 기계에게는 골이다.',
    `- 사람이 시킨 것(${askProvenance}): ${askQuoted}`,
    groundedLine,
    narrowedLine,
    boundaryLine,
    '',
    '⛔ 이 절은 사람이 읽는 자리다. 골 절 이름을 여기에 넣으면 판정층이 본문 안의 이름도 계약으로 읽을 수 있다.',
    '   고칠 땐 그 이름을 넣지 않는다.',
    '',
  ];
}

/** Renders caller-supplied same-path launch history without opening a ledger or log store. */
function launchPreflightHistorySummary(result: LaunchPreflightResult): string[] {
  const history = renderLaunchPreflight(result)
    .split('\n')
    .filter((line) =>
      line.includes('열린 PR:')
      || line.includes('완료 런:')
      || line.includes('중단 런:')
      || line.includes('최근 변경:')
      || line.includes('gate preexisting 실패 기록:'),
    );
  return history.length > 0 ? ['### 같은 대상 경로의 지난 이력', ...history] : [];
}

function acceptanceCriteria(
  criteria: readonly CheckableCriterion[],
  checklist: string[],
  clarificationQuestions: readonly Question[],
  clarificationResponses: Readonly<Record<string, GoalAuthorClarificationResponse | undefined>>,
): string[] {
  const acceptance = criteria.map(({ line }) => line);
  acceptance.push(
    ...preservationClarification(clarificationQuestions, clarificationResponses),
  );
  return acceptance;
}

/** Compose one grounded goal artifact without filesystem, process, pipeline, or daemon effects. */
export async function authorGoal(ask: string, deps: GoalAuthorDeps): Promise<AuthoredGoal> {
  if ('supersessionRootIntent' in deps) {
    throw new Error('supersessionRootIntent is reserved for the superseded document reader');
  }
  return authorGoalWithSupersededRootIntent(ask, deps);
}

/** Internal-only path: the locked superseded document is the authoritative RootIntent source. */
async function authorGoalWithSupersededRootIntent(
  ask: string,
  deps: GoalAuthorDeps & { supersessionRootIntent?: string; mandatoryGoalContextEvidence?: readonly string[] },
): Promise<AuthoredGoal> {
  try {
    const markerWarnings = formatEarlyMarkerWarnings(ask);
    for (const warning of markerWarnings) process.stderr.write(warning);
    if (markerWarnings.length > 0) {
      // ⚠️ 감싼 마커의 `markers` 값은 «표제 문자열»(예: `불변식:`)이고, heading-form 쪽은 «라벨»
      //   (`invariant`·`boundary`·`limitation`)이다 — 즉 이 칸의 «값 영역»이 둘이다.
      //   📏 2026-09-17 실측: 이 이벤트를 «읽는» 코드 0곳 · 최근 24h 발생 0건
      //   ⇒ 그래서 호환 심을 «짓지 않는다». 소비자가 생기면 그때 값 영역을 정규화한다.
      const markers = markerWarnings.map((warning) => warning.match(/^\[goal-author\] marker warning: 감싼 마커 — (.+?); 버려지는 문면:/)?.[1]
        ?? warning.match(/^\[goal-author\] marker warning: (.+?)(?: marker is present but could not be extracted| marker extraction succeeded| heading-form marker could not be extracted)(?:;|\n)/)?.[1]
        ?? 'unknown');
      try { observeGoalAuthor('goal-author', 'early-marker-warning', { markers, count: markers.length }); } catch { /* observation is fail-soft */ }
    }
  } catch {
    try { observeGoalAuthor('goal-author', 'early-marker-warning-failed', {}); } catch { /* observation is fail-soft */ }
  }
  // ⭐ 이 저작 «한 번»의 id. goalId 보다 «먼저» 있어야 ground·enhance 의 소요를 그 골에 붙일 수 있다.
  const authorRunId = generateGoalId();
  const authorGrade = deps.authorGrade ?? resolveGoalAuthorGrade(undefined, getUserConfig().harness?.authorGrade);
  const lite = authorGrade.grade === 'lite';
  // lite 는 판정선을 남기는 대신 단계를 덜 한다 — 요청에 반증 줄이 하나도 없으면 판정선 없는 골이 나가므로 시작 전에 멈춘다.
  if (lite && !ask.split(/\r?\n/u).some((line) => /판정선|판정 신호|반증|decision signal/iu.test(line))) {
    try { observeGoalAuthor('goal-author', 'author-grade-refused', { authorRunId, reason: 'lite-without-falsifiable-signal' }); }
    catch { /* observation is fail-soft */ }
    throw new Error('lite authoring needs a falsifiable signal line (판정선/반증) in the ask — add one or use --author-grade full');
  }
  const skippedPhases = lite ? ['adversarial-review', 'goal-steps-decomposed', 'persistent-grounding'] : [];
  try { observeGoalAuthor('goal-author', 'author-grade', { authorRunId, grade: authorGrade.grade, source: authorGrade.source, skippedPhases }); }
  catch { /* observation is fail-soft */ }
  const authorStartedAt = Date.now();
  const enhanceTokens: GoalAuthorTokens = { inputTokens: null, outputTokens: null };
  const onEnhanceUsage = (usage: LLMUsage): void => {
    if (usage.inputTokens !== undefined) enhanceTokens.inputTokens = (enhanceTokens.inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens !== undefined) enhanceTokens.outputTokens = (enhanceTokens.outputTokens ?? 0) + usage.outputTokens;
    try { deps.enhanceOpts?.onUsage?.(usage); } catch { /* usage observation is fail-soft */ }
  };
  let facts: CodebaseGrounding | null = null;
  let groundingError = false;
  if (!lite) {
    const persistentGrounding = resolveGoalAuthorPersistentGrounding('persistentGrounding' in deps ? deps.persistentGrounding : undefined);
    const groundStartedAt = startGoalAuthorPhase('ground', authorRunId, deps.onProgress);
    try {
      facts = await deps.ground(ask, persistentGrounding.deps);
    } catch {
      groundingError = true;
    } finally {
      endGoalAuthorPhase('ground', groundStartedAt, authorRunId, deps.onProgress);
      observeGoalAuthorPersistentGroundingResult(
        persistentGrounding.decision,
        goalAuthorPersistentGroundingMetrics(facts, groundingError, authorRunId),
      );
    }
  }

  const enhanceStartedAt = startGoalAuthorPhase('enhance', authorRunId, deps.onProgress);
  const enhanceAsk = stripDedicatedSectionSources(ask);
  let enhancement: GoalEnhancement;
  try {
    // ⭐⭐ 접지 사실을 인핸싱에 넘긴다 — `ground`(위)가 `enhance` 보다 «먼저»라 가능한 배선이다.
    //   ⛔ 새 LLM 경로를 만들지 않는다: 이 모듈이 저작 파이프라인의 유일한 LLM 단계이고,
    //     `EnhanceOpts` 는 이미 저작기 관측을 받는 가산 통로다(`directoryMeasurement` 가 그 선례).
    //   ⇒ 이것이 `Situation`/`Complication` 을 「나열」에서 「기술」로 바꾸는 입력이다.
    //   ⛔ 접지 사실이 없으면 `deps.enhanceOpts` 를 «그대로» 넘긴다 — `{}` 를 만들면 「인자 없음」이
    //     「빈 옵션」으로 바뀌어 기존 호출 계약이 조용히 달라진다(회귀 테스트가 그 차이를 문다).
    const persistentFacts = facts?.persistentEvidence ?? [];
    enhancement = enhanceAsk
      ? await deps.enhance(
        enhanceAsk,
        persistentFacts.length > 0
          ? { ...deps.enhanceOpts, groundedFacts: persistentFacts, onUsage: onEnhanceUsage }
          : { ...deps.enhanceOpts, onUsage: onEnhanceUsage },
      )
      : { original: ask, checklist: [], verbatimPreserved: true };
    // ⭐ goal-context 규범이 «어디에도 안 실린다»는 것을 관측으로 남긴다.
    //
    // ⛔⭐⭐ 왜 프롬프트에도 «안» 넣나(대표 2026-08-08): ***그것은 「추후 필요시 사용하는 내용」이다.***
    //   초판은 「문서에서 빼서 프롬프트로」였는데, 그 처방(🅐 결정 ⑵)은 «표면 수»(한 줄 수치)에
    //   대한 것이었다. 여기 걸린 것은 «3,730자 규범 전문»이라 성질이 다르다 —
    //   ⇒ 「문서에서 뺀다」와 「프롬프트에 넣는다」를 한 덩어리로 읽은 것이 틀렸다.
    //   골마다 3,730자를 상시 주입할 이유가 없고, 필요하면 저작기가 «그때» 그 폴더를 읽는다.
    const goalContext = deps.mandatoryGoalContextEvidence ?? [];
    observeGoalAuthor('goal-author', 'goal-context-placement', {
      authorRunId,
      items: goalContext.length,
      chars: goalContext.reduce((sum, line) => sum + line.length, 0),
      placement: 'omitted',
    });
  } finally {
    endGoalAuthorPhase('enhance', enhanceStartedAt, authorRunId, deps.onProgress, enhanceTokens);
  }
  if (!enhancement.verbatimPreserved || (enhanceAsk && enhancement.original !== enhanceAsk)) {
    throw new Error('goal author refused an enhancement that does not preserve its input verbatim');
  }
  enhancement = { ...enhancement, original: ask };

  if (lite) {
    const goalType = deps.goalType ?? 'implement';
    const goalId = deps.goalId ?? generateGoalId();
    const signal = decisionSignalSection(null, ask, enhancement.decisionSignal);
    const falsifiableSignal = signal.filled > 0 ? signal.lines : [
      ...signal.lines,
      ...ask.split(/\r?\n/u).filter((line) => /판정선|판정 신호|반증|decision signal/iu.test(line) && !signal.lines.some((rendered) => rendered.includes(line.trim()))),
    ];
    const targetPaths = [...new Set(declaredTargetPaths(ask))];
    const checklistIds = [...new Set(Array.from(ask.matchAll(/\b[A-Z][A-Z0-9]+-[A-Z0-9]+\b/g), (match) => match[0]))];
    const askFile = deps.askFile === undefined ? undefined : validateAskFile(deps.askFile);
    const inheritedRootIntent = deps.parentDocument === undefined ? null : parseRootIntent(deps.parentDocument);
    const rootIntent = validateRootIntent(deps.supersessionRootIntent ?? inheritedRootIntent ?? deps.rootIntent ?? goalSummary(ask));
    const document = [
      deps.goalTitle ?? goalSummary(ask),
      `- GoalId: ${goalId}`,
      `- RootIntent: ${rootIntent}`,
      `- GoalType: ${goalType}`,
      ...(askFile === undefined ? [] : [`- AskFile: ${askFile}`]),
      '',
      '## PROBLEM',
      `- 왜: ${enhancement.complication ?? goalSummary(ask)}`,
      '',
      '## WHAT TO BUILD',
      `- 무엇: ${enhancement.situation ?? goalSummary(ask)}`,
      ORIGINAL_ASK_MARKER,
      fenceFor(ask), ask, fenceFor(ask),
      '',
      '## ACCEPTANCE CRITERIA',
      ...enhancement.checklist.map(requestedCriterionLine),
      '',
      '## REQUIRED EVIDENCE',
      '- [requested] Verify the decision signal and the verbatim ask.',
      '',
      ...(goalType === 'implement' ? ['## TRACED PATHS', ...(targetPaths.length ? targetPaths.map((path) => `- ${path}`) : ['- Target paths: not declared in the ask.']), ''] : []),
      '## SCOPE BOUNDARY',
      `- 대상 경로: ${targetPaths.length ? targetPaths.join(' · ') : 'not declared'}`,
      `- 칸 id: ${checklistIds.length ? checklistIds.join(' · ') : 'not declared'}`,
      '',
      '## 답하지 못하는 것',
      '- No persistent grounding was performed in lite authoring.',
      '',
      '## 불변식',
      '- No persistent grounding was performed in lite authoring.',
      '',
      '## 판정 신호',
      ...falsifiableSignal,
    ].join('\n');
    return { document, facts: null, grounded: false, authorRunId };
  }

  observeGoalAuthor('goal-author', 'constant-instruction-placement', {
    authorRunId,
    lines: CONSTANT_DOCUMENT_INSTRUCTION_POLICY.length,
    chars: CONSTANT_DOCUMENT_INSTRUCTION_POLICY.reduce((sum, line) => sum + line.length, 0),
  });
  const assembleStartedAt = startGoalAuthorPhase('assemble', authorRunId, deps.onProgress);
  let assembleCompleted = false;
  let activeAssembleSubphase: { phase: GoalAuthorAssembleSubphase; startedAt: number } | null = null;
  const startAssembleSubphase = (phase: GoalAuthorAssembleSubphase): void => {
    activeAssembleSubphase = { phase, startedAt: startGoalAuthorPhase(phase, authorRunId) };
  };
  const endAssembleSubphase = (): void => {
    if (!activeAssembleSubphase) return;
    endGoalAuthorPhase(activeAssembleSubphase.phase, activeAssembleSubphase.startedAt, authorRunId);
    activeAssembleSubphase = null;
  };
  try {
    startAssembleSubphase('assemble-inputs');

  // ⛔ 반쪽 마이그레이션 수복(2026-07-28 실측): #5823 이 헬퍼만 새 계약으로 바꾸고 **호출부를
  //   안 고쳐** `verifiedFacts` (삭제된 함수)를 부르고 있었다 ⇒ `elanous self author` 가 크래시했다.
  //   ⇒ 근거 유무 판정을 **집계기 계약(`grounded`)** 하나로 모은다.
  const hasEvidence = !!facts?.grounded;
  const goalType = deps.goalType ?? 'implement';
  const evidenceProblem = hasEvidence
    ? groundedProblem(facts!, goalType === 'implement')
    : [`- Not grounded: grounding ${groundingError ? 'failed' : 'found no repository facts'}; the repository problem is unverified and no file path or symbol is asserted.`];
  if (hasEvidence) {
    observeProblemBackgroundEvidence(facts!, authorRunId);
    observePersistentEvidenceSourceKinds(facts!, authorRunId);
  }
  const problemEvidence = evidenceProblem;
  // Grounding can complete with no qualifying evidence. Keep that normal empty
  // document-channel result observable instead of conflating it with a failed lookup.
  let scopeCandidates: string[] = [];
  let scopeCandidatePaths: string[] = [];
  if (facts && !groundingError) {
    const candidates = scopeBoundaryCandidates(facts);
    scopeCandidates = candidates.lines;
    scopeCandidatePaths = candidates.paths;
  }
  if (!scopeCandidates.length) {
    scopeCandidates = [`- ${SCOPE_BOUNDARY_NOT_GROUNDED} — ${groundingError ? 'Grounding failed before scope-boundary candidates could be produced.' : 'No qualifying scope-boundary candidates were produced from the document channel.'}`];
  }
  const artifactLaunchDeclaration = promotedArtifactLaunchDeclaration(enhancement.original, authorRunId);
  const artifactLaunchClassification = artifactLaunchDeclarationClassification(enhancement.original);
  observeGoalAuthor('goal-author', 'artifact-launch-declaration-classification', {
    authorRunId,
    classification: artifactLaunchClassification,
  });
  const assertRequiredBlocks = (doc: string): void => {
    const goalType = parseGoalType(doc);
    if (goalType === null) throw new Error(`goal author refused a document with an invalid GoalType; expected one of: ${GOAL_TYPES.join(', ')}`);
    const requiredBlocks = requiredBlocksForGoalType(goalType);
    // ⛔ 코드펜스 안은 문서 구조가 아니다 — 원문에 `## ` 줄이 있어도 블록이 아니다.
    //   (리뷰 실측: 이걸 안 빼면 원문이 `## ` 를 품는 순간 저작이 거부돼 verbatim 계약이 깨진다)
    // ⛔ CommonMark: **여는 울타리보다 짧은 백틱 줄은 닫지 못한다.** 길이를 무시하고 토글하면
    //   원문 안의 짧은 ``` 가 문서 펜스를 조기에 닫고 그 뒤가 구조로 오독된다(실측).
    let openFence = 0;
    let openMarker = '';
    const headings = doc.split('\n').filter((line) => {
      const run = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (run) {
        // ⛔ 마커까지 본다 — `~~~` 는 백틱 펜스를 닫지 못한다(CommonMark). 마커를 무시하면
        //   서로 다른 펜스를 닫힘으로 오인해 **그 뒤의 진짜 다섯째 블록을 숨긴다**(조용한 오통과).
        const marker = run[1][0];
        if (openFence === 0) { openFence = run[1].length; openMarker = marker; return false; }
        if (marker === openMarker && run[1].length >= openFence) { openFence = 0; openMarker = ''; }
        return false;
      }
      return openFence === 0 && /^#{2}(?:[ \t]|$)/.test(line);
    });
    const normalizedHeadings = headings.map((heading) => heading.replace(/[ \t]+/g, ' ').trim());
    const canonicalHeadings = canonicalGoalHeadings(requiredBlocks, resolvedSteps !== undefined);
    if (artifactLaunchDeclaration.length) canonicalHeadings.push(`## ${ARTIFACT_LAUNCH_SECTION}`);
    // ⛔ 검증 시나리오는 «항상» 실린다 — 기동 선언이 없어도 사유와 함께 미측정으로 싣는다(RFC §4b).
    //   ⇒ 그래서 조건 없이 등록한다. 제목은 상수라 여기서 «내용 없이» 순서만 못 박을 수 있다.
    canonicalHeadings.push(TEST_SCENARIO_SECTION_TITLES[0], TEST_SCENARIO_SECTION_TITLES[1], TEST_SCENARIO_SECTION_TITLES[2]);
    const firstRequired = normalizedHeadings.indexOf(requiredBlocks[0]);
    const actualStructure = normalizedHeadings.slice(firstRequired, firstRequired + canonicalHeadings.length);
    // ⛔⭐ 뒤쪽은 아래 마지막 줄(전체 길이)이 이미 막지만 ***앞쪽은 열려 있다*** —
    //   사람용 RFC 절을 필수 블록 «앞»에 허용하기 때문이다. 그 허용이 `## STEPS` 에도 적용돼
    //   앞쪽 중복이 통과했다(무인 리뷰 must-fix ②). ⇒ 선택 절의 «개수»를 따로 못 박는다.
    const stepsHeadingCount = normalizedHeadings.filter((heading) => heading === '## STEPS').length;
    const expectedStepsCount = canonicalHeadings.includes('## STEPS') ? 1 : 0;
    const same = firstRequired >= 0
      && actualStructure.length === canonicalHeadings.length
      && actualStructure.every((heading, index) => heading === canonicalHeadings[index])
      && normalizedHeadings.length === firstRequired + canonicalHeadings.length
      && stepsHeadingCount === expectedStepsCount;
    if (!same) {
      // 사람용 RFC 절은 필수 골 절보다 앞에만 둘 수 있다. 그 사이 또는 뒤의 `##` 는
      // 절 본문 경계를 자르므로 계속 거부한다.
      throw new Error(`goal author refused a document whose required blocks are not contiguous and ordered: expected ${canonicalHeadings.join(', ')}; got ${normalizedHeadings.join(', ') || '(none)'}`);
    }
  };
  if (Boolean(deps.parent) !== Boolean(deps.parentDocument)) {
    throw new Error('parent and parentDocument must be supplied together');
  }
  const inheritedRootIntent = deps.parentDocument === undefined ? null : parseRootIntent(deps.parentDocument);
  const requestedRootIntent = deps.rootIntent === undefined ? undefined : validateRootIntent(deps.rootIntent);
  const supersessionRootIntent = deps.supersessionRootIntent === undefined ? undefined : validateRootIntent(deps.supersessionRootIntent);
  if (inheritedRootIntent !== null && requestedRootIntent !== undefined) {
    throw new Error('rootIntent must not be supplied when parent document has RootIntent');
  }
  if (inheritedRootIntent !== null && supersessionRootIntent !== undefined && inheritedRootIntent !== supersessionRootIntent) {
    throw new Error('parent document RootIntent must match superseded document RootIntent');
  }
  if (supersessionRootIntent !== undefined && requestedRootIntent !== undefined && requestedRootIntent !== supersessionRootIntent) {
    throw new Error('rootIntent must match superseded document RootIntent');
  }
  if (deps.parentDocument !== undefined && inheritedRootIntent === null && requestedRootIntent === undefined && supersessionRootIntent === undefined) {
    throw new Error('legacy parent document has no RootIntent; rootIntent is required');
  }
  const rootIntent = validateRootIntent(supersessionRootIntent ?? inheritedRootIntent ?? requestedRootIntent ?? goalSummary(enhancement.original));
  let resolvedSteps = deps.steps;
  if (resolvedSteps === undefined && goalType === 'implement' && deps.decomposeSteps) {
    const startedAt = Date.now();
    let failed = false;
    try {
      const decomposed = await deps.decomposeSteps(ask, { context: facts?.context || undefined, runId: process.env.ELANOUS_RUN_ID?.trim() || authorRunId });
      if (decomposed.length > 0) resolvedSteps = decomposed;
    } catch {
      failed = true;
    } finally {
      try {
        observeGoalAuthor('goal-author', 'goal-steps-decomposed', {
          authorRunId,
          goalType,
          stepCount: resolvedSteps?.length ?? 0,
          codeNamedStepCount: resolvedSteps?.filter(hasGoalStepCodeName).length ?? 0,
          elapsedMs: Date.now() - startedAt,
          failed,
        });
      } catch { /* observation is fail-soft */ }
    }
  }
  const explicitGoalTitle = deps.goalTitle === undefined ? undefined : validGoalSummary(deps.goalTitle);
  if (deps.goalTitle !== undefined && !explicitGoalTitle) throw new Error('goalTitle must contain non-whitespace text');
  endAssembleSubphase();
  startAssembleSubphase('assemble-sections');
  const liveSurfaceCriteria = enhancement.checklist.filter(isLiveSurfaceCriterion);
  const acceptanceChecklist = withoutDedicatedSectionDuplicates(
    enhancement.checklist.filter((criterion) => !isLiveSurfaceCriterion(criterion)),
    ask,
  );
  const criteria = checkableCriteria(ask, acceptanceChecklist, facts, groundingError, enhancement.checklist.length === 0, goalType === 'implement');
  // 🧪 저작이 시나리오를 «직접 쓰지 않고» 의뢰한다(대표 2026-08-19 · RFC T3).
  //   ⛔ 방법론 어휘는 이 파일의 레지스트리가 canonical — 생성기에 «인자로» 준다(같은 축에 두 어휘 금지).
  //   ⛔⭐ `명령 출처` 는 「실행 경로」가 아니라 ***「이 명령을 «어디서» 얻었나」***다(파서 어휘:
  //     ambiguous-command-source 의 후보가 `file:key` 형태다). 저작 시점엔 골 «파일명»이 아직 없고
  //     (제목 파생이라 문서가 완성돼야 정해진다) — 그래서 «문서 안의 출처»를 가리킨다.
  const testScenario = (deps.requestTestScenario ?? defaultRequestTestScenario)({
    launch: parseArtifactLaunchDeclaration(enhancement.original),
    acceptanceCriteria: acceptanceChecklist,
    registeredMethodologies: TEST_SCENARIO_METHODOLOGY_REGISTRY,
    commandSource: `goal:${ARTIFACT_LAUNCH_SECTION}`,
  });
  const ambiguities = preservationAmbiguities(facts, groundingError);
  const clarificationQuestions = scqaClarificationQuestions(facts, ask, groundingError, ambiguities, deps.repositoryRoot);
  const injectedClarificationAnswers = deps.clarificationAnswers ?? {};
  const clarificationAnswers: Record<string, string | undefined> = { ...injectedClarificationAnswers };
  const clarificationResponses: Record<string, GoalAuthorClarificationResponse | undefined> = Object.fromEntries(
    Object.entries(injectedClarificationAnswers).flatMap(([questionId, answer]) => answer === undefined ? [] : [[questionId, {
      questionId,
      answer,
      acceptedFormats: [],
      status: 'ANSWERED' as const,
      provenance: { source: 'injected' as const },
    }]]),
  );
  const selfResolutionSelected = deps.selfResolveClarification !== undefined;
  const evidence = facts ? [...(facts.persistentEvidence ?? []), ...facts.codeFacts, ...facts.documentFacts] : [];
  for (const question of clarificationQuestions) {
    if (clarificationAnswers[question.id] !== undefined) {
      observeGoalAuthor('goal-author.clarify', 'answer-injected', {
        questionId: question.id,
        source: 'caller',
        selfResolutionSelected,
      });
      continue;
    }
    if (!deps.selfResolveClarification) {
      observeGoalAuthor('goal-author.clarify', 'unresolved', {
        questionId: question.id,
        selfResolutionSelected,
      });
      continue;
    }
    const response = await resolveGoalAuthorClarification({
      questionId: question.id,
      kind: 'term',
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({ label: option.label })),
      blocking: false,
    }, { selfResolve: deps.selfResolveClarification, evidence, ask, selfResolutionSelected });
    if (response.answer !== null) {
      clarificationAnswers[question.id] = response.answer;
      clarificationResponses[question.id] = response;
    } else {
      observeGoalAuthor('goal-author.clarify', 'unresolved', {
        questionId: question.id,
        selfResolutionSelected,
      });
    }
  }
  const narrative = scqaNarrative(
    ask,
    facts,
    groundingError,
    clarificationAnswers,
    clarificationQuestions,
    deps.readSourceFile,
    {
      ...(enhancement.situation !== undefined && { situation: enhancement.situation }),
      ...(enhancement.complication !== undefined && { complication: enhancement.complication }),
    },
  );
  // ⭐ 관측 — 「요약이 실제로 문서에 실렸나」를 저작 단위로 남긴다.
  //   ⛔ `prompt-enhance` 의 관측만으로는 «생성됐다»까지만 알고 «문서에 갔다»는 모른다(층이 다르다).
  observeGoalAuthor('goal-author', 'scqa-summary', {
    authorRunId,
    groundedFacts: (facts?.persistentEvidence ?? []).length,
    situation: enhancement.situation === undefined ? 'template' : 'summary',
    complication: enhancement.complication === undefined ? 'template' : 'summary',
  });
  const helpProbeNarrative = await inlineElanousCommandProbeNarrative(ask, deps.runHelpProbe);
  observeAskExportGrounding(ask, facts, authorRunId);
  const launchPreflightHistory = deps.launchPreflight === undefined
    ? []
    : launchPreflightHistorySummary(deps.launchPreflight);
  const problem = [
    ...narrative.problem,
    '',
    ...helpProbeNarrative,
    '',
    ...problemEvidence,
    ...(deps.groundingEvidence?.length ? ['', ...deps.groundingEvidence] : []),
    ...(launchPreflightHistory.length === 0 ? [] : ['', ...launchPreflightHistory]),
    // ⛔⭐⭐ goal-context 규범은 여기 «안» 싣는다 — 그리고 ***저작 프롬프트에도 «안» 넣는다***(대표 2026-08-08).
    //   ⚠️ 이 주석의 초판은 「저작 프롬프트로 간다」였다. 그것은 «정정 전» 문면이고 구현과 반대였다
    //     — 무인 리뷰가 잡았다. ⇒ 문서에서 «빼기만» 한다. 필요하면 저작기가 «그때» 그 폴더를 읽는다.
    //   📏 실측: 이것이 문서에서 «3,823자»였고 골마다 한 글자도 다르지 않았다. 그 골에 대한 정보가 0인데
    //     저작기 고정 지시문 2,479자와 합쳐 «6,302자» = 대표 예산 5,000 의 «126%».
    //     ⇒ ***그 골에 대한 내용을 한 자도 안 써도 예산을 넘겼다.***
    //   ⭐ 그리고 이것을 읽어야 하는 것은 «저작기»다 — 자식도 리뷰어도 아니다.
    //   ⊕ 「빠졌다」와 「애초에 없다」를 가르는 관측은 아래 `goal-context-placement` 가 낸다.
  ];
  observeGoalAuthor('goal-author', 'preservation-ambiguity', {
    count: ambiguities.length,
    evidence: ambiguities,
  });
  const implementationTarget = selectImplementationTarget(facts, ask, groundingError);
  const absentFirstPath = absentFirstImplementationPath(facts, ask, groundingError, deps.repositoryRoot);
  if (absentFirstPath) {
    observeGoalAuthor('goal-author', 'implementation-target-absent-first-path', absentFirstPath);
  }
  observeGoalAuthor('goal-author', 'implementation-target-narrowing', {
    authorRunId,
    attempted: !groundingError && !!facts,
    rule: implementationTarget?.rule ?? null,
    ...(implementationTarget ? { path: implementationTarget.path } : { candidateCount: facts ? implementationCandidates(facts).length : 0 }),
  });
  const acceptanceSection = acceptanceCriteria(criteria, acceptanceChecklist, clarificationQuestions, clarificationResponses);
  const limitations = limitationSection(ask);
  const invariants = invariantSection(facts, ask, clarificationAnswers);
  const decisionSignals = decisionSignalSection(facts, ask, enhancement.decisionSignal);
  const distinctionSupport = normalizeAcceptanceDistinctionSupport(ask, facts?.persistentEvidence ?? []);
  const distinctionSection = acceptanceDistinctionSection(distinctionSupport, enhancement);
  // ⭐ 「사람이 썼나 / 접지에서 왔나 / 저작기가 만들었나 / 아무도 못 만들었나」를 «다른 값»으로.
  //   ⛔ 한 값이면 이 배선이 도는지, 도는데 안 쓰이는지, 아예 안 도는지가 안 갈린다.
  // ⛔⭐⭐ 그래서 저작 축은 «둘»이다 — `authoringOffered`(만들었나)와 `fromAuthoring`(쓰였나).
  //   초판은 「만들었나」 하나만 두고 그것을 `fromAuthoring` 이라 불렀다. ask·접지가 이겨 후보가
  //   버려진 판에서도 `1` 이 나왔다 ⇒ ***자가 「생성」을 「채택」이라 말했다***(무인 리뷰 2026-08-08).
  //   ⭐ 렌더와 «같은» `decisionSignalSelection` 을 쓰므로 이제 둘이 갈릴 수 없다.
  const decisionSignalSources = decisionSignalSelection(facts, ask, enhancement.decisionSignal);
  observeGoalAuthor('goal-author', 'decision-signal-source', {
    authorRunId,
    fromAsk: parseAskDecisionSignals(ask).length,
    fromEvidence: evidenceDecisionSignalCandidates(facts).length,
    authoringOffered: decisionSignalSources.authoringOffered ? 1 : 0,
    fromAuthoring: decisionSignalSources.authoringAdopted ? 1 : 0,
  });
  const slots = [invariants, decisionSignals];
  observeGoalAuthor('goal-author', 'section-slot-fill', {
    slots: slots.reduce((total, section) => total + section.slots, 0),
    filled: slots.reduce((total, section) => total + section.filled, 0),
    unfilled: slots.reduce((total, section) => total + section.unfilled, 0),
    unfilledReasons: slots.flatMap((section) => section.unfilledReasons),
    invariantBranches: invariants.invariantBranches,
  });
  const parsedBoundaryMatches = askBoundaryDecisions(ask);
  const normalizedBoundaryMatches = [
    ...normalizeUnparsedMarkerSegments(ask, ASK_BOUNDARY_MARKER, '경계', ASK_BOUNDARY),
  ];
  const authorBoundaryMatches = orderedAskMatches([...parsedBoundaryMatches, ...normalizedBoundaryMatches]);
  const unparsedBoundaryMarkers = markerOutsideMatches(ask, ASK_BOUNDARY_MARKER, authorBoundaryMatches);
  const headingBoundaryDiagnostics = [
    ...headingFormMarkerSources(ask, '경계', authorBoundaryMatches)
      .map((source) => renderHeadingFormMarker('boundary', source, '경계: src/example.ts만 고친다.')),
    ...emptyHeadingMarkerDiagnostics(ask, '경계'),
  ];
  const scopeBoundarySection = [
    ...scopeCandidates,
    ...parentBoundaryLines(deps.parentDocument),
    ...authorBoundaryMatches.flatMap((candidate) => [
      `- Boundary decision: ${candidate.value}`, 
      ...(isNormalizedAskMatch(candidate) ? [`  - Normalized ask marker: original=${JSON.stringify(candidate.original)}; normalized=${JSON.stringify(candidate.normalized)}`] : []),
    ]),
    ...unparsedBoundaryMarkers.map((source) => renderUnparsedMarker(
      UNPARSED_BOUNDARY_MARKER,
      source,
      '경계: <intentional boundary decision>',
      '경계: src/example.ts만 고친다.',
    )),
    ...headingBoundaryDiagnostics,
    ...liveSurfaceBoundary(liveSurfaceCriteria),
  ];
  const candidateCount = scopeCandidatePaths.length;
  const boundaryDecisionCount = scopeBoundarySection.filter((line) => line.startsWith('- Boundary decision:')).length;

  observeGoalAuthor('goal-author', 'scope-boundary-candidates', {
    count: candidateCount,
    candidatePaths: scopeCandidatePaths,
    boundaryDecisionCount,
    source: 'documentFacts',
  });
  // 전사 검사는 재조립한 문서가 아니라, 각 절에 넣을 원본 줄 배열을 본다. 원문/근거가
  // 절 제목을 인용해도 이 배열의 경계는 변하지 않는다.
  markUntranscribedCriteria(
    [...withoutDedicatedSectionDuplicates(enhancement.checklist, ask), ...liveSurfaceCriteria],
    acceptanceSection,
    scopeBoundarySection,
  );
  // ⭐⭐ 조인 행 — 여기가 goalId 가 «정해지는» 자리다. 이 한 줄이 저작 축(authorRunId 로 묶인
  //   phase-end·elapsedMs·후보 수)과 런 축(goalId 로 묶인 rework·replan·사람 판단)을 잇는다.
  //   ⛔ 이 줄이 없으면 「탐색 비용 ↔ 오판 비용」 곡선을 «원리상» 못 그린다(축이 서로를 모른다).
  //   ⚠️⭐ 계약 — 이 줄은 조립·린트가 «끝나기 전»에 난다(goalId 가 여기서 정해지므로 더 늦출 수 없다).
  //      ⇒ 저작이 그 «뒤»에 실패하면 이 조인 행만 남는다(dangling). 그러므로 ***집계는 「착지한 골」과의
  //      inner join 으로만 한다*** — 이 행 자체를 「골이 하나 생겼다」로 세면 «실패분까지» 센다(무인 리뷰 지적).
  const assignedGoalId = deps.goalId ?? generateGoalId();
  const askFile = deps.askFile === undefined ? undefined : validateAskFile(deps.askFile);
  try { observeGoalAuthor('goal-author', 'goal-id-assigned', { authorRunId, goalId: assignedGoalId, superseded: Boolean(deps.goalId) }); }
  catch { /* 관측은 fail-soft */ }
  // ⛔⭐⭐⭐⭐ 「왜 이 골인가」 절은 **문서에 안 싣는다**(대표 2026-08-09 · 소비자 전수 감사).
  //   판정 근거: 이 절을 파싱하는 코드가 `goal-author` 밖에 «0» 이고, 「사람이 읽는 자리」라고
  //   선언했지만 그 사람을 특정한 표면도 «0» 이었다. ⊕ 절 스스로가 중복을 자백하고 있었다 —
  //   *"사람이 시킨 것(… 원문은 아래 절에 그대로 있다)"* ⇒ 같은 것을 `## WHAT TO BUILD` 가 이미 싣는다.
  //
  // ⭐⭐ 그런데 «함수는 지우지 않는다» — 그 산출을 «관측»으로 옮긴다. 이유가 셋이다:
  //   ⑴ 「없앤 글자 수」를 상수로 쓰면 그 관측이 «거짓»이 된다. 실제로 생략된 문자열을 세야 참이다.
  //   ⑵ 이 함수가 «이미 아는 것»(접지 파일 수 · 좁힌 대상 · 경계 개수)은 값이 있다 — 문서에서 뺀다고
  //      그 값까지 버릴 이유가 없다. 읽는 자리를 «문서»에서 «로그»로 옮기는 것이다.
  //   ⑶ 기존 계약 테스트가 이 함수를 직접 문다. 함수를 지우면 그 경계 사례(비영 경계 · 규칙 미상 ·
  //      파일 샘플 상한 · 접지 0파일 · 공백 재배치 · 코드포인트)가 «검증할 대상을 잃는다».
  const retiredGoalSummary = rfcGoalProseSection({
    ask: enhancement.original,
    groundedFiles: facts?.files ?? [],
    grounded: Boolean(facts?.grounded) && !groundingError,
    narrowedPath: implementationTarget?.path ?? null,
    narrowedRule: implementationTarget?.rule ?? null,
    boundaryDecisionCount: authorBoundaryMatches.length,
  });
  try {
    observeGoalAuthor('goal-author', 'goal-summary-omitted', {
      authorRunId,
      goalId: assignedGoalId,
      // ⛔ 「자」는 «코드 포인트»로 센다 — 이 저장소 ask 는 이모지를 상시 쓰고, String.length 는
      //   이모지 하나를 2로 센다(같은 이유로 위 함수도 코드 포인트로 자른다).
      // ⛔⭐ 「없앤 글자 수」의 «경계 정의» — 그 절의 «본문»이다: 줄들을 `\n` 으로 이은 길이.
      //   ⚠️ 문서 배열에 끼울 때 앞뒤로 붙었을 «구분 개행»은 «안 센다» — 그 개행은 절의 것이 아니라
      //   조립의 것이고, 절이 사라져도 문서의 다른 이음매가 그 자리를 갖기 때문이다.
      //   ⇒ 이 수를 「문서가 이만큼 줄었다」로 읽지 마라. 「그 절이 이만큼이었다」로 읽는다.
      omittedCharacterCount: [...retiredGoalSummary.join('\n')].length,
      groundedFileCount: facts?.files?.length ?? 0,
      boundaryDecisionCount: authorBoundaryMatches.length,
      narrowedPath: implementationTarget?.path ?? null,
      // ⛔⭐ 규칙도 «같이» 싣는다 — 경로만 실으면 「안 좁혔다」와 「좁혔는데 규칙을 모른다」가
      //   한 값으로 뭉친다. ⊕ 이 다섯이 있어야 산출을 «재구성»할 수 있어 관측이 자기 일관성을 갖는다.
      narrowedRule: implementationTarget?.rule ?? null,
    });
  } catch { /* 관측은 fail-soft */ }
  endAssembleSubphase();
  startAssembleSubphase('assemble-document');
  const document = [
    explicitGoalTitle ?? goalSummary(enhancement.original),
    `- GoalId: ${assignedGoalId}`,
    `- RootIntent: ${rootIntent}`,
    `- GoalType: ${goalType}`,
    ...(askFile === undefined ? [] : [`- AskFile: ${askFile}`]),
    ...groundedSummary(facts, groundingError),
    ...(deps.parent ? [serializeGoalAuthorParent(deps.parent)] : []),
    ...genericSearchScopePrompt(clarificationQuestions, clarificationResponses),
    ...implementationAnchorPrompt(clarificationQuestions, clarificationResponses),
    '',
    '## PROBLEM',
    ...problem,
    '',
    '## WHAT TO BUILD',
    ...narrative.whatToBuild,
    '',
    // ⛔ prompt-enhance 의 **조립된 블롭(`enhanced`)을 싣지 않는다.** 그것은 자기 `## ` 헤딩
    //   (`## 목표`·`## 실행 제약`·`## 커버리지 체크리스트`)과 단계형 문장을 갖고 와서
    //   4블록·비플래너 불변식을 깬다(2026-07-28 라이브 실측). 헤딩 강등으로 덮으려 했더니
    //   **원문 안의 `#` 줄까지 고쳐 verbatim 계약을 깨뜨렸다**(리뷰 지적) — 잘못된 처방이었다.
    //   ⇒ 구조화 필드만 쓴다: 무손상 원문(`original`)은 코드펜스로, 요구는 checklist 로.
    ORIGINAL_ASK_MARKER,
    // ⛔ 원문이 백틱 울타리를 품을 수 있다 — 고정 3백틱이면 **원문이 문서 펜스를 조기에 닫고**
    //   그 뒤 줄들이 문서 구조로 오독된다(실측: 원문 안 `## …` 줄이 최상위 블록으로 잡혔다).
    //   ⇒ 원문 안 최장 백틱 런보다 **한 칸 긴** 울타리를 쓴다(CommonMark 규칙).
    fenceFor(enhancement.original),
    enhancement.original,
    fenceFor(enhancement.original),
    ...(hasEvidence && implementationCandidates(facts!).length
      ? facts!.genericSearchScope
        ? [
          '- Candidate leads remain in the repository evidence above; do not select or implement them until the requested clarification traces a behavior and call path.',
          ...implementationTargetGrounding(facts, ask, groundingError, clarificationAnswers, deps.repositoryRoot),
        ]
        : implementationTargetGrounding(facts, ask, groundingError, clarificationAnswers, deps.repositoryRoot)
      : ['- No grounded candidate exists. Select files only after new repository evidence is obtained.']),
    ...genericSearchScopeNotice(facts, groundingError),
    '',
    ...(resolvedSteps === undefined
      ? []
      : ['## STEPS', ...(resolvedSteps.length ? resolvedSteps.map((step) => `- ${step}`) : ['- No externally injected steps.']), '']),
    '## ACCEPTANCE CRITERIA',
    ...acceptanceSection,
    ...preservationAmbiguityCriteria(ambiguities, clarificationAnswers),
    ...preservationAmbiguityNotice(ambiguities),
    ...preservationAmbiguityClarification(clarificationQuestions, clarificationResponses),
    '',
    '## REQUIRED EVIDENCE',
    ...requiredEvidence(criteria, facts ? implementationCandidates(facts) : [], authorRunId),
    '',
    ...(goalType === 'implement' ? ['## TRACED PATHS', ...tracedPathsSection(facts, narrative.tracedPathsUnavailableEvidence), ''] : []),
    '## SCOPE BOUNDARY',
    ...scopeBoundarySection,
    '',
    '## 답하지 못하는 것',
    ...limitations,
    '',
    '### 수용 구별 관측',
    ...distinctionSection,
    '',
    '## 불변식',
    ...invariants.lines,
    '',
    '## 판정 신호',
    ...decisionSignals.lines,
    '',
    ...artifactLaunchDeclaration,
    // ⛔⭐ 시나리오는 문서 «끝»에 온다. 간격은 «한 곳»에서만 준다 — 기동 선언이 이미 빈 줄로 끝나고
    //   시나리오 절 자신은 빈 줄을 «안» 갖는다. 양쪽이 각자 넣으면 절 본문에 개행이 늘어
    //   기존 계약(`markdownSection` 이 내는 문자열)이 조용히 달라진다(2026-08-20 실측 2건).
    testScenario.sections.join('\n\n'),
  ].join('\n');

    endAssembleSubphase();
    assembleCompleted = true;
    endGoalAuthorPhase('assemble', assembleStartedAt, authorRunId, deps.onProgress);
    const lintStartedAt = startGoalAuthorPhase('lint', authorRunId, deps.onProgress);
    let lintPassed = false;
    try {
      assertRequiredBlocks(document);
      lintPassed = true;
    } finally {
      try {
        endGoalAuthorPhase('lint', lintStartedAt, authorRunId, deps.onProgress);
      } finally {
        try {
          observeGoalAuthor('goal-author', 'summary', {
            authorRunId,
            elapsedMs: Date.now() - authorStartedAt,
            inputTokens: enhanceTokens.inputTokens,
            outputTokens: enhanceTokens.outputTokens,
            totalTokens: enhanceTokens.inputTokens === null || enhanceTokens.outputTokens === null
              ? null : enhanceTokens.inputTokens + enhanceTokens.outputTokens,
            goalChars: [...document].length,
            sectionChars: authoredGoalSectionChars(document),
            ...(!lintPassed ? { outcome: 'lint-failed' } : {}),
          });
        } catch { /* observation is fail-soft */ }
      }
    }
    return { document, facts, grounded: !groundingError && hasEvidence, authorRunId };
  } finally {
    endAssembleSubphase();
    if (!assembleCompleted) endGoalAuthorPhase('assemble', assembleStartedAt, authorRunId, deps.onProgress);
  }
}

/** Select the single production authoring grounding route with the caller's repository root. */
export async function groundForGoalAuthor(
  ask: string,
  cwd: string,
  deps: GoalAuthorGroundingDeps = {},
): Promise<GoalAuthorGroundingResult> {
  return {
    path: 'groundMissionInCodebase',
    // ⛔⭐ 사람이 ask 에 «이름을 댄» 경로를 접지에 «넘긴다» — 접지가 그것을 후보로 쓴다.
    //   ⛔ 추출기를 «새로 만들지 않는다» — 이 파일이 이미 갖고 있는 askPathTokens 하나를 쓴다
    //     (2026-08-11 72차: 같은 것에 두 이름을 준 병을 하루에 여섯 번 셌다).
    facts: await (deps.groundMission ?? groundMissionInCodebase)(ask, {
      cwd,
      seedPaths: askPathTokens(ask),
      ...(deps.persistent !== undefined ? { persistent: deps.persistent } : {}),
    }),
  };
}

/**
 * Inspecting a known path must not depend on the bounded LLM discovery loop reaching
 * update_goal.  Read the actual repository candidate directly and express that read
 * as persistent evidence, while preserving the normal authoring route above.
 */
export async function groundInvariantInspection(
  invariant: string,
  cwd: string,
): Promise<CodebaseGrounding> {
  const paths = evidencePaths(invariant).filter((path) => isRepositoryImplementationCandidate(path));
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(cwd);
  } catch {
    repositoryRoot = resolve(cwd);
  }
  const existingPaths = paths.filter((path) => {
    const absolute = resolve(repositoryRoot, path);
    const lexicalRelative = relative(repositoryRoot, absolute);
    if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative) || !existsSync(absolute)) return false;
    try {
      // Resolve symlinks before reading: a repository-relative spelling must not
      // turn an out-of-tree target into grounding evidence.
      const resolved = realpathSync(absolute);
      const resolvedRelative = relative(repositoryRoot, resolved);
      if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) return false;
      readFileSync(resolved, 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  return {
    grounded: existingPaths.length > 0,
    context: '',
    files: existingPaths,
    persistentEvidence: existingPaths.map((path) => `${path}: directly read repository path for invariant inspection`),
    skillFacts: [],
    codeFacts: [],
    memoryFacts: [],
    documentFacts: [],
    documentMatches: [],
    searchTerms: [],
    genericSearchScope: false,
    refFacts: [],
    ptyFacts: [],
  };
}

async function runDefaultHelpProbe(cwd: string, argv: readonly string[]): Promise<GoalCommandExecutionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stderr: stderr.slice(0, GOAL_AUTHOR_HELP_PROBE_STDERR_MAX_CHARS) });
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      finish(null);
    }, GOAL_AUTHOR_HELP_PROBE_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < GOAL_AUTHOR_HELP_PROBE_STDERR_MAX_CHARS) {
        stderr += chunk.toString('utf8').slice(0, GOAL_AUTHOR_HELP_PROBE_STDERR_MAX_CHARS - stderr.length);
      }
    });
    child.once('error', () => finish(null));
    child.once('close', (status) => finish(status));
  });
}

/**
 * Reuse the existing grounding, additive enhancement, and coverage modules for production authoring.
 *
 * ⭐ export 인 이유 — 이 함수가 «배선»을 쥔다(어느 인자를 enhance 에 넘기는가).
 *   ⛔ 공개 진입점으로 그 배선을 재려면 실제 접지가 돌아 테스트가 타임아웃한다(실측 5초 초과).
 *   ⇒ 배선만 무는 테스트가 이것을 직접 부른다.
 */
export function defaultGoalAuthorDeps(cwd: string): GoalAuthorDeps {
  return {
    async ground(ask, groundingDeps) {
      return (await groundForGoalAuthor(ask, cwd, groundingDeps)).facts;
    },
    /**
     * ⭐⭐ 저작 경로는 체크리스트를 «완주 판정»이 아니라 «골 문서 재료»로 쓴다 — 그래서 용도를 밝힌다.
     *
     * ⛔ 종전엔 밝히지 않아 `coverage-gate` 문면(*"모든 요구를 빠짐없이 각각 개별 항목으로 —
     *   하나라도 누락되면 미완"*)을 그대로 받았고, 그 결과 `ACCEPTANCE CRITERIA` 가 문서의
     *   **19.9%**(평균 40.2줄 · 실측 최대 94줄)를 먹었다. 📏 그런데 이 경로에서 그 체크리스트로
     *   «완주를 판정하는 코드는 없다» — `checkableCriteria` 는 문서에 렌더하고
     *   `markUntranscribedCriteria` 는 표시만 한다. ⇒ ***관문이 아닌 것을 관문이라 믿고 만든 나열.***
     * ⭐ 진짜 관문은 `agent-mission/driver.ts:402` 의 `verifyCoverage` 하나뿐이고, 그 경로는
     *   이 칸을 «안 주므로» 기본값 `coverage-gate` 로 종전 문면을 그대로 받는다.
     */
    enhance(ask, opts) {
      return enhancePrompt(ask, { ...opts, checklistUse: 'authoring' });
    },
    readSourceFile: createRepositoryReferencedFileReader(cwd),
    runHelpProbe: (argv) => runDefaultHelpProbe(cwd, argv),
  };
}

const MAX_FILENAME_BYTES = 255;
// Goal files are listed and reviewed in ASCII-only terminals, so keep the meaningful
// prefix portable and short even when the request title is Korean.
const MAX_GOAL_SLUG_BYTES = 64;
const GOAL_FINGERPRINT_LENGTH = 8;
const IDENTITY_LINE = /^(agent|track|session|submitted):\s*(.*?)\s*$/i;

function localDate(now: Date): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

function asciiGoalSlug(title: string): string {
  return title.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function missionSlugFallback(goal: string): string {
  return slugify(extractSlugSource(goal));
}

async function goalSlug(goal: string, slugFn: (goal: string) => Promise<string>): Promise<string> {
  try {
    return (await slugFn(goal)).trim() || missionSlugFallback(goal);
  } catch {
    return missionSlugFallback(goal);
  }
}

function slugWithinUtf8Budget(normalizedSlug: string, byteBudget: number): string {
  let slug = '';
  let bytes = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalizedSlug);
  for (const { segment } of graphemes) {
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (bytes + segmentBytes > byteBudget) break;
    slug += segment;
    bytes += segmentBytes;
  }
  return slug.replace(/-+$/g, '');
}

function goalFingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, GOAL_FINGERPRINT_LENGTH);
}

export interface GoalFileNameSource {
  /** Human-readable generated goal title used for the ASCII slug. */
  title: string;
  /** Complete generated artifact used to distinguish semantically different results from one ask. */
  document: string;
  /** Repository identifiers from the original ask, retained before a generated title slug. */
  repositoryIdentifiers?: readonly string[];
}

function repositoryIdentifiers(ask: string): string[] {
  const lines = ask.split(/\r?\n/);
  const metadata = leadingIdentityMetadata(ask);
  const body = metadata.size
    ? (lines[0]?.trim() === '---' ? lines.slice(lines.slice(1).findIndex((line) => line.trim() === '---') + 2) : lines.slice(lines.findIndex((line) => !IDENTITY_LINE.test(line))))
    : lines;
  return body
    .filter((line) => !line.startsWith('Checkable requested criterion:'))
    .join('\n')
    .match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? [];
}

function buildGoalFileName(source: GoalFileNameSource, now: Date, collisionSuffix = ''): string {
  const date = localDate(now);
  const fingerprint = goalFingerprint(source.document);
  const fixed = `GOAL--${fingerprint}${collisionSuffix}-${date}.md`;
  const byteBudget = Math.min(
    MAX_GOAL_SLUG_BYTES,
    MAX_FILENAME_BYTES - Buffer.byteLength(fixed, 'utf8'),
  );
  const identifierPrefix = source.repositoryIdentifiers?.map(asciiGoalSlug).filter(Boolean).join('-');
  const titleSlug = asciiGoalSlug(source.title);
  const slug = slugWithinUtf8Budget([identifierPrefix, titleSlug].filter(Boolean).join('-'), byteBudget) || 'goal';
  return `GOAL-${slug}-${fingerprint}${collisionSuffix}-${date}.md`;
}

/** Single filename contract shared by helper callers and the filesystem writer. */
export function goalFileName(source: GoalFileNameSource, now: Date): string {
  const fileName = buildGoalFileName(source, now);
  if (!isGoalAuthorFileName(fileName)) throw new Error(`goal filename violates document contract: ${fileName}`);
  return fileName;
}

function leadingIdentityMetadata(ask: string): Map<string, string> {
  const lines = ask.split(/\r?\n/);
  let candidates: string[] = [];
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex((line) => line.trim() === '---');
    if (end < 0) return new Map();
    candidates = lines.slice(1, end + 1);
  } else if (IDENTITY_LINE.test(lines[0] ?? '')) {
    candidates = lines.slice(0, lines.findIndex((line) => !IDENTITY_LINE.test(line)) === -1
      ? lines.length
      : lines.findIndex((line) => !IDENTITY_LINE.test(line)));
  }

  const metadata = new Map<string, string>();
  for (const line of candidates) {
    const match = IDENTITY_LINE.exec(line);
    const value = match?.[2].trim();
    if (match && value && !metadata.has(match[1].toLowerCase())) metadata.set(match[1].toLowerCase(), value);
  }
  return metadata;
}

/** `submitted` 는 KST 로 적는다 — 두 트랙이 같은 벽시계를 인용해야 이력이 정렬된다. */
export function formatSubmittedAt(at: Date): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
  return `${parts.replace(' ', ' ')} KST`;
}

/**
 * 신원 머리말 — **값이 있는 줄만** 낸다.
 *
 * ⛔ 빈 값·`unknown` 을 찍지 않는다: 부재와 미지가 같은 값이 되면 조회가 거짓을 생산한다.
 *    *"모르면 비워라"* 가 아니라 **"없으면 줄을 쓰지 마라"** 다.
 * ⭐ 우선순위는 **ask 에 이미 적힌 값 > 환경/시계 유도**다(호출자가 명시한 것이 이긴다).
 */
function identityLines(ask: string, cwd: string, env: NodeJS.ProcessEnv, at: Date): string[] {
  const metadata = leadingIdentityMetadata(ask);
  const tree = /[/\\](pilot|axon)[/\\]/i.exec(cwd)?.[1]?.toLowerCase();
  const track = metadata.get('track') ?? (tree === 'pilot' ? 'S' : tree === 'axon' ? 'T' : undefined);
  const agent = metadata.get('agent') ?? env.AI_AGENT?.trim();
  const session = metadata.get('session') ?? env.CLAUDE_CODE_SESSION_ID?.trim();
  const submitted = metadata.get('submitted') ?? formatSubmittedAt(at);
  return [
    agent && `agent: ${agent}`,
    track && `track: ${track}`,
    session && `session: ${session}`,
    submitted && `submitted: ${submitted}`,
  ].filter((line): line is string => Boolean(line));
}

/** ⛔⭐ 문서가 «어떤 절 본문»으로 끝나면 그 절이 꼬리 메타를 삼킨다 — 그래서 경계를 준다.
 *
 *  ⛔ 종전엔 기동 선언 «하나»만 봤다. 2026-08-20 에 검증 시나리오 절이 그 뒤에 붙자
 *  ***조건이 조용히 거짓이 되어 `## 메타데이터` 경계가 사라졌다***(실측으로 잡았다).
 *  ⇒ 🔑 「마지막 절이 무엇인가」를 목록으로 물어야 한다 — 절을 더할 때마다 여기가 늙지 않게. */
function artifactLaunchTailBoundary(document: string): string {
  const tailTitles = [ARTIFACT_LAUNCH_SECTION, ...TEST_SCENARIO_SECTION_TITLES.map((title) => title.replace(/^##\s+/, ''))];
  for (const title of tailTitles) {
    const section = markdownSection(document, title);
    if (section !== null && document.trimEnd().endsWith(section.trimEnd())) return '## 메타데이터\n\n';
  }
  return '';
}

/** The authoring entrypoint's only side effect is one collision-safe goal file. */
export async function writeAuthoredGoal(
  ask: string,
  cwd: string,
  deps: Partial<GoalAuthorDeps> = {},
  fileDeps: GoalFileDeps = {},
  groundingRoot: string = cwd,
): Promise<{ path: string; authored: AuthoredGoal }> {
  if ('supersessionRootIntent' in deps) {
    throw new Error('supersessionRootIntent is reserved for the superseded document reader');
  }
  observeGoalAuthor('goal-author', 'grounding-root', { cwd, groundingRoot, differs: groundingRoot !== cwd });
  const defaultDeps = defaultGoalAuthorDeps(groundingRoot);
  const resolvedDeps = {
    ...defaultDeps,
    ...deps,
    repositoryRoot: deps.repositoryRoot ?? groundingRoot,
  };
  const mandatoryGoalContextEvidence = goalContextEvidence(cwd);
  const directoryMeasurement = askDirectoryMeasurementLine(observeAskDirectoryCounts(ask, groundingRoot));
  resolvedDeps.enhanceOpts = directoryMeasurement ? { ...resolvedDeps.enhanceOpts, directoryMeasurement } : resolvedDeps.enhanceOpts;
  observeGoalAuthor('goal-author', 'ask-directory-measurement-forwarded', { count: directoryMeasurement ? 1 : 0 });
  // ⛔ 잠금 키·재조회·역링크를 **canonical realpath** 로 고정한다(리뷰 must-fix 2026-07-31):
  //   symlink·상대·정규 경로가 같은 원본을 가리켜도 문자열로 잠그면 별개 잠금이 되어
  //   두 alias 동시 `--supersedes` 가 후속 문서를 둘 만들고 역링크는 하나만 남는다.
  //   존재하지 않는 원본은 realpathSync 가 던져 잠금 취득 전에 거부된다.
  const canonicalSupersededPath = fileDeps.supersedes ? realpathSync(fileDeps.supersedes.path) : undefined;
  const releaseSupersessionLock = canonicalSupersededPath
    ? (fileDeps.acquireSupersessionLock ?? defaultSupersessionLock)(canonicalSupersededPath)
    : undefined;
  let supersededDocument: string | undefined;
  try {
    if (canonicalSupersededPath) {
      validateLockedSupersededPath(cwd, canonicalSupersededPath);
      supersededDocument = (fileDeps.read ?? ((path: string) => readFileSync(path, 'utf8')))(canonicalSupersededPath);
    }
    const supersededGoalId = supersededDocument && parseGoalId(supersededDocument);
    const supersededRootIntent = supersededDocument === undefined ? null : parseRootIntent(supersededDocument);
    const inheritedRootIntent = resolvedDeps.parentDocument === undefined ? null : parseRootIntent(resolvedDeps.parentDocument);
    if (fileDeps.supersedes && !supersededGoalId) {
      throw new Error('superseded goal file has no GoalId');
    }
    if (fileDeps.supersedes && supersededRootIntent === null && inheritedRootIntent === null && resolvedDeps.rootIntent === undefined) {
      throw new Error('legacy superseded goal file has no RootIntent; rootIntent is required');
    }
    if (fileDeps.supersedes && supersededDocument) {
      const backlinkCount = supersededByCount(supersededDocument);
      if (backlinkCount > 1) throw new Error('superseded goal file has duplicate Superseded-By');
      if (backlinkCount === 1) throw new Error('superseded goal file already has Superseded-By');
    }
    const authored = await authorGoalWithSupersededRootIntent(ask, supersededDocument === undefined
      ? { ...resolvedDeps, mandatoryGoalContextEvidence }
      : {
        ...resolvedDeps,
        mandatoryGoalContextEvidence,
        ...(supersededGoalId && { goalId: supersededGoalId }),
        ...(supersededRootIntent !== null && { supersessionRootIntent: supersededRootIntent }),
      });
    const stampedAt = fileDeps.now?.() ?? new Date();
  const identity = identityLines(ask, cwd, fileDeps.env ?? process.env, stampedAt);
  if (identity.length) {
    // ⛔⭐ 머리말은 **파일 끝**이다. 둘째 줄에 두면 `elanous dev --file` 이 그것을 PR 제목·브랜치명으로
    //   집는다(실측 2026-07-29: `track: S` 가 브랜치가 되어 자식이 어긋난 제목을 받고 런이 죽었다).
    //   첫 줄은 **제목 전용**이어야 한다.
    authored.document = `${authored.document.replace(/\n+$/, '')}\n\n${artifactLaunchTailBoundary(authored.document)}---\n${identity.join('\n')}\n`;
  }
  const directory = resolveGoalDocumentsDir(cwd).directory;
  const mkdir = fileDeps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  // ⭐ exclusive create. `existsSync` 후 `writeFileSync` 는 TOCTOU 라 동시 저작이 남의 골을
  //   **조용히 덮어쓴다**. `wx` 는 파일이 이미 있으면 EEXIST 로 실패하므로 경합이 없다.
  //   주입된 write 가 있으면(테스트) 그것을 쓰되, 같은 배타 의미를 흉내내도록 exists 로 감싼다.
  // ⛔ 주입 write 를 `exists` 선검사로 감싸지 않는다 — 그건 여전히 TOCTOU 다(리뷰 지적).
  //   **계약으로 강제한다**: 주입하는 쪽이 파일이 이미 있으면 `code:'EEXIST'` 로 던지는
  //   **원자적 배타 생성**을 제공해야 한다(예: `writeFileSync(p, d, { flag: 'wx' })`).
  //   기본 경로는 그 계약을 그대로 만족한다.
  const write = fileDeps.write ?? ((path: string, document: string): void => {
    writeFileSync(path, document, { flag: 'wx' });
  });
  mkdir(directory);
  const source = {
    title: await goalSlug(authored.document.split('\n', 1)[0], resolvedDeps.slugFn ?? generateMissionSlug),
    document: authored.document,
    repositoryIdentifiers: repositoryIdentifiers(ask),
  };
  const now = stampedAt;
  const base = goalFileName(source, now);
  let path: string | null = null;
  for (let suffix = 1; suffix <= MAX_COLLISION_RETRIES; suffix += 1) {
    const candidate = join(directory, suffix === 1 ? base : buildGoalFileName(source, now, `-copy-${suffix}`));
    try {
      write(candidate, authored.document);
      path = candidate;
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
    if (!path) throw new Error(`goal author could not find a free filename after ${MAX_COLLISION_RETRIES} attempts for ${base}`);
    observeAuthoredConstraintMarkers(ask, authored.document, authored.authorRunId);
    observeAuthoredGroundingPathSections(authored.document, authored.facts?.files ?? [], authored.authorRunId);
    if (!canonicalSupersededPath || !supersededDocument) return { path, authored };

    const rewrite = fileDeps.rewrite ?? ((sourcePath: string, document: string) => atomicRewrite(sourcePath, document, fileDeps.rename));
    const remove = fileDeps.remove ?? ((successorPath: string) => rmSync(successorPath, { force: true }));
    const successorReference = repositoryRelativeGoalPath(cwd, path);
    try {
      rewrite(canonicalSupersededPath, addSupersededBy(supersededDocument, successorReference));
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        rewrite(canonicalSupersededPath, supersededDocument);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        remove(path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'goal author could not record Superseded-By and could not fully roll back');
      }
      throw error;
    }
    try {
      (fileDeps.emitSupersessionWarning ?? emitSupersessionWarning)(ask, supersededDocument, authored.document);
    } catch {
      try { observeGoalAuthor('goal-author', 'supersession-warning-detection-failed', {}); } catch { /* observation is fail-soft */ }
    }
    return { path, authored };
  } finally {
    releaseSupersessionLock?.();
  }
}
