// MX11 — Slash-command → mouse recipes.
//
// Five reusable factory functions that produce ready-to-mount
// popup surfaces for the most frequently used slash commands.
// Each recipe takes a `ToastStack?` so post-pick feedback can be
// queued automatically — "Switched to Opus 4.7" — matching the
// MX10 ToastStack demo contract.
//
// Recipes covered (PLAN-mouse-ux §7 MX11):
//   1. createModelPickerRecipe  — `/provider` replacement
//   2. createWdPickerRecipe     — `/workspace` replacement
//   3. createSessionPickerRecipe — `/session` replacement
//   4. createViewPickerRecipe   — `/view` replacement
//   5. createUndoPickerRecipe   — `/undo` replacement
//
// All five share one internal helper (buildActionPicker) so the
// render / bounds / ToastStack wiring is consistent.

import { SelectView, type SelectOption } from './ui/widgets/select-view.js';
import {
  formatChromeControlsTitleRight,
  mountViewAsModalSurface,
  type ModalShadowSpec,
  type ViewSurfaceHandle,
} from './ui/modal-adapter.js';
import { DEFAULT_CLOSE_GLYPH } from './ui/chrome/control-glyphs.js';
import { computePopupBounds, type PopupPlacement } from './ui/chrome/picker-popup-placement.js';
import type { ToastStack } from './ui/widgets/toast-stack.js';
import { modelDisplayForRotationEntry } from './user-config.js';
import type { RotationEntry } from './user-config/types.js';
import {
  ansiForPair,
  DEFAULT_WIDGET_TOKENS,
  resolveWidgetTokens,
  type ThemeTokens,
} from './theme/tokens.js';
import { BoxView, Consumed, Ignored, type EventResult, type FocusSource, type Size, type View } from './ui/view.js';
import { Printer } from './ui/printer.js';
import { Button } from './ui/widgets/button.js';
import { resolveModalChromeBoxOptions } from './ui/chrome/modal-chrome-box.js';
import { buildPickerFooterHint } from './ui/chrome/picker-chrome.js';
import { resolveModalWindowChromeSpec } from './ui/chrome/window-chrome.js';
import { resolveWidgetChromeBoxViewOptions } from './ui/declarative/index.js';
import { MenuTreeController } from './ui/widgets/menu-tree-controller.js';
import { mountSubmenuPopupPairSurface } from './ui/submenu-popup-pair.js';
import { createSubmenuPopupMenuView } from './ui/submenu-popup-menu-contract.js';
import { deriveSubmenuPopupRoleTheme } from './ui/submenu-popup-theme.js';

export interface ActionItem<T> {
  value: T;
  label: string;
  description?: string;
  shortcut?: string;
  /** N1 — render this row as an un-selectable section heading. Used
   *  by the rollup popup to separate handles by VW label. Disabled
   *  rows are still painted (so the user sees the grouping) but Enter
   *  skips over them. */
  heading?: boolean;
}

export interface BaseRecipe<T> {
  id?: string;
  title: string;
  items: ActionItem<T>[];
  placement: PopupPlacement;
  onPick: (value: T) => void | Promise<void>;
  onCancel?: () => void;
  /** Optional ToastStack — when provided, a success message is
   *  pushed after onPick resolves. */
  toasts?: ToastStack;
  successMessage?: (value: T) => string;
  footerHint?: string;
  browseMode?: boolean;
  filterable?: boolean;
  actionButtons?: boolean;
  primaryActionLabel?: string;
  cancelActionLabel?: string;
  /** IDX-6 Phase 5 adoption — when a theme is provided, the popup
   *  paints a drop-shadow (`▓` band, one row below + one col to the
   *  right) using `theme.modal.shadow`. Omit to disable. Production
   *  dashboard threads `currentThemeTokens()` here so every pill
   *  popup gets the preset-consistent depth cue; tests can omit to
   *  keep assertions minimal. */
  shadow?: ModalShadowSpec;
  /** IDX-F4 — modal tier for coordinator layering. Defaults to
   *  'menu' (context-menu / action picker). Shell rollup + other
   *  pill-popup-style entry points pass 'popup' to sit at the
   *  popup tier instead. */
  tier?: import('./display/types.js').ModalTier;
  /** U3 Bundle B — optional static chrome theme for the outer frame.
   *  When provided, the popup title bar / border / close glyph adopt
   *  the theme's modalChrome rail instead of the terminal default. */
  theme?: ThemeTokens;
  onMinimize?: () => void;
  initialIndex?: number;
  onSelectionChange?: (index: number, value: T) => void;
  visibleRows?: number;
}

export interface ActionPickerViewOpts {
  framed?: boolean;
}

export type ActionPickerViewFactory = typeof createActionPickerView;

/** Recipe spec as consumed by the normalize + view path: `placement`
 *  is only needed by the mount path (buildActionPicker), so it is
 *  optional here. This lets the view-only entry points
 *  (createViewPickerRecipeView) normalize a spec without a placement. */
type NormalizableRecipeSpec<T> = Omit<BaseRecipe<T>, 'placement'> & { placement?: PopupPlacement };

function normalizeVwPickerRecipeSpec<T>(spec: NormalizableRecipeSpec<T>): NormalizableRecipeSpec<T> {
  return {
    ...spec,
    items: spec.items.map((item) => ({
      value: item.value,
      label: item.label,
      shortcut: item.shortcut,
      heading: item.heading,
    })),
    filterable: false,
    footerHint: '',
  };
}

function recipeFooterHint(spec: {
  title: string;
  primaryAction: string;
  filterable?: boolean;
}): string {
  return buildPickerFooterHint({
    title: spec.title,
    primaryAction: spec.primaryAction,
    cancelAction: 'close',
    browseMode: true,
    filterable: spec.filterable ?? false,
  });
}

function buildActionPickerChrome(view: View, spec: Pick<BaseRecipe<unknown>, 'title' | 'theme' | 'onMinimize'>): BoxView {
  const chrome = spec.theme
    ? (spec.theme.widgetTokens?.modalChrome ?? DEFAULT_WIDGET_TOKENS.modalChrome)
    : undefined;
  return new BoxView(
    view,
    chrome
      ? {
          ...resolveModalChromeBoxOptions(chrome, {
            title: spec.title,
            titleAlign: 'center',
            titleRight: formatChromeControlsTitleRight({
              minimizeButton: !!spec.onMinimize,
              closeButton: true,
            }) ?? DEFAULT_CLOSE_GLYPH,
          }),
          fill: ' ',
        }
      : resolveWidgetChromeBoxViewOptions(
          undefined,
          resolveModalWindowChromeSpec(spec.title, undefined, 'center'),
          spec.title,
        ),
  );
}

export function createActionPickerView<T>(
  spec: Omit<BaseRecipe<T>, 'placement'>,
  opts: ActionPickerViewOpts = {},
): View {
  let size: Size = { width: 0, height: 0 };
  const options: SelectOption<number>[] = spec.items.map((it, i) => ({
    value: i,
    label: it.label,
    description: it.description,
    shortcut: it.shortcut,
    // N1 — heading rows are visual-only; SelectView skips disabled rows
    // during submission. cursor nav walks over them; we nudge to next
    // non-disabled via onCursorChange below.
    disabled: it.heading === true,
  }));
  const initialItem = spec.items.find((it) => it.heading !== true);
  const filterable = spec.filterable ?? spec.items.length >= 15;
  const browseMode = spec.browseMode ?? true;
  const actionButtons = spec.actionButtons ?? true;
  const visibleRows = Math.max(1, spec.visibleRows ?? 10);
  const initialSelectedIdx = (() => {
    if (
      typeof spec.initialIndex === 'number'
      && spec.initialIndex >= 0
      && spec.initialIndex < spec.items.length
    ) {
      return spec.initialIndex;
    }
    return initialItem ? spec.items.indexOf(initialItem) : 0;
  })();
  let selectedIdx = initialSelectedIdx;

  const select = new SelectView<number>({
    // Title is rendered by the BoxView frame below — leaving it unset
    // on the SelectView avoids a duplicate title row.
    options,
    initialValue: spec.items[initialSelectedIdx] ? initialSelectedIdx : undefined,
    searchable: filterable,
    browseMode,
    visibleRows: Math.min(spec.items.length, visibleRows),
    footerHint: spec.footerHint ?? (actionButtons ? '' : filterable
      ? recipeFooterHint({
          title: spec.title,
          primaryAction: spec.primaryActionLabel ?? 'confirm',
          filterable: true,
        })
      : ''),
    onChange: (idx) => {
      selectedIdx = idx as number;
      const entry = spec.items[selectedIdx];
      if (entry) spec.onSelectionChange?.(selectedIdx, entry.value);
    },
    onSubmit: picked => {
      const idx = picked as number;
      const entry = spec.items[idx];
      if (!entry) return;
      const result = spec.onPick(entry.value);
      const msg = spec.successMessage?.(entry.value);
      if (msg && spec.toasts) {
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).then(() => spec.toasts!.push({ text: msg, kind: 'success' }));
        } else {
          spec.toasts.push({ text: msg, kind: 'success' });
        }
      }
    },
    onCancel: spec.onCancel,
    theme: spec.theme,
  });
  const framed = opts.framed !== false;
  // BoxView wraps the SelectView in a visible border + title so the
  // popup is clearly demarcated from the base frame (without a border
  // the surrounding input-dividers / status gaps show through and the
  // popup looks visually broken).
  const framedView = buildActionPickerChrome(select, spec);
  const runPick = (value: T): void => {
    const result = spec.onPick(value);
    const msg = spec.successMessage?.(value);
    if (msg && spec.toasts) {
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(() => spec.toasts!.push({ text: msg, kind: 'success' }));
      } else {
        spec.toasts.push({ text: msg, kind: 'success' });
      }
    }
  };
  const primaryButton = actionButtons
    ? new Button({
        label: capitalizeActionLabel(spec.primaryActionLabel ?? 'select'),
        style: 'primary',
        theme: spec.theme,
        buttonId: 'action-picker-primary',
        frameStyle: 'pill',
        onClick: () => {
          const entry = spec.items[selectedIdx];
          if (!entry || entry.heading === true) return;
          runPick(entry.value);
        },
      })
    : null;
  const cancelButton = actionButtons
    ? new Button({
        label: capitalizeActionLabel(spec.cancelActionLabel ?? 'cancel'),
        style: 'secondary',
        theme: spec.theme,
        buttonId: 'action-picker-cancel',
        frameStyle: 'pill',
        onClick: () => spec.onCancel?.(),
      })
    : null;
  primaryButton?.takeFocus();
  cancelButton?.takeFocus();
  // 2026-05-06 — keyboard focus tracker. 'list' = SelectView · 'primary'
  // / 'cancel' = CTA 버튼. ←→/Tab 으로 'primary' ↔ 'cancel' 토글
  // (actionButtons true 시). Enter 시 focus 가 button 이면 그 button 의
  // onClick 호출. 사용자 피드백: "화살표 좌우로 이동이 안됨".
  type ButtonFocus = 'list' | 'primary' | 'cancel';
  let buttonFocus: ButtonFocus = 'list';
  const view: View = {
    draw(p: Printer): void {
      if (framed) framedView.draw(p);
      else {
        p.fill(' ');
        select.draw(p);
      }
      if (!primaryButton || !cancelButton) return;
      const gap = 2;
      const primaryW = primaryButton.requiredSize({ width: p.width, height: 1 }).width;
      const cancelW = cancelButton.requiredSize({ width: p.width, height: 1 }).width;
      const totalButtons = primaryW + gap + cancelW;
      const startX = Math.max(1, Math.floor((p.width - totalButtons) / 2));
      const row = Math.max(0, p.height - (framed ? 2 : 1));
      const innerX = framed ? 1 : 0;
      const innerWidth = Math.max(0, p.width - (framed ? 2 : 0));
      p.text(innerX, row, ' '.repeat(innerWidth));
      // focused state 가 dock submenu 의 row look 처럼 — 현재 focus 인
      // button 만 highlighted. list focus 일 때는 둘 다 unfocused.
      primaryButton.draw(
        p.sub(startX, row, primaryW, 1, { focused: buttonFocus === 'primary' }),
      );
      cancelButton.draw(
        p.sub(startX + primaryW + gap, row, cancelW, 1, { focused: buttonFocus === 'cancel' }),
      );
    },
    onEvent(ev): EventResult {
      // ←→ / Tab — buttonFocus 전환 (CTA 버튼 활성 시).
      if (
        actionButtons
        && (ev.name === 'left' || ev.name === 'right' || ev.name === 'tab')
      ) {
        if (buttonFocus === 'list') {
          buttonFocus = ev.name === 'left' ? 'cancel' : 'primary';
        } else {
          // 좌우 토글 · Tab 도 토글 (Shift+Tab 도 동일 — 두 버튼만 있음).
          buttonFocus = buttonFocus === 'primary' ? 'cancel' : 'primary';
        }
        return Consumed();
      }
      // Enter 시 buttonFocus 가 button 이면 그 button trigger.
      if (actionButtons && ev.name === 'enter') {
        if (buttonFocus === 'primary' && primaryButton) {
          const entry = spec.items[selectedIdx];
          if (entry && entry.heading !== true) runPick(entry.value);
          return Consumed();
        }
        if (buttonFocus === 'cancel' && cancelButton) {
          spec.onCancel?.();
          return Consumed();
        }
      }
      // ↑↓ 등은 list 로 forward · forward 시 list 로 focus 복귀.
      if (
        actionButtons
        && (ev.name === 'up' || ev.name === 'down' || ev.name === 'k' || ev.name === 'j')
      ) {
        buttonFocus = 'list';
      }
      const result = select.onEvent(ev);
      return result.kind === 'consumed' ? result : Ignored;
    },
    onMouse(ev) {
      if (primaryButton && cancelButton) {
        const gap = 2;
        const primaryW = primaryButton.requiredSize({ width: size.width, height: 1 }).width;
        const cancelW = cancelButton.requiredSize({ width: size.width, height: 1 }).width;
        const totalButtons = primaryW + gap + cancelW;
        const startX = Math.max(1, Math.floor((size.width - totalButtons) / 2));
        const row = Math.max(0, size.height - (framed ? 2 : 1));
        if (ev.y === row) {
          if (ev.x >= startX && ev.x < startX + primaryW) {
            return primaryButton.onMouse({ ...ev, x: ev.x - startX, y: 0 });
          }
          const cancelX = startX + primaryW + gap;
          if (ev.x >= cancelX && ev.x < cancelX + cancelW) {
            return cancelButton.onMouse({ ...ev, x: ev.x - cancelX, y: 0 });
          }
        }
      }
      return select.onMouse?.(ev) ?? Ignored;
    },
    layout(nextSize: Size): void {
      size = { ...nextSize };
      if (framed) framedView.layout(nextSize);
      else {
        const bodyHeight = Math.max(0, nextSize.height - (actionButtons ? 2 : 0));
        select.layout({ width: nextSize.width, height: bodyHeight });
      }
    },
    requiredSize(constraint: Size): Size {
      if (framed) return framedView.requiredSize(constraint);
      const bodyConstraint = {
        width: constraint.width,
        height: Math.max(0, constraint.height - (actionButtons ? 2 : 0)),
      };
      const inner = select.requiredSize(bodyConstraint);
      return {
        width: inner.width,
        height: Math.min(constraint.height, inner.height + (actionButtons ? 2 : 0)),
      };
    },
    takeFocus(source?: FocusSource): boolean {
      return select.takeFocus(source);
    },
  };
  return view;
}

function buildActionPicker<T>(spec: BaseRecipe<T>): ViewSurfaceHandle {
  const canonicalSpec = normalizeVwPickerRecipeSpec(spec);
  const view = createActionPickerView(canonicalSpec);
  // `spec` (BaseRecipe) carries the required placement; the normalized
  // spec keeps it too, but reading from `spec` keeps the required type.
  const bounds = computePopupBounds(spec.placement, actionPickerDesiredSize(canonicalSpec));
  return mountViewAsModalSurface({
    id: canonicalSpec.id ?? `action-picker:${canonicalSpec.title}`,
    bounds,
    view,
    priority: 260,
    shadow: canonicalSpec.shadow,
    chromeControls: {
      minimizeButton: !!canonicalSpec.onMinimize,
      closeButton: true,
      onClose: canonicalSpec.onCancel,
      onMinimize: canonicalSpec.onMinimize,
    },
    // IDX-F4 — recipes in this file build pill-anchored popups
    // (model / mode / wd / session / shell-rollup pickers). Default
    // tier is 'popup'. Context menus from right-click are built via
    // context-menu-host.ts which sets tier:'menu' on its own.
    tier: canonicalSpec.tier ?? 'popup',
  });
}

export function createActionPickerRecipe<T>(spec: BaseRecipe<T>): ViewSurfaceHandle {
  return buildActionPicker(spec);
}

function actionPickerDesiredSize<T>(spec: Pick<BaseRecipe<T>, 'title' | 'items' | 'actionButtons' | 'visibleRows'>): { width: number; height: number } {
  const actionButtons = spec.actionButtons ?? true;
  const widestItem = Math.max(
    spec.title.length,
    ...spec.items.map(i => i.label.length + (i.description ? i.description.length + 2 : 0)),
  );
  const visibleRows = Math.min(spec.items.length, Math.max(1, spec.visibleRows ?? 10));
  return {
    width: Math.max(32, Math.min(72, widestItem + 10)),
    height: visibleRows + 5 + (actionButtons ? 2 : 0),
  };
}

function capitalizeActionLabel(label: string): string {
  return label.length === 0 ? label : label.charAt(0).toUpperCase() + label.slice(1);
}

// ── 1. Model picker (replaces /provider) ─────────────────────────

export interface ModelPickerRecipeOpts {
  entries: RotationEntry[];
  placement: PopupPlacement;
  onSwitch: (entry: RotationEntry) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createModelPickerRecipe(opts: ModelPickerRecipeOpts): ViewSurfaceHandle {
  // 2026-05-05 (UX gap fix): label was previously "${provider} · ${model}"
  // OR `e.label` when set — which collapsed to bare provider name for
  // entries added via `elanous provider:rotate add anthropic` (no model
  // pinned). The user reported "switch model 에 provider 명만 나온다".
  //
  // New format: model name leads, user label appended when meaningful
  // (label is set AND differs from the provider name — `elanous
  // provider:rotate add anthropic` defaults label to provider name,
  // so we hide redundant repetition). Provider tag goes into the
  // description column. When the entry has no explicit model we
  // resolve to the provider's vendor default (PROVIDER_DEFAULT_MODEL)
  // so the picker always shows something meaningful.
  const items: ActionItem<RotationEntry>[] = opts.entries.map(e => {
    const modelName = modelDisplayForRotationEntry(e);
    const primary = modelName || e.provider;
    const userLabel = e.label && e.label.toLowerCase() !== e.provider.toLowerCase()
      ? e.label
      : null;
    return {
      value: e,
      label: userLabel ? `${primary} · ${userLabel}` : primary,
      description: e.provider,
    };
  });
  return buildActionPicker({
    id: 'recipe:model',
    title: 'Switch model',
    items,
    placement: opts.placement,
    // 2026-05-05 (UX): the model picker is select-and-go (Enter or
    // click on a row activates immediately). Action buttons added 2
    // unnecessary rows that stretched the popup from the input bar
    // up past the status dock — user reported "필요이상으로 영역을
    // 클리어". Disabling buttons drops popup height by 2 rows; ESC
    // still cancels.
    actionButtons: false,
    // Cap visible rows tightly: small rotations (1-3 entries) shouldn't
    // claim a 10-row popup. visibleRows=8 leaves headroom for fleets
    // of 8+ entries while letting 1-3 entry pickers stay compact.
    visibleRows: Math.min(opts.entries.length, 8),
    onPick: opts.onSwitch,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    // Toast prefers the user-supplied label (e.g. "Opus 4.7") when the
    // rotation entry has one — keeps existing-test compatibility AND
    // is more user-friendly than echoing the long model id.
    successMessage: e => `Switched to ${e.label ?? modelDisplayForRotationEntry(e) ?? e.provider}`,
  });
}

// ── 1b. Mode switcher (A1) ────────────────────────────────────────

export type ModeSwitcherMode = 'general' | 'sync' | 'control';

export interface ModeSwitcherRecipeOpts {
  active: ModeSwitcherMode;
  placement: PopupPlacement;
  onSwitch: (next: ModeSwitcherMode) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

/** Anchored popup for the ◆ mode pill. Three rows (general / sync /
 *  control) — the currently-active one is labelled with a leading
 *  `● ` marker so the user sees "I'm here" at a glance. Picking a row
 *  delegates to opts.onSwitch; host typically combines setMode with
 *  the matching enter/exit helper. */
export function createModeSwitcherRecipe(opts: ModeSwitcherRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<ModeSwitcherMode>[] = ([
    { value: 'general', label: 'general',     description: 'default chat + development' },
    { value: 'sync',    label: 'sync',        description: 'data / skill sync orchestration' },
    { value: 'control', label: 'control',     description: 'LLM-directed dashboard automation' },
  ] satisfies ActionItem<ModeSwitcherMode>[]).map(i => ({
    ...i,
    label: opts.active === i.value ? `● ${i.label}` : `  ${i.label}`,
  }));
  return buildActionPicker({
    id: 'recipe:mode',
    title: 'Switch mode',
    items,
    placement: opts.placement,
    onPick: opts.onSwitch,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    successMessage: m => `→ ${m} mode`,
    footerHint: recipeFooterHint({
      title: 'Switch mode',
      primaryAction: 'switch',
    }),
  });
}

// ── 2. Working-dir picker (replaces /workspace) ──────────────────

export interface WdPickerRecipeOpts {
  recentPaths: string[];
  placement: PopupPlacement;
  onSwitch: (path: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createWdPickerRecipe(opts: WdPickerRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.recentPaths.map(p => ({
    value: p,
    label: p,
  }));
  return buildActionPicker({
    id: 'recipe:wd',
    title: 'Switch working directory',
    items,
    placement: opts.placement,
    onPick: opts.onSwitch,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    successMessage: p => `cwd → ${p}`,
  });
}

// ── 3. Session picker (replaces /session) ────────────────────────

export interface SessionSummary {
  id: string;
  label: string;
  /** "5 min ago", "yesterday", etc. */
  ageHint?: string;
}

export interface SessionPickerRecipeOpts {
  sessions: SessionSummary[];
  placement: PopupPlacement;
  onResume: (sessionId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createSessionPickerRecipe(opts: SessionPickerRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.sessions.map(s => ({
    value: s.id,
    label: s.label,
    description: s.ageHint,
  }));
  return buildActionPicker({
    id: 'recipe:session',
    title: 'Resume session',
    items,
    placement: opts.placement,
    onPick: opts.onResume,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    successMessage: id => `Resumed session ${id.slice(0, 8)}`,
  });
}

// ── 4. View / layout picker (replaces /view) ────────────────────

export interface ViewPreset {
  id: string;
  label: string;
}

export interface ViewPickerRecipeOpts {
  presets: ViewPreset[];
  placement: PopupPlacement;
  onApply: (presetId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createViewPickerRecipe(opts: ViewPickerRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.presets.map(p => ({
    value: p.id,
    label: p.label,
  }));
  return buildActionPicker({
    id: 'recipe:view',
    title: 'Change layout',
    items,
    placement: opts.placement,
    onPick: opts.onApply,
    onCancel: opts.onCancel,
    primaryActionLabel: 'switch',
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    successMessage: id => `Layout → ${id}`,
  });
}

export function createViewPickerRecipeView(
  opts: Omit<ViewPickerRecipeOpts, 'placement'>,
  viewOpts: ActionPickerViewOpts = {},
): View {
  const items: ActionItem<string>[] = opts.presets.map((p) => ({
    value: p.id,
    label: p.label,
  }));
  return createActionPickerView(normalizeVwPickerRecipeSpec({
    id: 'recipe:view',
    title: 'Change layout',
    items,
    onPick: opts.onApply,
    onCancel: opts.onCancel,
    primaryActionLabel: 'switch',
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    successMessage: (id) => `Layout → ${id}`,
  }), viewOpts);
}

// ── 4a. Dock launcher menu / window attach picker ─────────────────

export type DockLauncherAction = 'add-window' | 'add-surface' | 'chat-only' | 'exit-program';

export interface DockLauncherRecipeOpts {
  placement: PopupPlacement;
  onPick: (action: DockLauncherAction) => void | Promise<void>;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
  actionButtons?: boolean;
  initialIndex?: number;
  onSelectionChange?: (index: number, value: DockLauncherAction) => void;
  items?: Array<{
    value: DockLauncherAction;
    label: string;
    description?: string;
  }>;
}

export function createDockLauncherRecipe(opts: DockLauncherRecipeOpts): ViewSurfaceHandle {
  const actionButtons = opts.actionButtons ?? false;
  const items: ActionItem<DockLauncherAction>[] = (opts.items ?? [
    {
      value: 'add-window',
      label: 'Pop out pane',
    },
    {
      value: 'add-surface',
      label: 'Add surface',
    },
    {
      value: 'chat-only',
      label: 'Chat only',
    },
  ]).map((item) => ({
    value: item.value,
    label: item.label,
    description: item.description,
  }));
  return buildActionPicker({
    id: 'recipe:dock-launcher',
    title: 'Menu',
    items,
    placement: opts.placement,
    onPick: opts.onPick,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    actionButtons,
    initialIndex: opts.initialIndex,
    onSelectionChange: opts.onSelectionChange,
    footerHint: actionButtons
      ? ''
      : '',
  });
}

export interface PaneWindowPreset {
  id: string;
  label: string;
  description?: string;
}

export interface PaneWindowPickerRecipeOpts {
  panes: PaneWindowPreset[];
  placement: PopupPlacement;
  onPick: (paneId: string) => void | Promise<void>;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

export function createPaneWindowPickerRecipe(opts: PaneWindowPickerRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.panes.map((pane) => ({
    value: pane.id,
    label: pane.label,
  }));
  return buildActionPicker({
    id: 'recipe:pane-window',
    title: 'Pop out pane',
    items,
    placement: opts.placement,
    onPick: opts.onPick,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    footerHint: recipeFooterHint({
      title: 'Pop out pane',
      primaryAction: 'open',
    }),
  });
}

export interface SurfaceCatalogPreset {
  id: string;
  label: string;
  description?: string;
  group?: string;
}

export interface SurfaceCatalogRecipeOpts {
  surfaces: SurfaceCatalogPreset[];
  placement: PopupPlacement;
  onPick: (surfaceId: string) => void | Promise<void>;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
  actionButtons?: boolean;
  filterable?: boolean;
  initialIndex?: number;
  onSelectionChange?: (index: number, value: string) => void;
}

export function createSurfaceCatalogRecipe(opts: SurfaceCatalogRecipeOpts): ViewSurfaceHandle {
  const actionButtons = opts.actionButtons ?? false;
  const items: ActionItem<string>[] = [];
  let lastGroup = '';
  for (const surface of opts.surfaces) {
    const group = surface.group?.trim() ?? '';
    if (group && group !== lastGroup) {
      items.push({
        value: `__heading:${group}`,
        label: group,
        heading: true,
      });
      lastGroup = group;
    }
    items.push({
      value: surface.id,
      label: surface.group?.trim() ? `  ${surface.label.trimStart()}` : surface.label,
    });
  }
  return buildActionPicker({
    id: 'recipe:surface-catalog',
    title: 'Add surface',
    items,
    placement: opts.placement,
    onPick: opts.onPick,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    actionButtons,
    filterable: opts.filterable,
    initialIndex: opts.initialIndex,
    onSelectionChange: opts.onSelectionChange,
    footerHint: actionButtons
      ? ''
      : '',
  });
}

export interface DockMenuTreeRecipeOpts {
  placement: PopupPlacement;
  windowPanes: PaneWindowPreset[];
  surfaces: SurfaceCatalogPreset[];
  onOpenWindow: (paneId: string) => void | Promise<void>;
  onOpenSurface: (surfaceId: string) => void | Promise<void>;
  onToggleChatOnly?: () => void | Promise<void>;
  onExitProgram?: () => void | Promise<void>;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

export function createDockMenuTreeRecipe(opts: DockMenuTreeRecipeOpts): ViewSurfaceHandle {
  const parentTheme = deriveSubmenuPopupRoleTheme(opts.theme, 'parent');
  const childTheme = deriveSubmenuPopupRoleTheme(opts.theme, 'child');
  const parentItems: ActionItem<DockLauncherAction>[] = [
    {
      value: 'add-window',
      label: 'Pop out pane',
    },
    {
      value: 'add-surface',
      label: 'Add surface',
    },
    {
      value: 'chat-only',
      label: 'Chat only',
    },
    {
      value: 'exit-program',
      label: 'Exit program',
    },
  ];
  const groupedSurfaceItems: ActionItem<string>[] = [];
  let lastGroup = '';
  for (const surface of opts.surfaces) {
    const group = surface.group?.trim() ?? '';
    if (group && group !== lastGroup) {
      groupedSurfaceItems.push({ value: `__heading:${group}`, label: group, heading: true });
      lastGroup = group;
    }
    groupedSurfaceItems.push({
      value: surface.id,
      label: group ? `  ${surface.label.trimStart()}` : surface.label,
    });
  }
  const windowItems: ActionItem<string>[] = opts.windowPanes.map((pane) => ({
    value: pane.id,
    label: pane.label,
  }));
  const tree = new MenuTreeController({
    launcherCount: 1,
    hasChildMenu: ({ parentIndex }) => {
      const action = parentItems[parentIndex]?.value;
      return action === 'add-window'
        ? windowItems.length > 0
        : action === 'add-surface'
          ? groupedSurfaceItems.length > 0
          : false;
    },
  });
  tree.openParent();

  const childState = (): { title: string; items: ActionItem<string>[] } => {
    const action = parentItems[tree.getParentCursor()]?.value;
    if (action === 'add-window') {
      return { title: 'Pop out pane', items: windowItems };
    }
    if (action === 'add-surface') {
      return { title: 'Add surface', items: groupedSurfaceItems };
    }
    return { title: 'Menu', items: [] };
  };

  const childVisibleRowsFor = (items: ActionItem<string>[]): number => {
    if (items.length >= 12) return 14;
    return 10;
  };

  const childMetrics = (): { title: string; items: ActionItem<string>[]; visibleRows: number; desired: { width: number; height: number } } => {
    const state = childState();
    const visibleRows = childVisibleRowsFor(state.items);
    const desired = actionPickerDesiredSize({
      title: state.title,
      items: state.items.length > 0 ? state.items : [{ value: '__empty__', label: '(empty)', heading: true }],
      actionButtons: false,
      visibleRows,
    });
    return {
      ...state,
      visibleRows,
      desired,
    };
  };

  const parentSize = actionPickerDesiredSize({
    title: 'Menu',
    items: parentItems,
    actionButtons: false,
  });
  const childWindowSize = actionPickerDesiredSize({
    title: 'Pop out pane',
    items: windowItems.length > 0 ? windowItems : [{ value: '__empty__', label: '(empty)', heading: true }],
    actionButtons: false,
    visibleRows: childVisibleRowsFor(windowItems),
  });
  const childSurfaceSize = actionPickerDesiredSize({
    title: 'Add surface',
    items: groupedSurfaceItems.length > 0 ? groupedSurfaceItems : [{ value: '__empty__', label: '(empty)', heading: true }],
    actionButtons: false,
    visibleRows: childVisibleRowsFor(groupedSurfaceItems),
  });
  const childSize = {
    width: Math.max(childWindowSize.width, childSurfaceSize.width),
    height: Math.max(childWindowSize.height, childSurfaceSize.height),
  };
  const gap = 2;
  const parentTopInset = 1;
  const parentBounds = computePopupBounds(opts.placement, {
    width: parentSize.width,
    height: parentSize.height + parentTopInset,
  });
  const expandedBounds = (): { row: number; col: number; width: number; height: number } => {
    const metrics = childMetrics();
    const childHeight = metrics.desired.height;
    return {
      row: Math.max(1, opts.placement.statusRow - Math.max(parentSize.height + parentTopInset, childHeight)),
      col: parentBounds.col,
      width: Math.min(
        parentSize.width + gap + metrics.desired.width,
        Math.max(1, opts.placement.termCols - parentBounds.col + 1),
      ),
      height: Math.min(Math.max(parentSize.height + parentTopInset, childHeight), opts.placement.termRows - 2),
    };
  };
  const childFrame = (currentSize: Size): { x: number; y: number; width: number; height: number } => {
    const metrics = childMetrics();
    const anchorX = parentSize.width + gap;
    return {
      // Keep the child slab anchored to the right of the parent.
      // The expanded popup itself may re-anchor left to make room,
      // but parent/child stay side-by-side inside the composite.
      x: anchorX,
      y: 0,
      width: metrics.desired.width,
      height: Math.min(currentSize.height, metrics.desired.height),
    };
  };

  const parentView = (): View => createSubmenuPopupMenuView({
    id: 'recipe:dock-menu-tree:parent',
    title: 'Menu',
    items: parentItems,
    contract: 'single-click-browse',
    initialIndex: tree.getParentCursor(),
    onSelectionChange: (index) => tree.setParentCursor(index),
    onPick: async (action) => {
      if (action === 'chat-only') {
        await opts.onToggleChatOnly?.();
        opts.onCancel?.();
        return;
      }
      if (action === 'exit-program') {
        await opts.onExitProgram?.();
        opts.onCancel?.();
        return;
      }
      if (action === 'add-window' && windowItems.length > 0) {
        tree.openChild();
        return;
      }
      if (action === 'add-surface' && groupedSurfaceItems.length > 0) {
        tree.openChild();
        return;
      }
    },
    onCancel: opts.onCancel,
    theme: parentTheme,
    shadow: opts.shadow,
  }, createActionPickerView);

  const childView = (): View => {
    const metrics = childMetrics();
    return createSubmenuPopupMenuView({
      id: 'recipe:dock-menu-tree:child',
      title: metrics.title,
      items: metrics.items,
      contract: 'single-click-browse',
      visibleRows: metrics.visibleRows,
      initialIndex: tree.getChildCursor(),
      onSelectionChange: (index) => tree.setChildCursor(index),
      onPick: async (value) => {
        const action = parentItems[tree.getParentCursor()]?.value;
        if (action === 'add-window') {
          await opts.onOpenWindow(value);
        } else if (action === 'add-surface') {
          await opts.onOpenSurface(value);
        }
        opts.onCancel?.();
      },
      onCancel: opts.onCancel,
      theme: childTheme,
      shadow: opts.shadow,
    }, createActionPickerView);
  };

  return mountSubmenuPopupPairSurface({
    id: 'recipe:dock-menu-tree',
    parentBounds,
    expandedBounds,
    parentRect: (currentSize) => ({
      x: 0,
      y: parentTopInset + (tree.isChildOpen ? Math.max(0, parentBounds.row - expandedBounds().row) : 0),
      width: parentSize.width,
      height: Math.min(
        currentSize.height - (parentTopInset + (tree.isChildOpen ? Math.max(0, parentBounds.row - expandedBounds().row) : 0)),
        parentSize.height,
      ),
    }),
    childRect: childFrame,
    createParentView: parentView,
    createChildView: childView,
    isChildVisible: () => tree.isChildOpen,
    isChildFocused: () => tree.activeRole === 'child',
    onHandleKey: (name) => tree.handleKey(name),
    onStateMayHaveChanged: () => {},
    priority: 260,
    shadow: opts.shadow,
    theme: parentTheme,
    backdrop: true,
    freezeBottomArea: false,
    backgroundInteractionPolicy: 'block',
    tier: 'popup',
    onClose: opts.onCancel,
  });
}

// ── 4b. Workspace restore picker (U6 Bundle B) ───────────────────

export interface WorkspaceRestoreEntry {
  surfaceId: string;
  label: string;
  kind: 'popup' | 'dialog' | 'terminal' | 'authored' | 'pane';
  docked?: boolean;
}

export interface WorkspaceRestoreRecipeOpts {
  entries: WorkspaceRestoreEntry[];
  placement: PopupPlacement;
  onRestore: (surfaceId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

export function createWorkspaceRestoreRecipe(opts: WorkspaceRestoreRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.entries.map((entry) => ({
    value: entry.surfaceId,
    label: entry.label,
    description: [entry.kind, entry.docked ? 'docked' : undefined].filter(Boolean).join(' · ') || undefined,
  }));
  return buildActionPicker({
    id: 'recipe:workspace-restore',
    title: 'Restore window',
    items,
    placement: opts.placement,
    onPick: opts.onRestore,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    toasts: opts.toasts,
    successMessage: (surfaceId) => `restore → ${surfaceId}`,
    footerHint: recipeFooterHint({
      title: 'Restore window',
      primaryAction: 'restore',
    }),
  });
}

export interface WorkspaceDesktopShellEntry {
  surfaceId: string;
  label: string;
  kind: 'popup' | 'dialog' | 'terminal' | 'authored' | 'pane';
  focused?: boolean;
}

export interface WorkspaceDesktopShellRecipeOpts {
  workspaceLabel?: string;
  layoutMode?: 'stack' | 'grid' | 'columns' | 'rows' | 'desktop';
  liveEntries: WorkspaceDesktopShellEntry[];
  dockEntries: WorkspaceDesktopShellEntry[];
  dormantEntries: WorkspaceDesktopShellEntry[];
  placement: PopupPlacement;
  onRestore: (surfaceId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

export interface ConversationPopupShellEntry {
  sessionId: string;
  label: string;
  brand?: string;
  focused?: boolean;
}

export interface ConversationPopupShellRecipeOpts {
  layoutMode?: 'cascade' | 'tile' | 'stack';
  liveEntries: ConversationPopupShellEntry[];
  minimizedEntries: ConversationPopupShellEntry[];
  placement: PopupPlacement;
  onPick: (sessionId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  shadow?: ModalShadowSpec;
}

export function createWorkspaceDesktopShellRecipe(opts: WorkspaceDesktopShellRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = [];
  appendWorkspaceSection(items, 'Live now', opts.liveEntries, { sectionState: 'active' });
  appendWorkspaceSection(items, 'Docked', opts.dockEntries, { sectionState: 'docked' });
  appendWorkspaceSection(items, 'Dormant', opts.dormantEntries, { sectionState: 'dormant' });
  return buildActionPicker({
    id: 'recipe:workspace-desktop-shell',
    title: workspaceDesktopShellTitle(opts),
    items,
    placement: opts.placement,
    onPick: (surfaceId) => {
      if (surfaceId.startsWith('__heading:')) return;
      return opts.onRestore(surfaceId);
    },
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    toasts: opts.toasts,
    successMessage: (surfaceId) => `restore → ${surfaceId}`,
    footerHint: buildPickerFooterHint({
      title: workspaceDesktopShellTitle(opts),
      primaryAction: 'restore',
      cancelAction: 'close',
      browseMode: true,
      filterable: false,
    }),
  });
}

export function createConversationPopupShellRecipe(opts: ConversationPopupShellRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = [];
  appendConversationPopupSection(items, 'Live', opts.liveEntries, { sectionState: 'live' });
  appendConversationPopupSection(items, 'Minimized', opts.minimizedEntries, { sectionState: 'minimized' });
  return buildActionPicker({
    id: 'recipe:conversation-popup-shell',
    title: conversationPopupShellTitle(opts),
    items,
    placement: opts.placement,
    onPick: (sessionId) => {
      if (sessionId.startsWith('__heading:')) return;
      return opts.onPick(sessionId);
    },
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    toasts: opts.toasts,
    successMessage: (sessionId) => `conversation → ${sessionId}`,
    footerHint: recipeFooterHint({
      title: conversationPopupShellTitle(opts),
      primaryAction: 'focus/restore',
    }),
  });
}

function appendWorkspaceSection(
  items: ActionItem<string>[],
  label: string,
  entries: WorkspaceDesktopShellEntry[],
  opts: { sectionState: 'active' | 'docked' | 'dormant' },
): void {
  if (entries.length === 0) return;
  items.push({
    value: `__heading:${label}`,
    label: `${workspaceShellSectionIcon(opts.sectionState)} ${label} (${entries.length})`,
    heading: true,
  });
  const selectable = opts.sectionState !== 'active';
  for (const entry of entries) {
    items.push({
      value: entry.surfaceId,
      label: `${workspaceShellRowIcon(entry, opts.sectionState)} ${entry.label}`,
      description: workspaceShellRowDescription(entry, opts.sectionState),
      heading: selectable ? false : true,
    });
  }
}

function appendConversationPopupSection(
  items: ActionItem<string>[],
  label: string,
  entries: ConversationPopupShellEntry[],
  opts: { sectionState: 'live' | 'minimized' },
): void {
  if (entries.length === 0) return;
  items.push({
    value: `__heading:${label}`,
    label: `${opts.sectionState === 'live' ? '●' : '—'} ${label} (${entries.length})`,
    heading: true,
  });
  for (const entry of entries) {
    items.push({
      value: entry.sessionId,
      label: `${entry.focused ? '●' : opts.sectionState === 'live' ? '○' : '—'} ${entry.label}`,
      description: [entry.brand, opts.sectionState === 'live' ? 'focus' : 'restore'].filter(Boolean).join(' · ') || undefined,
      heading: false,
    });
  }
}

function conversationPopupShellTitle(opts: ConversationPopupShellRecipeOpts): string {
  const live = opts.liveEntries.length;
  const minimized = opts.minimizedEntries.length;
  const total = live + minimized;
  const parts = [`${total} popup${total === 1 ? '' : 's'}`];
  if (opts.layoutMode) parts.push(opts.layoutMode);
  if (live > 0) parts.push(`${live} live`);
  if (minimized > 0) parts.push(`${minimized} minimized`);
  return parts.join(' · ');
}

function workspaceDesktopShellTitle(opts: WorkspaceDesktopShellRecipeOpts): string {
  const parts: string[] = [];
  if (opts.workspaceLabel) parts.push(opts.workspaceLabel);
  if (opts.layoutMode) parts.push(opts.layoutMode);
  if (opts.liveEntries.length > 0) parts.push(`${opts.liveEntries.length} live`);
  if (opts.dockEntries.length > 0) parts.push(`${opts.dockEntries.length} docked`);
  if (opts.dormantEntries.length > 0) parts.push(`${opts.dormantEntries.length} dormant`);
  const parked = opts.dockEntries.length + opts.dormantEntries.length;
  const prefix = parked > 0 ? `${parked} parked` : 'workspace shell';
  return parts.length > 0 ? `${prefix} · ${parts.join(' · ')}` : 'Workspace shell';
}

function workspaceShellKindIcon(kind: WorkspaceDesktopShellEntry['kind']): string {
  switch (kind) {
    case 'dialog': return '□';
    case 'terminal': return '>';
    case 'authored': return '✎';
    case 'pane': return '▤';
    case 'popup':
    default:
      return '◫';
  }
}

function workspaceShellRowIcon(
  entry: WorkspaceDesktopShellEntry,
  state: 'active' | 'docked' | 'dormant',
): string {
  const kind = workspaceShellKindIcon(entry.kind);
  if (state === 'active') return entry.focused ? `● ${kind}` : `○ ${kind}`;
  return `${workspaceShellSectionIcon(state)} ${kind}`;
}

function workspaceShellSectionIcon(state: 'active' | 'docked' | 'dormant'): string {
  switch (state) {
    case 'active': return '●';
    case 'docked': return '—';
    case 'dormant': return '·';
  }
}

function workspaceShellRowDescription(
  entry: WorkspaceDesktopShellEntry,
  sectionState: 'active' | 'docked' | 'dormant',
): string {
  const state = sectionState === 'active'
    ? 'active'
    : sectionState === 'docked'
      ? 'docked · restore'
      : 'dormant · restore';
  const focus = entry.focused ? 'focused' : undefined;
  return [entry.kind, state, focus].filter(Boolean).join(' · ');
}

// ── 6. Shell rollup popup (SRF-4) ────────────────────────────────

export interface ShellRollupEntry {
  id: string;
  /** Rendered chip (e.g. '▶ run') — pre-rendered by caller via
   *  renderHandleStatusChip so recipe stays presentation-free. */
  chip: string;
  mode: 'inline' | 'bg' | 'modal' | 'vw';
  label?: string;
  /** Raw status — used by onAttach to route via decideAttach. */
  status: 'running' | 'backgrounded' | 'completed' | 'killed';
}

export interface ShellRollupRecipeOpts {
  entries: ShellRollupEntry[];
  placement: PopupPlacement;
  /** Fires when the user picks an entry. Host typically invokes the
   *  same /shell attach decision the slash uses. */
  onPick: (id: string) => void | Promise<void>;
  onCancel?: () => void;
  toasts?: ToastStack;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — drop-shadow. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createShellRollupPopupRecipe(opts: ShellRollupRecipeOpts): ViewSurfaceHandle {
  // N1 — group by VW label so multi-runner users (runner + deploy +
  // test, etc.) see which group each handle belongs to. Single-group
  // case falls back to the flat list (no headers) so the common
  // 1-label case doesn't get a noisy header.
  const items: ActionItem<string>[] = [];
  const groups = groupEntriesByLabel(opts.entries);
  const useHeaders = groups.length > 1;
  for (const g of groups) {
    if (useHeaders) {
      items.push({
        value: `__heading:${g.label}`,
        label: `── ${g.label} (${g.entries.length}) ──`,
        heading: true,
      });
    }
    for (const e of g.entries) {
      const idTail = e.id.length > 10 ? `…${e.id.slice(-8)}` : e.id;
      const chipStripped = e.chip.replace(/\u001b\[[0-9;]*m/g, '');
      items.push({
        value: e.id,
        label: `${chipStripped}  ${idTail}`,
        description: `mode=${e.mode}`,
      });
    }
  }
  return buildActionPicker({
    id: 'recipe:shell-rollup',
    title: `🐚 Shells (${opts.entries.length})`,
    items,
    placement: opts.placement,
    onPick: (v) => {
      // N1 — heading rows are SelectView-disabled, but guard here too
      // in case a future caller hand-rolls a heading without the flag.
      if (typeof v === 'string' && v.startsWith('__heading:')) return;
      return opts.onPick(v);
    },
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    // Click-a-row is the attach verb (same as the model picker). The
    // footer hint still says "browse" for keyboard affordance, but
    // browseMode:true would swallow the click as cursor-only and never
    // fire onPick — the five failing SRF-4 tests.
    browseMode: false,
    footerHint: buildPickerFooterHint({
      title: `🐚 Shells (${opts.entries.length})`,
      primaryAction: 'attach',
      cancelAction: 'close',
      browseMode: true,
      filterable: false,
    }),
    successMessage: id => `attach → ${id.slice(-8)}`,
    // IDX-F4 — shell rollup is the entry-point pill popup ("which
    // shell to attach"), not a context menu — sits at the popup tier.
    tier: 'popup',
  });
}

interface LabelGroup {
  label: string;
  entries: ShellRollupEntry[];
}

/** N1 — group rollup entries by VW label. Default label `runner` is
 *  pinned first (most users' common case); the rest sort alphabetically.
 *  Unlabeled handles go under `(no label)` at the bottom so they're
 *  visually distinct without being lost. */
function groupEntriesByLabel(entries: ShellRollupEntry[]): LabelGroup[] {
  const buckets = new Map<string, ShellRollupEntry[]>();
  for (const e of entries) {
    const key = e.label ?? '(no label)';
    const list = buckets.get(key);
    if (list) list.push(e);
    else buckets.set(key, [e]);
  }
  const groups: LabelGroup[] = [];
  const pinned = buckets.get('runner');
  if (pinned) { groups.push({ label: 'runner', entries: pinned }); buckets.delete('runner'); }
  const keys = [...buckets.keys()].sort((a, b) => {
    // '(no label)' always last
    if (a === '(no label)') return 1;
    if (b === '(no label)') return -1;
    return a.localeCompare(b);
  });
  for (const k of keys) groups.push({ label: k, entries: buckets.get(k)! });
  return groups;
}

// ── 5. Undo picker (replaces /undo) ──────────────────────────────

export interface UndoSnapshot {
  id: string;
  description?: string;
  /** 7-char SHA hint for the underlying commit. */
  sha?: string;
  /** "5s ago" — formatted by the caller. */
  ageHint?: string;
}

export interface UndoPickerRecipeOpts {
  snapshots: UndoSnapshot[];
  placement: PopupPlacement;
  onRestore: (snapshotId: string) => void | Promise<void>;
  toasts?: ToastStack;
  onCancel?: () => void;
  theme?: ThemeTokens;
  /** IDX-6 Phase 5 adoption — pass `{ theme: currentThemeTokens() }`
   *  to add a drop-shadow behind the popup. Omit to disable. */
  shadow?: ModalShadowSpec;
  onMinimize?: () => void;
}

export function createUndoPickerRecipe(opts: UndoPickerRecipeOpts): ViewSurfaceHandle {
  const items: ActionItem<string>[] = opts.snapshots.map((s, i) => ({
    value: s.id,
    label: s.description ?? s.id,
    description: [s.sha?.slice(0, 7), s.ageHint].filter(Boolean).join(' · ') || undefined,
    shortcut: i < 9 ? String(i + 1) : undefined,
  }));
  return buildActionPicker({
    id: 'recipe:undo',
    title: 'Restore to which turn?',
    items,
    placement: opts.placement,
    onPick: opts.onRestore,
    onCancel: opts.onCancel,
    theme: opts.theme,
    shadow: opts.shadow,
    onMinimize: opts.onMinimize,
    toasts: opts.toasts,
    footerHint: '↑↓ · 1-9 jump · click row · Enter restore · Esc cancel',
    successMessage: id => `Restored to ${id.slice(0, 8)}`,
  });
}
