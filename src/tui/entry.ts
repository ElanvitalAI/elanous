import { initTui, closeTui, injectKey, readKey, type Key } from '../tui.js';
import { createSession, getActiveSessionId, loadSession, resolveSessionId, setActiveSessionId } from '../session/index.js';
import { fitLogLine, isToolFoldToggleKey, logViewLines, safeLogText, safeStatusText, streamReplyLines, toggleVisibleToolFold, toolFoldBlockStarts, wheelScroll } from './chat/log-view.js';
import { BackgroundJobStatus } from './chat/background-job-status.js';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, applyComposerKey, composerViewport, emptyComposer, wheelDirection } from './input/composer.js';
import { createInlineEditorState, type InlineEditorState } from '../input-core/inline-editor.js';
import { isNewSessionCommand, nextTuiTitle, requestNewTuiSession } from './slash/new-session.js';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS, isCompactCommand } from './slash/compact-command.js';
import { RESUME_BUSY_STATUS, parseResumeCommand, requestResumeTuiSession, resumeCandidates, resumeListLines } from './slash/resume.js';
import { reportTuiTurn } from '../pty-shell/tui-run-state.js';
import { createPasteFold } from '../chat/paste-fold.js';
import { createTurnTypeaheadState, dequeueTurnTypeaheadHandoff, drainTurnTypeaheadOnce, restoreTurnTypeaheadSubmission } from '../chat/turn-typeahead.js';
import { debug } from '../debug/log.js';
import { setCliStderrSink } from '../git-fs/cli-stderr.js';
import { createInputLagProbe } from './input-lag-probe.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import { countInterimDisplay, internalTurnOriginOfText, planInterimDisplay } from './chat/goal-interim.js';
import type { NextTuiSelfHealthSnapshot } from './chat/self-health-status.js';
import { createNextLoopCommand, type NextLoopCommand } from '../tui-client/next-loop-command.js';
import { handleMissionSlash, type MissionSlashContext } from './slash/mission.js';
import { handleSignalsSlash } from './slash/signals.js';

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
  /** Read-only terminal session source; injectable so the Next slash stays testable without PTYs. */
  readonly termSessions?: {
    list(): readonly NextTuiTermSession[] | Promise<readonly NextTuiTermSession[]>;
  };
}

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

/** Local chat entry: history and input are TUI-owned; turn execution stays shared. */
export async function showNextTui(options: NextTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('elanous --tui next requires stdin TTY');
  if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 6) {
    throw new Error('elanous --tui next requires at least 20 columns and 6 rows');
  }
  const dashboardRuntime = await (await import('../tui-client/next-dashboard-runtime.js')).loadNextTuiDashboardRuntime();
  const requested = options.resumeSessionId ?? getActiveSessionId();
  let id = requested ? resolveSessionId(requested) : null;
  if (requested && !id) throw new Error(`session not found: ${requested}`);
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
  let lastResumeRows: ReturnType<typeof resumeCandidates> | null = null;
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
  const slashHandlers = new Map<string, (args: string[], context: MissionSlashContext) => Promise<void>>();
  slashHandlers.set('mission', handleMissionSlash);
  slashHandlers.set('signals', handleSignalsSlash);
  const dispatchSlash = async (name: string, args: string[], context: MissionSlashContext): Promise<boolean> => {
    const handler = slashHandlers.get(name);
    if (!handler) return false;
    await handler(args, context);
    return true;
  };
  const missionWatchTimers = new Set<ReturnType<typeof setInterval>>();
  let missionWatchesClosed = false;
  const readyWatchIds = new Set<string>();
  const runWatchIds = new Set<string>();
  const startMissionReadyWatch = (missionId: string): void => {
    if (readyWatchIds.has(missionId)) return;
    readyWatchIds.add(missionId);
    pushNotice(`미션 준비 관찰 시작: ${missionId}`);
    void import('../autopilot/mission-tui-watch.js').then((watch) => {
      if (missionWatchesClosed) { readyWatchIds.delete(missionId); return; }
      const baseline = watch.takeMissionReadySnapshot(missionId);
      let state = watch.createMissionWatchState(baseline, Date.now());
      const timer = setInterval(() => {
        const current = watch.takeMissionReadySnapshot(missionId);
        const result = watch.advanceMissionWatch(state, current, Date.now());
        state = result.state;
        for (const event of result.events) {
          if (event.kind === 'phases') activity.push(`미션 분해 진행 — ${event.count} 페이즈 (${missionId})`);
          else if (event.kind === 'ready') {
            activity.push(`미션 준비 완료 — ${event.snapshot.goal}`);
            activity.push(...watch.missionDescriptionDigest(event.snapshot.description));
            activity.push(...watch.renderMissionPhaseBoardLines(event.snapshot.phases, { goal: event.snapshot.goal }));
            activity.push(`검토 후 /mission approve|hold ${missionId}`);
          } else if (event.kind === 'resolved-elsewhere') activity.push(`미션 ${missionId} 은 다른 서피스에서 해소됨 (status=${event.status})`);
          else if (event.kind === 'gone') activity.push(`미션 ${missionId} 삭제됨 · 준비 관찰 종료`);
          else if (event.kind === 'timeout') activity.push(`미션 준비 관찰 타임아웃 · /mission trace ${missionId}`);
        }
        if (result.events.length > 0) { activity = activity.slice(-80); render(); }
        if (result.done) { clearInterval(timer); missionWatchTimers.delete(timer); readyWatchIds.delete(missionId); }
      }, watch.MISSION_WATCH_INTERVAL_MS);
      missionWatchTimers.add(timer);
    }).catch((error: unknown) => {
      readyWatchIds.delete(missionId);
      pushNotice(`미션 준비 관찰 실패: ${safeStatusText(error instanceof Error ? error.message : String(error))}`);
      render();
    });
    render();
  };
  const startMissionRunWatch = (missionId: string): void => {
    if (runWatchIds.has(missionId)) return;
    runWatchIds.add(missionId);
    pushNotice(`미션 실행 관찰 시작: ${missionId}`);
    void import('../autopilot/mission-tui-watch.js').then((watch) => {
      if (missionWatchesClosed) { runWatchIds.delete(missionId); return; }
      const baseline = watch.takeMissionRunSnapshot(missionId);
      let state = watch.createMissionRunWatchState(baseline, Date.now());
      const timer = setInterval(() => {
        const current = watch.takeMissionRunSnapshot(missionId);
        const result = watch.advanceMissionRunWatch(state, current, Date.now());
        state = result.state;
        for (const event of result.events) {
          if (event.kind === 'phase') activity.push(watch.renderMissionRunPhaseLine(event));
          else if (event.kind === 'progress') activity.push(`미션 진행 ${event.phase.index + 1}/${event.total}: ${event.note}`);
          else if (event.kind === 'finished') activity.push('미션 종결', ...watch.renderMissionRunReportLines(event.snapshot));
          else if (event.kind === 'gone') activity.push(`미션 ${missionId} 삭제됨 · 실행 관찰 종료`);
          else if (event.kind === 'timeout') activity.push(`미션 실행 관찰 타임아웃 · /mission trace ${missionId}`);
        }
        if (result.events.length > 0) { activity = activity.slice(-80); render(); }
        if (result.done) { clearInterval(timer); missionWatchTimers.delete(timer); runWatchIds.delete(missionId); }
      }, watch.MISSION_RUN_WATCH_INTERVAL_MS);
      missionWatchTimers.add(timer);
      if (baseline) { activity.push(watch.renderMissionRunFooter(baseline)); render(); }
    }).catch((error: unknown) => {
      runWatchIds.delete(missionId);
      pushNotice(`미션 실행 관찰 실패: ${safeStatusText(error instanceof Error ? error.message : String(error))}`);
      render();
    });
    render();
  };
  const missionContext: MissionSlashContext = {
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
      startReadyWatch: startMissionReadyWatch,
      startRunWatch: startMissionRunWatch,
    },
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
    const columns = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    if (columns < 20 || rows < 6) {
      process.stdout.write(`\x1b[H\x1b[2J${fitLogLine('터미널이 너무 작습니다 · q 종료', Math.max(1, columns))}`);
      return;
    }
    const backgroundLine = backgroundJobs.line();
    const footerRows = backgroundLine ? 2 : 1;
    const history = [
      ...logViewLines(messages, columns, expandedToolBlocks),
      ...notices.map((line) => fitLogLine(line, columns)),
      ...activity.map((line) => fitLogLine(line, columns)),
    ];
    const bodyRows = rows - 3 - footerRows;
    maxScroll = Math.max(0, history.length - bodyRows);
    scroll = Math.min(scroll, maxScroll);
    const start = Math.max(0, history.length - bodyRows - scroll);
    const body = history.slice(start, start + bodyRows);
    logWindow = { start, rows: bodyRows, columns };
    const title = fitLogLine(`elanous next · ${safeLogText(nextTuiTitle(session?.meta)).split('\n')[0]}`, columns);
    const turnStatus = (!busy && focus === 'log'
      ? `로그 탐색 · ↑↓ 스크롤${toolFoldBlockStarts(messages, columns).length > 0 ? ' · Enter 접기/펼치기' : ''} · Esc 입력`
      : status) + nextTuiQueueSuffix(queue.queuedSubmissions.length);
    const footer = backgroundLine
      ? [fitLogLine(backgroundLine, columns), fitLogLine(turnStatus, columns)]
      : [fitLogLine(turnStatus, columns)];
    const prompt = composerViewport(editor, columns);
    const header = [title, mailLine ? fitLogLine(mailLine, columns) : '─'.repeat(Math.min(columns, 80))];
    if (selfHealthLine) header.push(fitLogLine(selfHealthLine, columns));
    if (atPicker) {
      const limit = Math.max(1, Math.min(6, rows - 8));
      const start = Math.max(0, Math.min(atPicker.selected - limit + 1, atPicker.candidates.length - limit));
      const visible = atPicker.candidates.slice(start, start + limit);
      header.push(fitLogLine(visible.length ? '@ 파일 첨부 · ↑↓ 선택 · Enter 추가 · Esc 닫기' : '@ 파일 후보 없음', columns));
      for (const [offset, candidate] of visible.entries()) {
        header.push(fitLogLine((start + offset === atPicker.selected ? '▸' : ' ') + ' ' + candidate.label, columns));
      }
    }
    const lines = [...header, ...body, ...footer, prompt.line];
    const promptRow = lines.length;
    process.stdout.write(`\x1b[H\x1b[2J${lines.join('\n')}\x1b[${promptRow};${prompt.cursorCol}H\x1b[?25h`);
  };

  let restoreCliStderrSink: (() => void) | null = null;

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
    const abort = new AbortController();
    turnAbort = abort;
    turnDone = import('../tui-client/local-chat-turn.js')
      .then(({ runLocalChatTurn, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus }) => {
        backgroundSubscription.stop ??= onLocalChatBackgroundStatus(turnSessionId, (frame) => {
          if (frame === null) {
            backgroundJobs.clear();
            render();
          } else if (backgroundJobs.accept(frame)) render();
        });
        selfHealthSubscription.stop ??= onLocalChatSelfHealthStatus(turnSessionId, (snapshot: NextTuiSelfHealthSnapshot | null) => {
          selfHealthLine = snapshot?.line ?? null;
          render();
        });
        let firstResponseSeen = false;
        return runLocalChatTurn(turnSessionId, turnText, abort.signal, undefined, undefined, (delta) => {
          // 첫 응답 경계: 첫 스트림 델타에서 턴 시작 트레이스를 닫는다(endedBy=stream-open).
          if (!firstResponseSeen) {
            firstResponseSeen = true;
            dashboardRuntime.endTurnStartSegments(turnSessionId, 'stream-open');
          }
          // The first model token is visible before the final JSONL frame. Keep only
          // a bounded tail until session history becomes the canonical display.
          streamingReply = (streamingReply + delta).slice(-32_768);
          activity = streamReplyLines(streamingReply, process.stdout.columns || 80);
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
        }, attachments);
      })
      .then(() => { status = `${compactNote}응답 완료 · Enter 전송 · Ctrl+Q 종료`; })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        turnFailed = true;
        status = compactNote + (message === '응답을 취소했습니다'
          ? '응답 취소됨 · Enter 전송'
          : `응답 실패: ${safeStatusText(message)}`);
      })
      .finally(() => {
        if (streamRenderTimer !== null) clearTimeout(streamRenderTimer);
        streamRenderTimer = null;
        session = loadSession(turnSessionId);
        messages = session?.messages ?? [];
        activity = [];
        streamingReply = '';
        busy = false;
        reportTuiTurn('idle');
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
        // 사람이 쌓아 둔 다음 입력이 먼저다 — 대기열이 비었을 때만 골 이어가기를 잰다.
        if (goalContinue && queue.queuedSubmissions.length === 0 && editor.text.length === 0) {
          try {
            goalContinue.noteTurnEnded({ lines: dashboardRuntime.replyLinesOfThisTurn(messages, turnCompacted ? 'after-last-user' : messagesAtTurnStart), failed: turnFailed || interrupted });
            goalContinue.check();
          } catch { /* fail-soft: 골 이어가기는 턴 정리를 막지 않는다 */ }
        } else if (goalContinue && (queue.queuedSubmissions.length > 0 || editor.text.length > 0)) {
          debug.log('tui.proactive', 'yield-user-input', { queued: queue.queuedSubmissions.length, bufferedChars: editor.text.length });
        }
        render();
      });
  };

  initTui();
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
  try {
    {
      const { createNextTuiWakeup, setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      wakeup = createNextTuiWakeup({
        isTurnRunning: () => busy,
        getBufferText: () => editor.text,
        getQueuedCount: () => queue.queuedSubmissions.length,
        requestYield: () => injectKey(internalWake),
        notify: (line) => { pushNotice(line); render(); },
      });
      setNextTuiWakeupTool(wakeup.tool);
      const gate = wakeup.gate;
      loopCommand = createNextLoopCommand(gate, (event, data) => debug.log('dashboard.loop', event, data));
      goalContinue = dashboardRuntime.createGoalContinue({
        startTurnIfIdle: (text, opts) => gate.startTurnIfIdle(text, opts),
        notify: (line) => { pushNotice(line); render(); },
      });
    }
    render();
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
          if (pending.submitted.trim() === '/quit') {
            turnAbort?.abort();
            await turnDone;
            break;
          }
          if (isNewSessionCommand(pending.submitted)) {
            // A turn still writes to the current session; switching under it would split the reply.
            status = requestNewTuiSession({ busy: true, from: id }).status;
            render();
            continue;
          }
          if (isCompactCommand(pending.submitted)) {
            // The running turn owns the session file; rewriting it underneath would race the reply.
            status = COMPACT_BUSY_STATUS;
            render();
            continue;
          }
          if (parseResumeCommand(pending.submitted)) {
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
        if (submitted === '/quit') break;
        if (isNewSessionCommand(submitted)) {
          const next = requestNewTuiSession({ busy, from: id });
          if (next.kind === 'started') {
            loopCommand?.run('stop');
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
        if (isCompactCommand(submitted)) {
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
        const resumeCommand = parseResumeCommand(submitted);
        if (resumeCommand?.kind === 'list') {
          lastResumeRows = resumeCandidates(id);
          activity = resumeListLines(lastResumeRows, id).map(safeStatusText);
          status = '/resume <번호|id 앞자리> 로 이어 가기 · Enter 전송';
          debug.log('tui.next', 'session-resume-list', { from: id, rows: activity.length });
          render();
          continue;
        }
        if (resumeCommand?.kind === 'load') {
          const next = requestResumeTuiSession({ busy, from: id, prefix: resumeCommand.prefix, rows: lastResumeRows ?? resumeCandidates(id) });
          if (next.kind === 'started') {
            loopCommand?.run('stop');
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
        if (submitted === '/loop' || submitted.startsWith('/loop ')) {
          activity = loopCommand?.run(submitted.slice('/loop'.length)) ?? ['사용법: /loop <간격> <프롬프트> · /loop stop'];
          status = 'Enter 전송';
          render();
          continue;
        }
        if (submitted === '/provider' || submitted.startsWith('/provider ')) {
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
        if (submitted === '/harness' || submitted.startsWith('/harness ')) {
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
        if (submitted === '/term' || submitted.startsWith('/term ') || submitted === '/terminal' || submitted.startsWith('/terminal ')) {
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
        if (
          submitted === '/mission' || submitted.startsWith('/mission ')
          || submitted === '/signals' || submitted.startsWith('/signals ')
        ) {
          missionContext.chatLines = activity;
          const [command = '', ...args] = submitted.slice('/'.length).trim().split(/\s+/);
          const dispatched = await dispatchSlash(command, args, missionContext);
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
    restoreCliStderrSink?.();
    restoreCliStderrSink = null;
    if (residueTimer !== null) clearTimeout(residueTimer);
    loopCommand?.dispose();
    missionWatchesClosed = true;
    for (const timer of missionWatchTimers) clearInterval(timer);
    missionWatchTimers.clear();
    readyWatchIds.clear();
    runWatchIds.clear();
    wakeup?.dispose();
    if (wakeup) {
      const { setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      setNextTuiWakeupTool(null);
    }
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
