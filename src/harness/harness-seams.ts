// 하니스 실 seam 팩토리 — StagedHarnessSeams 를 실 인프라에 배선 (H1 · 2026-07-20)
//
// DESIGN §14b. H0 의 fake seam 을 실 어댑터로: plan=heuristic·execute=SelfImplement implement(헤드리스
// goal-loop)·review=integrity-gate+critique(review-adapter)·deploy=openPr(fail-closed). 재발명 금지 —
// runSelfImplement 의 defaultSeams(createWorktree/implement/gate/openPr)를 재사용하고, Planner+critique
// Reviewer+divergence 루프를 하니스가 얹는다(runSelfImplement 의 일반화).
//
// ★ 제1원칙(코드-레벨 로깅 규율·대표 상시 지시): worktree 생성·execute·review·deploy 판정을 모두 관측
//   (observe=debug.log('harness.seams'))한다. 관측이 없으면 프레임워크가 자기인지·힐링 못 하고 디버깅도 불가.
//   조회 = elanous logs --category harness.seams.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseHeuristicPlan } from '../autopilot/planner.js';
import type { CodebaseGrounding } from '../autopilot/mission-codebase-gate.js';
import type { SelfImplementSeams } from '../self-implement/orchestrator.js';
import { changedFiles, commitWorktree, worktreeDiff } from '../self-implement/seams.js';
import { verifiedNonCodeOutcome, type DomainExecute, type DomainExecuteResult } from './skill-executor.js';
import { reviewDiffBudgetObservation, reviewPullRequest, renderReview } from '../agent-substrate/pr-reviewer.js';
import { buildReviewSeam, gateEvidenceNote, reviewResultToCritiqueLike, type GateLike, type CritiqueLike } from './review-adapter.js';
import { buildExecuteProgressJudge } from './execute-progress-judge.js';
import type { StagedHarnessSeams } from './staged-harness.js';
import { debug } from '../debug/log.js';
import { releasePathHold, releasePathHoldComment, RELEASE_PATH_LABEL } from '../self-dev/release-path-guard.js';
import { setEventLoopActivity } from '../debug/event-loop-watchdog.js';
import { nestInfo } from '../agent/nest-depth.js';
import { originObservationFields } from '../agent/origin-observation.js';
// ★ C1/C3([[RFC-plan-as-rfc-generation]] §8) — plan-time 크기 게이트 + 경량 Context Capsule(설계 계약).
import { buildHarnessCapsuleFromPlan, gradePlanSteps, renderCapsuleDigest } from './plan-sizing.js';
import { persistContextCapsule } from '../self-implement/context-capsule-store.js';
import { getHarnessSpace, resolveRunIdentity } from './harness-space.js';
import type { AutonomyRiskHit, HarnessGroundingRef } from '../self-implement/context-capsule.js';
import { AUTO_REVIEW_LABEL, resolveAutoReviewLabels } from '../self-implement/context-capsule.js';
import { verbatimOriginalAsk } from '../self-implement/goal-author.js';
import { isSupervisorDecisionSection, splitGoalSections, supervisorGoalDigest } from '../self-implement/goal-digest.js';

const AUTOREVIEW_SENTENCE_LIMIT = 240;
const SECURITY_RISK_REASON = '보안/인증 정보';

function observedRiskHits(hits: readonly AutonomyRiskHit[]) {
  return hits.map(({ reason, match, sentence }) => {
    const sentenceTruncated = sentence.length > AUTOREVIEW_SENTENCE_LIMIT;
    return {
      reason,
      ...(reason === SECURITY_RISK_REASON ? {} : { match }),
      sentence: sentenceTruncated ? sentence.slice(0, AUTOREVIEW_SENTENCE_LIMIT) : sentence,
      ...(sentenceTruncated ? { sentenceTruncated: true } : {}),
    };
  });
}

export interface HarnessSeamsDeps {
  /** 재사용할 self-implement seam(createWorktree/implement/gate/openPr). */
  seams: SelfImplementSeams;
  /** ★ 트랙 X1 도메인 executor(opt-in) — 주입 시 execute 스테이지를 이걸로 대체(코드 implement 대신 skill/투자/
   *  배포 executor). 미주입=기본 코드 executor(goal-loop 파일편집·무회귀). 산출은 changes 로 Review/Deploy 공유. */
  domainExecute?: DomainExecute;
  /** PR base 브랜치. */
  base?: string;
  /** worktree 브랜치 prefix(기본 'harness'). */
  branchPrefix?: string;
  /** 소프트 critique(별 family·research §6 "judge=prioritizer"). 없으면 게이트만(하드). */
  runCritique?: (ctx: { objective: string; cwd: string; changes: readonly string[] }) => CritiqueLike | Promise<CritiqueLike>;
  /** ★ deploy fail-closed 게이트 — 실 PR open 은 이게 true 반환할 때만(자동승인 금지·제1원칙). 없으면
   *  PR 안 열고 브랜치만 준비(operator 가 막·HITL 로 승인 후 개설). */
  authorizeDeploy?: (ctx: { objective: string; branch: string; apply?: boolean; diff?: string }) => boolean | Promise<boolean>;
  /** ★ G9 즉효(2026-07-25·harness↔무인리뷰 대칭화) — auto-review 라벨 부착 인텐트. true 면 deploy 가 작업
   *  위험도 자기판단(assessAutonomyEligibility·fail-safe) 통과 시 PR 에 auto-review 라벨을 달아 L3 무인 리뷰
   *  폴러(review-watch) 대상으로 만든다(개발 라인 orchestrator §G8 과 대칭). 부적합이면 라벨 없이 사유 관측. */
  autoReview?: boolean;
  /** ★ LLM 리뷰어 seam(단일 주입) — 있으면 (1) Review 스테이지 critique(worktree diff → reviewPullRequest →
   *  실 FAIL+findings → rework 자동수정 트리거) (2) PR 제목 LLM 생성 (3) post-PR 자율 리뷰 커멘트. 미주입 시
   *  게이트-only 리뷰·heuristic 제목·리뷰 커멘트 스킵(테스트/오프라인 안전·behavior-preserving). */
  llmReview?: (prompt: string) => Promise<string>;
  /** ★ execute 내부 진행 emit(task#22 part2-B·M-UX 2·3차) — 있으면 goal-loop 델타를 judge 로 debounce 해
   *  마일스톤/stall 카드를 이 서피스로. 미주입 시 execute 내부 진행 push 없음(페이즈 카드만). */
  onExecuteProgress?: (msg: string) => void;
  /** ★ grounding seam(이식 §3.1·2026-07-21) — plan 이 objective 를 grounding(코드+skill+기억/문서 3박자)해
   *  Executor 자식에 재사용 팩트를 실는다. 기본 `groundMissionInCodebase`(미션패브릭 재사용). 테스트=fake 주입. */
  ground?: (objective: string) => Promise<CodebaseGrounding>;
  /** ⓪ clarify seam(인터뷰·opt-in·2026-07-21) — 모호 objective 되묻기→확정설계 refine. 막(ux.question)이
   *  필요해 membrane 에서 구성(membraneClarify). 미주입 시 스킵(sequencer 가 seam 없으면 clarify 건너뜀). */
  clarify?: (ctx: { objective: string }) => Promise<{ refinedObjective: string; asked: number }>;
  /** ★ 외부 research seam(H3·상황부·opt-in·2026-07-21) — objective 가 외부지식을 요할 때(intent-gate)만 web 조사
   *  (invokeResearch)해 grounding 블록에 얹는다(OMX $autoresearch→$ralplan 형). 미주입/게이트 미통과=스킵(경량). */
  research?: (topic: string) => Promise<{ ok: boolean; output: string }>;
  /** ★ skill 힌트 seam(H3·상황부·opt-in·2026-07-21) — objective 의 explicit 트리거가 특정 skill 을 강하게
   *  가리키면 grounding 힌트 1줄(buildSkillHint·결정론·실행 안 함). luna 의미매칭의 offline·cost-0 보완축.
   *  null=힌트 없음(스킵). 미주입 시 완전 no-op. */
  skillHint?: (objective: string) => string | null;
  /** ★ skill 실행 seam(H3 실행형·상황부·opt-in·2026-07-21) — objective 가 allowlist skill 을 강하게 가리키면
   *  그 skill 을 격리 실행(invokeResearch·Write/Edit deny)해 실제 출력을 grounding 에 얹는다. 실행되면 skillHint 는
   *  건너뜀(중복 회피). null=실행 안 함(hint 로 폴백). 미주입 시 no-op.
   *  ★ S1(2026-07-21): dev-harness 는 selectHarnessSkill(luna 의미매칭 주경로·substring fallback)을 주입 —
   *  source/picked 로 선택 경로를 실어 carry 관측(S4). 종전 execHarnessSkill(substring-only)도 구조 호환. */
  skillExec?: (objective: string) => Promise<{ skill: string; output: string; source?: 'luna' | 'substring'; picked?: string[] } | null>;
  /** ★ LLM decompose seam(H2·Planner·opt-in·2026-07-21) — 리스트마커 없는 자유서술 objective 를 richer 스텝으로
   *  분해(TaskGenerator 순수·DB-free). context=grounding 블록. []=분해 실패/불가 → 상위가 단일 스텝 유지(fail-soft).
   *  parseHeuristicPlan 이 마커를 잡으면 종전 휴리스틱 유지(무회귀). 미주입 시 no-op. */
  decompose?: (objective: string, context?: string) => Promise<string[]>;
  /** ★ adversarial 레드팀 seam(H2·Planner·opt-in·2026-07-21) — 계획을 실행 전 적대적 크리틱이 공격해 결함을
   *  찾아 보강된 스텝 반환(건전/실패=null→원 계획 유지). context=grounding. dev-harness 가 llmReview 로 주입. */
  adversarialPlan?: (objective: string, steps: readonly string[], context?: string) => Promise<{ revisedSteps: string[]; issues: string[] } | null>;
  /** ★ adversarial 강제 발동(명시 요청·red_team 파라미터/키워드). false 여도 복잡 계획(스텝≥임계)이면 자동 발동. */
  adversarialForce?: boolean;
  /** ★ R3 신호 게이트 seam(판단층·opt-in·2026-07-22) — objective(+R1 corpus)에서 종목을 뽑아 규율 신호
   *  (asset-attractiveness BUY/HOLD/SELL·±1σ)를 grounding 에 얹는다(판단 참고·집행 아님·부작용0). null=신호 없음
   *  (스킵). scores.db READ-ONLY 재사용. 미주입 시 no-op. domainExecute(executor·파일 write)와 층위 다름. */
  signalGate?: (objective: string) => string | null | Promise<string | null>;
  /** ★ C1 capsule carry([[RFC-plan-as-rfc-generation]] §8·[[FEATURE-execution-harness-umbrella]] §3k) — Context
   *  Capsule(설계 계약) digest 를 execute 프롬프트 앞에 실어 executor 가 목표·범위·성공기준·증거 계약을 명시 공유
   *  (Waza A "planner/executor/reviewer 가 같은 불변 계약"). **3-state(B 조건부 flip·대표 2026-07-23)**: `true`=항상
   *  carry · `false`=never · `undefined`(기본)=**auto**(인터뷰가 nav 를 실제 채웠을 때만 carry·일반 기본값뿐이면
   *  noise 라 안 실음). capsule 은 골루프를 자르지 않고 수렴을 **돕는** 나침반이라 destructive 아님. */
  carryCapsule?: boolean;
  /** ★ C3 sizing 레벨(opt-in 차용·§8) — plan-time 크기 게이트를 **어느 강도로** 켤지. ⚠️ 골루프의 힘 =
   *  "될 때까지 evidence-gated 반복"이고, plan 텍스트 예측으로 미리 자르면 그 힘을 죽인다(2026-07-19 text too_large
   *  게이트를 죽인 교훈·"크기는 실행해야 안다"). 그래서 sizing 은 **가름(gate)이 아니라 렌즈(lens)**로만 기본 동작:
   *  - 'off'   : sizing 완전 비활성 — 순수 골루프(계측조차 안 함).
   *  - 'observe'(기본): 채점·관측만(never cuts). 골루프 runway 무접촉 — 가시성만 준다.
   *  ▶ 실제 재분해(cut)는 **plan 예측이 아니라 실행-근거**(스톨·files≥5·골루프 자체 신호)로 트리거하는 opt-in
   *    상위 레벨(advise/enforce)에서만 — 그건 대표 hard/soft 결정 대기(project_archint_soft_vs_hard_enforcement).
   *    이 seam 은 그 두 레벨을 구현하지 않는다(오늘 골루프는 절대 pre-empt 되지 않음). */
  sizingMode?: 'off' | 'observe';
  /** 이미 아는 골 문서 원문(opt-in). 없으면 리뷰는 무골 경로를 유지한다 — objective 로 대체하지 않는다. */
  goalDocument?: string;
  /** postPrReview 의 gh 호출 주입(opt-in). 미지정 시 node:child_process spawnSync. */
  spawnSyncFn?: typeof spawnSync;
}

/** adversarial 자동 발동 임계 — 이 스텝 수 이상이면 명시 요청 없이도 레드팀(복잡할수록 결함 위험↑). */
export const ADVERSARIAL_AUTO_STEPS = 10;

/** 플래너 강도(heft). deep=고위험·다단계 → 강한 계획(레드팀 적극)·light=단순·국소 → 경량. standard=기본. */
export type PlanHeft = 'light' | 'standard' | 'deep';

/** 성공한 코드 접지가 센 구조 규모. steps는 레드팀 발동 비교값이므로 순환을 막기 위해 넣지 않는다. */
export interface PlanHeftSignals {
  files: number;
  codeFacts: number;
}

/** ★ Q6 플래너 heft 자동선택(순수·결정론·2026-07-22) — objective 성격과 성공한 접지 구조 규모로 계획 강도를
 * 분류한다. signals 생략 시 기존 키워드/길이 휴리스틱과 바이트 동일하게 동작한다. 구조 신호가 있으면 files와
 * codeFacts 합계 2 이하=light, 3~7=standard, 8 이상=deep으로 25표본의 세 구간을 모두 가른다. */
export function classifyHeft(objective: string, signals?: PlanHeftSignals): PlanHeft {
  const t = objective.trim();
  if (/리팩토링|리팩터|refactor|마이그레이션|migrat|재설계|아키텍처|architect|전반|여러\s*파일|multiple files|rewrite|overhaul|대대적|전면/i.test(t)) return 'deep';
  if (t.length <= 60 && /오타|typo|문구|주석|rename|이름\s*바꿔|한\s*줄|간단|사소|\bnit\b|고쳐만|수정만/i.test(t)) return 'light';
  if (!signals) return 'standard';
  const structuralSize = signals.files + signals.codeFacts;
  return structuralSize >= 8 ? 'deep' : structuralSize <= 2 ? 'light' : 'standard';
}

/** heft 별 adversarial 자동발동 임계(스텝 수). deep=8·standard=10·light=12로 과잉 발동을 제한한다. */
export function adversarialThreshold(heft: PlanHeft): number {
  return heft === 'deep' ? 8 : heft === 'light' ? 12 : ADVERSARIAL_AUTO_STEPS;
}

/** 외부 research intent-gate(보수적·경량) — objective 가 **명시적으로** 외부/최신 지식을 요할 때만 true.
 *  평소 elanous-self 코딩 objective 는 내부 grounding 으로 충분 → false(비용 0). smarter LLM 게이트는 후속. */
function needsExternalResearch(objective: string): boolean {
  return /리서치|research|조사해|최신|latest\b|how to|공식 문서|official docs|외부 api|spec\b|rfc\s?\d/i.test(objective);
}

/** PR 제목 — llmReview 있으면 LLM 한 줄 요약(conventional-commit), 없으면 objective 첫 줄(heuristic). */
async function buildPrTitle(objective: string, files: readonly string[], diff: string, llmReview?: (p: string) => Promise<string>): Promise<string> {
  const fallback = prTitle(objective);
  if (!llmReview) return fallback;
  try {
    // ★ C2(2026-07-25·diff-driven) — 제목이 objective 뿐 아니라 **실제 변경(파일+diff)**을 반영하게(conventional
    //   type/scope 가 무엇이 바뀌었나에 맞음·리뷰#5343: 파일명만으론 부족). claude-code-fork 기법(diff→제목).
    const fileList = files.slice(0, 25).map((f) => `- ${f}`).join('\n') || '(파일 목록 없음)';
    const raw = await llmReview(
      'You are naming a pull request. Output ONE line only — a concise PR title in the objective\'s language, '
      + 'conventional-commit style (feat/fix/refactor/docs/...). ≤72 chars. The type/scope must reflect what '
      + 'actually changed (see the file list AND the diff). No quotes, no trailing period.\n\n'
      + `Objective:\n${objective.slice(0, 500)}\n\nChanged files:\n${fileList}\n\nDiff (truncated):\n${diff.slice(0, 2500)}`,
    );
    const t = raw.trim().split('\n')[0]!.replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 72);
    return t || fallback;
  } catch { return fallback; }
}

/** PR 본문 — ★ C2(2026-07-25·diff-driven): llmReview 가 있으면 **실제 worktree diff** 를 리뷰어 LLM 에 먹여
 *  `## Summary`(불릿)+`## Why`+`## Test plan`(체크리스트)를 생성(claude-code-fork 기법). llmReview 미주입/
 *  diff 없음/오류 시 heuristic 폴백(objective+파일목록+요약·무회귀). shouldFix(§3.3)는 두 경로 공통으로 이양.
 *  ★ shouldFix: review warn(경미) findings 를 rework 로 막지 않고 PR 메모로 이양(비블로킹·머지 차단 아님). */
async function buildPrBody(
  objective: string, files: readonly string[], summary: string, diff: string,
  llmReview?: (p: string) => Promise<string>, shouldFix?: readonly string[],
): Promise<string> {
  const footer = '🤖 elanous **dev-harness** (Planner→Executor→Reviewer→Deployer) 자율 생성';
  const shouldFixBlock = (shouldFix && shouldFix.length)
    ? ['', '## 후속 개선 (should-fix · 비블로킹 · 리뷰가 경미로 판정 — 머지 차단 아님)', ...shouldFix.slice(0, 10).map((f) => `- ${f}`)]
    : [];
  const heuristic = (): string => [
    '## 목표', objective.trim(), '',
    `## 변경 (${files.length}개 파일)`, ...files.map((f) => `- \`${f}\``), '',
    '## 검증', summary || '(요약 없음)',
    ...shouldFixBlock, '', '---', footer,
  ].join('\n');
  if (!llmReview || !diff.trim()) return heuristic();
  try {
    const raw = await llmReview(
      'You are writing a pull request description from a git diff. Output GitHub markdown with EXACTLY these '
      + 'sections and nothing else (in the objective\'s language):\n'
      + '## Summary\n(1-3 bullets — what changed and why)\n'
      + '## Why\n(1-2 sentences — the problem/motivation)\n'
      + '## Test plan\n(a checklist grounded in the verification summary below)\n'
      // ★ 리뷰#5343 반영 — Test plan 은 **실제 실행된 검증(summary)**만 반영·완료된 테스트를 지어내지 말 것.
      + 'IMPORTANT: the Test plan MUST reflect ONLY what the "Verification summary" confirms actually ran. '
      + 'Do NOT invent passing tests. No preamble, no surrounding code fence.\n\n'
      + `Objective:\n${objective.slice(0, 400)}\n\nVerification summary (what actually ran):\n${summary.slice(0, 600) || '(없음)'}\n\nDiff (truncated):\n${diff.slice(0, 6000)}`,
    );
    const body = raw.trim();
    // ★ 리뷰#5343 반영 — 필수 구조(## Summary) 검증. 없으면 임의/비구조 응답이므로 heuristic 폴백(허위 게시 차단).
    if (!body || !/^\s*##\s*Summary/im.test(body)) return heuristic();
    return [body, ...shouldFixBlock, '', '---', footer].join('\n');
  } catch { return heuristic(); }
}

/** 골 문서에서 `판정 신호` 절만 뽑아 리뷰 acceptance 로 쓴다. 계보 = self-implement seams. */
export function extractHarnessReviewAcceptance(goalDocument: string | undefined): { goal: string | undefined; acceptance: string | undefined } {
  let goal: string | undefined;
  try {
    goal = goalDocument?.trim() || undefined;
  } catch {
    return { goal: undefined, acceptance: undefined };
  }
  if (!goal) return { goal: undefined, acceptance: undefined };
  try {
    const acceptance = splitGoalSections(supervisorGoalDigest(goal, 3000).text)
      .find((section) => isSupervisorDecisionSection(section.title) && section.title.includes('판정 신호'))
      ?.body.trim() || undefined;
    return { goal, acceptance };
  } catch {
    return { goal, acceptance: undefined };
  }
}

function reviewAcceptanceObservation(goal: string | undefined, acceptance: string | undefined): { goalLoaded: boolean; acceptanceChars: number } {
  return { goalLoaded: Boolean(goal), acceptanceChars: acceptance?.length ?? 0 };
}

/** post-PR 자율 리뷰 — PR diff 를 reviewPullRequest 로 리뷰 → renderReview → `gh pr comment` 로 PR 에 게시.
 *  fail-soft(리뷰/게시 실패가 배포를 막지 않음). llmReview 미주입 시 스킵. */
export async function postPrReview(
  cwd: string,
  prNumber: number,
  objective: string,
  llmReview?: (p: string) => Promise<string>,
  spawnSyncFn: typeof spawnSync = spawnSync,
  goalDocument?: string,
): Promise<void> {
  if (!llmReview || !prNumber) return;
  try {
    const diff = spawnSyncFn('gh', ['pr', 'diff', String(prNumber)], { cwd, encoding: 'utf8', timeout: 25_000, maxBuffer: 12 * 1024 * 1024 });
    if (diff.status !== 0 || !diff.stdout.trim()) return;
    const { goal, acceptance } = extractHarnessReviewAcceptance(goalDocument);
    const review = await reviewPullRequest({
      prDiff: diff.stdout,
      phaseIntent: objective,
      ...(acceptance ? { acceptance } : {}),
    }, llmReview);
    spawnSyncFn('gh', ['pr', 'comment', String(prNumber), '--body', renderReview(review)], { cwd, encoding: 'utf8', timeout: 20_000 });
    debug.log('harness.seams', 'deployed-review', {
      number: prNumber, verdict: review.verdict, reviewed: review.reviewed,
      mustFix: review.mustFix.length, shouldFix: review.shouldFix.length,
      ...reviewAcceptanceObservation(goal, acceptance),
      ...reviewDiffBudgetObservation(review),
    });
  } catch { /* fail-soft — 자율 리뷰 실패가 배포를 막지 않는다 */ }
}

function slug(s: string): string {
  return (s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}
function prTitle(objective: string): string {
  const first = objective.split('\n')[0]!.trim();
  return first.length <= 72 ? first : `${first.slice(0, 69)}...`;
}

/** 실 seam 팩토리. worktree 를 plan 에서 1회 생성·execute/review/deploy 가 공유(cwd 클로저). */
/** ★ 이식(2026-07-21 · 미션패브릭 §3.1 "탐색 팩트=구조로 전달") — grounding 결과를 하니스 Executor 자식
 *  프롬프트에 실을 문자열 블록으로. 미션 walker 는 워킹메모리로 받지만 하니스 Executor 는 **별도 프로세스**
 *  (featurePrompt 문자열)라 여기서 접는다. `[skill:]`(계약)·`[code:]`(export 심볼)·`[memory:]`/`[self:]`/`[doc]`
 *  (참조 기억·자기이력·문서) 팩트 → 자식이 Read/추측 없이 재사용(재조사·재구현 환각 차단). grounded 아니면 ''. */
function groundingPromptBlock(g: CodebaseGrounding): string {
  if (!g.grounded) return '';
  const facts = [...(g.skillFacts ?? []), ...(g.codeFacts ?? []), ...(g.memoryFacts ?? [])];
  const lines: string[] = ['[기존 자산 grounding — 아래를 재조사·재구현하지 말고 그대로 재사용/확장하라. 웹 재검색 대신 이 로컬 canonical 참조를 직접 Read/Grep 하라]'];
  if (g.context.trim()) lines.push(g.context.trim());
  if (facts.length) {
    lines.push('', '재사용할 계약/심볼/참조(내용 직접 — Read 없이 보유):');
    for (const f of facts.slice(0, 20)) lines.push(`- ${f}`);
  }
  // ★ F1(refFacts 렌더 갭 수리·2026-07-22) — ~/source/ref 로컬 repo 참조([ref:name] path)가 grounding 에
  //   실려오지만 종전엔 프롬프트에 안 닿았다(skill/code/memory facts 만 렌더). F4 프레이밍(웹 재검색 대신 로컬
  //   canonical 직접 Read/Grep)을 강화해 별도 섹션으로 렌더 — executor 가 이 로컬 repo 를 재클론·웹검색 없이 소비.
  const refFacts = g.refFacts ?? [];
  if (refFacts.length) {
    lines.push('', '로컬 참조 repo(~/source/ref · 웹 검색·재클론 말고 이 경로를 직접 Read/Grep):');
    for (const f of refFacts.slice(0, 12)) lines.push(`- ${f}`);
  }
  // ★ F2(2026-07-25) — 상류 잡 capsule 팩트를 프롬프트에 렌더(refFacts 렌더 갭 선례와 동형). 이게 없으면
  //   ptyFacts 가 provenance 메타로만 기록되고 planner 에 안 닿아 handoff 가 cosmetic. downstream 이 상류
  //   목표·완료기준을 보고 중복 구현 말고 이어받거나 정합하게 한다.
  const ptyFacts = g.ptyFacts ?? [];
  if (ptyFacts.length) {
    lines.push('', '상류/병렬 잡 컨텍스트(관련 이전 작업의 목표·완료기준 — 중복 구현 말고 이어받거나 정합하라):');
    for (const f of ptyFacts.slice(0, 8)) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

export function buildHarnessSeams(deps: HarnessSeamsDeps): StagedHarnessSeams {
  let cwd: string | undefined;
  let branch: string | undefined;
  let groundBlock = ''; // ★ plan 에서 grounding 산출 → execute featurePrompt 에 주입(스테이지 간 문맥 전달)
  let groundingSignals: PlanHeftSignals | undefined;
  // ★ C1(§8) — plan 이 빌드한 Context Capsule digest(설계 계약) → carryCapsule 시 execute 프롬프트에 주입.
  //   groundingRefs = grounding 팩트의 provenance 참조(code/skill/memory/doc) — capsule 에 사실 배경으로 보존.
  let capsuleDigest = '';
  let groundingRefs: HarnessGroundingRef[] = [];
  // ★ Q3(X2 비-코드 종결상태·2026-07-22) — domainExecute(비-코드 executor)가 파일 변경 없이 낸 성과(집행/게시/
  //   신호)를 deploy 로 전달하는 클로저(cwd/branch 와 동형·스테이지 간 문맥). 코드 executor 경로는 미설정(무회귀).
  let nonCodeOutcome: { outcome: 'executed' | 'published' | 'signaled'; ref?: string; changes: string[]; nonCodeEvidence?: DomainExecuteResult['nonCodeEvidence'] } | undefined;
  const observe = (event: string, data: Record<string, unknown>): void => {
    try { debug.log('harness.seams', event, { runId, ...data }); } catch { /* fail-soft */ }
  };

  // ⭐ run identity(K) — #5476 이 implement seam 의 `runId` 를 **필수**로 만든 이유가 "새 seam 이 전파를
  //   조용히 빠뜨리는 걸 컴파일 시점에 막는다" 였는데, 정작 이 하니스 경로가 그 갭으로 남아 있었다
  //   (execute 가 runId 없이 호출 → 자식 goal-loop 이 join anchor 상실 → `elanous self run <runId>` 미조인).
  //   ★ 라운드마다 mint 하면 리워크 전체가 흩어지므로 **seams 1회 확정**(orchestrator:281 과 동일 규율).
  //   리졸버 계약: 상속(env `ELANOUS_RUN_ID`) 있으면 채택 → 없으면 canonical mint · env 무변경.
  //   ⚠️ `inherited: getHarnessSpace()?.runId` 를 명시로 넘기지 **않는다** — 리졸버가 미지정 시 읽는
  //      env 와 공간 객체의 출처가 동일(`getHarnessRunId`)이라 하중을 지지 않는 중복 인자이고,
  //      "배선돼 있다"는 인상만 만든다(#5484 리뷰 2R). 재발명 0 = SSOT 를 그대로 부른다.
  const { runId, source: runIdSource } = resolveRunIdentity();
  try {
    debug.log('run-identity', 'own', {
      runId, source: runIdSource, owner: 'harness-seams', nestDepth: nestInfo().depth, ...originObservationFields(),
    });
  } catch { /* fail-soft */ }

  // Review critique(소프트) — deps.runCritique 우선, 없으면 llmReview 로 substrate pr-reviewer 배선(C·H1):
  //   worktree diff(untracked 포함) → reviewPullRequest → 실 verdict/must-fix/should-fix →
  //   reviewResultToCritiqueLike → combineReview. FAIL 이면 staged-harness 가 rework(자동수정) 라우팅.
  const llmReview = deps.llmReview;
  const runCritique = deps.runCritique ?? (llmReview
    ? async (ctx: { objective: string; cwd: string; changes: readonly string[]; gate: GateLike }): Promise<CritiqueLike> => {
        setEventLoopActivity('harness:review:worktreeDiff');   // #24 — git add -N + git diff(비동기 git·이벤트루프 양보)
        const diff = await worktreeDiff(ctx.cwd);
        if (!diff.trim()) {
          const result = { verdict: 'pass' as const, mustFix: [], shouldFix: [], reviewed: false };
          observe('review.done', { verdict: result.verdict, reviewed: result.reviewed, mustFix: 0, shouldFix: 0, reason: 'no-diff' });
          debug.log('harness.review', 'unreviewed', { reviewed: result.reviewed, reason: 'no-diff' });
          return reviewResultToCritiqueLike(result);
        }
        const evidenceNote = gateEvidenceNote(ctx.gate);
        const { goal, acceptance } = extractHarnessReviewAcceptance(deps.goalDocument);
        setEventLoopActivity('harness:review:llm');   // #24 — reviewPullRequest(LLM·프롬프트 빌드)
        const result = await reviewPullRequest({
          prDiff: diff,
          phaseIntent: ctx.objective,
          ...(evidenceNote ? { evidenceNote } : {}),
          ...(acceptance ? { acceptance } : {}),
        }, llmReview);
        observe('review.done', {
          verdict: result.verdict, reviewed: result.reviewed ?? false,
          mustFix: result.mustFix.length, shouldFix: result.shouldFix.length,
          gateEvidenceLines: evidenceNote?.split(/\r?\n/).length ?? 0,
          ...reviewAcceptanceObservation(goal, acceptance),
          ...reviewDiffBudgetObservation(result),
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        });
        return reviewResultToCritiqueLike(result);
      }
    : undefined);
  const review = buildReviewSeam({
    runGate: async (c) => (await deps.seams.gate(c)) as GateLike,
    ...(runCritique ? { runCritique } : {}),
    cwd: () => cwd,
  });

  return {
    // ⓪ clarify — membrane 이 ux.question 배선해 주입(opt-in). 미주입 시 sequencer 가 스킵.
    ...(deps.clarify ? { clarify: deps.clarify } : {}),
    async plan({ objective, priorFindings, attempt, capsuleSeed }) {
      // ★ replan 진행-보존 수리(2026-07-22·관측 특정 결함) — 종전엔 attempt>0(재계획)마다 base(백지)에서
      //   `-r<n>` 새 worktree 를 만들어, 직전 라운드의 누적 작업(테스트 통과 코드)을 통째로 폐기했다. 실측
      //   (legC): near-done(테스트 pass·리뷰 findings 2건) 상태를 버리고 fresh Execute 가 4툴콜 changes:0 으로
      //   스톨 → execute-failed. priorFindings 는 아래에서 "피하라"로 이미 grounding 에 주입되므로, 재계획은
      //   **같은 worktree 위에서 다른 접근**을 시도하는 게 우월하다(진행 보존 + 지적 반영). 따라서 첫 계획
      //   (cwd 없음)만 worktree 를 생성하고, rework/replan(cwd 존재)은 그대로 재사용한다. 브랜치는 그대로라
      //   충돌도 없다(같은 worktree). [[REFACTOR-harness-entrypoint-observability-topology-2026-07-22]]
      if (!cwd) {
        const b = `${deps.branchPrefix ?? 'harness'}/${slug(objective)}`;
        const wt = await deps.seams.createWorktree({ branch: b, ...(deps.base ? { base: deps.base } : {}) });
        cwd = wt.path; branch = wt.branch;
      } else {
        observe('replan-reuse-worktree', { branch: branch ?? '', attempt: attempt ?? 0 });
      }
      const parsed = parseHeuristicPlan(objective);
      let steps = parsed && parsed.steps.length ? parsed.steps.map((s) => s.text) : [objective];
      // ★ 이식(§3.1) — 미션 grounding(코드+skill+기억/문서 3박자)을 재사용해 Executor 자식에 실을 팩트 확보.
      //   미션 walker 가 받는 [skill:]/[code:]/[memory:] 팩트를 하니스 Executor 도 받게(재조사·재구현 환각 차단).
      //   opt-in(deps.ground 주입 시만·production=dev-harness 가 groundMissionInCodebase 주입). fail-soft.
      //   관측 mission.grounding + harness.seams.grounded.
      if (deps.ground) {
        try {
          const g = await deps.ground(objective);
          groundBlock = groundingPromptBlock(g);
          groundingSignals = g.grounded ? { files: g.files.length, codeFacts: g.codeFacts.length } : undefined;
          // ★ C1(§8) — grounding 팩트를 capsule 의 provenance 참조로 보존(사실 배경일 뿐 files 승격 아님·mirage 가드 동형).
          groundingRefs = [
            ...(g.skillFacts ?? []).map((ref): HarnessGroundingRef => ({ ref: ref.slice(0, 200), provenance: 'skill' })),
            ...(g.codeFacts ?? []).map((ref): HarnessGroundingRef => ({ ref: ref.slice(0, 200), provenance: 'code' })),
            ...(g.memoryFacts ?? []).map((ref): HarnessGroundingRef => ({ ref: ref.slice(0, 200), provenance: 'memory' })),
            ...(g.refFacts ?? []).map((ref): HarnessGroundingRef => ({ ref: ref.slice(0, 200), provenance: 'doc' })),
            ...(g.ptyFacts ?? []).map((ref): HarnessGroundingRef => ({ ref: ref.slice(0, 200), provenance: 'pty' })),   // ★ F2 — 상류 잡 capsule grounding
          ].slice(0, 24);
          observe('grounded', { grounded: g.grounded, files: g.files.length, skillFacts: g.skillFacts.length, codeFacts: g.codeFacts.length, memoryFacts: g.memoryFacts.length, refFacts: (g.refFacts ?? []).length, ptyFacts: (g.ptyFacts ?? []).length });
        } catch (e) { groundBlock = ''; groundingSignals = undefined; groundingRefs = []; observe('ground-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ 외부 research(H3·상황부) — objective 가 외부지식을 요할 때만(intent-gate) web 조사 → grounding 블록에 얹음
      //   (Executor 도달 경로 재사용). OMX $autoresearch→$ralplan 형. 게이트 미통과=스킵(경량·비용 0). fail-soft.
      if (deps.research && needsExternalResearch(objective)) {
        observe('research-gate', { needed: true });
        try {
          const r = await deps.research(objective);
          if (r.ok && r.output.trim()) {
            const block = `[외부 조사(web) — 참고·검증 후 사용]\n${r.output.trim().slice(0, 1500)}`;
            groundBlock = groundBlock ? `${groundBlock}\n\n${block}` : block;
            observe('researched', { ok: true, chars: r.output.length });
          } else observe('researched', { ok: false });
        } catch (e) { observe('research-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ skill(H3·상황부) — 우선 skill 실행형(allowlist skill 을 격리 실행해 실 출력), 실행 못 하면 힌트형
      //   (결정론·실행 안 함·luna 보완축)으로 폴백. 둘 다 grounding 에 얹음. fail-soft. 미주입=스킵.
      let skillExecuted = false;
      if (deps.skillExec) {
        try {
          const exec = await deps.skillExec(objective);
          if (exec) debug.log('harness.skill', 'facts-carry', { found: exec.picked?.length ?? 1, delivered: exec.output.trim() ? 1 : 0 });
          if (exec && exec.output.trim()) {
            const block = `[skill '${exec.skill}' 실행 결과 — 참고·검증 후 사용]\n${exec.output.trim().slice(0, 1500)}`;
            groundBlock = groundBlock ? `${groundBlock}\n\n${block}` : block;
            skillExecuted = true;
            // S4 carry(제1원칙) — 선택 경로(luna 주경로/substring fallback)와 luna 픽 수를 executor 도달 지점에서 관측.
            observe('skill-executed', { skill: exec.skill, chars: exec.output.length, source: exec.source ?? 'unknown', picked: exec.picked?.length ?? 0 });
          }
        } catch (e) { observe('skill-exec-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      if (!skillExecuted && deps.skillHint) {   // 실행 안 됐을 때만 힌트(중복 회피)
        try {
          const hint = deps.skillHint(objective);
          if (hint && hint.trim()) {
            groundBlock = groundBlock ? `${groundBlock}\n\n${hint}` : hint;
            observe('skill-hinted', { hinted: true });
          } else observe('skill-hinted', { hinted: false });
        } catch (e) { observe('skill-hint-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ R3 신호 게이트(판단층·2026-07-22) — objective(+R1 corpus prepend)에서 종목을 뽑아 규율 신호
      //   (asset-attractiveness ±1σ)를 grounding 에 얹는다. 판단 참고일 뿐 집행 아님(부작용0·scores.db READ-ONLY).
      //   신호 없음/DB 부재=스킵. skillExec/skillHint 와 동형 append 패턴. fail-soft.
      if (deps.signalGate) {
        try {
          const sig = await deps.signalGate(objective);
          if (sig && sig.trim()) {
            groundBlock = groundBlock ? `${groundBlock}\n\n${sig}` : sig;
            observe('signal-gated', { signaled: true });
          } else observe('signal-gated', { signaled: false });
        } catch (e) { observe('signal-gate-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ H2 replan — 이전 실패 findings 를 grounding 에 얹어 재계획(decompose)과 Executor 가 같은 실수를
      //   반복하지 않게 회상시킨다. attempt 0(첫 계획)이면 없음. 재계획 시에만 신호.
      if (priorFindings && priorFindings.length > 0) {
        const fblock = `[이전 시도 실패 — 이번엔 다른 접근으로, 아래를 피하라]\n${priorFindings.slice(0, 8).map((f) => `- ${f}`).join('\n')}`;
        groundBlock = groundBlock ? `${groundBlock}\n\n${fblock}` : fblock;
        observe('replan-context', { findings: priorFindings.length, attempt: attempt ?? 0 });
      }
      // ★ H2 LLM decompose — 리스트마커 없는 자유서술 objective(통짜 1스텝)만 richer 분해(opt-in·fail-soft).
      //   마커가 있으면(parsed) 종전 휴리스틱 유지=무회귀. groundBlock 을 context 로 실어 재조사 없이 분해.
      //   빈 배열/실패=단일 스텝 유지. TaskGenerator(순수·DB-free) 재사용 — 미션 DB 무접촉(방화벽).
      if (!parsed && deps.decompose) {
        try {
          const decomposed = await deps.decompose(objective, groundBlock || undefined);
          if (decomposed.length > 0) {
            steps = decomposed;
            observe('decomposed', { steps: decomposed.length });
          } else observe('decomposed', { steps: 0 });
        } catch (e) { observe('decompose-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ H2 adversarial 레드팀 — 계획을 실행 前 적대 크리틱이 공격해 보강(대표 지시 2026-07-21). 발동:
      //   ①명시 요청(adversarialForce·red_team 파라미터/키워드) OR ②복잡 계획(스텝≥heft 임계) 자동.
      //   자동발동 임계를 objective heft 로 조절(deep=8·standard=10·light=12).
      //   크리틱 LLM 이 sound 판정 시 무변경(과잉 수정 금지). fail-soft(실패=원 계획 유지). observe 관문.
      const heft = classifyHeft(objective, groundingSignals);
      const autoThreshold = adversarialThreshold(heft);
      if (deps.adversarialPlan && (deps.adversarialForce || steps.length >= autoThreshold)) {
        const trigger = deps.adversarialForce ? 'forced' : 'auto-complex';
        try {
          const crit = await deps.adversarialPlan(objective, steps, groundBlock || undefined);
          if (crit && crit.revisedSteps.length > 0) {
            steps = crit.revisedSteps;
            observe('adversarial-revised', { trigger, heft, steps: steps.length, issues: crit.issues.length, sample: crit.issues.slice(0, 3).map((i) => i.slice(0, 60)) });
          } else observe('adversarial-sound', { trigger, heft, issues: crit?.issues.length ?? 0 });
        } catch (e) { observe('adversarial-failed', { trigger, error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
      }
      // ★ C3(§8) — plan-time 크기 **렌즈**(가름 아님). 미션 SSOT(gradePhaseCompletability) 재사용해 채점(텍스트-only·오탐0).
      //   ⚠️ 골루프 우선: 여기서 자르지 않는다 — sizing 은 관측/attach 만, execute 로 가는 steps 는 무접촉(골루프 runway 보존).
      //   'off'=계측조차 안 함(순수 골루프). 'observe'(기본)=채점·관측만. 실제 cut(재분해)은 실행-근거 트리거 opt-in 상위 레벨(대표 결정 대기).
      const sizingMode = deps.sizingMode ?? 'observe';
      const sizing = sizingMode === 'off' ? undefined : gradePlanSteps(steps);
      if (sizing && (sizing.oversizedCount || sizing.tooSmallCount)) {
        observe('plan-sizing', { mode: sizingMode, oversized: sizing.oversizedCount, tooSmall: sizing.tooSmallCount, underDecomposed: sizing.underDecomposed, sample: sizing.grades.filter((g) => g.verdict === 'too_large').slice(0, 3).map((g) => g.phaseTitle.slice(0, 60)) });
      }
      // ★ C1(§8) — plan 산출물로서의 경량 Context Capsule(설계 계약·Waza 차용 A). steps=inScope·gate=evidence.
      //   ★ C2(§8) — 인터뷰 씨앗(capsuleSeed)이 있으면 successCriteria/outOfScope/riskBoundaries 를 그걸로 승격
      //   (골루프 나침반 — 무엇이 done·범위밖·위험). 씨앗 없으면 휴리스틱 기본(무회귀). 빈 배열은 스킵(기본 폴백).
      //   순수 유지 위해 createdAt 주입. execute 프롬프트 carry 여부는 아래 B 조건부 flip(3-state auto)으로 결정.
      // ⛔⭐⭐ 비-코드 도메인엔 ***코드 게이트 성공기준을 주지 않는다*** — ***채울 수 없는 요구***이기 때문이다.
      //   📏 2026-08-11 73차 실측: 씨앗이 없으면 기본값이 *"계획된 모든 스텝이 구현되고 gate(tsc/test) 통과"*
      //     «한 줄»이고(24/24 동일), `--domain` 을 명시해도 그대로였다.
      //     ⇒ 조사·보고·게시 같은 objective 는 ***원리상 만족할 수 없고***, 실패 원장이 정확히 그 문장을
      //       *"미충족 성공기준"* 으로 찍었다(제 read-only 런 3/3).
      //   ⛔ 「무엇이 성공인가」를 여기서 «새로 정하지» 않는다 — 이 저장소가 이미 가진 «비-코드 종결»의
      //     말로 적는다(`verifiedNonCodeOutcome` 이 보는 것: 검증된 산출 ⊕ 그 증거).
      //   ⚠️ `evidenceRequired` 는 «안 건드린다» — 그쪽은 게이트·리뷰가 소비하므로 별개 착지다(남은 절반).
      const nonCodeSuccessCriteria = deps.domainExecute
        ? ['비-코드 도메인 실행이 «검증된» 산출을 남긴다 — 집행·게시·신호 중 하나와 그 증거(ref 또는 nonCodeEvidence)']
        : undefined;
      const capsule = buildHarnessCapsuleFromPlan({
        objective, steps, groundingRefs,
        ...(deps.base ? { target: deps.base } : {}),
        ...(capsuleSeed?.successCriteria?.length
          ? { successCriteria: capsuleSeed.successCriteria }
          : nonCodeSuccessCriteria ? { successCriteria: nonCodeSuccessCriteria } : {}),
        ...(capsuleSeed?.outOfScope?.length ? { outOfScope: capsuleSeed.outOfScope } : {}),
        ...(capsuleSeed?.riskBoundaries?.length ? { riskBoundaries: capsuleSeed.riskBoundaries } : {}),
        createdAt: new Date().toISOString(),
      });
      // ★ F2(2026-07-25) — 상류 잡이 자기 plan capsule 을 durable 스토어에 넣는다 → 하류 잡의 grounding
      //   검색-코퍼스(groundMissionInCapsules)가 관련도로 발견(dependsOn 없이 컨텍스트 교환·§11). 키=K 의 안정
      //   per-job 식별자(harness spaceId·getHarnessSpace)·없으면 branch/objective 폴백. persist 는 내부 fail-soft.
      persistContextCapsule(getHarnessSpace()?.id || branch || objective, capsule);
      // ★ B 조건부 flip(대표 결정 2026-07-23) — carryCapsule 3-state: true=항상 carry · false=never ·
      //   undefined(기본)=**auto**: 인터뷰가 nav(successCriteria/outOfScope/riskBoundaries)를 실제로 채웠을 때만 carry.
      //   일반 휴리스틱 기본값뿐이면 noise 라 안 실음 → 나침반이 의미 있을 때만 executor 에 도달(잠복 해소·순수 이득).
      const seedEnriched = !!(capsuleSeed && (capsuleSeed.successCriteria?.length || capsuleSeed.outOfScope?.length || capsuleSeed.riskBoundaries?.length));
      const shouldCarry = deps.carryCapsule === true || (deps.carryCapsule === undefined && seedEnriched);
      capsuleDigest = shouldCarry ? renderCapsuleDigest(capsule) : '';
      // ⛔⭐ 「성공기준이 «어디서» 왔나」를 값으로 낸다 — 개수만으로는 ***상수인 것을 못 본다***.
      //   📏 2026-08-11 73차 전수(24건): `successCriteria` 가 ***전부 1*** · `outOfScope` 가 ***전부 0*** 이었다.
      //     ⇒ 캡슐은 「골루프 나침반」인데 ***항해 필드 둘이 정보를 안 담고 있었다***(퇴화 검사 ⓐ·ⓑ).
      //   🔎 기전: 씨앗(clarify 인터뷰)이 없으면 `plan-sizing.ts` 가 ***하드코딩 한 줄***로 채운다 —
      //     *"계획된 모든 스텝이 구현되고 gate(tsc/test) 통과"*. 그리고 clarify 는 autoDrive=on 이면 «스킵»된다.
      //   🎯 ⇒ 📌 그래서 ***비-코드 objective(조사·보고)는 이 기준을 원리상 만족할 수 없다***(실측: read-only 런 셋이 전부 execute-failed).
      //   ⛔ 여기서 기준을 «바꾸지» 않는다 — 무엇이 성공인가는 설계 결정이다. ***상수라는 사실만 보이게 한다.***
      const successCriteriaSource = capsuleSeed?.successCriteria?.length ? 'seed' : nonCodeSuccessCriteria ? 'non-code-domain' : 'default';
      observe('capsule-built', { successCriteria: capsule.successCriteria.length, successCriteriaSource, inScope: capsule.inScope.length, outOfScope: capsule.outOfScope.length, riskBoundaries: capsule.riskBoundaries.length, groundingRefs: capsule.groundingRefs.length, seeded: !!capsuleSeed, seedEnriched, carried: shouldCarry });
      observe('planned', { branch: branch ?? '', worktree: (cwd ?? '').slice(-40), steps: steps.length, heuristic: !!parsed, grounded: !!groundBlock, heft, ...(sizing ? { oversized: sizing.oversizedCount } : {}) });
      return { steps, capsule, ...(sizing ? { sizing } : {}) };
    },

    async execute({ objective, steps, round, priorReview }) {
      setEventLoopActivity(`harness:execute:round-${round}`);   // #24 finer 마커(stall 시 정확 stage)
      if (!cwd) { observe('execute-no-worktree', { round }); return { ok: false, summary: 'worktree 미생성(plan 먼저)', changes: [] }; }
      // ★ 트랙 X1 — 도메인 executor 라우팅. 주입 시 코드 implement 대신 이걸로 실행(skill/투자/배포). rework 라운드면
      //   직전 리뷰 findings 를 전달(코드 executor 의 priorReview 반영 동형). 산출 changes 는 코드와 동일 경로로 Review/Deploy.
      if (deps.domainExecute) {
        // ★ 관측 보강(제1원칙·2026-07-23) — domain executor 실행 중(수 분) 진행을 표면/로그로 버블(종전 블라인드 해소).
        //   코드 executor 의 onExecuteProgress 와 동형 배선. 미주입이어도 observe 로 logs 도달.
        const domainProgress = (msg: string): void => {
          try { deps.onExecuteProgress?.(msg); } catch { /* fail-soft */ }
          observe('domain-progress', { round, msg: msg.slice(0, 120) });
        };
        const dr = await deps.domainExecute({
          objective, round, cwd, onProgress: domainProgress,
          ...(priorReview && priorReview.findings.length ? { priorFindings: priorReview.findings } : {}),
        });
        // 무변경 outcome은 producer별로 결합된 증거가 있을 때만 terminal 성공으로 승격한다.
        // generic은 이번 실행의 잔존 신규 artifact, web은 유효한 게시 URL, execution은 완료 action을 증명한다.
        // signaled는 운영 producer가 없고 어떤 증거와도 유효 조합이 아니므로 no-changes로 남는다.
        nonCodeOutcome = dr.ok && dr.changes.length === 0 && verifiedNonCodeOutcome(dr)
          ? { outcome: dr.outcome!, ref: dr.ref, changes: dr.changes, nonCodeEvidence: dr.nonCodeEvidence }
          : undefined;
        observe('executed', { round, ok: dr.ok, changes: dr.changes.length, executor: 'domain', outcome: dr.outcome ?? null, nonCodeOutcomePromoted: !!nonCodeOutcome, summary: dr.summary.slice(0, 100) });
        return { ok: dr.ok, summary: dr.summary, changes: dr.changes };
      }
      nonCodeOutcome = undefined;   // 코드 executor 경로 — 비-코드 outcome 없음(무회귀)
      // ★ 자동수정 상태머신(대표 2026-07-21): rework 라운드면 이전 리뷰 지적(findings)을 구현 프롬프트에
      //    주입 → 자식 goal-loop 이 그 블로커/should-fix 를 고치도록. Review FAIL → 여기로 재진입(staged-harness).
      const rework = priorReview && priorReview.verdict !== 'pass' && priorReview.findings.length > 0;
      const base = rework
        ? `${objective}\n\n[이전 리뷰 지적 — 반드시 반영해 수정하라]\n${priorReview!.findings.map((f) => `- ${f}`).join('\n')}`
        : objective;
      // ★ Q1(plan.steps 전달 갭 수리·2026-07-22) — plan seam 이 산출한 계획 스텝(휴리스틱/LLM decompose/
      //   adversarial-revised 로 richer 해진)을 executor 프롬프트에 실어, 플래너 노고가 유실되지 않게 한다.
      //   종전엔 execute seam 이 steps 를 구조분해에서 누락해 objective+grounding 만 전달 → 플래너 스텝이 executor
      //   에 안 닿았다(REFACTOR-harness-entrypoint-observability-topology §5). ⚠️ 무회귀 가드: steps 가 objective
      //   통짜 1스텝(마커·decompose 없음)이면 objective 중복이므로 주입 안 함 → 종전 문자열과 동일.
      const hasPlanSteps = steps.length > 1 || (steps.length === 1 && steps[0]!.trim() !== objective.trim());
      const planBlock = hasPlanSteps
        ? `[계획 — 이 스텝대로 구현]\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '';
      if (hasPlanSteps) observe('plan-steps-carried', { round, steps: steps.length });
      // ★ C1(§8·opt-in) — carryCapsule 이면 Context Capsule digest(설계 계약)를 맨 앞에 실어 executor 가
      //   목표·범위·성공기준·증거 계약을 명시 공유(Waza A). capsuleDigest 는 carryCapsule=false 시 ''(무회귀).
      if (capsuleDigest) observe('capsule-carried', { round });
      // ★ 이식(§3.1) — plan 에서 산출한 grounding 팩트 + 계획 스텝을 자식 프롬프트 앞에 실어 재조사·재구현 환각 차단.
      //   빈 블록은 filter 로 제거되므로 capsule/groundBlock/planBlock 모두 없으면 종전(base 단독)과 동일 = 무회귀.
      const feature = [capsuleDigest, groundBlock, planBlock, base].filter(Boolean).join('\n\n---\n\n');
      if (rework) observe('rework', { round, verdict: priorReview!.verdict, findings: priorReview!.findings.length });
      // ★ part2-B(M-UX 2·3차) — execute 내부 goal-loop 델타를 judge 로 debounce 해 마일스톤/stall 카드 emit.
      //   판단 결과는 관측(execute-milestone·제1원칙: 왜 떴나/안 떴나). 미주입 시 페이즈 카드만.
      const judge = deps.onExecuteProgress
        ? buildExecuteProgressJudge((msg) => {
            try { deps.onExecuteProgress!(msg); } catch { /* fail-soft */ }
            observe('execute-milestone', { round, msg: msg.slice(0, 90) });
          })
        : undefined;
      setEventLoopActivity(`harness:execute:round-${round}:implement`);   // #24 — 자식 goal-loop 구동 구간
      // ★ K run-identity — implement seam 은 runId 를 **필수**로 받는다(전파 누락을 타입이 막음).
      //   ⚠️ #5485 는 이 자리에서 `resolveRunIdentity()` 를 호출했는데, 리졸버는 **env 를 변경하지
      //      않으므로**(장수 데몬 identity bleed 방지 규율) `ELANOUS_RUN_ID` 미상속 경로에서는
      //      **라운드마다 새로 mint** 됐다 → 리워크 전체가 흩어져 `elanous self run <runId>` 미조인.
      //      그래서 seams 생성 시 1회 확정한 `runId` 를 쓴다(orchestrator:281 과 동일 규율).
      const r = await deps.seams.implement({ cwd, feature, runId, ...(judge ? { onProgress: judge } : {}) });
      // ⚠️ 버그A 수정(dogfood 2026-07-20): 하드코딩 `[]` 대신 워크트리 실 변경목록을 산출 —
      //    자식이 untracked 로 남긴 신규파일 포함. Reviewer 가 실 changeset 을 받는다.
      setEventLoopActivity(`harness:execute:round-${round}:changedFiles`);   // #24 — git diff/status(동기 spawnSync)
      const changes = changedFiles(cwd);
      observe('executed', { round, ok: r.ok, changes: changes.length, nonCodeOutcomePromoted: false, summary: r.summary.slice(0, 100) });
      return { ok: r.ok, summary: r.summary, changes };
    },

    review,

    async deploy({ objective, summary, shouldFix, verdict }) {
      if (!cwd || !branch) { observe('deploy-no-worktree', {}); return { ok: false, kind: 'none' }; }
      // ⚠️ 버그A 수정: 실 변경이 없으면 "deployed" 공수표 대신 정직히 no-changes 로 종료.
      const files = changedFiles(cwd);
      if (files.length === 0) {
        // ★ Q3(X2·2026-07-22) — 파일 변경이 없어도 비-코드 executor 가 성과(집행/게시/신호)를 냈으면 그 종결상태로
        //   종료(no-changes 오탐 방지). ⚠️ 부작용0 원칙: 실 집행(주문·게시)은 executor(X3)가 이미 수행하고 여기선
        //   라벨만 — deploy 는 authorizeDeploy 를 호출하지 않는다(집행 게이트는 executor 소유).
        if (nonCodeOutcome) {
          const artifactMissing = nonCodeOutcome.nonCodeEvidence === 'artifact-created'
            && (!nonCodeOutcome.ref || !existsSync(resolve(cwd, nonCodeOutcome.ref)));
          if (artifactMissing) {
            observe('deploy-noncode-blocked', { branch, outcome: nonCodeOutcome.outcome, ref: nonCodeOutcome.ref ?? null, reason: 'artifact-created-ref-missing' });
          } else {
            observe('deploy-noncode', { branch, outcome: nonCodeOutcome.outcome, ref: nonCodeOutcome.ref ?? null });
            return { ok: true, kind: nonCodeOutcome.outcome, changes: nonCodeOutcome.changes, ...(nonCodeOutcome.ref ? { ref: nonCodeOutcome.ref } : {}), ...(nonCodeOutcome.nonCodeEvidence ? { nonCodeEvidence: nonCodeOutcome.nonCodeEvidence } : {}) };
          }
        }
        observe('deploy-no-changes', { branch });
        return { ok: false, kind: 'none' };
      }
      // ★ #25 P2/P3 apply-in-place — 비-git dir/config 타겟은 PR 이 없다(seams.apply 존재). 그림자 diff 를
      //   HITL 로 확인 → 승인 시 백업 후 실위치 적용. ⚠️auto 금지(실 FS 쓰기·§4): authorizeDeploy 를 apply=true
      //   로 불러 막이 autoDrive 'on' 이어도 diff 확인을 강제하게 한다(미승인=그림자만·미적용·안전).
      if (deps.seams.apply) {
        const applyDiff = await worktreeDiff(cwd);   // 커밋 전 실 변경(제목 diff-driven·C2)
        const applyTitle = await buildPrTitle(objective, files, applyDiff, deps.llmReview);
        commitWorktree(cwd, applyTitle);          // 그림자에 커밋(diff 확정)
        const diff = await worktreeDiff(cwd);
        const authorized = deps.authorizeDeploy
          ? await deps.authorizeDeploy({ objective, branch, apply: true, diff })
          : false;
        if (!authorized) {
          observe('apply-fail-closed', { branch, files: files.length, reason: deps.authorizeDeploy ? 'declined' : 'no-approver' });
          return { ok: true, ref: 'staged', kind: 'staged' };   // 그림자만 준비·미적용(HITL 대기)
        }
        const res = deps.seams.apply({ cwd });
        observe('applied', { target: res.target.slice(-48), applied: res.applied, backup: res.backup.slice(-48) });
        return { ok: res.applied, ref: res.applied ? res.backup : 'staged', kind: 'applied' };
      }
      // A(대표 2026-07-21): PR 제목/본문 충실화 — objective 덤프/"1라운드 완료" 공수표 대체.
      const prDiff = await worktreeDiff(cwd);   // ★ C2 — diff 1회 계산해 제목·본문 공유(중복 호출 방지)
      const title = await buildPrTitle(objective, files, prDiff, deps.llmReview);
      const body = await buildPrBody(objective, files, summary, prDiff, deps.llmReview, shouldFix);
      // 커밋은 Deployer 소유(#4815)·HITL 게이트 아님 — PR 승인 여부와 무관하게 먼저 브랜치를 실체화한다
      //    (자식은 파일만 남기므로 이 커밋이 없으면 브랜치가 비어 "준비됨"이 거짓말이 된다).
      commitWorktree(cwd, title);
      // ★ fail-closed(제1원칙) — authorizeDeploy 없거나 false 면 PR 안 연다(브랜치만 준비·무단 PR 금지).
      const authorized = deps.authorizeDeploy ? await deps.authorizeDeploy({ objective, branch }) : false;
      if (!authorized) {
        observe('deploy-fail-closed', { branch, files: files.length, reason: deps.authorizeDeploy ? 'declined' : 'no-approver' });
        // 실패 아님 — 브랜치는 커밋되어 준비됨(ref=branch·kind=branch). PR 개설은 operator 승인(막·HITL) 후.
        return { ok: true, ref: branch, kind: 'branch' };
      }
      // ★ G9 즉효(2026-07-25·harness↔무인리뷰 대칭화) — 개발 라인(orchestrator §G8)과 동일하게, autoReview
      //   인텐트면 작업 위험도 자기판단(assessAutonomyEligibility·fail-safe) 통과 시 auto-review 라벨을 달아
      //   L3 폴러(review-watch)가 harness PR 도 무인 완결하게 한다(부적합=라벨 없이·사유 관측).
      // ★ 리뷰 반영(#5338) — evidenceRequired 를 하드코딩('tsc')하지 않고 **실제 review 게이트 결과**로 판정.
      //   deploy 는 verdict pass/warn 일 때만 도달(sequencer·fail→rework) = integrity-gate(tsc/test) 통과 →
      //   객관 증거 실존. verdict 미존재(방어)면 증거 없음→비적격(라벨 안 붙음·fail-safe·비-TS/도메인 오라벨 방지).
      // ★ G9 P1(2026-07-25) — G8 라벨 해석은 resolveAutoReviewLabels SSOT 공유(개발 라인 orchestrator §G8 과
      //   verbatim 중복 제거). ★제1원칙(관측·자기인지): auto-review 무인완결 자율 결정을 **서피스 무관 canonical
      //   카테고리 `autoreview.decision`** 로 관측 → `elanous logs --category autoreview.decision` 로 harness/
      //   self-implement/미래 runDevPipeline 결정을 한 창구로 전수 조회(기존 harness.seams·self-implement 분산 해소).
      const originalAsk = verbatimOriginalAsk(objective);
      const { labels, declineReasons, eligibility } = resolveAutoReviewLabels(!!deps.autoReview, {
        objective,
        ...(originalAsk !== null ? { originalAsk } : {}),
        ...(verdict ? { reviewVerdict: verdict } : {}),
        evidenceRequired: verdict ? ['review-gate'] : [],
      });
      if (deps.autoReview) debug.log('autoreview.decision', labels ? 'eligible' : 'declined', {
        surface: 'harness',
        branch,
        objective,
        eligible: eligibility?.eligible ?? false,
        riskHits: observedRiskHits(eligibility?.riskHits ?? []),
        suppressedRiskHits: eligibility?.suppressedRiskHits.length ?? 0,
        ...(declineReasons ? { reasons: declineReasons } : {}),
      });
      const pr = await deps.seams.openPr({ title, body, head: branch, ...(deps.base ? { base: deps.base } : {}), draft: true, cwd });
      let holdPath: string | undefined;
      let inspectionError: string | undefined;
      try {
        if (!deps.seams.readPrFiles) throw new Error('readPrFiles seam unavailable');
        const prFiles = await deps.seams.readPrFiles({ number: pr.number, cwd, ...(deps.base ? { base: deps.base } : {}) });
        if (!Array.isArray(prFiles) || !prFiles.every((path) => typeof path === 'string')) throw new Error('invalid PR file list');
        holdPath = releasePathHold(prFiles);
      } catch (error) {
        const rateLimited = error instanceof Error && (error as { rateLimited?: boolean }).rateLimited === true;
        inspectionError = rateLimited ? `rate-limit: ${String(error)}` : String(error);
      }
      if (holdPath) {
        const protectedPath = holdPath;
        const prCwd = cwd;
        debug.log('self-dev.merge', 'release-path-hold', { number: pr.number, path: protectedPath, label: RELEASE_PATH_LABEL });
        for (const [action, annotate] of [
          ['add-label', deps.seams.addPrLabel && (() => deps.seams.addPrLabel!({ number: pr.number, label: RELEASE_PATH_LABEL, cwd: prCwd }))],
          ['comment', deps.seams.postPrComment && (() => deps.seams.postPrComment!({ number: pr.number, body: releasePathHoldComment(protectedPath), cwd: prCwd }))],
        ] as const) {
          if (!annotate) { observe('release-path-annotation-failed', { number: pr.number, action, error: 'annotation seam unavailable' }); continue; }
          try { await annotate(); } catch (error) { observe('release-path-annotation-failed', { number: pr.number, action, error: String(error) }); }
        }
        observe('deployed-pr', { number: pr.number, url: pr.url, autoReview: false, mergeReason: 'release-path-hold' });
      } else if (inspectionError) {
        observe('release-path-inspection-failed', { number: pr.number, error: inspectionError });
        observe('deployed-pr', {
          number: pr.number,
          url: pr.url,
          autoReview: false,
          mergeReason: inspectionError.startsWith('rate-limit:')
            ? 'release-path-inspection-failed: rate-limit'
            : 'release-path-inspection-failed',
        });
      } else {
        let autoReviewLabeled = false;
        if (labels?.includes(AUTO_REVIEW_LABEL)) {
          if (deps.seams.addPrLabel) {
            try {
              await deps.seams.addPrLabel({ number: pr.number, label: AUTO_REVIEW_LABEL, cwd });
              autoReviewLabeled = true;
              observe('auto-review-labeled', { branch, number: pr.number, label: AUTO_REVIEW_LABEL });
            } catch (error) { observe('auto-review-label-failed', { number: pr.number, error: String(error) }); }
          } else observe('auto-review-label-failed', { number: pr.number, error: 'addPrLabel seam unavailable' });
        }
        observe('deployed-pr', { number: pr.number, url: pr.url, autoReview: autoReviewLabeled });
      }
      // B(대표 2026-07-21): post-PR 자율 리뷰 — 리뷰기가 PR 에 커멘트(fail-soft). 게이트가 놓친 품질 블로커 표면화.
      await postPrReview(cwd, pr.number, objective, deps.llmReview, deps.spawnSyncFn ?? spawnSync, deps.goalDocument);
      return { ok: true, ref: pr.url, kind: 'pr' };
    },
  };
}
