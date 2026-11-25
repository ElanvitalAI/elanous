import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { toolActivityLines, type ToolActivityRow } from '../chat/tool-activity.js';
import { renderNextTuiLogFrame } from './render.js';

// TOOL-SEARCH-FOLD — a capability lookup (ToolSearch · capability_search) never takes its own transcript line.
// Expectations are literal strings, independent of the renderer's constants.

const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, '');
const ts = '2026-11-25T07:05:00Z';
const longResult = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');

function frame(messages: SerializedMessage[], expanded: number[] = [], messageBlocks?: Parameters<typeof renderNextTuiLogFrame>[0]['messageBlocks']) {
  return renderNextTuiLogFrame({ messages, columns: 80, rows: 40, header: [], footer: [], promptLine: '> ', notices: [],
    activity: [], scroll: 0, expandedToolIndexes: new Set(expanded), ...(messageBlocks ? { messageBlocks } : {}) });
}
const text = (lines: readonly string[]): string[] => lines.map(plain).filter((line) => line.trim().length > 0);

test('live rows: a finished ToolSearch then Read renders one Read line, no ToolSearch line', () => {
  const rows: ToolActivityRow[] = [
    { id: 'a', name: 'ToolSearch', startedAt: 0, finishedAt: 10 },
    { id: 'b', name: 'Read', target: 'src/a.ts', startedAt: 10, finishedAt: 20 },
  ];
  expect(toolActivityLines(rows, 30)).toEqual(['✓ Read(a.ts)']);
});

test('live rows: a lookup between calls of one tool does not break their fold', () => {
  const rows: ToolActivityRow[] = [
    { id: 'a', name: 'Read', target: 'a.ts', startedAt: 0, finishedAt: 1 },
    { id: 'b', name: 'ToolSearch', startedAt: 1, finishedAt: 2 },
    { id: 'c', name: 'Read', target: 'b.ts', startedAt: 2, finishedAt: 3 },
    { id: 'd', name: 'capability_search', startedAt: 3, finishedAt: 4 },
    { id: 'e', name: 'Read', target: 'c.ts', startedAt: 4, finishedAt: 5 },
  ];
  expect(toolActivityLines(rows, 6, { expanded: true })).toEqual(['✓ Read ×3 · last c.ts']);
  // TOOL-RUN-FOLD — folded, the lookups still take no part: three Reads are one run line.
  expect(toolActivityLines(rows, 6)).toEqual(['✓ 3 tools · Read ×3']);
});

test('live rows: a ToolSearch still running, alone, shows no row at all', () => {
  expect(toolActivityLines([{ id: 'a', name: 'ToolSearch', startedAt: 0 }], 5)).toEqual([]);
});

test('history: a saved ToolSearch then Read renders one folded Read line; expanding Read shows the lookup above it', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: 'look', ts },
    { role: 'tool', content: '', toolName: 'ToolSearch', toolResult: 'matched: Read', ts },
    { role: 'tool', content: '', toolName: 'Read', toolResult: longResult, ts },
  ];
  const before = JSON.stringify(messages);
  const folded = text(frame(messages).body);
  expect(folded.some((line) => line.includes('ToolSearch'))).toBe(false);
  expect(folded.filter((line) => line.includes('Read'))).toEqual(['▸ Tool Read · 20 lines (folded)']);
  const open = text(frame(messages, [2]).body);
  expect(open.some((line) => line.startsWith('Tool: ToolSearch'))).toBe(true);
  expect(open.findIndex((line) => line.startsWith('Tool: ToolSearch'))).toBeLessThan(open.findIndex((line) => line.startsWith('Tool: Read')));
  // Display only: the session messages (what reaches the model) are untouched.
  expect(JSON.stringify(messages)).toBe(before);
});

test('history: a failed ToolSearch keeps its own row', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: 'look', ts },
    { role: 'tool', content: '', toolName: 'ToolSearch', toolResult: { error: 'catalog unavailable' }, ts },
  ];
  expect(text(frame(messages).body).some((line) => line.includes('ToolSearch'))).toBe(true);
});

test('detail blocks: a ToolSearch block rides on the next Read block — hidden folded, shown when Read is expanded', () => {
  const block = (id: string, title: string): MessageBlock => ({ id: `s:run-1:tool:${id}`, ts: 1, source: 'tool',
    body: { kind: 'tool-call', toolCallId: id, title, status: '완료' },
    detail: { level: 3, summary: `${title} done`, rawRef: { runId: 'run-1', blockId: `s:run-1:tool:${id}` } } });
  const messages: SerializedMessage[] = [{ role: 'user', content: 'look', ts }];
  const search = block('c1', 'ToolSearch');
  const read = block('c2', 'Read');
  const folded = text(frame(messages, [], [{ block: search, afterMessageIndex: 0 }, { block: read, afterMessageIndex: 0 }]).body);
  expect(folded.some((line) => line.includes('ToolSearch'))).toBe(false);
  expect(folded.some((line) => line.includes('Read done'))).toBe(true);
  const open = text(frame(messages, [], [{ block: search, afterMessageIndex: 0 }, { block: read, level: 3, afterMessageIndex: 0 }]).body);
  expect(open.some((line) => line.includes('ToolSearch'))).toBe(true);
});
