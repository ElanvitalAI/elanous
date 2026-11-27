// ELS-ZAXIS — the Obsidian viewer element, read-only (대표 11-26: «AI opens Obsidian in els»). Two parts:
//   · hydrate (server side, fs): the vault root comes from the elanous config key `obsidian.vault` (never a hard-coded path);
//     it reads one folder listing (folders + .md notes) and, when a note is open, its text — clamped inside the vault
//     (realpath check, no `..`, no symlink escape), bounded in size.
//   · render / key (pure): a note list with a cursor, or the open note rendered as light markdown with a scroll offset.
// The same code runs as a popup layer (els overlay) and as a tab (`els obsidian`, the widget «obsidian»).
// Ideas copied from classic (8/31 export): widgets/markdown wrapToWidth (word wrap, collapse blank runs) and obsidian-dir.ts
// (vault-clamped navigation, folders first). src/dashboard is not imported.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fitAnsi } from '../attach-view.js';
import { renderMarkdownRows } from './markdown-render.js';
import { attachKey, attachOf } from './obsidian-attach.js';
import { editOpOf, editorKey, editorViewOf, renderNoteEditor, type EditOp, type EditorView } from './note-editor.js';
import { cleanQuery, renderSearch, searchFolderOf, searchKey, searchVault, type ObsidianHit } from './obsidian-search.js';
import { hydrateNewNote, newNoteKey, newNoteOf, newNoteRow, type NewNoteState } from './obsidian-new-note.js';

export interface ObsidianEntry { readonly name: string; readonly dir: boolean }
export interface ObsidianProps {
  /** Folder shown, relative to the vault root ('' = the root). */
  readonly dir: string;
  readonly cursor: number;
  /** Open note, relative to the vault root; absent = the list. */
  readonly note?: string;
  readonly scroll: number;
  /** Filled by hydrate (server): the listing, the note text, or why the vault is unavailable. */
  readonly entries?: readonly ObsidianEntry[];
  readonly text?: string;
  readonly error?: string;
  readonly vaultName?: string;
  /** ELS-OBSIDIAN-SEARCH: the filter line (present = search mode, '' = just opened) and the selected hit. */
  readonly search?: string;
  readonly searchAt?: number;
  /** Filled by hydrate: name matches then text hits; `searchCapped` = a bound cut the scan short. */
  readonly hits?: readonly ObsidianHit[];
  readonly searchCapped?: boolean;
  /** ELS-TAKEOUT B1: the «new note» title/confirm row (obsidian-new-note.ts); `holdEsc` = Esc cancels it; `notice` = the result line. */
  readonly create?: NewNoteState | null;
  readonly holdEsc?: boolean;
  readonly notice?: string;
  /** ELS-ATTACH: a one-shot «attach this note» request (vault-relative); hydrate fires it and drops it. */
  readonly attach?: string;
  /** ELS-OBSIDIAN-EDIT: one editor op (client → server; hydrate applies it and drops it) · the editor's view (server-filled). */
  readonly editOp?: EditOp;
  readonly editor?: EditorView;
}

// 출처: #40244 ELS-ELN-LAYERS §2-4 — els stays light: one folder listing and one note, both bounded.
export const MAX_ENTRIES = 500;
// 출처: #40244 ELS-ELN-LAYERS §2-4 — one note read is bounded (256 KiB), the rest is cut with a marker.
export const MAX_NOTE_BYTES = 262_144;
const SAFE_REL = /^(?:[^/\u0000]+(?:\/[^/\u0000]+)*)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const cleanRel = (value: unknown): string | undefined => {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 1024 || !SAFE_REL.test(value)) return undefined;
  return value.split('/').some((part) => part === '..' || part === '.') ? undefined : value;
};
const nat = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;

/** Navigation props from untrusted input (the data fields are never taken from a caller — hydrate fills them). */
export function obsidianProps(raw: unknown): ObsidianProps | undefined {
  const value = isRecord(raw) ? raw : {};
  const dir = cleanRel(value.dir);
  const note = value.note === undefined ? undefined : cleanRel(value.note);
  if (dir === undefined || (value.note !== undefined && (note === undefined || note === ''))) return undefined;
  const create = newNoteOf(value.create);
  const search = value.search === undefined ? undefined : cleanQuery(value.search);
  if (value.search !== undefined && search === undefined) return undefined;
  const attach = attachOf(value.attach);
  const editOp = editOpOf(value.editOp);
  return { dir, cursor: nat(value.cursor), scroll: nat(value.scroll), ...(note ? { note } : {}), ...(create ? { create } : {}), ...(search !== undefined ? { search, searchAt: nat(value.searchAt) } : {}), ...(attach ? { attach } : {}), ...(editOp ? { editOp } : {}) };
}

/** Is `abs` the vault root or inside it (after resolving symlinks)? */
function insideVault(root: string, abs: string): string | undefined {
  try {
    const real = realpathSync(abs);
    const rel = relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..') ? real : undefined;
  } catch { return undefined; }
}

/** Server side: fill the listing / note text for these navigation props. `vault` = the configured root (undefined = not set). */
export function hydrateObsidian(nav: ObsidianProps, vault: string | undefined, notify?: (text: string, level: 'success' | 'error') => void, attach?: (rel: string) => void): ObsidianProps {
  if (nav.attach && attach) { try { attach(nav.attach); } catch { /* the result is a toast; a failure to start says nothing */ } }
  const made = hydrateNewNote(nav.create ?? undefined, vault, notify);
  if (made.open) nav = { dir: made.open.slice(0, made.open.lastIndexOf('/')), cursor: 0, scroll: 0, note: made.open };   // open the new note
  const base = { dir: nav.dir, cursor: nav.cursor, scroll: nav.scroll, ...(nav.note ? { note: nav.note } : {}),
    ...(made.create ? { create: made.create, holdEsc: true } : {}), ...(made.notice ? { notice: made.notice } : {}),
    ...(nav.search !== undefined && !made.open ? { search: nav.search, searchAt: nav.searchAt ?? 0 } : {}) };
  if (!vault?.trim()) return { ...base, error: 'Obsidian vault not set — elanous config set obsidian.vault <path>' };
  let root: string;
  try { root = realpathSync(vault.trim()); if (!statSync(root).isDirectory()) throw new Error('not a folder'); }
  catch { return { ...base, error: `Obsidian vault not found: ${vault}` }; }
  const vaultName = root.split(sep).pop() ?? 'vault';
  const folder = insideVault(root, join(root, nav.dir));
  if (!folder) return { ...base, dir: '', cursor: 0, vaultName, error: 'folder outside the vault' };
  let entries: ObsidianEntry[] = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true })
      .flatMap((one) => {
        if (one.name.startsWith('.')) return [];
        let dir = one.isDirectory();
        let file = one.isFile();
        if (one.isSymbolicLink()) { try { const st = statSync(join(folder, one.name)); dir = st.isDirectory(); file = st.isFile(); } catch { return []; } }
        return dir || (file && one.name.toLowerCase().endsWith('.md')) ? [{ name: one.name, dir }] : [];
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES);
  } catch { entries = []; }
  const found = nav.search?.trim() ? searchVault(root, nav.search) : undefined;   // ELS-OBSIDIAN-SEARCH: bounded, on demand
  const listed = { ...base, vaultName, entries, cursor: Math.min(nav.cursor, Math.max(0, entries.length - 1)),
    ...(found ? { hits: found.hits, ...(found.capped ? { searchCapped: true } : {}) } : nav.search !== undefined ? { hits: [] } : {}) };
  if (!nav.note) return listed;
  const file = insideVault(root, join(root, nav.note));
  if (!file || !file.toLowerCase().endsWith('.md')) return { ...listed, note: undefined, error: 'note outside the vault' } as ObsidianProps;
  try {
    const buffer = readFileSync(file);
    const text = buffer.subarray(0, MAX_NOTE_BYTES).toString('utf8');
    return { ...listed, text: buffer.length > MAX_NOTE_BYTES ? `${text}\n\n… (truncated)` : text };
  } catch { return { ...listed, note: undefined, error: `cannot read ${nav.note}` } as ObsidianProps; }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** classic widgets/markdown wrapToWidth, cell-exact: word wrap to `width` cells, blank runs collapsed to one. */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  let lastBlank = false;
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (para.trim() === '') { if (!lastBlank) out.push(''); lastBlank = true; continue; }
    lastBlank = false;
    let line = '';
    let used = 0;
    let lastSpace = -1;
    for (const { segment } of graphemes.segment(para.replace(/\t/g, '  '))) {
      const cells = Bun.stringWidth(segment);
      if (used + cells > width) {
        if (segment === ' ') { out.push(line); line = ''; used = 0; lastSpace = -1; continue; }
        if (lastSpace > 0 && lastSpace > line.length * 0.4) { out.push(line.slice(0, lastSpace).trimEnd()); line = line.slice(lastSpace + 1); }
        else { out.push(line); line = ''; }
        used = Bun.stringWidth(line);
        lastSpace = line.lastIndexOf(' ');
      }
      if (segment === ' ') lastSpace = line.length;
      line += segment;
      used += cells;
    }
    out.push(line);
  }
  return out;
}

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const CYAN = '\u001b[36m';
const RESET = '\u001b[0m';

/** Markdown rows for the note view — our classic renderer ported to els (markdown-render.ts: blocks, tables, callouts,
 *  frontmatter, wikilinks, embeds, mermaid placeholder), wrapped to `width` display cells. */
export function markdownRows(text: string, width: number): string[] {
  return renderMarkdownRows(text, width);
}

/** The key hint line: the keys, then the position count. When it does not fit `room` cells, keys drop from the one before
 *  «Esc close» backwards (the first key, Esc close and the count stay) — the count is never the part a narrow box cuts
 *  (H5: an 80x24 view keeps «N/30» in the footer). */
export function keyHint(keys: readonly string[], count: string, room: number): string {
  const kept = [...keys];
  const line = (): string => [...kept, count].join(' · ');
  while (Bun.stringWidth(line()) > room && kept.length > 2) kept.splice(kept.length - 2, 1);
  return line();
}

/** Pure rows for a box of `size`: a frame, a title line (vault / folder / note), the body, a key hint at the bottom. */
export function renderObsidian(props: ObsidianProps, size: { readonly w: number; readonly h: number }, focused: boolean): string[] {
  const editing = editorViewOf(props.editor);
  if (editing) return renderNoteEditor(editing, size, focused, props.vaultName);
  const { w, h } = size;
  if (w < 4 || h < 3) return Array.from({ length: h }, () => fitAnsi('Obsidian', w));
  const inner = w - 2;
  const bodyH = h - 2;
  const where = props.note ?? (props.dir || '/');
  const title = ` 📓 ${props.vaultName ?? 'Obsidian'} · ${where} `;
  const edge = focused ? CYAN : DIM;
  const top = `${edge}┌${RESET}${fitAnsi(`${BOLD}${title}${RESET}`, Math.min(inner, Bun.stringWidth(title)))}${edge}${'─'.repeat(Math.max(0, inner - Math.min(inner, Bun.stringWidth(title))))}┐${RESET}`;
  let body: string[];
  let hint: string;
  if (props.search !== undefined && !(props.error && !props.entries?.length)) {
    ({ body, hint } = renderSearch({ ...props, search: props.search }, inner, bodyH, focused));
  } else if (props.error && !props.entries?.length && !props.text) {
    body = wrapToWidth(props.error, inner);
    hint = 'Esc close';
  } else if (props.note && props.text === undefined && !props.error) {
    body = [`${DIM}Loading ${props.note}…${RESET}`];                 // the server is reading it (the next push fills it)
    hint = 'Esc close';
  } else if (props.note && props.text !== undefined) {
    const rows = markdownRows(props.text, inner);
    const scroll = Math.min(props.scroll, Math.max(0, rows.length - bodyH));
    body = rows.slice(scroll, scroll + bodyH);
    hint = keyHint(['j/k scroll', '⌫ back', 'e edit', 'a attach', 'space page', 'Esc close'], `${Math.min(rows.length, scroll + bodyH)}/${rows.length}`, inner - 2);
  } else {
    const entries = props.entries ?? [];
    const cursor = Math.min(props.cursor, Math.max(0, entries.length - 1));
    const start = entries.length <= bodyH ? 0 : Math.max(0, Math.min(cursor - Math.floor(bodyH / 2), entries.length - bodyH));
    body = entries.length === 0 ? [`${DIM}(empty folder)${RESET}`] : entries.slice(start, start + bodyH).map((entry, at) => {
      const text = `${entry.dir ? '▸ ' : '  '}${entry.dir ? entry.name : entry.name.replace(/\.md$/i, '')}${entry.dir ? '/' : ''}`;
      return start + at === cursor ? `\u001b[7m${fitAnsi(text, inner)}${RESET}` : text;
    });
    hint = keyHint(['j/k move', 'Enter open', 'n new', 'a attach', '⌫ up', '^b r move', 'Esc close'], `${entries.length ? cursor + 1 : 0}/${entries.length}`, inner - 2);
  }
  if (props.create) hint = newNoteRow(props.create, inner - 2);
  else if (props.notice) hint = `${props.notice} · ${hint}`;
  const rows = [top];
  for (let at = 0; at < bodyH; at++) rows.push(`${edge}│${RESET}${fitAnsi(body[at] ?? '', inner)}${edge}│${RESET}`);
  rows.push(`${edge}└${RESET}${fitAnsi(`${DIM} ${hint} ${RESET}`, Math.min(inner, Bun.stringWidth(hint) + 2))}${edge}${'─'.repeat(Math.max(0, inner - Math.min(inner, Bun.stringWidth(hint) + 2)))}┘${RESET}`);
  return rows;
}

const parentOf = (rel: string): string => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

/** Pure key reducer over navigation props: the new props (to hydrate again), 'pass' for keys it does not use. `page` = body rows. */
export function obsidianKey(props: ObsidianProps, bytes: string, page = 10): ObsidianProps | 'pass' | 'consumed' {
  const editing = editorViewOf(props.editor);
  if (editing) { const op = editorKey(editing, bytes); return op ? { dir: props.dir, cursor: props.cursor, scroll: props.scroll, ...(props.note ? { note: props.note } : {}), editOp: op } : 'pass'; }
  if (bytes === 'e' && props.note && props.text !== undefined && !props.create && props.search === undefined) return { dir: props.dir, cursor: props.cursor, scroll: props.scroll, note: props.note, editOp: { kind: 'open', rel: props.note } };
  // The new-note row first when it is open; in the search line `n` is a letter, not «new note».
  if (props.create || props.search === undefined) {
    const made = newNoteKey(props, bytes);
    if (made !== undefined) return made;
  }
  const attaching = props.create || props.search !== undefined ? undefined : attachKey(props, bytes);
  if (attaching !== undefined) return attaching;
  const nav = { dir: props.dir, cursor: props.cursor, scroll: props.scroll, ...(props.note ? { note: props.note } : {}) };
  // ELS-OBSIDIAN-SEARCH: `/` opens the filter line; in it every key is the search's (Esc leaves, Enter opens the hit).
  // `search: undefined` is explicit so the client's optimistic merge drops the old line at once.
  if (props.search !== undefined) {
    const next = searchKey({ search: props.search, searchAt: props.searchAt, hits: props.hits }, bytes);
    if (next === 'consumed') return 'consumed';
    if (next === 'leave') return { ...nav, search: undefined } as ObsidianProps;
    if ('open' in next) return { dir: searchFolderOf(next.open), cursor: 0, scroll: 0, note: next.open, search: undefined } as ObsidianProps;
    return { ...nav, ...next };
  }
  if (bytes === '/') return { ...nav, search: '', searchAt: 0 };
  const down = bytes === 'j' || bytes === '\u001b[B' || bytes === '\u001bOB';
  const up = bytes === 'k' || bytes === '\u001b[A' || bytes === '\u001bOA';
  const pageDown = bytes === ' ' || bytes === '\u001b[6~';
  const pageUp = bytes === 'b' || bytes === '\u001b[5~';
  const back = bytes === '\u007f' || bytes === '\b' || bytes === 'h' || bytes === '\u001b[D';
  if (props.note) {
    if (down) return { ...nav, scroll: props.scroll + 1 };
    if (up) return { ...nav, scroll: Math.max(0, props.scroll - 1) };
    if (pageDown) return { ...nav, scroll: props.scroll + page };
    if (pageUp) return { ...nav, scroll: Math.max(0, props.scroll - page) };
    if (back) return { dir: props.dir, cursor: props.cursor, scroll: 0 };
    return 'pass';
  }
  const entries = props.entries ?? [];
  const last = Math.max(0, entries.length - 1);
  if (down) return { ...nav, cursor: Math.min(last, props.cursor + 1) };
  if (up) return { ...nav, cursor: Math.max(0, props.cursor - 1) };
  if (pageDown) return { ...nav, cursor: Math.min(last, props.cursor + page) };
  if (pageUp) return { ...nav, cursor: Math.max(0, props.cursor - page) };
  if (bytes === 'g' || bytes === '\u001b[H') return { ...nav, cursor: 0 };
  if (bytes === 'G' || bytes === '\u001b[F') return { ...nav, cursor: last };
  if (back) return props.dir ? { dir: parentOf(props.dir), cursor: 0, scroll: 0 } : 'pass';
  if (bytes === '\r' || bytes === '\n' || bytes === 'l' || bytes === '\u001b[C') {
    const entry = entries[Math.min(props.cursor, last)];
    if (!entry) return 'pass';
    const path = props.dir ? `${props.dir}/${entry.name}` : entry.name;
    return entry.dir ? { dir: path, cursor: 0, scroll: 0 } : { dir: props.dir, cursor: props.cursor, scroll: 0, note: path };
  }
  return 'pass';
}
