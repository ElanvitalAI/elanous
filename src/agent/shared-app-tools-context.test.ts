import { afterEach, expect, spyOn, test } from 'bun:test';
import * as coreModule from '../domains/core-tools.js';
import { buildSharedAppTools } from './shared-app-tools.js';

// B5 리뷰 3라운드 must-fix — 봇 경로의 공용 dispatch 가 런타임 문맥(emitFeedback·세션·호출 id)을 코어 도구까지 넘긴다.
afterEach(() => { (coreModule.buildCoreTools as unknown as { mockRestore?: () => void }).mockRestore?.(); });

test('shared dispatch forwards the runtime context to core tools (memory_recall progress line can reach the chat)', async () => {
  const seen: unknown[] = [];
  spyOn(coreModule, 'buildCoreTools').mockReturnValue({
    specs: [{ name: 'memory_recall', description: 'x', parameters: { type: 'object', properties: {} } }] as never,
    names: new Set(['memory_recall']),
    dispatch: async (_name: string, _args: Record<string, unknown>, _onPartial?: unknown, context?: unknown) => { seen.push(context); return { ok: true }; },
  } as never);
  const shared = buildSharedAppTools();
  const emitFeedback = () => {};
  await shared.dispatch('memory_recall', { query: '어제' }, { surface: 'tui', sessionId: 's-1', toolCallId: 'c-1', emitFeedback });
  expect(seen).toEqual([{ surface: 'tui', sessionId: 's-1', toolCallId: 'c-1', emitFeedback }]);
});
