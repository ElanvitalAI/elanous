import { expect, test } from 'bun:test';
import type { OpsSeats } from '@/lib/ops-api';
import type { HarnessRunsResponse } from '@/nexus/client';
import { leaksInternal } from './public-text';
import { loopAgentsView } from './loop-agents-view';
import { seatNowLine } from './loop-agents-view';

// The owner mark is built from its code point so the public-leak gate does not see a literal in this test.
const CROWN = String.fromCodePoint(0x1f451);

const time = Date.parse('2026-10-08T10:00:00.000Z');

test('four fixed public seats, one-line 40-character titles and unreadable distinct from zero', () => {
  const seats: OpsSeats = { date: '2026-10-08', seats: [
    { seat: 'UX', now: { text: CROWN + ' UX /home/alice/project run-a1b2c3d4-1234-abcd-9876-0123456789ab ' + '가'.repeat(50), at: '' }, landed: [], blocked: null, pendingDecisions: 0, checklist: null },
    { seat: 'OP', now: { text: '첫 줄\n둘째 줄', at: '' }, landed: null, blocked: [], pendingDecisions: null, checklist: null },
  ] };
  const view = loopAgentsView(seats, null, time);
  expect(view.seats.map((row) => row.seat)).toEqual(['COO', 'CMO', 'CTO', 'CXO']);
  expect(view.seats[0]).toEqual({ seat: 'COO', now: '첫 줄', landedToday: '못 읽음', blocked: 0, decisionsWaiting: '못 읽음' });
  expect(view.seats[1]).toEqual({ seat: 'CMO', now: '못 읽음', landedToday: '못 읽음', blocked: '못 읽음', decisionsWaiting: '못 읽음' });
  expect(view.seats[3].landedToday).toBe(0);
  expect(view.seats[3].blocked).toBe('못 읽음');
  expect(view.seats[3].decisionsWaiting).toBe(0);
  expect(Array.from(view.seats[3].now)).toHaveLength(40);
  expect(view.seats[3].now).toContain('CXO');
  expect(view.seats[3].now).toContain('run-a1b2c3');
  expect(leaksInternal(JSON.stringify(view))).toEqual([]);
});

test('only running runs, newest first, up to six; no raw run IDs, paths or private stages', () => {
  const entries: HarnessRunsResponse['entries'] = Array.from({ length: 9 }, (_, i) => ({
    runId: `run-${String(i).repeat(8)}-1234-abcd-9876-0123456789ab`, status: i === 3 ? 'complete' : 'running',
    lastActivityTimestamp: new Date(time - (i + 1) * 1_000).toISOString(),
    lastPhase: `🅣 TC /Users/alice/secret stage ${i}`,
  }));
  const view = loopAgentsView(null, { entries: entries.reverse() }, time);
  expect(view.runs).toHaveLength(6);
  expect(view.runs.map((run) => run.id6)).toEqual(['000000', '111111', '222222', '444444', '555555', '666666']);
  expect(view.runs[0]).toEqual({ id6: '000000', stage: 'CTO  stage 0', elapsedSec: 1 });
  expect(leaksInternal(JSON.stringify(view))).toEqual([]);
  expect(loopAgentsView(null, { entries: [{ runId: 'run-abcdef12-1234-abcd-9876-0123456789ab', status: 'running' }] }, time).runs[0])
    .toEqual({ id6: 'abcdef', stage: 'running', elapsedSec: '못 읽음' });
});

test('seat «now» drops the channel-post header, kind word and markdown (live 10-03: the header filled the 40 chars)', () => {
  expect(seatNowLine('**[COO]** 2026-10-03 11:50 KST → CXO · CTO — INSIDE1 장면 ③ 데이터 확인 부탁')).toBe('INSIDE1 장면 ③ 데이터 확인 부탁');
  expect(seatNowLine('**[CXO]** 2026-10-03 11:49 KST → 전원 — 정정 · main 빨강 수리 착지 #23121')).toBe('main 빨강 수리 착지 #23121');
  expect(seatNowLine('**[COO]** 2026-10-03 11:50 KST → CXO · C — 승인됨')).toBe('승인됨');
  expect(seatNowLine('**[OP]** 📌안내 2026-10-03 06:32 KST → 전원 — **0.2.10 착지 마감** 대조 끝\n- 둘째 줄')).toBe('0.2.10 착지 마감 대조 끝');
  expect(seatNowLine('**[CMO]** 2026-10-03 11:26 KST → COO · 보고 · I1 · V3 · 그림자 모드 켬')).toBe('I1 · V3 · 그림자 모드 켬');
  expect(seatNowLine('그냥 한 줄')).toBe('그냥 한 줄');
});

test('seat «now» uses the actual work after recipient lists, kind and emoji, or the next nonempty line', () => {
  expect(seatNowLine('**[OP]** 2026-10-03 13:12 KST → TC — ✅ **LEAK1 #23101 착지 승인**')).toBe('LEAK1 #23101 착지 승인');
  expect(seatNowLine('**[TC]** 2026-10-03 13:24 KST → OP · UX · MK\n\n**게이트 OOM 수리 착지**')).toBe('게이트 OOM 수리 착지');
  expect(seatNowLine('**[MK]** 2026-10-03 13:07 KST → OP · 보고 · 가속 · 13시 정시')).toBe('가속 · 13시 정시');
  expect(seatNowLine('**[UX]** 2026-10-03 13:13 KST → OP — 보고 · 13:00 정시(늦음) · 쏜 수 14 · 착지 수 10 · 막힘 0')).toBe('13:00 정시(늦음) · 쏜 수 14 · 착지 수 10 · 막힘 0');
  expect(seatNowLine('→ COO · 🙋 LEAK1 승인 요청')).toBe('LEAK1 승인 요청');
  expect(seatNowLine('→ CTO · CMO · ⚠️ 정정 · 수치 고침')).toBe('수치 고침');
  expect(seatNowLine('**[TC]** 2026-10-03 13:24 KST → OP · UX · MK')).toBe('');
  expect(seatNowLine('**[TC]** 2026-10-03 13:24 KST → OP · UX · MK\n\n- **📌 안내 · 게이트 OOM 수리 착지**')).toBe('게이트 OOM 수리 착지');
  const publicNow = seatNowLine('→ COO · ✅ 착지 /home/alice/project ' + 'a'.repeat(40));
  expect(publicNow).toBe('착지');
  expect(leaksInternal(publicNow)).toEqual([]);
});

test('a dash inside the body is content, only the dash after recipients is header (10-03 live posts)', () => {
  expect(seatNowLine('**[TC]** 2026-10-03 19:08 KST → OP · 보고 · TC 쏜 수(19:05~) **4** — HARV2 · PTY-DEMO')).toBe('CTO 쏜 수(19:05~) 4 — HARV2 · PTY-DEMO');
  expect(seatNowLine('**[UX]** 2026-10-03 19:20 KST → OP — 보고 · 정시 · 쏜 수 38')).toBe('정시 · 쏜 수 38');
  expect(seatNowLine('**[COO]** 2026-10-03 11:50 KST → CXO · CTO — INSIDE1 장면 ③ 데이터 확인 부탁')).toBe('INSIDE1 장면 ③ 데이터 확인 부탁');
});
