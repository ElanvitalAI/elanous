// ELS-MEMO (대표 11-26 B4) — the memo popup element: a small text pad on the els z axis. Type to write (Korean IME syllables
// arrive whole), Enter = new line, ⌫ = delete, ctrl+u = clear the current line, ctrl+p = pin above ALL spaces (toggle),
// ctrl+e = send to the Obsidian vault («00. Inbox», y/n confirm — the same save module as the sidechat take-out), Esc
// closes (the text stays: <els state>/memos/popup.md, back on reopen and after a restart).
// The server's memo store owns the text (memo-store.ts); keys go up as ordered edits; hydrate re-fills text from the store.

import { fitAnsi } from '../attach-view.js';
import type { MemoEdit } from '../memo-store.js';
import { fitNameRow, newSaveToken, planVaultNote, saveVaultNote, spendToken } from '../vault-save.js';
import type { ElementDef } from './element.js';
import { truncateCells, visibleWidth } from './markdown-render.js';
import { wrapToWidth } from './obsidian-view.js';

export interface MemoSend { readonly rel?: string; readonly token?: string; readonly go?: boolean }
export interface MemoProps {
  /** Server-filled from the store (the client's optimistic guess until the push lands). */
  readonly text: string;
  readonly edit?: MemoEdit;
  readonly togglePin?: boolean;
  readonly pinAll?: boolean;
  readonly send?: MemoSend | null;
  readonly holdEsc?: boolean;
  readonly note?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const TOKEN = /^[a-z0-9]{1,32}$/;
const ctrl = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function editOf(raw: unknown): MemoEdit | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'type') { const text = typeof raw.text === 'string' ? raw.text.replace(ctrl, ' ').slice(0, 4096) : ''; return text ? { kind: 'type', text } : undefined; }
  return raw.kind === 'back' || raw.kind === 'newline' || raw.kind === 'clear-line' ? { kind: raw.kind } : undefined;
}
function sendOf(raw: unknown): MemoSend | undefined {
  if (!isRecord(raw)) return undefined;
  const token = typeof raw.token === 'string' && TOKEN.test(raw.token) ? raw.token : undefined;
  return { ...(token ? { token } : {}), ...(token && raw.go === true ? { go: true } : {}), ...(token && typeof raw.rel === 'string' ? { rel: raw.rel.replace(ctrl, ' ').slice(0, 200) } : {}) };
}

export function memoProps(raw: unknown): MemoProps | undefined {
  if (raw !== undefined && !isRecord(raw)) return undefined;
  const value = (raw ?? {}) as Record<string, unknown>;
  const edit = editOf(value.edit);
  const send = sendOf(value.send);
  return { text: typeof value.text === 'string' ? value.text.slice(0, 65_536) : '', ...(edit ? { edit } : {}), ...(value.togglePin === true ? { togglePin: true } : {}), ...(send ? { send } : {}) };
}

/** The memo's title for a vault note: its first non-empty line (markdown heading marks dropped). */
export function memoTitle(text: string): string {
  const line = text.split('\n').map((one) => one.replace(/^#+\s*/, '').trim()).find((one) => one) ?? '';
  return line.slice(0, 60) || 'Memo';
}

const CANCEL = { send: null, holdEsc: false } as const;
/** Key reducer: the optimistic props + ONE edit (or a pin toggle / a send step). Everything else is consumed. */
export function memoKey(props: MemoProps, key: string): Record<string, unknown> | 'consumed' {
  const text = props.text;
  if (props.send) {
    if (key === '\u001b') return { text, ...CANCEL };
    if (props.send.rel && props.send.token && !props.send.go) {
      if (key === 'y' || key === 'Y') return { text, send: { ...props.send, go: true }, holdEsc: true };
      if (key === 'n' || key === 'N') return { text, ...CANCEL };
    }
    return 'consumed';
  }
  if (key === '\u0010') return { text, togglePin: true };   // ctrl+p (ctrl+t = the element host's frame key, #40285)
  if (key === '\u0005') return text.trim() ? { text, send: {}, holdEsc: true } : 'consumed';     // ctrl+e
  if (key === '\r' || key === '\n') return { text: `${text}\n`, edit: { kind: 'newline' } };
  if (key === '\u007f' || key === '\b') return text ? { text: Array.from(text).slice(0, -1).join(''), edit: { kind: 'back' } } : 'consumed';
  if (key === '\u0015') return { text: text.includes('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : '', edit: { kind: 'clear-line' } };
  if (key === '\t') return { text: `${text}  `, edit: { kind: 'type', text: '  ' } };
  if (key.startsWith('\u001b') || /^[\u0000-\u001f\u007f]$/.test(key)) return 'consumed';
  const typed = key.replace(ctrl, ' ');
  return typed ? { text: text + typed, edit: { kind: 'type', text: typed } } : 'consumed';
}

const FRAME = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const R = '\u001b[0m';

export function renderMemo(raw: MemoProps | undefined, size: { readonly w: number; readonly h: number }, focused: boolean): string[] {
  const props: MemoProps = raw && typeof raw.text === 'string' ? raw : { text: '' };
  const { w, h } = size;
  if (w < 6 || h < 3) return [];
  const inner = w - 2;
  const title = ` 📝 Memo${props.pinAll ? ' · 📌 all spaces' : ''} `;
  const shownTitle = truncateCells(title, Math.max(0, inner - 1));
  const top = `${FRAME}╭─${R}${BOLD}${shownTitle}${R}${FRAME}${'─'.repeat(Math.max(0, inner - 1 - visibleWidth(shownTitle)))}╮${R}`;
  const hint = props.send?.rel && !props.send.go ? `${BOLD}${fitNameRow('Save to ', props.send.rel, '?', Math.max(10, inner - 8))}${R} y/n`
    : props.send ? `${DIM}Saving…${R}`
    : props.note ? props.note
    : inner >= 60 ? `${DIM}Enter new line · ^P pin all spaces · ^E send to vault · Esc close${R}` : `${DIM}^P pin · ^E vault · Esc${R}`;
  const bodyH = Math.max(0, h - 2);
  // wrapToWidth collapses blank runs; a memo keeps them — rebuild per source line.
  const rows = props.text ? props.text.split('\n').flatMap((line) => line ? wrapToWidth(line, Math.max(1, inner - 2)) : ['']) : [`${DIM}Write anything — it is kept until you delete it.${R}`];
  const caret = focused ? '\u001b[7m \u001b[27m' : '';
  if (focused && props.text) rows[rows.length - 1] = `${rows[rows.length - 1] ?? ''}${props.text ? caret : ''}`;
  const shown = rows.slice(Math.max(0, rows.length - bodyH));                // the end (caret) stays in view
  while (shown.length < bodyH) shown.push('');
  const side = (text: string): string => `${FRAME}│${R}${fitAnsi(` ${text}`, inner)}${FRAME}│${R}`;
  const bottom = `${FRAME}╰${R}${fitAnsi(` ${hint} `, Math.min(inner, visibleWidth(hint) + 2))}${FRAME}${'─'.repeat(Math.max(0, inner - Math.min(inner, visibleWidth(hint) + 2)))}╯${R}`;
  return [top, ...shown.map(side), bottom].slice(0, h);
}

export const memo: ElementDef<MemoProps> = {
  kind: 'memo',
  defaults: { band: 'float', focus: 'owns' },
  frames: ['popup'],
  dress: {},                                              // ELS-POPUP-STYLE fancy: bar · shading · shadow
  props: (raw) => memoProps(raw),
  hydrate: (props, context) => {
    const store = context.memo;
    if (!store) return { text: props.text, note: 'memo runs only in an els server' };
    if (props.edit) store.edit(props.edit);
    if (props.togglePin) store.togglePin();
    let send: MemoSend | undefined;
    let note: string | undefined;
    const say = (text: string, level: 'success' | 'error'): void => { note = text; try { context.notify?.(text, level); } catch { /* courtesy */ } };
    if (props.send) {
      const title = memoTitle(store.text());
      if (!props.send.token) {
        const plan = planVaultNote(context.vault, title);
        if (plan.ok) send = { rel: plan.rel, token: newSaveToken() }; else say(`Not saved: ${plan.message}`, 'error');
      } else if (!props.send.go) send = props.send;
      else if (spendToken(props.send.token)) {
        const saved = saveVaultNote(context.vault, title, store.text().endsWith('\n') ? store.text() : `${store.text()}\n`);
        say(saved.ok ? `Saved to ${saved.rel}` : `Not saved: ${saved.message}`, saved.ok ? 'success' : 'error');
      }
    }
    const problem = store.problem();
    return { text: store.text(), pinAll: store.pinAll(), ...(send ? { send, holdEsc: true } : {}), ...(note ? { note } : problem ? { note: problem } : {}) };
  },
  pinFor: (props) => props.pinAll ? 'all' : 'space',
  rect: () => ({ anchor: 'center', w: '50%', h: '50%' }),
  render: (props, size, focused) => renderMemo(props, size, focused),
  key: (layer, bytes) => {
    const props = layer.props as MemoProps | undefined;
    if (!props || typeof props.text !== 'string') return 'consumed';
    const next = memoKey(props, bytes);
    return next === 'consumed' ? 'consumed' : { update: next };
  },
};
