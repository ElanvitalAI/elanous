import type { PwaRole } from './pwa-role';

export type RouteMaturity = 'stable' | 'beta' | 'tool' | 'ops' | 'broken' | 'system';

/** App Router pages (including its generated 404 and the dynamic missions parent). */
export const ROUTE_MATURITY = {
  '/': 'stable',
  '/404': 'stable',
  '/setup': 'stable',
  '/setup/done': 'stable',
  '/chat': 'stable',
  '/term': 'stable',
  '/live': 'stable',
  '/market': 'stable',
  '/sessions': 'stable',
  '/settings': 'beta',
  '/editor': 'beta',
  '/intake': 'beta',
  '/trace': 'beta',
  '/board': 'beta',
  '/autopilot': 'beta',
  '/missions/[id]': 'beta',
  '/tasks': 'beta',
  '/workspace': 'beta',
  '/reflection': 'beta',
  '/vault': 'beta',
  '/observatory': 'beta',
  '/showroom': 'beta',
  '/workflows': 'beta',
  '/approvals': 'tool',
  '/worktrees': 'tool',
  '/design-check': 'tool',
  '/control': 'tool',
  '/scheduler': 'ops',
  '/dashboard': 'ops',
  '/bots': 'ops',
  '/botlab': 'ops',
  '/morning': 'broken',
  '/settings/devices': 'broken',
  '/workflows/chat-ui': 'broken',
  '/share': 'system',
} as const satisfies Record<string, RouteMaturity>;

/** Exact page match, then the one dynamic route's parent. No unknown page is advertised. */
export function routeMaturity(href: string): RouteMaturity | undefined {
  const path = href.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') || '/';
  if (Object.prototype.hasOwnProperty.call(ROUTE_MATURITY, path)) {
    return ROUTE_MATURITY[path as keyof typeof ROUTE_MATURITY];
  }
  if (path.startsWith('/missions/') && path.slice('/missions/'.length).indexOf('/') === -1) return ROUTE_MATURITY['/missions/[id]'];
  return undefined;
}

export function visibleForRole(role: PwaRole, href: string): boolean {
  const maturity = routeMaturity(href);
  if (!maturity) return false;
  if (role === 'owner') return true;
  if (maturity === 'system') return false;
  if (href.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') === '/settings') return true;
  return maturity === 'stable' || (role === 'contributor' && (maturity === 'beta' || maturity === 'tool'));
}
