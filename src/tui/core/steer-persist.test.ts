// MIDTURN-STEER-ORDER-PERSIST — a person line that joins a running turn is a saved user row at the join point and
// survives reload, the next turn start and a compaction display merge. Literal expectations only.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendMessage, createSession, loadSession, type SerializedMessage } from '../../session/index.js';
import { mergeDisplayAfterCompact } from './compact-display.js';
import { nextTuiPublicHistory } from './public-history.js';
import { joinedSteerRows } from './steer-status.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'steer-persist-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const at = (second: number) => () => `2026-11-24T15:09:${String(second).padStart(2, '0')}.000Z`;
const tool = (content: string, second: number): SerializedMessage => ({ role: 'tool', content, ts: at(second)() });

function turnWithSteers(steers: { text: string; afterTool: string }[], toolError = false) {
  const id = createSession({ source: 'tui' }, root).id;
  appendMessage(id, { role: 'user', content: 'check the mailbox', ts: at(0)() }, root);
  let second = 1;
  for (const steer of steers) {
    appendMessage(id, tool(toolError ? 'Error: exit 1' : steer.afterTool, second++), root);
    const queue = [{ kind: 'user', text: steer.text, steerId: `s-${second}` }];
    for (const row of joinedSteerRows(queue, [`s-${second}`], at(second++))) appendMessage(id, row, root);
  }
  appendMessage(id, tool('⚙️ Bash', second++), root);
  appendMessage(id, { role: 'assistant', content: 'done', ts: at(second)(), replyFinal: true }, root);
  return id;
}

test('steer then reload: the person row is saved after the tool call it joined at and shows with the mark', () => {
  const id = turnWithSteers([{ text: 'why no reply?', afterTool: '⚙️ Read' }]);
  const saved = loadSession(id, root)!.messages;
  expect(saved.map((row) => row.role)).toEqual(['user', 'tool', 'user', 'tool', 'assistant']);
  expect(saved[2]!.content).toBe('why no reply?');
  expect(saved[2]!.steerJoined).toBe(true);
  expect(typeof saved[2]!.turn_id).toBe('string');
  const shown = nextTuiPublicHistory(saved);
  expect(shown[2]!.content).toBe('why no reply?');
  // The next turn start reloads the same ledger: the row keeps its id.
  expect(loadSession(id, root)!.messages[2]!.turn_id).toBe(saved[2]!.turn_id);
});

test('two steers in one turn are both saved, in order, each after its own tool call', () => {
  const id = turnWithSteers([{ text: 'first', afterTool: '⚙️ Read' }, { text: 'second', afterTool: '⚙️ Grep' }]);
  const saved = loadSession(id, root)!.messages;
  expect(saved.map((row) => `${row.role}:${row.content}`)).toEqual([
    'user:check the mailbox', 'tool:⚙️ Read', 'user:first', 'tool:⚙️ Grep', 'user:second', 'tool:⚙️ Bash', 'assistant:done']);
});

test('steer after a failed tool call is still saved at the join point', () => {
  const id = turnWithSteers([{ text: 'retry it', afterTool: 'unused' }], true);
  const saved = loadSession(id, root)!.messages;
  expect(saved.map((row) => `${row.role}:${row.content}`)).toEqual([
    'user:check the mailbox', 'tool:Error: exit 1', 'user:retry it', 'tool:⚙️ Bash', 'assistant:done']);
});

test('steer then compaction: the displayed steer row stays exactly once, kept or refreshed from the store', () => {
  const id = turnWithSteers([{ text: 'why no reply?', afterTool: '⚙️ Read' }]);
  const shown = loadSession(id, root)!.messages;
  const steer = shown[2]!;
  const summary: SerializedMessage = { role: 'system', content: '<context_summary>older</context_summary>', ts: at(59)() };
  const kept = mergeDisplayAfterCompact(shown, [summary, steer, shown[3]!, shown[4]!]);
  expect(kept.rows.filter((row) => row.content === 'why no reply?').length).toBe(1);
  expect(kept.keptMissing).toBe(2);
  const dropped = mergeDisplayAfterCompact(shown, [summary, shown[4]!]);
  expect(dropped.rows[2]!.content).toBe('why no reply?');
  expect(dropped.rows.length).toBe(5);
});

test('no steer: nothing is echoed and the ledger holds only the turn rows', () => {
  expect(joinedSteerRows([{ kind: 'user', text: 'queued', steerId: 's-9' }], ['s-1'], at(1))).toEqual([]);
  expect(joinedSteerRows([{ kind: 'seat-mail', text: '[notice]', steerId: 's-1' }], ['s-1'], at(1))).toEqual([]);
  const id = turnWithSteers([]);
  expect(loadSession(id, root)!.messages.map((row) => row.role)).toEqual(['user', 'tool', 'assistant']);
});
