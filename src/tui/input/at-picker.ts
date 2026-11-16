import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Key } from '../../tui.js';
import type { InlinePanelSpec } from './inline-panel.js';

/** Candidate contract matches the classic chat `onAtCandidates` shape. */
export interface AtFileCandidate {
  readonly label: string;
  readonly absPath: string;
  readonly isDir: false;
}

export interface AtQuery {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

export function parseAtQuery(text: string, cursor: number): AtQuery | null {
  const head = text.slice(0, cursor);
  const match = head.match(/(?:^|\s)@([\p{L}\p{N}_./~\\-]*)$/u);
  if (!match) return null;
  const prefix = match[1] ?? '';
  return { prefix, start: head.length - prefix.length - 1, end: cursor };
}

/** List local files under root only; directories are traversal prefixes, never candidates. */
export async function listAtFiles(prefix: string, root: string): Promise<AtFileCandidate[]> {
  const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  const typedDir = slash < 0 ? '' : prefix.slice(0, slash + 1);
  const partial = slash < 0 ? prefix : prefix.slice(slash + 1);
  const dirPart = typedDir.replaceAll('\\', sep).replace(/^~(?=\/)/, '');
  const base = resolve(root, dirPart || '.');
  const inside = relative(resolve(root), base);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return [];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().startsWith(partial.toLocaleLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 15)
      .map((entry) => ({ label: `${typedDir}${entry.name}`, absPath: resolve(base, entry.name), isDir: false as const }));
  } catch {
    return [];
  }
}

export function acceptAtFile(text: string, query: AtQuery, candidate: AtFileCandidate, ordinal: number): { text: string; cursor: number; token: string } {
  const token = `[attached ${ordinal}: ${basename(candidate.absPath)}]`;
  const insertion = `${token} `;
  const next = text.slice(0, query.start) + insertion + text.slice(query.end);
  return { text: next, cursor: query.start + insertion.length, token };
}

export function attachmentsForMessage(text: string, selected: ReadonlyMap<string, string>): string[] {
  return [...selected].filter(([token]) => text.includes(token)).map(([, path]) => path);
}

export type AtPickerPanelAction =
  | { readonly kind: 'moved' | 'dismissed' }
  | { readonly kind: 'selected'; readonly accept: (ordinal: number) => ReturnType<typeof acceptAtFile> & { absPath: string } };

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
        title: '@ 파일 첨부',
        rows: active.candidates.map(({ label }) => ({ label })),
        selected: active.selected,
        hint: 'Enter 추가 · Esc 닫기',
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
      return candidates.length ? '@ 파일 첨부 후보 · ↑↓ 선택 · Enter 추가' : '@ 파일 후보 없음 · 계속 입력';
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
      if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl) {
        const candidate = active.candidates[active.selected];
        if (!candidate) return null;
        const query = active.query;
        close();
        return { kind: 'selected', accept: (ordinal) => ({ ...acceptAtFile(text, query, candidate, ordinal), absPath: candidate.absPath }) };
      }
      return null;
    },
  };
}
