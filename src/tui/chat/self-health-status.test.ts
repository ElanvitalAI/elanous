import { expect, test } from 'bun:test';
import { NextTuiSelfHealthTracker } from './self-health-status.js';

test('self health counts only this session recent structured errors and credit usage', () => {
  let now = 1_800_000_000_000;
  const tracker = new NextTuiSelfHealthTracker({
    now: () => now,
    runningRevision: () => 'a'.repeat(40),
    installedRevision: () => 'b'.repeat(40),
    loggingLive: () => true,
  });
  tracker.observe({ ts: new Date(now - 31 * 60_000).toISOString(), session_id: 'mine', category: 'llm.call', event: 'outcome-trace', data: { status: 503, provider: 'zai' } });
  tracker.observe({ ts: new Date(now - 1_000).toISOString(), session_id: 'other', category: 'llm.call', event: 'outcome-trace', data: { status: 401, provider: 'secret-provider' } });
  tracker.observe({ ts: new Date(now - 500).toISOString(), session_id: 'mine', category: 'llm.call', event: 'outcome-trace', data: { status: 429, provider: 'openrouter' } });
  tracker.observe({ ts: new Date(now - 250).toISOString(), session_id: 'mine', category: 'llm.usage', event: 'llm-usage', data: { billing: 'credit', billingProvider: 'openrouter', model: 'glm-5.3', site: 'review' } });

  const snapshot = tracker.snapshot('mine');
  expect(snapshot.errorCount).toBe(1);
  expect(snapshot.representativeError).toBe('openrouter HTTP 429');
  expect(snapshot.creditSource).toContain('openrouter/glm-5.3 · review · llm.usage billing=credit');
  expect(snapshot.line).toContain('설치본 bbbbbbb');
  expect(snapshot.line).not.toContain('secret-provider');
  expect(Object.isFrozen(snapshot)).toBe(true);
  now += 31 * 60_000;
  expect(tracker.snapshot('mine').errorCount).toBe(0);
  tracker.dispose();
});

test('self health reports unknown dimensions when observations are unavailable', () => {
  const tracker = new NextTuiSelfHealthTracker({ runningRevision: () => undefined, installedRevision: () => undefined, loggingLive: () => false });
  const snapshot = tracker.snapshot('session-123456');
  expect(snapshot.errorCount).toBeNull();
  expect(snapshot.creditKnown).toBe(false);
  expect(snapshot.line).toContain('오류 모름');
  expect(snapshot.line).toContain('크레딧 출처 모름');
  tracker.dispose();
});
