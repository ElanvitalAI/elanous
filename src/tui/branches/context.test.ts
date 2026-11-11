import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LARGE_THRESHOLD_BYTES } from '../../context.js';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { acceptAtFile } from '../input/at-picker.js';
import { projectNextTuiContextArea, runNextTuiContextBranchRoute } from './context.js';

test('context projection reflects attachments added after its page was opened', () => {
  const attachments = new Map([['[attached 1: a.txt]', '/a.txt'], ['[attached 2: b.txt]', '/b.txt']]);
  const secondPage = projectNextTuiContextArea(attachments, 1, 1);
  expect(secondPage.lines[0]).toBe('첨부 2건 · 2/2쪽');
  attachments.set('[attached 3: c.txt]', '/c.txt');
  const refreshedSecondPage = projectNextTuiContextArea(attachments, secondPage.page, 1);
  expect(refreshedSecondPage.lines[0]).toBe('첨부 3건 · 2/3쪽');
  expect(refreshedSecondPage.lines[1]).toContain('/b.txt');
  const thirdPage = projectNextTuiContextArea(attachments, 2, 1);
  expect(thirdPage.lines[0]).toBe('첨부 3건 · 3/3쪽');
  expect(thirdPage.lines[1]).toContain('/c.txt');
});

test('/context and /ctx edit the same attachment tokens used by Next turns', () => {
  expect(resolveNextTuiRoute('/ctx', NEXT_TUI_INPUT_CONTEXT)?.branchModule).toBe('./branches/context.js');
  const directory = mkdtempSync(join(tmpdir(), 'next-context-'));
  const small = join(directory, 'small.txt');
  const large = join(directory, 'large.txt');
  // Source: src/context.ts clearLarge removes only attachments strictly above its threshold.
  writeFileSync(small, Buffer.alloc(DEFAULT_LARGE_THRESHOLD_BYTES));
  // Source: src/context.ts DEFAULT_LARGE_THRESHOLD_BYTES is the classic clear-big boundary.
  writeFileSync(large, Buffer.alloc(DEFAULT_LARGE_THRESHOLD_BYTES + 1));
  // Source: src/tui/input/at-picker.ts acceptAtFile is the production token creator.
  const smallToken = acceptAtFile('@small', { prefix: 'small', start: 0, end: 6 }, { label: 'small.txt', absPath: small, isDir: false }, 1).token;
  const largeToken = acceptAtFile('@large', { prefix: 'large', start: 0, end: 6 }, { label: 'large.txt', absPath: large, isDir: false }, 2).token;
  const attachments = new Map([[smallToken, small], [largeToken, large]]);
  const chatLines: string[] = [];
  let attachmentArea: string[] = [];
  let attachmentPage = 0;
  const host = { attachments, chatLines, attachmentPage, attachmentPageSize: 1,
    setAttachmentPage: (value: number) => { attachmentPage = value; host.attachmentPage = value; },
    setAttachmentArea: (lines: string[]) => { attachmentArea = lines; }, setChatScrollOffset: () => {} };
  try {
    runNextTuiContextBranchRoute('/context', host);
    expect(attachmentArea.join('\n')).toContain(smallToken);
    expect(attachmentArea.join('\n')).not.toContain(largeToken);
    runNextTuiContextBranchRoute('/context page 2', host);
    expect(attachmentArea.join('\n')).toContain(largeToken);
    expect(attachmentArea[0]).toContain('2/2쪽');
    runNextTuiContextBranchRoute('/context page 1', host);
    runNextTuiContextBranchRoute('/context clear bg', host);
    expect([...attachments.keys()]).toEqual([smallToken, largeToken]);
    expect(chatLines.at(-1)).toBe('Usage: /context clear [big]');
    runNextTuiContextBranchRoute('/context clear big extra', host);
    expect([...attachments.keys()]).toEqual([smallToken, largeToken]);
    expect(chatLines.at(-1)).toBe('Usage: /context clear [big]');
    runNextTuiContextBranchRoute('/context clear big', host);
    expect([...attachments.keys()]).toEqual([smallToken]);
    expect(attachmentArea.join('\n')).toContain(smallToken);
    expect(attachmentArea.join('\n')).not.toContain(largeToken);
    runNextTuiContextBranchRoute('/ctx drop 1', host);
    expect(attachments.size).toBe(0);
    expect(attachmentArea).toEqual([]);
    runNextTuiContextBranchRoute('/ctx clear', host);
    expect(chatLines.at(-1)).toBe('첨부 0건 삭제');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
