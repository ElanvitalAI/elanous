import { describe, expect, test } from 'bun:test';
import { Inbox } from 'lucide-react';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  NAV_GROUPS,
  NON_MENU_SIDEBAR_ROUTES,
  SIDEBAR_NAV_ITEMS,
  visibleNavGroups,
  type SidebarRouteHref,
} from './sidebar-nav-items';
import { ROUTE_GUIDANCE_ITEMS } from '../welcome/WelcomeHome';
import { PRIVATE_SIDEBAR_NAV_ITEMS } from './sidebar-nav-private';

const CURRENT_BUILT_ROUTE_HREFS: readonly SidebarRouteHref[] = [
  ...PRIVATE_SIDEBAR_NAV_ITEMS.map((item) => item.href as SidebarRouteHref),
  '/',
  '/404',
  '/approvals',
  '/autopilot',
  '/board',
  '/botlab',
  '/bots',
  '/ceo',
  '/chat',
  '/decisions',
  '/consult',
  '/control',
  '/design-check',
  '/editor',
  '/exec',
  '/field',
  '/inside',
  '/intake',
  '/live',
  '/loops',
  '/market',
  '/missions',
  '/morning',
  '/ops/checklist',
  '/ops/release',
  '/ops/seats',
  '/observatory',
  '/outputs',
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
  '/today',
  '/trace',
  '/vault',
  '/workflows',
  '/workflows/chat-ui',
  '/workspace',
  '/worktrees',
];

function builtRouteHrefs(directory = resolve(dirname(import.meta.path), '../../app')): SidebarRouteHref[] {
  const paths: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^page\.(ts|tsx|js|jsx)$/.test(entry.name)) paths.push(path);
    }
  };
  visit(directory);
  return [
    ...paths.map((path): SidebarRouteHref => {
      const segments = relative(directory, dirname(path)).split(sep)
        .filter((segment) => segment && !/^\(.+\)$/.test(segment));
      const dynamic = segments.findIndex((segment) => /^\[.+\]$/.test(segment));
      const address = dynamic < 0 ? segments : segments.slice(0, dynamic);
      return address.length ? `/${address.join('/')}` : '/';
    }),
    '/404',
  ];
}

function expectCompleteRouteAccounting(
  builtHrefs: readonly SidebarRouteHref[],
  guidance: readonly { href: SidebarRouteHref; navigable: boolean }[],
): void {
  const menu = SIDEBAR_NAV_ITEMS.map((item) => item.href);
  const nonMenu = NON_MENU_SIDEBAR_ROUTES.map((item) => item.href);
  const accounted = [...menu, ...nonMenu];
  const built = new Set<string>(builtHrefs);
  const counts = new Map<string, number>();

  for (const href of accounted) counts.set(href, (counts.get(href) ?? 0) + 1);
  for (const item of guidance) counts.set(item.href, (counts.get(item.href) ?? 0) + 1);

  const missing = [...built].filter((href) => !accounted.includes(href) || !guidance.some((item) => item.href === href));
  const unexpected = accounted.filter((href) => !built.has(href));
  const duplicate = accounted.filter((href, index) => accounted.indexOf(href) !== index);
  const guidanceDuplicate = guidance
    .map((item) => item.href)
    .filter((href, index, hrefs) => hrefs.indexOf(href) !== index);
  const classificationMismatch = guidance
    .filter((item) => item.navigable !== menu.includes(item.href) || !accounted.includes(item.href))
    .map((item) => item.href);

  expect({
    missing,
    unexpected,
    duplicate,
    guidanceDuplicate,
    classificationMismatch,
    guidanceCount: guidance.length,
    accountedCount: accounted.length,
    builtCount: builtHrefs.length,
  }).toEqual({
    missing: [],
    unexpected: [],
    duplicate: [],
    guidanceDuplicate: [],
    classificationMismatch: [],
    guidanceCount: accounted.length,
    accountedCount: builtHrefs.length,
    builtCount: built.size,
  });
}

const expectedGroups = [
  ['today', '오늘', true, ['/today', '/approvals', '/intake']],
  ['talk', '대화', true, ['/chat', '/exec']],
  ['work', '일', true, ['/autopilot', '/outputs', '/scheduler', '/live', '/trace']],
  ['make', '만들기', true, ['/term', '/editor', '/design-check', '/workspace']],
  ['files', '자료', false, ['/vault', '/field', '/market']],
  ['settings', '설정', false, ['/settings']],
  ['ops', '운영🔒', false, ['/ceo', '/loops', '/ops/release', '/ops/checklist', '/ops/seats', '/bots', '/observatory', '/worktrees', '/control']],
] as const;

describe('NAV1a menu', () => {
  test('seven named groups, icons, bottom-tab flags, labels and ordered children', () => {
    expect(NAV_GROUPS.map(({ id, label, bottomTab }) => [id, label, bottomTab]))
      .toEqual(expectedGroups.map(([id, label, bottomTab]) => [id, label, bottomTab]));
    for (const [id, , , hrefs] of expectedGroups) {
      expect(NAV_GROUPS.find((group) => group.id === id)?.icon).toBeDefined();
      expect(SIDEBAR_NAV_ITEMS.filter((item) => item.group === id && (hrefs as readonly string[]).includes(item.href)).map((item) => item.href)).toEqual([...hrefs]);
    }
    expect(Object.fromEntries(SIDEBAR_NAV_ITEMS.map((item) => [item.href, item.label]))).toMatchObject({
      '/today': '오늘', '/approvals': '승인 대기', '/intake': '넣기', '/chat': '채팅', '/exec': 'COO 에게 맡기기',
      '/autopilot': '미션', '/outputs': '산출물', '/scheduler': '예약', '/live': 'Live', '/trace': 'Trace',
      '/term': '터미널', '/editor': '편집기', '/design-check': '디자인', '/workspace': '여러 탭',
      '/vault': 'Obsidian 노트', '/field': '현장 올리기', '/market': '마켓', '/settings': '설정',
      '/ceo': '대표 조망판', '/loops': '루프 현황', '/ops/release': '릴리스', '/ops/checklist': '판별 피처', '/bots': '봇',
      '/observatory': '관측', '/worktrees': '작업 트리', '/control': '제어',
    });
    for (const item of SIDEBAR_NAV_ITEMS) {
      expect(NAV_GROUPS.some((group) => group.id === item.group)).toBe(true);
      expect(item.hint.length).toBeGreaterThan(0);
      expect(item.icon).toBeDefined();
    }
  });

  test('promoted destinations belong only to the menu and keep direct page intent', () => {
    for (const href of ['/exec', '/field', '/ops/release', '/ops/checklist']) {
      expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === href)?.kind).toBeNull();
      expect(NON_MENU_SIDEBAR_ROUTES.some((route) => route.href === href)).toBe(false);
    }
    expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === '/autopilot')?.activeAlso).toEqual(['/tasks', '/missions']);
    expect(SIDEBAR_NAV_ITEMS.find((item) => item.href === '/editor')?.activeAlso).toEqual(['/workflows']);
  });

  test('operator controls ops regardless of role and Labs; other entries keep visibility and role filtering', () => {
    const off = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: true, showHidden: true }, 'owner', false);
    expect([...off.main, ...off.labs, ...off.hidden].filter((item) => item.group === 'ops')).toEqual([]);
    for (const role of ['owner', 'contributor', 'general'] as const) {
      const on = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: false, showHidden: false }, role, true);
      expect(on.main.filter((item) => item.group === 'ops').map((item) => item.href)).toEqual([...expectedGroups[6][3]]);
    }
    expect(off.labs.map((item) => item.href).sort()).toEqual(['/board', '/editor', '/showroom', '/workspace'].sort());
    expect(off.hidden.map((item) => item.href).sort()).toEqual(['/tasks', '/sessions', '/reflection', ...PRIVATE_SIDEBAR_NAV_ITEMS.map((item) => item.href)].sort());
    const general = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: false, showHidden: false }, 'general');
    expect(general.main.some((item) => item.href === '/scheduler')).toBe(false);
    expect(general.main.some((item) => item.href === '/chat')).toBe(true);
  });

  test('general menu puts Inbox today first and preserves the order of its five existing entries', () => {
    const main = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: false, showHidden: false }, 'general').main;
    expect(main).toHaveLength(6);
    expect(main[0]).toMatchObject({ group: 'today', href: '/today', label: '오늘', icon: Inbox });
    expect(main.map((item) => item.href)).toEqual(['/today', '/chat', '/live', '/term', '/market', '/settings']);
  });

  test('general beta opt-in preserves six default entries and opens beta only; other roles and ops stay unchanged', () => {
    const prefs = { showLabs: false, showHidden: false };
    const hrefs = (role: 'general' | 'contributor' | 'owner', showBeta?: boolean, operator = false) =>
      visibleNavGroups(SIDEBAR_NAV_ITEMS, prefs, role, operator, { showBeta }).main.map((item) => item.href);
    const off = hrefs('general');
    expect(off).toEqual(['/today', '/chat', '/live', '/term', '/market', '/settings']);
    expect(hrefs('general', false)).toEqual(off);
    const on = hrefs('general', true);
    for (const path of ['/exec', '/field', '/trace', '/autopilot', '/vault', '/intake']) expect(on).toContain(path);
    expect(on).toEqual(['/today', '/intake', '/chat', '/exec', '/autopilot', '/outputs', '/live', '/trace', '/term', '/vault', '/field', '/market', '/settings']);
    for (const path of ['/approvals', '/design-check', '/scheduler', '/ops/release', '/morning']) expect(on).not.toContain(path);
    for (const role of ['contributor', 'owner'] as const) expect(hrefs(role, true)).toEqual(hrefs(role));
    expect(hrefs('general', true, true).filter((path) => path.startsWith('/ops/'))).toEqual(['/ops/release', '/ops/checklist', '/ops/seats']);
  });

  test('complete built href accounting: no address missing or duplicated in menu, non-menu and guidance', () => {
    expect(builtRouteHrefs().sort()).toEqual([...CURRENT_BUILT_ROUTE_HREFS].sort());
    expectCompleteRouteAccounting(CURRENT_BUILT_ROUTE_HREFS, ROUTE_GUIDANCE_ITEMS);
  });

  test('missing guidance reports the omitted address', () => {
    const guidanceWithoutMorning = ROUTE_GUIDANCE_ITEMS.filter((route) => route.href !== '/morning');
    expect(() => expectCompleteRouteAccounting(builtRouteHrefs(), guidanceWithoutMorning)).toThrow('/morning');
  });

  test('missing nested static guidance reports the full href', () => {
    const guidanceWithoutSetupDone = ROUTE_GUIDANCE_ITEMS.filter((route) => route.href !== '/setup/done');
    expect(() => expectCompleteRouteAccounting(CURRENT_BUILT_ROUTE_HREFS, guidanceWithoutSetupDone)).toThrow('/setup/done');
  });

  test('a menu address duplicated as non-menu guidance fails accounting', () => {
    expect(() => expectCompleteRouteAccounting(
      CURRENT_BUILT_ROUTE_HREFS,
      [...ROUTE_GUIDANCE_ITEMS, { href: '/chat', navigable: false }],
    )).toThrow('/chat');
  });

  test('dynamic addresses use their parent; nested static addresses use the full href', () => {
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

  test('non-menu addresses retain their distinct reason categories', () => {
    const categoryByHref = new Map(NON_MENU_SIDEBAR_ROUTES.map((route) => [route.href, route.category]));

    expect(categoryByHref.get('/intake')).toBeUndefined();
    expect(categoryByHref.get('/share')).toBe('system-share-target');
    expect(categoryByHref.get('/missions')).toBe('dynamic-route-parent');
    expect(categoryByHref.get('/setup')).toBe('provider-onboarding');
    expect(categoryByHref.get('/404')).toBe('error-page');
    expect(categoryByHref.get('/morning')).toBe('unwired-screen');
    expect(categoryByHref.get('/design-check')).toBeUndefined();
    expect(categoryByHref.get('/botlab')).toBe('diagnostic-readonly');
    expect(categoryByHref.get('/inside')).toBe('beta-direct-link');
    expect(NON_MENU_SIDEBAR_ROUTES.find((route) => route.href === '/inside')?.reason.length).toBeGreaterThan(0);
    expect(SIDEBAR_NAV_ITEMS.some((item) => item.href === '/inside')).toBe(false);
    // OPS3 자리 현황은 NAV1a 운영 칸의 메뉴 항목이다(메뉴 밖 등록 아님).
    expect(categoryByHref.get('/ops/seats')).toBeUndefined();
    expect(SIDEBAR_NAV_ITEMS.some((item) => item.href === '/ops/seats' && item.group === 'ops')).toBe(true);
  });
});

// 2026-09-28 탭 다이어트 — 🅢 리딩 판단(채널 07:4x) · 내부 문서 `ROADMAP-pwa-tab-triage-and-launch-2026-09-28`
describe('탭 다이어트 — 메뉴 노출 등급', () => {
  const hrefs = (level: 'public' | 'labs' | 'hidden') =>
    SIDEBAR_NAV_ITEMS.filter((item) => (item.visibility ?? 'public') === level).map((item) => item.href);

  test('Missions = Autopilot ⊕ Tasks 한 메뉴: Tasks 주소에서도 Missions 가 켜진다', () => {
    expect(hrefs('public')).toContain('/autopilot');
    expect(hrefs('public')).not.toContain('/tasks');
    const missions = SIDEBAR_NAV_ITEMS.find((item) => item.href === '/autopilot');
    expect(missions?.activeAlso).toEqual(['/tasks', '/missions']);
  });

  test('Labs 는 별도 등급이며 Tasks·Sessions·Reflection 은 숨김이다', () => {
    expect(hrefs('labs').sort()).toEqual(['/board', '/editor', '/showroom', '/workspace'].sort());
    for (const href of ['/tasks', '/sessions', '/reflection']) {
      expect(hrefs('hidden')).toContain(href);
    }
  });

  test('기본은 공개만 · 설정을 켜면 Labs·숨김 묶음이 따로 붙는다', () => {
    const off = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: false, showHidden: false }, 'owner', false);
    expect(off.labs).toEqual([]);
    expect(off.hidden).toEqual([]);
    const on = visibleNavGroups(SIDEBAR_NAV_ITEMS, { showLabs: true, showHidden: true }, 'owner', true);
    expect(on.main.length + on.labs.length + on.hidden.length).toBe(SIDEBAR_NAV_ITEMS.length);
  });

  test('Design 은 비메뉴 목록에서 빠지고 메뉴로 올라왔다', () => {
    expect(NON_MENU_SIDEBAR_ROUTES.some((route) => route.href === '/design-check')).toBe(false);
    expect(SIDEBAR_NAV_ITEMS.some((item) => item.href === '/design-check' && item.label === '디자인')).toBe(true);
  });
});
