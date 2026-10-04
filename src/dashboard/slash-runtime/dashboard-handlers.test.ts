import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../project/project-store.js';
import { CardStore } from '../../task-cards/card-store.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import type { FoldMode } from '../../log-entry.js';
import { resolveSurfaceUx } from '../../agent/surface-ux/build.js';
import { debug } from '../../debug/log.js';
import { DEFAULT_THEME_TOKENS } from '../../theme/tokens.js';
import { listThemes } from '../../themes/index.js';
import type { QuestionChannel } from '../../hitl/question.js';
import { displayedSlashCommandNames, SLASH_COMMANDS } from '../../chat/index.js';
import {
  applyClarificationReply,
  parseGoalDocumentClarifications,
  type GoalDocumentClarification,
} from '../../self-implement/goal-author-clarification.js';
import {
  buildDashboardSlashRegistry,
  DASHBOARD_SLASH_CATALOG_BASELINE,
  readDashboardAskClarification,
  type DashboardSlashContext,
} from './dashboard-handlers.js';
import { executeImmediateDashboardSlash } from '../input/slash-executor.js';
import { createDashboardLogWidgetRuntime } from '../log-widget-runtime.js';
import type { LogSurfaceStateContract } from '../../widgets/contracts/log-surface.js';
import { checkSlashCatalogBaseline } from './registry.js';
import type { dashboardLoops } from '../../domains/dashboard-data.js';

type AskLaunchInput = {
  entrance: { id: 'tui-slash-ask'; status: 'live'; surface: 'slash'; stampability: 'stampable' };
  inputSource: 'say';
  askText: string;
  liveRunWindowMinutes: number;
  recentChangeWindowDays: number;
  forceRequested: boolean;
  decomposeBeforeLaunch: boolean;
};

const runAskLaunchFlow = mock(async (_input: AskLaunchInput, _deps: unknown) => ({ kind: 'stopped-before-authoring' }));
const runGoalAuthorCli = mock(async (_parts: string[], _options: unknown) => ({ path: 'goals/example.md' }));
const buildDevCliSpec = mock((input: unknown, _executor: unknown, options: unknown) => ({ input, options }));
const runDevPipeline = mock(async (spec: unknown) => ({ kind: 'planned', spec }));
const queryRunningRuns = mock((_options: unknown) => ({ counts: { running: 1, 'probable-running': 1 } }));
const renderRunningRuns = mock((_result: unknown) => 'running runs: 2 confirmed: 1 probable: 1 countedStatuses=running,probable-running\nrunId=run-live');
const listHarnessScreens = mock(() => [{ spaceId: 'space-123' }]);
const enqueueSoftStop = mock((_spaceId: string) => {});
const enqueueControlMemo = mock((_spaceId: string, _memo: unknown) => {});
const readAskPreflightLogRows = mock(async () => []);
const buildAskPreflightDeps = mock(async () => ({}));
const priorBlockSamplesFrom = mock(() => []);
const recentAuthoringSamplesFrom = mock(() => []);
mock.module('../../self-dev/ask-launch-flow.js', () => ({ runAskLaunchFlow }));
mock.module('../../self-implement/goal-author-cli.js', () => ({ runGoalAuthorCli }));
mock.module('../../self-dev/dev-cli.js', () => ({ buildDevCliSpec }));
mock.module('../../self-dev/dev-pipeline.js', () => ({ runDevPipeline }));
mock.module('../../self-implement/running-runs.js', () => ({ queryRunningRuns, renderRunningRuns }));
mock.module('../../harness/harness-screen.js', () => ({ listHarnessScreens }));
mock.module('../../harness/control-inbox.js', () => ({ enqueueSoftStop, enqueueControlMemo }));
mock.module('../../self-dev/ask-launch-io.js', () => ({
  readAskPreflightLogRows,
  buildAskPreflightDeps,
  priorBlockSamplesFrom,
  recentAuthoringSamplesFrom,
}));
mock.module('../../self-dev/launch-preflight.js', () => ({
  prepareAskLaunch: () => ({ liveRunWindowMinutes: 30, recentChangeWindowDays: 7 }),
}));
let restoreDebugSpies = () => {};

beforeEach(() => {
  const spies = [
    spyOn(debug, 'log').mockImplementation(() => {}),
    spyOn(debug, 'status').mockReturnValue({
      file: false,
      mirror: false,
      verbose: false,
      diag: false,
      renderSuppressed: false,
      level: 'off',
      path: '/tmp/debug.log',
      buffered: 0,
      bytesWritten: 0,
    }),
    spyOn(debug, 'setMirror').mockImplementation(() => {}),
    spyOn(debug, 'isMirrorEnabled').mockReturnValue(false),
    spyOn(debug, 'setFileEnabled').mockImplementation(() => {}),
    spyOn(debug, 'isFileEnabled').mockReturnValue(false),
    spyOn(debug, 'path').mockReturnValue('/tmp/debug.log'),
    spyOn(debug, 'setDiagEnabled').mockImplementation(() => {}),
    spyOn(debug, 'isDiagEnabled').mockReturnValue(false),
    spyOn(debug, 'enable').mockImplementation(() => {}),
    spyOn(debug, 'disable').mockImplementation(() => {}),
    spyOn(debug, 'setVerboseEnabled').mockImplementation(() => {}),
    spyOn(debug, 'isVerboseEnabled').mockReturnValue(false),
    spyOn(debug, 'toggle').mockReturnValue(false),
    spyOn(debug, 'setLevel').mockImplementation(() => {}),
    spyOn(debug, 'level').mockReturnValue('off'),
    spyOn(debug, 'setKeyTraceEnabled').mockImplementation(() => {}),
    spyOn(debug, 'isKeyTraceEnabled').mockReturnValue(false),
    spyOn(debug, 'setRenderSuppressed').mockImplementation(() => {}),
    spyOn(debug, 'isRenderSuppressed').mockReturnValue(false),
    spyOn(debug, 'tail').mockReturnValue([]),
    spyOn(debug, 'clear').mockImplementation(() => {}),
  ];
  restoreDebugSpies = () => { for (const spy of spies) spy.mockRestore(); };
});

afterEach(() => {
  restoreDebugSpies();
});

function createContext(
  lines: string[],
  surfaceUx?: DashboardSlashContext['surfaceUx'],
  debugLines?: string[],
): DashboardSlashContext {
  let logFoldMode: FoldMode = 'line';
  const debugSink = debugLines ?? [];
  const splitDestinations = debugLines !== undefined;
  return {
    chatLines: lines,
    ...(surfaceUx ? { surfaceUx } : {}),
    pushChatLine: (line: string) => { lines.push(line); },
    pushDebugLine: (line: string) => {
      debugSink.push(line);
      if (!splitDestinations) lines.push(line);
    },
    attachmentRowMap: { clear: () => {} },
    clearLogSearch: () => {},
    clearLogFilter: () => {},
    accent: (line: string) => line,
    warning: (line: string) => line,
    error: (line: string) => line,
    success: (line: string) => line,
    muted: (line: string) => line,
    text: (line: string) => line,
    setChatScrollOffset: () => {},
    draw: () => {},
    logSlash: {
      pushDebugBlank: () => {
        debugSink.push('');
        if (!splitDestinations) lines.push('');
      },
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
      chatLinesLength: () => lines.length,
      getLogTurnSeparatorMode: () => 'off',
      setLogTurnSeparatorMode: () => {},
      pushTurnSeparator: () => {},
      getLogFoldMode: () => logFoldMode,
      setLogFoldMode: (mode: FoldMode) => { logFoldMode = mode; },
      toggleSolo: () => false,
      copyEntireLog: async () => {},
      returnFocusToInput: () => {},
    },
    debugSlash: {
      ensureToolCallSubscription: () => {},
    },
  } as unknown as DashboardSlashContext;
}

test('/loops uses the dashboardLoops API contract: category is mode, not owner; only proven owners match the filter', async () => {
  const registry = buildDashboardSlashRegistry();
  expect(registry.has('loops')).toBe(true);
  expect(SLASH_COMMANDS.some(command => command.name === 'loops')).toBe(true);
  // handleDashboard('loops') serializes dashboardLoops() under `loops`.
  // Its LoopStatus contract has name/label/armed/category/last, but no owner.
  const apiLoops: NonNullable<ReturnType<typeof dashboardLoops>> = {
    loops: [{ name: 'dig', label: 'Dig', armed: true, category: 'exec', today: 1,
      byStatus: { done: 1 }, last: { at: '2026-01-01T00:00:00Z', status: 'done' } }],
    generatedAt: '2026-01-01T00:00:00Z',
  };
  const lines: string[] = [];
  const ctx = createContext(lines);
  ctx.error = (text) => `<red>${text}</red>`;
  ctx.sessionSlash = { remoteDaemon: () => ({ url: 'ws://127.0.0.1:3020/acp', token: 'secret' }) } as DashboardSlashContext['sessionSlash'];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    if (String(url).endsWith('/v1/dashboard/loops')) return new Response(JSON.stringify({ ok: true, loops: apiLoops }), { status: 200 });
    return new Response(JSON.stringify({ schedules: [
      { name: 'heartbeat', domain: 'ops', runVia: 'crontab', source: 'crontab', registryEnabled: true, state: 'live',
        lastRun: { at: '2026-01-01T00:00:00Z', status: 'error', exit: 1 }, intervalMs: 60_000 },
      { name: 'markets', domain: 'finance', runVia: 'crontab', source: 'crontab', registryEnabled: true, state: 'live', lastRun: null },
    ] }), { status: 200 });
  }) as typeof fetch;
  try {
    await registry.dispatch('loops', [], ctx);
    expect(lines.join('\n')).toContain('LAYER');
    expect(lines.join('\n')).toContain('OWNER');
    expect(lines.join('\n')).toContain('MODE');
    expect(lines.join('\n')).toContain('LAST RUN');
    expect(lines.join('\n')).toContain('VERDICT');
    expect(lines.find(line => line.includes('Dig'))).toMatch(/daemon loop\s+Dig\s+—\s+exec\s+/);
    lines.length = 0;
    await registry.dispatch('loops', ['ops'], ctx);
    expect(lines.join('\n')).toContain('daemon cron');
    expect(lines.join('\n')).toContain('heartbeat');
    expect(lines.join('\n')).toContain('<red>failed</red>');
    expect(lines.join('\n')).not.toContain('markets');
    expect(lines.join('\n')).not.toContain('Dig');
    lines.length = 0;
    await registry.dispatch('loops', ['finance'], ctx);
    expect(lines.join('\n')).toContain('markets');
    expect(lines.join('\n')).not.toContain('Dig');
    expect(lines.join('\n')).not.toContain('heartbeat');
  } finally { globalThis.fetch = previousFetch; }
});

test('/loops daemon cron uses calendar due instants rather than future interval across a weekend', async () => {
  const lines: string[] = [];
  const ctx = createContext(lines);
  ctx.sessionSlash = { remoteDaemon: () => ({ url: 'ws://127.0.0.1:3020/acp', token: undefined }) } as DashboardSlashContext['sessionSlash'];
  ctx.loopsLocalRows = () => [];
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let currentTime = '2026-01-10T12:00:00Z';
  Date.now = () => Date.parse(currentTime);
  globalThis.fetch = (async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).includes('/v1/schedules') ? { schedules: [{
      name: 'weekday', domain: 'ops', runVia: 'crontab', source: 'crontab', cron: '0 9 * * 1-5', state: 'live',
      lastRun: { at: '2026-01-09T09:00:00Z', status: 'ok', exit: 0 }, intervalMs: 86_400_000,
    }] } : { loops: { loops: [] } },
  ), { status: 200 })) as typeof fetch;
  try {
    await buildDashboardSlashRegistry().dispatch('loops', ['ops'], ctx);
    expect(lines.find(line => line.includes('weekday'))).toMatch(/daemon cron\s+weekday\s+ops\s+crontab\s+2026-01-09T09:00:00Z\s+alive/);
    lines.length = 0;
    currentTime = '2026-01-13T09:01:00Z';
    await buildDashboardSlashRegistry().dispatch('loops', ['ops'], ctx);
    expect(lines.find(line => line.includes('weekday'))).toContain('late');
  } finally { globalThis.fetch = previousFetch; Date.now = previousNow; }
});

test('/loops displays local rows and the other daemon registry when schedules never respond, even if fetch ignores abort', async () => {
  const lines: string[] = [];
  const ctx = createContext(lines);
  ctx.sessionSlash = { remoteDaemon: () => ({ url: 'ws://127.0.0.1:3020/acp', token: undefined }) } as DashboardSlashContext['sessionSlash'];
  ctx.loopsLocalRows = () => [{ layer: 'local loop', name: 'local-pulse', owner: 'ops', mode: 'event', lastRun: null, verdict: 'alive' }];
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    if (String(url).includes('/v1/schedules')) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ loops: { loops: [
      { name: 'dig', label: 'Remote dig', armed: true, category: 'exec', last: null },
    ] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const completion = await Promise.race([
      buildDashboardSlashRegistry().dispatch('loops', [], ctx).then(() => 'completed'),
      Bun.sleep(3000).then(() => 'timed out'),
    ]);
    expect(completion).toBe('completed');
    expect(requested.some(url => url.endsWith('/v1/dashboard/loops'))).toBe(true);
    expect(lines.join('\n')).toContain('daemon cron unavailable:');
    expect(lines.join('\n')).toContain('Remote dig');
    expect(lines.join('\n')).toContain('local-pulse');
    expect(lines.join('\n')).toContain('VERDICT');
  } finally { globalThis.fetch = previousFetch; }
});

test('/loops displays local rows when both daemon responses stall', async () => {
  const lines: string[] = [];
  const ctx = createContext(lines);
  ctx.sessionSlash = { remoteDaemon: () => ({ url: 'ws://127.0.0.1:3020/acp', token: undefined }) } as DashboardSlashContext['sessionSlash'];
  ctx.loopsLocalRows = () => [{ layer: 'local cron', name: 'local-ops', owner: 'ops', mode: 'crontab', lastRun: null, verdict: 'late' }];
  ctx.error = text => `<red>${text}</red>`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  try {
    const completion = await Promise.race([
      buildDashboardSlashRegistry().dispatch('loops', ['ops'], ctx).then(() => 'completed'),
      Bun.sleep(3000).then(() => 'timed out'),
    ]);
    expect(completion).toBe('completed');
    expect(lines.join('\n')).toContain('daemon cron unavailable:');
    expect(lines.join('\n')).toContain('daemon loops unavailable:');
    expect(lines.join('\n')).toContain('local-ops');
    expect(lines.join('\n')).toContain('<red>late</red>');
  } finally { globalThis.fetch = previousFetch; }
});

test('/wish follows /now in the visible catalog and registers on the human dashboard', () => {
  const names = SLASH_COMMANDS.map(({ name }) => name);
  expect(names[names.indexOf('now') + 1]).toBe('wish');
  expect(buildDashboardSlashRegistry().has('wish')).toBe(true);
});

test('/wish shows usage without writing a card when arguments are empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-wish-slash-empty-'));
  const store = new CardStore(root);
  try {
    const lines: string[] = [];
    const ctx = createContext(lines);
    ctx.wishCardStore = store;
    const registry = buildDashboardSlashRegistry();
    await registry.dispatch('wish', [], ctx);
    await registry.dispatch('wish', ['   '], ctx);
    expect(lines).toEqual(['  usage: /wish <소원 한 줄>', '  usage: /wish <소원 한 줄>']);
    expect(store.listCards()).toHaveLength(0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/wish creates distinct TUI cards for separate submissions, including identical text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-wish-slash-create-'));
  const store = new CardStore(root);
  try {
    const lines: string[] = [];
    const ctx = createContext(lines);
    ctx.wishCardStore = store;
    const registry = buildDashboardSlashRegistry();
    await registry.dispatch('wish', ['새', '소원'], ctx);
    await registry.dispatch('wish', ['새', '소원'], ctx);
    expect(lines).toEqual([
      '  소원 카드로 남겼습니다 — 새 소원',
      '  소원 카드로 남겼습니다 — 새 소원',
    ]);
    const cards = store.listCards();
    expect(cards).toHaveLength(2);
    expect(cards.every(card => card.goalId.startsWith('wish:tui:'))).toBe(true);
    expect(new Set(cards.map(card => card.goalId)).size).toBe(2);
    for (const card of cards) {
      expect(card.sections.map(section => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
      expect(JSON.parse(card.sections[0]!.content)).toMatchObject({ source: 'tui', text: '새 소원' });
      expect(JSON.parse(card.sections[1]!.content)).toEqual({ surface: 'tui', address: null });
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/session new suggests a matching project once without assigning it to a session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-tui-project-suggestion-'));
  const lines: string[] = [];
  const project = new ProjectStore(root).create({ name: 'TUI Workspace', primaryFolder: process.cwd() });
  const ctx = createContext(lines);
  let attached: string | null = null;
  const history = [{ role: 'system', content: 'prompt' }, { role: 'user', content: 'old' }];
  ctx.getAttachedSessionId = () => attached;
  ctx.setAttachedSessionId = (id) => { attached = id; };
  ctx.setAttachedChatId = () => {};
  ctx.compactSlash = { chatHistory: history } as DashboardSlashContext['compactSlash'];
  ctx.sessionSlash = { remoteDaemon: () => null } as DashboardSlashContext['sessionSlash'];
  setElanousConfigDir(root);
  try {
    await buildDashboardSlashRegistry().dispatch('session', ['new'], ctx);
    expect(lines.filter(line => line.includes('Project suggestion: TUI Workspace'))).toHaveLength(1);
    expect(lines.join('\n')).toContain(project.id);
    expect(history).toEqual([{ role: 'system', content: 'prompt' }]);
    expect(attached).toBeNull();
    expect(new ProjectStore(root).get(project.id)).toEqual(project);
    lines.length = 0;
    await buildDashboardSlashRegistry().dispatch('session', ['clear'], ctx);
    expect(lines.join('\n')).not.toContain('Project suggestion:');
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('/dashboard followed by /chat restores the chat layout (no /ui mode axis)', async () => {
  const lines: string[] = [];
  let chatOnlyMode = true;
  const transitions: boolean[] = [];
  const ctx = createContext(lines);
  ctx.getChatOnlyMode = () => chatOnlyMode;
  ctx.setChatOnlyLayout = (next) => { chatOnlyMode = next; transitions.push(next); };
  const registry = buildDashboardSlashRegistry();
  expect(registry.has('ui')).toBe(false);
  expect(registry.has('workspace')).toBe(false);
  await registry.dispatch('dashboard', [], ctx);
  expect(chatOnlyMode).toBe(false);
  await registry.dispatch('chat', [], ctx);
  expect(chatOnlyMode).toBe(true);
  expect(transitions).toEqual([false, true]);
});

test('/theme mirrors list output to ChatLog while preserving debug output', async () => {
  const preset = listThemes()[0];
  expect(preset).toBeDefined();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = {
    ...createContext(chatLines),
    theme: {
      pluginContributions: () => [],
      currentTokens: () => ({}),
      requestRender: () => {},
    },
    pushDebugLine: (line: string) => { debugLines.push(line); },
  } as DashboardSlashContext;

  await expect(buildDashboardSlashRegistry().dispatch('theme', ['list'], context))
    .resolves.toEqual({ kind: 'continue' });

  const expectedDebugLines = [
    '❯ /theme list',
    `* default  ${DEFAULT_THEME_TOKENS.name}`,
    ...listThemes().map((theme) => {
      const tags = [theme.isDark ? 'dark' : '', theme.isPastel ? 'pastel' : ''].filter(Boolean);
      return `  ${theme.name}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}  (preset)`;
    }),
  ];
  expect(chatLines).not.toEqual([]);
  expect(chatLines.some((line) => line.includes(preset!.name))).toBe(true);
  expect(debugLines).toEqual(expectedDebugLines);
  expect(chatLines).toEqual(expectedDebugLines);
});

test('/theme mirrors an unknown preset error to ChatLog', async () => {
  const chatLines: string[] = [];
  const context = createContext(chatLines);
  context.pushDebugLine = () => {};

  await expect(buildDashboardSlashRegistry().dispatch('theme', ['switch', 'missing-preset'], context))
    .resolves.toEqual({ kind: 'continue' });

  expect(chatLines.some((line) => line.includes("is not a registered preset"))).toBe(true);
});

test('SurfaceUx clarification bridge prefers selected options, accepts permitted Other text, and defers empty responses', async () => {
  const clarification: GoalDocumentClarification = {
    questionId: 'scope', header: '범위', question: '선택하세요', includeOther: true,
    options: [{ label: 'small', description: '작게' }, { label: 'full', description: '전체' }],
    answer: '', answered: false, answerLine: 1,
  };
  const asked: unknown[] = [];
  const answer = await readDashboardAskClarification(clarification, {
    question: async (request) => {
      asked.push(request);
      return { answers: { scope: 'full' }, otherText: { scope: 'custom answer' } };
    },
  });
  expect(answer).toBe('1');
  expect(asked).toHaveLength(1);
  const askedQuestion = (asked[0] as { questions: Array<Record<string, unknown>> }).questions[0];
  expect(askedQuestion).toEqual({
    id: 'scope',
    header: 'Clarify goal',
    question: '선택하세요',
    options: [
      { label: 'small', description: '작게' },
      { label: 'full', description: '전체' },
    ],
    includeOther: true,
  });
  await expect(readDashboardAskClarification(clarification, {
    question: async () => ({ answers: {}, otherText: { scope: 'custom answer' } }),
  })).resolves.toBe('custom answer');
  await expect(readDashboardAskClarification(clarification, {
    question: async () => ({ answers: { scope: 'small' } }),
  })).resolves.toBe('0');
  await expect(readDashboardAskClarification(clarification, {
    question: async () => ({ answers: {}, cancelled: true }),
  })).resolves.toBe('');
  await expect(readDashboardAskClarification(clarification, {
    question: async () => { throw new Error('unavailable'); },
  })).resolves.toBe('');
  await expect(readDashboardAskClarification(clarification, undefined)).resolves.toBe('');
});

test('Dashboard bridge uses the real SurfaceUx question channel and records answered observation', async () => {
  const clarification: GoalDocumentClarification = {
    questionId: 'scope', header: '범위', question: '무엇을 고칠까요?', includeOther: false,
    options: [{ label: 'minimal', description: '최소 변경' }], answer: '', answered: false, answerLine: 1,
  };
  const channel: QuestionChannel = {
    name: 'telegram',
    ask: async (request) => ({ answers: { [request.questions[0]!.id]: 'minimal' } }),
    cancel: () => {},
  };
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const ux = resolveSurfaceUx({ surface: 'tui', surfaceQuestionChannels: [channel] });
    await expect(readDashboardAskClarification(clarification, ux)).resolves.toBe('0');
    expect(log).toHaveBeenCalledWith('surface-ux.confirm', 'question', {
      surface: 'tui', mode: 'answered',
    });
  } finally {
    log.mockRestore();
  }
});

test('SurfaceUx bridge applies selected options and rejects Other text when the parser-derived clarification forbids it', async () => {
  const document = [
    '## Goal',
    'Keep this line unchanged.',
    '',
    '- Clarification:',
    '  - id: scope',
    '  - header: 범위',
    '  - question: 선택하세요',
    '  - options:',
    '    - label: minimal',
    '      description: 최소 변경',
    '    - label: full',
    '      description: 전체 변경',
    '  - includeOther: false',
    '  - answer: DEFERRED-UNTIL: 선택하세요',
    '',
    '## Preservation',
    'Keep this tail unchanged.',
    '',
  ].join('\n');
  const [clarification] = parseGoalDocumentClarifications(document);
  expect(clarification?.answerLine).toBe(13);

  const reply = await readDashboardAskClarification(clarification!, {
    question: async () => ({ answers: {}, otherText: { scope: 'forbidden free-form answer' } }),
  });
  expect(reply).toBe('');
  const deferred = applyClarificationReply(document, clarification!, reply);
  expect(deferred).toMatchObject({ answered: false, document });

  const selectedReply = await readDashboardAskClarification(clarification!, {
    question: async () => ({ answers: { scope: 'full' }, otherText: { scope: 'forbidden free-form answer' } }),
  });
  expect(selectedReply).toBe('1');
  const applied = applyClarificationReply(document, clarification!, selectedReply);
  const expected = document.replace(
    '  - answer: DEFERRED-UNTIL: 선택하세요',
    '  - answer: full\n  - provenance.source: injected',
  );
  expect(applied).toMatchObject({ answered: true, kind: 'option', document: expected });
  expect(parseGoalDocumentClarifications(applied.document)).toEqual([
    expect.objectContaining({ questionId: 'scope', answer: 'full', answered: true }),
  ]);
});

test('SurfaceUx bridge applies Other text only when parser-derived clarification permits it', async () => {
  const document = [
    '## Goal',
    'Keep this line unchanged.',
    '',
    '- Clarification:',
    '  - id: scope',
    '  - header: 범위',
    '  - question: 선택하세요',
    '  - options:',
    '    - label: minimal',
    '      description: 최소 변경',
    '  - includeOther: true',
    '  - answer: DEFERRED-UNTIL: 선택하세요',
    '',
    '## Preservation',
    'Keep this tail unchanged.',
    '',
  ].join('\n');
  const [clarification] = parseGoalDocumentClarifications(document);
  expect(clarification?.answerLine).toBe(11);

  const reply = await readDashboardAskClarification(clarification!, {
    question: async () => ({ answers: {}, otherText: { scope: 'focused implementation' } }),
  });
  const applied = applyClarificationReply(document, clarification!, reply);
  const expected = document.replace(
    '  - answer: DEFERRED-UNTIL: 선택하세요',
    '  - answer: focused implementation\n  - provenance.source: injected',
  );
  expect(applied).toMatchObject({ answered: true, kind: 'other', document: expected });
  expect(parseGoalDocumentClarifications(applied.document)).toEqual([
    expect.objectContaining({ questionId: 'scope', answer: 'focused implementation', answered: true }),
  ]);
});

test('harness enables structured clarification only when SurfaceUx is available', async () => {
  const registry = buildDashboardSlashRegistry();
  const goal = '대상 경로: src/a.ts 를 고친다';
  const ux = { question: async () => ({ answers: { choice: '1' } }) };

  await registry.dispatch('harness', ['ask', goal], createContext([], ux));
  await Bun.sleep(0);
  const [, interactiveDeps] = runAskLaunchFlow.mock.calls.at(-1)!;
  expect((interactiveDeps as { isInteractive(): boolean }).isInteractive()).toBe(true);
  await expect((interactiveDeps as { readClarification(clarification: GoalDocumentClarification): Promise<string> }).readClarification({
    questionId: 'choice', header: '선택', question: '질문', includeOther: false,
    options: [{ label: '1', description: '첫째' }], answer: '', answered: false, answerLine: 1,
  })).resolves.toBe('0');

  await registry.dispatch('harness', ['ask', goal], createContext([]));
  await Bun.sleep(0);
  const [, deferredDeps] = runAskLaunchFlow.mock.calls.at(-1)!;
  expect((deferredDeps as { isInteractive(): boolean }).isInteractive()).toBe(false);
  await expect((deferredDeps as { readLine(prompt: string): Promise<string> }).readLine('질문')).resolves.toBe('');
});

test('harness ask routes goal-author start progress to chat lines through its author wrapper', async () => {
  runAskLaunchFlow.mockClear();
  runGoalAuthorCli.mockClear();
  runAskLaunchFlow.mockImplementationOnce(async (_input, deps) => {
    await (deps as { authorGoal(args: string[], options: { cwd: string }): Promise<unknown> }).authorGoal(
      ['author this goal'],
      { cwd: process.cwd() },
    );
    return { kind: 'stopped-before-authoring' };
  });
  const lines: string[] = [];
  let scrollCalls = 0;
  let drawCalls = 0;
  const context = createContext(lines);
  context.setChatScrollOffset = () => { scrollCalls += 1; };
  context.draw = () => { drawCalls += 1; };

  await buildDashboardSlashRegistry().dispatch('harness', ['ask', 'ordinary goal'], context);
  await Bun.sleep(0);

  const [, options] = runGoalAuthorCli.mock.calls.at(-1)!;
  const onProgress = (options as { onProgress(phase: string, event: 'start' | 'end'): void }).onProgress;
  const scrollBeforeProgress = scrollCalls;
  const drawBeforeProgress = drawCalls;
  onProgress('ground', 'start');

  expect(lines).toContain('[goal-author] ground started');
  expect(scrollCalls).toBe(scrollBeforeProgress + 1);
  expect(drawCalls).toBe(drawBeforeProgress + 1);

  onProgress('ground', 'end');
  expect(lines).not.toContain('[goal-author] ground finished');
  expect(scrollCalls).toBe(scrollBeforeProgress + 1);
  expect(drawCalls).toBe(drawBeforeProgress + 1);
});

test('harness ask subcommand returns before the shared launch flow settles while its SurfaceUx modal clarification still round-trips', async () => {
  runAskLaunchFlow.mockClear();
  let settleLaunch: ((value: { kind: 'stopped-before-authoring' }) => void) | undefined;
  runAskLaunchFlow.mockImplementationOnce(() => new Promise((resolve) => { settleLaunch = resolve; }));
  const registry = buildDashboardSlashRegistry();
  const goal = '대상 경로: src/a.ts 를 고친다';
  const modalQuestions: unknown[] = [];

  await expect(registry.dispatch('harness', ['ask', goal], createContext([], {
    question: async (request) => {
      modalQuestions.push(request);
      return { answers: { scope: 'full' } };
    },
  }))).resolves.toEqual({ kind: 'continue' });
  await Bun.sleep(0);

  expect(runAskLaunchFlow).toHaveBeenCalledWith(expect.objectContaining({
    entrance: expect.objectContaining({ id: 'tui-slash-ask', status: 'live', surface: 'slash', stampability: 'stampable' }),
    inputSource: 'say',
    askText: goal,
    decomposeBeforeLaunch: true,
  }), expect.anything());
  const [, deps] = runAskLaunchFlow.mock.calls.at(-1)!;
  await expect((deps as { readClarification(clarification: GoalDocumentClarification): Promise<string> }).readClarification({
    questionId: 'scope', header: '범위', question: '무엇을 고칠까요?', includeOther: false,
    options: [{ label: 'minimal', description: '최소 변경' }, { label: 'full', description: '전체 변경' }],
    answer: '', answered: false, answerLine: 1,
  })).resolves.toBe('1');
  expect(modalQuestions).toHaveLength(1);
  settleLaunch!({ kind: 'stopped-before-authoring' });
});

test('harness ask reports preflight initialization failures and redraws without an unhandled rejection', async () => {
  readAskPreflightLogRows.mockRejectedValueOnce(new Error('preflight unavailable'));
  const lines: string[] = [];
  let scrollCalls = 0;
  let drawCalls = 0;
  const context = createContext(lines);
  context.setChatScrollOffset = () => { scrollCalls += 1; };
  context.draw = () => { drawCalls += 1; };

  await expect(buildDashboardSlashRegistry().dispatch('harness', ['ask', 'ordinary goal'], context))
    .resolves.toEqual({ kind: 'continue' });
  await Bun.sleep(0);

  expect(lines).toContain('  ✗ /ask 실패: preflight unavailable');
  expect(scrollCalls).toBeGreaterThan(0);
  expect(drawCalls).toBe(1);
});

test('harness is the only harness-launching slash command and its seven subcommands require arguments', async () => {
  const registry = buildDashboardSlashRegistry();
  expect(registry.has('harness')).toBe(true);
  for (const retiredName of ['implement', 'dev', 'ask', 'say']) expect(registry.has(retiredName)).toBe(false);

  const expected = [
    ['plan', '  usage: /harness plan <goal>'],
    ['ask', '  usage: /harness ask <무엇을 왜 고칠지 한 문장>'],
    ['goal', '  usage: /harness goal <goal-file>'],
    ['stop', '  usage: /harness stop <space-id>'],
    ['memo', '  usage: /harness memo <space-id> <note>'],
  ] as const;
  for (const [subcommand, line] of expected) {
    const lines: string[] = [];
    await registry.dispatch('harness', [subcommand], createContext(lines));
    expect(lines.some((value) => value.startsWith(line))).toBe(true);
  }
  const runLines: string[] = [];
  await registry.dispatch('harness', ['runs'], createContext(runLines));
  expect(runLines.some((value) => value.startsWith('  running runs:'))).toBe(true);
});

test('/harness implement is retired and directs users to harness ask without launching work', async () => {
  runAskLaunchFlow.mockClear();
  const runtimeCalls: unknown[] = [];
  const { _setSelfOrchestrateSlashRuntimeForTesting } = await import('./dashboard-handlers.js');
  _setSelfOrchestrateSlashRuntimeForTesting({ run: async (input: unknown) => {
    runtimeCalls.push(input);
    return { output: 'started' };
  } });
  try {
    for (const args of [['implement'], ['implement', 'retired', 'feature']]) {
      const lines: string[] = [];
      await buildDashboardSlashRegistry().dispatch('harness', args, createContext(lines));
      expect(lines).toEqual(['  /harness implement has moved to /harness ask <무엇을 왜 고칠지 한 문장>']);
    }
    expect(runAskLaunchFlow).not.toHaveBeenCalled();
    expect(runtimeCalls).toEqual([]);
  } finally {
    _setSelfOrchestrateSlashRuntimeForTesting(null);
  }
});

test('harness plan and goal reuse the CLI pipeline specs', async () => {
  buildDevCliSpec.mockClear();
  runDevPipeline.mockClear();
  const registry = buildDashboardSlashRegistry();
  await registry.dispatch('harness', ['plan', 'prepare', 'only'], createContext([]));
  await registry.dispatch('harness', ['goal', 'docs/goals/GOAL.md'], createContext([]));
  await Bun.sleep(0);
  expect(buildDevCliSpec).toHaveBeenNthCalledWith(1, { text: 'prepare only' }, { kind: 'self' }, { plan: true }, undefined, 'tui-slash-dev');
  expect(buildDevCliSpec).toHaveBeenNthCalledWith(2, { file: 'docs/goals/GOAL.md' }, { kind: 'self' }, {}, undefined, 'tui-slash-dev');
  expect(runDevPipeline).toHaveBeenCalledTimes(2);
});

test('harness sends a bare sentence to ask and reserves dev for its explicit subcommand', async () => {
  runAskLaunchFlow.mockClear();
  const calls: Array<{ goals: string[]; decompose: boolean }> = [];
  const { _setSelfOrchestrateSlashRuntimeForTesting } = await import('./dashboard-handlers.js');
  _setSelfOrchestrateSlashRuntimeForTesting({ run: async (input: { goals: string[]; decompose: boolean }) => {
    calls.push(input);
    return { output: 'started' };
  } });
  try {
    const emptyLines: string[] = [];
    await buildDashboardSlashRegistry().dispatch('harness', [], createContext(emptyLines));
    expect(emptyLines.some((line) => line.startsWith('  usage: /harness <무엇을 왜 고칠지 한 문장>'))).toBe(true);
    expect(calls).toEqual([]);
    expect(runAskLaunchFlow).not.toHaveBeenCalled();

    const goal = 'ordinary goal';
    await buildDashboardSlashRegistry().dispatch('harness', goal.split(' '), createContext([]));
    await Bun.sleep(0);
    expect(runAskLaunchFlow).toHaveBeenCalledWith(expect.objectContaining({ askText: goal }), expect.anything());
    expect(calls).toEqual([]);

    await buildDashboardSlashRegistry().dispatch('harness', ['dev', goal], createContext([]));
    await Bun.sleep(0);
    expect(calls).toEqual([{ goals: [goal], decompose: true }]);
  } finally {
    _setSelfOrchestrateSlashRuntimeForTesting(null);
  }
});

test('harness runs shows renderer summary before a capped run list and discloses truncation with the total', async () => {
  queryRunningRuns.mockClear();
  renderRunningRuns.mockClear();
  const lines: string[] = [];
  const runLines = Array.from({ length: 10 }, (_, index) => `runId=run-${index + 1}`);
  renderRunningRuns.mockReturnValueOnce(['summary first', ...runLines, 'summary last'].join('\n'));

  await buildDashboardSlashRegistry().dispatch('harness', ['runs'], createContext(lines));

  expect(lines).toEqual([
    '  summary first',
    '  summary last',
    ...runLines.slice(0, 8).map((line) => `  ${line}`),
    '  runs truncated: showing 8 of 10 total assessments',
  ]);
  expect(queryRunningRuns).toHaveBeenCalledWith({ includeTest: false, caller: 'dashboard' });
  expect(renderRunningRuns).toHaveBeenCalledWith(expect.anything());
});

test('harness runs does not report truncation when all run entries fit', async () => {
  const lines: string[] = [];
  renderRunningRuns.mockReturnValueOnce('summary only\nrunId=run-live');

  await buildDashboardSlashRegistry().dispatch('harness', ['runs'], createContext(lines));

  expect(lines).toEqual(['  summary only', '  runId=run-live']);
});

test('harness runs uses the established running predicate and validates stop and memo targets', async () => {
  queryRunningRuns.mockClear();
  renderRunningRuns.mockClear();
  listHarnessScreens.mockClear();
  enqueueSoftStop.mockClear();
  enqueueControlMemo.mockClear();
  const registry = buildDashboardSlashRegistry();

  await registry.dispatch('harness', ['runs'], createContext([]));
  expect(queryRunningRuns).toHaveBeenCalledWith({ includeTest: false, caller: 'dashboard' });
  expect(renderRunningRuns).toHaveBeenCalledWith(expect.anything());

  await registry.dispatch('harness', ['stop', 'space-123'], createContext([]));
  expect(enqueueSoftStop).toHaveBeenCalledWith('space-123');

  await registry.dispatch('harness', ['memo', 'space-123', 'watch', 'this'], createContext([]));
  expect(enqueueControlMemo).toHaveBeenCalledWith('space-123', {
    version: 1,
    kind: 'supervisor-note',
    urgency: 'normal',
    body: 'watch this',
  });

  listHarnessScreens.mockReturnValueOnce([{ spaceId: 'space-123' }]);
  const unknownStopLines: string[] = [];
  await registry.dispatch('harness', ['stop', 'missing-space'], createContext(unknownStopLines));
  expect(unknownStopLines).toEqual(['  unknown harness space: missing-space; available: space-123']);
  expect(enqueueSoftStop).toHaveBeenCalledTimes(1);

  listHarnessScreens.mockReturnValueOnce([{ spaceId: 'space-123' }]);
  const unknownMemoLines: string[] = [];
  await registry.dispatch('harness', ['memo', 'missing-space', 'watch'], createContext(unknownMemoLines));
  expect(unknownMemoLines).toEqual(['  unknown harness space: missing-space; available: space-123']);
  expect(enqueueControlMemo).toHaveBeenCalledTimes(1);
});

test('/log fold dispatch resolves mode, stores it, reports feedback, and resets scroll', async () => {
  const registry = buildDashboardSlashRegistry();
  const lines: string[] = [];
  let foldMode: FoldMode = 'line';
  let scrollResetCount = 0;
  const context = createContext(lines);
  context.setChatScrollOffset = (value) => {
    if (value === -1) scrollResetCount += 1;
  };
  context.logSlash.getLogFoldMode = () => foldMode;
  context.logSlash.setLogFoldMode = (mode) => { foldMode = mode; };

  await expect(registry.dispatch('log', ['fold', 'task-unit'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(foldMode as FoldMode).toBe('task-unit');
  expect(lines.at(-1)).toBe('  log fold mode → task-unit (task-unit folding (tool bodies collapsed to headers))');
  expect(scrollResetCount).toBe(1);

  await registry.dispatch('log', ['fold'], context);
  expect(foldMode as FoldMode).toBe('kind-unit');
  expect(lines.at(-1)).toBe('  log fold mode → kind-unit (kind-unit folding (adjacent same-kind operations collapsed together))');
  expect(scrollResetCount).toBe(2);

  await registry.dispatch('log', ['fold', 'bogus'], context);
  expect(foldMode as FoldMode).toBe('kind-unit');
  expect(lines.slice(-2)).toEqual([
    '  unknown log fold mode: bogus',
    '  /log fold line | task-unit | kind-unit',
  ]);
  expect(scrollResetCount).toBe(3);
});

test('dashboard catalog exposes /log fold in description and subcommands', () => {
  const log = SLASH_COMMANDS.find((command) => command.name === 'log');
  expect(log?.description).toContain('fold');
  expect(log?.subcommands).toContain('fold');
});

test('/log fold selected mode reaches the dashboard log widget render input', async () => {
  const registry = buildDashboardSlashRegistry();
  const lines: string[] = [];
  let foldMode: FoldMode = 'line';
  const context = createContext(lines);
  context.logSlash.getLogFoldMode = () => foldMode;
  context.logSlash.setLogFoldMode = (mode) => { foldMode = mode; };

  await expect(registry.dispatch('log', ['fold', 'task-unit'], context))
    .resolves.toEqual({ kind: 'continue' });

  const state = {
    lines,
    scrollOffset: -1,
    focused: false,
    scroll: 0,
  } as LogSurfaceStateContract & { scroll: number };
  createDashboardLogWidgetRuntime().syncMain(state, {
    lines,
    scrollOffset: -1,
    focused: false,
    footerLine: null,
    queueRow: null,
    logFrozenTailIndex: null,
    logSearchCursor: 0,
    logSearchResultsLength: 0,
    logFilterQuery: '',
    logSearchQuery: '',
    foldMode,
    clickDeps: null,
  });

  expect(state.foldMode).toBe('task-unit');
});

test('/log fold kind-unit stores the third mode and reports the coalescing meaning', async () => {
  const registry = buildDashboardSlashRegistry();
  const lines: string[] = [];
  let foldMode: FoldMode = 'line';
  const context = createContext(lines);
  context.logSlash.getLogFoldMode = () => foldMode;
  context.logSlash.setLogFoldMode = (mode) => { foldMode = mode; };

  await expect(registry.dispatch('log', ['fold', 'kind-unit'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(foldMode as FoldMode).toBe('kind-unit');
  expect(lines.at(-1)).toBe('  log fold mode → kind-unit (kind-unit folding (adjacent same-kind operations collapsed together))');
});

test('/log fold kind-unit replies on chat and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('log', ['fold', 'kind-unit'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.some((line) => line.includes('log fold mode'))).toBe(true);
  expect(debugLines).toEqual([]);
});

test('/log fold unknown mode replies on chat with usage and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('log', ['fold', 'zzz'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.some((line) => line.includes('unknown log fold mode'))).toBe(true);
  expect(chatLines).toContain('  /log fold line | task-unit | kind-unit');
  expect(debugLines).toEqual([]);
});

test('/log help replies on chat and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('log', ['help'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.length).toBeGreaterThan(0);
  expect(chatLines).toContain('');
  expect(debugLines).toEqual([]);
});

test('/debug mirror on replies on chat and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('debug', ['mirror', 'on'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.some((line) => line.includes('debug mirror: ON'))).toBe(true);
  expect(debugLines).toEqual([]);
});

test('/debug level replies on chat and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('debug', ['level'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.some((line) => line.includes('usage: /debug level'))).toBe(true);
  expect(debugLines).toEqual([]);

  const setChat: string[] = [];
  const setDebug: string[] = [];
  const setContext = createContext(setChat, undefined, setDebug);
  await expect(registry.dispatch('debug', ['level', 'off'], setContext))
    .resolves.toEqual({ kind: 'continue' });
  expect(setChat.some((line) => line.includes('debug level:'))).toBe(true);
  expect(setDebug).toEqual([]);
});

test('/debug keytrace on replies on chat and leaves debug empty', async () => {
  const registry = buildDashboardSlashRegistry();
  const chatLines: string[] = [];
  const debugLines: string[] = [];
  const context = createContext(chatLines, undefined, debugLines);

  await expect(registry.dispatch('debug', ['keytrace', 'on'], context))
    .resolves.toEqual({ kind: 'continue' });
  expect(chatLines.some((line) => line.includes('debug keytrace: ON'))).toBe(true);
  expect(debugLines).toEqual([]);
});

test('/log twelve subcommands emit no debug lines', async () => {
  const registry = buildDashboardSlashRegistry();
  const subcommands: string[][] = [
    ['clear'],
    ['copy'],
    ['filter', 'error'],
    ['fold', 'kind-unit'],
    ['freeze'],
    ['help'],
    ['input'],
    ['search', 'needle'],
    ['size', '+1'],
    ['solo'],
    ['turn', 'rule'],
    ['zzz'],
  ];
  for (const args of subcommands) {
    const chatLines: string[] = [];
    const debugLines: string[] = [];
    const context = createContext(chatLines, undefined, debugLines);
    await expect(registry.dispatch('log', args, context))
      .resolves.toEqual({ kind: 'continue' });
    expect(debugLines).toEqual([]);
  }
});

test('dashboard runtime registration catalog does not retain retired harness names as display differences', () => {
  expect(DASHBOARD_SLASH_CATALOG_BASELINE.registeredOnly).not.toContain('ask');
  expect(DASHBOARD_SLASH_CATALOG_BASELINE.registeredOnly).not.toContain('say');
  const registeredNames = buildDashboardSlashRegistry().names();
  const listedNames = displayedSlashCommandNames();
  const result = checkSlashCatalogBaseline(registeredNames, listedNames, DASHBOARD_SLASH_CATALOG_BASELINE);

  expect(result.violations).toEqual([]);
});

test('slash catalog comparison reports each new directional difference and contract violation', () => {
  const registeredNames = buildDashboardSlashRegistry().names();
  const listedNames = displayedSlashCommandNames();

  const registeredOnly = checkSlashCatalogBaseline(
    [...registeredNames, 'catalog-test-registered-only'],
    listedNames,
    DASHBOARD_SLASH_CATALOG_BASELINE,
  );
  expect(registeredOnly.violations).toContain('registered-only: catalog-test-registered-only');

  const listedOnly = checkSlashCatalogBaseline(
    registeredNames,
    [...listedNames, 'catalog-test-listed-only'],
    DASHBOARD_SLASH_CATALOG_BASELINE,
  );
  expect(listedOnly.violations).toContain('listed-only: catalog-test-listed-only');

  const duplicate = checkSlashCatalogBaseline(
    [...registeredNames, 'QUIT'],
    listedNames,
    DASHBOARD_SLASH_CATALOG_BASELINE,
  );
  expect(duplicate.violations).toContain('duplicate registered name: quit');
});

test('dashboard catalog exposes only the unified harness entry for every harness flow', () => {
  const harness = SLASH_COMMANDS.find((command) => command.name === 'harness');
  expect(harness).toMatchObject({
    aliases: [],
    subcommands: ['plan', 'ask', 'dev', 'goal', 'runs', 'stop', 'memo'],
  });
  for (const retiredName of ['ask', 'say', 'dev', 'goal', 'g', 'implement']) {
    expect(displayedSlashCommandNames()).not.toContain(retiredName);
  }
});

test('remaining slash stays registered and listed after retiring budget and usage', () => {
  const registry = buildDashboardSlashRegistry();
  expect(registry.has('remaining')).toBe(true);
  expect(registry.has('budget')).toBe(false);
  expect(registry.has('usage')).toBe(false);
  const remaining = SLASH_COMMANDS.find((command) => command.name === 'remaining');
  expect(remaining?.name).toBe('remaining');
});

test('dashboard catalog and registry stay synchronized except for the recorded display policy', () => {
  const listed = displayedSlashCommandNames();
  const registered = buildDashboardSlashRegistry().names();
  const listedOnly = new Set<string>(DASHBOARD_SLASH_CATALOG_BASELINE.listedOnly);
  const registeredOnly = new Set<string>(DASHBOARD_SLASH_CATALOG_BASELINE.registeredOnly);

  for (const name of listed) {
    if (!listedOnly.has(name)) expect(registered).toContain(name);
  }
  for (const name of registered) {
    if (!registeredOnly.has(name)) expect(listed).toContain(name);
  }
  for (const name of ['harness', 'status', 'st', 'now']) {
    expect(listed).toContain(name);
    expect(registered).toContain(name);
  }
  const result = checkSlashCatalogBaseline(registered, listed, DASHBOARD_SLASH_CATALOG_BASELINE);
  expect(result.violations).toEqual([]);
});

test('status and st on the human surface reuse the immediate executor lines', async () => {
  const statusLines = ['Dashboard status', '  view: log'];
  const getStatusLines = () => statusLines;
  const registry = buildDashboardSlashRegistry();

  const humanLines: string[] = [];
  await expect(registry.dispatch('status', [], { ...createContext(humanLines), getStatusLines }))
    .resolves.toEqual({ kind: 'continue' });
  expect(humanLines).toEqual(statusLines);

  const stLines: string[] = [];
  await expect(registry.dispatch('st', [], { ...createContext(stLines), getStatusLines }))
    .resolves.toEqual({ kind: 'continue' });
  expect(stLines).toEqual(statusLines);

  const agent = executeImmediateDashboardSlash({ name: 'status', args: [] }, { getStatusLines });
  expect(agent).not.toBeNull();
  expect(agent!.logLines).toEqual(statusLines);
  expect(humanLines).toEqual(statusLines);
});

test('restoring a removed listed-only name fails the catalog baseline by that name', () => {
  const registeredNames = buildDashboardSlashRegistry().names();
  const listedNames = displayedSlashCommandNames();
  const restored = checkSlashCatalogBaseline(
    registeredNames,
    [...listedNames, 'keys'],
    DASHBOARD_SLASH_CATALOG_BASELINE,
  );
  expect(restored.violations).toContain('listed-only: keys');
});
