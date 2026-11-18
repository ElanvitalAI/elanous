import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInlineEditorState } from '../../input-core/inline-editor.js';
import {
  createPromptHistoryStore, isRecordablePrompt, mergePromptHistory, moveEditorLine, PROMPT_HISTORY_MAX_CHARS, upDownTarget,
} from './prompt-history.js';

const at = (text: string, cursor: number) => ({ text, cursor });

test('↑/↓ target: line moves win inside a multi-line draft; queue panel whenever items wait and the composer is empty', () => {
  const two = 'first\nsecond';
  expect(upDownTarget({ key: 'up', editor: at(two, two.length), busy: false, queued: 0 })).toBe('line');
  expect(upDownTarget({ key: 'up', editor: at(two, 2), busy: false, queued: 0 })).toBe('history');
  expect(upDownTarget({ key: 'down', editor: at(two, 2), busy: false, queued: 0 })).toBe('line');
  expect(upDownTarget({ key: 'down', editor: at(two, two.length), busy: false, queued: 0 })).toBe('history');
  // Busy: queued items take ↑ only from an empty composer; no queue, or a draft, means history.
  expect(upDownTarget({ key: 'up', editor: createInlineEditorState(''), busy: true, queued: 2 })).toBe('queue-panel');
  expect(upDownTarget({ key: 'up', editor: createInlineEditorState(''), busy: true, queued: 0 })).toBe('history');
  expect(upDownTarget({ key: 'up', editor: createInlineEditorState('draft'), busy: true, queued: 2 })).toBe('history');
  expect(upDownTarget({ key: 'down', editor: createInlineEditorState(''), busy: true, queued: 2 })).toBe('history');
  expect(upDownTarget({ key: 'up', editor: createInlineEditorState(''), busy: false, queued: 2 })).toBe('queue-panel');
});

test('line moves keep the column where the target line allows', () => {
  const text = 'abcdef\nxy\nlonger line';
  expect(moveEditorLine(at(text, 5), 'down')).toEqual(at(text, 'abcdef\n'.length + 2));
  expect(moveEditorLine(at(text, 'abcdef\nxy\n'.length + 4), 'up')).toEqual(at(text, 'abcdef\n'.length + 2));
  expect(moveEditorLine(at(text, 3), 'up')).toEqual(at(text, 3));
});

test('secrets, empty and oversized prompts are never recorded; slash commands are', () => {
  expect(isRecordablePrompt('/model')).toBe(true);
  expect(isRecordablePrompt('  ')).toBe(false);
  expect(isRecordablePrompt('x'.repeat(PROMPT_HISTORY_MAX_CHARS + 1))).toBe(false);
  expect(isRecordablePrompt(`use token ghp_${'a'.repeat(36)}`)).toBe(false);
});

test('the store keeps a list per working directory, most recent last, owner-only, and survives a new store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-history-'));
  const path = join(dir, 'history.json');
  try {
    const one = createPromptHistoryStore('/work/a', path, 3);
    for (const text of ['first', '/status', 'second', 'third', 'second']) one.record(text);
    createPromptHistoryStore('/work/b', path, 3).record('other dir');
    // A new process reads the same list: oldest first, repeats moved to the end, capped at the limit.
    expect(createPromptHistoryStore('/work/a', path, 3).load()).toEqual(['/status', 'third', 'second']);
    expect(createPromptHistoryStore('/work/b', path, 3).load()).toEqual(['other dir']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('ghp_');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken file reads as empty; a resumed session adds only what the saved list lacks, before it', () => {
  expect(createPromptHistoryStore('/x', join(tmpdir(), 'missing-dir-for-history', 'none.json')).load()).toEqual([]);
  expect(mergePromptHistory(['b', 'c'], ['old', 'b', 'old', 'c'])).toEqual(['old', 'b', 'c']);
});
