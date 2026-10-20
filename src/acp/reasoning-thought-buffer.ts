// TUI-TURN-NARRATION 조각 2 — 추론 요약(reasoning summary)을 화면 한 줄로 낸다.
//
// 🩸 왜 있나 (결함 #87 · 2026-10-18): gpt-6 계열 TUI 턴은 도구 사이에 글을 0자 낸다
//   (`llm.stream consume-end` `textChars=0`). 그런데 추론 요약은 라운드마다 24~37자씩 «온다»
//   (`reasoningChars`). `core-turn-bridge` 의 `onReasoning` 이 debug.log 로만 남기고
//   화면으로 안 보내서, 사용자는 «무엇을 하는지» 한 줄도 못 봤다.
//   대시보드는 이미 `agent_thought_chunk` ⊕ `_meta.reasoning` 을 흐린 💭 줄로 그린다
//   (`dashboard/chat/acp-chat.ts`) — 빠진 것은 «주는 자리» 하나였다.
//
// ⭐ 델타를 그대로 흘리지 않고 «문단» 단위로 모은다 — 델타마다 보내면 한 생각이 여러 줄로 찢긴다.
//   문단 경계 = 다음 `summary_part_added` · 도구 호출 · 답 글 시작 · 턴 끝.

export type ReasoningEvent =
  | { kind: 'summary_part_added'; summaryIndex?: number }
  | { kind: 'summary_delta'; delta: string; summaryIndex?: number };

export interface ReasoningThoughtBuffer {
  onEvent(event: ReasoningEvent): void;
  /** 모은 문단을 내보낸다(비었으면 아무것도 안 한다). */
  flush(): void;
}

/** 요약 문단은 짧다(실측 24~37자). 폭주 방어로만 자른다. */
const MAX_THOUGHT_CHARS = 400;

export function createReasoningThoughtBuffer(emit: (text: string) => void): ReasoningThoughtBuffer {
  let buf = '';
  const flush = (): void => {
    const text = buf.trim();
    buf = '';
    if (text.length === 0) return;
    emit(text.length > MAX_THOUGHT_CHARS ? `${text.slice(0, MAX_THOUGHT_CHARS)}…` : text);
  };
  return {
    onEvent(event) {
      if (event.kind === 'summary_part_added') {
        flush();
        return;
      }
      // 모으는 단계에서도 상한을 지킨다 — 문단 경계 없이 긴 스트림이 와도 버퍼가 무한히 크지 않게.
      if (buf.length <= MAX_THOUGHT_CHARS) buf += event.delta.slice(0, MAX_THOUGHT_CHARS + 1 - buf.length);
    },
    flush,
  };
}
