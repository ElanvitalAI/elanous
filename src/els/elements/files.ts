// ELS-FILES — the file browser as an overlay element (popup, z > 0; ctrl+b f): the same hydrate/render/key as the tab
// (`els files`, files-tab.ts). Frame-agnostic: render(props, size, focused) and key(props, bytes) know nothing about the frame
// that hosts them. The server hydrates (fs reads, bounded); the client renders and turns keys into an `update` act (the
// server re-validates and re-hydrates) or an `open` ask (tab · tile · sidechat · attach to eln — the attach app does it).

import type { ElementDef } from './element.js';
import { filesKey, filesProps, hydrateFiles, renderFiles, type FilesProps } from './files-view.js';

export const files: ElementDef<FilesProps> = {
  kind: 'files',
  defaults: { band: 'float', focus: 'owns' },
  frames: ['popup', 'tab', 'tile'],
  dress: {},                                              // ELS-POPUP-STYLE fancy: bar · shading · shadow
  props: (raw) => filesProps(raw),
  hydrate: (props, context) => hydrateFiles(props, context.files),
  rect: () => ({ anchor: 'center', w: '86%', h: '82%' }),
  render: (props, size, focused) => renderFiles(props, size, focused),
  key: (layer, bytes) => {
    const props = layer.props as FilesProps | undefined;
    if (!props || typeof props.dir !== 'string') return 'pass';
    const next = filesKey(props, bytes);
    return next === 'pass' ? 'pass' : 'open' in next ? { open: next.open } : { update: next };
  },
};
