import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MissionCard } from './AutopilotMissions';
import type { AutopilotApi, MissionSummary } from '@/lib/autopilot-api';
import {
  MISSION_ROLLUP_UNMEASURED_HINT,
  missionStaleHint,
  missionStaleness,
} from '@/lib/mission-staleness';

// ── MISSIONS-STALE-MARK — «렌더 층» 판정선 ────────────────────────────────────
// 소스 문자열 검사가 «그 코드가 적혀 있다»까지만 말할 수 있으므로, 여기서는 «실제 카드
// 컴포넌트를 렌더한 HTML»로 판정선을 증명한다. `renderToStaticMarkup` 은 effect 를 돌리지
// 않으므로 카드의 초기 화면(접힘 · trace 미로드)이 그대로 나온다 — «멈춤» 표지와 «닫기
// 제안»이 그 초기 화면에 «있나/없나」가 이 파일의 물음이다.
const DAY = 86_400_000;
const STALE_UPDATED_AT = Date.parse('2026-07-12T03:00:00Z'); // ask 실측 «마지막 갱신 07-12»

function fakeApi(): AutopilotApi {
  return {
    missionAction: mock(() => Promise.resolve({})),
    trace: mock(() => Promise.resolve(null)),
  } as unknown as AutopilotApi;
}

function mission(over: Partial<MissionSummary> = {}): MissionSummary {
  return {
    id: 'apm_stale',
    goal: '멈춘 자율 미션',
    source: 'discovery',
    status: 'armed',
    model: null,
    tier: null,
    engine: null,
    createdAt: '2026-07-12T03:00:00Z',
    updatedAt: STALE_UPDATED_AT,
    isAutopilot: true,
    taskCount: 0,
    taskCounts: {},
    ...over,
  };
}

const render = (m: MissionSummary) =>
  renderToStaticMarkup(<MissionCard api={fakeApi()} m={m} onMutate={() => {}} />);

describe('MissionCard 렌더 — «N일 멈춤» 표지 ⊕ 마지막 갱신', () => {
  it('멈춘 자율 미션 카드에 «N일 멈춤 · 마지막 갱신 YYYY-MM-DD» 칩이 «렌더»된다', () => {
    const html = render(mission());
    const days = missionStaleness(STALE_UPDATED_AT, Date.now(), { status: 'armed' })!.days;
    expect(days).toBeGreaterThanOrEqual(14);
    expect(html).toContain(`${days}일 멈춤 · 마지막 갱신 2026-07-12`);
    expect(html).toContain(`title="${missionStaleHint()}"`);
  });

  it('같은 카드에 «닫기 제안»이 렌더된다', () => {
    expect(render(mission())).toContain('닫기 제안');
  });

  it('«종료 확인»창은 닫기 전에는 «렌더되지 않는다» — 한 번 클릭이 cancel 을 부르지 못하게', () => {
    const html = render(mission());
    expect(html).not.toContain('미션 종료 확인');
    expect(html).not.toContain('종료 확인');
    expect(html).toContain('aria-expanded="false"');
  });

  it('기준(14일) «안»의 미션은 칩도 «닫기 제안»도 없다', () => {
    const html = render(mission({ updatedAt: Date.now() - 3 * DAY }));
    expect(html).not.toContain('일 멈춤');
    expect(html).not.toContain('닫기 제안');
  });

  it('«마지막 갱신»을 못 읽은 미션은 멈춤으로 «주장하지» 않는다', () => {
    const html = render(mission({ updatedAt: undefined }));
    expect(html).not.toContain('일 멈춤');
    expect(html).not.toContain('닫기 제안');
  });

  it('종료 상태는 89일이 지나도 «멈춤»이 아니다 — apm(done) ⊕ TOX(completed·cancelled)', () => {
    for (const status of ['done', 'completed', 'cancelled']) {
      const html = render(mission({ status }));
      expect(html).not.toContain('일 멈춤');
      expect(html).not.toContain('닫기 제안');
    }
  });
});

describe('MissionCard 렌더 — 파생 롤업 («미측정» ≠ «파생 0»)', () => {
  it('파생을 «못 잰» 카드는 «파생 미측정»을 렌더하고 «왜»인지 title 로 말한다', () => {
    const html = render(mission({ derived: undefined }));
    expect(html).toContain('파생 미측정');
    expect(html).toContain(`title="${MISSION_ROLLUP_UNMEASURED_HINT}"`);
  });

  it('파생이 «정말로 0»인 카드는 «파생 0»을 렌더한다 — 미측정과는 «다른» 문면', () => {
    const html = render(mission({
      derived: { total: 0, ok: 0, stale: 0, error: 0, active: 0, pending: 0 },
    }));
    expect(html).toContain('파생 0');
    expect(html).not.toContain('파생 미측정');
  });

  it('«전부 파생 0»이던 ask 의 미션이 실측 롤업을 받으면 그 수가 보인다', () => {
    const html = render(mission({
      derived: { total: 4, ok: 2, stale: 1, error: 1, active: 0, pending: 0 },
    }));
    expect(html).toContain('파생 4');
    expect(html).not.toContain('파생 미측정');
  });
});
