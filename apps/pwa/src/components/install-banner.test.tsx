import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { InstallBanner } from './install-banner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
  else delete (globalThis as { window?: Window }).window;
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
  else delete (globalThis as { navigator?: Navigator }).navigator;
});

test('install prompt stays hidden on 390px chat across re-evaluation, but shows on other routes and 1024px chat', async () => {
  const storage = { getItem: () => null, setItem: () => {} };
  const win = Object.assign(new EventTarget(), { innerWidth: 390, localStorage: storage, location: { href: 'https://example.test/chat' }, navigator: { standalone: false }, matchMedia: () => ({ matches: false }) });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone Safari' } });
  const render = (path: string) => <PathnameContext.Provider value={path}><SearchParamsContext.Provider value={new URLSearchParams()}><InstallBanner /></SearchParamsContext.Provider></PathnameContext.Provider>;
  await act(async () => { tree = create(render('/chat')); });
  await act(async () => { win.dispatchEvent(new Event('beforeinstallprompt')); });
  expect(tree!.root.findAllByProps({ 'data-testid': 'install-banner' })).toHaveLength(0);
  await act(async () => tree!.update(render('/term')));
  expect(tree!.root.findAllByProps({ 'data-testid': 'install-banner' })).toHaveLength(1);
  await act(async () => tree!.update(render('/chat')));
  expect(tree!.root.findAllByProps({ 'data-testid': 'install-banner' })).toHaveLength(0);
  win.innerWidth = 1024;
  await act(async () => { win.dispatchEvent(new Event('resize')); });
  expect(tree!.root.findAllByProps({ 'data-testid': 'install-banner' })).toHaveLength(1);
});
