import { expect, test } from 'bun:test';
import { InlineChoiceBroker } from '../tui/inline-choice.js';
import {
  createInlineAskUserQuestionResolver,
  resolveUnattendedInlineChoiceTimeoutMs,
  UNATTENDED_INLINE_CHOICE_TIMEOUT_MS,
} from './inline-resolver.js';

test('unattended inline prompts use only explicit config or the exact seat-launch env value', () => {
  expect(resolveUnattendedInlineChoiceTimeoutMs({ tui: { unattended: false } }, { ELANOUS_TUI_UNATTENDED: '1' })).toBeUndefined();
  expect(resolveUnattendedInlineChoiceTimeoutMs({ tui: { unattended: true } }, { ELANOUS_TUI_UNATTENDED: '0' })).toBe(UNATTENDED_INLINE_CHOICE_TIMEOUT_MS);
  expect(resolveUnattendedInlineChoiceTimeoutMs({}, { ELANOUS_TUI_UNATTENDED: '1' })).toBe(UNATTENDED_INLINE_CHOICE_TIMEOUT_MS);
  expect(resolveUnattendedInlineChoiceTimeoutMs({}, { ELANOUS_TUI_UNATTENDED: 'true' })).toBeUndefined();
});

test('AskUserQuestion can collect sequential single/multi choices through PTY text without a modal', async () => {
  const lines: string[] = [];
  const broker = new InlineChoiceBroker({ appendLines: (next) => lines.push(...next) });
  const resolve = createInlineAskUserQuestionResolver(broker, {
    createId: () => 'fixture',
    timeoutMs: () => 60_000,
  });
  const resultPromise = resolve({ questions: [
    {
      id: 'scope', header: 'Scope', question: 'Which scope?',
      options: [{ label: 'small', description: 'first' }, { label: 'wide', description: 'second' }],
      includeOther: false,
    },
    {
      id: 'signals', header: 'Signals', question: 'Choose signals?',
      options: [{ label: 'logs', description: 'first' }, { label: 'screen', description: 'second' }],
      multiSelect: true, includeOther: false,
    },
  ] });

  expect(broker.activeId).toBe('fixture:scope');
  expect(broker.handleInput('2')).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(broker.activeId).toBe('fixture:signals');
  expect(broker.handleInput('1,2')).toBe(true);
  expect(await resultPromise).toEqual({ answers: { scope: 'wide', signals: ['logs', 'screen'] } });
  expect(lines).toContain('  1. small — first');
  expect(lines).toContain('  2. screen — second');
});

test('AskUserQuestion preserves partial answers when an inline prompt times out', async () => {
  const broker = new InlineChoiceBroker({ appendLines: () => {} });
  const resolve = createInlineAskUserQuestionResolver(broker, { createId: () => 'timeout', timeoutMs: () => 1 });
  const resultPromise = resolve({ questions: [{
    id: 'choice', header: 'Choice', question: 'Pick?',
    options: [{ label: 'a', description: '' }, { label: 'b', description: '' }],
    includeOther: false,
  }] });
  expect(await resultPromise).toEqual({ answers: {}, cancelled: true });
});
