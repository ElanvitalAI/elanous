'use client';

import { useContext, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { cn } from '@/lib/utils';
import { useNexusHealthIfMounted } from '@/nexus/hooks/use-nexus-state';
import { setupModeRedirect } from '@/lib/setup-mode';
import {
  NON_MENU_SIDEBAR_ROUTES,
  SIDEBAR_NAV_ITEMS,
  type SidebarRouteHref,
} from '@/components/shell/sidebar-nav-items';

/**
 * The sidebar table is the sole route classification source. Menu entries are
 * safe static destinations; every non-menu entry remains visible as reference
 * only because its recorded category says it is not a general destination.
 */
type RouteGuidanceItem = {
  href: SidebarRouteHref;
  label: string;
  navigable: boolean;
  reason?: string;
};

/**
 * The source table declares `SidebarNavItem.href` as string, so narrow it only
 * after checking membership in that table; a slash-prefixed unknown path is not
 * a typed application destination.
 */
export function isSidebarRouteHref(href: string): href is SidebarRouteHref {
  return SIDEBAR_NAV_ITEMS.some((item) => item.href === href)
    || NON_MENU_SIDEBAR_ROUTES.some((route) => route.href === href);
}

function toSidebarRouteHref(href: string): SidebarRouteHref {
  if (!isSidebarRouteHref(href)) throw new Error(`Unknown sidebar route: ${href}`);
  return href;
}

/**
 * Shared application address accounting for the home, missing-route screen,
 * and their route-inventory tests. Non-menu paths intentionally have no href:
 * their sidebar-table reason means they are reference material, not a general
 * destination users should be sent to.
 */
export const ROUTE_GUIDANCE_ITEMS: readonly RouteGuidanceItem[] = [
  ...SIDEBAR_NAV_ITEMS.map((item): RouteGuidanceItem => ({
    href: toSidebarRouteHref(item.href),
    label: item.label,
    navigable: true,
  })),
  ...NON_MENU_SIDEBAR_ROUTES.map((route): RouteGuidanceItem => ({
    href: route.href,
    label: route.href,
    navigable: false,
    reason: route.reason,
  })),
];

function routeGuidanceTestId(href: SidebarRouteHref): string {
  return `route-guidance-${href === '/' ? 'root' : href.slice(1).replaceAll('/', '-')}`;
}

export function RouteGuidanceList({ ariaLabel }: { ariaLabel: string }) {
  return (
    <section aria-label={ariaLabel} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ROUTE_GUIDANCE_ITEMS.map((item) => (
        <article
          key={item.href}
          data-testid={routeGuidanceTestId(item.href)}
          data-route-kind={item.navigable ? 'destination' : 'reference'}
          className={cn('rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm', !item.navigable && 'bg-muted/40')}
        >
          {item.navigable ? (
            <Link
              href={item.href}
              className="font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.label} <code className="text-xs text-muted-foreground">{item.href}</code>
            </Link>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="font-semibold">참고 주소 <code className="text-xs text-muted-foreground">{item.href}</code></span>
              <p className="text-sm leading-relaxed text-muted-foreground">{item.reason}</p>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

export function WelcomeHome() {
  const routerContext = useContext(AppRouterContext);
  if (routerContext == null) return <WelcomeHomeView />;
  return <WelcomeHomeRedirect />;
}

function WelcomeHomeRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const healthQuery = useNexusHealthIfMounted();
  const redirectTo = pathname == null || healthQuery.isError || healthQuery.isPending || healthQuery.isLoading
    ? null
    : setupModeRedirect(healthQuery.data, pathname);

  useEffect(() => {
    if (redirectTo === '/setup') router.replace('/setup');
  }, [redirectTo, router]);

  return <WelcomeHomeView />;
}

function WelcomeHomeView() {
  return (
    <main data-testid="welcome-home" className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40 px-6 py-12 sm:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10">
        <header className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">elanous PWA</p>
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">웰컴 — 어디부터 시작할까요?</h1>
          <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
            지금 갈 수 있는 곳과 참고 주소를 모두 안내합니다. 참고 주소는 기록된 사유 때문에 일반 목적지 링크로 만들지 않습니다.
          </p>
        </header>

        <RouteGuidanceList ariaLabel="전체 주소 안내" />

        <footer className="text-xs text-muted-foreground">
          이전 자동 포워딩(<code className="rounded bg-muted px-1 py-0.5 text-[11px]">/app → /chat</code>) 은 제거되었습니다. 기본 진입은 본 페이지로 유지됩니다.
        </footer>
      </div>
    </main>
  );
}
