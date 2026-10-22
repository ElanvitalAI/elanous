import { initTui, closeTui, injectKey, readKey, type Key } from '../tui.js';
import { createSession, getActiveSessionId, loadSession, resolveSessionId, setActiveSessionId } from '../session/index.js';
import { fitLogLine, logViewLines, safeLogText, safeStatusText, streamReplyLines, wheelScroll } from './chat/log-view.js';
import { BackgroundJobStatus } from './chat/background-job-status.js';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, applyComposerKey, composerViewport, emptyComposer, wheelDirection } from './input/composer.js';
import { createInlineEditorState, type InlineEditorState } from '../input-core/inline-editor.js';
import { isNewSessionCommand, nextTuiTitle, requestNewTuiSession } from './slash/new-session.js';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS, isCompactCommand } from './slash/compact.js';

export interface NextTuiOptions {
  readonly resumeSessionId?: string;
}

/** Local chat entry: history and input are TUI-owned; turn execution stays shared. */
export async function showNextTui(options: NextTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('elanous --tui next requires stdin TTY');
  if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 6) {
    throw new Error('elanous --tui next requires at least 20 columns and 6 rows');
  }
  const requested = options.resumeSessionId ?? getActiveSessionId();
  let id = requested ? resolveSessionId(requested) : null;
  if (requested && !id) throw new Error(`session not found: ${requested}`);
  let session = id ? loadSession(id) : null;
  let messages = session?.messages ?? [];
  // The seat ledger is touched only on next-TUI boot, and only when the
  // optional seat directory exists. No dashboard modules enter this path.
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
  let streamingReply = '';
  let streamRenderAt = 0;
  let streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
  const backgroundJobs = new BackgroundJobStatus(id);
  const backgroundSubscription: { stop?: () => void } = {};

  const render = (): void => {
    const columns = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    if (columns < 20 || rows < 6) {
      process.stdout.write(`\x1b[H\x1b[2J${fitLogLine('터미널이 너무 작습니다 · q 종료', Math.max(1, columns))}`);
      return;
    }
    const backgroundLine = backgroundJobs.line();
    const footerRows = backgroundLine ? 2 : 1;
    const history = [...logViewLines(messages, columns), ...activity.map((line) => fitLogLine(line, columns))];
    const bodyRows = rows - 3 - footerRows;
    maxScroll = Math.max(0, history.length - bodyRows);
    scroll = Math.min(scroll, maxScroll);
    const start = Math.max(0, history.length - bodyRows - scroll);
    const body = history.slice(start, start + bodyRows);
    const title = fitLogLine(`elanous next · ${safeLogText(nextTuiTitle(session?.meta)).split('\n')[0]}`, columns);
    const turnStatus = !busy && focus === 'log' ? '로그 탐색 · ↑↓ 스크롤 · Esc 입력' : status;
    const footer = backgroundLine
      ? [fitLogLine(backgroundLine, columns), fitLogLine(turnStatus, columns)]
      : [fitLogLine(turnStatus, columns)];
    const prompt = composerViewport(editor, columns);
    const lines = [title, mailLine ? fitLogLine(mailLine, columns) : '─'.repeat(Math.min(columns, 80)), ...body, ...footer, prompt.line];
    const promptRow = lines.length;
    process.stdout.write(`\x1b[H\x1b[2J${lines.join('\n')}\x1b[${promptRow};${prompt.cursorCol}H\x1b[?25h`);
  };

  initTui();
  process.stdout.on('resize', render);
  try {
    render();
    while (true) {
      const replayed = replay.shift();
      const key = replayed ?? await readKey();
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
          editor = createInlineEditorState(pending.submitted);
          status = '응답 중 · 완료 뒤 Enter 전송';
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
      if (result.action === 'edit' || result.action === 'cancel' || result.action === 'submit') historyIndex = 0;
      if (result.action === 'quit') break;
      if (result.action === 'cancel') status = '입력 취소됨 · Enter 전송 · Ctrl+Q 종료';
      if (result.action === 'submit' && result.submitted) {
        const submitted = result.submitted.trim();
        if (submitted === '/quit') break;
        if (isNewSessionCommand(submitted)) {
          const next = requestNewTuiSession({ busy, from: id });
          if (next.kind === 'started') {
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            id = next.id;
            session = loadSession(id);
            messages = [];
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
              busy = false;
              scroll = 0;
              render();
            });
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
              render();
            });
          render();
          continue;
        }
        activity = [];
        streamingReply = '';
        streamRenderAt = 0;
        if (!id) {
          id = createSession({ source: 'tui' }).id;
          setActiveSessionId(id);
          session = loadSession(id);
          backgroundJobs.setSessionId(id);
        }
        const turnSessionId = id;
        const turnText = result.submitted;
        busy = true;
        status = '응답 중 · Esc 취소';
        // «압축 N→M 메시지» stays on the status line through the reply when this turn compacted first.
        let compactNote = '';
        const abort = new AbortController();
        turnAbort = abort;
        turnDone = import('../tui-client/local-chat-turn.js')
          .then(({ runLocalChatTurn, onLocalChatBackgroundStatus }) => {
            backgroundSubscription.stop ??= onLocalChatBackgroundStatus(turnSessionId, (frame) => {
              if (frame === null) {
                backgroundJobs.clear();
                render();
              } else if (backgroundJobs.accept(frame)) render();
            });
            return runLocalChatTurn(turnSessionId, turnText, abort.signal, undefined, undefined, (delta) => {
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
                status = `${compactNote}응답 중 · Esc 취소`;
                session = loadSession(turnSessionId);
                messages = session?.messages ?? [];
                render();
              },
            });
          })
          .then(() => { status = `${compactNote}응답 완료 · Enter 전송 · Ctrl+Q 종료`; })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
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
            turnAbort = null;
            scroll = 0;
            render();
          });
      }
      render();
    }
  } finally {
    if (residueTimer !== null) clearTimeout(residueTimer);
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
