// ELS-OBSIDIAN-SEARCH (대표 11-26 B5) — search inside the Obsidian viewer (popup and tab): `/` opens a filter line, typing
// filters note names across the vault and finds text hits. Two parts, like obsidian-view.ts:
//   · searchVault (server side, fs, read-only): a bounded walk from the vault root — no index, no daemon, computed on demand
//     for each query and capped (files scanned, folder depth, bytes per file, total bytes, wall time). Dot folders are
//     skipped, symlinked folders are never entered, a symlinked note is read only when its real path is inside the vault.
//     Snippets go through the shared secret redaction (src/debug/secret-redaction.ts).
//   · renderSearch / searchKey (pure): the filter line and the result list (name matches first, then text hits with a
//     snippet), ↑/↓ to move, Enter to open, Esc to leave search.

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { redactSecretText } from '../../debug/secret-redaction.js';
import { fitAnsi } from '../attach-view.js';

export interface ObsidianHit {
  /** Note path relative to the vault root. */
  readonly path: string;
  readonly kind: 'name' | 'text';
  /** Text hits: the matching line, trimmed and redacted. */
  readonly snippet?: string;
}

// 출처: 대표 11-26 B5 «keep els light» — one query never walks more than this many entries (folders and files).
export const SEARCH_MAX_FILES = 5_000;
// 출처: 대표 11-26 B5 — a vault deeper than this is not walked further (a symlink loop cannot reach here: links are not entered).
export const SEARCH_MAX_DEPTH = 12;
// 출처: 대표 11-26 B5 — text search reads at most the head of each note.
export const SEARCH_MAX_FILE_BYTES = 65_536;
// 출처: 대표 11-26 B5 — and at most this much text per query in total (the server is one thread: a keystroke stays short).
export const SEARCH_MAX_TOTAL_BYTES = 4_194_304;
// 출처: 대표 11-26 B5 — a query stops after this many ms of wall time (each keystroke re-runs it).
export const SEARCH_MAX_MS = 150;
// 출처: 대표 11-26 B5 — one typed letter matches nearly every note's text: text hits start at two letters (names at one).
export const SEARCH_MIN_TEXT = 2;
// 출처: 대표 11-26 B5 — the result list is a screenful or a few, never the whole vault.
export const SEARCH_MAX_HITS = 200;
export const SEARCH_MAX_QUERY = 128;
const SNIPPET_CELLS = 160;

export interface SearchCaps { readonly files: number; readonly depth: number; readonly fileBytes: number; readonly totalBytes: number; readonly ms: number; readonly hits: number }
export const SEARCH_CAPS: SearchCaps = { files: SEARCH_MAX_FILES, depth: SEARCH_MAX_DEPTH, fileBytes: SEARCH_MAX_FILE_BYTES, totalBytes: SEARCH_MAX_TOTAL_BYTES, ms: SEARCH_MAX_MS, hits: SEARCH_MAX_HITS };

/** A query from untrusted props: a short line of printable text (undefined = refuse). */
export function cleanQuery(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > SEARCH_MAX_QUERY || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

const inside = (root: string, abs: string): boolean => {
  try {
    const rel = relative(root, realpathSync(abs));
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
  } catch { return false; }
};

/** Server side: name matches (case-insensitive, the note name without .md) first, then text hits with a snippet line.
 *  `root` must already be the vault's realpath. Never throws; `capped` says a bound cut the walk short. */
export function searchVault(root: string, query: string, caps: SearchCaps = SEARCH_CAPS, now: () => number = Date.now): { hits: ObsidianHit[]; capped: boolean } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], capped: false };
  const started = now();
  const names: ObsidianHit[] = [];
  const texts: ObsidianHit[] = [];
  let seen = 0;
  let bytes = 0;
  let capped = false;
  const over = (): boolean => {
    if (seen >= caps.files || bytes >= caps.totalBytes || now() - started > caps.ms || names.length >= caps.hits) capped = true;
    return capped;
  };
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > caps.depth) { capped = true; return; }
    let items: Dirent[];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    const folders: string[] = [];
    for (const one of items) {
      if (over()) return;
      if (one.name.startsWith('.')) continue;
      seen++;
      const path = rel ? `${rel}/${one.name}` : one.name;
      const abs = join(dir, one.name);
      if (one.isDirectory()) { folders.push(one.name); continue; }
      let file = one.isFile();
      if (one.isSymbolicLink()) {                                  // never enter a linked folder; read a linked note only inside
        try { file = statSync(abs).isFile() && inside(root, abs); } catch { file = false; }
      }
      if (!file || !one.name.toLowerCase().endsWith('.md')) continue;
      if (one.name.slice(0, -3).toLowerCase().includes(needle)) { names.push({ path, kind: 'name' }); continue; }
      if (texts.length >= caps.hits || needle.length < SEARCH_MIN_TEXT) continue;
      let text: string;
      try {
        const buffer = readFileSync(abs);
        const head = buffer.subarray(0, Math.min(caps.fileBytes, caps.totalBytes - bytes));
        bytes += head.length;
        text = head.toString('utf8');
      } catch { continue; }
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = text.lastIndexOf('\n', at) + 1;
      const end = text.indexOf('\n', at);
      const line = text.slice(start, end < 0 ? undefined : end).replace(/\t/g, ' ').trim();
      texts.push({ path, kind: 'text', snippet: redactSecretText(line).slice(0, SNIPPET_CELLS * 2) });
    }
    for (const name of folders) { if (over()) return; walk(join(dir, name), rel ? `${rel}/${name}` : name, depth + 1); }
  };
  walk(root, '', 0);
  return { hits: [...names, ...texts].slice(0, caps.hits), capped };
}

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const REVERSE = '\u001b[7m';
const RESET = '\u001b[0m';

const noteName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '');
const folderOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** Pure body rows for search mode (`inner` cells wide, `bodyH` rows) and the hint line. */
export function renderSearch(props: { readonly search: string; readonly searchAt?: number; readonly hits?: readonly ObsidianHit[]; readonly searchCapped?: boolean },
  inner: number, bodyH: number, focused: boolean): { body: string[]; hint: string } {
  const hits = props.hits ?? [];
  const at = Math.min(props.searchAt ?? 0, Math.max(0, hits.length - 1));
  const caret = focused ? `${REVERSE} ${RESET}` : '';
  const line = `${BOLD}/${RESET} ${props.search}${caret}`;
  const room = Math.max(0, bodyH - 1);
  let list: string[];
  if (!props.search.trim()) list = [`${DIM}Type to search note names and text${RESET}`];
  else if (hits.length === 0) list = [`${DIM}${props.hits === undefined ? 'Searching…' : 'No matches'}${RESET}`];
  else {
    const start = hits.length <= room ? 0 : Math.max(0, Math.min(at - Math.floor(room / 2), hits.length - room));
    list = hits.slice(start, start + room).map((hit, index) => {
      const folder = folderOf(hit.path);
      const text = hit.kind === 'name'
        ? `  ${noteName(hit.path)}${folder ? `  ${DIM}${folder}/${RESET}` : ''}`
        : `  ${noteName(hit.path)}  ${DIM}${hit.snippet ?? ''}${RESET}`;
      return start + index === at ? `${REVERSE}${fitAnsi(text.replaceAll(DIM, '').replaceAll(RESET, ''), inner)}${RESET}` : text;
    });
  }
  const count = hits.length ? `${at + 1}/${hits.length}${props.searchCapped ? '+' : ''}` : '0';
  return { body: [line, ...list], hint: `type to filter · ↑/↓ move · Enter open · Esc leave search · ${count}` };
}

/** Pure key reducer in search mode: the next search state, an `open` of a note, `leave`, or 'consumed' (a search line keeps
 *  every key — nothing reaches the pane under it). Arrows move; printable text types; ⌫ deletes; ctrl+u clears. */
export function searchKey(props: { readonly search: string; readonly searchAt?: number; readonly hits?: readonly ObsidianHit[] }, key: string):
  { readonly search: string; readonly searchAt: number } | { readonly open: string } | 'leave' | 'consumed' {
  const at = props.searchAt ?? 0;
  const hits = props.hits ?? [];
  const last = Math.max(0, hits.length - 1);
  if (key === '\u001b') return 'leave';
  if (key === '\u001b[B' || key === '\u001bOB' || key === '\u000e') return { search: props.search, searchAt: Math.min(last, at + 1) };   // ↓ · ctrl+n
  if (key === '\u001b[A' || key === '\u001bOA' || key === '\u0010') return { search: props.search, searchAt: Math.max(0, at - 1) };     // ↑ · ctrl+p
  if (key === '\u001b[6~') return { search: props.search, searchAt: Math.min(last, at + 10) };
  if (key === '\u001b[5~') return { search: props.search, searchAt: Math.max(0, at - 10) };
  if (key === '\r' || key === '\n') { const hit = hits[Math.min(at, last)]; return hit ? { open: hit.path } : 'consumed'; }
  if (key === '\u007f' || key === '\b') return props.search ? { search: Array.from(props.search).slice(0, -1).join(''), searchAt: 0 } : 'consumed';
  if (key === '\u0015') return props.search ? { search: '', searchAt: 0 } : 'consumed';
  if (key.startsWith('\u001b') || /^[\u0000-\u001f\u007f]$/.test(key)) return 'consumed';
  const text = key.replace(/[\u0000-\u001f\u007f]/g, '');
  if (!text || props.search.length + text.length > SEARCH_MAX_QUERY) return 'consumed';
  return { search: props.search + text, searchAt: 0 };
}

export const searchFolderOf = folderOf;
