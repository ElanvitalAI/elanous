// ELS-ZAXIS fallback — the Obsidian viewer as a TAB (`els obsidian`, widget «obsidian»): the same element code as the popup
// (hydrate · render · key from elements/obsidian-view.ts) hosted full-screen in its own pane. Read-only. The vault root is
// the elanous config key `obsidian.vault`. No mouse reporting is turned on (keys only).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createNoteEditor } from './elements/note-editor.js';
import { hydrateObsidianWithEditor } from './elements/obsidian-edit-hydrate.js';
import { MAX_NOTE_BYTES, hydrateObsidian, obsidianKey, renderObsidian, type ObsidianProps } from './elements/obsidian-view.js';

const ESC = '\u001b';
export const ENTER_TAB = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`;
export const LEAVE_TAB = `${ESC}[?25h${ESC}[?1049l`;

export interface ObsidianTabDeps {
  readonly vault: () => string | undefined;
  readonly write: (text: string) => void;
  readonly size: () => { cols: number; rows: number };
  /** ELS-TAKEOUT: one md file shown read-only (a sidechat answer taken out to a tab) instead of the vault. */
  readonly file?: string;
  /** ELS-ATTACH: `a` hands the note to an open agent pane through the els server; resolves to the one-line result. */
  readonly attach?: (rel: string) => Promise<string>;
  /** ELS-OBSIDIAN-EDIT: one-step backups of edited notes (<els state>/obsidian-backup). */
  readonly backupDir?: () => string | undefined;
}

/** ELS-TAKEOUT: one md file as the viewer's open note (bounded read; no vault, no navigation away from it). */
export function fileViewProps(file: string): ObsidianProps {
  try {
    const buffer = readFileSync(file);
    const text = buffer.subarray(0, MAX_NOTE_BYTES).toString('utf8');
    return { dir: '', cursor: 0, scroll: 0, note: basename(file), vaultName: 'Memo', text: buffer.length > MAX_NOTE_BYTES ? `${text}\n\n… (truncated)` : text };
  } catch { return { dir: '', cursor: 0, scroll: 0, vaultName: 'Memo', error: `cannot read ${basename(file)}` }; }
}

/** The tab's controller: `key` returns true when the tab should end (q / Esc / ctrl+c). */
export function createObsidianTab(deps: ObsidianTabDeps): { readonly paint: () => void; readonly key: (bytes: string) => boolean; readonly props: () => ObsidianProps } {
  // ELS-OBSIDIAN-EDIT: the tab's own editor buffer (this process is the tab's «server side»).
  const editor = createNoteEditor({ vault: deps.vault, ...(deps.backupDir ? { backupDir: deps.backupDir } : {}), page: Math.max(1, deps.size().rows - 3) });
  let props = deps.file ? fileViewProps(deps.file) : hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, deps.vault());
  const paint = (): void => {
    const { cols, rows } = deps.size();
    const lines = renderObsidian(props, { w: cols, h: rows }, true);
    deps.write(`${ESC}[H${lines.join('\r\n')}`);
  };
  return {
    paint,
    props: () => props,
    key: (chunk) => {
      // ELS-OBSIDIAN-EDIT: a terminal read can carry several keys («↓↓End», a fast typist) — one key at a time while editing
      // (the same split as the attach app's overlay keys); text runs stay whole (Korean IME syllables, a paste).
      if (props.editor) {
        for (const one of chunk.match(/\u001b\[[0-9;?<>]*[ -\/]*[@-~]|\u001bO[@-~]|\u001b|[\u0000-\u001f\u007f]|[^\u0000-\u001f\u007f\u001b]+/gu) ?? []) {
          if (one === '\u0003') return true;
          const next = obsidianKey(props, one, Math.max(1, deps.size().rows - 3));
          if (next !== 'pass' && next !== 'consumed') props = hydrateObsidianWithEditor(next, deps.vault(), editor);
        }
        paint();
        return false;
      }
      const bytes = chunk;
      // A title being typed keeps q/Esc; so does the search line (type q · leave search); ctrl+c always ends the tab.
      if (bytes === '\u0003' || (!props.create && props.search === undefined && (bytes === 'q' || bytes === ESC))) return true;
      const next = obsidianKey(props, bytes, Math.max(1, deps.size().rows - 3));
      if (next === 'pass' || next === 'consumed') return false;
      if (deps.file) { if (!next.note) return false; props = { ...props, scroll: next.scroll }; paint(); return false; }   // scroll only
      props = hydrateObsidianWithEditor(next, deps.vault(), editor, undefined,
        (nav) => hydrateObsidian(nav, deps.vault(), undefined, deps.attach ? (rel) => { void deps.attach!(rel).then((line) => { props = { ...props, notice: line }; paint(); }); } : undefined));
      paint();
      return false;
    },
  };
}
