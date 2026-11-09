import { isRecord } from '../primitives/guards.js';
/** ⛔⭐⭐⭐ E-트랙 — 코덱스의 «물음»을 사람에게 닿게 한다.
 *
 *  📏 2026-08-21 전수 실측 (`[F]` 15차):
 *    `setElicitationHandler` 의 프로덕션 호출자가 **0** 이라 elanous 는 ***구조적으로 모든
 *    elicitation 을 거절***하고 있었다. 그리고 코드가 그 사실을 «이미 자기 입으로» 적어 두었다
 *    (`codex-app-server-agent.ts` — *"지금 elanous 는 구조적으로 모든 elicitation 을 거절한다"*).
 *  ⊕ 그런데 이 저장소엔 사람에게 묻는 기계가 «끝까지» 있다 —
 *    저장소(`ask-user-question/`) · PWA 시트 · 텔레그램 HITL · 배달 리졸버.
 *  ⇒ 📌 또 「기능이 없다」가 아니라 ***«있는데 그 경로가 안 쓴다»***였다.
 *
 *  ⛔⭐⭐ 그런데 두 물음의 «모양이 다르다» — 그래서 아무거나 잇지 않는다:
 *    elicitation      JSON 스키마로 «구조화된 값»을 요구한다(문자열·수·불리언·enum)
 *    AskUserQuestion  «객관식»을 묻는다(라벨 목록 중 고르기)
 *  ⇒ ***고를 수 있는 것만 잇고, 나머지는 이유를 대어 거절한다.*** 못 맞추는 답을 지어내면
 *    코덱스가 스키마에 안 맞는 값을 받아 «조용히» 잘못 진행한다. 그것이 거절보다 나쁘다. */
import type { CodexElicitationHandler, CodexElicitationResult } from './codex-app-server-agent.js';
import { dispatchAskUserQuestion, type AskUserQuestionDispatchResult } from '../ask-user-question/tool.js';
import type { AskUserQuestionRequest, Question } from '../ask-user-question/types.js';
import { debug } from '../debug/log.js';

/** 왜 사람에게 못 물었나. ⛔ 「거절」 하나로 뭉치면 「아무도 안 물었다」와 구분이 안 된다. */
export type ElicitationDeclineReason =
  | 'no-schema'
  | 'no-properties'
  | 'unmappable-property'
  | 'too-many-properties'
  | 'too-many-options'
  | 'ambiguous-labels'
  | 'answer-off-schema'
  | 'answer-missing'
  | 'no-answer-surface'
  | 'cancelled'
  | 'dispatch-failed';

/** AskUserQuestion 은 한 번에 1–3 개를 묻는다. 그 상한은 그 도구의 계약이지 이 파일의 취향이 아니다. */
const MAX_QUESTIONS = 3;

interface SchemaProperty {
  type?: unknown;
  enum?: unknown;
  title?: unknown;
  description?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** ⛔ 12자 상한은 `Question.header` 의 계약이다. 넘치면 자른다 — 안 자르면 표면이 깨진다. */
function header(name: string): string {
  return name.slice(0, 12);
}

/** `Question.options` 의 계약이 2–4 다. ⛔ 이 수는 그 도구의 것이지 이 파일의 취향이 아니다. */
const MAX_OPTIONS = 4;

/** 한 속성을 «고를 수 있는 물음»으로 바꾼 결과.
 *  ⛔ 「못 고른다」와 「고를 것이 너무 많다」는 다른 값이다 — 처방이 다르기 때문이다. */
export type PropertyPlan =
  | { ok: true; question: Question; valueByLabel: Record<string, unknown> }
  | { ok: false; reason: 'unmappable-property' | 'too-many-options' | 'ambiguous-labels' };

/** JSON Schema 의 enum 은 문자열만이 아니다 — 수·불리언·null 도 유효하다.
 *  ⛔📏 초판은 문자열만 받아 «유효한» 수 enum 을 거절했다(무인 리뷰 must-fix · 2026-08-21).
 *  ⭐ 그래서 라벨은 «표시용»이고, 되돌릴 값은 `valueByLabel` 이 «원본 그대로» 쥔다. */
function enumLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** 한 속성을 «고를 수 있는 물음»으로. 못 고르면 이유를 낸다 — 지어내지 않는다. */
export function questionFromSchemaProperty(name: string, property: unknown): PropertyPlan {
  if (!isRecord(property)) return { ok: false, reason: 'unmappable-property' };
  const spec = property as SchemaProperty;
  const prompt = text(spec.description) ?? text(spec.title) ?? name;

  if (Array.isArray(spec.enum)) {
    const labels = spec.enum.map(enumLabel);
    // ⛔ 하나라도 라벨로 못 만들면(객체·null 등) 그 물음은 «고르기»가 아니다.
    if (labels.some((label) => label === undefined)) return { ok: false, reason: 'unmappable-property' };
    if (spec.enum.length < 2) return { ok: false, reason: 'unmappable-property' };
    // ⛔⭐⭐ **조용히 자르지 않는다.** 초판은 앞 넷만 실어 ***사람이 고를 수 없는 값을
    //   「고를 수 있었던 것처럼」*** 만들었다(무인 리뷰 must-fix). 전부 못 보이면 «전체를» 거절한다.
    if (spec.enum.length > MAX_OPTIONS) return { ok: false, reason: 'too-many-options' };
    // ⛔⭐⭐⭐ **라벨이 겹치면 되돌릴 수 없다.** `[1, "1"]`·`[true, "true"]` 는 서로 «다른 JSON 값»인데
    //   표시 라벨이 같다 ⇒ 사용자가 고른 것을 ***다른 값으로*** 실어 보낸다(무인 리뷰 must-fix · 2026-08-21).
    //   ⇒ 겹치면 거절한다. 라벨을 억지로 구별하면(예: `1 (number)`) 사람이 보는 글이 스키마를 배신한다.
    if (new Set(labels).size !== labels.length) return { ok: false, reason: 'ambiguous-labels' };
    const valueByLabel: Record<string, unknown> = {};
    spec.enum.forEach((value, index) => { valueByLabel[labels[index]!] = value; });
    return {
      ok: true,
      valueByLabel,
      question: {
        id: name,
        header: header(name),
        question: prompt,
        options: labels.map((label) => ({ label: label!, description: '' })),
        // ⛔⭐ 자유 입력을 «끈다». 켜 두면 사람이 스키마에 없는 값을 적을 수 있고,
        //   우리가 그것을 `accept` 로 실어 보내면 상대가 「사용자가 그렇게 답했다」로 읽는다.
        includeOther: false,
      },
    };
  }
  // ⭐ 불리언은 둘이다. ⛔ 라벨을 「예」·「아니오」로 «번역»하지 않는다 — 되돌리는 왕복이 깨진다.
  if (spec.type === 'boolean') {
    return {
      ok: true,
      valueByLabel: { true: true, false: false },
      question: {
        id: name,
        header: header(name),
        question: prompt,
        options: [{ label: 'true', description: 'yes' }, { label: 'false', description: 'no' }],
        includeOther: false,
      },
    };
  }
  // ⛔ 자유 문자열·수는 «고르기»가 아니다. 여기서 멈춘다.
  return { ok: false, reason: 'unmappable-property' };
}

export interface ElicitationQuestionPlan {
  request?: AskUserQuestionRequest;
  /** 못 물을 때 «왜»인지. `request` 가 있으면 없다. */
  declineReason?: ElicitationDeclineReason;
  /** 라벨 → 스키마의 «원본 값». ⛔ 라벨은 표시용이고, 되돌릴 때는 이것만 믿는다. */
  valueByLabel: Record<string, Record<string, unknown>>;
}

/** 스키마 → 물음 계획. ⛔ 순수 함수다 — 이 파일의 판단 전부가 여기서 반증 가능해야 한다. */
export function planElicitationQuestions(schema: unknown, message?: string): ElicitationQuestionPlan {
  if (!isRecord(schema)) return { declineReason: 'no-schema', valueByLabel: {} };
  const properties = schema.properties;
  if (!isRecord(properties)) return { declineReason: 'no-properties', valueByLabel: {} };
  const names = Object.keys(properties);
  if (names.length === 0) return { declineReason: 'no-properties', valueByLabel: {} };
  if (names.length > MAX_QUESTIONS) return { declineReason: 'too-many-properties', valueByLabel: {} };

  const questions: Question[] = [];
  const valueByLabel: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    const planned = questionFromSchemaProperty(name, properties[name]);
    // ⛔⭐ 하나라도 못 고르면 «전체를» 거절한다. 부분 답은 스키마의 required 를 못 채우고,
    //   못 채운 답을 보내면 상대가 그것을 「사용자가 그렇게 답했다」로 읽는다.
    if (!planned.ok) return { declineReason: planned.reason, valueByLabel: {} };
    valueByLabel[name] = planned.valueByLabel;
    questions.push(planned.question);
  }
  // ⭐ 상대가 준 안내문은 «첫 물음 앞»에 붙인다 — 버리면 사람이 맥락 없이 고른다.
  const intro = text(message);
  if (intro && questions[0]) questions[0] = { ...questions[0], question: `${intro}\n\n${questions[0].question}` };
  return { request: { questions }, valueByLabel };
}

export type ElicitationContent =
  | { ok: true; content: Record<string, unknown> }
  | { ok: false; reason: 'answer-off-schema' | 'answer-missing' };

/** 답 → elicitation content.
 *
 *  ⛔⭐⭐ **답을 «검증한다».** 계획에 없던 키, 계획에 없던 라벨(자유 입력 등), 빠진 속성은
 *  전부 거절한다 — 초판은 그것들을 그대로 실어 보냈고, 그러면 상대가 스키마 밖 값을
 *  「사용자가 그렇게 답했다」로 읽는다(무인 리뷰 must-fix · 2026-08-21). */
export function contentFromAnswers(
  answers: Record<string, string | string[]>,
  valueByLabel: Record<string, Record<string, unknown>>,
): ElicitationContent {
  const content: Record<string, unknown> = {};
  for (const name of Object.keys(valueByLabel)) {
    const answer = answers[name];
    // ⛔⭐⭐ **복수 선택을 「첫 값」으로 조용히 접지 않는다.** 스키마는 «한 값»을 요구하는데
    //   사람이 둘을 골랐다면 우리는 그가 무엇을 뜻했는지 «모른다» — 하나를 골라 보내면
    //   상대가 그것을 「사용자가 그렇게 답했다」로 읽는다(무인 리뷰 must-fix · 2026-08-21).
    //   ⛔ 초판은 그 동작을 «시험으로 정당화»까지 했다. 그것이 이 파일이 막겠다던 바로 그 사고다.
    if (Array.isArray(answer) && answer.length !== 1) {
      return { ok: false, reason: answer.length === 0 ? 'answer-missing' : 'answer-off-schema' };
    }
    const label = Array.isArray(answer) ? answer[0] : answer;
    if (label === undefined) return { ok: false, reason: 'answer-missing' };
    if (!Object.prototype.hasOwnProperty.call(valueByLabel[name]!, label)) return { ok: false, reason: 'answer-off-schema' };
    content[name] = valueByLabel[name]![label];
  }
  // ⛔ 계획에 «없던» 키가 돌아오면 그 답은 우리가 물은 것이 아니다.
  for (const name of Object.keys(answers)) {
    if (!Object.prototype.hasOwnProperty.call(valueByLabel, name)) return { ok: false, reason: 'answer-off-schema' };
  }
  return { ok: true, content };
}

export interface ElicitationAskDeps {
  dispatch?: (
    raw: Record<string, unknown>,
    ctx?: { sessionId?: string; signal?: AbortSignal },
  ) => Promise<AskUserQuestionDispatchResult>;
  observe?: (event: string, data: Record<string, unknown>) => void;
}

function declined(reason: ElicitationDeclineReason, observe: NonNullable<ElicitationAskDeps['observe']>, server?: string): CodexElicitationResult {
  // ⛔ 식별자만 싣는다 — 물음 본문·답은 사용자 내용이다(그 판정 축은 호출부 주석이 canonical).
  observe('declined', { server, reason });
  return { action: 'decline' };
}

/** 코덱스의 elicitation 을 «사람에게 묻는 기존 기계»로 보낸다. */
export function createAskUserElicitationHandler(deps: ElicitationAskDeps = {}): CodexElicitationHandler {
  const dispatch = deps.dispatch ?? ((raw, ctx) => dispatchAskUserQuestion(raw, ctx));
  const observe = deps.observe ?? ((event, data) => debug.log('mcp.elicitation.ask', event, data));

  return async ({ server, message, schema }) => {
    const plan = planElicitationQuestions(schema, message);
    if (!plan.request) return declined(plan.declineReason ?? 'no-schema', observe, server);

    let dispatched: AskUserQuestionDispatchResult;
    try {
      dispatched = await dispatch(plan.request as unknown as Record<string, unknown>, {});
    } catch {
      return declined('dispatch-failed', observe, server);
    }
    // ⛔⭐ 「답할 표면이 없다」와 「사람이 거절했다」는 다른 값이다 — 이름으로 가른다.
    if (dispatched.absenceReason !== undefined) return declined('no-answer-surface', observe, server);
    if (!dispatched.result) return declined('dispatch-failed', observe, server);
    if (dispatched.result.cancelled === true) return declined('cancelled', observe, server);

    const mapped = contentFromAnswers(dispatched.result.answers, plan.valueByLabel);
    if (!mapped.ok) return declined(mapped.reason, observe, server);
    observe('accepted', {
      server,
      questionCount: plan.request.questions.length,
      answeredKeys: Object.keys(mapped.content).length,
      answeredBy: dispatched.result.answeredBy,
    });
    return { action: 'accept', content: mapped.content };
  };
}
