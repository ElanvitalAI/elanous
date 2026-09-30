// 2026-05-07 dogfood feedback — sidebar nav item table 추출. SidebarNav
// 컴포넌트가 Next App Router 훅에 의존해 bun-only 테스트가 어렵게
// 되어, 순수 데이터인 nav 표 (순서 + label + hint) 만 별도 모듈로
// 분리. SidebarNav.tsx 가 이 표를 import 해서 사용 → 테스트는 표
// shape 만 검증 (Next 훅 의존 0).

import { Crosshair,
  Activity,
  BookOpen,
  Bot,
  CalendarClock,
  Compass,
  GitBranch,
  GitPullRequest,
  KanbanSquare,
  Layers,
  LayoutGrid,
  Layers2,
  Lightbulb,
  Inbox,
  MessageSquare,
  Store,
  Palette,
  Settings,
  Sliders,
  TerminalSquare,
  Telescope,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceTabKind } from '@/lib/workspace/types';
import type { PwaRole } from '@/lib/pwa-role';
import { visibleForRole } from '@/lib/route-maturity';
import { PRIVATE_SIDEBAR_NAV_ITEMS } from './sidebar-nav-private';

export interface SidebarNavItem {
  href: string;
  label: string;
  /** 한국어 + 짧은 hint (compact tooltip + aria-label 에 결합 노출). */
  hint: string;
  icon: LucideIcon;
  /** workspace 라우팅 시 intent kind. /workspace 자체 (kind=null) 은
   *  탭 추가 안 함 — 그대로 페이지 진입. */
  kind: WorkspaceTabKind | null;
  /** 메뉴 노출 등급(2026-09-28 탭 다이어트 · `내부 문서 `ROADMAP-pwa-tab-triage-and-launch-2026-09-28``).
   *  `public` = 기본 메뉴 · `labs` = 설정 «Labs 탭 보기»를 켜면 · `hidden` = 설정 «숨긴 탭 보기»를 켜면.
   *  ⛔ `hidden` 도 주소로는 열린다 — «지우기»가 아니라 «메뉴에서 빼기»다. 없으면 `public`. */
  visibility?: NavVisibility;
  /** 이 항목을 «켜짐»으로 칠할 다른 경로 — 합친 탭(Missions = Autopilot ⊕ Tasks ⊕ 미션 방)이 하위 화면에서도 켜지게. */
  activeAlso?: readonly string[];
}

export type NavVisibility = 'public' | 'labs' | 'hidden';

/** 메뉴에 그릴 항목 — 기본은 공개만, 설정에 따라 Labs·숨김 묶음을 더한다. 순서는 표 순서. */
export function visibleNavGroups(
  items: readonly SidebarNavItem[],
  prefs: { showLabs: boolean; showHidden: boolean },
  role: PwaRole = 'owner',
): { main: SidebarNavItem[]; labs: SidebarNavItem[]; hidden: SidebarNavItem[] } {
  const level = (item: SidebarNavItem): NavVisibility => item.visibility ?? 'public';
  const allowed = items.filter((item) => visibleForRole(role, item.href));
  return {
    main: allowed.filter((item) => level(item) === 'public'),
    labs: prefs.showLabs ? allowed.filter((item) => level(item) === 'labs') : [],
    hidden: prefs.showHidden ? allowed.filter((item) => level(item) === 'hidden') : [],
  };
}

export const NAV_SHOW_LABS_KEY = 'elanous.nav.showLabs';
export const NAV_SHOW_HIDDEN_KEY = 'elanous.nav.showHidden';

export type SidebarRouteHref = `/${string}`;

export const NON_MENU_SIDEBAR_ROUTE_CATEGORIES = [
  'retired',
  'system-share-target',
  'dynamic-route-parent',
  'provider-onboarding',
  'provider-onboarding-complete',
  'settings-subpage',
  'workflow-subflow',
  'workflow-legacy-redirect',
  'root-welcome',
  'error-page',
  'unwired-screen',
  'diagnostic-readonly',
];

export type NonMenuSidebarRouteCategory = typeof NON_MENU_SIDEBAR_ROUTE_CATEGORIES[number];

export interface NonMenuSidebarRoute {
  href: SidebarRouteHref;
  category: NonMenuSidebarRouteCategory;
  reason: string;
}

/** 메뉴 밖 주소의 분류와 대표 결정. 동적 주소는 런타임 진입 parent를 기록한다. */
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
  { href: '/morning', category: 'unwired-screen', reason: '부르는 백엔드가 아직 없는 미배선 화면.' },
  // 481c22af2 로 diagnostic-readonly 분류가 생겼다. `/design-check` 는 2026-09-28 탭 다이어트에서
  // 메뉴 «Design» 으로 올라갔다(카드·시안·내 시스템 — 디자인 시스템 공개 결정).
  { href: '/botlab', category: 'diagnostic-readonly', reason: '봇 화면 «벽»을 한 자리에서 보는 읽기 진단 화면(#15390 · 봇 운영자용).' },
];

/** 사용자 빈도순 (Terminal · Chat 최상단). Phase 2 (PWA chat ↔ voice
 *  일원화 · 2026-05-07) — Voice 항목 제거. Chat 탭의 헤더 mic toggle
 *  이 voice 진입점을 흡수했고, `/` 라우트는 `/chat` 으로 redirect. */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { href: '/term', label: 'Terminal', hint: '터미널 + agent dock', icon: TerminalSquare, kind: 'term' },
  { href: '/chat', label: 'Chat', hint: '채팅 (스트리밍 · multimodal · mic)', icon: MessageSquare, kind: 'chat' },
  // 2026-09-26 대표 결정으로 되살림 · RFC-pwa-intake-front-door
  { href: '/intake', label: 'Intake', hint: '넣으면 흡수 · 작업 · 그래프로 (URL · 미션 · 메모)', icon: Inbox, kind: null },
  { href: '/approvals', label: 'Approvals', hint: '아이디어 PR 요약 · 승인하고 머지', icon: GitPullRequest, kind: null },
  { href: '/showroom', label: 'Showroom', hint: 'multi-agent 동시 비교 (broadcast · CV-3)', icon: LayoutGrid, kind: null, visibility: 'labs' },
  // 2026-09-28 대표 오늘 미션 — 하니스 런의 판단·기획 신호를 한 화면에(기획 내부 문서 `PLAN-live-signals-tab-teaser-and-web-2026-09-28`).
  { href: '/live', label: 'Live', hint: '런이 판단·기획하는 신호 (진짜 수 · 쇼 모드)', icon: Activity, kind: null },
  // 2026-09-28 RFC v6 — 따라가는 작업대(해상도 L0 플릿 → L1 런 → L2 런 한 개 · 렌즈 · d3). Live 는 무대로 남는다.
  { href: '/trace', label: 'Trace', hint: '렌즈를 좁혀 런을 따라간다 (플릿 → 런 → 판단)', icon: Crosshair, kind: null },
  { href: '/bots', label: 'Bots', hint: '봇 신원 + 공통 명령 카탈로그 (읽기 전용)', icon: Bot, kind: null, visibility: 'hidden' },
  { href: '/observatory', label: 'Observatory', hint: 'subject 관측 (talk · screen · agent)', icon: Telescope, kind: null, visibility: 'hidden' },
  // Autopilot (2026-07-09 · 겹침 해소 F2) — 미션 지휘 센터(PFC Layer2).
  // Missions(사람+자율 미션 계보·인라인 골 던지기)·Repo Watch·자율행동·루프 4 서브탭.
  // 구 Triage 탭은 Missions 인라인 컴포저로 흡수(intake 와 "두 문" 겹침 해소). kind=null 직접 진입.
  // 2026-09-28 Missions 합치기(🅢 재분배 ③ · 메뉴 10→9) — Autopilot ⊕ Tasks 를 한 메뉴로. 두 화면은 위 «① 미션 ② 작업 ③ 스케줄» 줄로 오간다.
  { href: '/autopilot', label: 'Missions', hint: '미션 · 작업 (미션 계보·골 던지기·작업 보드·자율행동)', icon: Compass, kind: null, activeAlso: ['/tasks', '/missions'] },
  { href: '/tasks', label: 'Tasks', hint: '작업 보드 (Missions 안 ② 작업)', icon: KanbanSquare, kind: 'tasks', visibility: 'hidden' },
  // 2026-09-29 RFC #21760 §10 🅕 — 태스크당 컨텍스트 카드를 스튜어드 → 실행 → 착지 → 릴리스 한 줄로(카드 저장소 = 🅢 E1).
  { href: '/board', label: '보드', hint: '태스크 카드 흐름 (스튜어드 → 실행 → 착지 → 릴리스)', icon: KanbanSquare, kind: null, visibility: 'labs' },
  // Obsidian Vault (2026-07-09) — iPad Obsidian 기능 PWA 이식(브라우저·에디터·검색·
  // wikilink·backlink·태그·그래프). 백엔드 /v1/vault/*. kind=null 직접 진입.
  // 2026-09-28 탭 다이어트 — 디자인 시스템 카드·시안·«URL 로 내 시스템» (메뉴 밖 → 메뉴).
  { href: '/design-check', label: 'Design', hint: '디자인 시스템 고르기 · 시안 · URL 로 내 시스템', icon: Palette, kind: null },
  { href: '/vault', label: 'Vault', hint: 'Obsidian 노트 (브라우저·에디터·검색·그래프)', icon: BookOpen, kind: null },
  { href: '/market', label: '마켓', hint: '플러그인 찾아보기 · 상세 · 설치됨', icon: Store, kind: null },
  // 2026-07-08 부활 — 예약된 모든 잡의 단일 인지 지점(schedule_registry 기반 ·
  // crontab/데몬/workflow trigger 미러 흡수). 투자 크론이 /workflows·/tasks 에
  // 안 보이던 공백 해소. kind=null → workspace 탭 안 만들고 페이지 직접 진입.
  { href: '/scheduler', label: 'Schedules', hint: '예약 잡 종합 현황 (크론·데몬·launchd)', icon: CalendarClock, kind: null },
  // R5 (2026-05-09) — 진행 중인 세션 카드 데크 · 좌우 스와이프로
  // 거절·승인, 위/아래로 잠시 멈춤·펼치기.
  { href: '/sessions', label: 'Sessions', hint: '세션 카드 데크 (스와이프 결정)', icon: Layers2, kind: null, visibility: 'hidden' },
  // R6 (2026-05-09) — 오늘 elanous 활동 요약 (노트·세션·OCR 카운터).
  { href: '/reflection', label: 'Reflection', hint: '오늘의 회고 (5분 갱신)', icon: Lightbulb, kind: null, visibility: 'hidden' },
  // 개인 투자 시그널 대시보드는 «비공개 전용» 모듈에 있다(공개본에서는 빈 목록 · 🅢 판단 09-28).
  ...PRIVATE_SIDEBAR_NAV_ITEMS,
  // 2026-05-11에는 `/scheduler`를 중복 표면으로 제거했으나, 2026-07-08에
  // workflow-trigger 통합 모델이 투자 크론을 못 담아 생긴 공백을 해소하려 복구했다.
  { href: '/editor', label: '편집기', hint: '워크플로 · 실행 그래프 작성·편집', icon: GitBranch, kind: null, visibility: 'labs', activeAlso: ['/workflows'] },
  { href: '/worktrees', label: 'Worktrees', hint: '격리 작업 트리 목록·상태', icon: GitBranch, kind: null, visibility: 'hidden' },
  { href: '/control', label: 'Control', hint: '데몬 제어 패널', icon: Sliders, kind: 'control', visibility: 'hidden' },
  { href: '/settings', label: 'Settings', hint: '환경 + provider + theme', icon: Settings, kind: 'settings' },
  { href: '/workspace', label: 'Workspace', hint: '여러 탭 동시 보기', icon: Layers, kind: null, visibility: 'labs' },
] as const;
