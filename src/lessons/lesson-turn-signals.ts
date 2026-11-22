/**
 * POST-TURN-LESSON-REVIEW r2 — 턴 관측에서 원장 신호를 «결정적(LLM 없이)» 로 뽑는 검출기.
 *
 * 완료선 원문(eln release checklist 0.3.33 · POST-TURN-LESSON-REVIEW): «10턴 주기 검토 대신 원장 신호
 * (사람 정정·같은 오류 2회·리뷰 must·착지 거부·멈춤·승인 거절/초과·«기억해») 때만 값싼 모델 1회로
 * 교훈 0~1줄 후보(중복은 횟수+1 · 하루 상한 5)» — 정본 ASK-SEAT-ROLE-RETRO-MEMORY-ENGINE-1117.md «정정» §17-24.
 *
 * - 검출은 전부 결정적: 문구 목록·같은 서명 2회 카운트·원장 플래그(rejected/stalled/timeout)만 본다.
 * - 값싼 모델 호출은 seam(`summarizer` 주입) — 기본 구현은 결정적 한 줄 추출(신호 원문에서).
 *   배선이 LLM 이 아니어도 계약(0~1줄·중복 횟수+1·하루 상한 5)은 같다.
 */
import { debug } from '../debug/log.js';
import { budgetModel } from '../llm/model-defaults.js';
import { emitLessonSignal, type LessonSignalKind, type LessonSignalOptions, type LessonSignalInput, type LessonSignalOutcome } from './lesson-signal-capture-core.js';
import { FrictionLedger, type FrictionActor } from './friction-ledger.js';

/** 사람 정정 신호 문구 — 대표 11-17 정정 §20. */
export const HUMAN_CORRECTION_PHRASES: readonly string[] = ['아니', '정정', '그게 아니라', '되돌림', '다시 해', '틀렸'];
/** 사람 기억 지시 문구 — «기억해»·«앞으로». */
export const REMEMBER_PHRASES: readonly string[] = ['기억해', '앞으로'];

export type TurnObservationKind =
  | 'human-utterance'      // 사람 발화 원문 (utteranceOrigin === 'human')
  | 'tool-error'           // 같은 꼴 도구 오류 (signature = tool:name:errClass)
  | 'review-mustfix'       // 회수된 리뷰 must-fix ≥1 (signature = review:rule:pattern)
  | 'land-rejected'        // 착지 거부·회귀 (signature = land:L<n>)
  | 'stalled'              // 멈춤(A207 꼴)
  | 'approval-refused';    // 승인 거절·시간 초과

export interface TurnObservation {
  kind: TurnObservationKind;
  /** 같은 꼴 식별 서명 — MEMORY-SIGNALS §2-2 규칙(tool:name:errClass · review:rule:pattern · land:L<n>). */
  signature?: string;
  /** 관측 원문(human-utterance 사람 발화 · review-mustfix must-fix 항목 원문) — 요약자 evidenceText 로만 전달되고 원장 행에는 남지 않는다. */
  text?: string;
  /** 원장 참조(우편 id · PR-헤드 · 영수 경로). */
  ref: string;
}

/** 하루 상한 — 자리당 5(완료선 원문). */
export const DAILY_CANDIDATE_CAP = 5;

export interface TurnSignalOptions extends LessonSignalOptions {
  /** 값싼 모델 seam — 신호 1건을 받아 «다음에도 지킬 것 0~1줄» 을 낸다(주입 없으면 결정적 한 줄). */
  summarizer?: (signal: LessonSignalInput) => string | null;
  actor?: FrictionActor;
}

/** r12 — 원장·수집 단계가 필요한 옵션(요약자 제외) — 동기·비동기 양쪽 옵션에서 대입 가능. */
export type TurnSignalLedgerOptions = LessonSignalOptions & { actor?: FrictionActor };

/** r12 — 비동기(값싼 모델) 경로 옵션: summarizer가 Promise 를 돌려줘도 된다(Terra r11 [1]). */
export interface TurnSignalAsyncOptions extends Omit<TurnSignalOptions, 'summarizer'> {
  summarizer?: (signal: LessonSignalInput) => string | null | Promise<string | null>;
}

export interface TurnSignalResult {
  /** 발화한 신호(emitLessonSignal 결과 순서 대응). */
  outcomes: LessonSignalOutcome[];
  /** 상한에 걸려 띄우지 않은 신호 수. */
  capped: number;
}

function includesAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

/**
 * 턴 관측 전체를 훑어 원장 신호를 뽑고 즉시 발화한다(10턴 주기 아님 — 신호 있을 때만).
 * - 사람 정정/«기억해» 문구 → human-correction(«기억해» 는 사람 직접 지정이므로 하루 상한 밖).
 * - tool-error 서명 2회 관측 → repeat-error-2(같은 오류 2회 완료선) — **턴 간 이력은 friction 원장이 유지**
 *   (1회째 관측은 `observation:` 노트 행으로 기록, 다음 호출에서 그 행 수를 세어 2회째를 검출).
 * - review-mustfix·land-rejected·stalled·approval-refused → 1회 관측으로 신호.
 * - 하루 상한 5: 오늘 날짜의 후보 행 수를 원장에서 읽어(날짜 전환 리셋) 초과 신호는 capped 로 센다.
 * - 값싼 모델 1회 계약(0~1줄): 요약 줄(summarizer)이 없는 신호는 후보 행을 만들지 않는다 — «0줄 후보».
 * - fail-soft: summarizer·원장 오류는 관측 로그만 — 호출자(교정·리뷰 회수 경로)를 무너뜨리지 않는다.
 * - 측정(완료선 §24): memory.signal/turn-scan 관측 로그에 관측 수·발화 수·상한 컷 수.
 */
/**
 * r10 — 기본 결정적 요약(Terra mustFix ③): 주석이 약속한 «신호 원문에서 결정적 한 줄».
 * r12 — 동기 경로(시험·레거시 호출자)용 기본값. 실제 제품 경로(브리지)는 scanTurnSignalsAsync 의
 * cheapLessonSummarizer(값싼 모델 1회 = budget tier)를 쓴다 — 주석의 «값싼 모델 1회» 계약이 실경로에 연결된다.
 */
export function defaultLessonSummarizerSync(signal: LessonSignalInput): string {
  return `[${signal.kind}] ${signal.signature} — 다음에도 같은 꼴이면 ${signal.ref} 에서 먼저 확인`;
}

export async function cheapLessonSummarizer(signal: LessonSignalInput & { evidenceText?: string }, tryModel: (signal: LessonSignalInput & { evidenceText?: string }) => Promise<string | null> = runBudgetModelSummary): Promise<string | null> {
  // r16 — Terra r15b ②: 시험의 결정성은 «기본 모델 경로» 에만 적용 — 주입 tryModel 이 있으면 그 경로를
  // 그대로 실행한다(모델 실패 → null 폴백 검증이 시험 안에서 가능).
  if (process.env.BUN_TEST && tryModel === runBudgetModelSummary) return defaultLessonSummarizerSync(signal);
  try {
    const text = await tryModel(signal);
    if (!text) return null;
    return text.slice(0, 200);
  } catch (error) {
    // r16 — Terra r15b ②: 모델 실패 시 원문·서명 복사 폴백 금지 — 0줄 후보(계약: 0~1줄).
    debugSafe('cheap-summarizer-model-failed', { signature: signal.signature, reason: String(error).slice(0, 200) });
    return null;
  }
}

/** r16 — Terra r15b ②⑤: 값싼 모델 1회(budget tier) — 신호 원문(evidenceText)을 실제로 전달해 교훈을 추출한다. */
async function runBudgetModelSummary(signal: LessonSignalInput & { evidenceText?: string }): Promise<string | null> {
  const { streamLLM } = await import('../llm.js');
  const model = budgetModel();
  const system = '다음 원장 신호에서 «다음에도 지킬 것» 한 줄 교훈을 뽑는다. 원문·서명·비밀 그대로 복사 금지. 1줄, 120자 이하. 한국어.';
  const evidence = signal.evidenceText ?? '';
  const user = evidence
    ? `kind=${signal.kind} signature=${signal.signature} ref=${signal.ref}\n원문: ${evidence.slice(0, 500)}`
    : `kind=${signal.kind} signature=${signal.signature} ref=${signal.ref}`;
  const text = (await streamLLM(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    () => {},
    { model, maxTokens: 200 },
  )).trim();
  return text || null;
}

/**
 * r12 — Terra r11 [1]: 브리지 실경로 — 관측 수집 후 신호마다 값싼 모델(budget tier) 1회 요약·원장 발화.
 * 주입 summarizer(BUN_TEST 시험)가 없으면 cheapLessonSummarizer 기본.
 */
export async function scanTurnSignalsAsync(options: TurnSignalAsyncOptions, observations: readonly TurnObservation[]): Promise<TurnSignalResult> {
  const summarize = options.summarizer ?? cheapLessonSummarizer;
  const inputs = collectSignals(options, observations); // 관측 기록은 이 한 번(for side effects: recordObservation)
  const lines = new Map<LessonSignalInput, string | null>();
  for (const input of inputs) {
    try { lines.set(input, await summarize(input)); } catch { lines.set(input, null); }
  }
  return emitSignals(options, observations, inputs, lines);
}

/** r16 — Terra r15b ⑤: 요약자가 교훈을 추출할 증거 원문을 붙일 수 있다(원장·서명에는 절대 저장되지 않는다). */
export type SignalWithEvidence = LessonSignalInput & { evidenceText?: string };

/** r12 — 신호 수집(관측→입력)·발화(입력→원장) 분리: 동기 결정적·비동기(값싼 모델) 양쪽에서 재사용. */
function collectSignals(options: TurnSignalLedgerOptions, observations: readonly TurnObservation[]): SignalWithEvidence[] {
  const actor: FrictionActor = options.actor ?? 'person';
  const ledger = new FrictionLedger(options);
  const inputs: SignalWithEvidence[] = [];
  const errorSignatures = new Set<string>();
  const firedSignatures = new Set<string>();
  try {
    for (const obs of observations) {
      switch (obs.kind) {
        case 'human-utterance': {
          // r16 — Terra r15b ⑤: 사람 원문은 evidenceText 로 요약자에게만 전달(원장 note 에는 원문이 남지 않는다).
          const text = obs.text ?? '';
          const evidence = { evidenceText: text.slice(0, 500) };
          if (includesAny(text, HUMAN_CORRECTION_PHRASES)) inputs.push({ kind: 'human-correction', actor, signature: `human:correction:${obs.ref}`, ref: obs.ref, ...evidence });
          if (includesAny(text, REMEMBER_PHRASES)) inputs.push({ kind: 'human-correction', actor, signature: `human:remember:${obs.ref}`, ref: obs.ref, ...evidence });
          break;
        }
        case 'tool-error': {
          const signature = obs.signature ?? 'tool:unknown';
          // r7 — 관측 이력은 전용 `observation` 표에(후보 행과 분리 · Terra mustFix ④): candidates(2) 노출·발생 횟수 부풀림 없음.
          let observedBefore = false;
          try { observedBefore = ledger.countObservations(signature) >= 1; } catch { /* fail-soft */ }
          try { ledger.recordObservation({ actor, signature, ref: obs.ref }); } catch { /* fail-soft */ }
          const seenThisScan = errorSignatures.has(signature);
          if ((seenThisScan || observedBefore) && !firedSignatures.has(signature)) {
            inputs.push({ kind: 'repeat-error-2', actor, signature, ref: obs.ref, note: undefined }); // 같은 오류 «2회» — 서명당 한 번만
            firedSignatures.add(signature);
          }
          errorSignatures.add(signature);
          break;
        }
        case 'review-mustfix':
        case 'land-rejected':
        case 'stalled':
        case 'approval-refused': {
          // r17 — JUD-C #128647: must-fix 원문(문자열만·500자)을 값싼 모델 요약 입력에 전달(원장 note 는 obs.kind 그대로).
          const evidence = obs.kind === 'review-mustfix' && obs.text ? { evidenceText: obs.text.slice(0, 500) } : {};
          inputs.push({ kind: 'review-mustfix', actor, signature: obs.signature ?? `${obs.kind}:${obs.ref}`, ref: obs.ref, note: obs.kind, ...evidence });
          break;
        }
      }
    }
  } catch (error) {
    debugSafe('turn-scan-ledger-error', { reason: String(error).slice(0, 200) });
  }
  return inputs;
}

/** r12 — 발화 단계: 상한 원자 예약(reserveFiredOrNone) 후 요약 줄(0줄이면 후보 행 없음)로 원장에 남긴다. */
function emitSignals(_options: TurnSignalLedgerOptions, observations: readonly TurnObservation[], inputs: readonly LessonSignalInput[], lines: ReadonlyMap<LessonSignalInput, string | null>): TurnSignalResult {
  const ledger = new FrictionLedger(_options);
  const outcomes: LessonSignalOutcome[] = [];
  let capped = 0;
  for (const input of inputs) {
    const humanPinned = input.signature.startsWith('human:remember:');
    // r7 — 상한 판정과 예약을 한 트랜잭션으로(원자 · Terra mustFix ⑥). actor별 상한(⑤)·human:remember 예외(⑤).
    let reservation: { reserved: boolean; firedToday: number } | null = null;
    try {
      reservation = ledger.reserveFiredOrNone({ actor: input.actor, signal: input.kind, signature: input.signature, ref: input.ref, humanPinned, cap: DAILY_CANDIDATE_CAP });
    } catch (error) { debugSafe('reserve-error', { signature: input.signature, reason: String(error).slice(0, 200) }); }
    // r10 — 예약 실패(원장 오류로 reservation=null)에도 발화하지 않는다(fail-closed · Terra mustFix ⑦).
    if (!reservation || !reservation.reserved) { capped += 1; continue; }
    const line = lines.get(input) ?? null;
    if (line === null) { // 후보 줄 없음 — 후보 행 없이 관측만(«0줄 후보» · fail-soft 원칙과 동일)
      outcomes.push({ recorded: 0, recurred: false });
    } else {
      outcomes.push(emitLessonSignal(_options, { ...input, note: line }));
    }
  }
  debugSafe('turn-scan', { observations: observations.length, fired: outcomes.filter(o => o.recorded > 0).length, capped, actor: inputs[0]?.actor ?? 'person' });
  return { outcomes, capped };
}

export function scanTurnSignals(options: TurnSignalOptions, observations: readonly TurnObservation[]): TurnSignalResult {
  const inputs = collectSignals(options, observations);
  // r12 — 동기 경로(외부 호출자·레거시): 주입 summarizer 우선, 없으면 결정적 기본줄(값싼 모델은 scanTurnSignalsAsync).
  const summarize = options.summarizer ?? defaultLessonSummarizerSync;
  const lines = new Map<LessonSignalInput, string | null>();
  for (const input of inputs) {
    try { lines.set(input, summarize(input)); } catch { lines.set(input, null); }
  }
  return emitSignals(options, observations, inputs, lines);
}

/**
 * r12 — Terra r11 [0]: 리뷰 회수 경로(self-review-cli)의 실제 진입점. must-fix ≥1 리뷰 1건 = 신호 1건
 * (서명 PR+헤드 — 조각마다 발화하지 않는다). 값싼 모델 1회 요약·하루 상한은 scanTurnSignalsAsync 가 지킨다.
 * r17 — JUD-C #128647: mustFix 원문을 «안전하게» 전달한다 — 문자열 항목만, 항목당 200자, 전체 500자,
 * 공백 접기. 원문은 요약자 evidenceText 로만 흐르고 원장 행·서명에는 저장되지 않는다.
 */
export async function emitReviewMustFixSignal(options: TurnSignalAsyncOptions, pr: number | string, head: string, mustFix?: readonly unknown[]): Promise<TurnSignalResult> {
  const items = (mustFix ?? []).filter((item): item is string => typeof item === 'string');
  const text = items.map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).join('\n').slice(0, 500);
  return scanTurnSignalsAsync(options, [
    { kind: 'review-mustfix', signature: `review:${pr}:${String(head).slice(0, 10)}`, ref: `pr-${pr}`, ...(items.length > 0 ? { text } : {}) },
  ]);
}

/** r7 — 예약(reserveFiredOrNone)이 상한 판정과 발화 흔적을 원자적으로 남긴다(위 참조). */
function debugSafe(event: string, data: Record<string, unknown>): void {
  try { debug.log('memory.signal', event, data); } catch { /* fail-soft */ }
}

// 신호 종류·입출력 재노출(시험·장치 시나리오가 core 를 직접 import 하지 않아도 되게).
export type { LessonSignalKind, LessonSignalInput, LessonSignalOutcome };
