import { expect, test } from 'bun:test';
import type { OpsSeat, OpsSeats } from '@/lib/ops-api';
import { seatsNowLine } from './seats-now-line';

const clock = Date.parse('2026-10-03T04:30:00Z');
function row(seat: OpsSeat['seat'], text: string | null, secondsAgo = 30): OpsSeat {
  return {
    seat, now: text === null ? null : { text, at: new Date(clock - secondsAgo * 1000).toISOString() },
    landed: null, blocked: null, pendingDecisions: null, checklist: null,
  };
}
const data = (...seats: OpsSeat[]): OpsSeats => ({ date: '2026-10-03', seats });

test('fixed COO CMO CTO CXO order, public header cleaning, Unicode 24 code points and age buckets', () => {
  const raw = '**[UX]** 2026-10-03 13:13 KST → OP — 보고 · 가나다라마바사아자차카타파하가나다라마바사아자차카타파하 끝';
  expect(seatsNowLine(data(
    row('UX', raw, 30 * 3600),
    row('TC', '구현 확인', 2 * 3600),
    row('MK', '공개 준비', 5 * 60),
    row('OP', '현재 조율', 30),
  ), clock)).toEqual([
    { seat: 'COO', text: '현재 조율', ago: '방금' },
    { seat: 'CMO', text: '공개 준비', ago: '5분 전' },
    { seat: 'CTO', text: '구현 확인', ago: '2시간 전' },
    { seat: 'CXO', text: '가나다라마바사아자차카타파하가나다라마바사아자차', ago: '하루 넘음' },
  ]);
});

test('skips null and cleaned-empty rows; zero rows and null input yield []', () => {
  expect(seatsNowLine(data(row('OP', null), row('TC', '**[TC]** 2026-10-03 13:13 KST → OP — 보고 ·   '), row('UX', '실제 작업', 60)), clock))
    .toEqual([{ seat: 'CXO', text: '실제 작업', ago: '1분 전' }]);
  expect(seatsNowLine(data(row('OP', null), row('MK', null), row('TC', null), row('UX', null)), clock)).toEqual([]);
  expect(seatsNowLine(null, clock)).toEqual([]);
});

test('public text masks a private path before truncating', () => {
  const [line] = seatsNowLine(data(row('OP', '/home/ubuntu/.ssh/id_rsa 진행 중')), clock);
  expect(line!.text).not.toContain('/home/ubuntu');
  expect(line!.text).toContain('진행 중');
});
