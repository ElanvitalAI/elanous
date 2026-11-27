// ELS-ZAXIS — the element contract (ELS-ELN-LAYERS §2-1). An element = pure renderer ⊕ key reducer ⊕ data contract; els
// decides which frame (popup · tile · tab), its z and its focus. The server validates props with `props` before a layer
// opens (untrusted input from a pane, a tool or the CLI) and keeps them in a server-side state file; the attach client only
// calls `render` and `key`. Rows are strings (the spliceCells row form), not a cell buffer — YAML-friendly: every field of
// `defaults` and `props` is plain data, so a future UX-YAML spec can declare an element without code.

import type { FocusLevel, LayerBand, OverlayLayer, OverlayRect } from '../overlay-stack.js';
import type { PopupDress } from '../popup-style.js';

export type ElementFrame = 'popup' | 'tile' | 'tab';

export interface ElementDefaults {
  readonly band: LayerBand;
  readonly focus: FocusLevel;
  readonly blocking?: boolean;
  /** Default lifetime in ms (undefined = until closed). */
  readonly ttlMs?: number;
  readonly pin?: 'space' | 'all';
  /** Many at once (each open without a key gets a fresh one — toasts stack); otherwise one per key (open again = raise). */
  readonly multi?: boolean;
}

/** What an element's key reducer returns: `consumed` keeps the key; `pass` hands it down the focus stack; `{ update }` keeps
 *  the key and asks the server to update the layer's props (the server re-validates and re-hydrates them). */
export type KeyAnswer = 'consumed' | 'pass' | { readonly update: unknown };
/** ELS-FILES: open the selected thing somewhere else (tab · tile · sidechat · eln attach) — the attach app does it. */
export type OpenAnswer = { readonly open: import('./files-view.js').FilesOpen };

/** Server-side context for hydrate (data reads live on the server — ELS-ELN-LAYERS §1 rule 3). */
export interface ElementContext {
  readonly vault?: string;
  readonly sidechat?: import('../sidechat-hub.js').SidechatHub;
  /** ELS-TAKEOUT: the els state folder (memos live under it), a toast, and «open this md file in a new read-only tab»
   *  (returns an error line, or undefined when the tab opened). */
  readonly stateDir?: string;
  readonly notify?: (text: string, level: 'info' | 'success' | 'warning' | 'error') => void;
  readonly openTab?: (file: string, title: string) => string | undefined;
  /** ELS-ATTACH: hand a file to an open agent pane (src/els/eln-attach.ts); fire-and-forget, the result is a toast. */
  readonly attach?: (path: string, source: string) => void;
  /** ELS-OBSIDIAN-EDIT: the viewer's note editor buffer (src/els/elements/note-editor.ts). */
  readonly noteEditor?: import('./note-editor.js').NoteEditorStore;
  /** ELS-MEMO: the memo popup's text store (src/els/memo-store.ts). */
  readonly memo?: import('../memo-store.js').MemoStore;
  /** ELS-FILES-SSH: remote reads for the file browser (cached; one ssh call per miss). */
  readonly files?: import('./files-view.js').FilesRemote;
  /** ELS-POPUP-TERM: the server's popup pane (the live els-popup pane, else a fresh $SHELL) — named in one step. */
  readonly popupPane?: () => string | undefined;
}

export interface ElementDef<P> {
  readonly kind: string;
  readonly defaults: ElementDefaults;
  /** Validate untrusted props (server side) — undefined = refuse the open. */
  readonly props: (raw: unknown) => P | undefined;
  /** The layer's rect for these props (relative: re-resolved per view size). `others` = how many layers of this kind are open. */
  readonly rect: (props: P, others: number) => OverlayRect;
  /** Pure rows for a box of `size` (exactly `size.h` rows ideally; the splice pads and clips). */
  readonly render: (props: P, size: { readonly w: number; readonly h: number }, focused: boolean) => readonly string[];
  readonly key?: (layer: OverlayLayer, bytes: string) => KeyAnswer | OpenAnswer;
  /** Server side: fill data fields (fs reads) after validation, on open and on every update. */
  readonly hydrate?: (props: P, context: ElementContext) => P;
  /** ELS-POPUP-STYLE: how it wears the fancy frame (config els.popupStyle) — absent = always its own frame (toasts). */
  readonly dress?: PopupDress;
  /** ELS-MEMO: the layer's pin for these (hydrated) props, applied on every update (a pin toggle lives in the element's data). */
  readonly pinFor?: (props: P) => 'space' | 'all' | undefined;
  /** Frames this element supports; the first is used when the size rule's pick is not supported. */
  readonly frames: readonly ElementFrame[];
}

// 출처: #40244 ELS-ELN-LAYERS README «크기 적응» — wide → tile, narrow → popup (z cover), very narrow → tab.
export const WIDE_COLS = 160;
export const NARROW_COLS = 60;

/** The size-adaptive frame rule (stub for S4: popup-only elements always get popup). */
export function chooseFrame(def: Pick<ElementDef<unknown>, 'frames'>, view: { readonly cols: number; readonly rows: number }): ElementFrame {
  const wanted: ElementFrame = view.cols >= WIDE_COLS ? 'tile' : view.cols >= NARROW_COLS ? 'popup' : 'tab';
  return def.frames.includes(wanted) ? wanted : def.frames[0] ?? 'popup';
}
