import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  NAV_GROUPS,
  NON_MENU_SIDEBAR_ROUTES,
  SIDEBAR_NAV_ITEMS,
  isSidebarViewLink,
  navItemActive,
  sidebarRoutePath,
  visibleNavGroups,
} from './sidebar-nav-items';

const app = resolve(dirname(import.meta.path), '../../app');
const retainedRoutes = ['/', '/404', '/apps', '/apps/report', '/board', '/chat', '/credentials', '/credentials/register', '/credentials/register/claim', '/design-check', '/editor', '/live-run', '/live-run/adaptive', '/member/invite', '/ops/release', '/settings', '/setup', '/setup/done', '/share/received', '/signup', '/signup/complete', '/term', '/vault'];

function builtRoutes(directory = app): string[] {
  const pages: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /^page\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
        const segments = relative(directory, dirname(path)).split(sep).filter((part) => part && !/^\(.+\)$/.test(part));
        pages.push(segments.length ? `/${segments.join('/')}` : '/');
      }
    }
  };
  visit(directory);
  return [...pages, '/404'];
}

describe('PWA screens-out navigation', () => {
  test('keeps the public screens, member board and App Studio destinations', () => {
    expect(SIDEBAR_NAV_ITEMS.map((item) => item.href)).toEqual([
      '/chat', '/live-run', '/board', '/term', '/editor', '/apps', '/design-check', '/vault', '/settings', '/credentials',
    ]);
    expect(new Set(SIDEBAR_NAV_ITEMS.map((item) => item.href)).size).toBe(10);
    expect(NAV_GROUPS.map((group) => group.id)).toEqual(['talk', 'work', 'make', 'files', 'settings']);
  });

  test('retained pages are fully accounted for by menu and foundations', () => {
    const built = builtRoutes();
    const accounted = [
      ...SIDEBAR_NAV_ITEMS.map((item) => sidebarRoutePath(item.href)),
      ...NON_MENU_SIDEBAR_ROUTES.map((route) => route.href),
    ];
    expect(new Set(built).size).toBe(built.length);
    expect(built.sort()).toEqual([...retainedRoutes].sort());
    expect(new Set(accounted).size).toBe(accounted.length);
    expect(accounted.sort()).toEqual([...retainedRoutes].sort());
    expect(NON_MENU_SIDEBAR_ROUTES.filter((route) => route.category === 'member-signup').map((route) => route.href))
      .toEqual(['/signup', '/signup/complete']);
  });

  test('role and beta filtering only affects the retained menu', () => {
    const prefs = { showLabs: true, showHidden: true };
    const hrefs = (role: 'owner' | 'contributor' | 'general', showBeta = false) => {
      const groups = visibleNavGroups(SIDEBAR_NAV_ITEMS, prefs, role, { showBeta });
      return [...groups.main, ...groups.labs, ...groups.hidden].map((item) => item.href);
    };
    expect(hrefs('owner')).toEqual(['/chat', '/live-run', '/board', '/term', '/editor', '/apps', '/design-check', '/vault', '/settings', '/credentials']);
    expect(hrefs('general')).toEqual(['/chat', '/board', '/term', '/editor', '/settings']);
    expect(hrefs('general', true)).toEqual(['/chat', '/live-run', '/board', '/term', '/editor', '/apps', '/vault', '/settings']);
    expect(hrefs('contributor')).toEqual(hrefs('owner').filter((href) => href !== '/credentials'));
    for (const role of ['owner', 'contributor', 'general'] as const) {
      expect(visibleNavGroups(SIDEBAR_NAV_ITEMS, prefs, role).main.map((item) => item.href))
        .toEqual(hrefs(role).filter((href) => SIDEBAR_NAV_ITEMS.find((item) => item.href === href)?.visibility !== 'labs'));
    }
  });

  test('path accounting strips view queries and only highlights the active destination', () => {
    expect(sidebarRoutePath('/chat?view=compact#top')).toBe('/chat');
    expect(isSidebarViewLink('/chat?view=compact')).toBe(true);
    expect(isSidebarViewLink('/chat')).toBe(false);
    expect(navItemActive({ href: '/chat' }, '/chat', '', SIDEBAR_NAV_ITEMS)).toBe(true);
    expect(navItemActive({ href: '/chat' }, '/chat/child', '', SIDEBAR_NAV_ITEMS)).toBe(true);
    expect(navItemActive({ href: '/term' }, '/chat', '', SIDEBAR_NAV_ITEMS)).toBe(false);
  });
});
