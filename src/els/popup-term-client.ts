// ELS-POPUP-TERM — the attach app's side of the popup terminal. One instance per attach app. It
//   · keeps ONE attach stream to the popup pane named by the visible `term` layer (the same attach the app uses for panes:
//     frames in, input/resize/scroll out) and drops it when no term layer is shown;
//   · resizes that pane to the layer's inner box (the box minus its frame), re-sent only when the box changes;
//   · draws the latest frame inside the box (a frame, a title, the screen rows clipped cell-exactly by fitAnsi);
//   · says where the terminal cursor goes while the layer has focus (the PTY's own cursor, inside the box).
// The #40260 hardening rules hold: a focused layer owns every key and wheel; nothing it does not use reaches the pane below;
// no mouse-mode escape is written. Only a pane in POPUP_WS is ever attached (a layer naming any other pane draws a refusal).

import type { AttachFrame, AttachHandlers, Attached } from './attach-client.js';
import { fitAnsi } from './attach-view.js';
import type { ElsResult } from './core.js';
import { POPUP_WS } from './elements/term.js';
import type { OverlayLayer } from './overlay-stack.js';
import type { ElsRequest } from './server.js';

const CURSOR_HEADER = /^\[screen \d+x\d+ cursor=\(row (\d+), col (\d+), visible (true|false)\)\]\n/;
const R = '\u001b[0m';
const FRAME = '\u001b[32m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';

export interface PopupRow { readonly pane: string; readonly workspace: string; readonly state: string; readonly tabId?: string; readonly title?: string }
export const isPopupRow = (row: { readonly workspace: string }): boolean => row.workspace === POPUP_WS;

export interface PopupTermDeps {
  readonly attach: (pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers) => Attached;
  readonly request: (request: ElsRequest) => Promise<ElsResult>;
  /** Repaint the app (a frame arrived, the stream ended). */
  readonly render: () => void;
  /** The popup panes the latest listing has (POPUP_WS rows — the app filters them out of everything else). */
  readonly popupRows: () => readonly PopupRow[];
  /** Ask the server to act on the overlay layer (close · update). */
  readonly act: (one: { action: 'close' | 'update'; id: string; props?: unknown }) => void;
  /** The pane the layer names in the latest pushed stack (another viewer may have named one meanwhile). */
  readonly layerPane: (id: string) => string | undefined;
  /** A fresh popup pane: the person's shell in this cwd (POPUP_WS). Resolves to its pane id. */
  readonly create: () => Promise<string | undefined>;
  readonly note: (text: string) => void;
}

export interface PopupTerm {
  /** Bring the attach stream in line with the visible term layer and its inner box (call before each paint). */
  readonly sync: (layer: OverlayLayer | undefined, box: { readonly w: number; readonly h: number } | undefined) => void;
  /** The layer renderer (the app registers it for kind `term`). */
  readonly render: (layer: OverlayLayer, size: { readonly w: number; readonly h: number }, focused: boolean) => readonly string[];
  /** A frame counter for the paint cache (bumps on every frame). */
  readonly frameSeq: () => number;
  /** Where the PTY cursor is inside the box (0-based, box-relative incl. the frame), undefined = hidden. */
  readonly cursor: () => { readonly x: number; readonly y: number } | undefined;
  readonly input: (bytes: string) => void;
  readonly scroll: (lines: number) => void;
  /** Materialize a layer without a pane: reuse a live popup pane or make one, then name it in the layer. */
  readonly materialize: (layer: OverlayLayer) => void;
  readonly pane: () => string | undefined;
  readonly dispose: () => void;
}

export function createPopupTerm(deps: PopupTermDeps): PopupTerm {
  let attachedPane: string | undefined;
  let attached: Attached | undefined;
  let size = { cols: 0, rows: 0 };
  let lines: string[] = [];
  let cursor: { row: number; col: number; visible: boolean } | undefined;
  let back = 0;
  let seq = 0;
  let ended: string | undefined;
  let materializing: string | undefined;

  const detach = (): void => { attached?.detach(); attached = undefined; attachedPane = undefined; lines = []; cursor = undefined; back = 0; };
  const onFrame = (frame: AttachFrame): void => {
    const header = CURSOR_HEADER.exec(frame.screen);
    cursor = header ? { row: Number(header[1]), col: Number(header[2]), visible: header[3] === 'true' } : undefined;
    lines = frame.screen.replace(CURSOR_HEADER, '').replace(/^\[screen [^\]]*\]\n/, '').replace(/\n+$/, '').split('\n');
    back = frame.back;
    seq++;
    deps.render();
  };
  return {
    sync(layer, box) {
      const pane = (layer?.props as { pane?: string } | undefined)?.pane;
      const inner = box ? { cols: Math.max(1, box.w - 2), rows: Math.max(1, box.h - 2) } : undefined;
      if (!layer || !pane || !inner) { if (attached) detach(); return; }
      // Only a pane of the reserved popup workspace is ever attached (a layer naming any other pane is refused).
      const row = deps.popupRows().find((one) => one.pane === pane);
      if (!row) { if (attached) detach(); ended = undefined; return; }          // not listed yet (just made) — or not ours: never attached
      if (attachedPane !== pane) {
        detach();
        ended = undefined;
        attachedPane = pane;
        size = inner;
        attached = deps.attach(pane, inner, {
          onFrame,
          onEnd: (_code, reason) => {
            if (attachedPane !== pane) return;
            attached = undefined; attachedPane = undefined; ended = reason || 'the shell ended';
            // The shell exited (or the pane was closed): the popup goes with it. Nothing else is closed — other popup panes
            // (`els term` twice) keep running; an empty els-popup workspace is invisible and harmless.
            deps.act({ action: 'close', id: layer.id });
            deps.render();
          },
          onError: (message) => deps.note(message),
        });
        return;
      }
      if (inner.cols !== size.cols || inner.rows !== size.rows) { size = inner; attached?.resize(inner.cols, inner.rows); }
    },
    render(layer, box, focused) {
      const { w, h } = box;
      if (w < 4 || h < 3) return Array.from({ length: h }, () => fitAnsi('Terminal', w));
      const inner = w - 2;
      const pane = (layer.props as { pane?: string } | undefined)?.pane;
      const live = pane !== undefined && pane === attachedPane;
      const help = focused ? ' ctrl+b Esc hide · ctrl+b x close · ctrl+b m to a tab ' : ' click to type ';
      const title = ` ⌨ Terminal${back > 0 ? ` · ↑ ${back}` : ''} `;
      const top = `${FRAME}╭${R}${BOLD}${fitAnsi(title, Math.min(inner, Bun.stringWidth(title)))}${R}${FRAME}${'─'.repeat(Math.max(0, inner - Bun.stringWidth(title)))}╮${R}`;
      const helpCut = Bun.stringWidth(help) <= inner ? help : '';
      const bottom = `${FRAME}╰${'─'.repeat(Math.max(0, inner - Bun.stringWidth(helpCut)))}${R}${DIM}${helpCut}${R}${FRAME}╯${R}`;
      const body: string[] = live ? lines : [`${DIM}${ended ?? (pane ? 'connecting…' : 'starting a shell…')}${R}`];
      const rows = [top];
      // The screen is drawn as the server rendered it (SGR kept, wide glyphs clipped at the edge by fitAnsi).
      for (let at = 0; at < h - 2; at++) rows.push(`${FRAME}│${R}${fitAnsi(body[at] ?? '', inner)}${R}${FRAME}│${R}`);
      rows.push(bottom);
      return rows;
    },
    frameSeq: () => seq,
    cursor: () => cursor && cursor.visible && attached && back === 0 && cursor.row < size.rows && cursor.col < size.cols ? { x: cursor.col + 1, y: cursor.row + 1 } : undefined,
    input: (bytes) => { attached?.input(bytes); },
    scroll: (n) => { attached?.scroll(n); },
    materialize(layer) {
      if ((layer.props as { pane?: string } | undefined)?.pane || materializing === layer.id) return;
      materializing = layer.id;
      const live = deps.popupRows().find((row) => row.state !== 'exited');
      void (live ? Promise.resolve(live.pane) : deps.create()).then(async (pane) => {
        if (!pane) { deps.note('Could not start the popup terminal'); return; }
        // Two viewers can start one at the same time: whoever names the layer first wins, the loser closes the pane it
        // just made (that exact pane, through the server's close) so no hidden shell is left behind.
        const named = deps.layerPane(layer.id);
        if (named && named !== pane) { if (!live) await deps.request({ op: 'close', pane, confirmed: true }).catch(() => undefined); return; }
        deps.act({ action: 'update', id: layer.id, props: { pane } });
      }, () => deps.note('Could not start the popup terminal')).finally(() => { materializing = undefined; });
    },
    pane: () => attachedPane,
    dispose: () => detach(),
  };
}
