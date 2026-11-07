import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __resetFlagsForTests } from '../../src/mss/feature-flags.js';
import { __resetIdentityForTests, __setIdentityFileForTests } from '../../src/mss/identity-store.js';
import { enrichLogRecord } from '../../src/mss/log-enrich.js';
import { startTurnTrace, withSpan } from '../../src/mss/trace-context.js';

describe('mss log-enrich', () => {
  let dir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mss-enrich-'));
    __setIdentityFileForTests(join(dir, 'identity.json'));
    __resetIdentityForTests();
    for (const k of ['MSS_ENABLED']) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    __resetFlagsForTests();
  });

  afterEach(() => {
    __setIdentityFileForTests(null);
    __resetIdentityForTests();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetFlagsForTests();
  });

  test('no trace scope → basic record without trace_id but with elanous_id', () => {
    const rec = enrichLogRecord({ event: 'boot', filePath: 'src/mss/foo.ts' });
    expect(rec.category).toBe('mss.foo');
    expect(rec.event).toBe('boot');
    expect(rec.pid).toBe(process.pid);
    expect(rec.elanous_id).toBeDefined();
    expect(rec.trace_id).toBeUndefined();
    expect(typeof rec.ts).toBe('string');
  });

  test('inside trace scope → trace_id + span_id stamped', () => {
    startTurnTrace(() => {
      const rec = enrichLogRecord({
        event: 'classify',
        filePath: 'src/conductor/classify.ts',
        line: 42,
        fnName: 'classify',
        fields: { domain: 'coding' },
      });
      expect(rec.category).toBe('pfc.classify');
      expect(rec.trace_id).toHaveLength(26);
      expect(rec.span_id).toHaveLength(26);
      expect(rec.parent_span_id).toBeUndefined();
      expect(rec.fields).toEqual({ domain: 'coding' });
      expect(rec.source).toEqual({ file: 'src/conductor/classify.ts', line: 42, fn: 'classify' });
    });
  });

  test('child span stamps parent_span_id', () => {
    startTurnTrace(() => {
      withSpan(() => {
        const rec = enrichLogRecord({ event: 'child', filePath: 'src/mss/x.ts' });
        expect(rec.trace_id).toBeDefined();
        expect(rec.parent_span_id).toBeDefined();
        expect(rec.parent_span_id).not.toBe(rec.span_id);
      });
    });
  });

  test('MSS_ENABLED=false → trace/elanous fields suppressed but shape intact', () => {
    process.env.MSS_ENABLED = 'false';
    __resetFlagsForTests();
    startTurnTrace(() => {
      const rec = enrichLogRecord({ event: 'off', filePath: 'src/mss/x.ts' });
      expect(rec.event).toBe('off');
      expect(rec.category).toBe('mss.x');
      expect(rec.trace_id).toBeUndefined();
      expect(rec.elanous_id).toBeUndefined();
    });
  });

  test('explicit category overrides inference', () => {
    const rec = enrichLogRecord({ category: 'custom.namespace.thing', event: 'hit' });
    expect(rec.category).toBe('custom.namespace.thing');
  });

  test('no filePath and no category → unknown.anonymous', () => {
    const rec = enrichLogRecord({ event: 'orphan' });
    expect(rec.category).toBe('unknown.anonymous');
  });

  test('empty fields not attached to record', () => {
    const rec = enrichLogRecord({ event: 'nofields', filePath: 'src/mss/x.ts', fields: {} });
    expect(rec.fields).toBeUndefined();
  });
});
