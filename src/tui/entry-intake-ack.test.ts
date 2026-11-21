// CEO-CHANNEL-INGRESS ⑤ JUD hold #123230 (request 123207 · OP #123241 P0) mustFix — RED first:
// the notice intake ack must ride the REAL turn start. The TUI's startChatTurn wrapper
// discarded runDoorTurn's false — a door-REFUSED reservation (busy, or the holder gone)
// runs no body and throws nothing, so the wrapper still fired `accepted` and the entry
// answered the honest 👀 for a NO-OP. The ack binds to the boolean instead:
// started → accepted (the honest 👀 moment); refused → failed (refusal answer — no 👀);
// a throwing start → failed + rethrow (afterDispatch still frees the unstarted hold).
import { describe, expect, test } from 'bun:test';
import { startChatTurnWithIntakeAck } from './entry.js';

describe('entry — the notice intake ack rides the REAL turn start (JUD hold #123230 mustFix)', () => {
  const wire = (startChatTurn: (text: string, status: string) => boolean) => {
    const intake: Array<{ id: string; status: string }> = [];
    const renders: number[] = [];
    const wrapped = startChatTurnWithIntakeAck({
      startChatTurn,
      notifyTurnIntake: (id, status) => { intake.push({ id, status }); },
      noticeId: 'q1',
      render: () => { renders.push(renders.length); },
    });
    return { wrapped, intake, renders };
  };

  test('#123230 — 예약 거부(runDoorTurn false·본문 미실행) → intake failed · accepted 0 — no-op 에 👀 없음', () => {
    let called = 0;
    const { wrapped, intake, renders } = wire((_text, _status) => { called += 1; return false; });
    wrapped('[TG-CEO tg-9/m-1] 지금 착지 몇 개?', '[notice · ceo-ingress] auto-submitted');
    expect(called).toBe(1);                                                    // the wrapper DID call the start…
    expect(intake).toEqual([{ id: 'q1', status: 'failed' }]);                 // …but a refusal is a failure, never accepted
    expect(intake.filter((i) => i.status === 'accepted')).toHaveLength(0);    // accepted 0 — no 👀 for a no-op
    expect(renders.length).toBe(1);                                           // the UI still re-renders on refusal
  });

  test('실제 턴 시작(true) → intake accepted — 👀의 정직한 시점', () => {
    const { wrapped, intake, renders } = wire(() => true);
    wrapped('[TG-CEO tg-9/m-1] 지금 착지 몇 개?', '[notice · ceo-ingress] auto-submitted');
    expect(intake).toEqual([{ id: 'q1', status: 'accepted' }]);
    expect(renders.length).toBe(1);
  });

  test('수락한 실제 턴의 session/run 결속만 intake 답에 싣는다', () => {
    const received: Array<{ status: string; turn?: { sessionId: string; turnRunId: string } }> = [];
    const turn = { sessionId: 'session-1', turnRunId: 'run-1' };
    const run = (startChatTurn: () => boolean) => startChatTurnWithIntakeAck({
      startChatTurn,
      notifyTurnIntake: (_id, status, accepted) => { received.push({ status, ...(accepted ? { turn: accepted } : {}) }); },
      acceptedTurn: () => turn,
      noticeId: 'ceo-1',
      render: () => {},
    });
    run(() => false)('notice', 'status');
    run(() => true)('notice', 'status');
    expect(received).toEqual([{ status: 'failed' }, { status: 'accepted', turn }]);
  });

  test('시작 도중 throw → intake failed + 재throw(render 없음) — 실패도 👀 아님', () => {
    const { wrapped, intake, renders } = wire(() => { throw new Error('render defect'); });
    expect(() => wrapped('[TG-CEO tg-9/m-1] 지금 착지 몇 개?', '[notice · ceo-ingress] auto-submitted'))
      .toThrow('render defect');
    expect(intake).toEqual([{ id: 'q1', status: 'failed' }]);
    expect(renders.length).toBe(0);
  });
});
