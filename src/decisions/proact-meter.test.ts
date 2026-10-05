import { expect, test } from 'bun:test';
import type { DecisionEntry, SeatDecisionRecord } from './decision-ledger.js';
import type { DirectiveRow } from '../directives/directive-index.js';
import type { CoordEvent } from '../context-bus/coord-events.js';
import { formatProactMeter, measureProact, proactKstDay, proactWindow, readProactMeter, type ProactLoopRow, type ProactMeterInput } from './proact-meter.js';

// Full index row (more fields than the meter reads) — the meter only needs ts · text · source_file · line_no.
const directiveRow: DirectiveRow = {
  ts: '2026-10-02T03:00:00.000Z', agent: 'claude-code', session_id: 's', cwd: null, track: 'OP',
  released: null, dev: null, codename: null, text: '이 문제 왜 안 되나', source_file: '/tmp/session.jsonl', line_no: 12,
};

const now = new Date('2026-10-05T12:30:00.000Z'); // 2026-10-05 21:30 KST

function card(partial: Partial<DecisionEntry> & Pick<DecisionEntry, 'id' | 'title' | 'raisedAt'>): DecisionEntry {
  return {
    category: 'other', scqa: { s: '상황', c: '문제' }, options: [], recommendation: { skipped: true, reason: '없음' },
    raisedBy: { agent: 'seat-loop' }, status: 'open', history: [], ...partial,
  };
}

const input: ProactMeterInput = {
  decisions: [
    card({ id: 'D-1', title: '막힌 결정 제안', raisedAt: '2026-10-04T01:00:00.000Z', status: 'decided', decidedAt: '2026-10-04T05:00:00.000Z' }),
    card({ id: 'D-old', title: '창 밖', raisedAt: '2026-09-01T00:00:00.000Z' }),
    card({ id: 'D-ask', title: '왜 실패했나', raisedAt: '2026-10-03T02:00:00.000Z', raisedBy: { agent: 'human' }, scqa: { s: '상황', c: '대표가 물음' } }),
  ],
  seatDecisions: [{
    id: 'SD-1', title: '자리 조치', decision: '실행', seat: 'OP', delegation: '위임', reporting: 'posthoc',
    recordedAt: '2026-10-04T12:00:00.000Z', decidedAt: '2026-10-04T11:00:00.000Z',
  } satisfies SeatDecisionRecord],
  directives: [directiveRow],
  coord: [{
    id: 'c1', at: '2026-10-01T01:00:00.000Z', text: '경보', summary: '루프 경보', kind: '사고',
    refs: { seat: 'TC', recipients: [], all: false, kind: '사고', slot: null, deadline: null, url: 'https://coord.example/1' },
  } satisfies CoordEvent, {
    id: 'c2', at: '2026-10-01T02:00:00.000Z', text: '왜 막혀', summary: '왜 막혀 있나', kind: '요청',
    refs: { seat: 'CEO', recipients: ['OP'], all: false, kind: '요청', slot: null, deadline: null, url: null },
  } satisfies CoordEvent],
  loops: [{
    seat: 'OP', at: '2026-10-05T00:10:00.000Z', status: 'launched', action: 'harness', id: 'cell-1', title: '칸 발사', file: '/tmp/seat-loop/OP/2026-10-05.jsonl',
  } satisfies ProactLoopRow],
};

test('seven KST days each carry offered, adopted, and asked, and samples keep source links', () => {
  const meter = measureProact(input, now);
  expect(meter.days).toHaveLength(7);
  expect(meter.days.map(day => day.day)).toEqual(proactWindow(now).days);
  expect(meter.days.map(day => day.day)[0]).toBe('2026-09-29');
  expect(meter.days.map(day => day.day)[6]).toBe('2026-10-05');
  const byDay = Object.fromEntries(meter.days.map(day => [day.day, day]));
  expect(byDay['2026-10-04']).toEqual({ day: '2026-10-04', offered: 2, adopted: 2, asked: 0 });
  expect(byDay['2026-10-03']).toEqual({ day: '2026-10-03', offered: 0, adopted: 0, asked: 1 });
  expect(byDay['2026-10-02']).toEqual({ day: '2026-10-02', offered: 0, adopted: 0, asked: 1 });
  expect(byDay['2026-10-01']).toEqual({ day: '2026-10-01', offered: 1, adopted: 0, asked: 1 });
  expect(byDay['2026-10-05']).toEqual({ day: '2026-10-05', offered: 1, adopted: 1, asked: 0 });
  expect(byDay['2026-09-30']).toEqual({ day: '2026-09-30', offered: 0, adopted: 0, asked: 0 });
  const links = meter.samples.map(row => row.link);
  expect(links).toContain('decisions://D-1');
  expect(links).toContain('decisions://SD-1');
  expect(links).toContain('directives:///tmp/session.jsonl#L12');
  expect(links).toContain('https://coord.example/1');
  expect(links).toContain('loop:///tmp/seat-loop/OP/2026-10-05.jsonl#cell-1');
  expect(meter.samples.find(row => row.id === 'cell-1' && row.bucket === 'offered')!.title.startsWith('action:')).toBe(true);
  expect(meter.samples.find(row => row.id === 'D-old')).toBeUndefined();
  const outside = measureProact({ decisions: [card({ id: 'D-out', title: '창 밖 채택', raisedAt: '2026-09-20T00:00:00.000Z', status: 'decided', decidedAt: '2026-10-04T01:00:00.000Z' })] }, now);
  expect(outside.days.every(day => day.adopted === 0 && day.offered === 0)).toBe(true);
  expect(formatProactMeter(meter)).toContain('2026-10-04 · 2 · 2 · 0');
});

test('an unreadable source is not counted as zero and does not erase the other ledgers', () => {
  const meter = measureProact({ ...input, decisionsError: 'lock timeout' }, now);
  expect(meter.sources.decision).toEqual({ read: false, reason: 'lock timeout' });
  expect(meter.days.every(day => day.offered === (day.day === '2026-10-01' ? 1 : day.day === '2026-10-05' ? 1 : 0) || day.day === '2026-10-04')).toBe(true);
  const fourth = meter.days.find(day => day.day === '2026-10-04')!;
  expect(fourth).toEqual({ day: '2026-10-04', offered: 0, adopted: 0, asked: 0 });
  expect(meter.days.find(day => day.day === '2026-10-02')!.asked).toBe(1);
  expect(formatProactMeter(meter)).toContain('못 읽음: decision(lock timeout)');
});

test('readProactMeter uses injected ledgers and still emits seven days when every source is empty', () => {
  const meter = readProactMeter({
    now, stateDir: '/tmp/does-not-matter',
    readDecisions: () => ({ decisions: [], seatDecisions: [] }),
    readDirectives: () => [], readCoord: () => [], readLoops: () => [],
  });
  expect(meter.days).toHaveLength(7);
  expect(meter.days.every(day => day.offered === 0 && day.adopted === 0 && day.asked === 0)).toBe(true);
  expect(meter.sources.loop.read).toBe(true);
  expect(proactKstDay('2026-10-04T15:30:00.000Z')).toBe('2026-10-05');
});

test('a seat decision recorded inside the window counts on the record day, not a missing decision day', () => {
  const onlySeat = measureProact({ seatDecisions: input.seatDecisions, decisions: [], directives: [], coord: [], loops: [] }, now);
  expect(onlySeat.days.find(day => day.day === '2026-10-04')).toEqual({ day: '2026-10-04', offered: 1, adopted: 1, asked: 0 });
});
