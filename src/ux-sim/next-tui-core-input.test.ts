import { expect, test } from 'bun:test';
import { simulateNextTuiCoreInput } from './next-tui-core-input.js';

test('Next TUI input simulation preserves history draft and paste-fold lifecycle', () => {
  const result = simulateNextTuiCoreInput();
  expect(result.previousPrompt).toBe('previous prompt');
  expect(result.restoredDraft).toBe('unsent draft');
  expect(result.historyIndex).toBe(0);
  expect(result.foldedPaste).toMatch(/^\[붙여넣음 #\d+ · 4줄 · /);
  expect(result.expandedPaste).toBe('붙여넣기 첫째\n둘째\n셋째\n넷째');
  expect(result.heldAfterSubmit).toBe(0);
  expect(result.heldAfterDeletion).toBe(0);
  expect(result.heldQueuedAfterDeletion).toBe(1);
  expect(result.queuedPasteExpanded).toBe('대기열 붙여넣기 첫째\n둘째\n셋째\n넷째');
  expect(result.heldQueuedAfterSubmit).toBe(0);
});
