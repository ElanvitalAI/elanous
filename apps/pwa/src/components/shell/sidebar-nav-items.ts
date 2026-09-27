// 2026-05-07 dogfood feedback — sidebar nav item table 추출. SidebarNav
// 컴포넌트가 Next App Router 훅에 의존해 bun-only 테스트가 어렵게
// 되어, 순수 데이터인 nav 표 (순서 + label + hint) 만 별도 모듈로
// 분리. SidebarNav.tsx 가 이 표를 import 해서 사용 → 테스트는 표
// shape 만 검증 (Next 훅 의존 0).

import {
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
  LineChart,
  Inbox,
  MessageSquare,
  Settings,
  Sliders,
  TerminalSquare,
  Telescope,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceTabKind } from '@/lib/workspace/types';

export interface SidebarNavItem {
  href: string;
  label: string;
  /** 한국어 + 짧은 hint (compact tooltip + aria-label 에 결합 노출). */
  hint: string;
  icon: LucideIcon;
  /** workspace 라우팅 시 intent kind. /workspace 자체 (kind=null) 은
   *  탭 추가 안 함 — 그대로 페이지 진입. */
  kind: WorkspaceTabKind | null;
}

export type SidebarRouteHref = `/${string}`;

export const NON_MENU_SIDEBAR_ROUTE_CATEGORIES = [
  'retired',
  'system-share-target',
  'dynamic-route-parent',
  'provider-onboarding',
  'provider-onboarding-complete',
  'settings-subpage',
  'workflow-subflow',
  'root-welcome',
  'error-page',
  'unwired-screen',
  'diagnostic-readonly',
] as const;

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
  { href: '/workflows/chat-ui', category: 'workflow-subflow', reason: 'Workflows에서 여는 hosted chat 하위 흐름.' },
  { href: '/', category: 'root-welcome', reason: '첫 방문자를 위한 루트 welcome 화면.' },
  { href: '/404', category: 'error-page', reason: '오류 페이지.' },
  { href: '/morning', category: 'unwired-screen', reason: '부르는 백엔드가 아직 없는 미배선 화면.' },
  // 481c22af2: CLI가 못 보여주는 선언 안 된 규칙집 상태를 보이는 순수 읽기 진단.
  // 기존 분류는 은퇴·시스템 진입·동적 부모·온보딩·하위 흐름·루트·오류·미배선뿐이라,
  // 일반 목적지가 아닌 이 진단 화면을 나타낼 분류가 없어 diagnostic-readonly를 추가한다.
  { href: '/design-check', category: 'diagnostic-readonly', reason: 'DESIGN.md 규칙집 상태를 확인하는 순수 읽기 진단 화면.' },
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
  { href: '/showroom', label: 'Showroom', hint: 'multi-agent 동시 비교 (broadcast · CV-3)', icon: LayoutGrid, kind: null },
  { href: '/bots', label: 'Bots', hint: '봇 신원 + 공통 명령 카탈로그 (읽기 전용)', icon: Bot, kind: null },
  { href: '/observatory', label: 'Observatory', hint: 'subject 관측 (talk · screen · agent)', icon: Telescope, kind: null },
  // Autopilot (2026-07-09 · 겹침 해소 F2) — 미션 지휘 센터(PFC Layer2).
  // Missions(사람+자율 미션 계보·인라인 골 던지기)·Repo Watch·자율행동·루프 4 서브탭.
  // 구 Triage 탭은 Missions 인라인 컴포저로 흡수(intake 와 "두 문" 겹침 해소). kind=null 직접 진입.
  { href: '/autopilot', label: 'Autopilot', hint: '미션 지휘 (미션 계보·골 던지기·자율행동·루프)', icon: Compass, kind: null },
  { href: '/tasks', label: 'Tasks', hint: '작업 보드', icon: KanbanSquare, kind: 'tasks' },
  // Obsidian Vault (2026-07-09) — iPad Obsidian 기능 PWA 이식(브라우저·에디터·검색·
  // wikilink·backlink·태그·그래프). 백엔드 /v1/vault/*. kind=null 직접 진입.
  { href: '/vault', label: 'Vault', hint: 'Obsidian 노트 (브라우저·에디터·검색·그래프)', icon: BookOpen, kind: null },
  // 2026-07-08 부활 — 예약된 모든 잡의 단일 인지 지점(schedule_registry 기반 ·
  // crontab/데몬/workflow trigger 미러 흡수). 투자 크론이 /workflows·/tasks 에
  // 안 보이던 공백 해소. kind=null → workspace 탭 안 만들고 페이지 직접 진입.
  { href: '/scheduler', label: 'Scheduler', hint: '예약 잡 인지 (크론·run_via·last_run · registry)', icon: CalendarClock, kind: null },
  // R5 (2026-05-09) — 진행 중인 세션 카드 데크 · 좌우 스와이프로
  // 거절·승인, 위/아래로 잠시 멈춤·펼치기.
  { href: '/sessions', label: 'Sessions', hint: '세션 카드 데크 (스와이프 결정)', icon: Layers2, kind: null },
  // R6 (2026-05-09) — 오늘 elanous 활동 요약 (노트·세션·OCR 카운터).
  { href: '/reflection', label: 'Reflection', hint: '오늘의 회고 (5분 갱신)', icon: Lightbulb, kind: null },
  // R4 (2026-07-07 · organic-signal-engine) — 파이낸스 시그널 대시보드
  // (캡스톤 국면·US 섹터·매력도 히트맵·신호 타임라인·디깅 피드).
  // 루프 오케스트라는 Dashboard 안 서브탭(개요/루프)으로 이동(2026-07-08) —
  // 별 사이드바 항목 없음. Dashboard 진입 후 탭 전환.
  { href: '/dashboard', label: 'Dashboard', hint: '시그널 대시보드 + 루프 오케스트라 (서브탭)', icon: LineChart, kind: null },
  // 2026-05-11에는 `/scheduler`를 중복 표면으로 제거했으나, 2026-07-08에
  // workflow-trigger 통합 모델이 투자 크론을 못 담아 생긴 공백을 해소하려 복구했다.
  { href: '/workflows', label: 'Workflows', hint: 'YAML 워크플로우 작성·실행 (Archon-port · scheduler 흡수)', icon: GitBranch, kind: 'workflows' },
  { href: '/worktrees', label: 'Worktrees', hint: '격리 작업 트리 목록·상태', icon: GitBranch, kind: null },
  { href: '/control', label: 'Control', hint: '데몬 제어 패널', icon: Sliders, kind: 'control' },
  { href: '/settings', label: 'Settings', hint: '환경 + provider + theme', icon: Settings, kind: 'settings' },
  { href: '/workspace', label: 'Workspace', hint: '여러 탭 동시 보기', icon: Layers, kind: null },
] as const;
