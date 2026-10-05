// ── elanous 내부 프롬프트 인핸서 (범용·가산적) ──
//
// **범용 프롬프트 인핸서** — 어떤 실행자(코딩 에이전트·내부 스킬·goal-loop·오케스트레이터)의
// 어떤 작업(코드·콘텐츠·리서치·집행)이든, 들어온 원문 스펙을 실행 가능하게 **가산 보강**한다.
// elanous 실행 substrate 의 L2 능력 모듈(cross-cutting) — 특정 스킬/산출물 전용이 아니다.
//   (2계층: 외부=원문 verbatim 전송·재해석 금지 / elanous 내부=이 인핸서가 가산 보강.)
//
// ⭐제1 불변식 — 원문 verbatim 보존: 원문은 절대 수정/요약/삭제/재해석하지 않는다.
//   인핸싱은 **가산(additive)** 만 — 원문을 그대로 임베딩하고 그 위에 실행 스캐폴드(목표·제약·
//   요구 체크리스트)를 얹는다. (기원 = 상세 스펙을 요약으로 치환해 구체항목을 날린 드리프트 사건.
//    커버리지 체크리스트는 "여러 일반 기법 중 하나"지 목적 자체가 아니다.)
//
// 재사용: streamLLM(가산 스캐폴드 생성)·debug.log(관측). 원문 임베딩은 결정론(구조적 보존 보장).
import { tierModel } from '../llm/model-defaults.js';
import { streamLLM, type LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import type { LLMUsage } from '../prompt-cache/types.js';
import { llmUsageCostFields } from '../budget/llm-cost.js';

function logLlmUsage(model: string, usage: LLMUsage): void {
  try {
    debug.log('llm.usage', 'llm-usage', {
      site: 'prompt-enhance',
      model,
      ...(usage.provider !== undefined && { provider: usage.provider }),
      ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
      ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
      ...(usage.cacheCreationInputTokens !== undefined && { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
      ...llmUsageCostFields(model, usage),
    });
  } catch { /* usage observation must not change enhancement */ }
}

/** ⛔ 모듈 «안»에서만 쓴다 — 소비자가 생기면 그때 export 한다(무인 리뷰 must-fix 2026-08-26). */
type ChecklistProvenance = 'request' | 'preservation' | 'unknown';

export interface EnhanceResult {
  /** 원문 verbatim(무손상). */
  original: string;
  /** 원문(fenced) + 가산 스캐폴드. self-harness 에 이걸 보낸다. */
  enhanced: string;
  /** 원문에서 추출한 커버리지 항목(완주 판정 기준). */
  checklist: string[];
  /** checklist와 같은 인덱스의 생성 시점 출처. 기존 문자열 소비자와의 호환을 위해 가산적·선택적이다. */
  checklistProvenance?: ChecklistProvenance[];
  /** enhanced 안에 original 이 글자 그대로 들어있는가(항상 true — 구조적 보장). */
  verbatimPreserved: boolean;
  /** 스캐폴드 생성 주체. */
  enhancedBy: 'llm' | 'fallback';
  model: string | null;
  /**
   * SCQA 의 `S` — 그 자리가 «지금 어떤 상태인가». `groundedFacts` 를 준 호출자에게만 채워진다.
   * ⛔ 접지 문장을 옮겨 적은 것이 아니다 — 옮겨 적으면 근거 절과 글자 그대로 중복된다.
   */
  situation?: string;
  /** SCQA 의 `C` — 그 상태의 «무엇이 문제인가». 위와 같은 조건·같은 규율. */
  complication?: string;
  /**
   * 판정 신호 후보 — 「무엇이 참이면 이 골이 됐다고 볼 것인가」를 세 칸으로.
   *
   * ⛔ 왜 여기인가(2026-08-08): 저작기가 이것을 «스스로» 못 만들어서 사람이 매번 손으로 썼다.
   *   ⚠️ 휴리스틱으로 흉내내려는 시도가 «5라운드 UNCONVERGEABLE» 로 끝났다(run-92822cd2 ·
   *   리뷰: *"의미 연결이 공통 토큰 2개라는 휴리스틱뿐이라 일반어가 겹친 무관한 것에서도 신호를 생성"*).
   *   ⇒ ***의미를 잇는 일은 규칙으로 안 된다.*** 이 모듈이 이 경로의 유일한 LLM 단계이므로 여기서 만든다.
   * ⭐ 만들 수 없으면 «안 만든다» — 지어낸 신호는 없는 신호보다 나쁘다(호출자가 UNVERIFIABLE 을 낸다).
   */
  decisionSignal?: { condition: string; observation: string; expectedResult: string };
}

/**
 * 체크리스트를 «무엇에 쓰나» — 호출 경로마다 다르다.
 *
 * ⛔⭐⭐⭐ 왜 이 칸이 생겼나(2026-08-09 · 소비자 전수 감사): 프롬프트가
 *   *"이 체크리스트가 완주 판정 기준이다 — 하나라도 누락되면 미완이다"* 라고 «주장»하는데,
 *   ***그 문장이 호출 경로 넷 중 «하나»에서만 참이다.***
 *
 *     agent-mission/driver.ts:402   verifyCoverage(산출물, checklist) → missing·ratio   ✅ 진짜 관문
 *     self-implement/goal-author.ts 문서 렌더 ⊕ UNTRANSCRIBED 표시                      ⛔ 아무것도 «판정»하지 않는다
 *     self-implement/orchestrator.ts observe({checklist: …length}) — 개수만              ⛔ 아님
 *     harness/generic-skill-executor 프롬프트에 얹기만                                    ⛔ 아님
 *
 * 📏 그 거짓의 값: 저작 경로에서 `requestedCriteria` 가 평균 **40.2줄 / 2,935자(문서의 19.9%)**,
 *   실측 최대 **94**. ⇒ ***관문이 아닌 것을 관문이라 믿고 만든 나열이다.***
 *
 * ⛔ 기본값이 `coverage-gate` 인 이유 — 이 칸을 «안 주는» 경로는 지금 동작이 한 글자도 안 바뀌어야 한다.
 *   기본값을 뒤집으면 고치지 않은 호출부의 성질이 «조용히» 바뀐다.
 */
export type ChecklistUse = 'coverage-gate' | 'authoring';

export interface EnhanceOpts {
  /** 스캐폴드 생성 모델(기본 ELANOUS_PROMPT_ENHANCE_MODEL || ELANOUS_PR_REVIEW_MODEL || tierModel('better')). */
  model?: string;
  /**
   * 체크리스트의 «용도». 생략하면 `coverage-gate`(종전 동작).
   * ⭐ `authoring` 은 「완주 판정」이 아니라 「골 문서 재료」로 쓰는 경로가 준다.
   */
  checklistUse?: ChecklistUse;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** 산출물 유형 힌트(선택) — 예: 'PPT 발표덱', 'PLAN 문서'. 제약 문구 조정. */
  deliverableHint?: string;
  /** Optional usage observer for the caller's authoring phase; missing usage stays unknown. */
  onUsage?: (usage: LLMUsage) => void;
  /** 인핸싱 끄기(순수 verbatim). true 면 원문만 fenced 로 감싸 반환. */
  disabled?: boolean;
  /** Ask 원문 밖 스캐폴드에만 렌더할, 저작기가 관측한 디렉터리 실물 수. */
  directoryMeasurement?: string;
  /**
   * 접지가 Read 로 확인한 사실들 — 주면 `situation`/`complication` 을 «요약»으로 생성한다.
   *
   * ⛔ 왜 필요한가(2026-08-08 실측): 종전 `Situation` 은 ask 를 되풀이하고 개수를 붙였고,
   *   `Complication` 은 이 배열을 `join(' ')` 로 이어 붙였다. 접지 5건짜리 저작에서 그 한 줄이
   *   **1,236자**였고, 그 안의 문장은 근거 절·TRACED PATHS 에 **글자 그대로** 다시 나왔다.
   *   ⇒ SCQA 의 `S`·`C` 자리에 «기술»이 아니라 «나열»이 들어가 있었다.
   * ⭐ 새 LLM 경로를 만들지 않는다 — 이 모듈이 이미 그 자리의 유일한 LLM 단계다.
   */
  groundedFacts?: readonly string[];
}

const FENCE = '```';

/**
 * ask 에 「보존해야 할 표지」가 몇 개 있었나 — **결정론**이다(체크리스트와 문면을 대조하지 않는다).
 *
 * ⛔ 이 수는 「그중 몇 개가 체크리스트에 남았나」를 «답하지 않는다». 그 물음은 퍼지 매칭을 요구하고,
 *   그 매칭이 이 축의 앞선 런을 죽였다. 여기서는 ***분모만*** 낸다.
 */
function askMarkerCount(ask: string): number {
  return (ask.match(/(?:^|\s)(?:불변식|경계|판정\s*신호|invariant|boundary|decision\s+signal)\s*:/gi) ?? []).length;
}

const defaultModel = (): string =>
  process.env.ELANOUS_PROMPT_ENHANCE_MODEL || process.env.ELANOUS_PR_REVIEW_MODEL || tierModel('better');

/** 스캐폴드 생성 LLM 시스템 프롬프트 — 가산·원문불가침 규율. */
const enhanceSystem = (deliverableHint?: string, wantsScqa = false, checklistUse: ChecklistUse = 'coverage-gate'): string =>
  [
    '너는 elanous 의 범용 프롬프트 인핸서다. 사용자 원문(스펙)을 실행자(코딩 에이전트·내부 스킬·goal-loop 등)가 완수하도록 **가산적으로만** 보강한다.',
    '',
    // openclaw content-class 통찰: 사용자 원문은 "지시 컨텍스트"(요약 대상 아님)지, 외부 웹 콘텐츠(요약 대상)가 아니다.
    '원문은 "지시 컨텍스트"다 — 외부 웹 콘텐츠가 아니다. 요약·압축·일반화 대상이 아니라, 그대로 보존하고 그 위에 스캐폴드만 얹는 대상이다.',
    // Claude 규율: 이유를 붙이면 규칙이 패러프레이즈에 강해진다.
    '  (이유 — 사용자가 이 스펙을 준 목적 = 산출물이 그들의 구체 상황에 정확히 맞게 나오게 하려는 것. 일반화하면 준 목적 자체가 무너진다.)',
    '',
    '절대 불변식:',
    '- 원문을 수정/요약/삭제/재해석/일반화하지 않는다. 원문은 별도 블록으로 그대로 보존된다(네가 다시 쓰지 않는다).',
    // Codex 양방향: anti-drop + anti-invent. 모든 구체사실은 원문에서 추적 가능해야.
    '- 원문에 있는 것을 빠뜨리지도(anti-drop) 않고, 원문에 없는 것을 지어내지도(anti-invent) 않는다.',
    '  모든 구체 사실(수치·고유명사·날짜·순서·요구 장수)은 원문에서 추적 가능해야 한다.',
    '- 너는 원문 "위에 얹는" 실행 스캐폴드만 만든다.',
    '',
    '생성할 스캐폴드:',
    '1. goal — 원문이 요구하는 최종 산출물을 한두 줄로 재진술(요약 아님·산출물 지정).',
    '2. constraints — 실행 제약 문장들. 반드시 포함: "원문의 모든 항목/섹션을 산출물에 빠짐없이 반영(anti-drop)",',
    '   "원문에 없는 내용 지어내기 금지(anti-invent)", "일반화·요약·생략·재해석 금지, 구체 수치·고유명사·요구 장수를 원문 그대로 유지",',
    // Grok·openclaw: 생략은 침묵하지 말고 가시화(HITL 신호).
    '   "부득이 생략이 필요하면 침묵하지 말고 명시적으로 표시(visible omission)".',
    // 연구 ADOPT(탐색-먼저·Codex Plan/Gemini CLI) + 대표 landing-audit(§0.5): 지형을 먼저 조사해 재사용·재발명 금지.
    '   "구현/작업 전 관련 기존 코드·파일·함수·문서를 먼저 탐색(Read/Grep)해 지형을 파악하고, 이미 있는 것은 재사용하며 재발명하지 않는다(ground-before-act·anti-reinvention)".',
    // ⛔⭐⭐⭐ 여기가 용도로 갈린다 — 위 `ChecklistUse` 주석이 근거다.
    //   `coverage-gate` 문면은 «한 글자도» 안 바꾼다(agent-mission 의 verifyCoverage 가 실제로 그것으로 잰다).
    ...(checklistUse === 'authoring'
      ? [
        '3. checklist — ⛔ 원문을 «옮겨 적는 목록이 아니다».',
        '   원문 «전문»은 골 문서에 그대로 실려 구현자가 읽는다. 그러니 여기서 다시 적을 이유가 없다.',
        '   ⭐ 담을 것은 하나뿐이다 — ***그것이 없으면 구현자가 «다른 결정»을 내릴 수 있는 것.***',
        '   ⛔ 원문을 문장 단위로 쪼개지 않는다. ⛔ 같은 요구를 표현만 바꿔 여러 항목으로 만들지 않는다.',
        '   ⛔ 개수를 목표로 삼지 않는다 — 합치거나 지워서 수를 맞추지 않는다.',
        '   ⭐ 다만 다음 넷은 «항상» 항목으로 남긴다(골 문서의 다른 절이 각각 따로 소비하므로 빠지면 그 절이 빈다):',
        '     · 원문이 「불변식」으로 표시한 문장',
        '     · 원문이 「경계」로 표시한 문장',
        '     · 원문이 「판정 신호」로 표시한 문장의 조건·관측·기대',
        '     · 원문이 대상 경로로 지목한 파일 이름(빠지면 구현 대상을 좁히는 규칙이 다른 후보를 고른다)',
        '   상한·임계·횟수를 요구하는 항목은 원문에 수치가 있으면 그 수치를 담는다. 원문에 수치가 없으면 수치를 임의로 정하지 말라는 방어를 붙이지 말고, 그 수치를 묻는 기존 이름의 「미결 항목」으로 올린다.',
      ]
      : [
        '3. checklist — 원문이 명시한 **모든 요구·제약·산출물·수용기준**을 빠짐없이 추출한 문자열 배열(작업 종류 불문).',
        '   예: 코드=함수/엣지케이스/수용기준, 콘텐츠=섹션/수치/요구 장수, 리서치=질문/소스/인용, 집행=대상/한도.',
        '   구체 수치·고유명사·명시 개수를 지시하면 각각 개별 항목으로. 이 체크리스트가 완주 판정 기준이다 — 하나라도 누락되면 미완이다.',
      ]),
    '3a. checklistProvenance — checklist의 각 항목과 같은 인덱스에 "request" | "preservation" | "unknown"을 둔 배열.',
    '   각 출처는 checklist를 만들 때 원문에서 함께 판단한다. 보존 표지가 붙은 줄에서 온 항목만 "preservation", 그 외 원문 요청은 "request"다.',
    '   출처를 판단할 수 없거나 확신할 수 없으면 반드시 "unknown"을 쓴다. 추측으로 "preservation"을 기본값으로 쓰지 않는다.',
    // ⭐ SCQA 의 S·C — 접지 사실을 준 호출자에게만 요구한다. 안 주면 이 두 필드를 아예 언급하지 않는다.
    //   ⛔ 규율의 핵심은 「짧게」가 아니라 ***「옮겨 적지 마라」*** 다. 접지 문장은 골 문서의 다른 절에
    //     이미 글자 그대로 실리므로, 여기서 다시 적으면 그 자리는 «중복»이 되고 기술은 여전히 없다.
    ...(wantsScqa
      ? [
        '4. situation — 접지 사실이 보여 주는 «지금 그 자리의 상태»를 한두 문장으로 쓴다.',
        '   ⛔ 원문(ask)을 되풀이하지 않는다. ⛔ 접지 사실 문장을 그대로 옮겨 적지 않는다.',
        '   ⛔ 개수를 세어 보고하지 않는다("N개 항목" 같은 문장은 상태 기술이 아니다).',
        '5. complication — 그 상태의 «무엇이 문제인가»를 한두 문장으로 쓴다.',
        '   ⛔ 접지 사실을 나열하지 않는다. 나열은 근거 절이 이미 한다 — 너는 그 나열이 «왜 문제인지»를 쓴다.',
        '   ⭐ 판단이 안 서면 지어내지 말고 빈 문자열을 준다. 빈 값은 호출자가 종전 문면으로 되돌린다.',
        '6. decisionSignal — 「무엇이 참이면 이 요청이 «됐다»고 볼 것인가」를 세 칸으로.',
        '   condition       그 판정을 내리기 «전에» 무엇을 하는가 (실제로 돌릴 수 있는 한 가지 행동)',
        '   observation     그때 «무엇을 보는가» (파일·출력·로그 중 실제로 볼 수 있는 것)',
        '   expectedResult  그 관측이 «어떠해야» 됐다고 하는가',
        '   ⭐ 셋은 원문과 접지 사실에서 «잇는» 것이다. 원문에 없는 파일명·명령을 지어내지 않는다.',
        '   ⛔ 「테스트가 통과한다」처럼 무엇을 돌리는지 없는 문장은 쓰지 않는다.',
        '   ⛔ 셋 중 하나라도 근거에서 «못 이으면» 세 칸을 «전부» 비운다.',
        '      ***지어낸 신호는 없는 신호보다 나쁘다*** — 비우면 호출자가 「없다」고 정직하게 적는다.',
        '   ⛔ 검증 명령을 특정 언어로 가정하지 않는다. 근거에 있는 러너를 그대로 쓴다.',
      ]
      : []),
    ...(deliverableHint ? ['', `산출물 유형 힌트: ${deliverableHint}`] : []),
    '',
    wantsScqa
      ? 'JSON 만 출력: {"goal":"...","constraints":["..."],"checklist":["...","..."],"checklistProvenance":["request","preservation"],"situation":"...","complication":"...","decisionSignal":{"condition":"...","observation":"...","expectedResult":"..."}}'
      : 'JSON 만 출력: {"goal":"...","constraints":["..."],"checklist":["...","..."],"checklistProvenance":["request","preservation"]}',
  ].join('\n');

/** LLM 응답에서 {goal, constraints, checklist} JSON 파싱(관대). 실패 시 null.
 *
 * ⭐ `situation`/`complication` 은 **선택**이다 — 없으면 `undefined` 로 남고 호출자가 종전 문면을 쓴다.
 * ⛔ 이 둘이 없다고 파싱을 실패로 보지 않는다(체크리스트만이 실패 판정 기준이다). 그렇게 하면
 *   SCQA 요약을 안 쓰는 기존 호출자 전부가 폴백으로 떨어진다. */
export function parseEnhanceJson(
  raw: string,
): {
  goal: string;
  constraints: string[];
  checklist: string[];
  checklistProvenance?: ChecklistProvenance[];
  situation?: string;
  complication?: string;
  decisionSignal?: { condition: string; observation: string; expectedResult: string };
} | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const goal = typeof o.goal === 'string' ? o.goal.trim() : '';
  const asStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
  const constraints = asStrArr(o.constraints);
  const checklist = asStrArr(o.checklist);
  if (!checklist.length) return null; // 체크리스트 없으면 인핸싱 실패로 간주(폴백으로)
  const provenanceRaw = Array.isArray(o.checklistProvenance) ? o.checklistProvenance : [];
  const checklistProvenance = checklist.map((_, index): ChecklistProvenance => {
    const value = provenanceRaw[index];
    return value === 'request' || value === 'preservation' ? value : 'unknown';
  });
  const asText = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined; // 빈 문자열은 «안 준 것»과 같게 — 호출자가 폴백한다
  };
  // ⛔⭐ 판정 신호는 «셋이 다 차야» 받는다 — 하나라도 비면 «전부» 버린다.
  //   부분 신호는 소비자(goal-author-cli 의 decisionSignalFields)가 `extracted=true` 로 읽을 수 있는데
  //   실제로는 판정을 못 한다 ⇒ 「있다」와 「쓸 수 있다」가 갈리는 자리를 만들지 않는다.
  const signalRaw = o.decisionSignal;
  let decisionSignal: { condition: string; observation: string; expectedResult: string } | undefined;
  if (signalRaw && typeof signalRaw === 'object') {
    const s = signalRaw as Record<string, unknown>;
    const condition = asText(s.condition);
    const observation = asText(s.observation);
    const expectedResult = asText(s.expectedResult);
    if (condition !== undefined && observation !== undefined && expectedResult !== undefined) {
      decisionSignal = { condition, observation, expectedResult };
    }
  }
  return {
    goal,
    constraints,
    checklist,
    checklistProvenance,
    ...(asText(o.situation) !== undefined && { situation: asText(o.situation)! }),
    ...(asText(o.complication) !== undefined && { complication: asText(o.complication)! }),
    ...(decisionSignal !== undefined && { decisionSignal }),
  };
}

/**
 * 결정론 폴백 — LLM 없이 원문에서 요구 항목 추출(작업 종류 불문·범용).
 * 불릿(-·*), 번호목록, 헤더(===·##), 화살표(=>), 요구/수량 신호 라인을 항목으로. 원문 구조를 그대로 반영.
 */
export function extractChecklistFallback(raw: string): string[] {
  const items: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // 구조 후보(불릿/번호/화살표/헤더) 또는 요구/수량 신호(범용) — 도메인 무관.
    if (/^([-*•]|\d+[.)]|=>|##+\s|={3,}|-{3,})/.test(t) || /\d+\s*(개|장|건|회|초|분|원|\$)|반드시|필수|해야|must|required|shall/i.test(t)) {
      const cleaned = t.replace(/^([-*•]\s*|\d+[.)]\s*|=>\s*|#+\s*)/, '').trim();
      if (cleaned && cleaned.length > 1 && !/^=+$|^-+$/.test(cleaned)) items.push(cleaned.slice(0, 200));
    }
  }
  // 과다 방지 캡(원문이 방대하면 상위 구조만) — 그래도 원문 자체가 enhanced 에 통째로 있으니 손실 아님.
  return items.slice(0, 60);
}

/** 원문(verbatim) + 가산 스캐폴드를 조립. 원문은 fenced 로 통째 임베딩(구조적 보존). */
function assemble(original: string, goal: string, constraints: string[], checklist: string[], directoryMeasurement?: string): string {
  const parts = [
    '[VERBATIM 원문 — 편집·요약·재해석 금지. 아래가 최종 권위(SSOT)]',
    FENCE,
    original,
    FENCE,
    '',
    '[elanous 인핸싱 — 가산 스캐폴드. 충돌 시 위 원문이 항상 우선]',
  ];
  if (goal) parts.push(`## 목표\n${goal}`);
  if (directoryMeasurement) parts.push(`## 저작기 관측 실물 수\n${directoryMeasurement}`);
  if (constraints.length) parts.push(`## 실행 제약\n${constraints.map((c) => `- ${c}`).join('\n')}`);
  parts.push(
    `## 커버리지 체크리스트 (원문의 모든 항목 — 하나도 누락 금지·완주 판정 기준)\n${checklist
      .map((c) => `- [ ] ${c}`)
      .join('\n')}`,
  );
  return parts.join('\n');
}

/**
 * ★ 프롬프트 인핸싱(가산) — 원문을 verbatim 보존한 채 실행 스캐폴드를 얹는다.
 *   disabled 면 원문을 fenced 로만 감싸 반환(순수 verbatim). LLM 실패 시 결정론 폴백(체크리스트 추출).
 *   반환 enhanced 는 항상 원문을 글자 그대로 포함(verbatimPreserved 불변).
 */
export async function enhancePrompt(raw: string, opts: EnhanceOpts = {}): Promise<EnhanceResult> {
  const original = raw;

  if (opts.disabled) {
    const enhanced = `${FENCE}\n${original}\n${FENCE}`;
    debug.log('prompt-enhance', 'disabled', { origChars: original.length });
    return { original, enhanced, checklist: [], verbatimPreserved: true, enhancedBy: 'fallback', model: null };
  }

  const model = opts.model ?? defaultModel();
  let goal = '';
  let constraints: string[] = [];
  let checklist: string[] = [];
  let checklistProvenance: ChecklistProvenance[] | undefined;
  let situation: string | undefined;
  let complication: string | undefined;
  let decisionSignal: EnhanceResult['decisionSignal'];
  let enhancedBy: 'llm' | 'fallback' = 'llm';
  const groundedFacts = opts.groundedFacts ?? [];
  const wantsScqa = groundedFacts.length > 0;

  try {
    const messages: LLMMessage[] = [
      { role: 'system', content: enhanceSystem(opts.deliverableHint, wantsScqa, opts.checklistUse ?? 'coverage-gate') },
      {
        role: 'user',
        content: [
          '아래 원문을 인핸싱하라(원문은 수정하지 말고 스캐폴드만 JSON 으로):',
          '',
          original,
          // ⭐ 접지 사실은 «참고 입력»이다 — 원문이 아니다. 그래서 원문 뒤에 따로 붙인다.
          //   ⛔ 이것을 요약해 돌려주는 것이 아니라, 이것이 보여 주는 «상태와 문제»를 쓰는 것이다.
          ...(wantsScqa
            ? [
              '',
              '--- 접지가 Read 로 확인한 사실 (참고 입력 · 원문이 아니다) ---',
              ...groundedFacts.map((fact) => `- ${fact}`),
              '--- 여기까지 ---',
              '위 사실을 «옮겨 적지 말고», 그것이 보여 주는 상태(situation)와 문제(complication)를 써라.',
            ]
            : []),
        ].join('\n'),
      },
    ];
    const rawOut = await streamLLM(messages, () => {}, {
      model,
      reasoningEffort: opts.reasoningEffort ?? 'high',
      onUsage: (usage) => {
        logLlmUsage(model, usage);
        try { opts.onUsage?.(usage); } catch { /* usage observation must not change enhancement */ }
      },
    });
    const parsed = parseEnhanceJson(rawOut);
    if (parsed) {
      goal = parsed.goal;
      constraints = parsed.constraints;
      checklist = parsed.checklist;
      checklistProvenance = parsed.checklistProvenance;
      situation = parsed.situation;
      complication = parsed.complication;
      decisionSignal = parsed.decisionSignal;
    } else {
      enhancedBy = 'fallback';
    }
  } catch (e) {
    debug.log('prompt-enhance', 'llm-error', { error: String((e as { message?: string })?.message ?? e).slice(0, 160) }, { level: 'error' });
    enhancedBy = 'fallback';
  }

  // 폴백 — 결정론 체크리스트 추출(항상 커버리지 확보). LLM 이 constraints 를 못 줬으면 기본 제약 주입.
  if (!checklist.length) {
    checklist = extractChecklistFallback(original);
    checklistProvenance = checklist.map(() => 'unknown');
    enhancedBy = 'fallback';
  }
  if (!constraints.length) {
    constraints = [
      '원문의 모든 항목/섹션을 산출물에 빠짐없이 반영하라(anti-drop).',
      '원문에 없는 내용을 지어내지 마라(anti-invent) — 모든 구체 사실은 원문에서 추적 가능해야 한다.',
      '일반화·요약·생략·재해석을 금지하고, 구체 수치·고유명사·요구 장수를 원문 그대로 유지하라.',
      '부득이 생략이 필요하면 침묵하지 말고 명시적으로 표시하라(visible omission).',
    ];
  }

  // ⛔⭐ 「옮겨 적지 마라」를 «코드로» 확인한다 — 프롬프트에만 적으면 LLM 이 그대로 옮겨도 통과한다.
  //   접지 항목(또는 그 설명부)이 요약에 «글자 그대로» 들어 있으면 그 요약을 «버린다».
  //   ⇒ 버리면 호출자가 종전 문면으로 되돌아간다. 거짓 요약보다 «옛 문면»이 낫다.
  //   ⭐ 이것이 이 변경의 판정 신호를 만족시키는 자리다 — 프롬프트가 아니라 여기가 보장한다.
  //   ⊕ 원문(ask)도 같은 규율로 본다 — 무인 리뷰 should-fix(2026-08-08): 종전 `Situation` 의 결함이
  //     「ask 되풀이」였는데 그 금지는 프롬프트에만 있었다. 되풀이를 코드가 검사하지 않으면
  //     ***같은 결함으로 돌아가는 길이 열려 있다.*** 원문은 골 문서에 verbatim 으로 이미 실린다.
  const echoedSources = [...groundedFacts, original];
  const echoesInput = (text: string | undefined): boolean => {
    if (text === undefined) return false;
    return echoedSources.some((source) => {
      const whole = source.trim();
      if (whole.length === 0) return false;
      if (text.includes(whole)) return true;
      const dash = whole.indexOf(' — ');
      if (dash < 0) return false;
      const detail = whole.slice(dash + 3).trim();
      return detail.length > 0 && text.includes(detail);
    });
  };
  let scqaDropped: 'none' | 'situation' | 'complication' | 'both' = 'none';
  const situationEchoed = echoesInput(situation);
  const complicationEchoed = echoesInput(complication);
  if (situationEchoed) situation = undefined;
  if (complicationEchoed) complication = undefined;
  if (situationEchoed && complicationEchoed) scqaDropped = 'both';
  else if (situationEchoed) scqaDropped = 'situation';
  else if (complicationEchoed) scqaDropped = 'complication';

  // ⛔⭐ 판정 신호는 «관측 칸»이 비면 버린다 — 「무엇을 보는가」가 없으면 판정을 못 한다.
  //   ⚠️ 여기서는 echo 가드를 쓰지 «않는다»: 판정 신호는 근거의 파일명·명령을 «그대로 인용해야»
  //   실물을 무는데, echo 가드는 그것을 「옮겨 적었다」로 읽어 «옳은 신호를 버린다».
  //   ⇒ 같은 모듈 안에서도 «칸마다 규율이 다르다» — 요약은 옮기면 안 되고, 신호는 옮겨야 한다.
  const signalUsable = decisionSignal !== undefined && decisionSignal.observation.trim().length > 0;
  if (!signalUsable) decisionSignal = undefined;

  const enhanced = assemble(original, goal, constraints, checklist, opts.directoryMeasurement);
  const verbatimPreserved = enhanced.includes(original); // 구조적으로 항상 true

  debug.log('prompt-enhance', 'enhanced', {
    origChars: original.length,
    enhancedChars: enhanced.length,
    checklist: checklist.length,
    enhancedBy,
    model,
    verbatimPreserved,
    // ⭐ 관측 — 「요약을 요구했나 / 받았나 / 옮겨 적어 버렸나」를 «다른 값»으로 남긴다.
    //   ⛔ 안 요구한 것과 요구했는데 못 받은 것이 같은 값이면 이 배선이 도는지 알 수 없다.
    scqaRequested: wantsScqa,
    scqaSituation: situation === undefined ? 'absent' : 'present',
    scqaComplication: complication === undefined ? 'absent' : 'present',
    scqaDropped,
    groundedFacts: groundedFacts.length,
    // ⭐ 「요구했나 / 받았나」를 다른 값으로 — 이 배선이 실제로 도는지는 이 필드로만 보인다.
    decisionSignal: decisionSignal === undefined ? 'absent' : 'present',
  });

  // ⭐⭐ 체크리스트의 «모양» — 용도별로 갈린 뒤 실제로 무엇이 나왔나.
  //
  // ⛔⭐⭐⭐ 왜 「표지에서 온 항목 수」를 «세지 않나**: 그것을 세려면 체크리스트 문면과 ask 표지 문면을
  //   퍼지 매칭해야 하고, ***그 매칭이 바로 이 축의 앞선 런을 죽인 형태다***
  //   (run-b4f8f5df · 2026-08-08 · 감독: *"관측·테스트의 Goodhart 우회가 2라운드에도 동일 반복"*).
  //   ⇒ 대신 **결정론으로 셀 수 있는 것만** 낸다 — ask 에 표지가 «몇 개 있었나»(정규식 · 문면 대조 없음).
  //   그러면 「보존해야 했던 최소」와 「실제로 만든 수」가 «다른 값»으로 남고, 판정은 사람이 한다.
  debug.log('prompt-enhance', 'checklist-shape', {
    checklistUse: opts.checklistUse ?? 'coverage-gate',
    items: checklist.length,
    askMarkers: askMarkerCount(original),
    askChars: original.length,
  });

  return {
    original,
    enhanced,
    checklist,
    ...(checklistProvenance !== undefined && { checklistProvenance }),
    verbatimPreserved,
    enhancedBy,
    model,
    ...(situation !== undefined && { situation }),
    ...(complication !== undefined && { complication }),
    ...(decisionSignal !== undefined && { decisionSignal }),
  };
}
