import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { SerializedMessage } from '../session/index.js';
import { foldLedgerReply, foldRepeatedReply } from './reply-delta-fold.js';
import { createNextTuiQueue } from './core/queue.js';
import { createQueueIdleWatchdog } from './core/queue-idle-watchdog.js';

/**
 * SEAT-REPLY-DELTA-ONLY (대표 11-25 «eln OP repeats the same content like a parrot»). Expectations are literals (rule 11).
 */

const user = (content: string): SerializedMessage => ({ role: 'user', content, ts: '2026-11-25T10:00:00.000Z' });
const answer = (content: string, ts: string): SerializedMessage => ({ role: 'assistant', content, ts, replyFinal: true });

const A1 = [
  '아직 #39151 착지가 확인되지 않았습니다',
  '- 기존 추적선 유지: TC 가 pregate 재시도 중',
  '- JUD 서명 대기',
  '다음 점검 14:30',
].join('\n');
const A2 = [
  '아직 #39151 착지가 확인되지 않았습니다',
  '- 기존 추적선 유지: TC 가 pregate 재시도 중',
  '- JUD 서명 대기',
  '- minim5 pregate RED 1건 새로 보임',
  '다음 점검 15:00',
].join('\n');

describe('reply delta guard', () => {
  test('two notice-opened turns with near-identical answers: the second folds to one line', () => {
    const ledger = [user('[seat mail #1] TC info'), answer(A1, '2026-11-25T10:00:01.000Z'),
      user('[seat mail #2] TC info'), answer(A2, '2026-11-25T10:30:01.000Z')];
    const out = foldLedgerReply(ledger, true);
    expect(out).not.toBeNull();
    expect(out!.messages[3]!.content).toBe('변화 없음 · minim5 pregate RED 1건 새로 보임 · 다음 15:00');
    expect(out!.messages[3]!.content.includes('\n')).toBe(false);
    // The full text stays in the ledger row; the earlier rows are untouched.
    expect(out!.messages[3]!.replyDeltaFull).toBe(A2);
    expect(out!.messages[1]!.content).toBe(A1);
    expect(out!.fold.sameFirstLine).toBe(true);
  });

  test('a changed first line with the same body still folds by similarity', () => {
    const b = A1.replace('아직 #39151 착지가 확인되지 않았습니다', '#39151 착지 아직 확인되지 않았습니다');
    const fold = foldRepeatedReply(A1, b);
    expect(fold).not.toBeNull();
    expect(fold!.sameFirstLine).toBe(false);
    expect(fold!.folded).toBe('변화 없음 · 다음 14:30');
  });

  test('a third repeat compares with the kept full text of a folded row and folds again', () => {
    const ledger = [answer(A1, '2026-11-25T10:00:01.000Z'),
      { ...answer('변화 없음 · 다음 14:30', '2026-11-25T10:30:01.000Z'), replyDeltaFull: A1 },
      answer(A1, '2026-11-25T11:00:01.000Z')];
    expect(foldLedgerReply(ledger, true)!.messages[2]!.content).toBe('변화 없음 · 다음 14:30');
  });

  test('a human-opened turn is never folded', () => {
    const ledger = [user('상태?'), answer(A1, '2026-11-25T10:00:01.000Z'), user('상태 다시'), answer(A1, '2026-11-25T10:05:01.000Z')];
    expect(foldLedgerReply(ledger, false)).toBeNull();
  });

  test('different content is not folded', () => {
    const other = ['#39151 착지 완료 · main d2def7c', 'REL 에 발행 후보로 넘김', '남은 칸 2개는 UX 로 이관'].join('\n');
    expect(foldRepeatedReply(A1, other)).toBeNull();
    const ledger = [answer(A1, '2026-11-25T10:00:01.000Z'), answer(other, '2026-11-25T10:30:01.000Z')];
    expect(foldLedgerReply(ledger, true)).toBeNull();
  });

  test('the first answer of a session has nothing to repeat', () => {
    expect(foldLedgerReply([user('[seat mail #1] info'), answer(A1, '2026-11-25T10:00:01.000Z')], true)).toBeNull();
  });
});

describe('info-mail batching on an idle seat', () => {
  const T0 = new Date('2026-11-25T10:00:00Z').getTime();
  afterEach(() => { setSystemTime(); });
  const at = (ms: number): void => { setSystemTime(new Date(T0 + ms)); };

  test('3 info mails within 40 s on an idle seat open exactly one turn carrying all 3, at most 60 s + one stall window later', () => {
    at(0);
    const queue = createNextTuiQueue({ log: () => {}, turnLifeLog: () => {} });
    const turns: number[][] = [];
    let busy = false;
    const watchdog = createQueueIdleWatchdog({
      now: () => Date.now(), idle: () => !busy, queued: () => queue.autoDispatchCount,
      wake: () => {
        if (busy || queue.autoDispatchCount === 0) return true;
        const bundle = queue.drainNotices();
        if (bundle.kind === 'notices') turns.push(bundle.notices.map((n) => n.msgId!));
        busy = true;
        return true;
      },
      log: () => {}, stallMs: 5_000,
    });
    queue.onEnqueued(() => { watchdog.noteQueued(); });
    const info = (id: number): void => {
      queue.enqueueNotice(`[seat mail #${id}] TC info`, 'seat-mail', { msgId: id, passive: true, mailClass: 'P2', mailIntent: 'info' });
    };
    const run = (from: number, until: number): void => { for (let t = from; t <= until; t += 500) { at(t); watchdog.tick(); } };
    info(701);
    run(0, 20_000);
    info(702);
    run(20_500, 40_000);
    info(703);
    run(40_500, 59_500);
    expect(turns.length).toBe(0);
    run(60_000, 65_000);
    expect(turns).toEqual([[701, 702, 703]]);
    run(65_500, 200_000);
    expect(turns.length).toBe(1);
  });
});
