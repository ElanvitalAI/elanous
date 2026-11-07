// Verifies the MSS M2.1 wire-up of src/debug/log.ts — proves:
//   1. API signature is unchanged (ts / category / event / data)
//   2. MSS fields (trace_id / span_id / parent_span_id / elanous_id) are
//      appended *only* when MSS_ENABLED + a live trace scope exists
//   3. MSS_ENABLED=false reproduces pre-MSS shape exactly (PLAN §11.4)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { debug, type DebugEvent } from '../../../src/debug/log.js';
import { __resetFlagsForTests } from '../../../src/mss/feature-flags.js';
import {
  __resetIdentityForTests,
  __setIdentityFileForTests,
} from '../../../src/mss/identity-store.js';
import { startTurnTrace, withSpan } from '../../../src/mss/trace-context.js';

function mostRecentEvent(): DebugEvent | undefined {
  const events = debug.events(1);
  return events[events.length - 1];
}

describe('src/debug/log — MSS M2.1 backward-compat integration', () => {
  let dir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mss-log-int-'));
    __setIdentityFileForTests(join(dir, 'identity.json'));
    __resetIdentityForTests();
    for (const k of ['MSS_ENABLED']) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    __resetFlagsForTests();
    // Force a quiet-but-live sink so debug.log() actually records.
    debug.setLevel('diag');
    debug.clear();
  });

  afterEach(() => {
    debug.setLevel('trail');
    debug.clear();
    __setIdentityFileForTests(null);
    __resetIdentityForTests();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetFlagsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test('legacy API shape — ts/category/event/data preserved', () => {
    debug.log('pfc.classify', 'dispatch', { domain: 'coding', consumed: true });
    const ev = mostRecentEvent()!;
    expect(ev.category).toBe('pfc.classify');
    expect(ev.event).toBe('dispatch');
    expect(ev.data).toEqual({ domain: 'coding', consumed: true });
    expect(typeof ev.ts).toBe('string');
  });

  test('outside any trace scope → no trace_id/span_id appended', () => {
    debug.log('pfc.classify', 'orphan');
    const ev = mostRecentEvent()!;
    expect(ev.trace_id).toBeUndefined();
    expect(ev.span_id).toBeUndefined();
    expect(ev.parent_span_id).toBeUndefined();
  });

  test('inside withTraceContext → trace_id + span_id + elanous_id stamped', () => {
    startTurnTrace(() => {
      debug.log('pfc.classify', 'in-turn');
      const ev = mostRecentEvent()!;
      expect(ev.trace_id).toHaveLength(26);
      expect(ev.span_id).toHaveLength(26);
      expect(ev.elanous_id).toHaveLength(26);
    });
  });

  test('withSpan child → parent_span_id points at parent', () => {
    startTurnTrace(() => {
      withSpan(() => {
        debug.log('pfc.classify', 'child');
        const ev = mostRecentEvent()!;
        expect(ev.trace_id).toHaveLength(26);
        expect(ev.parent_span_id).toHaveLength(26);
        expect(ev.parent_span_id).not.toBe(ev.span_id);
      });
    });
  });

  test('MSS_ENABLED=false — pre-MSS shape reproduced exactly', () => {
    process.env.MSS_ENABLED = 'false';
    __resetFlagsForTests();
    startTurnTrace(() => {
      debug.log('pfc.classify', 'off');
      const ev = mostRecentEvent()!;
      expect(ev.trace_id).toBeUndefined();
      expect(ev.span_id).toBeUndefined();
      expect(ev.elanous_id).toBeUndefined();
      expect(ev.category).toBe('pfc.classify');
      expect(ev.event).toBe('off');
    });
  });

  test('JSONL output contains enriched fields when MSS_ENABLED=true', () => {
    startTurnTrace(() => {
      debug.log('mss.smoke', 'jsonl-check', { value: 42 });
      // ring-buffer event reflects the same shape the file sink writes
      const ev = mostRecentEvent()!;
      const line = JSON.stringify(ev);
      expect(line).toContain('"trace_id"');
      expect(line).toContain('"elanous_id"');
      // legacy fields unchanged
      expect(line).toContain('"category":"mss.smoke"');
      expect(line).toContain('"event":"jsonl-check"');
      expect(line).toContain('"value":42');
    });
  });

  test('enrichment never overrides an explicit category', () => {
    debug.log('custom.explicit.name', 'x');
    const ev = mostRecentEvent()!;
    expect(ev.category).toBe('custom.explicit.name');
  });

  test('enrichment survives three distinct call sites in one turn', () => {
    startTurnTrace(() => {
      debug.log('a.one', '1');
      debug.log('a.two', '2');
      debug.log('a.three', '3');
      const evs = debug.events(3);
      const ids = new Set(evs.map(e => e.trace_id));
      expect(ids.size).toBe(1); // same turn → same trace_id
      for (const e of evs) expect(e.elanous_id).toHaveLength(26);
    });
  });
});
