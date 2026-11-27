// ELS-FILES — the file browser as a TAB (`els files [dir]`, widget «files»): the same element code as the popup (hydrate ·
// render · key from elements/files-view.ts) hosted full-screen in its own pane — so it also shows as a tile in the grid.
// Read-only browsing. Enter / e run the person's $PAGER / $EDITOR in this same terminal (argv, no shell) and come back.
// No mouse reporting is turned on (keys only).

import { filesKey, filesProps, hydrateFiles, openCommand, renderFiles, type FilesOpen, type FilesProps } from './elements/files-view.js';

const ESC = '\u001b';
export const ENTER_FILES_TAB = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`;
export const LEAVE_FILES_TAB = `${ESC}[?25h${ESC}[?1049l`;

export interface FilesTabDeps {
  readonly dir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: (text: string) => void;
  readonly size: () => { cols: number; rows: number };
  /** Run argv in this terminal and wait (the pager/editor); the tab leaves and re-enters its screen around it. */
  readonly run: (argv: readonly string[]) => void;
}

/** The tab's controller: `key` returns true when the tab should end (q / Esc / ctrl+c outside the filter line). */
export function createFilesTab(deps: FilesTabDeps): { readonly paint: () => void; readonly key: (bytes: string) => boolean; readonly props: () => FilesProps; readonly note: () => string } {
  let props = hydrateFiles(filesProps({ dir: deps.dir }) ?? filesProps({})!);
  let note = '';
  const paint = (): void => {
    const { cols, rows } = deps.size();
    const lines = renderFiles(props, { w: cols, h: rows }, true, note ? `📁 ${note} ·` : '📁');
    deps.write(`${ESC}[H${lines.join('\r\n')}`);
  };
  const open = (ask: FilesOpen): void => {
    if (ask.how === 'tab' || ask.how === 'tile') {
      deps.write(LEAVE_FILES_TAB);
      try { deps.run(openCommand(ask, deps.env)); } finally { deps.write(ENTER_FILES_TAB); }
      note = '';
    } else note = ask.how === 'attach' ? 'attach to eln: use the popup (ctrl+b f)' : 'sidechat: use the popup (ctrl+b f)';
  };
  return {
    paint,
    props: () => props,
    note: () => note,
    key: (bytes) => {
      if (!props.filtering && (bytes === 'q' || bytes === ESC || bytes === '\u0003')) return true;
      if (props.filtering && bytes === ESC) { props = hydrateFiles({ ...props, filtering: false }); paint(); return false; }
      const next = filesKey(props, bytes, Math.max(1, deps.size().rows - 3));
      if (next === 'pass') return false;
      if ('open' in next) open(next.open);
      else { note = ''; props = hydrateFiles(next); }
      paint();
      return false;
    },
  };
}
