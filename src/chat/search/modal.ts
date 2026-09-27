// Search modal (P4.1) — KX5-a rewrite.
//
// Semantics (imperative API + state machine + onSelectionChange
// hook + KX3 surface.onKey) are unchanged. Internally the paint
// pipeline is now SelectView (controlled cursor + controlled query +
// externalFilter + emptyPlaceholder). The modal owns query / cursor /
// items / lastFired, SelectView renders.
//
// Why rewrite in KX5-a:
//   - Single row-highlight style across all choice UIs (dialog /
//     permission-prompt / slash-menu / ask-user / picker 3종 + here)
//   - Mouse + scroll support for free (SelectView.onMouse via MX4)
//   - Theme is now one `C.accent` call in select-view.ts:drawRow

import { ansi, visibleWidth } from '../../tui.js';
import type { ModalSurface, ModalBounds } from '../../display/modal-stack.js';
import type { CursorState } from '../../display/cursor-state.js';
import type { KeyEvent } from '../../plugins/core/types.js';
import type { Action } from '../../plugins/core/types.js';
import {
  type ThemeTokens,
} from '../../theme/tokens.js';
import { SelectView, type SelectOption } from '../../ui/widgets/select-view.js';
import { Printer } from '../../ui/printer.js';
import { BoxView } from '../../ui/view.js';
import { Button } from '../../ui/widgets/button.js';
import type { WidgetChromeSpec } from '../../ui/declarative/spec.js';
import { resolveWidgetChromeBoxViewOptions } from '../../ui/declarative/index.js';
import type { ClickRegion } from '../../ui/click-registry.js';
import type { MouseEventType } from '../../ui/mouse-events.js';
import {
  isDismissGraceMouseEventType,
  isDismissMouseEventType,
  isPrimaryDiscreteClickMouseEventType,
  type DisplayMouseEvent,
} from '../../display/types.js';
import {
  resolvePickerChromePresentation,
} from '../../ui/chrome/picker-chrome.js';
import { debug } from '../../debug/log.js';
import { routeSearchModalKeyInput } from './key-routing.js';
import { appendInputText, backspaceInputText } from '../../input/text-key.js';

export interface SearchItem {
  label: string;
  payload: unknown;
}

export interface SearchModalSpec {
  id: string;
  bounds: ModalBounds;
  title: string;
  width: number;
  maxVisible: number;
  onQuery: (q: string) => SearchItem[];
  onAccept: (item: SearchItem, query: string) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SearchItem | null) => void;
  footerHint?: string;
  /** Theme-aware picker chrome. */
  theme?: ThemeTokens;
  /** Declarative picker chrome override. */
  chromeSpec?: WidgetChromeSpec;
  /** Unified picker mouse semantics. Default true: click selects,
   *  double-click/Enter accepts. */
  browseMode?: boolean;
  /** Verb used in the default action rail. */
  primaryActionLabel?: string;
  /** Verb used in the default cancel action rail. */
  cancelActionLabel?: string;
  /** Whether the picker exposes a query field. Default true. */
  filterable?: boolean;
  /** C-d-1 — 'bottom' 이면 composer zone 을 교체하는 하단 슬롯 결정 뷰
   *  (essential 모드 · 호스트가 composer 페인트를 멈춘다 · codex/CC 동형). */
  slot?: 'bottom';
  /** Render mouse-clickable action buttons on the bottom row. */
  actionButtons?: boolean;
  /** Re-run onQuery after cursor/selection changes so callers whose
   *  labels encode current selection state can repaint immediately. */
  requeryOnSelectionChange?: boolean;
}

export interface SearchModalHandle {
  surface: ModalSurface;
  type(ch: string): void;
  backspace(): void;
  up(): void;
  down(): void;
  accept(): void;
  cancel(): void;
  state(): { query: string; items: SearchItem[]; selectedIdx: number };
}

const QUERY_PROMPT = '/ ';

export function createSearchModal(spec: SearchModalSpec): SearchModalHandle {
  let query = '';
  let items: SearchItem[] = spec.onQuery('');
  let cursor = 0;
  let lastFired: SearchItem | null | undefined = undefined;
  let lastRegistry: readonly ClickRegion[] = [];
  let ignoreInitialOutsideRelease = true;
  const browseMode = spec.browseMode ?? true;
  const filterable = spec.filterable ?? true;
  const actionButtons = spec.actionButtons ?? false;
  const pickerPresentation = resolvePickerChromePresentation({
    title: spec.title,
    primaryAction: spec.primaryActionLabel ?? 'pick',
    cancelAction: spec.cancelActionLabel ?? 'cancel',
    browseMode,
    filterable,
    chromeSpec: spec.chromeSpec,
    maxWidth: spec.width,
  });
  const footerHint = spec.footerHint ?? (actionButtons ? '' : pickerPresentation.footerHint);
  const chromeSpec = pickerPresentation.chromeSpec;
  const boxOptions = resolveWidgetChromeBoxViewOptions(
    spec.theme,
    chromeSpec,
    spec.title,
  );

  const clamp = (): void => {
    if (items.length === 0) { cursor = 0; return; }
    if (cursor >= items.length) cursor = items.length - 1;
    if (cursor < 0) cursor = 0;
  };

  const maybeFire = (): void => {
    if (!spec.onSelectionChange) return;
    const current = items[cursor] ?? null;
    const same = lastFired !== undefined && current?.payload === lastFired?.payload;
    if (same) return;
    lastFired = current;
    try { spec.onSelectionChange(current); } catch { /* swallow — hook errors shouldn't wedge the modal */ }
    if (spec.requeryOnSelectionChange) {
      items = spec.onQuery(query);
      clamp();
    }
  };

  const refresh = (): void => {
    items = spec.onQuery(query);
    clamp();
    if (debug.enabled) {
      debug.log('search-modal.refresh', spec.id, {
        title: spec.title,
        query,
        itemCount: items.length,
        cursor,
        head: items.slice(0, 5).map((item) => item.label),
      });
    }
    maybeFire();
  };

  const submitCurrent = (): void => {
    const item = items[cursor];
    if (item) spec.onAccept(item, query);
    else spec.onCancel?.();
  };

  // SelectView as the paint engine. Filtering stays with the caller
  // (onQuery) so custom match semantics (case sensitivity etc.)
  // survive; SelectView handles the row style + windowing + clickable
  // hit-boxes + empty-state rendering.
  const view = new SelectView<number>({
    title: undefined,
    searchable: filterable,
    externalFilter: true,
    emptyPlaceholder: '(no matches)',
    visibleRows: spec.maxVisible,
    options: (): SelectOption<number>[] =>
      items.map((it, idx) => ({ value: idx, label: it.label })),
    cursor: () => cursor,
    onCursorChange: (next) => {
      cursor = next;
      maybeFire();
    },
    query: () => query,
    footerHint,
    browseMode,
    cursorGlyph: spec.filterable === false ? '' : undefined,
    onSubmit: () => { submitCurrent(); },
    onCancel: () => spec.onCancel?.(),
    theme: spec.theme,
  });

  const primaryButton = actionButtons
    ? new Button({
        label: capitalizeActionLabel(spec.primaryActionLabel ?? 'select'),
        style: 'primary',
        theme: spec.theme,
        buttonId: 'search-modal-primary',
        frameStyle: 'pill',
        onClick: () => submitCurrent(),
      })
    : null;
  const cancelButton = actionButtons
    ? new Button({
        label: capitalizeActionLabel(spec.cancelActionLabel ?? 'cancel'),
        style: 'secondary',
        theme: spec.theme,
        buttonId: 'search-modal-cancel',
        frameStyle: 'pill',
        onClick: () => spec.onCancel?.(),
      })
    : null;
  primaryButton?.takeFocus();
  cancelButton?.takeFocus();

  const surfaceHeight = Math.max(spec.bounds.height, spec.maxVisible + 4 + (actionButtons ? 1 : 0));

  const framedView = new BoxView(view, boxOptions);

  const paint = (): string => {
    // Height: title (1) + query (1) + list (visibleCount or 1 for
    // placeholder) + footer (1). visibleCount grows with items up to
    // the cap, and stays at 1 when there are no matches so the
    // placeholder row has a spot.
    const listRows = Math.max(Math.min(items.length, spec.maxVisible), 1);
    const totalRows = Math.max(surfaceHeight, 4 + listRows + (actionButtons ? 1 : 0));
    const p = Printer.create({ width: spec.width, height: totalRows, focused: true });
    framedView.draw(p);
    if (primaryButton && cancelButton) {
      const gap = 2;
      const primaryW = primaryButton.requiredSize({ width: spec.width, height: 1 }).width;
      const cancelW = cancelButton.requiredSize({ width: spec.width, height: 1 }).width;
      const totalButtons = primaryW + gap + cancelW;
      const startX = Math.max(1, Math.floor((spec.width - totalButtons) / 2));
      const row = Math.max(1, totalRows - 2);
      const innerWidth = Math.max(0, spec.width - 2);
      p.text(1, row, ' '.repeat(innerWidth));
      primaryButton.draw(p.sub(startX, row, primaryW, 1, { focused: true }));
      cancelButton.draw(p.sub(startX + primaryW + gap, row, cancelW, 1, { focused: true }));
    }
    lastRegistry = p.registry.snapshot();
    const lines = p.lines();
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(ansi.moveTo(spec.bounds.row + i, spec.bounds.col) + lines[i]);
    }
    return out.join('');
  };

  // Caret claims the query row (y=1 in SelectView's downward layout,
  // after the title at y=0) and sits at the end of the typed query.
  const cursorState = (): CursorState => ({
    row: spec.bounds.row + 1,
    col: spec.bounds.col
      + 1
      + visibleWidth(QUERY_PROMPT)
      + visibleWidth(query),
    visible: filterable,
  });

  // KX3 — coordinator.routeKey drives this directly. Unknown keys
  // still return 'consumed' so the modal behaves as a keyboard trap
  // (matches legacy router contract). Accept alternate terminal key names
  // before delegating the ordinary keys to the shared router.
  const onKey = (ev: KeyEvent): 'consumed' | 'passthrough' => {
    if (ev.name === 'esc' || ev.name === '\x1b' || ev.sequence === '\x1b') {
      handle.cancel();
      return 'consumed';
    }
    if (ev.name === 'return') {
      handle.accept();
      return 'consumed';
    }
    return routeSearchModalKeyInput(ev, handle);
  };

  const onMouse = (ev: DisplayMouseEvent): Action => {
    const localX = ev.col - spec.bounds.col;
    const localY = ev.row - spec.bounds.row;
    if (isDismissMouseEventType(ev.type) && isSearchModalCloseHit(spec.width, localX, localY)) {
      ignoreInitialOutsideRelease = false;
      spec.onCancel?.();
      return { type: 'refresh' };
    }
    if (localX < 0 || localY < 0 || localX >= spec.width || localY >= surfaceHeight) {
      if (isDismissGraceMouseEventType(ev.type) && ignoreInitialOutsideRelease) {
        ignoreInitialOutsideRelease = false;
        return { type: 'refresh' };
      }
      if (isDismissMouseEventType(ev.type)) {
        ignoreInitialOutsideRelease = false;
        spec.onCancel?.();
        return { type: 'refresh' };
      }
      return { type: 'none' };
    }
    ignoreInitialOutsideRelease = false;
    if (isPrimaryDiscreteClickMouseEventType(ev.type)) {
      const buttonRegions = resolveActionButtonRegions(spec.width, surfaceHeight, primaryButton, cancelButton);
      if (buttonRegions.primary && containsLocalPoint(buttonRegions.primary, localX, localY)) {
        submitCurrent();
        return { type: 'refresh' };
      }
      if (buttonRegions.cancel && containsLocalPoint(buttonRegions.cancel, localX, localY)) {
        spec.onCancel?.();
        return { type: 'refresh' };
      }
    }
    const hit = [...lastRegistry].reverse().find((region) =>
      localX >= region.absX && localX < region.absX + region.width
      && localY >= region.absY && localY < region.absY + region.height,
    );
    if (!hit || !hit.view.onMouse) return { type: 'none' };
    const widgetEvent = {
      type: ev.type as MouseEventType,
      x: localX - hit.absX,
      y: localY - hit.absY,
      absX: localX,
      absY: localY,
      payload: hit.payload,
    };
    const result = hit.view.onMouse(widgetEvent);
    return result.kind === 'consumed' ? { type: 'refresh' } : { type: 'none' };
  };

  const surface: ModalSurface = {
    id: spec.id,
    owner: 'dashboard',
    kind: 'modal',
    focus: 'owns',
    priority: 200,
    interactionClass: 'blocking-modal',
    backgroundInteractionPolicy: 'block',
    windowRole: 'foreground',
    ...(spec.slot ? { slot: spec.slot } : {}),
    // IDX-F4 — all search-modal callers (finder / folder picker /
    // session sidebar picker / ssh picker / agent-roster search)
    // present a filterable item list above the input line, which is
    // the canonical `picker` tier semantics.
    tier: 'picker',
    bounds: {
      ...spec.bounds,
      // C-d-1 — 하단 슬롯은 바닥 정렬: surfaceHeight 가 콘텐츠 기반으로
      // 요청 height 와 달라져도 모달의 바닥이 composer 프레임 바닥에 붙어
      // 스테일 composer 픽셀이 아래로 새지 않는다(위로만 성장).
      ...(spec.slot === 'bottom'
        ? { row: Math.max(2, spec.bounds.row + spec.bounds.height - surfaceHeight) }
        : {}),
      width: spec.width,
      height: surfaceHeight,
    },
    render: () => [],
    paint,
    cursor: cursorState,
    onKey,
    onMouse,
  };

  // Prime the selection hook with the initial head so callers see
  // the first highlighted item without a keystroke.
  maybeFire();

  const handle: SearchModalHandle = {
    surface,
    type(ch: string) {
      if (!filterable) return;
      query = appendInputText(query, ch);
      if (debug.enabled) {
        debug.log('search-modal.input', spec.id, {
          title: spec.title,
          op: 'type',
          ch,
          query,
        });
      }
      refresh();
    },
    backspace() {
      if (!filterable) return;
      query = backspaceInputText(query);
      if (debug.enabled) {
        debug.log('search-modal.input', spec.id, {
          title: spec.title,
          op: 'backspace',
          query,
        });
      }
      refresh();
    },
    up() {
      cursor = Math.max(0, cursor - 1);
      maybeFire();
    },
    down() {
      cursor = Math.min(items.length - 1, cursor + 1);
      maybeFire();
    },
    accept() {
      submitCurrent();
    },
    cancel() { spec.onCancel?.(); },
    state() { return { query, items: items.slice(), selectedIdx: cursor }; },
  };
  return handle;
}

function isSearchModalCloseHit(width: number, localX: number, localY: number): boolean {
  return localY === 0 && localX >= Math.max(0, width - 3) && localX <= Math.max(0, width - 2);
}

function capitalizeActionLabel(label: string): string {
  return label.length > 0 ? label[0]!.toUpperCase() + label.slice(1) : label;
}

function containsLocalPoint(
  rect: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function resolveActionButtonRegions(
  width: number,
  height: number,
  primaryButton: Button | null,
  cancelButton: Button | null,
): {
  primary: { x: number; y: number; width: number; height: number } | null;
  cancel: { x: number; y: number; width: number; height: number } | null;
} {
  if (!primaryButton || !cancelButton) return { primary: null, cancel: null };
  const gap = 2;
  const primaryW = primaryButton.requiredSize({ width, height: 1 }).width;
  const cancelW = cancelButton.requiredSize({ width, height: 1 }).width;
  const totalButtons = primaryW + gap + cancelW;
  const startX = Math.max(1, Math.floor((width - totalButtons) / 2));
  const row = Math.max(1, height - 2);
  return {
    primary: { x: startX, y: row, width: primaryW, height: 1 },
    cancel: { x: startX + primaryW + gap, y: row, width: cancelW, height: 1 },
  };
}
