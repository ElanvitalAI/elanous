// ELS-ZAXIS — the element registry: kind → definition. The server validates and places with it; the attach client renders
// with it (renderers / keys for createAttachApp's deps.overlays).

import type { LayerRenderer } from '../overlay-compose.js';
import type { OverlayLayer } from '../overlay-stack.js';
import type { ElementDef, KeyAnswer as PlainKeyAnswer, OpenAnswer } from './element.js';
/** A key answer as the attach app takes it (ELS-FILES adds `open`). */
type KeyAnswer = PlainKeyAnswer | OpenAnswer;
import { paintPopup, type PopupStyle } from '../popup-style.js';
import { files } from './files.js';
import { memo } from './memo.js';
import { obsidian } from './obsidian.js';
import { shortcuts } from './shortcuts.js';
import { sidechat } from './sidechat.js';
import { term } from './term.js';
import { toast } from './toast.js';

export const ELEMENTS: Readonly<Record<string, ElementDef<any>>> = { toast, obsidian, sidechat, memo, files, term, shortcuts };

export function elementOf(kind: string): ElementDef<unknown> | undefined {
  return Object.hasOwn(ELEMENTS, kind) ? ELEMENTS[kind] : undefined;
}

/** Renderers for the attach client. A layer whose props do not validate draws nothing harmful: the framed fallback.
 *  ELS-POPUP-STYLE: every popup is drawn through the ONE style layer; `style` is read at each paint (config els.popupStyle). */
export function elementRenderers(style: () => PopupStyle = () => 'simple'): Record<string, LayerRenderer> {
  return Object.fromEntries(Object.values(ELEMENTS).map((def) => [def.kind, (layer: OverlayLayer, size: { w: number; h: number }, focused: boolean) => {
    // Hydrated elements arrive with server-filled data fields that `props` (navigation-only validation) would strip:
    // render the pushed props as they are, after the same validation succeeds.
    const props = def.props(layer.props);
    return props === undefined ? [] : paintPopup(def, def.hydrate ? layer.props : props, size, focused, style());
  }]));
}

export function elementKeys(): Record<string, (layer: OverlayLayer, bytes: string) => KeyAnswer> {
  return Object.fromEntries(Object.values(ELEMENTS).flatMap((def) => def.key ? [[def.kind, def.key]] : []));
}
