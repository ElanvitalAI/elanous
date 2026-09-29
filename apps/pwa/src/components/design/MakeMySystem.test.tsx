import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import type { CreateDesignSystemBody, CreateDesignSystemResponse } from '@/nexus/client';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;
const originalHTMLElement = globalThis.HTMLElement;
const originalNode = globalThis.Node;
const originalEvent = globalThis.Event;
const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

let root: import('react-dom/client').Root;
let host: HTMLElement;

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  globalThis.navigator = window.navigator as Navigator;
  globalThis.HTMLElement = window.HTMLElement as typeof HTMLElement;
  globalThis.Node = window.Node as typeof Node;
  globalThis.Event = window.Event as typeof Event;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
});

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('typing a URL and pressing Make calls onCreate once with kind url', async () => {
  const { MakeMySystem } = await import('./MakeMySystem');
  const created: CreateDesignSystemBody[] = [];
  await act(async () => {
    root.render(
      <MakeMySystem
        pending={false}
        result={null}
        error={null}
        onCreate={(body) => { created.push(body); }}
        onSelect={() => {}}
      />,
    );
  });
  const input = host.querySelector('#make-system-url') as HTMLInputElement;
  await act(async () => { setValue(input, 'https://stumptowncoffee.com'); });
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Make it') as HTMLButtonElement;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  expect(created).toEqual([{ kind: 'url', url: 'https://stumptowncoffee.com' }]);
  expect(host.textContent).toContain('Reference, not a copy — logos, names, images and text are not taken');
});

test('after success, Select it calls onSelect with the made id', async () => {
  const { MakeMySystem } = await import('./MakeMySystem');
  const selected: string[] = [];
  const result: CreateDesignSystemResponse = {
    ok: true,
    id: 'stumptowncoffee',
    dir: '/library/stumptowncoffee',
    tokens: [{ token: 'bg', value: '#ffffff', from: 'custom' }],
    unread: 4,
    warnings: ['본문 대비 2.1:1 — 4.5:1 미만'],
  };
  await act(async () => {
    root.render(
      <MakeMySystem
        pending={false}
        result={result}
        error={null}
        onCreate={() => {}}
        onSelect={(id) => { selected.push(id); }}
      />,
    );
  });
  expect(host.textContent).toContain('Made stumptowncoffee — 1 tokens · 4 unread');
  expect(host.textContent).toContain('본문 대비 2.1:1 — 4.5:1 미만');
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Select it') as HTMLButtonElement;
  await act(async () => { button.click(); });
  expect(selected).toEqual(['stumptowncoffee']);
});
