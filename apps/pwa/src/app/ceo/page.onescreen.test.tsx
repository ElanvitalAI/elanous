import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import CeoPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CEO-VIEW 무대: 생산 진입점(apps/pwa/src/app/ceo/page.tsx 의 default export)을 그대로 마운트하고,
 * 페이지가 실제로 부르는 DaemonClient.fetchResponse 만 fetch mock 시나리오로 갈아 끼운다.
 * 소스 문자열을 읽지 않고 «렌더된 한 화면»을 판정한다.
 */

const NOW = Date.parse('2026-10-23T10:00:00+09:00');
const MOCKED_AT = new Date(NOW - 30 * 60_000).toISOString();

const KNOWN_PATHS = [
  '/v1/ops/overview',
  '/v1/ops/seats',
  '/v1/schedules',
  '/v1/dashboard/loops',
  '/v1/decisions',
  '/v1/harness/runs',
  '/v1/grid',
  '/v1/drafts/metrics',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function seat(seatName: string, green: number, yellow: number) {
  return {
    seat: seatName,
    label: seatName,
    now: { text: seatName + ' 진행 중', at: '2026-10-23T09:40:00Z' },
    landed:
      seatName === 'OP'
        ? [{ pr: 1, title: 'PR #1', at: '2026-10-23T01:00:00Z', checklistId: 'c-1' }]
        : [],
    blocked: null,
    pendingDecisions: seatName === 'OP' ? 1 : 0,
    checklist: { green, yellow, red: 0, done: green + yellow },
    health: null,
  };
}

function scheduleRow(id: string, name: string, status: string, at: string) {
  return {
    id,
    name,
    source: 'user',
    category: 'release',
    domain: 'ops',
    runVia: 'daemon',
    state: 'live',
    cron: '0 9 * * *',
    intervalMs: 86_400_000,
    next: ['2026-10-24T00:00:00Z'],
    lastRun: { at, status, exit: status === 'failure' ? 1 : 0 },
  };
}

const OVERVIEW = { verdict: 'supply-empty', reasons: ['빈 자리 2 · 발사 가능 칸 0'], cacheAgeMs: 900 };
const SEATS = { date: '2026-10-23', version: '0.2.37', seats: [seat('OP', 4, 1), seat('TC', 2, 1), seat('MK', 1, 0), seat('UX', 0, 0)] };
const SCHEDULES = { schedules: [scheduleRow('sched-1', 'release-cut', 'failure', '2026-10-23T00:20:00Z')] };
const LOOPS = { loops: { loops: [{ name: 'default-loop', label: 'default-loop', last: { at: '2026-10-23T00:10:00Z', status: 'failure' } }] } };
const DECISIONS = {
  decisions: [
    { id: 'd1', title: '발행 컷 승인', dueAt: '2026-10-22T09:00:00Z', status: 'open' },
    { id: 'd2', title: '칸 재배치', dueAt: '2026-10-24T09:00:00Z', status: 'open' },
  ],
};
const RUNS = {
  landed: [
    { number: 1, mergedAt: '2026-10-23T01:00:00Z' },
    { number: 2, mergedAt: '2026-10-23T02:00:00Z' },
    { number: 3, mergedAt: '2026-10-20T02:00:00Z' },
  ],
  completeness: 'complete',
  finished: [{ runId: 'run-7', status: 'failed', endedAt: '2026-10-23T00:30:00Z', objective: '하니스 런 실패' }],
  entries: [],
  finishedObservation: { skippedFiles: 0 },
};
const GRID = {
  hq: {
    record: { holder: 'OP', generation: 3, acquiredAt: '2026-10-23T08:00:00Z', renewedAt: '2026-10-23T09:57:55Z', ttlSeconds: 900 },
    ageSeconds: 125,
    expired: false,
    reason: null,
  },
  members: [
    { context: 'OP', capacity: 3, running: 2, pending: 0, occupied: 2, reason: null },
    { context: 'TC', capacity: 5, running: 1, pending: 0, occupied: 1, reason: null },
  ],
  poolReason: null,
};
const DRAFTS = {
  state: 'ready',
  metrics: { pending: 1, inProgress: 0, done: 2, failed: 0 },
  measuredAt: MOCKED_AT,
  refreshing: false,
  reason: null,
};

function route(path: string): Response | null {
  if (path.includes('/v1/ops/overview')) return json(OVERVIEW);
  if (path.includes('/v1/ops/seats')) return json(SEATS);
  if (path.includes('/v1/schedules')) return json(SCHEDULES);
  if (path.includes('/v1/dashboard/loops')) return json(LOOPS);
  if (path.includes('/v1/decisions')) return json(DECISIONS);
  if (path.includes('/v1/harness/runs')) return json(RUNS);
  if (path.includes('/v1/grid')) return json(GRID);
  if (path.includes('/v1/drafts/metrics')) return json(DRAFTS);
  return null;
}

async function mountPage(): Promise<{ root: ReactTestRenderer; calls: string[] }> {
  const calls: string[] = [];
  const client = {
    async fetchResponse(path: string): Promise<Response> {
      calls.push(path);
      const response = route(path);
      if (!response) throw new Error('unrouted fetch: ' + path);
      return response;
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <DaemonContext.Provider value={{ client } as never}>
        <CeoPage />
      </DaemonContext.Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { root, calls };
}

function text(node: { children: Array<string | unknown> }): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : text(child as { children: Array<string | unknown> })))
    .join('');
}

function card(root: ReactTestRenderer, label: string): string {
  const matches = root.root.findAllByProps({ 'aria-label': label });
  expect(matches.length).toBeGreaterThan(0);
  return text(matches[0]!);
}

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
});

test('CEO-VIEW: 한 화면 답 — 막힘·결정·착지·예비·하트비트를 화면 하나로 답한다', async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const { root, calls } = await mountPage();
    mounted = root;

    // 생산 진입점 경유: 페이지가 실제로 부른 경로만, 새로 지어낸 원천 없이.
    expect(calls.length).toBeGreaterThanOrEqual(KNOWN_PATHS.length);
    expect(calls.filter((path) => !KNOWN_PATHS.some((known) => path.includes(known)))).toEqual([]);

    const answer = card(root, '한 화면 답');
    // 지금 무엇이 막혔나 — 흐름 판정 + 위험 톱 1
    expect(answer).toContain('지금 막힘');
    expect(answer).toContain('공급 부족');
    expect(answer).toContain('멈춘 하니스 런');
    // 무엇을 결정해야 하나
    expect(answer).toContain('결정 대기 2건');
    // 오늘 착지 수 · 예비 · 하트비트
    expect(answer).toContain('오늘 착지2건');
    expect(answer).toContain('예비 5칸');
    expect(answer).toContain('하트비트 2분 전');
    // 판 green/노랑 + 컷·발행 진입점
    expect(answer).toContain('green 7 · 노랑 2');
    expect(answer).toContain('컷·발행 현황');

    // 한 화면 구성은 기존 카드가 그대로 진다 — 텍스트 보고를 대체한다.
    expect(card(root, '릴리스 판 진행')).toContain('green 7');
    expect(card(root, '릴리스 판 진행')).toContain('노랑 2');
    expect(card(root, '루프 판정')).toContain('루프');
    expect(card(root, '결정 대기 카드')).toContain('2');
    expect(card(root, '오늘 병합 PR')).toContain('2');
    expect(card(root, '위험·막힘 톱 5')).toContain('멈춘 하니스 런');
    expect(card(root, '그리드')).toContain('칸 사용 3/8');
    expect(card(root, '그리드')).toContain('본부');

    // 폰·태블릿 폭: 2열 → sm 이상에서 넓어지는 반응형 그리드
    const answerRegion = root.root.findByProps({ 'aria-label': '한 화면 답' });
    expect(String(answerRegion.props.className)).toContain('grid-cols-2');
    expect(String(answerRegion.props.className)).toContain('sm:grid-cols-3');
    const cards = root.root.findByProps({ 'aria-label': '대표 조망 카드' });
    expect(String(cards.props.className)).toContain('grid-cols-2');
    expect(String(cards.props.className)).toContain('sm:gap-4');

    // 텍스트 보고 대체 — 보고용 입력 필드를 두지 않는다.
    expect(root.root.findAllByType('textarea')).toHaveLength(0);
  } finally {
    Date.now = realNow;
  }
});
