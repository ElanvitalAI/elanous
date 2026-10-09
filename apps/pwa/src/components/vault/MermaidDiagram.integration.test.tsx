import { createRequire } from 'node:module';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import { readMermaidThemePreference, writeMermaidThemePreference } from './mermaid-theme';
import { setMermaidLoaderForTest } from './MermaidDiagram';

const settings = createReactHookHarness(createRequire(import.meta.url)('react'));
const diagram = createReactHookHarness(createRequire(import.meta.url)('react'));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalComputedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
const listeners = new Map<string, Set<(event: Event) => void>>();
const stored = new Map<string, string>();
let failStorage = false;
let activeTheme = 'default';
const renderCalls: Array<{ source: string; theme: string }> = [];

// Injected through the component's loader seam (no process-wide mock.module).
setMermaidLoaderForTest(async () => ({
  initialize: ((options: { theme?: string }) => { activeTheme = options.theme ?? 'default'; }) as never,
  render: (async (_id: string, source: string) => {
    renderCalls.push({ source, theme: activeTheme });
    return { svg: `<svg data-rendered-theme="${activeTheme}"></svg>` };
  }) as never,
}));

Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  location: { hash: '' },
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failStorage) throw new Error('QuotaExceededError');
      stored.set(key, value);
    },
  },
  addEventListener: (type: string, listener: (event: Event) => void) => {
    const group = listeners.get(type) ?? new Set();
    group.add(listener);
    listeners.set(type, group);
  },
  removeEventListener: (type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener); },
  dispatchEvent: (event: Event) => { for (const listener of listeners.get(event.type) ?? []) listener(event); },
} });
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  documentElement: {}, head: { appendChild: () => {} }, getElementById: () => null,
  getElementsByTagName: () => [],
  createElement: () => ({ appendChild: () => {}, style: {}, setAttribute: () => {} }),
  createTextNode: () => ({}),
} });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ colorScheme: 'dark' }) });

function restore(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

afterAll(() => {
  settings.unmount();
  diagram.unmount();
  setMermaidLoaderForTest(null);
  restore('window', originalWindow);
  restore('document', originalDocument);
  restore('getComputedStyle', originalComputedStyle);
});
beforeEach(() => {
  settings.unmount();
  diagram.unmount();
  renderCalls.length = 0;
  failStorage = false;
  writeMermaidThemePreference('auto');
  stored.clear();
});

function renderedSvg(): { className: string; svg: string } {
  const card = diagram.find((element) => element.props['data-elanous-mermaid'] === 'ok');
  return { className: String(card.props.className), svg: String((card.props.dangerouslySetInnerHTML as { __html: string }).__html) };
}

async function showDiagram(source: string): Promise<void> {
  const { MermaidDiagram } = await import('./MermaidDiagram');
  diagram.render(MermaidDiagram as never, { source });
  await diagram.settle();
}

async function clickChoice(choice: string): Promise<void> {
  const button = settings.find((element) => element.props['aria-pressed'] !== undefined &&
    settings.textOf(element) === choice);
  settings.act(() => (button.props.onClick as () => void)());
  await settings.settle();
  await diagram.settle();
}

test('SettingsPanel click updates an open MermaidDiagram SVG; default has a light card on a dark page', async () => {
  const { MermaidThemeSelector } = await import('../settings/SettingsPanel');
  settings.render(MermaidThemeSelector as never);
  await settings.settle();
  await showDiagram('graph TD\nA-->B');
  expect(renderedSvg().svg).toContain('data-rendered-theme="default"');
  expect(renderedSvg().className).toContain('bg-white');
  for (const theme of ['neutral', 'dark', 'forest', 'default', '자동']) {
    await clickChoice(theme);
    const expected = theme === '자동' ? 'default' : theme;
    expect(renderedSvg().svg).toContain(`data-rendered-theme="${expected}"`);
    expect(renderedSvg().className.includes('bg-white')).toBe(expected !== 'dark');
    expect(renderCalls.at(-1)).toEqual({ source: 'graph TD\nA-->B', theme: expected });
  }
});

test('note init overrides clicked setting in the rendered SVG, without removing the note directive', async () => {
  const { MermaidThemeSelector } = await import('../settings/SettingsPanel');
  settings.render(MermaidThemeSelector as never);
  await settings.settle();
  const source = "%%{init: {theme: 'forest'}}%%\ngraph TD\nA-->B";
  await showDiagram(source);
  await clickChoice('dark');
  expect(renderedSvg().svg).toContain('data-rendered-theme="forest"');
  expect(renderedSvg().className).toContain('bg-white');
  expect(renderCalls.at(-1)).toEqual({ source, theme: 'forest' });
  await clickChoice('neutral');
  expect(renderedSvg().svg).toContain('data-rendered-theme="forest"');
  expect(renderCalls.at(-1)).toEqual({ source, theme: 'forest' });
  diagram.unmount();
  await showDiagram('graph TD\nA-->B');
  expect(renderedSvg().svg).toContain('data-rendered-theme="neutral"');
});

test('storage write rejection keeps the selected choice for renderer and next settings mount', async () => {
  const { MermaidThemeSelector } = await import('../settings/SettingsPanel');
  settings.render(MermaidThemeSelector as never);
  await settings.settle();
  await showDiagram('graph TD\nA-->B');
  failStorage = true;
  await clickChoice('neutral');
  expect(stored.get('elanous.mermaid.theme')).toBeUndefined();
  expect(renderedSvg().svg).toContain('data-rendered-theme="neutral"');
  expect(readMermaidThemePreference()).toBe('neutral');
  settings.unmount();
  settings.render(MermaidThemeSelector as never);
  expect(settings.find((element) => element.props['aria-pressed'] === true && settings.textOf(element) === 'neutral')).toBeDefined();
  failStorage = false;
  await clickChoice('forest');
  expect(readMermaidThemePreference()).toBe('forest');
  expect(renderedSvg().svg).toContain('data-rendered-theme="forest"');
});
