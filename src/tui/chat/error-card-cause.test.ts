import { expect, test } from 'bun:test';
import { classifyTurnFailure, nextTuiErrorCard } from './error-card.js';
import { turnReplyFailureMessage } from '../core/next-public-reply.js';

test('failure causes read as classes, never as raw error text', () => {
  const cases: Array<[string, string]> = [
    ['HTTP 429 rate limit exceeded for key sk-SECRET123456', 'Rate limit exceeded'],
    ['upstream returned 503 Service Unavailable', 'Provider server error'],
    ['stream idle timeout after 90s', 'timed out'],
    ['read ECONNRESET', 'Response stream was cut'],
    ['fetch failed: getaddrinfo ENOTFOUND api.example.com', 'Network connection failed'],
    ['401 Unauthorized', 'Authentication was denied'],
  ];
  for (const [raw, expected] of cases) expect(classifyTurnFailure(raw)).toContain(expected);
  expect(classifyTurnFailure('something odd')).toBeNull();
  expect(classifyTurnFailure(undefined)).toBeNull();
});

test('the public failure message keeps its prefix, adds the cause class, and hides the raw text', () => {
  const message = turnReplyFailureMessage('t1', true, undefined, 'HTTP 429 rate limit key sk-SECRET123456')!;
  expect(message.startsWith('요청을 처리하지 못했습니다.')).toBe(true);
  expect(message).toContain('Rate limit exceeded');
  expect(message).not.toContain('sk-SECRET');
  expect(turnReplyFailureMessage('t1', true, undefined, 'odd')).toBe('요청을 처리하지 못했습니다.');
  expect(turnReplyFailureMessage('t1', false, undefined, 'x')).toBeNull();
  expect(nextTuiErrorCard(message)[0]).toContain('✘ 요청을 처리하지 못했습니다. (');
});
