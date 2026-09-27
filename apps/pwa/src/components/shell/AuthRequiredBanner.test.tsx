import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { reportAuthRequired, resetAuthRequiredForTests } from '@/lib/auth-required';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;
const originalHTMLElement = globalThis.HTMLElement;
const originalNode = globalThis.Node;
const originalEvent = globalThis.Event;
const originalCustomEvent = globalThis.CustomEvent;
const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

let root: import('react-dom/client').Root;
let host: HTMLElement;

beforeEach(async () => {
  resetAuthRequiredForTests();
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  globalThis.navigator = window.navigator as Navigator;
  globalThis.HTMLElement = window.HTMLElement as typeof HTMLElement;
  globalThis.Node = window.Node as typeof Node;
  globalThis.Event = window.Event as typeof Event;
  globalThis.CustomEvent = class<T> extends window.Event {
    readonly detail: T;
    constructor(name: string, options: CustomEventInit<T> = {}) {
      super(name, options);
      this.detail = options.detail as T;
    }
  } as unknown as typeof CustomEvent;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  resetAuthRequiredForTests();
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else globalThis.document = originalDocument;
  if (originalNavigator === undefined) delete (globalThis as { navigator?: Navigator }).navigator;
  else globalThis.navigator = originalNavigator;
  if (originalHTMLElement === undefined) delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  else globalThis.HTMLElement = originalHTMLElement;
  if (originalNode === undefined) delete (globalThis as { Node?: typeof Node }).Node;
  else globalThis.Node = originalNode;
  globalThis.Event = originalEvent;
  globalThis.CustomEvent = originalCustomEvent;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

async function mount() {
  const { AuthRequiredBanner } = await import('./AuthRequiredBanner');
  await act(async () => { root.render(<AuthRequiredBanner />); });
}

test('mounted banner appears only after 401, links to settings and stays dismissed after remount', async () => {
  await mount();
  expect(host.querySelector('[role="alert"]')).toBeNull();

  await act(async () => { reportAuthRequired('/v1/health'); });
  const banner = host.querySelector('[role="alert"]');
  expect(banner?.textContent).toContain('이 기기는 아직 데몬에 연결되지 않았습니다(인증 필요).');
  expect(banner?.textContent).toContain('붙여넣으세요');
  expect(banner?.querySelector('a')?.getAttribute('href')).toBe('/settings');

  await act(async () => { (banner?.querySelector('button') as HTMLElement).click(); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { root.unmount(); });
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
  await mount();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { reportAuthRequired('/v1/other'); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test('a 401 before mounting shows the one-time notice', async () => {
  reportAuthRequired('/v1/health');
  await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('붙여넣으세요');
});

test('banner names settings labels that exist on the settings page', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (name: string) => readFileSync(new URL(`../settings/${name}`, import.meta.url), 'utf8');
  const banner = readFileSync(new URL('./AuthRequiredBanner.tsx', import.meta.url), 'utf8');
  for (const label of ['Connect token (other devices)', 'Bearer token']) expect(banner).toContain(label);
  expect(read('ConnectTokenCard.tsx')).toContain('Connect token (other devices)');
  expect(read('SettingsPanel.tsx')).toContain('Bearer token');
});
