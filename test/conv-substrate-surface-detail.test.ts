import { expect, test } from 'bun:test';
import { createMessageBlockStream, makeToolCallBlockId, type MessageBlock } from '../src/conv-substrate/message-block.js';
import { CHAT_SURFACE_DETAIL, type ChatSurface } from '../src/conv-substrate/surface-detail.js';

test('R-SURFACE declarations have only maxDetail/defaultDetail and ordered bounds', () => {
  const expected = {
    tui: [3, 0],
    pwa: [2, 0],
    discord: [1, 0],
    telegram: [1, 0],
  } as const;
  for (const surface of Object.keys(expected) as ChatSurface[]) {
    const declaration = CHAT_SURFACE_DETAIL[surface];
    expect(Object.keys(declaration).sort()).toEqual(['defaultDetail', 'maxDetail']);
    expect(declaration.maxDetail).toBe(expected[surface][0]);
    expect(declaration.defaultDetail).toBe(expected[surface][1]);
    expect(declaration.defaultDetail).toBeLessThanOrEqual(declaration.maxDetail);
  }
});

test('one shared MessageBlock can advance from summary to steps to a raw lookup key', () => {
  const stream = createMessageBlockStream();
  const blockId = makeToolCallBlockId('session-1', 'call-1');
  const initial: MessageBlock = {
    id: blockId, ts: 100, source: 'tool',
    body: { kind: 'tool-call', toolCallId: 'call-1', title: 'Read', status: 'running' },
    detail: { level: 1, summary: 'Reading a file' },
  };
  stream.push(initial);
  expect(stream.snapshot()[0]?.detail).toEqual({ level: 1, summary: 'Reading a file' });
  stream.update(blockId, (current) => ({
    ...current,
    detail: { level: 2, summary: 'Read completed', steps: ['Opened file', 'Parsed 20 lines'] },
  }));
  expect(stream.snapshot()[0]?.detail).toEqual({ level: 2, summary: 'Read completed',
    steps: ['Opened file', 'Parsed 20 lines'] });
  stream.update(blockId, (current) => ({
    ...current,
    detail: { ...current.detail!, level: 3, rawRef: { runId: 'run-1', blockId } },
  }));

  const [block] = stream.snapshot();
  expect(block?.id).toBe(blockId);
  expect(block?.detail?.level).toBe(3);
  expect(block?.detail?.summary).toBe('Read completed');
  expect(block?.detail?.rawRef).toEqual({ runId: 'run-1', blockId });
  expect(block?.detail?.steps).toEqual(['Opened file', 'Parsed 20 lines']);
  expect(JSON.stringify(block)).not.toContain('rawInput');
  expect(JSON.stringify(block)).not.toContain('rawOutput');
});
