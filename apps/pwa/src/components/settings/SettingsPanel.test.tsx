import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { MERMAID_THEME_PREFERENCES, readMermaidThemePreference, writeMermaidThemePreference } from '../vault/mermaid-theme';

// The full SettingsPanel has daemon-backed cards; check the chat card's real JSX mount here.
test('settings mounts the automatic-routing card', () => {
  const source = readFileSync(join(import.meta.dir, 'SettingsPanel.tsx'), 'utf8');
  expect(source).toContain("import { ChatRoutingCard } from './ChatRoutingCard'");
  expect(source).toContain('<ChatRoutingCard />');
});

test('settings wires all Mermaid choices to the shared persisted preference', () => {
  const source = readFileSync(join(import.meta.dir, 'SettingsPanel.tsx'), 'utf8');
  expect(MERMAID_THEME_PREFERENCES).toEqual(['auto', 'default', 'neutral', 'dark', 'forest']);
  expect(source).toContain('<MermaidThemeSelector />');
  expect(source).toContain('MERMAID_THEME_PREFERENCES.map((choice) => (');
  expect(source).toContain('onClick={() => chooseMermaidTheme(choice)}');
  expect(source).toContain('writeMermaidThemePreference(value)');
  expect(source).toContain('useState<MermaidThemePreference>(readMermaidThemePreference)');
  expect(source).toContain('aria-pressed={mermaidTheme === choice}');
});

test('settings persistence reports a change so an open diagram can update', () => {
  const oldWindow = globalThis.window;
  const previous = new Map<string, string>();
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => previous.get(key) ?? null,
        setItem: (key: string, value: string) => { previous.set(key, value); },
      },
      dispatchEvent: (event: Event) => { events.push(event.type); },
    },
  });
  try {
    expect(readMermaidThemePreference()).toBe('auto');
    writeMermaidThemePreference('forest');
    expect(readMermaidThemePreference()).toBe('forest');
    expect(events).toEqual(['elanous:mermaid-theme-change']);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow });
  }
});

test('storage rejection still notifies the diagram and remembers the selection', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('storage blocked'); },
    },
    dispatchEvent: (event: Event) => { events.push(event.type); },
  } });
  try {
    writeMermaidThemePreference('neutral');
    expect(readMermaidThemePreference()).toBe('neutral');
    expect(events).toEqual(['elanous:mermaid-theme-change']);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
