import type { RunStopClass } from './run-stop.js';
import type { RunContract } from './graph-run-contract.js';
import type { GateRoutingReason } from './graph-authority.js';
import { landingFreezeState, type LandingFreeze } from '../release-loop/landing-freeze.js';
import type { ActiveProviderInfo } from '../provider-summary.js';
import type { ResourceView } from '../control-plane/ledger.js';
import type { UserConfig } from '../user-config.js';

/** ⭐ RFC §5 «4단계» — `applies_when` 을 «코드»가 판정한다.
 *
 *  ⛔⭐ **표현식 엔진을 만들지 않는다.** 문법이 넓어지면 오버레이가 «작은 프로그램»이 되고,
 *    그러면 「왜 이 걸음인가」를 답하려면 그 프로그램을 읽어야 한다 — 그래프를 데이터로 둔 이유가 사라진다.
 *  ⇒ 문법은 «둘»뿐이다. 못 읽는 조건은 ⛔ **거절**한다(조용히 참으로 만들지 않는다).
 *
 *  📌 RFC §4.3 ⑵: 라우터·조건의 «값»은 코드가 낸다. LLM 이 못 고른다. */
export type OverlayConditionOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';

export interface OverlayCondition {
  readonly key: string;
  readonly operator: OverlayConditionOperator;
  readonly literal: string | number;
}

export type OverlayConditionParse =
  | { readonly ok: true; readonly condition: OverlayCondition }
  | { readonly ok: false; readonly reason: 'unparseable'; readonly source: string };

/** ⛔⭐ 리터럴을 «좁힌다» — 수 또는 «낱말»만.
 *  🩸 2026-09-08 실측: 옛 정규식(`\S+`)이 `a >= 1;` 을 통과시켰다. `1;` 이 «문자열 리터럴»이 되어
 *    수 비교가 조용히 낱말 비교로 바뀌었다 ⇒ 뜻이 달라지는데 아무도 안 말한다. */
const CONDITION = /^\s*([a-z_][a-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?|[a-z_][a-z0-9_-]*)\s*$/i;

export function parseOverlayCondition(source: string): OverlayConditionParse {
  const match = CONDITION.exec(source);
  if (!match) return { ok: false, reason: 'unparseable', source };
  const [, key, operator, rawLiteral] = match;
  const numeric = Number(rawLiteral);
  const literal = rawLiteral!.length > 0 && Number.isFinite(numeric) ? numeric : rawLiteral!;
  return { ok: true, condition: { key: key!, operator: operator as OverlayConditionOperator, literal } };
}

/** L1 values are producer observations; an unobserved field is absent, never a default. */
export interface GraphRunState {
  readonly attempts: number;
  readonly goal_id?: string;
  readonly stop_class?: RunStopClass;
  readonly review_repeat?: number;
  readonly sibling_overlap?: boolean;
  readonly main_sync_conflict?: boolean;
  readonly author_grade?: string;
  readonly substrate?: 'local' | 'pod';
  readonly freeze?: 'on' | 'off';
  readonly docs_only?: boolean;
  readonly provider?: string;
  readonly quota?: 'ok' | 'low' | 'exhausted';
  readonly machines?: number;
  readonly seats?: 'on' | 'steward-only';
}

/** Inputs known at a runtime overlay decision. Every field except `attempts` may be unknown. */
export interface RuntimeOverlayStateInput {
  readonly attempts: number;
  /** Producer results captured for this decision; omitted in callers not yet wired to L1. */
  readonly producers?: L1OverlayProducerReadings;
  readonly goalId?: string;
  readonly stopClass?: RunStopClass;
  readonly reviewRepeat?: number;
  /** Only a real boolean is a measurement. */
  readonly siblingOverlap?: unknown;
  readonly mainSyncConflict?: unknown;
  /** Only a non-empty string is a measurement. */
  readonly authorGrade?: unknown;
  /** Pass resolved producer values, not configuration wishes or fallback guesses. */
  readonly substrate?: unknown;
  /** Derived from readLandingFreeze's validated, expiry-aware result. */
  readonly freeze?: unknown;
  readonly docsOnly?: unknown;
  readonly provider?: unknown;
  readonly quota?: unknown;
  readonly machines?: unknown;
  readonly seats?: unknown;
}

/** Producer outputs supplied at the decision boundary; omission means the producer was not read. */
export interface L1OverlayProducerReadings {
  readonly runContract?: Pick<RunContract, 'substrate'>;
  readonly landingFreeze?: LandingFreeze | null;
  /** routeGate's documents-only verdict is the known docs-only observation. */
  readonly gateRoute?: { readonly reason: GateRoutingReason };
  readonly activeProvider?: Pick<ActiveProviderInfo, 'provider'>;
  /** Snapshot returned by assessQuotaExhaustion/readQuotaExhausted; only measured usage implies ok/low. */
  readonly quotaAssessment?: { readonly exhausted: boolean | undefined; readonly accountAvailability: {
    readonly currentUsedPercent?: number;
    readonly thresholdPercent?: number;
  } | undefined };
  /** Result of listMachineResources (Nexus live membership), not fleet intent. */
  readonly machineResources?: readonly Pick<ResourceView, 'machine' | 'expired'>[];
  /** Resolved loop modes; do not pass an unreadable config as a default measurement. */
  readonly seatConfig?: NonNullable<UserConfig['loops']>['seat'];
  readonly stewardConfig?: NonNullable<UserConfig['loops']>['steward'];
}

/** Derive only observations from named producers. A missing producer never becomes false or zero. */
export function l1OverlayStateInput(readings: L1OverlayProducerReadings): Omit<RuntimeOverlayStateInput, 'attempts'> {
  const quota = readings.quotaAssessment;
  const currentUsed = quota?.accountAvailability?.currentUsedPercent;
  const threshold = quota?.accountAvailability?.thresholdPercent;
  const seat = readings.seatConfig;
  return {
    ...(readings.runContract ? { substrate: readings.runContract.substrate } : {}),
    ...(readings.landingFreeze !== undefined ? { freeze: landingFreezeState(readings.landingFreeze) } : {}),
    ...(readings.gateRoute ? { docsOnly: readings.gateRoute.reason === 'documents-only' } : {}),
    ...(readings.activeProvider ? { provider: readings.activeProvider.provider } : {}),
    ...(quota?.exhausted === true ? { quota: 'exhausted' } :
      quota?.exhausted === false && currentUsed !== undefined && threshold !== undefined
        ? { quota: currentUsed >= threshold ? 'low' : 'ok' } : {}),
    ...(readings.machineResources ? { machines: new Set(readings.machineResources.filter((row) => !row.expired).map((row) => row.machine)).size } : {}),
    ...(seat && readings.stewardConfig?.mode === 'live'
      ? { seats: seat.mode === 'on' || seat.mode === 'live-safe' ? 'on' : 'steward-only' }
      : {}),
  };
}

/** ⛔ 아는 값만 싣는다 — 모르면 키를 «뺀다». 0·false·빈 문자열을 지어내지 않는다. */
export function buildRuntimeOverlayState(input: RuntimeOverlayStateInput): GraphRunState & Record<string, unknown> {
  const produced: Omit<RuntimeOverlayStateInput, 'attempts'> = input.producers === undefined ? {} : l1OverlayStateInput(input.producers);
  // Once producers are supplied, even an omitted reading is unknown; direct legacy inputs cannot override it.
  const substrate = input.producers === undefined ? input.substrate : produced.substrate;
  const freeze = input.producers === undefined ? input.freeze : produced.freeze;
  const docsOnly = input.producers === undefined ? input.docsOnly : produced.docsOnly;
  const provider = input.producers === undefined ? input.provider : produced.provider;
  const quota = input.producers === undefined ? input.quota : produced.quota;
  const machines = input.producers === undefined ? input.machines : produced.machines;
  const seats = input.producers === undefined ? input.seats : produced.seats;
  return {
    attempts: input.attempts,
    ...(input.goalId === undefined ? {} : { goal_id: input.goalId }),
    ...(input.stopClass === undefined ? {} : { stop_class: input.stopClass }),
    ...(typeof input.reviewRepeat === 'number' && Number.isFinite(input.reviewRepeat) ? { review_repeat: input.reviewRepeat } : {}),
    ...(typeof input.siblingOverlap === 'boolean' ? { sibling_overlap: input.siblingOverlap } : {}),
    ...(typeof input.mainSyncConflict === 'boolean' ? { main_sync_conflict: input.mainSyncConflict } : {}),
    ...(typeof input.authorGrade === 'string' && input.authorGrade.length > 0 ? { author_grade: input.authorGrade } : {}),
    ...(substrate === 'local' || substrate === 'pod' ? { substrate } : {}),
    ...(freeze === 'on' || freeze === 'off' ? { freeze } : {}),
    ...(typeof docsOnly === 'boolean' ? { docs_only: docsOnly } : {}),
    ...(typeof provider === 'string' && provider.trim().length > 0 ? { provider } : {}),
    ...(quota === 'ok' || quota === 'low' || quota === 'exhausted' ? { quota } : {}),
    ...(typeof machines === 'number' && Number.isSafeInteger(machines) && machines >= 0 ? { machines } : {}),
    ...(seats === 'on' || seats === 'steward-only' ? { seats } : {}),
  };
}

export type OverlayConditionVerdict =
  /** 조건이 참이다 — 얹는다. */
  | { readonly kind: 'applies' }
  /** 조건이 거짓이다 — 안 얹는다. ⛔ 「못 읽었다」와 «다른 값»이다. */
  | { readonly kind: 'does-not-apply' }
  /** ⛔ 조건을 못 읽었다 — 얹지 «않는다». 조용히 참으로 만들지 않는다. */
  | { readonly kind: 'unparseable'; readonly source: string }
  /** ⛔ 그 키가 상태에 «없다» — 「값이 0」과 «다른 값»이다. 얹지 않는다. */
  | { readonly kind: 'key-absent'; readonly key: string };

/** 조건을 «상태»에 대 본다. ⛔ 상태에 없는 키를 0·빈값으로 «가정하지 않는다». */
export function evaluateOverlayCondition(
  source: string | undefined,
  state: Readonly<Record<string, unknown>>,
): OverlayConditionVerdict {
  // 조건이 «없는» 오버레이는 항상 후보다(파서가 조건 필수를 따로 강제한다).
  if (source === undefined) return { kind: 'applies' };
  const parsed = parseOverlayCondition(source);
  if (!parsed.ok) return { kind: 'unparseable', source };
  const { key, operator, literal } = parsed.condition;
  if (!(key in state)) return { kind: 'key-absent', key };
  const actual = state[key];
  if (actual === undefined || actual === null) return { kind: 'key-absent', key };
  // Measured boolean branch keys accept only a real boolean observation — any textual lookalike
  // ('true', 'TRUE', 'yes', 1) is unknown, whatever the literal spelling in the condition.
  if ((key === 'sibling_overlap' || key === 'main_sync_conflict') && typeof actual !== 'boolean') return { kind: 'key-absent', key };

  if (typeof literal === 'number') {
    // ⛔ 수 비교인데 값이 수가 아니면 「비교 불가」다 — 거짓으로 접지 않는다.
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return { kind: 'key-absent', key };
    const holds = operator === '>=' ? actual >= literal
      : operator === '>' ? actual > literal
      : operator === '<=' ? actual <= literal
      : operator === '<' ? actual < literal
      : operator === '==' ? actual === literal
      : actual !== literal;
    return holds ? { kind: 'applies' } : { kind: 'does-not-apply' };
  }

  const actualText = typeof actual === 'string' ? actual : String(actual);
  const holds = operator === '==' ? actualText === literal
    : operator === '!=' ? actualText !== literal
    : undefined;
  // ⛔ 문자열에 대소 비교를 쓰면 「못 읽었다」다 — 사전순으로 «몰래» 답하지 않는다.
  if (holds === undefined) return { kind: 'unparseable', source };
  return holds ? { kind: 'applies' } : { kind: 'does-not-apply' };
}
