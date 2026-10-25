// 하니스 Reviewer 어댑터 — 무결성 게이트(하드) + critique(소프트) → ReviewVerdict (H1 · 2026-07-20)
//
// DESIGN §15e·RESEARCH §6. "test-gate first, judge second" — 실행 검증(테스트)이 **하드 게이트**(결정론·
// 최고 신뢰)이고, LLM critique 는 **소프트 prioritizer**(별 family·"judge=prioritizer 기본"·하드 merge 게이트
// unsafe). 이 어댑터가 둘을 하나의 verdict 로 융합해 하니스 Review 스테이지에 공급한다.
//
// ★ combineReview 는 순수(주입된 게이트·critique 결과 → verdict). buildReviewSeam 은 실 게이트/critique 를
//   주입받아 review seam 을 만든다(cwd 에서 실행). 재발명 금지: 실 게이트=runIntegrityGate·critique=mission-critique.

import { omission } from '../agent-substrate/review-intent.js';
import type { ReviewVerdict } from './staged-harness.js';
// ★ P3(PLAN-reviewer-substrate-unification) — verdict 어휘 단일 출처 + substrate PR 리뷰어 위임 브릿지.
import type { ReviewVerdict as ReviewVerdictKind, ReviewResult } from '../agent-substrate/pr-reviewer.js';
import { debug } from '../debug/log.js';

/** 무결성 게이트 결과의 최소 형상(runIntegrityGate GateResult 구조적 subset). */
export interface GateLike {
  passed: boolean;
  steps?: readonly { name: string; ok: boolean }[];
  log?: string;
}

const isMissingAtBaseLine = (line: string): boolean => /^- (?!(?:introduced|preexisting|unknown):).+: missing-at-base\b/.test(line);

/** 리뷰어에게 줄 게이트 실행 증빙. 전체 로그 대신 러너/컴파일러가 낸 판정 줄만 원문으로 보존한다. */
export function gateEvidenceNote(gate: GateLike): string | undefined {
  if (!gate.log?.trim()) return undefined;
  const lines = gate.log.split(/\r?\n/).filter((line) =>
    isMissingAtBaseLine(line) || /(?:^\[gate-baseline\]|^\[changed-test-evidence\]|^- (?:introduced|preexisting|unknown):|^⚠️ .*책임이 아니다\.|Ran \d+ tests? across \d+ files?|\b\d+ (?:pass|fail)\b|error TS\d+|Verify-by-breaking|verify-by-breaking|원복 후|뒤집었을 때)/i.test(line),
  );
  if (!lines.length) return undefined;

  // baseline 귀속은 실패 수보다 먼저 리뷰어에게 도달해야 한다. 머리·결론은 각각 한 슬롯을 먼저 예약해
  // 병적으로 많은 머리줄도 면책 결론을 상한 밖으로 밀어내지 못하게 한다. baseline 블록이 없으면 기존 순서를 보존한다.
  const baselineHeads = lines.filter((line) => line.startsWith('[gate-baseline]'));
  const exonerations = lines.filter((line) => /^⚠️ .*책임이 아니다\.$/.test(line));
  const attributions = lines.filter((line) => /^- (?:introduced|preexisting|unknown):/.test(line));
  const changedHeads = lines.filter((line) => line.startsWith('[changed-test-evidence]'));
  const missingAtBase = lines.filter(isMissingAtBaseLine);
  const changedEvidence = [
    ...changedHeads.slice(0, 1),
    ...(missingAtBase.length ? ['[changed-test-evidence] base에 없는 신규 모듈의 base RED 목격을 must-fix로 요구하지 말 것. missing-at-base는 RED 증거다.'] : []),
    ...missingAtBase.slice(0, 4),
    ...(missingAtBase.length > 4 ? [omission(missingAtBase.length - 4)] : []),
    ...changedHeads.slice(1, 3),
    ...(changedHeads.length > 3 ? [omission(changedHeads.length - 3)] : []),
  ];
  const prioritizedAttributions = changedEvidence.length
    ? [...attributions.filter((line) => line.startsWith('- introduced:')),
      ...attributions.filter((line) => !line.startsWith('- introduced:'))]
    : attributions;
  const hasBaseline = baselineHeads.length > 0;
  const limit = 24; // evidence 줄 상한. 제목 한 줄을 더한 출력은 최대 25줄이다.
  const rest = lines.filter((line) => !line.startsWith('[gate-baseline]') && !/^⚠️ .*책임이 아니다\.$/.test(line)
    && !/^- (?:introduced|preexisting|unknown):/.test(line) && !line.startsWith('[changed-test-evidence]')
    && !isMissingAtBaseLine(line));
  const ordered = hasBaseline
    ? [
      ...baselineHeads.slice(0, 1),
      ...exonerations.slice(0, 1),
      ...changedEvidence,
      ...prioritizedAttributions,
      ...baselineHeads.slice(1),
      ...exonerations.slice(1),
      ...rest,
    ]
    : changedEvidence.length ? [...changedEvidence, ...exonerations, ...prioritizedAttributions, ...rest] : lines;
  if (!hasBaseline || ordered.length <= limit) {
    const selected = ordered.length <= limit
      ? ordered
      : [...ordered.slice(0, limit - 1), omission(ordered.length - limit + 1)];
    return ['## Gate execution evidence', ...selected].join('\n');
  }

  const attributionLimit = 8;
  const omittedAttributions = Math.max(0, attributions.length - attributionLimit);
  const budgeted = [
    ...baselineHeads.slice(0, 1),
    ...exonerations.slice(0, 1),
    ...changedEvidence,
    ...prioritizedAttributions.slice(0, attributionLimit),
    ...(omittedAttributions ? [omission(omittedAttributions)] : []),
    ...baselineHeads.slice(1),
    ...exonerations.slice(1),
    ...rest,
  ];
  const selected = budgeted.length <= limit
    ? budgeted
    : [...budgeted.slice(0, limit - 1), omission(budgeted.length - limit + 1)];
  return ['## Gate execution evidence', ...selected].join('\n');
}

/** 기존 게이트 증빙을 절대 자르지 않고, 뒤처짐 또는 미지 사실은 별도 줄로 반드시 덧붙인다. */
export function appendGateWorktreeFreshnessEvidence(evidence: string | undefined, behind: number | undefined): string | undefined {
  if (behind === 0) return evidence;
  const freshness = behind === undefined
    ? '[worktree] origin/main 대비 뒤처짐: unknown (local ref unavailable; no fetch)'
    : `[worktree] origin/main 대비 ${behind} commits behind (local ref; no fetch)`;
  return evidence ? `${evidence}\n${freshness}` : freshness;
}

/** critique 결과의 최소 형상(CritiqueResult/ReviewResult 구조적 subset). verdict 어휘=substrate 단일 출처. */
export interface CritiqueLike {
  verdict: ReviewVerdictKind;
  findings?: readonly string[];
  /** 실제 LLM 심사가 완료됐는가. */
  reviewed?: boolean;
  /** reviewed=false인 fail-soft 리뷰가 실행되지 못한 원인. */
  failureReason?: string;
}

/** ★ P3 위임 브릿지 — substrate PR 리뷰어 결과(ReviewResult)를 하니스 critique 입력으로. PR 산출 스테이지가
 *  reviewPullRequest 로 리뷰하면 그 결과를 combineReview 의 소프트 critique 로 실을 수 있다(findings=must+should).
 *  ★ reviewed=false(미실행·fail-soft pass)는 pass 로 승인하지 않는다(dogfood #4798 리뷰·R3 동형) — warn 강등 +
 *  "리뷰 미실행" 근거. 게이트만으론 통과하되 미검토를 authoritative pass 로 위장하지 않음. 순수. */
export function reviewResultToCritiqueLike(r: ReviewResult): CritiqueLike {
  if (r.reviewed === false) return {
    verdict: 'warn',
    findings: ['자율 PR 리뷰 미실행(fail-soft) — 미검토'],
    reviewed: false,
    ...(r.failureReason !== undefined ? { failureReason: r.failureReason } : {}),
  };
  // ★ 리뷰 nit 완화(2026-07-22·P2) — verdict=fail 은 실블로커(mustFix)만 findings 로 실어 rework 프롬프트에
  //   nit(shouldFix)이 블로커로 섞여 불필요한 재작업을 유발하지 않게 한다. shouldFix nit 은 warn 경로(staged-harness
  //   shouldFix→PR 메모 이양)로만 흐른다. warn/pass 는 종전대로(mustFix 는 비어 있어 shouldFix 만 실림·무영향).
  //   canonical ReviewResult 의 mustFix/shouldFix 구분 재사용 = shape drift 0. [[project_review_substrate_unification]]
  if (r.verdict === 'fail') return { verdict: 'fail', findings: [...r.mustFix], ...(r.reviewed !== undefined ? { reviewed: r.reviewed } : {}) };
  return { verdict: r.verdict, findings: [...r.mustFix, ...r.shouldFix], ...(r.reviewed !== undefined ? { reviewed: r.reviewed } : {}) };
}

/** ★ P3 위임 브릿지 — substrate ReviewResult → 하니스 ReviewVerdict struct(게이트 없이 PR 리뷰만 쓸 때).
 *  ★ reviewed=false 는 pass 로 위장 금지(warn 강등·dogfood #4798). 순수. */
export function reviewResultToVerdict(r: ReviewResult): ReviewVerdict {
  if (r.reviewed === false) return {
    verdict: 'warn',
    findings: ['자율 PR 리뷰 미실행(fail-soft) — 미검토'],
    ...(r.failureReason !== undefined ? { failureReason: r.failureReason } : {}),
  };
  return { verdict: r.verdict, findings: [...r.mustFix, ...r.shouldFix], ...(r.mustFix.length ? { mustFix: [...r.mustFix] } : {}) };
}

/**
 * ★ 테스트 게이트(하드) + critique(소프트) → 단일 verdict(순수).
 * ① 게이트 fail → 즉시 fail(결정론 하드 게이트·mustFix=실패 스텝). ② 게이트 pass 면 critique 로 판정
 * (fail→fail·warn→warn·else pass). critique 없으면 게이트만(pass). "judge=prioritizer, tests=gate".
 */
export function combineReview(gate: GateLike, critique?: CritiqueLike): ReviewVerdict {
  if (!gate.passed) {
    const failed = (gate.steps ?? []).filter((s) => !s.ok).map((s) => s.name);
    return {
      verdict: 'fail',
      findings: [`무결성 게이트 실패: ${failed.join(', ') || '테스트'}`],
      mustFix: failed.length ? failed : ['테스트 통과'],
      ...(critique?.failureReason !== undefined ? { failureReason: critique.failureReason } : {}),
    };
  }
  if (critique?.verdict === 'fail') {
    return { verdict: 'fail', findings: [...(critique.findings ?? ['크리틱 fail'])], mustFix: [...(critique.findings ?? [])], ...(critique.reviewed !== undefined ? { reviewed: critique.reviewed } : {}) };
  }
  if (critique?.verdict === 'warn') {
    return {
      verdict: 'warn',
      findings: [...(critique.findings ?? [])],
      ...(critique.reviewed !== undefined ? { reviewed: critique.reviewed } : {}),
      ...(critique.failureReason !== undefined ? { failureReason: critique.failureReason } : {}),
    };
  }
  return {
    verdict: 'pass',
    findings: [],
    ...(critique?.reviewed !== undefined ? { reviewed: critique.reviewed } : {}),
    ...(critique?.failureReason !== undefined ? { failureReason: critique.failureReason } : {}),
  };
}

/** review seam 빌더 — 실 게이트/critique 를 주입받아 cwd 에서 실행 → combineReview. critique 는 선택
 *  (없으면 게이트만·research §6 "테스트 게이트가 최고 신뢰"). */
export function buildReviewSeam(deps: {
  runGate: (cwd: string) => GateLike | Promise<GateLike>;
  runCritique?: (ctx: { objective: string; cwd: string; changes: readonly string[]; gate: GateLike }) => CritiqueLike | Promise<CritiqueLike>;
  cwd: () => string | undefined;
}): (ctx: { objective: string; changes: string[] }) => Promise<ReviewVerdict> {
  return async ({ objective, changes }) => {
    const cwd = deps.cwd();
    if (!cwd) {
      // 관측(제1원칙) — worktree 미생성은 배선 오류 신호. 조회=elanous logs --category harness.review.
      debug.log('harness.review', 'no-worktree', { objective: objective.slice(0, 80) });
      return { verdict: 'fail', findings: ['worktree 미생성(plan 먼저)'], mustFix: ['plan'] };
    }
    const gate = await deps.runGate(cwd);
    const critique = deps.runCritique ? await deps.runCritique({ objective, cwd, changes, gate }) : undefined;
    const verdict = combineReview(gate, critique);
    // ★ 관측(제1원칙·코드-레벨 로깅 규율) — 리뷰 판정의 입력 재료(게이트 통과·실패 스텝·critique verdict)와
    //   최종 verdict 를 남긴다. 이게 없으면 프레임워크가 "왜 fail 했나" 자기인지 못 하고 디버깅도 불가.
    debug.log('harness.review', 'verdict', {
      objective: objective.slice(0, 80),
      changes: changes.length,
      gatePassed: gate.passed,
      gateFailedSteps: (gate.steps ?? []).filter((s) => !s.ok).map((s) => s.name),
      critiqueVerdict: critique?.verdict ?? null,
      verdict: verdict.verdict,
      findings: verdict.findings.length,
    });
    return verdict;
  };
}
