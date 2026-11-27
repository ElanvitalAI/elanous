// ELS-ZAXIS — the Obsidian viewer as an overlay element (popup, z > 0): the same hydrate/render/key as the tab
// (obsidian-view.ts). The server hydrates (vault = config obsidian.vault, passed in the element context); the client renders
// and turns navigation keys into an `update` act, which the server re-validates and re-hydrates.

import type { ElementDef } from './element.js';
import { hydrateObsidianWithEditor } from './obsidian-edit-hydrate.js';
import { hydrateObsidian, obsidianKey, obsidianProps, renderObsidian, type ObsidianProps } from './obsidian-view.js';

export const obsidian: ElementDef<ObsidianProps> = {
  kind: 'obsidian',
  defaults: { band: 'float', focus: 'owns' },
  frames: ['popup', 'tile', 'tab'],
  dress: {},                                              // ELS-POPUP-STYLE fancy: bar · shading · shadow
  // Validation keeps navigation only; data fields come from hydrate. On a client the pushed (already hydrated) props are
  // rendered as they are — see `view` below.
  props: (raw) => obsidianProps(raw),
  hydrate: (props, context) => hydrateObsidianWithEditor(props, context.vault, context.noteEditor, context.notify,
    (nav) => hydrateObsidian(nav, context.vault, context.notify, context.attach ? (rel) => context.attach!(rel, 'obsidian') : undefined)),
  rect: () => ({ anchor: 'center', w: '80%', h: '80%' }),
  render: (props, size, focused) => renderObsidian(props, size, focused),
  key: (layer, bytes) => {
    const props = layer.props as ObsidianProps | undefined;
    if (!props) return 'pass';
    const next = obsidianKey(props, bytes);
    return next === 'pass' || next === 'consumed' ? next : { update: next };
  },
};
