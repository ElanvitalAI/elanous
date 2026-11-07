import { initTui, closeTui, injectKey, readKey, type Key } from '../tui.js';
import { appendMessage, createSession, getActiveSessionId, loadSession, resolveSessionId, setActiveSessionId, updateSessionMeta } from '../session/index.js';
import { fitLogLine, isToolFoldToggleKey, logViewLines, safeLogText, safeStatusText, streamReplyLines, toggleVisibleToolFold, toolFoldBlockStarts, wheelScroll } from './chat/log-view.js';
import { BackgroundJobStatus } from './chat/background-job-status.js';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, applyComposerKey, composerViewport, emptyComposer, wheelDirection } from './input/composer.js';
import { createInlineEditorState, type InlineEditorState } from '../input-core/inline-editor.js';
import { nextTuiTitle, requestNewTuiSession } from './slash/new-session.js';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS } from './slash/compact-command.js';
import { RESUME_BUSY_STATUS, parseResumeCommand } from './slash/resume-command.js';
import { reportTuiProgress, reportTuiTurn } from '../pty-shell/tui-run-state.js';
import { createPasteFold } from '../chat/paste-fold.js';
import { createTurnTypeaheadState, dequeueTurnTypeaheadHandoff, drainTurnTypeaheadOnce, restoreTurnTypeaheadSubmission } from '../chat/turn-typeahead.js';
import { debug } from '../debug/log.js';
import { setCliStderrSink } from '../git-fs/cli-stderr.js';
import { createInputLagProbe } from './input-lag-probe.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import { countInterimDisplay, internalTurnOriginOfText, planInterimDisplay } from './chat/goal-interim.js';
import type { NextLoopCommand } from '../tui-client/next-loop-command.js';
import { handleSignalsSlash, type SignalsSlashContext } from './slash/signals.js';
import { updatePtyManifestSession } from '../pty-shell/pty-manifest.js';

let nextTuiRouteRegistry: typeof import('./core/registry.js') | undefined;
async function loadNextTuiRouteRegistry(): Promise<typeof import('./core/registry.js')> {
  nextTuiRouteRegistry ??= await import('./core/registry.js');
  return nextTuiRouteRegistry;
}

/** Status-line count of what waits for the running turn — empty when nothing waits. */
export function nextTuiQueueSuffix(count: number): string {
  return count > 0 ? ` · 대기 ${count}` : '';
}

type NextTuiTermSession = {
  id: string;
  title: string;
  kind: string;
  status: 'running' | 'backgrounded' | 'completed' | 'killed' | 'exited';
  cwd?: string;
  exitCode?: number | null;
};

export interface NextTuiOptions {
  readonly resumeSessionId?: string;
  readonly sidetabMode?: 'off' | 'collapsed' | 'open';
  /** Read-only terminal session source; injectable so the Next slash stays testable without PTYs. */
  readonly termSessions?: {
    list(): readonly NextTuiTermSession[] | Promise<readonly NextTuiTermSession[]>;
  };
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

export function atPickerHeaderLines(
  candidates: readonly AtPickerCandidate[],
  selected: number,
  availableRows: number,
  fit: (text: string) => string,
): string[] {
  if (availableRows <= 0) return [];
  const safeSelected = Math.max(0, Math.min(selected, candidates.length - 1));
  if (availableRows === 1) {
    const candidate = candidates[safeSelected];
    return [fit(candidate ? `@ ${safeSelected + 1}/${candidates.length} · ${candidate.label}` : '@ 파일 후보 없음')];
  }
  const limit = Math.max(1, Math.min(6, availableRows - 1));
  const start = Math.max(0, Math.min(safeSelected - limit + 1, candidates.length - limit));
  const visible = candidates.slice(start, start + limit);
  return [
    fit(visible.length ? '@ 파일 첨부 · ↑↓ 선택 · Enter 추가 · Esc 닫기' : '@ 파일 후보 없음'),
    ...visible.map((candidate, offset) => fit((start + offset === safeSelected ? '▸' : ' ') + ' ' + candidate.label)),
  ];
}

/** Local chat entry: history and input are TUI-owned; turn execution stays shared. */
export async function showNextTui(options: NextTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('elanous --tui next requires stdin TTY');
  if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 6) {
    throw new Error('elanous --tui next requires at least 20 columns and 6 rows');
  }
  const dashboardRuntime = await (await import('../tui-client/next-dashboard-runtime.js')).loadNextTuiDashboardRuntime();
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
  let editor = emptyComposer();
  let status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
  let busy = false;
  let turnAbort: AbortController | null = null;
  let turnDone: Promise<void> | null = null;
  let scroll = 0;
  let maxScroll = 0;
  let focus: 'input' | 'log' = 'input';
  let sidetabEnabled = options.sidetabMode !== 'off';
  let sidetabViewMode: 'current' | 'all' | 'workspaces' = 'current';
  const expandedWorkspaceIds = new Set<string>();
  let sidetabOpen = sidetabEnabled && (session?.meta.uiState?.sidetabOpen ?? sidetabOpenBySession.get(id!) ?? options.sidetabMode === 'open');
  let sidetabSelected = 0;
  let sidetabMode: 'list' | 'new' = 'list';
  let sidetabFocused = false;
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
  let pendingSidetabSwitch: string | null = null;
  let sidetabRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let paintingCoordinatorFrame = false;
  const mouseResidue = new MouseResidueGuard();
  const replay: Key[] = [];
  let escapeSnapshot: { editor: InlineEditorState; status: string; focus: 'input' | 'log'; busy: boolean } | null = null;
  // Wakes readKey when a character held by the residue guard would otherwise wait for the next key.
  const residueWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  let residueTimer: ReturnType<typeof setTimeout> | null = null;
  let historyIndex = 0;
  let draft = '';
  let activity: string[] = [];
  /** Rows of the last `/resume` list — `/resume <n>` picks from what the user saw. */
  let lastResumeRows: import('../session/index.js').SessionMeta[] | null = null;
  let atPicker: { query: AtPickerQuery; candidates: AtPickerCandidate[]; selected: number } | null = null;
  let atPickerApi: typeof import('./input/at-picker.js') | null = null;
  let dismissedAtQuery = '';
  const atAttachmentTokens = new Map<string, string>();
  let atAttachmentOrdinal = 0;
  // Tool-output fold state, keyed by message index; long tool output renders
  // collapsed and Enter/Tab/F in the log toggles the foldable block on screen nearest the
  // bottom of the last rendered scroll window.
  const expandedToolBlocks = new Set<number>();
  let logWindow = { start: 0, rows: 0, columns: 80 };
  let streamingReply = '';
  let streamRenderAt = 0;
  let streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
  const backgroundJobs = new BackgroundJobStatus(id);
  const backgroundSubscription: { stop?: () => void } = {};
  const selfHealthSubscription: { stop?: () => void } = {};
  let observedSessionId: string | null = null;
  let selfHealthLine: string | null = null;
  // TUI-NEXT-QUEUE-AND-WAKE — what is submitted while busy waits here (the classic FIFO state) and
  // leaves one item per settle; Esc returns it all to the prompt (classic «interrupted» drain).
  let queue = createTurnTypeaheadState();
  let interrupted = false;
  /** The prompt text a queued submission displaced; it comes back once that submission is sent. */
  let restoreDraft: string | null = null;
  /** ⏰/↻ lines from the wakeup scheduler and the internal-turn door (newest last, at most three). */
  let notices: string[] = [];
  // Distinct sentinels: the loop owns them, nothing else reads them as keys.
  const queueWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  const internalWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  let wakeup: NextTuiWakeup | null = null;
  let loopCommand: NextLoopCommand | null = null;
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
  const pasteFold = createPasteFold();
  // TURN-END-BEFORE-GOAL — 답이 약속만 하고 끝나면 깨움 문으로 한 턴 더(classic 과 같은 모듈 · 동적 로드).
  let goalContinue: ReturnType<(typeof dashboardRuntime)['createGoalContinue']> | null = null;
  /** 이번 턴이 실패·취소로 끝났나 — 그런 턴은 이어가지 않는다. */
  let turnFailed = false;
  /** 마지막으로 관측에 남긴 접힌 중간 답 수(next · 바뀔 때만 'folded' 한 줄). */
  let interimFoldedShown = 0;
  const pushNotice = (line: string): void => {
    notices = [...notices, safeStatusText(line)].slice(-3);
  };
  const observeSession = (
    sessionId: string,
    onBackground: typeof import('../tui-client/local-chat-turn.js').onLocalChatBackgroundStatus,
    onSelfHealth: typeof import('../tui-client/local-chat-turn.js').onLocalChatSelfHealthStatus,
  ): void => {
    if (observedSessionId === sessionId) return;
    backgroundSubscription.stop?.();
    selfHealthSubscription.stop?.();
    backgroundSubscription.stop = onBackground(sessionId, (frame) => {
      if (frame === null) backgroundJobs.clear();
      else backgroundJobs.accept(frame);
      render();
    });
    selfHealthSubscription.stop = onSelfHealth(sessionId, (snapshot) => {
      selfHealthLine = snapshot?.line ?? null;
      render();
    });
    observedSessionId = sessionId;
  };
  // MISSION-FABRIC-REMOVAL(대표 11-05) — /mission 은 지웠다. 미션 패브릭(autopilot 미션 스토어)은 시뮬레이션 장치로 새로 짓는다.
  const slashHandlers = new Map<string, (args: string[], context: SignalsSlashContext) => Promise<void>>();
  slashHandlers.set('signals', handleSignalsSlash);
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
    if (sidetabRemoteFrame !== null) {
      const columns = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const footer = fitLogLine(` ${status} `, Math.max(1, columns));
      process.stdout.write(`\x1b[H\x1b[2J${sidetabRemoteFrame}\x1b[${rows};1H\x1b[7m${footer}\x1b[0m`);
      return;
    }
    const columns = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    if (columns < 20 || rows < 6) {
      process.stdout.write(`\x1b[H\x1b[2J${fitLogLine('터미널이 너무 작습니다 · q 종료', Math.max(1, columns))}`);
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
    const sidetabWidth = sidetabOpen ? sidetabApi!.sidetabWidthForTerminal(columns) : 0;
    const chatColumns = columns - sidetabWidth - (sidetabOpen ? 1 : 0);
    const backgroundLine = backgroundJobs.line();
    const showSelfHealth = selfHealthLine !== null && rows >= 7;
    const title = fitLogLine(`elanous next · ${safeLogText(nextTuiTitle(session?.meta)).split('\n')[0]}`, chatColumns);
    const turnStatus = (!busy && focus === 'log'
      ? `로그 탐색 · ↑↓ 스크롤${toolFoldBlockStarts(messages, chatColumns).length > 0 ? ' · Enter 접기/펼치기' : ''} · Esc 입력`
      : status) + nextTuiQueueSuffix(queue.queuedSubmissions.length);
    const footer = backgroundLine
      ? [fitLogLine(backgroundLine, chatColumns), fitLogLine(turnStatus, chatColumns)]
      : [fitLogLine(turnStatus, chatColumns)];
    const prompt = composerViewport(editor, chatColumns);
    const header = [title, mailLine ? fitLogLine(mailLine, chatColumns) : '─'.repeat(Math.min(chatColumns, 80))];
    if (showSelfHealth) header.push(fitLogLine(selfHealthLine!, chatColumns));
    if (atPicker) {
      // Reserve the prompt, footer, and picker heading before assigning candidate rows.
      const pickerRows = rows - header.length - footer.length - 1;
      if (pickerRows > 0) {
        header.push(...atPickerHeaderLines(atPicker.candidates, atPicker.selected, pickerRows, (line) => fitLogLine(line, chatColumns)));
      }
    }
    const history = [
      ...logViewLines(messages, chatColumns, expandedToolBlocks),
      ...notices.map((line) => fitLogLine(line, chatColumns)),
      ...activity.map((line) => fitLogLine(line, chatColumns)),
    ];
    // Header rows can grow when mail, health, or picker state appears. Preserve
    // the prompt first, then trim excess header rows before calculating history.
    const visibleFooter = footer.slice(0, Math.max(0, Math.min(footer.length, rows - 1)));
    const headerBudget = Math.max(0, rows - visibleFooter.length - 1);
    const visibleHeader = header.slice(0, headerBudget);
    const bodyRows = Math.max(0, rows - visibleHeader.length - visibleFooter.length - 1);
    maxScroll = Math.max(0, history.length - bodyRows);
    scroll = Math.min(scroll, maxScroll);
    const start = Math.max(0, history.length - bodyRows - scroll);
    const body = history.slice(start, start + bodyRows);
    logWindow = { start, rows: bodyRows, columns: chatColumns };
    const lines = [...visibleHeader, ...body, ...visibleFooter, prompt.line];
    const promptRow = lines.length;
    const sidetabLines = sidetabOpen
      ? sidetabApi!.formatSidetabLines(sidetabRows, sidetabSelected, sidetabWidth, Math.max(1, rows - 1), sidetabMode)
      : [];
    const screenLineCount = sidetabOpen ? Math.max(lines.length, sidetabLines.length) : lines.length;
    const screenLines = Array.from({ length: screenLineCount }, (_, index) => {
      const line = lines[index] ?? '';
      return sidetabOpen ? `${sidetabLines[index] ?? ' '.repeat(sidetabWidth)}│${line}` : line;
    });
    process.stdout.write(`\x1b[H\x1b[2J${screenLines.join('\n')}\x1b[${promptRow};${prompt.cursorCol + (sidetabOpen ? sidetabWidth + 1 : 0)}H\x1b[?25h`);
    if (sidetabAttachments?.hasModal() && !paintingCoordinatorFrame) sidetabAttachments.refresh();
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
        if (sidetabRemoteFrame !== null) {
          const columns = process.stdout.columns || 80;
          const rows = process.stdout.rows || 24;
          const footer = fitLogLine(` ${status} `, Math.max(1, columns));
          process.stdout.write(`\x1b[H\x1b[2J${sidetabRemoteFrame}\x1b[${rows};1H\x1b[7m${footer}\x1b[0m`);
        }
        else render();
      },
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
    id = targetId;
    session = target;
    messages = target.messages;
    setActiveSessionId(targetId);
    updatePtyManifestSession(`tui:${process.pid}`, targetId);
    backgroundJobs.setSessionId(targetId);
    selfHealthLine = null;
    const statusSources = await import('../tui-client/local-chat-turn.js');
    observeSession(targetId, statusSources.onLocalChatBackgroundStatus, statusSources.onLocalChatSelfHealthStatus);
    goalContinue?.noteHumanTurn();
    lastResumeRows = null;
    expandedToolBlocks.clear();
    activity = [];
    streamingReply = '';
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
    status = '사이드탭 포커스 · 1–9 선택 · Esc 입력';
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
    const selected = sidetabRows[index]!;
    if (toggleWorkspaceRow(selected)) render();
    else if (selected.kind === 'tui') await switchSidetabSession(selected.sessionId, selected.ptyId);
    else {
      await ensureSidetabAttachments();
      sidetabAttachments?.select(selected);
    }
  };

  let restoreCliStderrSink: (() => void) | null = null;
  let restoreTuiStderrOwner: (() => void) | null = null;

  const refreshAtPicker = async (): Promise<void> => {
    const query = editor.text.slice(0, editor.cursor).match(/(?:^|\s)@([\p{L}\p{N}_./~\\-]*)$/u);
    if (!query) {
      atPicker = null;
      dismissedAtQuery = '';
      if (status.startsWith('@ 파일')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
      return;
    }
    const prefix = query[1] ?? '';
    const start = editor.cursor - prefix.length - 1;
    const key = start + ':' + prefix;
    if (dismissedAtQuery === key) { atPicker = null; return; }
    if (!atPickerApi) {
      atPickerApi = await import('./input/at-picker.js');
      debug.log('tui.next', 'at-picker-module-loaded', { onDemand: true });
    }
    const candidates = await atPickerApi.listAtFiles(prefix, process.cwd());
    atPicker = { query: { prefix, start, end: editor.cursor }, candidates, selected: 0 };
    status = candidates.length ? '@ 파일 첨부 후보 · ↑↓ 선택 · Enter 추가' : '@ 파일 후보 없음 · 계속 입력';
  };

  /** Every busy path ends here: the door learns the turn is over, then the queue moves or returns to the prompt. */
  const settle = (): void => {
    wakeup?.gate.noteTurnSettled();
    const count = queue.queuedSubmissions.length;
    if (interrupted) {
      interrupted = false;
      if (count === 0) return;
      const drained = drainTurnTypeaheadOnce(queue, editor.text || null, { interrupted: true });
      queue = drained.state;
      editor = createInlineEditorState(drained.nextInitial ?? '');
      status = `응답 취소됨 · 대기 ${count}건을 입력칸으로 · Enter 전송`;
      debug.log('tui.next', 'queue-restored', { count });
      return;
    }
    if (count > 0) injectKey(queueWake);
  };

  /** Sends the head of the queue through the ordinary idle submit path (slash commands included). */
  const dispatchQueued = (): void => {
    const { handoff, state } = dequeueTurnTypeaheadHandoff(queue);
    if (handoff.kind !== 'submit') return;
    queue = state;
    // 대기열에서 나가는 것도 사람이 쳐 둔 턴이다 — 골 이어가기의 연속·지문을 비운다(r3 must-fix).
    goalContinue?.noteHumanTurn();
    restoreDraft = editor.text;
    editor = createInlineEditorState(handoff.text);
    focus = 'input';
    historyIndex = 0;
    debug.log('tui.next', 'queue-dispatched', { length: handoff.text.length, remaining: queue.queuedSubmissions.length });
    replay.push({ name: 'enter', ctrl: false, shift: false, raw: '\r' });
  };

  /** One chat turn on the shared REPL child — a person's submit, or an internal turn the door opened (banner). */
  const startChatTurn = (turnText: string, banner?: string): void => {
    activity = [];
    streamingReply = '';
    streamRenderAt = 0;
    const attachments = [...atAttachmentTokens].filter(([token]) => turnText.includes(token)).map(([, path]) => path);
    if (!id) {
      id = createSession({ source: 'tui' }).id;
      setActiveSessionId(id);
      session = loadSession(id);
      backgroundJobs.setSessionId(id);
    }
    const turnSessionId = id;
    busy = true;
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
    // «압축 N→M 메시지» stays on the status line through the reply when this turn compacted first.
    let compactNote = '';
    turnFailed = false;
    // 이번 턴이 만든 답만 골 이어가기 판정에 쓴다 — 시작 때 세션 길이를 잡아 둔다.
    const messagesAtTurnStart = messages.length;
    // 이번 턴에 자동 압축이 있었나 — 있으면 길이 기준이 깨지므로 «마지막 사람 글 뒤» 로 판정한다.
    let turnCompacted = false;
    let turnGoalComplete = false;
    let turnGoalStopReason: string | undefined;
    const abort = new AbortController();
    turnAbort = abort;
    turnDone = import('../tui-client/local-chat-turn.js')
      .then(({ runLocalChatTurn, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus }) => {
        observeSession(turnSessionId, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus);
        let firstResponseSeen = false;
        return runLocalChatTurn(turnSessionId, turnText, abort.signal, undefined, undefined, (delta, replace = false) => {
          // 스트림 텍스트 = 진전 신호 — 마지막 진전 시각을 올린다(녹음기 없으면 아무 일도 안 한다).
          reportTuiProgress();
          // 첫 응답 경계: 첫 스트림 델타에서 턴 시작 트레이스를 닫는다(endedBy=stream-open).
          if (!firstResponseSeen) {
            firstResponseSeen = true;
            dashboardRuntime.endTurnStartSegments(turnSessionId, 'stream-open');
          }
          // The first model token is visible while the turn runs. Once the core
          // replaces that provisional answer, let the persisted final message
          // become canonical instead of showing the same answer in both layers.
          if (replace) {
            streamingReply = '';
            activity = [];
            if (streamRenderTimer !== null) clearTimeout(streamRenderTimer);
            streamRenderTimer = null;
            streamRenderAt = performance.now();
            render();
            return;
          } else {
            streamingReply = (streamingReply + delta).slice(-32_768);
            activity = streamReplyLines(streamingReply, process.stdout.columns || 80);
          }
          const now = performance.now();
          if (streamRenderAt === 0 || now - streamRenderAt >= 33) {
            streamRenderAt = now;
            render();
          } else if (streamRenderTimer === null) {
            streamRenderTimer = setTimeout(() => {
              streamRenderTimer = null;
              streamRenderAt = performance.now();
              render();
            }, 33 - (now - streamRenderAt));
          }
        }, {
          onCompact: (outcome) => {
            compactNote = outcome.status ? `${outcome.status} · ` : '';
            turnCompacted = true;
            status = `${compactNote}응답 중 · Esc 취소`;
            session = loadSession(turnSessionId);
            messages = session?.messages ?? [];
            expandedToolBlocks.clear();
            render();
          },
        }, attachments, (line) => {
          pushNotice(line);
          render();
        }).then((result) => {
          turnGoalComplete = result?.goalComplete === true;
          turnGoalStopReason = result?.goalStopReason;
        });
      })
      .then(() => {
        status = turnGoalStopReason === 'max_turns'
          ? 'Turn cap reached — continue with your next input'
          : `${compactNote}응답 완료 · Enter 전송 · Ctrl+Q 종료`;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        turnFailed = true;
        status = compactNote + (message === '응답을 취소했습니다'
          ? '응답 취소됨 · Enter 전송'
          : `응답 실패: ${safeStatusText(message)}`);
      })
      .finally(async () => {
        if (streamRenderTimer !== null) clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
        session = loadSession(turnSessionId);
        messages = session?.messages ?? [];
        activity = [];
        streamingReply = '';
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
        // Goal completion is terminal even when the person has already drafted the next input.
        // A real submitted turn calls noteHumanTurn and clears this terminal state.
        if (goalContinue && turnGoalComplete) goalContinue.noteGoalCompleted();
        // 사람이 쌓아 둔 다음 입력이 먼저다 — 대기열이 비었을 때만 골 이어가기를 잰다.
        if (goalContinue && queue.queuedSubmissions.length === 0 && editor.text.length === 0) {
          try {
            if (!turnGoalComplete) {
              goalContinue.noteTurnEnded({ lines: dashboardRuntime.replyLinesOfThisTurn(messages, turnCompacted ? 'after-last-user' : messagesAtTurnStart), failed: turnFailed || interrupted });
              goalContinue.check();
            }
          } catch { /* fail-soft: 골 이어가기는 턴 정리를 막지 않는다 */ }
        } else if (goalContinue && (queue.queuedSubmissions.length > 0 || editor.text.length > 0)) {
          debug.log('tui.proactive', 'yield-user-input', { queued: queue.queuedSubmissions.length, bufferedChars: editor.text.length });
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
      });
  };

  if (sidetabOpen) {
    sidetabApi = await import('./sidetab/list.js');
    sidetabRows = sidetabApi.loadSidetabRows(getSidetabViewMode() === 'all', undefined, sidetabScope());
    void refreshHerdrSidetabRows();
    sidetabRefreshTimer = setInterval(() => {
      if (!sidetabApi || !sidetabOpen) return;
      refreshSidetabRows();
      void refreshHerdrSidetabRows();
      render();
    }, 1_000);
  }
  initTui();
  const { installTuiStderrOwner } = await import('../surface/tui-stderr-owner.js');
  restoreTuiStderrOwner = installTuiStderrOwner((line) => {
    pushNotice(`[stderr] ${line}`);
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
      pushNotice(`[${source} stderr · rc=${exitCode}] ${text}`);
      render();
    }
  });
  process.stdout.on('resize', render);
  let simWatchTimer: ReturnType<typeof setInterval> | null = null;
  try {
    {
      const { createNextTuiWakeup, setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      const { setNextSidetabHandler, setNextSidetabIpcEnabled } = await import('../tui-client/local-chat-turn.js');
      const { createNextSidetabHostHandler } = await import('./sidetab/nl-tool.js');
      setNextSidetabIpcEnabled(true);
      wakeup = createNextTuiWakeup({
        isTurnRunning: () => busy,
        getBufferText: () => editor.text,
        getQueuedCount: () => queue.queuedSubmissions.length,
        requestYield: () => injectKey(internalWake),
        notify: (line) => { pushNotice(line); render(); },
      });
      setNextTuiWakeupTool(wakeup.tool);
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
      let key: Key = rawKey.name === 'paste' && typeof rawKey.paste === 'string' ? { ...rawKey, paste: pasteFold.fold(rawKey.paste) } : rawKey;
      // Ctrl+V — 클립보드 글을 같은 붙여넣기 규칙으로(예전엔 next 가 Ctrl 글자를 버려 아무 일도 없었다).
      if (key.ctrl && (key.name === 'v' || key.name === 'V' || key.name === 'ㅍ') && focus === 'input') {
        const { readClipboardText } = await import('../clipboard/index.js');
        const clip = await readClipboardText().catch(() => null);
        debug.log('tui.paste', 'clipboard-read', { surface: 'next', chars: clip?.length ?? 0 });
        if (!clip) {
          status = '클립보드에 붙여넣을 글이 없습니다 · Enter 전송';
          render();
          continue;
        }
        key = { name: 'paste', ctrl: false, shift: false, raw: '', paste: pasteFold.fold(clip) };
      }
      if (key === queueWake) {
        if (!busy) dispatchQueued();
        render();
        continue;
      }
      if (key === internalWake) {
        // The door opened while idle; a person who got here first (a turn, a typed prompt) withdraws it.
        if (busy || editor.text.length > 0) wakeup?.gate.port.declined?.(busy ? 'turn-running' : 'buffer');
        else {
          const request = wakeup?.gate.takePending();
          if (request) startChatTurn(request.input, wakeup!.banner(request));
        }
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
          if (escapeSnapshot && !escapeSnapshot.busy) ({ editor, status, focus } = escapeSnapshot);
          escapeSnapshot = null;
          if (step.wheel) scroll = wheelScroll(scroll, step.wheel, maxScroll);
          render();
          continue;
        }
        if (key === residueWake) continue;
        if (key.name === 'escape' && key.raw === '\x1b') {
          escapeSnapshot = { editor, status, focus, busy };
          mouseResidue.arm(Date.now());
        } else {
          escapeSnapshot = null;
        }
      }
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
            if (sidetabRows[sidetabSelected]!.kind === 'workspace') {
              // Workspace parents are toggled with Enter; arrow selection never routes them to PTY attach.
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
      if (sidetabFocused && key.name === 'escape') {
        returnToInput();
        render();
        continue;
      }
      if (key.name === 'mouse' && key.mouse?.type === 'click') {
        if (sidetabOpen && sidetabMode === 'list' && !sidetabAttachments?.hasRemoteView() && !sidetabAttachments?.hasModal()) {
          const panelWidth = sidetabApi!.sidetabWidthForTerminal(process.stdout.columns || 0);
          if (key.mouse.col <= panelWidth) {
            const index = sidetabApi!.sidetabRowIndexAtTerminalRow(
              sidetabRows.length,
              sidetabSelected,
              Math.max(1, (process.stdout.rows || 0) - 1),
              key.mouse.row,
            );
            if (index !== null) {
              await selectSidetabIndex(index);
            }
          }
        }
        render();
        continue;
      }
      if (sidetabAttachments?.handleKey(key)) {
        render();
        continue;
      }
      const wheel = wheelDirection(key);
      if (wheel) {
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
      if (sidetabFocused && key.name !== 'up' && key.name !== 'down') {
        render();
        continue;
      }
      if (sidetabOpen && sidetabMode === 'new') {
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
        if (sidetabRows[sidetabSelected]) {
          if (sidetabRows[sidetabSelected]!.kind === 'workspace') { /* Workspace parents have no PTY target. */ }
          else if (sidetabRows[sidetabSelected]!.kind === 'tui') await switchSidetabSession(sidetabRows[sidetabSelected]!.sessionId, sidetabRows[sidetabSelected]!.ptyId);
          else {
            await ensureSidetabAttachments();
            sidetabAttachments?.select(sidetabRows[sidetabSelected]!);
          }
        }
        render();
        continue;
      }
      if (sidetabOpen && editor.text.length === 0 && key.name === 'enter') {
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
        turnAbort?.abort();
        interrupted = true;
        status = '응답 취소 중';
        render();
        continue;
      }
      if (busy && key.ctrl && key.name === 'd') {
        turnAbort?.abort();
        await turnDone;
        break;
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        focus = 'log';
        scroll = Math.max(0, scroll + (key.name === 'pageup' ? 10 : -10));
        render();
        continue;
      }
      // TUI-NEXT-FOLD — Enter/Tab (or F) in the log expands/folds the long tool block visible in the
      // current scroll window (nearest the bottom). With none on screen the key keeps its ordinary meaning.
      if (focus === 'log' && isToolFoldToggleKey(key.name) && toggleVisibleToolFold(expandedToolBlocks, messages, logWindow.columns, logWindow)) {
        render();
        continue;
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
        if ((key.name === 'enter' || key.name === 'return') && !key.shift && activeAtPicker.candidates[activeAtPicker.selected]) {
          const candidate = activeAtPicker.candidates[activeAtPicker.selected]!;
          const picked = atPickerApi!.acceptAtFile(editor.text, activeAtPicker.query, candidate, ++atAttachmentOrdinal);
          editor = { text: picked.text, cursor: picked.cursor };
          atAttachmentTokens.set(picked.token, candidate.absPath);
          atPicker = null;
          dismissedAtQuery = '';
          status = '파일 첨부 추가됨 · Enter 전송';
          debug.log('tui.next', 'at-picker-selected', { path: candidate.absPath });
          render();
          continue;
        }
      }
      if (busy) {
        const pending = applyComposerKey(editor, key);
        editor = pending.state;
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
            status = requestNewTuiSession({ busy: true, from: id }).status;
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
          queue = restoreTurnTypeaheadSubmission(queue, pending.submitted);
          status = '응답 중 · 완료 뒤 순서대로 전송 · Esc 취소';
          debug.log('tui.next', 'queue-enqueued', { length: pending.submitted.length, count: queue.queuedSubmissions.length });
        }
        render();
        continue;
      }
      if (key.name === 'up' || key.name === 'down') {
        const prompts = messages.filter((message) => message.role === 'user').map((message) => message.content);
        if (prompts.length === 0 || (key.name === 'down' && historyIndex === 0)) {
          render();
          continue;
        }
        if (key.name === 'up' && historyIndex === 0) draft = editor.text;
        historyIndex = Math.max(0, Math.min(prompts.length, historyIndex + (key.name === 'up' ? 1 : -1)));
        editor = createInlineEditorState(historyIndex === 0 ? draft : prompts[prompts.length - historyIndex]!);
        render();
        continue;
      }
      focus = 'input';
      const result = applyComposerKey(editor, key);
      editor = result.state;
      if (result.action === 'edit') await refreshAtPicker();
      else if (result.action === 'submit' || result.action === 'cancel' || result.action === 'quit') atPicker = null;
      if (restoreDraft !== null) {
        // A queued submission just left through this Enter; what the person was typing comes back.
        if (result.action === 'submit') editor = createInlineEditorState(restoreDraft);
        restoreDraft = null;
      }
      if (result.action === 'edit' || result.action === 'cancel' || result.action === 'submit') historyIndex = 0;
      if (result.action === 'quit') break;
      if (result.action === 'cancel') {
        status = '입력 취소됨 · Enter 전송 · Ctrl+Q 종료';
        pasteFold.retainOnly([editor.text, ...queue.queuedSubmissions.map(String)]);
      }
      if (result.action === 'submit' && result.submitted) {
        const submittedFull = pasteFold.expand(result.submitted);
        // 지운 붙여넣기의 원문은 놓는다 — 입력칸·대기열에 남은 토큰만 쥔다(r3 must-fix).
        pasteFold.retainOnly([editor.text, ...queue.queuedSubmissions.map(String)]);
        const submitted = submittedFull.trim();
        const routeRegistry = await loadNextTuiRouteRegistry();
        const route = routeRegistry.resolveNextTuiRoute(submitted, routeRegistry.NEXT_TUI_INPUT_CONTEXT);
        if (route?.action === 'quit') break;
        if (route?.id === 'session.new') {
          const next = requestNewTuiSession({ busy, from: id });
          if (next.kind === 'started') {
            (loopCommand as NextLoopCommand | null)?.run('stop');
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            selfHealthSubscription.stop?.();
            selfHealthSubscription.stop = undefined;
            selfHealthLine = null;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            id = next.id;
            lastResumeRows = null;
            session = loadSession(id);
            messages = [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            streamingReply = '';
            scroll = 0;
            focus = 'input';
            draft = '';
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
            selfHealthSubscription.stop?.();
            selfHealthSubscription.stop = undefined;
            selfHealthLine = null;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            id = next.id;
            lastResumeRows = null;
            session = loadSession(id);
            messages = session?.messages ?? [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            streamingReply = '';
            scroll = 0;
            focus = 'input';
            draft = '';
            historyIndex = 0;
          }
          status = safeStatusText(next.status);
          render();
          continue;
        }
        if (route?.id === 'loop') {
          activity = await runLoopCommand(submitted.slice('/loop'.length));
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.id === 'provider') {
          const command = submitted.slice('/provider'.length).trim();
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
        if (route?.id === 'harness') {
          const rest = submitted.slice('/harness'.length).trim();
          const command = rest === 'runs' ? 'runs' : rest.startsWith('ask ') ? 'ask' : null;
          const goal = command === 'ask' ? rest.slice(4).trim() : '';
          if (!command || (command === 'ask' && (!goal || goal === '--dry-run'))) {
            activity.push('사용법: /harness ask <목표> · /harness runs');
            render();
            continue;
          }
          activity = [safeStatusText(`하니스 ${command === 'ask' ? '시작' : '진행 조회'}: ${goal || 'runs'}`)];
          busy = true;
          status = '하니스 진행 중 · Esc 취소';
          const abort = new AbortController();
          turnAbort = abort;
          turnDone = import('../tui-client/local-harness-command.js')
            .then(({ runLocalHarnessCommand }) => runLocalHarnessCommand(command, goal, abort.signal, (line) => {
              activity.push(safeStatusText(line));
              activity = activity.slice(-80);
              render();
            }))
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
        if (route?.action === 'help') {
          activity.push(...(await loadNextTuiRouteRegistry()).NEXT_TUI_HELP_LINES);
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.id === 'sidetab') {
          const args = submitted.slice(1).trim().split(/\s+/);
          const action = args[1]?.toLowerCase();
          if (action === 'help') {
            activity.push('/side [open|close|off|on|all|workspaces|new|kill|help] · /sidetab 별칭', 'Ctrl+\\ 후 s=사이드탭 · p=부모 · 1–9=선택 · Esc=입력 · 목록 클릭=전환');
            status = 'Enter 전송';
          } else if (action === 'off') {
            const restoreOpen = sidetabOpen;
            if (sidetabOpen) await toggleSidetab();
            sidetabEnabled = false;
            if (restoreOpen) {
              sidetabOpenBySession.set(id!, true);
              updateSessionMeta(id!, (meta) => { meta.uiState = { ...meta.uiState, sidetabOpen: true }; });
            }
            status = '사이드탭 off · /side on 으로 이 세션에서 켜기';
          } else if (action === 'on') {
            sidetabEnabled = true;
            if (sidetabOpenBySession.get(id!) === true && !sidetabOpen) await toggleSidetab();
            status = sidetabOpen ? '사이드탭 on · 열림' : '사이드탭 on · /side open 으로 열기';
          } else if (action === 'open') {
            sidetabEnabled = true;
            if (!sidetabOpen) await toggleSidetab();
          } else if (action === 'close') {
            if (sidetabOpen) await toggleSidetab();
          } else if (action === 'all') {
            expandedWorkspaceIds.clear();
            const nextViewMode: 'current' | 'all' = sidetabViewMode === 'all' ? 'current' : 'all';
            sidetabViewMode = nextViewMode;
            sidetabEnabled = true;
            if (!sidetabOpen) await toggleSidetab();
            else refreshSidetabRows();
            status = nextViewMode === 'all' ? '사이드탭 전체 목록' : '사이드탭 현재 세션 목록';
          } else if (action === 'workspaces') {
            expandedWorkspaceIds.clear();
            sidetabViewMode = sidetabViewMode === 'workspaces' ? 'current' : 'workspaces';
            sidetabEnabled = true;
            if (!sidetabOpen) await toggleSidetab();
            else refreshSidetabRows();
            status = sidetabViewMode === 'workspaces' ? '사이드탭 미션·하니스 워크스페이스' : '사이드탭 현재 세션 목록';
          } else if (action === 'kill') {
            if (!sidetabApi) sidetabApi = await import('./sidetab/list.js');
            refreshSidetabRows();
            const selected = sidetabRows[sidetabSelected];
            if (selected) {
              await ensureSidetabAttachments();
              sidetabAttachments?.kill(selected);
              refreshSidetabRows();
            } else {
              status = '종료할 PTY가 없습니다';
            }
          } else if (action === 'new') {
            sidetabEnabled = true;
            if (!sidetabOpen) await toggleSidetab();
            if (sidetabOpen) sidetabMode = 'new';
          } else {
            await toggleSidetab();
          }
          render();
          continue;
        }
        if (route?.id === 'terminal') {
          const { dispatchNextTermSlash } = await import('./slash/term-next.js');
          const args = submitted.slice('/'.length).trim().split(/\s+/).slice(1);
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
          await dispatchNextTermSlash(args, {
            chatLines: activity,
            setChatScrollOffset: (value) => { scroll = Math.max(0, Math.min(value, maxScroll)); },
            sessions,
          });
          status = 'Enter 전송';
          render();
          continue;
        }
        if (route?.id === 'signals') {
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
    setNextSidetabHandler(null);
    setNextSidetabIpcEnabled(false);
    turnAbort?.abort();
    await turnDone;
    backgroundSubscription.stop?.();
    selfHealthSubscription.stop?.();
    selfHealthLine = null;
    if (id) {
      const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
      await closeLocalChatSession(id);
    }
    process.stdout.off('resize', render);
    closeTui();
  }
}
