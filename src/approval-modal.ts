// Approval modal — T1-P2 (LC12b refactor).
//
// External contract (createApprovalModal + approvalModalRouter)
// unchanged. Internal is now a Dialog over the LC7 widgets, so the
// "bordered yes/no frame" is delegated to BoxView + ButtonBar and
// we only carry the Korean IME aliases + the serial-router plumbing.
//
// Key map (preserved):
//   y / ㅛ          → resolve(true)
//   n / ㅜ          → resolve(false)
//   Escape          → resolve(false)
//   Ctrl-G / Ctrl-ㅎ → resolve(false)
//   anything else while open → swallowed (consumed) so the modal is
//                              exclusive.

import type { ModalSurface, ModalBounds } from './display/modal-stack.js';
import type { KeyEvent } from './display/types.js';
import { Consumed, Ignored, BoxView, TextView, type EventResult, type FocusSource, type Size, type View } from './ui/view.js';
import type { Printer } from './ui/printer.js';
import { LinearLayout } from './ui/layout/linear.js';
import { resolveModalDialogChromeSpec } from './ui/chrome/dialog-chrome.js';
import { Dialog } from './ui/widgets/dialog.js';
import { mountViewAsModalSurface } from './ui/modal-adapter.js';
import type { ThemeTokens } from './theme/tokens.js';
import { C } from './tui.js';

export interface ApprovalModalSpec {
  id: string;
  bounds: ModalBounds;
  title: string;
  prompt: string;
  detail?: string | string[];
  yesLabel?: string;
  noLabel?: string;
  /** Put the rejecting choice first so Enter/initial focus cannot approve. */
  defaultNo?: boolean;
  theme?: ThemeTokens;
}

export interface ApprovalModalHandle {
  surface: ModalSurface;
  promise: Promise<boolean>;
  handleKey(ev: KeyEvent): 'consumed' | 'passthrough';
  dispose(answer?: boolean): void;
}

export function createApprovalModal(spec: ApprovalModalSpec): ApprovalModalHandle {
  let resolver: ((v: boolean) => void) | null = null;
  const promise = new Promise<boolean>(res => { resolver = res; });
  let resolved = false;
  const resolve = (answer: boolean): void => {
    if (resolved) return;
    resolved = true;
    resolver?.(answer);
  };

  const view = new ApprovalDialog(spec, resolve);
  const mounted = mountViewAsModalSurface({
    id: spec.id,
    bounds: spec.bounds,
    view,
    priority: 250,
    tier: 'dialog',
  });

  const handleKey = (ev: KeyEvent): 'consumed' | 'passthrough' => {
    if (resolved) return 'passthrough';
    const name = (ev.name ?? '').toLowerCase();
    // Korean IME + shortcut aliases — shortcut to the answer bypassing the Dialog routing
    if (name === 'y' || name === 'ㅛ') { resolve(true); return 'consumed'; }
    if (name === 'n' || name === 'ㅜ') { resolve(false); return 'consumed'; }
    if (name === 'escape')               { resolve(false); return 'consumed'; }
    if (ev.ctrl && (name === 'g' || name === 'ㅎ')) { resolve(false); return 'consumed'; }
    // Forward to Dialog in case user pressed Enter/Tab/arrows on the buttons
    const r = mounted.handleKey(ev);
    // Approval modal is exclusive while open — any non-matching key is consumed.
    return r === 'consumed' ? 'consumed' : 'consumed';
  };

  // KX4a — wire surface.onKey so coordinator.routeKey drives the
  // modal via its focus-stacked slot (approval pushes via
  // coordinator.pushModal in dashboard-approvers). Delegates to the
  // same handleKey above so y/n/escape/Ctrl+G semantics are single-
  // sourced. Imperative handle.handleKey + approvalModalRouter are
  // preserved for existing direct-call sites + tests.
  mounted.surface.onKey = handleKey;
  mounted.surface.onMouse = (ev) => mounted.handleMouse(ev) === 'consumed'
    ? { type: 'refresh' }
    : { type: 'none' };

  const dispose = (answer?: boolean): void => {
    resolve(answer ?? false);
    mounted.dispose();
  };

  return { surface: mounted.surface, promise, handleKey, dispose };
}

// ── Internal composite View ────────────────────────────────────

class ApprovalDialog implements View {
  private root: View;

  constructor(spec: ApprovalModalSpec, resolve: (v: boolean) => void) {
    const promptView = new TextView(spec.prompt);
    const detailLines = Array.isArray(spec.detail) ? spec.detail : spec.detail?.split('\n');
    const body: View = detailLines && detailLines.length > 0
      ? LinearLayout.vertical(
          { view: promptView, size: 1 },
          { view: new TextView(mutedMultiline(detailLines)) },   // flex
        )
      : promptView;

    const dialog = new Dialog<boolean>({
      title: spec.title,
      body,
      buttons: spec.defaultNo
        ? [
            { label: spec.noLabel ?? 'No (n/Esc)', value: false, shortcut: 'n', style: 'default' },
            { label: spec.yesLabel ?? 'Yes (y)', value: true, shortcut: 'y', style: 'primary' },
          ]
        : [
            { label: spec.yesLabel ?? 'Yes (y)', value: true, shortcut: 'y', style: 'primary' },
            { label: spec.noLabel ?? 'No (n/Esc)', value: false, shortcut: 'n', style: 'default' },
          ],
      onSubmit: v => resolve(v),
      onCancel: () => resolve(false),
      theme: spec.theme,
      chrome: spec.theme ? 'static' : 'legacy',
      chromeSpec: resolveModalDialogChromeSpec(spec.title, undefined, 'center'),
    });

    this.root = dialog;
  }

  draw(p: Printer): void { this.root.draw(p); }
  onEvent(ev: KeyEvent): EventResult { return this.root.onEvent(ev); }
  layout(size: Size): void { this.root.layout(size); }
  requiredSize(c: Size): Size { return this.root.requiredSize(c); }
  takeFocus(src?: FocusSource): boolean { return this.root.takeFocus(src); }
}

function mutedMultiline(s: string | string[]): string[] {
  const lines = Array.isArray(s) ? s : s.split('\n');
  return lines.map(l => C.muted(l));
}

// ─── Singleton router — Wave E (presentation) adds modal kind tag ──
//
// The router was previously type-agnostic — any open modal flipped
// `approvalModalRouter.current() !== null`, which the background-pill
// runtime mapped to `askUserActive`. That collapsed three distinct
// surfaces (AskUserQuestion, ExitPlanMode, terminal-inject approval)
// into one cyan "needs input" indicator. Wave E gives the router a
// `kind` tag so consumers can disambiguate; default 'approval' keeps
// pre-Wave-E set() calls semantically equivalent.

export type ApprovalModalKind = 'askUser' | 'planExit' | 'approval';

let currentHandle: ApprovalModalHandle | null = null;
let currentKind: ApprovalModalKind | null = null;
let currentOnClose: (() => void) | null = null;

export interface ApprovalModalRouter {
  current(): ApprovalModalHandle | null;
  /** Active modal's kind, or null when no modal is open. */
  currentKind(): ApprovalModalKind | null;
  set(handle: ApprovalModalHandle, onClose: () => void, kind?: ApprovalModalKind): boolean;
  handleKey(ev: KeyEvent): 'consumed' | 'passthrough';
  _resetForTesting(): void;
}

export const approvalModalRouter: ApprovalModalRouter = {
  current: () => currentHandle,
  currentKind: () => currentKind,
  set: (handle, onClose, kind) => {
    if (currentHandle) return false;
    currentHandle = handle;
    currentKind = kind ?? 'approval';
    currentOnClose = onClose;
    handle.promise.finally(() => {
      if (currentHandle === handle) {
        const cb = currentOnClose;
        currentHandle = null;
        currentKind = null;
        currentOnClose = null;
        try { cb?.(); } catch { /* ignore */ }
      }
    });
    return true;
  },
  handleKey: (ev) => currentHandle ? currentHandle.handleKey(ev) : 'passthrough',
  _resetForTesting: () => {
    if (currentHandle) {
      try { currentHandle.dispose(false); } catch { /* ignore */ }
    }
    currentHandle = null;
    currentKind = null;
    currentOnClose = null;
  },
};
