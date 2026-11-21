// #122460 (OP 🔴 P0 · TC-H-CX-16 postland 실측) — «처리 전 seen» 금지: tool-ack 은 커서만 전진한다.
//
// CX-16 실측(2026-11-21 · main 3988ca593a64): 양성 2통은 원문 처리 전(11:08:00.276)에 tool-ack 로 seen 이 찍혔고
// (답 11:08:02.699 · seen 영수 queueItemId 공백), 정답 턴의 queue 결속 seen(arrival 경로)은 not-forward 로 밀렸다.
// 규격(#122460): seen/ack = 그 msgId 원문을 답한 answered-turn 완료(runId 결속)에만 · tool-ack 로 seen 금지.
// #38305 의 손-ack(cli-ack) 은 보존 — 터미널의 사람 눈은 eyes-on 근거이므로 seen 을 남긴다.
import { afterEach, expect, test } from 'bun:test';
import { MsgStore } from './msg-store.js';

const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const open = () => { const store = new MsgStore(':memory:'); stores.push(store); return store; };

test('#122460 ①② MsgAck(tool-ack) 은 커서만 전진 — 답한 턴이 있기 전엔 seen 이 없다', () => {
  const store = open();
  const first = store.post({ from: 'OP', to: 'TC', body: 'P0 지시', intent: 'request' });
  const second = store.post({ from: 'OP', to: 'TC', body: '추가 지시' });
  const moved = store.ackThroughSeen('TC', second.id, 'tool-ack');
  expect(moved).toBe(second.id);
  expect(store.listReceipts({ messageId: first.id }).filter(r => r.state === 'seen')).toEqual([]);
  expect(store.listReceipts({ messageId: second.id }).filter(r => r.state === 'seen')).toEqual([]);
});

test('#122460 ①② 답한 턴의 queue 결속 seen(tui-queue) 은 tool-ack 뒤에도 그대로 선다(#38483 회귀)', () => {
  const store = open();
  const posted = store.post({ from: 'OP', to: 'TC', body: 'queue 결속', intent: 'request' });
  expect(store.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'delivered', source: 'tui-queue', queueItemId: 'q1' }).recorded).toBe(true);
  const moved = store.ackThroughSeen('TC', posted.id, 'tool-ack');
  expect(moved).toBe(posted.id);
  expect(store.recordReceipt({ messageId: posted.id, recipient: 'TC', state: 'seen', source: 'tui-queue', queueItemId: 'q1' }).recorded).toBe(true);
  const seen = store.listReceipts({ messageId: posted.id }).filter(r => r.state === 'seen');
  expect(seen.map(r => r.source)).toEqual(['tui-queue']);
  expect(seen.map(r => r.queueItemId)).toEqual(['q1']);
  expect(store.messageStatus('TC', posted.id)).toBe('acked');
});

test('#38305 회귀 — 손-ack(cli-ack) 은 seen 을 그대로 남긴다', () => {
  const store = open();
  const posted = store.post({ from: 'OP', to: 'TC', body: '손-ack' });
  store.ackThroughSeen('TC', posted.id, 'cli-ack');
  expect(store.listReceipts({ messageId: posted.id }).filter(r => r.state === 'seen').map(r => r.source)).toEqual(['cli-ack']);
});