/**
 * `trailingSlash: true` (next.config) serves `/app/chat/`, so usePathname() yields `/chat/` in the
 * built PWA while tests and dev often pass `/chat`. Compare routes with the trailing slash removed.
 */
export function isPwaRoute(pathname: string | null | undefined, route: string): boolean {
  if (!pathname) return false;
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed === route;
}
