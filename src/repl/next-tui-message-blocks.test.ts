import { expect, test } from 'bun:test';
import { createNextTuiMessageBlockEmitter } from './next-tui-message-blocks.js';

test('REPL adapter emits common MessageBlocks with references instead of tool payloads', () => {
  const emitted: Array<import('../conv-substrate/message-block.js').MessageBlock> = [];
  const emitter = createNextTuiMessageBlockEmitter({ sessionId: 'session-1', runId: 'run-1', emit: (block) => emitted.push(block) });

  emitter.toolCall({ id: 'call-1', name: 'Read', args: { path: '/private/secret.txt' } });
  const call = emitted.at(-1)!;
  expect(call.body.kind).toBe('tool-call');
  expect(call.detail?.rawRef).toEqual({ runId: 'run-1', blockId: 'session-1:run-1:tool:call-1' });
  expect(JSON.stringify(call)).not.toContain('/private/secret.txt');

  emitter.toolResult({ id: 'call-1', name: 'Read', result: { output: 'secret contents' } });
  const result = emitted.at(-1)!;
  expect(result.id).toBe(call.id);
  expect(result.ts).toBe(call.ts);
  expect(result.body.kind).toBe('tool-call');
  expect(result.detail?.level).toBe(3);
  expect(JSON.stringify(result)).not.toContain('secret contents');

  emitter.progress('검증을 진행합니다', ['파일 확인', '경계 확인']);
  expect(emitted.at(-1)?.detail).toMatchObject({ level: 2, summary: '검증을 진행합니다', steps: ['파일 확인', '경계 확인'] });
});
