export const PWA_RETAINED_ROUTES = [
  '/', '/chat', '/term', '/live-run', '/vault', '/settings', '/editor', '/setup', '/setup/done',
  '/apps', '/design-check', '/404',
] as const;

export interface PwaRouteWorld {
  readonly registeredRoutes: readonly string[];
  request(path: string): Promise<{ status: number; route: string | null }>;
}

/** Reads the route catalog from app files, but delegates requests to the real serving path. */
export function createPwaRouteWorld(
  pages: readonly string[],
  requestRoute: (path: string) => Promise<number>,
): PwaRouteWorld {
  const registeredRoutes = [...new Set(pages)].sort();
  return {
    registeredRoutes,
    async request(path) {
      const normalized = path.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') || '/';
      const status = await requestRoute(normalized);
      return { status, route: status === 200 ? normalized : null };
    },
  };
}
