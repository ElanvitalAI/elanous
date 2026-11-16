import { expect, test } from 'bun:test';
import { createHarnessAskUserSession, harnessAskUserComposerLines } from './harness-ask-user-session.js';
import type { HarnessAskUserCall } from '../tui-client/next-harness-ask-user.js';

const call: HarnessAskUserCall = { type: 'elanous.harness-ask-user.call', callId: 'h1', sessionId: 'current',
  round: { questions: ['좌석 종류는?', '환불 규칙은?'], assumptions: ['한 좌석 한 주문'] } };

test('the host projects both questions and assumptions inside composer and restores the prior draft', async () => {
  const events: string[] = [];
  const host = createHarnessAskUserSession({ sessionId: () => 'current', canBegin: () => true,
    onBegin: () => { events.push('save-draft'); }, onSettled: () => { events.push('restore-draft'); },
    setStatus: (line) => { events.push(line); }, render: () => { events.push('paint'); } });
  const pending = host.begin(call);
  expect(harnessAskUserComposerLines(host.active()!)).toEqual([
    '질문 · 한 번 답변하면 이 라운드를 마칩니다', '1. 좌석 종류는?', '2. 환불 규칙은?', '가정 1. 한 좌석 한 주문',
  ]);
  const lines = harnessAskUserComposerLines(host.active()!);
  expect(host.viewport(lines, 2)).toEqual(lines.slice(0, 2));
  host.scroll('down');
  expect(host.viewport(lines, 2)).toEqual(lines.slice(1, 3));
  host.scroll('down');
  expect(host.viewport(lines, 2)).toEqual(lines.slice(2));
  host.submit('스탠딩과 지정석');
  expect(await pending).toBe('스탠딩과 지정석');
  expect(host.active()).toBeNull();
  expect(events).toContain('restore-draft');
});

test('empty, oversized and control-bearing replies settle unanswered and restore the exact draft', async () => {
  for (const answer of ['', 'x'.repeat(8193), 'bad\u0000reply']) {
    let draft = '기존 입력 초안';
    let saved = '';
    let restored = 0;
    const host = createHarnessAskUserSession({ sessionId: () => 'current', canBegin: () => true,
      onBegin: () => { saved = draft; draft = ''; },
      onSettled: () => { draft = saved; restored++; },
      setStatus: () => {}, render: () => {} });
    const pending = host.begin(call);
    expect(draft).toBe('');
    host.submit(answer);
    expect(await pending).toBeNull();
    expect(host.active()).toBeNull();
    expect(draft).toBe('기존 입력 초안');
    expect(restored).toBe(1);
  }
});

test('foreign session, absent approval boundary and matching cancellation leave no answer', async () => {
  const host = createHarnessAskUserSession({ sessionId: () => 'current', canBegin: () => true,
    onBegin: () => {}, onSettled: () => {}, setStatus: () => {}, render: () => {} });
  expect(await host.begin({ ...call, sessionId: 'foreign' })).toBeNull();
  const pending = host.begin(call);
  host.cancel('h999');
  expect(host.active()).not.toBeNull();
  host.cancel('h1');
  expect(await pending).toBeNull();
});
