import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SchedulerPanel,
  ScheduleLoadContent,
  fetchScheduleLoad,
  parseIdsFilter,
  isCurrentScheduleRequest,
  reportScheduleLoadFailure,
  type ScheduleJob,
  type ScheduleLoadState,
  type SchedulesPayload,
} from './SchedulerPanel';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const EMPTY: SchedulesPayload = {
  total: 0,
  adopted: 0,
  byCategory: {},
  bySource: {},
  jobs: [],
  generatedAt: '2026-08-14T00:00:00.000Z',
};

const JOB: ScheduleJob = {
  id: 'job-1',
  name: 'Morning digest',
  cron: '0 7 * * *',
  intervalMs: null,
  category: 'digest',
  domain: 'finance',
  source: 'registry',
  enabled: true,
  runVia: 'elanous',
  lastRun: null,
  command: 'scripts/digest.ts',
  note: null,
};

function render(load: ScheduleLoadState): string {
  const jobs = load.kind === 'ready' ? load.data.jobs : [];
  return renderToStaticMarkup(
    <ScheduleLoadContent
      load={load}
      groups={jobs.length ? [{ domain: 'finance', jobs }] : []}
      onRefresh={() => {}}
      onAction={() => {}}
      busy={false}
      acting={false}
    />,
  );
}

const STUB_DAEMON = {
  config: { baseUrl: '', token: '', provider: '' },
  setConfig: () => {},
  client: {} as never,
  sessionId: 'scheduler-test',
  setSessionId: () => {},
};

describe('SchedulerPanel · render contract', () => {
  test('mounts under DaemonContext.Provider', () => {
    const html = renderToStaticMarkup(
      <DaemonContext.Provider value={STUB_DAEMON}>
        <SchedulerPanel />
      </DaemonContext.Provider>,
    );
    expect(html).toContain('Schedules');
    expect(html).toContain('Loading schedules…');
  });

  test('renders loading only while the initial request is pending', () => {
    const html = render({ kind: 'loading' });
    expect(html).toContain('Loading schedules…');
    expect(html).not.toContain('Failed to load schedules');
    expect(html).not.toContain('no schedules');
  });

  test('renders persistent failure reason and Retry without loading or empty text', () => {
    const html = render({ kind: 'error', reason: 'daemon unavailable' });
    expect(html).toContain('Failed to load schedules');
    expect(html).toContain('daemon unavailable');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Loading schedules…');
    expect(html).not.toContain('no schedules');
  });

  test('keeps empty and non-empty successful content distinct from failure', () => {
    const empty = render({ kind: 'ready', data: EMPTY });
    expect(empty).toContain('no schedules');
    expect(empty).not.toContain('Failed to load schedules');

    const populated = render({ kind: 'ready', data: { ...EMPTY, total: 1, jobs: [JOB] } });
    expect(populated).toContain('Finance');
    expect(populated).toContain('Morning digest');
    expect(populated).not.toContain('Failed to load schedules');
    expect(populated).not.toContain('no schedules');
  });
});

describe('SchedulerPanel · fetch and request generation', () => {
  test('uses the existing endpoint and turns rejection into persistent error plus existing toast', async () => {
    const paths: string[] = [];
    const load = await fetchScheduleLoad(async (path) => {
      paths.push(path);
      throw new Error('daemon unavailable');
    });
    const messages: string[] = [];
    if (load.kind === 'error') reportScheduleLoadFailure(load.reason, (message) => messages.push(message));

    // 새 읽기 API 가 먼저 · 판올림 전 데몬이면 옛 대시보드 경로로 한 번 더.
    expect(paths).toEqual(['/v1/schedules?includeOff=1', '/v1/dashboard/schedules']);
    expect(load).toEqual({ kind: 'error', reason: 'daemon unavailable' });
    expect(messages).toEqual(['scheduler load failed: daemon unavailable']);
  });

  test('Retry replacement request can recover into the same successful row content', async () => {
    const failed = await fetchScheduleLoad(async () => { throw new Error('temporary outage'); });
    const recovered = await fetchScheduleLoad(async () => ({ ok: true, schedules: { ...EMPTY, total: 1, jobs: [JOB] } }));

    expect(failed.kind).toBe('error');
    expect(recovered).toEqual({ kind: 'ready', data: { ...EMPTY, total: 1, jobs: [JOB] } });
    expect(render(recovered)).toContain('Morning digest');
  });

  test('a replacement client begins a new generation and stale prior-client completion is rejected', () => {
    const clientA = {};
    const clientB = {};
    const requestA = 1;
    const requestB = 2;

    expect(isCurrentScheduleRequest(requestB, clientB, requestB, clientB)).toBe(true);
    expect(isCurrentScheduleRequest(requestA, clientA, requestB, clientB)).toBe(false);
    expect(isCurrentScheduleRequest(requestB, clientA, requestB, clientB)).toBe(false);
  });
});

// ── 배선 핀 (사람 수습 · 2026-08-14) ──────────────────────────────────
//
// ⛔ 리뷰가 세 라운드에 걸쳐 「클릭·effect·경합을 «실제로» 돌리는 회귀」를 요구했고
//    자식이 매번 근사치를 냈다. 그런데 ***이 저장소의 `bun test` 에는 jsdom 이 없다.***
//    같은 결론이 이미 문서로 있다 — MemoIntakePreview.test.tsx 머리말:
//      "Network call + swipe + register dispatch run in the browser only
//       (no jsdom in `bun test`), so we pin the endpoint paths + decision
//       tables via grep — the runtime path is exercised by the Dia CDP dogfood"
//
// ⇒ 그래서 「불가능한 증명」 대신 이 저장소가 «정한» 대체 증명을 쓴다:
//    소스 문자열 핀은 ***배선을 지우면 실패한다*** — 그것이 리뷰가 요구한 성질이다.
//    ⛔ 이 핀은 「행동이 옳다」를 증명하지 않는다. 「배선이 «있다»」만 증명한다.
//       행동 검증은 Dia CDP dogfood 축이고 이 착지 밖이다.
import { readFileSync as __readPanelSrc } from 'node:fs';
import { dirname as __dirPanel } from 'node:path';
import { fileURLToPath as __urlPanel } from 'node:url';

const PANEL_SRC = __readPanelSrc(
  `${__dirPanel(__urlPanel(import.meta.url))}/SchedulerPanel.tsx`,
  'utf8',
);

describe('SchedulerPanel · 배선 핀 (지우면 실패한다)', () => {
  test('mount 시 자동 조회가 effect 로 걸려 있다', () => {
    // ⛔ 느슨하게 쓰면 «30초 interval 줄»이 대신 물려 배선을 지워도 통과한다(실측).
    //    그래서 effect 본문 «첫 줄»을 못 박고, interval 은 따로 센다.
    expect(PANEL_SRC).toMatch(/useEffect\(\(\) => \{\n\s*void refresh\(\);/);

  });

  test('실패 화면의 Retry 가 같은 조회를 다시 부른다', () => {
    expect(PANEL_SRC).toContain('Failed to load schedules');
    expect(PANEL_SRC).toMatch(/onClick=\{onRefresh\}[\s\S]{0,120}Retry/);
  });

  test('경합 요청 가드가 조회 «안에서» 실제로 불린다', () => {
    expect(PANEL_SRC).toMatch(/const refresh = useCallback\([\s\S]{0,900}isCurrentScheduleRequest\(/);
  });

  test('실패는 화면 상태 ⊕ 기존 toast 둘 다로 간다', () => {
    expect(PANEL_SRC).toContain('reportScheduleLoadFailure(nextLoad.reason, toast.error)');
  });

  test('세 상태의 문면이 서로 다르다', () => {
    for (const text of ['Loading schedules…', 'Failed to load schedules', 'no schedules']) {
      expect(PANEL_SRC).toContain(text);
    }
  });
});

describe('SchedulerPanel · /v1/schedules cards', () => {
  test('cards map to rows: «켜짐» comes from state, not registry enabled; next and duplicate carried', async () => {
    const card = {
      id: 'abc', name: 'drafts sweep', source: 'crontab', cron: '*/10 * * * *', intervalMs: null,
      command: 'bun bin/elanous.mjs harness drafts sweep', runVia: 'crontab', category: 'maintenance', domain: 'elanous', note: null,
      state: 'firing' as const, registryEnabled: false, next: ['2099-01-01T00:10:00.000Z'],
      lastRun: { at: '2026-09-28T00:00:00.000Z', status: 'ok', exit: 0, durationMs: 1200, via: 'crontab' }, flags: ['duplicate'],
    };
    const off = { ...card, id: 'off', name: 'old job', state: 'off' as const, registryEnabled: true, flags: [], lastRun: null };
    const launchd = { ...card, id: 'launchd:com.elanous.nexus', name: 'nexus', source: 'launchd', runVia: 'launchd', cron: null, state: 'live' as const, flags: ['no-history'], lastRun: null };
    const paths: string[] = [];
    const load = await fetchScheduleLoad(async (path) => { paths.push(path); return { schedules: [card, off, launchd], count: 3 }; });
    expect(paths).toEqual(['/v1/schedules?includeOff=1']);
    if (load.kind !== 'ready') throw new Error('expected ready');
    const [a, b] = load.data.jobs;
    expect(a).toMatchObject({ enabled: true, state: 'firing', lastStatus: 'ok', runVia: 'crontab' });
    // 레지스트리는 enabled 인데 발화 경로가 없다 ⇒ 꺼짐.
    expect(b).toMatchObject({ enabled: false, state: 'off' });
    expect(load.data.byState).toEqual({ firing: 1, off: 1, live: 1 });
    const html = render(load);
    expect(html).toContain('발화 중');
    expect(html).toContain('꺼짐');
    expect(html).toContain('duplicate');
    // launchd 는 레지스트리 조작 대상이 아니다 — 액션 없음(✕ 는 crontab 두 행에만).
    expect(html.split('>✕<').length - 1).toBe(2);
  });
});

describe('SchedulerPanel · ?ids= filter (Missions «이 미션을 부르는 스케줄»)', () => {
  test('exact id list, empty → null', () => {
    expect(parseIdsFilter('?ids=a,b%3Ac')).toEqual(['a', 'b:c']);
    expect(parseIdsFilter('?ids=')).toBeNull();
    expect(parseIdsFilter('')).toBeNull();
  });
});
