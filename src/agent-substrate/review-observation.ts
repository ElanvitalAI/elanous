// ── 수동 PR 리뷰 관측 payload (순수 · 2026-07-27) ─────────────────────────────────────
//
// ⭐ 왜 이 모듈이 있나 — **수동 `elanous self review` 의 verdict 가 어디에도 보존되지 않았다.**
//
// 실측(2026-07-27 · [[MANUAL-review-operations-2026-07-27]] §7b 로 기록됐던 갭):
//   · `elanous logs --category self-review` → **0건**
//   · `pr-reviewer.ts` 에 `debug.log` 없음 · CLI 액션에도 없음
//   · `registerStandaloneLogSink('self-review')` 는 있었으나 **`--acp` 분기 안에만** 있어
//     기본 경로(API 리뷰어)에서는 sink 조차 등록되지 않았다
// ⇒ verdict·must-fix 원문이 **터미널 출력으로만** 존재해 사후 감사가 불가능했다. 라운드가 여러 번
//   도는 워크플로에서 "몇 라운드였고 무엇이 지적됐나"를 되짚을 방법이 커밋 메시지뿐이었다.
//
// ⚠️ 제1원칙 — *"조회에 안 뜨면 관측 db 문제가 아니라 **계측 누락**"*. 이 모듈이 그 계측이다.
//
// 순수 함수로 둔 이유: 절단 정책(무엇을 얼마나 남기나)이 **회귀 테스트 대상**이기 때문이다.
// 로그가 폭주하면 관측 자체가 못 쓰게 되고, 너무 줄이면 감사가 안 된다 — 그 균형을 테스트로 고정한다.

import { redactSecretText } from '../debug/log.js';
import { isScopeRevertMustFix, type ReviewResult } from './pr-reviewer.js';

/** 로그 1건에 실을 must-fix/should-fix 항목 수 상한(나머지는 개수로만).
 *  ⚠️ 비-export(리뷰 must-fix) — 테스트가 이 상수로 기대값을 계산하면 상한이 커져도 통과해
 *  **정책이 잠기지 않는다**. 테스트는 고정 경계값(8/160)을 직접 단정한다. */
const REVIEW_ITEM_LIMIT = 8;
/** 항목 1건의 문자 상한 — 지적의 **식별**이 목적이지 전문 보존이 아니다(전문은 PR 코멘트·커밋). */
const REVIEW_ITEM_CHARS = 160;

/** ⚠️ 비-export(리뷰 must-fix) — 외부 소비자가 없다. 공개 표면은 `buildReviewObservation` 하나면 된다. */
interface ReviewObservationInput {
  readonly pr: string;
  readonly model: string;
  /** 리뷰에 준 의도(수용기준). 원문은 길어 **길이만** 남긴다 — 무엇을 기준으로 판정했나의 지표. */
  readonly intent: string;
  /** Null when the CLI refused to run the engine because the fetched diff was knowingly stale. */
  readonly review: ReviewResult | null;
  readonly durationMs: number;
  readonly diffTruncated?: boolean;
  readonly diffShownChars?: number;
  readonly diffTotalChars?: number;
  readonly diffOmittedFiles?: number;
  readonly referencedFilesOpened?: boolean;
  readonly referencedFilesRead?: number;
  readonly intentTruncated?: boolean;
  readonly intentTotalChars?: number;
  readonly intentSection?: string;
  /** The PR head SHA the diff read was anchored to, or `unknown` when GitHub did not provide one. */
  readonly headCommit?: string;
  /** Distinguishes a missing head lookup from a rejected malformed identity. */
  readonly headCommitState?: 'known' | 'absent' | 'malformed';
  /** The head SHA observed after the diff read; permits an explicit stale verdict. */
  readonly currentHeadCommit?: string;
  /** Distinguishes a missing current-head lookup from a rejected malformed identity. */
  readonly currentHeadCommitState?: 'known' | 'absent' | 'malformed';
  /** ⛔ 어느 경로가 «실제로» 답했나 — `api` | `acp` | `acp-fallback`.
   *  이 칸이 없으면 `done` 로그를 보는 관측자는 폴백이 구한 것과 그냥 통과한 것을 구별하지 못한다.
   *  ⚠️ 그리고 그것이 이 칸이 생긴 이유다: 호출부가 스프레드로 실어 보내도
   *  «인터페이스에 칸이 없으면» 그 값은 조용히 사라진다(리뷰 should-fix 로 잡혔다). */
  readonly reviewRoute?: 'api' | 'acp' | 'acp-fallback';
  /** 폴백을 «시도했나». 시도했는데 그것도 실패한 경우와 시도조차 안 한 경우를 가른다. */
  readonly fallbackAttempted?: boolean;
  /** 폴백이 실제로 시도한 백엔드. */
  readonly fallbackBackend?: string;
  /** Explicitly requested primary model and the ACP backend that actually completed review. */
  readonly requestedModel?: string;
  readonly actualBackend?: string;
  /** 폴백을 시도하지 않은 이유. */
  readonly fallbackNotAttemptedReason?: 'explicit-acp' | 'primary-review-succeeded' | 'explicit-model';
  /** 1차가 왜 못 돌았나 — 폴백의 «사인». */
  readonly fallbackTriggerReason?: string;
  /** Each failed ACP fallback attempt, retained in order for diagnosis. */
  readonly fallbackFailures?: readonly { backend: string; reason: string }[];
  /** Automatic ACP candidates excluded because the registry already declares them unsupported. */
  readonly skippedAcpFallbackBackends?: readonly { backend: string; reason: string }[];
  /** True when the diff's anchored commit no longer matched the observed PR head. */
  readonly stale?: boolean;
  /** True when a detected head movement caused the single permitted diff re-fetch. */
  readonly refetched?: boolean;
}

interface ReviewObservation {
  /** 어느 경로가 «실제로» 답했나. ⛔ 이 셋이 «출력»에도 있어야 한다 — 입력 인터페이스만 넓히면
   *  빌더가 명시 객체를 만드는 한 값은 여전히 사라진다(같은 창이 그 함정을 두 번 봤다). */
  readonly reviewRoute?: 'api' | 'acp' | 'acp-fallback';
  readonly fallbackAttempted?: boolean;
  readonly fallbackBackend?: string;
  readonly requestedModel?: string;
  readonly actualBackend?: string;
  readonly fallbackNotAttemptedReason?: 'explicit-acp' | 'primary-review-succeeded' | 'explicit-model';
  readonly fallbackTriggerReason?: string;
  readonly fallbackFailures?: readonly { backend: string; reason: string }[];
  readonly skippedAcpFallbackBackends?: readonly { backend: string; reason: string }[];

  readonly pr: string;
  readonly model: string;
  readonly verdict: string;
  /** 실제 리뷰가 돌았나 — fail-soft pass 와 진짜 PASS 를 구분(감사 시 핵심). */
  readonly reviewed: boolean;
  /** `reviewed:false` 일 때 «왜» 못 했나. 미검토(리뷰어 미주입)는 이 칸이 «없다**. */
  readonly failureReason?: string;
  readonly mustFix: number;
  /** 목표 범위를 이유로 되돌리거나 분리하라는 MUST-FIX의 관측용 빈도. */
  readonly scopeRevertMustFix: number;
  readonly shouldFix: number;
  /** ⭐ 지적 **식별용** 앞부분. 이게 있어야 "같은 지적이 반복되나"를 로그만으로 볼 수 있다. */
  readonly mustFixItems: readonly string[];
  readonly shouldFixItems: readonly string[];
  /** 상한을 넘겨 생략된 항목 수(0 이 아니면 로그가 전부가 아님을 알린다). */
  readonly omitted: number;
  readonly intentChars: number;
  readonly durationMs: number;
  readonly diffTruncated?: boolean;
  readonly diffShownChars?: number;
  readonly diffTotalChars?: number;
  readonly diffOmittedFiles?: number;
  readonly referencedFilesOpened?: boolean;
  readonly referencedFilesRead?: number;
  readonly intentTruncated?: boolean;
  readonly intentTotalChars?: number;
  readonly intentSection?: string;
  readonly headCommit: string;
  readonly headCommitState: 'known' | 'absent' | 'malformed';
  readonly currentHeadCommit: string;
  readonly currentHeadCommitState: 'known' | 'absent' | 'malformed';
  readonly stale: boolean;
  readonly refetched: boolean;
}

/** 사용자 제어 스칼라(pr·model)의 길이 상한 — 전체 payload 비대 방지(리뷰 must-fix). */
const SCALAR_CHARS = 64;

/**
 * ⭐ **재발명 제거**(2026-07-27 · 대표 지시) — 마스킹은 **공용 `redactSecretText`**(`debug/log.ts`)에
 * 위임한다. 이 모듈이 자체 정규식을 들고 있으면 **정책이 두 벌**이 되어 갈라진다.
 *
 * 공용 구현의 패턴은 **gitleaks 기본 config(MIT)** 의 rule 정규식을 이식한 것이다 — 외부 조사 결과
 * npm 의 `fast-redact` 계열은 **객체 경로** redaction 이라 자유 텍스트에 안 맞고, 자유 텍스트 자산인
 * gitleaks 는 외부 Go 바이너리라 in-process 로 못 쓴다 ⇒ **런타임이 아니라 규칙을 재사용**했다.
 */

/**
 * ⭐ **모든 self-review 발화가 쓰는 안전 변환**(리뷰 must-fix 2026-07-27 2R) — 마스킹 **후** 절단.
 * 종전엔 `done` 만 이 정책을 탔고 `start`(pr·model·backend)·`diff-fail`(pr·stderr)은 **원문 그대로**
 * 영속 로그에 들어갔다. 특히 `diff-fail` 은 stderr 를 **먼저 절단**해 "마스킹 후 절단" 규칙을 어겼다
 * (잘린 조각에 비밀이 남을 수 있다). 한 함수로 모아 우회 자체를 없앤다.
 */
export function safeLogText(s: string, max = SCALAR_CHARS): string {
  return redactSecretText(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

function clip(items: readonly string[]): string[] {
  return items.slice(0, REVIEW_ITEM_LIMIT)
    .map((s) => redactSecretText(s.replace(/\s+/g, ' ').trim()).slice(0, REVIEW_ITEM_CHARS));
}

/**
 * ⭐ 리뷰 1건 → 관측 payload(순수). `debug.log('self-review', 'done', payload)` 로 나간다.
 *
 * 절단 정책: 항목은 각각 최대 `REVIEW_ITEM_LIMIT` 건 · 건당 `REVIEW_ITEM_CHARS` 자.
 * 생략분은 `omitted` 로 **개수를 남긴다** — "로그에 8건뿐"을 "8건이 전부"로 오독하지 않게(정직 표기).
 * intent 는 **길이만** 남긴다(원문은 호출자 셸 히스토리·PR 본문에 있고, 로그 비대를 막는다).
 */
export function buildReviewObservation(input: ReviewObservationInput): ReviewObservation {
  const { review } = input;
  const mustFix = review?.mustFix ?? [];
  const shouldFix = review?.shouldFix ?? [];
  const shown = Math.min(mustFix.length, REVIEW_ITEM_LIMIT) + Math.min(shouldFix.length, REVIEW_ITEM_LIMIT);
  return {
    // ⚠️ 사용자 제어 문자열도 상한을 건다(리뷰 must-fix) — payload 비대 방지의 완결.
    pr: safeLogText(input.pr),
    model: safeLogText(input.model),
    // ⭐ 폴백 provenance — 「그냥 통과」와 「폴백이 구했다」를 `done` 로그만 보고 가를 수 있게.
    //   ⛔ 칸이 없으면 호출부가 스프레드로 실어 보내도 조용히 사라진다.
    ...(input.reviewRoute ? { reviewRoute: input.reviewRoute } : {}),
    ...(input.fallbackAttempted !== undefined ? { fallbackAttempted: input.fallbackAttempted } : {}),
    ...(input.fallbackBackend ? { fallbackBackend: safeLogText(input.fallbackBackend) } : {}),
    ...(input.requestedModel ? { requestedModel: safeLogText(input.requestedModel) } : {}),
    ...(input.actualBackend ? { actualBackend: safeLogText(input.actualBackend) } : {}),
    ...(input.fallbackNotAttemptedReason ? { fallbackNotAttemptedReason: input.fallbackNotAttemptedReason } : {}),
    ...(input.fallbackTriggerReason ? { fallbackTriggerReason: safeLogText(input.fallbackTriggerReason) } : {}),
    ...(input.fallbackFailures?.length ? {
      fallbackFailures: input.fallbackFailures.map(({ backend, reason }) => ({
        backend: safeLogText(backend), reason: safeLogText(reason, 400),
      })),
    } : {}),
    ...(input.skippedAcpFallbackBackends?.length ? {
      skippedAcpFallbackBackends: input.skippedAcpFallbackBackends.map(({ backend, reason }) => ({
        backend: safeLogText(backend), reason: safeLogText(reason, 400),
      })),
    } : {}),
    verdict: review?.verdict ?? 'refused-stale',
    // ⚠️ `reviewed` 는 옵셔널이라 미지정을 **false 로 낮추지 않는다** — 미지정 = 구버전 경로이고
    //    "리뷰가 안 돌았다"는 뜻이 아니다. null 은 stale diff 거부라 명시적으로 false 다.
    reviewed: review !== null && review.reviewed !== false,
    // ⭐ 실패 «이유»를 영속 관측에 싣는다 — 종전엔 `--json` 을 안 쓰면 원인을 못 봤다
    //   (`#7495` 리뷰 should-fix). `reviewed:false` 만 남으면 「왜」를 찾을 자리가 없다.
    //   ⚠️ 미주입(미검토)은 `failureReason` 이 «없어» 이 칸이 안 생긴다 — 실패와 미검토를 구분한다.
    ...(review?.failureReason ? { failureReason: safeLogText(review.failureReason) } : {}),
    mustFix: mustFix.length,
    scopeRevertMustFix: mustFix.filter(isScopeRevertMustFix).length,
    shouldFix: shouldFix.length,
    mustFixItems: clip(mustFix),
    shouldFixItems: clip(shouldFix),
    omitted: mustFix.length + shouldFix.length - shown,
    intentChars: input.intent.length,
    durationMs: input.durationMs,
    ...(input.diffTruncated !== undefined ? { diffTruncated: input.diffTruncated } : {}),
    ...(input.diffShownChars !== undefined ? { diffShownChars: input.diffShownChars } : {}),
    ...(input.diffTotalChars !== undefined ? { diffTotalChars: input.diffTotalChars } : {}),
    ...(input.diffOmittedFiles !== undefined ? { diffOmittedFiles: input.diffOmittedFiles } : {}),
    ...(input.referencedFilesOpened !== undefined ? { referencedFilesOpened: input.referencedFilesOpened } : {}),
    ...(input.referencedFilesRead !== undefined ? { referencedFilesRead: input.referencedFilesRead } : {}),
    ...(input.intentTruncated !== undefined ? { intentTruncated: input.intentTruncated } : {}),
    ...(input.intentTotalChars !== undefined ? { intentTotalChars: input.intentTotalChars } : {}),
    ...(input.intentSection !== undefined ? { intentSection: input.intentSection } : {}),
    headCommit: safeLogText(input.headCommit ?? 'unknown'),
    headCommitState: input.headCommitState ?? 'absent',
    currentHeadCommit: safeLogText(input.currentHeadCommit ?? 'unknown'),
    currentHeadCommitState: input.currentHeadCommitState ?? 'absent',
    stale: input.stale === true,
    refetched: input.refetched === true,
  };
}
