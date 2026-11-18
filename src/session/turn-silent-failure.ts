// OPENROUTER-CLAUDE(대표 11-17 · P0) — «조용한 실패 0».
//
// S: `eln --provider openrouter --model anthropic/claude-opus-5.5` 자리가 매 턴 1초 만에 «Turn done» 으로 끝났다.
//    본문 0자 · 화면 오류 0 · 사람이 볼 줄 0.
// C: 공급자는 401 을 냈고(`llm.provider-error`) 골 루프는 `stopReason=auth_rejected` 로 «돌려줬지만»(던지지 않음),
//    `runTurn` 의 골 루프 갈래는 `turnFailed` 만 세우고 빈 본문을 정상 결과로 넘겼다(코어 갈래는 이미 던진다).
//    공급자가 오류 없이 «빈 스트림»을 낸 경우도 같은 모양으로 «완료»가 됐다.
// Q: 공급자 오류·빈 응답을 어떻게 «화면의 ✗ 한 줄 ⊕ 로그 사건»으로 바꾸나?
// A: 턴 끝에서 두 가지를 판정해 «던진다» — 던진 오류는 REPL 이 TUI 의 오류 블록(✗)으로 보낸다.
//    ① 공급자 실패(auth_rejected·error) → `turn.provider-failed` ⊕ ✗ (공급자·모델·이유 · 비밀값 가림)
//    ② 본문 0자 ⊕ 도구 호출 0 ⊕ 오류 0 ⊕ 사람 중단 아님 → `turn.empty-response` ⊕ ✗ «empty response»
//    로거가 못 쓰는 경우(초기화 전·닫힌 저장소)에도 stderr 한 줄은 남긴다.

import { debug, redactSecretText } from '../debug/log.js';
import { formatAuthRejectedNotice } from '../core-turn/auth-rejected-notice.js';

const REASON_MAX = 160;

function oneLine(raw: string): string {
  const line = (redactSecretText(raw).split(/\r\n|\r|\n/, 1)[0] ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line;
}

/** 화면 ✗ 줄 — 공급자·모델·이유. 값(키·토큰)은 싣지 않는다. */
export function formatTurnFailureLine(provider: string, model: string | undefined, reason: string): string {
  return `✗ 모델 호출 실패 · provider=${provider} · model=${model || '(기본)'} · 이유: ${oneLine(reason)}`;
}

export class TurnSilentFailureError extends Error {
  readonly provider: string;
  readonly model: string | undefined;
  readonly reason: string;
  /** 401 이면 상위의 인증 판정(`isAuthRejectionError`)과 맞게 status 를 싣는다. */
  readonly status?: number;

  constructor(kind: 'provider-failed' | 'empty-response', provider: string, model: string | undefined, reason: string, status?: number) {
    super(formatTurnFailureLine(provider, model, reason));
    this.name = kind === 'empty-response' ? 'TurnEmptyResponseError' : 'TurnProviderFailedError';
    this.provider = provider;
    this.model = model;
    this.reason = oneLine(reason);
    if (status !== undefined) this.status = status;
  }
}

function observe(event: 'provider-failed' | 'empty-response', fields: Record<string, unknown>, line: string): void {
  let logged = false;
  try {
    debug.log('turn', event, fields, { level: 'error' });
    logged = true;
  } catch { /* 아래 stderr 로 */ }
  // 로거가 아직 없거나 죽었어도 사람이 볼 한 줄은 남긴다(조용한 실패 0).
  if (!logged) {
    try { process.stderr.write(`[turn.${event}] ${line}\n`); } catch { /* stderr 닫힘 */ }
  }
}

export interface TurnOutcomeInput {
  sessionId: string;
  provider: string;
  model: string | undefined;
  text: string;
  /** 이 턴에서 관측한 도구 호출 수. */
  toolCalls: number;
  /** 사람 중단(signal) — 빈 본문이어도 실패가 아니다. */
  aborted: boolean;
  /** 골 루프·코어 턴의 종료 이유(있으면). */
  stopReason?: string;
  /** 공급자 오류 원문(있으면 · 비밀값 가림 전). */
  errorMessage?: string;
}

/**
 * 턴 결과를 «성공으로 넘겨도 되는지» 판정한다. 아니면 관측 사건을 남기고 던진다.
 * 반환 = 정상(아무 일 없음).
 */
export function assertTurnNotSilentFailure(input: TurnOutcomeInput): void {
  if (input.aborted || input.stopReason === 'aborted') return;
  const base = { sessionId: input.sessionId, provider: input.provider, model: input.model ?? null };
  if (input.stopReason === 'auth_rejected' || input.stopReason === 'error') {
    const reason = input.stopReason === 'auth_rejected'
      ? formatAuthRejectedNotice(input.errorMessage)
      : (input.errorMessage || 'provider error');
    const err = new TurnSilentFailureError('provider-failed', input.provider, input.model, reason,
      input.stopReason === 'auth_rejected' ? 401 : undefined);
    observe('provider-failed', { ...base, stopReason: input.stopReason, reason: err.reason }, err.message);
    throw err;
  }
  if (input.text.trim().length === 0 && input.toolCalls === 0) {
    const reason = 'empty response (본문 0자 · 도구 호출 0 · 공급자 오류 없음)';
    const err = new TurnSilentFailureError('empty-response', input.provider, input.model, reason);
    observe('empty-response', { ...base, stopReason: input.stopReason ?? null, textChars: 0, toolCalls: 0 }, err.message);
    throw err;
  }
}
