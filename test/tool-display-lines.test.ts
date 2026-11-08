import { describe, expect, test } from 'bun:test';
import { CHAT_DEFAULTS } from '../src/user-config/chat.js';
import { FOLD_LIMITS } from '../src/log-entry.js';
import {
  measureChatToolDisplay,
  measureSkillRuntimeDisplay,
} from '../scripts/measure-tool-display-lines.js';

describe('tool display-line measurements', () => {
  test('caps an ordinary tool result at the render-block budget', () => {
    expect(CHAT_DEFAULTS.rendering.tool.blockMaxLines).toBe(8);
    expect(measureChatToolDisplay('Bash', 80)).toMatchObject({
      collapsedLines: 9,
      truncated: true,
      winningConstant: 'CHAT_DEFAULTS.rendering.tool.blockMaxLines (8)',
    });
  });

  test('keeps a truncated listing result at the resolved render-block budget', () => {
    expect(measureChatToolDisplay('Glob', 80)).toMatchObject({
      collapsedLines: 9,
      truncated: true,
      winningConstant: 'CHAT_DEFAULTS.rendering.tool.blockMaxLines (8)',
    });
  });

  test('records the no-truncation path instead of inventing a winning constant', () => {
    expect(measureChatToolDisplay('Glob', 3)).toMatchObject({
      collapsedLines: 4,
      truncated: false,
      winningConstant: null,
    });
  });

  test('caps the independent skill runtime at the listing-level collapsed budget', () => {
    expect(FOLD_LIMITS.TOOL_BODY).toBe(8);
    expect(measureSkillRuntimeDisplay(80)).toMatchObject({
      collapsedLines: 9,
      truncated: true,
      winningConstant: 'FOLD_LIMITS.TOOL_BODY (8)',
    });
    expect(measureSkillRuntimeDisplay(8)).toMatchObject({
      collapsedLines: 8,
      truncated: false,
      winningConstant: null,
    });
  });
});
