/** 대기 중 프롬프트 띠의 «주인 하나» (TUI-PROMPT-SINGLE-OWNER · 2026-10-17).
 *
 *  종전엔 띠를 둘이 그렸다 — frame 렌더러 zone 은 `❯ ` 를, textInput `drawInput` 은
 *  실제 버퍼를 직접 stdout 에 썼다. 직접 쓰기가 행 캐시를 무효화하므로 대기 중 매 draw
 *  (2Hz 상태줄 틱 포함)가 «zone 이 `❯ ` 로 지움 → afterRender 덧칠이 버퍼로 다시 씀»을
 *  되풀이했고, 프롬프트·구분선·상태줄이 매 프레임 `\x1b[2K` 로 다시 나갔다.
 *
 *  ⭐ 이제 textInput 은 그릴 줄을 여기 **올리기만** 하고(publish), 실제 쓰기는 frame
 *  렌더러 zone 하나가 한다. 행 캐시 diff 가 바뀐 줄만 내보내므로 대기 중 재출력은 0 이다. */
import { debug } from '../debug/log.js';
import type { LayoutZone } from '../layout/composer.js';
import type { CursorState } from './cursor-state.js';

export interface PromptRowPaint {
  /** 위→아래 순서의 보이는 프롬프트 줄(접두·패딩 포함 · 행 지움 없음). */
  rows: string[];
  /** 프롬프트 아래 둘째 줄의 일시 힌트(Ctrl+C 등). 없으면 null. */
  hint: string | null;
  caret: CursorState | null;
  source: 'text-input' | 'reverse-search';
}

export interface PromptRowOwner {
  /** 같은 그림이면 false(프레임 요청 없음) — 대기 중 외부 repaint 가 no-op 이 되는 자리. */
  publish(paint: PromptRowPaint): boolean;
  clear(): void;
  current(): PromptRowPaint | null;
}

export type PromptRowOwnerLog = (category: string, event: string, data: Record<string, unknown>) => void;

const CATEGORY = 'dashboard.prompt-owner';

const paintKey = (paint: PromptRowPaint): string => JSON.stringify(paint);

export function createPromptRowOwner(deps: {
  requestFrame: () => void;
  isDebugEnabled?: () => boolean;
  log?: PromptRowOwnerLog;
}): PromptRowOwner {
  let paint: PromptRowPaint | null = null;
  let key = '';
  const enabled = (): boolean => (deps.isDebugEnabled ? deps.isDebugEnabled() : debug.enabled);
  const log: PromptRowOwnerLog = deps.log ?? ((c, e, d) => debug.log(c, e, d));
  return {
    publish(next) {
      const nextKey = paintKey(next);
      if (nextKey === key) return false;
      paint = next;
      key = nextKey;
      if (enabled()) {
        log(CATEGORY, 'publish', {
          source: next.source,
          rows: next.rows.length,
          hint: next.hint !== null,
          caretRow: next.caret?.row ?? null,
          caretCol: next.caret?.col ?? null,
        });
      }
      deps.requestFrame();
      return true;
    },
    clear() {
      if (!paint) return;
      paint = null;
      key = '';
      if (enabled()) log(CATEGORY, 'clear', {});
      deps.requestFrame();
    },
    current: () => paint,
  };
}

/** 바닥 기준으로 `height` 줄에 맞춘다 — 입력 줄이 늘면 위로 자란다(textInput 과 같은 앵커). */
export function renderPromptOwnerRows(paint: PromptRowPaint, height: number): string[] {
  // ⚠️ `slice(-0)` is the whole array — a zero-height zone must paint nothing.
  if (height <= 0) return [];
  const visible = paint.rows.slice(-height);
  return [...Array.from({ length: height - visible.length }, () => ''), ...visible];
}

export type PromptBandOwner = 'text-input' | 'turn-typeahead' | 'suppressed';

/** 누가 띠를 그렸나 — 주인·그림(줄·힌트·caret)이 바뀔 때 한 줄, 같은 상태(대기)는 10초에 한 줄로 샘플링. */
export function createPromptBandRenderObserver(deps: {
  isDebugEnabled?: () => boolean;
  log?: PromptRowOwnerLog;
  now?: () => number;
  sampleMs?: number;
} = {}): (owner: PromptBandOwner, frameKey: string) => void {
  const now = deps.now ?? Date.now;
  const sampleMs = deps.sampleMs ?? 10_000;
  let lastOwner: PromptBandOwner | null = null;
  let lastFrameKey = '';
  let lastLoggedAt = 0;
  let renders = 0;
  return (owner, frameKey) => {
    renders++;
    const enabled = deps.isDebugEnabled ? deps.isDebugEnabled() : debug.enabled;
    if (!enabled) return;
    const changed = owner !== lastOwner || frameKey !== lastFrameKey;
    const at = now();
    if (!changed && at - lastLoggedAt < sampleMs) return;
    (deps.log ?? ((c, e, d) => debug.log(c, e, d)))(CATEGORY, 'frame-render', {
      owner,
      changed,
      rendersSinceLast: renders,
    });
    lastOwner = owner;
    lastFrameKey = frameKey;
    lastLoggedAt = at;
    renders = 0;
  };
}

/** 프롬프트 zone 을 주인 하나로 감싼다 — textInput 이 그림을 올렸으면 그것을, 아니면(턴 중)
 *  `inner`(turn-typeahead 에코·placeholder)를 그린다. caret 도 같은 그림에서 나온다. */
export function withPromptRowOwner(inner: LayoutZone, owner: PromptRowOwner, opts: {
  suppressPromptArea: boolean;
  onCaret?: (caret: CursorState | null) => void;
  /** `frameKey` covers everything the band paints — rows, hint and caret. */
  observe?: (owner: PromptBandOwner, frameKey: string) => void;
}): LayoutZone {
  return {
    ...inner,
    render: (height, width) => {
      const paint = opts.suppressPromptArea ? null : owner.current();
      if (!paint) {
        const rows = inner.render(height, width);
        opts.observe?.(opts.suppressPromptArea ? 'suppressed' : 'turn-typeahead', rows.join('\n'));
        return rows;
      }
      const rows = renderPromptOwnerRows(paint, height);
      opts.onCaret?.(paint.caret);
      opts.observe?.('text-input', JSON.stringify({ rows, hint: paint.hint, caret: paint.caret }));
      return rows;
    },
  };
}

/** 프롬프트 아래 둘째 줄(status-gap-top) — textInput 힌트가 있으면 그것, 아니면 빈 줄.
 *  프롬프트가 억제된 프레임(전면 모달 등)에는 힌트도 내지 않는다. */
export function renderPromptOwnerHintRow(owner: PromptRowOwner, opts: { suppressPromptArea: boolean }): string {
  if (opts.suppressPromptArea) return '';
  return owner.current()?.hint ?? '';
}
