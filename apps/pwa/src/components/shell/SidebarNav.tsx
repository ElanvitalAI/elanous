'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_SHOW_HIDDEN_KEY, NAV_SHOW_LABS_KEY, SIDEBAR_NAV_ITEMS, visibleNavGroups } from './sidebar-nav-items';
import { NAV_PREFS_EVENT, readFlag } from './nav-visibility-prefs';
import { SidebarWorkflowInvoker } from './SidebarWorkflowInvoker';
import { ShowroomSidebarSection } from './ShowroomSidebarSection';

// 2026-05-06 — sidebar nav workspace 통합 (BACKLOG-webterm-followups §4).
// Sidebar 클릭 시 single-page (/chat · /term 등) 으로 가는 대신 workspace 의
// activateOrAdd / openPicker 로 라우팅. /workspace?intent=<kind> 로 push 한 뒤
// /workspace/page.tsx 가 query 보고 처리. /chat /term /voice 등 single-page
// route 는 deep link 용으로 보존 (URL 직접 입력 시 그대로 동작).
//
// 2026-05-07 — 사용자 dogfood feedback: 사용 빈도 순으로 재배치
// (Terminal 최상단 → Chat → Voice → 나머지). compact 모드의 tooltip
// 도 한국어 + 짧은 hint 가 같이 노출되어 첫 사용자가 아이콘만으로
// 망설임 없이 진입할 수 있도록 정리. NAV_ITEMS 표는 별도 pure module
// (sidebar-nav-items.ts) 로 추출 — Next App Router 훅에 의존 안 하는
// 단위 테스트 가능.
const NAV_ITEMS = SIDEBAR_NAV_ITEMS;

// usePathname() with basePath:'/app' + trailingSlash:true returns
// values like '/chat/' (basePath stripped, trailing slash present).
// Normalise so the comparison against NAV_ITEMS.href succeeds.
function normalizePath(p: string): string {
  if (!p) return '/';
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

interface Props {
  /** Mobile drawer dismissal — fires after a nav click so the drawer
   *  doesn't stay open over the destination. md+ inline mode also
   *  benefits (auto-collapse on navigate keeps content area maximal). */
  onNavigate?: () => void;
  /** Explicit close — wires the in-sidebar ✕ button so users can
   *  collapse without scanning back up to the TopBar hamburger. */
  onClose?: () => void;
  /** Compact rail mode (U-6b). Hides labels, sticks to a w-10 column
   *  so md+ collapsed users still get one-tap navigation. The TopBar
   *  hamburger handles expand/collapse, so no in-sidebar ✕ here. */
  compact?: boolean;
}

export function SidebarNav({ onNavigate, onClose, compact = false }: Props = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const current = normalizePath(pathname ?? '/');
  // Sidebar nav workspace 통합 — kind 가 있는 nav 는 /workspace?intent=<kind>
  // 로 우회. /workspace 진입 자체 (kind=null) + 명시적 /chat 등 deep link 는
  // 기존 Link 동작 그대로.
  const handleNavClick = (
    item: typeof NAV_ITEMS[number],
    e: React.MouseEvent<HTMLAnchorElement>,
  ): void => {
    if (item.kind === null) return; // /workspace direct link
    // Cmd/Ctrl-click → 새 탭에서 single-page route 직접 열림 (browser default).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(`/workspace?intent=${item.kind}` as never);
    onNavigate?.();
  };
  // 보는 사람 기기별 설정 — ⛔ 렌더 중에 읽지 않는다(정적 export 하이드레이션 · #418). 첫 렌더는 공개 탭만.
  const [prefs, setPrefs] = useState({ showLabs: false, showHidden: false });
  useEffect(() => {
    const read = () => setPrefs({ showLabs: readFlag(NAV_SHOW_LABS_KEY), showHidden: readFlag(NAV_SHOW_HIDDEN_KEY) });
    read();
    window.addEventListener(NAV_PREFS_EVENT, read);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener(NAV_PREFS_EVENT, read); window.removeEventListener('storage', read); };
  }, []);
  const groups = visibleNavGroups(NAV_ITEMS, prefs);
  const renderItem = (item: typeof NAV_ITEMS[number]) => {
          // Voice ('/') matches only an exact '/'. Other routes match
    // exact OR any nested path so that future child routes
    // (e.g. /intake/<id>) keep the parent highlighted.
    const active =
      item.href === '/'
        ? current === '/'
        : current === item.href || current.startsWith(item.href + '/')
          || (item.activeAlso ?? []).some((p) => current === p || current.startsWith(p + '/'));
    const Icon = item.icon;
    return (
      <li key={item.href} className="group/nav relative">
        <Link
          href={item.href as never}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            handleNavClick(item, e);
            if (e.defaultPrevented) return;
            onNavigate?.();
          }}
          title={compact ? `${item.label} — ${item.hint}` : item.hint}
          aria-label={`${item.label} — ${item.hint}`}
          className={cn(
            'flex items-center rounded-md text-sm transition-colors',
            compact ? 'justify-center px-1.5 py-2' : 'gap-3 px-3 py-2',
            active
              ? 'bg-primary/15 text-foreground font-semibold ring-1 ring-primary/40'
              : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
          )}
        >
          <Icon
            className={cn(
              'h-4 w-4 shrink-0',
              active ? 'text-primary' : 'text-current',
            )}
          />
          {!compact && item.label}
          {!compact && active && (
            <span
              className="ml-auto h-1.5 w-1.5 rounded-full bg-primary"
              aria-hidden
            />
          )}
        </Link>
        {/* compact rail tooltip — 첫 사용자가 아이콘만 보고
            망설일 때 hover 즉시 label + 한국어 hint 노출.
            native title 도 fallback (key-nav · 모바일 long-press).
            pointer:fine 만 활성 — touch 디바이스 long-press 와
            중복 안 되도록. */}
        {compact && (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/nav:opacity-100 [@media(pointer:coarse)]:hidden"
          >
            <span className="font-medium">{item.label}</span>
            <span className="ml-1 text-muted-foreground">— {item.hint}</span>
          </span>
        )}
      </li>
    );
  };
  return (
    <nav className="flex h-full flex-col">
      {onClose && !compact && (
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/50">
            menu
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close menu"
            title="close menu"
            className="rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <ul className={cn('flex-1 space-y-1', compact ? 'px-1 py-2' : 'px-2 py-3')}>
        {groups.main.map(renderItem)}
      </ul>
      {groups.labs.length > 0 && (
        <NavGroup label="Labs" compact={compact}>{groups.labs.map(renderItem)}</NavGroup>
      )}
      {groups.hidden.length > 0 && (
        <NavGroup label="Hidden" compact={compact}>{groups.hidden.map(renderItem)}</NavGroup>
      )}
      {/* R6 Task 2 · §6.5 — saved Showroom layouts as 1-click switch.
          The widget is silent when DaemonProvider is absent (SSR /
          some dev routes) and renders nothing in compact mode.
          Suspense wrap (2026-05-09) — useSearchParams() in this child
          forces every page that mounts AppShell to bail out of static
          prerender unless wrapped. Without Suspense, the static
          export crashes on /workflows, /tasks, etc. with
          "useSearchParams() should be wrapped in a suspense
          boundary". */}
      {prefs.showLabs && (
        <Suspense fallback={null}>
          <ShowroomSidebarSection compact={compact} onNavigate={onNavigate} />
        </Suspense>
      )}
      {/* BACKLOG #3 — sticky workflow invoker. Hidden in compact rail
          (no horizontal room). Silently absent when NexusClient is
          missing (SSR / dev). */}
      {prefs.showLabs && <SidebarWorkflowInvoker compact={compact} />}
    </nav>
  );
}

function NavGroup({ label, compact, children }: { label: string; compact: boolean; children: ReactNode }) {
  return (
    <div className={cn('border-t border-sidebar-border', compact ? 'px-1 py-2' : 'px-2 py-2')}>
      {!compact && (
        <span className="px-3 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/50">{label}</span>
      )}
      <ul className="mt-1 space-y-1">{children}</ul>
    </div>
  );
}
