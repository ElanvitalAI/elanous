import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { LogRecord } from '../mss/logging/record.js';
import { observeModelInputTokens } from './model-input-observation.js';

describe('observeModelInputTokens', () => {
  test('records a measured harness node and a measured loop tick with distinct identities', () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'model-input-observation-test',
      emit(record) { if (record.category === 'harness.model-input') records.push(record); },
    });
    try {
      expect(observeModelInputTokens({ scope: 'harness-node', nodeKind: 'review', runId: 'run-1', nodeId: 'node-1' }, 183)).toEqual({
        scope: 'harness-node', nodeKind: 'review', runId: 'run-1', nodeId: 'node-1',
        status: 'measured', inputTokens: 183,
      });
      expect(observeModelInputTokens({ scope: 'loop-tick', nodeKind: 'research', runId: 'run-1', tickId: 'tick-1' }, 0)).toEqual({
        scope: 'loop-tick', nodeKind: 'research', runId: 'run-1', tickId: 'tick-1',
        status: 'measured', inputTokens: 0,
      });
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ category: 'harness.model-input', event: 'recorded', data: {
        scope: 'harness-node', nodeKind: 'review', runId: 'run-1', nodeId: 'node-1',
        status: 'measured', inputTokens: 183,
      } });
      expect(records[1]).toMatchObject({ category: 'harness.model-input', event: 'recorded', data: {
        scope: 'loop-tick', nodeKind: 'research', runId: 'run-1', tickId: 'tick-1',
        status: 'measured', inputTokens: 0,
      } });
    } finally {
      off();
    }
  });

  test('missing usage is logged unmeasured rather than a measured zero in both scopes', () => {
    const records: LogRecord[] = [];
    const off = debug.registerSink({
      name: 'model-input-unmeasured-test',
      emit(record) { if (record.category === 'harness.model-input') records.push(record); },
    });
    try {
      for (const scope of ['harness-node', 'loop-tick'] as const) {
        for (const unavailable of [undefined, null]) {
          const record = observeModelInputTokens({ scope, nodeKind: 'plan' }, unavailable);
          expect(record).toEqual({ scope, nodeKind: 'plan', status: 'unmeasured', inputTokens: null, reason: 'usage-unavailable' });
          expect(JSON.parse(JSON.stringify(record))).toEqual(record);
        }
      }
      expect(records).toHaveLength(4);
      for (const record of records) {
        expect(record).toMatchObject({ category: 'harness.model-input', event: 'recorded', data: {
          nodeKind: 'plan', status: 'unmeasured', inputTokens: null, reason: 'usage-unavailable',
        } });
      }
    } finally {
      off();
    }
  });

  test('non-count numbers cannot enter a token baseline as measurements', () => {
    for (const invalid of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(observeModelInputTokens({ scope: 'harness-node', nodeKind: 'execute' }, invalid)).toEqual({
        scope: 'harness-node', nodeKind: 'execute', status: 'unmeasured', inputTokens: null, reason: 'invalid-usage',
      });
    }
  });
});
