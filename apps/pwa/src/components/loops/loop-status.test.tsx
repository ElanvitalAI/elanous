import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoopStatusContent, LoopStatusPanel } from './LoopStatusPanel';
import LoopsPage from '@/app/loops/page';
import { createLoopRowsRefresh, loadLoopRows, loopRows, LOOP_SCHEDULES_PATH, LOOPS_PATH, type LoopSchedule } from './loop-status';
import { routeMaturity } from '@/lib/route-maturity';
import { SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';

const now = Date.parse('2026-10-04T12:00:00.000Z');
const job = (patch: Partial<LoopSchedule> = {}): LoopSchedule => ({
  id: 'loop-1', name: '루프 하나', source: 'crontab', category: 'monitor', domain: 'elanous',
  runVia: 'daemon', cron: null, intervalMs: 600_000, state: 'firing', next: [],
  lastRun: { at: '2026-10-04T11:40:00.000Z', status: 'ok', exit: 0 }, ...patch,
});

test('past twice the interval turns red 늦음, but exactly twice stays alive', () => {
  const rows = loopRows([job()], now + 1);
  expect(rows[0]?.verdict).toBe('늦음');
  expect(loopRows([job()], now)[0]?.verdict).toBe('살아 있음');
  const html = renderToStaticMarkup(<LoopStatusContent rows={rows} state="ready" />);
  expect(html).toContain('data-loop-verdict="늦음"');
  expect(html).toContain('bg-red-500/15 text-red-300');
  expect(html).toContain('md:table');
  expect(html).toContain('md:hidden');
  for (const header of ['루프 · 층', '주인(자리)', '모드', '마지막 실행 시각', '판정']) expect(html).toContain(header);
});

// 리뷰 must-fix(GOODHART): 데몬 stale 은 크론에만 — 크론 없는 일정은 stale 이어도 «2× 간격» 규칙으로(#23684 판정 복원).
test('shared verdict classifies cron without fixed cadence, failed/off and unknown owner', () => {
  const rows = loopRows([
    job({ id: 'cron', cron: '*/10 * * * *', intervalMs: null, state: 'stale', next: ['2026-10-04T12:10:00.000Z', '2026-10-04T12:20:00.000Z'], lastRun: { at: '2026-10-04T11:39:00.000Z', status: 'ok', exit: 0 } }),
    job({ id: 'failed', lastRun: { at: '2026-10-04T11:59:00.000Z', status: 'error', exit: 1 } }),
    job({ id: 'off', state: 'off', lastRun: { at: '2026-10-04T09:00:00.000Z', status: 'error', exit: 1 } }),
    job({ id: 'missing', lastRun: null, intervalMs: null, domain: null, category: null }),
    job({ id: 'stale-no-history', state: 'stale', lastRun: null, intervalMs: null }),
    job({ id: 'stale-no-period', state: 'stale', intervalMs: null, cron: null, next: [] }),
    job({ id: 'stale-not-overdue', state: 'stale', lastRun: { at: '2026-10-04T11:50:00.000Z', status: 'ok', exit: 0 } }),
    job({ id: 'never-run-interval', lastRun: null }),
  ], now);
  expect(rows.map((row) => row.verdict)).toEqual(['늦음', '실패', '꺼짐', '판정 불가', '판정 불가', '판정 불가', '살아 있음', '판정 불가']);
  expect(rows.map((row) => row.owner)).toEqual(Array(8).fill('미지정'));
  expect(rows[3]?.layer).toBe('crontab');
  expect(rows[3]?.lastRun).toBeNull();
  expect(renderToStaticMarkup(<LoopStatusContent rows={rows} state="ready" />)).toContain('data-loop-verdict="판정 불가"');
});

test('reads existing schedule and recorded-loop GETs with injected transport, including off entries', async () => {
  const calls: string[] = [];
  const rows = await loadLoopRows(async (path) => {
    calls.push(path);
    if (path === LOOP_SCHEDULES_PATH) return { schedules: [job(), job({ id: 'off', state: 'off' })] };
    return { loops: { loops: [{ name: 'retro', label: '회고 루프', category: 'reflect', armed: null, last: null }] } };
  }, now + 1);
  expect(calls).toEqual([LOOP_SCHEDULES_PATH, LOOPS_PATH]);
  expect(rows.map((row) => row.verdict)).toEqual(['늦음', '꺼짐', '판정 불가']);
  expect(rows[2]).toMatchObject({ layer: 'reflect', owner: '미지정', mode: '관측' });
  expect(loadLoopRows(async () => ({ bad: true }), now)).rejects.toThrow('loop registries unavailable');
  await expect(loadLoopRows(async (path) => path === LOOPS_PATH ? { loops: { loops: [{ name: 'dig', label: '디깅', armed: false, last: null }] } } : Promise.reject(new Error('offline')), now)).rejects.toThrow('스케줄');
  await expect(loadLoopRows(async (path) => path === LOOPS_PATH ? { loops: { loops: [] } } : Promise.reject(new Error('offline')), now)).rejects.toThrow('스케줄');
  await expect(loadLoopRows(async (path) => path === LOOP_SCHEDULES_PATH ? { schedules: [] } : Promise.reject(new Error('offline')), now)).rejects.toThrow('루프');
  expect(await loadLoopRows(async (path) => path === LOOP_SCHEDULES_PATH ? { schedules: [] } : { loops: { loops: [] } }, now)).toEqual([]);
});

test('equal labels in the two registries retain separate stable, namespaced identities', async () => {
  const rows = await loadLoopRows(async (path) => path === LOOP_SCHEDULES_PATH
    ? { schedules: [job({ id: 'retro', name: '회고 루프' })] }
    : { loops: { loops: [{ name: 'retro', label: '회고 루프', category: 'reflect', armed: null, last: null }] } }, now);
  expect(rows.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'schedule:retro', name: '회고 루프' },
    { id: 'loop:retro', name: '회고 루프' },
  ]);
});

test('overlapping refreshes apply only the newest request including errors and dispose', async () => {
  const pending: Array<{ path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const fetchJson = (path: string): Promise<unknown> => new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
  const results: Array<{ rows: ReturnType<typeof loopRows>; state: 'ready' | 'error' }> = [];
  const poller = createLoopRowsRefresh(fetchJson, (result) => results.push(result), () => now);
  const first = poller.refresh();
  const second = poller.refresh();
  expect(pending.map(({ path }) => path)).toEqual([LOOP_SCHEDULES_PATH, LOOPS_PATH, LOOP_SCHEDULES_PATH, LOOPS_PATH]);
  pending[2]!.resolve({ schedules: [job({ id: 'newer' })] });
  pending[3]!.resolve({ loops: { loops: [] } });
  await second;
  pending[0]!.resolve({ schedules: [job({ id: 'older' })] });
  pending[1]!.resolve({ loops: { loops: [] } });
  await first;
  expect(results.map((result) => result.rows[0]?.id)).toEqual(['schedule:newer']);

  const staleFailure = poller.refresh();
  const latest = poller.refresh();
  pending[6]!.resolve({ schedules: [job({ id: 'latest' })] });
  pending[7]!.resolve({ loops: { loops: [] } });
  await latest;
  pending[4]!.reject(new Error('stale network failure'));
  pending[5]!.resolve({ loops: { loops: [] } });
  await staleFailure;
  expect(results.map((result) => result.rows[0]?.id)).toEqual(['schedule:newer', 'schedule:latest']);

  const afterDispose = poller.refresh();
  poller.dispose();
  pending[8]!.resolve({ schedules: [job({ id: 'unmounted' })] });
  pending[9]!.resolve({ loops: { loops: [] } });
  await afterDispose;
  expect(results).toHaveLength(2);
});

test('operational beta page is reachable from the operations navigation and mounts the status panel', () => {
  expect(routeMaturity('/loops')).toBe('beta');
  expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === '/loops')).toMatchObject({ group: 'ops', label: '루프 현황' });
  expect(LoopsPage().type).toBe(LoopStatusPanel);
});

test('no registry entries and fetch failure are not shown as healthy', () => {
  expect(renderToStaticMarkup(<LoopStatusContent rows={[]} state="ready" />)).toContain('등록된 루프·크론이 없습니다');
  const failed = renderToStaticMarkup(<LoopStatusContent rows={[]} state="error" />);
  expect(failed).toContain('일부 레지스트리 조회가 실패했습니다');
  expect(failed).not.toContain('등록된 루프·크론이 없습니다');
});

test('cron schedules follow daemon live or stale state without inferring fixed cadence from next runs', () => {
  const at = Date.parse('2026-10-05T08:00:00.000Z');
  const daily = job({ id: 'morning', cron: '*/10 9 * * *', intervalMs: null, state: 'live',
    next: ['2026-10-05T09:00:00.000Z', '2026-10-05T09:10:00.000Z'], lastRun: { at: '2026-10-04T09:50:00.000Z', status: 'ok', exit: 0 } });
  expect(loopRows([daily], at)[0]?.verdict).toBe('살아 있음');
  expect(loopRows([{ ...daily, state: 'stale' }], at)[0]?.verdict).toBe('늦음');
  expect(loopRows([{ ...daily, lastRun: null }], at)[0]?.verdict).toBe('판정 불가');
  expect(loopRows([{ ...daily, lastRun: null, state: 'stale' }], at)[0]?.verdict).toBe('늦음');
});

test('injected registries use shared verdict precedence and preserve display metadata', async () => {
  const rows = await loadLoopRows(async (path) => path === LOOP_SCHEDULES_PATH ? { schedules: [
    job({ id: 'failed-overdue', lastRun: { at: '2026-10-04T11:00:00.000Z', status: 'ok', exit: 1 } }),
    job({ id: 'abandoned-schedule', lastRun: { at: '2026-10-04T11:59:00.000Z', status: 'abandoned', exit: null } }),
    job({ id: 'expired-schedule', lastRun: { at: '2026-10-04T11:59:00.000Z', status: 'expired', exit: null } }),
    job({ id: 'off-overdue', state: 'off', lastRun: { at: '2026-10-04T11:00:00.000Z', status: 'error', exit: 1 } }),
    job({ id: 'threshold' }),
    job({ id: 'cron-live', cron: '*/10 9 * * *', state: 'live', intervalMs: null, lastRun: { at: '2026-10-03T09:50:00.000Z', status: 'ok', exit: 0 } }),
    job({ id: 'cron-stale', cron: '*/10 9 * * *', state: 'stale', intervalMs: null, lastRun: { at: '2026-10-03T09:50:00.000Z', status: 'ok', exit: 0 } }),
  ] } : { loops: { loops: [
    { name: 'failed-loop', label: 'Failed', category: 'reflect', armed: true, last: { at: '2026-10-04T11:59:00.000Z', status: 'failed' } },
    { name: 'abandoned-loop', label: 'Abandoned', armed: null, last: { at: '2026-10-04T11:59:00.000Z', status: 'abandoned' } },
    { name: 'expired-loop', label: 'Expired', armed: true, last: { at: '2026-10-04T11:59:00.000Z', status: 'expired' } },
    { name: 'unjudged-loop', label: 'Unjudged', armed: null, last: null },
    { name: 'off-loop', label: 'Off', armed: false, last: { at: '2026-10-04T11:59:00.000Z', status: 'failed' } },
  ] } }, now);
  expect(rows.map(({ id, verdict }) => [id, verdict])).toEqual([
    ['schedule:failed-overdue', '실패'], ['schedule:abandoned-schedule', '실패'],
    ['schedule:expired-schedule', '실패'], ['schedule:off-overdue', '꺼짐'],
    ['schedule:threshold', '살아 있음'], ['schedule:cron-live', '살아 있음'],
    ['schedule:cron-stale', '늦음'], ['loop:failed-loop', '실패'],
    ['loop:abandoned-loop', '실패'], ['loop:expired-loop', '실패'],
    ['loop:unjudged-loop', '판정 불가'], ['loop:off-loop', '꺼짐'],
  ]);
  expect(rows[7]).toMatchObject({ layer: 'reflect', owner: '미지정', mode: 'armed', lastRun: '2026-10-04T11:59:00.000Z' });
  expect(renderToStaticMarkup(<LoopStatusContent rows={rows} state="ready" />)).toContain('data-loop-verdict="판정 불가"');
});
