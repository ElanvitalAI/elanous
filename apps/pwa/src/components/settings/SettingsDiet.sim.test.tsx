import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import SettingsPage from '../../app/settings/page';
import { DaemonContext, DaemonProvider } from '../providers/DaemonProvider';
import { ThemeProvider } from '../providers/ThemeProvider';
import { loadModelTierPrefs } from '../../lib/model-tier-prefs';

test('settings route renders the retained provider, credential and theme controls without out-of-scope cards', () => {
  const html = renderToStaticMarkup(createElement(DaemonProvider, null,
    createElement(ThemeProvider, null, createElement(SettingsPage))));

  expect(html).toContain('Default provider');
  expect(html).toContain('연결 토큰');
  expect(html).toContain('type="password"');
  expect(html).toContain('Mermaid theme');
  expect(html).not.toContain('Embedding + Vision');
  expect(html).not.toContain('Show hidden navigation');
  expect(html).not.toContain('Saved</button>');
  expect(html).not.toContain('(no session yet)');
});

test('the retained settings tier card saves a selection consumed by its rendered state', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { hash: '' }, addEventListener: () => {}, removeEventListener: () => {},
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  const providerValue = {
    config: { baseUrl: '', token: '', provider: 'anthropic' },
    setConfig: () => {}, client: {}, sessionId: '', setSessionId: () => {},
  };
  let tree: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      tree = create(createElement(DaemonContext.Provider, { value: providerValue as never },
        createElement(ThemeProvider, null, createElement(SettingsPage))));
    });
    expect(tree!.root.findByProps({ 'data-testid': 'llm-model-tier-card' })).toBeTruthy();
    const slider = tree!.root.findByProps({ 'data-testid': 'llm-model-tier-slider' });
    await act(async () => { slider.props.onChange({ target: { value: '4' } }); });
    await act(async () => { await Promise.resolve(); });
    expect(loadModelTierPrefs().llm).toBe('loaded');
    expect(tree!.root.findByProps({ 'data-testid': 'llm-model-tier-slider' }).props.value).toBe(4);
    expect(tree!.root.findByProps({ 'data-testid': 'llm-model-tier-card' }).findAll((node) =>
      node.type === 'span' && node.children.includes('Loaded')).length).toBeGreaterThan(0);
    await act(async () => { tree!.unmount(); });
    await act(async () => {
      tree = create(createElement(DaemonContext.Provider, { value: providerValue as never },
        createElement(ThemeProvider, null, createElement(SettingsPage))));
    });
    expect(tree!.root.findByProps({ 'data-testid': 'llm-model-tier-slider' }).props.value).toBe(4);
  } finally {
    if (tree) await act(async () => { tree!.unmount(); });
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
