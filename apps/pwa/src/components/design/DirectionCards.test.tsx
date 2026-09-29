// RFC design loop §B — a real click on a card's Select button reaches `onPick`
// with that card's id. linkedom DOM ⊕ react-dom, same setup as
// `components/shell/AuthRequiredBanner.test.tsx`.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import type { DesignDirectionView } from '@/nexus/client';

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

const system = (id: string, category = 'Modern & Minimal'): DesignDirectionView => ({
  id, label: id[0].toUpperCase() + id.slice(1), mood: `${id} mood`, isDark: false, isPastel: false,
  swatch: { text: '#111111', accent: '#b5452b', muted: '#888888', bg: '#fafafa', fg: '#111111' },
  source: 'design-system', typography: { display: 'Fraunces', body: 'Inter' }, category,
});
const theme = (id: string): DesignDirectionView => ({
  id, mood: `${id} mood`, isDark: true, isPastel: false,
  swatch: { text: '#eeeeee', accent: '#88c0d0', muted: '#4c566a' }, source: 'theme', typography: null, category: null,
});

async function mount(props: {
  declared: string | null;
  pendingId?: string | null;
  onPick?: (id: string) => void;
  previews?: ReadonlySet<string>;
  onPreview?: (id: string) => void;
}) {
  const { DirectionCards } = await import('./DirectionCards');
  await act(async () => {
    root.render(
      <DirectionCards
        available={[theme('nord-light'), system('minimal'), system('paper')]}
        declared={props.declared}
        pendingId={props.pendingId ?? null}
        onPick={props.onPick ?? (() => {})}
        previews={props.previews}
        onPreview={props.onPreview}
      />,
    );
  });
}

test('renders one card per direction, systems before themes', async () => {
  await mount({ declared: null });
  const ids = [...host.querySelectorAll('[data-direction]')].map((el) => el.getAttribute('data-direction'));
  expect(ids).toEqual(['minimal', 'paper', 'nord-light']);
  expect(host.textContent).toContain('Design systems');
  expect(host.textContent).toContain('Terminal themes');
  expect(host.textContent).toContain('Fraunces');
});

test('clicking Select calls onPick once with that card id', async () => {
  const picked: string[] = [];
  await mount({ declared: null, onPick: (id) => picked.push(id) });
  const button = host.querySelector('[data-direction="paper"] button') as HTMLButtonElement;
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(picked).toEqual(['paper']);
});

test('the declared card shows Selected and has no Select button', async () => {
  await mount({ declared: 'minimal' });
  const card = host.querySelector('[data-direction="minimal"]')!;
  expect(card.textContent).toContain('Selected');
  expect(card.querySelector('button')).toBeNull();
  expect(host.querySelectorAll('button').length).toBe(2);
});

test('Preview appears only on cards that have a preview and calls onPreview once', async () => {
  const opened: string[] = [];
  await mount({
    declared: null,
    previews: new Set(['paper']),
    onPreview: (id) => opened.push(id),
  });
  expect(host.querySelector('[data-direction="paper"] [aria-label="Preview Paper"]')).not.toBeNull();
  expect(host.querySelector('[data-direction="minimal"] [aria-label^="Preview"]')).toBeNull();
  expect(host.querySelector('[data-direction="nord-light"] [aria-label^="Preview"]')).toBeNull();
  const button = host.querySelector('[data-direction="paper"] [aria-label="Preview Paper"]') as HTMLButtonElement;
  await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(opened).toEqual(['paper']);
});

test('while one pick is in flight every Select waits', async () => {
  await mount({ declared: null, pendingId: 'paper' });
  const buttons = [...host.querySelectorAll('button')] as HTMLButtonElement[];
  expect(buttons.every((b) => b.disabled)).toBe(true);
  expect(host.querySelector('[data-direction="paper"] button')!.textContent).toBe('Selecting…');
});
