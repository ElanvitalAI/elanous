import { describe, expect, test } from 'bun:test';
import { createInlineChoice, formatInlineChoiceLines, InlineChoiceBroker, splitInlineChoiceComposerInput } from './inline-choice.js';

const spec = {
  id: 'stop-confirm',
  question: '중단 요청을 확인할까요?',
  options: [
    { value: 'stop', label: '중단' },
    { value: 'continue', label: '계속' },
  ],
  includeOther: false,
};

describe('inline choice prompts', () => {
  test('renders choices into chat lines and accepts a numeric text response', async () => {
    const lines: string[] = [];
    const events: unknown[] = [];
    let now = 100;
    const prompt = createInlineChoice(spec, {
      appendLines: (newLines) => lines.push(...newLines),
      observe: (event) => events.push(event),
      now: () => now,
    });

    expect(lines).toEqual(formatInlineChoiceLines(spec));
    expect(prompt.handleInput('99')).toBe(true);
    expect(lines.at(-1)).toBe('  선택한 번호를 확인해 다시 입력하세요.');
    now = 125;
    expect(prompt.handleInput('1')).toBe(true);
    expect(await prompt.promise).toEqual({ selected: ['stop'] });
    expect(events).toEqual([{ id: 'stop-confirm', outcome: 'answered', selectedCount: 1, elapsedMs: 25 }]);
    expect(prompt.handleInput('2')).toBe(false);
  });

  test('supports multi-select and a typed Other answer for PTY text input', async () => {
    const lines: string[] = [];
    const multi = createInlineChoice({ ...spec, multiSelect: true }, { appendLines: (next) => lines.push(...next) });
    expect(multi.handleInput('2,1,2')).toBe(true);
    expect(await multi.promise).toEqual({ selected: ['continue', 'stop'] });

    const other = createInlineChoice({ ...spec, includeOther: true }, { appendLines: (next) => lines.push(...next) });
    expect(other.handleInput('3')).toBe(true);
    expect(other.handleInput('keep the current run')).toBe(true);
    expect(await other.promise).toEqual({ selected: [], otherText: 'keep the current run' });
  });

  test('yes/no defaults to N on Enter and supports explicit keyboard selection without Other', async () => {
    const panel: string[][] = [];
    const defaultNo = createInlineChoice({ ...spec, yesNo: true }, {
      appendLines: () => {}, renderPanel: (lines) => panel.push([...lines]),
    });
    expect(panel.at(-1)).toContain('  ▸ n. 계속');
    expect(panel.at(-1)?.some((line) => line.includes('Other'))).toBe(false);
    expect(defaultNo.handleInput('')).toBe(true);
    expect(await defaultNo.promise).toEqual({ selected: ['continue'] });

    const chooseYes = createInlineChoice({ ...spec, yesNo: true }, { appendLines: () => {} });
    expect(chooseYes.handleKey('up')).toBe(true);
    expect(chooseYes.handleInput('')).toBe(true);
    expect(await chooseYes.promise).toEqual({ selected: ['stop'] });

    const typedYes = createInlineChoice({ ...spec, yesNo: true }, { appendLines: () => {} });
    expect(typedYes.handleInput('y')).toBe(true);
    expect(await typedYes.promise).toEqual({ selected: ['stop'] });
  });

  test('bounds long option lists and keeps the selected row visible while scrolling', () => {
    const long = {
      ...spec,
      options: Array.from({ length: 24 }, (_, index) => ({ value: `v${index}`, label: `Choice ${index + 1}` })),
    };
    const lines = formatInlineChoiceLines(long, 18);
    expect(lines.filter((line) => line.includes('Choice '))).toEqual([
      '    16. Choice 16',
      '    17. Choice 17',
      '    18. Choice 18',
      '  ▸ 19. Choice 19',
    ]);
    expect(lines.some((line) => line.includes('↑'))).toBe(true);
    expect(lines.some((line) => line.includes('↓'))).toBe(true);
  });

  test('reports invalid answer separately so the input owner can restore its draft', async () => {
    const prompt = createInlineChoice({ ...spec, yesNo: true }, { appendLines: () => {} });
    expect(prompt.handleInputResult('invalid')).toBe('rejected');
    expect(prompt.handleInputResult('n')).toBe('accepted');
    await expect(prompt.promise).resolves.toEqual({ selected: ['continue'] });
  });

  test('separates prompt answer from a draft present when the prompt opened', () => {
    expect(splitInlineChoiceComposerInput('keep this draftn', 'keep this draft')).toEqual({
      answer: 'n', restoreText: 'keep this draft',
    });
    expect(splitInlineChoiceComposerInput(' y ', 'keep this draft')).toEqual({
      answer: 'y', restoreText: 'keep this draft',
    });
    expect(splitInlineChoiceComposerInput('2', 'keep this draft')).toEqual({
      answer: '2', restoreText: 'keep this draft',
    });
  });

  test('preserves edits to the draft instead of treating the whole edited draft as an answer', () => {
    expect(splitInlineChoiceComposerInput('keep this revised draft', 'keep this draft')).toEqual({
      answer: null, restoreText: 'keep this revised draft',
    });
    expect(splitInlineChoiceComposerInput('keep this revised draftn', 'keep this revised draft')).toEqual({
      answer: 'n', restoreText: 'keep this revised draft',
    });
  });

  test('cancels and records an unattended timeout instead of guessing', async () => {
    const outcomes: string[] = [];
    const cancelled = createInlineChoice(spec, {
      appendLines: () => {},
      observe: (event) => outcomes.push(event.outcome),
    });
    cancelled.cancel();
    expect(await cancelled.promise).toEqual({ selected: [], cancelled: true, reason: 'cancelled' });

    const timed = createInlineChoice({ ...spec, timeoutMs: 1 }, {
      appendLines: () => {},
      observe: (event) => outcomes.push(event.outcome),
    });
    expect(await timed.promise).toEqual({ selected: [], cancelled: true, reason: 'timeout' });
    expect(outcomes).toEqual(['cancelled', 'timeout']);
  });

  test('broker routes external text to exactly one active prompt and releases its slot', async () => {
    const lines: string[] = [];
    const broker = new InlineChoiceBroker({ appendLines: (next) => lines.push(...next) });
    const answer = broker.ask(spec);
    expect(broker.activeId).toBe('stop-confirm');
    expect(() => broker.ask({ ...spec, id: 'clarify' })).toThrow('another inline choice is already active');
    expect(broker.handleInput('2')).toBe(true);
    expect(await answer).toEqual({ selected: ['continue'] });
    await Promise.resolve();
    expect(broker.activeId).toBeNull();
    expect(broker.handleInput('1')).toBe(false);
    expect(lines).toEqual(formatInlineChoiceLines(spec));
  });

  test('streaming yes/no keys answer the active prompt without consuming ordinary text', async () => {
    const broker = new InlineChoiceBroker({ appendLines: () => {} });
    const answer = broker.ask({ ...spec, yesNo: true });
    expect(broker.handleStreamingKey('x')).toBe(false);
    expect(broker.handleStreamingKey({ name: 'y', ctrl: true })).toBe(false);
    expect(broker.handleStreamingKey({ name: 'y', alt: true })).toBe(false);
    expect(broker.handleStreamingKey({ name: 'y' })).toBe(true);
    await expect(answer).resolves.toEqual({ selected: ['stop'] });
    expect(broker.handleStreamingKey('n')).toBe(false);
  });
});
