export type Maturity = 'stable' | 'beta' | 'tool' | 'ops' | 'broken' | 'system';
export type Surface = 'pwa' | 'desktop' | 'ios' | 'android' | 'tui' | 'cli' | 'telegram' | 'discord' | 'acp';
export type Role = 'owner' | 'contributor' | 'general';

type SurfaceMaturity = { pwa: Maturity } & Partial<Record<Exclude<Surface, 'pwa'>, Maturity>>;

/** App Router pages, including the generated 404 and the dynamic missions route. */
export const FEATURE_MATURITY = {
  pwaRoute: {
    '/': { pwa: 'stable' },
    '/404': { pwa: 'stable' },
    '/setup': { pwa: 'stable' },
    '/setup/done': { pwa: 'stable' },
    '/consult': { pwa: 'stable' },
    '/chat': { pwa: 'stable' },
    '/term': { pwa: 'stable' },
    '/live': { pwa: 'stable' },
    '/market': { pwa: 'stable' },
    '/sessions': { pwa: 'stable' },
    '/settings': { pwa: 'beta' },
    '/editor': { pwa: 'beta' },
    '/intake': { pwa: 'beta' },
    '/trace': { pwa: 'beta' },
    '/board': { pwa: 'beta' },
    '/autopilot': { pwa: 'beta' },
    '/missions/[id]': { pwa: 'beta' },
    '/tasks': { pwa: 'beta' },
    '/workspace': { pwa: 'beta' },
    '/reflection': { pwa: 'beta' },
    '/vault': { pwa: 'beta' },
    '/observatory': { pwa: 'beta' },
    '/exec': { pwa: 'beta' },
    '/field': { pwa: 'beta' },
    '/showroom': { pwa: 'beta' },
    '/workflows': { pwa: 'beta' },
    '/approvals': { pwa: 'tool' },
    '/worktrees': { pwa: 'tool' },
    '/design-check': { pwa: 'tool' },
    '/control': { pwa: 'tool' },
    '/scheduler': { pwa: 'ops' },
    '/ops/release': { pwa: 'ops' },
    '/ops/checklist': { pwa: 'ops' },
    '/dashboard': { pwa: 'ops' },
    '/bots': { pwa: 'ops' },
    '/botlab': { pwa: 'ops' },
    '/morning': { pwa: 'broken' },
    '/settings/devices': { pwa: 'broken' },
    '/workflows/chat-ui': { pwa: 'broken' },
    '/share': { pwa: 'system' },
  },
} as const satisfies { pwaRoute: Record<string, SurfaceMaturity> };

/** Unregistered routes and surfaces are not implicitly mature. Desktop shares the PWA implementation. */
export function maturityOn(route: string, surface: Surface): Maturity | undefined {
  if (!Object.prototype.hasOwnProperty.call(FEATURE_MATURITY.pwaRoute, route)) return undefined;
  const grades: SurfaceMaturity = FEATURE_MATURITY.pwaRoute[route as keyof typeof FEATURE_MATURITY.pwaRoute];
  return grades[surface] ?? (surface === 'desktop' ? grades.pwa : undefined);
}

export function visibleOn(route: string, surface: Surface, role: Role): boolean {
  const maturity = maturityOn(route, surface);
  if (!maturity) return false;
  if (role === 'owner') return true;
  if (maturity === 'system') return false;
  if (route === '/settings') return true;
  return maturity === 'stable' || (role === 'contributor' && (maturity === 'beta' || maturity === 'tool'));
}
