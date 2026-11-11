import { describe, expect, test } from 'bun:test';

import {
  findReverseHistoryMatchIndices,
  resolveReverseHistorySearchResult,
  shouldPreferHistoryArrowNavigation,
  shouldSuppressSlashPickerAfterHistoryRecall,
} from '../src/chat/index.js';

describe('chat input history priority', () => {
  test('quick slash mode gives up-arrow to history before picker navigation', () => {
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: true,
      linesLength: 1,
      historyLength: 3,
      historyIdx: -1,
      keyName: 'up',
      currentLine: '/',
    })).toBe(true);
  });

  test('down-arrow stays on history while navigating back toward the draft', () => {
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: true,
      linesLength: 1,
      historyLength: 3,
      historyIdx: 1,
      keyName: 'down',
      currentLine: '/tablet status',
    })).toBe(true);
  });

  test('plain input mode keeps picker ownership for arrow keys', () => {
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: false,
      linesLength: 1,
      historyLength: 3,
      historyIdx: -1,
      keyName: 'up',
      currentLine: '/tablet status',
    })).toBe(false);
  });

  test('plain empty draft boots into history search on first up', () => {
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: false,
      linesLength: 1,
      historyLength: 3,
      historyIdx: -1,
      keyName: 'up',
      currentLine: '',
    })).toBe(true);
  });

  test('once history navigation started, up/down stay on history even for slash lines', () => {
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: false,
      linesLength: 1,
      historyLength: 3,
      historyIdx: 0,
      keyName: 'up',
      currentLine: '/tablet status',
    })).toBe(true);
    expect(shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: false,
      linesLength: 1,
      historyLength: 3,
      historyIdx: 1,
      keyName: 'down',
      currentLine: '/tablet status',
    })).toBe(true);
  });

  test('history-recalled slash lines suppress immediate slash picker activation', () => {
    expect(shouldSuppressSlashPickerAfterHistoryRecall({
      suppressedByHistoryRecall: true,
      linesLength: 1,
      currentLine: '/git status',
    })).toBe(true);
  });

  test('suppression only applies to single-line slash history recalls', () => {
    expect(shouldSuppressSlashPickerAfterHistoryRecall({
      suppressedByHistoryRecall: true,
      linesLength: 1,
      currentLine: 'normal text',
    })).toBe(false);
    expect(shouldSuppressSlashPickerAfterHistoryRecall({
      suppressedByHistoryRecall: false,
      linesLength: 1,
      currentLine: '/git status',
    })).toBe(false);
    expect(shouldSuppressSlashPickerAfterHistoryRecall({
      suppressedByHistoryRecall: true,
      linesLength: 2,
      currentLine: '/git status',
    })).toBe(false);
  });
});

describe('reverse input history search helpers', () => {
  const history = [
    'first command',
    'second question',
    '/run-skill ast-grep',
    'latest question about agents',
  ];

  test('findReverseHistoryMatchIndices returns newest-first matches', () => {
    expect(findReverseHistoryMatchIndices(history, 'question')).toEqual([3, 1]);
  });

  test('matching is case-insensitive and empty query includes all entries newest first', () => {
    expect(findReverseHistoryMatchIndices(history, 'AST')).toEqual([2]);
    expect(findReverseHistoryMatchIndices(history, '')).toEqual([3, 2, 1, 0]);
  });

  test('resolveReverseHistorySearchResult selects nth newest match', () => {
    expect(resolveReverseHistorySearchResult(history, 'question', 0)).toBe('latest question about agents');
    expect(resolveReverseHistorySearchResult(history, 'question', 1)).toBe('second question');
    expect(resolveReverseHistorySearchResult(history, 'question', 9)).toBe('second question');
    expect(resolveReverseHistorySearchResult(history, 'missing', 0)).toBeNull();
  });
});

describe('reverse input history search helpers', () => {
  const history = [
    'first command',
    'second question',
    '/run-skill ast-grep',
    'latest question about agents',
  ];

  test('findReverseHistoryMatchIndices returns newest-first matches', () => {
    expect(findReverseHistoryMatchIndices(history, 'question')).toEqual([3, 1]);
  });

  test('matching is case-insensitive and empty query includes all entries newest first', () => {
    expect(findReverseHistoryMatchIndices(history, 'AST')).toEqual([2]);
    expect(findReverseHistoryMatchIndices(history, '')).toEqual([3, 2, 1, 0]);
  });

  test('resolveReverseHistorySearchResult selects nth newest match', () => {
    expect(resolveReverseHistorySearchResult(history, 'question', 0)).toBe('latest question about agents');
    expect(resolveReverseHistorySearchResult(history, 'question', 1)).toBe('second question');
    expect(resolveReverseHistorySearchResult(history, 'question', 9)).toBe('second question');
    expect(resolveReverseHistorySearchResult(history, 'missing', 0)).toBeNull();
  });
});
