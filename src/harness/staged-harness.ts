// 스몰-폼 에이전틱 하니스 — Planner→Executor→Reviewer→Deployer 순수 시퀀서 (H0 · 2026-07-20)
//
// DESIGN-cross-surface-autonomy-membrane §14. 엔진 노드①의 격상 — bare runGoalLoop(flat 툴 루프)에서
// 스테이지드 하니스로. 풀 미션 패브릭 아님(tox DB·coordinator·arc·lineage 없음) · 말/슬래시 트리거 상시 엔진.
//
// ★ 설계 = runSelfImplement 와 동형의 headless 순수 시퀀서: 모든 외부 작용(plan/execute/review/deploy)을 seam
//   으로 주입해 유닛 테스트 가능. 실 seam 어댑터(decompose·runGoalLoop·integrity-gate+critique·openPr)는 H1+.
// ★ 승격된 공용 primitive(cut 작전 C1~C6) 위에 딛는다:
//   - 문맥교환: state-channels(applyChannelUpdates·plan lastValue·changes/decisions/failures append)
//   - 코디네이션: progress-ledger(evaluateProgressLedger → continue/replan/escalate)
//   - 핸드오프: working-memory-format(StageHandoff = WorkingMemoryEntry 계약)
// ★ 제1원칙(대표 상시 지시): 모든 자율/셀프힐 판정에 관측을 남긴다 — observe(=debug.log('harness.<stage>')).
//   Ledger/verdict/autoDrive 결정은 입력 재료 digest 까지 계측(자기인지 갭 방지).

import { applyChannelUpdate, applyChannelUpdates, type ChannelReducers, type ChannelState } from '../agent-substrate/state-channels.js';
import { evaluateProgressLedger, type ProgressSignals, type LedgerRecommendation } from '../agent-substrate/progress-ledger.js';
import { debug } from '../debug/log.js';
import { persistReviewArtifact, type ReviewArtifactWriter } from '../agent-substrate/review-artifact.js';
// ★ P3(PLAN-reviewer-substrate-unification) — verdict 어휘를 substrate 단일 출처에서. 미션·하니스·CLI 통일.
import type { ReviewVerdict as ReviewVerdictKind } from '../agent-substrate/pr-reviewer.js';
// ★ C1/C3([[RFC-plan-as-rfc-generation]] §8) — plan 산출물에 경량 Context Capsule(설계 계약)과 plan-time 크기 신호를 실는다.
import type { HarnessContextCapsule } from '../self-implement/context-capsule.js';
import type { PlanSizing, CapsuleSeed } from './plan-sizing.js';
import { verifiedNonCodeOutcome, type DomainExecuteResult } from './skill-executor.js';
// ★ C4(§8·Waza 차용 B) — 실패 조사 원장(진단·렌즈·골루프 우선). 실패마다 Capsule 나침반 대비 원인/probe/verdict 기록.
import { openInvestigation, shouldHandoff, renderLedger, type FailureInvestigation } from './failure-ledger.js';
import { writeHarnessStageFrame } from './harness-screen.js';
import { getHarnessSpace } from './harness-space.js';

/** 하니스 채널 스키마 — 각 스테이지가 필드 소유(§15c 문맥교환 anti-downgrade·구조화 결정 append). */
export const HARNESS_CHANNEL_REDUCERS: ChannelReducers = {
  plan: 'lastValue',       // Planner 산출(최신 계획)
  changes: 'append',       // Executor 변경 누적
  decisions: 'append',     // 스테이지 결정 누적
  verdict: 'lastValue',    // Reviewer 최신 판정
  failures: 'append',      // 리뷰 실패/rework 이력
  deploy: 'lastValue',     // Deployer 결과
};

/** Reviewer 구조화 판정. verdict 어휘는 substrate 단일 출처(P3·pr-reviewer.ReviewVerdict). 하니스 뷰는
 *  findings(전체)+mustFix(블로커) — substrate ReviewResult(mustFix/shouldFix)와 매핑은 review-adapter. */
export interface ReviewVerdict {
  verdict: ReviewVerdictKind;
  findings: string[];
  mustFix?: string[];
  /** 실제 LLM 심사가 완료됐는가. diff 없음·fail-soft 통과와 실제 PASS를 구분한다. */
  reviewed?: boolean;
  /** reviewed=false인 fail-soft 리뷰가 실행되지 못한 원인. */
  failureReason?: string;
  /** 결정론 게이트(타입 래칫·시험)가 fail 의 출처일 때만 true — 다음 라운드는 래칫 편집(HARNESS-NEIGHBOR-SWEEP 계기). */
  gateFailed?: boolean;
}

/** 스테이지 핸드오프(§15c #2 — 재발명 말고 계약 재사용·WorkingMemoryEntry 동형 subset). */
export interface StageHandoff {
  summary: string;
  reusables?: string[];
  decisions?: string[];
  artifacts?: string[];
}

/** autoDrive 정책(§5 스펙트럼) — off=모든 상호작용 릴레이(풀HITL)·safe=저위험 자율/고위험만 escalate·
 *  on=처음부터 자율·escalation 0. H0 에선 escalation 지점의 terminal stage 라벨을 결정(막 배선은 H1+). */
export type AutoDrive = 'off' | 'safe' | 'on';

/** 각 스테이지의 외부 작용 — 주입 가능(테스트 fake·실 어댑터 H1+). */
export interface StagedHarnessSeams {
  /** ⓪ 명확화(인터뷰·opt-in·2026-07-21) — 모호한 objective 를 되묻고(intake 예산 1) 확정설계를
   *  refinedObjective 로 접는다(미션 intake 파이프라인 재사용). 미주입/autoDrive 'on' 이면 스킵.
   *  ★ C2(§8) — 인터뷰가 산출한 구조(scope/excluded/notes)를 capsuleSeed 로 반환하면 plan 이 Capsule 의
   *  successCriteria/outOfScope/riskBoundaries 로 승격(골루프 나침반). 미반환 시 종전(문자열 refine)만. */
  clarify?(ctx: { objective: string }): Promise<{ refinedObjective: string; asked: number; capsuleSeed?: CapsuleSeed }>;
  /** ⓪½ 리서치(front·opt-in·R1·2026-07-22) — plan 前 first-class 수집 스테이지. corpus 를 모아 objective 앞에
   *  grounding 으로 얹어 plan/execute 전체가 재사용(탐색 부담을 앞에서 흡수→헤비골 완주율↑). 미주입=스킵. */
  research?(ctx: { objective: string }): Promise<{ corpus: string }>;
  /** ① 계획 — objective → 스텝/수용기준. (H1: decompose 순수로직)
   *  ★ C1/C3(§8) — 산출에 경량 Context Capsule(planner/executor/reviewer 공유 설계 계약)과
   *  plan-time 크기 신호(sizing·soft)를 additive 로 실을 수 있다(둘 다 optional·미설정 시 종전과 동일).
   *  ★ C2(§8) — capsuleSeed(인터뷰 산출)를 받으면 Capsule 의 success/scope/risk 를 그걸로 채운다. */
  plan(ctx: { objective: string; priorFindings?: string[]; attempt?: number; capsuleSeed?: CapsuleSeed }): Promise<{ steps: string[]; handoff?: StageHandoff; capsule?: HarnessContextCapsule; sizing?: PlanSizing }>;
  /** ② 구현 — 계획 실행. priorReview 있으면 rework(리뷰 지적 반영). (H1: runGoalLoop) */
  execute(ctx: { objective: string; steps: string[]; priorReview?: ReviewVerdict; round: number }): Promise<{ ok: boolean; summary: string; changes: string[]; handoff?: StageHandoff }>;
  /** ③ 리뷰 — 구조화 verdict. (H1: integrity-gate 하드 + critique 소프트·별 family) */
  review(ctx: { objective: string; changes: string[] }): Promise<ReviewVerdict>;
  /** ④ 배포 — PR/머지 또는 apply-in-place(#25). (H1: openPr·approvePr fail-closed)
   *  kind: 'pr'=PR 개설 · 'branch'=브랜치 커밋·준비(PR 승인 대기·fail-closed) · 'none'=변경 없음 ·
   *  'applied'=비-git/config 타겟 실위치 적용(백업됨·ref=백업경로) · 'staged'=apply 승인 대기(그림자만·미적용).
   *  Non-code kinds require the shared domain proof contract when changes is empty. */
  deploy(ctx: { objective: string; summary: string; shouldFix?: string[]; verdict?: ReviewVerdictKind }): Promise<{ ok: boolean; ref?: string; kind?: 'pr' | 'branch' | 'none' | 'applied' | 'staged' | 'executed' | 'published' | 'signaled'; changes?: string[]; nonCodeEvidence?: DomainExecuteResult['nonCodeEvidence'] }>;
  /** 진행 push(막의 progress·§4) — 생략 시 no-op. */
  onProgress?(ev: { stage: HarnessStage; message: string }): void;
  /** Complete review output persistence. The reviewed log contains only the returned artifact path. */
  persistReviewArtifact?: ReviewArtifactWriter;
}

export type HarnessStage = 'research' | 'clarify' | 'plan' | 'execute' | 'review' | 'deploy';

/** Q2(자기서술·2026-07-22) — `elanous harness map` 이 소비하는 스테이지 파이프라인 SSOT. 실행 순서(order)·
 *  필수/opt-in(optional)·역할(role)을 한 곳에 서술해, 하니스가 자기 구조를 스스로 설명한다(제1원칙 자기인지).
 *  ⚠️ 순서는 시퀀서(runStagedHarness) 실제 실행 순서와 일치해야 함 — clarify→research→plan→execute→review→deploy. */
export interface HarnessStageMeta {
  readonly stage: HarnessStage;
  readonly order: number;
  readonly optional: boolean;
  readonly role: string;
}
export const HARNESS_STAGE_MAP: readonly HarnessStageMeta[] = [
  { stage: 'clarify', order: 0, optional: true, role: '명확화 — 모호한 objective 를 되묻고 확정설계(refinedObjective)로 접음. autoDrive on 이거나 미주입이면 스킵' },
  { stage: 'research', order: 1, optional: true, role: '리서치(front) — plan 前 수집 corpus 를 objective 앞 grounding 으로 얹어 이후 전 스테이지가 재사용. 미주입 스킵' },
  { stage: 'plan', order: 2, optional: false, role: '계획 — objective→스텝(휴리스틱/LLM decompose/adversarial 레드팀 보강) + 코드/skill/기억 grounding 팩트' },
  { stage: 'execute', order: 3, optional: false, role: '구현 — 계획 실행(goal-loop). plan.steps + grounding 을 프롬프트에 실음(Q1). priorReview 있으면 rework(자동수정)' },
  { stage: 'review', order: 4, optional: false, role: '리뷰 — integrity-gate(하드·tsc/test) + critique(소프트·별 family) 구조화 verdict. FAIL→execute 재진입' },
  { stage: 'deploy', order: 5, optional: false, role: '배포 — PR 개설 / 브랜치 준비 / apply-in-place(#25). 부작용은 fail-closed HITL(authorizeDeploy)' },
];

export type HarnessTerminal =
  | 'pr-opened'       // ✅ draft PR 개설(리뷰 후 operator 가 Ready→머지·fail-closed HITL). ⚠️ "deployed" 아님 — 머지 전
  | 'deployed'        // (예약) 실 머지/배포 — 현재 미사용(하니스는 draft PR 까지·머지는 HITL)
  | 'branch-prepared' // ✅ 브랜치 커밋·준비됨(PR 은 operator 승인 대기·fail-closed)
  | 'applied'         // ✅ #25 비-git/config 타겟 실위치 적용됨(백업됨·deployRef=백업경로)
  | 'apply-staged'    // ✅ #25 apply 승인 대기(그림자만 준비·미적용·HITL diff 확인 후 적용)
  | 'executed'        // ✅ Q3 #X2 비-코드 집행 완료(투자 주문 등·파일 변경 없음·deployRef=감사ref)
  | 'published'       // ✅ Q3 #X2 비-코드 게시 완료(웹 배포 등·deployRef=게시URL)
  | 'signaled'        // ✅ Q3 #X2 신호 산출 완료(판단층·부작용0·deployRef=신호요약)
  | 'no-changes'      // ⚠️ 구현이 실 변경을 남기지 않음(deploy 산출 0)
  | 'plan-only'       // ✅ 계획 산출만 반환(execute/review/deploy 미호출)
  | 'plan-empty'      // ① 계획 산출 없음
  | 'execute-failed'  // ② 구현 실패
  | 'review-diverged' // ③ review↔rework K라운드 초과(divergence 캡)
  | 'deploy-failed'   // ④ 배포 실패
  | 'escalated';      // HITL 필요(autoDrive off/safe·막 배선은 H1+)

export interface HarnessResult {
  /** Sequencer-resolved run id: explicit caller value or objective-slug fallback. */
  runId: string;
  ok: boolean;
  terminal: HarnessTerminal;
  rounds: number;                 // Execute→Review 라운드 수
  verdict?: ReviewVerdict;
  deployRef?: string;
  ledgerRecommendation?: LedgerRecommendation;
  detail?: string;
  state: ChannelState;            // 최종 채널 상태(plan/changes/verdict/failures/deploy)
  /** ★ C4(§8) — 실패 조사 원장(가설·probe·verdict·미충족 성공기준). 실패 terminal 에 첨부(HITL 번들·자기인지). */
  investigations?: FailureInvestigation[];
}

export interface StagedHarnessOptions {
  objective: string;
  seams: StagedHarnessSeams;
  /** autoDrive 정책(기본 safe). */
  autoDrive?: AutoDrive;
  /** review↔rework divergence 캡(기본 2·초과 시 escalate/abort). */
  maxReviewRounds?: number;
  /** ★ C4(§8·Waza 차용 B) 실패 원장 레벨(opt-in·기본 observe) — 'off'=원장 안 씀 · 'observe'(기본)=실패마다
   *  Capsule 나침반 대비 조사 기록·관측·handoff 번들 첨부(제어 흐름 무접촉·골루프 우선). 실제 루프 단축(handoff
   *  집행)은 미구현(대표 결정 대기) — 오늘 원장은 진단만. */
  ledgerMode?: 'off' | 'observe';
  /** ★ H2 replan 캡(기본 2 = DEFAULT_MAX_REPLANS · ⛔ 종전 1 이었고 #5399(2026-07-25)가 상향했다.
   *  이 주석이 그때 안 고쳐져 「기본 1」로 15줄 위에 남아 있었고, 그 문면이 문서 셋으로 번졌다) —
   *  divergence(review 반복 실패) 후 progress-ledger 가 'replan' 을 권고하면
   *  실패 findings 를 반영해 plan 을 재산출하고 execute→review 를 재시도한다. 0=replan 없음(종전 동작). */
  maxReplans?: number;
  /** 관측/식별용 run id(기본 objective 슬러그). */
  runId?: string;
  /** 'plan'이면 계획 산출 후 반환하며 execute/review/deploy를 호출하지 않는다. */
  stopAfter?: 'plan';
}

function slug(s: string): string {
  return (s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';
}

/** replan cap 기본값 — 종전 하드코딩 1 을 2 로 상향(2 라운드 안에 수렴 못하면 review-diverged 로 조기
 *  종료하던 도그푸드 관측 완화·다른-접근 재계획 1 회 더). */
const DEFAULT_MAX_REPLANS = 2;
/** 과도 반복 방어 상한 — 이보다 크면 오설정으로 보고 기본값으로 되돌린다. */
const MAX_REPLANS_CEILING = 20;

/** 순수 — replan cap 값 해석. **1..20 범위의 안전 정수만** 채택하고 그 외(소수·0·음수·범위초과·NaN·
 *  비숫자·undefined)는 기본 2. (종전 `v>0 ? Math.floor(v)` 는 0.5→0 을 채택해 replan 0 회로 만드는
 *  버그였음·review). 순수라 단위 테스트 가능. */
export function resolveMaxReplans(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_REPLANS_CEILING ? v : DEFAULT_MAX_REPLANS;
}

/**
 * 스테이지드 하니스 시퀀서. plan → (execute → review)* → deploy.
 *
 * Review verdict 라우팅(§15e): pass/warn → deploy · fail → rework(재-execute·divergence 캡) · 캡 초과 →
 * escalate(autoDrive off/safe) 또는 abort. progress-ledger 로 stall/escalate 판정. 모든 판정 observe(제1원칙).
 */
export async function runStagedHarness(opts: StagedHarnessOptions): Promise<HarnessResult> {
  const { seams } = opts;
  let objective = opts.objective; // ⓪ clarify 가 확정설계로 refine 할 수 있음(let)
  const autoDrive: AutoDrive = opts.autoDrive ?? 'safe';
  const maxReviewRounds = opts.maxReviewRounds ?? 2;
  const runId = opts.runId ?? slug(objective);
  let state: ChannelState = {};

  // 제1원칙 관측 관문 — 자율/셀프힐 판정을 카테고리 로그로(logs.db 도달). 입력 digest 포함(자기인지 갭 방지).
  const observe = (event: string, data: Record<string, unknown>): void => {
    try { debug.log('harness.sequencer', event, { runId, ...data }); } catch { /* fail-soft */ }
  };
  const screenSpace = getHarnessSpace();
  const progress = (stage: HarnessStage, message: string): void => {
    observe('stage-enter', { stage, message });
    if (screenSpace?.id) writeHarnessStageFrame(screenSpace.id, stage, message);
    try { seams.onProgress?.({ stage, message }); } catch { /* best-effort */ }
  };

  // ★ C4(§8·Waza B) — 실패 조사 원장(진단·렌즈). observe 기본. 실패마다 Capsule 나침반 대비 조사 기록.
  //   ⚠️ 골루프 우선: 원장은 제어 흐름을 바꾸지 않는다(handoff 판정은 관측만·루프 캡은 종전대로).
  const ledgerMode = opts.ledgerMode ?? 'observe';
  const failureLedger: FailureInvestigation[] = [];
  const recordFailure = (inv: FailureInvestigation): void => {
    if (ledgerMode === 'off') return;
    failureLedger.push(inv);
    observe('investigation', { stage: inv.stage, attempt: inv.attempt, verdict: inv.verdict, unmet: inv.unmetCriteria.length, handoffSignal: shouldHandoff(failureLedger) });
  };

  observe('start', { objective: objective.slice(0, 120), autoDrive, maxReviewRounds });

  // ⓪ Clarify(인터뷰·opt-in) — 모호하면 되묻고 확정설계로 refine. autoDrive 'on'=완전자율(스킵)·
  //   off/safe=되묻기. 미주입 시 스킵(무영향). fail-soft. [[DESIGN §14b clarify seam]].
  // ★ C2(§8) — 인터뷰 산출 capsuleSeed(scope/excluded/notes → success/scope/risk)를 plan 에 전달해 Capsule 나침반을 채운다.
  let capsuleSeed: CapsuleSeed | undefined;
  if (seams.clarify && autoDrive !== 'on') {
    progress('clarify', '💬 요구 명확화(필요 시 되묻기)…');
    try {
      const c = await seams.clarify({ objective });
      if (c.refinedObjective && c.refinedObjective !== objective) objective = c.refinedObjective;
      if (c.capsuleSeed) capsuleSeed = c.capsuleSeed;
      observe('clarified', { asked: c.asked, refined: objective === opts.objective ? 0 : 1, seed: c.capsuleSeed ? { success: c.capsuleSeed.successCriteria?.length ?? 0, out: c.capsuleSeed.outOfScope?.length ?? 0, risk: c.capsuleSeed.riskBoundaries?.length ?? 0 } : 0 });
    } catch (e) { observe('clarify-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
  }

  // ⓪½ Research(front·opt-in·R1) — plan 前 first-class 수집 스테이지. seams.research 주입 시 corpus 를 모아
  //   objective 앞에 grounding 으로 얹는다(재조사 억제 프레이밍). clarify 후(refined objective)·plan 전에 실행해
  //   plan/execute 전체가 재사용 → 탐색+통합 헤비골의 "구현 前 탐색이 예산 소진"을 앞에서 흡수. 미주입=스킵(무회귀).
  if (seams.research) {
    progress('research', '🔎 사전 조사(수집)…');
    try {
      const r = await seams.research({ objective });
      if (r.corpus && r.corpus.trim()) {
        objective = `[사전 조사 corpus — 재조사 말고 이 자료를 우선 사용]\n${r.corpus.trim().slice(0, 3000)}\n\n---\n\n${objective}`;
        observe('researched', { chars: r.corpus.length });
      } else observe('researched', { chars: 0 });
    } catch (e) { observe('research-failed', { error: String((e as { message?: string })?.message ?? e).slice(0, 120) }); }
  }

  // ① Plan (+ ★ H2 replan 루프 — divergence 시 ledger 권고면 실패 findings 반영 재계획).
  // cap 기본 2(종전 하드코딩 1 은 2 라운드 안에 수렴 못하면 게이트 통과에도 review-diverged 로 조기 종료·
  //   도그푸드 반복 관측). opts.maxReplans 명시는 resolveMaxReplans 검증(1..20 안전정수) 경유(0·음수·소수·
  //   NaN 우회 차단). ⚠️user-config 노브는 로더가 미등록 키를 strip 해 실동작 불가(실증 확인) → config-first
  //   는 정식 스키마 등록(후속) 전까지 미도입, 지금은 상수 기본 + opts.
  const maxReplans = opts.maxReplans === 0 ? 0
    : opts.maxReplans !== undefined ? resolveMaxReplans(opts.maxReplans) : DEFAULT_MAX_REPLANS;
  progress('plan', '🗺️ 계획 수립…');
  let plan = await seams.plan({ objective, ...(capsuleSeed ? { capsuleSeed } : {}) });
  state = applyChannelUpdate(state, 'plan', plan, HARNESS_CHANNEL_REDUCERS);
  observe('planned', {
    steps: plan.steps.length,
    ...(plan.capsule ? { capsule: 1, successCriteria: plan.capsule.successCriteria.length } : {}),
    ...(plan.sizing ? { oversized: plan.sizing.oversizedCount, tooSmall: plan.sizing.tooSmallCount, underDecomposed: plan.sizing.underDecomposed } : {}),
  });
  // ★ C3(§8) — plan-time 크기 신호는 **soft**(관측·권고). 체계적 under-decomposition(과대 스텝 ≥2) 의심 시
  //   경고만 남긴다(자동 재분해 안 함 — 하드 집행은 대표 결정 대기). executor 무한 split 로 떠넘기던 걸 plan 에서 가시화.
  if (plan.sizing?.underDecomposed) {
    observe('plan-under-decomposed', { oversized: plan.sizing.oversizedCount, sample: plan.sizing.grades.filter((g) => g.verdict === 'too_large').slice(0, 3).map((g) => g.phaseTitle.slice(0, 60)) });
  }
  if (!plan.steps.length) {
    observe('terminal', { terminal: 'plan-empty' });
    return { runId, ok: false, terminal: 'plan-empty', rounds: 0, detail: '계획 산출 없음', state };
  }
  if (opts.stopAfter === 'plan') {
    debug.log('staged-harness', 'stop-after-plan', { runId, steps: plan.steps.length });
    return { runId, ok: true, terminal: 'plan-only', rounds: 0, state };
  }

  let round = 0;
  let review: ReviewVerdict | undefined;
  let replans = 0;
  let ledgerRec: LedgerRecommendation = 'continue';

  // 바깥 replan 루프 — 안쪽은 execute→review divergence 루프. verdict pass/warn 이면 탈출→deploy.
  replanLoop: while (true) {
    // ② Execute → ③ Review 루프(divergence 캡)
    round = 0;
    review = undefined;
    // 이번 계획 시도의 리뷰 실패 수(replan 마다 리셋) — replan 은 fresh 접근이라 consecutiveFailures 는
    //   현 시도 기준(누적 state.failures 아님). 안 그러면 replan 후 누적 실패로 escalate 가 replan 캡보다 먼저 발동.
    let attemptReviewFails = 0;
    const residualPayload = (): Record<string, unknown> => {
      const uniquePathTokens: string[] = [];
      const seenPathTokens = new Set<string>();
      for (const token of plan.steps.flatMap((step) => step.split(/\s+/))) {
        if (token.includes('/') && /\.[A-Za-z]{1,4}$/.test(token) && !seenPathTokens.has(token)) {
          seenPathTokens.add(token);
          uniquePathTokens.push(token);
        }
      }
      return {
        remainingSteps: plan.steps.length,
        reviewRounds: round,
        consecutiveReviewFails: attemptReviewFails,
        investigations: failureLedger.length,
        planPathTokens: uniquePathTokens.slice(0, 20),
        ...(uniquePathTokens.length > 20
          ? { planPathTokensTruncated: true, planPathTokensTruncatedCount: uniquePathTokens.length - 20 }
          : {}),
      };
    };
    while (round < maxReviewRounds) {
      round++;
      progress('execute', `🔨 구현 (라운드 ${round})…`);
      const exec = await seams.execute({ objective, steps: plan.steps, round, ...(review ? { priorReview: review } : {}) });
      state = applyChannelUpdates(state, exec.changes.map((c) => ({ channel: 'changes', value: c })), HARNESS_CHANNEL_REDUCERS);
      observe('executed', { round, ok: exec.ok, changes: exec.changes.length });
      if (!exec.ok) {
        // 구현 실패 — 제1원칙 ②: 셀프힐(리뷰 루프의 rework)로 못 푸는 하드 실패는 autoDrive 게이트로.
        //   off/safe → escalate(HITL·막 배선 H1+) · on → 자율 abort. 관측 관문에 판정 근거 남김.
        state = applyChannelUpdate(state, 'failures', { phaseId: 'execute', title: `execute r${round}` }, HARNESS_CHANNEL_REDUCERS);
        // ★ C4 — 실패 조사 기록(Capsule 나침반 대비). 구현 실패는 실행-근거로 확인(supported).
        recordFailure(openInvestigation({
          stage: 'execute', attempt: round, symptoms: [exec.summary.slice(0, 200)],
          hypothesis: exec.changes.length === 0 ? '구현이 진전 없음(스톨·변경 0)' : '구현 실패(gate/실행 오류)',
          probe: 'exec.ok · changes 수', expectedIfTrue: 'ok=false', observed: `ok=${exec.ok}·changes=${exec.changes.length}`,
          verdict: 'supported', evidenceRefs: [exec.summary.slice(0, 80)],
          ...(plan.capsule ? { capsule: plan.capsule } : {}),
        }));
        const terminal: HarnessTerminal = autoDrive === 'on' ? 'execute-failed' : 'escalated';
        observe('terminal', { terminal, reason: 'execute-failed', round, autoDrive, handoffSignal: shouldHandoff(failureLedger) });
        return { runId, ok: false, terminal, rounds: round, detail: [exec.summary, renderLedger(failureLedger)].filter(Boolean).join('\n\n'), state, ...(failureLedger.length ? { investigations: failureLedger } : {}) };
      }

      progress('review', '🔎 리뷰…');
      review = await seams.review({ objective, changes: exec.changes });
      state = applyChannelUpdate(state, 'verdict', review, HARNESS_CHANNEL_REDUCERS);
      let reviewArtifactPath: string | undefined;
      try {
        reviewArtifactPath = (seams.persistReviewArtifact ?? persistReviewArtifact)({
          origin: 'staged-harness-review', runId, round, verdict: review.verdict,
          findings: review.findings, mustFix: review.mustFix,
        }).path;
      } catch {
        observe('review-artifact-failed', { round, verdict: review.verdict });
      }
      observe('reviewed', {
        round, verdict: review.verdict, findings: review.findings.length,
        ...(review.reviewed !== undefined ? { reviewed: review.reviewed } : {}),
        ...(reviewArtifactPath ? { artifactPath: reviewArtifactPath } : {}),
      });

      if (review.verdict === 'pass' || review.verdict === 'warn') break;

      // fail → rework. 실패 이력 append(문맥교환 — 다음 라운드가 회상)·현 시도 실패 카운트 증가.
      state = applyChannelUpdate(state, 'failures', { phaseId: 'review', title: `review_fail r${round}` }, HARNESS_CHANNEL_REDUCERS);
      // ★ C4 — 리뷰 미통과 조사(Capsule 나침반 대비). findings 있으면 원인 지지(supported), 없으면 미결(inconclusive).
      recordFailure(openInvestigation({
        stage: 'review', attempt: round, symptoms: review.findings.slice(0, 4),
        hypothesis: `리뷰 미통과 — ${review.findings[0]?.slice(0, 80) ?? '지적 있음(내역 없음)'}`,
        probe: 'review.verdict · findings', expectedIfTrue: 'verdict=fail·findings>0',
        observed: `verdict=${review.verdict}·findings=${review.findings.length}`,
        verdict: review.findings.length > 0 ? 'supported' : 'inconclusive',
        ...(plan.capsule ? { capsule: plan.capsule } : {}),
      }));
      attemptReviewFails++;
    }

    // 코디네이션 — progress-ledger 로 stall/replan/escalate 판정(승격된 C3 primitive 사용).
    const signals: ProgressSignals = {
      totalPhases: 1, donePhases: review?.verdict === 'pass' || review?.verdict === 'warn' ? 1 : 0,
      failedPhases: review?.verdict === 'fail' ? 1 : 0,
      consecutiveFailures: review?.verdict === 'fail' ? attemptReviewFails : 0,
      maxPhaseAttempts: round, orphanPendingWrites: 0,
    };
    ledgerRec = evaluateProgressLedger(signals, { maxStalls: maxReviewRounds }).recommendation;
    observe('ledger', { recommendation: ledgerRec, rounds: round, attemptFails: attemptReviewFails, verdict: review?.verdict, replans });

    if (review?.verdict !== 'fail') break;   // pass/warn → deploy

    // ★ H2 in-loop replan — divergence(리뷰 반복 실패) + ledger 가 'replan' 권고 + 캡 미초과면, 실패
    //   findings 를 반영해 plan 을 재산출하고 execute→review 를 처음부터 재시도(다른 접근). 관측 관문.
    //   plan seam 이 attempt(브랜치 suffix·worktree 충돌 회피)+priorFindings(다른 계획)를 받는다.
    if (ledgerRec === 'replan' && replans < maxReplans) {
      replans++;
      const priorFindings = review.findings ?? [];
      // 셀프힐 판정 관측(제1원칙) — 왜 재계획하는지 근거(findings digest)까지.
      observe('replan', { replans, cap: maxReplans, findings: priorFindings.length, sample: priorFindings.slice(0, 3).map((f) => f.slice(0, 60)) });
      observe('replan-residual', residualPayload());
      progress('plan', `🗺️ 재계획 (replan ${replans}/${maxReplans}·이전 실패 반영·다른 접근)…`);
      plan = await seams.plan({ objective, priorFindings, attempt: replans, ...(capsuleSeed ? { capsuleSeed } : {}) });
      state = applyChannelUpdate(state, 'plan', plan, HARNESS_CHANNEL_REDUCERS);
      observe('replanned', { replans, steps: plan.steps.length });
      if (!plan.steps.length) {
        observe('terminal', { terminal: 'plan-empty', afterReplan: replans });
        return { runId, ok: false, terminal: 'plan-empty', rounds: round, detail: `재계획 산출 없음(replan ${replans})`, state };
      }
      continue replanLoop;   // 새 계획으로 execute→review 재시도
    }

    // divergence 캡(+replan 캡) 초과 — autoDrive 로 escalate vs abort(막 배선은 H1+·여기선 terminal 라벨).
    const terminal: HarnessTerminal = autoDrive === 'on' ? 'review-diverged' : 'escalated';
    observe('terminal', { terminal, reason: 'review-diverged', autoDrive, replans, handoffSignal: shouldHandoff(failureLedger) });
    observe('diverged-residual', residualPayload());
    const divergeDetail = `리뷰 ${maxReviewRounds}라운드 미통과${replans ? ` (replan ${replans}회 후)` : ''}`;
    return { runId, ok: false, terminal, rounds: round, ...(review ? { verdict: review } : {}), ledgerRecommendation: ledgerRec, detail: [divergeDetail, renderLedger(failureLedger)].filter(Boolean).join('\n\n'), state, ...(failureLedger.length ? { investigations: failureLedger } : {}) };
  }
  const ledger = { recommendation: ledgerRec };

  // ④ Deploy
  // ★ ③구현이양(§3.3·2026-07-21) — warn(경미) 은 rework 로 막지 않고 proceed 하되, should-fix findings 를
  //   PR 메모로 **이양**(유실 방지·재작업 없이 후속 처리 위임). "경미 정련=구현 이양(메모)" 미션패브릭(#4821) 정합.
  const shouldFix = review?.verdict === 'warn' ? (review.findings ?? []) : [];
  if (shouldFix.length) observe('should-fix-carried', { count: shouldFix.length });
  progress('deploy', '🚀 배포…');
  const deploy = await seams.deploy({ objective, summary: `${round}라운드 완료·verdict=${review?.verdict}`, ...(shouldFix.length ? { shouldFix } : {}), ...(review?.verdict ? { verdict: review.verdict } : {}) });
  state = applyChannelUpdate(state, 'deploy', deploy, HARNESS_CHANNEL_REDUCERS);
  const deployChanges = deploy.changes ?? [];
  const isNonCodeKind = deploy.kind === 'published' || deploy.kind === 'executed' || deploy.kind === 'signaled';
  const nonCodeVerified = deploy.ok && deployChanges.length === 0 && verifiedNonCodeOutcome({
    outcome: deploy.kind === 'published' || deploy.kind === 'executed' ? deploy.kind : undefined,
    ref: deploy.ref,
    nonCodeEvidence: deploy.nonCodeEvidence,
  });
  observe('deployed', { ok: deploy.ok, kind: deploy.kind ?? null, ref: deploy.ref ?? null, changes: deployChanges.length, nonCodeEvidence: deploy.nonCodeEvidence ?? null, nonCodeVerified });
  // ⚠️ 버그A 수정: kind 로 정직한 terminal 을 고른다 — 'deployed'(PR 개설)를 빈 브랜치/no-PR 에도
  //    찍던 공수표를 제거. dev-harness 툴 메시지가 terminal 을 그대로 노출하므로 자동 정직해진다.
  // ⭐ 「리뷰 판정이 실제로 돌았나」는 **모든** terminal 관측이 실어야 한다(true/false/null 삼상태).
  //    ⛔ 조기 반환 둘이 이 값을 빼면 원장에서 그 두 종단만 「모름」이 되어, 수용 기준(「항상」)이 깨진다.
  const reviewExecuted = review?.reviewed ?? null;
  if (deploy.kind === 'none') {
    observe('terminal', { terminal: 'no-changes', reviewExecuted });
    return { runId, ok: false, terminal: 'no-changes', rounds: round, ...(review ? { verdict: review } : {}), detail: '구현이 실 변경을 남기지 않음', state };
  }
  if (!deploy.ok) {
    observe('terminal', { terminal: 'deploy-failed', reviewExecuted });
    return { runId, ok: false, terminal: 'deploy-failed', rounds: round, ...(review ? { verdict: review } : {}), detail: '배포 실패', state };
  }

  // #25 apply 타겟(비-git/config): 'applied'=실위치 적용(백업됨) · 'staged'=HITL 승인 대기(그림자만).
  // Q3 #X2 비-코드: executed(집행)·published(게시)·signaled(신호). deploy seam 이 changedFiles===0 이어도
  //   execute 의 비-코드 outcome 이 있으면 이 kind 를 반환 → no-changes 로 안 빠짐.
  const terminal: HarnessTerminal =
    deploy.kind === 'applied' ? 'applied'
    : deploy.kind === 'staged' ? 'apply-staged'
    : deploy.kind === 'branch' ? 'branch-prepared'
    : deploy.kind === 'executed' && nonCodeVerified ? 'executed'
    : deploy.kind === 'published' && nonCodeVerified ? 'published'
    : isNonCodeKind ? 'no-changes'
    : 'pr-opened';
  observe('terminal', { terminal, rounds: round, changes: deployChanges.length, nonCodeEvidence: deploy.nonCodeEvidence ?? null, nonCodeVerified, reviewExecuted, ...(review?.reviewed !== undefined ? { reviewed: review.reviewed } : {}) });
  return { runId, ok: terminal !== 'no-changes', terminal, rounds: round, ...(review ? { verdict: review } : {}), ...(deploy.ref ? { deployRef: deploy.ref } : {}), ledgerRecommendation: ledger.recommendation, ...(terminal === 'no-changes' ? { detail: '검증된 비-코드 증거 없이 변경이 없음' } : {}), state };
}
