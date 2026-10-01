import { describe, expect, test } from 'bun:test';
import { HarnessCliInputError } from '../harness/harness-cli-command.js';
import { CliUserError, formatCliUserError, isCliUserError } from './cli-user-error.js';

describe('CLI user errors', () => {
  test('formats a message with an optional hint', () => {
    expect(formatCliUserError(new CliUserError('이미 있는 칸: EV13', 'set <id> 로 고친다')))
      .toBe('❌ 이미 있는 칸: EV13\n  ↳ set <id> 로 고친다');
    expect(formatCliUserError(new CliUserError('칸 id 가 비었다'))).toBe('❌ 칸 id 가 비었다');
  });

  test('accepts existing harness errors without changing their output', () => {
    const err = new HarnessCliInputError('invalid PR number: nope');
    expect(isCliUserError(err)).toBe(true);
    if (isCliUserError(err)) expect(formatCliUserError(err)).toBe('❌ invalid PR number: nope');
  });

  test('recognizes a second module copy but not exceptions with only the same name', async () => {
    const copy = await import(`./cli-user-error.ts?copy=${Date.now()}`);
    const foreign = new copy.CliUserError('remote input');
    expect(foreign instanceof CliUserError).toBe(false);
    expect(foreign.name).toBe('CliUserError');
    expect(isCliUserError(foreign)).toBe(true);
    const harnessCopy = await import(`../harness/harness-cli-command.ts?copy=${Date.now()}`);
    const foreignHarness = new harnessCopy.HarnessCliInputError('remote harness input');
    expect(foreignHarness instanceof HarnessCliInputError).toBe(false);
    expect(isCliUserError(foreignHarness)).toBe(true);

    const lookalike = new Error('unexpected failure');
    lookalike.name = 'CliUserError';
    expect(isCliUserError(lookalike)).toBe(false);
    const fakeHarness = new Error('unexpected harness failure');
    fakeHarness.name = 'HarnessCliInputError';
    expect(isCliUserError(fakeHarness)).toBe(false);
    expect(isCliUserError({ name: 'CliUserError', message: 'plain object' })).toBe(false);
    expect(isCliUserError(null)).toBe(false);
  });
});
