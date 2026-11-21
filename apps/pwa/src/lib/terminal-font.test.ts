import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { preloadTerminalFont } from './terminal-font';

function fakeDocument() {
  const appended: Array<Record<string, string>> = [];
  return {
    appended,
    doc: {
      head: { appendChild: (node: Record<string, string>) => { appended.push(node); return node; } },
      querySelector: (selector: string) => appended.find((node) => selector.includes(node.href ?? '')) ?? null,
      createElement: () => ({}) as Record<string, string>,
    } as never,
  };
}

test('terminal preloads its font once, on demand', () => {
  const { appended, doc } = fakeDocument();
  preloadTerminalFont(doc);
  preloadTerminalFont(doc);
  expect(appended.map((node) => [node.rel, node.as, node.href])).toEqual([['preload', 'font', '/app/fonts/JetBrainsMonoNerdFontMono-Regular.ttf']]);
});

test('without a document it does nothing', () => {
  expect(preloadTerminalFont(undefined)).toBeUndefined();
});

test('the root layout no longer preloads the terminal font on every page (bare webchat entry never asks for it)', () => {
  const layout = readFileSync(resolve(import.meta.dir, '../app/layout.tsx'), 'utf8');
  expect(layout.includes('rel="preload"')).toBe(false);
  expect(layout.includes('.ttf')).toBe(false);
});

test('both terminal views request the preload themselves', () => {
  for (const file of ['XtermView.tsx', 'PtyLiveView.tsx']) {
    const source = readFileSync(resolve(import.meta.dir, `../components/terminal/${file}`), 'utf8');
    expect(source.includes('preloadTerminalFont()')).toBe(true);
  }
});
