import { expect, test } from 'bun:test';
import { createAcpEventRouter } from './event-router.js';

test('replace metadata updates the turn answer after a status thought closed its active block', () => {
  const router = createAcpEventRouter();
  const stream = router.getStream('replace-test');
  router.noteUserSubmit('replace-test', '질문');
  router.ingest('replace-test', {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '선답' },
  });
  router.ingest('replace-test', {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '근거를 반영해 답변을 보강합니다.' },
  });
  router.ingest('replace-test', {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '최종 답변' },
    _meta: { elanous: { textOperation: 'replace' } },
  });

  expect(stream.snapshot().filter((block) => block.body.kind === 'assistant').map((block) =>
    block.body.kind === 'assistant' ? block.body.text : '')).toEqual(['최종 답변']);
  router.dropSession('replace-test');
});

test('transient status updates stay out of the conversation transcript', () => {
  const router = createAcpEventRouter();
  const stream = router.getStream('status-test');
  router.noteUserSubmit('status-test', '질문');
  router.ingest('status-test', {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ctx 410,000 chars / 400,000' },
    _meta: { status: true },
  });
  router.ingest('status-test', {
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '진행 근거' },
    _meta: { reasoning: true },
  });

  const blocks = stream.snapshot();
  expect(blocks.some((block) => JSON.stringify(block).includes('ctx 410,000'))).toBe(false);
  expect(blocks.some((block) => block.body.kind === 'thought' && block.body.text === '진행 근거')).toBe(true);
  router.dropSession('status-test');
});
