import { initTui, initTuiPrimary, closeTui, injectKey, pendingKeyCount as tuiPendingKeyCount, readKey, setTuiAltScreen, setTuiMouseCapture, type Key } from '../tui.js';
import { createNextTuiCompactPainter, createNextTuiHistoryCache, fitLogLine, foldTargetAtScreenRow, isNextTuiContextCountStatus, isToolFoldToggleKey, NEXT_TUI_TITLE, nextTuiCompactActionStatus, nextTuiCompactHeight, nextTuiStatusAfterWelcome, nextVisibleFoldTarget, renderNextTuiCompactFrame, safeStatusText, streamReplyLines, toolFoldBlockStarts, wheelScroll, wrapLogLines } from './core/render.js';
import { renderNextTuiEntryFrame, shellApprovalCommandViewport } from './core/entry-render.js';
import type { MessageBlock } from '../conv-substrate/message-block.js';
import { nextMessageBlockDetailLevel } from './chat/message-block-view.js';
import { createMessageBlockSessionStore, upsertMessageBlock } from './core/message-block-session.js';
import { formatMessageBlockRawTrace, resolveMessageBlockRawTrace } from './core/message-block-raw-ref.js';
import { BackgroundJobStatus } from './chat/background-job-status.js';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, composerViewport, replaceSlashPickerQuery, wheelDirection } from './input/composer.js';
import { inlineEditorInsert, type InlineEditorState } from '../input-core/inline-editor.js';
import { createContextRegistry } from '../context.js';
import { hasClipboardImage, readClipboardText } from '../clipboard/index.js';
import { registerClipboardImageAttachment } from '../clipboard/image-attachment.js';
import { readClipboardPaste } from '../clipboard/paste.js';
import { requestNewTuiSession } from './slash/new-session.js';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS } from './slash/compact-command.js';
import { RESUME_BUSY_STATUS, parseResumeCommand } from './slash/resume-command.js';
import { reportTuiProgress, reportTuiTurn } from '../pty-shell/tui-run-state.js';
import { createNextTuiQueue } from './core/queue.js';
import { agentDisplayLine, agentDisplayLines, applyAgentEvent, reconcileAgentOutputStatuses, reconcileNestedAgentSnapshot, type AgentDisplay } from './core/agents.js';
import { formatNextTuiStatusLine, nextTuiElapsedMs } from './chat/status-line.js';
import { decideNextTuiAutoContinue, startNextTuiTurn } from './core/turn.js';
import { debug } from '../debug/log.js';
import { setCliStderrSink } from '../git-fs/cli-stderr.js';
import { createInputLagProbe } from './input-lag-probe.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import { countInterimDisplay, internalTurnOriginOfText, planInterimDisplay } from './chat/goal-interim.js';
import type { NextLoopCommand } from '../tui-client/next-loop-command.js';
import { handleSignalsSlash, type SignalsSlashContext } from './slash/signals.js';
import { updatePtyManifestSession } from '../pty-shell/pty-manifest.js';
import { createNextTuiCoreInput } from './core/input.js';
import { formatInlinePanel } from './input/inline-panel.js';
import { startMissionWatch as startMissionWatchLoop } from './mission-watch.js';
import { nextSlashCandidates } from './input/slash-complete.js';
import { nextFirstScreenLines } from './branches/first-screen.js';
import type { NextTuiHarnessRunner } from './branches/harness.js';
import type { GraphInstanceView } from '../../plugins/graph-instance-view/handlers/view-model.js';
import { monotonicNowMs, requiresLongShellEscConfirmation } from '../esc-shell-timing.js';
import { createShellApprovalSession, shellApprovalPromptHelp, shellApprovalPromptTitle } from './shell-approval-session.js';
import { SYNCHRONIZED_OUTPUT_BEGIN, SYNCHRONIZED_OUTPUT_END, openSynchronizedOutputRegion, synchronizedOutputDisabledByEnv } from '../display/synchronized-output-region.js';
import { remoteFrameRows, ScreenPaintCache } from './core/screen-paint-cache.js';
import { formatSidetabSectionFrame, normalizeSidetabSectionOrder, reorderSidetabSections, sidetabSectionTargetAt, type SidetabSectionFrame, type SidetabSectionId } from './sidetab/sections.js';
import type { SerializedMessage } from '../session/index.js';
import { displayNextPublicReplyText, projectUserReplyStatus, streamReplyProgress, turnReplyFailureMessage } from './core/next-public-reply.js';
import { nextTuiPublicHistory } from './core/public-history.js';

let nextTuiRouteRegistry: typeof import('./core/registry.js') | undefined;
async function loadNextTuiRouteRegistry(): Promise<typeof import('./core/registry.js')> {
  nextTuiRouteRegistry ??= await import('./core/registry.js');
  return nextTuiRouteRegistry;
}

export { nextTuiQueueSuffix } from './core/queue.js';

export interface NextTuiActiveShellCall { readonly name: 'Bash' | 'RunShell'; readonly startedAtMonotonicMs: number }

export function nextTuiShellEscDecision(
  activeCalls: ReadonlyMap<string, NextTuiActiveShellCall>,
  nowMs: number,
): 'abort' | 'confirm' | null {
  if (activeCalls.size === 0) return null;
  return [...activeCalls.values()].some(({ name, startedAtMonotonicMs }) =>
    requiresLongShellEscConfirmation(name, nowMs - startedAtMonotonicMs)) ? 'confirm' : 'abort';
}

export { shellApprovalCommandViewport };

type NextTuiTermSession = {
  id: string;
  title: string;
  kind: string;
  status: 'running' | 'backgrounded' | 'completed' | 'killed' | 'exited';
  cwd?: string;
  exitCode?: number | null;
};

export interface NextTuiOptions {
  /** Existing authenticated Nexus member session, supplied by the Next host. */
  readonly memberBoardSession?: () => { nexusUrl: string; sessionToken: string } | undefined;
  readonly resumeSessionId?: string;
  readonly sidetabMode?: 'off' | 'collapsed' | 'open';
  readonly compactHeight?: number;
  /** Test seam for the approval panel deadline; production uses the REPL timeout. */
  readonly shellApprovalTimeoutMs?: number;
  /** Read-only terminal session source; injectable so the Next slash stays testable without PTYs. */
  readonly termSessions?: {
    list(): readonly NextTuiTermSession[] | Promise<readonly NextTuiTermSession[]>;
  };
  /** Test seam for the registry-loaded harness branch; production reuses the local CLI adapter. */
  readonly harnessRunner?: NextTuiHarnessRunner;
  /** Test seam for rendering the real attachment footer without invoking a file picker. */
  readonly contextAttachmentsForTest?: readonly (readonly [token: string, path: string])[];
}

const sidetabOpenBySession = new Map<string, boolean>();

interface AtPickerCandidate {
  readonly label: string;
  readonly absPath: string;
  readonly isDir: false;
}

interface AtPickerQuery {
  readonly prefix: string;
  readonly start: number;
  readonly end: number;
}

interface SlashPickerCandidate { readonly value: string; readonly description: string }

/** Local chat entry: history and input are TUI-owned; turn execution stays shared. */
export async function showNextTui(options: NextTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('elanous --tui next requires stdin TTY');
  if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 6) {
    throw new Error('elanous --tui next requires at least 20 columns and 6 rows');
  }
  const { readNextTuiStatusModel } = await import('./chat/status-model.js');
  const dashboardRuntime = await (await import('../tui-client/next-dashboard-runtime.js')).loadNextTuiDashboardRuntime();
  const { appendMessage, createSession, loadSession, resolveSessionId, setActiveSessionId, updateSessionMeta } = await import('../session/index.js');
  const simWorldId = process.env.ELANOUS_SIM_WORLD_ID?.trim();
  const simWorld = simWorldId ? (await import('../ux-sim/world.js')).loadWorld(simWorldId) : null;
  const simWorldWatch = simWorld ? await import('../ux-sim/world-watch.js') : null;
  // A bare launch is a fresh human conversation. Automation CLIs share the
  // active-session pointer, so only an explicit root --continue/--resume may
  // attach an existing session here.
  const requested = options.resumeSessionId;
  let id = requested ? resolveSessionId(requested) : null;
  if (requested && !id) throw new Error(`session not found: ${requested}`);
  if (!id) {
    id = createSession({ source: 'tui', ...(simWorldId ? { title: `SIM-TUI ${simWorldId}` } : {}) }).id;
    setActiveSessionId(id);
  }
  let session = id ? loadSession(id) : null;
  let messages = session?.messages ?? [];
  // The seat ledger is touched only on next-TUI boot, and only when the
  // optional seat directory exists. The one dashboard module below is the
  // turn-start segments recorder wired over the shared turn delegation.
  const { readSeatMailSnapshot, seatMailLine } = await import('./seat-mail-boot.js');
  const mailLine = seatMailLine(readSeatMailSnapshot(process.cwd()));
  const input = createNextTuiCoreInput();
  let status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
  let executionModelBadge: string | undefined;
  let resolveExecutionModelBadge: (() => string | undefined) | undefined;
  let executionModelBadgeLoading = false;
  let tuiClosed = false;
  let welcomePending = true;
  let lastCompactCount: string | null = null;
  const compactHeight = nextTuiCompactHeight(process.env.ELANOUS_NEXT_TUI_COMPACT_HEIGHT, options.compactHeight);
  let compactMode = (process.stdout.rows || 24) <= compactHeight;
  const compactPainter = createNextTuiCompactPainter((text) => process.stdout.write(text));
  const missionWatchCancellation: { cancel?: () => void } = {};
  let busy = false;
  let turnElapsedMs: number | undefined;
  let measuredUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  let telemetrySessionId: string | null = null;
  let turnElapsedTimer: ReturnType<typeof setInterval> | null = null;
  let turnAbort: AbortController | null = null;
  let turnDone: Promise<void> | null = null;
  let scroll = 0;
  const prepareHistory = createNextTuiHistoryCache();
  let publicHistoryCache: { source: readonly SerializedMessage[]; length: number; busy: boolean;
    last: SerializedMessage | undefined; view: SerializedMessage[] } | null = null;
  let maxScroll = 0;
  let focus: 'input' | 'log' = 'input';
  let sidetabEnabled = options.sidetabMode !== 'off';
  let sidetabViewMode: 'current' | 'all' | 'workspaces' = 'current';
  const expandedWorkspaceIds = new Set<string>();
  let sidetabOpen = sidetabEnabled && (session?.meta.uiState?.sidetabOpen ?? sidetabOpenBySession.get(id!) ?? options.sidetabMode === 'open');
  let sidetabSelected = 0;
  let sidetabSectionOrder = normalizeSidetabSectionOrder(session?.meta.uiState?.sidetabSectionOrder);
  let sidetabSectionFrame: SidetabSectionFrame | null = null;
  let sidetabSectionScroll: number | null = null;
  let sidetabDragSource: SidetabSectionId | null = null;
  let sidetabDragOver: SidetabSectionId | 'end' | null = null;
  let sidetabMode: 'list' | 'new' = 'list';
  let sidetabRich = false;
  let richView: GraphInstanceView | null = null;
  let richSelectedIndex = 0;
  let richRead: ((runId?: string) => GraphInstanceView | null) | null = null;
  let richRender: ((view: GraphInstanceView, width: number, height: number, selectedNodeId?: string) => string[]) | null = null;
  const refreshRichView = (): void => {
    if (!sidetabRich || !richRead) return;
    try {
      richView = richRead(sidetabRows[sidetabSelected]?.runId);
      richSelectedIndex = Math.min(richSelectedIndex, Math.max(0, (richView?.nodes.length ?? 1) - 1));
    }
    catch { richView = null; }
  };
  const richNodeCount = (): number => richView?.nodes.length ?? 0;
  let sidetabFocused = false;
  let sidetabContextMenu: { rowId: string; menu: import('../ui/context-menu-registry.js').Menu } | null = null;
  let sidetabRename: { rowId: string; previousEditor: InlineEditorState } | null = null;
  let sidetabCloseRowId: string | null = null;
  let sidetabChordPending = false;
  let sidetabChordTimer: ReturnType<typeof setTimeout> | null = null;
  let sidetabRemoteFrame: string | null = null;
  let sidetabRows: import('./sidetab/list.js').SidetabRow[] = [];
  let herdrSidetabRows: import('./sidetab/list.js').SidetabRow[] = [];
  let remoteSidetabRows: import('./sidetab/list.js').SidetabRow[] = [];
  let remoteSidetabRefreshPending = false;
  let herdrSidetabRefreshPending = false;
  let herdrSidetabPortal: import('./sidetab/herdr-portal.js').HerdrSidetabPortal | null = null;
  let sidetabApi: typeof import('./sidetab/list.js') | null = null;
  const getSidetabViewMode = (): 'current' | 'all' | 'workspaces' => sidetabViewMode;
  const sidetabScope = () => getSidetabViewMode() === 'workspaces'
    ? { mode: 'workspaces' as const, expandedWorkspaceIds: [...expandedWorkspaceIds] }
    : undefined;
  // ⚠️ `as` 단언은 «null 로 좁혀지는» 흐름 분석을 푸는 것 — 값은 클로저(ensureSidetabAttachments) 안에서만 바뀐다.
  let sidetabAttachments: import('./sidetab/attach.js').SidetabAttachmentController | null = null as import('./sidetab/attach.js').SidetabAttachmentController | null;
  let workspaceInput: ReturnType<typeof import('./sidetab/workspace-input-controller.js').createWorkspaceInputController> | null = null;
  let workspaceBroadcast: ReturnType<typeof import('./sidetab/workspace-broadcast.js').createWorkspaceBroadcast> | null = null;
  let pendingSidetabSwitch: string | null = null;
  let sidetabRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let paintingCoordinatorFrame = false;
  const mouseResidue = new MouseResidueGuard();
  const replay: Key[] = [];
  let escapeSnapshot: { editor: InlineEditorState; status: string; focus: 'input' | 'log'; busy: boolean } | null = null;
  // Wakes readKey when a character held by the residue guard would otherwise wait for the next key.
  const residueWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  let residueTimer: ReturnType<typeof setTimeout> | null = null;
  let activity: string[] = [];
  let agents: AgentDisplay[] = [];
  /** Rows of the last `/resume` list — `/resume <n>` picks from what the user saw. */
  let lastResumeRows: import('../session/index.js').SessionMeta[] | null = null;
  let atPicker: { query: AtPickerQuery; candidates: AtPickerCandidate[]; selected: number } | null = null;
  const isInternalWakeForeground = (): boolean => focus === 'input' && !sidetabFocused && !atPicker
    && !sidetabAttachments?.hasModal() && !sidetabAttachments?.hasRemoteView();
  let slashPicker: { query: string; candidates: SlashPickerCandidate[]; selected: number } | null = null;
  let slashPickerVisible = false;
  let stopConfirmationSelection: 0 | 1 | null = null;
  let stopConfirmationKind: 'turn' | 'long-shell' | null = null;
  // Shell-approval seam: prompt state, copy, and lifecycle live in ./shell-approval-session.js
  // so approval behavior edits stop widening the entry hotspot (P0-ENTRY-TS-HOTSPOT-SEAM).
  const shellApproval = createShellApprovalSession({
    setStatus: (line) => { status = line; },
    render: () => render(),
    timeoutMs: options.shellApprovalTimeoutMs,
    viewport: () => {
      const columns = Math.max(1, process.stdout.columns || 1);
      return {
        columns,
        rows: process.stdout.rows || 6,
        sidetabWidth: sidetabOpen && sidetabApi ? sidetabApi.sidetabWidthForTerminal(columns) : 0,
      };
    },
  });
  const activeShellCalls = new Map<string, NextTuiActiveShellCall>();
  const activeToolCalls = new Map<string, string>();
  const shellActivitySnapshotRequest: { current: (() => boolean) | null } = { current: null };
  const pushNowRequest: { current: ((requestId: string) => boolean) | null } = { current: null };
  const pushNowCommit: { current: ((requestId: string) => boolean) | null } = { current: null };
  let shellEscSnapshotPending = false;
  let pushNowSnapshotPending = false;
  let pushNowRequestId: string | null = null;
  let pushNowPhase: 'checking' | 'committing' | null = null;
  const pushNowCommitting = (): boolean => pushNowPhase === 'committing';
  let pushNowRequestSerial = 0;
  let atPickerApi: typeof import('./input/at-picker.js') | null = null;
  let dismissedAtQuery = '';
  let slashNavigated = false;
  let dismissedSlashDraft = '';
  const atAttachmentTokens = new Map<string, string>(options.contextAttachmentsForTest ?? []);
  let contextAttachmentArea: string[] = [];
  let contextAttachmentAreaVisible = false;
  let contextAttachmentPage = 0;
  let contextAttachmentScroll = 0;
  let contextAttachmentScrollStep = 1;
  let contextAttachmentScrollMax = 0;
  let contextAttachmentScrollPage = 1;
  let contextAttachmentScrollPages = 1;
  let atAttachmentOrdinal = 0;
  const clipboardAttachments = createContextRegistry();
  const refreshVisibleContextAttachmentArea = async (): Promise<void> => {
    if (!contextAttachmentAreaVisible) return;
    const branch = await import('./branches/context.js');
    const projection = branch.projectNextTuiContextArea(atAttachmentTokens, contextAttachmentPage, 1);
    contextAttachmentPage = projection.page;
    contextAttachmentArea = projection.lines;
    contextAttachmentScroll = 0;
  };
  // Tool-output fold state, keyed by message index; long tool output renders
  // collapsed and Enter/Tab/F in the log toggles the foldable block on screen nearest the
  // bottom of the last rendered scroll window.
  const expandedToolBlocks = new Set<number>();
  const messageBlockSessions = createMessageBlockSessionStore();
  let messageBlocks: MessageBlock[] = [];
  let messageBlockLevels = new Map<string, 0 | 1 | 2 | 3>();
  let messageBlockRawTexts = new Map<string, string>();
  let messageBlockAfterMessageIndexes = new Map<string, number>();
  const saveMessageBlockSession = (): void => {
    if (!id) return;
    messageBlockSessions.save(id, { blocks: [...messageBlocks], levels: new Map(messageBlockLevels),
      rawTexts: new Map(messageBlockRawTexts), afterMessageIndexes: new Map(messageBlockAfterMessageIndexes) });
  };
  const restoreMessageBlockSession = (sessionId: string): void => {
    const saved = messageBlockSessions.restore(sessionId);
    messageBlocks = saved.blocks;
    messageBlockLevels = saved.levels;
    messageBlockRawTexts = saved.rawTexts;
    messageBlockAfterMessageIndexes = saved.afterMessageIndexes;
  };
  let logWindow: { start: number; rows: number; columns: number; bodyTop: number; leadingBlankRows: number; foldTargets: readonly ({ kind: 'message'; id: string; start: number; end: number } | { kind: 'tool'; index: number; start: number; end: number })[] } = { start: 0, rows: 0, columns: 80, bodyTop: 1, leadingBlankRows: 0, foldTargets: [] };
  let lastFoldTargetKey: string | null = null;
  let pendingEcho: SerializedMessage | null = null;
  let pendingEchoStart = 0;
  const screenPaintCache = new ScreenPaintCache();
  let compactGeometry: { columns: number; rows: number; chatColumns: number; sources: string[] } | null = null;
  let compactReturnPending = false;
  const paintScreen = (lines: string[], cursorRow: number, cursorCol: number, columns: number, rows: number): void => {
    if (compactMode) compactPainter.beforeExternalPaint(rows);
    const region = openSynchronizedOutputRegion();
    const synchronized = region.outermost && !synchronizedOutputDisabledByEnv();
    const diff = screenPaintCache.diff(lines, columns, rows);
    let output = `${synchronized ? SYNCHRONIZED_OUTPUT_BEGIN : ''}\x1b[?25l`;
    if (diff.clear) output += '\x1b[H\x1b[2J';
    for (const { row, text } of diff.changedRows) output += `\x1b[${row + 1};1H\x1b[2K\x1b[0m${text}`;
    output += `\x1b[${cursorRow};${cursorCol}H\x1b[?25h${synchronized ? SYNCHRONIZED_OUTPUT_END : ''}`;
    try {
      process.stdout.write(output);
    } finally {
      region.close();
    }
  };
  const backgroundJobs = new BackgroundJobStatus(id);
  const backgroundSubscription: { stop?: () => void } = {};
  let observedSessionId: string | null = null;
  // TUI-NEXT-QUEUE-AND-WAKE — what is submitted while busy waits here (the classic FIFO state) and
  // leaves one item per settle; Esc returns it all to the prompt (classic «interrupted» drain).
  const queue = createNextTuiQueue();
  /** The prompt text a queued submission displaced; it comes back once that submission is sent. */
  let restoreDraft: string | null = null;
  /** ⏰/↻ lines from the wakeup scheduler and the internal-turn door (newest last, at most three). */
  let notices: string[] = [];
  let internalNotices: string[] = [];
  // Distinct sentinels: the loop owns them, nothing else reads them as keys.
  const queueWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  const internalWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  let wakeup: NextTuiWakeup | null = null;
  let loopCommand: NextLoopCommand | null = null;
  let decideBranchRoute: ((input: string) => string) | undefined;
  let pluginWizardFlow: ReturnType<typeof import('./branches/plugin-wizard.js').createPluginWizardFlow> | null = null;
  const runLoopCommand = async (raw: string): Promise<string[]> => {
    if (!loopCommand) {
      if (!wakeup?.gate) {
        return [
          'usage: /loop <간격> <프롬프트> · /loop stop',
          '간격: 30s · 5m · 1h · 맨숫자=분 — TUI가 쉴 때 프롬프트를 발사합니다',
        ];
      }
      const { createNextLoopCommand } = await import('../tui-client/next-loop-command.js');
      loopCommand = createNextLoopCommand(wakeup.gate, (event, data) => debug.log('dashboard.loop', event, data));
    }
    return loopCommand.run(raw);
  };
  // TURN-END-BEFORE-GOAL — 답이 약속만 하고 끝나면 깨움 문으로 한 턴 더(classic 과 같은 모듈 · 동적 로드).
  let goalContinue: ReturnType<(typeof dashboardRuntime)['createGoalContinue']> | null = null;
  /** 이번 턴이 실패·취소로 끝났나 — 그런 턴은 이어가지 않는다. */
  /** 마지막으로 관측에 남긴 접힌 중간 답 수(next · 바뀔 때만 'folded' 한 줄). */
  let interimFoldedShown = 0;
  const pushNotice = (line: string): void => {
    notices = [...notices, safeStatusText(line)].slice(-3);
  };
  const pushInternalNotice = (line: string): void => {
    internalNotices = [...internalNotices, safeStatusText(line)].slice(-3);
  };
  const observeSession = (
    sessionId: string,
    onBackground: typeof import('../tui-client/local-chat-turn.js').onLocalChatBackgroundStatus,
  ): void => {
    if (observedSessionId === sessionId) return;
    backgroundSubscription.stop?.();
    backgroundSubscription.stop = onBackground(sessionId, (frame) => {
      if (frame === null) backgroundJobs.clear();
      else if (backgroundJobs.accept(frame) && id === sessionId) {
        try {
          agents = reconcileNestedAgentSnapshot(agents, (JSON.parse(frame) as { nestedAgents?: unknown }).nestedAgents);
        } catch { /* background status has its own validator */ }
      }
      if (id === sessionId && !busy) {
        session = loadSession(sessionId);
        messages = session?.messages ?? messages;
      }
      render();
    });
    observedSessionId = sessionId;
  };
  // MISSION-FABRIC-REMOVAL(대표 11-05) — /mission 은 지웠다. 미션 패브릭(autopilot 미션 스토어)은 시뮬레이션 장치로 새로 짓는다.
  const slashHandlers = new Map<string, (args: string[], context: SignalsSlashContext) => Promise<void>>();
  slashHandlers.set('signals', handleSignalsSlash);
  slashHandlers.set('status', async (_args, context) => (await import('./branches/status.js')).runNextTuiStatusBranchRoute('/status', { addLines: (...lines) => context.chatLines.push(...lines), sessionId: id ?? undefined }));
  slashHandlers.set('remaining', async (args, context) => (await import('./branches/remaining.js')).handleNextTuiRemainingSlash(args, context));
  slashHandlers.set('loop', async (args, context) => {
    context.chatLines.push(...await runLoopCommand(args.join(' ')));
  });
  const dispatchSlash = async (name: string, args: string[], context: SignalsSlashContext): Promise<boolean> => {
    const handler = slashHandlers.get(name);
    if (!handler) return false;
    await handler(args, context);
    return true;
  };
  const slashContext: SignalsSlashContext = {
    chatLines: activity,
    setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
    muted: (text) => text,
    accent: (text) => text,
    text: (text) => text,
    error: (text) => text,
    warning: (text) => text,
    info: (text) => text,
  };
  // Load the presentation leaf before rendering without adding to the audited static entry imports.
  const { nextTuiStatusLine } = await import('./chat/status-line.js');

  // TURN-START-BLOCK-REST — 턴 경계 recorder: showNextTui → runLocalChatTurn 위임 턴의
  // 시작 경계(begin)와 첫 응답 경계(end · stream-open)를 세션 키로 열고 닫아
  // debug.log('tui.turn-start', 'segments', …) 줄 한 개로 남긴다. 박동은 전용 input-lag
  // 프로브(20ms·unref)의 것만 읽는다 — 키 지연 계측(noteKey/notePaint) 등록은 이 몫 범위 밖.
  // recorder·프로브 타이머는 모두 unref 라 teardown 이 기다리는 대상에 들지 않고, dispose 는
  // 부르지 않는다 — 닫힌 턴의 줄은 박동 두 번 뒤 지연 emit 되므로 dispose 가 그 줄을 끊는다.
  const turnStartBeats = createInputLagProbe({ log: () => {}, isBusy: () => busy });
  dashboardRuntime.setTurnStartSegments(dashboardRuntime.createTurnStartSegments({
    beats: turnStartBeats.beats,
    log: (category, event, data) => { debug.log(category, event, data); },
    isBusy: () => busy,
  }));

  const render = (): void => {
    slashPickerVisible = false;
    const nextCompactMode = (process.stdout.rows || 24) <= compactHeight;
    if (nextCompactMode !== compactMode) {
      const returningToCompact = nextCompactMode;
      compactMode = nextCompactMode;
      setTuiAltScreen(!compactMode);
      compactPainter.invalidateViewport(returningToCompact);
      if (returningToCompact) compactReturnPending = true;
    }
    if (sidetabRemoteFrame !== null) {
      const columns = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const footer = fitLogLine(` ${status} `, Math.max(1, columns));
      const body = remoteFrameRows(sidetabRemoteFrame, columns, rows - 1);
      paintScreen([...Array(Math.max(0, rows - 1 - body.length)).fill(''), ...body, `\x1b[7m${footer}\x1b[0m`], rows, 1, columns, rows);
      return;
    }
    const columns = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    if (columns < 20 || rows < 6) {
      paintScreen([fitLogLine('터미널이 너무 작습니다 · q 종료', Math.max(1, columns))], 1, 1, columns, rows);
      return;
    }
    if (sidetabOpen && columns < 34) {
      sidetabOpen = false;
      sidetabMode = 'list';
      status = '터미널 폭이 줄어 사이드탭을 닫았습니다';
      if (sidetabRefreshTimer !== null) {
        clearInterval(sidetabRefreshTimer);
        sidetabRefreshTimer = null;
      }
    }
    if (compactMode) setTuiMouseCapture(sidetabOpen);
    const sidetabWidth = sidetabOpen ? sidetabApi!.sidetabWidthForTerminal(columns) : 0;
    const chatColumns = columns - sidetabWidth - (sidetabOpen ? 1 : 0);
    const backgroundLine = backgroundJobs.line();
    let modelBadgeResolutionFailed = false;
    const resolveModelBadgeSafely = (): string | undefined => {
      try {
        return resolveExecutionModelBadge?.();
      } catch {
        // Model/config status is optional; a transient config read must not
        // make the interactive renderer fail. Clear the resolver so the next
        // render can retry after the underlying state recovers.
        resolveExecutionModelBadge = undefined;
        executionModelBadgeLoading = false;
        modelBadgeResolutionFailed = true;
        return undefined;
      }
    };
    if (resolveExecutionModelBadge) {
      // The active route/config can change between turns; keep the footer badge
      // aligned with the model that the next turn will actually use.
      executionModelBadge = resolveModelBadgeSafely();
    } else if (!executionModelBadgeLoading) {
      executionModelBadgeLoading = true;
      void import('./chat/execution-badge.js').then(({ resolveDashboardExecutionBadge }) => {
        resolveExecutionModelBadge = resolveDashboardExecutionBadge;
        executionModelBadge = resolveModelBadgeSafely();
        if (!modelBadgeResolutionFailed && !tuiClosed) render();
      }).catch(() => {
        // Let a later render retry a failed lazy load instead of leaving the
        // badge permanently unavailable for this TUI session.
        executionModelBadgeLoading = false;
      });
    }
    const title = fitLogLine(NEXT_TUI_TITLE, chatColumns);
    const header = [title, mailLine ? fitLogLine(mailLine, chatColumns) : '─'.repeat(Math.max(0, chatColumns))];
    const rawTurnStatus = busy && activeShellCalls.size > 0
      ? 'Bash 실행 · Esc 취소'
      : busy && activeToolCalls.size > 0
        ? '도구 실행 · Esc 취소'
        : !busy && focus === 'log'
          ? `로그 탐색 · ↑↓ 스크롤${toolFoldBlockStarts(messages, chatColumns).length > 0 ? ' · Enter 접기/펼치기' : ''} · Esc 입력`
          : status;
    const turnStatusBase = isNextTuiContextCountStatus(rawTurnStatus) ? '' : nextTuiStatusAfterWelcome(rawTurnStatus);
    const background = backgroundJobs.snapshot();
    const backgroundTasks = background ? background.running + background.pending : 0;
    const activeShellApproval = shellApproval.active();
    const approvalViewport = activeShellApproval
      ? shellApprovalCommandViewport(activeShellApproval.command, columns, sidetabOpen ? sidetabWidth : 0, rows, activeShellApproval.scroll)
      : null;
    const approvalCommandLines = approvalViewport?.lines ?? [];
    const approvalPageSize = approvalViewport?.pageSize ?? 1;
    const approvalScroll = approvalViewport?.scroll ?? 0;
    const attachmentLines = contextAttachmentArea.flatMap((line) => wrapLogLines(safeStatusText(line), chatColumns));
    const attachmentContent = attachmentLines.slice(1);
    const statusRowCount = backgroundLine ? 2 : 1;
    const attachmentRowLimit = Math.max(1, Math.min(6, rows - header.length - statusRowCount - 1));
    const attachmentBodyRows = Math.max(1, attachmentRowLimit - 1);
    contextAttachmentScrollStep = attachmentBodyRows;
    contextAttachmentScrollPages = Math.max(1, Math.ceil(attachmentContent.length / attachmentBodyRows));
    contextAttachmentScrollMax = (contextAttachmentScrollPages - 1) * attachmentBodyRows;
    contextAttachmentScroll = Math.max(0, Math.min(contextAttachmentScroll, contextAttachmentScrollMax));
    contextAttachmentScrollPage = Math.floor(contextAttachmentScroll / attachmentBodyRows) + 1;
    const attachmentOverflow = contextAttachmentScrollMax > 0;
    const rawAttachmentHint = attachmentOverflow && focus === 'input' && !atPicker && !slashPicker && !activeShellApproval
      ? `첨부 경로 ${contextAttachmentScrollPage}/${contextAttachmentScrollPages} · PgUp/PgDn`
      : null;
    const statusMinimumWidth = Bun.stringWidth(`실패·미·Q${queue.count}·B${backgroundTasks}`);
    const hintWidth = chatColumns - statusMinimumWidth - Bun.stringWidth(' · ');
    const attachmentHint = rawAttachmentHint && hintWidth > 0
      ? [
          rawAttachmentHint,
          `${contextAttachmentScrollPage}/${contextAttachmentScrollPages} PgUp/PgDn`,
          'PgUp/PgDn',
          `첨부 경로 ${contextAttachmentScrollPage}/${contextAttachmentScrollPages}`,
          '첨부 경로',
        ].find((candidate) => Bun.stringWidth(candidate) <= hintWidth) ?? null
      : null;
    const statusWidth = Math.max(1, chatColumns - (attachmentHint ? Bun.stringWidth(`${attachmentHint} · `) : 0));
    const statusLine = formatNextTuiStatusLine({
      turnState: turnStatusBase,
      model: readNextTuiStatusModel(id ?? undefined, session?.meta),
      queued: queue.count,
      backgroundTasks,
      width: statusWidth,
      elapsedMs: id === telemetrySessionId ? turnElapsedMs : undefined,
      measuredUsage: id === telemetrySessionId ? measuredUsage : undefined,
    });
    const turnStatus = [statusLine, attachmentHint].filter(Boolean).join(' · ');
    const compactActionStatus = nextTuiCompactActionStatus(turnStatus);
    const attachmentFooter = attachmentLines.length
      ? [attachmentLines[0]!, ...attachmentContent.slice(contextAttachmentScroll, contextAttachmentScroll + attachmentBodyRows)]
      : [];
    const withAttachmentFooter = (lines: string[]): string[] => [...attachmentFooter, ...lines];
    const statusFooter = rows <= compactHeight
      ? [
          ...(backgroundLine ? [fitLogLine(backgroundLine, chatColumns)] : []),
          nextTuiStatusLine({
            state: welcomePending ? 'Enter 전송 · Esc 취소 · Ctrl+Q 종료'
              : (compactActionStatus ?? turnStatusBase) || (busy ? '응답 중' : '대기'),
            ...(executionModelBadge ? { model: executionModelBadge } : {}),
            queued: queue.count,
            activeChildren: agents.filter(({ status: agentStatus }) => agentStatus === 'running' || agentStatus === 'background').length,
            columns: chatColumns,
          }),
        ]
      : [
          ...(backgroundLine ? [fitLogLine(backgroundLine, chatColumns)] : []),
          ...(welcomePending ? [fitLogLine('Enter 전송 · Esc 취소 · Ctrl+Q 종료', chatColumns)] : []),
          ...(turnStatus ? [fitLogLine(turnStatus, chatColumns)] : []),
        ];
    const panelSpec = atPicker
      ? {
          title: '@ 파일 첨부',
          rows: atPicker.candidates.map((candidate) => ({ label: candidate.label })),
          selected: atPicker.selected,
          hint: 'Enter 추가 · Esc 닫기',
        }
      : slashPicker
        ? {
            title: '/ 명령',
            rows: slashPicker.candidates.map((candidate) => ({ label: candidate.value, description: candidate.description })),
            selected: slashPicker.selected,
            hint: '↑↓ 선택 · Tab 완성 · Enter 실행 · Esc 닫기',
          }
        : stopConfirmationSelection !== null
          ? {
              title: stopConfirmationKind === 'long-shell' ? '긴 셸 명령 중단 확인' : '응답 중단 확인',
              rows: [{ label: 'y. 중단' }, { label: 'n. 계속' }],
              selected: stopConfirmationSelection,
              hint: 'y/n 입력 · 기본 N · Enter=계속 · Esc 닫기',
            }
          : null;
    slashPickerVisible = Boolean(slashPicker && !atPicker && !activeShellApproval);
    const footer = withAttachmentFooter(activeShellApproval
      ? [
          fitLogLine(shellApprovalPromptTitle(activeShellApproval.kind), chatColumns),
          ...approvalCommandLines.slice(approvalScroll, approvalScroll + approvalPageSize).map((line) => fitLogLine(line, chatColumns)),
          fitLogLine(`명령 ${approvalScroll + 1}-${Math.min(approvalCommandLines.length, approvalScroll + approvalPageSize)} / ${approvalCommandLines.length} · ↑↓ 내용 보기`, chatColumns),
          fitLogLine(shellApprovalPromptHelp(activeShellApproval.kind), chatColumns),
        ]
      : panelSpec
      ? formatInlinePanel(panelSpec).map((line) => fitLogLine(line, chatColumns))
      : statusFooter);
    // Keep title, status and at least one log row visible on ordinary small terminals.
    const promptMaxRows = Math.max(1, Math.min(6, rows - header.length - footer.length - 1)); // Source: #36682
    const prompt = composerViewport(input.editor, { columns: chatColumns, maxRows: promptMaxRows });
    // Keep submitted user text visible until the session transcript catches up.
    const visibleMessages = pendingEcho && !messages.slice(pendingEchoStart).some((message) =>
      message.role === 'user' && message.content === pendingEcho!.content)
      ? [...messages, pendingEcho] : messages;
    const basicChat = focus === 'input';
    let displayedMessages: readonly SerializedMessage[] = visibleMessages;
    if (basicChat) {
      if (!publicHistoryCache || publicHistoryCache.source !== visibleMessages
        || publicHistoryCache.length !== visibleMessages.length || publicHistoryCache.last !== visibleMessages.at(-1)
        || publicHistoryCache.busy !== busy) {
        publicHistoryCache = { source: visibleMessages, length: visibleMessages.length, busy,
          last: visibleMessages.at(-1), view: nextTuiPublicHistory(visibleMessages, busy) };
      }
      displayedMessages = publicHistoryCache.view.map((message) => message.role === 'assistant' && message.content.includes('\t')
        ? { ...message, content: displayNextPublicReplyText(message.content) } : message);
    }
    const reconciledAgents = reconcileAgentOutputStatuses(agents, messages, backgroundJobs.snapshot()?.tasks);
    const displayActivity = [
      ...(!basicChat ? [
        ...agentDisplayLines(reconciledAgents),
        ...reconciledAgents.map(agentDisplayLine),
        ...(backgroundJobs.taskLines?.() ?? []).map(safeStatusText),
      ] : []),
      ...activity,
    ];
    // Source: renderNextTuiLogFrame reserves one prompt row after header and footer.
    const firstScreen = nextFirstScreenLines({
      width: chatColumns,
      availableRows: Math.max(0, rows - header.length - footer.length - prompt.lines.length),
      hasMessages: displayedMessages.length > 0,
      hasActivity: displayActivity.length > 0,
      hasNotices: notices.length > 0,
      hasDraft: input.editor.text.length > 0,
      busy,
    });
    const frameInput = { messages: displayedMessages, messageBlocks: (basicChat ? [] : messageBlocks).map((block) => ({
      block, level: messageBlockLevels.get(block.id) ?? 0, rawText: messageBlockRawTexts.get(block.id),
      afterMessageIndex: messageBlockAfterMessageIndexes.get(block.id),
    })), columns: chatColumns, rows,
      header, footer,
      promptLine: prompt.line, promptLines: prompt.lines, notices: basicChat ? notices : [...notices, ...internalNotices], activity: [...firstScreen, ...displayActivity], scroll,
      expandedToolIndexes: basicChat ? new Set<number>() : expandedToolBlocks };
    const prepared = prepareHistory(frameInput);
    const frame = compactMode
      ? renderNextTuiCompactFrame(frameInput, prepared)
      : renderNextTuiEntryFrame(frameInput, prepared);
    ({ scroll, maxScroll, logWindow } = frame);
    const { lines, promptRow } = frame;
    sidetabSectionFrame = sidetabOpen && !sidetabRich && sidetabMode === 'list'
      ? formatSidetabSectionFrame(sidetabRows, sidetabSelected, sidetabWidth, Math.max(1, rows - 1), sidetabSectionOrder,
        sidetabSectionScroll ?? undefined)
      : null;
    const sidetabLines = sidetabOpen
      ? sidetabContextMenu
        ? [sidetabContextMenu.menu.title ?? '사이드탭',
          ...sidetabContextMenu.menu.items.filter((item) => item.kind === 'command')
            .map((item, index) => ` ${index + 1} ${item.label}`),
          ' Esc 닫기'].map((line) => fitLogLine(line, sidetabWidth))
        : sidetabRich && richView && richRender
        ? richRender(richView, sidetabWidth, Math.max(1, rows - 1), richView.nodes[richSelectedIndex]?.id)
        : sidetabRich ? [fitLogLine('원장 조회 불가 · g 목록', sidetabWidth)]
          : sidetabSectionFrame?.lines ?? sidetabApi!.formatSidetabLines(sidetabRows, sidetabSelected, sidetabWidth, Math.max(1, rows - 1), sidetabMode)
      : [];
    const screenLines = sidetabOpen && !compactMode
      ? Array.from({ length: Math.max(lines.length, sidetabLines.length) }, (_, index) =>
          `${sidetabLines[index] ?? ' '.repeat(sidetabWidth)}│${lines[index] ?? ''}`)
      : lines;
    if (compactMode) {
      const sources = displayedMessages.map((message) => JSON.stringify(message));
      const geometry = compactGeometry;
      const boundaryKind = geometry && (compactReturnPending || geometry.columns !== columns || geometry.rows !== rows)
        ? 'resize' : geometry && geometry.chatColumns !== chatColumns ? 'layout' : null;
      let retainedStableCount = 0;
      if (geometry) {
        let retainedSources = 0;
        while (retainedSources < sources.length && sources[retainedSources] === geometry.sources[retainedSources]) retainedSources++;
        if (retainedSources === sources.length && retainedSources === geometry.sources.length) retainedStableCount = prepared.lines.length;
        else {
          const retainedInput = { ...frameInput, messages: displayedMessages.slice(0, retainedSources),
            messageBlocks: frameInput.messageBlocks.filter((block) => (block.afterMessageIndex ?? visibleMessages.length - 1) < retainedSources) };
          retainedStableCount = prepareHistory(retainedInput).lines.length;
        }
      }
      const decorate = sidetabOpen ? (visible: readonly string[]): readonly string[] =>
        Array.from({ length: rows }, (_, index) => `${sidetabLines[index] ?? ' '.repeat(sidetabWidth)}│${visible[index] ?? ''}`) : undefined;
      const cursorCol = prompt.cursorCol + (sidetabOpen ? sidetabWidth + 1 : 0);
      if (frame.scroll > 0) compactPainter.paintViewport(screenLines, cursorCol, rows, columns, promptRow + prompt.cursorRow, decorate);
      else {
        compactPainter.paint(screenLines, cursorCol, rows, columns,
          header.length + prepared.lines.length, promptRow + prompt.cursorRow, header.length, decorate,
          boundaryKind ? { kind: boundaryKind, chatColumns, retainedStableCount } : undefined,
          geometry ? retainedStableCount : undefined);
        // A scrolled paint is temporary. Apply its pending geometry only when
        // the stable painter resumes at the tail.
        compactGeometry = { columns, rows, chatColumns, sources };
        compactReturnPending = false;
      }
      // Compact chat has overwritten rows owned by the full-screen cache.
      // Reopening the sidetab must repaint every row, including unchanged text.
      screenPaintCache.invalidate(rows);
    }
    else {
      paintScreen(screenLines, promptRow + prompt.cursorRow, prompt.cursorCol + (sidetabOpen ? sidetabWidth + 1 : 0), columns, rows);
    }
    if (sidetabAttachments?.hasModal() && !paintingCoordinatorFrame) {
      sidetabAttachments.refresh();
      screenPaintCache.invalidate(rows);
      if (compactMode) compactPainter.invalidateViewport();
    }
  };

  const startMissionWatch = (
    kind: 'ready' | 'run',
    missionId: string,
    poll: () => Promise<{ message: string; outcome: 'pending' | 'complete' | 'error' }>,
    onReady?: (isActive: () => boolean) => Promise<void>,
  ): void => {
    missionWatchCancellation.cancel?.();
    status = kind === 'ready' ? `미션 준비 관찰 중 · ${missionId}` : `미션 실행 관찰 중 · ${missionId}`;
    render();
    const watcher = startMissionWatchLoop({
      poll,
      onUpdate: (message) => {
        activity.push(`  ${message}`);
        if (activity.length > 30) activity.splice(0, activity.length - 30);
        render();
      },
      onError: (message) => {
        activity.push(`  미션 관찰 실패: ${message}`);
        status = `미션 관찰 오류 · ${missionId}`;
        render();
      },
      onComplete: async (isActive) => {
        if (kind === 'ready') await onReady?.(isActive);
        if (!isActive()) return;
        status = kind === 'ready' ? `미션 준비 완료 · ${missionId}` : `미션 종결 · ${missionId}`;
        render();
      },
    });
    missionWatchCancellation.cancel = watcher.cancel;
  };

  const ensureSidetabAttachments = async (): Promise<void> => {
    if (sidetabAttachments) return;
    const herdrPortalModule = await import('./sidetab/herdr-portal.js');
    herdrSidetabPortal ??= herdrPortalModule.createHerdrSidetabPortal();
    const installer = await import('../agent-mission/tool-install.js') as unknown as {
      detectAgentCli?: (agent: 'codex' | 'claude') => Promise<{
        agent: 'codex' | 'claude'; installed: boolean; version: string | null;
        login: 'ready' | 'needed' | 'unknown'; message: string;
      }>;
    };
    sidetabAttachments = (await import('./sidetab/attach.js')).createSidetabAttachmentController({
      herdrPortal: herdrSidetabPortal,
      logEvent: (category, event, data) => debug.log(category, event, data),
      drawBase: () => {
        paintingCoordinatorFrame = true;
        try { render(); } finally { paintingCoordinatorFrame = false; }
      },
      termSize: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
      setStatus: (message) => { status = safeStatusText(message); },
      ...(installer.detectAgentCli ? { detectAgentCli: installer.detectAgentCli } : {}),
      drawRemoteFrame: (frame) => {
        sidetabRemoteFrame = frame || null;
        render();
      },
    });
    const ports = (await import('./sidetab/workspace-input-ports.js')).createWorkspaceInputPorts({
      rows: () => sidetabRows,
      attachments: sidetabAttachments,
    });
    workspaceInput = (await import('./sidetab/workspace-input-controller.js')).createWorkspaceInputController(ports);
    workspaceBroadcast = (await import('./sidetab/workspace-broadcast.js')).createWorkspaceBroadcast({
      rows: () => sidetabRows,
      sendTerminal: ports.sendTerminal,
    });
  };

  const toggleSidetab = async (): Promise<void> => {
    if (!sidetabEnabled) {
      status = '사이드탭 off · /side on 으로 이 세션에서 켜기';
      return;
    }
    if (!sidetabOpen && (process.stdout.columns || 0) < 34) {
      status = '사이드탭은 터미널 폭 34칸 이상에서 열 수 있습니다';
      return;
    }
    if (!sidetabApi) sidetabApi = await import('./sidetab/list.js');
    sidetabRows = sidetabApi.loadSidetabRows(getSidetabViewMode() === 'all', undefined, sidetabScope());
    const current = sidetabRows.findIndex((row) => row.sessionId === id);
    const next = sidetabApi.applySidetabKey({ open: sidetabOpen, selected: current >= 0 ? current : sidetabSelected }, 'toggle', sidetabRows.length);
    sidetabOpen = next.open;
    sidetabOpenBySession.set(id!, sidetabOpen);
    updateSessionMeta(id!, (meta) => { meta.uiState = { ...meta.uiState, sidetabOpen }; });
    sidetabSelected = next.selected;
    sidetabMode = 'list';
    if (sidetabOpen && sidetabRefreshTimer === null) {
      void refreshHerdrSidetabRows();
      if (process.env.ELANOUS_REMOTE_SIDETAB === '1') void refreshRemoteSidetabRows();
      sidetabRefreshTimer = setInterval(() => {
        if (!sidetabOpen || !sidetabApi) return;
        refreshSidetabRows();
        refreshRichView();
        void refreshHerdrSidetabRows();
        if (process.env.ELANOUS_REMOTE_SIDETAB === '1') void refreshRemoteSidetabRows();
        render();
      }, 1000);
    } else if (!sidetabOpen && sidetabRefreshTimer !== null) {
      clearInterval(sidetabRefreshTimer);
      sidetabRefreshTimer = null;
    }
  };

  const refreshSidetabRows = (): void => {
    if (!sidetabApi) return;
    const selectedId = sidetabRows[sidetabSelected]?.id;
    sidetabRows = [...sidetabApi.loadSidetabRows(getSidetabViewMode() === 'all', undefined, sidetabScope()), ...herdrSidetabRows, ...remoteSidetabRows];
    const preservedIndex = selectedId ? sidetabRows.findIndex((row) => row.id === selectedId) : -1;
    sidetabSelected = preservedIndex >= 0
      ? preservedIndex
      : Math.min(sidetabSelected, Math.max(0, sidetabRows.length - 1));
    refreshRichView();
  };
  const toggleWorkspaceRow = (row: { id: string; kind: string }): boolean => {
    if (sidetabViewMode !== 'workspaces' || row.kind !== 'workspace') return false;
    if (expandedWorkspaceIds.has(row.id)) expandedWorkspaceIds.delete(row.id);
    else expandedWorkspaceIds.add(row.id);
    refreshSidetabRows();
    return true;
  };

  const refreshHerdrSidetabRows = async (): Promise<void> => {
    if (herdrSidetabRefreshPending) return;
    herdrSidetabRefreshPending = true;
    try {
      const portal = await import('./sidetab/herdr-portal.js');
      herdrSidetabPortal ??= portal.createHerdrSidetabPortal();
      await herdrSidetabPortal.refreshRows();
      herdrSidetabRows = [...herdrSidetabPortal.rows()];
      refreshSidetabRows();
    } catch { /* Herdr is optional; TUI rows remain available. */ }
    finally { herdrSidetabRefreshPending = false; }
  };
  const refreshRemoteSidetabRows = async (): Promise<void> => {
    if (remoteSidetabRefreshPending) return;
    remoteSidetabRefreshPending = true;
    try {
      const remote = await import('./sidetab/remote.js');
      const hosts = remote.configuredRemoteSidetabHosts();
      const results = await remote.fetchRegisteredRemoteSidetabRows(hosts);
      const next = new Map<string, import('./sidetab/list.js').SidetabRow>();
      for (const row of remoteSidetabRows) if (row.remoteHost) next.set(row.id, row);
      for (const result of results) {
        for (const [key, row] of next) if (row.remoteHost === result.host) next.delete(key);
        if (result.error) {
          const stale = remote.markRemoteHostUnavailable(remoteSidetabRows, result.host, result.error);
          for (const row of stale) if (row.remoteHost === result.host) next.set(row.id, row);
        } else {
          for (const row of result.rows) next.set(row.id, row);
        }
      }
      remoteSidetabRows = [...next.values()];
      refreshSidetabRows();
    } catch { /* Remote sidetab is opt-in; local rows remain available. */ }
    finally { remoteSidetabRefreshPending = false; }
  };
  const switchSidetabSession = async (requestedSessionId?: string, sourcePtyId?: string): Promise<void> => {
    const selected = sidetabRows[sidetabSelected];
    const targetId = requestedSessionId ?? (selected?.kind === 'tui' ? selected.sessionId : undefined);
    if (!targetId || targetId === id) return;
    if (sourcePtyId && !sidetabRows.some((row) => row.ptyId === sourcePtyId && row.sessionId === targetId)) {
      status = '세션 목록이 갱신되어 전환을 취소했습니다';
      return;
    }
    if (busy) {
      status = '응답 중에는 세션을 전환할 수 없습니다';
      return;
    }
    const target = loadSession(targetId);
    if (!target) {
      status = '세션을 읽을 수 없습니다 · 목록을 다시 열어 주세요';
      return;
    }
    saveMessageBlockSession();
    id = targetId;
    restoreMessageBlockSession(targetId);
    lastFoldTargetKey = null;
    session = target;
    messages = target.messages;
    sidetabSectionOrder = normalizeSidetabSectionOrder(target.meta.uiState?.sidetabSectionOrder);
    sidetabSectionScroll = null;
    sidetabDragSource = null;
    sidetabDragOver = null;
    setActiveSessionId(targetId);
    updatePtyManifestSession(`tui:${process.pid}`, targetId);
    backgroundJobs.setSessionId(targetId);
    const statusSources = await import('../tui-client/local-chat-turn.js');
    observeSession(targetId, statusSources.onLocalChatBackgroundStatus);
    goalContinue?.noteHumanTurn();
    lastResumeRows = null;
    expandedToolBlocks.clear();
    activity = [];
    agents = [];
    activeShellCalls.clear();
    scroll = 0;
    maxScroll = 0;
    status = '세션 전환됨 · Enter 전송 · Ctrl+Q 종료';
  };
  const focusSidetab = async (): Promise<void> => {
    sidetabEnabled = true;
    if (sidetabAttachments?.hasRemoteView()) sidetabAttachments.showMain();
    if (!sidetabOpen) await toggleSidetab();
    sidetabMode = 'list';
    sidetabFocused = true;
    status = '사이드탭 포커스 · g 그래프/자원 · 1–9 선택 · Esc 입력';
  };
  const returnToParent = (): void => {
    sidetabAttachments?.showMain();
    sidetabFocused = false;
    focus = 'input';
    status = '부모 채팅 · 입력 포커스';
  };
  const returnToInput = (): void => {
    sidetabFocused = false;
    focus = 'input';
    status = '입력 포커스';
  };
  const selectSidetabIndex = async (index: number): Promise<void> => {
    refreshSidetabRows();
    if (index < 0 || index >= sidetabRows.length) {
      status = `사이드탭 ${index + 1}번 항목 없음`;
      return;
    }
    sidetabSelected = index;
    sidetabSectionScroll = null;
    const selected = sidetabRows[index]!;
    if (toggleWorkspaceRow(selected)) render();
    else if (sidetabViewMode === 'workspaces') status = '워크스페이스 PTY 선택 · /side bind 로 결합 · Enter 로 attach';
    else if (selected.kind === 'tui') await switchSidetabSession(selected.sessionId, selected.ptyId);
    else {
      await ensureSidetabAttachments();
      sidetabAttachments?.select(selected);
    }
  };
  const sidetabRowById = (rowId: string): import('./sidetab/list.js').SidetabRow | undefined => {
    refreshSidetabRows();
    return sidetabRows.find((row) => row.id === rowId);
  };

  let restoreCliStderrSink: (() => void) | null = null;
  let restoreTuiStderrOwner: (() => void) | null = null;

  const refreshAtPicker = async (): Promise<void> => {
    const query = input.editor.text.slice(0, input.editor.cursor).match(/(?:^|\s)@([\p{L}\p{N}_./~\\-]*)$/u);
    if (!query) {
      atPicker = null;
      dismissedAtQuery = '';
      if (status.startsWith('@ 파일')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
      return;
    }
    const prefix = query[1] ?? '';
    const start = input.editor.cursor - prefix.length - 1;
    const key = start + ':' + prefix;
    if (dismissedAtQuery === key) { atPicker = null; return; }
    if (!atPickerApi) {
      atPickerApi = await import('./input/at-picker.js');
      debug.log('tui.next', 'at-picker-module-loaded', { onDemand: true });
    }
    const candidates = await atPickerApi.listAtFiles(prefix, process.cwd());
    atPicker = { query: { prefix, start, end: input.editor.cursor }, candidates, selected: 0 };
    status = candidates.length ? '@ 파일 첨부 후보 · ↑↓ 선택 · Enter 추가' : '@ 파일 후보 없음 · 계속 입력';
  };

  const refreshSlashPicker = async (): Promise<void> => {
    const draft = input.editor.text;
    if (draft !== dismissedSlashDraft) dismissedSlashDraft = '';
    if (input.editor.cursor !== draft.length || !/^\/[\w-]*$/.test(draft) || draft === dismissedSlashDraft) {
      slashPicker = null;
      if (status.startsWith('슬래시 명령')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
      return;
    }
    const registry = await loadNextTuiRouteRegistry();
    const candidates = nextSlashCandidates(draft, registry.NEXT_TUI_ROUTE_REGISTRY,
      registry.NEXT_TUI_INPUT_CONTEXT, registry.resolveNextTuiRoute)
      .map(({ text, description }) => ({ value: text, description }));
    slashPicker = candidates.length ? { query: draft.slice(1), candidates, selected: 0 } : null;
    slashNavigated = false;
    if (candidates.length) status = '슬래시 명령 · ↑↓ 선택 · Tab 완성 · Esc 닫기';
  };

  /** Every busy path ends here: the door learns the turn is over, then the queue moves or returns to the prompt. */
  const settle = (): void => {
    wakeup?.gate.noteTurnSettled();
    const result = queue.settle(input.editor.text);
    if (result.kind === 'restore') {
      input.setText(result.text);
      input.clearHistory();
      status = `응답 취소됨 · 대기 ${result.count}건을 입력칸으로 · Enter 전송`;
      debug.log('tui.next', 'queue-restored', { count: result.count });
    } else if (result.kind === 'wake') injectKey(queueWake);
  };

  /** Sends the head of the queue through the ordinary idle submit path (slash commands included). */
  const dispatchQueued = (): void => {
    const handoff = queue.dequeue();
    if (handoff.kind !== 'submit') return;
    // 대기열에서 나가는 것도 사람이 쳐 둔 턴이다 — 골 이어가기의 연속·지문을 비운다(r3 must-fix).
    goalContinue?.noteHumanTurn();
    restoreDraft = input.editor.text;
    input.setText(handoff.text);
    focus = 'input';
    input.clearHistory();
    debug.log('tui.next', 'queue-dispatched', { length: handoff.text.length, remaining: handoff.remaining });
    replay.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  };

  /** Apply the execution-side snapshot captured when Esc was pressed. */
  const applyShellEscDecision = (): void => {
    shellEscSnapshotPending = false;
    const shellDecision = nextTuiShellEscDecision(activeShellCalls, monotonicNowMs());
    if (shellDecision !== 'confirm') {
      turnAbort?.abort();
      queue.markInterrupted();
      status = '응답 취소 중';
    } else {
      stopConfirmationSelection = 1;
      stopConfirmationKind = shellDecision === 'confirm' ? 'long-shell' : 'turn';
      status = shellDecision === 'confirm' ? '긴 셸 명령 중단 확인 · 기본 N' : '응답 중단 확인 · 기본 N';
    }
    render();
  };

  const applyPushNowDecision = (requestId: string, outcome: 'ready' | 'interrupted' | 'deferred', activeTools: string[]): void => {
    if (requestId !== pushNowRequestId) return;
    if (outcome === 'ready') {
      if (!busy || queue.count === 0 || pushNowPhase !== 'checking') {
        pushNowSnapshotPending = false;
        pushNowRequestId = null;
        pushNowPhase = null;
        return;
      }
      pushNowPhase = 'committing';
      if (pushNowCommit.current?.(requestId) !== true) {
        pushNowSnapshotPending = false;
        pushNowRequestId = null;
        pushNowPhase = null;
        status = '도구 상태 확인 불가 · 대기 입력 유지';
      }
      render();
      return;
    }
    pushNowSnapshotPending = false;
    pushNowRequestId = null;
    // The child has committed an interrupt, but the turn can still emit events until it settles.
    if (outcome !== 'interrupted') pushNowPhase = null;
    if (!busy || queue.count === 0) return;
    if (outcome === 'deferred') {
      status = '작업 중 · 완료 뒤 대기 입력 전송';
      debug.log('tui.next', 'queue-push-now', { count: queue.count, action: 'deferred', tools: activeTools, requestId });
    } else {
      turnAbort?.abort();
      status = '⚡ 지금 밀어 넣기 · 대기 입력 전송 중';
      debug.log('tui.next', 'queue-push-now', { count: queue.count, action: 'interrupt', requestId });
    }
    render();
  };

  /** One chat turn on the shared REPL child — a person's submit, or an internal turn the door opened (banner). */
  const startChatTurn = (turnText: string, banner?: string): void => {
    activity = [];
    agents = [];
    activeShellCalls.clear();
    activeToolCalls.clear();
    stopConfirmationSelection = null;
    stopConfirmationKind = null;
    pushNowSnapshotPending = false;
    pushNowRequestId = null;
    pushNowPhase = null;
    const attachments = [...atAttachmentTokens].filter(([token]) => turnText.includes(token)).map(([, path]) => path);
    if (!id) {
      id = createSession({ source: 'tui' }).id;
      restoreMessageBlockSession(id);
      setActiveSessionId(id);
      session = loadSession(id);
      backgroundJobs.setSessionId(id);
    }
    const turnSessionId = id;
    busy = true;
    telemetrySessionId = turnSessionId;
    const turnStartedAt = performance.now();
    turnElapsedMs = 0;
    measuredUsage = undefined;
    if (turnElapsedTimer !== null) clearInterval(turnElapsedTimer);
    turnElapsedTimer = setInterval(() => {
      if (tuiClosed || !busy || id !== turnSessionId) return;
      turnElapsedMs = nextTuiElapsedMs(turnStartedAt, performance.now(), turnElapsedMs);
      render();
    }, 250);
    // herdr pane 이면 턴 시작·끝을 working → idle 로 신고한다(`eln herdr prompt --wait` 가 이것을 기다린다).
    // 녹음기는 startTuiSelfReport 가 이미 열었다 — 없으면 아무것도 안 한다.
    reportTuiTurn('busy');
    // 턴 시작도 진전이다(SURVIVAL-PROGRESS-CLOCK) — 마지막 진전 시각의 0초를 잡는다.
    reportTuiProgress();
    // An internal turn says where it came from (classic «↻ 자동 재개(<origin>): <이유>») instead of looking typed.
    // TUI-GOAL-INTERIM-QUIET — the log draws a recognized internal input in place («↻ 자동 재개(<origin>)»), so the
    // notice list would only repeat it under the last reply; the status line still names it while the turn runs.
    if (banner && !internalTurnOriginOfText(turnText)) pushNotice(banner);
    status = banner ? `${safeStatusText(banner)} · 응답 중 · Esc 취소` : '응답 중 · Esc 취소';
    dashboardRuntime.beginTurnStartSegments(turnSessionId);
    // 이번 턴이 만든 답만 골 이어가기 판정에 쓴다 — 시작 때 세션 길이를 잡아 둔다.
    const messagesAtTurnStart = messages.length;
    const turn = startNextTuiTurn({ sessionId: turnSessionId, text: turnText }, {
      run: async ({ sessionId, text, signal }, onDelta, onCompact, onNotice, onAgent, onStatus, onMessageBlock) => {
        const { runLocalChatTurn, onLocalChatBackgroundStatus, requestLocalChatShellActivitySnapshot, requestLocalChatPushNow, commitLocalChatPushNow } = await import('../tui-client/local-chat-turn.js');
        shellActivitySnapshotRequest.current = () => requestLocalChatShellActivitySnapshot(sessionId);
        pushNowRequest.current = (requestId) => requestLocalChatPushNow(sessionId, requestId);
        pushNowCommit.current = (requestId) => commitLocalChatPushNow(sessionId, requestId);
        observeSession(sessionId, onLocalChatBackgroundStatus);
        return runLocalChatTurn(sessionId, text, signal, undefined, undefined, onDelta,
          { onCompact: (outcome) => onCompact(outcome.status ?? ''), onMessageBlock,
            onMeasuredUsage: (usage) => {
              if (id !== turnSessionId || !busy) return;
              measuredUsage = usage;
              render();
            } }, attachments, onStatus, onAgent,
          (event) => {
            if (event.phase === 'snapshot') {
              activeShellCalls.clear();
              for (const call of event.calls) activeShellCalls.set(call.id, { name: call.name, startedAtMonotonicMs: call.startedAtMonotonicMs });
              if (shellEscSnapshotPending) applyShellEscDecision();
              else render();
              return;
            }
            if (event.phase === 'start') {
              activeShellCalls.set(event.id, { name: event.name, startedAtMonotonicMs: event.startedAtMonotonicMs });
              status = 'Bash 실행 · Esc 취소';
            } else {
              activeShellCalls.delete(event.id);
              status = '응답 중 · Esc 취소';
            }
            render();
          }, (event) => {
            if (event.phase === 'snapshot') {
              activeToolCalls.clear();
              for (const call of event.calls) activeToolCalls.set(call.id, call.name);
            } else if (event.phase === 'start') activeToolCalls.set(event.id, event.name);
            else activeToolCalls.delete(event.id);
            // The execution-side set decides interruption; this mirror shows live non-shell work.
            const nonShellTools = [...new Set([...activeToolCalls.values()].filter((name) => name !== 'Bash' && name !== 'RunShell'))];
            if (nonShellTools.length > 0) {
              status = '도구 실행 · Esc 취소';
              render();
            } else if (event.phase === 'finish' && event.name !== 'Bash' && event.name !== 'RunShell') {
              status = '응답 중 · Esc 취소';
              render();
            }
          }, (event) => applyPushNowDecision(event.requestId, event.outcome, event.activeTools));
      },
      onProgress: reportTuiProgress,
      onStreamOpen: () => dashboardRuntime.endTurnStartSegments(turnSessionId, 'stream-open'),
      onPreview: (preview) => {
        // Child deltas are provisional and may include tool or diagnostic text.
        const progress = preview ? streamReplyProgress(turnSessionId) : null;
        activity = progress ? streamReplyLines(progress, process.stdout.columns || 80) : [];
        render();
      },
      onCompact: (compactStatus) => {
        // Compaction details may include child diagnostics; the basic chat shows only the state.
        // Settlement still reports the count. A head of 대화 압축 완료 folds to 완료 and
        // drops both the count and 응답 완료 from the 24-row footer.
        if (/^압축 \d+→\d+ 메시지$/.test(compactStatus)) lastCompactCount = compactStatus;
        status = projectUserReplyStatus(compactStatus);
        session = loadSession(turnSessionId);
        messages = session?.messages ?? [];
        expandedToolBlocks.clear();
        render();
      },
      onNotice: (line) => { pushNotice(line); render(); },
      onStatus: (line) => {
        if (isNextTuiContextCountStatus(line)) return;
        status = projectUserReplyStatus(line);
        render();
      },
      onAgent: (event) => {
        agents = applyAgentEvent(agents, event);
        reportTuiProgress();
        render();
      },
      onMessageBlock: (block) => {
        const state = messageBlockSessions.restore(turnSessionId);
        upsertMessageBlock(state, block, Math.max(0, messagesAtTurnStart));
        messageBlockSessions.save(turnSessionId, state);
        if (id === turnSessionId) {
          session = loadSession(turnSessionId);
          messages = session?.messages ?? messages;
          messageBlocks = state.blocks;
          messageBlockLevels = state.levels;
          messageBlockRawTexts = state.rawTexts;
          messageBlockAfterMessageIndexes = state.afterMessageIndexes;
        }
        reportTuiProgress();
        if (id === turnSessionId) render();
      },
      onSettled: async (outcome) => {
        if (turnElapsedTimer !== null) clearInterval(turnElapsedTimer);
        turnElapsedTimer = null;
        turnElapsedMs = nextTuiElapsedMs(turnStartedAt, performance.now(), turnElapsedMs);
        if (outcome.kind !== 'completed') measuredUsage = undefined;
        pendingEcho = null;
        stopConfirmationSelection = null;
        stopConfirmationKind = null;
        activeShellCalls.clear();
        activeToolCalls.clear();
        shellActivitySnapshotRequest.current = null;
        pushNowCommit.current = null;
        pushNowRequest.current = null;
        shellEscSnapshotPending = false;
        pushNowSnapshotPending = false;
        pushNowRequestId = null;
        pushNowPhase = null;
        const compactNote = outcome.compacted ? `${lastCompactCount ?? '대화 압축 완료'} · ` : '';
        lastCompactCount = null;
        status = outcome.kind === 'cancelled' ? `${compactNote}응답 취소됨 · Enter 전송`
          : outcome.kind === 'failed' ? `${compactNote}응답 실패 · ↑ 이전 입력 후 Enter 재시도`
            : outcome.goalStopReason === 'max_turns' ? 'Turn cap reached — continue with your next input'
              : `${compactNote}응답 완료 · Enter 전송 · Ctrl+Q 종료`;
        const failure = turnReplyFailureMessage(turnSessionId, outcome.kind === 'failed', outcome.authFailureKind);
        if (failure) appendMessage(turnSessionId, {
          role: 'assistant', content: failure, ts: new Date().toISOString(), replyFinal: false, replyFailure: true,
          ...(outcome.authFailureKind ? { replyFailureKind: outcome.authFailureKind } : {}),
        });
        session = loadSession(turnSessionId);
        messages = session?.messages ?? [];
        activity = [];
        // Keep the completed tree visible after settlement; a new turn resets it.
        busy = false;
        turnAbort = null;
        scroll = 0;
        settle();
        // TUI-GOAL-INTERIM-QUIET 관측 — 그리기 계획(log-view 와 같은 함수)의 접힘 수가 바뀐 턴 끝에 한 줄.
        try {
          const shown = countInterimDisplay(planInterimDisplay(messages));
          if (shown.folded !== interimFoldedShown) {
            interimFoldedShown = shown.folded;
            debug.log('tui.goal-interim', 'folded', { surface: 'next', ...shown });
          }
        } catch { /* fail-soft: 관측은 턴 정리를 막지 않는다 */ }
        const auto = decideNextTuiAutoContinue(outcome, queue.count, input.editor.text);
        if (goalContinue && auto === 'complete') goalContinue.noteGoalCompleted();
        if (goalContinue && auto === 'check') {
          try {
            goalContinue.noteTurnEnded({ lines: dashboardRuntime.replyLinesOfThisTurn(messages, outcome.compacted ? 'after-last-user' : messagesAtTurnStart), failed: outcome.kind === 'failed' });
            goalContinue.check();
          } catch { /* fail-soft: 골 이어가기는 턴 정리를 막지 않는다 */ }
        } else if (goalContinue && auto === 'yield') {
          debug.log('tui.proactive', 'yield-user-input', { queued: queue.count, bufferedChars: input.editor.text.length });
        }
        const switchAfterTurn = pendingSidetabSwitch;
        pendingSidetabSwitch = null;
        try {
          if (switchAfterTurn) await switchSidetabSession(switchAfterTurn);
        } finally {
          try {
            render();
          } finally {
            // Publish idle only after the canonical history has replaced the stream preview
            // on screen. External PTY observers use this edge as their capture boundary.
            reportTuiTurn('idle');
          }
        }
      },
    });
    turnAbort = turn.controller;
    turnDone = turn.done.then(() => {});
  };

  if (sidetabOpen) {
    sidetabApi = await import('./sidetab/list.js');
    sidetabRows = sidetabApi.loadSidetabRows(getSidetabViewMode() === 'all', undefined, sidetabScope());
    void refreshHerdrSidetabRows();
    sidetabRefreshTimer = setInterval(() => {
      if (!sidetabApi || !sidetabOpen) return;
      refreshSidetabRows();
      refreshRichView();
      void refreshHerdrSidetabRows();
      render();
    }, 1_000);
  }
  // Load the route table before accepting Enter so the first echo has no import wait.
  await loadNextTuiRouteRegistry();
  if (compactMode) initTuiPrimary();
  else initTui();
  const { installTuiStderrOwner } = await import('../surface/tui-stderr-owner.js');
  restoreTuiStderrOwner = installTuiStderrOwner((line) => {
    pushInternalNotice(`[stderr] ${line}`);
    render();
  });
  restoreCliStderrSink = setCliStderrSink(({ source, exitCode, raw }) => {
    // Keep the exact bytes in the normal debug log while rendering only failures through the
    // TUI-owned notice area. Writing the CLI stream to process.stderr would overwrite the prompt.
    debug.log('tui.cli-stderr', 'captured', {
      source,
      exitCode,
      text: raw.toString('utf8'),
      rawBase64: raw.toString('base64'),
      byteLength: raw.length,
    });
    if (exitCode !== 0) {
      const text = raw.toString('utf8').trim() || `${source} exited with rc=${exitCode}`;
      pushInternalNotice(`[${source} stderr · rc=${exitCode}] ${text}`);
      render();
    }
  });
  process.stdout.on('resize', render);
  let simWatchTimer: ReturnType<typeof setInterval> | null = null;
  try {
    {
      const { createNextTuiWakeup, setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      const { setNextSidetabHandler, setNextSidetabIpcEnabled, setNextTuiShellApprovalHandler, setNextTuiShellApprovalCancelHandler, setNextMemberBoardSessionSource } = await import('../tui-client/local-chat-turn.js');
      setNextMemberBoardSessionSource(options.memberBoardSession ?? null);
      const { createNextSidetabHostHandler } = await import('./sidetab/nl-tool.js');
      setNextSidetabIpcEnabled(true);
      wakeup = createNextTuiWakeup({
        isTurnRunning: () => busy,
        isInputForeground: isInternalWakeForeground,
        enableSeatMailWake: true,
        getBufferText: () => input.editor.text,
        getQueuedCount: () => queue.count,
        pendingKeyCount: tuiPendingKeyCount,
        requestYield: () => injectKey(internalWake),
        notify: (line) => { pushNotice(line); render(); },
      });
      setNextTuiWakeupTool(wakeup.tool);
      setNextTuiShellApprovalHandler(shellApproval.begin);
      setNextTuiShellApprovalCancelHandler(shellApproval.cancel);
      setNextSidetabHandler(createNextSidetabHostHandler({
        rows: async () => { if (!sidetabApi) sidetabApi = await import('./sidetab/list.js'); refreshSidetabRows(); return sidetabRows; },
        selected: () => sidetabSelected,
        switchSession: async (row) => {
          if (toggleWorkspaceRow(row)) { render(); return { ok: true, action: 'expand', target: row.id }; }
          if (!row.sessionId) return { error: '전환할 TUI 세션 id가 없습니다' };
          const index = sidetabRows.findIndex((item) => item.id === row.id);
          if (index < 0) return { error: '세션 목록이 갱신되어 전환을 취소했습니다' };
          if (busy) {
            sidetabSelected = index;
            pendingSidetabSwitch = row.sessionId;
            return { ok: true, action: 'switch', target: row.id, scheduled: 'after-turn' };
          }
          sidetabSelected = index;
          await switchSidetabSession(row.sessionId, row.ptyId);
          render();
          return { ok: true, action: 'switch', target: row.id };
        },
        attach: async (row) => {
          if (toggleWorkspaceRow(row)) { render(); return { ok: true, action: 'expand', target: row.id }; }
          await ensureSidetabAttachments();
          const ok = sidetabAttachments!.select(row);
          render();
          return { ok, action: 'attach', target: row.id };
        },
        detach: () => { if (sidetabAttachments?.hasRemoteView()) sidetabAttachments.showMain(); else if (sidetabAttachments?.hasModal()) { sidetabAttachments.handleKey({ name: '\\', ctrl: true, shift: false, raw: '' }); sidetabAttachments.handleKey({ name: 'd', ctrl: false, shift: false, raw: 'd' }); } render(); return { ok: true, action: 'detach' }; },
        spawn: async (character) => { await ensureSidetabAttachments(); const ok = sidetabAttachments!.spawn(character); refreshSidetabRows(); render(); return { ok, action: 'new', character }; },
        runMission: async (agent, mission) => { await ensureSidetabAttachments(); const result = await sidetabAttachments!.runMission(agent, mission); refreshSidetabRows(); render(); return result; },
        runMissionPair: async (agent, mission, parallelMission) => { await ensureSidetabAttachments(); const result = await sidetabAttachments!.runMissionPair(agent, mission, parallelMission); refreshSidetabRows(); render(); return result; },
        kill: async (row) => { await ensureSidetabAttachments(); const ok = sidetabAttachments!.kill(row); refreshSidetabRows(); render(); return { ok, action: 'kill', target: row.id }; },
      }));
      const gate = wakeup.gate;
      goalContinue = dashboardRuntime.createGoalContinue({
        startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
        notify: (line) => { pushNotice(line); render(); },
      });
    }
    render();
    let simWatchOffset = 0;
    const seenSimWatchEventIds = new Set<string>();
    const legacySimMessageCounts = new Map<string, number>();
    for (const message of messages) {
      if (message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.startsWith('SIM · ')) continue;
      const eventId = message.content.slice('SIM · '.length).split(' · ', 1)[0] ?? '';
      if (eventId.startsWith('[')) legacySimMessageCounts.set(message.content, (legacySimMessageCounts.get(message.content) ?? 0) + 1);
      else if (eventId) seenSimWatchEventIds.add(eventId);
    }
    simWatchTimer = simWorld ? setInterval(() => {
      try {
        const batch = simWorldWatch!.readSimWorldWatchEvents(simWorld, simWatchOffset);
        simWatchOffset = batch.offset;
        let appended = false;
        for (const event of batch.events) {
          if (seenSimWatchEventIds.has(event.id)) continue;
          if (event.id.startsWith('legacy:')) {
            const legacyContents = [
              `SIM · [${event.at}] ${event.runId} · ${event.event} · ${event.verdict}`,
              ...(event.sequence ? [`SIM · [${event.at}] ${event.runId}#${event.sequence} · ${event.event} · ${event.verdict}`] : []),
            ];
            const legacy = legacyContents.find((content) => (legacySimMessageCounts.get(content) ?? 0) > 0);
            if (legacy) {
              const count = legacySimMessageCounts.get(legacy)!;
              if (count === 1) legacySimMessageCounts.delete(legacy); else legacySimMessageCounts.set(legacy, count - 1);
              continue;
            }
          }
          const content = `SIM · ${event.id} · ${simWorldWatch!.renderSimWorldWatchEvent(event)}`;
          appendMessage(id!, { role: 'assistant', content, ts: event.at });
          seenSimWatchEventIds.add(event.id);
          appended = true;
        }
        if (!appended) return;
        session = loadSession(id!);
        messages = session?.messages ?? [];
        render();
      } catch (error) {
        if (simWatchTimer !== null) clearInterval(simWatchTimer);
        simWatchTimer = null;
        status = 'SIM 관측 감시 중단';
        pushNotice(safeStatusText(error instanceof Error ? error.message : String(error)));
        render();
      }
    }, 250) : null;
    while (true) {
      const replayed = replay.shift();
      const rawKey = replayed ?? await readKey();
      // TUI-PASTE-ECHO — 긴 붙여넣기는 입력창에 자리표시 한 덩어리로(제출 때 원문으로 되돌린다).
      let key: Key = input.foldKey(rawKey);
      // Ctrl+V shares classic's image-first, text-fallback contract; bracketed file/path paste remains unchanged.
      if (key.ctrl && (key.name === 'v' || key.name === 'V' || key.name === 'ㅍ') && focus === 'input') {
        const pasted = await readClipboardPaste({
          hasImage: hasClipboardImage,
          attachImage: async () => {
            const registered = await registerClipboardImageAttachment(clipboardAttachments);
            if (!registered) return null;
            const { attachment, isNew } = registered;
            atAttachmentTokens.set(attachment.token, attachment.sourcePath);
            await refreshVisibleContextAttachmentArea();
            debug.log('tui.paste', 'image-attached', {
              surface: 'next', filename: attachment.filename, reused: !isNew,
            });
            return `${attachment.token} `;
          },
          readText: readClipboardText,
        });
        if (pasted.kind === 'image') {
          input.setEditor(inlineEditorInsert(input.editor, pasted.value));
          input.clearHistory();
          render();
          continue;
        }
        const clip = pasted.kind === 'text' ? pasted.text : null;
        debug.log('tui.paste', 'clipboard-read', {
          surface: 'next', chars: clip?.length ?? 0, image: pasted.imageDetected,
        });
        if (!clip) {
          status = pasted.imageDetected
            ? '클립보드 이미지를 첨부하지 못했습니다 · 다시 시도'
            : '클립보드에 붙여넣을 글이 없습니다 · Enter 전송';
          render();
          continue;
        }
        key = { name: 'paste', ctrl: false, shift: false, raw: '', paste: input.foldPaste(clip) };
      }
      if (key === queueWake) {
        if (!busy) dispatchQueued();
        render();
        continue;
      }
      if (key === internalWake) {
        // The door rechecks focus and human input after the yield key reaches this loop.
        const request = wakeup?.takePendingIfIdle();
        if (request) startChatTurn(request.input, wakeup!.banner(request));
        render();
        continue;
      }
      if (!replayed) {
        const step = mouseResidue.accept(key, Date.now());
        if (step.kind === 'hold') {
          // A held character must not wait for the next keystroke to appear.
          if (residueTimer !== null) clearTimeout(residueTimer);
          residueTimer = setTimeout(() => {
            residueTimer = null;
            injectKey(residueWake);
          }, MOUSE_RESIDUE_WINDOW_MS);
          continue;
        }
        if (residueTimer !== null) clearTimeout(residueTimer);
        residueTimer = null;
        if (step.kind === 'release') {
          replay.push(...step.keys.filter((held) => held !== residueWake));
          continue;
        }
        if (step.kind === 'mouse') {
          // The ESC that led this report already ran as Escape; undo its prompt effect.
          // An aborted turn cannot be undone, so its "cancelling" status stays truthful.
          if (escapeSnapshot && !escapeSnapshot.busy) {
            input.setEditor(escapeSnapshot.editor);
            status = escapeSnapshot.status;
            focus = escapeSnapshot.focus;
          }
          escapeSnapshot = null;
          if (step.wheel) scroll = wheelScroll(scroll, step.wheel, maxScroll);
          render();
          continue;
        }
        if (key === residueWake) continue;
        if (key.name === 'escape' && key.raw === '\x1b') {
          escapeSnapshot = { editor: input.editor, status, focus, busy };
          mouseResidue.arm(Date.now());
        } else {
          escapeSnapshot = null;
        }
      }
      if (welcomePending) welcomePending = false;
      if (sidetabChordPending) {
        sidetabChordPending = false;
        if (sidetabChordTimer !== null) clearTimeout(sidetabChordTimer);
        sidetabChordTimer = null;
        if (key.name === 'up' || key.name === 'down') {
          if (!sidetabApi) sidetabApi = await import('./sidetab/list.js');
          refreshSidetabRows();
          if (sidetabRows.length > 0) {
            const delta = key.name === 'up' ? -1 : 1;
            sidetabSelected = (sidetabSelected + delta + sidetabRows.length) % sidetabRows.length;
            sidetabSectionScroll = null;
            if (sidetabRows[sidetabSelected]!.kind === 'workspace') {
              // Workspace parents are toggled with Enter; arrow selection never routes them to PTY attach.
            } else if (getSidetabViewMode() === 'workspaces') {
              status = '워크스페이스 PTY 선택 · /side bind 로 결합 · Enter 로 attach';
            } else if (sidetabRows[sidetabSelected]!.kind === 'tui') await switchSidetabSession(sidetabRows[sidetabSelected]!.sessionId, sidetabRows[sidetabSelected]!.ptyId);
            else {
              await ensureSidetabAttachments();
              sidetabAttachments?.select(sidetabRows[sidetabSelected]!);
            }
          }
          render();
          continue;
        }
        if (key.name.toLowerCase() === 's') {
          await focusSidetab();
          render();
          continue;
        }
        if (key.name.toLowerCase() === 'p') {
          returnToParent();
          render();
          continue;
        }
        if (/^[1-9]$/.test(key.name)) {
          sidetabEnabled = true;
          if (!sidetabOpen) await toggleSidetab();
          await selectSidetabIndex(Number(key.name) - 1);
          render();
          continue;
        }
        if (key.name === 'escape') {
          returnToInput();
          render();
          continue;
        }
        if (key.name.toLowerCase() === 'd' && sidetabAttachments?.hasModal()) {
          sidetabAttachments.handleKey({ name: '\\', ctrl: true, shift: false });
          sidetabAttachments.handleKey(key);
          render();
          continue;
        }
        if (sidetabAttachments?.hasRemoteView()) sidetabAttachments.showMain();
        await toggleSidetab();
      }
      if (key.ctrl && key.name === '\\') {
        if (!sidetabEnabled) {
          status = '사이드탭 off · /side on 으로 이 세션에서 켜기';
          render();
          continue;
        }
        sidetabChordPending = true;
        sidetabChordTimer = setTimeout(() => {
          if (!sidetabChordPending) return;
          sidetabChordPending = false;
          sidetabChordTimer = null;
          if (sidetabAttachments?.hasRemoteView()) sidetabAttachments.showMain();
          void toggleSidetab().then(render);
        }, 300);
        continue;
      }
      if (sidetabRename && (key.name === 'escape' || key.name === 'enter' || key.name === 'return')) {
        const pending = sidetabRename;
        sidetabRename = null;
        const nickname = input.editor.text.trim();
        input.setEditor(pending.previousEditor);
        if (key.name === 'escape') status = '사이드탭 이름 변경 취소';
        else {
          const row = sidetabRowById(pending.rowId);
          if (!nickname || !row?.ptyId) status = 'PTY 이름을 입력하거나 현재 항목을 다시 확인하세요';
          else {
            const { renamePty } = await import('../pty-shell/registry.js');
            status = renamePty(row.ptyId, nickname) ? 'PTY 이름 변경 완료' : 'PTY 이름 변경 실패';
            refreshSidetabRows();
          }
        }
        render();
        continue;
      }
      if (sidetabCloseRowId) {
        if (key.name.toLowerCase() === 'y') {
          const row = sidetabRowById(sidetabCloseRowId);
          if (row) {
            await ensureSidetabAttachments();
            status = sidetabAttachments?.kill(row) ? 'PTY 종료 요청 완료' : 'PTY 종료 불가';
            refreshSidetabRows();
          } else status = 'PTY 항목을 찾을 수 없습니다';
        } else status = 'PTY 종료 취소';
        sidetabCloseRowId = null;
        render();
        continue;
      }
      if (sidetabContextMenu) {
        // A terminal can emit a release after right-click; the parser may
        // normalize right-button release to an empty key. Keep the menu open.
        if ((key.name === 'mouse' && (key.mouse?.type === 'release' || key.mouse?.type === 'motion'))
          || (key.name === '' && !key.raw)) {
          render();
          continue;
        }
        const pending = sidetabContextMenu;
        sidetabContextMenu = null;
        const chosen = ({ '1': 'open', '2': 'rename', '3': 'close' } as const)[key.name as '1' | '2' | '3'];
        const allowed = pending.menu.items.some((item) => item.kind === 'command' && item.id === chosen);
        const row = chosen && allowed ? sidetabRowById(pending.rowId) : undefined;
        if (chosen === 'open' && row) await selectSidetabIndex(sidetabRows.findIndex((item) => item.id === row.id));
        else if (chosen === 'rename' && row?.ptyId) {
          sidetabRename = { rowId: row.id, previousEditor: input.editor };
          input.setText('');
          sidetabFocused = false;
          status = '새 PTY 이름 입력 · Enter 저장 · Esc 취소';
        } else if (chosen === 'close' && row) {
          sidetabCloseRowId = row.id;
          status = 'PTY 종료 확인 · y 실행 · 다른 키 취소';
        } else status = chosen ? '사이드탭 항목을 사용할 수 없습니다' : '사이드탭 메뉴 닫힘';
        render();
        continue;
      }
      if (sidetabFocused && key.name === 'escape') {
        if (sidetabRich) { sidetabRich = false; render(); continue; }
        returnToInput();
        render();
        continue;
      }
      if (sidetabFocused && sidetabOpen && key.name.toLowerCase() === 'g') {
        if (sidetabRich) sidetabRich = false;
        else {
          try {
            const [{ loadDeclaredPluginHandler }, { BUILTIN_DIR }] = await Promise.all([
              import('../plugins/core/declared-handler.js'), import('../plugins/core/host.js'),
            ]);
            richRead = await loadDeclaredPluginHandler<(runId?: string) => GraphInstanceView | null>(BUILTIN_DIR, 'richSidetabRead');
            richRender = await loadDeclaredPluginHandler<(view: GraphInstanceView, width: number, height: number, selectedNodeId?: string) => string[]>(BUILTIN_DIR, 'graphInstanceTerminal');
            sidetabRich = Boolean(richRead && richRender);
            refreshRichView();
          } catch { status = '그래프 사이드탭을 열 수 없습니다'; }
        }
        render();
        continue;
      }
      if (sidetabDragSource && key.name === 'mouse' && (key.mouse?.type === 'drag' || key.mouse?.type === 'release')) {
        const panelWidth = sidetabApi!.sidetabWidthForTerminal(process.stdout.columns || 0);
        const target = sidetabSectionFrame && key.mouse
          ? sidetabSectionTargetAt(sidetabSectionFrame, key.mouse.row, key.mouse.col, panelWidth) : undefined;
        if (key.mouse?.type === 'drag') sidetabDragOver = target?.kind === 'section' ? target.id : target?.kind === 'end' ? 'end' : null;
        else {
          const before = target?.kind === 'section' ? target.id : target?.kind === 'end' ? 'end' : sidetabDragOver;
          if (before && before !== sidetabDragSource) {
            sidetabSectionOrder = reorderSidetabSections(sidetabSectionOrder, sidetabDragSource, before);
            updateSessionMeta(id!, (meta) => { meta.uiState = { ...meta.uiState, sidetabSectionOrder }; });
            status = '사이드탭 구획 순서 저장';
          }
          sidetabDragSource = null;
          sidetabDragOver = null;
        }
        render();
        continue;
      }
      if (key.name !== 'mouse') { sidetabDragSource = null; sidetabDragOver = null; }
      if (key.name === 'mouse' && (key.mouse?.type === 'click' || key.mouse?.type === 'right-click')) {
        let panelClick = false;
        if (sidetabOpen && sidetabMode === 'list' && !sidetabAttachments?.hasRemoteView() && !sidetabAttachments?.hasModal()) {
          const panelWidth = sidetabApi!.sidetabWidthForTerminal(process.stdout.columns || 0);
          if (key.mouse.col <= panelWidth) {
            const target = sidetabSectionFrame
              ? sidetabSectionTargetAt(sidetabSectionFrame, key.mouse.row, key.mouse.col, panelWidth) : undefined;
            if (target?.kind === 'section' && key.mouse.type === 'click') sidetabDragSource = target.id;
            else {
              sidetabDragSource = null;
              if (target?.kind === 'row') {
                const row = sidetabRows[target.index];
                if (row) {
                  const { sidetabPointerAction, sidetabRowMenu } = await import('./sidetab/interaction.js');
                  const action = sidetabPointerAction(key, [{ rowId: row.id,
                    rect: { row: key.mouse.row, col: 1, width: panelWidth, height: 1 } }]);
                  if (action?.kind === 'select') await selectSidetabIndex(target.index);
                  else if (action?.kind === 'context-menu') {
                    const menu = sidetabRowMenu(row);
                    sidetabContextMenu = { rowId: row.id, menu };
                    status = `${menu.title} · 1 Open here · 2 Rename · 3 Close · Esc 취소`;
                  }
                }
              }
            }
            panelClick = true;
          }
        }
        if (!panelClick) sidetabDragSource = null;
        if (!panelClick && key.mouse.type === 'click' && !sidetabAttachments?.hasModal() && !sidetabAttachments?.hasRemoteView()) {
          const target = foldTargetAtScreenRow(logWindow.foldTargets, logWindow, key.mouse.row);
          if (target) {
            focus = 'log';
            lastFoldTargetKey = target.kind === 'message' ? `message:${target.id}` : `tool:${target.index}`;
            if (target.kind === 'message') {
              const block = messageBlocks.find((candidate) => candidate.id === target.id);
              if (block) messageBlockLevels.set(block.id, (messageBlockLevels.get(block.id) ?? 0) === 0 ? 1 : 0);
            } else if (expandedToolBlocks.has(target.index)) expandedToolBlocks.delete(target.index);
            else expandedToolBlocks.add(target.index);
            saveMessageBlockSession();
          }
        }
        render();
        continue;
      }
      if (sidetabAttachments?.handleKey(key)) {
        render();
        continue;
      }
      if (shellApproval.handleKey(key)) {
        render();
        continue;
      }
      if (stopConfirmationSelection !== null) {
        if (key.name === 'escape') {
          const confirmationKind = stopConfirmationKind;
          stopConfirmationSelection = null;
          stopConfirmationKind = null;
          status = confirmationKind === 'long-shell' ? '긴 셸 명령 계속 실행 · Esc 취소' : '응답 중 · Esc 취소';
        } else if (key.name === 'up' || key.name === 'down') {
          stopConfirmationSelection = stopConfirmationSelection === 0 ? 1 : 0;
        } else if (key.name === 'y' || key.name === 'n' || key.name === 'enter' || key.name === 'return') {
          const stop = key.name === 'y' || ((key.name === 'enter' || key.name === 'return') && stopConfirmationSelection === 0);
          const confirmationKind = stopConfirmationKind;
          stopConfirmationSelection = null;
          stopConfirmationKind = null;
          if (stop) {
            turnAbort?.abort();
            queue.markInterrupted();
            status = '응답 취소 중';
          } else status = confirmationKind === 'long-shell' ? '긴 셸 명령 계속 실행 · Esc 취소' : '응답 중 · Esc 취소';
        }
        render();
        continue;
      }
      const wheel = wheelDirection(key);
      if (wheel) {
        const wheelFrame = sidetabSectionFrame as SidetabSectionFrame | null;
        const panelWidth = sidetabApi?.sidetabWidthForTerminal(process.stdout.columns || 0) ?? 0;
        if (wheelFrame && key.mouse && key.mouse.col <= panelWidth) {
          sidetabSectionScroll = Math.max(0, Math.min(wheelFrame.maxStart,
            wheelFrame.start + (wheel === 'down' ? 3 : -3)));
          render();
          continue;
        }
        // Wheel over the chat moves the log only; the prompt and focus stay as they were.
        scroll = wheelScroll(scroll, wheel, maxScroll);
        render();
        continue;
      }
      if (key.ctrl && key.name === 'q') {
        turnAbort?.abort();
        await turnDone;
        break;
      }
      if (sidetabFocused && /^[1-9]$/.test(key.name)) {
        await selectSidetabIndex(Number(key.name) - 1);
        render();
        continue;
      }
      if (sidetabFocused && sidetabRich && (key.name === 'up' || key.name === 'down')) {
        const count = richNodeCount();
        if (count > 0) richSelectedIndex = (richSelectedIndex + (key.name === 'up' ? -1 : 1) + count) % count;
        render();
        continue;
      }
      if (sidetabFocused && key.name !== 'up' && key.name !== 'down') {
        render();
        continue;
      }
      if (sidetabOpen && (sidetabMode as 'list' | 'new') === 'new') {
        if (key.name === 'escape') {
          sidetabMode = 'list';
        } else {
          const character = ({ s: 'shell', e: 'elanous', c: 'codex', l: 'claude' } as const)[key.name.toLowerCase() as 's' | 'e' | 'c' | 'l'];
          if (character) {
            await ensureSidetabAttachments();
            sidetabAttachments?.spawn(character);
            sidetabMode = 'list';
            refreshSidetabRows();
          }
        }
        render();
        continue;
      }
      if (sidetabOpen && (key.name === 'up' || key.name === 'down')) {
        const next = sidetabApi!.applySidetabKey({ open: sidetabOpen, selected: sidetabSelected }, key.name, sidetabRows.length);
        sidetabSelected = next.selected;
        sidetabSectionScroll = null;
        if (sidetabRows[sidetabSelected]) {
          if (sidetabRows[sidetabSelected]!.kind === 'workspace') { /* Workspace parents have no PTY target. */ }
          else if (getSidetabViewMode() === 'workspaces') status = '워크스페이스 PTY 선택 · /side bind 로 결합 · Enter 로 attach';
          else if (sidetabRows[sidetabSelected]!.kind === 'tui') await switchSidetabSession(sidetabRows[sidetabSelected]!.sessionId, sidetabRows[sidetabSelected]!.ptyId);
          else {
            await ensureSidetabAttachments();
            sidetabAttachments?.select(sidetabRows[sidetabSelected]!);
          }
        }
        render();
        continue;
      }
      if (sidetabOpen && input.editor.text.length === 0 && key.name === 'enter') {
        const selected = sidetabRows[sidetabSelected];
        if (selected) {
          if (toggleWorkspaceRow(selected)) {
            // The workspace parent has no PTY target; refresh to show or hide its member rows.
          } else if (selected.kind === 'tui') await switchSidetabSession(selected.sessionId, selected.ptyId);
          else {
            await ensureSidetabAttachments();
            sidetabAttachments?.select(selected);
          }
          refreshSidetabRows();
        }
        render();
        continue;
      }
      if (busy && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
        if (key.name === 'escape') {
          if (shellEscSnapshotPending) continue;
          shellEscSnapshotPending = true;
          if (shellActivitySnapshotRequest.current?.()) {
            status = '셸 실행 상태 확인 중 · Esc';
            render();
            continue;
          }
          shellEscSnapshotPending = false;
          applyShellEscDecision();
          continue;
        }
        turnAbort?.abort();
        queue.markInterrupted();
        status = '응답 취소 중';
        render();
        continue;
      }
      if (busy && key.ctrl && key.name === 'd') {
        turnAbort?.abort();
        await turnDone;
        break;
      }
      if (!busy && focus === 'input' && !atPicker && !slashPicker && !shellApproval.active()
        && contextAttachmentScrollMax > 0
        && ((key.name === 'pageup' && contextAttachmentScroll > 0)
          || (key.name === 'pagedown' && contextAttachmentScroll < contextAttachmentScrollMax))) {
        const delta = key.name === 'pageup' ? -contextAttachmentScrollStep : contextAttachmentScrollStep;
        contextAttachmentScroll = Math.max(0, Math.min(contextAttachmentScrollMax, contextAttachmentScroll + delta));
        render();
        continue;
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        focus = 'log';
        scroll = Math.max(0, scroll + (key.name === 'pageup' ? 10 : -10));
        render();
        continue;
      }
      // TUI-NEXT-FOLD — Enter/Space fold MessageBlocks; Tab/F still step through detail levels.
      if (focus === 'log' && (isToolFoldToggleKey(key.name) || key.name === 'space')) {
        const visibleTargets = logWindow.foldTargets.filter((candidate) => candidate.end >= logWindow.start
          && candidate.start < logWindow.start + logWindow.rows);
        const targetKey = (candidate: typeof visibleTargets[number]): string => candidate.kind === 'message' ? `message:${candidate.id}` : `tool:${candidate.index}`;
        const target = nextVisibleFoldTarget(visibleTargets, messageBlocks, messageBlockLevels, lastFoldTargetKey);
        if (target?.kind === 'message') {
          lastFoldTargetKey = targetKey(target);
          const block = messageBlocks.find((candidate) => candidate.id === target.id);
          if (block) {
            const current = messageBlockLevels.get(block.id) ?? 0;
            messageBlockLevels.set(block.id, nextMessageBlockDetailLevel(block, current));
          }
          const expanded = block && messageBlockLevels.get(block.id) === 3 && block.detail?.rawRef ? block : undefined;
          if (expanded?.detail?.rawRef && !messageBlockRawTexts.has(expanded.id)) {
            const trace = resolveMessageBlockRawTrace(loadSession(id!)?.messages ?? [], expanded);
            if (trace) {
              messageBlockRawTexts.set(expanded.id, formatMessageBlockRawTrace(trace));
              saveMessageBlockSession();
            }
          }
          saveMessageBlockSession();
          render();
          continue;
        }
        if (target?.kind === 'tool') {
          lastFoldTargetKey = targetKey(target);
          if (expandedToolBlocks.has(target.index)) expandedToolBlocks.delete(target.index);
          else expandedToolBlocks.add(target.index);
          render();
          continue;
        }
      }
      if (focus === 'log' && (key.name === 'up' || key.name === 'down')) {
        scroll = Math.max(0, scroll + (key.name === 'up' ? 1 : -1));
        render();
        continue;
      }
      if (focus === 'log' && key.name === 'escape') {
        focus = 'input';
        render();
        continue;
      }
      const activeAtPicker = atPicker as { query: AtPickerQuery; candidates: AtPickerCandidate[]; selected: number } | null;
      if (!busy && focus === 'input' && activeAtPicker) {
        if (key.name === 'escape') {
          dismissedAtQuery = activeAtPicker.query.start + ':' + activeAtPicker.query.prefix;
          atPicker = null;
          status = '파일 선택 닫힘 · Enter 전송';
          render();
          continue;
        }
        if ((key.name === 'up' || key.name === 'down') && activeAtPicker.candidates.length > 0) {
          activeAtPicker.selected = (activeAtPicker.selected + (key.name === 'up' ? -1 : 1) + activeAtPicker.candidates.length) % activeAtPicker.candidates.length;
          render();
          continue;
        }
        if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl && activeAtPicker.candidates[activeAtPicker.selected]) {
          const candidate = activeAtPicker.candidates[activeAtPicker.selected]!;
          const picked = atPickerApi!.acceptAtFile(input.editor.text, activeAtPicker.query, candidate, ++atAttachmentOrdinal);
          input.setEditor({ text: picked.text, cursor: picked.cursor });
          atAttachmentTokens.set(picked.token, candidate.absPath);
          await refreshVisibleContextAttachmentArea();
          atPicker = null;
          dismissedAtQuery = '';
          status = '파일 첨부 추가됨 · Enter 전송';
          debug.log('tui.next', 'at-picker-selected', { path: candidate.absPath });
          render();
          continue;
        }
      }
      const activeSlashPicker = slashPicker as { query: string; candidates: SlashPickerCandidate[]; selected: number } | null;
      let selectedSlashCommand: string | null = null;
      if (!busy && focus === 'input' && activeSlashPicker && slashPickerVisible) {
        if (key.name === 'escape') {
          dismissedSlashDraft = input.editor.text;
          slashPicker = null;
          slashNavigated = false;
          render();
          continue;
        }
        if ((key.name === 'up' || key.name === 'down') && activeSlashPicker.candidates.length > 0) {
          activeSlashPicker.selected = (activeSlashPicker.selected + (key.name === 'up' ? -1 : 1) + activeSlashPicker.candidates.length) % activeSlashPicker.candidates.length;
          slashNavigated = true;
          render();
          continue;
        }
        if (key.name === 'tab' && !key.shift && activeSlashPicker.candidates[activeSlashPicker.selected]) {
          input.setText(`${activeSlashPicker.candidates[activeSlashPicker.selected]!.value} `);
          slashPicker = null;
          slashNavigated = false;
          status = '명령 완성 · Enter 전송';
          render();
          continue;
        }
        if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl && slashNavigated && activeSlashPicker.candidates[activeSlashPicker.selected]) {
          selectedSlashCommand = activeSlashPicker.candidates[activeSlashPicker.selected]!.value;
          slashPicker = null;
          slashNavigated = false;
        }
      }
      if (busy) {
        if (key.name === 'up' && key.ctrl && !key.alt && !key.shift && !key.meta) {
          if (pushNowCommitting()) {
            status = '지금 제출 중 · 응답 전환 뒤 입력 가능';
            render();
            continue;
          }
          // A pending probe has no authority to abort after this recall.
          pushNowSnapshotPending = false;
          pushNowRequestId = null;
          pushNowPhase = null;
          const recalled = queue.recall(input.editor.text);
          if (recalled) {
            input.setText(recalled.text);
            input.clearHistory();
            status = `대기 ${recalled.count}건을 입력칸으로 · 응답 중`;
            debug.log('tui.next', 'queue-recalled', { count: recalled.count });
          }
          render();
          continue;
        }
        if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.ctrl && !key.alt
          && input.editor.text.trim().length === 0 && queue.count > 0) {
          if (pushNowCommitting()) {
            status = '지금 제출 중 · 응답 전환 뒤 입력 가능';
            render();
            continue;
          }
          // The child decides and aborts in one event-loop tick, before another tool can start.
          if (!pushNowSnapshotPending) {
            const requestId = `push-${++pushNowRequestSerial}`;
            pushNowSnapshotPending = pushNowRequest.current?.(requestId) === true;
            pushNowRequestId = pushNowSnapshotPending ? requestId : null;
            pushNowPhase = pushNowSnapshotPending ? 'checking' : null;
            status = pushNowSnapshotPending ? '도구 실행 상태 확인 중 · 대기 입력 유지' : '도구 상태 확인 불가 · 대기 입력 유지';
          }
          render();
          continue;
        }
        const pending = input.applyKey(key, queue.pendingTexts);
        if (pending.action === 'submit' && pending.submitted) {
          const routeRegistry = await loadNextTuiRouteRegistry();
          const pendingRoute = routeRegistry.resolveNextTuiRoute(pending.submitted, routeRegistry.NEXT_TUI_INPUT_CONTEXT);
          if (pendingRoute?.action === 'quit') {
            turnAbort?.abort();
            await turnDone;
            break;
          }
          if (pendingRoute?.id === 'session.new') {
            // A turn still writes to the current session; switching under it would split the reply.
            status = (await requestNewTuiSession({ busy: true, from: id })).status;
            render();
            continue;
          }
          if (pendingRoute?.id === 'session.compact') {
            // The running turn owns the session file; rewriting it underneath would race the reply.
            status = COMPACT_BUSY_STATUS;
            render();
            continue;
          }
          if (pendingRoute?.id === 'session.resume' && parseResumeCommand(pending.submitted)) {
            // Same reason as /new: the running turn still writes to the current session.
            status = RESUME_BUSY_STATUS;
            render();
            continue;
          }
          // Queued, not put back: it leaves on its own after this turn settles (herdr `pane run` and msg-wake
          // pastes arrive here too, so an outside prompt during a turn is kept, not lost).
          queue.enqueue(pending.submitted);
          status = '응답 중 · 완료 뒤 순서대로 전송 · Esc 취소';
          debug.log('tui.next', 'queue-enqueued', { length: pending.submitted.length, count: queue.count });
        }
        render();
        continue;
      }
      if (key.name === 'up' || key.name === 'down') {
        const prompts = messages.filter((message) => message.role === 'user').map((message) => message.content);
        input.browseHistory(key.name, prompts);
        slashPicker = null;
        render();
        continue;
      }
      focus = 'input';
      if (selectedSlashCommand !== null) input.setEditor(replaceSlashPickerQuery(input.editor, selectedSlashCommand));
      const result = input.applyKey(key, queue.pendingTexts);
      input.noteAction(result.action);
      if (result.action === 'edit') {
        await refreshAtPicker();
        await refreshSlashPicker();
      } else if (result.action === 'submit' || result.action === 'cancel' || result.action === 'quit') {
        atPicker = null;
        slashPicker = null;
        slashNavigated = false;
      }
      if (restoreDraft !== null) {
        // A queued submission just left through this Enter; what the person was typing comes back.
        if (result.action === 'submit') input.setText(restoreDraft);
        restoreDraft = null;
      }
      if (result.action === 'quit') break;
      if (result.action === 'cancel') {
        status = '입력 취소됨 · Enter 전송 · Ctrl+Q 종료';
        input.retainLivePasteTokens([input.editor.text, ...queue.pendingTexts]);
      }
      if (result.action === 'submit' && result.submitted) {
        const submittedFull = input.expandSubmission(result.submitted, [input.editor.text, ...queue.pendingTexts]);
        // 지운 붙여넣기의 원문은 놓는다 — 입력칸·대기열에 남은 토큰만 쥔다(r3 must-fix).
        input.retainLivePasteTokens([input.editor.text, ...queue.pendingTexts]);
        const submitted = submittedFull.trim();
        if (submitted === '/tasks') {
          const lines = backgroundJobs.taskLines();
          activity = lines.length > 0 ? [`작업 ${lines.length}건 · /tasks stop <id 앞자리> 로 취소`] : ['배경 Agent 작업 없음'];
          status = '작업 목록 · Enter 전송';
          render();
          continue;
        }
        if (submitted.startsWith('/tasks stop ')) {
          const prefix = submitted.slice('/tasks stop '.length).trim();
          const taskId = prefix.length >= 4 ? backgroundJobs.resolveTask(prefix) : null;
          if (!taskId || !id) status = '작업 ID를 고유한 4자 이상 앞자리로 입력하세요';
          else {
            const { requestLocalChatTaskStop } = await import('../tui-client/local-chat-turn.js');
            status = requestLocalChatTaskStop(id, taskId) ? `작업 ${backgroundJobs.displayTaskId(taskId)} 중단 요청` : '작업 중단 요청 실패';
          }
          render();
          continue;
        }
        const routeRegistry = await loadNextTuiRouteRegistry();
        const route = routeRegistry.resolveNextTuiRoute(submitted, routeRegistry.NEXT_TUI_INPUT_CONTEXT);
        // Existing registry commands remain usable during a wizard confirmation.
        // Ordinary text (including the wizard phrase itself) is still the wizard's answer.
        if (pluginWizardFlow && (!route || route.id === 'plugin.wizard')) {
          const turn = await pluginWizardFlow.answer(submitted);
          if (turn.kind === 'confirmation-required') {
            activity.push('저장 여부를 “네” 또는 “아니오”로 답해 주세요.');
          } else {
            if (turn.kind === 'saved') {
              pluginWizardFlow = null;
              activity.push(`플러그인 저장 완료: ${turn.id}`);
            } else if (turn.kind === 'declined') {
              pluginWizardFlow = null;
              activity.push('플러그인 초안을 저장하지 않았습니다.');
            } else if (turn.kind === 'error') activity.push(turn.message);
          }
          status = 'Enter 전송';
          render();
          continue;
        }
        if (!route && !submitted.startsWith('/')) {
          pendingEcho = { role: 'user', content: submittedFull, ts: new Date().toISOString() };
          pendingEchoStart = messages.length;
          render();
        }
        if (route?.action === 'quit') break;
        if (route?.id === 'session.new') {
          pluginWizardFlow = null;
          const next = await requestNewTuiSession({ busy, from: id });
          if (next.kind === 'started') {
            (loopCommand as NextLoopCommand | null)?.run('stop');
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            saveMessageBlockSession();
            id = next.id;
            restoreMessageBlockSession(id);
            lastFoldTargetKey = null;
            lastResumeRows = null;
            session = loadSession(id);
            messages = [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            scroll = 0;
            focus = 'input';
            input.clearHistory();
          }
          status = next.status;
          render();
          continue;
        }
        if (route?.id === 'session.compact') {
          if (!id) {
            status = COMPACT_NO_SESSION_STATUS;
            render();
            continue;
          }
          const compactSessionId = id;
          busy = true;
          status = '압축 중';
          turnAbort = null;
          turnDone = Promise.all([import('./slash/compact.js'), import('../tui-client/local-chat-turn.js')])
            .then(([{ compactNextTuiSession }, { localChatModel }]) =>
              compactNextTuiSession(compactSessionId, { force: true, modelId: localChatModel(compactSessionId) }))
            .then((outcome) => { status = `${outcome.status ?? '압축 완료'} · Enter 전송`; })
            .catch((error: unknown) => {
              status = `압축 실패: ${safeStatusText(error instanceof Error ? error.message : String(error))}`;
            })
            .finally(() => {
              session = loadSession(compactSessionId);
              messages = session?.messages ?? [];
              expandedToolBlocks.clear();
              busy = false;
              scroll = 0;
              settle();
              render();
            });
          render();
          continue;
        }
        const resumeCommand = route?.id === 'session.resume' ? parseResumeCommand(submitted) : null;
        if (resumeCommand?.kind === 'list') {
          const { resumeCandidates, resumeListLines } = await import('./slash/resume.js');
          lastResumeRows = resumeCandidates(id);
          activity = resumeListLines(lastResumeRows, id).map(safeStatusText);
          status = '/resume <번호|id 앞자리> 로 이어 가기 · Enter 전송';
          debug.log('tui.next', 'session-resume-list', { from: id, rows: activity.length });
          render();
          continue;
        }
        if (resumeCommand?.kind === 'load') {
          const { requestResumeTuiSession, resumeCandidates } = await import('./slash/resume.js');
          const next = requestResumeTuiSession({ busy, from: id, prefix: resumeCommand.prefix, rows: lastResumeRows ?? resumeCandidates(id) });
          if (next.kind === 'started') {
            (loopCommand as NextLoopCommand | null)?.run('stop');
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            saveMessageBlockSession();
            id = next.id;
            restoreMessageBlockSession(id);
            lastFoldTargetKey = null;
            lastResumeRows = null;
            session = loadSession(id);
            messages = session?.messages ?? [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            scroll = 0;
            focus = 'input';
            input.clearHistory();
          }
          status = safeStatusText(next.status);
          render();
          continue;
        }
        if (route?.id === 'model') {
          const { applyNextTuiModelTier, parseNextTuiModelCommand } = await import('./slash/model.js');
          const parsed = parseNextTuiModelCommand(submitted);
          if (parsed.kind === 'tier') {
            if (!id) {
              status = '현재 대화를 찾을 수 없어 모델 설정을 적용하지 못했습니다';
            } else {
              applyNextTuiModelTier(id, parsed.tier, parsed.choice);
              status = `모델: ${parsed.label} · 다음 턴부터 적용`;
            }
            render();
            continue;
          }
          if (parsed.kind === 'invalid') {
            activity.push(parsed.message);
            status = 'Enter 전송';
            render();
            continue;
          }
          const command = parsed.providerCommand;
          activity = ['provider 목록 조회 중'];
          busy = true;
          status = 'provider 조회 중 · Esc 취소';
          const abort = new AbortController();
          turnAbort = abort;
          turnDone = import('../tui-client/local-provider-command.js')
            .then(({ runLocalProviderCommand }) => runLocalProviderCommand(command, abort.signal, (line) => {
              activity.push(safeStatusText(line));
              activity = activity.slice(-80);
              render();
            }))
            .then(() => { status = 'provider 명령 완료 · Enter 전송'; })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              status = message === 'provider lookup cancelled' || message === 'provider switch cancelled'
                ? 'provider 명령 취소됨 · Enter 전송'
                : `provider 실패: ${safeStatusText(message)}`;
            })
            .finally(() => {
              busy = false;
              turnAbort = null;
              settle();
              render();
            });
          render();
          continue;
        }
        if (route?.branchHost === 'plugin-wizard' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/plugin-wizard.js');
          pluginWizardFlow = branch.createPluginWizardFlow();
          const turn = await pluginWizardFlow.start(submitted);
          if (turn.kind === 'proposal') activity.push(...branch.formatPluginWizardProposal(turn.proposal).map(safeStatusText));
          else if (turn.kind === 'error') {
            pluginWizardFlow = null;
            activity.push(safeStatusText(turn.message));
          }
          status = '플러그인 초안 확인 · Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'harness' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/harness.js');
          const request = branch.parseNextTuiHarnessCommand(submitted);
          if (!request) {
            activity.push(branch.NEXT_TUI_HARNESS_USAGE);
            render();
            continue;
          }
          activity = [safeStatusText(branch.nextTuiHarnessStartLine(request))];
          busy = true;
          status = '하니스 진행 중 · Esc 취소';
          const abort = new AbortController();
          turnAbort = abort;
          turnDone = branch.runNextTuiHarnessBranchRoute(request, abort.signal, (line) => {
              activity.push(safeStatusText(line));
              activity = activity.slice(-80);
              render();
            }, options.harnessRunner)
            .then(() => { status = '하니스 명령 완료 · Enter 전송'; })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              status = message === '하니스 호출을 취소했습니다'
                ? '하니스 호출 취소됨 · Enter 전송'
                : `하니스 실패: ${safeStatusText(message)}`;
            })
            .finally(() => {
              busy = false;
              turnAbort = null;
              settle();
              render();
            });
          render();
          continue;
        }
        if (route?.branchHost === 'memory' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/memory.js');
          activity = branch.runNextTuiMemoryBranchRoute(submitted).split('\n').map(safeStatusText);
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'decide' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/decide.js');
          decideBranchRoute ??= branch.createNextTuiDecideBranchRoute();
          activity = decideBranchRoute(submitted).split('\n').map(safeStatusText);
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.action === 'help') {
          const helpLines = (await loadNextTuiRouteRegistry()).buildNextTuiHelpLines();
          activity.push(...helpLines);
          // A 24-row terminal cannot show every command and the Keys section at once.
          // Start at this help block's first line; PgDn reaches the remaining commands and keys.
          scroll = Math.max(0, helpLines.length - logWindow.rows);
          status = scroll > 0 ? 'PgDn 나머지 명령·키 보기 · Esc 입력' : 'Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'now' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/now.js');
          activity = ['현재 맥락 조회 중…'];
          busy = true;
          status = '현재 맥락 조회 중 · Esc 취소';
          const abort = new AbortController();
          turnAbort = abort;
          render();
          turnDone = branch.runNextTuiNowBranchRoute(submitted, {
            chatLines: activity,
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
            signal: abort.signal,
            onUpdate: render,
          }).finally(() => {
            activity.shift();
            busy = false;
            turnAbort = null;
            status = 'Enter 전송';
            settle();
            render();
          });
          continue;
        }
        if (route?.branchHost === 'context' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/context.js');
          branch.runNextTuiContextBranchRoute(submitted, {
            chatLines: activity,
            attachments: atAttachmentTokens,
            attachmentPage: contextAttachmentPage,
            attachmentPageSize: 1,
            setAttachmentPage: (value) => { contextAttachmentPage = value; },
            setAttachmentArea: (lines) => {
              contextAttachmentAreaVisible = true;
              contextAttachmentArea = [...lines];
              contextAttachmentScroll = 0;
            },
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
          });
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'app' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/app/index.js');
          await branch.runNextTuiAppBranchRoute(submitted, {
            chatLines: activity,
            cwd: process.cwd(),
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
          });
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'sidetab' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/sidetab/route.js');
          await branch.runNextTuiBranchRoute(submitted, {
            state: () => ({ open: sidetabOpen, viewMode: sidetabViewMode, rememberedOpen: sidetabOpenBySession.get(id!) === true }),
            setEnabled: (enabled) => { sidetabEnabled = enabled; },
            rememberOpen: () => {
              sidetabOpenBySession.set(id!, true);
              updateSessionMeta(id!, (meta) => { meta.uiState = { ...meta.uiState, sidetabOpen: true }; });
            },
            setViewMode: (mode) => { sidetabViewMode = mode; },
            setNewMode: () => { sidetabMode = 'new'; },
            clearExpandedWorkspaces: () => expandedWorkspaceIds.clear(),
            toggle: toggleSidetab,
            refreshRows: refreshSidetabRows,
            killSelected: async () => {
              if (!sidetabApi) sidetabApi = await import('./sidetab/list.js');
              refreshSidetabRows();
              const selected = sidetabRows[sidetabSelected];
              if (!selected) return false;
              await ensureSidetabAttachments();
              sidetabAttachments?.kill(selected);
              refreshSidetabRows();
              return true;
            },
            spawnSideAgent: async (agent) => {
              await ensureSidetabAttachments();
              const sessionId = sidetabAttachments!.spawnSideAgent(agent);
              refreshSidetabRows();
              if (sessionId) {
                const index = sidetabRows.findIndex((row) => row.sessionId === sessionId);
                if (index >= 0) sidetabSelected = index;
              }
              return sessionId;
            },
            sendSelectedAgent: async (message) => {
              const row = sidetabRows[sidetabSelected];
              if (!row) return false;
              await ensureSidetabAttachments();
              return sidetabAttachments!.sendSideAgent(row, message);
            },
            readSelectedAgent: async () => {
              const row = sidetabRows[sidetabSelected];
              if (!row) return undefined;
              await ensureSidetabAttachments();
              return sidetabAttachments!.readSideAgent(row);
            },
            bindWorkspaceSelected: async () => {
              refreshSidetabRows();
              const row = sidetabRows[sidetabSelected];
              if (!row?.spaceId || !row.ptyId || row.kind === 'workspace') return false;
              const parent = sidetabRows.find((candidate) => candidate.kind === 'workspace' && candidate.spaceId === row.spaceId);
              if (!parent) return false;
              await ensureSidetabAttachments();
              try { workspaceInput!.select(parent); workspaceInput!.bind(row); return true; }
              catch { return false; }
            },
            submitWorkspace: async (mode, text) => {
              await ensureSidetabAttachments();
              workspaceInput!.edit(mode, text);
              const sent = await workspaceInput!.submit(mode);
              const spaceId = workspaceInput!.state().activeSpaceId;
              const reply = mode === 'sidechat' && spaceId ? workspaceInput!.conversation(spaceId).at(-1)?.text : undefined;
              return { sent, ...(reply ? { reply } : {}) };
            },
            broadcastWorkspace: async (rowIds, text) => {
              await ensureSidetabAttachments();
              refreshSidetabRows();
              const state = workspaceInput!.state();
              if (!state.activeSpaceId) throw new Error('워크스페이스 PTY를 먼저 결합하세요');
              const { bindWorkspacePty } = await import('../sidetab-core/workspace-input.js');
              const targets = rowIds.map((rowId) => {
                const row = sidetabRows.find((candidate) => candidate.id === rowId);
                if (!row) throw new Error('선택한 PTY 행이 사라졌습니다');
                return bindWorkspacePty(state, row).entries[state.activeSpaceId!]!.target!;
              });
              return workspaceBroadcast!.send(state.activeSpaceId, targets, text);
            },
            addHelp: (...lines) => { activity.push(...lines); },
            setStatus: (message) => { status = message; },
          });
          render();
          continue;
        }
        if (route?.branchHost === 'terminal' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./branches/term/route.js');
          const sessions = options.termSessions ?? {
            list: async () => {
              const { listPty } = await import('../pty-shell/registry.js');
              return listPty().map((handle) => ({
                id: handle.id,
                title: handle.nickname ?? handle.cmd,
                kind: handle.kind,
                status: handle.isAlive() ? 'running' as const : 'exited' as const,
                ...(handle.workdir === undefined ? {} : { cwd: handle.workdir }),
                exitCode: handle.exitCode,
              }));
            },
          };
          await branch.runNextTuiTermBranchRoute(submitted, {
            chatLines: activity,
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
            sessions,
          });
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.branchHost === 'mission' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('./slash/mission.js');
          await branch.runNextTuiMissionBranchRoute(submitted, {
            chatLines: activity,
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
            muted: (text) => text,
            accent: (text) => text,
            text: (text) => text,
            error: (text) => text,
            success: (text) => text,
            warning: (text) => text,
            info: (text) => text,
            subtext: (text) => text,
            missionTui: {
              startReadyWatch: (missionId, poll, onReady) => startMissionWatch('ready', missionId, poll, onReady),
              startRunWatch: (missionId, poll) => startMissionWatch('run', missionId, poll),
            },
          });
          status = status || 'Enter 전송';
          render();
          continue;
        }
        if (route?.action === 'command' && slashHandlers.has(submitted.slice(1).trim().split(/\s+/)[0] ?? '')) {
          slashContext.chatLines = activity;
          const [command = '', ...args] = submitted.slice('/'.length).trim().split(/\s+/);
          const dispatched = await dispatchSlash(command, args, slashContext);
          if (!dispatched) activity.push('알 수 없는 슬래시 명령');
          status = 'Enter 전송';
          render();
          continue;
        }
        // A person's turn: an internal turn opened but not yet run gives way, and the door's «last turn» moves.
        wakeup?.gate.port.declined?.('human-turn');
        wakeup?.gate.noteHumanTurn();
        goalContinue?.noteHumanTurn();
        startChatTurn(submittedFull);
      }
      render();
    }
  } finally {
    tuiClosed = true;
    if (turnElapsedTimer !== null) clearInterval(turnElapsedTimer);
    missionWatchCancellation.cancel?.();
    delete missionWatchCancellation.cancel;
    if (simWatchTimer !== null) clearInterval(simWatchTimer);
    if (sidetabRefreshTimer !== null) clearInterval(sidetabRefreshTimer);
    if (sidetabChordTimer !== null) clearTimeout(sidetabChordTimer);
    sidetabAttachments?.close();
    restoreCliStderrSink?.();
    restoreCliStderrSink = null;
    restoreTuiStderrOwner?.();
    restoreTuiStderrOwner = null;
    if (residueTimer !== null) clearTimeout(residueTimer);
    (loopCommand as NextLoopCommand | null)?.dispose();
    wakeup?.dispose();
    if (wakeup) {
      const { setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      setNextTuiWakeupTool(null);
    }
    const { setNextSidetabHandler, setNextSidetabIpcEnabled } = await import('../tui-client/local-chat-turn.js');
    shellApproval.dispose();
    const { setNextTuiShellApprovalHandler, setNextTuiShellApprovalCancelHandler } = await import('../tui-client/local-chat-turn.js');
    setNextTuiShellApprovalHandler(null);
    setNextTuiShellApprovalCancelHandler(null);
    setNextSidetabHandler(null);
    setNextSidetabIpcEnabled(false);
    (await import('../tui-client/local-chat-turn.js')).setNextMemberBoardSessionSource(null);
    turnAbort?.abort();
    await turnDone;
    backgroundSubscription.stop?.();
    if (id) {
      const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
      await closeLocalChatSession(id);
    }
    process.stdout.off('resize', render);
    closeTui();
  }
}
