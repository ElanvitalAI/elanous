// ── 턴 UX 시뮬레이터 — 상태 팩토리 ───────────────────────────────────────────
//
// 🚨 왜 이것이 있나 (2026-08-19 · 대표 지시)
//   대표: *"mock 장치를 많이 만들어둬야 할것 같네요. 하니스 돌리는 상황이라던지,
//        스트리밍 나오는 상태라던지요. 그래야 실제 로직에 영향을 안주고 빠르게 UX 테스트가 가능"*
//   대표: *"시뮬레이션을 최대한 효율적으로 하는 mock 을 개발해주세요"*
//
// 📏 이 장치가 없어서 치른 값(같은 창의 실측):
//   ⓐ 스트리밍 상태를 만들려고 매번 «진짜 3분짜리 턴»을 돌렸다
//   ⓑ 서브에이전트가 도는 순간을 잡으려고 폴링 장치를 따로 지었고 «두 번» 놓쳤다
//   ⓒ 그러고도 ***렌더 층에서 필드가 떨어지는 버그***를 못 잡았다 —
//      위젯이 「필드를 골라」 새 state 를 만드는 자리에서 조용히 사라졌다
//
// ⭐⭐ 그래서 이 시뮬레이터의 설계 기준은 «빠름»이 아니라 ***「진짜 렌더 경로를 탄다」***다.
//   순수 상태 팩토리 → ***실제 위젯 `render()`*** → 프레임 문자열.
//   ⛔ 렌더러를 흉내 내지 않는다. 흉내 내면 오늘 놓친 그 버그를 «또» 못 잡는다.

import type { TurnTypeaheadState } from '../chat/turn-typeahead.js';
import { createTurnTypeaheadState, applyTurnTypeaheadKey } from '../chat/turn-typeahead.js';

/** 시뮬레이션할 턴 국면. 실제 화면에서 관측한 상태들을 그대로 이름 붙였다. */
export type TurnPhase =
  /** 아무것도 안 도는 상태 — 프롬프트만 */
  | 'idle'
  /** 모델이 생각 중 — footer 에 `✢ Thinking…` */
  | 'thinking'
  /** 토큰이 흐르는 중 — footer 에 `✶ Streaming…` */
  | 'streaming'
  /** 서브에이전트를 물고 도는 중 — footer 에 `✻ Streaming Agent (N tools)…` */
  | 'streaming-with-subagents'
  /** 하니스 자식(SelfImplement)이 도는 중 */
  | 'harness-child'
  /** 사용자가 중단한 직후 */
  | 'interrupted';

export interface TurnSimSpec {
  phase: TurnPhase;
  /** 큐에 쌓인 발화들(FIFO 순). */
  queued?: readonly string[];
  /** 컴포저에 남은 초안. */
  draft?: string;
  /** 도는 자식 수(`streaming-with-subagents` · `harness-child` 에서 의미 있음). */
  children?: number;
  /** 경과 초 — footer 문면에 들어간다. */
  elapsedSec?: number;
  /** 스크롤백 줄. 안 주면 국면에 맞는 기본 줄을 넣는다. */
  lines?: readonly string[];
}

/** ⭐ footer(스트리밍 표시줄) 문면 — 실제 화면에서 관측한 형태를 그대로 재현한다. */
export function simFooterLine(spec: TurnSimSpec): string | null {
  const t = spec.elapsedSec ?? 12;
  const n = spec.children ?? 0;
  switch (spec.phase) {
    case 'idle': return null;
    case 'thinking': return `✢ Thinking…  (${t}s)`;
    case 'streaming': return `✶ Streaming…  (${t}s · ↓ 512 tokens)`;
    case 'streaming-with-subagents': return `✻ Streaming Agent (${Math.max(1, n)} tools)…  (${t}s · ↓ 12 tokens)`;
    case 'harness-child': return `✽ Streaming SelfImplement (1 tools)…  (${t}s · ↓ 9 tokens)`;
    case 'interrupted': return null;
  }
}

/** 국면에 맞는 스크롤백 기본 줄. ⛔ 내용이 중요한 게 아니라 «형태»가 중요하다. */
export function simLines(spec: TurnSimSpec): string[] {
  if (spec.lines) return [...spec.lines];
  const head = ['  ❯ 시뮬레이션 프롬프트', ''];
  switch (spec.phase) {
    case 'idle': return [];
    case 'interrupted':
      return [...head, '  일부 답변이 여기까지 나왔습니다.', '',
        '  ✘ 중단됨  (24s · ↓ 34 tokens)'];
    case 'streaming-with-subagents': {
      const n = Math.max(1, spec.children ?? 2);
      return [...head, ...Array.from({ length: n }, (_, i) =>
        `  ⏺ Agent(시뮬 조사 ${i + 1})`), ''];
    }
    case 'harness-child':
      return [...head, '  ⏺ SelfImplement(시뮬 하니스 골)', ''];
    default:
      return [...head, '  스트리밍 본문이 흐르는 중입니다.', ''];
  }
}

/** ⭐ 큐 상태를 «실제 판정기»로 만든다 — 손으로 객체를 짓지 않는다.
 *  ⛔ 손으로 지으면 판정기가 바뀌었을 때 시뮬레이터만 옛 모양으로 남는다. */
export function simTypeaheadState(spec: TurnSimSpec): TurnTypeaheadState {
  let state = createTurnTypeaheadState();
  for (const text of spec.queued ?? []) {
    for (const ch of text) state = applyTurnTypeaheadKey(state, { name: ch } as never).state;
    state = applyTurnTypeaheadKey(state, { name: 'enter' } as never, () => true).state;
  }
  for (const ch of spec.draft ?? '') state = applyTurnTypeaheadKey(state, { name: ch } as never).state;
  return state;
}
