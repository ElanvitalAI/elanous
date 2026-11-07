// FabricStageHeader 단계 표 배선 가드(F3 · 2026-07-09).
// 작업·스케줄 링크가 정확한 라우트와 사이드바에 연결되는지 확인한다.

import { describe, it, expect } from 'bun:test';
import { FABRIC_STAGES, FabricStageHeader } from './FabricStageHeader';
import LoopsPage from '@/app/loops/page';
import { LoopsView } from '@/components/loops/LoopsView';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SIDEBAR_NAV_ITEMS } from './sidebar-nav-items';

describe('FABRIC_STAGES', () => {
  it('남은 작업 흐름은 tasks → scheduler 순이다', () => {
    expect(FABRIC_STAGES.map((s) => s.key)).toEqual([
      'tasks', 'scheduler',
    ]);
  });

  it('구 intake 단계는 제거됨(포착=골던지기·텔레그램으로 흡수)', () => {
    expect(FABRIC_STAGES.map((s) => s.href)).not.toContain('/intake');
  });

  it('각 단계 href 가 canonical 라우트', () => {
    const byKey = Object.fromEntries(FABRIC_STAGES.map((s) => [s.key, s.href]));
    expect(byKey.tasks).toBe('/tasks');
    expect(byKey.scheduler).toBe('/scheduler');
  });

  it('루프 현황은 스케줄 단계를 공유하되 별도 파이프라인 단계를 만들지 않는다', () => {
    expect(LoopsPage().props.children.type).toBe(LoopsView);
    expect(renderToStaticMarkup(createElement(FabricStageHeader, { active: 'scheduler' }))).toMatch(/<a aria-current="page"[^>]*href="\/scheduler"/);
    expect(FABRIC_STAGES.map((stage) => stage.href)).not.toContain('/loops');
  });

  it('모든 단계 href 가 사이드바 nav 에도 존재(표면 정합)', () => {
    const navHrefs = new Set(SIDEBAR_NAV_ITEMS.map((i) => i.href));
    for (const s of FABRIC_STAGES) expect(navHrefs.has(s.href)).toBe(true);
  });

  it('대표 조망판은 운영 메뉴에서 열리고 파이프라인 단계는 늘리지 않는다', () => {
    expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === '/ceo')).toMatchObject({ group: 'ops', label: '대표 조망판' });
    expect(FABRIC_STAGES.map((stage) => stage.href)).not.toContain('/ceo');
  });

  it('label·sub·num 이 모두 채워짐', () => {
    for (const s of FABRIC_STAGES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.sub.length).toBeGreaterThan(0);
      expect(s.num.length).toBeGreaterThan(0);
    }
  });
});
