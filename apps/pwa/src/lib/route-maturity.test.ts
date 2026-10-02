import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ROUTE_MATURITY, routeMaturity, visibleForRole } from './route-maturity';
import { FEATURE_MATURITY, visibleOn } from '../../../../src/maturity/feature-maturity';
import { SIDEBAR_NAV_ITEMS, visibleNavGroups } from '../components/shell/sidebar-nav-items';

const app = resolve(dirname(import.meta.path), '../app');

function builtPages(directory: string): string[] {
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /^page\.(?:tsx?|jsx?)$/.test(entry.name)) {
        const segments = relative(directory, dir).split(sep).filter((part) => part && !/^\(.+\)$/.test(part));
        pages.push(segments.length ? `/${segments.join('/')}` : '/');
      }
    }
  };
  walk(directory);
  return [...pages, '/404'];
}

describe('PWA route maturity', () => {
  test('every graded App Router page is classified exactly once (including nested and dynamic pages)', () => {
    const built = builtPages(app);
    expect(new Set(built).size).toBe(built.length);
    expect(routeMaturity('/exec')).toBe('beta');
    expect(routeMaturity('/field')).toBe('beta');
    expect(Object.keys(ROUTE_MATURITY).sort()).toEqual([...built].sort());
    expect(ROUTE_MATURITY).toEqual(Object.fromEntries(
      Object.entries(FEATURE_MATURITY.pwaRoute).map(([path, grade]) => [path, grade.pwa]),
    ));
    expect(ROUTE_MATURITY['/share']).toBe('system');
    expect(ROUTE_MATURITY['/morning']).toBe('broken');
    expect(ROUTE_MATURITY['/settings/devices']).toBe('broken');
    expect(ROUTE_MATURITY['/workflows/chat-ui']).toBe('broken');
    expect(ROUTE_MATURITY['/scheduler']).toBe('ops');
    expect(ROUTE_MATURITY['/ops/release']).toBe('ops');
    expect(ROUTE_MATURITY['/ops/checklist']).toBe('ops');
    expect(ROUTE_MATURITY['/settings']).toBe('beta');
    expect(ROUTE_MATURITY['/approvals']).toBe('tool');
    expect(ROUTE_MATURITY['/chat']).toBe('stable');
    for (const item of SIDEBAR_NAV_ITEMS) expect(routeMaturity(item.href)).toBeDefined();
  });

  test('role exposure follows the matrix, including settings accessible for everyone', () => {
    for (const [path, maturity] of Object.entries(ROUTE_MATURITY)) {
      const general = visibleForRole('general', path);
      const contributor = visibleForRole('contributor', path);
      const owner = visibleForRole('owner', path);
      expect(owner).toBe(true);
      if (general) expect(contributor).toBe(true);
      if (contributor) expect(owner).toBe(true);
      if (maturity === 'broken' || maturity === 'ops') {
        expect(general).toBe(false);
        expect(contributor).toBe(false);
      }
      if (maturity === 'tool') {
        expect(contributor).toBe(true);
        expect(general).toBe(false);
      }
      if (maturity === 'stable') expect(general).toBe(true);
      if (maturity === 'beta') {
        expect(contributor).toBe(true);
        expect(general).toBe(path === '/settings');
      }
    }
    expect(visibleForRole('general', '/settings')).toBe(true);
    expect(visibleForRole('general', '/settings?tab=theme')).toBe(true);
    expect(visibleForRole('general', '/settings/')).toBe(true);
    expect(visibleForRole('owner', '/share')).toBe(true);
    expect(visibleForRole('general', '/share')).toBe(false);
    expect(visibleForRole('contributor', '/share')).toBe(false);
    expect(visibleForRole('general', '/unknown')).toBe(false);
    expect(visibleForRole('general', '/chat')).toBe(true);
    expect(visibleForRole('contributor', '/editor')).toBe(true);
    expect(visibleForRole('general', '/editor')).toBe(false);
    expect(visibleForRole('owner', '/morning')).toBe(true);
    for (const [path, grade] of Object.entries(FEATURE_MATURITY.pwaRoute)) {
      expect(routeMaturity(path)).toBe(grade.pwa);
      for (const role of ['owner', 'contributor', 'general'] as const) {
        expect(visibleForRole(role, path)).toBe(visibleOn(path, 'pwa', role));
      }
    }
    expect(routeMaturity('/missions/123')).toBe('beta');
    expect(visibleForRole('contributor', '/missions/123?view=detail')).toBe(visibleOn('/missions/[id]', 'pwa', 'contributor'));
    expect(routeMaturity('/workflows/chat-ui/')).toBe('broken');
    expect(visibleForRole('contributor', '/workflows/chat-ui')).toBe(false);
  });

  test('route lookup preserves exact, normalized, dynamic, and unknown results', () => {
    for (const [route, { pwa }] of Object.entries(FEATURE_MATURITY.pwaRoute)) {
      expect(routeMaturity(route)).toBe(pwa);
      expect(routeMaturity(`${route}?view=compact#top`)).toBe(pwa);
    }
    expect(routeMaturity('/missions/123/')).toBe(FEATURE_MATURITY.pwaRoute['/missions/[id]'].pwa);
    expect(routeMaturity('/missions/123?view=detail')).toBe(FEATURE_MATURITY.pwaRoute['/missions/[id]'].pwa);
    for (const route of ['/unknown', '/missions/123/extra', '/chat/extra', '/toString', '/__proto__']) {
      expect(routeMaturity(route)).toBeUndefined();
      for (const role of ['owner', 'contributor', 'general'] as const) {
        expect(visibleForRole(role, route)).toBe(false);
      }
    }
  });

  test('sidebar groups never reintroduce hidden-for-role destinations', () => {
    const prefs = { showLabs: true, showHidden: true };
    const hrefs = (role: 'owner' | 'contributor' | 'general') => {
      const groups = visibleNavGroups(SIDEBAR_NAV_ITEMS, prefs, role);
      return [...groups.main, ...groups.labs, ...groups.hidden].map((item) => item.href);
    };
    const general = hrefs('general');
    const contributor = hrefs('contributor');
    const owner = hrefs('owner');
    expect(general).toContain('/settings');
    expect(general).not.toContain('/approvals');
    expect(contributor).toContain('/approvals');
    expect(contributor).not.toContain('/scheduler');
    expect(owner).toContain('/scheduler');
    for (const href of general) expect(contributor).toContain(href);
    for (const href of contributor) expect(owner).toContain(href);
  });
});
