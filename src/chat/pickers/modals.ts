// Picker modals for chat.ts — compact chooser family.
//
// The slash / arg / @ / skill pickers now share one framed chooser
// contract:
// - shared SelectView body
// - centered picker chrome
// - compact footer vocabulary
// - family-specific flavor only for title / hint / row mapping
//
// The adapter surface stays intentionally thin so chat.ts can treat
// every picker family as "same popup, different flavor".

import { ansi, visibleWidth, stripAnsi, C } from '../../tui.js';
import type { SlashCommand, ArgSuggestion, AtCandidate, SkillCandidate } from '../index.js';
import type { ModalSurface, ModalBounds } from '../../display/modal-stack.js';
import type { Action, DisplayMouseEvent, KeyEvent } from '../../display/types.js';
import { SelectView, type SelectOption } from '../../ui/widgets/select-view.js';
import { BoxView } from '../../ui/view.js';
import { Printer } from '../../ui/printer.js';
import { resolveWidgetChromeBoxViewOptions } from '../../ui/declarative/index.js';
import { buildPickerFooterHint } from '../../ui/chrome/picker-chrome.js';
import { resolveModalWindowChromeSpec } from '../../ui/chrome/window-chrome.js';
import { debug } from '../../debug/log.js';
import { isClickIntentMouseEventType } from '../../ui/mouse-events.js';
import { CHAT_PICKER_KINDS, type ChatPickerKind } from './kinds.js';

/** IDX-F2 — picker modals receive an `onKey` closure from chat.ts so
 *  coordinator.routeKey can deliver keys directly. The closure has
 *  access to the caller's buffer state + mutation primitives through
 *  captured variables, keeping chat.ts as the owner of editing
 *  semantics while the picker becomes a first-class key participant.
 *
 *  IDX-F1.5 widened the return to allow a Promise so picker.dispatch
 *  (async for the at-picker filesystem scan) can be awaited inline. */
export type PickerOnKey = (ev: KeyEvent) =>
  | 'consumed' | 'passthrough'
  | Promise<'consumed' | 'passthrough'>;

/** F-E — fired when a mouse click lands on a picker row. `filtIdx`
 *  is the 0-indexed position in the current filtered list (NOT in
 *  the full options). chat.ts wraps this into a
 *  `picker.submitAt(filtIdx, bufView)` call so the row selection
 *  mirrors the keyboard ↑↓ + Enter path exactly. Return type is void
 *  — the dispatch outcome flows through the picker state's DispatchResult,
 *  handled by the same splice/submit logic used by onKey. */
export type PickerOnRowClick = (filtIdx: number) => void | Promise<void>;

function framedPickerFooterHint(spec: {
  title: string;
  primaryAction: string;
  filterable?: boolean;
}): string {
  return buildPickerFooterHint({
    title: spec.title,
    primaryAction: spec.primaryAction,
    browseMode: false,
    filterable: spec.filterable ?? true,
  });
}

function compactChatPickerFooterHint(spec: {
  total: number;
  compactThreshold?: number;
  fullHint: string;
}): string {
  const threshold = spec.compactThreshold ?? 4;
  return spec.total <= threshold ? '' : spec.fullHint;
}

function compactMouseFirstChatPickerFooterHint(spec: {
  total: number;
  fullHint: string;
}): string {
  return compactChatPickerFooterHint({
    total: spec.total,
    fullHint: spec.fullHint,
  });
}

function pickerWindow(total: number, maxVisible: number, cursor: number): {
  visibleCount: number;
  startIdx: number;
} {
  const visibleCount = Math.min(total, maxVisible);
  if (visibleCount <= 0) return { visibleCount: 0, startIdx: 0 };
  const startIdx = total > visibleCount
    ? Math.max(0, Math.min(cursor - Math.floor(visibleCount / 2), total - visibleCount))
    : 0;
  return { visibleCount, startIdx };
}

type PickerRow = {
  label: string;
  description?: string;
  icon?: string;
};

type PickerChromeSpec<T> = {
  title: string;
  footerHint: () => string;
  getRows: () => T[];
  toRow: (item: T) => PickerRow;
};

export interface ChatPickerModalBindings {
  selectedIdx: () => number;
  maxVisible: number;
  getInputZoneHeight: () => number;
  width: number;
  getWidth?: () => number;
  /** Live prompt anchor (input bottom row + col). When present it wins
   *  over the mount-time `bounds` snapshot, so a terminal resize moves
   *  an already-open picker with the prompt (TUI-PICKER-RESIZE-SHRINK). */
  getAnchor?: () => { row: number; col: number };
  onKey?: PickerOnKey;
  onRowClick?: PickerOnRowClick;
}

type FramedPickerSpec<T> = {
  id: string;
  bounds: ModalBounds;
  getRows: () => T[];
  toRow: (item: T) => PickerRow;
  title: string;
  footerHint: () => string;
  selectedIdx: () => number;
  maxVisible: number;
  getInputZoneHeight: () => number;
  width: number;
  getWidth?: () => number;
  getAnchor?: () => { row: number; col: number };
  onKey?: PickerOnKey;
  onRowClick?: PickerOnRowClick;
};

function createFramedPickerModal<T>(spec: FramedPickerSpec<T>): ModalSurface {
  const computeBounds = (): (ModalBounds & { startIdx: number; visibleCount: number }) | null => {
    const rows = spec.getRows();
    const inputZoneHeight = spec.getInputZoneHeight();
    const anchor = spec.getAnchor?.() ?? spec.bounds;
    const bottomRow = anchor.row - inputZoneHeight;
    if (rows.length === 0 || bottomRow < 4) return null;
    const { visibleCount, startIdx } = pickerWindow(
      rows.length,
      Math.min(spec.maxVisible, Math.max(1, bottomRow - 3)),
      spec.selectedIdx(),
    );
    if (visibleCount <= 0) return null;
    const height = visibleCount + 3;
    const row = bottomRow - height + 1;
    return { row, col: anchor.col, width: spec.getWidth?.() ?? spec.width, height, startIdx, visibleCount };
  };

  /** Phase 4.5a (substrate Occam · §4-pre.7 · 2026-05-03) — update
   *  the picker's derived bounds (interactiveBounds / visualBounds /
   *  backdropBounds) in lockstep with the main bounds. Called from
   *  `getBounds()` (the lifecycle hook coord invokes BEFORE region
   *  snapshot + paint), NOT from paint() itself. The main `surface.
   *  bounds` is assigned by coord based on `getBounds()` return value.
   *
   *  Pre-Phase-4.5a, the equivalent helper `updateSurfaceBounds`
   *  also mutated `surface.bounds` from inside paint(), which raced
   *  against coord's region snapshot and produced a one-frame ghost
   *  on filter shrink (the picker `잔상` artifact, log:
   *  log/debug-20260503151235.log 13:06.292). Splitting the main-
   *  bounds assignment to coord eliminates the race.
   *
   *  §1.5 numeric short-circuit preserved — identity churn with the
   *  same numbers is suppressed (was the 2026-05-03 #1401 fix for
   *  the original 48Hz flicker class). */
  const updateDerivedBounds = (surface: ModalSurface, bounds: ModalBounds): void => {
    const cur = surface.interactiveBounds;
    if (cur
      && cur.row === bounds.row
      && cur.col === bounds.col
      && cur.width === bounds.width
      && cur.height === bounds.height) {
      return;
    }
    surface.interactiveBounds = { ...bounds };
    surface.visualBounds = { ...bounds };
    surface.backdropBounds = { ...bounds };
  };

  const surface: ModalSurface = {
    id: spec.id,
    owner: 'dashboard',
    kind: 'modal',
    tier: 'picker',
    focus: spec.onKey ? 'participates' : 'none',
    priority: 100,
    bounds: { ...spec.bounds },
    interactiveBounds: { ...spec.bounds },
    visualBounds: { ...spec.bounds },
    backdropBounds: { ...spec.bounds },
    occluding: true,
    render: () => [],
    /** Phase 4.5a (§4-pre.7) — layout settle hook called by coord
     *  BEFORE regionMap.resolve + paint each frame. Returns the
     *  picker's desired bounds for this frame; coord assigns to
     *  `surface.bounds` and invalidates region rows on change.
     *  Mirrors derived bounds (interactive/visual/backdrop) here as
     *  well — paint() must not touch any of these (§1.6). */
    getBounds: (): ModalBounds | null => {
      const computed = computeBounds();
      if (!computed) return null;
      const main: ModalBounds = {
        row: computed.row,
        col: computed.col,
        width: computed.width,
        height: computed.height,
      };
      updateDerivedBounds(surface, main);
      return main;
    },
    paint: () => {
      const computed = computeBounds();
      if (!computed) return '';
      // §4-pre.7 — paint() must not mutate surface.bounds (or any
      // derived bounds). Coord settled the main bounds via
      // getBounds() above; derived bounds were mirrored in there.
      const rows = spec.getRows();
      const options: SelectOption<number>[] = rows.map((item, idx) => {
        const row = spec.toRow(item);
        return {
          value: idx,
          label: row.label,
          description: row.description ?? '',
          icon: row.icon,
        };
      });
      const view = new BoxView(
        new SelectView<number>({
          options,
          visibleRows: computed.visibleCount,
          cursor: () => spec.selectedIdx(),
          footerHint: spec.footerHint(),
          browseMode: false,
          onSubmit: () => {},
        }),
        resolveWidgetChromeBoxViewOptions(
          undefined,
          resolveModalWindowChromeSpec(spec.title, undefined, 'center'),
          spec.title,
        ),
      );
      const printer = Printer.create({ width: computed.width, height: computed.height });
      view.layout({ width: computed.width, height: computed.height });
      view.draw(printer);
      const lines = printer.lines();
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        out.push(ansi.moveTo(computed.row + i, computed.col) + '\x1b[2K' + lines[i]);
      }
      return out.join('');
    },
    cursor: () => null,
    onKey: spec.onKey
      ? async (ev: KeyEvent) => {
          const res = await Promise.resolve(spec.onKey!(ev));
          return res === 'consumed' ? 'consumed' : 'passthrough';
        }
      : undefined,
    onMouse: spec.onRowClick
      ? (ev: DisplayMouseEvent): Action => {
          const computed = computeBounds();
          if (!computed) return { type: 'none' };
          // §4-pre.7 — onMouse runs OUTSIDE paint() so it COULD
          // legally mutate bounds, but doing so here re-introduces
          // the snapshot/paint race that getBounds() exists to avoid.
          // Coord settles bounds on the next frame via getBounds()
          // anyway. Read from `computed` directly for click target
          // resolution.
          if (!isClickIntentMouseEventType(ev.type)) return { type: 'none' };
          const localRow = ev.row - computed.row;
          const listRow = localRow - 1;
          if (listRow < 0 || listRow >= computed.visibleCount) return { type: 'none' };
          const idx = computed.startIdx + listRow;
          if (idx < 0 || idx >= spec.getRows().length) return { type: 'none' };
          const onRowClick = spec.onRowClick;
          if (!onRowClick) return { type: 'none' };
          void onRowClick(idx);
          if (debug.enabled) {
            debug.log('chat.picker.onMouse', 'consumed', {
              id: spec.id,
              type: ev.type,
              row: ev.row,
              col: ev.col,
              filtIdx: idx,
            });
          }
          return { type: 'none' };
        }
      : undefined,
  };
  // §4-pre.7 — initial layout settle. Outside paint(), outside
  // coord lifecycle (factory time), so direct assignment of main +
  // derived bounds is safe. Subsequent frames go through coord's
  // getBounds() lifecycle.
  const initial = computeBounds();
  if (initial) {
    const initialBounds: ModalBounds = {
      row: initial.row,
      col: initial.col,
      width: initial.width,
      height: initial.height,
    };
    surface.bounds = initialBounds;
    updateDerivedBounds(surface, initialBounds);
  }
  return surface;
}

function createConfiguredPickerModal<T>(
  spec: Omit<FramedPickerSpec<T>, 'title' | 'footerHint' | 'getRows' | 'toRow'> & PickerChromeSpec<T>,
): ModalSurface {
  return createFramedPickerModal({
    ...spec,
    title: spec.title,
    footerHint: spec.footerHint,
    getRows: spec.getRows,
    toRow: spec.toRow,
  });
}

function createSimpleConfiguredPickerModal<T>(spec: Omit<FramedPickerSpec<T>, 'footerHint' | 'getRows' | 'toRow'> & {
  title: string;
  total: () => number;
  fullHint: () => string;
  getRows: () => T[];
  toRow: (item: T) => PickerRow;
}): ModalSurface {
  return createConfiguredPickerModal({
    ...spec,
    footerHint: () => compactMouseFirstChatPickerFooterHint({
      total: spec.total(),
      fullHint: spec.fullHint(),
    }),
    getRows: spec.getRows,
    toRow: spec.toRow,
  });
}

function compactMouseFirstPickerHintFromChrome(spec: {
  title: string;
  primaryAction: string;
}): string {
  return framedPickerFooterHint({
    title: spec.title,
    primaryAction: spec.primaryAction,
  }).replace('↑↓ move · ', '').replace('Double-click/Enter', 'Click/↵').replace(' · Esc cancel', ' · Esc');
}

// ── Slash picker ────────────────────────────────────────────────

interface ChatPickerModalCommonSpec {
  id: string;
  bounds: ModalBounds;
}

type ChatPickerModalCommonBindingsSpec = ChatPickerModalCommonSpec & ChatPickerModalBindings;

type ChatPickerItem<K extends ChatPickerKind> =
  K extends 'slash' ? SlashCommand :
  K extends 'arg' ? ArgSuggestion :
  K extends 'at' ? AtCandidate :
  SkillCandidate;

type ChatPickerItems<K extends ChatPickerKind> = ChatPickerItem<K>[];

export type ChatPickerFamilySources = {
  [K in ChatPickerKind]: {
    id: string;
    getItems: () => ChatPickerItems<K>;
  };
};

export function createChatPickerFamilySource<K extends ChatPickerKind>(
  id: string,
  getItems: () => ChatPickerItems<K>,
): ChatPickerFamilySources[K] {
  return { id, getItems } as ChatPickerFamilySources[K];
}

export function createChatPickerFamilySources(
  sources: ChatPickerFamilySources,
): ChatPickerFamilySources {
  return sources;
}

export interface ChatPickerModalFamily {
  sources: ChatPickerFamilySources;
  createSurface: (kind: ChatPickerKind) => ModalSurface;
}

interface ChatPickerFlavor<K extends ChatPickerKind> {
  title: string;
  primaryAction?: string;
  fullHint?: (ctx: {
    items: ChatPickerItems<K>;
    selectedIdx: number;
  }) => string;
  toRow: (item: ChatPickerItem<K>) => PickerRow;
}

function createFlavoredChatPickerModal<K extends ChatPickerKind>(
  spec: ChatPickerModalCommonBindingsSpec & {
    getItems: () => ChatPickerItems<K>;
  },
  flavor: ChatPickerFlavor<K>,
): ModalSurface {
  const fullHint = flavor.fullHint
    ? () => flavor.fullHint!({
        items: spec.getItems(),
        selectedIdx: spec.selectedIdx(),
      })
    : () => compactMouseFirstPickerHintFromChrome({
        title: flavor.title,
        primaryAction: flavor.primaryAction ?? 'pick',
      });
  return createSimpleConfiguredPickerModal({
    ...spec,
    title: flavor.title,
    total: () => spec.getItems().length,
    fullHint,
    getRows: spec.getItems,
    toRow: (item) => flavor.toRow(item),
  });
}

const chatPickerFamilyFlavors = {
  slash: {
    title: 'Slash commands',
    primaryAction: 'run',
    toRow: (cmd: SlashCommand) => ({
      label: '/' + cmd.name + (cmd.aliases?.length ? ` (${cmd.aliases.join(',')})` : ''),
      description: cmd.description,
    }),
  },
  arg: {
    title: 'Arguments',
    primaryAction: 'insert',
    toRow: (it: ArgSuggestion) => ({
      label: it.value,
      description: it.description ?? '',
    }),
  },
  at: {
    title: 'Attach context',
    fullHint: ({ items, selectedIdx }: { items: AtCandidate[]; selectedIdx: number }) => {
      const cursorItem = items[selectedIdx];
      return cursorItem?.isDir
        ? 'type filter · Click/↵ ref · Tab descend · Ctrl+I attach · Esc'
        : 'type filter · Click/↵ attach · Tab autofill · Esc';
    },
    toRow: (it: AtCandidate) => ({
      label: it.label,
      description: it.hint ?? '',
      icon: it.icon,
    }),
  },
  skill: {
    title: 'Skills',
    fullHint: () => 'type filter · Click/↵ insert `/run-skill` · Esc',
    toRow: (it: SkillCandidate) => ({
      label: `$${it.name}`,
      description: it.description ?? '',
      icon: C.success('$'),
    }),
  },
} satisfies { [K in ChatPickerKind]: ChatPickerFlavor<K> };

function getChatPickerFamilyFlavor<K extends ChatPickerKind>(kind: K): ChatPickerFlavor<K> {
  switch (kind) {
    case 'slash':
      return chatPickerFamilyFlavors.slash as ChatPickerFlavor<K>;
    case 'arg':
      return chatPickerFamilyFlavors.arg as ChatPickerFlavor<K>;
    case 'at':
      return chatPickerFamilyFlavors.at as ChatPickerFlavor<K>;
    case 'skill':
      return chatPickerFamilyFlavors.skill as ChatPickerFlavor<K>;
  }
}

export function createChatPickerModalFamily(spec: {
  bounds: ModalBounds;
  sources: ChatPickerFamilySources;
  bindings: Record<ChatPickerKind, ChatPickerModalBindings>;
}): ChatPickerModalFamily {
  const sources = spec.sources;

  const createSurface = <K extends ChatPickerKind>(kind: K): ModalSurface => {
    const source = sources[kind];
    return createFlavoredChatPickerModal({
      id: source.id,
      bounds: spec.bounds,
      getItems: source.getItems,
      ...spec.bindings[kind],
    }, getChatPickerFamilyFlavor(kind));
  };

  return {
    sources,
    createSurface,
  };
}
