// ELS-OBSIDIAN-EDIT — the viewer's hydrate with the note editor in front: an `editOp` goes to the editor store (server side:
// the els server for the popup, the tab's own process for the tab); while an editor is open the props carry its view (and
// holdEsc, so Esc reaches the editor) instead of re-reading the folder and the note on every key.

import { sep } from 'node:path';
import type { NoteEditorStore } from './note-editor.js';
import { hydrateObsidian, type ObsidianProps } from './obsidian-view.js';

export function hydrateObsidianWithEditor(props: ObsidianProps, vault: string | undefined, editor: NoteEditorStore | undefined,
  notify?: (text: string, level: 'success' | 'error') => void, more?: (nav: ObsidianProps) => ObsidianProps): ObsidianProps {
  const { editOp, editor: _client, ...nav } = props;
  const view = editor?.apply(editOp);
  if (view) {
    const vaultName = (vault ?? '').replace(/[/\\]+$/, '').split(sep).pop() || 'Obsidian';
    return { dir: nav.dir, cursor: nav.cursor, scroll: nav.scroll, ...(nav.note ? { note: nav.note } : {}), vaultName, editor: view, holdEsc: true };
  }
  return more ? more(nav as ObsidianProps) : hydrateObsidian(nav as ObsidianProps, vault, notify);
}
