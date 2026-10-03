import {
  Activity, BookOpen, Bot, CalendarClock, Compass, Crosshair, GitBranch,
  GitPullRequest, Inbox, KanbanSquare, Layers, Layers2, Lightbulb, LayoutGrid,
  MessageSquare, Palette, Settings, Sliders, Store, Telescope, TerminalSquare,
  type LucideIcon, Users,
} from 'lucide-react';
import type { WorkspaceTabKind } from '@/lib/workspace/types';
import type { PwaRole } from '@/lib/pwa-role';
import { visibleForRole } from '@/lib/route-maturity';
import { PRIVATE_SIDEBAR_NAV_ITEMS } from './sidebar-nav-private';

export type NavGroupId = 'today' | 'talk' | 'work' | 'make' | 'files' | 'settings' | 'ops';
export type NavVisibility = 'public' | 'labs' | 'hidden';

export interface SidebarNavItem {
  href: string;
  /** Private extension entries are assigned a group on spread below. */
  group?: NavGroupId;
  label: string;
  hint: string;
  icon: LucideIcon;
  kind: WorkspaceTabKind | null;
  visibility?: NavVisibility;
  activeAlso?: readonly string[];
}

export const NAV_GROUPS: readonly { id: NavGroupId; label: string; icon: LucideIcon; bottomTab: boolean }[] = [
  { id: 'today', label: '오늘', icon: Inbox, bottomTab: true },
  { id: 'talk', label: '대화', icon: MessageSquare, bottomTab: true },
  { id: 'work', label: '일', icon: Compass, bottomTab: true },
  { id: 'make', label: '만들기', icon: TerminalSquare, bottomTab: true },
  { id: 'files', label: '자료', icon: BookOpen, bottomTab: false },
  { id: 'settings', label: '설정', icon: Settings, bottomTab: false },
  { id: 'ops', label: '운영🔒', icon: Sliders, bottomTab: false },
];

/** Keep role filtering and Labs/Hidden for non-operations entries. Operations require an operator response, independently of both. */
export function visibleNavGroups(
  items: readonly SidebarNavItem[],
  prefs: { showLabs: boolean; showHidden: boolean },
  role: PwaRole = 'owner',
  operator = false,
  opts?: { showBeta?: boolean },
): { main: SidebarNavItem[]; labs: SidebarNavItem[]; hidden: SidebarNavItem[] } {
  const level = (item: SidebarNavItem): NavVisibility => item.visibility ?? 'public';
  const allowed = items.filter((item) => item.group === 'ops' ? operator : visibleForRole(role, item.href, opts));
  return {
    main: allowed.filter((item) => item.group === 'ops' || level(item) === 'public'),
    labs: prefs.showLabs ? allowed.filter((item) => item.group !== 'ops' && level(item) === 'labs') : [],
    hidden: prefs.showHidden ? allowed.filter((item) => item.group !== 'ops' && level(item) === 'hidden') : [],
  };
}

export const NAV_SHOW_LABS_KEY = 'elanous.nav.showLabs';
export const NAV_SHOW_HIDDEN_KEY = 'elanous.nav.showHidden';
export type SidebarRouteHref = `/${string}`;

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
  { href: '/share', category: 'system-share-target', reason: '운영체제가 공유 동작으로 호출하는 Share Target 진입점.' },
  { href: '/missions', category: 'dynamic-route-parent', reason: '`[id]`를 받는 동적 주소이며 부모 경로 자체는 없다.' },
  { href: '/setup', category: 'provider-onboarding', reason: 'LLM provider 온보딩 진입점.' },
  { href: '/setup/done', category: 'provider-onboarding-complete', reason: 'LLM provider 온보딩 완료 화면.' },
  { href: '/settings/devices', category: 'settings-subpage', reason: 'Settings 아래 Device fleet 하위 화면.' },
  { href: '/workflows', category: 'workflow-legacy-redirect', reason: '기존 워크플로 링크를 /editor?mode=workflow 로 전달한다.' },
  { href: '/workflows/chat-ui', category: 'workflow-subflow', reason: 'Workflows에서 여는 hosted chat 하위 흐름.' },
  { href: '/', category: 'root-welcome', reason: '첫 방문자를 위한 루트 welcome 화면.' },
  { href: '/404', category: 'error-page', reason: '오류 페이지.' },
  { href: '/consult', category: 'contact-form', reason: 'AX 도입 상담·과정 문의를 접수하는 입력 화면(CS1 · #22436).' },
  { href: '/morning', category: 'unwired-screen', reason: '부르는 백엔드가 아직 없는 미배선 화면.' },
  { href: '/inside', category: 'beta-direct-link', reason: '시연자가 주소로 여는 엘라누스 안쪽 장면 지도(메뉴에는 노출하지 않음).' },
  // 481c22af2 로 diagnostic-readonly 분류가 생겼다. `/design-check` 는 2026-09-28 탭 다이어트에서
  // 메뉴 «Design» 으로 올라갔다(카드·시안·내 시스템 — 디자인 시스템 공개 결정).
  // 메뉴 «운영» 칸은 NAV1(0.2.10)에서 연다 — 이번 판은 주소로 연다.
  { href: '/botlab', category: 'diagnostic-readonly', reason: '봇 화면 «벽»을 한 자리에서 보는 읽기 진단 화면(#15390 · 봇 운영자용).' },
];

export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { group: 'today', href: '/today', label: '오늘', hint: '결정 대기 · 맡긴 일 · 최근 대화', icon: Inbox, kind: null },
  { group: 'today', href: '/approvals', label: '승인 대기', hint: '아이디어 PR 요약 · 승인하고 머지', icon: GitPullRequest, kind: null },
  { group: 'today', href: '/intake', label: '넣기', hint: '넣으면 흡수 · 작업 · 그래프로 (URL · 미션 · 메모)', icon: Inbox, kind: null },
  { group: 'talk', href: '/chat', label: '채팅', hint: '채팅 (스트리밍 · multimodal · mic)', icon: MessageSquare, kind: 'chat' },
  { group: 'talk', href: '/exec', label: 'COO 에게 맡기기', hint: 'COO 에게 맡기기 · 맡긴 일', icon: Bot, kind: null },
  { group: 'work', href: '/autopilot', label: '미션', hint: '미션 · 작업 (미션 계보·골 던지기·작업 보드·자율행동)', icon: Compass, kind: null, activeAlso: ['/tasks', '/missions'] },
  { group: 'work', href: '/outputs', label: '산출물', hint: '엘라누스가 만든 문서 · 슬라이드 · 보고서 · 영상', icon: Layers, kind: null },
  { group: 'work', href: '/scheduler', label: '예약', hint: '예약 잡 종합 현황 (크론·데몬·launchd)', icon: CalendarClock, kind: null },
  { group: 'work', href: '/live', label: 'Live', hint: '런이 판단·기획하는 신호 (진짜 수 · 쇼 모드)', icon: Activity, kind: null },
  { group: 'work', href: '/trace', label: 'Trace', hint: '렌즈를 좁혀 런을 따라간다 (플릿 → 런 → 판단)', icon: Crosshair, kind: null },
  { group: 'make', href: '/term', label: '터미널', hint: '터미널 + agent dock', icon: TerminalSquare, kind: 'term' },
  { group: 'make', href: '/editor', label: '편집기', hint: '워크플로 · 실행 그래프 작성·편집', icon: GitBranch, kind: null, visibility: 'labs', activeAlso: ['/workflows'] },
  { group: 'make', href: '/design-check', label: '디자인', hint: '디자인 시스템 고르기 · 시안 · URL 로 내 시스템', icon: Palette, kind: null },
  { group: 'make', href: '/workspace', label: '여러 탭', hint: '여러 탭 동시 보기', icon: Layers, kind: null, visibility: 'labs' },
  { group: 'files', href: '/vault', label: 'Obsidian 노트', hint: 'Vault — Obsidian 노트 (브라우저·에디터·검색·그래프)', icon: BookOpen, kind: null },
  { group: 'files', href: '/field', label: '현장 올리기', hint: '현장 올리기 · 사진과 메모', icon: Inbox, kind: null },
  { group: 'files', href: '/market', label: '마켓', hint: '플러그인 찾아보기 · 상세 · 설치됨', icon: Store, kind: null },
  { group: 'settings', href: '/settings', label: '설정', hint: '환경 + provider + theme', icon: Settings, kind: 'settings' },
  { group: 'ops', href: '/ops/release', label: '릴리스', hint: '판 진행 노드 줄 · 로그 꼬리', icon: GitBranch, kind: null },
  { group: 'ops', href: '/ops/checklist', label: '판별 피처', hint: '확인표 칸 목록 · 상태 · 담당 · 근거', icon: GitPullRequest, kind: null },
  { group: 'ops', href: '/ops/seats', label: '자리 현황', hint: '자리별 지금 일 · 착지 · 막힘 · 결정 대기(?capture=public 공개 시연)', icon: Users, kind: null },
  { group: 'ops', href: '/bots', label: '봇', hint: '봇 신원 + 공통 명령 카탈로그 (읽기 전용)', icon: Bot, kind: null, visibility: 'hidden' },
  { group: 'ops', href: '/observatory', label: '관측', hint: 'subject 관측 (talk · screen · agent)', icon: Telescope, kind: null, visibility: 'hidden' },
  { group: 'ops', href: '/worktrees', label: '작업 트리', hint: '격리 작업 트리 목록·상태', icon: GitBranch, kind: null, visibility: 'hidden' },
  { group: 'ops', href: '/control', label: '제어', hint: '데몬 제어 패널', icon: Sliders, kind: 'control', visibility: 'hidden' },
  { group: 'work', href: '/tasks', label: 'Tasks', hint: '작업 보드 (Missions 안 ② 작업)', icon: KanbanSquare, kind: 'tasks', visibility: 'hidden' },
  { group: 'work', href: '/board', label: '보드', hint: '태스크 카드 흐름 (스튜어드 → 실행 → 착지 → 릴리스)', icon: KanbanSquare, kind: null, visibility: 'labs' },
  { group: 'work', href: '/sessions', label: '대화 카드', hint: '대화 카드 데크 (스와이프 결정)', icon: Layers2, kind: null, visibility: 'hidden' },
  { group: 'today', href: '/reflection', label: 'Reflection', hint: '오늘의 회고 (5분 갱신)', icon: Lightbulb, kind: null, visibility: 'hidden' },
  ...PRIVATE_SIDEBAR_NAV_ITEMS.map((item) => ({ ...item, group: 'files' as const })),
  { group: 'make', href: '/showroom', label: 'Showroom', hint: 'multi-agent 동시 비교 (broadcast · CV-3)', icon: LayoutGrid, kind: null, visibility: 'labs' },
] as const;
