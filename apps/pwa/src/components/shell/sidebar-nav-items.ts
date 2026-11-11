import { BookOpen, GitBranch, LayoutGrid, MessageSquare, Palette, Settings, TerminalSquare, type LucideIcon } from 'lucide-react';
import type { PwaRole } from '@/lib/pwa-role';
import { visibleForRole } from '@/lib/route-maturity';

export type NavGroupId = 'talk' | 'work' | 'make' | 'files' | 'settings';
export type NavVisibility = 'public' | 'labs' | 'hidden';

export interface SidebarNavItem {
  href: string;
  group?: NavGroupId;
  label: string;
  hint: string;
  icon: LucideIcon;
  visibility?: NavVisibility;
  activeAlso?: readonly string[];
}

export const NAV_GROUPS: readonly { id: NavGroupId; label: string; icon: LucideIcon; bottomTab: boolean }[] = [
  { id: 'talk', label: '대화', icon: MessageSquare, bottomTab: true },
  { id: 'work', label: '실행', icon: GitBranch, bottomTab: true },
  { id: 'make', label: '만들기', icon: TerminalSquare, bottomTab: true },
  { id: 'files', label: '자료', icon: BookOpen, bottomTab: false },
  { id: 'settings', label: '설정', icon: Settings, bottomTab: false },
];

/** Keep role filtering and Labs/Hidden for non-operations entries. Operations require an operator response, independently of both. */
export function visibleNavGroups(
  items: readonly SidebarNavItem[],
  prefs: { showLabs: boolean; showHidden: boolean },
  role: PwaRole = 'owner',
  opts?: { showBeta?: boolean },
): { main: SidebarNavItem[]; labs: SidebarNavItem[]; hidden: SidebarNavItem[] } {
  const level = (item: SidebarNavItem): NavVisibility => item.visibility ?? 'public';
  const allowed = items.filter((item) => visibleForRole(role, item.href, opts));
  return {
    main: allowed.filter((item) => level(item) === 'public'),
    labs: prefs.showLabs ? allowed.filter((item) => level(item) === 'labs') : [],
    hidden: prefs.showHidden ? allowed.filter((item) => level(item) === 'hidden') : [],
  };
}

export const NAV_SHOW_LABS_KEY = 'elanous.nav.showLabs';
export const NAV_SHOW_HIDDEN_KEY = 'elanous.nav.showHidden';
export type SidebarRouteHref = `/${string}`;

/** 메뉴 항목의 «주소» — `?view=` 같은 보기 링크는 그 경로의 한 보기라 주소 회계에선 경로만 센다. */
export function sidebarRoutePath(href: string): string {
  return href.split(/[?#]/, 1)[0] || '/';
}

/** 경로에 질의가 붙은 메뉴 항목(같은 화면의 다른 보기) — 404 안내·주소 회계에서 경로 항목과 겹쳐 세지 않는다. */
export function isSidebarViewLink(href: string): boolean {
  return sidebarRoutePath(href) !== href;
}

function queryMatches(href: string, search: string): boolean {
  const current = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(href.slice(href.indexOf('?') + 1))) if (current.get(key) !== value) return false;
  return true;
}

/** 메뉴 항목이 «지금 화면»인가 — 경로 ⊕ 보기 링크(`?view=`)의 질의까지 본다(LOOP-NAV-ACTIVE).
 *  보기 링크는 경로와 질의가 다 맞을 때만 켜지고, 그때 같은 경로의 경로 항목은 비켜 준다(강조는 하나). */
export function navItemActive(
  item: { href: string; activeAlso?: readonly string[] },
  path: string,
  search: string,
  items: readonly { href: string }[],
): boolean {
  const route = sidebarRoutePath(item.href);
  const pathMatch = route === '/'
    ? path === '/'
    : path === route || path.startsWith(route + '/')
      || (item.activeAlso ?? []).some((p) => path === p || path.startsWith(p + '/'));
  if (!pathMatch) return false;
  if (isSidebarViewLink(item.href)) return path === route && queryMatches(item.href, search);
  return !items.some((other) => other !== item && isSidebarViewLink(other.href)
    && sidebarRoutePath(other.href) === path && queryMatches(other.href, search));
}

export const NON_MENU_SIDEBAR_ROUTE_CATEGORIES = [
  'retired', 'system-share-target', 'dynamic-route-parent', 'provider-onboarding',
  'provider-onboarding-complete', 'settings-subpage', 'workflow-subflow',
  'workflow-legacy-redirect', 'root-welcome', 'error-page', 'unwired-screen',
  'diagnostic-readonly', 'contact-form', 'beta-direct-link', 'operator-direct-link',
];
export type NonMenuSidebarRouteCategory = typeof NON_MENU_SIDEBAR_ROUTE_CATEGORIES[number];
export interface NonMenuSidebarRoute {
  href: SidebarRouteHref;
  category: NonMenuSidebarRouteCategory;
  reason: string;
}

export const NON_MENU_SIDEBAR_ROUTES: readonly NonMenuSidebarRoute[] = [
  { href: '/credentials/register', category: 'settings-subpage', reason: '자격 금고 슬롯별 등록 화면.' },
  { href: '/credentials/register/claim', category: 'settings-subpage', reason: '일회용 소유자 등록 링크를 처리하는 화면.' },
  { href: '/apps/report', category: 'workflow-subflow', reason: '앱 화면에서 여는 공개 앱 신고 화면.' },
  { href: '/ops/release', category: 'operator-direct-link', reason: '운영자 릴리스 그래프 직접 진입점.' },
  { href: '/live-run/adaptive', category: 'beta-direct-link', reason: '런 장면에서 여는 적응형 그래프 시뮬레이션 재생 화면.' },
  { href: '/share/received', category: 'system-share-target', reason: 'OS 공유 수신 후 회원 스크랩 저장 화면.' },
  { href: '/setup', category: 'provider-onboarding', reason: 'LLM provider 온보딩 진입점.' },
  { href: '/setup/done', category: 'provider-onboarding-complete', reason: 'LLM provider 온보딩 완료 화면.' },
  { href: '/', category: 'root-welcome', reason: '첫 방문자를 위한 루트 welcome 화면.' },
  { href: '/404', category: 'error-page', reason: '오류 페이지.' },
];

export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { group: 'talk', href: '/chat', label: '채팅', hint: '채팅 (스트리밍 · multimodal · mic)', icon: MessageSquare },
  { group: 'work', href: '/live-run', label: '런 장면', hint: '하니스 런 하나가 도는 장면 — 노드·간선 (라이브 · 리플레이)', icon: GitBranch },
  { group: 'work', href: '/board', label: '내 보드', hint: '회원 본인 앱의 진행 상태와 브리핑', icon: LayoutGrid },
  { group: 'make', href: '/term', label: '터미널', hint: '터미널 + agent dock', icon: TerminalSquare },
  { group: 'make', href: '/editor', label: '그래프', hint: '그래프 작성·편집 — 작업 노드 · 실행 단계 노드', icon: GitBranch },
  { group: 'make', href: '/apps', label: '앱', hint: '앱 스튜디오 — 시뮬레이션과 운영 상태', icon: LayoutGrid },
  { group: 'make', href: '/design-check', label: '디자인 방향', hint: '앱 디자인 방향 고르기', icon: Palette },
  { group: 'files', href: '/vault', label: 'Obsidian 노트', hint: 'Vault — Obsidian 노트 (브라우저·에디터·검색·그래프)', icon: BookOpen },
  { group: 'settings', href: '/settings', label: '설정', hint: '환경 + provider + theme', icon: Settings },
  { group: 'settings', href: '/credentials', label: '자격', hint: '넥서스 금고의 자격 슬롯 상태', icon: Settings },
] as const;
