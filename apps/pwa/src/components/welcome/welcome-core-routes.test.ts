import { describe, expect, test } from 'bun:test';
import { SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';
import { splitWelcomeRoutes } from './welcome-core-routes';

describe('splitWelcomeRoutes', () => {
  test('partitions every menu destination without inventing an absent market route', () => {
    const { core, more } = splitWelcomeRoutes(SIDEBAR_NAV_ITEMS);
    expect(core.map((item) => item.href)).toEqual(
      ['/term', '/chat', '/intake', '/live', '/editor', '/market'].filter((href) => SIDEBAR_NAV_ITEMS.some((item) => item.href === href)),
    );
    expect([...core, ...more].length).toBe(SIDEBAR_NAV_ITEMS.length);
    expect(new Set([...core, ...more])).toEqual(new Set(SIDEBAR_NAV_ITEMS));
    expect(more).toEqual(SIDEBAR_NAV_ITEMS.filter((item) => !core.includes(item)));
  });

  test('uses the onboarding order even if the sidebar order changes', () => {
    const items = [{ href: '/editor' }, { href: '/chat' }, { href: '/term' }];
    expect(splitWelcomeRoutes(items).core).toEqual([items[2], items[1], items[0]]);
  });

  test('includes Setup when supplied, and keeps all other destinations in more', () => {
    const items = [
      { href: '/control', label: 'Control' },
      { href: '/setup', label: 'Setup' },
      { href: '/chat', label: 'Chat' },
      { href: '/showroom', label: 'Showroom' },
    ];
    expect(splitWelcomeRoutes(items)).toEqual({ core: [items[2], items[1]], more: [items[0], items[3]] });
  });
});
