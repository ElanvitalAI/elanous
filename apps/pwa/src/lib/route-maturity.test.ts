import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ROUTE_MATURITY, routeMaturity, visibleForRole } from './route-maturity';
import { FEATURE_MATURITY, visibleOn } from '../../../../src/maturity/feature-maturity';
import { SIDEBAR_NAV_ITEMS } from '../components/shell/sidebar-nav-items';

const app = resolve(dirname(import.meta.path), '../app');
const retainedRoutes = ['/', '/404', '/apps', '/apps/report', '/board', '/chat', '/credentials', '/credentials/register', '/credentials/register/claim', '/design-check', '/editor', '/live-run', '/live-run/adaptive', '/member/invite', '/ops/release', '/scraps', '/settings', '/setup', '/setup/done', '/share/received', '/signup', '/signup/complete', '/term', '/vault', '/voice-notes'];

function builtPages(directory = app): string[] {
  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^page\.(?:ts|tsx|jsx?)$/.test(entry.name)) {
        const segments = relative(directory, dir).split(sep).filter((part) => part && !/^\(.+\)$/.test(part));
        pages.push(segments.length ? `/${segments.join('/')}` : '/');
      }
    }
  };
  walk(directory);
  return [...pages, '/404'];
}

describe('PWA route maturity after screens-out', () => {
  test('retained pages, the operator-only release page, and generated 404 are the complete classified route set', () => {
    const built = builtPages();
    expect(new Set(built).size).toBe(built.length);
    expect(built.sort()).toEqual([...retainedRoutes].sort());
    expect(Object.keys(ROUTE_MATURITY).sort()).toEqual([...retainedRoutes].sort());
    expect(ROUTE_MATURITY).toEqual(Object.fromEntries(
      Object.entries(FEATURE_MATURITY.pwaRoute).map(([path, grade]) => [path, grade.pwa]),
    ));
    for (const item of SIDEBAR_NAV_ITEMS) expect(routeMaturity(item.href)).toBeDefined();
    for (const removed of ['/autopilot', '/missions/[id]', '/workspace', '/scheduler']) {
      expect(routeMaturity(removed)).toBeUndefined();
    }
  });

  test('role visibility follows the retained routes and preserves beta opt-in', () => {
    for (const [path, maturity] of Object.entries(ROUTE_MATURITY)) {
      const general = visibleForRole('general', path);
      const contributor = visibleForRole('contributor', path);
      expect(visibleForRole('owner', path)).toBe(true);
      if (maturity === 'stable') expect(general).toBe(true);
      if (maturity === 'beta') expect(general).toBe(path === '/settings');
      expect(visibleForRole('general', path, { showBeta: true })).toBe(maturity === 'beta' || general);
      expect(contributor).toBe(maturity !== 'ops' && maturity !== 'system');
      for (const role of ['owner', 'contributor', 'general'] as const) {
        expect(visibleForRole(role, path)).toBe(visibleOn(path, 'pwa', role));
      }
    }
    expect(visibleForRole('general', '/setup')).toBe(true);
    expect(visibleForRole('general', '/setup/done')).toBe(true);
    expect(visibleForRole('general', '/settings')).toBe(true);
    expect(visibleForRole('general', '/live-run')).toBe(false);
    expect(visibleForRole('general', '/live-run', { showBeta: true })).toBe(true);
    expect(visibleForRole('owner', '/ops/release')).toBe(true);
    expect(visibleForRole('contributor', '/ops/release')).toBe(false);
    expect(visibleForRole('general', '/ops/release')).toBe(false);
  });

  test('lookup normalizes query and trailing slash but rejects removed or nested routes', () => {
    expect(routeMaturity('/chat?view=compact#top')).toBe('stable');
    expect(routeMaturity('/setup/')).toBe('stable');
    for (const route of ['/unknown', '/workspace', '/autopilot', '/missions/123', '/chat/extra']) {
      expect(routeMaturity(route)).toBeUndefined();
      for (const role of ['owner', 'contributor', 'general'] as const) expect(visibleForRole(role, route)).toBe(false);
    }
  });
});
