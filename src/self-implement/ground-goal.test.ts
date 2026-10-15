import { describe, expect, test } from 'bun:test';
import { debug, getAmbientSessionId } from '../debug/log.js';
import { groundGoalInCodebase } from './ground-goal.js';

describe('groundGoalInCodebase', () => {
  test('persistent 루프가 검증 후보를 내면 export 심볼명과 성공 관측을 남긴다', async () => {
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    const seenCwds: (string | undefined)[] = [];
    const cwd = process.cwd();
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const block = await groundGoalInCodebase('persistent', {
        cwd,
        persistent: {
          runGoalLoop: async (ctx) => {
            await ctx.dispatchTool('Read', { file_path: 'src/self-implement/ground-goal.ts' }, { callId: 'read', sessionId: ctx.sessionId, signal: ctx.signal });
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/self-implement/ground-goal.ts: verified' } });
            return { finalText: '', iterations: 2, stopReason: 'goal_complete', goalComplete: true };
          },
        },
        extractExportedSymbols: (path, _max, seenCwd) => {
          seenCwds.push(seenCwd);
          return path === 'src/self-implement/ground-goal.ts' ? ['Found'] : [];
        },
      });
      expect(seenCwds).toEqual([cwd]);
      expect(block).toBe([
        '## Codebase grounding (existing files + exported symbols)',
        '- src/self-implement/ground-goal.ts: Found',
        'Read-file-referencing completion evidence (preserved verbatim):',
        '- src/self-implement/ground-goal.ts: verified',
      ].join('\n'));
      const completed = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'completed');
      expect(completed).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          cwd,
          candidatesFound: 1,
          candidatesIncluded: 1,
          symbolsAttached: 1,
          evidenceLinesEmitted: 1,
        }),
      }));
      const data = completed?.data as Record<string, unknown>;
      for (const field of ['totalElapsedMs', 'persistentElapsedMs', 'renderingElapsedMs']) {
        expect(data[field]).toEqual(expect.any(Number));
        expect(data[field]).toBeGreaterThanOrEqual(0);
      }
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('persistent 루프가 후보를 못 내면 빈 grounding을 내고 one-shot 검색은 호출하지 않는다', async () => {
    expect(await groundGoalInCodebase('missing', {
      cwd: '/wt',
      persistent: { runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false }) },
    })).toBe('');
  });

  test('재시도 미완료는 상위 grounding empty 관측에도 별도 사유로 남는다', async () => {
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    let attempts = 0;
    try {
      expect(await groundGoalInCodebase('unread candidate', {
        cwd: process.cwd(),
        persistent: { runGoalLoop: async (ctx) => {
          attempts += 1;
          if (attempts === 1) {
            ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: {
              status: 'complete', evidence: 'src/self-implement/ground-goal.ts: found by Glob',
            } });
            return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
          }
          return { finalText: 'done', iterations: 1, stopReason: 'end_turn', goalComplete: false };
        } },
      })).toBe('');
      expect(attempts).toBe(2);
      expect(logs).toContainEqual(expect.objectContaining({ category: 'grounding.persistent', event: 'empty',
        data: expect.objectContaining({ reason: 'no-candidates', persistentStopReason: 'evidence_retry_incomplete' }) }));
    } finally { (debug as { log: typeof debug.log }).log = original; }
  });

  test('심볼 추출 예외도 fail-soft로 빈 grounding을 반환한다', async () => {
    expect(await groundGoalInCodebase('broken symbols', {
      cwd: '/wt',
      persistent: {
        runGoalLoop: async (ctx) => {
          ctx.callbacks?.onToolCall?.({ id: 'done', name: 'update_goal', args: { status: 'complete', evidence: 'src/found.ts: verified' } });
          return { finalText: '', iterations: 1, stopReason: 'goal_complete', goalComplete: true };
        },
      },
      extractExportedSymbols: () => { throw new Error('cannot read candidate'); },
    })).toBe('');
  });

  test('문자열화할 수 없는 예외도 fail-soft로 빈 grounding을 반환한다', async () => {
    await expect(groundGoalInCodebase('unprintable failure', {
      cwd: '/wt',
      persistent: { runGoalLoop: async () => { throw Object.create(null); } },
    })).resolves.toBe('');
  });

  test('runtime ambient scope와 persistent 관측이 하나의 생성 session ID로 조인된다', async () => {
    const original = debug.log.bind(debug) as typeof debug.log;
    const logs: { category: string; event: string; data: unknown }[] = [];
    let ambientSessionId = '';
    let loopSessionId = '';
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      await groundGoalInCodebase('session join', {
        cwd: process.cwd(),
        persistent: {
          runGoalLoop: async (ctx) => {
            ambientSessionId = getAmbientSessionId() ?? '';
            loopSessionId = ctx.sessionId;
            return { finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false };
          },
        },
      });
      const finished = logs.find((log) => log.category === 'grounding.persistent' && log.event === 'finished');
      expect(ambientSessionId).toMatch(/^grounding-/);
      expect(loopSessionId).toBe(ambientSessionId);
      expect(finished).toEqual(expect.objectContaining({
        data: expect.objectContaining({ sessionId: ambientSessionId }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('관측기와 시계가 실패해도 모든 분기가 fail-soft로 빈 grounding을 반환한다', async () => {
    const originalLog = debug.log.bind(debug) as typeof debug.log;
    const originalNow = performance.now;
    const throwingLog = (() => { throw new Error('log unavailable'); }) as typeof debug.log;
    const throwingNow = () => { throw new Error('clock unavailable'); };
    (debug as { log: typeof debug.log }).log = throwingLog;
    try {
      expect(await groundGoalInCodebase('disabled', { cwd: '/wt', persistent: false })).toBe('');
      expect(await groundGoalInCodebase('empty', {
        cwd: '/wt',
        persistent: { runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false }) },
      })).toBe('');
      expect(await groundGoalInCodebase('error', {
        cwd: '/wt',
        persistent: { runGoalLoop: async () => { throw new Error('persistent unavailable'); } },
      })).toBe('');
      performance.now = throwingNow;
      expect(await groundGoalInCodebase('clock failure', {
        cwd: '/wt',
        persistent: { runGoalLoop: async () => ({ finalText: '', iterations: 1, stopReason: 'max_iterations', goalComplete: false }) },
      })).toBe('');
    } finally {
      performance.now = originalNow;
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('persistent false만 루프를 끄는 스위치다', async () => {
    expect(await groundGoalInCodebase('disabled', { cwd: '/wt', persistent: false })).toBe('');
  });
});
