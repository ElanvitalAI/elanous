import { expect, test } from 'bun:test';
import { formatSidetabLines, withSidetabPreviewSources, type SidetabRow } from './list.js';

// SLASH-SWEEP-0328: the current TUI's own row peeked its own screen and showed three empty «↳ …» rows.
test('the current TUI row has no peek; another PTY row keeps its snapshot tail', () => {
  const rows = [
    { id: 'self', label: 'idle elanous', kind: 'tui', badge: 'idle', currentProcess: true },
    { id: 'shell-a', label: 'shell', kind: 'shell', badge: 'live' },
  ] as unknown as SidetabRow[];
  const withSources = withSidetabPreviewSources(rows, new Map([['self', 'Remote · 0\n+ new · /side new'], ['shell-a', '$ ls\nREADME.md']]));
  expect(withSources.map((row) => row.previewSource)).toEqual(['', '$ ls\nREADME.md']);
  expect(formatSidetabLines(withSources, 0, 28).some((line) => line.includes('↳'))).toBe(false);
  expect(formatSidetabLines(withSources, 1, 28).some((line) => line.includes('↳ README.md'))).toBe(true);
});
