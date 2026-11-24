/**
 * ELN-GLM-TOOL-EFFICIENCY(0.3.28) — 한 응답의 여러 tool_call 실행 순서·관측.
 *   ① 읽기 전용(카탈로그 supportsParallel) 호출은 겹쳐 돈다 · 쓰기는 하나씩 · 섞인 묶음은 결과 순서를 지킨다
 *   ② 한 호출이 던져도 형제 결과를 잃지 않는다
 *   ③ core.turn · dispatch-summary 의 구조 카운트(도구 수·겹친 수·재읽기) — 문자열 내용 0
 *   ④ 자리 모드에만 도구 묶음 지침이 실린다
 * ⛔ 벽시계 판정 없음(R-TST40) — 겹침은 deferred promise 로 증명한다. ⛔ mock.module 없음 — spyOn 만.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LLMMessage, StreamWithToolsHandlers } from '../llm.js';
import * as llmModule from '../llm.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { debug } from '../debug/log.js';
import { dispatchWithParallelSafety } from '../session-runtime/parallel-dispatch.js';
import { runCoreTurn } from './run-core-turn.js';
import { runGoalLoop } from './run-goal-loop.js';
import { SEAT_TOOL_BATCHING_GUIDELINE, SEAT_TURN_CAP_DEFAULTS } from './seat-turn-cap.js';
import { createToolBatchObserver } from './tool-batch-observation.js';
import type { CoreTurnContext, CoreTurnResult } from './types.js';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** 대기 중인 마이크로태스크·즉시 타이머를 모두 흘린다(시간을 재지 않는다). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Call = { name: string; id: string; args?: Record<string, unknown> };

describe('ELN-GLM-TOOL-EFFICIENCY — 한 응답의 여러 tool_call 실행기', () => {
  test('읽기 전용 호출은 겹쳐 돈다 — 둘 다 시작한 뒤에야 하나가 끝난다', async () => {
    const calls: Call[] = [{ name: 'Read', id: 'r1' }, { name: 'Grep', id: 'r2' }];
    const gates = new Map(calls.map((call) => [call.id, deferred()]));
    const started: string[] = [];
    const run = dispatchWithParallelSafety(calls, async (call) => {
      started.push(call.id);
      await gates.get(call.id)!.promise;
    });
    await flush();
    expect(started).toEqual(['r1', 'r2']);
    gates.get('r2')!.resolve();
    gates.get('r1')!.resolve();
    const summary = await run;
    expect(summary.parallelActivated).toBe(true);
  });

  test('쓰기는 하나씩 — 앞 쓰기가 끝나기 전에는 다음 쓰기를 시작하지 않는다', async () => {
    const calls: Call[] = [{ name: 'Edit', id: 'w1' }, { name: 'Write', id: 'w2' }];
    const gates = new Map(calls.map((call) => [call.id, deferred()]));
    const started: string[] = [];
    const run = dispatchWithParallelSafety(calls, async (call) => {
      started.push(call.id);
      await gates.get(call.id)!.promise;
    });
    await flush();
    expect(started).toEqual(['w1']);
    gates.get('w1')!.resolve();
    await flush();
    expect(started).toEqual(['w1', 'w2']);
    gates.get('w2')!.resolve();
    expect((await run).parallelActivated).toBe(false);
  });

  test('섞인 묶음 — 실행과 결과 모두 원래 호출 순서를 지킨다', async () => {
    const calls: Call[] = [
      { name: 'Read', id: 'r1' }, { name: 'Edit', id: 'w1' }, { name: 'Read', id: 'r2' }, { name: 'Edit', id: 'w2' },
    ];
    const gates = new Map(calls.map((call) => [call.id, deferred()]));
    const started: string[] = [];
    const results: Array<string | null> = calls.map(() => null);
    const run = dispatchWithParallelSafety(calls, async (call, index) => {
      started.push(call.id);
      await gates.get(call.id)!.promise;
      results[index] = `done:${call.id}`;
    });
    const expectedOrder = ['r1', 'w1', 'r2', 'w2'];
    const expectedStarted: string[] = [];
    for (const id of expectedOrder) {
      expectedStarted.push(id);
      await flush();
      expect(started).toEqual(expectedStarted);
      gates.get(id)!.resolve();
    }
    expect((await run).parallelActivated).toBe(false);
    expect(results).toEqual(['done:r1', 'done:w1', 'done:r2', 'done:w2']);
  });

  test('도구 하나가 실패해도 형제 결과를 잃지 않는다 — 오류 결과·던짐 둘 다', async () => {
    // (a) 도구 실패 = 오류 «결과»(llm.ts dispatchOne 이 잡아 넣는 꼴) — 형제는 정상 결과를 쓴다.
    const calls: Call[] = [{ name: 'Read', id: 'bad' }, { name: 'Read', id: 'ok' }];
    const results: unknown[] = calls.map(() => null);
    await dispatchWithParallelSafety(calls, async (call, index) => {
      results[index] = call.id === 'bad' ? { error: 'ENOENT' } : { ok: true };
    });
    expect(results).toEqual([{ error: 'ENOENT' }, { ok: true }]);

    // (b) 콜백 자체가 던진다(후처리 훅 등) — 안전 묶음은 형제가 결과를 쓸 때까지 끝나지 않는다.
    const parallel: Call[] = [{ name: 'Read', id: 'throws' }, { name: 'Read', id: 'slow' }];
    const slowGate = deferred();
    const started: string[] = [];
    const slots: Array<string | null> = parallel.map(() => null);
    let settled = false;
    const run = dispatchWithParallelSafety(parallel, async (call, index) => {
      started.push(call.id);
      if (call.id === 'throws') throw new Error('post-processing failed');
      if (call.id === 'slow') await slowGate.promise;
      slots[index] = call.id;
    }).finally(() => { settled = true; });
    const rejection = run.catch((error: unknown) => error);
    await flush();
    expect(settled).toBe(false);
    slowGate.resolve();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(slots).toEqual([null, 'slow']);
    expect(started).toEqual(['throws', 'slow']);
  });
});

describe('ELN-GLM-TOOL-EFFICIENCY — 재읽기 세기(구조 인자만)', () => {
  test('같은 대상의 두 번째 읽기만 센다 · 범위·도구가 달라도 같은 파일이면 재읽기 · root 가 다르면 다른 대상', () => {
    const observer = createToolBatchObserver();
    observer.start('Read', { file_path: '/repo/a.ts' })();
    observer.start('Read', { file_path: '/repo/a.ts', offset: 40 })();
    observer.start('read_file', { file_path: '/repo/a.ts' })();
    observer.start('Read', { file_path: '/repo/b.ts' })();
    // 도구가 달라도 같은 대상이면 재읽기다(리뷰 r1 — 도구 id 를 열쇠에 넣지 않는다).
    observer.start('ElanousFsRead', { path: '/repo/b.ts' })();
    observer.start('ElanousFsRead', { path: 'a.ts', root: 'cwd' })();
    observer.start('ElanousFsRead', { path: 'a.ts', root: 'obsidian' })();
    // 경로 없는 읽기는 대상 판정 불가 — 읽기로는 세되 재읽기로는 세지 않는다.
    observer.start('Read', {})();
    observer.start('Read', {})();
    // 카탈로그 kind 가 read 가 아닌 도구는 경로가 같아도 읽기가 아니다.
    observer.start('Grep', { path: '/repo/a.ts', pattern: 'x' })();
    observer.start('Edit', { file_path: '/repo/a.ts' })();
    const summary = observer.summary();
    expect(summary.readCount).toBe(9);
    expect(summary.repeatedReadCount).toBe(3);
    expect(summary.toolCount).toBe(11);
    expect(summary.parallelDispatchCount).toBe(0);
  });

  test('끝 알림은 한 번만 반영된다 · 겹친 호출은 서로를 겹친 것으로 센다', () => {
    const observer = createToolBatchObserver();
    const endA = observer.start('Read', { file_path: '/a' }, 0);
    const endB = observer.start('Read', { file_path: '/b' }, 0);
    endA();
    endA();
    const endC = observer.start('Edit', { file_path: '/a' }, 1);
    endB();
    endC();
    observer.start('Read', { file_path: '/c' }, 2)();
    const summary = observer.summary();
    expect(summary.parallelDispatchCount).toBe(3);
    expect(summary.maxConcurrentDispatches).toBe(2);
    expect(summary.toolRounds).toBe(3);
  });
});

describe('ELN-GLM-TOOL-EFFICIENCY — core.turn · dispatch-summary', () => {
  const tool: LLMToolSpec = { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
  let streamImpl: (handlers: StreamWithToolsHandlers, opts: Record<string, unknown>) => Promise<string> = async () => '';
  let records: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  let off: (() => void) | undefined;

  beforeEach(() => {
    records = [];
    off = debug.registerSink({
      name: 'tc-gte-dispatch-summary',
      emit: (record) => records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }),
    }) ?? undefined;
    spyOn(llmModule, 'streamLLMWithTools').mockImplementation((async (
      _messages: LLMMessage[], handlers: StreamWithToolsHandlers, opts?: Record<string, unknown>,
    ) => streamImpl(handlers, opts ?? {})) as typeof llmModule.streamLLMWithTools);
  });
  afterEach(() => {
    off?.();
    mock.restore();
  });

  const summaryOf = (sessionId: string) => records.find((record) => record.category === 'core.turn'
    && record.event === 'dispatch-summary' && record.data.sessionId === sessionId)?.data;

  test('GLM 꼴 한 응답 여러 tool_call — 도구 수·겹친 수·재읽기·공급자를 카운트로만 싣는다', async () => {
    const secretPath = '/tc-gte/secret-alpha.ts';
    const otherPath = '/tc-gte/secret-beta.ts';
    streamImpl = async (handlers, opts) => {
      (opts.onResolvedProvider as (provider: string, model: string) => void)('glm', 'glm-5.3');
      const round0: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'Read', args: { file_path: secretPath } },
        { name: 'Read', args: { file_path: secretPath } },
        { name: 'Read', args: { file_path: otherPath } },
      ];
      await dispatchWithParallelSafety(round0, async (call, index) => {
        await handlers.dispatchTool(call.name, call.args, { callId: `c0-${index}`, turnIndex: 0 });
      });
      await handlers.dispatchTool('Edit', { file_path: secretPath, old_string: 'a', new_string: 'b' }, { callId: 'c1-0', turnIndex: 1 });
      await handlers.dispatchTool('Read', { file_path: otherPath }, { callId: 'c1-1', turnIndex: 1 });
      return 'done';
    };
    await runCoreTurn({
      sessionId: 'tc-gte-summary',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [tool],
      dispatchTool: async () => { await flush(); return { ok: true }; },
      signal: new AbortController().signal,
    } as CoreTurnContext);

    const data = summaryOf('tc-gte-summary');
    expect(data).toMatchObject({
      dispatchCount: 5,
      toolCount: 5,
      parallelDispatchCount: 3,
      toolRounds: 2,
      readCount: 4,
      repeatedReadCount: 2,
      provider: 'glm',
      model: 'glm-5.3',
      aborted: false,
    });
    expect(data?.maxConcurrentDispatches).toBe(3);
    // 문자열 내용 0 — 식별 열쇠(세션·공급자·모델) 밖의 칸은 전부 수·참거짓이고, 경로·인자는 싣지 않는다.
    for (const [key, value] of Object.entries(data ?? {})) {
      if (key === 'sessionId' || key === 'provider' || key === 'model') continue;
      expect(['number', 'boolean']).toContain(typeof value);
    }
    expect(JSON.stringify(data)).not.toContain('secret-alpha');
    expect(JSON.stringify(data)).not.toContain('secret-beta');
  });

  test('중단(재기동 전 끊김)으로 끝난 턴도 요약을 한 번 낸다', async () => {
    const controller = new AbortController();
    streamImpl = async (handlers) => {
      await handlers.dispatchTool('Read', { file_path: '/tc-gte/a.ts' }, { callId: 'a', turnIndex: 0 });
      controller.abort();
      return '';
    };
    await runCoreTurn({
      sessionId: 'tc-gte-aborted',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [tool],
      dispatchTool: async () => ({ ok: true }),
      signal: controller.signal,
    } as CoreTurnContext);
    const summaries = records.filter((record) => record.event === 'dispatch-summary' && record.data.sessionId === 'tc-gte-aborted');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.data).toMatchObject({ toolCount: 1, readCount: 1, aborted: true });
  });

  test('스트림이 던져도 요약을 낸다 — 오류 출구', async () => {
    streamImpl = async (handlers) => {
      await handlers.dispatchTool('Read', { file_path: '/tc-gte/a.ts' }, { callId: 'a', turnIndex: 0 });
      throw new Error('provider exploded');
    };
    await runCoreTurn({
      sessionId: 'tc-gte-error',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [tool],
      dispatchTool: async () => ({ ok: true }),
      signal: new AbortController().signal,
    } as CoreTurnContext).catch(() => undefined);
    expect(summaryOf('tc-gte-error')).toMatchObject({ toolCount: 1, aborted: false });
  });
});

describe('ELN-GLM-TOOL-EFFICIENCY — 자리 모드 도구 묶음 지침', () => {
  async function firstTurnSystemMessages(seat: boolean): Promise<string[]> {
    let captured: LLMMessage[] = [];
    const ctx = {
      sessionId: `tc-gte-seat-${seat}`,
      messages: [{ role: 'user', content: 'OP: 다음 행 진행.' }],
      tools: [],
      dispatchTool: async () => ({ ok: true }),
      signal: new AbortController().signal,
    } as CoreTurnContext;
    await runGoalLoop(ctx, {
      changedFiles: () => [],
      controlSpaceId: null,
      intentStallProvider: null,
      attachLifecycleBridge: () => () => {},
      startLivenessHeartbeat: () => () => {},
      ...(seat ? { seatTurnCap: { seat: 'TC', ...SEAT_TURN_CAP_DEFAULTS } } : {}),
      runTurn: async (turnCtx) => {
        if (captured.length === 0) captured = [...turnCtx.messages];
        turnCtx.callbacks?.onTurnComplete?.([{
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'g1', name: 'update_goal', input: { status: 'complete', evidence: '확인 완료' } }],
        }]);
        return { stopReason: 'end_turn', finalText: '완료' } satisfies CoreTurnResult;
      },
    });
    return captured.filter((message) => message.role === 'system').map((message) => String(message.content));
  }

  test('자리 모드면 지침이 목표 계약 바로 뒤에 실리고, 사람 대화 goal loop 에는 없다', async () => {
    const seatSystems = await firstTurnSystemMessages(true);
    expect(seatSystems[1]).toBe(SEAT_TOOL_BATCHING_GUIDELINE);
    const humanSystems = await firstTurnSystemMessages(false);
    expect(humanSystems).not.toContain(SEAT_TOOL_BATCHING_GUIDELINE);
  });
});
