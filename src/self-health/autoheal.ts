// ── 자동 회복 (TUI-400-AUTOHEAL-FALLBACK · 대표 10-22) ──
//
// 대표 «400 같은 오류로 멈추면 스스로 회복 · 자동 provider fallback 이 없으면 작업을 못 잇는다».
// 실측(10-22 07:1x OPT): TUI 턴이 «Codex API 400(대화 기록 어긋남 의심)» 로 끝나고 멈췄다 — 지문
// `codex-400-bad-request` 는 «/session new 뒤 다시» 를 사람에게 «보여줄» 뿐이었고, OP 가 손으로 쳐서 회복했다.
//
// 이 모듈은 «판정»만 갖는다(순수 · 관측·화면은 호출부가 남긴다). 사다리:
//   ① 같은 턴 400(대화 기록) → 새 백엔드 세션 ⊕ 직전 요약(짧게)으로 1회 재시도
//   ② 그래도 400 → `llm.fallbackChain` 다음 공급자로 그 턴 재시도
//   ③ 그래도 실패 → 턴당 2회 상한에서 멈추고 사람에게 이유 한 줄
// ⛔ 답·도구 호출이 이미 흘렀으면 다시 보내지 않는다(중복 출력·부작용). ⛔ 무한 반복 금지(AUTOHEAL_MAX_ATTEMPTS).
// 📋 관측 = `debug.log('self-health.autoheal', attempt|recovered|exhausted|skipped, …)` — 호출부(plain-turn 런타임).

import { matchFailureText, type FailureSignature } from './signatures.js';

/** 턴당 자동 회복 상한 — ① 새 세션 ② 공급자. ⛔ 늘리면 «무한 반복 금지» 판정선이 같이 움직인다. */
export const AUTOHEAL_MAX_ATTEMPTS = 2;

export type AutohealStep = 'new-session' | 'provider-fallback';

/** 재시도 요청에 실리는 ACP `_meta` 키 — 서버 다리(`core-turn-bridge`)가 «이 턴은 다음 공급자로» 를 읽는다.
 *  ⛔ 공급자 «이름»은 싣지 않는다 — 고르는 것은 서버가 자기 `llm.fallbackChain` 으로 한다(클라이언트가 지갑을 못 고른다). */
export const AUTOHEAL_META_KEY = 'elanousAutoheal';

export interface AutohealProviderFallbackMeta {
  readonly providerFallback: true;
}

export function autohealProviderFallbackMeta(): Record<string, AutohealProviderFallbackMeta> {
  return { [AUTOHEAL_META_KEY]: { providerFallback: true } };
}

/** 프롬프트 `_meta` 에 «다음 공급자로» 표지가 있나. */
export function readAutohealProviderFallback(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  const value = meta?.[AUTOHEAL_META_KEY];
  return typeof value === 'object' && value !== null
    && (value as { providerFallback?: unknown }).providerFallback === true;
}

/** 자동 회복을 거는 지문 — 오류 «원문»으로 판정한다(지문 번역문으로 판정하면 안 걸린다 · #27452 교훈). */
export function autohealSignatureFor(detail: string): FailureSignature | null {
  const sig = matchFailureText(detail);
  return sig?.autoheal ? sig : null;
}

export type AutohealStopReason =
  | 'not-autoheal-signature'
  | 'output-emitted'
  | 'tool-dispatched'
  | 'aborted'
  | 'history-changed'
  | 'no-fallback-provider'
  | 'max-attempts';

export type AutohealDecision =
  | { readonly kind: 'retry'; readonly step: AutohealStep; readonly attempt: number; readonly provider?: string }
  | { readonly kind: 'stop'; readonly reason: AutohealStopReason };

export interface AutohealDecisionInput {
  /** 이번 실패의 오류 원문. */
  readonly detail: string;
  /** 이미 한 자동 회복 횟수(0 = 첫 실패). */
  readonly attemptsDone: number;
  /** 이 턴에서 답·도구 호출이 화면/서버로 흘렀나. */
  readonly emitted: boolean;
  /** 도구 실행 수가 바뀌었나(모르면 false — 그때는 emitted 로만 가른다). */
  readonly toolDispatched: boolean;
  readonly aborted: boolean;
  /** ② 칸에서 쓸 다음 공급자(없으면 null). ① 칸에서는 안 본다. */
  readonly fallbackProvider: string | null;
}

/** 다음 한 걸음. 순수 — 같은 입력이면 같은 답. */
export function decideAutohealStep(input: AutohealDecisionInput): AutohealDecision {
  if (!autohealSignatureFor(input.detail)) return { kind: 'stop', reason: 'not-autoheal-signature' };
  if (input.aborted) return { kind: 'stop', reason: 'aborted' };
  if (input.emitted) return { kind: 'stop', reason: 'output-emitted' };
  if (input.toolDispatched) return { kind: 'stop', reason: 'tool-dispatched' };
  if (input.attemptsDone >= AUTOHEAL_MAX_ATTEMPTS) return { kind: 'stop', reason: 'max-attempts' };
  if (input.attemptsDone === 0) return { kind: 'retry', step: 'new-session', attempt: 1 };
  if (!input.fallbackProvider) return { kind: 'stop', reason: 'no-fallback-provider' };
  return { kind: 'retry', step: 'provider-fallback', attempt: 2, provider: input.fallbackProvider };
}

/** 화면 한 줄 — 시도할 때. */
export function formatAutohealAttemptLine(decision: Extract<AutohealDecision, { kind: 'retry' }>): string {
  const what = decision.step === 'new-session' ? '새 세션 ⊕ 요약으로' : `공급자 ${decision.provider ?? '?'} 로`;
  return `자동 회복: ${what} 다시 시도 (${decision.attempt}/${AUTOHEAL_MAX_ATTEMPTS})`;
}

export interface AutohealAttemptRecord {
  readonly step: AutohealStep;
  readonly provider?: string;
}

/** 화면 한 줄 — 상한에서 멈출 때. 한글 두 칸으로 130칸 안(지문 한 줄과 같은 규율). */
export function formatAutohealExhaustedNotice(
  attempts: readonly AutohealAttemptRecord[],
  reason: AutohealStopReason,
  opts: { rawHint?: string } = {},
): string {
  const steps = attempts.map((a) => (a.step === 'new-session' ? '새 세션' : `공급자 ${a.provider ?? '?'}`)).join(' → ');
  const why = reason === 'no-fallback-provider' ? `${steps} · 대체 공급자 없음` : steps;
  const raw = opts.rawHint ? ` · 원문 ${opts.rawHint}` : '';
  return `⚠ 자동 회복 ${attempts.length}회 실패(${why}) → 잠시 뒤 다시 · eln usage${raw}`;
}

/** 상한에서 멈춘 턴 — 메시지는 «원문 그대로»(지문·#27452 판정이 원문으로 돈다), 회복 이력은 따로 싣는다. */
export class AutohealExhaustedError extends Error {
  constructor(
    readonly original: unknown,
    readonly attempts: readonly AutohealAttemptRecord[],
    readonly reason: AutohealStopReason,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'AutohealExhaustedError';
  }
}

/** 직전 요약을 «짧게» — 이미 있는 압축 요약(`compactConversation`)을 쓰고, 실패·시간 초과면
 *  같은 압축 모듈의 대화록(`buildCompactTranscript`) 꼬리로 대신한다. ⛔ 여기서 요약을 다시 만들지 않는다. */
export async function summarizeForAutoheal<T>(
  prior: readonly T[],
  deps: {
    compact: (history: readonly T[]) => Promise<{ summary: string }>;
    transcript: (history: readonly T[]) => string;
    timeoutMs?: number;
    maxChars?: number;
  },
): Promise<{ summary: string; source: 'compact' | 'transcript-tail' | 'empty' }> {
  const maxChars = deps.maxChars ?? 1_200;
  const clip = (text: string, tail: boolean): string => {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return tail ? `…${trimmed.slice(-maxChars)}` : `${trimmed.slice(0, maxChars)}…`;
  };
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('autoheal summary timed out')), deps.timeoutMs ?? 20_000);
    });
    try {
      const { summary } = await Promise.race([deps.compact(prior), timeout]);
      if (summary.trim()) return { summary: clip(summary, false), source: 'compact' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch { /* 요약 실패는 대화록 꼬리로 — 회복을 막지 않는다 */ }
  const transcript = deps.transcript(prior);
  return transcript.trim()
    ? { summary: clip(transcript, true), source: 'transcript-tail' }
    : { summary: '', source: 'empty' };
}
