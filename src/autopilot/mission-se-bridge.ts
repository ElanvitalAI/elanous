// ── 미션 fabric ↔ Self-Evolution 브릿지 (2단계 실코드 구현 · 2026-07-12) ─────
//
// walker(run-mission.ts)는 운영 행위만 한다 — 코어 코드(src/·apps/·test/) 편집은
// guardCoreCodeEdits 가 자동 되돌린다. 따라서 "구현" 페이즈(실 코드/테스트 작성 필요)는
// walker 로는 막다른 길이다(편집→되돌림→거짓 완료). 이 브릿지가 미션 fabric 의 2단계를 잇는다:
//   1단계(walker): 조사/설계/문서/검증-관측/스케줄 등록 페이즈 → 에이전트 턴(현행).
//   2단계(SE):     구현·테스트저작 페이즈 → 격리 worktree 자율 구현(runNocturnalOne) →
//                  IMMUTABLE_CORE 게이트 → 무결성 게이트(bun test) → PR 초안(merge HITL).
//
// build.armed(=~/.elanous/autopilot.json) 게이트는 그대로 유지 — disarmed(기본)면 격리 worktree
// 를 만들지 않고 "arming 대기" 로 정직 보고(막다른 walker 턴보다 나음). classifyPhaseKind 는
// 순수함수(단위테스트·실 미션 7페이즈 픽스처로 회귀 가드). runImplementationPhaseViaSE 는
// buildArmed/runNocturnalOne/makeDeps/writePlan 을 주입받아(기본 실배선) 테스트 가능.

import { homedir } from 'node:os';
import { elanousStateRoot } from './state-paths.js';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Task } from '../task-orchestrator/types.js';
import type { PhaseResult } from './mission-multiphase-executor.js';
import { slugify } from './proposal/draft-plan.js';
import { readWorkingMemory, formatWorkingMemoryForPrompt } from './mission-working-memory.js';
import { formatRfcDesignForPrompt } from './mission-rfc-store.js';
import { computeRemovalLivenessWarning } from './mission-removal-liveness.js';
import { debug } from '../debug/log.js';
import { budgetModel, tierModel } from '../llm/model-defaults.js';
import { seTriageRetry, type SEAttemptEvidence, type SERetryPath } from './mission-se-retry-triage.js';
import { makeBuildId, buildLogPath, upsertBuildSafe, openSeBuildsDb, nextAttemptSeq, type SeBuildStatus } from './se-build-registry.js';

/** SE 러너 BuildStatus → 레지스트리 SeBuildStatus(PLAN B1). */
function mapBuildStatus(s: string): SeBuildStatus {
  if (s === 'built') return 'built';
  if (s === 'no-change') return 'no-change'; // ★ 변경0(no-op) 정직화 — built 로 뭉개면 트레일이 "성공"처럼 오표시(대표 2026-07-14)
  if (s === 'gate-failed') return 'gate-failed';
  return 'failed'; // pr-failed·impl-failed·core-violation·error
}
import { buildArmed, loadAutopilotArming } from './arming.js';
import { isSystemRepairAuthorized } from './system-repair.js';
import { runNocturnalOne, type NocturnalResult } from './build/nocturnal-runner.js';
import { makeNocturnalDeps, extractFailCount } from './build/nocturnal-deps.js';
import type { BuildTarget } from './build/build-target.js';
import { resolveSeBudgetLadder, SE_BUDGET_LADDER_DEFAULT } from './mission-budget.js';
import { verifyPhaseAlreadySatisfied, type NoopVerdict } from './mission-se-noop-verify.js';
import { makeMissionObserver, SELF_MEMORY_IMPORTANCE } from './mission-observation.js';
import { arcIdForPhase } from './mission-arc.js';
import { TaskStore } from '../task-orchestrator/store.js';
import { buildSelfHealContext, formatSelfHealContextForPrompt } from './mission-selfheal-context.js';
import { persistMissionRouteDecision, routeDecisionFromExecutionBackend } from './mission-route-decision.js';
import { getUserConfig } from '../user-config.js';
import type { LlmRoutePolicyConfig } from '../user-config/types.js';

export type PhaseKind = 'implementation' | 'operational';

// 강한 구현 신호 — 이것만으로 implementation 확정(경로 언급 불필요). "구현"은 동사형만
// (구현하라/구현한다/구현해야/구현했다) — "구현 방향/구현 계획"(문서·명사수식)은 제외.
const STRONG_IMPL = /구현하|구현해|구현했|구현됨|코딩|리팩터|리팩토링|버그\s*수정|함수를?\s*작성|모듈을?\s*작성|\bimplement\b|\brefactor\b/i;
// 테스트 저작 신호 — 새 테스트 파일(test/ 보호경로) 작성이므로 walker 불가 → SE 경로.
const TEST_AUTHORING = /테스트\s*(코드|작성|추가|보강)|검증\s*코드|test\s*(를)?\s*(작성|추가)|\.test\.|mock\s*helper/i;
// 코어 편집 경로(보호경로 파일 명시) — 편집 동사와 함께면 implementation.
const CORE_PATH = /\bsrc\/[\w./-]+|\bapps\/[\w./-]+|\btest\/[\w./-]+|\.tsx?\b/;
const EDIT_VERB = /추가|확장|연결|통합|등록|수정|생성|변경|배선|치환|패치/;
// 명시 read-only(조사) — 강한 구현 신호가 없으면 operational(조사 페이즈).
const READONLY = /수정하지\s*않는다|편집하지\s*않는다|건드리지\s*않는다|read-?only|읽기\s*전용|조사만\s*한다|파일을\s*변경하지\s*않/i;
// ★ 명시적 조사·문서 전용 선언(대표 2026-07-13·dogfood 버그 수정) — 페이즈 설명 첫 문장의 유형
//   선언은 grounding 문구(CORE_PATH src 경로 + "재사용·확장" EDIT_VERB)보다 강한 신호다. 이게
//   없어서 조사 전용 페이즈("조사 전용 단계다 / 변경 파일은 없으며")가 SE 격리(구현)로 오라우팅→
//   새 문서(untracked) diff 미캡처→"검증 불가 FAIL" 무한 반복→opus 소진(price-guard 페이즈0).
//   STRONG_IMPL 과 무관하게 최우선 operational 확정(walker·조사 예산 32k~128k 토큰).
const EXPLICIT_READONLY = /조사\s*전용|변경\s*파일(은|이)?\s*없|편집\s*없이|코드\s*수정\s*없이|검증\s*전용|스파이크|spike/i;
// ★ 운영 액션(대표 2026-07-13·dogfood 버그 수정) — 크론/스케줄 등록·기존 스크립트 실행은 코드 변경이
//   아니라 런타임 액션(elanous schedule·schedules.db). SE 격리(코드 diff 기대)로 가면 만들 코드가 없어
//   no-change→실패(price-guard 페이즈4 "장중 5분 크론 등록"이 implementation 오분류돼 opus 도 no-op).
//   walker(운영)가 elanous schedule 로 처리한다. 단 STRONG_IMPL(크론 매니저 '구현') 이 있으면 코드라 제외.
const OPERATIONAL_ACTION = /크론.*(등록|추가|생성)|cron.*(등록|register)|주기.*크론|elanous\s*schedule/i;
// ★ 조사/파악 동사(대표 2026-07-13·split 서브페이즈 회귀) — 제목이 "조사하라/파악하라/분석하라"
//   면 조사 페이즈(walker). split 이 만든 조사 서브("기존 주입 경계를 조사하라")가 "조사 전용"
//   명시가 없어 grounding(src 경로)로 implementation 오분류→SE격리 no-op 실패. 제목 기준 +
//   강한 구현신호(STRONG_IMPL) 없으면 operational. "X 조사해서 Y 구현하라"는 STRONG_IMPL 로 impl 유지.
const INVESTIGATE_VERB = /조사하라|조사한다|파악하라|파악한다|분석하라|분석한다|식별하라|추적하라|확인하라|대조하라/;

/** 페이즈가 실 코드/테스트 작성(코어·보호경로 편집)을 요구하는가. 구현·테스트저작이면 SE 격리
 *  경로로 라우팅, 아니면 walker(운영). 순수함수(단위테스트). 판정 순서:
 *   1) 명시 read-only(조사) + 강한 구현신호 없음 → operational.
 *   2) 강한 구현신호 or 테스트저작 → implementation.
 *   3) 코어 경로 명시 + 편집 동사 → implementation.
 *   4) 그 외 → operational(보수적·walker). */
export function classifyPhaseKind(task: Task): PhaseKind {
  const hay = [
    task.title,
    task.description,
    task.surface.kind === 'subagent' ? task.surface.prompt : '',
    ...(task.acceptance?.criteria ?? []),
  ].join('\n');
  // 0) 명시적 조사·문서·검증 전용 선언 → operational 확정(grounding 문구 오탐 차단).
  if (EXPLICIT_READONLY.test(hay)) return 'operational';
  // 0b) 운영 액션(크론/스케줄 등록·런타임) → operational. 단 강한 구현 신호(매니저 '구현' 등)면 코드.
  if (OPERATIONAL_ACTION.test(hay) && !STRONG_IMPL.test(hay)) return 'operational';
  // 0c) 조사/파악 동사 제목(split 조사 서브 등) → operational. 강한 구현신호 없을 때만(코드 조사구현 제외).
  if (INVESTIGATE_VERB.test(task.title) && !STRONG_IMPL.test(hay)) return 'operational';
  if (READONLY.test(hay) && !STRONG_IMPL.test(hay)) return 'operational';
  if (STRONG_IMPL.test(hay) || TEST_AUTHORING.test(hay)) return 'implementation';
  if (CORE_PATH.test(hay) && EDIT_VERB.test(hay)) return 'implementation';
  return 'operational';
}

// ── LLM 분류(대표 2026-07-13) — 정규식 사전 대체 ──────────────────────────
// 정규식 사전은 새 페이즈 표현마다 오분류한다(dogfood 반복: 크론 등록·조사 서브페이즈마다 regex
// 추가). 경량 LLM 이 페이즈 의도(코드 작성 vs 조사/운영)를 이해해 분류하는 게 근본이다. 안전하게
// LLM 우선 + 정규식 fallback(LLM 실패/불확실) + 캐시(task.id·결정론·재호출 무비용) 하이브리드.
const _classifyCache = new Map<string, PhaseKind>();

async function defaultClassifyLLM(prompt: string): Promise<string> {
  const { streamLLM, resolveDefaultProvider } = await import('../llm.js');
  // ★ 라우팅 누수 수복(대표 2026-07-19·라이브 dogfood 근본원인) — 주석은 "luna 급"인데 코드는 haiku 를
  //   하드코딩(claude-haiku-4-5)했다. codex-only 환경에서 cross-family override → anthropic 401 →
  //   정규식 폴백 → "수집" 페이즈를 implementation 으로 오분류 → se-isolated 코드작성 라우팅 → scope
  //   creep → 페이즈 실패. 공용 provider-aware budget tier로 통일한다.
  const model = process.env.ELANOUS_CLASSIFY_MODEL || budgetModel();
  const provider = resolveDefaultProvider(model);
  return streamLLM([{ role: 'user', content: prompt }], () => {}, { model, maxTokens: 16, ...(provider ? { provider } : {}) });
}

/** ★ 분류 맥락(대표 2026-07-22 "전체 페이즈·아크 분류와 같이 보면") — 단일 페이즈 고립 판정 대신
 *  미션 골·아크 의도·형제 페이즈로 이 페이즈의 역할을 맥락 판정(앞에 조사/설계 페이즈 따로 있고 이건
 *  배선 역할 → implementation). tie-breaker(luna 2차 판단)가 소비. 미주입=고립 판정(하위호환). */
export interface PhaseClassifyContext { goal?: string; arcIntent?: string; siblingTitles?: string[] }

/** divergence tie-breaker 프롬프트(luna 2차 판단·전체 맥락) — 결정론 가드 완화. 코드작성 여부만 이분. */
function tieBreakerPrompt(task: Task, cleaned: string, ctx?: PhaseClassifyContext): string {
  return [
    '아래 미션 페이즈가 실제로 코드/테스트 파일(src/·apps/·test/)을 새로 작성·편집해야 완료되는가(implementation),',
    '아니면 읽기·조사·파악·기록·설계결론만 남기면 완료되는가(operational)?',
    '규칙 분류기는 operational, 의도 분류기는 implementation 이라 했다(불일치). **전체 미션·아크 맥락에서** 이 페이즈의 역할로 판정하라.',
    ...(ctx?.goal ? [`미션 골: ${ctx.goal.slice(0, 300)}`] : []),
    ...(ctx?.arcIntent ? [`아크 의도: ${ctx.arcIntent.slice(0, 150)}`] : []),
    ...(ctx?.siblingTitles?.length ? [`같은 미션 다른 페이즈(맥락): ${ctx.siblingTitles.slice(0, 8).map((t, i) => `${i + 1}. ${t}`).join(' · ')}`] : []),
    '핵심: 앞선 페이즈가 조사/설계를 이미 했고 이 페이즈가 "배선/추가/통합/연결/구현"이면 implementation(코드작성). 이 페이즈 자체가 조사/파악/기록이면 operational.',
    '정확히 한 단어만: implementation 또는 operational.',
    `이 페이즈 제목: ${task.title}`,
    `이 페이즈 내용: ${cleaned.slice(0, 800)}`,
    '답(한 단어):',
  ].join('\n');
}

/** ★ 페이즈 분류(LLM 우선 + 정규식 fallback + 캐시) — classifyPhaseKind 의 지능형 대체.
 *  경량 LLM 이 "이 페이즈가 코드/테스트를 작성하는가(implementation) vs 조사·크론등록·문서·운영
 *  액션인가(operational)"를 자연어 의도로 판단. LLM 실패·불확실 시 정규식(안전망). deps.llm 주입=테스트.
 *  deps.context = 전체 페이즈·아크 맥락(tie-breaker 가 소비·대표 2026-07-22). */
export async function classifyPhaseKindSmart(
  task: Task,
  deps: { llm?: (prompt: string) => Promise<string>; noCache?: boolean; context?: PhaseClassifyContext } = {},
): Promise<PhaseKind> {
  return (await classifyPhaseKindDetailed(task, deps)).kind;
}

/** ★ P3(조율자 격상) — 분류 + 저신뢰 신호 노출. classifyPhaseKindSmart 는 이걸 감싸 kind 만 반환(하위호환).
 *  lowConfidence(llm-fail-regex/llm-uncertain-regex)면 조율자가 개입(재분류/보수 라우팅)할 수 있게
 *  호출측(run-mission)에 신호를 준다. 종전엔 debug.log 로만 남기고 호출측이 몰랐던 갭(A축) 해소. */
export async function classifyPhaseKindDetailed(
  task: Task,
  deps: { llm?: (prompt: string) => Promise<string>; noCache?: boolean; context?: PhaseClassifyContext } = {},
): Promise<{ kind: PhaseKind; lowConfidence: boolean; source: 'llm' | 'llm-uncertain-regex' | 'llm-fail-regex' }> {
  if (!deps.noCache && _classifyCache.has(task.id)) return { kind: _classifyCache.get(task.id)!, lowConfidence: false, source: 'llm' };
  const regexKind = classifyPhaseKind(task); // fallback 미리 계산
  let kind = regexKind;
  // ★ 관측(대표 2026-07-19·제1원칙) — 분류 출처를 기록. llm=LLM 확답, llm-uncertain-regex=LLM 모호→regex,
  //   llm-fail-regex=LLM 실패(401 등)→regex. 마지막 둘은 저신뢰(오분류 위험) — 조율자 개입 신호(A축).
  let source: 'llm' | 'llm-uncertain-regex' | 'llm-fail-regex' = 'llm-uncertain-regex';
  let failReason: string | undefined;
  const hay = [task.title, task.description, ...(task.acceptance?.criteria ?? [])].join('\n').slice(0, 1400);
  // ★ 재료 정제(대표 2026-07-20 "부적절한 컨텍스트 유입") — 본문의 코드파일 경로를 중립 토큰으로 치환.
  //   조사 페이즈가 "읽을 파일"을 다수 나열하면 경로 밀도가 implementation 오판을 유발(bc37d7 Phase1 실증).
  //   경로 개수/구체성 대신 **동작 의도(동사)**로 판단하게 한다. 로그용 codeRefs 는 원본(hay)에서 별도 계산.
  const cleaned = hay
    .replace(/`?\b(?:src|apps|test|scripts|docs)\/[\w./-]+`?/g, '<파일>')
    .replace(/`[^`\n]*\.(?:ts|tsx|md|json)`/g, '<파일>');
  let answer = '';
  try {
    const prompt = [
      '미션 페이즈를 분류하라. 정확히 한 단어만 답하라: implementation 또는 operational.',
      '- implementation: src/ · apps/ · test/ 의 코드나 테스트 파일을 실제로 새로 작성하거나 편집한다.',
      '- operational: 조사·파악·분석·기록(읽기), 크론/스케줄 등록, 문서·리포트 작성, 기존 스크립트 실행 등 코드 변경이 없는 운영 액션.',
      '★1차 신호=동사: 조사/파악/기록/식별/분석/검토/수집=operational · 구현/작성(코드)/수정/편집/추가(코드)=implementation.',
      '★주의: 본문에 코드 파일 경로(<파일>)가 여러 개 언급돼도 그 자체는 implementation 신호가 아니다. 그 파일을 "읽기/조사"하면 operational, "새로 쓰거나 고치면" implementation. "읽기만 한다 / 설계 결론·구현 제안은 작성하지 않는다"가 있으면 operational.',
      `제목(1차 신호): ${task.title}`,
      `내용: ${cleaned}`,
      '답(한 단어):',
    ].join('\n');
    const llm = deps.llm ?? defaultClassifyLLM;
    answer = (await llm(prompt)).trim().toLowerCase();
    if (answer.includes('implementation')) { kind = 'implementation'; source = 'llm'; }
    else if (answer.includes('operational')) { kind = 'operational'; source = 'llm'; }
    // 둘 다 없음(불확실) → regexKind 유지(fallback·source=llm-uncertain-regex)
  } catch (e) { source = 'llm-fail-regex'; failReason = e instanceof Error ? e.message.slice(0, 80) : String(e); }
  // ★ 재료 신호 digest(대표 2026-07-20·"부적절한 컨텍스트 유입" 진단 계측) — 종전 로그는 diverged("틀림")만
  //   보여주고 "왜(어떤 재료가 오판시켰나)"는 안 남겨 DB 직접읽기 없이는 진단 불가(자기인지 갭)였다. 입력의
  //   read-only 신호 수·코드파일 참조 수·LLM 원답을 남겨, "읽기전용 명시인데 코드참조 많아 LLM 이 impl 오판"
  //   을 `elanous logs --category mission.phase.classify` 로만 추적한다.
  const readOnlyHits = (hay.match(/읽기만|읽기\s?전용|조사|파악|기록한|기록하|식별|작성하지\s?않|설계\s?결론|구현\s?제안/g) ?? []).length;
  const codeRefs = (hay.match(/\b(?:src|apps|test|scripts)\//g) ?? []).length + (hay.match(/\.ts\b/g) ?? []).length;
  const llmDiverged = source === 'llm' && kind !== regexKind; // 가드 전 원 divergence(관측)
  // ★ divergence 가드(대표 2026-07-20) — LLM 이 regex-operational + read-only 증거를 뒤집어 implementation
  //   이라 할 때 보수 라우팅. **위험 방향 전용**: 조사→구현 오라우팅은 Opus 400턴 낭비(bc37d7)라 비용 비대칭.
  //   ★ 완화(대표 2026-07-22 지시 "결정론이면 luna 로 완화") — 종전엔 이 조건에서 LLM(luna) 정답을 **무조건**
  //   operational 로 덮어써, "배선하라"류 진짜 구현 페이즈를 walker(operational·저장약점)로 오라우팅해 완주를
  //   막았다(라이브 81b18c phase5 실증). 이제 하드 오버라이드 대신 **luna 2차 tie-breaker**로 완화: "acceptance
  //   충족하려면 파일을 실제로 고쳐야 하나?" 집중 재질의 → implementation 확답이면 유지(→SE build), 아니면(op/
  //   불확실/luna실패) 종전 보수(operational). luna 두 번 다 implementation 이면 강신호라 신뢰.
  let guarded = false;
  if (source === 'llm' && kind === 'implementation' && regexKind === 'operational' && readOnlyHits > 0) {
    try {
      const llm2 = deps.llm ?? defaultClassifyLLM;
      const tie = (await llm2(tieBreakerPrompt(task, cleaned, deps.context))).trim().toLowerCase();
      if (!tie.includes('implementation')) { kind = 'operational'; guarded = true; } // op 확답/불확실 → 보수 유지
      // implementation 재확답이면 kind='implementation' 유지(luna 완화 — SE build 라우팅)
    } catch { kind = 'operational'; guarded = true; } // 안전망: luna 실패 = 종전 보수 오버라이드
  }
  try {
    debug.log('mission.phase.classify', guarded ? 'llm-diverge-guard' : source, {
      phaseId: task.id, title: task.title.slice(0, 50), kind, regexKind,
      lowConfidence: source !== 'llm',
      diverged: llmDiverged, ...(guarded ? { guarded: true } : {}),
      answer: answer.slice(0, 24), readOnlyHits, codeRefs, inputChars: hay.length, // ★ 재료 유입 진단
      ...(failReason ? { failReason } : {}),
    });
  } catch { /* fail-soft */ }
  if (!deps.noCache) _classifyCache.set(task.id, kind);
  return { kind, lowConfidence: source !== 'llm', source };
}

/** 페이즈별 유니크 slug(git 브랜치/worktree/planPath 명명). ★ 한글 title 은 slugify 가 의미있는
 *  영문이 없으면 'proposal' 로 폴백돼 여러 페이즈가 같은 slug→worktree/브랜치 충돌(2026-07-12
 *  dogfood 버그: [2][3] 둘 다 'proposal'→[3] worktree 생성 실패). task.id hex 로 유니크 보장하고
 *  가독성 위해 영문 title slug 를 앞에 붙인다(한글 폴백이면 hex 만). 순수함수. */
export function phaseSlug(missionId: string, task: Task): string {
  const phaseKey = task.id.replace(/^task:/, '').slice(0, 8);
  const titleSlug = slugify(task.title);
  const titlePart = titleSlug === 'proposal' ? '' : `${titleSlug.slice(0, 14)}-`;
  return `${slugify(missionId).slice(0, 22)}-${titlePart}${phaseKey}`.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/** 구현 페이즈 → 플랜 초안 md 경로. 미션 fabric core 네임스페이스(autopilot/·git 밖 ~/.elanous).
 *  ★ task.id hex 로 서브키잉(한글 title slugify 폴백 충돌 방지 — slug 버그와 동일 근본). */
export function phasePlanPath(missionId: string, task: Task): string {
  const phaseKey = task.id.replace(/^task:/, '').slice(0, 8);
  return join(elanousStateRoot(), 'autopilot/proposals', `${missionId}__phase-${phaseKey}.md`);
}

/** 페이즈(제목·설명·프롬프트·acceptance)를 SE 구현 입력 PLAN md 로 직렬화. 반환=경로. */
export function writePhasePlan(missionId: string, task: Task): string {
  const p = phasePlanPath(missionId, task);
  const criteria = (task.acceptance?.criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(명시 acceptance 없음)';
  const prompt = task.surface.kind === 'subagent' ? task.surface.prompt : '';
  // ★ R3 재구현(대표 2026-07-12) — 이전 리뷰 지적([REBUILD] notes)을 PLAN 에 실어 SE 가 반영.
  const rebuildNotes = task.notes.filter((n) => n.startsWith('[REBUILD]')).map((n) => `- ${n.replace(/^\[REBUILD\]\s*/, '')}`);
  // ★ P3 워킹 메모리 주입(대표 2026-07-13) — 이전 페이즈(특히 조사)가 파악한 재사용 경계·결정을
  //   SE 격리 구현 PLAN 에 실어, fresh worktree 세션이 그 경계를 재구현/자가충족하지 않게 한다
  //   (P7 근본: 조사 서브의 재사용 경계가 구현 서브에 미전달). fail-soft(읽기 실패=빈 블록).
  // ★ 아크 메모리 2층(A4·2026-07-14) — 이 페이즈의 아크를 넘겨 같은 아크 메이트가 이미 정의한
  //   경계·결정을 강조 주입(아크 통합 정합성 유지·dead-code 예방). flat 이면 arcId=undefined(종전대로).
  const wmArcId = (() => { try {
    const s = new TaskStore(); const arcs = s.getMission(missionId)?.autopilot?.arcs; s.close();
    return arcIdForPhase(arcs, task.id);
  } catch { return undefined; } })();
  // ★ 축A A1 — viewerPhaseId(이 페이즈)로 가시성 필터. agent-전용 각인은 소유 페이즈만 본다(현재 subteam 기본이라 무영향·비파괴).
  const wmEntries = (() => { try { return readWorkingMemory(missionId); } catch { return []; } })();
  const wmBlock = (() => { try { return formatWorkingMemoryForPrompt(wmEntries, { ...(wmArcId ? { arcId: wmArcId } : {}), viewerPhaseId: task.id }); } catch { return ''; } })();
  // ★ ②RFC 설계 주입(근본·2026-07-22·핸드오프 3근본 #2) — SE 격리 구현이 RFC 설계 본문을 못 보고
  //   즉흥 확장하던 근본 해소(walker 경로와 대칭). rfc.md 본문을 PLAN 최상단 계약으로 주입. 비-RFC 미션은 ''.
  const rfcBlock = (() => { try { return formatRfcDesignForPrompt(missionId); } catch { return ''; } })();
  // ★ 근본 B — 제거-전 liveness 게이트(대표 설계·2026-07-22) — RFC 가 "제거" 지시한 심볼이 실제 live 면
  //   결정론 grep 으로 잡아 PLAN 최상단에 premise 교정(제거 말고 불일치 보고). SE 격리 구현이 live 툴을
  //   맹종 제거해 침묵 capability 손실(a85843 phase2 dispatchYoutubeTranscript)나는 근본 차단. fail-soft.
  const livenessBlock = (() => { try {
    const criteriaText = (task.acceptance?.criteria ?? []).join('\n');
    return computeRemovalLivenessWarning(`${prompt}\n${task.description ?? ''}\n${criteriaText}`, process.cwd());
  } catch { return ''; } })();
  // ★ 관측 장치(대표 2026-07-19·제1원칙) — 빌드 조사문맥(provenance:build seed)이 이 실행 페이즈
  //   프롬프트에 실제로 주입됐는지 관측. hasBuildContext=false 면 "재조사 방지" 이관이 끊긴 것(A1 예산소진
  //   실패 재발 신호). `elanous logs --category mission.exec.context` 로 실시간 와칭. fail-soft.
  try {
    const buildSeed = wmEntries.find((e) => e.provenance === 'build');
    debug.log('mission.exec.context', 'wm-inject', {
      missionId, phaseId: task.id, wmChars: wmBlock.length,
      hasBuildContext: !!buildSeed,
      reusables: buildSeed?.reusables?.length ?? 0,
      buildArtifacts: buildSeed?.artifacts?.length ?? 0,
      // ★ ②RFC 주입 관측(2026-07-22) — SE PLAN 에 RFC 설계 본문이 실렸는지(경로만 아닌 내용). 0 이면 RFC-blind 재발.
      rfcChars: rfcBlock.length,
    });
  } catch { /* fail-soft — 관측 실패가 실행을 막지 않음 */ }
  const body = [
    `# PLAN — ${task.title}`, '',
    `> 미션 ${missionId} 의 구현 페이즈. walker 가 SE 격리 worktree 로 위임(2단계 브릿지).`, '',
    ...(rfcBlock ? ['## ★ RFC 설계 계약(이 미션의 상위 계약 — 반드시 준수·설계 밖 즉흥 확장 금지)', '', rfcBlock, ''] : []),
    ...(livenessBlock ? ['## ★★ 제거-전 liveness 사실 확인(최우선 — RFC 제거 지시 검증)', '', livenessBlock, ''] : []),
    ...(rebuildNotes.length ? ['## ★ 이전 리뷰 지적(반드시 반영·재구현)', '', ...rebuildNotes, ''] : []),
    ...(wmBlock ? ['## ★ 미션 워킹 메모리 — 이전 페이즈 결정·재사용 경계(반드시 재사용)', '', wmBlock, ''] : []),
    '## 지시', '', prompt || task.description || task.title, '',
    '## acceptance(완료 기준)', '', criteria, '',
    '## 규칙', '',
    '- 작은 순수 함수 + 단위테스트(bun test) 위주. bun test 통과 필수.',
    '- 매매(trade-*)·arming·safety·재부팅·mandate 등 불변 코어 수정 금지.',
    ...(rebuildNotes.length ? ['- ★위 "이전 리뷰 지적"을 반드시 해소하라(같은 문제 반복 금지).'] : []),
  ].join('\n');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** ★ 게이트 실패 사유 발췌(대표 2026-07-12·순수) — evidence(bun test 로그)에서 몇 개 실패·첫 실패
 *  테스트를 뽑아 "왜" 를 바로 이해되게. 리포트가 '무결성 게이트 실패' 만 반복하던 문제 해소. */
export function summarizeGateFailure(evidence: NocturnalResult['evidence']): string {
  const log = evidence?.log ?? '';
  if (!log) return '';
  const fails = extractFailCount(log);
  const firstFail = /\(fail\)\s*(.+)/.exec(log)?.[1]?.trim()
    ?? /([\w./-]+\.test\.ts)/.exec(log)?.[1];
  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails}개 실패`);
  if (firstFail) parts.push(firstFail.slice(0, 60));
  return parts.join(' · ');
}

/** SE NocturnalResult → 페이즈 결과 매핑(보고 문구·VERDICT 포함). built 만 done(VERDICT: PASS). */
export function seResultToPhaseResult(r: NocturnalResult): PhaseResult {
  switch (r.status) {
    case 'built':
      return {
        ok: true, summary: `[SE·PR] 격리 구현 완료 → PR 초안 ${r.prUrl ?? '(생성 실패)'} · merge HITL. VERDICT: PASS`,
        ...(r.prUrl ? { prUrl: r.prUrl } : {}),
        // 비평을 페이즈 결과에 실어 task 에 보관 → 재구현이 반영(대표 2026-07-12).
        ...(r.critique ? { critiqueVerdict: r.critique.verdict, critiqueFindings: r.critique.findings } : {}),
      };
    case 'no-change':
      // 실제 변경 0 = 이미 구현됨/변경 불필요(대표 2026-07-12) — 정직한 no-op PASS(가짜 PR 없음).
      return { ok: true, summary: `✅ 변경 불필요(no-op) — 이 페이즈 기능은 이미 구현되어 있거나 변경할 것이 없습니다. PR 없음. VERDICT: PASS` };
    case 'pr-failed':
      return { ok: false, summary: `❌ PR 생성 실패 — 게이트는 통과했으나 커밋/push/gh 실패(리뷰 산출물 없음). 재구현 필요.` };
    case 'disarmed':
      return { ok: false, summary: `🔒 build arming 대기(autopilot.json build.armed=true 후 재실행).` };
    case 'gate-failed': {
      // ★ 사유 명확화(대표 2026-07-12) — 중복 문구 제거 + bun test 실패 detail. 흔한 원인=구현은
      //   됐으나 예산 소진으로 검증(bun test) 완주 못 함(P5·P6 dogfood). 에스컬레이션 이력은
      //   runImplementationPhaseViaSE 가 앞에 덧붙인다("예산 …까지 상향").
      const d = summarizeGateFailure(r.evidence);
      return { ok: false, summary: `❌ 무결성 게이트 실패 — bun test 미통과${d ? ` (${d})` : ''}. 구현했으나 검증 미완이거나 실제 테스트 실패.` };
    }
    case 'core-violation':
      return { ok: false, summary: `[SE·불변코어 위반] ${r.next}` };
    case 'impl-failed':
    case 'no-approved':
    default:
      return { ok: false, summary: `[SE·구현 실패] ${r.next}` };
  }
}

export interface SEBridgeDeps {
  repoRoot?: string;
  /** build arming(기본 buildArmed() — ~/.elanous/autopilot.json). 테스트 주입. */
  armed?: boolean;
  /** 코딩 백엔드(기본 arming.build.backend). */
  backend?: string;
  /** 게이트 스코프(기본 makeNocturnalDeps 기본값 'src/autopilot/'). */
  gateScope?: string;
  /** SE 러너(기본 runNocturnalOne). 테스트 주입. */
  runOne?: typeof runNocturnalOne;
  /** deps 팩토리(기본 makeNocturnalDeps). 테스트 주입. */
  makeDeps?: typeof makeNocturnalDeps;
  /** R1 LLM 비평 주입(기본 llmReviewCritique·streamLLM). 미주입 안 함 — 기본이 실 LLM. 테스트는 무력화. */
  llmReview?: (prompt: string) => Promise<string>;
  /** ★ 적응형 재시도 triage classify(대표 2026-07-14) — SE 갈림길(split/revise/escalate vs
   *  계단 상향)을 LLM 이 관찰 분류. 미주입=비-test 는 기본 streamLLM(sol), test 는 휴리스틱. */
  triageClassify?: (prompt: string) => Promise<string>;
  /** ★ grounded no-op 검증(대표 2026-07-14) — 실패 반환 직전 "이미 코드에 구현됐나"를 코드
   *  실독으로 한 번 더 거른다. 미주입=비-test 는 기본 verifyPhaseAlreadySatisfied, test 는 스킵. */
  verifyNoop?: (intent: string, acceptance: string[]) => Promise<NoopVerdict>;
  /** ★ grounded 미충족 → 타겟 리커버리(대표 2026-07-14·시스템 리커버리) — grounded 검증이 알아낸
   *  미충족(missing)을 버리지 않고 타겟 수정 1회 자동 시도. 기본 on(비-test). 순수 grounded-fail
   *  경로만 테스트하려면 false. */
  recoverGrounded?: boolean;
  /** ★ 셀프힐 맥락 파악(RFC 3박자·P2·2026-07-14) — 판단 전 3박자에서 이 페이즈의 과거 셀프힐
   *  이력 조립(기본 buildSelfHealContext). 테스트 주입(3박자 조회 격리). */
  buildContext?: (ctx: { missionId: string; phaseId: string; phaseTitle: string }) => ReturnType<typeof buildSelfHealContext>;
  /** PLAN 직렬화(기본 writePhasePlan). 테스트 주입(fs 격리). */
  writePlan?: (missionId: string, task: Task) => string;
  /** ★ SE 구현 예산 커스텀(대표 2026-07-12·seam) — 지정 시 그 maxTurns 로 1회만(에스컬레이션
   *  안 함). 미지정=자기 적응형 에스컬레이션(40→70→110). "지정 가능 인터페이스"(사용자 노출 나중). */
  maxTurns?: number;
  /** ★ 페이즈 내부 진행 콜백(대표 2026-07-12) — 시도 시작·재시도·opus 폴백 같은 변곡점마다
   *  호출. run-mission 이 "구현 중" 메시지를 edit 해 실시간 노출. 미주입=조용(로그만). */
  onProgress?: (note: string) => void;
  /** ★ 페이즈 스택 base(대표 2026-07-13 · 페이즈 의존성 전파) — 이 구현 페이즈의 worktree 를 만들
   *  base ref. 직전 성공 구현 페이즈의 원격 브랜치(origin/se/<slug>)를 넘기면 이전 산출물 위에
   *  쌓인다(dogfood: 페이즈2 가 페이즈1 정책을 못 봐 중복 생성·실패). 미지정=main(독립·기존). */
  baseBranch?: string;
  /** ★ 이식 #1(harness front-half → walker·2026-07-22) — 실행 전 적대적 플랜 비평 critic(주입·테스트=fake).
   *  미주입이면 config autopilot.adversarialPlanCritique=true(비-test) 시 llmReview 재사용. off=무회귀. */
  adversarialCritic?: (prompt: string) => Promise<string>;
  log?: (s: string) => void;
}

/** ★ SE 구현 예산 에스컬레이션 계단(대표 2026-07-12·①) — gate-failed/pr-failed(예산 소진·미완
 *  으로 검증 못 끝냄)이면 이 순서로 상향 재시도. 복잡한 페이즈가 구현+검증을 완주하도록 "스스로
 *  더 길게". 성공(built/no-change) 즉시 중단. deps.maxTurns 지정 시 이 계단 대신 그 값 1회.
 *  ★상향(대표 2026-07-12): 미션 페이즈가 엄청 커서 600턴도 부족(dogfood P6=600턴서도 큰 구현
 *  +124/-43 후 bun test 검증 전 소진). 3단계를 1000 으로 상향(150→300→1000). 맥스턴은 상한이라
 *  간단 페이즈는 일찍 끝나 손해 없음. 검증-우선 프롬프트(makeNocturnalDeps)와 짝. 계단 소진 시
 *  최종 방어=opus 폴백(SE_OPUS_FALLBACK_BACKEND).
 *  ★ 오버라이드(대표 2026-07-14): 이 값은 이제 **기본값**일 뿐 — 실행은 resolveSeBudgetLadder()
 *  가 user-config(autopilot.budget.se)→env(ELANOUS_SE_BUDGET)→이 기본 순으로 정한다(mission-budget.ts). */
export const SE_BUDGET_LADDER = SE_BUDGET_LADDER_DEFAULT;

/** ★ 구조적 실패(대표 2026-07-13) — 예산/모델을 더 줘도 소용없는 실패. dead-code(만들었지만
 *  기존 경로에 미배선)·범위밖(계획 밖 파일 수정)·no-op(변경 0)·미완/훼손. 이건 배선·분해 문제라
 *  더 큰 예산이 아니라 '분할'이 답이다(budget 소진과 구분). 게이트/비평 사유 텍스트로 판정. */
export function isStructuralFailure(text: string): boolean {
  // ★ 명확히 구조적인 신호만(대표 2026-07-13) — '미완/훼손' 은 budget 소진("검증 미완")과 겹쳐
  //   제외. dead-code(미배선·연결안됨)·범위밖·no-op·계획 미달 은 예산 증액으로 안 풀리는 배선/분해 문제.
  return /연결(되지|\s*안)|미배선|배선.*(안|못|되지)|dead.?code|계획.*미달|범위\s*밖|범위 초과|scope\b|변경\s*0|no-?op|가짜\s*no-op/i.test(text ?? '');
}

/** ★ 최종 방어 폴백 백엔드(대표 2026-07-12) — terra 예산 계단이 다 실패하면 마지막으로 opus 4.8
 *  (최신·최강)로 1회 더 시도. 유료지만 성공 확률이 높다(대표). anthropic provider 로 전환됨
 *  (se-elanous-self-impl: claude* → anthropic). deps.maxTurns 커스텀 지정 시엔 폴백 안 함. */
export const SE_OPUS_FALLBACK_BACKEND = 'elanous-self:claude-opus-4-8';

/** Execution-attempt ladder, kept pure so the paid-model boundary is
 * independently testable.  `evidence-hitl` never silently turns a failed
 * implementation attempt into an Opus API call; an authorized system-repair
 * mission is the one deliberate exception. */
export function resolveSeImplementationAttempts(input: {
  backend: string;
  ladder: readonly number[];
  maxTurns?: number;
  routePolicy?: LlmRoutePolicyConfig;
  systemRepairAuthorized?: boolean;
}): Array<{ backend: string; maxTurns: number }> {
  if (input.maxTurns) return [{ backend: input.backend, maxTurns: input.maxTurns }];
  const automaticOpusAllowed = input.systemRepairAuthorized || input.routePolicy?.opusEscalation !== 'evidence-hitl';
  return input.ladder.map((maxTurns, index) => ({
    backend: index === 0 || !automaticOpusAllowed ? input.backend : SE_OPUS_FALLBACK_BACKEND,
    maxTurns,
  }));
}

/** ★ grounded 미충족 → 타겟 리커버리 지시(대표 2026-07-14·시스템 리커버리). grounded 검증이 실독으로
 *  알아낸 "무엇이 미충족인지(missing)"를 다음 시도의 강한 타겟 가이드로 되먹인다. opus no-op(변경0)을
 *  "이걸 반드시 닫아라(검증기가 미완 확증) + 결함이면 원본 in-place 개정(재사용≠결함 동결)"으로 깬다.
 *  외부 판단 없이 시스템이 스스로 수렴하게 하는 핵심. 순수함수(플랜 append 문자열). */
export function buildGroundedRecoveryDirective(missing: string): string {
  return [
    '',
    '## [시스템 리커버리 · grounded 미충족 타겟 · 대표 2026-07-14]',
    'grounded 코드 검증이 다음이 미충족임을 실독으로 확증했다(추측 아님):',
    `> ${missing.replace(/\s+/g, ' ').trim().slice(0, 500)}`,
    '',
    '이번 시도는 정확히 이것만 닫는다:',
    '- 반드시 위 미충족을 해소하라. 변경 0(no-op)은 금지 — 검증기가 이미 미완을 확증했으므로 "이미 됐다"는 성립하지 않는다.',
    '- 기존 코드를 재사용하되, 결함이 있으면 원본 파일을 직접 in-place 개정해 닫아라(새 파일 병렬 생성·재구현 아님). 재사용은 결함 동결이 아니다.',
    '- 최소 변경으로 위 미충족만 해소하고 무관한 리팩터는 하지 마라.',
    '',
  ].join('\n');
}

/** ★ R1 LLM 비평 실주입(대표 2026-07-12) — streamLLM(elanous 표준·미션 분해 decompose 와 동일
 *  헬퍼)으로 diff 심층 비평. lazy import(순환/부팅 회피). 실패 시 critiquePhaseWithLLM 이 결정론
 *  (R0)으로 폴백. 비평 모델=분해와 동일 gpt-5.6-sol(리즈닝)·maxTokens 1500(비평은 짧게). */
async function llmReviewCritique(prompt: string): Promise<string> {
  const { streamLLM, resolveDefaultProvider } = await import('../llm.js');
  const model = process.env.ELANOUS_CRITIQUE_MODEL || tierModel('better');
  const provider = resolveDefaultProvider(model);
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    model, maxTokens: 1500, ...(provider ? { provider } : {}),
  });
}

/** ★ SE 재시도 triage classify 기본(대표 2026-07-14) — 갈림길 분류 LLM(비평·진단과 동일 sol 리즈닝). */
async function seTriageClassifyDefault(prompt: string): Promise<string> {
  const { streamLLM, resolveDefaultProvider } = await import('../llm.js');
  const model = process.env.ELANOUS_RETRY_TRIAGE_MODEL || process.env.ELANOUS_DECOMPOSE_MODEL || tierModel('better');
  const provider = resolveDefaultProvider(model);
  return streamLLM([{ role: 'user', content: prompt }], () => {}, { model, reasoningEffort: 'medium', ...(provider ? { provider } : {}) });
}

/** 구현 페이즈를 SE 격리 경로로 집행. build disarmed 면 격리 worktree 를 만들지 않고 arming
 *  대기로 보고(막다른 길 아님·재실행 가능). armed 면 자율 구현 → 게이트 → PR 초안. */
/**
 * 이미 merge된 PR 산출 페이즈 재빌드 스킵 판정(2026-07-15·false-failure 방지) — rebuild/rerun 으로
 * backlog 리셋된 페이즈가 `[SE-PR]` 노트에 **merge된** PR 을 달고 있으면, 재구현(SE 격리 빌드)은
 * no-op/dead-code false-failure 만 낳는다(산출은 이미 main). merge 확인 시 그 PR 번호 반환 → 조기 PASS.
 * gh 실패·미merge·노트 부재 = null(**fail-open** — 정상 빌드로·정당한 rebuild 보존). deps.checkMergedPr
 * 주입 시 gh 우회(테스트). 실측 근거: 미션 668871 이 머지된 claim/docs-lint 페이즈 재실행 → false-failure.
 */
export function mergedPrForPhase(task: Task, checkMerged?: (prNum: string) => boolean): string | null {
  const note = (task.notes ?? []).map(String).find((n) => /\[SE-PR\]/.test(n));
  const m = note?.match(/\/pull\/(\d+)/);
  if (!m) return null;
  const prNum = m[1]!;
  try {
    if (checkMerged) return checkMerged(prNum) ? `#${prNum}` : null;
    const r = spawnSync('gh', ['pr', 'view', prNum, '--json', 'merged', '-q', '.merged'], { encoding: 'utf-8', timeout: 8000 });
    return r.status === 0 && r.stdout.trim() === 'true' ? `#${prNum}` : null;
  } catch { return null; /* fail-open — gh 없음/네트워크 실패 시 정상 빌드 */ }
}

export async function runImplementationPhaseViaSE(
  missionId: string,
  task: Task,
  deps: SEBridgeDeps = {},
): Promise<PhaseResult> {
  const log = deps.log ?? ((s: string) => console.log(s));
  // ★ 자기인지 관측 관문(RFC 3박자·P1·2026-07-14) — 셀프힐 의사결정을 logs.db(elanous logs)+self-memory
  //   +ops_events 에 흘려 "시스템이 자기 셀프힐을 관측"하게 한다. log()(사람용 run.log 서사)와 겸용.
  //   fail-soft(팬아웃 실패는 삼킴). 컨텍스트(missionId·phaseId·phaseTitle) 바인딩.
  const observe = makeMissionObserver({ missionId, phaseId: task.id, phaseTitle: task.title });
  const armed = deps.armed ?? buildArmed();
  const arming = loadAutopilotArming();
  // ★ 셀프힐 Opus 강제(대표 2026-07-13·컴포넌트 5) — system-repair 권한 미션은 첫 시도부터 Opus
  //   (claude-opus-4-8). 전역 terra 백엔드와 무관하게, 시스템 결함 수리는 최강 모델로(escalate 스폰
  //   경로가 authorizeSystemRepair 등재). deps.backend 명시(테스트/커스텀)가 최우선. isSystemRepair-
  //   Authorized 는 파일 read(캐시 없음)라 스폰 직후 즉시 반영. fail-soft(등재 조회 실패=강제 안 함).
  let selfHealForced = false;
  if (!deps.backend) {
    try { selfHealForced = isSystemRepairAuthorized(missionId); } catch { /* fail-soft */ }
  }
  const backend = deps.backend ?? (selfHealForced ? SE_OPUS_FALLBACK_BACKEND : arming.build.backend);
  if (selfHealForced) log(`[se-bridge] 🛡️ 셀프힐(system-repair) 미션 — Opus 강제(backend=${backend}): ${missionId}`);
  // User policy constrains only *automatic* paid escalation.  An approved
  // system-repair mission keeps its explicit Opus authorization; a normal
  // mission instead records evidence and returns to HITL after its Codex lane
  // is exhausted.
  let routePolicy: LlmRoutePolicyConfig | undefined;
  try { routePolicy = getUserConfig().llm.routePolicy; } catch { /* fail-soft: legacy behavior */ }
  const repoRoot = deps.repoRoot ?? process.cwd();
  const runOne = deps.runOne ?? runNocturnalOne;
  const mk = deps.makeDeps ?? makeNocturnalDeps;
  const writePlan = deps.writePlan ?? writePhasePlan;

  const planPath = writePlan(missionId, task);
  const slug = phaseSlug(missionId, task); // ★ 페이즈별 유니크(한글 title 폴백 충돌 방지)
  const target: BuildTarget = { id: missionId, slug, title: task.title, planPath };

  if (!armed) {
    log(`[se-bridge] 🔒 구현 페이즈 SE 라우팅 — build disarmed(arming 대기): ${task.title}`);
    // 격리 worktree 를 만들지 않는다(비용 회피) — 명시 disarmed 결과로 매핑.
    return seResultToPhaseResult({ status: 'disarmed', target, next: 'autopilot.json build.armed=true 시 격리 구현.' });
  }

  // ★ merge된 PR 재빌드 스킵 가드(2026-07-15·false-failure 방지) — rebuild/rerun 이 이미 merge된 산출
  //   페이즈를 재실행하면 no-op/dead-code false-failure 만 낳는다(산출은 이미 main). merge 확인 시 조기
  //   PASS(worktree 안 만듦·비용 0). fail-open(gh 실패/미merge=정상 빌드). #4184(worktree 분기) 보완.
  const mergedPr = mergedPrForPhase(task);
  if (mergedPr) {
    log(`[se-bridge] ✅ 이미 merge된 PR(${mergedPr}) 산출 페이즈 — 재빌드 스킵(산출 main 반영·no-op false-failure 방지): ${task.title}`);
    observe({ stage: 'pass', verdict: 'pass', rationale: `이미 merge된 PR(${mergedPr}) 산출 — 재빌드 스킵(no-op false-failure 방지)`, refs: { skip: 'merged-pr', pr: mergedPr } });
    return { ok: true, summary: `✅ 이미 merge된 PR(${mergedPr}) 산출 — 재구현 스킵(산출 main 반영). VERDICT: PASS` };
  }

  log(`[se-bridge] 🔧 구현 페이즈 → SE 격리 구현(backend=${backend}): ${task.title}`);
  // ★ PLAN 워킹메모리 주입 관측(2026-07-14 · 관측성) — PLAN md 에 실린 워킹메모리(재사용 경계·외부
  //   수습 가이드)가 몇 건인지 run.log 에 남긴다. 빌드 로그 tail 은 IMPLEMENT 툴스트림만 보여줘 "PLAN 이
  //   주입 가이드를 소비했나"가 안 보이던 갭 해소(dogfood: inject 한 replan 가이드가 PLAN 에 들어갔는지
  //   ops mission-log 로 확인 가능). fail-soft.
  try {
    const wm = readWorkingMemory(missionId);
    const ext = wm.filter((e) => (e.provenance ?? 'self') === 'external').length;
    const rebuilds = task.notes.filter((n) => n.startsWith('[REBUILD]')).length;
    if (wm.length) log(`[se-bridge] 🧠 PLAN 워킹메모리 주입 — ${wm.length} entries${ext ? ` · 외부 가이드 ${ext}건(수습/교정)` : ''}${rebuilds ? ` · 재구현 지적 ${rebuilds}건` : ''} (재사용 경계 인지)`);
  } catch { /* fail-soft */ }
  // ★ 맥락 파악(RFC 3박자·P2·2026-07-14) — 판단 전에 3박자(logs.db·ops·working-memory)에서 이
  //   페이즈의 과거 셀프힐 이력을 조립한다. P1 관문이 채운 logs.db 를 소스로 하므로 미션 재실행 간
  //   누적된 교착/no-op 을 인지(크로스런 파악). 과거 이력이 있으면 PLAN 에 주입해 구현자·triage 가
  //   같은 실패를 반복하지 않게 하고, summary(repeatDeadlock 등)는 후속 판단 근거가 된다. fail-soft.
  try {
    const healContext = deps.buildContext
      ? deps.buildContext({ missionId, phaseId: task.id, phaseTitle: task.title })
      : buildSelfHealContext({ missionId, phaseId: task.id, phaseTitle: task.title });
    const digest = formatSelfHealContextForPrompt(healContext);
    if (digest) {
      const sum = healContext.summary;
      try { appendFileSync(planPath, `\n\n## ${digest}\n`); } catch { /* fail-soft */ }
      observe({ stage: 'diagnose', verdict: 'event', rationale: `맥락 파악 — 과거 셀프힐 ${sum.total}건(교착 ${sum.deadlockCount}·no-op ${sum.noopCount}) 인지${sum.repeatDeadlock ? ' · 반복 교착 경고 주입' : ''}`, refs: { repeatDeadlock: sum.repeatDeadlock, priorEvents: sum.total } });
    }
  } catch { /* fail-soft — 맥락 없이 진행 */ }
  const llmReview = deps.llmReview ?? llmReviewCritique; // ★ R1 실주입 — 기본이 실 LLM(streamLLM)

  // ★ 이식 #1 (harness front-half → walker·2026-07-22 대표 지시·RESEARCH-porting-goalloop-harness) —
  //   실행 전 적대적 플랜 비평(red-team). 델리게이트가 예산을 태우기 전에 이 phase 접근을 레드팀이
  //   공격해 결함(누락 전제·오접근·미처리 엣지)을 찾아 PLAN 에 사전 주입한다. walker 지배 실패(오접근
  //   →terra 사다리 전소→사후 triage·고비용)를 값싼 1콜로 사전 차단. opt-in·fail-soft·무회귀.
  const adversarialOn = deps.adversarialCritic !== undefined
    || (process.env.NODE_ENV !== 'test' && (() => { try { return (getUserConfig().raw?.autopilot as { adversarialPlanCritique?: unknown } | undefined)?.adversarialPlanCritique === true; } catch { return false; } })());
  if (adversarialOn) {
    try {
      const critic = deps.adversarialCritic ?? llmReview;
      const steps = task.acceptance?.criteria ?? [];
      const objective = task.surface.kind === 'subagent' ? `${task.title}\n${task.surface.prompt.slice(0, 600)}` : task.title;
      const { adversarialPlanCritique } = await import('../harness/adversarial-plan.js');
      const critique = await adversarialPlanCritique(objective, steps, critic);
      if (critique && (critique.issues.length || critique.revisedSteps.length)) {
        const block = ['\n\n## ⚠️ 사전 레드팀 점검 (실행 전 적대적 비평)',
          ...(critique.issues.length ? ['발견된 결함(구현 시 반드시 고려):', ...critique.issues.map((i) => `- ${i}`)] : []),
          ...(critique.revisedSteps.length ? ['', '보강된 접근(권장):', ...critique.revisedSteps.map((s, i) => `${i + 1}. ${s}`)] : []),
          ''].join('\n');
        try { appendFileSync(planPath, block); } catch { /* fail-soft */ }
        log(`[se-bridge] 🔴 사전 레드팀 — 결함 ${critique.issues.length}건${critique.revisedSteps.length ? ` · 보강 ${critique.revisedSteps.length}스텝` : ''} PLAN 주입(오접근 예산소진 차단)`);
        observe({ stage: 'prevent', verdict: 'inject', rationale: `사전 적대적 비평 — 결함 ${critique.issues.length}건 사전 주입`, refs: { issues: critique.issues.length, revised: critique.revisedSteps.length } });
      }
    } catch { /* fail-soft — 비평 실패가 구현을 막지 않음 */ }
  }
  // ★ 자기 적응형 예산 에스컬레이션(대표 2026-07-12·①) — gate-failed/pr-failed(거의 다 됐는데
  //   예산 소진·미완)이면 예산을 늘려 재시도. 성공(built/no-change) 즉시 중단. core-violation·
  //   impl 오류·disarmed 는 재시도 무의미(즉시 반환). ★최종 방어: terra 계단 소진 시 opus 4.8 로
  //   1회 더(대표 2026-07-12·유료지만 성공확률↑). deps.maxTurns 커스텀 지정 시엔 그 값 1회.
  // ★ config-first 예산 계단(대표 2026-07-14) — user-config(autopilot.budget.se) →
  //   env(ELANOUS_SE_BUDGET) → 기본[150·400·1000]. 상수 직참조를 은퇴해 코드 변경 없이·
  //   인스턴스별(테스트 config 만 상향) 조정 가능.
  const ladder = resolveSeBudgetLadder();
  const attempts = resolveSeImplementationAttempts({
    backend, ladder, ...(deps.maxTurns ? { maxTurns: deps.maxTurns } : {}), routePolicy,
    systemRepairAuthorized: selfHealForced,
  });
  const automaticOpusAllowed = selfHealForced || routePolicy?.opusEscalation !== 'evidence-hitl';
  const onProgress = deps.onProgress ?? (() => {});
  const modelLabel = (b: string): string => b.includes('opus') ? 'opus 4.8' : b.includes(':') ? b.slice(b.indexOf(':') + 1) : b;
  // ★ 빌드 레지스트리 시작 순번(PLAN B1) — 재구현/재시도가 이어지도록 그 페이즈 기존 빌드 수 +1.
  let startSeq = 1;
  if (process.env.NODE_ENV !== 'test') {
    try { const bdb = openSeBuildsDb(); startSeq = nextAttemptSeq(bdb, task.id); bdb.close(); } catch { /* fail-soft */ }
  }
  let result: PhaseResult = { ok: false, summary: '[SE] 미실행' };
  // ★ 적응형 재시도 triage(대표 2026-07-14) — split-vs-계속을 브리틀한 정규식(구조적 2회)만이 아니라
  //   LLM 이 게이트 출력·비평 근거·구조 신호를 관찰해 근본 갈림길(retry-escalate/split/revise/skip/
  //   escalate)로 확실히 분류(walker triage 와 동일 철학). test 는 휴리스틱(결정론·LLM 무호출).
  const seEvidence: SEAttemptEvidence[] = [];
  const seDecisions: SERetryPath[] = [];
  const triageClassify = deps.triageClassify ?? (process.env.NODE_ENV === 'test' ? undefined : seTriageClassifyDefault);
  // ★ grounded no-op 검증 seam(대표 2026-07-14) — 실패 반환 직전 코드를 실독해 "이미 충족?" 을
  //   확증하면 자동 PASS. NODE_ENV=test 는 스킵(실 LLM/fs 회피·주입 없으면 그대로 실패).
  const verifyNoop = deps.verifyNoop
    ?? (process.env.NODE_ENV === 'test' ? undefined
      : (intent: string, acceptance: string[]) => verifyPhaseAlreadySatisfied(intent, acceptance, { repoRoot }));
  // ★ 시스템 리커버리 바운드(대표 2026-07-14) — grounded 미충족 타겟 수정은 빌드당 1회만(무한 방지).
  let groundedRecoveryTried = false;
  const recoverEnabled = deps.recoverGrounded !== false;

  /** grounded 미충족 → 타겟 리커버리 1회(opus·missing 을 강 타겟 가이드로 되먹임) → 재검증. 시스템이
   *  외부 판단 없이 스스로 수렴. built(게이트 통과) 또는 재검증 충족이면 PASS, 아니면 fallback(FAIL·HITL). */
  const runGroundedRecovery = async (missing: string, intent: string, acceptance: string[], fallback: PhaseResult): Promise<PhaseResult> => {
    const recoveryBackend = automaticOpusAllowed ? SE_OPUS_FALLBACK_BACKEND : backend;
    const recoveryLabel = automaticOpusAllowed ? 'opus' : modelLabel(recoveryBackend);
    log(`[se-bridge] grounded 검증 — 미충족(${missing.slice(0, 80)}) → 🔧 시스템 리커버리 시도(타겟·${recoveryLabel}·바운드 1회)`);
    observe({ stage: 'recover', verdict: 'event', rationale: `grounded 미충족 → 타겟 리커버리(${recoveryLabel}·1회) 시도`, missing });
    onProgress(`🔧 시스템 리커버리 — grounded 미충족 타겟 수정: ${missing.slice(0, 45)}`);
    try { appendFileSync(planPath, buildGroundedRecoveryDirective(missing)); } catch { /* fail-soft */ }
    const recSeq = startSeq + attempts.length;
    const buildId = makeBuildId(task.id, recSeq);
    upsertBuildSafe({ buildId, missionId, phaseId: task.id, phaseTitle: task.title, index: 0, total: 0, attemptSeq: recSeq, backend: recoveryBackend, status: 'running', maxTurns: 400 });
    const recDeps = mk({ repoRoot, backend: recoveryBackend, ...(deps.gateScope ? { gateScope: deps.gateScope } : {}), base: deps.baseBranch ?? 'main', log, llmReview, maxTurns: 400, buildLogPath: buildLogPath(buildId) });
    let rr;
    try { rr = await runOne(target, true, recDeps); }
    catch (e) { log(`[se-bridge] 시스템 리커버리 예외 → 실패 유지: ${e instanceof Error ? e.message.slice(0, 80) : ''}`); return fallback; }
    log(`[se-bridge] 🔧 시스템 리커버리 status=${rr.status} · ${rr.next}${rr.prUrl ? ` · PR ${rr.prUrl}` : ''}`);
    upsertBuildSafe({ buildId, missionId, phaseId: task.id, phaseTitle: task.title, index: 0, total: 0, attemptSeq: recSeq, backend: recoveryBackend, status: mapBuildStatus(rr.status), maxTurns: 400, ...(rr.prUrl ? { prUrl: rr.prUrl } : {}), gateResult: rr.next.slice(0, 200) });
    // 리커버리가 실제 변경+게이트 통과(built) → 성공.
    if (rr.status === 'built') {
      const pr = seResultToPhaseResult(rr);
      if (pr.ok) { onProgress('✅ 시스템 리커버리 성공 — 미충족 타겟 수정 완료'); return pr; }
    }
    // built 아니어도 grounded 재확인 — 최소 변경으로 닫혔는지.
    try {
      const v2 = await verifyNoop!(intent, acceptance);
      if (v2.satisfied) {
        log(`[se-bridge] ✅ 시스템 리커버리 후 grounded 충족(${v2.evidence.slice(0, 60)}) → PASS`);
        observe({ stage: 'recover', verdict: 'converge', rationale: `시스템 리커버리 성공 — 타겟 수정으로 grounded 충족: ${v2.evidence.slice(0, 120)}`, stateful: true });
        onProgress('✅ 시스템 리커버리 성공 — grounded 충족 확인');
        return { ok: true, summary: `✅ 시스템 리커버리: grounded 미충족을 타겟 수정해 충족 — ${v2.evidence}. VERDICT: PASS` };
      }
    } catch { /* fail-soft */ }
    // ★ 교착 감지(대표 2026-07-14·C) — 리커버리 opus 가 명시 missing + "no-op 금지" 강지시에도 변경 0
    //   (no-change)이면 구현자(opus '됐다') vs 검증자(grounded '미충족') 교착이다. 재시도/재구현은
    //   수렴 안 함(계속 no-op). 범위축소(revise)로 라우팅 — heal 오버라이드 마커([SE triage: revise]).
    //   그래야 카드가 "재구현"이 아니라 "골 정정(범위축소)"을 권장한다(#4104 effectiveCardHeal).
    if (rr.status === 'no-change') {
      log('[se-bridge] 🔒 구현자-검증자 교착 — 리커버리 opus 도 변경 0 → revise(범위축소) 권장(재시도 무의미)');
      observe({ stage: 'deadlock', verdict: 'stuck', rationale: 'opus 가 grounded 미충족을 명시 지시(no-op 금지)에도 변경 0(리커버리 포함 반복). 재시도/재구현 수렴 안 함 → revise(범위축소) 권장', missing, triageKind: 'revise', stateful: true });
      onProgress('🔒 교착(opus vs 검증자) — 범위축소 권장');
      return { ok: false, summary: `[SE triage: revise] 🔒 구현자-검증자 교착 — opus 가 grounded 미충족(${missing.slice(0, 80)})을 명시 지시(no-op 금지)에도 변경 0(리커버리 포함 반복). 재시도/재구현은 수렴 안 함 — 페이즈 범위를 좁히거나(정의만·검증은 후속 페이즈로) 검증 기준을 재검토하라. VERDICT: FAIL` };
    }
    log('[se-bridge] 시스템 리커버리 후에도 미충족 → 실패 유지(HITL·바운드 1회 소진)');
    observe({ stage: 'recover', verdict: 'fail', rationale: '시스템 리커버리(바운드 1회) 후에도 grounded 미충족 → 실패 유지(HITL)', missing, stateful: true });
    return fallback;
  };

  /** 실패 반환 직전 grounded 검증 — 이미 충족(file:line 근거)이면 PASS, 미충족이면 타겟 리커버리 1회. */
  const passIfAlreadySatisfied = async (failResult: PhaseResult): Promise<PhaseResult> => {
    if (!verifyNoop) return failResult;
    const intent = task.surface.kind === 'subagent' ? task.surface.prompt : task.title;
    const acceptance = task.acceptance?.criteria ?? [];
    try {
      const v = await verifyNoop(intent, acceptance);
      if (v.satisfied) {
        log(`[se-bridge] ✅ grounded 검증 — 이미 충족(${v.evidence.slice(0, 80)}) → 자동 PASS(실패 취소)`);
        observe({ stage: 'diagnose', verdict: 'pass', rationale: `grounded 검증 — 이미 구현돼 있음(변경 불필요·자동 PASS): ${v.evidence.slice(0, 120)}`, stateful: true });
        onProgress(`✅ 이미 구현됨(grounded 검증) — ${v.evidence.slice(0, 60)}`);
        return { ok: true, summary: `✅ grounded 검증: 이 페이즈는 이미 구현돼 있습니다 — ${v.evidence}. 변경 불필요·사람 확인 불요. VERDICT: PASS` };
      }
      // ★ 미충족 — missing 을 버리지 말고 타겟 리커버리 1회(시스템 자가 수렴·대표 2026-07-14).
      if (v.missing.trim() && recoverEnabled && !groundedRecoveryTried) {
        groundedRecoveryTried = true;
        return await runGroundedRecovery(v.missing, intent, acceptance, failResult);
      }
      log(`[se-bridge] grounded 검증 — 미충족(${v.missing.slice(0, 80)}) → 실패 유지`);
      observe({ stage: 'diagnose', verdict: 'fail', rationale: 'grounded 검증 — 미충족(리커버리 비활성/소진) → 실패 유지', missing: v.missing });
    } catch { /* fail-soft — 실패 유지 */ }
    return failResult;
  };
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    try { persistMissionRouteDecision(task.id, routeDecisionFromExecutionBackend(a.backend)); } catch { /* evidence is fail-soft */ }
    // ★ per-build 관측(PLAN B1) — 시도마다 새 buildId, 레지스트리 running + per-build 로그 tee.
    const attemptSeq = startSeq + i;
    const buildId = makeBuildId(task.id, attemptSeq);
    const blogPath = buildLogPath(buildId);
    // ★ 변곡점 진행 표시(대표 2026-07-12·빌드ID 2026-07-13·Layout A footer 2026-07-16) — 시도 시작을
    //   페이즈 카드 footer 에 접는다(별도 메시지 아님). 암호 빌드 id 는 여기(하단·내부)만. buildId 의
    //   _<attempt> 접미사는 '시도 N/M' 로 이미 보이므로 짧게(bld_<hex>). ops build <id> 로 logcat.
    onProgress(`⚙ ${modelLabel(a.backend)} · 시도 ${i + 1}/${attempts.length} · ${buildId.replace(/_\d+$/, '')}`);
    upsertBuildSafe({ buildId, missionId, phaseId: task.id, phaseTitle: task.title, index: 0, total: 0, attemptSeq, backend: a.backend, status: 'running', maxTurns: a.maxTurns });
    const seDeps = mk({ repoRoot, backend: a.backend, ...(deps.gateScope ? { gateScope: deps.gateScope } : {}), base: deps.baseBranch ?? 'main', log, llmReview, maxTurns: a.maxTurns, buildLogPath: blogPath });
    const r = await runOne(target, true, seDeps);
    log(`[se-bridge] status=${r.status} · backend=${a.backend} · maxTurns=${a.maxTurns} · ${r.next}${r.prUrl ? ` · PR ${r.prUrl}` : ''}`);
    upsertBuildSafe({ buildId, missionId, phaseId: task.id, phaseTitle: task.title, index: 0, total: 0, attemptSeq, backend: a.backend, status: mapBuildStatus(r.status), maxTurns: a.maxTurns, ...(r.prUrl ? { prUrl: r.prUrl } : {}), gateResult: r.next.slice(0, 200) });
    // ★ no-change grounded 게이트(대표 2026-07-14 · opus false no-op 실측) — no-change(변경 0)는
    //   **i 무관하게** grounded 검증을 태운다. 구 로직은 "진짜 no-op은 첫 시도에 나온다"는 가정으로
    //   i=0 no-change 를 무검증 PASS 했는데, 강한 모델(opus)도 게으르게 "변경 불필요"라 dodge 할 수
    //   있다(golden-set top-k 미구현인데 done 으로 샌 실측). 그래서 passIfAlreadySatisfied 로 코드를
    //   실독해 (a)충족 확증 → PASS (b)미충족 → 타겟 리커버리(missing 구현 1회) (c)그래도 미충족 →
    //   FAIL. 연쇄 가짜성공(KGS·golden-set) 차단. verifyNoop 미주입(테스트)이면 i=0 정당 no-op 만 PASS.
    if (r.status === 'no-change') {
      if (!verifyNoop) { if (i === 0) return seResultToPhaseResult(r); return { ok: false, summary: `⚠️ 가짜 no-op(i>0·검증기 미주입) — 자동 PASS 금지. VERDICT: FAIL` }; }
      log(`[se-bridge] no-op(변경 0·i=${i}) → grounded 검증으로 진짜/가짜 판별(i=0 dodge 포함)`);
      return passIfAlreadySatisfied({ ok: false, summary: `⚠️ 가짜 no-op — 에이전트가 변경 0("이미 됨")이라 했으나 grounded 검증이 충족을 확증 못 함(실제 미완). 자동 PASS 금지·재구현/재분할 필요. VERDICT: FAIL` });
    }
    result = seResultToPhaseResult(r);
    if (result.ok) return result; // built(PR) — 완주(no-change 는 위 grounded 게이트가 처리).
    if (r.status !== 'gate-failed' && r.status !== 'pr-failed') return result; // 재시도 무의미.
    // ★ 적응형 재시도 triage(대표 2026-07-14) — 게이트 실패 시, split-vs-계속을 구조적 정규식만이
    //   아니라 LLM 이 게이트 출력·비평 근거·구조 신호를 관찰해 근본 갈림길로 확실히 분류. 이전엔
    //   '구조적 2회->split·나머지 무조건 에스컬레이션'뿐이라 환경제약(gh 부재)이나 보안 경계를 못
    //   갈랐다. retry-escalate 는 다음 계단(자동), split/revise/skip/escalate 는 중단->실패 카드(HITL).
    const critiqueFindings = r.critique?.findings ?? [];
    seEvidence.push({
      attempt: i + 1, backend: a.backend, maxTurns: a.maxTurns, gateStatus: r.status, gateText: r.next,
      critiqueFindings, structural: isStructuralFailure(`${r.next} ${critiqueFindings.join(' ')}`),
    });
    const hasMoreRungs = i < attempts.length - 1;
    const nextRungLabel = hasMoreRungs ? `${modelLabel(attempts[i + 1]!.backend)} ${attempts[i + 1]!.maxTurns}턴` : undefined;
    const decision = await seTriageRetry(
      { phaseTitle: task.title, goal: task.surface.kind === 'subagent' ? task.surface.prompt.slice(0, 300) : task.title, attempts: seEvidence, priorDecisions: seDecisions, hasMoreRungs, ...(nextRungLabel ? { nextRungLabel } : {}) },
      { ...(triageClassify ? { classify: triageClassify } : {}) },
    );
    seDecisions.push(decision.path);
    log(`[se-bridge] 🧭 재시도 triage(${decision.source}) → ${decision.path} · ${decision.rationale}`);
    observe({ stage: 'triage', verdict: decision.isRetry ? 'event' : 'fail', triageKind: decision.path, rationale: `재시도 triage(${decision.source}) → ${decision.path}: ${decision.rationale}`.slice(0, 280), stateful: !decision.isRetry, refs: { attempt: i + 1, backend: a.backend, buildId } });
    if (!decision.isRetry) {
      // split/revise/skip/escalate — 계단 상향 무의미. 중단하고 권고를 실패 카드/진단에 노출(HITL).
      const labels: Record<SERetryPath, string> = { 'retry-escalate': '🔁 재시도', split: '✂️ 분할 필요', revise: '📝 골 범위 축소', skip: '⏭️ 건너뛰기', escalate: '🚨 사람 판단' };
      const label = labels[decision.path];
      onProgress(`${label} — ${decision.rationale.slice(0, 60)}`);
      return { ok: false, summary: `[SE triage: ${decision.path}] ${label} — ${decision.rationale} (${i + 1}회 시도·≤${a.maxTurns}턴). 계단 증액 무의미. VERDICT: FAIL` };
    }
    // retry-escalate — 다음 계단으로. triage 가이드(비평 반영 등)가 있으면 다음 시도 PLAN 에 주입.
    if (decision.injectGuidance.length) {
      try { appendFileSync(planPath, `\n\n## [재시도 가이드 · triage 시도${i + 1}]\n${decision.injectGuidance.map((g) => `- ${g}`).join('\n')}\n`); } catch { /* fail-soft */ }
    }
    // ★ 자기치유 grounded 유도(#4108 차용·대표 2026-07-14) — 다음 rung 을 돌기 *전에* 코드 실독으로
    //   (a) 이미 충족이면 PASS 단축(rung 낭비 0) (b) 미충족이면 missing 을 다음 rung PLAN 에 주입해
    //   opus 가 blind no-op 하기 *전에* 유도(no-op 예방). #4109 terminal 리커버리(no-op 후 복구)와
    //   이중 방어(예방+복구). 주입은 buildGroundedRecoveryDirective 공용(강 타겟·재사용≠결함동결).
    //   실패 경로 한정·fail-soft. verifyNoop 미주입(test 기본)은 skip.
    if (verifyNoop && hasMoreRungs) {
      const intent = task.surface.kind === 'subagent' ? task.surface.prompt : task.title;
      const acceptance = task.acceptance?.criteria ?? [];
      try {
        const v = await verifyNoop(intent, acceptance);
        if (v.satisfied) {
          log(`[se-bridge] ✅ 자기치유 grounded(재시도 전) — 이미 충족(${v.evidence.slice(0, 60)}) → 재시도 중단·PASS`);
          observe({ stage: 'prevent', verdict: 'pass', rationale: `예방(재시도 rung 전) grounded — 이미 충족 → 재시도 중단·PASS(rung 낭비 0): ${v.evidence.slice(0, 100)}`, importance: SELF_MEMORY_IMPORTANCE, stateful: true });
          onProgress(`✅ 이미 구현됨(grounded 검증) — ${v.evidence.slice(0, 60)}`);
          return { ok: true, summary: `✅ grounded 검증: 이 페이즈는 이미 구현돼 있습니다 — ${v.evidence}. 재시도 불필요. VERDICT: PASS` };
        }
        if (v.missing.trim()) {
          log(`[se-bridge] 🩹 자기치유(재시도 전) — grounded 진단을 다음 rung 에 주입: ${v.missing.slice(0, 80)}`);
          observe({ stage: 'prevent', verdict: 'inject', rationale: '예방(재시도 rung 전) — grounded missing 을 다음 rung PLAN 에 주입(opus blind no-op 예방)', missing: v.missing });
          onProgress(`🩹 자기치유 — 정확히 이것을 하라: ${v.missing.slice(0, 55)}`);
          try { appendFileSync(planPath, buildGroundedRecoveryDirective(v.missing)); } catch { /* fail-soft */ }
        }
      } catch { /* fail-soft — 유도 없이 다음 rung 진행 */ }
    }
    if (hasMoreRungs) {
      const next = attempts[i + 1]!;
      const msg = next.backend !== a.backend
        ? `🛡️ ${modelLabel(a.backend)} ${a.maxTurns}턴 실패 → 최종 방어: opus 4.8 폴백 시도`
        : `🔁 ${a.maxTurns}턴 실패 → 예산 상향 ${next.maxTurns}턴 재시도`;
      log(`[se-bridge] ${msg}`);
      observe({ stage: 'escalate', verdict: 'event', rationale: msg.replace(/[🛡️🔁]/g, '').trim(), refs: { fromBackend: a.backend, toBackend: next.backend, fromTurns: a.maxTurns, toTurns: next.maxTurns } });
      onProgress(msg);
    }
  }
  // ★ 에스컬레이션+폴백 소진(대표 2026-07-12) — terra 예산 계단 + opus 4.8 까지 다 실패. "왜" 를
  //   리포트에 명확히(어디까지 시도했는지 + 원 사유). 최강 모델·최대 예산으로도 안 됨을 바로 이해.
  // ★ 계단 소진 실패 반환 직전에도 grounded 검증 — 반복 gate-failed 가 실은 "이미 구현돼 있어
  //   새로 만들 게 없는" 경우(budget-exhausted 로 오분류되던 실측)를 코드 실독으로 구제(대표 2026-07-14).
  const exhaustedTrail = attempts.map((attempt) => `${modelLabel(attempt.backend)} ${attempt.maxTurns}턴`).join(' → ');
  const exhaustedFail: PhaseResult = attempts.length > 1
    ? { ...result, summary: `⏱️ ${exhaustedTrail}까지 시도했으나 실패${automaticOpusAllowed ? '' : ' — Opus 자동 승격은 정책상 차단됐으며, 축적된 근거로 HITL 승인을 요청해야 합니다'}. ${result.summary}` }
    : result;
  return passIfAlreadySatisfied(exhaustedFail);
}
