import { expect, test } from 'bun:test';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { nextVisibleFoldTarget, type NextTuiFoldTarget } from './render.js';

const blocks: MessageBlock[] = ['a', 'b'].map((id) => ({ id, ts: 1, source: 'agent',
  body: { kind: 'thought', text: id }, detail: { level: 3, summary: id } })) as MessageBlock[];
const targets: NextTuiFoldTarget[] = [
  { kind: 'message', id: 'a', start: 0, end: 0 },
  { kind: 'message', id: 'b', start: 1, end: 1 },
  { kind: 'tool', index: 2, start: 2, end: 2 },
];

test('visible MessageBlocks advance fairly, fold, then hand focus to saved tool rows', () => {
  const levels = new Map<string, 0 | 1 | 2 | 3>();
  const selected: string[] = [];
  let last: string | null = null;
  const advance = () => {
    const target = nextVisibleFoldTarget(targets, blocks, levels, last)!;
    const key = target.kind === 'message' ? `message:${target.id}` : `tool:${target.index}`;
    selected.push(key);
    last = key;
    if (target.kind === 'message') levels.set(target.id, ((levels.get(target.id) ?? 0) + 1) % 4 as 0 | 1 | 2 | 3);
  };
  for (let i = 0; i < 9; i += 1) advance();
  expect(selected).toEqual([
    'message:a', 'message:b', 'message:a', 'message:b', 'message:a', 'message:b',
    'message:a', 'message:b', 'tool:2',
  ]);
});
