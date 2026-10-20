import { debug } from '../debug/log.js';
import type { LayoutZone } from '../layout/composer.js';
import {
  drawTurnTypeaheadPromptRows,
  type TurnTypeaheadPromptPaintSink,
  type TurnTypeaheadPromptRowsInput,
} from './input/turn-typeahead-prompt.js';

/** Dashboard draw entry for the input-prompt zone. Streaming redraws reach
 * this production binding through the zone renderer below. */
export function drawDashboardTurnTypeaheadPromptRows(
  input: TurnTypeaheadPromptRowsInput,
  sink?: TurnTypeaheadPromptPaintSink,
): string[] {
  return drawTurnTypeaheadPromptRows(input, sink);
}

/** Essential frames own the fallback prompt caret; Z-axis state only wins
 * when a modal has made a visible claim. */
export function buildDashboardTurnTypeaheadPromptZone(input: TurnTypeaheadPromptRowsInput & {
  suppressPromptArea: boolean;
}): LayoutZone {
  return {
    id: 'input-prompt',
    height: input.frame.inputHeight,
    render: (height, width) => {
      if (input.suppressPromptArea) return Array.from({ length: height }, () => ' '.repeat(width));
      return drawDashboardTurnTypeaheadPromptRows({ ...input, height, width });
    },
  };
}

/** 프롬프트 zone 에 관측만 덧입힌다 — 렌더 산출은 `inner` 가 소유한다.
 *
 *  ⭐ **왜 뽑았나**(무인 리뷰 must-fix · 2026-08-01): 종전엔 이 래퍼가 `zones.push({...})` 안에
 *  인라인이라, 테스트가 `inner`(=`buildDashboardTurnTypeaheadPromptZone`)만 불러도 통과했다.
 *  ⇒ ***래퍼가 `inner.render` 를 부르는 것을 끊어도 검사가 침묵***했다. 이제 그 결선이 검사된다.
 *
 *  ⛔⚠️ **여전히 검사 밖인 한 겹**: 이 함수의 반환이 실제로 `zones` 배열에 **push 되는지**는
 *  `showDashboard` 안의 지역 조립부라 단위 검사가 닿지 않는다. ***무한 후퇴이므로 여기서 경계를 긋는다*** —
 *  그 한 겹은 **라이브 검증**(`dev --elanous --hold` ⊕ `pty snapshot`)이 맡는다. */
export function observeDashboardTurnTypeaheadPromptZone(
  inner: LayoutZone,
  deps: {
    promptBottomRow: number;
    state: { buffer: string; queuedSubmissions: string[] };
    isDebugEnabled?: () => boolean;
    log?: (category: string, event: string, data: Record<string, unknown>) => void;
  },
): LayoutZone {
  return {
    ...inner,
    render: (height, width) => {
      const rows = inner.render(height, width);
      const enabled = deps.isDebugEnabled ? deps.isDebugEnabled() : debug.enabled;
      if (deps.state.buffer && enabled) {
        (deps.log ?? ((c, e, d) => debug.log(c, e, d)))('dashboard.turn-typeahead-prompt', 'dashboard-draw-prompt', {
          row: deps.promptBottomRow,
          text: rows.at(-1) ?? '',
          bufferLength: deps.state.buffer.length,
          queuedSubmissionCount: deps.state.queuedSubmissions.length,
        });
      }
      return rows;
    },
  };
}
