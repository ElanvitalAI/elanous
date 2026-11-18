/**
 * 🔗 우산 — SELF-IMPLEMENT-DECOMPOSE §2 «목표 모양» · W0 0a.
 *
 * 세 덩어리
 *   - `StageContext` — 읽기 전용(opts·seams·identity·template·worktree·T ⊕ `StageNodeContext` 흡수). 직렬화하지 않는다.
 *   - `RunState`     — 직렬화 가능한 런 상태 묶음(impl·gate·review·rework·supervisor·findings·providerErrors·land).
 *                      ⛔ 함수·AbortSignal·핸들·Map·Set·undefined 금지 — 없음은 `null`, Map 은 `Record`, Set 은 배열.
 *   - `RunSink`      — `runSelfImplementInner` 위치 콜백(orchestrator.ts:5252-5305 · 호출 :4483-4540)을 객체 하나로.
 *
 * `applyPatch(state, patch)` — 순수. 입력을 고치지 않고 새 상태를 돌려준다. 모르는 칸·틀린 꼴은 «거부»(StatePatchError)한다.
 *
 * ⛔ 0a 는 형과 순수 함수뿐이다. 생산 코드에서 부르는 곳은 아직 없다(0b 가 RunSink 를, 2d 이후가 applyPatch 를 배선).
 * ⛔ 오늘 런 «안» 체크포인트는 없다 — RunState 직렬화는 새 능력이지 parity 주장이 아니다.
 *
 * RunState 에서 «뺀» 것과 이유(공유 상태 표 = seat-state/TC/GOAL-AUTHOR-DECOMPOSE-STEP0.md §11)
 *   - `reworkCapProceed`(orchestrator.ts:5212) — 모듈 전역 · 프로세스 공유라 동시 런끼리 경합한다. 런 상태가 아니다(W0 비보장).
 *   - `lastProviderError`·`lastCredentialFailure`(:3922-3923 · ChildProviderErrorDetail) — 직렬화 안전을 0a 에서 감사하지 않았다(unmeasured).
 *   - `wt`·`graphTemplate`·`nodeContext`·`T`·`opts`·`seams` — 핸들·함수를 품는다 → StageContext.
 *   - 콜백·`observe`·`AbortSignal` — 함수·핸들 → RunSink / StageContext.signal.
 *   - Map 6(:3839-3846) → Record 5 ⊕ 배열 1 로 바꿔 싣는다(꼴 변환 · 값 동일).
 *   - 안쪽 나머지 약 50(§11a 의 #8·#15-18·#24-37·#39-59 등)은 W2·W3 에서 해당 단계가 뗄 때 칸을 더한다.
 *
 * 노드 기준 = 실행 파이프라인 8노드뿐(envelope.ts `StageNode` = pipeline-shape.ts:4-12 `PipelineNodeId`).
 *   orchestrator 는 `onNodeEntry` 12곳(:7119 · :7759 · :7951-7952 · :8111-8112 · :8487 · :8860 · :9373 · :9433 · :9536 · :9856)으로 이 8개만 밟는다.
 *   implement-loop.yaml 32노드 중 나머지 24(여정 19 · 앞단 3 · 저작 출구 2)는 관측 지점이지 단계가 아니다 — 여기서 모델링하지 않는다.
 */
import type { GraphTemplate } from '../graph-templates.js';
import type { RunContract } from '../graph-run-contract.js';
import type { StageNodeContext as LegacyStageNodeContext } from '../graph-stage-units.js';
import type { LifecycleScreenComparison } from '../lifecycle-screen-scoreboard.js';
import type {
  AttemptOrdinal,
  CitedReviewSymbolOccurrence,
  GoalExecutionRecord,
  NormalizedReviewFindingOccurrence,
  ObservationMeasurementBasis,
  SelfImplementOptions,
  SelfImplementResult,
  SelfImplementSeams,
  StepTimeouts,
  makeRunObserver,
} from '../orchestrator.js';
import type { PipelineNodeId } from '../pipeline-shape.js';
import type { ReviewFindingRecurrence } from '../review-finding-recurrence.js';
import type { EscalateTier } from '../rework-policy.js';
import type { RunShardIdentity } from '../run-ledger.js';
import type { ChildLlmSelection } from '../../agent/run-context.js';
import type { ReworkBudgetVerdict } from '../run-outcome.js';
import type { ReviewRework } from '../../self-dev/run-types.js';
import type { resolveRunIdentity } from '../../harness/harness-space.js';

// ─────────────────────────────────────────────────────────────────────────────
// StageContext
// ─────────────────────────────────────────────────────────────────────────────

/** 옛 이름 호환 — 정의는 `graph-stage-units.ts:36-55` 그대로다(그 파일은 고치지 않는다). */
export type StageNodeContext = LegacyStageNodeContext;

export type StageWorktree = Awaited<ReturnType<SelfImplementSeams['createWorktree']>>;

/** 읽기 전용 맥락 — 한 런 동안 바뀌지 않거나(opts·seams·identity·T), 한 번 정해진 뒤 고정된다(template·worktree·node). */
export interface StageContext {
  /** orchestrator.ts:5253 `opts` */
  readonly opts: SelfImplementOptions;
  /** orchestrator.ts:5308 `s = opts.seams` */
  readonly seams: SelfImplementSeams;
  /** orchestrator.ts:5254 `identity` · 없으면 :5306 에서 resolveRunIdentity */
  readonly identity: { readonly runId: string; readonly source: ReturnType<typeof resolveRunIdentity>['source'] };
  /** orchestrator.ts:5255 */
  readonly attemptOrdinal: AttemptOrdinal;
  /** orchestrator.ts:5256 */
  readonly shardIdentity: RunShardIdentity;
  /** orchestrator.ts:5302 `startedAtMs` */
  readonly startedAtMs: number;
  /** orchestrator.ts:5344 `graphTemplate`(오버레이 :5517 전까지 let) — 정해지기 전이면 undefined */
  readonly template?: GraphTemplate;
  /** orchestrator.ts:5692 `wt` — 만들기 전이면 undefined */
  readonly worktree?: StageWorktree;
  /** orchestrator.ts:5590 `T` */
  readonly T: StepTimeouts;
  /** orchestrator.ts:5434 `nodeContext`(StageNodeContext 흡수) — 해석 실패면 undefined */
  readonly node?: StageNodeContext;
  /** 취소 신호 — 직렬화 불가라 RunState 가 아니라 여기 둔다. */
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunState — 생산자 줄은 orchestrator.ts(origin/main cb407dfcd7) 기준
// ─────────────────────────────────────────────────────────────────────────────

export interface RunStateImpl {
  /** let round :6266 · 증가 :8716 · :9204 */
  round: number;
  /** impl.ok — `impl = ` :7900 · :7956 · :7967 · :7984 · :8025 · :8165 · :8178 */
  ok: boolean | null;
  /** impl.summary — 같은 생산자 */
  summary: string | null;
  /** impl.toolCalls — 같은 생산자(미주입은 null = 모름) */
  toolCalls: number | null;
  /** goalOnlyReworkUsed :6285 · :7938 */
  goalOnlyReworkUsed: boolean;
  /**
   * 지금 묶인 자식 모델 — `activeChildLlm` 초기값 :6360(= opts.childLlm) · 재작업 재선택 :7829(`reselectChildForRework`
   * rework-child-provider.ts:9 · grok → openai-codex). 런 도중 «바뀐다»(HARNESS-DOCS-DRIFT-1118 N16). 없으면 null.
   * 읽는 곳: implement 호출 :7887 · :7962 · :8122.
   */
  childLlm: ChildLlmSelection | null;
  /** 재선택 이력 — 생산자 :7829 · 관측 'rework-child-model-reselected' :7830-7833 와 같은 값. 오늘은 관측 이벤트로만 남는다. */
  childLlmReselections: ChildLlmReselection[];
}

/** 재작업 라운드의 자식 모델 재선택 한 건(rework-child-provider.ts:6 `action: 'reselect'`). */
export interface ChildLlmReselection {
  round: number;
  previous: ChildLlmSelection;
  selected: ChildLlmSelection;
  reason: 'grok-quota-exhausted' | 'grok-credential-missing';
}

export interface RunStateGate {
  /** gate.passed — `gate = ` :8489 · :8491 · :8504 · :8519 · :8577 · :8952 · :9434 · :9491 */
  passed: boolean | null;
  /** gate.deferredToLand — 같은 생산자 */
  deferredToLand: boolean;
  /** gate.testStepExecuted — 같은 생산자 */
  testStepExecuted: boolean | null;
  /** gate.unverified — 같은 생산자 */
  unverified: string[];
  /** gate.measuredFileCount — 같은 생산자 */
  measuredFileCount: number | null;
  /** gateEnvDeficitKind :8493 · :8513 */
  envDeficitKind: string | null;
  /** lastGateUnverifiedKey :8711 */
  lastUnverifiedKey: string | null;
}

export interface RunStateReview {
  /** review.verdict — `review = ` :8868 */
  verdict: 'pass' | 'warn' | 'fail' | null;
  /** review.reviewed — :8868 */
  reviewed: boolean | null;
  /** review.mustFix — :8868 */
  mustFix: string[];
  /** review.shouldFix — :8868 */
  shouldFix: string[];
  /** review.summary — :8868 */
  summary: string | null;
  /** reviewedHeadCommit :8852 · :8870 */
  reviewedHeadCommit: string | null;
}

export type ReworkSource = 'gate' | 'review' | 'supervisor';

export interface RunStateRework {
  /** reworkNote :6004(setReworkPart) · :7747 */
  note: string;
  /** reworkJudgeNote — setReworkPart :6001 경유 · 직접 생산 줄 unresolved */
  judgeNote: string;
  /** reworkKind :6006 */
  kind: ReworkSource;
  /** reworkHistory :8653 · :9199 */
  history: string[];
  /** failCounts :8651 · :9198 */
  failCounts: number[];
  /** measuredRework(바깥 :3831) ← 콜백 :4497 */
  measured: ReviewRework | null;
  /** consecutiveUnresolvedBudget :7218 · :7223 · :7540 · :7543 */
  consecutiveUnresolvedBudget: number;
}

export interface RunStateSupervisor {
  /** lastSupervisorVerdict :7166 */
  lastVerdict: ReworkBudgetVerdict | null;
  /** lastSupervisorReason :7128 · :7347 */
  lastReason: string | null;
  /** lastReworkVerdict :7127 · :7349 */
  lastReworkVerdict: ReworkBudgetVerdict | null;
  /** judgedEffectiveMax :7351 */
  judgedEffectiveMax: number | null;
  /** 바깥 lastParsedSupervisorVerdict :3901 ← 콜백 :4511 */
  lastParsedVerdict: ReworkBudgetVerdict | null;
  /** 바깥 lastParsedSupervisorReason :3902 ← 콜백 :4512 */
  lastParsedReason: string | null;
}

export interface RunStateFindings {
  /** reviewFindingRoundCount :4163 */
  roundCount: number;
  /** lastReviewFindings :4164 */
  lastReviewFindings: string[] | null;
  /** symbolKeyedReviewFindingCount :4170 */
  symbolKeyedCount: number;
  /** proseFallbackReviewFindingCount :4171 */
  proseFallbackCount: number;
  /** Map verbatimReviewFindingOccurrences :3839 · set :4181 */
  verbatimOccurrences: Record<string, number>;
  /** Map normalizedReviewFindingFirstSeenRounds :3840 · set :4186 */
  normalizedFirstSeenRounds: Record<string, number>;
  /** Map normalizedReviewFindingObservedRoundCounts :3841 · set :4187 · :4191 */
  normalizedObservedRoundCounts: Record<string, number>;
  /** Map normalizedReviewFindingRepeatCounts :3842 · set :4193 */
  normalizedRepeatCounts: Record<string, number>;
  /** 배열 normalizedRepeatedReviewFindingOccurrences :3843 · push :4194 */
  normalizedRepeatedOccurrences: NormalizedReviewFindingOccurrence[];
  /** Map citedReviewSymbolOccurrences :3846 · set :4205 · :4213 */
  citedSymbolOccurrences: Record<string, CitedReviewSymbolOccurrence>;
}

export type ChildProviderErrorQueryStatus = 'found' | 'none' | 'unavailable' | 'not-configured';

export interface RunStateProviderErrors {
  /** providerErrorCount :3948 · :4004 */
  providerErrorCount: number;
  /** credentialFailureCount :3949 · :4025 */
  credentialFailureCount: number;
  /** failureSequence :3916 · :3917 · :3950 · :3951 · :4005 */
  failureSequence: number;
  /** lastProviderErrorSeq :3950 · :4005 */
  lastProviderErrorSeq: number;
  /** lastCredentialFailureSeq :3951 · :4026 */
  lastCredentialFailureSeq: number;
  /** lastFailedGateSeq :3916 */
  lastFailedGateSeq: number;
  /** lastMustFixReviewSeq :3917 */
  lastMustFixReviewSeq: number;
  /** providerErrorAtLastGate :3914 · 비움 :4527 */
  providerErrorAtLastGate: string | null;
  /** childProviderErrorQueryStatus :3944 · :3957 */
  childQueryStatus: ChildProviderErrorQueryStatus;
  /** queriedProviderErrorCount :3952 */
  queriedProviderErrorCount: number;
  /** queriedCredentialFailureCount :3953 */
  queriedCredentialFailureCount: number;
}

export interface RunStateLand {
  /** 바깥 resolvedBase ← 콜백 :4513(안 :5713) */
  resolvedBase: string | null;
  /** mergeApprovalReceived ← 콜백 :4509 */
  mergeApprovalReceived: boolean;
  /** autoMergeAuthorizedBeforeSync ← 콜백 :4510 */
  autoMergeAuthorizedBeforeSync: boolean;
  /** finishedImplementationAtMainSync ← 콜백 :4534 */
  finishedImplementationAtMainSync: boolean;
  /** preSyncCommit ← 콜백 :4534 */
  preSyncCommit: string | null;
  /** capturedPrNumber ← 콜백 :4537 */
  capturedPrNumber: number | null;
  /** prAttributionMismatch ← 콜백 :4538 */
  prAttributionMismatch: boolean;
  /** openPrInvoked :4051 */
  openPrInvoked: boolean;
}

export interface RunState {
  impl: RunStateImpl;
  gate: RunStateGate;
  review: RunStateReview;
  rework: RunStateRework;
  supervisor: RunStateSupervisor;
  findings: RunStateFindings;
  providerErrors: RunStateProviderErrors;
  land: RunStateLand;
}

export type RunStateSection = keyof RunState;

// ─────────────────────────────────────────────────────────────────────────────
// RunSink — runSelfImplementInner 위치 인자(orchestrator.ts:5257-5304 · 호출 :4488-4538) 중 함수·관측자 → 객체 하나
//   키 이름 = 옛 매개변수 이름(0b 가 1:1 로 옮긴다). 같은 함수가 두 자리에 꽂히는 두 쌍은 키 하나로 합쳤다.
//   표 = seat-state/TC/SI-W0-RUNSINK-KEYS.md
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewFindingTelemetry = NonNullable<Parameters<NonNullable<SelfImplementSeams['diagnose']>>[0]['reviewFindingTelemetry']>;
export type ClarificationTimeoutPayload = Pick<GoalExecutionRecord, 'clarificationTimeoutUnanswered' | 'clarificationTimeoutQuestionIds' | 'clarificationUnansweredOutcome'>;

export interface RunSink {
  /** :5257 */ onNodeEntry(node: PipelineNodeId, round: number): void;
  /** :5258 */ onRoundClassification(classification: LifecycleScreenComparison): void;
  /** :5259 */ onWorktreeCreated(path: string): void;
  /** :5260 */ onRoundExecution(tier: EscalateTier): void;
  /** :5261 */ onReviewFindings(round: number, mustFix: readonly string[]): void;
  /** :5262 */ onReworkMeasured(rework: ReviewRework): void;
  /** :5265 */ onGraphResolved(identity: { graphId: string; graphVersion: string }): void;
  /** :5267 */ onGraphTemplateResolved(template: GraphTemplate): void;
  /** :5272 */ onEvidenceCoverage(summary: { required: number; covered: number; uncovered: number }): void;
  /** :5273 (질의) */ reviewFindingTelemetry(): ReviewFindingTelemetry;
  /** :5276 (질의 · 시험 심) */ reworkBudgetReviewFindingRecurrence(): ReviewFindingRecurrence | null;
  /** :5277 */ onMergeApprovalReceived(): void;
  /** :5278 */ onAutoMergeAuthorizedBeforeSync(): void;
  /** :5279 */ onSupervisorVerdictParsed(verdict: ReworkBudgetVerdict): void;
  /** :5280 */ onSupervisorReasonParsed(reason: string | undefined): void;
  /** :5281 */ onResolvedBase(base: string | null): void;
  /** :5282 */ onObservationMeasurementBasis(basis: ObservationMeasurementBasis): void;
  /** :5283 */ onClarificationTimeout(timeout: ClarificationTimeoutPayload): void;
  /** :5284 `hasProviderError` ⊕ :5298 `hasCurrentProviderError` — 호출부(:4516 · :4532)가 같은 함수를 꽂는다 */
  hasCurrentProviderError(): boolean;
  /** :5285 `hasCredentialFailure` ⊕ :5299 `hasCurrentCredentialFailure` — 호출부(:4517 · :4533)가 같은 함수를 꽂는다 */
  hasCurrentCredentialFailure(): boolean;
  /** :5286 (질의) */ providerErrorCategory(): NonNullable<SelfImplementResult['providerErrors']>['category'] | undefined;
  /** :5287 */ onReviewReflectRejected(rejectedCount: number): void;
  /** :5288 관측자 객체(makeRunObserver) — 없으면 안에서 만든다(:5307) */
  readonly observe?: ReturnType<typeof makeRunObserver>;
  /** :5291 */ onActiveProvider(active: { provider?: string; model?: string; auth?: string }): void;
  /** :5292 */ onSessionCreated(sessionId: string): void;
  /** :5293 */ onRunContractResolved(contract: RunContract): void;
  /** :5294 */ onFailureVerdict(kind: 'gate' | 'review'): Promise<void>;
  /** :5295 (질의 · 읽고 비운다 — 호출부 :4525-4529) */ providerErrorAtLastGate(): string | undefined;
  /** :5296 (질의) */ hasObservedProviderError(): boolean;
  /** :5297 (질의) */ hasObservedCredentialFailure(): boolean;
  /** :5300 */ onMainSyncStarted(commit: string | undefined): void;
  /** :5301 */ preserveMergeHarvest(reason: string, inputChars?: number): Promise<boolean>;
  /** :5303 */ onPrAttributed(number: number): void;
  /** :5304 */ onPrAttributionMismatch(): void;
}


// ─────────────────────────────────────────────────────────────────────────────
// StatePatch · applyPatch
// ─────────────────────────────────────────────────────────────────────────────

/** 경로 = [칸, 필드] · `merge`/`unset` 은 Record 필드 안 키까지 [칸, 필드, 키] 를 허용한다. */
export type StatePatchOp =
  | { readonly op: 'set'; readonly path: readonly [RunStateSection, string]; readonly value: unknown }
  | { readonly op: 'append'; readonly path: readonly [RunStateSection, string]; readonly values: readonly unknown[] }
  | { readonly op: 'merge'; readonly path: readonly [RunStateSection] | readonly [RunStateSection, string]; readonly value: Readonly<Record<string, unknown>> }
  | { readonly op: 'unset'; readonly path: readonly [RunStateSection, string] | readonly [RunStateSection, string, string] };

export type StatePatch = readonly StatePatchOp[];

export type StatePatchErrorCode =
  | 'unknown-op' | 'bad-path' | 'unknown-section' | 'unknown-field' | 'wrong-type'
  | 'not-a-list' | 'not-a-record' | 'not-nullable' | 'forbidden-key' | 'not-serializable';

export class StatePatchError extends Error {
  constructor(readonly code: StatePatchErrorCode, readonly index: number, detail: string) {
    super(`StatePatch[${index}] ${code}: ${detail}`);
    this.name = 'StatePatchError';
  }
}

type Check = (v: unknown) => boolean;
interface FieldSpec { readonly check: Check; readonly nullable?: true; readonly item?: Check; readonly entry?: Check }

const isNum: Check = v => typeof v === 'number' && Number.isFinite(v);
const isInt: Check = v => Number.isSafeInteger(v);
const isStr: Check = v => typeof v === 'string';
const isBool: Check = v => typeof v === 'boolean';
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const oneOf = (...xs: readonly string[]): Check => v => typeof v === 'string' && xs.includes(v);
const listOf = (item: Check): Check => v => Array.isArray(v) && v.every(item);
const recordOf = (entry: Check): Check => v => isPlainObject(v) && Object.values(v).every(entry);
const shape = (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check => v =>
  isPlainObject(v)
  && Object.entries(fields).every(([k, c]) => Object.hasOwn(v, k) && c(v[k]))
  && Object.keys(v).every(k => Object.hasOwn(fields, k) || (Object.hasOwn(optional, k) && (optional[k] as Check)(v[k])));

const VERDICT = oneOf('EXTEND', 'SUFFICIENT', 'UNCONVERGEABLE', 'CONTRACT-CONFLICT');
const REVIEW_REWORK = shape({ trend: oneOf('unmeasured', 'improving', 'stable', 'worsening', 'oscillating'), signature: isStr, rounds: isInt });
const NORMALIZED_OCCURRENCE = shape(
  { hash: isStr, firstSeenRound: isInt, repeatedAtRound: isInt, occurrence: isInt },
  { observedRoundCount: isInt },
);
const CHILD_LLM = shape(
  { provider: isStr, model: isStr, source: oneOf('flag', 'config') },
  { effort: oneOf('minimal', 'low', 'medium', 'high', 'xhigh', 'max'), codexQuotaPolicy: oneOf('credits') },
);
const CHILD_LLM_RESELECTION = shape({
  round: isInt, previous: CHILD_LLM, selected: CHILD_LLM, reason: oneOf('grok-quota-exhausted', 'grok-credential-missing'),
});
const CITED_OCCURRENCE = shape({ hash: isStr, symbol: isStr, firstSeenRound: isInt, lastSeenRound: isInt, occurrence: isInt });

const f = (check: Check): FieldSpec => ({ check });
const n = (check: Check): FieldSpec => ({ check, nullable: true });
const list = (item: Check): FieldSpec => ({ check: listOf(item), item });
const nlist = (item: Check): FieldSpec => ({ check: listOf(item), item, nullable: true });
const rec = (entry: Check): FieldSpec => ({ check: recordOf(entry), entry });

const SCHEMA: { readonly [S in RunStateSection]: { readonly [K in keyof RunState[S]]: FieldSpec } } = {
  impl: {
    round: f(isInt), ok: n(isBool), summary: n(isStr), toolCalls: n(isInt), goalOnlyReworkUsed: f(isBool),
    childLlm: n(CHILD_LLM), childLlmReselections: list(CHILD_LLM_RESELECTION),
  },
  gate: {
    passed: n(isBool), deferredToLand: f(isBool), testStepExecuted: n(isBool), unverified: list(isStr),
    measuredFileCount: n(isInt), envDeficitKind: n(isStr), lastUnverifiedKey: n(isStr),
  },
  review: {
    verdict: n(oneOf('pass', 'warn', 'fail')), reviewed: n(isBool), mustFix: list(isStr), shouldFix: list(isStr),
    summary: n(isStr), reviewedHeadCommit: n(isStr),
  },
  rework: {
    note: f(isStr), judgeNote: f(isStr), kind: f(oneOf('gate', 'review', 'supervisor')), history: list(isStr),
    failCounts: list(isNum), measured: n(REVIEW_REWORK), consecutiveUnresolvedBudget: f(isInt),
  },
  supervisor: {
    lastVerdict: n(VERDICT), lastReason: n(isStr), lastReworkVerdict: n(VERDICT), judgedEffectiveMax: n(isInt),
    lastParsedVerdict: n(VERDICT), lastParsedReason: n(isStr),
  },
  findings: {
    roundCount: f(isInt), lastReviewFindings: nlist(isStr), symbolKeyedCount: f(isInt), proseFallbackCount: f(isInt),
    verbatimOccurrences: rec(isInt), normalizedFirstSeenRounds: rec(isInt), normalizedObservedRoundCounts: rec(isInt),
    normalizedRepeatCounts: rec(isInt), normalizedRepeatedOccurrences: list(NORMALIZED_OCCURRENCE),
    citedSymbolOccurrences: rec(CITED_OCCURRENCE),
  },
  providerErrors: {
    providerErrorCount: f(isInt), credentialFailureCount: f(isInt), failureSequence: f(isInt), lastProviderErrorSeq: f(isInt),
    lastCredentialFailureSeq: f(isInt), lastFailedGateSeq: f(isInt), lastMustFixReviewSeq: f(isInt),
    providerErrorAtLastGate: n(isStr), childQueryStatus: f(oneOf('found', 'none', 'unavailable', 'not-configured')),
    queriedProviderErrorCount: f(isInt), queriedCredentialFailureCount: f(isInt),
  },
  land: {
    resolvedBase: n(isStr), mergeApprovalReceived: f(isBool), autoMergeAuthorizedBeforeSync: f(isBool),
    finishedImplementationAtMainSync: f(isBool), preSyncCommit: n(isStr), capturedPrNumber: n(isInt),
    prAttributionMismatch: f(isBool), openPrInvoked: f(isBool),
  },
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o: object, k: string): boolean => Object.hasOwn(o, k);

/**
 * 직렬화 규칙 — 패치 값은 «JSON 왕복에서 그대로 돌아오는 값»만 받는다. 아니면 `not-serializable`.
 *   허용: null · boolean · string · 유한 number · 빈칸 없는 배열 · 평범한 객체(proto = Object.prototype)의 자기 문자열 키.
 *   거부: undefined(배열 원소·객체 값 모두 — JSON 이 null 로 바꾸거나 지워 왕복이 깨진다) · bigint · function · symbol
 *        · NaN/±Infinity · 배열 빈칸 · 순환 · 평범하지 않은 객체(Date·Map·Set·클래스 인스턴스·null-proto) · symbol 키.
 *   키 `__proto__`·`constructor`·`prototype` 는 어디에 있든 `forbidden-key`.
 *   그 밖의 키(예: Record 필드의 `toString`)는 «자기 키» 데이터로 받는다 — 상속 키는 보지 않는다.
 */
function assertSerializable(value: unknown, index: number, at: string, ancestors: Set<object> = new Set()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StatePatchError('not-serializable', index, `${at}: non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new StatePatchError('not-serializable', index, `${at}: ${typeof value}`);
  if (ancestors.has(value)) throw new StatePatchError('not-serializable', index, `${at}: cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) throw new StatePatchError('not-serializable', index, `${at}[${i}]: hole`);
      if (value[i] === undefined) throw new StatePatchError('not-serializable', index, `${at}[${i}]: undefined`);
      assertSerializable(value[i], index, `${at}[${i}]`, ancestors);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new StatePatchError('not-serializable', index, `${at}: non-plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new StatePatchError('not-serializable', index, `${at}: symbol key`);
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new StatePatchError('forbidden-key', index, `${at}.${k}`);
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) throw new StatePatchError('not-serializable', index, `${at}.${k}: undefined`);
      assertSerializable(v, index, `${at}.${k}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function fieldSpec(index: number, section: unknown, field: unknown): FieldSpec {
  if (typeof section !== 'string' || !hasOwn(SCHEMA, section)) throw new StatePatchError('unknown-section', index, String(section));
  const fields = SCHEMA[section as RunStateSection] as Record<string, FieldSpec>;
  if (typeof field !== 'string' || !hasOwn(fields, field)) throw new StatePatchError('unknown-field', index, `${section}.${String(field)}`);
  return fields[field] as FieldSpec;
}

/** 칸을 필드 맵으로 본다 — 키·꼴은 호출 전에 SCHEMA 로 확인했다. */
function sectionOf(state: RunState, section: unknown): Record<string, unknown> {
  return state[section as RunStateSection] as unknown as Record<string, unknown>;
}

function accepts(spec: FieldSpec, value: unknown): boolean {
  return (value === null && spec.nullable === true) || (value !== null && spec.check(value));
}

/**
 * 순수 — `state` 를 고치지 않고 새 상태를 돌려준다. 한 op 라도 거부되면 통째로 던진다(부분 적용 0).
 * 모르는 칸·필드·꼴은 조용히 버리지 않고 `StatePatchError` 로 거부한다.
 */
export function applyPatch(state: RunState, patch: StatePatch): RunState {
  if (!Array.isArray(patch)) throw new StatePatchError('bad-path', -1, 'patch 는 배열이어야 한다');
  const next = structuredClone(state) as RunState;
  patch.forEach((raw: StatePatchOp, index) => {
    const op = raw as { op?: unknown; path?: unknown };
    if (!Array.isArray(op.path) || op.path.length < 1 || op.path.length > 3) throw new StatePatchError('bad-path', index, String(op.path));
    const [section, field, key] = op.path as unknown[];
    // 값 검사는 칸·꼴 검사보다 먼저 — 직렬화 불가 값은 어느 필드로 가든 거부된다.
    if (Object.hasOwn(raw, 'value')) assertSerializable((raw as { value?: unknown }).value, index, 'value');
    if (Object.hasOwn(raw, 'values')) assertSerializable((raw as { values?: unknown }).values, index, 'values');
    switch (op.op) {
      case 'set': {
        if (op.path.length !== 2) throw new StatePatchError('bad-path', index, 'set 은 [칸, 필드]');
        const spec = fieldSpec(index, section, field);
        const value = (raw as { value?: unknown }).value;
        if (!accepts(spec, value)) throw new StatePatchError('wrong-type', index, `${String(section)}.${String(field)}`);
        sectionOf(next, section)[field as string] = structuredClone(value);
        return;
      }
      case 'append': {
        if (op.path.length !== 2) throw new StatePatchError('bad-path', index, 'append 는 [칸, 필드]');
        const spec = fieldSpec(index, section, field);
        if (!spec.item) throw new StatePatchError('not-a-list', index, `${String(section)}.${String(field)}`);
        const values = (raw as { values?: unknown }).values;
        if (!Array.isArray(values) || !values.every(spec.item)) throw new StatePatchError('wrong-type', index, `${String(section)}.${String(field)}`);
        const target = sectionOf(next, section);
        const current = target[field as string];
        target[field as string] = [...(Array.isArray(current) ? current : []), ...structuredClone(values)];
        return;
      }
      case 'merge': {
        const value = (raw as { value?: unknown }).value;
        if (!isPlainObject(value)) throw new StatePatchError('wrong-type', index, 'merge 값은 평범한 객체');
        for (const k of Object.keys(value)) if (FORBIDDEN_KEYS.has(k)) throw new StatePatchError('forbidden-key', index, k);
        if (op.path.length === 1) {
          // 칸 단위 얕은 병합 — 각 키가 그 칸의 필드여야 하고 꼴이 맞아야 한다.
          if (typeof section !== 'string' || !hasOwn(SCHEMA, section)) throw new StatePatchError('unknown-section', index, String(section));
          for (const [k, v] of Object.entries(value)) {
            const spec = fieldSpec(index, section, k);
            if (!accepts(spec, v)) throw new StatePatchError('wrong-type', index, `${String(section)}.${k}`);
          }
          Object.assign(next[section as RunStateSection], structuredClone(value));
          return;
        }
        if (op.path.length !== 2) throw new StatePatchError('bad-path', index, 'merge 는 [칸] 또는 [칸, 필드]');
        const spec = fieldSpec(index, section, field);
        if (!spec.entry) throw new StatePatchError('not-a-record', index, `${String(section)}.${String(field)}`);
        if (!Object.values(value).every(spec.entry)) throw new StatePatchError('wrong-type', index, `${String(section)}.${String(field)}`);
        const target = sectionOf(next, section);
        target[field as string] = { ...(target[field as string] as Record<string, unknown>), ...structuredClone(value) };
        return;
      }
      case 'unset': {
        const spec = fieldSpec(index, section, field);
        const target = sectionOf(next, section);
        if (op.path.length === 2) {
          if (spec.nullable !== true) throw new StatePatchError('not-nullable', index, `${String(section)}.${String(field)}`);
          target[field as string] = null;
          return;
        }
        if (!spec.entry) throw new StatePatchError('not-a-record', index, `${String(section)}.${String(field)}`);
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new StatePatchError('forbidden-key', index, String(key));
        const rest = { ...(target[field as string] as Record<string, unknown>) };
        delete rest[key];
        target[field as string] = rest;
        return;
      }
      default:
        throw new StatePatchError('unknown-op', index, String(op.op));
    }
  });
  return next;
}
