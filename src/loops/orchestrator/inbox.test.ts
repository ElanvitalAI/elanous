import { expect, test } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestratorNode } from './tick.js';
import { coordinatorReply, handleCoordinatorAgentMessage, runCoordinatorAgentInbox, runCoordinatorInbox } from './inbox.js';
import { LOOP_MESSAGE_ROUTES } from '../msg-address.js';
import type { LLMProvider } from '../../llm.js';

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
