// llmDecomposeSteps — 하니스 LLM decompose(TaskGenerator 순수 재사용) 테스트 (H2)

import { describe, test, expect } from 'bun:test';
import { llmDecomposeSteps } from './llm-decompose.js';
import type { DecomposeCallable } from '../task-orchestrator/generator.js';
import { debug } from '../debug/log.js';

/** 유효 proposal JSON 반환 fake callable. */
const validProposal = JSON.stringify({
  tasks: [
    { index: 0, title: '스키마 정의', surface: { kind: 'llm-direct', prompt: 'a' } },
    { index: 1, title: '핸들러 구현', surface: { kind: 'llm-direct', prompt: 'b' } },
    { index: 2, title: '테스트 추가', surface: { kind: 'llm-direct', prompt: 'c' } },
  ],
  rationale: '세 단계로 나눠 스키마→구현→테스트 순으로 진행.',
});

describe('llmDecomposeSteps', () => {
  test('유효 proposal → 스텝 제목 배열과 완료 관측', async () => {
    const original = debug.log;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const callable: DecomposeCallable = async () => ({ text: validProposal });
      const steps = await llmDecomposeSteps('로그인 기능 추가', callable);
      expect(steps).toEqual(['스키마 정의', '핸들러 구현', '테스트 추가']);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'harness.llm-decompose',
        event: 'completed',
        data: expect.objectContaining({ inputLength: '로그인 기능 추가'.length, taskCount: 3, failed: false }),
      }));
      expect(logs[0]?.data.durationMs).toEqual(expect.any(Number));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('passes the generator rationale to the optional observer without changing titles or failure behavior', async () => {
    const callable: DecomposeCallable = async () => ({ text: validProposal });
    const rationales: string[] = [];
    expect(await llmDecomposeSteps('로그인 기능 추가', callable, { onRationale: (reason) => rationales.push(reason) }))
      .toEqual(['스키마 정의', '핸들러 구현', '테스트 추가']);
    expect(rationales).toEqual(['세 단계로 나눠 스키마→구현→테스트 순으로 진행.']);
    expect(await llmDecomposeSteps('로그인 기능 추가', callable, { onRationale: () => { throw new Error('observer down'); } }))
      .toEqual(['스키마 정의', '핸들러 구현', '테스트 추가']);
    expect(await llmDecomposeSteps('로그인 기능 추가', async () => ({ text: 'invalid' }), { onRationale: (reason) => rationales.push(reason) }))
      .toEqual([]);
    expect(rationales).toHaveLength(1);
  });

  test('garbage(파싱 실패·2라운드) → [] (fail-soft)', async () => {
    const callable: DecomposeCallable = async () => ({ text: '이건 JSON 이 아님' });
    const steps = await llmDecomposeSteps('뭔가 해줘', callable);
    expect(steps).toEqual([]);
  });

  test('callable throw → [] (fail-soft) 및 실패 관측', async () => {
    const original = debug.log;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const callable: DecomposeCallable = async () => { throw new Error('LLM down'); };
      expect(await llmDecomposeSteps('x', callable)).toEqual([]);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'harness.llm-decompose',
        event: 'completed',
        data: expect.objectContaining({ inputLength: 1, taskCount: 0, failed: true, error: 'LLM down' }),
      }));
      expect(logs[0]?.data.durationMs).toEqual(expect.any(Number));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('hostile throw 값도 []로 흡수하고 안전한 실패 관측을 남긴다', async () => {
    const original = debug.log;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    const hostileError = {
      get message(): never { throw new Error('message getter must not escape'); },
      toString(): never { throw new Error('toString must not escape'); },
    };
    try {
      const callable: DecomposeCallable = async () => { throw hostileError; };
      expect(await llmDecomposeSteps('x', callable)).toEqual([]);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'harness.llm-decompose',
        event: 'completed',
        data: expect.objectContaining({ failed: true, error: 'error reason unavailable' }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('관측 실패는 성공 반환과 fail-soft 실패 반환을 바꾸지 않는다', async () => {
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = (() => { throw new Error('log unavailable'); }) as typeof debug.log;
    try {
      const callable: DecomposeCallable = async () => ({ text: validProposal });
      await expect(llmDecomposeSteps('로그인 기능 추가', callable)).resolves.toEqual(['스키마 정의', '핸들러 구현', '테스트 추가']);
      const failingCallable: DecomposeCallable = async () => { throw new Error('LLM down'); };
      await expect(llmDecomposeSteps('x', failingCallable)).resolves.toEqual([]);
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });

  test('빈 objective → [] (callable 미호출)', async () => {
    let called = false;
    const callable: DecomposeCallable = async () => { called = true; return { text: validProposal }; };
    expect(await llmDecomposeSteps('   ', callable)).toEqual([]);
    expect(called).toBe(false);
  });

  test('context(grounding) 를 프롬프트에 전달', async () => {
    let seenPrompt = '';
    const callable: DecomposeCallable = async (inp) => { seenPrompt = inp.prompt; return { text: validProposal }; };
    await llmDecomposeSteps('기능 추가', callable, { context: 'GROUND_MARKER_XYZ' });
    expect(seenPrompt).toContain('GROUND_MARKER_XYZ');
  });

  test('명시한 goal-author coarse 프로필을 TaskGenerator 프롬프트와 완료 관측에 전달한다', async () => {
    const original = debug.log;
    const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const seenPrompts: string[] = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      logs.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      const callable: DecomposeCallable = async (inp) => { seenPrompts.push(inp.prompt); return { text: validProposal }; };
      await llmDecomposeSteps('기능 추가', callable, { promptProfile: 'goal-author-coarse' });
      await llmDecomposeSteps('기능 추가', callable);
      expect(seenPrompts[0]).toContain('Goal-author coarse slicing');
      const observations = logs.filter((log) => log.category === 'harness.llm-decompose' && log.event === 'completed');
      expect(observations).toHaveLength(2);
      expect(observations[0]?.data).toEqual(expect.objectContaining({ promptProfile: 'goal-author-coarse' }));
      expect(observations[1]?.data).not.toHaveProperty('promptProfile');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
    }
  });
});
