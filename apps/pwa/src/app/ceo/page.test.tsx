import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { routeMaturity } from '@/lib/route-maturity';
import { SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';
import CeoPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let tree: ReactTestRenderer | undefined;

const at = Date.parse('2026-10-05T09:00:00Z');
const schedule = (id: string, state: string, status: string, lastAt: string) => ({
  id, name: id, source: 'crontab', category: 'monitor', domain: 'elanous', runVia: 'daemon',
  cron: '0 * * * *', intervalMs: null, state, next: [], lastRun: { at: lastAt, status, exit: status === 'ok' ? 0 : 1 },
});
const seat = (id: string, green = 0, yellow = 0) => ({
  seat: id, now: null, landed: [], blocked: [], pendingDecisions: 0,
  checklist: { green, yellow, red: 0, done: 0 },
});
const seats = { date: '2026-10-05', seats: [seat('OP', 1), seat('TC', 1, 1), seat('MK'), seat('UX')] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

async function mount() {
  const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
  const client = new DaemonClient(config);
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><CeoPage /></DaemonContext.Provider>);
  });
  return tree!.root;
}

function card(root: ReactTestRenderer['root'], label: string) {
  const section = root.findByProps({ 'aria-label': label });
  const text = (node: typeof section): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
  return text(section);
}

test('owner overview preserves four summary cards and adds two compact cards using existing read-only daemon endpoints', async () => {
  Date.now = () => at;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [
      schedule('late', 'stale', 'ok', '2026-10-04T09:00:00Z'),
      schedule('failed', 'live', 'error', '2026-10-05T08:00:00Z'),
      schedule('alive', 'live', 'ok', '2026-10-05T08:00:00Z'),
    ] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [{ id: 'one' }, { id: 'two' }] });
    if (url.includes('/v1/harness/runs')) return json({ landed: [
      { number: 12, mergedAt: '2026-10-05T00:00:00Z' },
      { number: 13, mergedAt: '2026-10-04T15:00:00Z' },
      { number: 14, mergedAt: '2026-10-04T14:59:59Z' },
    ], landedTruncated: false, landedError: null });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  expect(routeMaturity('/ceo')).toBe('ops');
  expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === '/ceo')).toMatchObject({ group: 'ops', label: '대표 조망판' });
  expect(root.findByProps({ 'aria-label': '대표 조망 카드' }).props.className).toContain('grid-cols-2');
  expect(root.findAllByType('section')).toHaveLength(6);
  expect(card(root, '릴리스 판 진행')).toContain('green 2');
  expect(card(root, '릴리스 판 진행')).toContain('노랑 1');
  expect(card(root, '루프 판정')).toContain('늦음 1');
  expect(card(root, '루프 판정')).toContain('실패 1');
  expect(card(root, '루프 판정')).toContain('살아 있음 1');
  expect(card(root, '결정 대기 카드')).toContain('2');
  expect(card(root, '오늘 병합 PR')).toContain('2');
  expect(card(root, '위험·막힘 톱 5')).toContain('못 읽음');
  expect(card(root, '그리드')).toContain('준비 중');
  expect(calls.map((call) => call.url)).toEqual([
    'https://nexus.example/v1/ops/seats',
    'https://nexus.example/v1/schedules?includeOff=1',
    'https://nexus.example/v1/dashboard/loops',
    'https://nexus.example/v1/decisions?status=open',
    `https://nexus.example/v1/harness/runs?finishedSince=${Date.parse('2026-10-04T15:00:00Z')}`,
    `https://nexus.example/v1/harness/runs?finishedSince=${Date.parse('2026-09-27T15:00:00Z')}`,
  ]);
  expect(calls.every(({ init }) => !init?.method || init.method === 'GET')).toBe(true);
  expect(calls.every(({ init }) => (init?.headers as Record<string, string>)?.authorization === 'Bearer owner-token')).toBe(true);
});

test('each unreadable source is 못 읽음 rather than zero; a successfully empty source is zero', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json({ error: 'forbidden' }, 403);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) throw Error('offline');
    return json({ landed: [], landedError: 'gh unavailable' });
  }) as typeof fetch;
  const root = await mount();
  expect(card(root, '릴리스 판 진행')).toBe('릴리스 판 진행못 읽음');
  expect(card(root, '루프 판정')).toBe('루프 판정등록 0');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드못 읽음');
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR못 읽음');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
  expect(card(root, '그리드')).toBe('그리드준비 중');
});

test('a partial checklist, malformed schedules and truncated PR list are not measured counts', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json({ ...seats, seats: seats.seats.map((row, index) => ({ ...row, checklist: index === 0 ? null : { green: 0, yellow: 0, red: 0, done: 0 } })) });
    if (url.includes('/v1/schedules')) return json({ schedules: [{ id: 'broken' }] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    return json({ landed: [], landedTruncated: true });
  }) as typeof fetch;
  const root = await mount();
  expect(card(root, '릴리스 판 진행')).toContain('못 읽음');
  expect(card(root, '루프 판정')).toContain('못 읽음');
  expect(card(root, '오늘 병합 PR')).toContain('못 읽음');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드0');
});

test('a failed loop registry never turns a readable schedule count into a false clean risk list', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ error: 'unavailable' }, 503);
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    if (url.includes('/v1/harness/runs')) return json({ landed: [], entries: [], finished: [], finishedObservation: { skippedFiles: 0 } });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  expect(card(root, '루프 판정')).toBe('루프 판정등록 0');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR0');
});

test('failed risk-run observation remains unreadable without discarding the independent merged count', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    if (url.includes('/v1/harness/runs')) {
      if (url.includes(String(Date.parse('2026-09-27T15:00:00Z')))) throw Error('risk source offline');
      return json({ landed: [{ number: 42, mergedAt: '2026-10-05T08:00:00Z' }] });
    }
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR1');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드0');
});

test('risk card sorts stopped runs, failed loops and overdue decisions newest first and caps at five on phone width', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [
      schedule('old-failure', 'live', 'error', '2026-10-05T01:00:00Z'),
      schedule('new-failure', 'live', 'error', '2026-10-05T08:00:00Z'),
      schedule('ok', 'live', 'ok', '2026-10-05T08:30:00Z'),
    ] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [
      { name: 'retro', label: 'retro-failed', last: { at: '2026-10-05T08:20:00Z', status: 'abandoned' } },
    ] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [
      { id: 'late', title: 'late decision', dueAt: '2026-10-05T07:00:00Z' },
      { id: 'early', title: 'early decision', dueAt: '2026-10-05T02:00:00Z' },
      { id: 'future', title: 'future decision', dueAt: '2026-10-06T00:00:00Z' },
    ] });
    if (url.includes('/v1/harness/runs')) return json({
      completeness: 'complete', entries: [], finishedObservation: { skippedFiles: 0 }, landed: [],
      finished: [
        { runId: 'latest', status: 'human-stop', objective: 'latest stopped', endedAt: '2026-10-05T08:45:00Z' },
        { runId: 'middle', status: 'failed', objective: 'middle stopped', endedAt: '2026-10-05T06:00:00Z' },
        { runId: 'oldest', status: 'parked', objective: 'oldest stopped', endedAt: '2026-10-05T00:00:00Z' },
        { runId: 'done', status: 'completed', endedAt: '2026-10-05T08:55:00Z' },
      ],
    });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  const section = root.findByProps({ 'aria-label': '위험·막힘 톱 5' });
  expect(section.findAllByType('li')).toHaveLength(5);
  expect(card(root, '위험·막힘 톱 5')).toContain('latest stopped');
  expect(card(root, '위험·막힘 톱 5')).toContain('retro-failed');
  expect(card(root, '위험·막힘 톱 5')).not.toContain('old-failure');
  expect(card(root, '위험·막힘 톱 5')).not.toContain('oldest stopped');
  expect(section.findAllByType('li').map((row) => row.findByType('time').props.dateTime)).toEqual([
    '2026-10-05T08:45:00Z', '2026-10-05T08:20:00Z', '2026-10-05T08:00:00Z',
    '2026-10-05T07:00:00Z', '2026-10-05T06:00:00Z',
  ]);
  expect(root.findByProps({ 'aria-label': '위험과 그리드 카드' }).props.className).toContain('grid-cols-2');
  expect(root.findByProps({ 'aria-label': '위험과 그리드 카드' }).props.className).not.toContain('overflow-x');
});

test('duplicate failed loop in schedule and registry occupies only one risk slot', async () => {
  Date.now = () => at;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [schedule('duplicate', 'live', 'error', '2026-10-05T07:00:00Z')] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [
      { name: 'duplicate', label: 'newer failure', last: { at: '2026-10-05T08:00:00Z', status: 'error' } },
    ] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [
      { id: 'one', dueAt: '2026-10-05T06:00:00Z' }, { id: 'two', dueAt: '2026-10-05T05:00:00Z' },
      { id: 'three', dueAt: '2026-10-05T04:00:00Z' }, { id: 'four', dueAt: '2026-10-05T03:00:00Z' },
      { id: 'five', dueAt: '2026-10-05T02:00:00Z' },
    ] });
    if (url.includes('/v1/harness/runs')) return json({ completeness: 'complete', entries: [], finished: [], finishedObservation: { skippedFiles: 0 }, landed: [] });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  const section = root.findByProps({ 'aria-label': '위험·막힘 톱 5' });
  expect(section.findAllByType('li')).toHaveLength(5);
  expect(card(root, '위험·막힘 톱 5')).toContain('newer failure');
  expect(card(root, '위험·막힘 톱 5')).toContain('four');
  expect(card(root, '위험·막힘 톱 5')).not.toContain('five');
  expect(section.findAllByType('li').map((row) => row.findByType('time').props.dateTime)).toEqual([
    '2026-10-05T08:00:00Z', '2026-10-05T06:00:00Z', '2026-10-05T05:00:00Z',
    '2026-10-05T04:00:00Z', '2026-10-05T03:00:00Z',
  ]);
});
