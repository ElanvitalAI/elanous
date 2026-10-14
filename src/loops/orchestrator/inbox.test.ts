import { expect, test } from 'bun:test';
import { MsgStore } from '../../msg/msg-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestratorNode } from './tick.js';
import { coordinatorReply, runCoordinatorInbox } from './inbox.js';

test('coordinator replies once with a conservative proposal, then acknowledges the request', () => {
  const store = new MsgStore(':memory:');
  try {
    const request = store.post({ from: 'MK', to: 'COORDINATOR', kind: 'request', body: 'TA-X hold 풀어도 되나' });
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
