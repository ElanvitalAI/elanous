// ELS-MEMO (대표 11-26 B4) — the server side of the memo popup: ONE memo text per els server, kept in memory and written to
// <els state>/memos/popup.md — atomic (temp + rename), debounced through one timer armed on change (never a poll), flushed
// at once on close/dispose. The element (elements/memo.ts) sends ordered edits (type · back · newline · line-clear), never
// the whole text, so a stale push between two keys cannot drop text (same rule as the sidechat hub).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MemoEdit = { readonly kind: 'type'; readonly text: string } | { readonly kind: 'back' } | { readonly kind: 'newline' } | { readonly kind: 'clear-line' };

// 출처: ELS-MEMO — a memo is a note, not a document: 64 KiB. One write per 400 ms of typing at most.
export const MEMO_MAX_CHARS = 65_536;
export const MEMO_SAVE_MS = 400;

export interface MemoStore {
  readonly text: () => string;
  readonly pinAll: () => boolean;
  readonly edit: (edit: MemoEdit) => void;
  readonly togglePin: () => void;
  /** Write now if a save is pending (popup closed · server stopping). */
  readonly flush: () => void;
  /** The last save failure (one line), or undefined. */
  readonly problem: () => string | undefined;
  readonly dispose: () => void;
}

export interface MemoStoreOptions {
  readonly file: string;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly write?: (file: string, text: string) => void;
}

const writeAtomic = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
};

export function createMemoStore(options: MemoStoreOptions): MemoStore {
  const setTimer = options.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const write = options.write ?? writeAtomic;
  let text = '';
  try { text = readFileSync(options.file, 'utf8').slice(0, MEMO_MAX_CHARS); } catch { text = ''; }   // restart: the memo comes back
  let pinAll = false;
  let timer: unknown;
  let problem: string | undefined;
  const save = (): void => {
    timer = undefined;
    try { write(options.file, text); problem = undefined; }
    catch (error) { problem = `Memo not saved (${(error as { code?: string }).code ?? 'error'})`; }
  };
  const schedule = (): void => { if (timer === undefined) timer = setTimer(save, MEMO_SAVE_MS); };
  return {
    text: () => text,
    pinAll: () => pinAll,
    problem: () => problem,
    edit(edit) {
      const before = text;
      if (edit.kind === 'type') text = (text + edit.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')).slice(0, MEMO_MAX_CHARS);
      else if (edit.kind === 'back') text = Array.from(text).slice(0, -1).join('');
      else if (edit.kind === 'newline') text = `${text}\n`.slice(0, MEMO_MAX_CHARS);
      else text = text.includes('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : '';
      if (text !== before) schedule();
    },
    togglePin() { pinAll = !pinAll; },
    flush() { if (timer !== undefined) { clearTimer(timer); save(); } },
    dispose() { if (timer !== undefined) { clearTimer(timer); save(); } },
  };
}

/** Closing the memo popup writes a pending save at once. Event-driven (the registry's change listener), never polled. */
export function watchMemoClose(registry: { onChange: (listener: (stack: { layers: ReadonlyArray<{ kind: string }> }) => void) => { dispose: () => void } }, store: MemoStore): { readonly dispose: () => void } {
  let open = false;
  return registry.onChange((stack) => { const now = stack.layers.some((one) => one.kind === 'memo'); if (open && !now) store.flush(); open = now; });
}
