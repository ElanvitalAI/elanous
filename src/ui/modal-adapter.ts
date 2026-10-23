// LC12 / MX2 — View → ModalSurface adapter.
//
// Bridges a LC4 View (with Printer-based drawing) to the existing
// ModalSurface API the coordinator has used since P2.3. Legacy
// modals (approval, ask-user-question, pickers, search, plan-exit)
// can migrate to View-based internals without disturbing the caller.
//
// Helpers:
//   mountViewAsModalSurface(spec) → { surface, handleKey, handleMouse,
//                                     dispose, isDisposed }.
//       surface.paint() draws the view into a Printer sized to
//       spec.bounds, then emits one ANSI-positioned line per row.
//       The Printer's registry is captured so handleMouse can
//       hit-test subsequent mouse events against the last-rendered
//       frame.
//   defaultPriority — what the legacy modals use.
//
// Keeping this file tiny and dependency-light lets us drop it into
// any migration target without pulling in dashboard-specific code.

import { resolveChromeDefault } from './chrome-defaults.js';
import { DEFAULT_CLOSE_GLYPH, DEFAULT_MINIMIZE_GLYPH } from './chrome/control-glyphs.js';
import type { ModalBounds, ModalSurface } from '../display/modal-stack.js';
import type { CursorState } from '../display/cursor-state.js';
import {
  isCaptureSessionEndMouseEventType,
  isCaptureSessionMouseEventType,
  isModalChromeMouseEventType,
  isPrimaryDiscreteClickMouseEventType,
  isSecondaryClickMouseEventType,
  type DisplayMouseEvent,
  type KeyEvent,
  type ModalTier,
  type SurfaceOwner,
} from '../display/types.js';
import type { SurfaceInteractionClass } from '../display/surface-interaction-policy.js';
import { Printer } from './printer.js';
import { ansi, visibleWidth } from '../tui.js';
import type { View } from './view.js';
import {
  applyModalIdToRefinement,
  refineHitFromPayload,
} from '../display/hit-target.js';
import { resolveLayoutSpec } from '../display/layout-spec.js';
import type { ClickRegion, ClickRegistry } from './click-registry.js';
import type { MouseEvent, MouseEventType } from './mouse-events.js';
import { DragMachine } from './drag-machine.js';
import type { ContextKeyService, ContextKeys } from '../input-core/context-keys.js';
import { getRuntimeContextKeyService } from '../input-core/context-key-runtime.js';
import { ansiForPair, resolveWidgetTokens, type ThemeTokens } from '../theme/tokens.js';
import type { BoxDecoration } from './attributes/box-decoration.js';
import { resolveColorToken } from './chrome/resolve-color.js';

export interface ViewSurfaceSpec {
  id: string;
  /** Static rect. Callers that mount with a known position use
   *  this directly. R2 adopters (see `layout`) can supply a
   *  sentinel 0-size rect; the resolver overrides it at mount. */
  bounds: ModalBounds;
  /** R2 — optional declarative layout. When present, the adapter
   *  calls `resolveLayoutSpec(layout, env)` at mount time and
   *  writes the resulting rect to `bounds`, overriding whatever
   *  the caller passed. Adopters get tier-aware anchoring
   *  (above-input, overlay-center, bottom-right) for free;
   *  legacy callers keep working unchanged because `layout` is
   *  opt-in. `env` defaults to `{ term: opts.termSize() }` so
   *  anchors that don't need inputZone work out of the box. */
  layout?: import('../display/layout-spec.js').LayoutSpec;
  /** R2 — layout env override. Tests inject their own env when
   *  they need a specific inputZone; production callers can omit
   *  and let the adapter synthesise from the running termSize
   *  + best-effort inputZone inference. */
  layoutEnv?: import('../display/layout-spec.js').LayoutEnv;
  view: View;
  owner?: SurfaceOwner;
  priority?: number;
  /** Optional caret claim — topmost non-null wins. */
  cursor?: () => CursorState | null;
  /** Called when the modal should be disposed (final frame). */
  onDispose?: () => void;
  /** MX6 — fired when a right-click lands on a view that declares
   *  contextActions. The host is responsible for creating a
   *  ContextMenu popup (via buildContextMenuPopup) and mounting it.
   *  `anchor` is the absolute terminal row/col (1-indexed) of the
   *  click so the popup can place near the cursor. */
  onContextMenu?: (req: ContextMenuRequest) => void;
  /** IDX-2b — modal tier. When supplied, the adapter atomically
   *  sets the matching context key to true on mount and to false on
   *  dispose (VSCode SuggestWidget pattern — modalVisible ⟺
   *  contextKey.get()). Omit for modals that don't want automatic
   *  context-key tracking (existing callers = backward compat).
   *
   *  IDX-2b uses a string union, not a typed enum. IDX-2c upgrades
   *  to a proper ModalTier enum + compatibility matrix. */
  tier?: ModalTierTag;
  /** IDX-2b — test-injectable context-key service. Production uses
   *  the dashboard singleton if omitted. Tests pass their own
   *  ContextKeyService so assertions don't collide across cases. */
  contextKeyService?: ContextKeyService;
  /** Surface interaction class override. Most callers can omit this
   *  and let the adapter infer from `tier`; explicit override exists
   *  for migration cases where the visual tier and product ownership
   *  role intentionally differ. */
  interactionClass?: SurfaceInteractionClass;
  backgroundInteractionPolicy?: 'allow' | 'block';
  /** IDX-6 Phase 5 — optional drop-shadow config. When supplied the
   *  paint output appends extra cells below + to the right of bounds
   *  using the theme's `modal.shadow` colour (or widgetTokens.modal.
   *  shadow). Off by default so existing modals don't suddenly grow
   *  a shadow band without opting in. */
  shadow?: ModalShadowSpec;
  /** IDX-F8b — optional theme used to resolve the `modal.backdrop`
   *  pair. When provided (or inherited from `shadow.theme`) the paint
   *  pipeline fills the modal's rect with the backdrop's fg/bg before
   *  drawing the view, producing a visible pastel surface behind
   *  modal contents. Opt out via `backdrop: false` or
   *  `ELANOUS_MODAL_BACKDROP=off`. `vw` and `execution` tiers skip the
   *  fill automatically — those are host/overlay surfaces that shouldn't
   *  paint an opaque block over the base frame. */
  theme?: import('../theme/tokens.js').ThemeTokens;
  /** IDX-F8b — override the auto-backdrop behaviour. Default: `true`
   *  when `theme` (or `shadow.theme`) is present AND tier is not in
   *  the skip list. Set `false` to force-disable for a specific caller
   *  (e.g. a modal that paints its own background). */
  backdrop?: boolean;
  /** Optional host-bottom-band freeze override. Default undefined keeps
   *  the existing tier-based policy. `false` is useful for lightweight
   *  dock-attached popups that should not blank prompt/status rows. */
  freezeBottomArea?: boolean;
  /** P4b (2026-04-20) — optional Flutter-style `BoxDecoration`. When
   *  present AND `shadow` is NOT explicitly set, the adapter derives
   *  a `ModalShadowSpec` from `decoration.boxShadow[0]` so declarative
   *  widget trees can specify shadow via the P2 attribute surface.
   *
   *  P4b accepts every BoxDecoration field for future use but only
   *  renders `boxShadow` via the existing shadow pipeline. Other
   *  fields (`border`, `borderRadius`, `padding`, `color`, `shape`)
   *  are accepted-but-not-yet-rendered — they'll wire up in P4c when
   *  the dashboard migrates modal chrome rendering to `renderChrome`.
   *
   *  Explicit `shadow` always wins over `decoration.boxShadow`.
   *  `decoration.boxShadow.length === 0` (explicit empty) disables
   *  shadow even when the decoration field is present. */
  decoration?: import('./attributes/box-decoration.js').BoxDecoration;
  chromeControls?: ChromeControlsSpec;
}

export interface ChromeControlsSpec {
  closeButton?: boolean;
  minimizeButton?: boolean;
  /** Default behavior for the close control. Omit → dispose. */
  closeDisposition?: ChromeControlDisposition;
  /** Default behavior for the minimize control. Omit → dispose. */
  minimizeDisposition?: ChromeControlDisposition;
  /** Optional override hook. Return `'keep-open'` to suppress the
   *  default dispose path while still using the shared trigger route. */
  onClose?: () => ChromeControlResult;
  /** Optional override hook. Return `'keep-open'` to suppress the
   *  default dispose path while still using the shared trigger route. */
  onMinimize?: () => ChromeControlResult;
}

export type ChromeControlDisposition = 'dispose' | 'keep-open';
export type ChromeControlResult = void | ChromeControlDisposition;

export interface ModalShadowSpec {
  /** Required — theme providing the shadow colour via either
   *  `theme.modal.shadow` (hex) or `theme.widgetTokens.modal.shadow`
   *  (TokenPair). When both absent, paint skips shadow emission
   *  regardless of `enabled`. */
  theme: import('../theme/tokens.js').ThemeTokens;
  /** Override enabled — defaults to true when shadow config is
   *  present. Callers can pass `{ theme, enabled: false }` to keep
   *  the shadow wiring intact but temporarily disable (useful for
   *  ASCII-only terminals). */
  enabled?: boolean;
  /** Glyph painted in shadow cells. Default `'▓'` — a solid block.
   *  Honors the ELANOUS_ASCII_ICONS env var by falling back to `'#'`
   *  when ASCII mode is active (still visible in dumb terminals). */
  glyph?: string;
}

/** IDX-F4 — modal tier tag now aliases the canonical `ModalTier`
 *  from `src/display/types.ts`. The pre-F4 standalone string union
 *  (picker / popup / vw-picker / dialog / approval / terminal /
 *  plan-exit / system-alert) was redundant with the F1 coordinator
 *  ModalTier (picker / popup / terminal / dialog / vw / execution /
 *  tooltip / menu) — having two parallel taxonomies meant a modal's
 *  "context-key tier" and its "stacking tier" could disagree. F4
 *  collapses them. Approval/plan-exit/system-alert all map to
 *  `dialog`; vw-picker maps to `vw`. */
export type ModalTierTag = ModalTier;

/** tier → which context-key is toggled. Exported for tests and for
 *  the dashboard's own direct updates (e.g. singleton state changes
 *  that don't flow through the adapter). */
export const MODAL_TIER_CONTEXT_KEY: Readonly<Record<ModalTier, keyof ContextKeys | null>> = {
  picker: 'pickerOpen',
  popup: 'popupOpen',
  vw: 'popupOpen',             // virtual-window host shares the popup flag
  dialog: 'dialogOpen',        // absorbs IDX-2b approval / plan-exit
  terminal: 'terminalModalActive',
  menu: 'popupOpen',           // context menu routes like a popup for input
  execution: null,             // execution overlay — no input-capture flag
  tooltip: null,               // transient overlay — no input-capture flag
};

/** IDX-F8b / workspace-popup polish — tiers that opt OUT of automatic
 *  backdrop fill. `vw` is the host layer that already paints its own
 *  content. `execution` / `tooltip` are transparent overlays.
 *
 *  Workspace-era policy: lightweight popup families (`popup`, `menu`,
 *  `picker`) should not paint a full-rect pastel slab by default.
 *  They still can opt in via `backdrop: true`, but the default avoids
 *  the large left-side shaded rectangle that appears when a narrow
 *  popup owns a wider modal rect. Dialog / terminal keep the stronger
 *  backdrop because they are closer to attention-taking blocking
 *  surfaces. Exported for tests. */
export const BACKDROP_SKIP_TIERS: ReadonlySet<ModalTier> = new Set([
  'vw',
  'execution',
  'tooltip',
  'popup',
  'menu',
  'picker',
]);

export function interactionClassForModalTier(
  tier: ModalTier | undefined,
): SurfaceInteractionClass | undefined {
  switch (tier) {
    case 'vw':
      return 'workspace';
    case 'execution':
    case 'tooltip':
      return 'embedded-overlay';
    case 'dialog':
    case 'popup':
    case 'menu':
    case 'picker':
    case 'terminal':
      return 'blocking-modal';
    default:
      return undefined;
  }
}

/** IDX-F8b — ambient theme getter. Mirrors the theme-icons pattern:
 *  dashboard calls `configureModalAdapterTheme(() => currentThemeTokens())`
 *  once at boot; every modal mount after that inherits the current
 *  theme for backdrop resolution without individual callers having to
 *  thread it through their spec. Explicit `spec.theme` still wins. */
let ambientModalThemeGetter:
  | (() => import('../theme/tokens.js').ThemeTokens | null | undefined)
  | null = null;

export function configureModalAdapterTheme(
  getter: (() => import('../theme/tokens.js').ThemeTokens | null | undefined) | null,
): void {
  ambientModalThemeGetter = getter;
}

/** Test helper — drop the ambient getter so cases can set/unset
 *  without leaking across tests. */
export function __resetModalAdapterThemeForTests(): void {
  ambientModalThemeGetter = null;
}

function readAmbientModalTheme(): import('../theme/tokens.js').ThemeTokens | undefined {
  if (!ambientModalThemeGetter) return undefined;
  try {
    return ambientModalThemeGetter() ?? undefined;
  } catch {
    return undefined;
  }
}

/** IDX-F8b — resolve the backdrop ANSI prefix to use for `p.fill`.
 *  Returns `''` when no theme is available, the env kill-switch is
 *  set, the spec opted out, the tier is in `BACKDROP_SKIP_TIERS`, or
 *  the theme's `modal.backdrop` resolves to no ANSI. Exported for
 *  tests. */
export function resolveBackdropAnsi(opts: {
  theme?: import('../theme/tokens.js').ThemeTokens;
  shadowTheme?: import('../theme/tokens.js').ThemeTokens;
  tier?: ModalTier;
  backdrop?: boolean;
}): string {
  if (process.env.ELANOUS_MODAL_BACKDROP === 'off') return '';
  // Theme precedence: explicit spec.theme > shadow.theme > ambient
  // (dashboard-configured fallback). The ambient getter lets the
  // dashboard thread a theme once at boot so individual modal callers
  // don't all need to accept a theme in their spec.
  const theme = opts.theme ?? opts.shadowTheme ?? readAmbientModalTheme();
  if (!theme) return '';
  // backdrop=false explicitly disables; backdrop=true forces on; undefined =
  // auto-on whenever a theme is present and tier isn't in the skip list.
  if (opts.backdrop === false) return '';
  if (opts.backdrop !== true && opts.tier && BACKDROP_SKIP_TIERS.has(opts.tier)) return '';
  const pair = resolveWidgetTokens(theme, 'modal').backdrop;
  return ansiForPair(pair);
}

/** IDX-6 Phase 5 — resolve the shadow ANSI prefix + glyph to emit.
 *  Returns null when the spec is absent, disabled, or the theme has
 *  no shadow colour declared. Exported for tests. */
export function resolveShadowAnsi(
  spec: ModalShadowSpec | undefined,
): { ansi: string; glyph: string } | null {
  if (!spec) return null;
  if (spec.enabled === false) return null;
  const theme = spec.theme;
  // Prefer widgetTokens.modal.shadow (TokenPair — hex + attrs); fall
  // back to flat `theme.modal.shadow` hex; finally null.
  const widgetShadow = resolveWidgetTokens(theme, 'modal').shadow;
  if (widgetShadow) {
    const prefix = ansiForPair(widgetShadow);
    if (!prefix) return null;
    return {
      ansi: prefix,
      glyph: spec.glyph ?? (process.env.ELANOUS_ASCII_ICONS === '1' ? '#' : '▓'),
    };
  }
  const flat = theme.modal.shadow;
  if (!flat) return null;
  const prefix = ansiForPair({ fg: flat });
  if (!prefix) return null;
  return {
    ansi: prefix,
    glyph: spec.glyph ?? (process.env.ELANOUS_ASCII_ICONS === '1' ? '#' : '▓'),
  };
}

/** Request to show a context menu — built by the adapter when a
 *  right-click lands on a view that declares contextActions. */
export interface ContextMenuRequest {
  items: import('./view.js').ContextMenuActionItem[];
  /** Optional caption shown in the popup chrome. */
  title?: string;
  /** 1-indexed terminal coords. */
  anchorRow: number;
  anchorCol: number;
  /** Workspace affinity for the spawned context menu. When the origin
   *  view lives inside a workspace-class surface, the request carries
   *  that workspace id so the resulting menu / submenu chain remains
   *  attached to the same workspace instead of defaulting to main. */
  ownerWorkspaceId?: string;
  /** The view that produced the items. */
  origin: View;
}

export function formatChromeControlsTitleRight(
  controls: ChromeControlsSpec | undefined,
): string | undefined {
  if (!controls) return undefined;
  const labels: string[] = [];
  if (controls.minimizeButton) labels.push(DEFAULT_MINIMIZE_GLYPH);
  if (controls.closeButton) labels.push(DEFAULT_CLOSE_GLYPH);
  return labels.length > 0 ? labels.join(' ') : undefined;
}

export function dispatchChromeControlAction(
  action: 'close' | 'minimize',
  controls: ChromeControlsSpec | undefined,
  dispose: () => void,
): ChromeControlDisposition {
  let result: ChromeControlResult = undefined;
  if (action === 'close') {
    try { result = controls?.onClose?.(); } catch { /* swallow */ }
  } else {
    try { result = controls?.onMinimize?.(); } catch { /* swallow */ }
  }
  const disposition = resolveChromeControlDisposition(action, controls, result);
  if (disposition === 'dispose') dispose();
  return disposition;
}

function resolveChromeControlDisposition(
  action: 'close' | 'minimize',
  controls: ChromeControlsSpec | undefined,
  callbackResult: ChromeControlResult,
): ChromeControlDisposition {
  if (callbackResult === 'dispose' || callbackResult === 'keep-open') {
    return callbackResult;
  }
  if (action === 'close') return controls?.closeDisposition ?? 'dispose';
  return controls?.minimizeDisposition ?? 'dispose';
}

export interface ViewSurfaceHandle {
  surface: ModalSurface;
  /** Wire this into the host's keydispatch. 'consumed' means the
   *  view swallowed the event; 'passthrough' means the host should
   *  continue looking for a handler. */
  handleKey(ev: KeyEvent): 'consumed' | 'passthrough';
  /** Route a raw terminal mouse event through the last rendered
   *  frame's ClickRegistry into the target view's `onMouse`. Returns
   *  'consumed' if the view took the event, 'passthrough' when the
   *  event fell outside every registered region or the target
   *  didn't implement `onMouse`. */
  handleMouse(ev: DisplayMouseEvent): 'consumed' | 'passthrough';
  /** Programmatic close — next paint() returns '', and the host
   *  should pop the surface out of its focus stack. */
  dispose(): void;
  isDisposed(): boolean;
}

export const DEFAULT_MODAL_PRIORITY = 250;

/** P4b (2026-04-20) — translate a Flutter-style `BoxDecoration.boxShadow`
 *  into a legacy `ModalShadowSpec`. Returns `null` when the decoration
 *  carries no shadow info so callers fall through to "no shadow".
 *
 *  Color handling:
 *    - decoration.boxShadow[0].color is a ColorToken | string | null.
 *      We don't emit it directly — the existing shadow resolver reads
 *      colour from the active theme (modal.shadow / widgetTokens.modal.
 *      shadow). When the decoration supplies a token, the caller is
 *      expected to have set theme.modal.shadow to the resolved hex OR
 *      to pass a custom `theme` whose modal.shadow slot is pre-filled.
 *      In other words: boxShadow provides WHERE, theme provides WHAT
 *      colour. P4c will plumb colour through end-to-end.
 *
 *  dx/dy semantics:
 *    - This shim keeps the existing shadow geometry (1 row below, 1
 *      col right of bounds) regardless of boxShadow offset. Non-1
 *      offsets are accepted but don't shift the shadow band. Full
 *      positional support lives in the `renderChrome` primitive used
 *      directly by callers that bypass modal-adapter.
 */
export function deriveShadowFromDecoration(
  decoration: BoxDecoration | undefined,
  theme: import('../theme/tokens.js').ThemeTokens | undefined,
): ModalShadowSpec | null {
  if (!decoration || !theme) return null;
  const shadows = decoration.boxShadow;
  if (!shadows || shadows.length === 0) return null;
  const first = shadows[0]!;
  // Explicit opacity: 0 or negative-distance offset = "disabled"
  const { dx, dy } = first.offset;
  if (first.opacity === 0 && dx === 0 && dy === 0) return null;
  // Probe that a resolvable colour exists · if not, skip the shadow
  // rather than paint with the wrong hue.
  const tokenHex = resolveColorToken(first.color ?? null, theme);
  const themeHex = theme.modal.shadow;
  if (!tokenHex && !themeHex) return null;
  return {
    theme,
    enabled: true,
  };
}

/** P4c (2026-04-20) — does this decoration actually require any
 *  post-view framing work? `boxShadow` alone doesn't count — it's still
 *  handled by the legacy `ModalShadowSpec` path (via P4b
 *  `deriveShadowFromDecoration`). Border, border radius, padding, and
 *  color all trigger the framing path. */
export function hasRenderableChrome(d: BoxDecoration | undefined | null): boolean {
  if (!d) return false;
  const borderPresent = !!(
    d.border && (d.border.top || d.border.right || d.border.bottom || d.border.left)
  );
  const paddingPresent = !!(
    d.padding && (d.padding.top || d.padding.right || d.padding.bottom || d.padding.left)
  );
  const colorPresent = d.color != null && d.color !== '';
  return borderPresent || paddingPresent || colorPresent;
}

export interface ChromeInnerDims {
  /** Usable view width after borders + horizontal padding are subtracted. */
  readonly width: number;
  /** Usable view height after borders + vertical padding are subtracted. */
  readonly height: number;
  /** Pixel offset (cells) from the outer top-left to the inner view top-left.
   *  Drives mouse translation so click coords land in view-local space. */
  readonly offsetRow: number;
  readonly offsetCol: number;
}

/** P4c — compute the inner view rectangle given the outer bounds and a
 *  decoration. No-op (passes outer dims through) when the decoration has
 *  no renderable chrome; callers should short-circuit the framing path
 *  via `hasRenderableChrome` first. */
export function computeInnerDims(
  bounds: ModalBounds,
  decoration: BoxDecoration | undefined | null,
): ChromeInnerDims {
  if (!hasRenderableChrome(decoration)) {
    return { width: bounds.width, height: bounds.height, offsetRow: 0, offsetCol: 0 };
  }
  const d = decoration!;
  const borderLeft = d.border?.left ? 1 : 0;
  const borderRight = d.border?.right ? 1 : 0;
  const borderTop = d.border?.top ? 1 : 0;
  const borderBottom = d.border?.bottom ? 1 : 0;
  const padTop = d.padding?.top ?? 0;
  const padRight = d.padding?.right ?? 0;
  const padBottom = d.padding?.bottom ?? 0;
  const padLeft = d.padding?.left ?? 0;
  return {
    width: Math.max(0, bounds.width - borderLeft - borderRight - padLeft - padRight),
    height: Math.max(0, bounds.height - borderTop - borderBottom - padTop - padBottom),
    offsetRow: borderTop + padTop,
    offsetCol: borderLeft + padLeft,
  };
}

/** Glyph set used for decoration borders. P4c uses the `unicode` family
 *  (single-line box) as the baseline and swaps individual corners for
 *  rounded glyphs when `borderRadius` > 0. `BorderStyle` is honoured
 *  only via `'double'` swapping the entire set — other styles (dashed /
 *  none) fall back to `solid` in P4c; a fuller mapping matches
 *  `renderChrome` in P4d if needed. */
function decorationGlyphs(d: BoxDecoration): {
  h: string; v: string; tl: string; tr: string; bl: string; br: string;
} {
  const topStyle = d.border?.top?.style ?? 'solid';
  const double = topStyle === 'double';
  const h = double ? '═' : '─';
  const v = double ? '║' : '│';
  const r = d.borderRadius;
  const tl = double ? '╔' : ((r?.topLeft ?? 0) > 0 ? '╭' : '┌');
  const tr = double ? '╗' : ((r?.topRight ?? 0) > 0 ? '╮' : '┐');
  const bl = double ? '╚' : ((r?.bottomLeft ?? 0) > 0 ? '╰' : '└');
  const br = double ? '╝' : ((r?.bottomRight ?? 0) > 0 ? '╯' : '┘');
  return { h, v, tl, tr, bl, br };
}

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` into a raw 38;2 SGR foreground
 *  payload. Returns `null` when the input isn't a usable hex so callers
 *  fall through to "no colour" rather than emit a malformed sequence.
 *  Mirrors `hexToTrueColourForeground` in `chrome/text-style-to-ansi.ts`
 *  — kept local so this file stays free of `chalk.level` detection
 *  quirks (bun test pipes stdout → `chalk.level = 0`). */
function hexToSgrFg(hex: string): string | null {
  const cleaned = hex.startsWith('#') ? hex.slice(1) : hex;
  let r: number, g: number, b: number;
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    b = parseInt(cleaned[2]! + cleaned[2]!, 16);
  } else if (cleaned.length >= 6) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    return null;
  }
  if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return `\u001b[38;2;${r};${g};${b}m`;
}

function tint(str: string, colour: string | null): string {
  if (!colour) return str;
  const open = hexToSgrFg(colour);
  if (!open) return str;
  return `${open}${str}\u001b[39m`;
}

/** P4c — wrap `viewLines` (inner-sized string array from the Printer)
 *  with the decoration's border + padding so the result fills the
 *  outer bounds exactly. Fill color (`decoration.color`) tints padding
 *  and border cells; border color resolves from `border.top.color` or
 *  whichever side is first non-null. */
export function composeDecorationFrame(input: {
  readonly viewLines: readonly string[];
  readonly outerWidth: number;
  readonly decoration: BoxDecoration;
  readonly theme?: ThemeTokens;
}): string[] {
  const { viewLines, outerWidth, decoration, theme } = input;
  const g = decorationGlyphs(decoration);
  const hasLeft = !!decoration.border?.left;
  const hasRight = !!decoration.border?.right;
  const hasTop = !!decoration.border?.top;
  const hasBottom = !!decoration.border?.bottom;
  const borderToken =
    decoration.border?.top?.color
    ?? decoration.border?.left?.color
    ?? decoration.border?.right?.color
    ?? decoration.border?.bottom?.color
    ?? null;
  const borderHex = theme ? resolveColorToken(borderToken, theme) : null;
  const fillHex = theme ? resolveColorToken(decoration.color ?? null, theme) : null;
  const fillCell = tint(' ', fillHex);

  const innerLen = Math.max(0, outerWidth - (hasLeft ? 1 : 0) - (hasRight ? 1 : 0));
  const leftV = hasLeft ? tint(g.v, borderHex) : '';
  const rightV = hasRight ? tint(g.v, borderHex) : '';

  const rows: string[] = [];

  if (hasTop) {
    rows.push(
      (hasLeft ? tint(g.tl, borderHex) : '')
      + tint(g.h.repeat(innerLen), borderHex)
      + (hasRight ? tint(g.tr, borderHex) : ''),
    );
  }

  const padTop = decoration.padding?.top ?? 0;
  const padBottom = decoration.padding?.bottom ?? 0;
  const padLeft = decoration.padding?.left ?? 0;
  const padRight = decoration.padding?.right ?? 0;
  const padLeftStr = fillCell.repeat(padLeft);
  const padRightStr = fillCell.repeat(padRight);
  const fillInner = fillCell.repeat(innerLen);

  for (let i = 0; i < padTop; i++) {
    rows.push(`${leftV}${fillInner}${rightV}`);
  }

  for (const line of viewLines) {
    rows.push(`${leftV}${padLeftStr}${line}${padRightStr}${rightV}`);
  }

  for (let i = 0; i < padBottom; i++) {
    rows.push(`${leftV}${fillInner}${rightV}`);
  }

  if (hasBottom) {
    rows.push(
      (hasLeft ? tint(g.bl, borderHex) : '')
      + tint(g.h.repeat(innerLen), borderHex)
      + (hasRight ? tint(g.br, borderHex) : ''),
    );
  }

  return rows;
}

export function mountViewAsModalSurface(spec: ViewSurfaceSpec): ViewSurfaceHandle {
  let disposed = false;
  let lastRegistry: ClickRegistry | null = null;
  const drag = new DragMachine();

  // R2 — when a LayoutSpec is present, resolve it now and override
  // `spec.bounds`. Keeps downstream paint / hit-test code reading
  // from a single `spec.bounds` field regardless of whether the
  // caller used the declarative anchor (`layout`) or passed a
  // concrete rect up front. Mutation is safe — the spec is owned
  // by this mount call and isn't shared.
  if (spec.layout) {
    try {
      const env = spec.layoutEnv ?? { term: { rows: 24, cols: 80 } };
      const resolved = resolveLayoutSpec(spec.layout, env);
      spec.bounds = {
        row: resolved.row,
        col: resolved.col,
        width: resolved.width,
        height: resolved.height,
      };
    } catch {
      // If resolution fails (e.g. a misconfigured env + above-input
      // without an inputZone), fall through to the pre-supplied
      // `spec.bounds`. This keeps adopters from breaking at mount
      // time under partial env — the bounds stays the caller's
      // best-effort fallback.
    }
  }

  // S2 / F8 — chrome default propagation. When the caller didn't pass
  // a `decoration` AND the theme has opted in via `chromeDefaults`, the
  // resolver below substitutes the per-tier shape so every dialog /
  // popup / menu / terminal of a given theme paints a coherent chrome
  // without duplicating BoxDecoration boilerplate at every call site.
  // Themes that don't ship `chromeDefaults` get `undefined` back and
  // existing modals stay un-framed (pre-S2 contract).
  const effectiveTheme = spec.theme ?? readAmbientModalTheme();
  const effectiveDecoration = spec.decoration ?? resolveChromeDefault(spec.tier, effectiveTheme);

  // P4b — decoration → shadow translation. Explicit `spec.shadow`
  // always wins; the decoration path only fills in when no legacy
  // spec was supplied. Keeps both styles (legacy + declarative)
  // viable without forcing migration.
  if (!spec.shadow && effectiveDecoration) {
    const derived = deriveShadowFromDecoration(
      effectiveDecoration,
      effectiveTheme,
    );
    if (derived) spec.shadow = derived;
  }

  // P4c — compute inner dims once. Legacy callers (no decoration or a
  // decoration with only boxShadow) get outer dims passed through
  // unchanged, so view.layout + Printer.create + mouse translation all
  // see the original bounds. Decorations that actually frame the view
  // yield smaller `inner` values; the view lays itself out inside the
  // frame and the paint loop wraps the output with border + padding.
  const inner = computeInnerDims(spec.bounds, effectiveDecoration);
  const chromeActive = hasRenderableChrome(effectiveDecoration);
  let lastLayoutWidth = inner.width;
  let lastLayoutHeight = inner.height;

  // The view is laid out once up front (with the declared bounds).
  // Re-layout happens if the caller resizes bounds externally —
  // but since ModalSurface.bounds is readonly, that's a full remount.
  spec.view.layout({ width: inner.width, height: inner.height });
  spec.view.takeFocus('front');

  // IDX-2b — context-key lifecycle. tier set → atomically flip the
  // corresponding context key on mount AND on dispose. Ownership
  // counting (for stacked modals of the same tier) is deliberately
  // simplified in this session: each tier flag stays true while at
  // least one modal of that tier exists. Proper stack-counting lands
  // in IDX-2c with the ModalTier enum + registry.
  const ctxSvc = spec.tier
    ? (spec.contextKeyService ?? getRuntimeContextKeyService())
    : null;
  const ctxKey = spec.tier ? MODAL_TIER_CONTEXT_KEY[spec.tier] : null;
  if (ctxSvc && ctxKey) {
    // Mount: set flag true AND record previous modalTopTier so dispose
    // can restore it. A modal of tier X that opens over a modal of
    // tier Y leaves modalTopTier === 'X' while active; on dismiss we
    // restore to 'Y' so subsequent bindings see the correct stack top.
    ctxSvc.update({ [ctxKey]: true, modalTopTier: spec.tier } as Partial<ContextKeys>);
  }

  // IDX-F8b — cache the backdrop ANSI. Paint fires every frame; theme
  // and tier don't change over a surface's lifetime, so one resolve
  // at mount is cheaper than re-reading env + theme every redraw.
  const backdropAnsi = resolveBackdropAnsi({
    theme: spec.theme,
    shadowTheme: spec.shadow?.theme,
    tier: spec.tier,
    backdrop: spec.backdrop,
  });

  const paint = (): string => {
    if (disposed) return '';
    const bounds = surface.bounds;
    const innerNow = computeInnerDims(bounds, effectiveDecoration);
    if (innerNow.width !== lastLayoutWidth || innerNow.height !== lastLayoutHeight) {
      spec.view.layout({ width: innerNow.width, height: innerNow.height });
      lastLayoutWidth = innerNow.width;
      lastLayoutHeight = innerNow.height;
    }
    // P4c — Printer matches the inner dims (legacy path has inner ==
    // outer, so this keeps the prior behaviour byte-for-byte when no
    // decoration is active). When decoration is active, the view
    // draws into a smaller Printer and the framing step wraps the
    // output with border + padding to fill outer bounds.
    const p = Printer.create({
      width: innerNow.width,
      height: innerNow.height,
      focused: true,
    });
    // IDX-F8b — fill the modal rect with the pastel backdrop before the
    // view draws. Cells the view touches get overwritten with view
    // content; cells the view leaves blank keep the backdrop colour.
    // Gated by tier + env + explicit opt-out via `resolveBackdropAnsi`.
    if (backdropAnsi) p.fill(' ', backdropAnsi);
    try {
      spec.view.draw(p);
      // Phase D-3 cleanup (2026-04-21) — the old post-frame
      // `p.backfillEmptyStyle(backdropAnsi)` call is gone. Phase D-2
      // (PR #269) made `Printer.placeText` merge SGR via
      // `mergeStyle(existingCell.style, activeStyle)` (see
      // src/ui/printer-cell-model.ts). That auto-preserves the
      // backdrop bg laid down by the `p.fill(' ', backdropAnsi)`
      // above whenever a view paints a fg-only span — so no
      // second-pass backfill is needed.
      lastRegistry = p.registry;
    } catch {
      // A paint() throw must not break the frame — return empty and
      // leave the previous registry alone (stale is better than
      // undefined, and the next successful paint refreshes it).
      return '';
    }
    const viewLines = p.lines();
    const lines = chromeActive && effectiveDecoration
      ? composeDecorationFrame({
          viewLines,
          outerWidth: bounds.width,
          decoration: effectiveDecoration,
          theme: effectiveTheme,
        })
      : viewLines;
    const out: string[] = [];
    // CRITICAL: do NOT emit `\x1b[2K` here. Clearing the entire row
    // would wipe out base-frame content OUTSIDE this modal's bounds
    // (input prompt, pane-nav, status-gap, etc.). We write exactly
    // bounds.width cells at bounds.col onwards; the terminal keeps
    // whatever the base frame painted before and after our region.
    // Always emit a leading SGR reset so residual styles from the
    // cell to the LEFT of the popup don't bleed into our first cell.
    for (let i = 0; i < lines.length; i++) {
      out.push(ansi.moveTo(bounds.row + i, bounds.col) + '\x1b[0m' + lines[i]);
    }
    // IDX-6 Phase 5 — drop shadow. Paint one col to the right of
    // every body row (excluding top) plus one row below the bottom
    // of bounds (starting one col to the right of the left edge).
    // Cells lie OUTSIDE spec.bounds — they don't increase the modal's
    // footprint for hit-testing purposes; they're decoration only.
    const shadowSeq = resolveShadowAnsi(spec.shadow);
    if (shadowSeq) {
      const glyph = shadowSeq.glyph;
      const prefix = shadowSeq.ansi;
      // Right edge: rows 1..height-1 (skip top so shadow reads as
      // "light from upper-left"). For each, write at col = right+1.
      for (let i = 1; i < spec.bounds.height; i++) {
        out.push(
          ansi.moveTo(bounds.row + i, bounds.col + bounds.width)
          + '\x1b[0m' + prefix + glyph + '\x1b[0m',
        );
      }
      // Bottom edge: row = bottom+1, cols = left+1..right+1 inclusive.
      const bottomRow = bounds.row + bounds.height;
      const bottomLen = bounds.width;   // width matches left+1..right
      if (bottomLen > 0) {
        out.push(
          ansi.moveTo(bottomRow, bounds.col + 1)
          + '\x1b[0m' + prefix + glyph.repeat(bottomLen) + '\x1b[0m',
        );
      }
    }
    return out.join('');
  };

  const visualBounds = spec.shadow
    ? {
        row: spec.bounds.row,
        col: spec.bounds.col,
        width: spec.bounds.width + 1,
        height: spec.bounds.height + 1,
      }
    : { ...spec.bounds };

  const handleKey = (ev: KeyEvent): 'consumed' | 'passthrough' => {
    if (disposed) return 'passthrough';
    try {
      const r = spec.view.onEvent(ev);
      return r.kind === 'consumed' ? 'consumed' : 'passthrough';
    } catch {
      return 'passthrough';
    }
  };

  const surface: ModalSurface = {
    id: spec.id,
    owner: spec.owner ?? 'dashboard',
    kind: 'modal',
    focus: 'owns',
    priority: spec.priority ?? DEFAULT_MODAL_PRIORITY,
    tier: spec.tier,
    freezeBottomArea: spec.freezeBottomArea,
    interactionClass: spec.interactionClass ?? interactionClassForModalTier(spec.tier),
    backgroundInteractionPolicy: spec.backgroundInteractionPolicy,
    bounds: spec.bounds,
    interactiveBounds: { ...spec.bounds },
    visualBounds,
    backdropBounds: { ...spec.bounds },
    render: () => [],
    paint,
    cursor: spec.cursor,
    // Previously callers had to manually patch `handle.surface.onKey =
    // handle.handleKey` after mounting. Several callers forgot
    // (mouse-action-recipes / slash-launcher / status-bar-popups /
    // vw-*-modal / ask-user-question / plan-exit-modal), which left
    // the modal visible but key-inert — coordinator.routeKey would
    // see `!surface.onKey` and fall through, and the user would
    // find the picker/dialog unresponsive to Enter/Esc/letters while
    // cursor-move keys happened to work via other code paths. Wiring
    // onKey here makes this the default so the adapter is "mount and
    // it works". Callers that still patch `surface.onKey` after this
    // become harmless redundancy.
    onKey: handleKey,
    dispose: () => doCleanup(),
  };

  /** B-3b (2026-04-21) — unified cleanup closure. Previously the
   *  surface.dispose path (coordinator → closeSurface → surface.
   *  dispose?()) ran only `clearContextKey + spec.onDispose`, while
   *  the handle.dispose path (caller holding the ViewSurfaceHandle)
   *  additionally ran `drag.abort()`. The gap leaked pointer-capture
   *  state whenever a modal was disposed via coordinator/primitive
   *  (i.e. when `coord.modalLifecycleAPI().push(...)` → primitive
   *  dispose chain invoked surface.dispose). Routing both entry
   *  points through this single closure makes cleanup identical
   *  regardless of who initiates dispose — the minimum contract for
   *  B-3b's "primitive as lifecycle driver" model where coord's
   *  `modalLifecycle.on('disposed')` calls closeSurface and relies
   *  on surface.dispose running every teardown step. */
  function doCleanup(): void {
    if (disposed) return;
    disposed = true;
    drag.abort();
    clearContextKey();
    spec.onDispose?.();
  }

  /** Shared cleanup — called by both surface.dispose (coordinator
   *  path) and handle.dispose (caller path). Idempotent via the
   *  outer `disposed` flag. */
  function clearContextKey(): void {
    if (!ctxSvc || !ctxKey) return;
    // IDX-2b — atomic context-key cleanup. Clear the tier flag.
    // modalTopTier is cleared only if this modal still appears to
    // be on top (i.e. no one has mounted a higher tier since our
    // mount). Proper stack accounting is IDX-2c scope.
    const currentTopTier = ctxSvc.keys.modalTopTier;
    const patch: Partial<ContextKeys> = { [ctxKey]: false };
    if (currentTopTier === spec.tier) patch.modalTopTier = null;
    ctxSvc.update(patch);
  }

  const handleMouse = (ev: DisplayMouseEvent): 'consumed' | 'passthrough' => {
    if (disposed || !lastRegistry) return 'passthrough';
    const bounds = surface.bounds;
    const innerNow = computeInnerDims(bounds, effectiveDecoration);
    // DisplayMouseEvent row/col are 1-indexed terminal coords. Modal
    // bounds.row/col are 1-indexed. Registry hit-test wants 0-indexed
    // coords relative to the modal's top-left.
    // P4c — when decoration adds border/padding, the view's registry
    // lives in inner-space; shift by `inner.offsetRow/Col`. Clicks
    // that fall on the border/padding band (negative rel coord OR past
    // inner dims) pass through — the chrome is purely decoration, not
    // a click target in P4c.
    const rootX = ev.col - bounds.col - innerNow.offsetCol;
    const rootY = ev.row - bounds.row - innerNow.offsetRow;
    if (chromeActive && (rootX < 0 || rootY < 0 || rootX >= innerNow.width || rootY >= innerNow.height)) {
      return 'passthrough';
    }
    const hit = lastRegistry.hit(rootX, rootY);
      const chromeHit = hitChromeControl(bounds.width, rootX, rootY, spec.chromeControls);
    const titleRailHit = isModalTitleRailHit(bounds.width, rootX, rootY, spec.chromeControls);

    const mkEvent = (region: ClickRegion, type: MouseEventType): MouseEvent => ({
      type,
      x: rootX - region.absX,
      y: rootY - region.absY,
      absX: rootX,
      absY: rootY,
      payload: region.payload,
    });

    try {
      // Drag routing: 'drag' and 'release' events are captured by the
      // DragMachine and forwarded to the drag origin (not the current
      // hit). This preserves drag semantics when the pointer leaves
      // the origin's region mid-gesture.
      if (isCaptureSessionMouseEventType(ev.type) && !isCaptureSessionEndMouseEventType(ev.type) && drag.isDragging()) {
        const origin = drag.onDrag(rootX, rootY);
        if (origin) {
          const r = origin.view.onMouse?.(mkEvent(origin, 'drag'));
          return r?.kind === 'consumed' ? 'consumed' : 'passthrough';
        }
      }
      if (isCaptureSessionEndMouseEventType(ev.type) && drag.isDragging()) {
        const result = drag.onRelease(hit, rootX, rootY);
        // Origin receives a release event. Local coords use the
        // origin's region translation when the pointer is still
        // inside it; otherwise we fall back to absolute (local may
        // go negative — widgets should handle that gracefully).
        if (result.origin) {
          result.origin.onMouse?.({
            type: 'release',
            x: hit && hit.view === result.origin ? rootX - hit.absX : rootX,
            y: hit && hit.view === result.origin ? rootY - hit.absY : rootY,
            absX: rootX,
            absY: rootY,
          });
        }
        if (result.drop) {
          result.drop.view.onDropReceive?.(result.drop.ev);
        }
        return 'consumed';
      }

      if (!hit && chromeHit && isPrimaryDiscreteClickMouseEventType(ev.type)) {
        ev.hitTarget = { kind: 'modal-button', modalId: spec.id, buttonId: chromeHit };
        if (chromeHit === 'chrome-close') {
          dispatchChromeControlAction('close', spec.chromeControls, doCleanup);
          return 'consumed';
        }
        if (chromeHit === 'chrome-minimize') {
          dispatchChromeControlAction('minimize', spec.chromeControls, doCleanup);
          return 'consumed';
        }
      }

      if (
        spec.chromeControls !== undefined
        && titleRailHit
        && isModalChromeMouseEventType(ev.type)
      ) {
        ev.hitTarget = { kind: 'modal-title', modalId: spec.id };
        return 'consumed';
      }

      // Non-drag path: route to whatever region the pointer is over.
      if (!hit) return 'passthrough';

      const mouseEvent = mkEvent(hit, ev.type as MouseEventType);

      // IDX-F5c — refine ev.hitTarget from coarse `{kind:'modal-body',
      // modalId}` (attached by mouse-wiring in F5b) to the fine-grained
      // item / button target the registered click region describes.
      // Precedence: the view's optional `describeHit` override wins,
      // then the payload-convention reader on `hit.payload`. When
      // ev.hitTarget wasn't set (e.g. the wiring layer is bypassed in
      // tests), we still synthesize from spec.id + refinement so
      // downstream consumers see a consistent shape.
      if (ev.hitTarget === undefined || ev.hitTarget.kind === 'modal-body') {
        const viewRefinement = hit.view.describeHit?.(mouseEvent.y, mouseEvent.x) ?? null;
        const refinement = viewRefinement ?? refineHitFromPayload(hit.payload);
        const refined = applyModalIdToRefinement(spec.id, refinement);
        if (refined) {
          ev.hitTarget = refined;
        } else if (ev.hitTarget === undefined) {
          ev.hitTarget = { kind: 'modal-body', modalId: spec.id };
        }
      }

      if (isPrimaryDiscreteClickMouseEventType(ev.type)) {
        // Try drag-start: if the view opts in, we silently capture.
        // The view still gets a synthetic onMouse(type='click') so
        // widgets that want both click + drag semantics can handle
        // both (e.g. click-to-focus AND click-and-drag-to-reorder).
        drag.onMouseDown(hit, mouseEvent);
      }

      // MX6 — on right-click, ask the view for context actions. When
      // the view returns a non-empty list we hand the host a
      // ContextMenuRequest so it can mount the popup. onMouse is
      // still dispatched so widgets that want custom handling are
      // free to short-circuit by returning Consumed.
      if (isSecondaryClickMouseEventType(ev.type) && spec.onContextMenu) {
        const actions = hit.view.contextActions?.(mouseEvent);
        if (actions && actions.length > 0) {
          try {
            spec.onContextMenu({
              items: actions,
              anchorRow: ev.row,
              anchorCol: ev.col,
              ownerWorkspaceId:
                surface.ownerWorkspaceId
                ?? (surface.interactionClass === 'workspace' ? surface.id : undefined),
              origin: hit.view,
            });
          } catch {
            /* host hook failed — swallow */
          }
        }
      }

      const r = hit.view.onMouse?.(mouseEvent);
      return r?.kind === 'consumed' ? 'consumed' : 'passthrough';
    } catch {
      return 'passthrough';
    }
  };

  return {
    surface,
    handleKey,
    handleMouse,
    // B-3b — route through the unified closure so surface.dispose
    // and handle.dispose produce identical side effects. See
    // doCleanup comment above for the why.
    dispose: () => doCleanup(),
    isDisposed: () => disposed,
  };
}

function hitChromeControl(
  width: number,
  localX: number,
  localY: number,
  controls: ChromeControlsSpec | undefined,
): 'chrome-minimize' | 'chrome-close' | null {
  const titleRight = formatChromeControlsTitleRight(controls);
  if (!titleRight || localY !== 0 || width < 4) return null;
  const text = ` ${titleRight} `;
  const rightX = Math.max(1, width - visibleWidth(text) - 1);
  let cursorX = rightX + 1;
  if (controls?.minimizeButton) {
    if (localX === cursorX) return 'chrome-minimize';
    cursorX += 2;
  }
  if (controls?.closeButton && localX === cursorX) {
    return 'chrome-close';
  }
  return null;
}

function isModalTitleRailHit(
  width: number,
  localX: number,
  localY: number,
  controls: ChromeControlsSpec | undefined,
): boolean {
  if (localY !== 0 || width < 4) return false;
  if (localX < 1 || localX >= width - 1) return false;
  const titleRight = formatChromeControlsTitleRight(controls);
  if (!titleRight) return true;
  const controlsWidth = visibleWidth(` ${titleRight} `);
  const controlsStart = Math.max(1, width - controlsWidth - 1);
  return localX < controlsStart;
}
