import { basename } from 'node:path';
import type { Key } from '../../tui.js';
import type { InlinePanelSpec } from './inline-panel.js';
// Ported from the retired classic TUI's @ completion (src/dashboard/input/chat-main-at-candidate-opts.ts):
// the same splitAtPrefix/readDirEntries helpers, folders listed with a trailing «/» first, hidden entries only
// when the typed part starts with «.». Absolute («/…») and home («~/…») prefixes list those directories.
import { readDirEntries, splitAtPrefix } from '../../browser-pane/model.js';
import { isImageAttachmentPath } from './image-mentions.js';

/** Candidate contract matches the classic chat `onAtCandidates` shape. */
export interface AtFileCandidate {
  readonly label: string;
  readonly absPath: string;
  readonly isDir: boolean;
}

export interface AtQuery {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

const AT_CANDIDATE_LIMIT = 15;

export function parseAtQuery(text: string, cursor: number): AtQuery | null {
  const head = text.slice(0, cursor);
  const match = head.match(/(?:^|\s)@([\p{L}\p{N}_./~\\-]*)$/u);
  if (!match) return null;
  const prefix = match[1] ?? '';
  return { prefix, start: head.length - prefix.length - 1, end: cursor };
}

/** Folders and files for the typed prefix: relative to root, or absolute / «~/». Folders first, «/»-suffixed. */
export async function listAtFiles(prefix: string, root: string): Promise<AtFileCandidate[]> {
  const normalized = prefix.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  const typedDir = slash < 0 ? (normalized === '~' ? '~/' : '') : normalized.slice(0, slash + 1);
  const partial = slash < 0 ? (normalized === '~' ? '' : normalized) : normalized.slice(slash + 1);
  let dir: string;
  try {
    dir = typedDir ? splitAtPrefix(typedDir, root).dir : splitAtPrefix('', root).dir;
  } catch {
    return [];
  }
  const { folders, files } = readDirEntries(dir, partial.startsWith('.'));
  const wanted = partial.toLocaleLowerCase();
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const matches = (name: string) => name.toLocaleLowerCase().startsWith(wanted);
  return [
    ...folders.filter((entry) => matches(entry.name)).sort(byName)
      .map((entry) => ({ label: `${typedDir}${entry.name}/`, absPath: entry.absPath, isDir: true })),
    ...files.filter((entry) => matches(entry.name)).sort(byName)
      .map((entry) => ({ label: `${typedDir}${entry.name}`, absPath: entry.absPath, isDir: false })),
  ].slice(0, AT_CANDIDATE_LIMIT);
}

export function acceptAtFile(text: string, query: AtQuery, candidate: AtFileCandidate, ordinal: number): { text: string; cursor: number; token: string } {
  const kind = isImageAttachmentPath(candidate.absPath) ? 'image' : 'attached';
  const token = `[${kind} ${ordinal}: ${basename(candidate.absPath)}]`;
  const insertion = `${token} `;
  const next = text.slice(0, query.start) + insertion + text.slice(query.end);
  return { text: next, cursor: query.start + insertion.length, token };
}

/** A folder choice descends: the query becomes «@<folder>/» and the picker lists inside it. */
export function descendAtFolder(text: string, query: AtQuery, candidate: AtFileCandidate): { text: string; cursor: number } {
  const insertion = `@${candidate.label}`;
  return { text: text.slice(0, query.start) + insertion + text.slice(query.end), cursor: query.start + insertion.length };
}

export function attachmentsForMessage(text: string, selected: ReadonlyMap<string, string>): string[] {
  return [...selected].filter(([token]) => text.includes(token)).map(([, path]) => path);
}

export type AtPickerPanelAction =
  | { readonly kind: 'moved' | 'dismissed' }
  | { readonly kind: 'descended'; readonly text: string; readonly cursor: number }
  | { readonly kind: 'selected'; readonly accept: (ordinal: number) => ReturnType<typeof acceptAtFile> & { absPath: string } };

export const AT_PICKER_STATUS_OPEN = '@ file candidates · ↑↓ select · Enter attach';
export const AT_PICKER_STATUS_EMPTY = '@ no matching files · keep typing';

/** Input branch owns query, candidates, selection and dismissal; the host owns attachments. */
export function createAtPickerPanel(
  root: string,
  list: typeof listAtFiles = listAtFiles,
) {
  let active: { query: AtQuery; candidates: AtFileCandidate[]; selected: number } | null = null;
  let dismissed = '';
  let revision = 0;
  const queryKey = (query: AtQuery) => `${query.start}:${query.prefix}`;
  const close = () => { revision++; active = null; dismissed = ''; };
  return {
    get isOpen(): boolean { return active !== null; },
    get panel(): InlinePanelSpec | null {
      return active ? {
        title: '@ Attach file',
        rows: active.candidates.map(({ label, absPath, isDir }) => ({
          label,
          ...(isDir ? { description: 'folder' } : isImageAttachmentPath(absPath) ? { description: 'image' } : {}),
        })),
        selected: active.selected,
        hint: '↑↓ select · Enter attach / open folder · Esc close',
      } : null;
    },
    close,
    async refresh(text: string, cursor: number): Promise<string | null> {
      const current = ++revision;
      const query = parseAtQuery(text, cursor);
      if (!query) { active = null; dismissed = ''; return null; }
      if (dismissed === queryKey(query)) { active = null; return null; }
      const candidates = await list(query.prefix, root);
      // A close or newer edit must not be undone by a slow directory read.
      if (current !== revision) return null;
      active = { query, candidates, selected: 0 };
      return candidates.length ? AT_PICKER_STATUS_OPEN : AT_PICKER_STATUS_EMPTY;
    },
    handleKey(key: Pick<Key, 'name' | 'shift' | 'alt' | 'ctrl'>, text: string): AtPickerPanelAction | null {
      if (!active) return null;
      if (key.name === 'escape') {
        dismissed = queryKey(active.query);
        active = null;
        revision++;
        return { kind: 'dismissed' };
      }
      if ((key.name === 'up' || key.name === 'down') && active.candidates.length) {
        active.selected = (active.selected + (key.name === 'up' ? -1 : 1) + active.candidates.length) % active.candidates.length;
        return { kind: 'moved' };
      }
      const enter = (key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl;
      if (enter || (key.name === 'tab' && !key.shift && !key.alt && !key.ctrl)) {
        const candidate = active.candidates[active.selected];
        if (!candidate) return null;
        const query = active.query;
        if (candidate.isDir) {
          // Keep the picker live: the host sets the new draft and refreshes, which lists the folder.
          revision++;
          active = null;
          return { kind: 'descended', ...descendAtFolder(text, query, candidate) };
        }
        close();
        return { kind: 'selected', accept: (ordinal) => ({ ...acceptAtFile(text, query, candidate, ordinal), absPath: candidate.absPath }) };
      }
      return null;
    },
  };
}
