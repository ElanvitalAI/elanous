import { describe, expect, test } from 'bun:test';
import {
  MERMAID_THEME_PREFERENCES,
  readMermaidThemePreference,
  selectMermaidTheme,
  writeMermaidThemePreference,
} from './mermaid-theme';

describe('Mermaid theme selection', () => {
  test('automatic is default regardless of PWA color scheme; explicit choices stay explicit', () => {
    expect(MERMAID_THEME_PREFERENCES).toEqual(['auto', 'default', 'neutral', 'dark', 'forest']);
    for (const [preference, expected] of [
      ['auto', 'default'], ['default', 'default'], ['neutral', 'neutral'],
      ['dark', 'dark'], ['forest', 'forest'],
    ] as const) {
      expect(selectMermaidTheme('graph TD\nA-->B', preference)).toBe(expected);
    }
  });

  test('note init directive wins over automatic and explicitly selected settings', () => {
    const source = "%%{init: {'theme': 'forest'}}%%\ngraph TD\nA-->B";
    expect(selectMermaidTheme(source, 'auto')).toBe('forest');
    expect(selectMermaidTheme(source, 'dark')).toBe('forest');
    expect(selectMermaidTheme('%%{init: {theme: "dark"}}%%\ngraph TD', 'neutral')).toBe('dark');
    expect(selectMermaidTheme('%%{init: {"theme": "base"}}%%\ngraph TD', 'forest')).toBe('base');
    expect(selectMermaidTheme('%%{init: {"theme": "default"}}%%\ngraph TD', 'dark')).toBe('default');
    expect(selectMermaidTheme('%%{init: {theme: neutral}}%%\ngraph TD', 'forest')).toBe('neutral');
    expect(selectMermaidTheme('%%{init: {layout: "elk"}}%%\ngraph TD', 'neutral')).toBe('neutral');
  });

  test('storage defaults to auto when no browser is available', () => {
    expect(readMermaidThemePreference()).toBe('auto');
    expect(() => writeMermaidThemePreference('forest')).not.toThrow();
  });
});
