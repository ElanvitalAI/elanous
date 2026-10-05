import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LoopRow } from '@/components/loops/loop-status';
import { LoopActivityMap } from './LoopActivityMap';
import { leaksInternal } from './public-text';

const now = Date.parse('2026-10-05T10:00:00Z');
const rows: LoopRow[] = [
  { id: 'schedule:late', name: '늦은 루프', layer: 'ops', owner: 'OP', mode: 'cron', lastRun: null, verdict: '늦음' },
  { id: 'loop:off', name: '꺼진 루프', layer: 'ops', owner: '미지정', mode: 'off', lastRun: null, verdict: '꺼짐' },
];

test('map exposes four seats, unknown owner, red verdict and clickable node list at phone width', () => {
  const html = renderToStaticMarkup(<LoopActivityMap rows={rows} edges={[]} seenAt={{}} now={now} state="ready" />);
  for (const label of ['COO', 'CMO', 'CTO', 'CXO', '미지정', '늦은 루프', '꺼진 루프']) expect(html).toContain(label);
  expect(html).toContain('data-loop-verdict="늦음"');
  expect(html).toContain('text-red-300');
  expect(html).toContain('늦은 루프');
  expect(html).toContain('꺼진 루프');
  expect(html).toContain('type="button"');
  expect(html).toContain('grid gap-4 sm:grid-cols-2');
  expect(html).toContain('최근 사건이 없습니다');
  expect(leaksInternal(html)).toEqual([]);
});

test('sub-seats remain visible as seat nodes when supplied by ops seats', () => {
  const html = renderToStaticMarkup(<LoopActivityMap rows={rows} edges={[]} seenAt={{}} now={now} state="ready" seatIds={['OP', 'MK', 'TC', 'UX', 'TC-1']} />);
  expect(html).toContain('CTO-1');
  expect(html).toContain('h-[90px] w-[90px]');
});

test('run incident keeps opaque graph IDs and provides a Trace lens link', () => {
  const edge = { at: '2026-10-05T09:59:00Z', kind: 'run' as const, from: 'OP', to: 'loop:run-123abc', ref: 'run-123abc' };
  const html = renderToStaticMarkup(<LoopActivityMap rows={rows} edges={[edge]} seenAt={{}} now={now} state="ready" />);
  expect(html).toContain('최근 간선 사건');
  expect(html).toContain('type="button"');
  expect(html).not.toContain('data-id="loop:run-123abc"');
});
