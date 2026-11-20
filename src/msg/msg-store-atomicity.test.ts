// msg-store 트랜잭션 원자성 — transaction-review #38917 착지 보류 2결함의 실재현 시험.
// ① withPostedEvents 중첩 호출이 savepoint 없이 write() 를 실행해, 호출자가 catch 한 부분 쓰기(메시지+receipt)가 바깥 트랜잭션에 커밋됨.
// ② settleTaDelivery 의 claim 정리(DELETE FROM msg_ta_claim) 실패가 이미 커밋된 settle 성공을 뒤집어 보고됨.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { MsgStore } from './msg-store.js';

const FIXED = new Date('2026-11-19T09:00:00.000Z');
const stores: MsgStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const open = () => { const store = new MsgStore(':memory:', { now: () => FIXED }); stores.push(store); return store; };

test('중첩 트랜잭션에서 appendWithProvenance 의 provenance 쓰기 실패를 호출자가 catch 해도 부분 쓰기(메시지·posted 영수증)가 바깥 트랜잭션에 커밋되지 않는다', () => {
  const store = open();
  store.db.exec("CREATE TRIGGER fail_provenance BEFORE INSERT ON msg_provenance BEGIN SELECT RAISE(ABORT, 'provenance write failed'); END");
  let caught: unknown;
  store.db.transaction(() => {
    try { store.appendWithProvenance({ from: 'OP', to: 'TC', body: '부분-쓰기-재현' }, 'coord:pool4-atomicity:TC'); }
    catch (error) { caught = error; }
  }).immediate();
  expect(String(caught)).toContain('provenance write failed');
  // 메시지 행 자체가 바깥 커밋에 남지 않는다(orphan 0).
  expect(store.db.query('SELECT COUNT(*) AS count FROM msg_messages WHERE body = ?').get('부분-쓰기-재현')).toEqual({ count: 0 });
  expect(store.db.query('SELECT COUNT(*) AS count FROM msg_provenance').get()).toEqual({ count: 0 });
  // posted 영수증도 고아로 남지 않고, 수신자 목록에도 보이지 않는다.
  expect(store.db.query('SELECT COUNT(*) AS count FROM msg_receipts').get()).toEqual({ count: 0 });
  expect(store.list('TC')).toEqual([]);
  // 실패한 쓰기가 예약한 영수증 사건도 같이 버려진다 — 다음 성공 커밋에는 새 메시지의 사건만 발행된다.
  const events: unknown[] = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data: never) => {
    if (category === 'msg' && event === 'msg.receipt.posted') events.push(data);
  });
  try {
    const fresh = store.post({ from: 'OP', to: 'TC', body: '롤백-후-재시도' });
    expect(events.map((entry) => (entry as { msgId: number }).msgId)).toEqual([fresh.id]);
  } finally { spy.mockRestore(); }
});

test('settleTaDelivery: 커밋 후 claim 정리(DELETE FROM msg_ta_claim) 실패 주입(RAISE 트리거)이 저장된 settle 성공을 뒤집지 않는다 — true 반환·응답/배달 상태 유지(fail-open)', () => {
  const store = open();
  const request = store.post({ from: 'OP', to: 'TA', body: 'memo settle 원자성' });
  store.post({ from: 'TA', to: 'OP', body: 'pending', replyTo: request.id });
  store.setTaDeliveryStatus(request.id, 'pending');
  const token = store.claimTaDelivery(request.id)!;
  store.db.exec("CREATE TRIGGER fail_claim_delete BEFORE DELETE ON msg_ta_claim BEGIN SELECT RAISE(ABORT, 'claim cleanup failed'); END");
  // settle 본문(응답·배달 상태)은 커밋됐고, 커밋 후 정리 실패는 예외도 false도 아닌 true.
  expect(store.settleTaDelivery(request.id, token, 'delivered once', true)).toBe(true);
  expect(store.taDeliveryStatus(request.id)).toBe('delivered');
  expect(store.listReplies(request.id)[0]!.body).toBe('delivered once');
  // 정리 실패로 남은 claim 행: 라이벌 claim 차단은 유지되고(소유자 재settle 만 허용) 소리 없이 표류한다.
  expect(store.taDeliveryClaimState(request.id)).toBe('held');
  expect(store.db.query('SELECT COUNT(*) AS count FROM msg_ta_claim WHERE request_id = ?').get(request.id)).toEqual({ count: 1 });
  expect(store.claimTaDelivery(request.id)).toBeNull();
});
