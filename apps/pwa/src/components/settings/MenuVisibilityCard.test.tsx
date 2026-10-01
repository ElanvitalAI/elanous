// 메뉴 카드 — 체크를 켜면 그 키로 한 번 쓰고, 처음 그릴 때 저장된 값을 읽는다.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event };
let root: import('react-dom/client').Root;
let host: HTMLElement;

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  Object.assign(globalThis, originals);
});

test('reads saved flags on mount and writes the key once per toggle', async () => {
  const { MenuVisibilityCard } = await import('./MenuVisibilityCard');
  const writes: Array<[string, boolean]> = [];
  await act(async () => {
    root.render(<MenuVisibilityCard read={(key) => key === 'elanous.nav.showHidden'} write={(key, on) => writes.push([key, on])} />);
  });
  const labs = host.querySelector('[data-elanous-action="menu-show-labs"]') as HTMLInputElement;
  const hidden = host.querySelector('[data-elanous-action="menu-show-hidden"]') as HTMLInputElement;
  expect(labs.checked).toBe(false);
  expect(hidden.checked).toBe(true);
  expect(host.textContent).toContain('Showroom');
  expect(host.textContent).toContain('Dashboard');
  // linkedom 은 체크박스 기본 동작(값 뒤집기)을 안 한다 — 브라우저처럼 값을 바꾼 뒤 click 사건을 보낸다.
  await act(async () => { labs.checked = true; labs.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(writes).toEqual([['elanous.nav.showLabs', true]]);
});
