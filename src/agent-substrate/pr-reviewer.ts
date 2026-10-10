// ── PR 리뷰어 substrate (C 작전 다음 컷 · PLAN-reviewer-substrate-unification 2026-07-20) ──
//
// DESIGN-cross-surface-autonomy-membrane §14 의 C1~C6(state-channels·progress-ledger·working-memory·
// frames·cold-ledger)에 이은 다음 승격 축 = **PR 리뷰어**. 미션 PR 리뷰(R0~R3·mission-critique)와
// 하니스 Reviewer(H0/H1)가 같은 "리뷰"를 각자 구현(shape drift)하던 것을 이 substrate 로 단일화한다.
//
// ★ 미션-중립 — PR diff → verdict 는 순수하며 미션 결합이 없다(PhaseResult 브릿지 reviewToPhaseFields 만
//   mission-critique 잔류). LLM 리뷰어는 llmReview 주입 seam(streamLLM-sol 등)이라 substrate 는 LLM 무결합.
// ★ 소비자 — 미션(mission-critique re-export)·하니스(review-adapter)·CLI(elanous self review)·self-implementation.
// 전부 순수(+ 주입 seam). I/O 없음(gh pr diff·streamLLM 은 호출측).

import type { ReferencedFileReader } from '../self-implement/goal-file-reader.js';
import { capIntent, reviewIntentTruncationObservation } from './review-intent.js';
import { debug } from '../debug/log.js';
import { safeLogText } from './review-observation.js';

/** 리뷰 판정 어휘(canonical) — 미션·하니스·CLI 단일 출처. pass/warn/fail. */
export type ReviewVerdict = 'pass' | 'warn' | 'fail';

/** verdict 심각도 비교 — 더 나쁜 쪽(fail > warn > pass). 순수. */
export function worseReviewVerdict(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
  const rank = { pass: 0, warn: 1, fail: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** 리뷰 결과 — critic 계약(Verdict/Must-fix/Should-fix)을 결정론 파싱한 형태. mustFix=블로커(재작업
 *  유발)·shouldFix=비블로커. reviewed=실제 리뷰 완료(fail-soft pass 와 구분·verdict-gated 자동머지). */
/**
 * MUST-FIX가 목표 범위를 이유로 변경을 되돌리거나 별도 변경으로 분리하라고 요구하는지 판별한다.
 * 관측용 문자열 신호 분류일 뿐 verdict나 MUST-FIX 내용을 바꾸지 않는다.
 */
export function isScopeRevertMustFix(mustFix: string): boolean {
  const text = mustFix.toLowerCase();
  const scopeSignal = /무관|범위\s*밖|목표\s*밖|unrelated|out\s+of\s+scope|outside\s+(?:the\s+)?scope/.test(text);
  const revertSignal = /되돌리|분리하|별도\s*(?:pr|변경)|revert|split\s+(?:into|to)|separate\s+(?:pr|change)/.test(text);
  return scopeSignal && revertSignal;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  mustFix: string[];
  shouldFix: string[];
  /** 리뷰어가 판정에 앞서 더 보아야 한다고 관측한 저장소 맥락. 소비·판정에는 아직 쓰지 않는다. */
  requirements?: string[];
  /** 실제 리뷰가 돌았나(LLM 응답 파싱 성공). 미주입/예외로 verdict='pass' 된 경우와 진짜 PASS 구분. */
  reviewed?: boolean;
  /** 이 리뷰가 실제로 본 diff 양 — 프롬프트를 만든 그 계산에서 나온다(재계산 아님). */
  diffBudget?: Pick<DiffBudgetResult, 'truncated' | 'shownChars' | 'totalChars' | 'omittedFiles'>;
  /** 이 리뷰가 실제로 본 reviewer-provided context 양 — 프롬프트를 만든 그 계산에서 나온다(재계산 아님). */
  contextBudget?: Pick<ReviewerContextBudget, 'itemCount' | 'shownChars' | 'totalChars' | 'truncated' | 'fullyIncludedItems' | 'truncatedItems' | 'omittedItems'>;
  /** 절단된 diff를 보완하려 저장소 파일을 하나 이상 안전하게 열었는가. */
  referencedFilesOpened?: boolean;
  /** 절단된 diff를 보완하려 안전하게 연 저장소 파일 수. */
  referencedFilesRead?: number;
  /**
   * ⭐ `reviewed:false` 일 때 «왜» 못 했나. ⛔ 종전엔 맨 `catch { }` 라 이 값이 «없었고**,
   * 사용자는 `reviewed=false` 만 보고 원인을 찾을 자리가 없었다(2026-08-07 실측:
   * 레지스트리는 `Unknown ACP backend "…". Known: …` 를 정확히 던지는데 여기서 사라졌다).
   * ⚠️ 미주입(`llmReview` 없음)은 «실패가 아니라 미검토»라 이 칸을 안 채운다 — 둘을 구분한다.
   */
  failureReason?: string;
  /** Subscription reviewer unavailable: the default reviewer produced this verdict. */
  reviewerFallback?: string;
}

/** 모든 리뷰 관측 생산자가 공유하는 diff 예산 필드 계약. 예산 부재는 빈 객체로 보존한다.
 *  ⚠️ 내부 타입 — 소비자는 `...reviewDiffBudgetObservation(r)` 로 스프레드만 하므로 이름을 참조하지
 *  않는다(dead export 금지·review · `pty-control-ipc.ts:7` 선례). 실 소비자가 생기면 그때 export 한다. */
interface ReviewDiffBudgetObservation {
  diffTruncated?: boolean;
  diffShownChars?: number;
  diffTotalChars?: number;
  diffOmittedFiles?: number;
}

/** 리뷰 엔진이 산출한 예산을 관측 필드로 옮긴다. 재계산하지 않으며, 없음은 비절단으로 꾸미지 않는다. */
export function reviewDiffBudgetObservation(
  review: Pick<ReviewResult, 'diffBudget'>,
): ReviewDiffBudgetObservation {
  const budget = review.diffBudget;
  return budget ? {
    diffTruncated: budget.truncated,
    diffShownChars: budget.shownChars,
    diffTotalChars: budget.totalChars,
    diffOmittedFiles: budget.omittedFiles,
  } : {};
}

/** 리뷰 입력 — 실제 PR diff + 페이즈/PR 의도 + (선택) 수용기준·워킹메모리 선행결정. */
/** 리뷰어에게 이미지로 실려 가는 참조 — 텍스트 예산에 «안» 들어간다(`P4b`). */
export interface ReviewImage {
  label: string;
  mimeType: string;
  /** base64 — ACP `ContentBlock` 의 이미지 표현과 같은 모양. */
  data: string;
}

/** 한 리뷰가 실어 보낼 수 있는 이미지 «개수»와 «총량». ⛔ 없으면 `--context` 를 반복해
 *  전송량을 무제한 늘릴 수 있다(`#7486` 재리뷰 must-fix). 파일 «하나»의 상한(10MB)만으로는 못 막는다. */
const MAX_REVIEW_IMAGES = 4;
const MAX_REVIEW_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

/**
 * 개수·총량 안에 드는 앞쪽만 남기고, ***잘라 낸 수를 «같이 돌려준다»***.
 *
 * ⛔ 종전엔 이 주석이 *"잘라 낸 사실은 관측으로 남긴다"* 라 «말만» 하고 구현이 없었다
 * (`#7486` 재리뷰 must-fix — 오늘 이 창이 반복해 만난 그 형태를 «내가» 또 만들었다).
 * 조용히 줄이면 「이미지를 보냈는데 왜 못 봤나」가 영영 안 풀린다.
 */
export function capReviewImages(images: readonly ReviewImage[]): { kept: ReviewImage[]; dropped: number } {
  const kept: ReviewImage[] = [];
  let total = 0;
  for (const image of images) {
    if (kept.length >= MAX_REVIEW_IMAGES) break;
    const bytes = Math.floor(image.data.length * 3 / 4);
    if (total + bytes > MAX_REVIEW_IMAGE_TOTAL_BYTES) break;
    total += bytes;
    kept.push(image);
  }
  return { kept, dropped: images.length - kept.length };
}

export interface ReviewerContextItem {
  label: string;
  body: string;
  /**
   * ⭐ 이 항목이 이미지면 여기 실린다. `body` 는 그때 «짧은 표지»만 담는다 —
   * ⛔ base64 를 `body` 에 넣으면 텍스트 예산(12,000자)을 통째로 먹고, 그러고도
   * 모델은 그것을 «이미지로 못 본다**. 실제 픽셀은 `ContentBlock` 으로 따로 간다.
   */
  image?: { mimeType: string; data: string };
}

/** Human-supplied material to assess alongside, but never merged into, review intent or evidence. */
/** Reviewer-context 관측은 원장에 shown/total·절단·항목 구성을 함께 남겨, 절단 없음(false)과 미제공(undefined)을 구분한다. */
export interface ReviewerContextBudget {
  text: string;
  itemCount: number;
  shownChars: number;
  totalChars: number;
  truncated: boolean;
  fullyIncludedItems: number;
  truncatedItems: number;
  omittedItems: number;
}

export interface ReviewInput {
  prDiff: string;
  phaseIntent: string;
  acceptance?: string;
  workingMemory?: string;
  /** Separate human-provided review context; preserve caller order and do not append to phaseIntent. */
  reviewerContext?: ReviewerContextItem[];
  /** Optional observation join keys for the reviewer-context budget; runId alone is shared by child spaces. */
  reviewContext?: { runId?: string; round?: number };
  /** ⭐ diff 가 **무엇인지** 리뷰어에게 알린다(S2·2026-07-30). 규칙 (7) SCOPE CREEP 은
   *  *"의도를 넘어선 변경"* 을 보는데, 증거에 **이미 base 에 머지된 남의 작업**이 섞여 있으면
   *  그 판정이 통째로 틀린다(#5914 실사례: 표시 49 files vs 저작 6 files).
   *  ⛔ `phaseIntent` 에 섞지 마라 — 의도 채널과 증거 채널은 다른 것이다. */
  evidenceNote?: string;
  /** Repository-bounded reader injected by the caller. It rejects lexical and symlink escapes. */
  readReferencedFile?: ReferencedFileReader;
}

/**
 * 리뷰 프롬프트 diff 예산(기본 64000·ELANOUS_PR_REVIEW_DIFF_CHARS override·최소 2000).
 * 모델 한계가 아닌 리뷰 예산이다. 기본 리뷰 모델 gpt-5.6-sol의 1,000,000 토큰 contextWindow를 기준으로
 * 64,000자(약 16K 토큰)는 분할 리뷰 도입을 전제로 한 조각별 고정 예산이다.
 */
export function reviewDiffCharLimit(): number {
  const n = Number(process.env.ELANOUS_PR_REVIEW_DIFF_CHARS);
  return Number.isFinite(n) && n >= 2000 ? n : 64_000;
}

/** ★ diff 를 파일 단위(`diff --git` 경계)로 분할. 각 청크=그 파일 전체 diff(헤더 포함). 첫 파일 전
 *  프리앰블(있으면)은 자체 청크. 순수. `git diff`/`gh pr diff` 표준 형식 가정(없으면 통째 1청크). */
export function splitDiffByFile(prDiff: string): string[] {
  return prDiff.split(/(?=^diff --git )/m).filter((p) => p.length > 0);
}

/** 실제 변경 파일 수(diff --git 헤더 청크만·프리앰블 제외). 순수. */
function countDiffFiles(chunks: readonly string[]): number {
  return chunks.filter((c) => /^diff --git /.test(c)).length;
}

const OMIT_MARKER_RESERVE = 44; // "\n... [N chars omitted mid-file] ...\n" 여유

/** ★ 한 파일 diff 를 예산 내로 — 초과 시 head + tail(중간 생략). ★출력 길이 ≤ budget 보장(marker 예약).
 *  후반 hunk 도 tail 로 보여 correctness/미배선 검증 가능(head-only 절단의 맹점 해소). 순수. */
export function budgetFileDiff(fileDiff: string, budget: number): string {
  if (fileDiff.length <= budget) return fileDiff;
  const half = Math.floor((budget - OMIT_MARKER_RESERVE) / 2);
  if (half < 20) return fileDiff.slice(0, Math.max(0, budget - 12)) + '\n...[cut]'; // 과소예산 — head 만.
  let head = fileDiff.slice(0, half);
  const hnl = head.lastIndexOf('\n');
  if (hnl > half * 0.5) head = head.slice(0, hnl);           // head 는 줄 끝까지
  let tail = fileDiff.slice(-half);
  const tnl = tail.indexOf('\n');
  if (tnl >= 0 && tnl < half * 0.5) tail = tail.slice(tnl + 1); // tail 은 줄 처음부터
  const omitted = fileDiff.length - head.length - tail.length;
  return `${head}\n... [${omitted} chars omitted mid-file] ...\n${tail}`;
}

/**
 * ★ 분할 리뷰 «패스 상한». 기본 6 · `ELANOUS_PR_REVIEW_MAX_PASSES` override · 최소 1.
 *
 * ⛔ 왜 상한이 있나 — 한 패스 = LLM 호출 «한 번»이다. 상한이 없으면 초대형 PR 하나가
 *   리뷰 비용을 무제한으로 끌어올린다. ⛔ 그러나 상한에 걸리면 «조용히 덜 보지» 않는다 —
 *   `ReviewChunkPlan.droppedByCap` 으로 «값»이 되고, `coversAll=false` 가 되어
 *   병합 게이트(`review-diff-truncated`)가 여전히 «옳게» 막는다.
 * ⚠️ 이웃 `reviewDiffCharLimit()` 과 같은 관용구(env)로 둔다 — 이 모듈은 user-config 에
 *   결합하지 않는 substrate 다(파일 머리말의 「LLM 무결합」과 같은 이유).
 */
export function reviewMaxPasses(): number {
  const n = Number(process.env.ELANOUS_PR_REVIEW_MAX_PASSES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
}

/** 분할 리뷰 계획 — 「몇 번에 나눠 보나」와 「그래도 못 본 것이 있나」를 «둘 다» 값으로 낸다. */
export interface ReviewChunkPlan {
  /** 각 패스에 실릴 diff 텍스트. 각각 길이 ≤ limit. */
  passes: string[];
  /** ⭐ 모든 변경 파일의 diff 를 «온전히» 실었나. 이것이 `diffTruncated` 의 반대말이다. */
  coversAll: boolean;
  totalChars: number;
  /** 실제로 리뷰어에게 실린 총 문자 수(패스 합). */
  coveredChars: number;
  files: number;
  /** 어느 패스에도 «전혀» 안 실린 파일 수. */
  omittedFiles: number;
  /** 한 파일이 예산보다 커서 그 파일만 head/tail 절단된 수. */
  oversizedFiles: number;
  /** ⛔ 패스 상한 때문에 «버린» 패스 수. 침묵 금지 — 0 이 아니면 coversAll=false 다. */
  droppedByCap: number;
}

/**
 * ★ diff 를 «파일 경계»로 갈라 각 패스가 예산 안에 들어가도록 묶는다. 순수.
 *
 * ⭐ `budgetedDiff` 와 «다른 물음»에 답한다:
 *    `budgetedDiff`   — "한 번에 보낼 건데 뭘 «버릴까»"   ⇒ 반드시 절단이 생긴다
 *    `planReviewChunks` — "몇 번에 나눠 보내면 «다 볼까»" ⇒ 대개 절단이 «안» 생긴다
 * ⛔ 그래서 이 함수는 상한을 «회피»하지 않는다 — 조각마다 상한을 «지킨다».
 */
export function planReviewChunks(
  prDiff: string,
  limit = reviewDiffCharLimit(),
  maxPasses = reviewMaxPasses(),
): ReviewChunkPlan {
  const chunks = splitDiffByFile(prDiff);
  const fileCount = countDiffFiles(chunks);
  const base = {
    totalChars: prDiff.length,
    files: fileCount,
  };
  if (prDiff.length === 0) {
    return { ...base, passes: [], coversAll: true, coveredChars: 0, omittedFiles: 0, oversizedFiles: 0, droppedByCap: 0 };
  }
  // 파일 하나가 예산보다 크면 그 파일만 head/tail 절단한다 — 그래도 「전부 봤다」는 아니다.
  let oversizedFiles = 0;
  const sized = chunks.map((chunk) => {
    if (chunk.length <= limit) return chunk;
    if (/^diff --git /.test(chunk)) oversizedFiles += 1;
    return budgetFileDiff(chunk, limit);
  });
  // 그리디 패킹 — 순서를 보존한다(리뷰어가 파일 순서로 맥락을 잡는다).
  const passes: string[] = [];
  let current = '';
  for (const chunk of sized) {
    if (current.length > 0 && current.length + chunk.length > limit) {
      passes.push(current);
      current = '';
    }
    current += chunk;
  }
  if (current.length > 0) passes.push(current);

  const droppedPasses = Math.max(0, passes.length - maxPasses);
  const kept = droppedPasses > 0 ? passes.slice(0, maxPasses) : passes;
  const coveredChars = kept.reduce((sum, pass) => sum + pass.length, 0);
  const shownFiles = countDiffFiles(splitDiffByFile(kept.join('')));
  return {
    ...base,
    passes: kept,
    coversAll: droppedPasses === 0 && oversizedFiles === 0 && shownFiles === fileCount,
    coveredChars,
    omittedFiles: fileCount - shownFiles,
    oversizedFiles,
    droppedByCap: droppedPasses,
  };
}

/**
 * ★ 여러 패스의 리뷰 결과를 «하나»로 접는다. 순수.
 *
 * ⛔⭐ 접는 규칙에 이유가 있다:
 *   verdict  — ***하나라도 fail 이면 fail***. 다수결이 «아니다»: 한 조각에서 찾은 진짜 결함은
 *              다른 조각이 깨끗하다고 사라지지 않는다. warn 도 같은 논리로 전파한다.
 *   reviewed — ***모든 패스가 돌았을 때만 true***. 한 패스라도 못 돌았으면 그 조각을 «안 본» 것이고,
 *              「리뷰했다」고 말하면 병합 게이트가 거짓 위에서 판단한다.
 *   지적     — 순서 보존 ⊕ 정확 중복 제거. 상한 6 은 `parseReviewResult` 와 같은 값으로 맞춘다.
 */
export function foldReviewResults(
  results: readonly ReviewResult[],
): Pick<ReviewResult, 'verdict' | 'mustFix' | 'shouldFix' | 'requirements' | 'reviewed' | 'failureReason' | 'reviewerFallback'> {
  const dedupe = (values: readonly string[]): string[] => [...new Set(values)];
  const collect = (pick: (r: ReviewResult) => readonly string[] | undefined): string[] =>
    dedupe(results.flatMap((r) => [...(pick(r) ?? [])]));
  const verdict: ReviewVerdict = results.some((r) => r.verdict === 'fail') ? 'fail'
    : results.some((r) => r.verdict === 'warn') ? 'warn'
      : 'pass';
  const mustFix = collect((r) => r.mustFix).slice(0, 6);
  const shouldFix = collect((r) => r.shouldFix).slice(0, 6);
  const requirements = collect((r) => r.requirements);
  const failed = results.find((r) => r.reviewed !== true);
  const reviewerFallback = results.find((r) => r.reviewerFallback)?.reviewerFallback;
  return {
    verdict,
    mustFix,
    shouldFix,
    ...(requirements.length ? { requirements } : {}),
    reviewed: results.length > 0 && failed === undefined,
    ...(failed?.failureReason ? { failureReason: failed.failureReason } : {}),
    ...(reviewerFallback ? { reviewerFallback } : {}),
  };
}

/** Shared diff-budget accounting. `shownChars` is exactly the text passed to the reviewer. */
export interface DiffBudgetResult {
  text: string;
  truncated: boolean;
  files: number;
  shownChars: number;
  totalChars: number;
  omittedFiles: number;
}

/** ★ 파일별 예산 head/tail 절단 — 초대형 PR 도 변경 파일들의 앞/뒤가 보이게. ★출력 길이 ≤ limit 하드 보장.
 *  파일이 너무 많아 파일당 최소예산도 못 주면 앞쪽 N개만 보이고 나머지 수를 고지. 순수. files=실제 변경 파일 수. */
export function budgetedDiff(prDiff: string, limit = reviewDiffCharLimit()): DiffBudgetResult {
  const chunks = splitDiffByFile(prDiff);
  const fileCount = countDiffFiles(chunks);
  // ⭐ omittedFiles 는 **최종 렌더 결과** 기준이다 — 선택 여부가 아니라 실제로 출력에 남은 파일을 센다.
  //   limit<=0(또는 하드 캡)로 최종 텍스트가 비면 그 파일은 헤더도 안 남아 완전 누락으로 집계된다.
  //   이게 없으면 text='' 인데 omittedFiles=0 이 되어 프롬프트가 "EVERY changed file"이라 거짓말한다.
  const countOmitted = (text: string): number => fileCount - countDiffFiles(splitDiffByFile(text));
  const result = (text: string): DiffBudgetResult => ({
    text,
    truncated: text.length < prDiff.length,
    files: fileCount,
    shownChars: text.length,
    totalChars: prDiff.length,
    omittedFiles: countOmitted(text),
  });
  if (prDiff.length <= limit) return result(prDiff);
  if (chunks.length <= 1) return result(budgetFileDiff(prDiff, limit).slice(0, Math.max(0, limit)));
  const MIN_PER_FILE = 300;
  let shown = chunks;
  if (chunks.length * MIN_PER_FILE > limit) {
    const maxFiles = Math.max(1, Math.floor(limit / MIN_PER_FILE));
    shown = chunks.slice(0, maxFiles);
  }
  const droppedByCount = fileCount - countDiffFiles(shown);
  const noteReserve = droppedByCount > 0 ? 90 : 0;
  const perFile = Math.max(120, Math.floor((limit - noteReserve - shown.length) / shown.length));
  const parts = shown.map((f) => budgetFileDiff(f, perFile));
  if (droppedByCount > 0) parts.push(`... [${droppedByCount} more changed file(s) omitted — diff too large for review budget] ...`);
  // ★ 하드 캡(안전망) — 예산 배분이 근사라 최종 길이를 limit 로 명시 절단(예산 절대 보장).
  return result(parts.join('\n').slice(0, Math.max(0, limit)));
}

/** 절단 고지용 실제 시청률. 절단 분기에서는 반올림으로 100%가 되는 거짓 표시를 금지한다. */
export function diffShownPercent(shownChars: number, totalChars: number): number {
  return Math.min(99, Math.floor((shownChars / totalChars) * 100));
}

/** ★ PR diff 섹션(파일별 예산 head/tail·절단 명시·순수). 한도 이내=전체·초과=모든 파일 head+tail(중간 생략). */
/**
 * ⭐절단 고지의 **규율 항목** — 단일 출처(2026-07-27).
 *
 * ⚠️ 이 문장들이 `diffSection` 안에 인라인돼 있어, #5517 이 문구를 강화했을 때 그것을 단언하던 테스트가
 * **조용히 stale** 이 됐다(`Do NOT flag` 를 계속 기대).
 *
 * ⭐ 한 덩어리 문자열이 아니라 **항목 맵**인 이유: 테스트가 `contains(합친 문자열)` 만 보면 상수를
 * 빈 값으로 바꿔도 통과한다 — *"규율이 빠지면 깨진다"* 가 성립하지 않는다. 항목으로 두면
 * **삭제는 개수로, 빈 값은 길이로** 잡히고 **문구 다듬기는 통과**한다(출처가 하나이므로).
 */
export const DIFF_TRUNCATION_RULES = {
  /** ①부재를 단정하지 마라 */
  noAbsenceClaim:
    'Do NOT conclude anything is missing, absent, unwired, untested, or not implemented merely because you cannot see it here.',
  /** ②못 본 것은 SHOULD-FIX 로 */
  unseenToShouldFix:
    'Put claims that require unseen code in SHOULD-FIX as unverified (could not see);',
  /** ③MUST-FIX 는 보이는 증거에만 */
  mustFixNeedsEvidence:
    'raise MUST-FIX only for findings with concrete visible evidence.',
} as const;

/** 렌더용 합본 — 항목 순서대로 이어 붙인다. ⚠️내부 전용(파일 밖 소비자 없음) — 테스트도 **항목 맵**을
 *  본다(합본만 보면 비워도 통과하는 항등식이 된다). 소비자가 생기면 그때 export 한다. */
const DIFF_TRUNCATION_DISCIPLINE = Object.values(DIFF_TRUNCATION_RULES).join(' ');

export function diffSection(
  prDiff: string,
  limit = reviewDiffCharLimit(),
  budget: DiffBudgetResult = budgetedDiff(prDiff, limit),
): string[] {
  const { text, truncated, files, shownChars, totalChars, omittedFiles } = budget;
  if (!truncated) return ['## PR diff', text];
  const shownPercent = diffShownPercent(shownChars, totalChars);
  const representation = omittedFiles === 0
    ? 'EVERY changed file is represented above.'
    : `${omittedFiles} changed file(s) are entirely omitted from this review.`;
  return [
    `## PR diff (budget-truncated: ${shownChars}/${totalChars} chars shown, ${shownPercent}%, over ${files} files; per-file HEAD+TAIL shown, middles omitted${omittedFiles > 0 ? `; ${omittedFiles} files entirely omitted` : ''})`,
    text,
    '',
    `[NOTE] You did not receive the full diff. Long files show HEAD + TAIL with the middle omitted ("... N chars omitted mid-file ..."). ${representation} ${DIFF_TRUNCATION_DISCIPLINE}`,
  ];
}

/** post-PR 리뷰 프롬프트 — critic(read-only) 계약. diff scope-guard 가 아니라 산출물 correctness/설계 검증.
 *  첫 줄 VERDICT 고정(결정론 파싱)·이후 MUST-FIX/SHOULD-FIX 섹션. */
function referencedRepositoryPaths(prDiff: string): string[] {
  const changed = [...prDiff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]!);
  const mentioned = [...prDiff.matchAll(/(?<![\w/])(?:src|test|docs|scripts)\/[\w.@/-]+/g)].map((match) => match[0]!);
  return [...new Set([...changed, ...mentioned])];
}

const REVIEWER_CONTEXT_MAX_CHARS = 12_000;

/** Decode the a-side of a diff header, including Git's quoted UTF-8 octal paths. */
function reviewerContextDiffPath(chunk: string): string | undefined {
  const header = /^diff --git ("(?:\\.|[^"\\])*"|a\/[^ \n]+) (?:"(?:\\.|[^"\\])*"|b\/[^ \n]+)(?:\r?\n|$)/.exec(chunk);
  if (!header) return undefined;
  const token = header[1]!;
  if (!token.startsWith('"')) return token.slice(2);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const body = token.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    // Decode by code point so astral characters (emoji) keep both surrogate halves.
    const codePoint = body.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    if (char !== '\\') { bytes.push(...Buffer.from(char, 'utf8')); if (codePoint > 0xffff) i += 1; continue; }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; continue; }
    const next = body[++i]!;
    if (escapes[next] !== undefined) bytes.push(escapes[next]);
    else bytes.push(...Buffer.from(next, 'utf8'));
  }
  const path = Buffer.from(bytes).toString('utf8');
  return path.startsWith('a/') ? path.slice(2) : undefined;
}

/** Bound each ordered human-supplied item independently so an early large item cannot evict later context. */
function budgetReviewerContextWithParts(
  items: readonly ReviewerContextItem[],
  maxChars: number,
): { budget: ReviewerContextBudget; partsByItem: (string | undefined)[] } {
  const fullText = items.map((item) => `### ${item.label}\n${item.body}`).join('\n\n');
  if (items.length === 0) {
    return { budget: { text: '', itemCount: 0, shownChars: 0, totalChars: 0, truncated: false, fullyIncludedItems: 0, truncatedItems: 0, omittedItems: 0 }, partsByItem: [] };
  }
  const separatorChars = (items.length - 1) * 2;
  const itemBudget = Math.max(0, Math.floor((maxChars - separatorChars) / items.length));
  const renderItem = (item: ReviewerContextItem, budget: number): string | undefined => {
    const header = `### ${item.label}\n`;
    const fullItem = `${header}${item.body}`;
    if (fullItem.length <= budget) return fullItem;
    const markerFor = (omitted: number) => `\n... [${omitted} chars omitted from reviewer context item] ...`;
    let marker = markerFor(item.body.length);
    if (header.length + marker.length > budget) return undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bodyChars = Math.max(0, budget - header.length - marker.length);
      const nextMarker = markerFor(item.body.length - bodyChars);
      if (nextMarker === marker) break;
      marker = nextMarker;
    }
    const bodyChars = Math.max(0, budget - header.length - marker.length);
    const headChars = Math.floor(bodyChars / 2);
    const tailChars = bodyChars - headChars;
    const omitted = item.body.length - bodyChars;
    marker = markerFor(omitted);
    if (header.length + bodyChars + marker.length > budget) return undefined;
    return `${header}${item.body.slice(0, headChars)}${marker}${tailChars > 0 ? item.body.slice(-tailChars) : ''}`;
  };
  const initialParts = items.map((item) => renderItem(item, itemBudget));
  const initialOmittedItems = initialParts.filter((part) => part === undefined).length;
  const leftover = initialOmittedItems * itemBudget;
  const includedItems = items.length - initialOmittedItems;
  const recoveredItemBudget = includedItems === 0
    ? Math.max(0, maxChars - separatorChars)
    : itemBudget + Math.floor(leftover / includedItems);
  const recoveredParts = initialParts.map((part, index) => part === undefined ? undefined : renderItem(items[index], recoveredItemBudget)!);
  const selected = recoveredParts.map((part) => part !== undefined);
  let shownChars = recoveredParts.filter((part): part is string => part !== undefined).join('\n\n').length;
  let selectedItems = includedItems;
  const refill = initialParts.map((part, index) => part === undefined ? renderItem(items[index], recoveredItemBudget) : undefined);
  for (let index = 0; index < refill.length; index += 1) {
    if (selected[index] || refill[index] === undefined) continue;
    const addedSeparatorChars = selectedItems === 0 ? 0 : 2;
    if (shownChars + addedSeparatorChars + refill[index]!.length > maxChars) continue;
    selected[index] = true;
    selectedItems += 1;
    shownChars += addedSeparatorChars + refill[index]!.length;
  }
  const partsByItem = recoveredParts.map((part, index) => selected[index] ? part ?? refill[index] : undefined);
  const parts = partsByItem.filter((part): part is string => part !== undefined);
  const fullyIncludedItems = partsByItem.filter((part, index) => part === `### ${items[index].label}\n${items[index].body}`).length;
  const truncatedItems = parts.length - fullyIncludedItems;
  const omittedItems = items.length - parts.length;
  const text = parts.join('\n\n');
  return {
    budget: {
      text,
      itemCount: items.length,
      shownChars: text.length,
      totalChars: fullText.length,
      truncated: text.length < fullText.length,
      fullyIncludedItems,
      truncatedItems,
      omittedItems,
    },
    partsByItem,
  };
}

export function budgetReviewerContext(
  items: readonly ReviewerContextItem[] = [],
  maxChars = REVIEWER_CONTEXT_MAX_CHARS,
): ReviewerContextBudget {
  return budgetReviewerContextWithParts(items, maxChars).budget;
}

function reviewerContextSection(
  items: readonly ReviewerContextItem[] | undefined,
  budget = items?.length ? budgetReviewerContext(items) : undefined,
): string[] {
  if (!items?.length || !budget) return [];
  const itemStatus = `${budget.fullyIncludedItems} fully included, ${budget.truncatedItems} truncated, ${budget.omittedItems} omitted`;
  const heading = budget.truncated
    ? `## Reviewer-provided context (budget-truncated: ${budget.shownChars}/${budget.totalChars} chars shown, ${diffShownPercent(budget.shownChars, budget.totalChars)}%; ${itemStatus})`
    : `## Reviewer-provided context (${itemStatus})`;
  return ['', heading, budget.text];
}

const REFERENCED_CONTEXT_MAX_FILES = 4;
const REFERENCED_CONTEXT_MAX_CHARS_PER_FILE = 4_000;
const REFERENCED_CONTEXT_MAX_CHARS = 12_000;

/** Read only a bounded, deterministic supplement when diff budgeting omitted context. */
function readTruncatedDiffContext(input: ReviewInput, budget: DiffBudgetResult): { text: string; count: number } {
  if (!budget.truncated || !input.readReferencedFile) return { text: '', count: 0 };
  const paths = referencedRepositoryPaths(input.prDiff);
  const parts: string[] = [];
  let count = 0;
  let chars = 0;
  for (const path of paths.slice(0, REFERENCED_CONTEXT_MAX_FILES)) {
    const result = input.readReferencedFile(path);
    if (result.kind !== 'ok') continue;
    count += 1;
    const remaining = REFERENCED_CONTEXT_MAX_CHARS - chars;
    if (remaining <= 0) break;
    const header = `### ${path}\n`;
    let contents = result.contents.slice(0, Math.min(REFERENCED_CONTEXT_MAX_CHARS_PER_FILE, remaining - header.length));
    let marker = contents.length < result.contents.length
      ? `\n... [${result.contents.length - contents.length} chars omitted from referenced file] ...`
      : '';
    if (header.length + contents.length + marker.length > remaining) {
      contents = result.contents.slice(0, Math.max(0, remaining - header.length - marker.length));
      marker = `\n... [${result.contents.length - contents.length} chars omitted from referenced file] ...`;
    }
    const part = `${header}${contents}${marker}`;
    if (part.length > remaining) break;
    parts.push(part);
    chars += part.length;
  }
  const omitted = paths.length - count;
  if (omitted > 0 && chars < REFERENCED_CONTEXT_MAX_CHARS) {
    parts.push(`... [${omitted} referenced file(s) not included within context budget] ...`);
  }
  return { text: parts.join('\n\n').slice(0, REFERENCED_CONTEXT_MAX_CHARS), count };
}

export function buildReviewPrompt(
  input: ReviewInput,
  budget: DiffBudgetResult = budgetedDiff(input.prDiff),
  referencedContext = '',
  reviewerContextBudget = input.reviewerContext?.length ? budgetReviewerContext(input.reviewerContext) : undefined,
): string {
  const phaseIntent = capIntent(input.phaseIntent);
  const intentTruncation = reviewIntentTruncationObservation(input.phaseIntent);
  const phaseIntentHeading = intentTruncation.intentTruncated
    ? `## Phase intent (budget-truncated: ${phaseIntent.length}/${intentTruncation.intentTotalChars} chars shown, ${diffShownPercent(phaseIntent.length, intentTruncation.intentTotalChars!)}%)`
    : '## Phase intent';

  return [
    'You are a strict staff-engineer reviewing an ALREADY-OPENED pull request from an autonomous coding agent.',
    // ⚠️ 무표식 절단 금지(리뷰 must-fix) — 잘렸으면 **어느 절부터**인지 리뷰어가 알아야 한다.
    phaseIntentHeading, phaseIntent,
    ...(input.acceptance ? ['## Acceptance criteria', input.acceptance.slice(0, 1000)] : []),
    'This is a POST-PR review of the produced artifact. Judge whether the PR actually',
    'delivers the phase intent CORRECTLY and soundly: (1) correctness/latent bugs, (2) does it meet the stated',
    'acceptance criteria, (3) design/regression risk, (4) missing wiring (new code never called), (5) tests present',
    'and honest (no Goodhart),',
    // ★ G3(2026-07-21·리뷰 신뢰·무인 auto-merge 전제) — 자율 산출은 gate/test 를 통과해도 스코프크리프·죽은
    //   코드를 남긴다(라이브 실증: 미사용 env var 주입). 무인 병합이 안전하려면 리뷰가 이걸 잡아야 한다.
    '(6) DEAD/UNUSED additions: any new export, env var, field, constant, or function that NOTHING in the diff or',
    '    codebase consumes = FAIL (wire it or delete it — do not ship speculative/unused surface),',
    '(7) SCOPE CREEP: changes materially beyond the stated intent (unrequested refactors, extra features, contract',
    '    changes to shared functions not needed by the goal) — surface explicitly; FAIL if risky/unwarranted, else WARN.',
    '(8) TEST SIDE EFFECTS: when test files change alongside non-test repository files, determine whether those files are',
    '    intended output or test side effects: check literal repository paths in tests, injected stubs for functions that write them,',
    '    and whether those path files changed in the same diff. A path the phase intent names as "이 런의 골 문서" is excluded from this',
    '    test-side-effect/source suspicion only; still review that goal document\'s content for scope and correctness. If you cannot determine this, do not PASS; report the concern.',
    '(9) UNKNOWN-DEFAULT OUTPUT ASSERTION: report only when a newly optional parameter can be omitted by a caller that does not',
    '    know its value, omission forces one-sided default, and that assumed value is presented as fact in external output. Label every',
    '    such finding "UNKNOWN-DEFAULT OUTPUT ASSERTION" and require the code to preserve unknown, require the value, or answer only',
    '    for callers that know it. Do not report ordinary defaults or values that remain internal and are never surfaced in output.',
    '(10) GOODHART PASSING PROOF: apply only when you identify Goodhart — not for ordinary must-fix findings.',
    '    On that same finding line, state what would pass: one concrete observation and where to see it. Examples:',
    '    run the real entrypoint and assert runtime output this change did not author; force the call site to fail',
    '    and check that the error names that site; use values the real caller produces instead of synthetic input.',
    'Do NOT rubber-stamp; an empty review is a failed review — always surface at least a watch item.',
    '',
    ...(input.workingMemory ? ['## Prior decisions / reuse boundaries (working memory)', input.workingMemory.slice(0, 1200)] : []),
    // ⭐ 증거가 무엇인지 먼저 말한다 — 규칙 (7) 이 "의도를 넘어선 변경" 을 판정하려면
    //   diff 에 담긴 것이 **이 PR 이 저작한 것인지**를 알아야 한다.
    ...(input.evidenceNote ? ['## Evidence', input.evidenceNote.slice(0, 1200)] : []),
    ...reviewerContextSection(input.reviewerContext, reviewerContextBudget),
    ...diffSection(input.prDiff, reviewDiffCharLimit(), budget),
    ...(referencedContext ? ['', '## Repository file context (read within repository boundary)', referencedContext] : []),
    '',
    'Reply in Korean. First line EXACTLY one of: VERDICT: PASS | VERDICT: WARN | VERDICT: FAIL.',
    '  - FAIL = blocker(s): incorrect, unmet acceptance, unwired code, dead/unused additions, Goodhart. Rework required.',
    '  - WARN = ships but has non-blocking concerns.',
    '  - PASS = correct and sound (a watch item is still fine).',
    'Then optionally a line "MUST-FIX:" followed by blocker findings (one per line, "- " prefix),',
    'then optionally a line "SHOULD-FIX:" followed by non-blocker findings ("- " prefix). Keep each finding one concise line.',
    'Then optionally a line "REQUIREMENTS:" followed by repository context you need to inspect before making a determination ("- " prefix). This is observational only and does not change the verdict.',
  ].join('\n');
}

/** «지적 없음» 표지 — 일부 모델(GLM-5.3 실측)이 빈 섹션 대신 `- (없음 — …)` / `- none` 을 항목으로 쓴다.
 *  ⭐ 표지 «만»인 항목을 0건으로 접는다. 두 모양뿐이다:
 *   ① 낱말 하나(`none`·`없음`·`N/A`·`해당 없음` · 끝 마침표 허용)
 *   ② 항목 «전체»가 괄호에 싸인 표지 — 설명이 붙으면 그 설명이 «지적이 없다»는 말일 때만
 *      (`(없음 — 블로커 수준의 결함은 발견되지 않음)` · `(none — no blockers)`).
 *  ⛔ 그 밖은 «지적»으로 남긴다 — `없음 — 인증 검사가 없어 …` · `(none: the new export is never called)` ·
 *  `none of the tests …`. 표지 낱말로 시작하는 실제 블로커를 지우면 PASS/WARN 리뷰에서 블로커가 사라진다. */
const NONE_WORD = String.raw`(?:없음|해당\s*없음|n\/a|none|nothing)`;
const BARE_SENTINEL = new RegExp(String.raw`^${NONE_WORD}\s*[.。]?$`, 'i');
const BRACKETED_SENTINEL = new RegExp(String.raw`^[([（【]\s*${NONE_WORD}(?:\s*[—–\-:.,;]\s*([^)\]）】]*))?\s*[)\]）】]$`, 'i');
// ⭐ 설명 «전체»가 「지적 없음」 한 문장일 때만 — 일부만 맞아도 접으면 `(none: no blockers are checked because …)` 같은 지적이 사라진다.
const NO_FINDING_REMARK = new RegExp([
  String.raw`^(?:(?:블로커|차단)\s*)?(?:수준의?\s*)?(?:결함|문제|이슈|지적|블로커)(?:은|는|이|가)?\s*(?:발견되지\s*않(?:음|았(?:다|습니다)?)|없(?:음|다|습니다))[.。]?$`,
  String.raw`^(?:no|zero)\s+(?:blocking\s+)?(?:blockers?|issues?|problems?|findings?|must-?fix(?:es)?)(?:\s+found)?\.?$`,
  String.raw`^nothing\s+(?:blocking|to\s+fix)\.?$`,
].join('|'), 'i');
function isNoneSentinelFinding(finding: string): boolean {
  const text = finding.trim();
  if (BARE_SENTINEL.test(text)) return true;
  const bracketed = BRACKETED_SENTINEL.exec(text);
  if (!bracketed) return false;
  const remark = bracketed[1]?.trim();
  return !remark || NO_FINDING_REMARK.test(remark);
}

/** critic 응답 파싱 → ReviewResult. 순수함수. VERDICT + MUST-FIX/SHOULD-FIX/REQUIREMENTS 섹션 분해.
 *  verdict=FAIL 인데 must-fix 미기재면 첫 finding 을 must 로 승격(블로커 근거 보존). */
/** ⭐ `VERDICT: PASS|WARN|FAIL` 판정 줄 — `parseReviewResult` 와 `reviewedResultFromRaw` 가 «같은» 정규식을 쓴다(존재 판정이 갈리면 안 된다). */
const VERDICT_LINE = /VERDICT:\s*(PASS|WARN|FAIL)/i;

export function parseReviewResult(text: string): ReviewResult {
  const vm = VERDICT_LINE.exec(text);
  const verdict = (vm ? vm[1]!.toLowerCase() : 'pass') as ReviewVerdict;
  const lines = text.split('\n').map((l) => l.trim());
  const mustFix: string[] = [];
  const shouldFix: string[] = [];
  const requirements: string[] = [];
  let fallbackFinding: string | undefined;
  let section: 'must' | 'should' | 'requirements' | null = null;
  for (const l of lines) {
    if (/^MUST-?FIX/i.test(l)) { section = 'must'; continue; }
    if (/^SHOULD-?FIX/i.test(l)) { section = 'should'; continue; }
    if (/^REQUIREMENTS:\s*$/i.test(l)) { section = 'requirements'; continue; }
    if (/^(WATCH|VERDICT)/i.test(l)) { section = null; continue; }
    if (l.startsWith('- ')) {
      const f = l.slice(2).trim();
      if (!f) continue;
      if (section === 'must') { if (!isNoneSentinelFinding(f)) mustFix.push(f); }
      else if (section === 'should') shouldFix.push(f);
      else if (section === 'requirements') requirements.push(f);
      else fallbackFinding ??= f;
    }
  }
  if (verdict === 'fail' && mustFix.length === 0) {
    const first = shouldFix.shift() ?? fallbackFinding;
    mustFix.push(first ?? 'PR 리뷰 FAIL — 재작업 필요(구체 지적 미파싱).');
  }
  const fallback = text.match(/\n\[reviewer fallback: ([^\r\n]+)\]$/);
  return {
    verdict,
    mustFix: mustFix.slice(0, 6),
    shouldFix: shouldFix.slice(0, 6),
    ...(fallback ? { reviewerFallback: fallback[1] } : {}),
    ...(requirements.length ? { requirements } : {}),
  };
}

/** 판정 줄 없는 응답의 사유 값 — 기존 «리뷰 못 함» 경로(`reviewed:false` ⊕ `failureReason`)를 그대로 탄다. */
export const NO_VERDICT_LINE_REASON = 'no-verdict-line';

/**
 * ⛔⭐⭐ REVIEW-NO-VERDICT-FAILCLOSED(2026-10-10) — 리뷰어 응답 «하나»를 결과로 접는다.
 *   `parseReviewResult` 는 `VERDICT:` 줄이 없으면 `pass` 로 기본값을 둔다. 종전 호출부는 거기에
 *   `reviewed: true` 를 붙여서, 자격 없는 리뷰어의 219자 오류 문구가 «지적 0 인 PASS» 로 접혔다
 *   (실물: run-dbe7b7df · PR #25906 · codex-app-server 17초).
 *   ⇒ 판정 줄이 없으면 «리뷰 못 함»(`reviewed:false` · `failureReason=no-verdict-line`)이다 —
 *   catch 경로와 «같은 모양»이라 소비처(orchestrator·seams·renderReview·fold)가 이미 «통과 판정 아님»으로 다룬다.
 *   ⭐ 판정 줄이 «있는» 응답은 `parseReviewResult(raw)` ⊕ `reviewed:true` 그대로 — 바이트 동일.
 *   ⛔ 계약: `reviewed:false` 일 때 `verdict` 는 «의미 없는 자리값»(`pass`)이다 — catch·미주입 경로와 같다.
 *      소비처는 `reviewed` 를 «먼저» 본다(`renderReview`·`self-review-cli`·`review-adapter`·orchestrator).
 */
function reviewedResultFromRaw(raw: string, runId: string | undefined, pass?: { index: number; of: number }): ReviewResult {
  if (VERDICT_LINE.test(raw)) return { ...parseReviewResult(raw), reviewed: true };
  try {
    debug.log('review.verdict', NO_VERDICT_LINE_REASON, {
      chars: raw.length,
      head: safeLogText(raw, 80),
      ...(pass ? { pass: pass.index + 1, passes: pass.of } : {}),
      // ⛔ backend 는 안 남긴다 — 이 함수는 어느 백엔드로 불렸는지 «모른다»(catch 주석 `#7495` 와 같은 이유).
      ...(runId !== undefined ? { runId } : {}),
    });
  } catch { /* Observation must not prevent the review. */ }
  return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false, failureReason: NO_VERDICT_LINE_REASON };
}

function failureReasonText(error: unknown): string {
  if (error instanceof Error) return safeLogText(error.message, 400);
  if (typeof error === 'string') return safeLogText(error, 400);
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return safeLogText(typeof code === 'number' || typeof code === 'string' ? `${code}: ${message}` : message, 400);
    }
    try {
      return safeLogText(JSON.stringify(error), 400);
    } catch {
      return 'Unknown review failure';
    }
  }
  return safeLogText(String(error), 400);
}

/** ★ 자율 PR 리뷰 — PR diff 를 critic(llmReview 주입 seam)에 실어 verdict 산출. llmReview 미주입/예외 시
 *  fail-soft: verdict='pass'·reviewed=false(리뷰 실패가 미션/호출측을 막지 않음). */
export async function reviewPullRequest(
  input: ReviewInput,
  /** ⭐ `P4b` — 두 번째 인자로 이미지를 «같이» 받는다. 안 받는 리뷰어(API 백엔드)는 그냥 무시한다. */
  llmReview?: (prompt: string, images?: readonly ReviewImage[]) => Promise<string>,
): Promise<ReviewResult> {
  if (!llmReview) return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false }; // 리뷰어 미주입=미검토.
  try {
    const diffBudget = budgetedDiff(input.prDiff);
    // Existing caller: self-review-cli.ts runSelfReviewCliCommand → deps.reviewPullRequest(reviewInput, llmReview).
    const plan = planReviewChunks(input.prDiff);
    const chunked = plan.passes.length > 1;
    const contextItems = input.reviewerContext ?? [];
    const passPaths = chunked ? plan.passes.map((pass) => new Set(
      splitDiffByFile(pass).flatMap((chunk) => {
        // self-review-cli.ts runSelfReviewCliCommand → deps.reviewPullRequest(reviewInput, llmReview) → this pass.
        const path = reviewerContextDiffPath(chunk);
        return path === undefined ? [] : [path];
      }),
    )) : [];
    const matchedLabels = new Set(passPaths.flatMap((paths) => [...paths]));
    const passContext = chunked && contextItems.length ? passPaths.map((paths, passIndex) => {
      const indices = contextItems.flatMap((item, index) =>
        item.image ? (passIndex === 0 ? [index] : [])
          : !matchedLabels.has(item.label) || paths.has(item.label) ? [index] : []);
      const { budget, partsByItem } = budgetReviewerContextWithParts(indices.map((index) => contextItems[index]!), REVIEWER_CONTEXT_MAX_CHARS);
      return { indices, budget, partsByItem };
    }) : [];
    const chunkContextBudget = passContext.length ? (() => {
      const shownByItem: Array<number | undefined> = contextItems.map(() => undefined);
      const status: Array<'omitted' | 'truncated' | 'full' | undefined> = contextItems.map(() => undefined);
      for (const { indices, partsByItem } of passContext) {
        indices.forEach((itemIndex, position) => {
          const part = partsByItem[position];
          // Count each item once at its narrowest pass: a loss in any pass must show in shownChars.
          const shown = part?.length ?? 0;
          shownByItem[itemIndex] = Math.min(shownByItem[itemIndex] ?? shown, shown);
          const full = `### ${contextItems[itemIndex]!.label}\n${contextItems[itemIndex]!.body}`;
          if (part !== full) status[itemIndex] = part === undefined && status[itemIndex] !== 'truncated' ? 'omitted' : 'truncated';
          else if (status[itemIndex] === undefined) status[itemIndex] = 'full';
        });
      }
      const shownCount = shownByItem.filter((length) => (length ?? 0) > 0).length;
      const fullyIncludedItems = status.filter((value) => value === 'full').length;
      const truncatedItems = status.filter((value) => value === 'truncated').length;
      const omittedItems = contextItems.length - fullyIncludedItems - truncatedItems;
      return {
        itemCount: contextItems.length,
        // Same scale as totalChars (items joined by "\n\n"): each item counts once at its narrowest
        // shown part, so shownChars === totalChars exactly when no item lost anything in any pass.
        // perPassShownChars in the budget log keeps the raw per-pass sizes.
        shownChars: shownByItem.reduce<number>((sum, length) => sum + (length ?? 0), 0) + Math.max(0, shownCount - 1) * 2,
        totalChars: contextItems.map((item) => `### ${item.label}\n${item.body}`).join('\n\n').length,
        truncated: truncatedItems > 0 || omittedItems > 0,
        fullyIncludedItems, truncatedItems, omittedItems,
      };
    })() : undefined;
    const singleContextBudget = !chunked && contextItems.length ? budgetReviewerContext(contextItems) : undefined;
    const reviewerContextBudget = chunkContextBudget ?? singleContextBudget;
    if (reviewerContextBudget) {
      try {
        debug.log('review.images', 'reviewer-context-budget', {
          itemCount: reviewerContextBudget.itemCount,
          shownChars: reviewerContextBudget.shownChars,
          totalChars: reviewerContextBudget.totalChars,
          truncated: reviewerContextBudget.truncated,
          fullyIncludedItems: reviewerContextBudget.fullyIncludedItems,
          truncatedItems: reviewerContextBudget.truncatedItems,
          omittedItems: reviewerContextBudget.omittedItems,
          ...(chunked ? { passes: plan.passes.length, perPassShownChars: passContext.map(({ budget }) => budget.shownChars) } : {}),
          ...(input.reviewContext?.runId !== undefined ? { runId: input.reviewContext.runId } : {}),
          ...(input.reviewContext?.round !== undefined ? { round: input.reviewContext.round } : {}),
        });
      } catch {
        // Observation must not prevent the review.
      }
    }
    const referencedContext = readTruncatedDiffContext(input, diffBudget);
    // ⭐ 이미지가 실린 컨텍스트 항목을 «따로» 모아 두 번째 인자로 넘긴다.
    //   ⛔ 프롬프트 문자열에 base64 를 섞지 않는다 — 예산을 먹고, 그러고도 모델은 이미지로 못 본다.
    const capped = capReviewImages((input.reviewerContext ?? [])
      .filter((item): item is ReviewerContextItem & { image: { mimeType: string; data: string } } => item.image !== undefined)
      .map((item) => ({ label: item.label, mimeType: item.image.mimeType, data: item.image.data })));
    const reviewImages = capped.kept;
    if (capped.dropped > 0) {
      // ⛔ 「원본 수」와 「보낸 수」를 «다른 칸»으로 둔다 — 하나로 접으면 누락이 안 보인다.
      try {
        debug.log('review.images', 'capped', { requested: capped.kept.length + capped.dropped, sent: capped.kept.length, dropped: capped.dropped });
      } catch {
        // Observation must not prevent the review.
      }
    }
    // ⭐⭐⭐ 분할 리뷰(2026-08-19) — 예산을 넘는 diff 를 «버리는» 대신 «나눠서 다 본다».
    //   🚨 왜 — 리뷰가 `pass` 를 냈는데 diff 의 18%만 본 사례가 실물로 났고(북극성 조각 ⓪ ·
    //     283,155자 중 52,000자), 병합 게이트가 `review-diff-truncated` 로 «옳게» 막았다.
    //     그 결과 **성공한 런이 원리상 착지할 수 없었다**.
    //   📌 이 파일 `reviewDiffCharLimit()` 주석이 애초에 그렇게 적어 뒀다 —
    //     *"64,000자는 **분할 리뷰 도입을 전제로 한 조각별 고정 예산**"*. 부품(`splitDiffByFile`)도
    //     서 있었다. 없던 것은 「조각들을 리뷰하고 결과를 «접는» 자」 하나였다.
    //   ⛔ 상한을 «올리는» 것이 아니다 — 조각마다 상한을 «지킨다».
    if (chunked) {
      try {
        debug.log('review.diff-plan', 'chunked', {
          passes: plan.passes.length, files: plan.files, coversAll: plan.coversAll,
          coveredChars: plan.coveredChars, totalChars: plan.totalChars,
          omittedFiles: plan.omittedFiles, oversizedFiles: plan.oversizedFiles,
          droppedByCap: plan.droppedByCap,
          ...(input.reviewContext?.runId !== undefined ? { runId: input.reviewContext.runId } : {}),
        });
      } catch { /* Observation must not prevent the review. */ }
      const passResults: ReviewResult[] = [];
      for (const [index, passDiff] of plan.passes.entries()) {
        const passBudget: DiffBudgetResult = {
          text: passDiff,
          truncated: false,
          files: splitDiffByFile(passDiff).filter((c) => /^diff --git /.test(c)).length,
          shownChars: passDiff.length,
          totalChars: passDiff.length,
          omittedFiles: 0,
        };
        const passInput: ReviewInput = {
          ...input,
          prDiff: passDiff,
          reviewerContext: passContext[index]?.indices.map((itemIndex) => contextItems[itemIndex]!),
          // ⭐ 리뷰어에게 «자기가 몇 분의 몇을 보는지» 알린다 — 이것 없이는 조각 리뷰어가
          //   "다른 파일이 안 보인다"를 SCOPE/미배선 결함으로 오판한다(규칙 (7) 오작동).
          evidenceNote: [
            input.evidenceNote,
            `이 리뷰는 PR diff 를 ${plan.passes.length}조각으로 나눈 것 중 ${index + 1}번째 조각입니다.`
            + ' 다른 조각의 파일은 이 프롬프트에 없을 뿐 PR 에는 있습니다 —'
            + ' 「여기 안 보인다」를 결함으로 판정하지 마십시오.',
          ].filter(Boolean).join('\n'),
        };
        passResults.push(reviewedResultFromRaw(await llmReview(
          buildReviewPrompt(passInput, passBudget, '', passContext[index]?.budget),
          reviewImages.length > 0 && index === 0 ? reviewImages : undefined,
        ), input.reviewContext?.runId, { index, of: plan.passes.length }));
      }
      return {
        ...foldReviewResults(passResults),
        diffBudget: {
          // ⭐ 「전부 봤나」가 truncated 의 «정의»다 — 상한에 걸렸거나 초대형 파일이 있으면 여전히 true.
          truncated: !plan.coversAll,
          shownChars: plan.coveredChars,
          totalChars: plan.totalChars,
          omittedFiles: plan.omittedFiles,
        },
        ...(reviewerContextBudget ? {
          contextBudget: {
            itemCount: reviewerContextBudget.itemCount,
            shownChars: reviewerContextBudget.shownChars,
            totalChars: reviewerContextBudget.totalChars,
            truncated: reviewerContextBudget.truncated,
            fullyIncludedItems: reviewerContextBudget.fullyIncludedItems,
            truncatedItems: reviewerContextBudget.truncatedItems,
            omittedItems: reviewerContextBudget.omittedItems,
          },
        } : {}),
      };
    }
    const raw = await llmReview(
      buildReviewPrompt(input, diffBudget, referencedContext.text, singleContextBudget),
      reviewImages.length > 0 ? reviewImages : undefined,
    );
    return {
      ...reviewedResultFromRaw(raw, input.reviewContext?.runId),
      diffBudget: {
        truncated: diffBudget.truncated,
        shownChars: diffBudget.shownChars,
        totalChars: diffBudget.totalChars,
        omittedFiles: diffBudget.omittedFiles,
      },
      ...(reviewerContextBudget ? {
        contextBudget: {
          itemCount: reviewerContextBudget.itemCount,
          shownChars: reviewerContextBudget.shownChars,
          totalChars: reviewerContextBudget.totalChars,
          truncated: reviewerContextBudget.truncated,
          fullyIncludedItems: reviewerContextBudget.fullyIncludedItems,
          truncatedItems: reviewerContextBudget.truncatedItems,
          omittedItems: reviewerContextBudget.omittedItems,
        },
      } : {}),
      ...(input.readReferencedFile ? {
        referencedFilesOpened: referencedContext.count > 0,
        referencedFilesRead: referencedContext.count,
      } : {}),
    }; // 실제 리뷰 완료(fail-soft pass 와 구분).
  } catch (error) {
    // ⛔⭐⭐⭐ 종전엔 **맨 `catch { }`** 라 «왜 못 했는지»를 통째로 버렸다.
    //   실측(2026-08-07): `--acp-backend claude-code`(미등록) 를 주면 레지스트리는
    //   ***`Unknown ACP backend "claude-code". Known: claude, gemini, codex-app-server, grok`***
    //   이라는 «완벽한» 오류를 던지는데, 그것이 여기서 사라지고 사용자는 `reviewed=false` 만 봤다.
    //   CLI 는 *"관측: elanous logs --category acp-review"* 라 안내하는데 ⛔ 그 로그에도 아무것도 없었다.
    //   ⇒ ***fail-soft 는 옳지만 «침묵하는» fail-soft 는 아니다.*** 이유를 «값으로» 돌려준다.
    //
    // ⛔⭐⭐⭐ 그런데 «여기서 로그를 쓰지 않는다** — 이 함수는 파일 머리말대로 «LLM 무결합»이고
    //   자기가 어느 백엔드로 불렸는지 «모른다**. 한때 여기에 `acp-review` 관측을 넣었다가
    //   ***비-ACP 호출의 실패까지 「ACP 실패」로 오염***시켰다(`#7495` 리뷰 must-fix — 내가 만든 것이다).
    //   ⇒ 관측은 «어느 경로인지 아는» 호출부가 남긴다(`self-review-cli`).
    // ⛔⭐⭐ **원본**에서 마스킹한다 — 이 값은 `--json` 의 `...review` 스프레드로 «그대로» 나가고,
    //   LLM/전송 오류 메시지에는 토큰·키가 섞일 수 있다(`#7495` 리뷰 must-fix · 보안).
    //   출력 «경계마다» 막으면 새 소비처가 생길 때 하나를 빠뜨린다 ⇒ 여기서 한 번 막는다.
    //   ⚠️ `review-observation` 의 `pr-reviewer` import 는 «타입 전용»이라 런타임 순환이 없다.
    const reason = failureReasonText(error);
    return { verdict: 'pass', mustFix: [], shouldFix: [], reviewed: false, failureReason: reason };
  }
}

/** 리뷰 결과를 PR 코멘트/알림/CLI 용 markdown 으로 렌더. */
export function renderReview(r: ReviewResult): string {
  // A review that never ran must not read as PASS anywhere it is rendered (PR body, comments, CLI) — 10-05 #23942·#24151.
  if (r.reviewed === false) return `⚠️ 자율 PR 리뷰: 리뷰 안 돎 — 사유 ${r.failureReason?.trim() || '미상'} (통과 판정 아님)`;
  const icon = r.verdict === 'pass' ? '✅' : r.verdict === 'warn' ? '⚠️' : '⛔';
  const head = `${icon} 자율 PR 리뷰: ${r.verdict.toUpperCase()}`;
  const parts = [head];
  if (r.reviewerFallback) parts.push(`[reviewer fallback: ${r.reviewerFallback}]`);
  if (r.mustFix.length) parts.push('**Must-fix (blockers)**', ...r.mustFix.map((f) => `- ${f}`));
  if (r.shouldFix.length) parts.push('**Should-fix**', ...r.shouldFix.map((f) => `- ${f}`));
  if (r.mustFix.length === 0 && r.shouldFix.length === 0) parts.push('— 리뷰 통과(블로커·비블로커 지적 없음).');
  return parts.join('\n');
}
