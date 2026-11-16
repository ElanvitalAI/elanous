import { expect, test } from 'bun:test';
import { answerHarnessAskUserCall, createReplHarnessAsker, HARNESS_ASK_USER_IPC_ENV,
  isHarnessAskUserCall, parseHarnessAskUserRound, type HarnessAskUserIpcProcess } from './next-harness-ask-user.js';
import { buildReplTools } from '../repl/index.js';

class FakeIpc implements HarnessAskUserIpcProcess {
  sent: unknown[] = [];
  listeners = new Set<(value: unknown) => void>();
  send(value: unknown): boolean { this.sent.push(value); return true; }
  on(_event: 'message', listener: (value: unknown) => void): void { this.listeners.add(listener); }
  off(_event: 'message', listener: (value: unknown) => void): void { this.listeners.delete(listener); }
  receive(value: unknown): void { for (const listener of this.listeners) listener(value); }
}

const round = { questions: ['어떤 좌석을 팔까요?', '환불 규칙은요?'], assumptions: ['좌석 중복 판매는 금지'] };

test('the native request permits one or two bounded questions and inert assumptions', () => {
  expect(parseHarnessAskUserRound(round)).toEqual(round);
  expect(parseHarnessAskUserRound({ ...round, questions: [] })).toBeNull();
  expect(parseHarnessAskUserRound({ ...round, questions: [...round.questions, '셋째 질문'] })).toBeNull();
  expect(parseHarnessAskUserRound({ ...round, questions: ['비밀\u001b[2J'] })).toBeNull();
  expect(parseHarnessAskUserRound({ ...round, ownerId: 'self-declared-owner' })).toBeNull();
});

test('the real child request consumes only a matching host session and request ID reply', async () => {
  const ipc = new FakeIpc();
  const ask = createReplHarnessAsker(ipc, 'session-a', { [HARNESS_ASK_USER_IPC_ENV]: '1' })!;
  const pending = ask(round);
  const call = ipc.sent[0];
  expect(isHarnessAskUserCall(call)).toBe(true);
  if (!isHarnessAskUserCall(call)) throw new Error('expected native request');
  expect(call.sessionId).toBe('session-a');
  ipc.receive({ type: 'elanous.harness-ask-user.result', callId: call.callId,
    sessionId: 'session-b', answer: 'foreign answer' });
  ipc.receive({ type: 'elanous.harness-ask-user.result', callId: 'h999',
    sessionId: 'session-a', answer: 'late answer' });
  const host = await answerHarnessAskUserCall(async () => '좌석별 재고를 잠급니다', call);
  ipc.receive(host);
  expect(await pending).toBe('좌석별 재고를 잠급니다');
});

test('missing channel and cancelled request produce no synthetic answer', async () => {
  const ipc = new FakeIpc();
  expect(createReplHarnessAsker(ipc, 'session-a', {})).toBeNull();
  const ask = createReplHarnessAsker(ipc, 'session-a', { [HARNESS_ASK_USER_IPC_ENV]: '1' })!;
  const signal = new AbortController();
  const pending = ask(round, signal.signal);
  signal.abort();
  expect(await pending).toBeNull();
  expect(ipc.sent.at(-1)).toMatchObject({ type: 'elanous.harness-ask-user.cancel',
    sessionId: 'session-a', reason: 'turn-cancelled' });
});

test('an unanswered native request expires and a late answer cannot turn it into consent', async () => {
  const ipc = new FakeIpc();
  // Source: this fixture uses a short deadline to exercise the same production timeout branch.
  const fixtureTimeoutMs = 5;
  const ask = createReplHarnessAsker(ipc, 'session-a', { [HARNESS_ASK_USER_IPC_ENV]: '1' }, fixtureTimeoutMs)!;
  const pending = ask(round);
  const call = ipc.sent.find(isHarnessAskUserCall);
  if (!call) throw new Error('expected native request');
  expect(await pending).toBeNull();
  expect(ipc.sent.at(-1)).toMatchObject({ type: 'elanous.harness-ask-user.cancel',
    callId: call.callId, sessionId: 'session-a', reason: 'timeout' });
  ipc.receive(await answerHarnessAskUserCall(async () => 'late', call));
  expect(await pending).toBeNull();
});

test('the installed REPL tool permits one round per request, including a new request in the same session', async () => {
  const previous = process.env[HARNESS_ASK_USER_IPC_ENV];
  process.env[HARNESS_ASK_USER_IPC_ENV] = '1';
  try {
    const ipc = new FakeIpc();
    let requestId = 'request-1';
    const tools = buildReplTools({ sessionId: 'session-a', getRequestId: () => requestId, shellApprovalProcess: ipc,
      pluginRuntime: { hostTools: [], dispatchPluginTool: async () => ({ ok: false, error: 'unused' }) } });
    expect(tools.specs.map(spec => spec.name)).toContain('HarnessAskUser');
    const pending = tools.dispatch('HarnessAskUser', round);
    const call = ipc.sent.find(isHarnessAskUserCall);
    if (!call) throw new Error('REPL did not send the native interview request');
    ipc.receive(await answerHarnessAskUserCall(async () => '지정석만, 공연 하루 전까지', call));
    expect(await pending).toEqual({ status: 'answered', answer: '지정석만, 공연 하루 전까지',
      assumptions: round.assumptions });
    expect(await tools.dispatch('HarnessAskUser', round)).toEqual({ status: 'unanswered',
      reason: 'interview-round-already-used' });
    expect(ipc.sent.filter(isHarnessAskUserCall)).toHaveLength(1);
    requestId = 'request-2';
    const next = tools.dispatch('HarnessAskUser', round);
    const nextCall = ipc.sent.filter(isHarnessAskUserCall).at(-1);
    if (!nextCall || nextCall.callId === call.callId) throw new Error('new request did not get its own call');
    ipc.receive(await answerHarnessAskUserCall(async () => '새 요청의 사람 답변', nextCall));
    expect(await next).toMatchObject({ status: 'answered', answer: '새 요청의 사람 답변' });
    expect(ipc.sent.filter(isHarnessAskUserCall)).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env[HARNESS_ASK_USER_IPC_ENV];
    else process.env[HARNESS_ASK_USER_IPC_ENV] = previous;
  }
});

test('the native tool cannot spend an interview round without an active request', async () => {
  const previous = process.env[HARNESS_ASK_USER_IPC_ENV];
  process.env[HARNESS_ASK_USER_IPC_ENV] = '1';
  try {
    const ipc = new FakeIpc();
    const tools = buildReplTools({ sessionId: 'session-a', getRequestId: () => undefined,
      shellApprovalProcess: ipc,
      pluginRuntime: { hostTools: [], dispatchPluginTool: async () => ({ ok: false, error: 'unused' }) } });
    expect(await tools.dispatch('HarnessAskUser', round)).toEqual({ status: 'unanswered',
      reason: 'request-scope-unavailable' });
    expect(ipc.sent.filter(isHarnessAskUserCall)).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env[HARNESS_ASK_USER_IPC_ENV];
    else process.env[HARNESS_ASK_USER_IPC_ENV] = previous;
  }
});

test('missing IPC still registers the product tool and dispatch settles explicitly unanswered', async () => {
  const previous = process.env[HARNESS_ASK_USER_IPC_ENV];
  delete process.env[HARNESS_ASK_USER_IPC_ENV];
  try {
    const ipc = new FakeIpc();
    const tools = buildReplTools({ sessionId: 'session-a', getRequestId: () => 'request-a',
      shellApprovalProcess: ipc,
      pluginRuntime: { hostTools: [], dispatchPluginTool: async () => ({ ok: false, error: 'unused' }) } });
    expect(tools.specs.map(spec => spec.name)).toContain('HarnessAskUser');
    expect(await tools.dispatch('HarnessAskUser', round)).toEqual({ status: 'unanswered',
      reason: 'host-unavailable', assumptions: round.assumptions });
    expect(ipc.sent.filter(isHarnessAskUserCall)).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env[HARNESS_ASK_USER_IPC_ENV];
    else process.env[HARNESS_ASK_USER_IPC_ENV] = previous;
  }
});
