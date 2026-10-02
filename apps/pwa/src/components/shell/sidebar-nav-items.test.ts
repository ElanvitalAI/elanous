// 2026-05-07 dogfood feedback — sidebar nav 순서 + tooltip 표의
// pure data contract lock. Next App Router 훅 의존 없이 표 shape 만
// 검증.
//
// Phase 2 (PWA chat ↔ voice 일원화 · 2026-05-07) — 'Voice' nav 항목
// 삭제 (chat 탭 헤더 mic toggle 이 voice 진입점을 흡수). 최상단
// 2 슬롯은 Terminal · Chat 만 고정.

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  NON_MENU_SIDEBAR_ROUTE_CATEGORIES,
  NON_MENU_SIDEBAR_ROUTES,
  SIDEBAR_NAV_ITEMS,
  type NonMenuSidebarRoute,
  type SidebarRouteHref,
} from './sidebar-nav-items';
import { ROUTE_GUIDANCE_ITEMS } from '../welcome/WelcomeHome';
import { PRIVATE_SIDEBAR_NAV_ITEMS } from './sidebar-nav-private';

const APP_DIRECTORY = resolve(dirname(import.meta.path), '../../app');
const PAGE_FILE_PATTERN = /^page\.(?:ts|tsx|js|jsx)$/;
const ROUTE_GROUP_PATTERN = /^\(.+\)$/;
const DYNAMIC_SEGMENT_PATTERN = /^\[.+\]$/;

/** Current App Router address inventory: static pages use their complete href;
 * the `/missions/[id]` dynamic page is represented by its `/missions` parent. */
// 비공개 전용 화면(개인 투자 대시보드)은 공개본에 없다 — 그 주소는 비공개 모듈에서 가져와 더한다.
const CURRENT_BUILT_ROUTE_HREFS: readonly SidebarRouteHref[] = [
  ...PRIVATE_SIDEBAR_NAV_ITEMS.map((item) => item.href as SidebarRouteHref),
  '/',
  '/404',
  '/approvals',
  '/autopilot',
  '/board',
  '/botlab',
  '/bots',
  '/chat',
  '/consult',
  '/control',
  '/design-check',
  '/editor',
  '/exec',
  '/field',
  '/intake',
  '/live',
  '/market',
  '/missions',
  '/morning',
  '/ops/checklist',
  '/ops/release',
  '/observatory',
  '/reflection',
  '/scheduler',
  '/sessions',
  '/settings',
  '/settings/devices',
  '/setup',
  '/setup/done',
  '/share',
  '/showroom',
  '/tasks',
  '/term',
  '/trace',
  '/vault',
  '/workflows',
  '/workflows/chat-ui',
  '/workspace',
  '/worktrees',
];

/**
 * Every static page is its full visible href, independent of nesting depth.
 * A dynamic page contributes the visible parent before its first dynamic
 * segment because static export has no concrete child href to account for.
 */
function builtRouteHrefs(directory = APP_DIRECTORY): SidebarRouteHref[] {
  const pagePaths: string[] = [];
  const visit = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && PAGE_FILE_PATTERN.test(entry.name)) pagePaths.push(path);
    }
  };
  visit(directory);

  const hrefs = pagePaths.map((pagePath): SidebarRouteHref => {
    const segments = relative(directory, dirname(pagePath)).split(sep).filter(Boolean);
    const visibleSegments = segments.filter((segment) => !ROUTE_GROUP_PATTERN.test(segment));
    const dynamicSegmentIndex = visibleSegments.findIndex((segment) => DYNAMIC_SEGMENT_PATTERN.test(segment));
    const addressSegments = dynamicSegmentIndex >= 0
      ? visibleSegments.slice(0, dynamicSegmentIndex)
      : visibleSegments;
    return addressSegments.length === 0
      ? '/'
      : `/${addressSegments.join('/')}` as SidebarRouteHref;
  });

  // Next emits this static error entry whenever the App Router has pages.
  return [...hrefs, '/404'];
}

function expectUniqueHrefs(hrefs: readonly string[]): void {
  expect(new Set(hrefs).size).toBe(hrefs.length);
}

function expectCompleteRouteAccounting(
  builtHrefs: readonly string[],
  guidanceItems: readonly { href: SidebarRouteHref; navigable: boolean }[],
): void {
  const navigationHrefs: string[] = guidanceItems.filter((item) => item.navigable).map((item) => item.href);
  const nonMenuHrefs: string[] = guidanceItems.filter((item) => !item.navigable).map((item) => item.href);
  expectUniqueHrefs(navigationHrefs);
  expectUniqueHrefs(nonMenuHrefs);
  const overlappingHref = navigationHrefs.find((href) => nonMenuHrefs.includes(href));
  if (overlappingHref) throw new Error(`menu and non-menu route overlap: ${overlappingHref}`);
  expect([...navigationHrefs, ...nonMenuHrefs].sort()).toEqual([...builtHrefs].sort());
}

describe('SIDEBAR_NAV_ITEMS — order + tooltip table (2026-05-07 dogfood)', () => {
  it('Terminal · Chat 가 최상단 2 슬롯에 고정', () => {
    expect(SIDEBAR_NAV_ITEMS[0]!.label).toBe('Terminal');
    expect(SIDEBAR_NAV_ITEMS[1]!.label).toBe('Chat');
  });

  it('Voice 항목은 더 이상 nav 에 노출되지 않음 (Phase 2 일원화)', () => {
    const voice = SIDEBAR_NAV_ITEMS.find((i) => i.label === 'Voice');
    expect(voice).toBeUndefined();
  });

  it('각 nav item 에 한국어 hint 가 비어있지 않게 채워짐', () => {
    for (const item of SIDEBAR_NAV_ITEMS) {
      expect(item.hint.length).toBeGreaterThan(0);
      // 한국어 문자 또는 영문/특수 모두 허용 — 빈 문자열만 차단.
    }
  });

  it('Terminal · Chat 의 hint 가 사용자 친화적 한국어 문구', () => {
    expect(SIDEBAR_NAV_ITEMS[0]!.hint).toContain('터미널');
    expect(SIDEBAR_NAV_ITEMS[1]!.hint).toContain('채팅');
  });

  it('href 는 unique', () => {
    expectUniqueHrefs(SIDEBAR_NAV_ITEMS.map((i) => i.href));
  });

  it('Workspace 는 kind=null (intent 라우팅 미적용 · 직접 페이지 진입)', () => {
    const ws = SIDEBAR_NAV_ITEMS.find((i) => i.label === 'Workspace');
    expect(ws).toBeDefined();
    expect(ws!.kind).toBeNull();
  });

  it('Intake 는 Chat 바로 다음 · href=/intake · kind=null · 되살린 힌트', () => {
    const intakeIdx = SIDEBAR_NAV_ITEMS.findIndex((i) => i.href === '/intake');
    expect(intakeIdx).toBe(2);
    const intake = SIDEBAR_NAV_ITEMS[intakeIdx]!;
    expect(intake.label).toBe('Intake');
    expect(intake.kind).toBeNull();
    expect(intake.hint).toBe('넣으면 흡수 · 작업 · 그래프로 (URL · 미션 · 메모)');
    expect(NON_MENU_SIDEBAR_ROUTES.some((route) => route.href === '/intake')).toBe(false);
  });

  it('Approvals 는 Intake 바로 다음이고 직접 페이지로 진입한다', () => {
    const item = SIDEBAR_NAV_ITEMS[3]!;
    expect(item.href).toBe('/approvals');
    expect(item.label).toBe('Approvals');
    expect(item.hint).toBe('아이디어 PR 요약 · 승인하고 머지');
    expect(item.kind).toBeNull();
    expect(item.icon).toBeDefined();
  });

  it('Showroom 은 Approvals 다음 슬롯 · kind=null · href=/showroom (CV-3 P1)', () => {
    const showroomIdx = SIDEBAR_NAV_ITEMS.findIndex((i) => i.label === 'Showroom');
    expect(showroomIdx).toBe(4);
    const sr = SIDEBAR_NAV_ITEMS[showroomIdx]!;
    expect(sr.href).toBe('/showroom');
    expect(sr.kind).toBeNull();
    expect(sr.hint).toContain('multi-agent');
  });

  it('편집기 하나가 두 모드에 진입하고 옛 워크플로 주소는 메뉴 밖으로 보존된다', () => {
    const editor = SIDEBAR_NAV_ITEMS.find((item) => item.label === '편집기');
    expect(editor?.href).toBe('/editor');
    expect(editor?.kind).toBeNull();
    expect(editor?.hint).toContain('실행 그래프');
    expect(SIDEBAR_NAV_ITEMS.some((item) => item.href === '/workflows')).toBe(false);
    expect(NON_MENU_SIDEBAR_ROUTES.find((route) => route.href === '/workflows')?.category).toBe('workflow-legacy-redirect');
  });

  it('Worktrees 항목 · href=/worktrees · kind=null · GitBranch 아이콘', () => {
    const worktreesIdx = SIDEBAR_NAV_ITEMS.findIndex((i) => i.label === 'Worktrees');
    expect(worktreesIdx).toBeGreaterThan(0);
    const worktrees = SIDEBAR_NAV_ITEMS[worktreesIdx]!;
    expect(worktrees.href).toBe('/worktrees');
    expect(worktrees.kind).toBeNull();
    expect(worktrees.hint).toContain('작업 트리');
    expect(worktrees.icon).toBeDefined();
    // 2026-09-28 탭 다이어트 — Design 이 메뉴로 올라와 20(공개 10 · Labs 3 · 숨김 7).
    expect(SIDEBAR_NAV_ITEMS).toHaveLength(23 + PRIVATE_SIDEBAR_NAV_ITEMS.length);
  });

  it('마켓은 읽기 화면으로 직접 진입한다', () => {
    const market = SIDEBAR_NAV_ITEMS.find(item => item.href === '/market');
    expect(market?.label).toBe('마켓');
    expect(market?.kind).toBeNull();
    expect(market?.hint).toContain('설치됨');
  });

  it('Bots 항목 · href=/bots · kind=null · 읽기 전용 카탈로그 안내', () => {
    const bots = SIDEBAR_NAV_ITEMS.find((item) => item.label === 'Bots');
    expect(bots).toBeDefined();
    expect(bots!.href).toBe('/bots');
    expect(bots!.kind).toBeNull();
    expect(bots!.hint).toContain('읽기 전용');
  });

  // 2026-07-08 — Scheduler 부활(registry 기반 · 은퇴한 workflow-trigger 통합
  // 모델이 투자 크론을 못 담아 공백이 생겼던 것을 되살림). kind=null(페이지
  // 직접 진입 · workspace 탭 안 만듦).
  // 2026-09-28 — 이름만 «Schedules»(대표 «스케줄러 종합 현황» 탭 · 🅣 계약 #21428) · 주소는 호환 그대로.
  it('Schedules 항목 · href=/scheduler · kind=null', () => {
    const idx = SIDEBAR_NAV_ITEMS.findIndex((i) => i.label === 'Schedules');
    expect(idx).toBeGreaterThan(0);
    const s = SIDEBAR_NAV_ITEMS[idx]!;
    expect(s.href).toBe('/scheduler');
    expect(s.kind).toBeNull();
  });

  it('메뉴 밖 주소는 사유와 허용된 분류로 등록되고 nav 에 노출되지 않음', () => {
    expect(NON_MENU_SIDEBAR_ROUTES.length).toBeGreaterThan(0);
    const navHrefs = new Set(SIDEBAR_NAV_ITEMS.map((item) => item.href));
    for (const route of NON_MENU_SIDEBAR_ROUTES) {
      expect(route.reason.length).toBeGreaterThan(0);
      expect(NON_MENU_SIDEBAR_ROUTE_CATEGORIES).toContain(route.category);
      expect(navHrefs).not.toContain(route.href);
    }
  });

  it('현재 App Router 빌드 주소 인벤토리가 재귀적 정적 주소 회계와 일치함', () => {
    expect(builtRouteHrefs().sort()).toEqual([...CURRENT_BUILT_ROUTE_HREFS].sort());
  });

  it('실제 App Router 빌드 주소는 홈·404가 소비하는 공유 안내 회계에 정확히 한 번씩 속함', () => {
    expectCompleteRouteAccounting(CURRENT_BUILT_ROUTE_HREFS, ROUTE_GUIDANCE_ITEMS);
  });

  it('주소 분류가 빠지면 누락 주소를 표시하며 실패함', () => {
    const guidanceWithoutMorning = ROUTE_GUIDANCE_ITEMS.filter((route) => route.href !== '/morning');
    expect(() => expectCompleteRouteAccounting(builtRouteHrefs(), guidanceWithoutMorning)).toThrow('/morning');
  });

  it('중첩 정적 주소가 미분류이면 그 전체 href를 표시하며 실패함', () => {
    const guidanceWithoutSetupDone = ROUTE_GUIDANCE_ITEMS.filter((route) => route.href !== '/setup/done');
    expect(() => expectCompleteRouteAccounting(CURRENT_BUILT_ROUTE_HREFS, guidanceWithoutSetupDone)).toThrow('/setup/done');
  });

  it('메뉴 주소를 비메뉴 분류에 중복 기록하면 실패함', () => {
    const duplicateMenuRoute: NonMenuSidebarRoute = {
      href: '/chat',
      category: 'retired',
      reason: 'duplicate fixture',
    };
    expect(() => expectCompleteRouteAccounting(
      CURRENT_BUILT_ROUTE_HREFS,
      [...ROUTE_GUIDANCE_ITEMS, { href: duplicateMenuRoute.href, navigable: false }],
    )).toThrow('/chat');
  });

  it('동적 주소는 parent만, 중첩 정적 주소는 전체 href로 회계함', () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), 'sidebar-route-accounting-'));
    try {
      mkdirSync(join(fixtureDirectory, 'foo', 'bar'), { recursive: true });
      mkdirSync(join(fixtureDirectory, 'missions', '[id]'), { recursive: true });
      writeFileSync(join(fixtureDirectory, 'foo', 'bar', 'page.tsx'), 'export default null;');
      writeFileSync(join(fixtureDirectory, 'missions', '[id]', 'page.tsx'), 'export default null;');

      expect(builtRouteHrefs(fixtureDirectory).sort()).toEqual([
        '/404',
        '/foo/bar',
        '/missions',
      ]);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('확인된 비메뉴 주소는 각자의 서로 다른 이유 분류를 유지함', () => {
    const categoryByHref = new Map(NON_MENU_SIDEBAR_ROUTES.map((route) => [route.href, route.category]));

    expect(categoryByHref.get('/intake')).toBeUndefined();
    expect(categoryByHref.get('/share')).toBe('system-share-target');
    expect(categoryByHref.get('/missions')).toBe('dynamic-route-parent');
    expect(categoryByHref.get('/setup')).toBe('provider-onboarding');
    expect(categoryByHref.get('/404')).toBe('error-page');
    expect(categoryByHref.get('/morning')).toBe('unwired-screen');
    // /design-check 는 2026-09-28 메뉴 «Design» 으로 올라갔다(비메뉴 목록에 없다).
    expect(categoryByHref.get('/design-check')).toBeUndefined();
    expect(categoryByHref.get('/botlab')).toBe('diagnostic-readonly');
  });
});

// 2026-09-28 탭 다이어트 — 🅢 리딩 판단(채널 07:4x) · 내부 문서 `ROADMAP-pwa-tab-triage-and-launch-2026-09-28`
import { visibleNavGroups } from './sidebar-nav-items';

describe('탭 다이어트 — 메뉴 노출 등급', () => {
  const label = (level: 'public' | 'labs' | 'hidden') =>
    SIDEBAR_NAV_ITEMS.filter((item) => (item.visibility ?? 'public') === level).map((item) => item.label);

  it('공개 메뉴는 핵심 탭만 — Missions = Autopilot ⊕ Tasks 한 메뉴(09-28 합침 · Tasks 는 주소로 열리고 Missions 가 켜진다)', () => {
    expect(label('public')).toEqual(['Terminal', 'Chat', 'Intake', 'Approvals', 'Live', 'Trace', 'Missions', 'Design', 'Obsidian 노트', '마켓', 'Schedules', 'Settings']);
    const missions = SIDEBAR_NAV_ITEMS.find((i) => i.label === 'Missions')!;
    expect(missions.href).toBe('/autopilot');
    expect(missions.activeAlso).toEqual(['/tasks', '/missions']);
  });

  it('Labs = 편집기 · Workspace · Showroom · 숨김 = 일곱', () => {
    expect(label('labs').sort()).toEqual(['Showroom', 'Workspace', '편집기', '보드'].sort());
    const privateHidden = PRIVATE_SIDEBAR_NAV_ITEMS.map((item) => item.label);
    expect(label('hidden').sort()).toEqual(['Bots', 'Control', 'Observatory', 'Reflection', 'Sessions', 'Tasks', 'Worktrees', ...privateHidden].sort());
  });

  it('기본은 공개만 · 설정을 켜면 Labs·숨김 묶음이 따로 붙는다', () => {
    const off = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: false, showHidden: false });
    expect(off.labs).toEqual([]);
    expect(off.hidden).toEqual([]);
    const on = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: true, showHidden: true });
    expect(on.main.length + on.labs.length + on.hidden.length).toBe(SIDEBAR_NAV_ITEMS.length);
  });

  it('Design 은 메뉴 밖 목록에서 빠지고 메뉴로 올라왔다', () => {
    expect(NON_MENU_SIDEBAR_ROUTES.some((route) => route.href === '/design-check')).toBe(false);
    expect(SIDEBAR_NAV_ITEMS.some((item) => item.href === '/design-check' && item.label === 'Design')).toBe(true);
  });
});
