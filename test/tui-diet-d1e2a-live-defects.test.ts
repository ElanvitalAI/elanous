import { describe, expect, test, spyOn } from 'bun:test';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../src/dashboard/slash-runtime/dashboard-handlers.js';
import { HookDispatcher } from '../src/plugin-hooks/dispatcher.js';
import { buildAndonTurnHook } from '../src/cft/andon-turn-hook.js';
import { createPickerState } from '../src/chat/pickers/state.js';
import { SLASH_COMMANDS } from '../src/chat/index.js';
import { resolveDashboardChatMainSlashCommand } from '../src/dashboard/input/chat-main-slash-command.js';
import { createLogSearchModal } from '../src/log-pane/search-modal.js';
import { createDashboardLogSearchOpener } from '../src/dashboard/index.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import { debug } from '../src/debug/log.js';
import { createSearchModal } from '../src/chat/search/modal.js';
import { parseAcpSlash } from '../src/dashboard/chat/acp-chat.js';
import type { DashboardAcpChat } from '../src/dashboard/chat/acp-chat.js';
import { createTurnStreamFormatter, type TurnStreamFormatterDeps } from '../src/dashboard/turn-stream-formatter.js';
import type { Key } from '../src/tui.js';

const identity = (s: string): string => s;
const missingModal = "ModalLifecycle: no modal type registered as 'background-tasks-popup'";

function backgroundContext(options: { modal?: () => never; rows?: unknown[]; textOnly?: boolean } = {}) {
  const chatLines: string[] = [];
  let scrollOffset = 0;
  const ctx = {
    chatLines,
    pushChatLine: (line: string) => chatLines.push(line),
    pushDebugLine: (_line: string) => { throw new Error('background task output must be visible in chat'); },
    muted: identity,
    warning: identity,
    setChatScrollOffset: (offset: number) => { scrollOffset = offset; },
    widgetHost: { get: () => ({ state: { rows: options.rows ?? [] } }) },
    backgroundTasksTextOnly: options.textOnly ?? false,
    ...(options.modal ? { widgetModalPopup: { open: options.modal } } : {}),
  } as unknown as DashboardSlashContext;
  return { ctx, chatLines, scrollOffset: () => scrollOffset };
}

describe('TUI D1e-2a live defects', () => {
  test('streaming tool progress uses singular for one call and plural for subsequent calls', () => {
    const progress: string[] = [];
    const deps: TurnStreamFormatterDeps = {
      emit: () => {},
      thinking: { update: label => progress.push(label), updateMetrics: () => {} },
      termCols: () => 80,
      wrapOpts: {},
      formatResponse: () => [],
      text: identity,
      muted: identity,
      ptyCallLine: () => null,
      ptyResultLine: () => null,
      renderToolCallEvent: () => [],
      renderToolResultVariants: () => null,
      toolRendering: {},
      brainIcon: '🧠',
    };
    const formatter = createTurnStreamFormatter(deps);
    formatter.onToolCall({ id: 'first', name: 'Read', args: {} });
    formatter.onToolCall({ id: 'second', name: 'Read', args: {} });
    expect(progress).toEqual(['Streaming Read (1 tool)', 'Streaming Read (2 tools)']);
  });

  test('/bg survives an unregistered modal lifecycle type with one visible line', async () => {
    const { ctx, chatLines, scrollOffset } = backgroundContext({ modal: () => { throw new Error(missingModal); } });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await buildDashboardSlashRegistry().dispatch('bg', [], ctx);
      expect(log).toHaveBeenCalledWith('dashboard.slash', 'modal-type-missing', { type: 'background-tasks-popup' });
    } finally {
      log.mockRestore();
    }
    expect(chatLines).toEqual(['  배경 작업 창을 열 수 없습니다']);
    expect(scrollOffset()).toBe(-1);
  });

  test('/bg retains a working popup and does not swallow unrelated modal errors', async () => {
    const working = backgroundContext({ modal: (() => ({ dispose() {} })) as () => never });
    await buildDashboardSlashRegistry().dispatch('bg', [], working.ctx);
    expect(working.chatLines).toEqual([]);
    expect(working.scrollOffset()).toBe(-1);

    const unrelated = backgroundContext({ modal: () => { throw new Error('popup initialization failed'); } });
    await expect(buildDashboardSlashRegistry().dispatch('bg', [], unrelated.ctx))
      .rejects.toThrow('popup initialization failed');
    expect(unrelated.chatLines).toEqual([]);
  });

  test('essential /bg bypasses the popup and lists tasks in chat', async () => {
    let opened = 0;
    const { ctx, chatLines } = backgroundContext({ textOnly: true, modal: () => { opened++; throw new Error(missingModal); } });
    await buildDashboardSlashRegistry().dispatch('bg', [], ctx);
    expect(opened).toBe(0);
    expect(chatLines).toEqual(['  /bg: no active background tasks.']);
  });

  test('/bg text fallback lists background tasks in the chat log', async () => {
    const { ctx, chatLines } = backgroundContext({ rows: [
      { id: 'job-1', source: 'agent', status: 'running', label: 'research', detail: 'reading', elapsedMs: 3000 },
    ] });
    await buildDashboardSlashRegistry().dispatch('bg', [], ctx);
    expect(chatLines).toEqual([
      '  /bg: 1 active background task',
      '  agent · running · research  reading · 3s',
    ]);
  });

  test('Esc and Enter dismiss log search while Enter confirms a selected result', () => {
    const jumps: string[] = [];
    const cancels: string[] = [];
    const makeModal = () => createLogSearchModal({
      linesGetter: () => ['research status'], termCols: 100, termRows: 40, anchorRow: 10, anchorCol: 20,
      onJump: (_result, query) => jumps.push(query), onCancel: (query) => cancels.push(query),
    });
    const esc = makeModal();
    esc.handleKey({ name: 'escape' } as Key);
    expect(esc.isDisposed()).toBe(true);
    expect(cancels).toEqual(['']);
    const enter = makeModal();
    enter.handleKey({ name: 'r' } as Key);
    enter.handleKey({ name: 'enter' } as Key);
    expect(enter.isDisposed()).toBe(true);
    expect(jumps).toEqual(['r']);
  });

  test('dashboard log search opener removes the actual modal on Esc and Enter', () => {
    const display = new DisplayCoordinator({ frameMs: 100_000 });
    const cancels: string[] = [];
    const jumps: string[] = [];
    const openLogSearchModal = createDashboardLogSearchOpener({
      display: () => display,
      linesGetter: () => ['research status'],
      initialQuery: () => '',
      termSize: () => ({ cols: 100, rows: 40 }),
      computePaneH: () => 8,
      currentThemeTokens: () => DEFAULT_THEME_TOKENS,
      currentWorkspaceOwnerId: () => 'dashboard-main',
      draw: () => {},
      onJump: (_result, query) => jumps.push(query),
      onCancel: query => cancels.push(query),
    });
    const send = (name: string) => display.routeKey({ name } as Parameters<DisplayCoordinator['routeKey']>[0]);
    openLogSearchModal();
    const escId = display.modalStack().at(-1);
    expect(escId).toStartWith('log-search:');
    expect(send('escape').type).toBe('consumed');
    expect(display.modalStack()).not.toContain(escId);
    expect(cancels).toEqual(['']);

    openLogSearchModal();
    const alternateEscId = display.modalStack().at(-1);
    expect(send('esc').type).toBe('consumed');
    expect(display.modalStack()).not.toContain(alternateEscId);
    expect(cancels).toEqual(['', '']);

    openLogSearchModal();
    const ctrlGId = display.modalStack().at(-1);
    expect(display.routeKey({ name: 'g', ctrl: true } as Parameters<DisplayCoordinator['routeKey']>[0]).type).toBe('consumed');
    expect(display.modalStack()).not.toContain(ctrlGId);
    expect(cancels).toEqual(['', '', '']);

    openLogSearchModal();
    const enterId = display.modalStack().at(-1);
    expect(send('r').type).toBe('consumed');
    expect(send('enter').type).toBe('consumed');
    expect(display.modalStack()).not.toContain(enterId);
    expect(jumps).toEqual(['r']);

    openLogSearchModal();
    const emptyId = display.modalStack().at(-1);
    expect(send('enter').type).toBe('consumed');
    expect(display.modalStack()).not.toContain(emptyId);
    expect(cancels).toEqual(['', '', '', '']);
  });

  test('search modal Esc cancels even with no selectable results', () => {
    let cancelled = 0;
    const modal = createSearchModal({
      id: 'empty-search', bounds: { row: 1, col: 1, width: 48, height: 8 },
      title: 'Search', width: 48, maxVisible: 4, onQuery: () => [],
      onAccept: () => { throw new Error('no result'); }, onCancel: () => { cancelled++; },
    });
    expect(modal.surface.onKey?.({ name: 'esc' } as Key)).toBe('consumed');
    expect(cancelled).toBe(1);
    expect(modal.surface.onKey?.({ name: 'escape' } as Key)).toBe('consumed');
    expect(cancelled).toBe(2);
    expect(modal.surface.onKey?.({ name: 'g', ctrl: true } as Key)).toBe('consumed');
    expect(cancelled).toBe(3);
    expect(modal.surface.onKey?.({ name: 'enter' } as Key)).toBe('consumed');
    expect(cancelled).toBe(4);
  });

  test('slash Enter keeps typed unknown name, but arrow-selected choice can replace it', async () => {
    const picker = createPickerState({ commands: SLASH_COMMANDS });
    const buf = { lines: ['/g'], lineIdx: 0, colIdx: 2 };
    await picker.refresh(buf);
    const direct = await picker.dispatch({ name: 'enter' } as Key, buf);
    expect(direct).toEqual({ consumed: true, action: { kind: 'submit', text: '/g' } });
    const registry = buildDashboardSlashRegistry();
    expect(resolveDashboardChatMainSlashCommand('/g').cmdLower).toBe('g');
    expect(await registry.dispatch('g', [], {} as DashboardSlashContext)).toEqual({ kind: 'unregistered' });
    expect(registry.has('gemini')).toBe(true);
    await picker.dispatch({ name: 'down' } as Key, buf);
    const selected = await picker.dispatch({ name: 'enter' } as Key, buf);
    expect(selected).toEqual({ consumed: true, action: { kind: 'submit', text: '/' + picker.slashFiltered(buf)[picker.selectedIdx()]!.name } });
    expect(resolveDashboardChatMainSlashCommand('/goal').cmdLower).toBe('goal');
    expect(resolveDashboardChatMainSlashCommand('/ask').cmdLower).toBe('ask');
    expect(resolveDashboardChatMainSlashCommand('/clipboard').cmdLower).toBe('clipboard');
    for (const typed of ['/goal', '/ask', '/clipboard']) {
      const entry = { lines: [typed], lineIdx: 0, colIdx: typed.length };
      picker.onBufferEdit();
      await picker.refresh(entry);
      expect(await picker.dispatch({ name: 'enter' } as Key, entry)).toEqual({
        consumed: true, action: { kind: 'submit', text: typed },
      });
    }
  });

  test('argument picker does not invent an /acp subcommand on trailing space', async () => {
    const picker = createPickerState({ commands: SLASH_COMMANDS });
    const buf = { lines: ['/acp '], lineIdx: 0, colIdx: 5 };
    await picker.refresh(buf);
    expect(await picker.dispatch({ name: 'enter' } as Key, buf)).toEqual({
      consumed: true, action: { kind: 'submit', text: '/acp' },
    });
    const parsed = resolveDashboardChatMainSlashCommand('/acp ');
    expect(parsed).toEqual({ cmdLower: 'acp', args: [] });
    const acp = { getLastBackend: () => null, getSticky: () => null } as unknown as DashboardAcpChat;
    expect(parseAcpSlash(parsed.args[0] ?? '', parsed.args.slice(1), acp).kind).toBe('help');
    await picker.dispatch({ name: 'down' } as Key, buf);
    expect(await picker.dispatch({ name: 'enter' } as Key, buf)).toEqual({
      consumed: true, action: { kind: 'submit', text: '/acp codex' },
    });
  });

  test('reserved built-in Andon priority never writes to the terminal', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => { throw new Error('terminal output'); });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const dispatcher = new HookDispatcher({ auditRoot: null });
      expect(() => dispatcher.register(buildAndonTurnHook())).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('plugin-hooks', 'reserved-priority', {
        message: "hook 'core:andon' registered with reserved priority 2 (range 0-9 is reserved for built-ins)",
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test('every built-in core:* hook stays off the terminal — route-banner and missions leaked into /research status (🅢 mbp live)', () => {
    const warnings: string[] = [];
    const dispatcher = new HookDispatcher({ auditRoot: null, warn: message => warnings.push(message) });
    dispatcher.register({ id: 'core:route-banner', event: 'Turn', priority: 3, invoke: () => ({}) });
    dispatcher.register({ id: 'core:missions', event: 'Turn', priority: 5, invoke: () => ({}) });
    dispatcher.register({ id: 'plugin:core-lookalike', event: 'Turn', priority: 4, invoke: () => ({}) });
    expect(warnings).toEqual([
      "hook 'plugin:core-lookalike' registered with reserved priority 4 (range 0-9 is reserved for built-ins)",
    ]);
  });

  test('other reserved priority warnings still reach the warning sink', () => {
    const warnings: string[] = [];
    const dispatcher = new HookDispatcher({ auditRoot: null, warn: message => warnings.push(message) });
    dispatcher.register(buildAndonTurnHook());
    dispatcher.register({ id: 'external:reserved', event: 'Turn', priority: 2, invoke: () => ({}) });
    expect(warnings).toEqual([
      "hook 'external:reserved' registered with reserved priority 2 (range 0-9 is reserved for built-ins)",
    ]);
  });
});
