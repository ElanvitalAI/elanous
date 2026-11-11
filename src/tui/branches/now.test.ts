import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { runNextTuiNowBranchRoute } from './now.js';

test('/now and its fixed phrase use the shared context query and source-labelled TUI renderer', async () => {
  expect(resolveNextTuiRoute('/now', NEXT_TUI_INPUT_CONTEXT)?.branchModule).toBe('./branches/now.js');
  expect(resolveNextTuiRoute('지금 상황', NEXT_TUI_INPUT_CONTEXT)?.id).toBe('now');
  expect(resolveNextTuiRoute('/context', NEXT_TUI_INPUT_CONTEXT)?.branchModule).toBe('./branches/context.js');
  expect(resolveNextTuiRoute('/app check', NEXT_TUI_INPUT_CONTEXT)?.branchModule).toBe('./branches/app/index.js');
  const chatLines: string[] = [];
  const topics: string[] = [];
  const host = { chatLines, setChatScrollOffset: () => {} };
  const query = async ({ topic }: { topic: string }) => {
    topics.push(topic);
    return { at: '2026-11-10T00:00:00.000Z', topic, facts: [{ kind: 'version' as const, version: '0.3.8', source: 'elanous://release/0.3.8' }], events: [], guide: [] };
  };
  await runNextTuiNowBranchRoute('/now 발행', host, query);
  await runNextTuiNowBranchRoute('지금 상황', host, query);
  expect(topics).toEqual(['발행', '발행', '', '']);
  expect(chatLines.join('\n')).toContain('원장');
  expect(chatLines.join('\n')).toContain('0.3.8');
  await runNextTuiNowBranchRoute('/now', host, async () => { throw new Error('unavailable'); });
  expect(chatLines.at(-1)).toBe('현재 맥락 조회 실패 · /now 다시 시도');
});

test('/now shows a fast section while a slow source reaches its deadline', async () => {
  const chatLines: string[] = [];
  const updates: string[] = [];
  let firstUpdate!: () => void;
  const firstPaint = new Promise<void>(resolve => { firstUpdate = resolve; });
  let slowSignal: AbortSignal | undefined;
  const query = ({ section, signal }: { section: 'core' | 'operations'; signal?: AbortSignal }) => {
    if (section === 'core') {
      slowSignal = signal;
      return new Promise<import('../../context-bus/context-now.js').ContextNowAnswer>(() => {});
    }
    return Promise.resolve({ at: '2026-11-10T00:00:00.000Z', topic: null,
      facts: [{ kind: 'run' as const, goal: 'active', phase: 'review', elapsed: '2분', source: 'run://one' }], events: [], guide: [] });
  };
  const pending = runNextTuiNowBranchRoute('/now', {
    chatLines, setChatScrollOffset: () => {}, onUpdate: () => { updates.push(chatLines.join('\n')); firstUpdate(); },
  }, query, 30);
  await firstPaint;
  expect(updates[0]).toContain('active');
  expect(updates[0]).not.toContain('시간 상한');
  await pending;
  expect(slowSignal?.aborted).toBe(true);
  expect(chatLines.join('\n')).toContain('기본 현황 시간 상한 도달');
  expect(chatLines.join('\n')).toContain('run://one');
});

test('/now cancellation leaves the slow query result out of the visible transcript', async () => {
  const chatLines: string[] = [];
  const abort = new AbortController();
  let finishQuery!: (answer: import('../../context-bus/context-now.js').ContextNowAnswer) => void;
  const query = () => new Promise<import('../../context-bus/context-now.js').ContextNowAnswer>((resolve) => { finishQuery = resolve; });
  const pending = runNextTuiNowBranchRoute('/now', { chatLines, setChatScrollOffset: () => {}, signal: abort.signal }, query);
  abort.abort();
  await pending;
  expect(chatLines).toEqual(['현재 맥락 조회 취소됨']);
  finishQuery({ at: '2026-11-10T00:00:00.000Z', topic: null, facts: [], events: [], guide: [] });
  await Promise.resolve();
  expect(chatLines).toEqual(['현재 맥락 조회 취소됨']);
});

test('/now forwards each cancellation to its query', async () => {
  const chatLines: string[] = [];
  const active = new Set<AbortSignal>();
  for (const topic of ['one', 'two', 'three']) {
    const abort = new AbortController();
    const pending = runNextTuiNowBranchRoute(`/now ${topic}`, { chatLines, setChatScrollOffset: () => {}, signal: abort.signal },
      ({ signal }) => new Promise((_, reject) => {
        expect(signal).toBe(abort.signal);
        active.add(signal!);
        signal!.addEventListener('abort', () => { active.delete(signal!); reject(new Error('worker stopped')); }, { once: true });
      }));
    abort.abort();
    await pending;
    expect(active.size).toBe(0); // Source: #36701 cancellation acceptance, no active query remains
  }
  expect(chatLines).toEqual(['현재 맥락 조회 취소됨', '현재 맥락 조회 취소됨', '현재 맥락 조회 취소됨']);
});
