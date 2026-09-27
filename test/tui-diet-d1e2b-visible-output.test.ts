import { describe, expect, test } from 'bun:test';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../src/dashboard/slash-runtime/index.js';

const registry = buildDashboardSlashRegistry();

function makeCtx() {
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const helpModals: Array<{ title: string; lines: readonly string[] }> = [];
  const helpCalls: string[] = [];
  const ctx = {
    chatLines,
    attachmentRowMap: { clear() {} },
    clearLogSearch() {},
    clearLogFilter() {},
    pushDebugLine(line: string) { debugLines.push(line); },
    pushChatLine(line: string) { chatLines.push(line); },
    setChatScrollOffset(_offset: number) {},
    muted: (line: string) => line,
    accent: (line: string) => line,
    success: (line: string) => line,
    warning: (line: string) => line,
    undo: { bold: (line: string) => line },
    showHelp: async (scope: string) => { helpCalls.push(scope); },
    showHelpModal: (options: { title: string; lines: readonly string[] }) => { helpModals.push(options); },
    contextSlash: { renderContextList: () => ['  /context', '  (empty)'] },
  } as unknown as DashboardSlashContext;
  return { ctx, chatLines, debugLines, helpModals, helpCalls };
}

describe('essential slash output', () => {
  const commands: Array<[string, string[], string]> = [
    ['pause', [], '/pause:'], ['context', [], '/context'], ['debug', ['status'], 'debug:'],
    ['undo', ['list'], '/undo:'], ['api-allow', ['list'], 'api-allow:'],
    ['resume-turn', ['list'], '/resume:'], ['plan', ['status'], 'plan mode:'],
    ['code-edit', ['status'], 'code-edit policy:'], ['wd', [], 'session working dir:'],
    ['clear', [], 'Status cleared'],
  ];
  for (const [name, args, expectedText] of commands) {
    test(`/${name} ${args.join(' ')} writes user-visible output`, async () => {
      const { ctx, chatLines } = makeCtx();
      expect(chatLines).toHaveLength(0);
      expect((await registry.dispatch(name, args, ctx)).kind).toBe('continue');
      expect(chatLines.length).toBeGreaterThan(0);
      expect(chatLines.some(line => line.includes(expectedText))).toBe(true);
    });
  }
  test('/context preserves the returned attachment rows, not just a generic status', async () => {
    const { ctx, chatLines } = makeCtx();
    ctx.contextSlash.renderContextList = () => ['  /context', '  attachment.txt  3 KB'];
    await registry.dispatch('context', [], ctx);
    expect(chatLines).toContain('  attachment.txt  3 KB');
  });
  test('/context with no rows still explains the empty result', async () => {
    const { ctx, chatLines } = makeCtx();
    ctx.contextSlash.renderContextList = () => [];
    await registry.dispatch('context', [], ctx);
    expect(chatLines).toEqual(['  /context: (없음)']);
  });
  test('/plan enter is not a plan-start alias', async () => {
    const { ctx, chatLines, debugLines } = makeCtx();
    expect((await registry.dispatch('plan', ['enter'], ctx)).kind).toBe('continue');
    expect(chatLines).toHaveLength(0);
    expect(debugLines).toEqual(['  usage: /plan [status | start [title] | done | show]']);
  });
  test('/help opens a modal and does not call blocking showHelp', async () => {
    const { ctx, helpModals, helpCalls } = makeCtx();
    expect((await registry.dispatch('help', [], ctx)).kind).toBe('continue');
    expect(helpModals).toHaveLength(1);
    expect(helpModals[0]!.lines.length).toBeGreaterThan(0);
    expect(helpModals[0]!.lines.some(line => line.includes('/help'))).toBe(true);
    expect(helpModals[0]!.lines.some(line => line.includes('Press any key to close'))).toBe(false);
    expect(helpCalls).toHaveLength(0);
  });
  test('/help without a modal host remains visible without waiting for a key', async () => {
    const { ctx, chatLines, helpCalls } = makeCtx();
    ctx.showHelpModal = undefined;
    expect((await registry.dispatch('help', [], ctx)).kind).toBe('continue');
    expect(chatLines.length).toBeGreaterThan(0);
    expect(helpCalls).toHaveLength(0);
  });
});
