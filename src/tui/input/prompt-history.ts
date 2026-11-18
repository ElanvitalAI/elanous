// NEXT-TUI-INPUT-HISTORY (대표 11-17 · ASK-USER-TURN-COLOR-AND-HISTORY-1117 item 2).
// ↑/↓ in the composer walks earlier prompts. What ↑ does is decided in one place (upDownTarget):
//   line        — a multi-line draft whose cursor is not on its first (↑) or last (↓) line moves between its lines
//   queue-panel — an empty composer with queued items opens the queue panel (ELN-QUEUE-ITEM-CONTROLS)
//   history     — otherwise; the panel never falls through into history at its top
// The history survives sessions: one file per state universe, a list per working directory, most recent last.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecretText } from '../../debug/secret-redaction.js';
import type { InlineEditorState } from '../../input-core/inline-editor.js';
import { sessionRoot } from '../../session/index.js';

export type UpDownTarget = 'line' | 'queue-panel' | 'history';

// 출처: ASK 2 «같은 작업 디렉터리 기준 최근 n개» — a few screens of ↑ presses; older prompts are in session search.
export const PROMPT_HISTORY_LIMIT = 200;
// 출처: a pasted log is not a prompt to recall; very long entries are left out instead of being cut.
export const PROMPT_HISTORY_MAX_CHARS = 4000;

const lineOf = (text: string, cursor: number) => text.slice(0, cursor).split('\n').length - 1;

export function upDownTarget(input: { readonly key: 'up' | 'down'; readonly editor: InlineEditorState; readonly busy: boolean; readonly queued: number }): UpDownTarget {
  const { key, editor } = input;
  const lines = editor.text.split('\n').length;
  const line = lineOf(editor.text, editor.cursor);
  if (lines > 1 && (key === 'up' ? line > 0 : line < lines - 1)) return 'line';
  // Waiting items come first whenever they exist, during a turn or after one; the panel never falls into history.
  if (key === 'up' && input.queued > 0 && editor.text.trim() === '') return 'queue-panel';
  return 'history';
}

/** Move the cursor one logical line up or down, keeping its column where the target line allows. */
export function moveEditorLine(editor: InlineEditorState, key: 'up' | 'down'): InlineEditorState {
  const rows = editor.text.split('\n');
  const line = lineOf(editor.text, editor.cursor);
  const target = Math.max(0, Math.min(rows.length - 1, line + (key === 'up' ? -1 : 1)));
  if (target === line) return editor;
  const startOf = (row: number) => rows.slice(0, row).reduce((sum, text) => sum + text.length + 1, 0);
  const column = editor.cursor - startOf(line);
  return { text: editor.text, cursor: startOf(target) + Math.min(column, rows[target]!.length) };
}

/** A prompt worth keeping: not empty, not oversized, and nothing the secret redactor would change. */
export function isRecordablePrompt(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= PROMPT_HISTORY_MAX_CHARS && redactSecretText(trimmed) === trimmed;
}

/**
 * Oldest first. The saved list already holds every prompt submitted since this feature (this session's too), so the
 * session's own user turns only add what predates it (a resumed older session), placed before the saved ones.
 */
export function mergePromptHistory(saved: readonly string[], session: readonly string[]): string[] {
  const known = new Set(saved);
  const older: string[] = [];
  for (const text of session) if (!known.has(text) && older.at(-1) !== text) older.push(text);
  return [...older, ...saved];
}

export interface PromptHistoryStore {
  load(): string[];
  record(text: string): void;
}

export const defaultPromptHistoryPath = (): string => join(dirname(sessionRoot()), 'next-tui-prompt-history.json');

/** File-backed history for `cwd`. Read failures read as empty; write failures never reach the composer. */
export function createPromptHistoryStore(cwd: string, path = defaultPromptHistoryPath(), limit = PROMPT_HISTORY_LIMIT): PromptHistoryStore {
  const readAll = (): Record<string, string[]> => {
    try {
      if (!existsSync(path)) return {};
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .map(([dir, list]) => [dir, Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []]));
    } catch { return {}; }
  };
  return {
    load: () => (readAll()[cwd] ?? []).filter(isRecordablePrompt),
    record(text) {
      if (!isRecordablePrompt(text)) return;
      try {
        const all = readAll();
        const list = (all[cwd] ?? []).filter((item) => item !== text);
        all[cwd] = [...list, text].slice(-limit);
        mkdirSync(dirname(path), { recursive: true });
        // Prompts are private: owner-only, written whole then renamed so a crash never leaves half a file.
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
        renameSync(temp, path);
        chmodSync(path, 0o600);
      } catch { /* history is a convenience; a failed write must not block a submit */ }
    },
  };
}
