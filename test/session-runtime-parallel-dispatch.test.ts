// ── Parallel dispatch helper · Coding Pipeline P2 tests ──
//
// Unit tests the partitioner and the dispatch orchestrator
// independently of streamLLMWithTools. Register fake catalog entries
// so we don't depend on the shipped Grep/Read/Edit supportsParallel
// values (and thus don't break when real entries shift).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  isSafeForParallel,
  partitionByParallelSafety,
  dispatchWithParallelSafety,
} from '../src/session-runtime/parallel-dispatch.js';
import { nativeToolCatalog, type NativeToolCatalogEntry } from '../src/native-tool-catalog.js';

let savedLen = 0;

function pushFake(entry: Partial<NativeToolCatalogEntry> & { id: string; supportsParallel: boolean }): void {
  nativeToolCatalog.push({
    id: entry.id,
    kind: entry.kind ?? 'other',
    aliases: entry.aliases ?? [entry.id],
    displayName: entry.displayName ?? entry.id,
    description: entry.description ?? 'fake',
    promptSummary: entry.promptSummary ?? 'fake',
    surface: entry.surface ?? ['skill'],
    safety: entry.safety ?? ['read-only'],
    supportsParallel: entry.supportsParallel,
    defaultEnabled: true,
  });
}

beforeEach(() => {
  savedLen = nativeToolCatalog.length;
});

afterEach(() => {
  nativeToolCatalog.length = savedLen;
});

describe('isSafeForParallel', () => {
  test('returns true for catalog entry with supportsParallel=true', () => {
    pushFake({ id: 'fake_safe', aliases: ['FakeSafe', 'fake_safe'], displayName: 'FakeSafe', supportsParallel: true });
    expect(isSafeForParallel('FakeSafe')).toBe(true);
    expect(isSafeForParallel('fake_safe')).toBe(true);
  });

  test('returns false for supportsParallel=false', () => {
    pushFake({ id: 'fake_unsafe', aliases: ['FakeUnsafe'], displayName: 'FakeUnsafe', supportsParallel: false });
    expect(isSafeForParallel('FakeUnsafe')).toBe(false);
  });

  test('returns false for unknown tool (conservative default)', () => {
    expect(isSafeForParallel('Unknown_No_Catalog_Entry_XYZ')).toBe(false);
  });

  test('Agent is always sequential even if catalog marks it parallel', () => {
    // The real catalog may or may not flag Agent; the helper hard-
    // excludes it so the agent-batch path upstream stays authoritative.
    pushFake({ id: 'Agent', aliases: ['Agent'], displayName: 'Agent', supportsParallel: true });
    expect(isSafeForParallel('Agent')).toBe(false);
  });
});

describe('partitionByParallelSafety', () => {
  test('splits calls and preserves indices', () => {
    pushFake({ id: 'p_read', aliases: ['PRead'], displayName: 'PRead', supportsParallel: true });
    pushFake({ id: 'p_write', aliases: ['PWrite'], displayName: 'PWrite', supportsParallel: false });

    const calls = [
      { name: 'PRead', id: 'a' },
      { name: 'PWrite', id: 'b' },
      { name: 'PRead', id: 'c' },
    ];
    const { safe, unsafe } = partitionByParallelSafety(calls);
    expect(safe.map((x) => x.index)).toEqual([0, 2]);
    expect(unsafe.map((x) => x.index)).toEqual([1]);
    expect(safe[0]!.call.id).toBe('a');
    expect(unsafe[0]!.call.id).toBe('b');
  });

  test('all-unsafe batch yields empty safe group', () => {
    pushFake({ id: 'p_write2', aliases: ['PWrite2'], displayName: 'PWrite2', supportsParallel: false });
    const calls = [{ name: 'PWrite2', id: 'x' }];
    const { safe, unsafe } = partitionByParallelSafety(calls);
    expect(safe.length).toBe(0);
    expect(unsafe.length).toBe(1);
  });
});

describe('dispatchWithParallelSafety', () => {
  test('fires safe calls in parallel (kickoff overlap) when >=2 safe', async () => {
    pushFake({ id: 'slow_read', aliases: ['SlowRead'], displayName: 'SlowRead', supportsParallel: true });

    const calls = [
      { name: 'SlowRead', id: 'a' },
      { name: 'SlowRead', id: 'b' },
      { name: 'SlowRead', id: 'c' },
    ];
    const results: Array<{ id: string; startedAt: number; finishedAt: number }> = [];
    let t0 = 0;
    const dispatchOne = async (call: (typeof calls)[number], _index: number) => {
      const startedAt = Date.now() - t0;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const finishedAt = Date.now() - t0;
      results.push({ id: call.id, startedAt, finishedAt });
    };
    t0 = Date.now();
    const summary = await dispatchWithParallelSafety(calls, dispatchOne);
    const totalMs = Date.now() - t0;

    expect(summary.parallelActivated).toBe(true);
    expect(summary.safeCount).toBe(3);
    expect(summary.unsafeCount).toBe(0);
    // 3 parallel 30ms calls should finish in well under 90ms (would
    // be ~90ms sequential). Allow generous slack for CI jitter.
    expect(totalMs).toBeLessThan(80);
    // All three started within a small window (kickoff overlap).
    const starts = results.map((r) => r.startedAt).sort((a, b) => a - b);
    expect(starts[2]! - starts[0]!).toBeLessThan(15);
  });

  test('falls back to sequential when <2 safe calls', async () => {
    pushFake({ id: 'solo_read', aliases: ['SoloRead'], displayName: 'SoloRead', supportsParallel: true });
    pushFake({ id: 'solo_write', aliases: ['SoloWrite'], displayName: 'SoloWrite', supportsParallel: false });

    const calls = [
      { name: 'SoloWrite', id: 'a' },
      { name: 'SoloRead', id: 'b' },
    ];
    const order: string[] = [];
    const dispatchOne = async (call: (typeof calls)[number]) => {
      order.push(`start:${call.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${call.id}`);
    };
    const summary = await dispatchWithParallelSafety(calls, dispatchOne);
    expect(summary.parallelActivated).toBe(false);
    expect(summary.safeCount).toBe(1);
    expect(summary.unsafeCount).toBe(1);
    // Strict sequential order: start:a · end:a · start:b · end:b.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  test('mixed batch: safe group parallel, unsafe sequential after', async () => {
    pushFake({ id: 'mx_read', aliases: ['MxRead'], displayName: 'MxRead', supportsParallel: true });
    pushFake({ id: 'mx_write', aliases: ['MxWrite'], displayName: 'MxWrite', supportsParallel: false });

    const calls = [
      { name: 'MxRead', id: 'r1' },
      { name: 'MxWrite', id: 'w1' },
      { name: 'MxRead', id: 'r2' },
      { name: 'MxWrite', id: 'w2' },
    ];
    const order: string[] = [];
    const dispatchOne = async (call: (typeof calls)[number]) => {
      order.push(`start:${call.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${call.id}`);
    };
    const summary = await dispatchWithParallelSafety(calls, dispatchOne);
    expect(summary.parallelActivated).toBe(true);
    expect(summary.safeCount).toBe(2);
    expect(summary.unsafeCount).toBe(2);
    // First 4 events = reads start (parallel kickoff) + reads end;
    // then writes sequential in original order.
    expect(order.slice(0, 2)).toEqual(expect.arrayContaining(['start:r1', 'start:r2']));
    // Writes run strictly after reads and in original order.
    const w1Idx = order.indexOf('start:w1');
    const w2Idx = order.indexOf('start:w2');
    expect(w1Idx).toBeGreaterThan(-1);
    expect(w2Idx).toBeGreaterThan(w1Idx);
    expect(order.indexOf('end:w1')).toBeLessThan(w2Idx);
  });

  test('one failing safe call does not cancel siblings', async () => {
    pushFake({ id: 'flk_read', aliases: ['FlkRead'], displayName: 'FlkRead', supportsParallel: true });

    const calls = [
      { name: 'FlkRead', id: 'a' },
      { name: 'FlkRead', id: 'b' },
    ];
    const completed: string[] = [];
    const dispatchOne = async (call: (typeof calls)[number]) => {
      if (call.id === 'a') {
        // Caller is responsible for catching its own errors — helper
        // uses Promise.all, so an unhandled throw would reject. The
        // llm.ts callback wraps dispatch in try/catch. Test simulates
        // that wrapping.
        try {
          throw new Error('simulated');
        } catch {
          completed.push('err:a');
        }
      } else {
        completed.push('ok:b');
      }
    };
    await dispatchWithParallelSafety(calls, dispatchOne);
    expect(completed).toContain('err:a');
    expect(completed).toContain('ok:b');
  });

  test('empty batch is a no-op', async () => {
    const summary = await dispatchWithParallelSafety([], async () => {});
    expect(summary.safeCount).toBe(0);
    expect(summary.unsafeCount).toBe(0);
    expect(summary.parallelActivated).toBe(false);
  });

  test('writeback via index arg preserves result ordering', async () => {
    pushFake({ id: 'w_read', aliases: ['WRead'], displayName: 'WRead', supportsParallel: true });
    pushFake({ id: 'w_write', aliases: ['WWrite'], displayName: 'WWrite', supportsParallel: false });

    const calls = [
      { name: 'WRead', id: 'r1' },
      { name: 'WWrite', id: 'w1' },
      { name: 'WRead', id: 'r2' },
    ];
    const results: Array<string | null> = new Array(calls.length).fill(null);
    const dispatchOne = async (call: (typeof calls)[number], index: number) => {
      // Sleep in reverse order to prove order is preserved by index,
      // not by finish time.
      const delay = (calls.length - index) * 5;
      await new Promise((r) => setTimeout(r, delay));
      results[index] = call.id;
    };
    await dispatchWithParallelSafety(calls, dispatchOne);
    // Original order preserved via index writeback.
    expect(results).toEqual(['r1', 'w1', 'r2']);
  });

  // ⭐ TUI-ESC-ABORT-TOOLS (2026-10-15) — 턴 중단(Esc)이 묶음 안 «남은» 호출을 새로 시작하지 않는다.
  test('sequential batch: abort inside the first call skips the second and third', async () => {
    pushFake({ id: 'ab_write', aliases: ['AbWrite'], displayName: 'AbWrite', supportsParallel: false });
    const calls = [
      { name: 'AbWrite', id: 'a' },
      { name: 'AbWrite', id: 'b' },
      { name: 'AbWrite', id: 'c' },
    ];
    const controller = new AbortController();
    const called: string[] = [];
    const summary = await dispatchWithParallelSafety(calls, async (call) => {
      called.push(call.id);
      if (call.id === 'a') controller.abort();
    }, controller.signal);
    expect(called).toEqual(['a']);
    expect(summary.skippedIndices).toEqual([1, 2]);
  });

  test('mixed batch: abort during the safe group skips every unsafe call', async () => {
    pushFake({ id: 'ab_read', aliases: ['AbRead'], displayName: 'AbRead', supportsParallel: true });
    pushFake({ id: 'ab_write2', aliases: ['AbWrite2'], displayName: 'AbWrite2', supportsParallel: false });
    const calls = [
      { name: 'AbRead', id: 'r1' },
      { name: 'AbWrite2', id: 'w1' },
      { name: 'AbRead', id: 'r2' },
      { name: 'AbWrite2', id: 'w2' },
    ];
    const controller = new AbortController();
    const called: string[] = [];
    const summary = await dispatchWithParallelSafety(calls, async (call) => {
      called.push(call.id);
      if (call.id === 'r1') controller.abort();
    }, controller.signal);
    expect(summary.parallelActivated).toBe(true);
    expect(called.sort()).toEqual(['r1', 'r2']);
    expect(summary.skippedIndices).toEqual([1, 3]);
  });

  test('already-aborted signal dispatches nothing; caller can fill every slot (tool_call/tool_result pairing)', async () => {
    pushFake({ id: 'ab_read3', aliases: ['AbRead3'], displayName: 'AbRead3', supportsParallel: true });
    const calls = [
      { name: 'AbRead3', id: 'r1' },
      { name: 'AbRead3', id: 'r2' },
    ];
    const controller = new AbortController();
    controller.abort();
    const results: Array<string | null> = new Array(calls.length).fill(null);
    const summary = await dispatchWithParallelSafety(calls, async (call, index) => { results[index] = call.id; }, controller.signal);
    for (const i of summary.skippedIndices) results[i] = 'aborted';
    expect(results).toEqual(['aborted', 'aborted']);
  });

  test('no signal keeps skippedIndices empty (behaviour unchanged)', async () => {
    const summary = await dispatchWithParallelSafety([{ name: 'Whatever', id: 'x' }], async () => {});
    expect(summary.skippedIndices).toEqual([]);
  });
});
