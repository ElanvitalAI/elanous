// ── self-dev rework 소진-복구 정책 (순수·2026-07-22 대표 PLAN) ────────────────
//
// self-implement rework 루프(orchestrator.ts)가 미묘한 버그를 스스로 수렴하도록 4개 결정을 순수 함수로.
// #1 진단 합성(buildReworkFeature)·#2 모델 escalation(shouldEscalateModel)·#3 적응형 rework
// (resolveAdaptiveMaxRework)·#4 리뷰어→fix(buildReworkFeature 가 진단으로 통합). 결정론·주입 없음.
// 실증 근본: C1/C2C3 dogfood 가 maxRework=2 소진 후 정지 — raw 재시도·모델고정·라운드고정이 원인.

import { measureReviewFindingKeyOverlap, reviewFindingKey, type ReviewFindingKeyOverlap } from '../agent-substrate/review-finding-key.js';
import { requiredEvidenceFromGoal, tailWithOmissionMarker } from './off-diff-evidence.js';
import { eligibleRefutationGoalLines, MUST_FIX_REFUTATION_ACKNOWLEDGEMENT, REFUTATION_QUOTE_GRAMMAR } from './reflect-mustfix.js';
import { SUPERVISION_REWORK_SOURCES, type SupervisionReworkSource } from './supervision-vocabulary.js';
import { lookupLlmTierSpec } from '../model-tier/index.js';

export type ReviewFindingRepeatSignal = 'repeat' | 'no-repeat' | 'unmeasurable' | 'insufficient-history';
export type AdaptiveReworkReason = 'insufficient-fail-history' | 'zero-failures' | 'fail-count-not-decreased' | 'repeat-blocked-extension' | 'extended-by-fail-count' | 'hard-cap';

export interface AdaptiveReworkDecision {
  maxRework: number;
  reason: AdaptiveReworkReason;
  failCountTrend: 'decreased' | 'not-decreased' | 'zero-failures' | 'insufficient-history';
  repeatSignal: ReviewFindingRepeatSignal;
  convergence: ConvergenceAssessment;
  convergenceDisposition: ConvergenceDisposition;
}

export interface ConvergenceThreshold {
  /** Configuration-owned threshold; policy does not claim that any particular number is universally correct. */
  nonConvergenceScore: number;
}

export interface ConvergenceRepeatComparison {
  previousRound: number;
  currentRound: number;
  previousFindingKey: string;
  currentFindingKey: string;
  comparable: boolean;
  sharedSymbolCount: number;
  /** Normalized shared symbols divided by the smaller normalized symbol set; undefined when incomparable. */
  overlapRatio: number | undefined;
}

export interface ConvergenceAssessment {
  /** Cumulative, deterministic measure of cross-round non-convergence. */
  nonConvergenceScore: number;
  threshold: ConvergenceThreshold;
  thresholdReached: boolean;
  /** The policy asks the caller to inspect every round; it never samples or performs that inspection. */
  requiresFullReview: boolean;
  /** Count of current-round findings judged to repeat a prior-round finding. */
  repeatedMustFixFindings: number;
  nonDecreasingFailTransitions: number;
  /** Each retained adjacent-round comparison observation, which may be truncated by a later logging layer. */
  repeatedMustFixComparisons: ConvergenceRepeatComparison[];
  /** Total adjacent-round finding comparisons attempted, independent of retained observations. */
  totalMustFixComparisons: number;
  /** Comparisons without a citation on at least one side are retained rather than treated as non-repeats. */
  unmeasurableMustFixComparisons: number;
  /** Unmeasurable comparisons where neither the previous nor current finding cites a symbol. */
  unmeasurableMustFixComparisonsWithoutCitations: number;
  /** Unmeasurable comparisons where only the previous-round finding lacks cited symbols. */
  unmeasurableMustFixComparisonsWithoutPreviousCitations: number;
  /** Unmeasurable comparisons where only the current-round finding lacks cited symbols. */
  unmeasurableMustFixComparisonsWithoutCurrentCitations: number;
}

export type FullConvergenceReview = 'unconvergeable' | 'recoverable';
/** A convergence disposition can stop only after the requested full review reports no recovery path. */
export type ReworkStopReason = 'non-convergence';

export interface ConvergenceDisposition {
  stop: boolean;
  reason: ReworkStopReason | undefined;
  requiresFullReview: boolean;
}

/** At least two shared citations identify a defect; containment permits a reviewer to add context in either round.
 * This deliberately excludes pairs that only share a function name. */
function hasContainedMultiSymbolReviewFindingOverlap(overlap: ReviewFindingKeyOverlap): boolean {
  return overlap.comparable
    && overlap.sharedSymbolCount >= 2
    && overlap.overlapRatio === 1;
}

/** A substantive repeat is a comparable, contained multi-symbol citation overlap, independent of prose wording. */
export function isSubstantiveReviewFindingRepeat(
  currentFinding: string,
  previousFinding: string,
  overlap = measureReviewFindingKeyOverlap(currentFinding, previousFinding),
): boolean {
  return hasContainedMultiSymbolReviewFindingOverlap(overlap);
}

/** 인접한 서로 다른 리뷰 라운드의 반복 근거를 보존한다. 정규화 키는 라운드 안 중복 제거에만 쓰고,
 * 포함된 다중 심볼 겹침으로 반복을 확정한다. 비교 불가능한 지적은 반복 부재로 접지 않는다. */
export function measureReviewFindingRepeat(rounds: readonly (readonly string[] | undefined)[]): ReviewFindingRepeatSignal {
  if (rounds.length < 2) return 'insufficient-history';
  const currentRound = rounds.at(-1);
  const previousRound = rounds.at(-2);
  // A gate-only round has no review evidence, so it must not compare stale reviews.
  if (!currentRound || !previousRound) return 'insufficient-history';
  const deduplicateRound = (round: readonly string[]) => [...new Map(round.map((finding) => [reviewFindingKey(finding).key, finding])).values()];
  const current = deduplicateRound(currentRound);
  const previous = deduplicateRound(previousRound);
  if (current.length === 0 || previous.length === 0) return 'no-repeat';

  let unmeasurable = false;
  for (const currentFinding of current) {
    for (const previousFinding of previous) {
      const overlap = measureReviewFindingKeyOverlap(currentFinding, previousFinding);
      if (!overlap.comparable) {
        unmeasurable = true;
      } else if (isSubstantiveReviewFindingRepeat(currentFinding, previousFinding, overlap)) {
        return 'repeat';
      }
    }
  }
  return unmeasurable ? 'unmeasurable' : 'no-repeat';
}

/** #3 적응형 rework 판정 — 직접 개선 증거인 실패 수 감소가 연장을 결정한다.
 * 반복 신호는 개선 증거가 없을 때만 연장을 차단하며, 두 라운드 모두 실패 0은 별도 추세로 보존한다. */
export function resolveAdaptiveMaxReworkDecision(
  baseMax: number,
  failCounts: readonly number[],
  hardCap = 6,
  reviewFindingRounds: readonly (readonly string[] | undefined)[] = [],
  fullReview?: FullConvergenceReview,
): AdaptiveReworkDecision {
  const cap = Math.max(0, hardCap);
  const unclampedBase = Math.max(0, baseMax);
  const base = Math.min(cap, unclampedBase);
  const repeatSignal = measureReviewFindingRepeat(reviewFindingRounds);
  const convergence = assessConvergence(failCounts, reviewFindingRounds, { nonConvergenceScore: cap });
  const convergenceDisposition = resolveConvergenceDisposition(convergence, fullReview);
  const previousFailCount = failCounts.at(-2);
  const currentFailCount = failCounts.at(-1);
  const failCountTrend = failCounts.length < 2
    ? 'insufficient-history'
    : previousFailCount === 0 && currentFailCount === 0
      ? 'zero-failures'
      : currentFailCount! < previousFailCount!
        ? 'decreased'
        : 'not-decreased';
  const policyMax = failCountTrend === 'decreased' ? unclampedBase + 1 : unclampedBase;
  const maxRework = Math.min(cap, policyMax);
  if (maxRework < policyMax) return { maxRework, reason: 'hard-cap', failCountTrend, repeatSignal, convergence, convergenceDisposition };
  if (failCountTrend === 'insufficient-history') {
    return { maxRework, reason: 'insufficient-fail-history', failCountTrend, repeatSignal, convergence, convergenceDisposition };
  }
  if (failCountTrend === 'zero-failures') return { maxRework, reason: 'zero-failures', failCountTrend, repeatSignal, convergence, convergenceDisposition };
  if (failCountTrend === 'not-decreased' && repeatSignal === 'repeat') {
    return { maxRework, reason: 'repeat-blocked-extension', failCountTrend, repeatSignal, convergence, convergenceDisposition };
  }
  if (failCountTrend === 'not-decreased') return { maxRework, reason: 'fail-count-not-decreased', failCountTrend, repeatSignal, convergence, convergenceDisposition };
  return { maxRework, reason: 'extended-by-fail-count', failCountTrend, repeatSignal, convergence, convergenceDisposition };
}

/** #3 적응형 rework 호환 래퍼 — 기존 소비자는 숫자 상한을 그대로 받는다. */
export function resolveAdaptiveMaxRework(
  baseMax: number,
  failCounts: readonly number[],
  hardCap = 6,
  reviewFindingRounds: readonly (readonly string[] | undefined)[] = [],
): number {
  return resolveAdaptiveMaxReworkDecision(baseMax, failCounts, hardCap, reviewFindingRounds).maxRework;
}

/** 현재 라운드까지 끊기지 않고 살아남은 정규화 review finding key의 후행 연속 라운드 수를 센다.
 * 현재 라운드의 최초 등장 순서가 결과와 최장 동률의 결정 규칙이며, 라운드 안 중복은 한 번으로 취급한다. */
export function countConsecutiveMustFixIds(rounds: readonly (readonly string[])[]): {
  counts: { id: string; consecutiveRounds: number }[];
  longestId: string | null;
  longestConsecutiveRounds: number;
} {
  const current = [...new Set(rounds.at(-1) ?? [])];
  const counts = current.map((id) => {
    let consecutiveRounds = 0;
    for (let index = rounds.length - 1; index >= 0; index--) {
      if (!new Set(rounds[index]).has(id)) break;
      consecutiveRounds++;
    }
    return { id, consecutiveRounds };
  });
  const longest = counts.reduce<{ id: string; consecutiveRounds: number } | undefined>(
    (best, entry) => !best || entry.consecutiveRounds > best.consecutiveRounds ? entry : best,
    undefined,
  );
  return {
    counts,
    longestId: longest?.id ?? null,
    longestConsecutiveRounds: longest?.consecutiveRounds ?? 0,
  };
}

/** Counts every observed stalled/worsening transition and each substantively repeated current-round finding.
 * The threshold is supplied by configuration so this pure policy exposes its provenance rather than hard-coding it. */
export function assessConvergence(
  failCounts: readonly number[],
  mustFixFindingRounds: readonly (readonly string[] | undefined)[],
  threshold: ConvergenceThreshold,
): ConvergenceAssessment {
  const nonDecreasingFailTransitions = failCounts.slice(1).reduce(
    (count, current, index) => count + (current >= failCounts[index]! ? 1 : 0),
    0,
  );
  const repeatedMustFixComparisons: ConvergenceRepeatComparison[] = [];
  let repeatedMustFixFindings = 0;
  let totalMustFixComparisons = 0;
  let unmeasurableMustFixComparisons = 0;
  let unmeasurableMustFixComparisonsWithoutCitations = 0;
  let unmeasurableMustFixComparisonsWithoutPreviousCitations = 0;
  let unmeasurableMustFixComparisonsWithoutCurrentCitations = 0;
  for (let currentRound = 1; currentRound < mustFixFindingRounds.length; currentRound++) {
    const previous = new Map((mustFixFindingRounds[currentRound - 1] ?? []).map((finding) => [reviewFindingKey(finding).key, finding]));
    const current = new Map((mustFixFindingRounds[currentRound] ?? []).map((finding) => [reviewFindingKey(finding).key, finding]));
    for (const [currentFindingKey, currentFinding] of current) {
      let repeated = false;
      for (const [previousFindingKey, previousFinding] of previous) {
        const overlap = measureReviewFindingKeyOverlap(currentFinding, previousFinding);
        totalMustFixComparisons++;
        repeatedMustFixComparisons.push({
          previousRound: currentRound - 1,
          currentRound,
          previousFindingKey,
          currentFindingKey,
          comparable: overlap.comparable,
          sharedSymbolCount: overlap.sharedSymbolCount,
          overlapRatio: overlap.overlapRatio,
        });
        if (!overlap.comparable) {
          unmeasurableMustFixComparisons++;
          if (overlap.leftSymbolCount === 0 && overlap.rightSymbolCount === 0) {
            unmeasurableMustFixComparisonsWithoutCitations++;
          } else if (overlap.rightSymbolCount === 0) {
            unmeasurableMustFixComparisonsWithoutPreviousCitations++;
          } else {
            unmeasurableMustFixComparisonsWithoutCurrentCitations++;
          }
        }
        if (isSubstantiveReviewFindingRepeat(currentFinding, previousFinding, overlap)) repeated = true;
      }
      if (repeated) repeatedMustFixFindings++;
    }
  }
  const nonConvergenceScore = nonDecreasingFailTransitions + repeatedMustFixFindings;
  const normalizedThreshold = Math.max(0, threshold.nonConvergenceScore);
  const thresholdReached = nonConvergenceScore >= normalizedThreshold && normalizedThreshold > 0;
  return {
    nonConvergenceScore,
    threshold: { nonConvergenceScore: normalizedThreshold },
    thresholdReached,
    requiresFullReview: thresholdReached,
    repeatedMustFixFindings,
    nonDecreasingFailTransitions,
    repeatedMustFixComparisons,
    totalMustFixComparisons,
    unmeasurableMustFixComparisons,
    unmeasurableMustFixComparisonsWithoutCitations,
    unmeasurableMustFixComparisonsWithoutPreviousCitations,
    unmeasurableMustFixComparisonsWithoutCurrentCitations,
  };
}

/** A score can only request a full review. Stopping requires that external full review explicitly finds no path to convergence. */
export function resolveConvergenceDisposition(
  assessment: ConvergenceAssessment,
  fullReview: FullConvergenceReview | undefined,
): ConvergenceDisposition {
  const stop = assessment.requiresFullReview && fullReview === 'unconvergeable';
  return {
    stop,
    reason: stop ? 'non-convergence' : undefined,
    requiresFullReview: assessment.requiresFullReview,
  };
}

/** ⚠️ 비-export(리뷰 must-fix) — 외부 소비자가 없다(orchestrator·테스트 모두 함수만 쓴다).
 *  공개 표면은 `parseReworkBudgetDecision`/`applyReworkBudgetDecision` 둘이면 된다.
 *  선례: `agent-substrate/review-observation.ts` 의 `ReviewObservationInput`. */
type ReworkBudgetVerdict = 'EXTEND' | 'SUFFICIENT' | 'UNCONVERGEABLE' | 'CONTRACT-CONFLICT';

interface ReworkBudgetDecision {
  verdict: ReworkBudgetVerdict;
  reason: string;
}

/** 감독이 현장과 충돌한 계획을 다음 자식에게 명시적으로 재지시하는 최소 문맥. */
export interface ContractConflictRelaxation {
  target: string;
  expected: string;
  replacement: string;
}

export interface ReworkPlanRevision {
  reason: string;
  relaxation?: ContractConflictRelaxation;
  application?: { status: 'applied' | 'already-applied' | 'failed'; detail?: string };
  disposition?: ContractConflictDisposition;
  refutations?: readonly { findingId: string; finding: string; quote: string; reason: string }[];
}

/** 판정 헤더 2줄(BUDGET/REASON)을 걷어낸 순수 진단. 구현 에이전트에게는 "왜+어떻게"만 가야 한다 —
 *  예산 제어 문구가 섞이면 종전 진단 계약이 오염되고, 구현자가 제어 어휘를 흉내 낼 수 있다(리뷰 should-fix). */
export function stripReworkBudgetHeaders(response: string | undefined): string {
  const lines = (response ?? '').split(/\r?\n/);
  if (!/^BUDGET: (EXTEND|SUFFICIENT|UNCONVERGEABLE|CONTRACT-CONFLICT)$/.test(lines[0] ?? '')) return response ?? '';
  const rest = /^REASON: /.test(lines[1] ?? '') ? lines.slice(2) : lines.slice(1);
  return rest.join('\n').replace(/^\n+/, '');
}

/** diagnose 응답의 고정 첫 줄 계약을 결정론적으로 해석한다. 산문·손상된 응답은 판정 없음으로 fail-soft 한다. */
export function parseReworkBudgetDecision(response: string | undefined): ReworkBudgetDecision | undefined {
  const lines = (response ?? '').split(/\r?\n/);
  const verdict = /^BUDGET: (EXTEND|SUFFICIENT|UNCONVERGEABLE|CONTRACT-CONFLICT)$/.exec(lines[0] ?? '')?.[1] as ReworkBudgetVerdict | undefined;
  const reason = /^REASON: (.+)$/.exec(lines[1] ?? '')?.[1]?.trim();
  return verdict && reason ? { verdict, reason } : undefined;
}

/** Optional structured contract-conflict payload. Missing or partial fields deliberately remain legacy-compatible. */
export function parseContractConflictRelaxation(response: string | undefined): ContractConflictRelaxation | undefined {
  const fields = new Map<string, string[]>();
  for (const line of (response ?? '').split(/\r?\n/)) {
    const match = /^(TARGET|EXPECTED|REPLACEMENT):\s*(.+)$/.exec(line);
    if (match) {
      const key = match[1]!;
      fields.set(key, [...(fields.get(key) ?? []), match[2]!.trim()]);
    }
  }
  const target = fields.get('TARGET');
  const expected = fields.get('EXPECTED');
  const replacement = fields.get('REPLACEMENT');
  if (target?.length !== 1 || expected?.length !== 1 || replacement?.length !== 1) return undefined;
  return { target: target[0]!, expected: expected[0]!, replacement: replacement[0]! };
}

/** 최근 실패 지적만 판단자에게 전달한다. 항목별·전체 상한은 LLM 프롬프트 비대를 막는다.
 *
 *  ⭐ **앞부분을 보존한다**(리뷰 should-fix) — 종전엔 `note.slice(-N)` 으로 **꼬리만** 남겨
 *  `[리뷰 must-fix …]` 종류 표지와 **첫 지적들이 통째로 잘렸다**. 이 이력의 존재 이유가
 *  *"같은 지적이 반복되나"* 를 판단자가 보게 하는 것인데, 앞부분을 버리면 바로 그 비교가 불가능하다.
 *  절단은 판단자를 눈멀게 한다 — [[INCIDENT-review-diff-truncation-absence-verdict-2026-07-27]] 과
 *  동형이므로, 자를 때는 **잘렸다는 사실을 명시**한다(침묵 절단 금지).
 *
 *  ⭐ **상한은 항목 단위다.** 원문 앞부분만 자르면 뒤 항목이 통째로 사라지고, 판정기는 인용
 *  심볼 조각만 본다. 항목을 중간에서 잘라야 하면 그 항목 머리만 남기고 `…[절단]` 을 붙인다.
 *  항목 수는 줄이지 않는다. 전체 상한 때문에 본문을 줄였으면 몇 항목·몇 자를 뺐는지 한 줄로 적는다. */
/** ⚠️ 기본 보관 라운드가 5인 이유(리뷰 should-fix) — 호출부가 판단자에게 넘길 때 **현재 지적 1건을
 *  뺀다**(`slice(0, -1)` · 자기 자신과 비교 금지). 보관을 4로 두면 판단자는 3라운드만 보게 되어
 *  이 PR 이 늘리려던 문맥이 오히려 줄어든다. **+1 은 그 차감분**이고, 판단자가 실제로 보는 이전
 *  라운드 수는 종전 설계대로 최대 4다. */
const HISTORY_ROUNDS_KEPT = 5;
const ITEM_CUT_MARKER = '…[절단]';

/** 한 라운드 이력을 must-fix 항목(불릿) 단위로 상한에 맞춘다. 불릿이 없으면 통째가 한 항목이다. */
export function truncateReworkHistoryByItem(note: string, maxChars: number): string {
  const cap = Math.max(0, maxChars);
  if (note.length <= cap) return note;
  const lines = note.split('\n');
  const preamble: string[] = [];
  const items: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (current) items.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) items.push(current.join('\n'));
  if (items.length === 0) {
    const marker = `\n${ITEM_CUT_MARKER}`;
    const headBudget = Math.max(0, cap - marker.length);
    return `${note.slice(0, headBudget)}${marker}`.slice(0, cap);
  }
  const head = preamble.join('\n');
  const full = items.map((item) => item);
  const kept = full.map((item) => item);
  const render = (bodies: readonly string[]): string => {
    const removedChars = full.reduce((sum, item, index) => sum + Math.max(0, item.length - (bodies[index]?.length ?? 0)), 0);
    const cutItems = bodies.filter((item, index) => item !== full[index]).length;
    const footer = removedChars > 0 ? `…[${cutItems}항목·${removedChars}자 절단]` : '';
    const body = [head, ...bodies].filter((part, index) => index === 0 ? part.length > 0 : true).join('\n');
    return footer ? `${body}\n${footer}` : body;
  };
  if (render(kept).length <= cap) return render(kept);
  // 가장 긴 항목부터 머리를 남기고 자른다. 짧은 뒤 항목이 통째로 사라지지 않게 하고, 항목 수는 유지한다.
  const order = full
    .map((item, index) => ({ index, length: item.length }))
    .sort((left, right) => right.length - left.length || right.index - left.index);
  for (const { index } of order) {
    if (render(kept).length <= cap) break;
    const item = full[index]!;
    let low = 0;
    let high = item.length;
    let best = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      kept[index] = mid >= item.length ? item : `${item.slice(0, mid)}${ITEM_CUT_MARKER}`;
      if (render(kept).length <= cap) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    kept[index] = best < 0
      ? ITEM_CUT_MARKER
      : best >= item.length
        ? item
        : `${item.slice(0, best)}${ITEM_CUT_MARKER}`;
  }
  const text = render(kept);
  if (text.length <= cap) return text;
  // 상한이 항목 수·요약 줄보다 짧으면 항목 자리를 유지한 채 꼬리부터 비운다.
  return text.slice(0, cap);
}

export function appendReworkHistory(history: readonly string[], note: string, maxRounds = HISTORY_ROUNDS_KEPT, maxCharsPerRound = 1200): string[] {
  const entry = truncateReworkHistoryByItem(note, maxCharsPerRound);
  return [...history, entry].slice(-Math.max(0, maxRounds));
}

/** LLM 판정을 권한이 제한된 예산 레일로 변환한다. 종료는 넓고, 연장은 hardCap 아래에서만 누적된다.
 *
 *  ⭐ `priorRounds` = 판단자가 **현재 지적과 비교할 수 있었던 이전 라운드 수**(현재 라운드 제외).
 *  0 이면 **UNCONVERGEABLE 을 적용하지 않는다** — *"같은 지적이 반복된다"* 는 주장은 비교 대상이
 *  있을 때만 성립한다. 실전 오탐(2026-07-27 · run-9135a622): 이력에 현재 지적이 그대로 들어가
 *  판단자가 자기 자신과 비교하고 "재발"이라 판정 → **게이트를 통과하고 조치 가능한 must-fix 5건을
 *  가진 런이 1라운드 만에 죽었다.** 근본은 호출부에서 고쳤고(이전 라운드만 전달), 이 레일은
 *  같은 형태의 오탐이 다시 종료를 일으키지 못하게 하는 **구조 가드**다. */
/** 다음 라운드에 유지할 판단 기반 예산 carry를 결정한다. 그림자 종료 판정은 종료 권한뿐 아니라
 *  기존 연장을 지울 권한도 없으므로 이전 carry를 보존한다. */
export function resolveReworkBudgetCarry(
  decision: ReworkBudgetDecision | undefined,
  effectiveMax: number,
  previousCarry: number | undefined,
  shadowed: boolean,
): number | undefined {
  if (!decision || decision.verdict === 'CONTRACT-CONFLICT') return previousCarry;
  if (decision.verdict === 'EXTEND') return effectiveMax;
  return shadowed ? previousCarry : undefined;
}

export type ContractConflictDisposition = 'first-observed' | 'repeated';

/** 계약 충돌은 자동 집행하지 않는다. 반복 처분은 라운드 수나 reason 문면이 아니라 직전 판정이 실제 계약 충돌일 때만 남긴다. */
export function resolveContractConflictDisposition(previousVerdict?: ReworkBudgetVerdict): ContractConflictDisposition {
  return previousVerdict === 'CONTRACT-CONFLICT' ? 'repeated' : 'first-observed';
}

export function applyReworkBudgetDecision(
  effectiveMax: number,
  decision: ReworkBudgetDecision | undefined,
  hardCap = 6,
  kind: SupervisionReworkSource = 'review',
  priorRounds = Number.POSITIVE_INFINITY,
  shadowStop = false,
  previousVerdict?: ReworkBudgetVerdict,
): { effectiveMax: number; stop: boolean; exit: 'continue' | 'proceed' | 'blocked'; applied: boolean; shadowed?: boolean; wouldExit?: 'proceed' | 'blocked'; contractConflictDisposition?: ContractConflictDisposition } {
  const cap = Math.max(0, hardCap);
  const normalizedMax = Math.min(cap, Math.max(0, effectiveMax));
  if (!decision) return { effectiveMax: normalizedMax, stop: false, exit: 'continue', applied: false };
  if (decision.verdict === 'CONTRACT-CONFLICT') {
    return {
      effectiveMax: normalizedMax,
      stop: false,
      exit: 'continue',
      applied: false,
      contractConflictDisposition: resolveContractConflictDisposition(previousVerdict),
    };
  }
  // 비교 대상 없는 "반복" 주장은 근거가 없다 — 판정은 관측에 남지만 종료시키지 않는다.
  // 첫 review 재작업도 must-fix를 실제로 고칠 다음 시도를 보장한 뒤에만 종료할 수 있다.
  if (decision.verdict === 'UNCONVERGEABLE' && priorRounds < 1) {
    return { effectiveMax: normalizedMax, stop: false, exit: 'continue', applied: false, shadowed: false };
  }
  if (decision.verdict === 'EXTEND') {
    const extendedMax = Math.min(cap, normalizedMax + 1);
    return { effectiveMax: extendedMax, stop: false, exit: 'continue', applied: extendedMax > normalizedMax };
  }
  if (decision.verdict === 'SUFFICIENT') {
    if (kind !== 'review') return { effectiveMax: normalizedMax, stop: false, exit: 'continue', applied: false };
    return shadowStop
      ? { effectiveMax: normalizedMax, stop: false, exit: 'continue', applied: false, shadowed: true, wouldExit: 'proceed' }
      : { effectiveMax: normalizedMax, stop: true, exit: 'proceed', applied: true };
  }
  return shadowStop
    ? { effectiveMax: normalizedMax, stop: false, exit: 'continue', applied: false, shadowed: true, wouldExit: 'blocked' }
    : { effectiveMax: normalizedMax, stop: true, exit: 'blocked', applied: true };
}

export interface ReworkNotePart {
  readonly source: SupervisionReworkSource;
  readonly note: string;
}

const REWORK_SOURCE_HEADERS: Record<SupervisionReworkSource, string> = {
  gate: '[gate 실패]',
  review: '[리뷰 must-fix — 반드시 반영]',
  supervisor: '[감독 input 제안 — 다음 라운드에서 반드시 검토]',
};

/** Merges independently produced reasons without silently collapsing a new source into gate. */
export function mergeReworkNotes(parts: readonly ReworkNotePart[]): { note: string; sources: readonly SupervisionReworkSource[] } {
  const bySource: Record<SupervisionReworkSource, string[]> = {
    gate: [], review: [], supervisor: [],
  };
  for (const part of parts) {
    if (part.note.trim()) bySource[part.source].push(part.note);
  }
  const sources = SUPERVISION_REWORK_SOURCES.filter((source) => bySource[source].length > 0);
  return {
    sources,
    note: sources.map((source) => `${REWORK_SOURCE_HEADERS[source]}\n${bySource[source].join('\n')}`).join('\n\n'),
  };
}

/** Chooses the terminal budget/disposition source by explicit priority, never merge order. */
export function resolveReworkKind(sources: readonly SupervisionReworkSource[]): SupervisionReworkSource {
  const priority: Record<SupervisionReworkSource, number> = { gate: 0, supervisor: 1, review: 2 };
  let selected: SupervisionReworkSource = 'gate';
  for (const source of sources) {
    if (priority[source] > priority[selected]) selected = source;
  }
  return selected;
}

/** #2 모델 escalation 티어 — 자동 정책은 base(terra)에서 sol 한 단계만 선택한다.
 *  - 'sol'  = 상한 직전과 상한 라운드.
 *  - 'opus' = 기존 명시 호출자의 최상위 지원 경로.
 *  - 'none' = 그 앞 라운드 전부 base(terra). review 재작업도 항상 base다. */
export type EscalateTier = 'none' | 'sol' | 'opus';

export function resolveEscalateTier(
  round: number,
  effectiveMax: number,
  reworkKind?: SupervisionReworkSource,
): EscalateTier {
  if (reworkKind === 'review') return 'none';
  if (effectiveMax <= 0 || round < 0) return 'none';
  return round > 0 && round >= effectiveMax - 1 ? 'sol' : 'none';
}

/** #2 모델 escalation — 티어가 none 이 아니면(sol) 중간 모델로 재시도. buildReworkFeature 힌트·관측용. */
export function shouldEscalateModel(round: number, effectiveMax: number): boolean {
  return resolveEscalateTier(round, effectiveMax) !== 'none';
}

/** 단일 승급 타깃(model/provider/effort). terra→sol 해석은 기존대로 유지한다. */
export interface EscalateTarget { model: string; provider: string; effort: string; }

/** codex 사다리의 한 칸을 승급 타깃으로 — ⛔ 모델 이름을 박지 않는다.
 *  🩸 2026-09-23: GPT-6 이관 뒤에도 여기 `gpt-5.6-sol`·`gpt-5.6-terra` 가 박혀 있어서, 재작업 승급이
 *    «옛 세대»로 갔다(결정 지적 · GPT-6 에는 terra 가 없다). 사다리를 바꾸면 여기도 따라온다. */
function codexLadderTarget(tier: 'better' | 'best', fallbackEffort: string): EscalateTarget {
  const spec = lookupLlmTierSpec('openai-codex', tier);
  return { model: spec.model, provider: 'openai-codex', effort: spec.reasoningLevel ?? fallbackEffort };
}

const TIER_DEFAULTS: Record<Exclude<EscalateTier, 'none'>, EscalateTarget> = {
  get sol() { return codexLadderTarget('best', 'high'); },
  // ⛔ opus 도 같은 병이었다(`claude-opus-4-8` 박제 · 사다리는 이미 opus-5) — anthropic 사다리 loaded 칸에서.
  get opus() {
    const spec = lookupLlmTierSpec('anthropic', 'loaded');
    return { model: spec.model, provider: 'anthropic', effort: spec.reasoningLevel ?? 'high' };
  },
};

/** 티어 → 타깃 해석(순수) — 기본 맵 + SOL 환경 덮어쓰기.
 *  'none'/미지정=null(escalate 미주입=종전 base 모델). */
export function resolveEscalateTarget(
  tier: EscalateTier,
  env: Record<string, string | undefined> = process.env,
): EscalateTarget | null {
  if (tier === 'none') return null;
  const d = TIER_DEFAULTS[tier];
  const p = tier.toUpperCase();
  return {
    model: env[`ELANOUS_SELFDEV_${p}_MODEL`]?.trim() || d.model,
    provider: env[`ELANOUS_SELFDEV_${p}_PROVIDER`]?.trim() || d.provider,
    effort: env[`ELANOUS_SELFDEV_${p}_EFFORT`]?.trim() || d.effort,
  };
}

/** 승급 칸 순서(낮음 → 높음). */
const ESCALATION_TIER_ORDER = ['budget', 'balanced', 'better', 'best', 'loaded'] as const;
const EFFORT_RANK: Readonly<Record<string, number>> = { off: 0, none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
function effortRank(effort: string | undefined): number {
  return effort === undefined ? -1 : (EFFORT_RANK[effort] ?? -1);
}

/** 명시 자식이 들고 있는 선택(모델·provider·노력). */
export interface ExplicitChildForEscalation { readonly provider: string; readonly model: string; readonly effort?: string }

/** 결정 2026-09-23 — 「명시 자식은 «같은 provider» 안에서만 승격」.
 *  🩸 계기: kimi-k3 를 명시해 쏜 확인 시험이 재작업 2 에서 openai-codex `gpt-5.6-terra` 로 바뀌어
 *    (로그 13:08~) 모델 비교가 조용히 오염됐다 — 다른 provider 로 넘어가는 승급이었다.
 *  규칙: 자식 provider 의 사다리에서 자식 모델이 앉은 «가장 높은» 칸을 찾고, 그 위에서
 *    «다른 모델» 이거나 «더 높은 노력» 인 첫 칸으로 올린다. 없으면 승급하지 않는다(null).
 *  ⛔ `loaded` 칸이 «다른 모델»이면 건너뛴다 — codex 의 loaded(astra)는 결정 「명시 호출만」이다.
 *  ⛔ 사다리를 못 읽거나 자식 모델이 사다리에 없으면 그 provider 의 best 칸(다른 모델일 때만). */
function sameProviderStep(child: ExplicitChildForEscalation): EscalateTarget | null {
  const specs: Array<{ tier: typeof ESCALATION_TIER_ORDER[number]; model: string; effort?: string }> = [];
  for (const tier of ESCALATION_TIER_ORDER) {
    try {
      const spec = lookupLlmTierSpec(child.provider as Parameters<typeof lookupLlmTierSpec>[0], tier);
      specs.push({ tier, model: spec.model, ...(spec.reasoningLevel ? { effort: spec.reasoningLevel } : {}) });
    } catch { return null; }
  }
  const matching = specs.map((spec, index) => (spec.model === child.model ? index : -1)).filter((index) => index >= 0);
  if (matching.length === 0) {
    const best = specs.find((spec) => spec.tier === 'best');
    return best && best.model !== child.model ? { model: best.model, provider: child.provider, effort: best.effort ?? '' } : null;
  }
  const seat = matching[matching.length - 1]!;
  const currentEffort = child.effort ?? specs[seat]!.effort;
  for (let index = seat + 1; index < specs.length; index += 1) {
    const candidate = specs[index]!;
    if (candidate.tier === 'loaded' && candidate.model !== child.model) continue;
    if (candidate.model !== child.model || effortRank(candidate.effort) > effortRank(currentEffort)) {
      return { model: candidate.model, provider: child.provider, effort: candidate.effort ?? '' };
    }
  }
  return null;
}

/** 명시 자식의 승급 타깃 — 같은 provider 안에서만(위 규칙). `ELANOUS_SELFDEV_SOL_*` 는 운영자의 명시
 *  덮어쓰기라 그대로 우선한다. ⛔ `effort` 가 빈 문자열이면 «안 보낸다»는 뜻이다(OpenRouter 는 노력을
 *  보내면 덜 생각했다 — 2026-09-23 실측). */
export function resolveExplicitChildEscalateTarget(
  tier: EscalateTier,
  env: Record<string, string | undefined> = process.env,
  child?: ExplicitChildForEscalation,
): EscalateTarget | null {
  if (tier === 'none') return null;
  const overrideModel = env.ELANOUS_SELFDEV_SOL_MODEL?.trim();
  if (overrideModel) {
    return {
      model: overrideModel,
      provider: env.ELANOUS_SELFDEV_SOL_PROVIDER?.trim() || child?.provider || 'openai-codex',
      effort: env.ELANOUS_SELFDEV_SOL_EFFORT?.trim() || '',
    };
  }
  if (child === undefined) return null;
  const step = sameProviderStep(child);
  if (step === null) return null;
  const effortOverride = env.ELANOUS_SELFDEV_SOL_EFFORT?.trim();
  return effortOverride ? { ...step, effort: effortOverride } : step;
}

/** Rework 지시문 전체 예산. 현재 지적(진단 포함)의 종전 최대 4,000자와 직전 항목 절을 한 컨텍스트로 묶어,
 *  이전 이력이 현재 라운드 지적을 조용히 밀어내지 못하게 한다. */
const REWORK_CONTEXT_MAX_CHARS = 5000;
const PLAN_REVISION_REASON_MAX_CHARS = 1200;
const PLAN_REVISION_REFUTATIONS_MAX_ITEMS = 3;
const PLAN_REVISION_REFUTATION_MAX_CHARS = 900;
const PRIOR_ROUND_HEADER = '[직전 라운드에 지적받아 반영한 것]';

function truncateWithMarker(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function renderPlanRevisionSection(planRevision: ReworkPlanRevision): string {
  const reason = truncateWithMarker(planRevision.reason, PLAN_REVISION_REASON_MAX_CHARS, '…[감독 이유 절단]');
  const relaxation = planRevision.relaxation
    ? `\n[수용 기준 완화]\n- 대상: ${planRevision.relaxation.target}\n- 이전: ${planRevision.relaxation.expected}\n- 완화: ${planRevision.relaxation.replacement}\n- 적용: ${planRevision.application?.status ?? 'failed'}${planRevision.application?.detail ? ` (${planRevision.application.detail})` : ''}${planRevision.disposition ? `\n- 충돌 처분: ${planRevision.disposition}` : ''}`
    : '';
  const refutations = (planRevision.refutations ?? []).slice(0, PLAN_REVISION_REFUTATIONS_MAX_ITEMS);
  const omitted = (planRevision.refutations?.length ?? 0) - refutations.length;
  const refutationSection = refutations.length
    ? `\n[타당하다고 확인된 자식 반박]\n${refutations.map((refutation) => {
      const entry = `- [${refutation.findingId}] ${refutation.finding}\n  인용: ${refutation.quote}\n  반박 이유: ${refutation.reason}`;
      return truncateWithMarker(entry, PLAN_REVISION_REFUTATION_MAX_CHARS, '\n  …[반박 절단]');
    }).join('\n')}${omitted > 0 ? `\n…[타당한 자식 반박 ${omitted}개 생략됨]` : ''}`
    : '';
  const verifiedRelaxationApplied = planRevision.application?.status === 'applied' || planRevision.application?.status === 'already-applied';
  const acceptanceInstruction = verifiedRelaxationApplied
    ? '검증된 완화가 적용된 골 문서의 수용 기준을 이번 구현의 기준으로 사용하라.'
    : '원본 골 문서는 수정되지 않았다. 완화가 검증·적용될 때까지 원본 수용 기준을 추측해 바꾸지 말고 재계획 또는 명확화가 필요하다는 상태와 이유를 보고하라.';
  return `[감독 계획 수정 지시 — 현장이 기존 계획과 어긋남]\n감독 이유: ${reason}${relaxation}\n${acceptanceInstruction}${refutationSection}`;
}

function renderPriorRoundSection(items: readonly string[], availableChars: number): string {
  const entries = items.map((item) => `- ${item.trim()}`).filter((item) => item.length > 2);
  const prefix = `\n\n${PRIOR_ROUND_HEADER}\n`;
  const bodyBudget = availableChars - prefix.length;
  if (entries.length === 0 || bodyBudget <= 0) return '';

  const omission = (count: number) => `…[직전 항목 ${count}개 생략됨]`;
  let kept = 0;
  for (let candidate = entries.length; candidate >= 0; candidate--) {
    const body = [
      ...entries.slice(0, candidate),
      ...(candidate < entries.length ? [omission(entries.length - candidate)] : []),
    ].join('\n');
    if (body.length <= bodyBudget) {
      kept = candidate;
      break;
    }
  }
  const body = [
    ...entries.slice(0, kept),
    ...(kept < entries.length ? [omission(entries.length - kept)] : []),
  ].join('\n');
  return body ? `${prefix}${body}` : '';
}

/** #1+#4 rework feature 합성 — raw note(gate log/mustFix)에 (있으면)진단을 액션 지시로 앞세운다.
 *  진단이 있으면 "왜+어떻게"가 먼저(사람이 하던 진단 내부화), 없으면 raw note 폴백(무회귀). */
export function buildReworkFeature(
  feature: string,
  round: number,
  effectiveMax: number,
  note: string,
  diagnosis?: string,
  appliedLastRound?: readonly string[],
  refutableFindings?: readonly { id: string; item: string }[],
  planRevision?: ReworkPlanRevision,
  reworkKind?: SupervisionReworkSource,
  refutationGuidance?: string,
  triageJudgement?: string,
): string {
  const d = (diagnosis ?? '').trim();
  const planRevisionSection = planRevision ? renderPlanRevisionSection(planRevision) : '';
  const guidance = d
    ? `[진단 — 왜 실패했고 어떻게 고칠지(최우선)]\n${d.slice(0, 2000)}${planRevisionSection ? `\n\n${planRevisionSection}` : ''}\n\n[원 지적]\n${tailWithOmissionMarker(note, 2000)}`
    : `${planRevisionSection ? `${planRevisionSection}\n\n` : ''}${tailWithOmissionMarker(note, 3000)}`;
  const boundedGuidance = truncateWithMarker(guidance, REWORK_CONTEXT_MAX_CHARS, '\n…[재작업 문맥 절단]');
  const priorItems = round > 0 ? appliedLastRound?.filter((item) => item.trim().length > 0) ?? [] : [];
  const priorSection = renderPriorRoundSection(priorItems, Math.max(0, REWORK_CONTEXT_MAX_CHARS - boundedGuidance.length));
  const tier = resolveEscalateTier(round, effectiveMax, reworkKind);
  const normalizedTriageJudgement = triageJudgement?.trim();
  const escalateHint = tier === 'sol'
    ? ` (중간 승급 모델(sol)${normalizedTriageJudgement ? ` — 트리아지 판단: ${normalizedTriageJudgement.slice(0, 600)}` : ''})`
    : '';
  const evidenceReminder = requiredEvidenceFromGoal(feature).length > 0
    ? '\n\n이번 라운드에도 골이 이름으로 요구한 증거를 전체 다시 내야 한다. 고친 것만 적으면 요구 전체가 누락으로 판정된다.'
    : '';
  const refuteGrammar = round > 0 && refutableFindings?.length
    ? (() => {
      const exampleQuote = [...eligibleRefutationGoalLines(feature)]
        .find(([, kind]) => kind === 'preservation-contract')?.[0];
      const example = exampleQuote
        ? [
          '예시(위 첫 항목 ID와 이 골의 실제 인용 줄):',
          `REFUTE [${refutableFindings[0]!.id}] ${JSON.stringify(exampleQuote)} — 이 지적은 인용한 골 계약과 충돌한다.`,
        ]
        : ['예시를 만들 인용 가능 골 원문 줄이 없어 REFUTE 예시는 생략한다. 실제 회부 시에는 아래 문법대로 골의 적격 원문 줄 전체를 JSON 문자열로 인용하라.'];
      return [
        '',
        '',
        '[기각 가능한 원본 must-fix — ID는 라운드 간 불변]',
        ...refutableFindings.map((finding) => `- [${finding.id}] ${finding.item}`),
        ...example,
          `리뷰 must-fix가 골의 허용된 보존 계약과 충돌하거나 골이 요청한 기준 자체를 되돌려 골 자기모순을 만든다고 판단하면 반드시 \`REFUTE [MF-안정ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 근거 한 줄\`로 회부하라. 두 현재 must-fix가 동시에 만족될 수 없을 때는 ID를 사전순으로 놓고 \`REFUTE [MF-낮은ID] CONFLICT [MF-높은ID] "JSON 문자열로 인코딩한 골의 원문 줄" — 두 지적을 동시에 만족할 수 없다: 양립 불가 이유\`로 회부하라. 이 형식은 위 스냅샷의 서로 다른 두 ID와 실제 적격 골 인용을 모두 요구하며, 순차적으로 나타난 지적이나 단순히 무관한 두 지적에는 쓰지 않는다. ${refutationGuidance ?? `반론 검토 결과를 반드시 제출하라: 있으면 위 REFUTE 형식으로 회부하고, 없으면 정확히 \`${MUST_FIX_REFUTATION_ACKNOWLEDGEMENT}\` 한 줄을 남겨라. ${REFUTATION_QUOTE_GRAMMAR}`} JSON 디코딩한 인용이 원문과 다르거나 ID가 위 스냅샷에 없으면 무효다. REFUTE는 자동 수용되지 않으며 감독이 ACCEPT 또는 REJECT로 판정한다.`,
      ].join('\n');
    })()
    : '';
  return `${feature}\n\n[라운드 ${round}/${effectiveMax}${escalateHint} — 아래를 반드시 고쳐 통과시켜라. 참조한 심볼/필드는 정의·선언까지 완성(소비만 하고 미정의 금지)]${refuteGrammar}\n${boundedGuidance}${priorSection}${evidenceReminder}`;
}

/** 🩸 2026-09-26 run-7dd4cce6 — 실패 시험 0건인데 «같은 미검증 파일 집합»으로 gate 가 거듭 빨갛고,
 *  반복 감지는 리뷰 지적(심볼 인용)만 비교해서 `incomparable` 로 흘려 rework 를 헛돌았다.
 *  ⭐ 반복 열쇠 = 정렬한 미검증 집합. 직전 gate 실패 라운드와 같고 실패 시험이 0이면 «재작업이 그 신호를 못 바꾼다».
 *  첫 등장은 반복이 아니다(자식이 시험을 더해 풀 수도 있다) — `previousKey` 가 없으면 false. */
export function unverifiedRepeatKey(unverified: readonly string[] | undefined): string | undefined {
  if (!unverified || unverified.length === 0) return undefined;
  return [...new Set(unverified)].sort().join('\n');
}

export function isRepeatedUnverifiedOnlyGateFailure(input: {
  previousKey: string | undefined;
  unverified: readonly string[] | undefined;
  gateLog: string | undefined;
  introduced?: number;
}): boolean {
  const key = unverifiedRepeatKey(input.unverified);
  if (key === undefined || input.previousKey === undefined || key !== input.previousKey) return false;
  if ((input.introduced ?? 0) > 0) return false;
  return failIndicator('gate', input.gateLog, 0) === 0;
}

/** gate/review 실패 지표 추출(순수·적응형 입력) — gate log 의 "N fail" 합 또는 review mustFix 수. */
export function failIndicator(kind: SupervisionReworkSource, gateLog: string | undefined, mustFixCount: number): number {
  if (kind === 'review') return Math.max(0, mustFixCount);
  let total = 0;
  for (const m of (gateLog ?? '').matchAll(/(\d+)\s+fail\b/g)) total += Number.parseInt(m[1]!, 10);
  return total;
}

/** 대표 2026-09-25 (BACKLOG B9) — 재작업 승급은 «codex·anthropic 이 아닐 때만» 한다.
 *  🩸 종전: 명시 자식 LLM 이 없으면 부모 provider 와 무관하게 codex `gpt-6-sol` 로 승급했고, 그 env 가 provider 선택을 이겼다
 *    (09-25 벤치 anthropic 팔 40콜 중 22콜이 codex · 「codex 소진이면 grok」 결정도 무너진다).
 *  ⭐ codex(gpt-6-sol)·anthropic(Opus 5.5)은 이미 최상위급 — 승급 없이 같은 모델로 재작업한다.
 *  그 밖의 provider(grok·openrouter·local…)는 종전 승급을 그대로 쓴다. */
export const ESCALATION_SUPPRESSED_PROVIDERS: readonly string[] = ['openai-codex', 'anthropic'];
export function escalationAllowedForProvider(provider: string | undefined): boolean {
  const p = provider?.trim().replace(/^auto:/, '');
  return !p || !ESCALATION_SUPPRESSED_PROVIDERS.includes(p);
}
