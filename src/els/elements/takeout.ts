// ELS-TAKEOUT (대표 11-26 «꺼내기») — take the sidechat's LAST answer out: ctrl+e opens a chooser row inside the popup
//   [m] memo (md under the els state folder) · [o] Obsidian note (vault «00. Inbox», after a y/n confirm) · [t] new tab
//   (the memo file in a read-only markdown tab) · Esc cancel.
// The chooser is UI state carried in the sidechat props (`takeout`); the client key reducer only moves between steps,
// the server's hydrate does the write through the one save module (src/els/vault-save.ts) and answers with a toast.
// `holdEsc` (server-set while a chooser row is up) tells the attach app to give Esc to the element (cancel) instead of
// closing the popup.

import type { SidechatTurn } from '../sidechat-hub.js';
import { fitNameRow, newSaveToken, planVaultNote, saveMemo, saveVaultNote, spendToken } from '../vault-save.js';
import type { ElementContext } from './element.js';

export type TakeoutState =
  | { readonly step: 'choose' }
  | { readonly step: 'memo' }
  | { readonly step: 'tab' }
  /** Obsidian: asked (no rel yet) → the server plans the name (rel + token) → `go` after the user's y. */
  | { readonly step: 'obsidian'; readonly rel?: string; readonly token?: string; readonly go?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const TOKEN = /^[a-z0-9]{1,32}$/;

/** Untrusted → takeout state (null / anything else = none). `rel` is never taken from a client: the server re-plans it. */
export function takeoutOf(raw: unknown): TakeoutState | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.step === 'choose' || raw.step === 'memo' || raw.step === 'tab') return { step: raw.step };
  if (raw.step !== 'obsidian') return undefined;
  const token = typeof raw.token === 'string' && TOKEN.test(raw.token) ? raw.token : undefined;
  return { step: 'obsidian', ...(token ? { token } : {}), ...(token && raw.go === true ? { go: true } : {}),
    ...(token && typeof raw.rel === 'string' ? { rel: raw.rel.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) } : {}) };
}

/** The last answered turn (question + answer, no error), or undefined. */
export function lastAnswer(turns: readonly SidechatTurn[]): SidechatTurn | undefined {
  const last = turns.at(-1);
  return last && last.a.trim() && !last.error ? last : undefined;
}

/** The markdown taken out: the question as a heading, then the answer. */
export function takeoutMarkdown(turn: SidechatTurn): string {
  return `# ${turn.q.replace(/\s+/g, ' ').trim()}\n\n${turn.a.trim()}\n`;
}
const titleOf = (turn: SidechatTurn): string => turn.q.replace(/\s+/g, ' ').trim().slice(0, 60);

const CANCEL = { takeout: null, holdEsc: false } as const;

/** Key reducer while a chooser row is up (or ctrl+e to open it). undefined = not a takeout key (the normal reducer runs). */
export function takeoutKey(props: { readonly input: string; readonly takeout?: TakeoutState; readonly status?: string; readonly turns?: readonly SidechatTurn[] }, key: string): Record<string, unknown> | 'consumed' | undefined {
  const t = props.takeout;
  if (!t) {
    if (key !== '\u0005') return undefined;                                         // ctrl+e
    if ((props.status && props.status !== 'idle') || !lastAnswer(props.turns ?? [])) return 'consumed';
    return { input: props.input, takeout: { step: 'choose' }, holdEsc: true };
  }
  if (key === '\u001b') return { input: props.input, ...CANCEL };
  if (t.step === 'choose') {
    const k = key.toLowerCase();
    if (k === 'm') return { input: props.input, takeout: { step: 'memo' }, holdEsc: true };
    if (k === 'o') return { input: props.input, takeout: { step: 'obsidian' }, holdEsc: true };
    if (k === 't') return { input: props.input, takeout: { step: 'tab' }, holdEsc: true };
    return 'consumed';
  }
  if (t.step === 'obsidian' && t.rel && t.token && !t.go) {
    if (key === 'y' || key === 'Y') return { input: props.input, takeout: { step: 'obsidian', rel: t.rel, token: t.token, go: true }, holdEsc: true };
    if (key === 'n' || key === 'N') return { input: props.input, ...CANCEL };
  }
  return 'consumed';
}

/** Server side: run the step (write / plan) and answer the takeout state to keep (undefined = the row closes). */
export function hydrateTakeout(t: TakeoutState | undefined, turns: readonly SidechatTurn[], context: ElementContext): TakeoutState | undefined {
  if (!t || t.step === 'choose') return t;
  const turn = lastAnswer(turns);
  const say = (text: string, level: 'success' | 'error' | 'info'): void => { try { context.notify?.(text, level); } catch { /* a toast is a courtesy */ } };
  if (!turn) { say('Nothing to take out yet', 'info'); return undefined; }
  if (t.step === 'memo' || t.step === 'tab') {
    const saved = saveMemo(context.stateDir, titleOf(turn), takeoutMarkdown(turn));
    if (!saved.ok) { say(`Memo not saved: ${saved.message}`, 'error'); return undefined; }
    if (t.step === 'memo') { say(`Memo saved: ${saved.rel}`, 'success'); return undefined; }
    const problem = context.openTab ? context.openTab(saved.path, `▤ ${titleOf(turn).slice(0, 24)}`) : 'tabs open only in an els server';
    say(problem ? `Tab not opened: ${problem}` : 'Opened in a new tab', problem ? 'error' : 'success');
    return undefined;
  }
  if (!t.go) {
    if (t.rel && t.token) return t;                                                  // waiting for y/n
    const plan = planVaultNote(context.vault, titleOf(turn));
    if (!plan.ok) { say(`Not saved: ${plan.message}`, 'error'); return undefined; }
    return { step: 'obsidian', rel: plan.rel, token: newSaveToken() };
  }
  if (!spendToken(t.token)) return undefined;                                         // this confirm already wrote
  const saved = saveVaultNote(context.vault, titleOf(turn), takeoutMarkdown(turn));
  say(saved.ok ? `Saved to ${saved.rel}` : `Not saved: ${saved.message}`, saved.ok ? 'success' : 'error');
  return undefined;
}

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const R = '\u001b[0m';
/** The chooser / confirm row drawn in place of the input line. */
export function takeoutRow(t: TakeoutState, room = 200): string {
  if (t.step === 'choose') return room >= 62 ? `${BOLD}Take out:${R} [m] memo · [o] Obsidian note · [t] new tab · ${DIM}Esc cancel${R}` : `${BOLD}Take out:${R} m memo · o Obsidian · t tab · ${DIM}Esc${R}`;
  if (t.step === 'obsidian' && t.rel && !t.go) return `${BOLD}${fitNameRow('Save to ', t.rel, '?', Math.max(10, room - 4))}${R} y/n`;
  return `${DIM}Taking out…${R}`;
}
