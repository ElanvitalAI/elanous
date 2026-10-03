import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import * as realNavigation from 'next/navigation';

let pathname = '/inside';
const originalNavigation = { ...realNavigation };
mock.module('next/navigation', () => ({ ...originalNavigation, usePathname: () => pathname }));
const { MaturityBanner } = await import('./MaturityBanner');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => mock.module('next/navigation', () => originalNavigation));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let tree: ReactTestRenderer | undefined;
afterEach(() => {
  if (tree) act(() => tree!.unmount());
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

test('inside demo hides beta; URL overrides memory and toggles update the banner without changing other routes', () => {
  let url = 'https://example.test/inside?demo=1';
  let saved = '0';
  const handlers = new Map<string, () => void>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { get href() { return url; } },
    localStorage: { getItem: () => saved },
    addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
    removeEventListener: (name: string) => handlers.delete(name),
  } });
  pathname = '/inside';
  expect(renderToStaticMarkup(<MaturityBanner />)).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  url = 'https://example.test/inside?demo=0';
  expect(renderToStaticMarkup(<MaturityBanner />)).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  url = 'https://example.test/inside?demo=1';
  act(() => { tree = create(<MaturityBanner />); });
  const text = () => JSON.stringify(tree!.toJSON());
  expect(text()).not.toContain('베타');
  pathname = '/app/inside/';
  act(() => tree!.update(<MaturityBanner />));
  expect(text()).not.toContain('베타');
  pathname = '/inside';
  act(() => tree!.update(<MaturityBanner />));
  url = 'https://example.test/app/inside/?demo=0';
  pathname = '/app/inside/';
  act(() => { tree!.update(<MaturityBanner />); handlers.get('elanous:inside-demo')?.(); });
  expect(text()).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  url = 'https://example.test/inside?demo=0';
  pathname = '/inside';
  act(() => { tree!.update(<MaturityBanner />); handlers.get('elanous:inside-demo')?.(); });
  expect(text()).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  url = 'https://example.test/inside';
  saved = '1';
  act(() => handlers.get('elanous:inside-demo')?.());
  expect(text()).not.toContain('베타');
  pathname = '/settings';
  act(() => tree!.update(<MaturityBanner />));
  expect(text()).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  pathname = '/morning';
  act(() => tree!.update(<MaturityBanner />));
  expect(text()).toContain('이 화면은 지금 고치는 중입니다.');
});
