// TUI-STREAM-RETRY — 끊긴 스트림을 다시 걸 때 «이미 화면에 흘린 텍스트»를 두 번 보이지 않게 하는 관문.
//
// ⛔ 화면 쪽에는 «커밋하지 않고 지우는» 신호가 없다. TUI plain 경로는 `onText('', …)` 를 chunk 만 받아
//   `('', '')` 로 바꾸고, `turn-stream-formatter` 는 그것을 «clear-and-commit»(지난 글을 영구 보존)으로 읽는다.
//   ⇒ 되감기를 화면에 «알리는» 대신, 재시도 본문이 이미 보인 글과 겹치는 동안은 «안 내보내고»,
//     넘어서는 순간 그 뒷부분만 이어 붙인다. 이력(turnText)은 늘 재시도 본문이 정본이다.
//   ⚠️ 재시도 본문이 이미 보인 글과 «갈라지면» 지울 길이 없으니 커밋 경계(`onText('', '')`)를 한 번 내고
//     새 본문을 처음부터 흘린다 — 옛 조각은 지난 서술로 남는다(관측: `llm.retry stream-retry-display-diverged`).

export type RetryDisplayStep =
  | { kind: 'emit'; delta: string }
  | { kind: 'hold' }
  | { kind: 'diverged'; text: string };

export interface RetryDisplayGate {
  /** 끊김 뒤 재시도 직전에 부른다 — 지금 화면에 보이는 이 턴의 글을 «확인 대기»로 둔다. */
  arm(): void;
  /** 텍스트 델타가 turnText 에 붙은 «뒤» 부른다. 무엇을 화면에 낼지 돌려준다. */
  onText(delta: string, turnText: string): RetryDisplayStep;
  /** 스트림이 끝났을 때 — 확인 대기 중인데 재시도 본문이 보인 글과 다르면 갈라짐으로 낸다. */
  settle(turnText: string): RetryDisplayStep;
  /** 확인 대기 중인 글자 수(관측용). */
  heldChars(): number;
}

export function createRetryDisplayGate(): RetryDisplayGate {
  let visible = '';
  let replaying = false;
  return {
    arm() {
      replaying = visible.length > 0;
    },
    onText(delta, turnText) {
      if (!replaying) {
        visible += delta;
        return { kind: 'emit', delta };
      }
      if (visible.startsWith(turnText)) return { kind: 'hold' };
      replaying = false;
      if (turnText.startsWith(visible)) {
        const rest = turnText.slice(visible.length);
        visible = turnText;
        return { kind: 'emit', delta: rest };
      }
      visible = turnText;
      return { kind: 'diverged', text: turnText };
    },
    settle(turnText) {
      if (!replaying) return { kind: 'hold' };
      replaying = false;
      if (visible === turnText) return { kind: 'hold' };
      visible = turnText;
      return { kind: 'diverged', text: turnText };
    },
    heldChars() {
      return replaying ? visible.length : 0;
    },
  };
}
