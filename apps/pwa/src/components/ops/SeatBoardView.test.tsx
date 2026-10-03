import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeatBoardContent } from './SeatBoardView';
import type { OpsSeats } from '@/lib/ops-api';

const seats: OpsSeats = {
  date: '2026-10-02',
  seats: [
    { seat: 'UX', now: { text: '발표 준비\n/Users/private', at: '2026-10-02T00:00:00Z' }, landed: [{ pr: 22741, title: '공개 시연\naccount-1\nOPS3 비공개\n#22741 비공개', at: '2026-10-02T01:00:00Z', checklistId: 'OPS3' }], blocked: [{ id: 'OPS3', title: '검토 필요\nremote-2', status: 'red' }], pendingDecisions: 2, checklist: { green: 1, yellow: 2, red: 1, done: 3 } },
    { seat: 'OP', now: null, landed: null, blocked: null, pendingDecisions: null, checklist: null },
    { seat: 'TC', now: null, landed: [], blocked: [], pendingDecisions: 0, checklist: { green: 0, yellow: 0, red: 0, done: 0 } },
    { seat: 'MK', now: null, landed: [], blocked: [], pendingDecisions: 0, checklist: null },
  ],
};
const ready = { kind: 'ready' as const, data: seats };

describe('SeatBoardContent', () => {
  test('four cards order, unknown counts, and status bar remain distinct from zero', () => {
    const html = renderToStaticMarkup(<SeatBoardContent result={ready} refreshedAt="2026-10-02T00:00:00Z" />);
    expect([...html.matchAll(/aria-label="(COO|CMO|CTO|CXO) 자리"/g)].map((hit) => hit[1])).toEqual(['COO', 'CMO', 'CTO', 'CXO']);
    expect(html).toContain('오늘 착지 <strong class="text-3xl text-muted-foreground">못 읽음');
    expect(html).toContain('대표 결정 대기 <strong class="text-3xl ">0');
    expect(html).toContain('🟢');
    expect(html).toContain('22741');
    expect(html).toContain('OPS3');
    expect(html).toContain('발표 준비');
    expect(html).toContain('공개 시연');
    expect(html).toContain('검토 필요');
    expect(html).toContain('오늘 착지 <strong class="text-3xl text-muted-foreground">못 읽음</strong>');
    expect(html).toContain('막힘 <strong class="text-3xl text-muted-foreground">못 읽음</strong>');
    expect(html).toContain('결정 대기 <strong class="text-3xl text-muted-foreground">못 읽음</strong>');
    expect(html).toContain('마지막 갱신');
    expect(html).toContain('min-[1440px]:grid-cols-4');
  });
  test('public mode keeps safe lines and counts but drops forbidden lines and identifiers', () => {
    const privateSeats: OpsSeats = { ...seats, seats: seats.seats.map((seat) => seat.seat === 'UX' ? {
      ...seat,
      now: { text: '발표 준비\n/Users/private\n/home/ubuntu/.ssh/id_rsa\n비공개 계정 account-1\nSTAGE9 내부', at: '2026-10-02T00:00:00Z' },
      landed: [{ pr: 22741, title: '공개 시연\n계정 account-1\n/home/ubuntu/.ssh/id_rsa\n#22741 비공개\nSTAGE9 내부', at: '2026-10-02T01:00:00Z', checklistId: 'STAGE9' }],
      blocked: [{ id: 'OPS3', title: '검토 필요\n연결 remote-2\n/Users/private\nOPS3 비공개\nSTAGE9 내부', status: 'red' as const }],
    } : seat) };
    const html = renderToStaticMarkup(<SeatBoardContent result={{ kind: 'ready', data: privateSeats }} refreshedAt="2026-10-02T00:00:00Z" publicCapture />);
    for (const secret of ['22741', 'OPS3', 'STAGE9', '/Users/', 'account-1', 'remote-2', '/home/ubuntu/.ssh/id_rsa', '비공개']) expect(html).not.toContain(secret);
    for (const safe of ['오늘 착지', '막힘', '발표 준비', '공개 시연', '검토 필요', 'PUBLIC CAPTURE · 가린 화면', 'text-5xl']) expect(html).toContain(safe);
    expect(html).toContain('오늘 착지 <strong class="text-5xl ">1</strong>');
    expect(html).toContain('막힘 <strong class="text-5xl ">1</strong>');
    expect(html).toContain('flex min-h-screen flex-col text-base');
    expect(html).toContain('mt-auto border-t');
  });
  test('a complete board totals numbers including zero without inventing counts', () => {
    const complete: OpsSeats = { date: seats.date, seats: seats.seats.map((seat) => ({ ...seat,
      landed: seat.landed ?? [], blocked: seat.blocked ?? [], pendingDecisions: seat.pendingDecisions ?? 0 })) };
    const html = renderToStaticMarkup(<SeatBoardContent result={{ kind: 'ready', data: complete }} refreshedAt={null} />);
    expect(html).toContain('오늘 착지 <strong class="text-3xl">1</strong>');
    expect(html).toContain('막힘 <strong class="text-3xl">1</strong>');
    expect(html).toContain('결정 대기 <strong class="text-3xl">2</strong>');
  });
  test('403 renders only the operator message', () => {
    expect(renderToStaticMarkup(<SeatBoardContent result={{ kind: 'forbidden' }} refreshedAt={null} publicCapture />)).toBe('<p>운영자만 볼 수 있습니다</p>');
  });
});
