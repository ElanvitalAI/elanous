import { describe, expect, test } from 'bun:test';
import { StreamNoProgressError, isTurnProgressEvent, resolveTurnNoProgressMs } from './turn-progress.js';

describe('ELN-TURN-STALL-WATCHDOG progress definition', () => {
  test.each([
    ['text with one character', { type: 'text', delta: 'a' }, true],
    ['empty text delta', { type: 'text', delta: '' }, false],
    ['tool call', { type: 'tool_call' }, true],
    ['image', { type: 'image' }, true],
    ['reasoning delta', { type: 'reasoning', delta: 'thinking…' }, false],
    ['usage', { type: 'usage' }, false],
    ['finish', { type: 'finish' }, false],
    ['text phase', { type: 'text_phase' }, false],
  ] as const)('%s → %p', (_name, event, expected) => {
    expect(isTurnProgressEvent(event)).toBe(expected);
  });

  test('limit: call option, then config, then 600000 ms; non-positive values are ignored', () => {
    expect(resolveTurnNoProgressMs(1_234, 5_678)).toEqual({ ms: 1_234, source: 'call' });
    expect(resolveTurnNoProgressMs(undefined, 5_678)).toEqual({ ms: 5_678, source: 'config' });
    expect(resolveTurnNoProgressMs(0, -1)).toEqual({ ms: 600_000, source: 'default' });
    expect(resolveTurnNoProgressMs(undefined, undefined)).toEqual({ ms: 600_000, source: 'default' });
  });

  test('the abort reason is a timeout the fallback classifier can route, with both durations', () => {
    const err = new StreamNoProgressError(600_000, 600_250);
    expect(err.code).toBe('ETIMEDOUT');
    expect(err.message).toBe('stream no progress: no output for 600250ms (limit 600000ms)');
  });
});
