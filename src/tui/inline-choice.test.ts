import { describe, expect, test } from 'bun:test';
import { createInlineChoice, formatInlineChoiceLines, InlineChoiceBroker } from './inline-choice.js';

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
});
