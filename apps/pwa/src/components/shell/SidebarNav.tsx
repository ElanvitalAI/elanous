'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePwaRole } from '@/lib/pwa-role';
import { useOperator } from '@/lib/use-operator';
import { routeMaturity, visibleForRole } from '@/lib/route-maturity';
import { useShowBeta } from '@/lib/show-beta';
import { NAV_SHOW_HIDDEN_KEY, NAV_SHOW_LABS_KEY, NAV_GROUPS, SIDEBAR_NAV_ITEMS, navItemActive, visibleNavGroups, type NavGroupId } from './sidebar-nav-items';
import { NavSearchProbe } from './NavSearchProbe';
import { NAV_PREFS_EVENT, readFlag } from './nav-visibility-prefs';
import { SidebarWorkflowInvoker } from './SidebarWorkflowInvoker';
import { ShowroomSidebarSection } from './ShowroomSidebarSection';

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
  const [search, setSearch] = useState('');
  const role = usePwaRole();
  const { showBeta } = useShowBeta();
  const operator = useOperator();
  const [collapsed, setCollapsed] = useState<NavGroupId[]>([]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem('elanous.nav.collapsedGroups') ?? '[]');
      if (Array.isArray(saved)) setCollapsed(NAV_GROUPS.filter((group) => saved.includes(group.id)).map((group) => group.id));
    } catch { /* Storage may be unavailable. */ }
  }, []);
  const toggleGroup = (id: NavGroupId) => {
    const next = collapsed.includes(id) ? collapsed.filter((value) => value !== id) : [...collapsed, id];
    setCollapsed(next);
    try { window.localStorage.setItem('elanous.nav.collapsedGroups', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  };
  // General users follow direct links; typed beta addresses remain available even without menu opt-in.
  const handleNavClick = (
    item: typeof NAV_ITEMS[number],
    e: React.MouseEvent<HTMLAnchorElement>,
  ): void => {
    if (item.kind === null || role === 'general') return; // General users stay on the selected direct destination.
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
  const groups = visibleNavGroups(NAV_ITEMS, prefs, role, operator, { showBeta });
  const renderItem = (item: typeof NAV_ITEMS[number]) => {
    // Highlight nested routes and the shared Missions/Editor destinations.
    const active = navItemActive(item, current, search, NAV_ITEMS);
    const Icon = item.icon;
    const experimental = role === 'general' && showBeta && item.href !== '/settings' && routeMaturity(item.href) === 'beta';
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
          title={compact ? `${item.label}${experimental ? ' · 실험' : ''} — ${item.hint}` : item.hint}
          aria-label={`${item.label}${experimental ? ' · 실험' : ''} — ${item.hint}`}
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
          {!compact && experimental && <span className="rounded border border-primary/40 px-1 text-[10px] text-primary">실험</span>}
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
            {experimental && <span className="ml-1 text-primary">실험</span>}
            <span className="ml-1 text-muted-foreground">— {item.hint}</span>
          </span>
        )}
      </li>
    );
  };
  return (
    <nav className="flex h-full flex-col">
      <Suspense fallback={null}><NavSearchProbe onSearch={setSearch} /></Suspense>
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
      <div className={cn('flex-1 space-y-2', compact ? 'px-1 py-2' : 'px-2 py-3')}>
        {NAV_GROUPS.map((group) => {
          const items = groups.main.filter((item) => item.group === group.id);
          if (items.length === 0) return null;
          const Icon = group.icon;
          const first = items[0]!;
          return (
            <section key={group.id} aria-label={group.label}>
              {!compact && items.length === 1 ? (
                <ul>{renderItem(first)}</ul>
              ) : compact ? (
                <Link href={first.href as never}
                  title={`${group.label}${role === 'general' && showBeta && first.href !== '/settings' && routeMaturity(first.href) === 'beta' ? ' · 실험' : ''}`}
                  aria-label={`${group.label}${role === 'general' && showBeta && first.href !== '/settings' && routeMaturity(first.href) === 'beta' ? ' · 실험' : ''}`}
                  onClick={() => onNavigate?.()}
                  className="relative flex justify-center rounded-md px-1.5 py-2 text-sidebar-foreground/70 hover:bg-sidebar-accent">
                  <Icon className="h-4 w-4" />
                  {role === 'general' && showBeta && first.href !== '/settings' && routeMaturity(first.href) === 'beta' && <span aria-hidden className="absolute -right-1 -top-1 rounded bg-primary px-0.5 text-[8px] text-primary-foreground">실험</span>}
                </Link>
              ) : (
                <>
                  <button type="button" onClick={() => toggleGroup(group.id)} aria-expanded={!collapsed.includes(group.id)}
                    aria-controls={`nav-group-${group.id}`}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-semibold text-sidebar-foreground/80 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="h-4 w-4" />{group.label}
                    <ChevronDown aria-hidden className={cn('ml-auto h-3.5 w-3.5 transition-transform', collapsed.includes(group.id) && '-rotate-90')} />
                  </button>
                  {!collapsed.includes(group.id) && <ul id={`nav-group-${group.id}`} className="ml-3 space-y-1 border-l border-sidebar-border pl-2">{items.map(renderItem)}</ul>}
                </>
              )}
            </section>
          );
        })}
      </div>
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
      {prefs.showLabs && visibleForRole(role, '/showroom') && (
        <Suspense fallback={null}>
          <ShowroomSidebarSection compact={compact} onNavigate={onNavigate} />
        </Suspense>
      )}
      {/* BACKLOG #3 — sticky workflow invoker. Hidden in compact rail
          (no horizontal room). Silently absent when NexusClient is
          missing (SSR / dev). */}
      {prefs.showLabs && visibleForRole(role, '/workflows') && <SidebarWorkflowInvoker compact={compact} />}
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
