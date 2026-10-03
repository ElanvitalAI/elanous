import { FEATURE_MATURITY, visibleOn } from '../../../../src/maturity/feature-maturity';
import type { Maturity } from '../../../../src/maturity/feature-maturity';
import type { PwaRole } from './pwa-role';

export type RouteMaturity = Maturity;

/** App Router pages (including its generated 404 and the dynamic missions parent). */
export const ROUTE_MATURITY: Record<string, RouteMaturity> = Object.fromEntries(
  Object.entries(FEATURE_MATURITY.pwaRoute).map(([route, grade]) => [route, grade.pwa]),
);

/** Exact page match, then the one dynamic route's parent. No unknown page is advertised. */
function routeKey(href: string): string {
  const path = href.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') || '/';
  if (Object.prototype.hasOwnProperty.call(ROUTE_MATURITY, path)) return path;
  if (path.startsWith('/missions/') && path.slice('/missions/'.length).indexOf('/') === -1) return '/missions/[id]';
  return path;
}

export function routeMaturity(href: string): RouteMaturity | undefined {
  const key = routeKey(href);
  return Object.prototype.hasOwnProperty.call(ROUTE_MATURITY, key) ? ROUTE_MATURITY[key] : undefined;
}

export function visibleForRole(role: PwaRole, href: string, opts?: { showBeta?: boolean }): boolean {
  const route = routeKey(href);
  if (role === 'general' && opts?.showBeta && routeMaturity(route) === 'beta') return true;
  return visibleOn(route, 'pwa', role);
}
