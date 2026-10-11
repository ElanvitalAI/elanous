// ── 페이즈 산출물 결정론 비평 (R0 · 대표 지시 2026-07-12) ────────────────────
//
// SE 격리 자율 구현이 만든 페이즈 산출물(변경 파일 + diff)을 LLM 없이 결정론으로 비평한다.
// 2026-07-12 memory-lifecycle dogfood 6 PR 리뷰에서 확정된 실패 유형을 겨냥:
//   ① 범위밖 변경 — 페이즈 PLAN 이 지목 안 한 파일 수정(특히 mission-engine 코어 훼손).
//   ② Goodhart — 테스트 통과 위해 프로덕션 코드 삭제 + 테스트 동시 변경.
// (dead-code·회귀는 R0.5/게이트(#3856 동적스코프)가 담당 — 이 모듈은 순수·빠른 1차 필터.)
//
// 순수함수(단위테스트·실 dogfood 케이스 회귀 픽스처). nocturnal-runner built 경로가 gate 뒤·
// makePr 전에 호출해 PR 본문에 비평을 첨부하고 verdict 를 기록한다.

/** 비평 판정 — pass(문제 없음) / warn(범위밖 등 경고·PR 은 만들되 표시) / fail(코어 훼손·Goodhart). */
export interface CritiqueResult {
  verdict: 'pass' | 'warn' | 'fail';
  outOfScope: string[];
  goodhartSuspect: boolean;
  findings: string[];
}

/** 코어 민감 경로 — 페이즈 범위 밖에서 이게 바뀌면 fail(자율 구현이 건드리면 안 되는 오케스트레이션). */
const CORE_SENSITIVE = /^src\/autopilot\/mission-|^src\/autopilot\/(arming|safety)|^src\/nexus\/|^src\/index\.ts/;

/** planBody(페이즈 PLAN md)에서 명시 언급된 파일 경로 추출(src|scripts|test|apps/…확장자). 순수. */
export function planReferencedFiles(planBody: string): Set<string> {
  const set = new Set<string>();
  for (const m of planBody.matchAll(/(?:src|scripts|test|apps)\/[\w./-]+\.\w+/g)) set.add(m[0]);
  return set;
}

/** 변경 파일이 plan 범위 내인가 — 정확 언급 또는 언급된 파일과 같은 디렉토리면 관대 처리. */
function inScope(file: string, referenced: Set<string>): boolean {
  if (referenced.has(file)) return true;
  const dir = file.replace(/[^/]+$/, ''); // 파일의 디렉토리
  return [...referenced].some((r) => r.replace(/[^/]+$/, '') === dir);
}

/** ★ 결정론 비평(R0) — 순수함수. changedFiles=격리 변경 파일, planBody=페이즈 PLAN, diff=git diff.
 *  범위밖(코어 민감이면 fail·아니면 warn) + Goodhart(프로덕션 삭제 + 테스트 변경) 을 flag. */
export function critiquePhaseDeterministic(input: {
  planBody: string;
  changedFiles: string[];
  diff: string;
}): CritiqueResult {
  const referenced = planReferencedFiles(input.planBody);
  const findings: string[] = [];

  // ① 범위밖 — plan 에 언급 안 된 src/scripts/apps 변경(테스트/문서는 관대).
  const outOfScope: string[] = [];
  for (const f of input.changedFiles) {
    if (!/^(src|scripts|apps)\//.test(f)) continue;
    if (/\.test\.tsx?$/.test(f)) continue; // 테스트 파일은 범위 판단서 제외(검증 페이즈 등)
    if (!inScope(f, referenced)) outOfScope.push(f);
  }
  const coreViolation = outOfScope.some((f) => CORE_SENSITIVE.test(f));
  if (outOfScope.length) {
    findings.push(`범위밖 변경 ${outOfScope.length}건: ${outOfScope.slice(0, 4).join(', ')}${coreViolation ? ' (★코어 민감 — 훼손 의심)' : ''}`);
  }

  // ② Goodhart — 프로덕션(.ts non-test) 삭제 라인 + 테스트 파일 동시 변경.
  const touchesTest = input.changedFiles.some((f) => /\.test\.tsx?$/.test(f));
  const touchesProd = input.changedFiles.some((f) => /^src\/.*(?<!\.test)\.tsx?$/.test(f));
  const hasProdDeletion = /\n-\s*(export |function |const |if \(|return |await )/.test(input.diff);
  const goodhartSuspect = touchesTest && touchesProd && hasProdDeletion;
  if (goodhartSuspect) {
    findings.push('Goodhart 의심: 프로덕션 코드 삭제 + 테스트 동시 변경(테스트 통과 위한 프로덕션 훼손?)');
  }

  const verdict: CritiqueResult['verdict'] =
    coreViolation || goodhartSuspect ? 'fail' : outOfScope.length ? 'warn' : 'pass';
  return { verdict, outOfScope, goodhartSuspect, findings };
}

/** verdict 심각도 비교 — 더 나쁜 쪽 반환(fail > warn > pass). */
export function worseVerdict(a: CritiqueResult['verdict'], b: CritiqueResult['verdict']): CritiqueResult['verdict'] {
  const rank = { pass: 0, warn: 1, fail: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/** R1 LLM 비평 프롬프트(diff + 페이즈 목표 → 범위·중복·품질·안전 비평). ASCII+한글(agent 정책). */
/** ★ 분할 서브페이즈 감지(대표 지시 2026-07-12·순수) — splitPhaseIntoSubphases 가 심는 "[분할 N/M]"
 *  마커. 이런 페이즈는 더 큰 기능을 의도적으로 쪼갠 한 조각이라, 새 필드/export 가 아직 안 쓰여도
 *  (dead) 후속 서브페이즈가 배선한다 → dead-code·범위밖-파일 요구로 잡으면 위양성(dogfood: KGS
 *  스키마 서브페이즈가 sqlite-store 만 고쳤는데 비평이 pack/write 미수정으로 FAIL). */
export function isSplitSubphasePlan(planBody: string): boolean {
  return /\[\s*분할\s*\d+\s*\/\s*\d+\s*\]/.test(planBody);
}

export function buildCritiquePrompt(input: { planBody: string; changedFiles: string[]; diff: string }): string {
  const isSplit = isSplitSubphasePlan(input.planBody);
  return [
    'You are a strict code reviewer for an autonomous coding agent PR. Review the diff for a single mission phase.',
    'Judge: (1) scope creep (files not in the plan), (2) duplication (reimplementing existing modules instead of extending), (3) dead code (new exports never wired), (4) Goodhart (deleting production logic to pass tests), (5) correctness/safety.',
    ...(isSplit ? [
      '',
      '★ IMPORTANT — This phase is ONE PIECE of a larger feature intentionally split into sub-phases (note the "[분할 N/M]" marker in the plan below).',
      '- New schema columns / fields / exports added here may be WIRED BY LATER sub-phases. Do NOT flag them as dead code merely because they are not yet consumed.',
      '- Do NOT demand edits to files outside THIS sub-phase\'s stated scope (e.g. do not require pack/write/query changes when this sub-phase is schema-only). Those are separate sub-phases.',
      '- Judge ONLY whether THIS sub-phase\'s own acceptance criteria are met. FAIL only for real problems inside this scope: scope creep OUT of the plan, Goodhart (deleting logic to pass tests), or incorrectness.',
    ] : []),
    '',
    '## Phase plan', input.planBody.slice(0, 2000),
    '## Changed files', input.changedFiles.join('\n'),
    '## Diff (truncated)', input.diff.slice(0, 6000),
    '',
    'Reply in Korean. First line exactly one of: VERDICT: PASS | VERDICT: WARN | VERDICT: FAIL. Then up to 4 concise findings (one per line, prefixed with "- ").',
  ].join('\n');
}

/** 판정 줄 — «줄 머리» VERDICT 만 판정으로 읽는다(본문 중간 인용·설명 속 «VERDICT:» 오인 방지).
 *  들여쓰기는 허용(mission-engine 의 미션 판정 파서와 같은 앵커). */
const CRITIQUE_VERDICT_LINE = /^[ \t]*VERDICT:\s*(PASS|WARN|FAIL)/im;
/** 판정 줄이 없을 때 findings 에 남기는 fail-closed 사유(REVIEW-NO-VERDICT-FAILCLOSED #25937). */
const NO_VERDICT_FINDING = '비평 판정 줄(VERDICT) 없음 — 판정 없음은 통과가 아니다(fail-closed · REVIEW-NO-VERDICT-FAILCLOSED #25937)';
const MAX_CRITIQUE_FINDINGS = 4;

/** LLM 응답 파싱 → verdict + findings. 순수함수(LLM node 규칙).
 *  ⛔ 판정 줄이 «없으면» pass 로 기본하지 않는다(칸 MISSION-CRITIQUE-FAILCLOSED · #25937):
 *  «판정 없음 = 통과 아님» ⇒ verdict 'warn' + 사유 finding.
 *  'fail' 이 아니라 'warn' 인 이유 — 소비측(nocturnal-runner)은 critique verdict==='fail' 에
 *  gate-failed(재구현 요구)를 건다. «비평가 응답의 형식 결함»을 «구현 훼손」으로
 *  오귀속시키는 것이다. 'warn' 은 PR 본문(renderCritique)·자율 원장에 그대로 표시되어 사람(HITL)이 판단한다.
 *  (post-PR 리뷰 축 parseReviewResult 는 substrate 가 `reviewed:false` 로 같은 fail-closed 를 이미 한다.) */
export function parseLLMCritique(text: string): { verdict: CritiqueResult['verdict']; findings: string[] } {
  const bullets = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  const vm = CRITIQUE_VERDICT_LINE.exec(text);
  if (!vm) return { verdict: 'warn', findings: [NO_VERDICT_FINDING, ...bullets].slice(0, MAX_CRITIQUE_FINDINGS) };
  return { verdict: vm[1]!.toLowerCase() as CritiqueResult['verdict'], findings: bullets.slice(0, MAX_CRITIQUE_FINDINGS) };
}

/** ★ R1 결정론 + LLM 비평(대표 2026-07-12) — 결정론(R0) 먼저, llmReview 주입 시 LLM 심층 비평
 *  병합(더 나쁜 verdict + findings 합침). llmReview 미주입/실패 시 결정론만(fail-soft). */
export async function critiquePhaseWithLLM(
  input: { planBody: string; changedFiles: string[]; diff: string },
  llmReview?: (prompt: string) => Promise<string>,
): Promise<CritiqueResult> {
  const det = critiquePhaseDeterministic(input);
  if (!llmReview) return det;
  try {
    const raw = await llmReview(buildCritiquePrompt(input));
    const llm = parseLLMCritique(raw);
    return {
      verdict: worseVerdict(det.verdict, llm.verdict),
      outOfScope: det.outOfScope,
      goodhartSuspect: det.goodhartSuspect,
      findings: [...det.findings, ...llm.findings.map((f) => `[LLM] ${f}`)],
    };
  } catch { return det; } // LLM 실패 시 결정론만(자율 파이프라인 무중단).
}

/** 비평 결과를 PR 본문/알림용 markdown 으로 렌더. */
export function renderCritique(r: CritiqueResult): string {
  const icon = r.verdict === 'pass' ? '✅' : r.verdict === 'warn' ? '⚠️' : '⛔';
  const head = `${icon} 자동 비평(R0): ${r.verdict.toUpperCase()}`;
  if (r.findings.length === 0) return `${head} — 결정론 체크 통과(범위 준수·Goodhart 없음).`;
  return `${head}\n${r.findings.map((f) => `- ${f}`).join('\n')}`;
}

// ── 자율 PR 리뷰 — substrate 승격 (PLAN-reviewer-substrate-unification 2026-07-20) ──
//
// PR 리뷰어 계약/함수(reviewPullRequest·buildReviewPrompt·parseReviewResult·renderReview·diff 예산
// 절단 일가·ReviewResult/ReviewInput/ReviewVerdict)는 src/agent-substrate/pr-reviewer.ts 로 승격됐다
// (C 작전 다음 컷·DESIGN-cross-surface-autonomy-membrane §14). 미션·하니스·CLI(elanous self review)·
// self-implementation 이 하나의 리뷰어를 공용 소비 → drift 방지. 여기선 기존 import 처 무접촉을 위한
// re-export(C1 동형·회귀0) + PhaseResult 브릿지(reviewToPhaseFields·미션 결합이라 잔류)만 둔다.
export {
  reviewPullRequest, buildReviewPrompt, parseReviewResult, renderReview,
  reviewDiffCharLimit, splitDiffByFile, budgetFileDiff, budgetedDiff, diffSection,
  DIFF_TRUNCATION_RULES,
  worseReviewVerdict,
} from '../agent-substrate/pr-reviewer.js';
export type { ReviewResult, ReviewInput, ReviewVerdict } from '../agent-substrate/pr-reviewer.js';
import type { ReviewResult } from '../agent-substrate/pr-reviewer.js';

/** 리뷰 결과 → PhaseResult 필드(critiqueVerdict/critiqueFindings). fail=mustFix 를 findings 로(재작업
 *  유발) · warn=shouldFix(PR 코멘트) · pass=빈 결과. [CRITIQUE:verdict] 각인 → rebuild 경로 재사용.
 *  ★ 미션 결합(PhaseResult 브릿지)이라 substrate 아닌 여기 잔류. */
export function reviewToPhaseFields(r: ReviewResult): { critiqueVerdict?: 'warn' | 'fail'; critiqueFindings?: string[] } {
  if (r.verdict === 'fail') return { critiqueVerdict: 'fail', critiqueFindings: r.mustFix };
  if (r.verdict === 'warn' && r.shouldFix.length) return { critiqueVerdict: 'warn', critiqueFindings: r.shouldFix };
  return {};
}
