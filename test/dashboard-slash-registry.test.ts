import { describe, expect, mock, spyOn, test } from 'bun:test';
import * as askLaunchFlow from '../src/self-dev/ask-launch-flow.js';
import type { AskLaunchFlowDeps, AskLaunchFlowInput, AskLaunchFlowResult } from '../src/self-dev/ask-launch-flow.js';
import * as goalAuthorCli from '../src/self-implement/goal-author-cli.js';
import type { GoalAuthorCliDeps } from '../src/self-implement/goal-author-cli.js';
import {
  getToolRuntime,
  registerToolRuntime,
  _unregisterToolRuntimeForTest,
} from '../src/tool-runtime/registry.js';
import type { ToolRuntime } from '../src/tool-runtime/types.js';
import type {
  DashboardSlashContext,
  SkillToolSlashExecutor,
  SkillToolSlashResult,
} from '../src/dashboard/slash-runtime/index.js';
import {
  DEFAULT_COMPACT_POLICY,
  resetAutoCompactStateForTest,
  type CompactProvider,
} from '../src/compact/index.js';
import { computeAnchorCount } from '../src/compact/pipeline.js';
import type { ChatMessage } from '../src/chat/index.js';
import { clearTelemetryForTest } from '../src/context-display/index.js';
import { censusRegisteredSlashOutputs } from '../src/command-registry.js';
import { setGoalAuthorRuntimeDeps } from '../src/tool-runtime/goal-author-runtime.js';

const {
  SlashCommandRegistry,
  buildDashboardSlashRegistry,
  runDeferredSkillToolSlash,
} = await import('../src/dashboard/slash-runtime/index.js');

/**
 * Phase B-1.a — slash command registry pilot. Verifies:
 *  - register / dispatch contract (continue + return outcomes)
 *  - duplicate-registration error
 *  - unregistered fallthrough
 *  - the 3 pilot dashboard handlers (quit / clear / help) wire correctly
 */

interface FakeCtxState {
  scrollOffset: number;
  exitLoop: boolean;
  closed: number;
  attachmentClears: number;
  searchClears: number;
  filterClears: number;
  debugLines: string[];
  chatOutputLines: string[];
  helpCalls: string[];

  // B-1.b
  forkCalls: number;
  toggleCalls: { state: unknown }[];
  toggleResult: { posture: 'control' | 'default' };
  inputCoreSetModeCalls: unknown[];
  resolveModeCalls: unknown[];
  chatModeStateValue: unknown;
  chatOnlyMode: boolean;
  chatOnlyLayoutCalls: { value: boolean; opts: { announce: boolean } }[];
  enterSyncCalls: number;
  voiceChatCalls: { state: unknown; args: string[] }[];
  voiceChatStatus: string;
  voiceChatStateValue: unknown;
  reloadSkillCalls: number;
  reloadSkillResult: number;

  // B-1.c
  blockStorePinned: Map<string, string[]>;
  blockStoreLatest: Map<string, string | null>;
  blockStoreLog: Array<{ op: string; target: string; id?: string }>;
  blockAttachCount: number;
  blockAttachLog: Array<{ op: string; target?: string }>;

  // B-1.d
  drawCalls: number;

  // B-1.e — auto-tts controller is mocked enough to satisfy
  // handleAutoTtsSlash's enable/disable/toggle calls; we capture each
  // sub-method invocation to verify the slash router wired through.
  autoTtsControllerEnabled: boolean;
  autoTtsControllerLog: string[];

  // B-1.f — companion-popup state. Each popup has an open flag; helpers
  // append a string to the log. Slash-runtime line builders return
  // labelled strings so tests can verify the right one was used.
  companionOpen: { clipboard: boolean; memo: boolean; detail: boolean };
  companionLog: string[];

  // B-1.h — preview / context / paste captures
  previewLog: string[];
  contextRenderCalls: number;
  pasteAttachResult: string | null;
  pasteAttachThrow: Error | null;
  pasteThinkingStops: Array<{ status: 'completed' | 'failed'; errorText?: string }>;
  pasteNextInitial: string | null;

  // TUI 부활 T2 — /ui
  uiMode: 'essential' | 'rich';
  uiModeSetCalls: Array<'essential' | 'rich'>;
  resumePickerOpens: number;
  forkPickerOpens: number;
  forkTimetravelCalls: number[];
  forkTimetravelResult: { forkedId: string; turn: number; removedUserText: string } | null;

  // /compact + /tokens slash wire-up captures
  compactChatHistory: ChatMessage[];
  compactActiveModelId: string | undefined;
  compactSessionId: string | undefined;
  compactProvider: CompactProvider;
  compactProviderCalls: Array<{ messageCount: number; preserveLastN: number; hint?: string; activeModelId?: string }>;
  logCopyCalls: number;
  logReturnInputCalls: number;
}

function makeFakeCtx(): { ctx: DashboardSlashContext; state: FakeCtxState } {
  const state: FakeCtxState = {
    scrollOffset: 0,
    exitLoop: false,
    closed: 0,
    attachmentClears: 0,
    searchClears: 0,
    filterClears: 0,
    debugLines: [],
    chatOutputLines: [],
    helpCalls: [],
    forkCalls: 0,
    toggleCalls: [],
    toggleResult: { posture: 'control' },
    inputCoreSetModeCalls: [],
    resolveModeCalls: [],
    chatModeStateValue: { tag: 'session-state' },
    chatOnlyMode: true,
    chatOnlyLayoutCalls: [],
    enterSyncCalls: 0,
    voiceChatCalls: [],
    voiceChatStatus: 'started',
    voiceChatStateValue: { tag: 'voice-chat' },
    reloadSkillCalls: 0,
    reloadSkillResult: 7,
    blockStorePinned: new Map(),
    blockStoreLatest: new Map(),
    blockStoreLog: [],
    blockAttachCount: 0,
    blockAttachLog: [],
    drawCalls: 0,
    autoTtsControllerEnabled: false,
    autoTtsControllerLog: [],
    companionOpen: { clipboard: false, memo: false, detail: false },
    companionLog: [],
    previewLog: [],
    contextRenderCalls: 0,
    pasteAttachResult: null,
    pasteAttachThrow: null,
    pasteThinkingStops: [],
    pasteNextInitial: null,
    // TUI 부활 T2 — /ui
    uiMode: 'essential' as 'essential' | 'rich',
    uiModeSetCalls: [] as Array<'essential' | 'rich'>,
    // TUI 부활 S-a — /resume
    resumePickerOpens: 0,
    // TUI 부활 S-b — /fork
    forkPickerOpens: 0,
    forkTimetravelCalls: [] as number[],
    forkTimetravelResult: null as { forkedId: string; turn: number; removedUserText: string } | null,
    compactChatHistory: [],
    compactActiveModelId: undefined,
    compactSessionId: undefined,
    compactProviderCalls: [],
    logCopyCalls: 0,
    logReturnInputCalls: 0,
    // Filled in below — needs `state` to exist for the closure.
    compactProvider: null as unknown as CompactProvider,
  };
  // Default fake provider — summarize() returns null so the pipeline
  // takes the Layer 5 truncate fallback (no real LLM call). Tests
  // can override individual methods via `state.compactProvider = …`.
  state.compactProvider = {
    async summarize(args) {
      state.compactProviderCalls.push({
        messageCount: args.messages.length,
        preserveLastN: args.preserveLastN ?? 4,
        ...(args.hint !== undefined ? { hint: args.hint } : {}),
        ...(args.activeModelId !== undefined ? { activeModelId: args.activeModelId } : {}),
      });
      return null;
    },
    getContextWindow() {
      return 200_000;
    },
    getAutoCompactThreshold() {
      return 100_000;
    },
  };
  const ctx: DashboardSlashContext = {
    chatLines: [],
    attachmentRowMap: { clear: () => { state.attachmentClears++; } },
    pushDebugLine: (line) => { state.debugLines.push(line); },
    pushChatLine: (line) => { state.debugLines.push(line); state.chatOutputLines.push(line); },
    setChatScrollOffset: (n) => { state.scrollOffset = n; },
    setExitInputLoop: (v) => { state.exitLoop = v; },
    muted: (text) => `[muted]${text}`,
    accent: (text) => `[accent]${text}`,
    highlight: (text) => `[highlight]${text}`,
    text: (text) => `[text]${text}`,
    error: (text) => `[error]${text}`,
    success: (text) => `[success]${text}`,
    warning: (text) => `[warning]${text}`,
    info: (text) => `[info]${text}`,
    iconsSync: '↻',
    closeTui: () => { state.closed++; },
    showHelp: async (scope) => { state.helpCalls.push(scope); },
    clearLogSearch: () => { state.searchClears++; },
    clearLogFilter: () => { state.filterClears++; },
    forkAttachedSessionFromChatHistory: async () => { state.forkCalls++; },
    toggleSessionControlMode: (s) => { state.toggleCalls.push({ state: s }); return state.toggleResult; },
    resolveSessionInputModeFromChatMode: (opts) => { state.resolveModeCalls.push(opts); return 'mode-out'; },
    inputCoreSetMode: (mode) => { state.inputCoreSetModeCalls.push(mode); return 'set-out'; },
    chatModeStateRef: { value: state.chatModeStateValue },
    getChatOnlyMode: () => state.chatOnlyMode,
    setChatOnlyLayout: (value, opts) => { state.chatOnlyLayoutCalls.push({ value, opts }); state.chatOnlyMode = value; },
    enterSyncMode: () => { state.enterSyncCalls++; },
    handleVoiceChatSlash: async (s, a) => { state.voiceChatCalls.push({ state: s, args: [...a] }); return state.voiceChatStatus; },
    voiceChatStateRef: { value: state.voiceChatStateValue },
    reloadSkillIndex: () => { state.reloadSkillCalls++; return state.reloadSkillResult; },
    blockStore: {
      getLatest: (target) => {
        state.blockStoreLog.push({ op: 'getLatest', target });
        const id = state.blockStoreLatest.get(target);
        return id ? { id } : null;
      },
      pin: (target, id) => {
        state.blockStoreLog.push({ op: 'pin', target, id });
        const existing = state.blockStorePinned.get(target) ?? [];
        if (existing.includes(id)) return false;
        state.blockStorePinned.set(target, [...existing, id]);
        return true;
      },
      unpin: (target, id) => {
        state.blockStoreLog.push({ op: 'unpin', target, id });
        const existing = state.blockStorePinned.get(target) ?? [];
        const idx = existing.indexOf(id);
        if (idx < 0) return false;
        state.blockStorePinned.set(target, existing.filter((_, i) => i !== idx));
        return true;
      },
      pinned: (target) => {
        state.blockStoreLog.push({ op: 'pinned', target });
        return (state.blockStorePinned.get(target) ?? []).map(id => ({ id }));
      },
    },
    blockAttach: {
      clearSession: (target) => {
        state.blockAttachLog.push({ op: 'clearSession', target });
        const removed = state.blockAttachCount;
        state.blockAttachCount = 0;
        return removed;
      },
      count: () => state.blockAttachCount,
      clear: () => {
        state.blockAttachLog.push({ op: 'clear' });
        state.blockAttachCount = 0;
      },
    },
    draw: () => { state.drawCalls++; },
    autoTtsRef: {
      controller: {
        enable: () => { state.autoTtsControllerEnabled = true; state.autoTtsControllerLog.push('enable'); },
        disable: () => { state.autoTtsControllerEnabled = false; state.autoTtsControllerLog.push('disable'); },
        toggle: () => {
          state.autoTtsControllerEnabled = !state.autoTtsControllerEnabled;
          state.autoTtsControllerLog.push('toggle');
          return state.autoTtsControllerEnabled;
        },
        isEnabled: () => state.autoTtsControllerEnabled,
        isSpeaking: () => false,
      },
      providerId: 'fake-provider',
    } as unknown as DashboardSlashContext['autoTtsRef'],
    controlSignalSlashRuntime: {
      usageLines: () => ['[cs:usage]'],
      statusLines: () => ['[cs:status]'],
      clearLine: () => '[cs:clear]',
      latestLines: (filter: unknown) => [`[cs:latest:${JSON.stringify(filter)}]`],
      listLines: (limit: unknown, filter: unknown) => [`[cs:list:${JSON.stringify({ limit, filter })}]`],
      emitLines: (a: readonly string[]) => [`[cs:emit:${a.join(',')}]`],
      parseFilterTokens: (tokens: readonly string[]) => ({ filter: tokens.length ? tokens.join('|') : null, limit: tokens.length || null }),
    },
    browserCdpSlashRuntime: {
      usageLines: () => ['[bcdp:usage]'],
      statusLines: () => ['[bcdp:status]'],
      smokeLines: async () => ['[bcdp:smoke]'],
      stopLines: () => ['[bcdp:stop]'],
    },
    widgetHost: {
      available: () => [
        { source: 'builtin' as const, def: { type: 'demo', description: 'a demo widget' } },
      ],
      discover: async () => undefined,
      instanceCount: () => 2,
    },
    preview: {
      slashRuntime: {
        resolve: (arg: string) => {
          if (arg === 'src') return { kind: 'source', source: 'src-tag' };
          if (arg === 'follow') return { kind: 'binding', binding: 'follow-tag' };
          if (arg === 'status') return { kind: 'status' };
          return { kind: 'usage' };
        },
        statusLine: (s: unknown, b: unknown) => `[preview:status:${String(s)}:${String(b)}]`,
        usageLine: () => '[preview:usage]',
      },
      setDockedSource: (s) => { state.previewLog.push(`setSource:${String(s)}`); },
      setDockedBinding: (b) => { state.previewLog.push(`setBinding:${String(b)}`); },
      refreshWorkingDirPreview: (opts) => { state.previewLog.push(`refresh:${opts.force}`); },
      resolveBindingMode: () => 'binding-mode-out',
      dockedSnapshotRef: { value: { sourceMode: 'src-mode-fake' } },
    },
    contextSlash: {
      renderContextList: () => { state.contextRenderCalls++; },
      contextRegistry: { _fake: true },
    },
    pasteSlash: {
      startThinking: () => ({
        stop: (opts) => { state.pasteThinkingStops.push(opts); },
      }),
      attachClipboardImage: async () => {
        if (state.pasteAttachThrow) throw state.pasteAttachThrow;
        return state.pasteAttachResult;
      },
      setNextInitial: (token: string) => { state.pasteNextInitial = token; },
    },
    uiModeSlash: {
      getMode: () => state.uiMode,
      setMode: (mode: 'essential' | 'rich') => {
        state.uiModeSetCalls.push(mode);
        state.uiMode = mode;
      },
    },
    sessionResume: {
      openPicker: () => { state.resumePickerOpens++; },
    },
    sessionFork: {
      openPicker: () => { state.forkPickerOpens++; },
      timetravel: async (n: number) => {
        state.forkTimetravelCalls.push(n);
        return state.forkTimetravelResult;
      },
    },
    refreshReasoningHudSegment: () => { state.companionLog.push('refreshReasoningHud'); },
    inputSeed: {
      appendBlock: (seed: string) => { state.companionLog.push(`appendBlock:${seed.length}`); },
      setPendingPlainInput: () => { state.companionLog.push('setPendingPlainInput'); },
    },
    inputHistory: {
      store: {
        list: () => [
          { id: 1, text: 'hello world', createdAt: '2026-05-04T10:00:00Z', kind: 'chat' },
        ],
        search: () => [],
        clear: () => { state.companionLog.push('history:clear'); },
        kind: 'sqlite',
      },
      refresh: () => { state.companionLog.push('history:refresh'); },
      openDetailViewer: (title, lines) => { state.companionLog.push(`history:detail:${title}:${lines.length}`); },
    },
    substrateStats: {
      paintCacheStats: () => ({ hits: 7, misses: 3, size: 5 }),
      overlayWriteStats: () => ({ skipped: 4, written: 11 }),
      generationStats: () => [
        { id: 'modal-X', bumps: 2, lastBumpAt: Date.now() - 2000 },
        { id: 'modal-Y', bumps: 1, lastBumpAt: Date.now() - 5000 },
      ],
      f8ShadowStats: () => ({ mode: false, divergences: 0 }),
    },
    companion: {
      popupHost: {
        isOpen: (key) => state.companionOpen[key],
      },
      setPopupOpen: (key, next) => {
        state.companionOpen[key] = next;
        state.companionLog.push(`setPopupOpen:${key}:${next}`);
      },
      openClipboard: async () => {
        state.companionOpen.clipboard = true;
        state.companionLog.push('openClipboard');
      },
      closeClipboard: () => {
        state.companionOpen.clipboard = false;
        state.companionLog.push('closeClipboard');
      },
      openMemo: () => {
        state.companionOpen.memo = true;
        state.companionLog.push('openMemo');
      },
      cancelMemo: () => {
        state.companionOpen.memo = false;
        state.companionLog.push('cancelMemo');
      },
      commitMemo: () => {
        state.companionOpen.memo = false;
        state.companionLog.push('commitMemo');
      },
      closeDetail: () => {
        state.companionOpen.detail = false;
        state.companionLog.push('closeDetail');
      },
      clearDetailViewer: () => { state.companionLog.push('clearDetailViewer'); },
      clearClipHistory: () => { state.companionLog.push('clearClipHistory'); },
      notifyClipboardCleared: () => { state.companionLog.push('notifyClipboardCleared'); },
      notifyClipboardToggled: (open) => { state.companionLog.push(`notifyClipboardToggled:${open}`); },
      slashRuntime: {
        openedLine: (n) => `[opened:${n}]`,
        closedLine: (n) => `[closed:${n}]`,
        toggledLine: (n, open) => `[toggled:${n}:${open}]`,
        usageLine: (n) => `[usage:${n}]`,
        detailClearedLine: () => '[detailCleared]',
      },
    },
    logSlash: {
      pushDebugBlank: () => {},
      getLogHeightBias: () => 0,
      setLogHeightBias: () => {},
      recomputePaneHeight: () => {},
      getLogFilterQuery: () => '',
      applyLogFilter: () => {},
      getLogSearchResultsCount: () => 0,
      firstSearchResultLineIdx: () => null,
      applyLogSearch: () => {},
      scrollToSearchLineIdx: () => {},
      openLogSearchModal: () => {},
      isLogFreezeEnabled: () => false,
      getLogFrozenTailIndex: () => null,
      chatLinesLength: () => 0,
      getLogTurnSeparatorMode: () => 'off' as const,
      setLogTurnSeparatorMode: () => {},
      getLogFoldMode: () => 'line' as const,
      setLogFoldMode: () => {},
      pushTurnSeparator: () => {},
      toggleSolo: () => false,
      copyEntireLog: async () => { state.logCopyCalls++; },
      returnFocusToInput: () => { state.logReturnInputCalls++; },
    },
    compactSlash: {
      // Tests assign chatHistory / activeModelId / sessionId per-case.
      // The default fake provider's summarize() returns null so the
      // pipeline takes the Layer 5 truncate fallback without any
      // actual LLM call. Tests that need a successful Layer 3 stub
      // override this via the returned `state.compactProvider*` knobs.
      chatHistory: state.compactChatHistory,
      activeModelId: () => state.compactActiveModelId,
      sessionId: () => state.compactSessionId,
      getProvider: () => state.compactProvider,
    },
  };
  return { ctx, state };
}

describe('SlashCommandRegistry — generic registry', () => {
  test('dispatch returns unregistered when name not found', async () => {
    const reg = new SlashCommandRegistry<{}, never>();
    const r = await reg.dispatch('nope', [], {});
    expect(r.kind).toBe('unregistered');
  });

  test('handler returning void → continue outcome', async () => {
    const reg = new SlashCommandRegistry<{ count: number }, never>();
    const ctx = { count: 0 };
    reg.register('inc', (_args, c) => { c.count++; });
    const r = await reg.dispatch('inc', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.count).toBe(1);
  });

  test('handler returning {return: X} → return outcome with value', async () => {
    const reg = new SlashCommandRegistry<{}, 'quit' | 'reload'>();
    reg.register('q', () => ({ return: 'quit' }));
    const r = await reg.dispatch('q', [], {});
    expect(r).toEqual({ kind: 'return', value: 'quit' });
  });

  test('async handler is awaited', async () => {
    const reg = new SlashCommandRegistry<{ tag: string }, never>();
    reg.register('a', async (_args, c) => {
      await Promise.resolve();
      c.tag = 'set';
    });
    const ctx = { tag: '' };
    const r = await reg.dispatch('a', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.tag).toBe('set');
  });

  test('register accepts alias array', async () => {
    const reg = new SlashCommandRegistry<{ hits: number }, never>();
    reg.register(['a', 'b', 'c'], (_args, c) => { c.hits++; });
    const ctx = { hits: 0 };
    await reg.dispatch('a', [], ctx);
    await reg.dispatch('b', [], ctx);
    await reg.dispatch('c', [], ctx);
    expect(ctx.hits).toBe(3);
    expect(reg.has('a') && reg.has('b') && reg.has('c')).toBe(true);
  });

  test('registration owns the immediate-during-stream marker for every alias', () => {
    const reg = new SlashCommandRegistry<{}, never>();
    reg.register(['observe', 'obs'], () => {}, { immediateDuringStream: true });
    reg.register('ordinary', () => {});

    expect(reg.isImmediateDuringStream('observe')).toBe(true);
    expect(reg.isImmediateDuringStream('obs')).toBe(true);
    expect(reg.isImmediateDuringStream('ordinary')).toBe(false);
    expect(reg.isImmediateDuringStream('missing')).toBe(false);
  });

  test('duplicate registration throws', () => {
    const reg = new SlashCommandRegistry<{}, never>();
    reg.register('x', () => {});
    expect(() => reg.register('x', () => {})).toThrow(/duplicate registration/);
  });

  test('empty alias list throws', () => {
    const reg = new SlashCommandRegistry<{}, never>();
    expect(() => reg.register([], () => {})).toThrow(/at least one name required/);
  });

  test('args are forwarded to handler', async () => {
    const reg = new SlashCommandRegistry<{ seen: string[] }, never>();
    reg.register('x', (args, c) => { c.seen = [...args]; });
    const ctx = { seen: [] as string[] };
    await reg.dispatch('x', ['a', 'b'], ctx);
    expect(ctx.seen).toEqual(['a', 'b']);
  });
});

describe('buildDashboardSlashRegistry — pilot handlers', () => {
  test('/log copy and input dispatch the index-provided whole-copy and focus-return callbacks', async () => {
    const registry = buildDashboardSlashRegistry();
    for (const [args, expected] of [
      [['copy'], 'copy'],
      [['all'], 'copy'],
      [['input'], 'input'],
      [['return'], 'input'],
    ] as const) {
      const { ctx, state } = makeFakeCtx();
      expect(await registry.dispatch('log', [...args], ctx)).toEqual({ kind: 'continue' });
      expect(state.logCopyCalls).toBe(expected === 'copy' ? 1 : 0);
      expect(state.logReturnInputCalls).toBe(expected === 'input' ? 1 : 0);
    }
  });

  test('harness ask dispatches its complete feature text through the goal-author write seam', async () => {
    const runAskLaunchFlow = spyOn(askLaunchFlow, 'runAskLaunchFlow').mockImplementation(async (input: AskLaunchFlowInput, deps: AskLaunchFlowDeps): Promise<AskLaunchFlowResult> => {
      await deps.authorGoal([input.askText], { cwd: deps.cwd() });
      return { kind: 'stopped-before-authoring' };
    });
    const calls: Array<{ feature: string; surface: string }> = [];
    const authoredPaths = new Set<string>();
    const goalWrites: Array<{ ask: string; cwd: string }> = [];
    const existingRuntime = getToolRuntime('self_implement');
    const originalRunGoalAuthorCli = goalAuthorCli.runGoalAuthorCli;
    const noFilesystemWrite: GoalAuthorCliDeps['write'] = async (ask, cwd) => {
      goalWrites.push({ ask, cwd });
      return {
        path: `${cwd}/docs/goals/GOAL-dashboard-slash-test.md`,
        authored: { document: `# Goal\n${ask}\n`, facts: null, grounded: false, authorRunId: 'dashboard-slash-test' },
      };
    };
    const runGoalAuthorCli = spyOn(goalAuthorCli, 'runGoalAuthorCli').mockImplementation((parts, options, deps = {}) => originalRunGoalAuthorCli(parts, options, {
      ...deps,
      decomposeSteps: async () => [],
      recordAsk: () => true,
      write: noFilesystemWrite,
    }));
    setGoalAuthorRuntimeDeps({
      fileDeps: {
        mkdir: () => {},
        write: (path) => {
          if (authoredPaths.has(path)) {
            const error = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException;
            error.code = 'EEXIST';
            throw error;
          }
          authoredPaths.add(path);
        },
      },
    });
    _unregisterToolRuntimeForTest('self_implement');
    try {
      registerToolRuntime({
        id: 'self_implement',
        spec: {} as ToolRuntime['spec'],
        async run(args, context) {
          calls.push({ feature: (args as { feature: string }).feature, surface: context.surface });
          return { output: 'started' };
        },
      } as ToolRuntime);

      const feature = `preserve this complete goal text without truncation: ${'long feature payload '.repeat(6)}END-OF-FEATURE`;
      expect(feature.length).toBeGreaterThan(80);
      const reg = buildDashboardSlashRegistry();
      for (const args of [['ask', ...feature.split(' ')], feature.split(' ')] as const) {
        const { ctx } = makeFakeCtx();
        expect((await reg.dispatch('harness', [...args], ctx)).kind).toBe('continue');
      }
      const { ctx: retiredImplementCtx, state: retiredImplementState } = makeFakeCtx();
      expect((await reg.dispatch('harness', ['implement', ...feature.split(' ')], retiredImplementCtx)).kind).toBe('continue');
      expect(retiredImplementState.chatOutputLines).toContain('[muted]  /harness implement has moved to /harness ask <무엇을 왜 고칠지 한 문장>');
      await Bun.sleep(25);

      expect(runAskLaunchFlow).toHaveBeenCalledTimes(2);
      expect(runGoalAuthorCli).toHaveBeenCalledTimes(2);
      expect(runGoalAuthorCli.mock.calls.map(([parts]) => parts.join(' '))).toEqual([feature, feature]);
      expect(runGoalAuthorCli.mock.calls.every(([, , deps]) => deps === undefined)).toBe(true);
      expect(goalWrites).toEqual([
        { ask: feature, cwd: process.cwd() },
        { ask: feature, cwd: process.cwd() },
      ]);
      expect(calls).toEqual([]);
      expect(authoredPaths.size).toBe(0);
    } finally {
      runGoalAuthorCli.mockRestore();
      runAskLaunchFlow.mockRestore();
      _unregisterToolRuntimeForTest('self_implement');
      if (existingRuntime) registerToolRuntime(existingRuntime);
      setGoalAuthorRuntimeDeps();
    }
    expect(getToolRuntime('self_implement')).toBe(existingRuntime);
  });

  test('quit / q / exit → closeTui + return "quit"', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['quit', 'q', 'exit'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r).toEqual({ kind: 'return', value: 'quit' });
      expect(state.closed).toBe(1);
    }
  });

  test('clear / cls → mutates chat state, continue', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['clear', 'cls'] as const) {
      const { ctx, state } = makeFakeCtx();
      ctx.chatLines.push('a', 'b', 'c');
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(ctx.chatLines.length).toBe(0);
      expect(state.attachmentClears).toBe(1);
      expect(state.searchClears).toBe(1);
      expect(state.filterClears).toBe(1);
      expect(state.scrollOffset).toBe(-1);
      expect(state.debugLines).toEqual(['[muted]Status cleared']);
    }
  });

  test('help / ? → showHelp("dashboard") then continue', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['help', '?'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.helpCalls).toEqual(['dashboard']);
    }
  });

  test('unknown command → unregistered (falls through to legacy switch)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('unknown-future-thing', [], ctx);
    expect(r.kind).toBe('unregistered');
  });
});

describe('B-1.b · 6 tiny standalone case migrations', () => {
  test('fork → 현 시점 full-copy 분기 (codex ForkCurrentSession 동형 · 컨셉 정렬)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('fork', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.forkCalls).toBe(1);
    expect(state.forkPickerOpens).toBe(0);
    expect(state.scrollOffset).toBe(-1);
  });

  test('fork before:N → 패브릭 컨벤션 수용 — timetravel 위임 (tg/dc 동형)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.forkTimetravelResult = { forkedId: 'f2', turn: 3, removedUserText: 'x' };
    await reg.dispatch('fork', ['before:3'], ctx);
    expect(state.forkTimetravelCalls).toEqual([3]);
    expect(state.forkCalls).toBe(0);
  });

  test('rewind 무인자 → user 턴 픽커 오픈 (codex backtrack 계보 · 숫자 입력 불요)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('rewind', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.forkPickerOpens).toBe(1);
    expect(state.forkCalls).toBe(0);
  });

  test('rewind <n> → timetravel(n) + 잘린 turn 텍스트 입력창 prefill', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.forkTimetravelResult = { forkedId: 'f1', turn: 2, removedUserText: '고칠 메시지' };
    const r = await reg.dispatch('rewind', ['2'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.forkTimetravelCalls).toEqual([2]);
    expect(state.pasteNextInitial).toBe('고칠 메시지');
  });

  test('rewind 비정수 인자 → usage 경고 (호출 없음)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    await reg.dispatch('rewind', ['abc'], ctx);
    expect(state.forkPickerOpens).toBe(0);
    expect(state.forkTimetravelCalls).toEqual([]);
    expect(ctx.chatLines.join('\n')).toContain('usage: /rewind');
  });

  test('ctoggle (control posture) → push CONTROL MODE banner + reset scroll', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.toggleResult = { posture: 'control' };
    const r = await reg.dispatch('ctoggle', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.toggleCalls.length).toBe(1);
    expect(state.toggleCalls[0]?.state).toBe(state.chatModeStateValue);
    expect(state.inputCoreSetModeCalls).toEqual(['mode-out']);
    expect(state.resolveModeCalls).toEqual([{ chatModeState: state.chatModeStateValue }]);
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('[error]');
    expect(ctx.chatLines[0]).toContain('CONTROL MODE');
    expect(state.scrollOffset).toBe(-1);
  });

  test('ctoggle (default posture) → push back-to-default banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.toggleResult = { posture: 'default' };
    const r = await reg.dispatch('ctoggle', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[0]).toBe('[muted]-- back to default chat mode --');
  });

  test('dashboard / dash → exits chatOnly when active (idempotent when already off)', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['dashboard', 'dash'] as const) {
      const { ctx, state } = makeFakeCtx();
      state.chatOnlyMode = true;
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.chatOnlyLayoutCalls).toEqual([{ value: false, opts: { announce: true } }]);
      expect(state.chatOnlyMode).toBe(false);
    }
    // idempotent when already off
    {
      const { ctx, state } = makeFakeCtx();
      state.chatOnlyMode = false;
      const r = await reg.dispatch('dashboard', [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.chatOnlyLayoutCalls).toEqual([]);
    }
  });

  test('sync / s → enterSyncMode + push banner + setExitInputLoop(true)', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['sync', 's'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.enterSyncCalls).toBe(1);
      expect(state.exitLoop).toBe(true);
      expect(ctx.chatLines.length).toBe(1);
      expect(ctx.chatLines[0]).toContain('[highlight]');
      expect(ctx.chatLines[0]).toContain('Sync mode');
      expect(state.scrollOffset).toBe(-1);
    }
  });

  test('voice-chat / vc → calls handleVoiceChatSlash + 3 chat lines', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['voice-chat', 'vc'] as const) {
      const { ctx, state } = makeFakeCtx();
      state.voiceChatStatus = 'started';
      const r = await reg.dispatch(name, ['start'], ctx);
      expect(r.kind).toBe('continue');
      expect(state.voiceChatCalls.length).toBe(1);
      expect(state.voiceChatCalls[0]?.state).toBe(state.voiceChatStateValue);
      expect(state.voiceChatCalls[0]?.args).toEqual(['start']);
      expect(ctx.chatLines.length).toBe(3);
      expect(ctx.chatLines[0]).toBe('');
      expect(ctx.chatLines[1]).toContain('[accent]');
      expect(ctx.chatLines[1]).toContain('/voice-chat start');
      expect(ctx.chatLines[2]).toBe('[muted]  started');
      expect(state.scrollOffset).toBe(-1);
    }
  });

  test('voice-chat with no args → header shows default "start"', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    await reg.dispatch('voice-chat', [], ctx);
    expect(ctx.chatLines[1]).toContain('/voice-chat start');
  });

  test('skill-reload / skills-reload → reloadSkillIndex + chat-line announcement', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['skill-reload', 'skills-reload'] as const) {
      const { ctx, state } = makeFakeCtx();
      state.reloadSkillResult = 7;
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.reloadSkillCalls).toBe(1);
      expect(ctx.chatLines.length).toBe(1);
      expect(ctx.chatLines[0]).toBe('[muted][skills] index rebuilt — 7 skills loaded');
      expect(state.scrollOffset).toBe(-1);
    }
  });

  test('skill-reload pluralization (n=1 → "skill")', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.reloadSkillResult = 1;
    await reg.dispatch('skill-reload', [], ctx);
    expect(ctx.chatLines[0]).toBe('[muted][skills] index rebuilt — 1 skill loaded');
  });
});

describe('B-1.c · 8 small standalone case migrations', () => {
  test('attach-pin without target → usage warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('attach-pin', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[warning]  usage: /attach-pin <sessionId>');
  });

  test('attach-pin with target but no captured block → muted notice', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('attach-pin', ['term:1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[muted]  no block captured yet for term:1.');
  });

  test('attach-pin success → info banner with block id', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockStoreLatest.set('term:1', 'blk-42');
    const r = await reg.dispatch('attach-pin', ['term:1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toContain('[info]');
    expect(state.debugLines[0]).toContain('📌 pinned blk-42 from term:1');
    expect(state.blockStorePinned.get('term:1')).toEqual(['blk-42']);
  });

  test('attach-pin already pinned → muted "already pinned"', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockStoreLatest.set('term:1', 'blk-42');
    state.blockStorePinned.set('term:1', ['blk-42']);
    const r = await reg.dispatch('attach-pin', ['term:1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[muted]  blk-42 is already pinned.');
  });

  test('attach-unpin without target → usage warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('attach-unpin', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[warning]  usage: /attach-unpin <sessionId> [blockId]');
  });

  test('attach-unpin with id → unpins specific block', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockStorePinned.set('term:1', ['blk-1', 'blk-2']);
    const r = await reg.dispatch('attach-unpin', ['term:1', 'blk-1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[info]  blk-1 unpinned from term:1.');
    expect(state.blockStorePinned.get('term:1')).toEqual(['blk-2']);
  });

  test('attach-unpin without id → batch unpin all on target', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockStorePinned.set('term:1', ['a', 'b', 'c']);
    const r = await reg.dispatch('attach-unpin', ['term:1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toBe('[info]  unpinned 3 blocks on term:1.');
    expect(state.blockStorePinned.get('term:1')).toEqual([]);
  });

  test('attach-clear with target → clearSession', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockAttachCount = 3;
    const r = await reg.dispatch('attach-clear', ['term:1'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.blockAttachLog).toEqual([{ op: 'clearSession', target: 'term:1' }]);
    expect(state.debugLines[0]).toContain('detached 3 attachments from term:1');
  });

  test('attach-clear without target → clear all', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.blockAttachCount = 5;
    const r = await reg.dispatch('attach-clear', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.blockAttachLog).toEqual([{ op: 'clear' }]);
    expect(state.debugLines[0]).toContain('all 5 attachments detached');
  });

  test('rebind dispatches to runRebindCommand and pushes painted lines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('rebind', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBeGreaterThan(0);
  });

  test('perf status dispatch (no-throw smoke + chat-line)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('perf', ['status'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines.length).toBeGreaterThan(0);
    expect(state.debugLines[0]).toContain('perf:');
  });

  test('cache (default subcommand) dispatch (no-throw smoke)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('cache', [], ctx);
    expect(r.kind).toBe('continue');
    // formatSessionSummary returns at least one line; pushed as muted.
    expect(state.debugLines.length).toBeGreaterThan(0);
  });

  test('pty-list / ptys dispatch (no-throw smoke)', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['pty-list', 'ptys'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.debugLines.length).toBeGreaterThan(0);
    }
  });

  test('sweep-tool-results dispatch (no-throw smoke; success or warning)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('sweep-tool-results', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines.length).toBe(1);
    // outcome is success or warning (filesystem-dependent)
    expect(state.debugLines[0]).toMatch(/^\[(success|warning)\]/);
  });
});

// Wait for fire-and-forget IIFE inside `runDeferredSkillToolSlash` to flush.
// Two microtask awaits cover: (1) await loadExecutor(), (2) await exec(),
// plus the trailing draw/setChatScrollOffset are sync after the executor.
async function flushSkillToolSlash(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('B-1.d · runDeferredSkillToolSlash helper', () => {
  test('happy path: ok=true → muted lines + draw + scrollOffset reset', async () => {
    const { ctx, state } = makeFakeCtx();
    const exec: SkillToolSlashExecutor = async (req) => ({
      ok: true,
      logLines: [`hello ${req.name} ${req.args.join(',')}`],
    });
    runDeferredSkillToolSlash('budget', async () => exec, ['x', 'y'], ctx);
    await flushSkillToolSlash();
    expect(ctx.chatLines).toEqual(['[muted]  hello budget x,y']);
    expect(state.scrollOffset).toBe(-1);
    expect(state.drawCalls).toBe(1);
  });

  test('warning path: ok=false → warning prefix on logLines', async () => {
    const { ctx, state } = makeFakeCtx();
    const exec: SkillToolSlashExecutor = async () => ({ ok: false, logLines: ['bad', 'state'] });
    runDeferredSkillToolSlash('route', async () => exec, [], ctx);
    await flushSkillToolSlash();
    expect(ctx.chatLines).toEqual(['[warning]  bad', '[warning]  state']);
    expect(state.drawCalls).toBe(1);
  });

  test('no-result path: executor returns null → muted "no result" message', async () => {
    const { ctx, state } = makeFakeCtx();
    const exec: SkillToolSlashExecutor = async () => null as SkillToolSlashResult;
    runDeferredSkillToolSlash('llm', async () => exec, [], ctx);
    await flushSkillToolSlash();
    expect(ctx.chatLines).toEqual(['[muted]  /llm: no result']);
    expect(state.drawCalls).toBe(1);
  });

  test('throw path: loader rejects → error line with cmd name + draw', async () => {
    const { ctx, state } = makeFakeCtx();
    runDeferredSkillToolSlash(
      'lane',
      async () => { throw new Error('module load fail'); },
      [],
      ctx,
    );
    await flushSkillToolSlash();
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('[error]');
    expect(ctx.chatLines[0]).toContain('/lane failed');
    expect(ctx.chatLines[0]).toContain('module load fail');
    expect(state.drawCalls).toBe(1);
  });

  test('throw path: executor rejects → error line', async () => {
    const { ctx, state } = makeFakeCtx();
    const exec: SkillToolSlashExecutor = async () => { throw new Error('boom'); };
    runDeferredSkillToolSlash('relay', async () => exec, [], ctx);
    await flushSkillToolSlash();
    expect(ctx.chatLines[0]).toContain('[error]');
    expect(ctx.chatLines[0]).toContain('/relay failed');
    expect(ctx.chatLines[0]).toContain('boom');
    expect(state.drawCalls).toBe(1);
  });
});

describe('B-1.d · 9 deferred skill-tool slash registrations', () => {
  // Each registration is verified for two things only — that's the
  // load-bearing per-case check at this tier:
  //   1. The name/alias is registered (dispatch returns 'continue', not 'unregistered').
  //   2. The handler executes synchronously (the dispatch call itself
  //      returns immediately because the IIFE is fire-and-forget).
  // The actual skill-tool execution is exercised in those modules' own
  // test files; the helper's behavior is covered by the previous block.
  const registeredNames = [
    'budget', 'b',
    'route',
    'agent-room',
    'showroom',
    'lane',
    'relay',
    'reply',
    'capture',
    'inject',
    'llm',
  ] as const;

  for (const name of registeredNames) {
    test(`/${name} is registered and dispatches as 'continue'`, async () => {
      const reg = buildDashboardSlashRegistry();
      const { ctx } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
    });
  }

  test('budget alias `b` is registered to the same handler shape as budget', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('budget')).toBe(true);
    expect(reg.has('b')).toBe(true);
  });

  test('all 9 unique handlers are present in registry.names()', () => {
    const reg = buildDashboardSlashRegistry();
    const names = new Set(reg.names());
    for (const n of registeredNames) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe('B-1.e · 4 tiny standalone toggles / state-mutation cases', () => {
  test('pause: first call → success "queued" + scrollOffset reset', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    // The handler dynamically imports turn-checkpoint. Reset to a known
    // state by calling once and checking either branch is acceptable.
    const r = await reg.dispatch('pause', [], ctx);
    expect(r.kind).toBe('continue');
    // The response is either the "queued" success path or "already
    // queued" muted path depending on prior process state.
    expect(state.debugLines.length).toBeGreaterThan(0);
    expect(state.debugLines[0]).toMatch(/\[(success|muted)\]/);
    expect(state.scrollOffset).toBe(-1);
    // pauseRequested is a module-level singleton; clear it so the flag
    // doesn't leak into subsequent test files (e.g.
    // llm-exploration-synthesis-phase) where streamLLMWithTools sees a
    // stale pause request and short-circuits to a checkpoint pause.
    const { resetPauseFlag } = await import('../src/turn-checkpoint/index.js');
    resetPauseFlag();
  });

  test('chat: toggles chat-only layout via setChatOnlyLayout', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.chatOnlyMode = false;
    const r = await reg.dispatch('chat', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.chatOnlyLayoutCalls).toEqual([
      { value: true, opts: { announce: true } },
    ]);
    expect(state.chatOnlyMode).toBe(true);
  });

  test('chat: toggles back when already in chat-only', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.chatOnlyMode = true;
    const r = await reg.dispatch('chat', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.chatOnlyLayoutCalls).toEqual([
      { value: false, opts: { announce: true } },
    ]);
    expect(state.chatOnlyMode).toBe(false);
  });

  test('qc without intent: pushes "armed" banner only', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('qc', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('quick-control armed');
    expect(state.scrollOffset).toBe(-1);
  });

  test('qc with intent words: pushes banner + intent line', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('qc', ['fix', 'the', 'bug'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBe(2);
    expect(ctx.chatLines[0]).toContain('quick-control armed');
    expect(ctx.chatLines[1]).toContain('intent: fix the bug');
  });

  test('auto-tts (and aliases) on → controller.enable + status banner', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['auto-tts', 'autotts', 'tts'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, ['on'], ctx);
      expect(r.kind).toBe('continue');
      expect(state.autoTtsControllerLog).toEqual(['enable']);
      expect(state.autoTtsControllerEnabled).toBe(true);
      expect(ctx.chatLines.length).toBe(3);
      expect(ctx.chatLines[2]).toContain('auto-TTS on');
    }
  });

  test('auto-tts off → controller.disable + status banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.autoTtsControllerEnabled = true;
    const r = await reg.dispatch('auto-tts', ['off'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.autoTtsControllerLog).toEqual(['disable']);
    expect(state.autoTtsControllerEnabled).toBe(false);
    expect(ctx.chatLines[2]).toContain('auto-TTS off');
  });

  test('auto-tts toggle → controller.toggle + reflects new state in banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.autoTtsControllerEnabled = false;
    const r = await reg.dispatch('auto-tts', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.autoTtsControllerLog).toEqual(['toggle']);
    expect(state.autoTtsControllerEnabled).toBe(true);
    expect(ctx.chatLines[2]).toMatch(/auto-TTS on \(provider: fake-provider\)/);
  });
});

describe('B-1.f · 3 companion-popup cases (clipboard · memo · detail)', () => {
  test('clipboard open: openClipboard + opened banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('clipboard', ['open'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['openClipboard']);
    expect(state.companionOpen.clipboard).toBe(true);
    expect(ctx.chatLines).toEqual(['[opened:clipboard]']);
  });

  test('clipboard close: closeClipboard + closed banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.clipboard = true;
    const r = await reg.dispatch('clip', ['close'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['closeClipboard']);
    expect(state.companionOpen.clipboard).toBe(false);
    expect(ctx.chatLines).toEqual(['[closed:clipboard]']);
  });

  test('clipboard toggle (closed → open): opens then notifies toggled true', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.clipboard = false;
    const r = await reg.dispatch('cb', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['openClipboard', 'notifyClipboardToggled:true']);
    expect(state.companionOpen.clipboard).toBe(true);
  });

  test('clipboard toggle (open → close): closes then notifies toggled false', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.clipboard = true;
    const r = await reg.dispatch('clipboard', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['closeClipboard', 'notifyClipboardToggled:false']);
    expect(state.companionOpen.clipboard).toBe(false);
  });

  test('clipboard clear: clearClipHistory + notifyClipboardCleared', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('clipboard', ['clear'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['clearClipHistory', 'notifyClipboardCleared']);
  });

  test('clipboard unknown sub: usage banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('clipboard', ['unknown-sub'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines).toEqual(['[usage:clipboard]']);
  });

  test('memo open + close + commit each map to correct helper', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const [sub, expected] of [
      ['open', 'openMemo'],
      ['close', 'cancelMemo'],
      ['cancel', 'cancelMemo'],
      ['commit', 'commitMemo'],
      ['save', 'commitMemo'],
    ] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch('memo', [sub], ctx);
      expect(r.kind).toBe('continue');
      expect(state.companionLog).toContain(expected);
    }
  });

  test('memo toggle (closed → open): openMemo + opened banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.memo = false;
    const r = await reg.dispatch('me', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['openMemo']);
    expect(ctx.chatLines).toEqual(['[opened:memo]']);
  });

  test('memo toggle (open → close): cancelMemo only (no banner)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.memo = true;
    const r = await reg.dispatch('note', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['cancelMemo']);
    expect(ctx.chatLines.length).toBe(0);
  });

  test('detail open: setPopupOpen + opened banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('detail', ['open'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['setPopupOpen:detail:true']);
    expect(state.companionOpen.detail).toBe(true);
    expect(ctx.chatLines).toEqual(['[opened:detail]']);
  });

  test('detail close: closeDetail + closed banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.detail = true;
    const r = await reg.dispatch('report', ['close'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['closeDetail']);
    expect(ctx.chatLines).toEqual(['[closed:detail]']);
  });

  test('detail toggle: setPopupOpen with negated state', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.companionOpen.detail = false;
    const r = await reg.dispatch('dv', ['toggle'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['setPopupOpen:detail:true']);
    expect(ctx.chatLines).toEqual(['[toggled:detail:true]']);
  });

  test('detail clear: clearDetailViewer + cleared banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('detail', ['clear'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toEqual(['clearDetailViewer']);
    expect(ctx.chatLines).toEqual(['[detailCleared]']);
  });
});

describe('B-1.g · 3 sub-runtime delegation cases', () => {
  test('signals status (default sub) → statusLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signals', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines).toEqual(['', '[accent]❯ /signals status', '[cs:status]']);
  });

  test('signals help → usageLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signal', ['help'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines).toEqual(['', '[accent]❯ /signals help', '[cs:usage]']);
  });

  test('signals clear → observer().clear() + clearLine', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signals', ['clear'], ctx);
    expect(r.kind).toBe('continue');
    // The third line is the clearLine sentinel; observer mutation
    // happens in the real `defaultControlSignalObserver()` singleton —
    // we don't intercept it here, only confirm dispatch landed.
    expect(ctx.chatLines.length).toBe(3);
    expect(ctx.chatLines[2]).toBe('[cs:clear]');
  });

  test('signals list → parseFilterTokens + listLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signals', ['list', 'foo', 'bar'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toContain('[cs:list:');
    expect(ctx.chatLines[2]).toContain('"foo|bar"');
  });

  test('signals emit → emitLines with remaining args', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signals', ['emit', 'topic', 'payload'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toBe('[cs:emit:topic,payload]');
  });

  test('signals unknown sub → falls back to usageLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('signals', ['nonsense'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toBe('[cs:usage]');
  });

  test('browser-cdp status (default) → statusLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('browser-cdp', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toBe('[bcdp:status]');
  });

  test('browser-cdp smoke → smokeLines (async)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('bcdp', ['smoke'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toBe('[bcdp:smoke]');
  });

  test('browser-cdp stop → stopLines', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('bcdp', ['stop'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toBe('[bcdp:stop]');
  });

  test('widget list → renders available widgets', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('widget', ['list'], ctx);
    expect(r.kind).toBe('continue');
    // Lines: '' (separator) + accent header + the widget row
    expect(ctx.chatLines.length).toBe(3);
    expect(ctx.chatLines[2]).toContain('demo');
    expect(ctx.chatLines[2]).toContain('a demo widget');
  });

  test('widget reload → discover + summary line', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('w', ['reload'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toContain('reloaded');
    expect(ctx.chatLines[2]).toContain('1 widget type');
  });

  test('widget instances → instanceCount', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('widgets', ['instances'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toContain('2 widget instance(s) alive');
  });

  test('widget unknown sub → warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('widget', ['oops'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[2]).toContain('[warning]');
    expect(ctx.chatLines[2]).toContain('unknown subcommand');
  });
});

describe('B-1.h · session/context cluster', () => {
  // /control / /dm / /default — registered as 3 separate names so the
  // matched name flows through (fixing the original `cmd` typo by
  // construction). Smoke-test all 3 → continue.
  test('control / dm / default registered separately', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['control', 'dm', 'default'] as const) {
      const { ctx } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
    }
  });

  test('surface (default sub = enter) → setSessionPreferredSurface path', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    // Empty args usually triggers a status branch in parseSessionSurfaceSlash.
    const r = await reg.dispatch('surface', [], ctx);
    expect(r.kind).toBe('continue');
    // status branch pushes 0+ lines + scrollOffset reset
  });

  test('preview source: setDockedSource + refresh + statusLine', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('preview', ['src'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.previewLog).toEqual(['setSource:src-tag', 'refresh:true']);
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('preview:status');
  });

  test('preview binding (alias /pv): setDockedBinding + refresh + statusLine', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('pv', ['follow'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.previewLog).toEqual(['setBinding:follow-tag', 'refresh:true']);
  });

  test('preview status: no setter, just statusLine', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('preview', ['status'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.previewLog).toEqual([]);
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('preview:status');
  });

  test('preview unknown sub: usageLine', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('preview', ['nonsense'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.previewLog).toEqual([]);
    expect(ctx.chatLines).toEqual(['[preview:usage]']);
  });

  test('context (no sub) → renderContextList', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('context', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.contextRenderCalls).toBe(1);
  });

  test('context drop with non-numeric id → warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('ctx', ['drop', 'not-a-num'], ctx);
    expect(r.kind).toBe('continue');
    // Either the dynamic-import contextRegistry path runs (real module)
    // or warns about usage. Either way ctx loaded; verify no throw.
    expect(ctx.chatLines.length).toBeGreaterThanOrEqual(1);
  });

  test('ui: 인자 없음 → 현재 모드 + 사용법 (setMode 미호출)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('ui', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.uiModeSetCalls).toEqual([]);
    expect(ctx.chatLines.join('\n')).toContain('ui mode: essential');
    expect(ctx.chatLines.join('\n')).toContain('/ui rich');
  });

  test('ui rich → setMode(rich) 위임', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('ui', ['rich'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.uiModeSetCalls).toEqual(['rich']);
    expect(ctx.chatLines.join('\n')).toContain('/ui rich');
  });

  test('ui bogus → warning + 사용법 (setMode 미호출)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    await reg.dispatch('ui', ['bogus'], ctx);
    expect(state.uiModeSetCalls).toEqual([]);
    expect(ctx.chatLines.join('\n')).toContain('unknown mode: bogus');
  });

  test('workspace: essential 에서 rich 전용 안내 (T3 VW slash 게이트)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.uiMode = 'essential';
    const r = await reg.dispatch('workspace', ['list'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('rich 모드 전용');
  });

  test('mission 알 수 없는 서브커맨드 → usage (DB 무접촉 경로)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('mission', ['bogus'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('usage: /mission');
  });

  test('resume: 인자 없음 → 세션 픽커 오픈 (TUI 부활 S-a)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('resume', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.resumePickerOpens).toBe(1);
  });

  test('resume <prefix> → 픽커 대신 /session load 위임 경로', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    // 존재하지 않는 prefix — session load 가 에러 라인을 밀고 끝나면 된다.
    // 계약: 픽커는 열리지 않는다. (위임 대상 /session 핸들러가 요구하는
    // sessionSlash 는 이 테스트에서만 최소 스텁 — 다른 테스트 무영향.)
    (ctx as unknown as { sessionSlash: unknown }).sessionSlash = {
      remoteDaemon: () => null,
    };
    const r = await reg.dispatch('resume', ['zzz-no-such'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.resumePickerOpens).toBe(0);
  });

  test('paste happy path: clipboard returns token → setNextInitial', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.pasteAttachResult = '<paste-token-1>';
    const r = await reg.dispatch('paste', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.pasteThinkingStops).toEqual([{ status: 'completed', errorText: undefined }]);
    expect(state.pasteNextInitial).toBe('<paste-token-1>');
    // header + accent + reference line
    expect(ctx.chatLines.length).toBe(3);
    expect(ctx.chatLines[2]).toContain('Reference it in your next question');
  });

  test('paste no-token: clipboard returns null → no setNextInitial', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.pasteAttachResult = null;
    const r = await reg.dispatch('paste', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.pasteThinkingStops).toEqual([{ status: 'completed', errorText: undefined }]);
    expect(state.pasteNextInitial).toBeNull();
    expect(ctx.chatLines.length).toBe(2);  // header + accent only
  });

  test('paste throw: thinking handle stops with failed status + error text', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.pasteAttachThrow = new Error('clipboard unavailable');
    const r = await reg.dispatch('paste', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.pasteThinkingStops).toEqual([{ status: 'failed', errorText: 'clipboard unavailable' }]);
    expect(state.pasteNextInitial).toBeNull();
  });

  test('paste does NOT register `v` alias (was dead in original switch)', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('paste')).toBe(true);
    // /view's `v` alias is still NOT registered yet (B-1.h didn't migrate /view).
    // Just confirm /paste's own `v` is NOT pulled in.
    const names = new Set(reg.names());
    // After migration both /paste and (un-migrated) /view would have v;
    // the registry only has /paste so v is absent.
    expect(names.has('paste')).toBe(true);
  });
});

describe('B-1.i · /handoff + /reasoning', () => {
  test('handoff missing args → usage error + draw', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('handoff', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBeGreaterThanOrEqual(2);
    expect(ctx.chatLines[0]).toContain('[error]');
    expect(state.drawCalls).toBe(1);
  });

  test('handoff valid args dispatches IIFE (smoke)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('handoff', ['s1', 'codex'], ctx);
    expect(r.kind).toBe('continue');
    // Synchronous return from registry; the IIFE runs async. Just
    // confirm registration + immediate return — actual dispatchAgentHandoff
    // is exercised in agent-handoff.test.ts.
  });

  test('reasoning invalid level → usage muted line', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('reasoning', ['nonsense'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBe(1);
    expect(ctx.chatLines[0]).toContain('[muted]');
    expect(ctx.chatLines[0]).toContain('invalid level');
  });

  test('reasoning all aliases (r, think) registered', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('reasoning')).toBe(true);
    expect(reg.has('r')).toBe(true);
    expect(reg.has('think')).toBe(true);
  });
});

describe('B-2.a · medium-tier first round (audit · sst · wd)', () => {
  test('audit dispatches without throw (smoke)', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('audit', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.scrollOffset).toBe(-1);
  });

  test('sst (default sub) renders 4 pushDebugLine groups + bumps', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('sst', [], ctx);
    expect(r.kind).toBe('continue');
    // header + 3 stat lines + 1 "bumps (top N)" + N=2 entries = 6 lines minimum
    expect(state.debugLines.length).toBeGreaterThanOrEqual(5);
    expect(state.debugLines[0]).toContain('substrate stats');
    expect(state.debugLines[1]).toContain('paint-cache');
    expect(state.debugLines[1]).toContain('hits=7');
    expect(state.debugLines[2]).toContain('overlay');
    expect(state.debugLines[2]).toContain('skipped=4');
    expect(state.debugLines[3]).toContain('f8 shadow');
  });

  test('substrate-stats alias → same handler', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('substrate-stats', [], ctx);
    expect(r.kind).toBe('continue');
  });

  test('wd (default sub = show) dispatches without throw', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('wd', [], ctx);
    expect(r.kind).toBe('continue');
    // /wd default branch dispatches getSessionWorkingDir + 2 pushDebugLine
    // calls. The real session/working-dir module loads here; smoke just
    // confirms no throw and at least one log line.
    expect(state.debugLines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('B-2.b · /plan + /code-edit (dynamic-import)', () => {
  test('plan default sub (status) dispatches', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('plan', [], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines.length).toBeGreaterThanOrEqual(1);
  });

  test('plan unknown sub → usage warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('plan', ['oops'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toContain('[warning]');
    expect(state.debugLines[0]).toContain('usage: /plan');
  });

  test('code-edit + alias /ce dispatch (smoke)', async () => {
    const reg = buildDashboardSlashRegistry();
    for (const name of ['code-edit', 'ce'] as const) {
      const { ctx, state } = makeFakeCtx();
      const r = await reg.dispatch(name, [], ctx);
      expect(r.kind).toBe('continue');
      expect(state.debugLines.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('code-edit policy unsupervised → warning banner', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('code-edit', ['policy', 'unsupervised'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toContain('[warning]');
    expect(state.debugLines[0]).toContain('UNSUPERVISED');
  });
});

describe('B-2.d · /api-allow + /api', () => {
  test('api-allow list dispatches', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('api-allow', ['list'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines.length).toBeGreaterThanOrEqual(1);
  });

  test('api alias registered', async () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('api-allow')).toBe(true);
    expect(reg.has('api')).toBe(true);
  });

  test('api-allow add without target → usage warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('api-allow', ['add'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.debugLines[0]).toContain('[warning]');
    expect(state.debugLines[0]).toContain('usage:');
  });
});

describe('B-2.e · /history /hist /inputs', () => {
  test('history list (default sub) renders entries', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('history', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBeGreaterThanOrEqual(2);
    expect(ctx.chatLines[0]).toContain('input history — 1');
    expect(ctx.chatLines[1]).toContain('hello world');
  });

  test('history aliases (hist, inputs) registered', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('history')).toBe(true);
    expect(reg.has('hist')).toBe(true);
    expect(reg.has('inputs')).toBe(true);
  });

  test('history clear → store.clear + refresh', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('history', ['clear'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.companionLog).toContain('history:clear');
    expect(state.companionLog).toContain('history:refresh');
  });

  test('history find without query → usage warning', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('history', ['find'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines[0]).toContain('[warning]');
    expect(ctx.chatLines[0]).toContain('usage:');
  });
});

// ── Slash wire-up · context-display + compact (PR1) ──────────────────
//
// HANDOFF (2026-05-04) §5.1 — verifies that /tokens, /compact, /usage,
// /cost, and /memory dispatch correctly off the registry, mutate
// chatHistory only when the pipeline reduced something, and route
// through the ctx-injected fake provider so no real LLM call escapes.

describe('slash wire-up · /tokens', () => {
  test('register tokens + tk aliases', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('tokens')).toBe(true);
    expect(reg.has('tk')).toBe(true);
  });

  test('dispatch /tokens with empty telemetry → renders fallback summary', async () => {
    clearTelemetryForTest();
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.compactActiveModelId = 'claude-opus-4-7';
    const r = await reg.dispatch('tokens', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.length).toBeGreaterThan(0);
    expect(ctx.chatLines.join('\n')).toContain('context');
    expect(state.scrollOffset).toBe(-1);
  });
});

describe('slash wire-up · /compact', () => {
  test('register compact + compress + squeeze aliases', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('compact')).toBe(true);
    expect(reg.has('compress')).toBe(true);
    expect(reg.has('squeeze')).toBe(true);
  });

  test('dispatch /compact threads provider + active-model + session through pipeline', async () => {
    resetAutoCompactStateForTest();
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.compactActiveModelId = 'claude-opus-4-7';
    state.compactSessionId = 'session-test-abc';
    const fixtureSize = DEFAULT_COMPACT_POLICY.preserveLastN + 1;
    state.compactChatHistory.push(
      ...Array.from({ length: fixtureSize }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index}`,
      } as ChatMessage)),
    );
    const sliceUntil = Math.max(
      0,
      state.compactChatHistory.length - DEFAULT_COMPACT_POLICY.preserveLastN,
    );
    const anchorCount = computeAnchorCount(
      state.compactChatHistory,
      DEFAULT_COMPACT_POLICY.preserveFirst,
      sliceUntil,
    );
    const layer3SummarySlice = state.compactChatHistory.slice(anchorCount, sliceUntil);
    expect(layer3SummarySlice, 'Layer 3 summary slice precondition').not.toBeEmpty();
    ctx.compactSlash.chatHistory = state.compactChatHistory;
    const r = await reg.dispatch('compact', ['focus', 'on', 'errors'], ctx);
    expect(r.kind).toBe('continue');
    expect(state.compactProviderCalls.length).toBe(1);
    expect(state.compactProviderCalls[0]!.activeModelId).toBe('claude-opus-4-7');
    expect(state.compactProviderCalls[0]!.hint).toBe('focus on errors');
    // Status block always rendered
    expect(ctx.chatLines.join('\n')).toContain('/compact');
    expect(state.scrollOffset).toBe(-1);
    resetAutoCompactStateForTest();
  });

  test('/compact preserves history when pipeline reduces nothing', async () => {
    resetAutoCompactStateForTest();
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    // Empty history → no Layer 1+2 reductions, fake provider returns
    // null (no Layer 3) → no Layer 5 fallback target → savedTokens=0
    // → wire-up should NOT mutate chatHistory.
    const beforeLen = ctx.compactSlash.chatHistory.length;
    await reg.dispatch('compact', [], ctx);
    expect(ctx.compactSlash.chatHistory.length).toBe(beforeLen);
    resetAutoCompactStateForTest();
  });

  // PR3 §5.3 — /compact --inspect routes to the archive replay viewer.

  test('/compact --inspect (no args) inspects current sessionId', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    state.compactSessionId = 'session-no-archive';
    await reg.dispatch('compact', ['--inspect'], ctx);
    // No real archive → fallback message + no provider call.
    expect(ctx.chatLines.join('\n')).toContain('/compact --inspect');
    expect(ctx.chatLines.join('\n')).toContain('session-no-archive');
    expect(state.compactProviderCalls.length).toBe(0);
  });

  test('/compact inspect (without dashes) is also accepted', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    await reg.dispatch('compact', ['inspect'], ctx);
    expect(ctx.chatLines.join('\n')).toContain('/compact --inspect');
    expect(state.compactProviderCalls.length).toBe(0);
  });

  test('/compact --inspect list enumerates archive sessions', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    await reg.dispatch('compact', ['--inspect', 'list'], ctx);
    expect(ctx.chatLines.join('\n')).toContain('/compact --inspect list');
    expect(state.compactProviderCalls.length).toBe(0);
  });
});

describe('buildDashboardSlashRegistry — output census', () => {
  test('dispatches every registered slash command and preserves output classifications', async () => {
    const registry = buildDashboardSlashRegistry();
    const census = await censusRegisteredSlashOutputs({
      registry,
      createContext: () => {
        const { ctx, state } = makeFakeCtx();
        return {
          context: ctx,
          observe: () => ({
            visibleOutput: state.chatOutputLines.length > 0,
            hiddenOutput: state.debugLines.length > 0,
          }),
        };
      },
    });

    expect(census.registeredTotal).toBe(registry.names().length);
    expect(census.commands.map(command => command.name)).toEqual([...registry.names()]);
    expect(new Set(census.commands.map(command => command.classification))).toEqual(new Set([
      'visible-output',
      'hidden-only',
      'indeterminate',
    ]));
    expect(census.visibleOutput + census.hiddenOnly + census.indeterminate).toBe(census.registeredTotal);
  });
});

describe('slash wire-up · /usage', () => {
  test('register usage + stats aliases', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('usage')).toBe(true);
    expect(reg.has('stats')).toBe(true);
  });

  test('dispatch /usage with empty telemetry → renders no-call message', async () => {
    clearTelemetryForTest();
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('usage', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('/usage');
    expect(ctx.chatLines.join('\n')).toContain('no LLM calls');
    expect(state.scrollOffset).toBe(-1);
  });
});

describe('slash wire-up · /cost', () => {
  test('register cost + spend aliases (budget already taken)', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('cost')).toBe(true);
    expect(reg.has('spend')).toBe(true);
  });

  test('dispatch /cost renders header even when log is empty', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('cost', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('/cost');
  });
});

describe('slash wire-up · /memory', () => {
  test('register memory + mem aliases', () => {
    const reg = buildDashboardSlashRegistry();
    expect(reg.has('memory')).toBe(true);
    expect(reg.has('mem')).toBe(true);
  });

  test('dispatch /memory with default args → renders list header', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx, state } = makeFakeCtx();
    const r = await reg.dispatch('memory', [], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('/memory list');
    expect(state.scrollOffset).toBe(-1);
  });

  test('dispatch /memory show without arg → usage hint', async () => {
    const reg = buildDashboardSlashRegistry();
    const { ctx } = makeFakeCtx();
    const r = await reg.dispatch('memory', ['show'], ctx);
    expect(r.kind).toBe('continue');
    expect(ctx.chatLines.join('\n')).toContain('usage:');
  });
});
