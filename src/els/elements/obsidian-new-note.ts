// ELS-TAKEOUT B1 (대표 11-26) — «new note» in the Obsidian viewer (popup and tab): `n` in the note list opens a one-line
// title input, Enter asks «Create 00. Inbox/<title>.md? y/n», only `y` writes — an empty note with a «# title» line, through
// the same save module as the sidechat take-out (src/els/vault-save.ts: Inbox only, clamped, atomic, never overwriting).
// The input/confirm is UI state in the viewer props (`create`); the write happens in hydrate (els server for the popup, the
// viewer's own process for the tab — never the attach client), once per server-minted confirm token.

import { INBOX_FOLDER, fitNameRow, newSaveToken, planVaultNote, saveVaultNote, spendToken, NOTE_NAME_MAX } from '../vault-save.js';

export interface NewNoteState {
  readonly title: string;
  readonly confirm?: boolean;
  /** Server-planned name + confirm token (shown in the y/n row); `go` after the user's y. */
  readonly rel?: string;
  readonly token?: string;
  readonly go?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const TOKEN = /^[a-z0-9]{1,32}$/;
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, ' ');

/** Untrusted → new-note state (null / anything else = none). */
export function newNoteOf(raw: unknown): NewNoteState | undefined {
  if (!isRecord(raw) || typeof raw.title !== 'string') return undefined;
  const title = Array.from(clean(raw.title)).slice(0, NOTE_NAME_MAX).join('');
  const token = raw.confirm === true && typeof raw.token === 'string' && TOKEN.test(raw.token) ? raw.token : undefined;
  return { title, ...(raw.confirm === true ? { confirm: true } : {}), ...(token ? { token } : {}),
    ...(token && typeof raw.rel === 'string' ? { rel: clean(raw.rel).slice(0, 200) } : {}), ...(token && raw.go === true ? { go: true } : {}) };
}

type Nav = { readonly dir: string; readonly cursor: number; readonly scroll: number; readonly note?: string };
/** Key reducer for the new-note row. undefined = not a new-note key (the viewer's own reducer runs); 'pass' = ignored. */
export function newNoteKey<P extends Nav & { readonly create?: NewNoteState | null }>(props: P, key: string): (Nav & { create: NewNoteState | null; holdEsc: boolean }) | 'pass' | undefined {
  const nav: Nav = { dir: props.dir, cursor: props.cursor, scroll: props.scroll, ...(props.note ? { note: props.note } : {}) };
  const c = props.create;
  if (!c) return key === 'n' && !props.note ? { ...nav, create: { title: '' }, holdEsc: true } : undefined;
  if (key === '\u001b') return { ...nav, create: null, holdEsc: false };
  if (!c.confirm) {
    if (key === '\r' || key === '\n') return c.title.trim() ? { ...nav, create: { title: c.title, confirm: true }, holdEsc: true } : 'pass';
    if (key === '\u007f' || key === '\b') return { ...nav, create: { title: Array.from(c.title).slice(0, -1).join('') }, holdEsc: true };
    if (key === '\u0015') return { ...nav, create: { title: '' }, holdEsc: true };
    if (key.startsWith('\u001b') || /^[\u0000-\u001f\u007f]$/.test(key)) return 'pass';
    const text = clean(key);
    return { ...nav, create: { title: Array.from(c.title + text).slice(0, NOTE_NAME_MAX).join('') }, holdEsc: true };
  }
  if (c.rel && c.token && !c.go) {
    if (key === 'y' || key === 'Y') return { ...nav, create: { ...c, go: true }, holdEsc: true };
    if (key === 'n' || key === 'N') return { ...nav, create: null, holdEsc: false };
  }
  return 'pass';
}

export interface NewNoteOutcome {
  /** The state to keep (undefined = the row closes). */
  readonly create?: NewNoteState;
  /** One line for the person (also a toast in the popup). */
  readonly notice?: string;
  /** The note just created (vault-relative) — the viewer opens it. */
  readonly open?: string;
}

/** Server side: plan the name on confirm, write on y (once per token). */
export function hydrateNewNote(c: NewNoteState | undefined, vault: string | undefined, notify?: (text: string, level: 'success' | 'error') => void): NewNoteOutcome {
  if (!c) return {};
  const say = (text: string, ok: boolean): NewNoteOutcome => { try { notify?.(text, ok ? 'success' : 'error'); } catch { /* courtesy */ } return { notice: text }; };
  if (!c.confirm) return { create: c };
  if (!c.go) {
    if (c.rel && c.token) return { create: c };
    const plan = planVaultNote(vault, c.title);
    return plan.ok ? { create: { title: c.title, confirm: true, rel: plan.rel, token: newSaveToken() } } : say(`Not created: ${plan.message}`, false);
  }
  if (!spendToken(c.token)) return {};
  const saved = saveVaultNote(vault, c.title, `# ${c.title.trim()}\n`);
  if (!saved.ok) return say(`Not created: ${saved.message}`, false);
  return { ...say(`Created ${saved.rel}`, true), open: saved.rel };
}

/** The bottom row while a title is typed / confirmed. */
export function newNoteRow(c: NewNoteState, room = 200): string {
  if (!c.confirm) {
    const wide = room >= 64;
    const head = wide ? `New note in ${INBOX_FOLDER}: ` : 'New note: ';
    const tail = wide ? ' · Enter next · Esc cancel' : ' · Enter · Esc';
    // The title keeps its END in view while typing (the caret side).
    let title = c.title;
    while (title && Bun.stringWidth(`${head}${title}▏${tail}`) > room) title = Array.from(title).slice(1).join('');
    return `${head}${title}▏${tail}`;
  }
  if (c.rel && !c.go) return fitNameRow('Create ', c.rel, '? y/n', room);
  return 'Creating…';
}
