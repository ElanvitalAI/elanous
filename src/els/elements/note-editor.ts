// ELS-OBSIDIAN-EDIT (대표 11-26 20:4x «노트 편집도 만들어주세요») — edit an open note in place, in the Obsidian viewer (popup and
// tab). `e` on an open note opens the editor: arrows · Home/End (also ctrl+a/ctrl+e) · PgUp/PgDn · typing (Korean IME
// syllables arrive whole) · Enter · ⌫ · Del · ctrl+s save · Esc closes (dirty → «Discard changes? y/n»).
// The buffer lives on the SERVER side (a NoteEditorStore in the element context — the els server for the popup, the tab's
// own process for the tab); the client sends ONE ordered op per key (`editOp`), never the text, so a stale push between
// two keys cannot drop a syllable (the sidechat rule). Save goes through vault-save saveVaultEdit: existing .md inside the
// vault only, atomic, refused when the file changed on disk since open («Changed outside — reload? y/n», never clobbered),
// one-step backup under the els state folder.

import { fitAnsi } from '../attach-view.js';
import { openVaultEdit, saveVaultEdit, type NoteStat } from '../vault-save.js';

export type EditKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pgup' | 'pgdn' | 'back' | 'del' | 'enter';
export type EditOp =
  | { readonly kind: 'open'; readonly rel: string }
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'key'; readonly key: EditKey }
  | { readonly kind: 'save' } | { readonly kind: 'esc' } | { readonly kind: 'yes' } | { readonly kind: 'no' };

export type EditMode = 'edit' | 'discard' | 'conflict';
/** What the client draws (server-filled): the whole buffer (≤ 64 KiB), the caret, the window top, the state. */
export interface EditorView {
  readonly rel: string;
  readonly lines: readonly string[];
  readonly row: number;
  readonly col: number;
  readonly top: number;
  readonly dirty: boolean;
  readonly mode: EditMode;
  readonly notice?: string;
}

const KEYS: readonly EditKey[] = ['left', 'right', 'up', 'down', 'home', 'end', 'pgup', 'pgdn', 'back', 'del', 'enter'];
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const SAFE_REL = /^[^/\u0000]+(?:\/[^/\u0000]+)*$/;

/** Untrusted → one op (or undefined). Text: CR/LF kept as newlines, other control bytes dropped, bounded. */
export function editOpOf(raw: unknown): EditOp | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'open') return typeof raw.rel === 'string' && raw.rel.length <= 1024 && SAFE_REL.test(raw.rel) && !raw.rel.split('/').some((p) => p === '..' || p === '.') ? { kind: 'open', rel: raw.rel } : undefined;
  if (raw.kind === 'type') { const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, 16_384) : ''; return text ? { kind: 'type', text } : undefined; }
  if (raw.kind === 'key') return KEYS.includes(raw.key as EditKey) ? { kind: 'key', key: raw.key as EditKey } : undefined;
  return raw.kind === 'save' || raw.kind === 'esc' || raw.kind === 'yes' || raw.kind === 'no' ? { kind: raw.kind } : undefined;
}

export interface NoteEditorStore {
  /** Apply one op; returns the view to draw, or undefined when no editor is open (closed / failed to open). */
  readonly apply: (op: EditOp | undefined) => EditorView | undefined;
  readonly view: () => EditorView | undefined;
}

export interface NoteEditorOptions {
  readonly vault: () => string | undefined;
  /** One-step backups go here (<els state>/obsidian-backup); undefined = no backup. */
  readonly backupDir?: () => string | undefined;
  readonly notify?: (text: string, level: 'success' | 'error') => void;
  /** Lines per PgUp/PgDn. */
  readonly page?: number;
}

const chars = (line: string): string[] => Array.from(line);

export function createNoteEditor(options: NoteEditorOptions): NoteEditorStore {
  let state: { rel: string; lines: string[]; row: number; col: number; top: number; dirty: boolean; mode: EditMode; base: NoteStat; notice?: string } | undefined;
  const page = options.page ?? 10;
  const say = (text: string, ok: boolean): void => { if (state) state.notice = text; try { options.notify?.(text, ok ? 'success' : 'error'); } catch { /* courtesy */ } };
  const view = (): EditorView | undefined => state && { rel: state.rel, lines: state.lines, row: state.row, col: state.col, top: state.top, dirty: state.dirty, mode: state.mode, ...(state.notice ? { notice: state.notice } : {}) };
  const clampCol = (): void => { if (state) state.col = Math.min(state.col, chars(state.lines[state.row] ?? '').length); };
  const load = (rel: string): string | undefined => {
    const opened = openVaultEdit(options.vault(), rel);
    if (!opened.ok) return opened.message;
    const lines = opened.text.replace(/\r\n?/g, '\n').split('\n');
    state = { rel, lines, row: 0, col: 0, top: 0, dirty: false, mode: 'edit', base: opened.stat };
    return undefined;
  };
  const insert = (text: string): void => {
    const s = state!;
    const line = chars(s.lines[s.row] ?? '');
    const head = line.slice(0, s.col).join('');
    const tail = line.slice(s.col).join('');
    const parts = text.split('\n');
    if (parts.length === 1) { s.lines[s.row] = head + text + tail; s.col += chars(text).length; }
    else {
      const last = parts.at(-1)!;
      s.lines.splice(s.row, 1, head + parts[0]!, ...parts.slice(1, -1), last + tail);
      s.row += parts.length - 1;
      s.col = chars(last).length;
    }
    s.dirty = true;
  };
  const key = (k: EditKey): void => {
    const s = state!;
    const len = (r: number): number => chars(s.lines[r] ?? '').length;
    switch (k) {
      case 'left': if (s.col > 0) s.col--; else if (s.row > 0) { s.row--; s.col = len(s.row); } return;
      case 'right': if (s.col < len(s.row)) s.col++; else if (s.row < s.lines.length - 1) { s.row++; s.col = 0; } return;
      case 'up': if (s.row > 0) { s.row--; clampCol(); } return;
      case 'down': if (s.row < s.lines.length - 1) { s.row++; clampCol(); } return;
      case 'home': s.col = 0; return;
      case 'end': s.col = len(s.row); return;
      case 'pgup': s.row = Math.max(0, s.row - page); clampCol(); return;
      case 'pgdn': s.row = Math.min(s.lines.length - 1, s.row + page); clampCol(); return;
      case 'enter': insert('\n'); return;
      case 'back': {
        if (s.col > 0) { const line = chars(s.lines[s.row]!); line.splice(s.col - 1, 1); s.lines[s.row] = line.join(''); s.col--; s.dirty = true; }
        else if (s.row > 0) { const prev = len(s.row - 1); s.lines.splice(s.row - 1, 2, s.lines[s.row - 1]! + s.lines[s.row]!); s.row--; s.col = prev; s.dirty = true; }
        return;
      }
      case 'del': {
        if (s.col < len(s.row)) { const line = chars(s.lines[s.row]!); line.splice(s.col, 1); s.lines[s.row] = line.join(''); s.dirty = true; }
        else if (s.row < s.lines.length - 1) { s.lines.splice(s.row, 2, s.lines[s.row]! + s.lines[s.row + 1]!); s.dirty = true; }
        return;
      }
    }
  };
  const save = (): void => {
    const s = state!;
    const saved = saveVaultEdit(options.vault(), s.rel, s.lines.join('\n'), s.base, options.backupDir?.());
    if (saved.ok) { s.base = saved.stat; s.dirty = false; say(`Saved ${s.rel}`, true); return; }
    if (saved.reason === 'changed') { s.mode = 'conflict'; s.notice = undefined; return; }
    say(`Not saved: ${saved.message}`, false);
  };
  return {
    view,
    apply(op) {
      if (!op) return view();
      if (op.kind === 'open') {
        if (state && state.rel === op.rel) return view();                  // already editing this note (a re-applied op)
        const problem = load(op.rel);
        if (problem) { state = undefined; try { options.notify?.(`Cannot edit: ${problem}`, 'error'); } catch { /* courtesy */ } }
        return view();
      }
      if (!state) return undefined;
      state.notice = undefined;
      if (state.mode === 'discard') {
        if (op.kind === 'yes') { state = undefined; return undefined; }
        if (op.kind === 'no' || op.kind === 'esc') state.mode = 'edit';
        return view();
      }
      if (state.mode === 'conflict') {
        if (op.kind === 'yes') { const rel = state.rel; const problem = load(rel); if (problem) { state = undefined; return undefined; } state!.notice = 'Reloaded from disk'; return view(); }
        if (op.kind === 'no' || op.kind === 'esc') state.mode = 'edit';
        return view();
      }
      if (op.kind === 'esc') { if (state.dirty) state.mode = 'discard'; else state = undefined; return view(); }
      if (op.kind === 'save') save();
      else if (op.kind === 'type') insert(op.text);
      else if (op.kind === 'key') key(op.key);
      return view();
    },
  };
}

/** Key → op (client side). undefined = not an editor key (consumed by the caller). */
export function editorKey(view: EditorView, bytes: string): EditOp | undefined {
  if (view.mode !== 'edit') {
    if (bytes === 'y' || bytes === 'Y') return { kind: 'yes' };
    if (bytes === 'n' || bytes === 'N') return { kind: 'no' };
    return bytes === '\u001b' ? { kind: 'esc' } : undefined;
  }
  const map: Record<string, EditOp> = {
    '\u0013': { kind: 'save' }, '\u001b': { kind: 'esc' }, '\r': { kind: 'key', key: 'enter' }, '\u007f': { kind: 'key', key: 'back' }, '\b': { kind: 'key', key: 'back' },
    '\u001b[3~': { kind: 'key', key: 'del' }, '\u001b[A': { kind: 'key', key: 'up' }, '\u001b[B': { kind: 'key', key: 'down' }, '\u001b[C': { kind: 'key', key: 'right' }, '\u001b[D': { kind: 'key', key: 'left' },
    '\u001bOA': { kind: 'key', key: 'up' }, '\u001bOB': { kind: 'key', key: 'down' }, '\u001bOC': { kind: 'key', key: 'right' }, '\u001bOD': { kind: 'key', key: 'left' },
    '\u001b[H': { kind: 'key', key: 'home' }, '\u001b[1~': { kind: 'key', key: 'home' }, '\u001bOH': { kind: 'key', key: 'home' }, '\u0001': { kind: 'key', key: 'home' },
    '\u001b[F': { kind: 'key', key: 'end' }, '\u001b[4~': { kind: 'key', key: 'end' }, '\u001bOF': { kind: 'key', key: 'end' }, '\u0005': { kind: 'key', key: 'end' },
    '\u001b[5~': { kind: 'key', key: 'pgup' }, '\u001b[6~': { kind: 'key', key: 'pgdn' },
  };
  if (map[bytes]) return map[bytes];
  if (bytes.startsWith('\u001b[200~') || bytes.startsWith('\u001b[201~')) return undefined;      // paste markers (the text arrives as keys)
  if (bytes.startsWith('\u001b')) return undefined;
  if (bytes === '\n') return { kind: 'type', text: '\n' };                                         // a pasted newline
  if (/^[\u0000-\u001f\u007f]+$/.test(bytes)) return undefined;
  return editOpOf({ kind: 'type', text: bytes });
}

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const INV = '\u001b[7m';
const R = '\u001b[0m';

/** The visible slice of one line starting at display column `from` (cells), at most `width` cells; caret at `caretCell`. */
function sliceCells(line: string, from: number, width: number, caretCell?: number): string {
  let out = '';
  let cell = 0;
  let used = 0;
  const segs = Array.from(line);
  for (const ch of segs) {
    const w = Math.max(1, Bun.stringWidth(ch));
    if (cell >= from) {
      if (used + w > width) break;
      out += cell === caretCell ? `${INV}${ch}${R}` : ch;
      used += w;
    }
    cell += w;
  }
  if (caretCell !== undefined && caretCell >= cell && used < width) out += `${INV} ${R}`;
  return out;
}
const cellsTo = (line: string, col: number): number => Array.from(line).slice(0, col).reduce((sum, ch) => sum + Math.max(1, Bun.stringWidth(ch)), 0);

/** Pure rows: frame, title «✎ <note> ●(dirty)», the window of lines around the caret (horizontal scroll keeps the caret in
 *  view), a status row (keys · or the discard / conflict question · or a notice). */
export function renderNoteEditor(view: EditorView, size: { readonly w: number; readonly h: number }, focused: boolean, vaultName = 'Obsidian'): string[] {
  const { w, h } = size;
  if (w < 8 || h < 4) return Array.from({ length: Math.max(0, h) }, () => fitAnsi('✎', Math.max(0, w)));
  const inner = w - 2;
  const bodyH = h - 2;
  const edge = focused ? YELLOW : DIM;
  const title = ` ✎ ${vaultName} · ${view.rel}${view.dirty ? ' ●' : ''} `;
  const tw = Math.min(inner, Bun.stringWidth(title));
  const top = `${edge}┌${R}${fitAnsi(`${BOLD}${title}${R}`, tw)}${edge}${'─'.repeat(Math.max(0, inner - tw))}┐${R}`;
  const textW = Math.max(1, inner - 1);
  const winTop = Math.min(Math.max(view.top, view.row - bodyH + 1, 0), view.row);
  const caretCell = cellsTo(view.lines[view.row] ?? '', view.col);
  const hscroll = caretCell >= textW ? caretCell - textW + 1 : 0;
  const rows: string[] = [top];
  for (let at = 0; at < bodyH; at++) {
    const r = winTop + at;
    const line = view.lines[r];
    const shown = line === undefined ? `${DIM}~${R}` : sliceCells(line, hscroll, textW, focused && r === view.row ? caretCell : undefined);
    rows.push(`${edge}│${R}${fitAnsi(` ${shown}`, inner)}${edge}│${R}`);
  }
  const hint = view.mode === 'discard' ? `${BOLD}Discard changes? y/n${R}`
    : view.mode === 'conflict' ? `${BOLD}Changed outside — reload? y/n${R}`
    : view.notice ? `${CYAN}${view.notice}${R}`
    : `${DIM}${inner >= 64 ? '^S save · Esc close · ' : '^S save · Esc · '}${view.row + 1}:${view.col + 1}${R}`;
  const hw = Math.min(inner, Bun.stringWidth(hint.replace(/\u001b\[[0-9;]*m/g, '')) + 2);
  rows.push(`${edge}└${R}${fitAnsi(` ${hint} `, hw)}${edge}${'─'.repeat(Math.max(0, inner - hw))}┘${R}`);
  return rows;
}

/** Untrusted editor view from pushed props (client render) — drawn only when its shape is right. */
export function editorViewOf(raw: unknown): EditorView | undefined {
  if (!isRecord(raw) || typeof raw.rel !== 'string' || !Array.isArray(raw.lines) || !raw.lines.every((one) => typeof one === 'string')) return undefined;
  const nat = (v: unknown): number => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  const mode: EditMode = raw.mode === 'discard' || raw.mode === 'conflict' ? raw.mode : 'edit';
  return { rel: raw.rel, lines: raw.lines as string[], row: Math.min(nat(raw.row), Math.max(0, raw.lines.length - 1)), col: nat(raw.col), top: nat(raw.top), dirty: raw.dirty === true, mode,
    ...(typeof raw.notice === 'string' ? { notice: raw.notice.slice(0, 160) } : {}) };
}
