// ── LLM 요청 본문 서로게이트 정리 (TUI-RECOVER-SKIPS-CREDITS · 0.2.36 · 2026-10-22 · OP P0) ──────────
//
// 🚨 실물(n8n 세션 · 설치본 99edcfa): 매 턴 즉시 실패 «자동 회복 2회 실패».
//   grok 원문 `Failed to parse the request body as JSON: messages[19].content: unexpected end of hex escape`
//   ⊕ 같은 요청에 codex `400 {"detail":"Bad Request"}`. 크레딧·폴백 순서 문제가 아니다 — 이력의 글 하나에
//   «짝 없는 서로게이트»(이모지를 UTF-16 단위로 자른 반토막)가 섞여 JSON 본문이 깨졌다. 새 세션⊕요약도 그 글을 싣는다.
// ⭐ 보내기 직전에 모든 문자열의 짝 없는 서로게이트를 U+FFFD 로 바꾼다 — 바뀐 메시지만 새로 만든다.
//
// 세 얼굴: 관측 = debug.log('llm.request', 'lone-surrogate-fixed', { messages, strings }) · 인지 = 짝 없는 서로게이트 ·
//   힐링 = U+FFFD 치환(글 하나가 깨져도 턴은 돈다) · 실패 없음.

/** 짝 없는 서로게이트를 U+FFFD 로 — 바뀌었으면 새 문자열. */
export function wellFormedString(value: string): string {
  const fn = (value as { toWellFormed?: () => string }).toWellFormed;
  if (typeof fn === 'function') return fn.call(value);
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

function isWellFormed(value: string): boolean {
  const fn = (value as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof fn === 'function') return fn.call(value);
  return wellFormedString(value) === value;
}

/** 값 속 문자열(객체 «키» 포함)을 훑어 고친다 — 바뀐 곳이 없으면 같은 참조를 돌려준다.
 *  깊이 제한은 두지 않는다(깊은 곳에 남으면 본문이 그대로 깨진다 · r1 must-fix) — 순환은 지금 걷는 경로 집합으로 끊는다. */
function fixValue(value: unknown, count: { strings: number }, path: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    if (isWellFormed(value)) return value;
    count.strings += 1;
    return wellFormedString(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (path.has(value)) return value;
  path.add(value);
  try {
    if (Array.isArray(value)) {
      let out: unknown[] | null = null;
      value.forEach((item, i) => {
        const next = fixValue(item, count, path);
        if (next !== item) { out ??= [...value]; out[i] = next; }
      });
      return out ?? value;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const nextKey = fixValue(key, count, path) as string;
      const next = fixValue(item, count, path);
      if (nextKey !== key || next !== item) changed = true;
      return [nextKey, next] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  } finally {
    path.delete(value);
  }
}

/** 메시지 배열 — 고친 메시지 수·문자열 수와 함께. 바뀐 게 없으면 같은 배열. */
export function wellFormedLLMMessages<T>(messages: readonly T[]): { messages: T[]; fixedMessages: number; fixedStrings: number } {
  const count = { strings: 0 };
  let fixedMessages = 0;
  let out: T[] | null = null;
  messages.forEach((message, i) => {
    const next = fixValue(message, count, new WeakSet<object>()) as T;
    if (next !== message) { fixedMessages += 1; out ??= [...messages]; out[i] = next; }
  });
  return { messages: out ?? (messages as T[]), fixedMessages, fixedStrings: count.strings };
}
