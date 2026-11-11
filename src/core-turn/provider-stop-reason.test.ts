import { expect, test } from 'bun:test';
import { coreStopReasonFromProvider } from './provider-stop-reason.js';

test('a second provider length stop remains visible as a bounded turn', () => {
  expect(coreStopReasonFromProvider(false, 'length')).toBe('max_turns');
  expect(coreStopReasonFromProvider(false, 'max_tokens')).toBe('max_turns');
  expect(coreStopReasonFromProvider(false, 'stop')).toBe('end_turn');
  expect(coreStopReasonFromProvider(true, 'length')).toBe('aborted');
});
