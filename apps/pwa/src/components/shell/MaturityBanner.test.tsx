import { afterAll, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as realNavigation from 'next/navigation';

let pathname = '/settings';
const originalNavigation = { ...realNavigation };
mock.module('next/navigation', () => ({ ...originalNavigation, usePathname: () => pathname }));
const { MaturityBanner } = await import('./MaturityBanner');
afterAll(() => mock.module('next/navigation', () => originalNavigation));

test('current beta routes show a banner while stable and retired routes do not', () => {
  const text = () => renderToStaticMarkup(<MaturityBanner />);
  pathname = '/settings';
  expect(text()).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  pathname = '/vault/';
  expect(text()).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  for (const route of ['/chat', '/inside', '/app/inside/', '/morning']) {
    pathname = route;
    expect(text()).toBe('');
  }
});
