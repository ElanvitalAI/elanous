// ELS-FILES (대표 11-26 18:5x «classic 파일 브라우저를 els z축 요소로») — the file browser element, read-only. Two parts:
//   · hydrate (server side, fs): one folder listing (folders first, hidden files only when asked, a name filter) and a
//     preview of the selected entry — text (markdown through our classic renderer), a hex notice for binaries, a placeholder
//     for images, a child list for folders. Everything is bounded (entries, preview bytes); a name that looks like a
//     credential is never previewed (and so never lands in the overlay state file).
//   · render / key (pure): list + preview side by side when the box is wide enough, list alone when it is narrow.
// The same code runs as a popup layer (els overlay, ctrl+b f) and as a tab (`els files`, widget «files»).
// Ideas copied from classic (8/31 export, ~/elanous-hq/ref/elanous-classic-20260831): panes/files-pane.ts (folders first,
// dotfile toggle), modals/pane-multi.ts browser+preview split, preview/* (text · binary · image kinds), widgets/list cursor
// window. src/dashboard is NOT imported (retired) — a fresh, pure re-write.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { fitAnsi } from '../attach-view.js';
import { renderMarkdownRows, truncateCells, visibleWidth } from './markdown-render.js';

export interface FileEntry { readonly name: string; readonly dir: boolean }
export type PreviewKind = 'text' | 'markdown' | 'binary' | 'image' | 'dir' | 'empty' | 'secret' | 'error';
export interface FilePreview {
  readonly name: string;
  readonly kind: PreviewKind;
  /** Text (text · markdown), a hex dump (binary), child names one per line (dir), or why there is none (error). */
  readonly text?: string;
  /** File size in bytes (files only). */
  readonly size?: number;
  readonly truncated?: boolean;
}
export interface FilesProps {
  /** ELS-FILES-SSH: the host browsed ('' = this machine) — one of the switcher's hosts (ssh config aliases ⊕ els hosts). */
  readonly host: string;
  /** Absolute folder shown ('' on a remote host = its home, until the first listing resolves it). */
  readonly dir: string;
  readonly cursor: number;
  /** Show dotfiles. */
  readonly hidden: boolean;
  /** Case-insensitive name filter ('' = none). */
  readonly filter: string;
  /** The `/` filter line is taking typed keys. */
  readonly filtering: boolean;
  /** Preview scroll offset (rows). */
  readonly scroll: number;
  /** Filled by hydrate (server): the listing after hidden/filter, how many names the folder has, the preview, or an error. */
  readonly entries?: readonly FileEntry[];
  readonly total?: number;
  readonly preview?: FilePreview;
  readonly error?: string;
  /** Server-filled: the host switcher ('' first = local) and whether a remote read is in flight. */
  readonly hosts?: readonly string[];
  readonly loading?: boolean;
}

/** What a key asks the attach app to do beyond a props update: open the selected file somewhere else. */
export interface FilesOpen {
  /** attach = hand the path to an eln pane's input (typed, never sent — the person presses Enter). */
  readonly how: 'tab' | 'tile' | 'sidechat' | 'attach';
  /** pager (read) or editor (the person's own $EDITOR — only on an explicit `e`). */
  readonly tool: 'pager' | 'editor';
  readonly path: string;
  /** ELS-FILES-SSH: the host the path lives on ('' / absent = this machine). */
  readonly host?: string;
  readonly title: string;
  /** sidechat: the preview text handed over as context (already bounded). */
  readonly context?: string;
}

// 출처: #40244 ELS-ELN-LAYERS §2-4 — els stays light: one folder listing is bounded (the rest is counted, not listed).
export const MAX_FILE_ENTRIES = 2_000;
// 출처: #40244 ELS-ELN-LAYERS §2-4 — one preview read is bounded (64 KiB), the rest is cut with a marker.
export const MAX_PREVIEW_BYTES = 65_536;
// 출처: classic preview/binary sniff — a NUL in the first 8 KiB means binary.
const SNIFF_BYTES = 8_192;
// 출처: classic hex preview — 16 bytes a row, 16 rows.
const HEX_BYTES = 256;
// 출처: ELS-SIDECHAT SIDECHAT_MAX_INPUT 2000 — the handed-over context leaves room for a question.
export const SIDECHAT_CONTEXT_CHARS = 1_500;
const MAX_FILTER = 128;
const MAX_PATH = 4_096;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.heic', '.svg']);
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
// Never previewed: private keys, env files, token stores, password files. The person can still open one in a pager tab.
const SECRET_NAME = /^(?:id_[a-z0-9_]+(?!\.pub)|.*\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|gpg|asc)|\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|credentials(?:\..*)?|auth\.json|.*(?:secret|token|passw).*)$/i;
const SECRET_DIR = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|Keychains)(?:\/|$)|(?:^|\/)\.config\/(?:gh|gcloud)(?:\/|$)/;

export const looksSecret = (path: string): boolean => SECRET_NAME.test(basename(path)) || SECRET_DIR.test(path);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nat = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '');

/** An absolute, normalized folder path from untrusted input (undefined = refuse). */
export function cleanDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH || value.includes('\0') || !isAbsolute(value)) return undefined;
  const norm = normalize(value);
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

/** Navigation props from untrusted input — data fields are never taken from a caller (hydrate fills them). A missing dir is
 *  the home folder (the attach app sends the focused pane's cwd). */
export function filesProps(raw: unknown): FilesProps | undefined {
  const value = isRecord(raw) ? raw : {};
  const host = value.host === undefined || value.host === '' ? '' : typeof value.host === 'string' && HOST_NAME.test(value.host) ? value.host : undefined;
  if (host === undefined) return undefined;
  const dir = value.dir === undefined || (host && value.dir === '') ? (host ? '' : homedir()) : cleanDir(value.dir);
  if (dir === undefined) return undefined;
  const filter = typeof value.filter === 'string' ? clean(value.filter).slice(0, MAX_FILTER) : '';
  return { host, dir, cursor: nat(value.cursor), hidden: value.hidden === true, filter, filtering: value.filtering === true, scroll: nat(value.scroll),
    ...(value.refresh === true && host ? { refresh: true } : {}) } as FilesProps;
}

const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const navOf = (props: FilesProps): FilesProps => ({ host: props.host ?? '', dir: props.dir, cursor: props.cursor, hidden: props.hidden, filter: props.filter, filtering: props.filtering, scroll: props.scroll });

/** The folder's entries: folders first, then names (locale order); dotfiles only when `hidden`; `filter` = substring. */
export function listFolder(dir: string, hidden: boolean, filter: string): { entries: FileEntry[]; total: number } {
  const needle = filter.toLowerCase();
  const all = readdirSync(dir, { withFileTypes: true });
  const kept: FileEntry[] = [];
  for (const one of all) {
    if (!hidden && one.name.startsWith('.')) continue;
    if (needle && !one.name.toLowerCase().includes(needle)) continue;
    let isDir = one.isDirectory();
    if (one.isSymbolicLink()) { try { isDir = statSync(join(dir, one.name)).isDirectory(); } catch { isDir = false; } }
    kept.push({ name: one.name, dir: isDir });
  }
  kept.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { entries: kept.slice(0, MAX_FILE_ENTRIES), total: kept.length };
}

/** A hex dump: offset · 16 bytes · printable ASCII. */
export function hexDump(bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const chunk = bytes.subarray(at, at + 16);
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
    rows.push(`${at.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join('\n');
}

/** Is this byte buffer text? No NUL in the sniff window and it decodes as UTF-8 (a cut last character is allowed). */
export function isTextBytes(bytes: Uint8Array): boolean {
  const sniff = bytes.subarray(0, SNIFF_BYTES);
  if (sniff.includes(0)) return false;
  // stream:true lets a multi-byte character cut by the read window stay pending instead of failing the whole sniff.
  try { new TextDecoder('utf-8', { fatal: true }).decode(sniff, { stream: true }); return true; } catch { return false; }
}

/** Preview of one bounded byte read (shared by the local and remote sources). */
export function previewOfBytes(name: string, path: string, bytes: Uint8Array, size: number): FilePreview {
  if (looksSecret(path)) return { name, kind: 'secret', size };
  if (IMAGE_EXT.has(extname(name).toLowerCase())) return { name, kind: 'image', size };
  if (size === 0) return { name, kind: 'empty', size };
  const truncated = size > bytes.length;
  if (!isTextBytes(bytes)) return { name, kind: 'binary', size, text: hexDump(bytes.subarray(0, HEX_BYTES)) };
  const text = new TextDecoder('utf-8').decode(bytes);
  return { name, kind: MARKDOWN_EXT.has(extname(name).toLowerCase()) ? 'markdown' : 'text', size, text, ...(truncated ? { truncated: true } : {}) };
}

function readHead(path: string, cap: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buffer = new Uint8Array(cap);
    let got = 0;
    while (got < cap) { const n = readSync(fd, buffer, got, cap - got, got); if (n <= 0) break; got += n; }
    return buffer.subarray(0, got);
  } finally { closeSync(fd); }
}

const errorText = (error: unknown): string => {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'ENOENT' ? 'not found' : code === 'ENOTDIR' ? 'not a folder' : 'cannot read';
};

/** Preview of one local entry. */
export function previewLocal(dir: string, entry: FileEntry, hidden: boolean): FilePreview {
  const path = join(dir, entry.name);
  if (entry.dir) {
    try {
      const { entries, total } = listFolder(path, hidden, '');
      return { name: entry.name, kind: 'dir', text: entries.slice(0, 200).map((one) => `${one.dir ? '▸ ' : '  '}${one.name}${one.dir ? '/' : ''}`).join('\n') + (total > 200 ? `\n… ${total - 200} more` : '') };
    } catch (error) { return { name: entry.name, kind: 'error', text: errorText(error) }; }
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { name: entry.name, kind: 'error', text: 'not a regular file' };
    if (looksSecret(path)) return { name: entry.name, kind: 'secret', size: stat.size };
    if (IMAGE_EXT.has(extname(entry.name).toLowerCase())) return { name: entry.name, kind: 'image', size: stat.size };
    return previewOfBytes(entry.name, path, readHead(path, Math.min(stat.size, MAX_PREVIEW_BYTES)), stat.size);
  } catch (error) { return { name: entry.name, kind: 'error', text: errorText(error) }; }
}

/** The remote reads a hydrate needs (src/els/files-remote.ts RemoteFiles, structurally). */
export interface FilesRemote {
  readonly hosts: () => readonly string[];
  readonly listing: (host: string, dir: string, hidden: boolean) => { readonly state: 'ok'; readonly dir: string; readonly entries: readonly FileEntry[]; readonly total: number } | { readonly state: 'loading' } | { readonly state: 'error'; readonly text: string };
  readonly preview: (host: string, dir: string, entry: FileEntry) => FilePreview | undefined;
  readonly refresh?: (host: string) => void;
}

const filterNames = (entries: readonly FileEntry[], filter: string): FileEntry[] => { const needle = filter.toLowerCase(); return needle ? entries.filter((one) => one.name.toLowerCase().includes(needle)) : [...entries]; };

/** Server side: fill the listing and the selected entry's preview for these navigation props. A remote host is read through
 *  `remote` (cached; 'loading' until its one ssh call lands, then the server re-hydrates). */
export function hydrateFiles(nav: FilesProps, remote?: FilesRemote): FilesProps {
  const base = navOf(nav);
  const hosts = remote ? ['', ...remote.hosts()] : undefined;
  if (base.host && (nav as { refresh?: boolean }).refresh) remote?.refresh?.(base.host);         // R: forget this host's reads
  if (base.host) {
    if (!remote) return { ...base, entries: [], total: 0, error: 'remote browsing runs only in an els server' };
    const listed = remote.listing(base.host, base.dir, base.hidden);
    if (listed.state === 'loading') return { ...base, ...(hosts ? { hosts } : {}), entries: [], total: 0, loading: true };
    if (listed.state === 'error') return { ...base, ...(hosts ? { hosts } : {}), cursor: 0, entries: [], total: 0, error: listed.text };
    const entries = filterNames(listed.entries, base.filter);
    const cursor = Math.min(base.cursor, Math.max(0, entries.length - 1));
    const selected = entries[cursor];
    const preview = selected ? remote.preview(base.host, listed.dir, selected) : undefined;
    return { ...base, dir: listed.dir, cursor, entries, total: base.filter ? entries.length : listed.total, ...(hosts ? { hosts } : {}),
      ...(preview ? { preview } : selected ? { loading: true } : {}) };
  }
  return hosts ? { ...hydrateLocal(base), hosts } : hydrateLocal(base);
}

function hydrateLocal(nav: FilesProps): FilesProps {
  const base = navOf(nav);
  let listed: { entries: FileEntry[]; total: number };
  try { listed = listFolder(nav.dir, nav.hidden, nav.filter); }
  catch (error) { return { ...base, cursor: 0, entries: [], total: 0, error: `${nav.dir}: ${errorText(error)}` }; }
  const cursor = Math.min(nav.cursor, Math.max(0, listed.entries.length - 1));
  const selected = listed.entries[cursor];
  return { ...base, cursor, entries: listed.entries, total: listed.total, ...(selected ? { preview: previewLocal(nav.dir, selected, nav.hidden) } : {}) };
}

// ---- render -----------------------------------------------------------------------------------------------------------

const R = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const CYAN = '\u001b[36m';
const BLUE = '\u001b[34m';
const YELLOW = '\u001b[33m';
// 출처: ELS-FILES — below this many inner cells the preview column would be too thin to read: list alone.
export const SPLIT_MIN_INNER = 60;

export const humanSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1_073_741_824 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${(bytes / 1_073_741_824).toFixed(1)} GiB`;

const homeShort = (path: string): string => { const home = homedir(); return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path; };

/** The preview rows for `width` cells (markdown rendered, text wrapped by cells, binary as hex). */
export function previewRows(preview: FilePreview | undefined, width: number): string[] {
  if (!preview || width < 1) return [];
  const head = `${BOLD}${truncateCells(clean(preview.name), Math.max(1, width - 12))}${R}${preview.size !== undefined ? ` ${DIM}${humanSize(preview.size)}${R}` : ''}`;
  let body: string[];
  switch (preview.kind) {
    case 'markdown': body = renderMarkdownRows(preview.text ?? '', width); break;
    case 'text': body = (preview.text ?? '').replace(/\r/g, '').split('\n').flatMap((line) => wrapCells(line.replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f]/g, '·'), width)); break;
    case 'binary': body = [`${YELLOW}binary file — hex of the first bytes${R}`, '', ...(preview.text ?? '').split('\n').map((line) => truncateCells(line, width))]; break;
    case 'image': body = [`${YELLOW}🖼  image${R} — no inline preview here`, `${DIM}Enter opens it in a tab ($PAGER)${R}`]; break;
    case 'dir': body = (preview.text ?? '').split('\n').map((line) => truncateCells(clean(line), width)); break;
    case 'empty': body = [`${DIM}(empty file)${R}`]; break;
    case 'secret': body = [`${YELLOW}🔒 preview hidden${R} — the name looks like a credential`]; break;
    default: body = [`${YELLOW}${preview.text ?? 'cannot read'}${R}`];
  }
  if (preview.truncated) body.push(`${DIM}… (first ${humanSize(MAX_PREVIEW_BYTES)} shown)${R}`);
  return [head, '', ...body];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Hard wrap by display cells (code and logs keep their spacing; a wide glyph never straddles the edge). */
export function wrapCells(line: string, width: number): string[] {
  if (!line) return [''];
  const out: string[] = [];
  let cur = '';
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const w = Bun.stringWidth(segment);
    if (used + w > width) { out.push(cur); cur = ''; used = 0; }
    cur += segment; used += w;
  }
  out.push(cur);
  return out;
}

const entryLabel = (entry: FileEntry): string => `${entry.dir ? `${BLUE}▸ ` : '  '}${clean(entry.name)}${entry.dir ? `/${R}` : ''}`;

/** Pure rows for a box of `size`: frame + path title, (filter line), list │ preview, key hint at the bottom. */
export function renderFiles(props: FilesProps, size: { readonly w: number; readonly h: number }, focused: boolean, title = '📁'): string[] {
  const { w, h } = size;
  if (w < 4 || h < 3) return Array.from({ length: h }, () => fitAnsi('Files', w));
  const inner = w - 2;
  const edge = focused ? CYAN : DIM;
  const where = props.host ? `${props.host}:${props.dir || '~'}` : homeShort(props.dir);
  const head = ` ${title} ${where}${props.hidden ? ' · hidden shown' : ''}${props.loading ? ' · ⏳' : ''} `;
  const headCut = truncateCells(head, inner);
  const top = `${edge}┌${R}${BOLD}${headCut}${R}${edge}${'─'.repeat(Math.max(0, inner - visibleWidth(headCut)))}┐${R}`;
  const entries = props.entries ?? [];
  const showFilter = props.filtering || props.filter !== '';
  const showHosts = (props.hosts?.length ?? 0) > 1;
  const bodyH = Math.max(0, h - 2 - (showFilter ? 1 : 0) - (showHosts ? 1 : 0));
  const split = inner >= SPLIT_MIN_INNER;
  const listW = split ? Math.max(20, Math.min(48, Math.floor(inner * 0.4))) : inner;
  const prevW = split ? inner - listW - 1 : 0;
  const cursor = Math.min(props.cursor, Math.max(0, entries.length - 1));
  const start = entries.length <= bodyH ? 0 : Math.max(0, Math.min(cursor - Math.floor(bodyH / 2), entries.length - bodyH));
  let list: string[];
  if (props.error) list = wrapCells(clean(props.error), listW).map((line) => `${YELLOW}${line}${R}`);
  else if (props.loading && !entries.length) list = [`${DIM}⏳ reading ${props.host || 'folder'}…${R}`];
  else if (!entries.length) list = [`${DIM}${props.filter ? '(no match)' : '(empty folder)'}${R}`];
  else list = entries.slice(start, start + bodyH).map((entry, at) => start + at === cursor ? `\u001b[7m${fitAnsi(entryLabel(entry).replace(/\u001b\[0m/g, ''), listW)}${R}` : entryLabel(entry));
  const preview = split ? (props.preview ? previewRows(props.preview, Math.max(1, prevW - 1)) : props.loading && entries.length ? [`${DIM}⏳ reading…${R}`] : []) : [];
  const scroll = Math.min(props.scroll, Math.max(0, preview.length - bodyH));
  const shownPreview = preview.slice(scroll, scroll + bodyH);
  const rows = [top];
  if (showHosts) {
    // Many hosts on a narrow box: drop tabs from the left until the current one fits (it is never scrolled out of view).
    const all = props.hosts!;
    const current = Math.max(0, all.indexOf(props.host ?? ''));
    let first = 0;
    const widthFrom = (from: number): number => all.slice(from, current + 1).reduce((sum, name) => sum + Bun.stringWidth(name || 'local') + 3, 5 + (from > 0 ? 2 : 0));
    while (first < current && widthFrom(first) > inner) first++;
    const tabs = all.slice(first).map((name) => { const label = ` ${name || 'local'} `; return name === props.host ? `\u001b[7m${label}\u001b[27m` : label; }).join(`${DIM}│${R}`);
    rows.push(`${edge}│${R}${fitAnsi(`${DIM}host${R} ${first > 0 ? '‹ ' : ''}${tabs}`, inner)}${edge}│${R}`);
  }
  if (showFilter) rows.push(`${edge}│${R}${fitAnsi(` ${CYAN}/${R} ${clean(props.filter)}${props.filtering && focused ? '\u001b[7m \u001b[27m' : ''}`, inner)}${edge}│${R}`);
  for (let at = 0; at < bodyH; at++) {
    const left = fitAnsi(list[at] ?? '', listW);
    const line = split ? `${left}${DIM}│${R}${fitAnsi(` ${shownPreview[at] ?? ''}`, prevW)}` : left;
    rows.push(`${edge}│${R}${line}${edge}│${R}`);
  }
  const count = entries.length ? `${cursor + 1}/${props.total ?? entries.length}${(props.total ?? 0) > entries.length ? ` (first ${entries.length})` : ''}` : '0';
  const hint = props.filtering ? `type to filter · Enter done · ⌫ erase · ${count}`
    : `${count} · j/k · Enter open · ⌫ up · . hidden · / filter · t tile · e edit · a → eln · s sidechat · J/K scroll${showHosts ? ' · [ ] host · R reload' : ''} · Esc close`;   // the count first: never cut
  const hintCut = truncateCells(` ${hint} `, inner);
  rows.push(`${edge}└${R}${DIM}${hintCut}${R}${edge}${'─'.repeat(Math.max(0, inner - visibleWidth(hintCut)))}┘${R}`);
  return rows;
}

// ---- keys -------------------------------------------------------------------------------------------------------------

const DOWN = new Set(['j', '\u001b[B', '\u001bOB']);
const UP = new Set(['k', '\u001b[A', '\u001bOA']);
const BACK = new Set(['\u007f', '\b', 'h', '\u001b[D', '\u001bOD']);
const ENTER = new Set(['\r', '\n', 'l', '\u001b[C', '\u001bOC']);

/** Pure key reducer over navigation props: new props (to hydrate again), an open request, or 'pass'. `page` = body rows. */
export function filesKey(props: FilesProps, bytes: string, page = 10): FilesProps | { readonly open: FilesOpen } | 'pass' {
  const nav = navOf(props);
  if (props.filtering) {
    if (bytes === '\r' || bytes === '\n') return { ...nav, filtering: false };
    if (bytes === '\u007f' || bytes === '\b') return props.filter ? { ...nav, filter: Array.from(props.filter).slice(0, -1).join(''), cursor: 0 } : { ...nav, filtering: false };
    if (bytes === '\u0015') return { ...nav, filter: '', cursor: 0 };
    if (bytes === '\u001b') return { ...nav, filtering: false };                // Esc leaves the filter line (a second Esc closes)
    if (bytes.startsWith('\u001b') || /^[\u0000-\u001f\u007f]+$/.test(bytes)) return nav;
    const text = clean(bytes);
    return text ? { ...nav, filter: (props.filter + text).slice(0, MAX_FILTER), cursor: 0 } : nav;
  }
  const hosts = props.hosts ?? [];
  if ((bytes === '[' || bytes === ']') && hosts.length > 1) {
    const at = Math.max(0, hosts.indexOf(props.host ?? ''));
    const next = hosts[(at + (bytes === ']' ? 1 : hosts.length - 1)) % hosts.length]!;
    return { ...nav, host: next, dir: next ? '' : homedir(), cursor: 0, scroll: 0, filter: '' };
  }
  if (bytes === 'R' && props.host) return { ...nav, refresh: true } as FilesProps;
  const entries = props.entries ?? [];
  const last = Math.max(0, entries.length - 1);
  const cursor = Math.min(props.cursor, last);
  const entry = entries[cursor];
  const path = entry ? join(props.dir, entry.name) : undefined;
  const on = props.host ? { host: props.host } : {};
  const shown = props.host ? `${props.host}:${path}` : path;
  if (DOWN.has(bytes)) return { ...nav, cursor: Math.min(last, cursor + 1), scroll: 0 };
  if (UP.has(bytes)) return { ...nav, cursor: Math.max(0, cursor - 1), scroll: 0 };
  if (bytes === '\u001b[6~' || bytes === '\u0006') return { ...nav, cursor: Math.min(last, cursor + page), scroll: 0 };
  if (bytes === '\u001b[5~' || bytes === '\u0002') return { ...nav, cursor: Math.max(0, cursor - page), scroll: 0 };
  if (bytes === 'g' || bytes === '\u001b[H') return { ...nav, cursor: 0, scroll: 0 };
  if (bytes === 'G' || bytes === '\u001b[F') return { ...nav, cursor: last, scroll: 0 };
  if (bytes === 'J') return { ...nav, scroll: props.scroll + 1 };
  if (bytes === 'K') return { ...nav, scroll: Math.max(0, props.scroll - 1) };
  if (bytes === ' ') return { ...nav, scroll: props.scroll + page };
  if (bytes === 'b') return { ...nav, scroll: Math.max(0, props.scroll - page) };
  if (bytes === '.') return { ...nav, hidden: !props.hidden, cursor: 0, scroll: 0 };
  if (bytes === '/') return { ...nav, filtering: true };
  if (BACK.has(bytes)) {
    if (props.filter) return { ...nav, filter: '', cursor: 0, scroll: 0 };
    if (!props.dir) return 'pass';                                          // a remote home not resolved yet
    const up = dirname(props.dir);
    return up === props.dir ? 'pass' : { ...nav, dir: up, cursor: 0, scroll: 0, filter: '' };
  }
  if (!entry || !path) return ENTER.has(bytes) || bytes === 't' || bytes === 'e' || bytes === 's' || bytes === 'a' ? nav : 'pass';
  if (ENTER.has(bytes) && entry.dir) return { ...nav, dir: path, cursor: 0, scroll: 0, filter: '' };
  if (entry.dir) {
    if (bytes === 'a') return { open: { how: 'attach', tool: 'pager', path, ...on, title: `📁 ${clean(entry.name)}`.slice(0, 64) } };
    return bytes === 't' || bytes === 'e' || bytes === 's' ? nav : 'pass';
  }
  const title = `📄 ${clean(entry.name)}`.slice(0, 64);
  if (bytes === '\r' || bytes === '\n') return { open: { how: 'tab', tool: 'pager', path, ...on, title } };
  if (bytes === 't') return { open: { how: 'tile', tool: 'pager', path, ...on, title } };
  if (bytes === 'e') return { open: { how: 'tab', tool: 'editor', path, ...on, title } };
  if (bytes === 'a') return { open: { how: 'attach', tool: 'pager', path, ...on, title } };
  if (bytes === 's') {
    const preview = props.preview;
    const text = preview && preview.name === entry.name && (preview.kind === 'text' || preview.kind === 'markdown') ? (preview.text ?? '') : '';
    return { open: { how: 'sidechat', tool: 'pager', path, ...on, title, context: `[file ${shown}] ${text.replace(/\s+/g, ' ').trim()}`.slice(0, SIDECHAT_CONTEXT_CHARS) } };
  }
  return 'pass';
}

/** POSIX single-quoting for a remote path. */
export const shQuotePath = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** Split a $PAGER / $EDITOR value into argv (plain whitespace words — no shell is involved). */
const words = (value: string | undefined): string[] => (value ?? '').trim().split(/\s+/).filter(Boolean);

/** The argv a tab runs to show (or edit) `path`: the person's $PAGER (default `less -R`) or $EDITOR (default `vi`). No shell:
 *  the path is one argv entry, so a file name can never become a command. */
export function openCommand(open: Pick<FilesOpen, 'tool' | 'path' | 'host'>, env: Readonly<Record<string, string | undefined>>): string[] {
  // ELS-FILES-SSH: a remote file opens in `ssh -t host` with the remote less (or vi): the remote shell gets ONE command
  // string whose only variable part is the path, single-quoted for POSIX sh. The person's own ssh, as in their terminal.
  if (open.host) return ['ssh', '-t', '--', open.host, `${open.tool === 'editor' ? 'vi' : 'less -R'} ${shQuotePath(open.path)}`];
  const tool = open.tool === 'editor' ? words(env.VISUAL || env.EDITOR) : words(env.PAGER);
  const argv = tool.length ? tool : open.tool === 'editor' ? ['vi'] : ['less', '-R'];
  return [...argv, open.path];                                   // the path is absolute: it can never read as an option
}
