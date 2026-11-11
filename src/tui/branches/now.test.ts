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
  expect(topics).toEqual(['발행', '']);
  expect(chatLines.join('\n')).toContain('원장');
  expect(chatLines.join('\n')).toContain('0.3.8');
  await runNextTuiNowBranchRoute('/now', host, async () => { throw new Error('unavailable'); });
  expect(chatLines.at(-1)).toBe('현재 맥락 조회 실패 · /now 다시 시도');
});
