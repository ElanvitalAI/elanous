import { describe, expect, test } from 'bun:test';
import {
  DISPATCH_SHADOW_COMPARE_ENV,
  parseDispatchShadowCompareContext,
  recordDispatchShadowCompareFromEnv,
} from './dispatch-shadow-compare.js';

const context = {
  requestId: 'request-42',
  cellId: 'ENTRANCE-DISPATCH-SHADOW',
  tickId: 'tick-20261031-0100',
  snapshotHash: 'a'.repeat(64),
  dispatcherAction: 'launch',
  dispatcherReason: 'highest-priority eligible card',
  loopShadowAction: 'launch',
  loopShadowReason: 'same eligible card',
  policyVersion: 'entrance-shadow-v1',
  runId: 'run-42',
};

describe('dispatch shadow comparison', () => {
  test('accepts the bounded dispatcher handoff and emits one joined harness event', () => {
    const raw = JSON.stringify(context);
    const parsed = parseDispatchShadowCompareContext(raw);
    expect(parsed).toEqual(context);

    const events: Array<{ category: string; event: string; data: unknown }> = [];
    recordDispatchShadowCompareFromEnv(raw, {
      entrance: 'cli-harness-say',
      productEntryAction: 'queue',
      productEntryReason: 'graph-intake-queue',
    }, (category, event, data) => events.push({ category, event, data }));

    expect(events).toEqual([{
      category: 'harness',
      event: 'dispatch.shadow.compare',
      data: {
        ...context,
        entrance: 'cli-harness-say',
        productEntryAction: 'queue',
        productEntryReason: 'graph-intake-queue',
        agreement: true,
      },
    }]);
  });

  test('ignores malformed, oversized, and incomplete optional context', () => {
    expect(parseDispatchShadowCompareContext(undefined)).toBeUndefined();
    expect(parseDispatchShadowCompareContext('{')).toBeUndefined();
    expect(parseDispatchShadowCompareContext(JSON.stringify({ ...context, snapshotHash: 'short' }))).toBeUndefined();
    expect(parseDispatchShadowCompareContext(JSON.stringify({ ...context, runId: undefined }))).toBeUndefined();
    expect(parseDispatchShadowCompareContext('x'.repeat(2049))).toBeUndefined();

    const events: unknown[] = [];
    recordDispatchShadowCompareFromEnv(JSON.stringify({ ...context, runId: undefined }), {
      entrance: 'cli-harness-ask', productEntryAction: 'launch-gate', productEntryReason: 'graph-intake-launch-gate',
    }, (_category, _event, data) => events.push(data));
    expect(events).toEqual([]);
    expect(DISPATCH_SHADOW_COMPARE_ENV).toBe('ELANOUS_DISPATCH_SHADOW_COMPARE');
  });

  test('logging failure does not escape into launch routing', () => {
    expect(() => recordDispatchShadowCompareFromEnv(JSON.stringify(context), {
      entrance: 'cli-harness-ask', productEntryAction: 'launch-gate', productEntryReason: 'graph-intake-launch-gate',
    }, () => { throw new Error('log sink unavailable'); })).not.toThrow();
  });
});
