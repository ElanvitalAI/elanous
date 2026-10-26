import { expect, test } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestratorNode } from './tick.js';
import { coordinatorReply, handleCoordinatorAgentMessage, runCoordinatorAgentInbox, runCoordinatorInbox } from './inbox.js';
import { LOOP_MESSAGE_ROUTES } from '../msg-address.js';
import { KNOWHOW_DOC_RELATIVE_PATH, readOnlyRunner, resolveKnowhowDocPath } from './knowhow-pack.js';
import type { LLMProvider } from '../../llm.js';
import { runAskOpContextInbox } from './inbox.js';

test('test /askop requires explicit sinks and records request-linked latency without production delivery', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TEST', to: 'COORDINATOR', kind: 'question',
      body: 'Test /askop\nquestion: Which release is next?' });
    const context = async () => ({ queriedAt: '2026-10-26T00:00:00Z', topic: 'release',
      facts: [], gaps: ['requested release fact absent'] });
    expect(await runAskOpContextInbox({ store, context, acknowledge: false }))
      .toEqual({ replied: 0, acknowledged: 0 });
    expect(store.listReplies(request.id)).toHaveLength(0);

    const sinkReplies: Array<{ from: string; to: string; body: string; kind: 'reply'; replyTo: number }> = [];
    const events: Array<{ requestId: number; requestToReplyMs: number | null; processingMs: number }> = [];
    expect(await runAskOpContextInbox({ store, context, testHarness: {
      replySink: input => { sinkReplies.push(input); return store.post(input); },
      eventSink: event => events.push(event),
    } })).toEqual({ replied: 1, acknowledged: 1 });
    expect(sinkReplies).toHaveLength(1);
    expect(sinkReplies[0]?.replyTo).toBe(request.id);
    expect(sinkReplies[0]?.to).toBe('TEST');
    expect(sinkReplies[0]?.body).toContain('모름 — 확인된 근거가 없어 답할 수 없습니다.');
    expect(store.listReplies(request.id)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).toBe(request.id);
    expect(events[0]?.requestToReplyMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.processingMs).toBeGreaterThanOrEqual(0);
    expect(events[0]?.processingMs).toBeLessThan(60_000);

    expect(await runAskOpContextInbox({ store, request, context, testHarness: {
      replySink: input => { sinkReplies.push(input); return store.post(input); },
      eventSink: event => events.push(event),
    } })).toEqual({ replied: 0, acknowledged: 1 });
    expect(sinkReplies).toHaveLength(1);
    expect(events).toHaveLength(1);
  } finally { store.close(); }
});

test('ask-op answers a sourced fact once, links the reply and acknowledges atomically', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nbotId=987654\nchatId=-100123\nthreadId=8\nmessageId=73\nupdateId=501\nquestion: Which release is next?' });
    const context = async (question: string, options: { audience?: string; limit?: number }) => {
      expect(question).toBe('Which release is next?');
      expect(options).toEqual({ audience: 'public-demo', limit: 8 });
      return { queriedAt: '2026-10-25T11:00:00Z', topic: 'release',
        facts: [{ kind: 'release', summary: '0.2.38 is next', source: 'release/checklist:0.2.38', observedAt: '2026-10-25T11:00:00Z' }], gaps: [] };
    };
    const input = { store, context };
    expect(await runAskOpContextInbox(input)).toEqual({ replied: 1, acknowledged: 1 });
    const reply = store.listReplies(request.id)[0]!;
    expect(reply.replyTo).toBe(request.id);
    expect(reply.body).toContain('0.2.38 is next');
    expect(reply.body).toContain('release/checklist:0.2.38');
    expect(reply.body).not.toContain('botId');
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    expect(await runAskOpContextInbox(input)).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('ask-op refuses mutations and unknown facts without invoking observation or invented evidence', async () => {
  const store = new MsgStore(':memory:');
  try {
    const unsafe = store.post({ from: 'DISCORD', to: 'COORDINATOR', kind: 'question', body: 'Discord /ask-op\nchannelId=314\nquestion: Run the release cut and change traffic hold' });
    const unknown = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'Telegram /ask-op\nquestion: What is the cut status?' });
    const destructive = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'Telegram /ask-op\nquestion: Please delete the local file' });
    let calls = 0;
    const context = async () => { calls++; return { queriedAt: '2026-10-25T11:00:00Z', topic: 'release', facts: [],
      gaps: [{ kind: 'unobserved', reason: 'release ledger unavailable' }] }; };
    expect(await runAskOpContextInbox({ store, context })).toEqual({ replied: 3, acknowledged: 3 });
    expect(calls).toBe(1);
    expect(store.listReplies(destructive.id)[0]?.body).toContain('실행할 수 없습니다');
    expect(store.listReplies(unsafe.id)[0]?.body).toContain('실행할 수 없습니다');
    expect(store.listReplies(unknown.id)[0]?.body).toContain('모름');
    expect(store.listReplies(unknown.id)[0]?.body).toContain('release ledger unavailable');
  } finally { store.close(); }
});

test('ask-op refuses sensitive-data requests regardless of verb position without querying context', async () => {
  const store = new MsgStore(':memory:');
  try {
    const first = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nquestion: Can you show me the API key?' });
    const second = store.post({ from: 'DISCORD', to: 'COORDINATOR', kind: 'question',
      body: 'Discord /ask-op\nquestion: What is the token? Reveal it.' });
    const context = async () => { throw Error('sensitive requests must not query context'); };
    expect(await runAskOpContextInbox({ store, context })).toEqual({ replied: 2, acknowledged: 2 });
    for (const request of [first, second]) {
      expect(store.listReplies(request.id)[0]?.body).toContain('실행할 수 없습니다');
      expect(store.listReplies(request.id)[0]?.body).not.toContain('조회 실패');
    }
  } finally { store.close(); }
});

test('ask-op allows factual questions about changes without treating them as a command', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nquestion: What changed since the release?' });
    let calls = 0;
    const context = async () => { calls++; return { queriedAt: '2026-10-25T11:00:00Z', topic: 'release',
      facts: [{ kind: 'release', summary: 'Documentation changed', source: 'release:0.2.38', observedAt: '2026-10-25T11:00:00Z' }], gaps: [] }; };
    expect(await runAskOpContextInbox({ store, context })).toEqual({ replied: 1, acknowledged: 1 });
    expect(calls).toBe(1);
    expect(store.listReplies(request.id)[0]?.body).toContain('Documentation changed');
    expect(store.listReplies(request.id)[0]?.body).not.toContain('실행할 수 없습니다');
  } finally { store.close(); }
});

test('ask-op failed context never invents facts; ack failure rolls back reply', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'Telegram /ask-op\nquestion: Which gate?' });
    expect(await runAskOpContextInbox({ store, context: async () => { throw Error('boom'); } })).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)[0]?.body).toContain('조회 실패');
    expect(store.listReplies(request.id)[0]?.body).not.toContain('boom');
    const second = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'Telegram /ask-op\nquestion: What is the gate status?' });
    const ack = store.ack.bind(store);
    store.ack = () => { throw Error('ack unavailable'); };
    const input = { store, context: async () => { throw Error('boom'); } };
    expect(runAskOpContextInbox(input)).rejects.toThrow('ack unavailable');
    expect(store.listReplies(second.id)).toHaveLength(0);
    store.ack = ack;
    expect(await runAskOpContextInbox(input)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(second.id)[0]?.body).toContain('조회 실패');
    expect(store.listReplies(second.id)[0]?.body).not.toContain('boom');
  } finally { store.close(); }
});

test('ask-op follows the agent SSE then ordered tick path without repeating a reply', async () => {
  const store = new MsgStore(':memory:');
  try {
    const first = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'request', body: 'first?' });
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nbotId=22\nchatId=23\nquestion: What is next?' });
    let queried = 0;
    const context = async () => { queried++; return { queriedAt: '2026-10-25T11:00:00Z', topic: 'next',
      facts: [{ kind: 'cell', summary: 'Next: OP', source: 'checklist:0.2.38', observedAt: '2026-10-25T11:00:00Z' }], gaps: [] }; };
    const input = { store, context };
    expect(await runAskOpContextInbox({ ...input, request, acknowledge: false })).toEqual({ replied: 1, acknowledged: 0 });
    expect(store.getCursor('COORDINATOR')).toBe(0);
    expect(await runAskOpContextInbox(input)).toEqual({ replied: 1, acknowledged: 2 });
    expect(queried).toBe(1);
    expect(store.listReplies(first.id)).toHaveLength(1);
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('unmarked surface question keeps the resident path and cannot read the context bundle', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question', body: 'What is next?' });
    expect(await runAskOpContextInbox({ store,
      context: async () => { throw Error('unmarked request must not query context'); }, knowhow: false }))
      .toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)[0]?.body).toContain('모름');
  } finally { store.close(); }
});

test('agent intake answers an ambiguous request once across SSE replay and tick scan', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'request', body: 'Which gate blocks this?' });
    let runs = 0;
    const input = { store, role: { provider: 'grok' as const, model: 'grok-4.6' }, pack: 'L0',
      runAgent: async () => { runs++; return 'Proposal: inspect gate logs. Evidence: no result supplied.'; } };
    expect(await handleCoordinatorAgentMessage(request, input)).toEqual({ replied: 1, acknowledged: 0 });
    expect(await handleCoordinatorAgentMessage(request, input)).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.getCursor('COORDINATOR')).toBe(0);
    expect(await runCoordinatorAgentInbox(input)).toEqual({ replied: 0, acknowledged: 1 });
    expect(runs).toBe(1);
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('out-of-order SSE reply leaves earlier request for ordered tick scan', async () => {
  const store = new MsgStore(':memory:');
  try {
    const first = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: 'first?' });
    const later = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'request', body: 'later?' });
    const input = { store, role: { provider: 'grok' as const, model: 'grok-4.6' }, pack: 'L0',
      runAgent: async ({ request }: { request: { id: number } }) => `Proposal for #${request.id}` };
    expect(await handleCoordinatorAgentMessage(later, input)).toEqual({ replied: 1, acknowledged: 0 });
    expect(store.getCursor('COORDINATOR')).toBe(0);
    expect(await runCoordinatorAgentInbox(input)).toEqual({ replied: 1, acknowledged: 2 });
    expect(store.listReplies(first.id)).toHaveLength(1);
    expect(store.listReplies(later.id)).toHaveLength(1);
    expect(store.getCursor('COORDINATOR')).toBe(later.id);
  } finally { store.close(); }
});

test('explicit coordinator role sends definite traffic wording through the agent', async () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'request', body: 'TC 자리: 손 구현 착수' });
    let runs = 0;
    await runCoordinatorAgentInbox({ store, role: { provider: 'grok', model: 'grok-4.6' }, pack: 'L0',
      runAgent: async () => { runs++; return 'Observed start; propose hold, no traffic write.'; } });
    expect(runs).toBe(1);
    expect(store.listReplies(request.id)[0]?.body).toContain('Observed start');
  } finally { store.close(); }
});

test('coordinator replies once with a conservative proposal, then acknowledges the request', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'MK', to: LOOP_MESSAGE_ROUTES.orchestrator.msgAddress, kind: 'request', body: 'TA-X hold 풀어도 되나' });
    expect(runCoordinatorInbox(store)).toEqual({ replied: 1, acknowledged: 1 });
    const replies = store.list('MK');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toStartWith('제안: 모름 — OP/자리 판단 필요\n근거:');
    expect(replies[0]!.replyTo).toBe(request.id);
    expect(store.listReplies(request.id).map(reply => reply.id)).toEqual([replies[0]!.id]);
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    expect(runCoordinatorInbox(store)).toEqual({ replied: 0, acknowledged: 0 });
    expect(store.list('MK')).toHaveLength(1);
  } finally { store.close(); }
});

test('clear start and first-line signals only propose hold and UNHOLD', () => {
  const store = new MsgStore(':memory:');
  try {
    const start = store.post({ from: 'TC', to: 'COORDINATOR', body: 'TC 자리: 손 구현 착수' });
    const firstLine = store.post({ from: 'UX', to: 'COORDINATOR', body: 'UX 자리: 첫 줄 확정' });
    expect(coordinatorReply(start)).toContain('제안: hold 제안');
    expect(coordinatorReply(firstLine)).toContain('제안: UNHOLD 제안');
    expect(coordinatorReply({ ...firstLine, body: '첫 줄 확정됐나?' })).toContain('제안: 모름');
    const question = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'question', body: 'UX 자리: 첫 줄 확정' });
    expect(coordinatorReply(question)).toContain('제안: 모름 — OP/자리 판단 필요');
    expect(runCoordinatorInbox(store)).toEqual({ replied: 3, acknowledged: 3 });
    expect(store.list('TC')[0]!.body).toContain('실제 잠금 변경은 수행하지 않았습니다.');
    expect(store.list('MK')[0]!.body).toContain('제안: 모름 — OP/자리 판단 필요');
  } finally { store.close(); }
});

test('failed reply does not acknowledge and retry sends one answer', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: '판정 요청' });
    const post = store.post.bind(store);
    store.post = () => { throw new Error('reply unavailable'); };
    expect(() => runCoordinatorInbox(store)).toThrow('reply unavailable');
    expect(store.getCursor('COORDINATOR')).toBe(0);
    store.post = post;
    expect(runCoordinatorInbox(store)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    expect(store.list('MK')).toHaveLength(1);
  } finally { store.close(); }
});

test('a failed acknowledgement rolls back the reply, so retry cannot duplicate it', () => {
  const store = new MsgStore(':memory:');
  try {
    store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: '확인 요청' });
    const ack = store.ack.bind(store);
    store.ack = () => { throw new Error('ack unavailable'); };
    expect(() => runCoordinatorInbox(store)).toThrow('ack unavailable');
    expect(store.list('MK')).toHaveLength(0);
    store.ack = ack;
    expect(runCoordinatorInbox(store).replied).toBe(1);
    expect(store.list('MK')).toHaveLength(1);
  } finally { store.close(); }
});

test('an earlier re #id reply is reused rather than sent again', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', body: '방법 확인' });
    store.post({ from: 'COORDINATOR', to: 'TC', kind: 'reply', body: `re #${request.id}\n제안: 기존 답` });
    expect(runCoordinatorInbox(store)).toEqual({ replied: 0, acknowledged: 1 });
    expect(store.list('TC')).toHaveLength(1);
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
  } finally { store.close(); }
});

test('a linked reply is reused if the request is retried before acknowledgement', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', body: '방법 확인' });
    store.post({ from: 'COORDINATOR', to: 'TC', kind: 'reply', body: '제안: 기존 답', replyTo: request.id });
    expect(runCoordinatorInbox(store)).toEqual({ replied: 0, acknowledged: 1 });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally { store.close(); }
});

test('a legacy marker on another thread does not consume this request', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', body: '첫 질문' });
    const other = store.post({ from: 'TC', to: 'COORDINATOR', body: '다른 질문' });
    store.post({ from: 'COORDINATOR', to: 'TC', kind: 'reply', body: `re #${request.id}\n제안: 다른 답`, replyTo: other.id });
    expect(runCoordinatorInbox(store, 1)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.listReplies(request.id)).toHaveLength(1);
    expect(store.listReplies(request.id)[0]!.body).toStartWith('제안:');
  } finally { store.close(); }
});

test('a structured reply takes precedence over a legacy marker', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', body: '방법 확인' });
    store.post({ from: 'COORDINATOR', to: 'TC', kind: 'reply', body: `re #${request.id}\n제안: 옛 답` });
    const linked = store.post({ from: 'COORDINATOR', to: 'TC', kind: 'reply', body: '제안: 새 답', replyTo: request.id });
    expect(runCoordinatorInbox(store)).toEqual({ replied: 0, acknowledged: 1 });
    const receipt = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
      .get(`coord-inbox:${request.id}:TC`) as { message_id: number };
    expect(receipt.message_id).toBe(linked.id);
  } finally { store.close(); }
});

test('untyped msg post requests are drained in bounded ticks without lost answers', () => {
  const store = new MsgStore(':memory:');
  try {
    const questions = Array.from({ length: 3 }, (_, i) => store.post({ from: 'MK', to: 'COORDINATOR', body: `질문 ${i + 1}` }));
    expect(runCoordinatorInbox(store, 2)).toEqual({ replied: 2, acknowledged: 2 });
    expect(store.getCursor('COORDINATOR')).toBe(questions[1]!.id);
    expect(runCoordinatorInbox(store, 2)).toEqual({ replied: 1, acknowledged: 1 });
    expect(store.getCursor('COORDINATOR')).toBe(questions[2]!.id);
    expect(store.list('MK').map(reply => reply.replyTo)).toEqual(questions.map(question => question.id));
    expect(store.list('MK').every(reply => reply.body.startsWith('제안:'))).toBe(true);
  } finally { store.close(); }
});

test('orchestrator intake uses its isolated root and replies in shadow mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-inbox-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    const request = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: '방법 맞나?' });
    await runOrchestratorNode('intake', { root, runId: 'inbox-test', window: '08', mode: 'shadow', cards: () => [],
      now: new Date('2026-10-14T00:00:00Z') });
    expect(store.list('MK')).toHaveLength(1);
    expect(store.list('MK')[0]!.replyTo).toBe(request.id);
    expect(store.list('MK')[0]!.body).toStartWith('제안:');
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    const later = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'request', body: '다음 질문' });
    // Same completed runId and a noon window both still drain newly arrived messages.
    await runOrchestratorNode('intake', { root, runId: 'inbox-test', window: '08', mode: 'shadow',
      now: new Date('2026-10-14T00:00:00Z') });
    expect(store.list('TC')[0]!.replyTo).toBe(later.id);
    const afternoon = store.post({ from: 'UX', to: 'COORDINATOR', kind: 'request', body: '오후 질문' });
    await runOrchestratorNode('intake', { root, runId: 'inbox-noon', window: '12', mode: 'shadow',
      now: new Date('2026-10-14T03:00:00Z') });
    expect(store.list('UX')[0]!.replyTo).toBe(afternoon.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('production tick without OP role answers from the read-only bundle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-op-role-tick-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  const envName = 'ELANOUS_ROLE_LLM_COORDINATOR';
  const previous = process.env[envName];
  delete process.env[envName];
  try {
    const request = store.post({ from: 'TELEGRAM', to: 'COORDINATOR', kind: 'question',
      body: 'Telegram /ask-op\nbotId=1\nchatId=2\nquestion: What is the release?' });
    await runOrchestratorNode('intake', { root, runId: 'ask-op-role-unset', window: '08', mode: 'shadow',
      now: new Date('2026-10-25T00:00:00Z'), coordinatorContext: async () => ({ queriedAt: '2026-10-25T00:00:00Z', topic: 'release',
        facts: [{ kind: 'release', summary: '0.2.39 is next', source: 'release:0.2.39', observedAt: '2026-10-25T00:00:00Z' }], gaps: [] }) });
    const reply = store.listReplies(request.id)[0];
    expect(reply?.body).toContain('0.2.39 is next');
    expect(reply?.body).toContain('release:0.2.39');
    expect(reply?.replyTo).toBe(request.id);
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    await runOrchestratorNode('intake', { root, runId: 'ask-op-role-unset-noon', window: '12', mode: 'shadow',
      now: new Date('2026-10-25T03:00:00Z') });
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('configured coordinator uses the agent body once and leaves traffic untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-agent-tick-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  const envName = 'ELANOUS_ROLE_LLM_COORDINATOR';
  const previous = process.env[envName];
  const trafficPath = join(root, 'traffic.json');
  const traffic = '{"UX":{"signal":"hold"}}\n';
  writeFileSync(trafficPath, traffic);
  process.env[envName] = JSON.stringify({ provider: 'grok', model: 'grok-4.6' });
  let runs = 0;
  try {
    const request = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'question', body: 'Which gate blocks this?' });
    const options = { root, runId: 'agent-inbox', window: '08' as const, mode: 'shadow' as const,
      now: new Date('2026-10-14T00:00:00Z'), coordinatorAgentRun: async () => { runs++; return 'Inspect the gate log first.'; } };
    await runOrchestratorNode('intake', options);
    await runOrchestratorNode('intake', options);
    expect(runs).toBe(1);
    expect(store.listReplies(request.id)).toHaveLength(1);
    expect(store.listReplies(request.id)[0]!.body).toBe('Inspect the gate log first.');
    expect(store.getCursor('COORDINATOR')).toBe(request.id);
    expect(readFileSync(trafficPath, 'utf8')).toBe(traffic);
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('real tick runTurn denies a model Write call and preserves traffic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-agent-tool-tick-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  const trafficPath = join(root, 'traffic.json');
  writeFileSync(trafficPath, 'original\n');
  const envName = 'ELANOUS_ROLE_LLM_COORDINATOR';
  const previousRole = process.env[envName];
  const previousSessionRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env[envName] = JSON.stringify({ provider: 'local', model: 'fake-local' });
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  let rounds = 0;
  let sawDenial = false;
  const provider: LLMProvider = {
    name: 'local', defaultModel: 'fake-local', available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages) {
      rounds++;
      if (rounds === 1) yield { type: 'tool_call', id: 'write-traffic', name: 'Write',
        args: { file_path: trafficPath, content: 'tampered\n' } };
      else {
        sawDenial = JSON.stringify(messages).includes('L0 denied');
        yield { type: 'text', delta: 'The write was denied; traffic stays unchanged.' };
      }
    },
  };
  try {
    const request = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'question', body: 'Can you change traffic.json?' });
    await runOrchestratorNode('intake', { root, runId: 'real-tool-path', window: '08', mode: 'shadow',
      coordinatorAgentProvider: provider, now: new Date('2026-10-14T00:00:00Z') });
    expect(rounds).toBe(2);
    expect(sawDenial).toBe(true);
    expect(readFileSync(trafficPath, 'utf8')).toBe('original\n');
    expect(store.listReplies(request.id)).toHaveLength(1);
  } finally {
    if (previousRole === undefined) delete process.env[envName]; else process.env[envName] = previousRole;
    if (previousSessionRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT;
    else process.env.ELANOUS_SESSION_ROOT = previousSessionRoot;
    store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('disabled orchestrator leaves coordinator requests unread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-inbox-off-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  try {
    store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: '질문' });
    await runOrchestratorNode('intake', { root, runId: 'inbox-off', window: '08', mode: 'off',
      now: new Date('2026-10-14T00:00:00Z') });
    expect(store.list('MK')).toHaveLength(0);
    expect(store.getCursor('COORDINATOR')).toBe(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

// ── resident OP knowhow pack (K3) on the production intake path ────────────────────────────

/**
 * Fake-bin measurement stage. The production read-only allowlist and the placeholder
 * refusal run for real (`readOnlyRunner` over the repository); only the binary's stdout is
 * canned. A doc command that production would refuse therefore cannot slip through here on
 * a canned output that happens to match the item's 기대.
 */
function measurementStage(output: string) {
  const commands: string[] = [];
  const docPath = resolveKnowhowDocPath()!;
  const repoRoot = docPath.slice(0, -(KNOWHOW_DOC_RELATIVE_PATH.length + 1));
  const guarded = readOnlyRunner(repoRoot);
  return {
    commands,
    run: (command: string) => {
      commands.push(command);
      const refusal = guarded(command);
      return refusal.skipped ? refusal : { status: 0, output };
    },
  };
}

async function askOPDesk(question: string, output: string, knowhowOff = false, docPath = resolveKnowhowDocPath()!) {
  const root = mkdtempSync(join(tmpdir(), 'coord-knowhow-'));
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  const stage = measurementStage(output);
  try {
    const request = store.post({ from: 'TC', to: 'COORDINATOR', kind: 'question', body: question });
    const knowhow = knowhowOff ? false : { docPath, runCommand: stage.run };
    await runOrchestratorNode('intake', { root, runId: 'coord-knowhow', window: '08', mode: 'shadow',
      coordinatorKnowhow: knowhow, now: new Date('2026-10-14T00:00:00Z') });
    const replies = store.listReplies(request.id);
    expect(replies).toHaveLength(1);
    return { body: replies[0]!.body, commands: stage.commands };
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

// Tonight's question sample 1: the landing train refused a branch because it is behind main.
const LANDING_QUESTION = 'PR #27423 이 «main 보다 뒤» 라며 착지가 거부됐다. rejudge 해도 fromHead 와 toHead 가 같다. 어떻게 하나?';

test('behind-main landing question is answered from the resident pack with K-OP-083', async () => {
  const { body, commands } = await askOPDesk(LANDING_QUESTION, '2\n');
  expect(body).toContain('K-OP-083');
  expect(body).toContain('기대 일치');
  expect(body).toContain('재는 명령: `rg -c');
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('rejudge-on-head.ts');
});

// Tonight's question sample 2: same question, but the item no longer measures what it claims.
test('contradicted measurement degrades the same question to 모름 with a staleness flag', async () => {
  const { body } = await askOPDesk(LANDING_QUESTION, '0\n');
  expect(body.startsWith('제안: 모름')).toBe(true);
  expect(body).toContain('낡음 의심 (K-OP-083)');
  expect(body).not.toContain('제안: K-OP-083');
});

// Tonight's question sample 3: nothing in the pack matches, so the question is kept as a candidate.
test('an unmatched question answers 모름 and records the 노하우 후보', async () => {
  const question = '점심 회의실 예약은 어디서 하나?';
  const { body, commands } = await askOPDesk(question, '2\n');
  expect(body).toContain('제안: 모름 — OP/자리 판단 필요');
  expect(body).toContain(`노하우 후보: ${question}`);
  expect(commands).toHaveLength(0);
});

test('the fixed traffic rule still answers alone when the pack is switched off', async () => {
  const { body, commands } = await askOPDesk(LANDING_QUESTION, '2\n', true);
  expect(body).toContain('제안: 모름');
  expect(body).toContain('노하우 후보:');
  expect(body).not.toContain('K-OP-083');
  expect(commands).toHaveLength(0);
});

test('a doc command outside the read-only allowlist never runs on the production path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coord-knowhow-doc-'));
  const docPath = join(root, 'KNOWHOW.md');
  writeFileSync(docPath, [
    '## K-OP-902 착지 거부 재게이트',
    '- 상황: PR 이 «main 보다 뒤» 라며 착지가 거부됐다 · rejudge 해도 fromHead 와 toHead 가 같다',
    '- 신호: 착지 거부 · fromHead 와 toHead 가 같다',
    '- 재는 명령: `eln tasks rejudge 27423`',
    '- 기대: 2 줄',
    '- 처방(힐링): 같은 가지에 merge 해 새 머리를 만든 뒤 rejudge 한다',
    '- 출처: test · 상태: active',
    '',
    '## K-OP-903 문서 지도',
    '- 상황: 새 자리가 운영 지침 위치를 못 찾는다',
    '- 신호: main 이력에도 안 뜬다',
    '- 재는 명령: `rg -c KNOWHOW docs/_index.md`',
    '- 기대: ≥1',
    '- 처방(힐링): 지도에 한 줄 남긴다',
    '- 출처: test · 상태: active',
    '',
  ].join('\n'));
  try {
    const { body, commands } = await askOPDesk(LANDING_QUESTION, '2\n', false, docPath);
    expect(body).toContain('K-OP-902');
    expect(body).toContain('재지 못함 — eln tasks is not read-only (읽기 전용 허용 목록 밖)');
    expect(body).toContain('재지 못함 — 사람 확인');
    expect(commands).toHaveLength(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
