import { afterEach, expect, spyOn, test } from 'bun:test';
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
const draftMetrics = { inventory: 168, oldestAgeHours: 119.2, needsOwner: 12, converted48h: 330, cohort48h: 701, conversion48h: 330 / 701 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const gridData = {
  hq: { record: { holder: '본부-OP', generation: 4, acquiredAt: 900, renewedAt: 990, ttlSeconds: 1500 }, ageSeconds: 125, expired: false, reason: null },
  members: [
    { context: 'long-pool-context-alpha', capacity: 3, running: 1, pending: 1, occupied: 2, reason: null },
    { context: 'pool-beta', capacity: 5, running: 0, pending: 1, occupied: 1, reason: null },
  ], poolReason: null,
};

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

test('all six cards show loading rather than unreadable before the first response', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    await pending;
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    if (url.includes('/v1/harness/runs')) return json({ completeness: 'complete', landed: [], finished: [], entries: [], finishedObservation: { skippedFiles: 0 } });
    if (url.includes('/v1/grid')) return json(gridData);
    if (url.includes('/v1/drafts/metrics')) return json({ state: 'ready', metrics: draftMetrics, measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  const labels = ['릴리스 판 진행', '루프 판정', '결정 대기 카드', '오늘 병합 PR', '위험·막힘 톱 5', '그리드', 'draft 재고'];
  expect(calls).toHaveLength(8);
  expect(root.findAllByType('section').map((section) => section.props['aria-label'])).toEqual(labels);
  for (const label of labels) {
    expect(card(root, label)).toContain('불러오는 중…');
    expect(card(root, label)).not.toContain('못 읽음');
  }
  expect(root.findByProps({ 'aria-label': '결정 대기 카드' }).findByType('a').props.href).toBe('/decisions');
  await act(async () => { release(); });
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드0');
  expect(card(root, '그리드')).toContain('칸 사용 3/8');
});

test('failed and unanswered reads show 못 읽음 only after the request ends', async () => {
  const deadlines: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    if (delay !== 15_000) return originalSetTimeout(callback, delay);
    deadlines.push(callback);
    return deadlines.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    globalThis.fetch = (async (url: string): Promise<Response> => {
      if (url.includes('/v1/grid')) return new Promise<Response>(() => {});
      throw Error('offline');
    }) as typeof fetch;
    const root = await mount();
    expect(root.findAllByType('section').map((section) => section.props['aria-label'])).toEqual([
      '릴리스 판 진행', '루프 판정', '결정 대기 카드', '오늘 병합 PR', '위험·막힘 톱 5', '그리드', 'draft 재고',
    ]);
    expect(deadlines).toHaveLength(8);
    expect(card(root, 'draft 재고')).toBe('draft 재고못 읽음');
    for (const label of ['릴리스 판 진행', '루프 판정', '결정 대기 카드', '오늘 병합 PR', '위험·막힘 톱 5']) {
      expect(card(root, label)).toContain('못 읽음');
    }
    expect(card(root, '그리드')).toContain('불러오는 중…');
    expect(card(root, '그리드')).not.toContain('못 읽음');
    await act(async () => { deadlines[6]!(); });
    expect(card(root, '릴리스 판 진행')).toBe('릴리스 판 진행못 읽음발행 현황 보기 →');
    expect(card(root, '루프 판정')).toBe('루프 판정못 읽음루프 상호작용 보기 →');
    expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드못 읽음');
    expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR못 읽음');
    expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
    expect(card(root, '그리드')).toBe('그리드못 읽음');
    expect(root.findByProps({ 'aria-label': '릴리스 판 진행' }).findByType('a').props.href).toBe('/ops/release');
    expect(root.findByProps({ 'aria-label': '루프 판정' }).findByType('a').props.href).toBe('/loops?view=interact');
    expect(root.findByProps({ 'aria-label': '결정 대기 카드' }).findByType('a').props.href).toBe('/decisions');
  } finally {
    timer.mockRestore();
  }
});

test('completed cards resolve independently while another request remains unanswered', async () => {
  let releaseGrid!: (response: Response) => void;
  const pendingGrid = new Promise<Response>((resolve) => { releaseGrid = resolve; });
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/grid')) return pendingGrid;
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) throw Error('offline');
    if (url.includes('/v1/harness/runs')) return json({ completeness: 'complete', landed: [], finished: [], entries: [], finishedObservation: { skippedFiles: 0 } });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
  const root = await mount();
  expect(card(root, '릴리스 판 진행')).toContain('green 2');
  expect(card(root, '루프 판정')).toContain('등록 0');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드못 읽음');
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR0');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
  expect(card(root, '그리드')).toBe('그리드불러오는 중…');
  await act(async () => { releaseGrid(json(gridData)); });
  expect(card(root, '그리드')).toContain('칸 사용 3/8');
});

test('owner overview preserves four summary cards and adds two compact cards using existing read-only daemon endpoints', async () => {
  Date.now = () => at;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/v1/grid')) return json(gridData);
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
  expect(root.findAllByType('section')).toHaveLength(7);
  expect(card(root, '릴리스 판 진행')).toContain('green 2');
  expect(card(root, '릴리스 판 진행')).toContain('노랑 1');
  expect(card(root, '루프 판정')).toContain('늦음 1');
  expect(card(root, '루프 판정')).toContain('실패 1');
  expect(card(root, '루프 판정')).toContain('살아 있음 1');
  expect(card(root, '결정 대기 카드')).toContain('2');
  expect(root.findByProps({ 'aria-label': '결정 대기 카드' }).findByType('a').props.href).toBe('/decisions');
  expect(card(root, '오늘 병합 PR')).toContain('2');
  expect(card(root, '위험·막힘 톱 5')).toContain('못 읽음');
  expect(card(root, '그리드')).toContain('칸 사용 3/8');
  expect(calls.map((call) => call.url)).toEqual([
    'https://nexus.example/v1/ops/seats',
    'https://nexus.example/v1/schedules?includeOff=1',
    'https://nexus.example/v1/dashboard/loops',
    'https://nexus.example/v1/decisions?status=open',
    `https://nexus.example/v1/harness/runs?finishedSince=${Date.parse('2026-10-04T15:00:00Z')}`,
    `https://nexus.example/v1/harness/runs?finishedSince=${Date.parse('2026-09-27T15:00:00Z')}`,
    'https://nexus.example/v1/grid',
    'https://nexus.example/v1/drafts/metrics',
  ]);
  expect(calls.every(({ init }) => !init?.method || init.method === 'GET')).toBe(true);
  expect(calls.every(({ init }) => (init?.headers as Record<string, string>)?.authorization === 'Bearer owner-token')).toBe(true);
});

function gridFetch(grid: unknown, status = 200) {
  globalThis.fetch = (async (url: string) => {
    if (url.includes('/v1/grid')) return json(grid, status);
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    if (url.includes('/v1/harness/runs')) return json({ completeness: 'complete', landed: [], finished: [], entries: [], finishedObservation: { skippedFiles: 0 } });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
}

test('grid shows live HQ, two measured members and total slots without invented heartbeat columns', async () => {
  gridFetch(gridData);
  const root = await mount();
  const section = root.findByProps({ 'aria-label': '그리드' });
  expect(card(root, '그리드')).toContain('본부 · 본부-OP · 2분 전');
  expect(card(root, '그리드')).toContain('long-pool-context-alpha2/3');
  expect(card(root, '그리드')).toContain('pool-beta1/5');
  expect(card(root, '그리드')).toContain('칸 사용 3/8');
  expect(section.findByProps({ title: 'long-pool-context-alpha' }).props.className).toContain('truncate');
  expect(section.findAllByProps({ role: 'meter' }).map((meter) => meter.props['aria-valuenow'])).toEqual([2, 1]);
  expect(section.findAllByProps({ role: 'meter' })[0]!.findAllByType('div').find((node) => node.props.style)?.props.style.width).toBe('66.66666666666666%');
  expect(card(root, '그리드')).not.toContain('하트비트');
});

test('expired HQ is marked red', async () => {
  gridFetch({ ...gridData, hq: { ...gridData.hq, expired: true } });
  const root = await mount();
  expect(card(root, '그리드')).toContain('만료');
  expect(root.findByProps({ 'aria-label': '그리드' }).findAllByType('span').find((span) => span.children.includes('만료'))?.props.className).toContain('text-red-600');
});

test('unmeasured member is not plotted as zero and pool/HQ read errors stay distinct', async () => {
  gridFetch({ hq: { record: null, ageSeconds: null, expired: null, reason: 'arbiter down' },
    members: [{ ...gridData.members[0], occupied: null, running: null, pending: null, reason: 'unreachable' }, gridData.members[1]], poolReason: 'pool unavailable' });
  const root = await mount();
  expect(card(root, '그리드')).toContain('본부 못 읽음');
  expect(card(root, '그리드')).toContain('풀 못 읽음 · pool unavailable');
  expect(card(root, '그리드')).toContain('long-pool-context-alpha측정 불가');
  expect(card(root, '그리드')).toContain('pool-beta1/5');
  expect(card(root, '그리드')).toContain('칸 사용 측정 불가/8');
  expect(root.findByProps({ 'aria-label': '그리드' }).findAllByProps({ role: 'meter' })[0]!.props['aria-valuenow']).toBeUndefined();
  expect(card(root, '그리드')).not.toContain('0/3');
});

test('failed grid read is 못 읽음 while all five existing cards remain readable', async () => {
  gridFetch({ error: 'offline' }, 503);
  const root = await mount();
  expect(card(root, '그리드')).toBe('그리드못 읽음');
  expect(card(root, '릴리스 판 진행')).toContain('green 2');
  expect(card(root, '루프 판정')).toContain('등록 0');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드0');
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR0');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5해당 없음');
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
  // RELEASE-LIVE2: 못 읽어도 «발행 현황» 으로 가는 길은 남는다.
  expect(card(root, '릴리스 판 진행')).toBe('릴리스 판 진행못 읽음발행 현황 보기 →');
  expect(root.findByProps({ 'aria-label': '릴리스 판 진행' }).findByType('a').props.href).toBe('/ops/release');
  // LOOP-INTERACT D: 루프 판정 카드에서 루프 상호작용 지도로 한 탭.
  expect(card(root, '루프 판정')).toBe('루프 판정등록 0루프 상호작용 보기 →');
  expect(root.findByProps({ 'aria-label': '루프 판정' }).findByType('a').props.href).toBe('/loops?view=interact');
  expect(card(root, '결정 대기 카드')).toBe('결정 대기 카드못 읽음');
  expect(card(root, '오늘 병합 PR')).toBe('오늘 병합 PR못 읽음');
  expect(card(root, '위험·막힘 톱 5')).toBe('위험·막힘 톱 5못 읽음');
  expect(card(root, '그리드')).toBe('그리드못 읽음');
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
  expect(card(root, '루프 판정')).toBe('루프 판정등록 0루프 상호작용 보기 →');
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

function draftFetch(drafts: () => Response | Promise<Response>, calls: string[] = []) {
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.includes('/v1/drafts/metrics')) return drafts();
    if (url.includes('/v1/grid')) return json(gridData);
    if (url.includes('/v1/ops/seats')) return json(seats);
    if (url.includes('/v1/schedules')) return json({ schedules: [] });
    if (url.includes('/v1/dashboard/loops')) return json({ loops: { loops: [] } });
    if (url.includes('/v1/decisions')) return json({ decisions: [] });
    if (url.includes('/v1/harness/runs')) return json({ completeness: 'complete', landed: [], finished: [], entries: [], finishedObservation: { skippedFiles: 0 } });
    throw Error(`Unexpected GET: ${url}`);
  }) as typeof fetch;
}

test('DRAFT-METRIC card shows inventory, oldest age, drafts without an owner mark and 48h conversion with the measurement time', async () => {
  draftFetch(() => json({ state: 'ready', metrics: draftMetrics, measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null }));
  const root = await mount();
  const text = card(root, 'draft 재고');
  expect(text).toContain('열린 draft168');
  expect(text).toContain('최장 나이5.0일');
  expect(text).toContain('주인 표식 없는 draft12');
  expect(text).not.toContain('처리 중 표식 0건');
  expect(text).toContain('48h 전환율47.1%330/701');
  expect(text).toContain('09:30 측정');
  expect(text).not.toContain('갱신 실패');
  expect(root.findByProps({ 'aria-label': 'draft 재고' }).props.className).toContain('col-span-2');
});

test('DRAFT-METRIC card shows overlap on one line and never turns null fields into zero', async () => {
  const overlap = { launches24h: 3, launched: 4, unmeasured: 0, sourceIncomplete: false,
    linked: 2, autoLanded: 2, autoRate: 1, secondSiblingMedianHours: 4.5, salvaged: 0, salvageUnmeasured: 0 };
  let rate: number | null = 1;
  draftFetch(() => json({ state: 'ready', metrics: { ...draftMetrics, overlap: { ...overlap, autoRate: rate } },
    measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null }));
  let root = await mount();
  expect(card(root, 'draft 재고')).toContain('겹침 발사 24h 3 · 자동 착지 100.0% (2/2) · 둘째 형제 착지 중앙값 4.5h');
  expect(card(root, 'draft 재고')).toContain('열린 draft168');
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  rate = null;
  root = await mount();
  expect(card(root, 'draft 재고')).toContain('겹침 발사 24h 3 · 자동 착지 못 잼 (2/2)');
  expect(card(root, 'draft 재고')).not.toContain('자동 착지 0%');
});

test('DRAFT-METRIC overlap warns when the source is incomplete or launches were unmeasured', async () => {
  const overlap = { launches24h: 3, launched: 5, unmeasured: 0, sourceIncomplete: false,
    linked: 2, autoLanded: 2, autoRate: 1, secondSiblingMedianHours: 4.5, salvaged: 0, salvageUnmeasured: 0 };
  let partial: Omit<typeof overlap, 'unmeasured'> & { unmeasured: number | null } = { ...overlap, sourceIncomplete: true };
  draftFetch(() => json({ state: 'ready', metrics: { ...draftMetrics, overlap: partial },
    measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null }));
  for (const incomplete of [{ ...overlap, sourceIncomplete: true }, { ...overlap, unmeasured: 1 },
    { ...overlap, unmeasured: null }]) {
    partial = incomplete;
    const root = await mount();
    expect(card(root, 'draft 재고')).toContain('겹침 발사 24h 3 · 자동 착지 100.0% (2/2) · 둘째 형제 착지 중앙값 4.5h · 부분 측정');
    expect(card(root, 'draft 재고')).toContain('열린 draft168');
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
  partial = overlap;
  const root = await mount();
  expect(card(root, 'draft 재고')).toContain('겹침 발사 24h 3 · 자동 착지 100.0% (2/2) · 둘째 형제 착지 중앙값 4.5h');
  expect(card(root, 'draft 재고')).not.toContain('부분 측정');
});

test('DRAFT-METRIC card: when no draft carries an owner mark it says so instead of implying 168 orphans', async () => {
  draftFetch(() => json({ state: 'ready', metrics: { ...draftMetrics, needsOwner: draftMetrics.inventory }, measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null }));
  const root = await mount();
  expect(card(root, 'draft 재고')).toContain('주인 표식 없는 draft168처리 중 표식 0건');
});

test('DRAFT-METRIC card: cold cache is 측정 중, failures are 못 읽음 — never zero', async () => {
  for (const [body, expected] of [
    [{ state: 'measuring', metrics: null, measuredAt: null, refreshing: true, reason: null }, 'draft 재고측정 중'],
    [{ state: 'unavailable', metrics: null, measuredAt: null, refreshing: false, reason: 'gh: HTTP 502' }, 'draft 재고못 읽음'],
    [{ state: 'ready', metrics: { ...draftMetrics, inventory: undefined }, measuredAt: '2026-10-08T00:30:00Z' }, 'draft 재고못 읽음'],
    [{ error: 'unauthorized' }, 'draft 재고못 읽음'],
  ] as const) {
    draftFetch(() => json(body, 'error' in body ? 401 : 200));
    const root = await mount();
    expect(card(root, 'draft 재고')).toBe(expected);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
});

test('DRAFT-METRIC card keeps the previous value after a failed refresh and says so; empty inventory is a real zero', async () => {
  draftFetch(() => json({ state: 'ready', metrics: { ...draftMetrics, inventory: 0, oldestAgeHours: null, needsOwner: 0, cohort48h: 0, converted48h: 0, conversion48h: null },
    measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: 'timeout' }));
  const root = await mount();
  const text = card(root, 'draft 재고');
  expect(text).toContain('열린 draft0');
  expect(text).toContain('최장 나이해당 없음');
  expect(text).toContain('48h 전환율표본 없음');
  expect(text).toContain('갱신 실패 — 이전 값');
});

test('DRAFT-METRIC card re-asks the daemon while it is measuring and stops after the value arrives', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const polls: Array<() => void> = [];
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    if (delay !== 10_000) return originalSetTimeout(callback, delay);
    polls.push(callback);
    return polls.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  try {
    let ready = false;
    const calls: string[] = [];
    draftFetch(() => json(ready ? { state: 'ready', metrics: draftMetrics, measuredAt: '2026-10-08T00:30:00Z', refreshing: false, reason: null }
      : { state: 'measuring', metrics: null, measuredAt: null, refreshing: true, reason: null }), calls);
    const root = await mount();
    expect(card(root, 'draft 재고')).toBe('draft 재고측정 중');
    expect(polls).toHaveLength(1);
    ready = true;
    await act(async () => { polls[0]!(); });
    expect(card(root, 'draft 재고')).toContain('열린 draft168');
    expect(calls.filter((url) => url.includes('/v1/drafts/metrics'))).toHaveLength(2);
    expect(polls).toHaveLength(1);
  } finally { timer.mockRestore(); }
});
