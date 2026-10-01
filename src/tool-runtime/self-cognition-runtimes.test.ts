import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoreTools, CORE_TOOL_SPECS } from '../domains/core-tools.js';
import { openSurfaceEventsDb, recordEvent } from '../domains/surface-events.js';
import {
  SELF_COGNITION_MCP_CATALOG_ENTRIES,
  SELF_COGNITION_RUNTIMES,
  SELF_COGNITION_TOOL_NAMES,
  runBudgetedRecall,
} from './self-cognition-runtimes.js';

describe('self-cognition runtimes', () => {
  test('derives runtime specs and MCP metadata from the authoritative name ledger', () => {
    expect(SELF_COGNITION_RUNTIMES.map(runtime => runtime.id)).toEqual([...SELF_COGNITION_TOOL_NAMES]);
    expect(SELF_COGNITION_MCP_CATALOG_ENTRIES.map(entry => entry.id)).toEqual([...SELF_COGNITION_TOOL_NAMES]);
    expect(SELF_COGNITION_RUNTIMES.map(runtime => runtime.spec.name)).toEqual([...SELF_COGNITION_TOOL_NAMES]);
    expect(SELF_COGNITION_TOOL_NAMES.every(name => CORE_TOOL_SPECS.some(spec => spec.name === name))).toBe(true);
  });

  test('exposes only read-only parallel-safe MCP entries', () => {
    for (const entry of SELF_COGNITION_MCP_CATALOG_ENTRIES) {
      expect(entry.host).toEqual(['mcp']);
      expect(entry.safety).toEqual(['read-only']);
      expect(entry.supportsParallel).toBe(true);
    }
  });

  test('retains existing recall fields and adds only the optional time budget', () => {
    const memory = CORE_TOOL_SPECS.find(spec => spec.name === 'memory_recall')!;
    const self = CORE_TOOL_SPECS.find(spec => spec.name === 'self_recall')!;
    expect(Object.keys(memory.parameters.properties!)).toEqual([
      'query', 'direction', 'kind', 'category', 'domain', 'sinceHours', 'limit', 'restoreId', 'timeBudgetMs',
    ]);
    expect(Object.keys(self.parameters.properties!)).toEqual(['query', 'sinceHours', 'limit', 'timeBudgetMs']);
    expect(memory.parameters.required).toEqual([]);
    expect(self.parameters.required).toEqual([]);
  });

  test('slow recall emits one progress line then returns captured hits at the budget', async () => {
    const lines: string[] = [];
    let report!: (value: Record<string, unknown>) => void;
    const answer = runBudgetedRecall('memory_recall', { query: '어제 부탁한 일', timeBudgetMs: 60 }, {
      surface: 'mcp', sessionId: 'session', toolCallId: 'call',
      emitFeedback: env => {
        expect(env.kind).toBe('tool.progress');
        if (env.kind === 'tool.progress') lines.push(...env.payload.lines);
        expect(env.parentToolCallId).toBe('call');
      },
    }, onPartial => {
      report = onPartial;
      return new Promise(() => {});
    }, undefined, 10);
    report({ hits: [{ text: '찾은 일' }], count: 1 });
    const result = await answer;
    expect(lines).toEqual(['기억을 찾는 중 — 어제 부탁한 일']);
    expect(result).toMatchObject({ hits: [{ text: '찾은 일' }], count: 1, partial: true });
    expect((result as Record<string, unknown>).note).toBe('(찾던 중 0.06초에서 멈췄습니다 — 더 찾을까요?)');
  });

  test('default progress fires at 10 seconds and budget keeps the 60-second note', async () => {
    const scheduled = new Map<number, () => void>();
    const lines: string[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      scheduled.set(ms, callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const answer = runBudgetedRecall('memory_recall', {}, {
        surface: 'mcp', emitFeedback: env => lines.push(...env.asciiFallback),
      }, onPartial => {
        onPartial({ hits: [{ text: '찾은 일' }], count: 1 });
        return new Promise(() => {});
      });
      expect(scheduled.has(10_000)).toBe(true);
      expect(lines).toEqual([]);
      scheduled.get(10_000)!();
      expect(lines).toEqual(['기억을 찾는 중 — 최근 발송·대화']);
      expect(scheduled.has(60_000)).toBe(true);
      scheduled.get(60_000)!();
      expect(await answer).toMatchObject({
        hits: [{ text: '찾은 일' }], count: 1, partial: true,
        note: '(찾던 중 60초에서 멈췄습니다 — 더 찾을까요?)',
      });
    } finally {
      timer.mockRestore();
    }
  });

  test('out-of-range budget uses the supported timer limit in both timer and partial note', async () => {
    const scheduled = new Map<number, () => void>();
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      scheduled.set(ms, callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const answer = runBudgetedRecall('memory_recall', { timeBudgetMs: 2_147_483_648 },
        { surface: 'mcp' }, onPartial => {
          onPartial({ hits: [{ text: '찾은 일' }], count: 1 });
          return new Promise(() => {});
        });
      expect(scheduled.has(2_147_483_648)).toBe(false);
      expect(scheduled.has(2_147_483_647)).toBe(true);
      scheduled.get(2_147_483_647)!();
      expect(await answer).toMatchObject({
        hits: [{ text: '찾은 일' }], count: 1, partial: true,
        note: '(찾던 중 2147483.647초에서 멈췄습니다 — 더 찾을까요?)',
      });
    } finally {
      timer.mockRestore();
    }
  });

  test('fast search keeps its original result and sends no progress', async () => {
    const lines: string[] = [];
    const original = { events: [{ summary: 'done' }], count: 1, docs: null, note: 'unchanged' };
    const result = await runBudgetedRecall('self_recall', { timeBudgetMs: 60 }, {
      surface: 'mcp', emitFeedback: env => lines.push(...env.asciiFallback),
    }, async () => original, undefined, 10);
    expect(result).toEqual(original);
    expect(lines).toEqual([]);
  });

  test('shared dispatch budgets both recall tools and preserves their staged hits', async () => {
    for (const name of ['memory_recall', 'self_recall'] as const) {
      const partial = name === 'memory_recall'
        ? { hits: [{ text: '찾은 일' }], count: 1 }
        : { events: [{ summary: '구현' }], count: 1, docs: null };
      const lines: string[] = [];
      const stages: Record<string, unknown>[] = [];
      let reportLate!: (value: Record<string, unknown>) => void;
      const core = buildCoreTools(async (_name, _args, report) => {
        reportLate = report;
        report(partial);
        return new Promise(() => {});
      });
      const result = await core.dispatch(name, { query: '어제 부탁한 일', timeBudgetMs: 30 },
        stage => stages.push(stage), { surface: 'mcp', emitFeedback: env => lines.push(...env.asciiFallback) }) as Record<string, unknown>;
      expect(stages).toEqual([partial]);
      expect(result).toMatchObject({ ...partial, partial: true, note: '(찾던 중 0.03초에서 멈췄습니다 — 더 찾을까요?)' });
      reportLate({ count: 10 });
      expect(stages).toEqual([partial]);
      expect(lines).toEqual([]);
    }
  });

  test('shared dispatch returns a seeded memory from the real worker', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'self-cognition-worker-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    try {
      process.env.ELANOUS_STATE_DIR = stateDir;
      const db = openSurfaceEventsDb();
      try {
        recordEvent(db, { surface: 'telegram', direction: 'inbound', kind: 'qna',
          text: 'worker-seeded-unique-recall yesterday request', domain: 'general' });
      } finally {
        db.close();
      }
      const result = await buildCoreTools().dispatch('memory_recall', {
        query: 'worker-seeded-unique-recall', timeBudgetMs: 10_000,
      }) as Record<string, unknown>;
      expect(result).toMatchObject({ count: 1, hits: [{ text: 'worker-seeded-unique-recall yesterday request' }] });
      expect(result.error).toBeUndefined();
      expect(result.partial).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('shared dispatch emits progress after ten seconds for a slow recall', async () => {
    const scheduled = new Map<number, () => void>();
    const lines: string[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      scheduled.set(ms, callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const core = buildCoreTools(async (_name, _args, report) => {
        report({ hits: [{ text: '찾은 일' }], count: 1 });
        return new Promise(() => {});
      });
      const answer = core.dispatch('memory_recall', {}, undefined,
        { surface: 'mcp', emitFeedback: env => lines.push(...env.asciiFallback) });
      expect(lines).toEqual([]);
      scheduled.get(10_000)!();
      expect(lines).toEqual(['기억을 찾는 중 — 최근 발송·대화']);
      scheduled.get(60_000)!();
      expect(await answer).toMatchObject({ partial: true, hits: [{ text: '찾은 일' }] });
    } finally {
      timer.mockRestore();
    }
  });

  test('shared dispatch fast searches return their original shapes for both recall tools', async () => {
    for (const name of ['memory_recall', 'self_recall'] as const) {
      const original = name === 'memory_recall'
        ? { hits: [{ text: '기억' }], count: 1, note: '원본' }
        : { events: [{ summary: '구현' }], count: 1, docs: null, note: '원본' };
      const lines: string[] = [];
      const core = buildCoreTools(async () => original);
      const result = await core.dispatch(name, {}, undefined,
        { surface: 'mcp', emitFeedback: env => lines.push(...env.asciiFallback) });
      expect(result).toEqual(original);
      expect(lines).toEqual([]);
    }
  });

  test('self recall returns episode-stage events if document search exceeds its budget', async () => {
    const result = await runBudgetedRecall('self_recall', { timeBudgetMs: 15 }, { surface: 'mcp' },
      onPartial => {
        onPartial({ events: [{ summary: '구현' }], count: 1, docs: null });
        return new Promise(() => {});
      }, undefined, 5);
    expect(result).toMatchObject({ events: [{ summary: '구현' }], count: 1, docs: null, partial: true,
      note: '(찾던 중 0.015초에서 멈췄습니다 — 더 찾을까요?)' });
  });
});
