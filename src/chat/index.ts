// ── Chat module — Grok AI conversation with Claude Code-style spinner ──
// Integrates into the dashboard log pane as an inline chat

import { getGrokApiKey, GROK_MODEL, GROK_API_URL } from '../config.js';
import { C, ansi, KeyStreamParser, readKey, traceKey, traceKeyListener, termSize, pad, visibleWidth, stripAnsi, truncate, render, hLine, closeTui, resetRenderCache, invalidateRenderCacheFromRow, injectKey } from '../tui.js';
import { paintCursorMove, paintCursorVisibility, type CursorState } from '../display/cursor-state.js';
import { firstVisibleInputLineIdx, inputLineWindow } from '../display/prompt-frame.js';
import { createChatPickerFamilySource, createChatPickerFamilySources } from './pickers/modals.js';
import type { ChatPickerKind } from './pickers/kinds.js';
import { createPickerState, type BufferAction, type PickerBufferView } from './pickers/state.js';
import { createChatPickerModalRuntime } from './pickers/modal-runtime.js';
import type { ModalSurface } from '../display/modal-stack.js';
// Type-only import: avoids the runtime circular dep that streamGrok
// below sidesteps with a dynamic `await import('../llm.js')`. Keeping
// ChatMessage structurally compatible with LLMMessage lets the
// dashboard stash rich tool_use/tool_result blocks in chat.history
// instead of dropping them after each turn — the elanous side of the
// "history-as-source-of-truth" pattern claude-code-fork uses.
import type { ContentBlock } from '../llm.js';
import { debug } from '../debug/log.js';
import { matchTextInputGlobalAction } from './global-actions.js';
import { isTextInputQuitChord } from './input-quit-chord.js';
// P5 — leader-chord pass-through from input focus. chat.ts swallows
// plain letters into its textarea buffer, so the resolver never sees
// them unless we peek first. These two helpers let textInput arm the
// chord on Ctrl+B and route the next letter through the resolver
// before the buffer-insert path runs.
import {
  armChordLeader,
  dispatchInputEvent,
  isInputCoreChordArmed,
  keyEvent as inputCoreKeyEvent,
  getInputSettings,   // R6 — chord window from user-config
} from '../input-core/index.js';
import { applyInlineEditorKey } from '../input-core/inline-editor-key.js';
import type { InputSourceRef } from '../input/input-source-kind.js';
import {
  multilineEditorBackspace,
  multilineEditorInsertLineBreak,
  multilineEditorMoveLeft,
  multilineEditorMoveRight,
  multilineEditorMoveVertical,
} from '../input-core/multiline-editor.js';

/** P2.2.c — minimal coordinator surface textInput needs. Exposed as
 *  a structural type so chat.ts doesn't pull the whole DisplayCoordinator
 *  module — easier mocking in tests and avoids circular imports. */
export interface CursorSink {
  setCursor(state: CursorState | null): void;
}

/** P2.3.b — minimal modal-stack interface chat.ts uses to push/pop
 *  picker modals. Subset of DisplayCoordinator — kept structural so
 *  tests can inject a fake. */
export interface ModalSink {
  pushModal(surface: ModalSurface): { id: string; dispose: () => void };
  /** F-E2 — force the coordinator to repaint the modal overlay. Chat
   *  calls this after every keystroke so the picker's paint closure
   *  re-evaluates `getFiltered()` / `getItems()` — without it, the
   *  picker handle stays mounted but its filter output doesn't flow
   *  back to the screen until an unrelated event forces a frame
   *  (cursor move, pane redraw, etc.), producing the "typed-but-list-
   *  didn't-update" symptom. Optional: test fakes can omit it. */
  requestRender?(opts?: { force?: boolean }): void;
}

/** P2.3.b — combined sink — chat callers usually pass one
 *  DisplayCoordinator that satisfies both. */
export interface DisplaySink extends CursorSink, ModalSink {}
import type { Key } from '../tui.js';
import {
  createSpinner,
  createToolLoader,
  applyColor,
  FIGURES,
  loadingMessage,
  randomVerb,
  stalledIntensity,
  stalledColor,
  renderMarkdown,
  type StatusColor,
} from '../render.js';
import { urlAwareWrap } from './wrap.js';
import { deleteAttachmentTokenBeforeCursor } from './attachment-token.js';
import {
  navigateSingleLineHistory,
  shouldPreferHistoryArrowNavigation,
  shouldSuppressSlashPickerAfterHistoryRecall,
  type TextInputHistoryState,
} from './input-history-state.js';
import {
  acceptReverseHistorySearch as acceptReverseHistorySearchState,
  applyReverseHistorySearchKey,
  cancelReverseHistorySearch as cancelReverseHistorySearchState,
  inactiveReverseHistorySearchState,
  resolveCurrentReverseHistorySearchResult,
  startOrCycleReverseHistorySearch,
} from './reverse-history-search.js';
import {
  applyCurrentLineEditorState as applyCurrentLineEditorStateToBuffer,
  applyMultilineEditorState as applyMultilineEditorStateToBuffer,
  currentLineEditorState as currentLineEditorStateFromBuffer,
  insertMultilineTextAtCursor,
  insertTextAtCursor,
  multilineEditorState as multilineEditorStateFromBuffer,
} from './input-buffer-state.js';
import { resolveTextInputControlAction } from './input-control-key.js';
import { resolveTextInputEditAction } from './input-edit-key.js';
import { resolveTextInputTextAction } from './input-text-key.js';

import { perf } from '../perf-counters.js';

/** Row where the input prompt starts — set by the textInput paint
 *  loop so writeTerminal knows which rows to invalidate in the
 *  frame cache. Falls back to "invalidate everything" when unknown
 *  (first paint, overlays, etc). */
let _inputPromptStartRow = -1;

export type TextInputDirectWriteStrategy =
  | { kind: 'scoped-invalidate'; fromRow: number }
  | { kind: 'full-reset' };

export function resolveTextInputDirectWriteStrategy(
  inputPromptStartRow: number,
): TextInputDirectWriteStrategy {
  return inputPromptStartRow >= 0
    ? { kind: 'scoped-invalidate', fromRow: inputPromptStartRow }
    : { kind: 'full-reset' };
}

/** P2.1: narrow the frame-cache invalidation when direct stdout
 *  writes happen from the input loop. The old behaviour called
 *  resetRenderCache() which nuked EVERY row, forcing the next
 *  render() to re-emit the entire screen — including the work
 *  already in the cache above the input. Now we only invalidate
 *  the input zone and below (prompt rows + picker overlay space),
 *  so render() reuses the cached pane / log / status rows and just
 *  diffs the bottom band. Fallback: if the input row hasn't been
 *  reported yet, full reset — safer than painting a stale cache.
 *
 *  This is a PARTIAL step toward full coordinator integration
 *  (P2.2/P2.3). The remaining goal is to route the input paint
 *  itself through the frame cache so there are no direct writes at
 *  all; that requires rewriting the textInput paint loop and is
 *  deferred to a separate focused branch. */
function writeTerminal(chunk: string): void {
  const strategy = resolveTextInputDirectWriteStrategy(_inputPromptStartRow);
  if (strategy.kind === 'scoped-invalidate') {
    invalidateRenderCacheFromRow(strategy.fromRow);
  } else {
    resetRenderCache();
  }
  process.stdout.write(chunk);
  // viaCoordinator=false — this is the bypass path /perf highlights.
  perf.recordStdoutWrite(chunk.length, false);
}

/** textInput reports the current prompt's top row so writeTerminal
 *  can scope its cache invalidation. Passing -1 reverts to full
 *  reset for safety when we aren't sure where input is. */
export function setInputPromptStartRow(row: number): void {
  _inputPromptStartRow = row;
}

export interface SpinnerHandle {
  stop: () => void;
  update: (text: string) => void;
}

export type TextInputGlobalAction =
  | { kind: 'resize-log'; delta: number; reset?: boolean }
  | { kind: 'goto-log' }
  | { kind: 'toggle-log-zoom' }
  | { kind: 'copy-last-block' }
  | { kind: 'spawn-terminal-modal' }
  | { kind: 'copy-log-pane' }
  | { kind: 'provider-rotate-next' }
  // Ctrl+L — 화면 클리어 + 강제 리페인트(대화 보존). codex clear_terminal ·
  // claude-code app:redraw 관례 정렬(2026-07-12) — 입력 재진입 semantics 폐기.
  | { kind: 'force-redraw' };

export interface TextInputHost {
  /** Mutable repaint/insert hooks the input loop populates while live. */
  control?: {
    repaint: () => void;
    insertAtCursor?: (text: string) => void;
    /** External submit trigger — voice multi-turn auto-Enter, mouse
     *  surface actions, etc. When `text` is provided, replaces the
     *  buffer; then injects a synthetic Enter key into the readKey
     *  queue so the textInput main loop returns the submit outcome
     *  exactly as if the user had typed Enter. Reset to undefined on
     *  textInput return. */
    submit?: (request?: string | TextInputExternalSubmitRequest) => void;
  };
  onLinesChange?: (visibleLines: number) => void;
  /** Preferred host seam for input-global shortcuts. textInput emits a
   *  semantic action here instead of knowing about dashboard-specific
   *  callback names one by one. */
  dispatchGlobalAction?: (action: TextInputGlobalAction) => void | Promise<void>;
  onLogResize?: (delta: number, reset?: boolean) => void;
  onGotoLog?: () => void;
  onLogZoomToggle?: () => void;
  onCopyLastBlock?: () => void | Promise<void>;
  onSpawnTerminalModal?: () => void;
  onCopyLogPane?: () => void | Promise<void>;
}

export interface ResolvedTextInputHost {
  control?: {
    repaint: () => void;
    insertAtCursor?: (text: string) => void;
    submit?: (request?: string | TextInputExternalSubmitRequest) => void;
  };
  onLinesChange?: (visibleLines: number) => void;
  dispatchGlobalAction?: (action: TextInputGlobalAction) => void | Promise<void>;
}

export interface TextInputRenderActions {
  /** Pure repaint used by host afterRender / resize callbacks. Must
   *  never schedule another coordinator frame or it can create a
   *  self-sustaining render loop. */
  repaintHost: () => void;
  /** User-originated mutation repaint. Repaints locally and then asks
   *  the modal sink to refresh any mounted picker surfaces. */
  repaintUserMutation: () => void;
}

const TEXT_INPUT_CURSOR_PROTOCOL_ENABLE = '\x1b[>1u\x1b[>4;2m';
const TEXT_INPUT_CURSOR_PROTOCOL_DISABLE = '\x1b[<u\x1b[>4;0m';
const SYNCHRONIZED_OUTPUT_BEGIN = '\x1b[?2026h';
const SYNCHRONIZED_OUTPUT_END = '\x1b[?2026l';

export function beginTextInputCursor(cursorSink?: CursorSink): string {
  return (cursorSink ? '' : paintCursorVisibility(true)) + TEXT_INPUT_CURSOR_PROTOCOL_ENABLE;
}

export function hideTextInputCursor(cursorSink?: CursorSink): string {
  cursorSink?.setCursor(null);
  return cursorSink ? '' : paintCursorVisibility(false);
}

export function endTextInputCursor(cursorSink?: CursorSink): string {
  return hideTextInputCursor(cursorSink) + TEXT_INPUT_CURSOR_PROTOCOL_DISABLE;
}

export function resolveTextInputHost(opts: {
  controlOut?: {
    repaint: () => void;
    insertAtCursor?: (text: string) => void;
    submit?: (request?: string | TextInputExternalSubmitRequest) => void;
  };
  onLinesChange?: (visibleLines: number) => void;
  onLogResize?: (delta: number, reset?: boolean) => void;
  onGotoLog?: () => void;
  onCopyLastBlock?: () => void | Promise<void>;
  onSpawnTerminalModal?: () => void;
  onCopyLogPane?: () => void | Promise<void>;
  host?: TextInputHost;
}): ResolvedTextInputHost {
  const host = opts.host;
  const legacyDispatch = (action: TextInputGlobalAction): void | Promise<void> => {
    switch (action.kind) {
      case 'resize-log':
        return (host?.onLogResize ?? opts.onLogResize)?.(action.delta, action.reset);
      case 'goto-log':
        return (host?.onGotoLog ?? opts.onGotoLog)?.();
      case 'toggle-log-zoom':
        return host?.onLogZoomToggle?.();
      case 'copy-last-block':
        return (host?.onCopyLastBlock ?? opts.onCopyLastBlock)?.();
      case 'spawn-terminal-modal':
        return (host?.onSpawnTerminalModal ?? opts.onSpawnTerminalModal)?.();
      case 'copy-log-pane':
        return (host?.onCopyLogPane ?? opts.onCopyLogPane)?.();
      case 'force-redraw':
        // legacy 호스트엔 전용 훅이 없다 — repaint 만으로 폴백(fail-soft).
        return host?.control?.repaint?.();
    }
  };
  return {
    control: host?.control ?? opts.controlOut,
    onLinesChange: host?.onLinesChange ?? opts.onLinesChange,
    dispatchGlobalAction: host?.dispatchGlobalAction ?? legacyDispatch,
  };
}

export function createTextInputRenderActions(opts: {
  /** When false, suppress all direct input repaint work. Used by hosts
   *  to prevent a background prompt from repainting underneath a
   *  foreground blocking modal. */
  shouldPaint?: () => boolean;
  /** Optional frame-chrome repaint that must run before the input
   *  body. Used by hosts to restore adjacent divider ownership when
   *  the input repaints outside the main layout pass. */
  paintChrome?: () => void;
  paint: () => void;
  /** Hide the terminal cursor before direct repaint writes. This keeps
   *  the tty from briefly showing the write cursor at the line end;
   *  coordinator-owned cursor sinks re-show it at the final position. */
  hideCursorBeforePaint?: boolean;
  beforePaint?: () => void;
  modalSink?: ModalSink;
  shouldRequestModalRender?: () => boolean;
}): TextInputRenderActions {
  const paintAll = (synchronizedOutput = false) => {
    if (opts.shouldPaint?.() === false) return false;
    if (synchronizedOutput) writeTerminal(SYNCHRONIZED_OUTPUT_BEGIN);
    try {
      if (opts.beforePaint) {
        opts.beforePaint();
      } else if (opts.hideCursorBeforePaint) {
        writeTerminal(paintCursorVisibility(false));
      }
      opts.paintChrome?.();
      opts.paint();
      return true;
    } finally {
      if (synchronizedOutput) writeTerminal(SYNCHRONIZED_OUTPUT_END);
    }
  };
  const repaintHost = () => {
    paintAll();
  };
  const repaintUserMutation = () => {
    const painted = paintAll(true);
    if (opts.shouldRequestModalRender?.() === false) return;
    if (debug.enabled) {
      debug.log('chat.modal.requestRender', 'user-mutation', {
        force: true,
        painted,
      });
    }
    opts.modalSink?.requestRender?.({ force: true });
  };
  return { repaintHost, repaintUserMutation };
}

export {
  findReverseHistoryMatchIndices,
  resolveReverseHistorySearchResult,
  shouldPreferHistoryArrowNavigation,
  shouldSuppressSlashPickerAfterHistoryRecall,
} from './input-history-state.js';

/**
 * Start an animated spinner on a specific terminal row.
 * Uses Claude Code-style glyphs (· ✢ ✳ ✶ ✻ ✽) with stall detection.
 */
export function startSpinner(row: number, col: number, text: string): SpinnerHandle {
  const spinner = createSpinner(120);
  const loader = createToolLoader(500);
  let msg = text;
  let running = true;
  let lastTokenTime = Date.now();

  spinner.start();
  loader.start();

  const draw = () => {
    if (!running) return;
    const now = Date.now();
    const stalled = stalledIntensity(lastTokenTime, now);

    // Spinner glyph with stall-aware coloring
    let spinnerStr: string;
    if (stalled > 0) {
      const colorEsc = stalledColor('claude', stalled);
      spinnerStr = colorEsc ? `${colorEsc}${spinner.char()}\x1b[0m` : spinner.render('claude');
    } else {
      spinnerStr = spinner.render('claude');
    }

    // Blinking status circle
    const statusCircle = loader.render('running');

    writeTerminal(
      ansi.moveTo(row, col) +
      `${statusCircle} ${spinnerStr} ${C.muted(msg)}`
    );
  };

  const interval = setInterval(draw, 80);
  draw();

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
      spinner.stop();
      loader.stop();
      // Final state: green circle with tick
      writeTerminal(
        ansi.moveTo(row, col) +
        `${applyColor(FIGURES.BLACK_CIRCLE, 'success')} ${applyColor(FIGURES.TICK, 'success')} ${C.muted(msg)}`
      );
    },
    update: (t: string) => {
      msg = t;
      lastTokenTime = Date.now(); // Reset stall timer on update
    },
  };
}

// ── Slash command definition ──

export interface SlashCommand {
  name: string;        // e.g. 'quit'
  aliases?: string[];  // e.g. ['q', 'exit']
  description: string; // shown in picker
  /** First-positional-arg suggestions (static). E.g. /plugin → [list, activate, ...]. */
  subcommands?: string[];
}

// Default commands available in the input
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'directive', aliases: [], description: 'Record a directive as a Linear issue' },
  { name: 'run-skill', aliases: ['rs', 'run'], description: 'Execute a skill via its SKILL.md prompt' },
  { name: 'ad', aliases: [], description: 'Create an advertising plan from a URL, brief, or attached image' },
  // B4 — craft rulebook verdict, same resolution as `elanous repo design-check`
  //   and the PWA `/design-check` panel. Listed (not baselined as hidden) on
  //   purpose: a surface nobody can discover is not a surface.
  { name: 'design',    aliases: ['design-check'], description: 'Craft rulebooks — 이 저장소 DESIGN.md 가 선언한 규칙집 · 못 찾은 것 · elanous 가 주는데 선언 안 된 것. /design [--declared] · /design pick [번호|id] 디자인 방향 선택', subcommands: ['--declared', 'pick'] },
  { name: 'provider',  aliases: ['p'],          description: 'LLM providers — /provider (list) · next (cycle, also Alt+M / pill click) · use <name> · pick (visual picker) · reset', subcommands: ['next', 'use', 'pick', 'picker', 'menu', 'reset', 'list'] },
  { name: 'reasoning', aliases: ['r', 'think'],  description: 'Reasoning level (codex effort + summary, anthropic extended-thinking budget) — /reasoning [off|low|medium|high|xhigh] (cycle when no arg · xhigh 는 모델 상한이 xhigh 이상일 때만 wire 에 실린다, 아니면 high 로 깎인다)', subcommands: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { name: 'model',     aliases: ['m'],           description: 'Switch active model — /model <codex|terra|sol|luna|opus|sonnet|grok> (list + current when no arg). OpenAI 는 Codex(Responses API)만. effort 는 /reasoning.', subcommands: ['codex', 'terra', 'sol', 'luna', 'opus', 'sonnet', 'grok'] },
  { name: 'local',     aliases: ['ll'],         description: 'Local OpenAI-compatible LLM — ping / models / test / use', subcommands: ['ping', 'models', 'test', 'use', 'status'] },
  { name: 'session',   aliases: ['sess'],       description: 'Session resume — list / load / sync / new (handoff from mobile)', subcommands: ['list', 'load', 'sync', 'new'] },
  { name: 'resume',    aliases: [],             description: 'Resume session — 픽커에서 선택 · /resume <id-prefix> 즉시 로드 (TUI 부활 S-a)' },
  { name: 'fork',      aliases: [],             description: 'Fork — 현 시점 전체 복사로 새 세션 분기 (codex /fork 동형)' },
  { name: 'rewind',    aliases: [],             description: 'Rewind — 과거 user 턴 픽커로 되감기 (원본 보존 · 새 세션 분기 · /rewind <n> 숏컷)' },
  // TUI 부활 C-a (2026-07-12): autopilot 미션 TUI 표면 — CLI 동등 단일 창구 소비.
  { name: 'mission',   aliases: [],             description: 'Autopilot 미션 — list(+헬스) · trace <id> 계보 · arm <id> 승인 (구체화/종료는 CLI)', subcommands: ['list', 'trace', 'arm'] },
  { name: 'resume-turn', aliases: [],           description: 'Resume a paused turn checkpoint (/pause 짝 · 구 /resume)', subcommands: ['list'] },
  { name: 'context',   aliases: ['ctx'],        description: 'Show / clear / drop attached files', subcommands: ['clear', 'drop'] },
  { name: 'paste', aliases: [],             description: 'Attach clipboard image (macOS)' },
  { name: 'sync',  aliases: ['s'],         description: 'Enter sync mode' },
  { name: 'plugin', aliases: ['plugins'], description: 'Manage plugins', subcommands: ['list', 'activate', 'deactivate', 'reload'] },
  { name: 'widget', aliases: ['widgets'], description: 'Manage widgets', subcommands: ['list', 'reload', 'instances'] },
  { name: 'clear', aliases: ['cls'],       description: 'Clear chat log' },
  { name: 'log',   aliases: [],             description: 'Chat Log controls — size / clear / filter / search / freeze / solo / turn / fold / help', subcommands: ['size', 'clear', 'filter', 'search', 'freeze', 'solo', 'turn', 'fold', 'help'] },
  { name: 'help',  aliases: ['?'],         description: 'Show help overlay' },
  { name: 'setup', aliases: [], description: 'Onboarding wizard guide — /setup (anchor) · /setup reset (re-run wizard on next boot)', subcommands: ['help', 'reset'] },
  { name: 'memory', aliases: ['mem'], description: 'Memory ops — list / show / search / add / delete (see `elanous memory --help`)', subcommands: ['list', 'show', 'search', 'add', 'delete', 'index'] },
  { name: 'status', aliases: ['st'], description: 'Print the claude-code-style status pills (working dir + git + model)' },
  { name: 'export', aliases: [], description: 'Export this conversation transcript to a markdown file — /export [path] (default ~/temp/elanous-transcript-<stamp>.md)' },
  { name: 'delta', aliases: ['diffs'], description: 'Source delta browser — open the latest turn-scoped file diff popup', subcommands: ['open', 'help'] },
  { name: 'theme', aliases: [], description: 'Theme controls — list / switch / use / reset / preview / export', subcommands: ['list', 'switch', 'use', 'reset', 'preview', 'export'] },
  { name: 'debug', aliases: [], description: 'Runtime tracer + surfaces — /debug on (mirror+file) · off · file (quiet trail) · diag (loud trail) · render on|off (렌더 무음, 레벨과 직교); surfaces: window / popup / workbench / promote', subcommands: ['on', 'off', 'file', 'diag', 'mirror', 'verbose', 'render', 'level', 'toggle', 'tail', 'clear', 'path', 'view', 'status', 'window', 'popup', 'workbench'] },
  { name: 'rebind', aliases: [], description: 'Manage runtime input bindings — list / show / add / reset / export / import', subcommands: ['actions', 'reset', 'export', 'import', 'help'] },
  { name: 'api-allow', aliases: ['api'], description: 'api_call allowlist — add/remove/list hosts the model may call', subcommands: ['add', 'remove', 'list', 'clear'] },
  { name: 'prompt', aliases: ['prompts'], description: 'Prompt Bank — list / show / search / select / inject / explain / enable / disable / config', subcommands: ['list', 'show', 'search', 'select', 'inject', 'explain', 'enable', 'disable', 'config'] },
  { name: 'history', aliases: ['hist', 'inputs'], description: 'Input history — list / find / show / clear', subcommands: ['list', 'find', 'show', 'clear'] },
  { name: 'research', aliases: ['rsh'],    description: 'Autonomous research loop — start / status / stop / tail / replan (PFC-S4)', subcommands: ['start', 'status', 'stop', 'tail', 'replan'] },
  // /harness is the dashboard's sole harness-launching entry. Its first
  // positional token selects plan, ask, dev, goal, runs, stop, or memo;
  // otherwise the complete sentence follows the former /dev dispatch.
  { name: 'harness', aliases: [], description: 'Harness — /harness <goal> (self-dev) · plan <goal> · ask <sentence> · dev <goal> · goal <goal-file> · runs · stop <space-id> · memo <space-id> <note>', subcommands: ['plan', 'ask', 'dev', 'goal', 'runs', 'stop', 'memo'] },
  { name: 'plan',  aliases: [],            description: 'Toggle plan mode — read-only planning posture (slash alias for EnterPlanMode tool)', subcommands: ['enter', 'exit', 'status'] },
  { name: 'chat',  aliases: [],            description: 'Toggle LLM-only layout (hide 3-pane grid)' },
  { name: 'dashboard', aliases: ['dash'],  description: 'Return to 3-pane dashboard layout' },
  { name: 'telegram',  aliases: ['tg'],    description: 'Telegram bot — status / pair / send / pause / stop / attach / detach / sessions', subcommands: ['status', 'pair', 'setup', 'send', 'pause', 'stop', 'attach', 'detach', 'sessions'] },
  { name: 'tablet',    aliases: [],        description: 'Tablet mode — collapse layout to log + input', subcommands: ['on', 'off', 'toggle', 'auto', 'status', 'browser-preview', 'bp'] },
  { name: 'surface',   aliases: [], description: 'Surface control — open a pane/catalog launcher (/surface catalog · browser · preview · log · scratch · obsidian · skill) OR set a preferred LLM surface (/surface coding-agent · research-agent · control-agent · ops-agent · … · clear · status)', subcommands: ['catalog', 'browser', 'preview', 'browser-preview', 'log', 'scratch', 'obsidian', 'skill', 'skill-file', 'agents', 'coding-agent', 'coding-chat', 'research-agent', 'research-chat', 'control-agent', 'ops-ui-agent', 'ops-fleet-agent', 'ops-agent', 'clear', 'status'] },
  { name: 'term',  aliases: ['terminal'], description: 'Interactive terminal modal — spawn / list / attach / detach / switch / kill / snapshot / resume', subcommands: ['spawn', 'list', 'attach', 'detach', 'switch', 'kill', 'snapshot', 'resume'] },
  { name: 'claude', aliases: [], description: 'Spawn claude-code CLI in a terminal modal' },
  { name: 'codex',  aliases: [], description: 'Spawn codex CLI in a terminal modal' },
  { name: 'gemini', aliases: [], description: 'Spawn gemini CLI in a terminal modal' },
  { name: 'acp',    aliases: [], description: 'ACP chat — stream claude-code / codex / gemini replies into the chat pane (not a VW spawn). /acp codex points at the canonical codex app-server path; /acp cas is a synonym.', subcommands: ['claude', 'codex', 'gemini', 'cas', 'cancel', 'status', 'drop'] },
  { name: 'conv', aliases: [], description: 'Conversation widget/popup host — /conv list · /conv open <session-id> · /conv layout <cascade|tile|stack> · /conv focus <next|prev>.', subcommands: ['list', 'ls', 'open', 'layout', 'focus'] },
  { name: 'handoff', aliases: [], description: 'H5 P3 cross-agent context handoff: /handoff <from_session_id> <to_brand> [--channels r,p,m] [--prompt "prefix"]. Takes source session snapshot (filtered by channels if observer present) and launches target via adapter registry. Brands: codex · claude · claude-code · gemini · elanous.' },
  { name: 'remaining', aliases: [], description: '계정마다 행으로 「지금 쓸 수 있는 것이 얼마나 남았나」를 본다 — 크레딧 축과 구독 축을 갈라 낸다. 화면은 명령 산출을 그대로 읽는다.' },
  { name: 'agent-room', aliases: [], description: 'H6 P4 VW agent-room — /agent-room <N> <brands...> · /agent-room list · /agent-room close <id> · N ∈ {2,3,4} · brands: codex/claude/gemini/elanous/auto/lll:<m>', subcommands: ['list', 'close', 'preset', 'help'] },
  { name: 'showroom', aliases: ['sr'], description: 'Showroom v2 multi-LLM lane composer — /showroom (default 2-pane) · /showroom <lane1> <lane2> [<lane3> [<lane4>]] · lane = role:provider[:transport] · roles plan/build/exec/review/reflect · pair with /lane and /relay for cross-lane handoffs.', subcommands: ['help'] },
  { name: 'reply',   aliases: [], description: 'H6 P5 AgentReply — /reply <target-session-id> <message...> · send message to a live session, capture the response · flags: --from · --channels r,m · --idle-ms · --timeout-ms', subcommands: ['help'] },
  { name: 'capture',   aliases: [], description: 'H6 P6 capture source registry — /capture list · /capture snapshot <sourceId> · enumerate VW panes / agent sessions / browser CDP pages · dispatch text/ansi/png snapshot', subcommands: ['list', 'snapshot', 'help'] },
  { name: 'inject',    aliases: [], description: 'H6 P7 InjectCaptureToContext — /inject <sourceId> <targetId> · inject capture snapshot into target session · --as user-message|system-note|attached-block · HITL approver gated · non-revocable v1', subcommands: ['help'] },
  { name: 'relay',     aliases: [], description: 'Showroom v2 multi-lane handoff macros — /relay plan-build-review · /relay broadcast [--from <lane>] · /relay <from> -> <toA>,<toB> · HITL approver gates each step · failed steps non-aborting', subcommands: ['plan-build-review', 'broadcast', 'help'] },
  { name: 'lane',      aliases: [], description: 'Showroom v2 cross-lane context inject — /lane <from> <to> · address by pane index | role (plan/build/exec/review/reflect) | brand · --as user-message|system-note|attached-block · HITL approver gated · /lane list · /lane help', subcommands: ['list', 'help'] },
  { name: 'control', aliases: [],      description: 'Enter control mode — the LLM treats every message as a dashboard command. /control off to exit.' },
  { name: 'default', aliases: [],          description: 'Exit control mode back to default chat.' },
  // NOTE: the preferred-LLM-surface command (/surface coding-agent · … · clear · status)
  // shares the '/surface' name with the pane/catalog launcher above — both handlers
  // dispatch by argument (immediate slash-executor for panes, registry for LLM surfaces).
  // They are documented in the single merged '/surface' entry to keep names unique.
  { name: 'qc',      aliases: [],          description: 'Quick-control — arm one-shot control mode; next message runs as control, then auto-return to chat.' },
  { name: 'voice-chat', aliases: ['vc'], description: 'Continuous voice chat mode — speak, elanous replies in voice (Phase 4-5). Subcommands: start / stop / cancel / status. Chord: Alt+R toggles enter/exit anywhere.', subcommands: ['start', 'stop', 'cancel', 'status'] },
  { name: 'auto-tts', aliases: ['tts', 'autotts'], description: 'Auto-TTS for chat responses (Phase 2) — speaks LLM replies sentence-by-sentence. Subcommands: on / off / toggle / status.', subcommands: ['on', 'off', 'toggle', 'status'] },
  { name: 'quit',  aliases: ['q', 'exit'], description: 'Exit application' },
];

/** Every user-visible slash spelling, normalized for runtime-catalog comparison. */
export function displayedSlashCommandNames(commands: readonly SlashCommand[] = SLASH_COMMANDS): string[] {
  return commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

/** Score and rank slash commands against the user's typed text (sans leading `/`).
 *
 *  Exported as a pure function so tests can exercise the ranking without
 *  spinning up the full textInput TTY loop. Ranking rules:
 *    prefix-on-name         100
 *    prefix-on-alias         80
 *    substring-on-name       50
 *    word-start in desc      10  (regex \b<text>)
 *  Sort by score desc, then name asc. Empty text returns the input list
 *  unchanged. */
export function filterSlashCommands(text: string, commands: SlashCommand[]): SlashCommand[] {
  const q = text.toLowerCase();
  if (!q) return commands;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const descRe = new RegExp(`\\b${escaped}`, 'i');
  const scored: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    const aliases = (cmd.aliases ?? []).map(a => a.toLowerCase());
    let score = 0;
    if (name.startsWith(q)) score = 100;
    else if (aliases.some(a => a.startsWith(q))) score = 80;
    else if (name.includes(q)) score = 50;
    else if (descRe.test(cmd.description)) score = 10;
    if (score > 0) scored.push({ cmd, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.cmd.name.localeCompare(b.cmd.name);
  });
  return scored.map(s => s.cmd);
}

/** Candidate suggestion for argument autocomplete. */
export interface ArgSuggestion {
  value: string;
  description?: string;
}

/** One row in the `$` skill picker. Accepting a row rewrites the
 *  buffer to `/run-skill <name> ` so the existing slash executor path
 *  stays the single runtime contract. */
export interface SkillCandidate {
  name: string;
  description?: string;
}

/**
 * Host-provided dynamic completer for slash-command arguments.
 * Called with the resolved command name + any already-completed arg
 * words + the currently-typed (incomplete) arg. Returns an ordered
 * list of candidates; the picker filters by prefix of currentArg.
 */
export type GetArgSuggestions = (
  cmdName: string,
  priorArgs: string[],
  currentArg: string,
) => ArgSuggestion[] | Promise<ArgSuggestion[]>;

/** Host callback for the `$` picker. The host returns picker-ready
 *  skills in display order for the current typed prefix. */
export type GetSkillCandidates = (
  prefix: string,
) => SkillCandidate[] | Promise<SkillCandidate[]>;

/** One row in the `@`-mention picker. The host returns these in
 *  display order — the picker doesn't re-sort. `absPath` carries the
 *  resolved path so the host's onAtPick callback can hand it to its
 *  own attachment registry. */
export interface AtCandidate {
  /** Display label — typically `name` or `name/`. */
  label: string;
  /** Absolute path on disk — what `onAtPick` receives. */
  absPath: string;
  /** True when this entry is a directory; Tab descends into it
   *  instead of accepting it as a final selection. */
  isDir: boolean;
  /** Optional pre-colored ANSI icon glyph for the row. */
  icon?: string;
  /** Optional muted right-side hint (size, ext label, etc). */
  hint?: string;
}

/** Host callback that returns the candidate list for the given
 *  prefix. Prefix is whatever the user typed after `@`, so for
 *  `@foo/bar` the host typically lists entries inside `cwd/foo/`
 *  matching `bar*`. Returning [] suppresses the picker. */
export type GetAtCandidates = (prefix: string) => AtCandidate[] | Promise<AtCandidate[]>;

/** Called when the user accepts a file candidate (Enter, or Tab on a
 *  non-directory). The host typically registers the path as an
 *  attachment and returns the token text (e.g. `[PDF #3] `) that
 *  textInput will splice into the buffer in place of `@<prefix>`.
 *  Returning the absolute path (or the bare filename) is also fine —
 *  textInput just inserts whatever string comes back. */
export type OnAtPick = (absPath: string) => string | Promise<string>;

/** Arc C · v2 — fires when the user explicitly attaches a folder from
 *  the `@` picker via Ctrl+I (the "escalate to attach" override).
 *  Host typically opens createFolderPickerModal, lets the user select
 *  one file inside, routes that file through the same attachment
 *  pipeline as onAtPick, and returns the resulting token string for
 *  textInput to splice in place of `@<prefix>`. Returning an empty
 *  string cancels the splice — the picker leaves the buffer intact.
 *
 *  Plain Enter on a folder does NOT call this — picker-state handles
 *  that internally by splicing `@<label> ` (trailing space, picker
 *  auto-exits) as a plain-text reference. The split is the whole
 *  point of v2: Enter = reference, Ctrl+I = attach. */
export type OnAtFolderAttach = (absPath: string) => string | Promise<string>;

/** Called after the input atomically deletes an attachment token via
 *  Backspace. `token` is the raw bracket form (e.g. `[Md #1]`), and
 *  `stillReferenced` is true when the same token still appears
 *  elsewhere in the buffer — the host uses that to decide whether to
 *  drop the attachment from its registry + clear the related log
 *  lines, or keep it because other references survive. */
export type OnTokenDeleted = (token: string, stillReferenced: boolean) => void;

// ── Multiline text input with cursor + slash command autocomplete ──

export interface InputResult {
  text: string;
  submitted: boolean; // true=Enter, false=Escape
  externalSubmitSource?: InputSourceRef;
  /** Why a non-submitted input ended. Currently only Escape is
   *  surfaced because control mode treats it as "exit
   *  control" while Ctrl+M / Ctrl+S keep their own dedicated flags. */
  cancelledBy?: 'escape';
  /** Set when the user pressed the "go to pane" chord (Ctrl+M) from
   *  inside the input. The host treats this like an Escape but also
   *  knows to restore focus to a non-input pane (last visited or
   *  view default) instead of staying in input. The chord also
   *  accepts Ctrl+ㅡ so it works while a Korean IME is active. */
  gotoPane?: boolean;
  /** Set to the digit string ('1'..'9') when the user pressed
   *  Ctrl+<digit> from the input. The host looks up the view by
   *  `shortcut` field and re-enters textInput on the next iteration
   *  so the user can keep typing. Distinct from gotoPane —
   *  viewSwitch keeps the user in input mode. */
  viewSwitch?: string;
  /** Set when the user pressed Ctrl+S (or its Korean alias Ctrl+ㄴ).
   *  Distinct from `submitted` so the host can implement "save
   *  draft" / "commit memo" flows where Ctrl+S means "persist
   *  what's in the buffer" but Enter would mean "send to LLM" or
   *  similar. textInput itself doesn't act on the chord beyond
   *  returning — the host decides. */
  saved?: boolean;
}

export interface TextInputExternalSubmitRequest {
  text?: string;
  source?: InputSourceRef;
}

/**
 * Multiline inline text input with Claude Code-style slash command picker.
 * When text starts with `/`, shows filtered command dropdown above input.
 * Enter submits, Shift+Enter (or Alt+Enter / Ctrl+J) inserts newline.
 * Escape cancels. Up/Down navigate commands or lines.
 */
export async function textInput(opts: {
  row: number;
  getRow?: () => number;
  col: number;
  width: number;
  maxLines?: number;
  prompt?: string;
  placeholder?: string;
  commands?: SlashCommand[];
  initialText?: string;
  history?: string[];
  /** Quick slash-entry mode wants history ↑/↓ to win over the slash picker
   *  so the user can keep walking older command history even when the
   *  loaded line starts with `/`. */
  preferHistoryArrowKeys?: boolean;
  /**
   * Ctrl+Shift+V handler. When the user presses the chord, the input calls
   * this and inserts the returned string at the cursor. The caller is
   * expected to perform the actual clipboard read + registration in its own
   * scope (e.g. dashboard's contextRegistry). Returning null leaves the
   * buffer untouched. Any exception is swallowed so a hiccup doesn't
   * abort the input session.
   */
  onPasteImage?: () => Promise<string | null>;
  /** Dynamic completer for arg-level suggestions (e.g. plugin names). */
  getArgSuggestions?: GetArgSuggestions;
  /** Dynamic completer for `$` skill invocations. */
  getSkillCandidates?: GetSkillCandidates;
  /** Copy the most recent log block from inside input mode. Fires on
   *  Ctrl+Y — mirrors the `y` key in log focus, without needing to
   *  leave the prompt. Host owns the clipboard write + status line. */
  onCopyLastBlock?: () => void | Promise<void>;
  /** Bracketed-paste handler. textInput collects everything between
   *  paste-start and paste-end markers into a single string and hands
   *  it off here — the host can tokenize file paths to attachment tags
   *  ([PDF #1], [Image #3], …) and return the final insert text. When
   *  omitted, the raw paste body is inserted literally. Mirrors the
   *  `onImagePaste` pattern in claude-code-fork's PromptInput. */
  onPaste?: (text: string) => string | Promise<string>;
  /** Optional key source for embedded hosts and deterministic input tests. */
  readKey?: () => Promise<Key>;
  /** Mouse event pass-through. textInput normally swallows mouse events
   *  silently. When this is provided, the input delegates every mouse
   *  event to the host so it can scroll the log / switch focus while
   *  typing. The host is expected to mutate its own state; the input
   *  redraws the bar + picker on top afterward. */
  onMouse?: (mouse: { row: number; col: number; type: 'click' | 'double-click' | 'right-click' | 'scroll-up' | 'scroll-down' | 'drag' | 'release'; shift?: boolean }) => void | boolean | Promise<void | boolean>;
  /** MX11b — key interceptor called BEFORE textInput's own key
   *  handling. Host returns 'consumed' to short-circuit the event
   *  (no further input processing), 'passthrough' to let the default
   *  input handling proceed. Used to let an active status-bar pill
   *  popup swallow Enter/Esc/arrows before the prompt sees them.
   *
   *  IDX-F2.5 — may return a Promise so the host can route the key
   *  through `coordinator.tryRouteKeyToTopModalAsync`, which awaits
   *  the async `onKey` of the chat picker (picker.dispatch hits the
   *  filesystem for at-picker). textInput awaits the return. */
  onPreKey?: (key: import('../tui.js').Key) =>
    | 'consumed' | 'passthrough'
    | Promise<'consumed' | 'passthrough'>;
  /** A-5b.2 — dispatcher-level key hook. Runs AFTER `onPreKey`
   *  (modal/picker routing) but BEFORE every textInput-specific
   *  handler (paste · mouse · Ctrl+Y / Ctrl+G / Enter · ESC / chars).
   *  Host routes the key through `routeInputEventAsync` with
   *  `ViewMode={kind:'input'}` so:
   *    • A-8 ESC guard fires when a drag session is active.
   *    • Future widget-focus / global key bindings activate without
   *      needing dedicated textInput hooks.
   *  Returns `'consumed'` to short-circuit the readKey iteration
   *  (textInput stays in the loop, draws, and awaits the next key);
   *  `'passthrough'` to let textInput's buffer / specialized handlers
   *  proceed. Omit to disable (legacy behaviour preserved). */
  onKey?: (key: import('../tui.js').Key) =>
    | 'consumed' | 'passthrough'
    | Promise<'consumed' | 'passthrough'>;
  /** Provide candidate file/directory entries for the `@`-mention
   *  picker. Called with whatever the user has typed after `@` (may
   *  include subpath fragments like `foo/ba`). Host decides what
   *  base directory to scan and how to filter; textInput just
   *  renders + drives selection. Omit to disable the picker. */
  onAtCandidates?: GetAtCandidates;
  /** Resolve a picked file into the text textInput should splice
   *  into the buffer in place of `@<prefix>`. Typically used to
   *  register the file as an attachment and return its token tag
   *  ([PDF #N], [Text #N], …). Required when onAtCandidates is set;
   *  without it the picker is read-only. */
  onAtPick?: OnAtPick;
  /** Arc C · v2 — Ctrl+I on a folder in the `@` picker: host opens
   *  a folder-scoped selection modal, awaits the user's file pick,
   *  and resolves with the attachment token that picker-state splices
   *  in place of `@<prefix>`. Empty string = user cancelled. Omit to
   *  fall back to plain-Enter folder splice (`@<label> ` reference). */
  onAtFolderAttach?: OnAtFolderAttach;
  /** Notify the host when the user backspaces an attachment token.
   *  textInput passes the deleted token tag plus whether the same
   *  tag still appears anywhere in the buffer — false means the host
   *  can safely drop the attachment from its registry + clean up
   *  any UI that still references it (like log summary lines). */
  onTokenDeleted?: OnTokenDeleted;
  /** Invoked when the user presses Escape. Return `true` to signal
   *  "I consumed it" — textInput then stays in the input loop instead
   *  of cancelling. Used by the host to dismiss transient overlays
   *  (image preview modal, etc.) without exiting the prompt. Return
   *  `false` / omit to fall through to the default cancel behavior.
   *  TUI 부활 후속 (2026-07-12): 현재 버퍼 텍스트가 인자로 전달된다 —
   *  dashboard 의 Esc·Esc `/rewind` 제스처가 "빈 버퍼일 때만 prime"
   *  (codex backtrack 동형) 을 판정하는 데 쓴다. 기존 호출자 무영향. */
  onEscape?: (bufferText?: string) => boolean;
  /** Mutable handle the input populates so the host can ask textInput
   *  to re-paint its prompt + picker. The host calls
   *  `controlOut.repaint()` after any external screen rewrite (a
   *  scratchpad refresh, an async image render finishing, etc.) so the
   *  prompt row doesn't end up blanked under the cursor. textInput
   *  resets the handle to a no-op when it returns so callers can leave
   *  the same struct in a long-lived closure. */
  controlOut?: {
    repaint: () => void;
    /** Arc C · v2 — splice text at the current cursor. Hosts that
     *  open external modals (e.g. the folder picker from Browser
     *  dblclick) feed the resulting attachment token back into the
     *  live input buffer via this hook so it appears just like a
     *  token inserted via `@` picker. textInput populates this when
     *  it enters the loop and resets it to a no-op on return, so
     *  callers holding a long-lived handle get a safe no-op when
     *  input is idle. */
    insertAtCursor?: (text: string) => void;
  };
  /** P2.2.c — sink for cursor placement. When supplied, drawInput
   *  routes its caret-position decision through this instead of
   *  emitting `\\x1b[r;cH` directly. The coordinator owns the
   *  ANSI emit (single source of truth, frame-end ordering, foundation
   *  for modal cursor ownership in P2.3). When omitted, falls back
   *  to direct stdout write (legacy behaviour preserved for tests
   *  + non-coordinator callers). */
  cursorSink?: CursorSink;
  /** Optional ownership gate. When false, the chat-main surface may
   *  remain visible but it must not actively claim the terminal
   *  cursor. Used when another workspace owns the foreground input
   *  while the shared host input rows are still visible. */
  canClaimCursor?: () => boolean;
  /** P2.3.b — sink for the slash-picker modal. When supplied, the
   *  picker registers as a coordinator-owned modal (lifecycle +
   *  render via writeOverlay) instead of writing rows directly to
   *  stdout. When omitted, falls back to legacy direct-paint mode. */
  modalSink?: ModalSink;
  /** Optional ownership gate for picker modal sync. When false, the
   *  main chat surface stays visually present but must not keep
   *  re-syncing slash/arg/@/skill picker overlays while another
   *  workspace owns interactive input. */
  shouldSyncPickers?: () => boolean;
  /** Fires when the number of visible input lines changes (1 → 2 on
   *  Shift+Enter, 2 → 1 on delete, etc.). Hosts use this to grow/
   *  shrink the reserved row budget for the input zone so log rows
   *  don't get clipped by multi-line input. Called with the current
   *  visible-line count, clamped to maxLines. */
  onLinesChange?: (visibleLines: number) => void;
  /** Live log-pane resize from inside input. Ctrl+Up grows the log
   *  (delta=+1), Ctrl+Down shrinks it (delta=-1), Ctrl+0 resets
   *  (delta=0 with reset=true). The host should bump its
   *  logHeightBias and redraw — textInput repaints its prompt
   *  afterward via the same controlOut.repaint() path used for
   *  multi-line growth. */
  onLogResize?: (delta: number, reset?: boolean) => void;
  /** Restore layout-owned frame chrome adjacent to the input before
   *  the prompt repaints itself. Typical use: redraw the divider rows
   *  immediately above/below the live input block so host repaints and
   *  direct prompt paints share one ownership path. */
  onPaintChrome?: () => void;
  /** Suppress all direct prompt/picker repaint work when the input is
   *  backgrounded by a foreground blocking modal. The input loop stays
   *  alive, but it no longer writes terminal rows until the host says
   *  painting is allowed again. */
  shouldPaint?: () => boolean;
  /** Global "jump focus to the log pane" shortcut. Bound to Ctrl+G
   *  inside textInput so the user can leave the prompt and land on
   *  the log without having to escape first. The host should set
   *  its own focus state and redraw; textInput then exits the input
   *  loop via the same path as `gotoPane`. When omitted, Ctrl+G is
   *  not intercepted. */
  onGotoLog?: () => void;
  /** Tmux-style zoom — toggle a "log dominates the viewport" mode
   *  (chat-only). Bound to Ctrl+B then z (chord) + Ctrl+Shift+Up/Down
   *  for ±5-row fast resize. Host owns the toggle + redraw. */
  onLogZoomToggle?: () => void;
  /** Global "spawn modal terminal" shortcut. Bound to Ctrl+Shift+T
   *  inside textInput so the user can open a new terminal without
   *  leaving the prompt. Host spawns the session + toggles the
   *  terminal modal router; textInput just triggers. When omitted,
   *  Ctrl+Shift+T is not intercepted in input mode. */
  onSpawnTerminalModal?: () => void;
  /** Global "copy log pane contents to clipboard" shortcut. Bound
   *  to Ctrl+Shift+L inside textInput so users can yank the full
   *  log buffer from any focus state. Host owns the clipboard
   *  write + status line. When omitted, Ctrl+Shift+L is not
   *  intercepted in input mode. */
  onCopyLogPane?: () => void | Promise<void>;
  /** Optional grouped host contract. Preferred for new callers that
   *  want to treat textInput as a surface with a narrow host-owned
   *  side-effect boundary instead of a flat callback bag. Legacy
   *  fields above remain supported for compatibility/tests. */
  host?: TextInputHost;
}): Promise<InputResult> {
  const { row: initialRow, col, width, maxLines = 5, prompt = '\u276f ', placeholder = '' } = opts;
  const getRow = (): number => opts.getRow?.() ?? initialRow;
  const row = getRow();
  // P2.1: report the input's top row so writeTerminal scopes its
  // frame-cache invalidation to this zone instead of nuking the
  // entire cache on every key press. When textInput returns, the
  // caller restores the row to -1 (see finally block below).
  setInputPromptStartRow(row);
  const commands = opts.commands ?? SLASH_COMMANDS;
  const history = opts.history ?? [];
  let lines: string[] = [opts.initialText ?? ''];
  // Line-count reporting: only fires when the visible count actually
  // changes, so hosts don't re-render on every keystroke.
  const resolvedHost = resolveTextInputHost(opts);
  const hostControl = resolvedHost.control;
  const onLinesChangeHandler = resolvedHost.onLinesChange;
  const dispatchGlobalAction = resolvedHost.dispatchGlobalAction;
  let lastReportedLines = -1;
  let lineIdx = 0;   // current line
  let colIdx = lines[0]!.length;  // cursor at end of initial text

  // KX2 — picker selection / navigation / async fetch caches live in
  // the shared state machine (chat-picker-state.ts). textInput keeps
  // the buffer (lines/lineIdx/colIdx) and delegates mode detection +
  // dispatch to the state.
  const picker = createPickerState({
    commands,
    getArgSuggestions: opts.getArgSuggestions,
    getSkillCandidates: opts.getSkillCandidates,
    onAtCandidates: opts.onAtCandidates,
    onAtPick: opts.onAtPick,
    onAtFolderAttach: opts.onAtFolderAttach,
  });
  const bufView = (): PickerBufferView => ({ lines, lineIdx, colIdx });
  const slashPickerModalId = `chat:slash-picker:${Date.now().toString(36)}`;
  const argPickerModalId = `chat:arg-picker:${Date.now().toString(36)}`;
  const atPickerModalId  = `chat:at-picker:${Date.now().toString(36)}`;
  const skillPickerModalId = `chat:skill-picker:${Date.now().toString(36)}`;
  const MAX_PICKER = 6;  // max visible items

  /** IDX-F2.5 — when picker.onKey decides a key produces a submit,
   *  it can't return from textInput itself (closure scope). Instead
   *  it parks the text here; the main loop consumes the signal at
   *  the top of the next iteration and returns the submit outcome. */
  let pendingSubmit: string | null = null;

  /** IDX-F2.5 — shared picker onKey closure. The coordinator's async
   *  routing path (routeSurfaceKeyAsync) awaits this, and the same
   *  `picker.refresh` + `picker.dispatch` + buffer-mutation logic the
   *  modal picker path uses runs inline. On a submit,
   *  park the text in `pendingSubmit`; the main loop picks it up on
   *  the next iteration and returns the submit outcome.
   *
   *  Labeled per picker (slash/arg/at) so debug.log 'chat.picker.dispatch'
   *  entries identify which path invoked dispatch. The slash/arg
   *  pickers run sync under the hood; the at picker hits the
   *  filesystem so dispatch is genuinely async. The closure itself
   *  is uniformly async to satisfy the surface contract. */
  /** F-E — shared handler for a picker DispatchResult. Splice / submit
   *  payloads produced by either keyboard (makePickerOnKey) or mouse
   *  (makePickerOnRowClick) dispatchers feed through here so the
   *  buffer mutation + pendingSubmit + drawAll triplet stays in one
   *  place. Returns whether the result was consumed so the caller
   *  can decide its surface-level return. */
  const processPickerDispatch = async (
    dispatched: Awaited<ReturnType<typeof picker.dispatch>>,
  ): Promise<boolean> => {
    if (!dispatched.consumed) return false;
    const a = dispatched.action;
    if (a) {
      if (a.kind === 'splice') {
        const line = lines[a.lineIdx] ?? '';
        lines[a.lineIdx] = line.slice(0, a.start) + a.text + line.slice(a.end);
        lineIdx = a.lineIdx;
        colIdx = a.newColIdx;
        await picker.refresh(bufView());
      } else if (a.kind === 'submit') {
        pendingSubmit = a.text;
      }
    }
    drawAll();
    return true;
  };

  const pickerModalRuntime = createChatPickerModalRuntime({
    modalSink: opts.modalSink,
    picker,
    getBufferView: bufView,
    writeTerminal,
    getBounds: () => ({ row: getRow(), col, width, height: 1 }),
    getInputZoneHeight: () => Math.min(lines.length, maxLines),
    onDispatchResult: async (dispatched) => processPickerDispatch(dispatched),
  });
  // History navigation state
  let historyIdx = -1;        // -1 = current input, 0 = most recent, 1 = older...
  let savedCurrentInput = ''; // save current input when navigating history
  let suppressSlashPickerFromHistoryRecall = false;
  let reverseSearch = inactiveReverseHistorySearchState();

  const currentReverseSearchResult = (): string | null =>
    resolveCurrentReverseHistorySearchResult(reverseSearch, history);

  const onUserBufferEdit = (): void => {
    suppressSlashPickerFromHistoryRecall = false;
    picker.onBufferEdit();
  };
  const bufferState = () => ({ lines, lineIdx, colIdx });
  const historyState = (): TextInputHistoryState => ({
    lines,
    lineIdx,
    colIdx,
    historyIdx,
    savedCurrentInput,
  });
  const applyBufferState = (next: { lines: string[]; lineIdx: number; colIdx: number }): void => {
    lines = next.lines;
    lineIdx = next.lineIdx;
    colIdx = next.colIdx;
  };
  const applyHistoryState = (next: TextInputHistoryState): void => {
    lines = next.lines;
    lineIdx = next.lineIdx;
    colIdx = next.colIdx;
    historyIdx = next.historyIdx;
    savedCurrentInput = next.savedCurrentInput;
  };
  const currentLineEditorState = () => currentLineEditorStateFromBuffer(bufferState());
  const applyCurrentLineEditorState = (next: { text: string; cursor: number }): void => {
    applyBufferState(applyCurrentLineEditorStateToBuffer(bufferState(), next));
  };
  const multilineEditorState = () => multilineEditorStateFromBuffer(bufferState());
  const applyMultilineEditorState = (next: { lines: string[]; line: number; col: number }): void => {
    applyBufferState(applyMultilineEditorStateToBuffer(next));
  };

  const onHistoryRecall = (): void => {
    suppressSlashPickerFromHistoryRecall = true;
    picker.onBufferEdit();
  };

  const isSlashPickerSuppressed = (): boolean =>
    shouldSuppressSlashPickerAfterHistoryRecall({
      suppressedByHistoryRecall: suppressSlashPickerFromHistoryRecall,
      linesLength: lines.length,
      currentLine: lines[0] ?? '',
    });
  const refreshPickerAndDraw = async (): Promise<void> => {
    // Keep picker items in sync with the post-mutation buffer before
    // repainting the prompt. Without this tail refresh, arg/@ picker
    // lists can lag one keystroke behind visible text.
    await picker.refresh(bufView());
    drawAll();
  };
  const runInputLoopPickerPrelude = async (key: Key): Promise<boolean> => {
    const preferHistoryArrowNavigation = shouldPreferHistoryArrowNavigation({
      preferHistoryArrowKeys: opts.preferHistoryArrowKeys,
      linesLength: lines.length,
      historyLength: history.length,
      historyIdx,
      keyName: key.name,
      currentLine: lines[0] ?? '',
    });
    if (preferHistoryArrowNavigation) {
      applyHistoryState(navigateSingleLineHistory(
        historyState(),
        history,
        key.name === 'up' ? 'older' : 'newer',
      ));
      onHistoryRecall();
      drawAll();
      return true;
    }
    if (isSlashPickerSuppressed()) {
      await picker.refresh(bufView());
      return false;
    }
    return await pickerModalRuntime.dispatchKey({ key, source: 'input-loop', label: 'main' });
  };
  const cancelReverseHistorySearch = (state = reverseSearch): void => {
    const cancelled = cancelReverseHistorySearchState(state, historyState());
    applyHistoryState(cancelled.input);
    reverseSearch = cancelled.search;
  };

  const acceptReverseHistorySearch = (): boolean => {
    const accepted = acceptReverseHistorySearchState(reverseSearch, history, historyState());
    if (!accepted.accepted) return false;
    applyHistoryState(accepted.input);
    onUserBufferEdit();
    reverseSearch = accepted.search;
    return true;
  };

  // Show cursor + enable Kitty keyboard protocol for Shift+Enter detection
  const cursorBootstrap = beginTextInputCursor(opts.cursorSink);
  if (debug.enabled) {
    debug.log('input.cursor.bootstrap', 'begin', {
      hasCursorSink: !!opts.cursorSink,
      row,
      col,
      width,
      maxLines,
      initialTextLength: opts.initialText?.length ?? 0,
    });
  }
  writeTerminal(cursorBootstrap);

  // KX2 — mode / filter queries now go through the shared picker state.
  // These thin wrappers keep the modal chooser contract readable at the
  // call site; callers can eventually inline `picker.mode(bufView())`.
  const isSlashMode  = (): boolean => !isSlashPickerSuppressed() && picker.mode(bufView()) === 'slash';
  const isArgMode    = (): boolean => picker.mode(bufView()) === 'arg';
  const isAtMode     = (): boolean => picker.mode(bufView()) === 'at';
  const isSkillMode  = (): boolean => picker.mode(bufView()) === 'skill';
  const getFilteredCommands = (): SlashCommand[] => picker.slashFiltered(bufView());

  /** Retire any mounted picker modal. Modal runtime owns the clear contract. */
  const clearPicker = () => {
    pickerModalRuntime.clearAll();
  };

  // Track how many rows drawInput painted last time so we can clear
  // exactly those rows (no more, no less) on the next draw. Without
  // this, iterating `for i = 0..maxLines` and clearing each row would
  // wipe decorations the host drew ABOVE the input (e.g. an hLine
  // divider at row `row - (numLines)` when numLines < maxLines).
  let prevDrawnLines = 0;

  const drawInput = () => {
    const row = getRow();
    setInputPromptStartRow(row);
    const promptStr = C.accent(prompt);
    const promptW = visibleWidth(prompt);
    const textW = width - promptW - 1;
    const numLines = lines.length;
    // Visible window: at most `maxLines` rows on screen, but the buffer
    // (`lines`) may exceed that. `firstVisibleIdx` keeps the cursor's
    // line inside the window — pinned to the bottom row when cursor is
    // at/near the end of the buffer; otherwise scrolls just enough to
    // keep `lineIdx` visible. Without this, a paste taller than
    // `maxLines` left bottom lines rendered nowhere and the cursor
    // stuck on the bottom visible row, so backspace looked broken.
    const visibleLines = Math.min(numLines, maxLines);
    const firstVisibleIdx = firstVisibleInputLineIdx(numLines, visibleLines, lineIdx);
    const rowsToTouch = Math.max(visibleLines, prevDrawnLines);

    // Reserve the expanded input rows before painting them. The dashboard
    // host redraws its frame when this count changes; notifying after the
    // input paint lets that redraw overwrite the newly added top lines.
    if (onLinesChangeHandler && visibleLines !== lastReportedLines) {
      lastReportedLines = visibleLines;
      onLinesChangeHandler(visibleLines);
    }

    if (debug.enabled) {
      debug.log('chat.input.scroll', 'compute', {
        numLines,
        maxLines,
        visibleLines,
        lineIdx,
        firstVisibleIdx,
        lastVisibleIdx: firstVisibleIdx + visibleLines - 1,
      });
    }

    // Row layout: input's BOTTOM line is always `row`. It grows upward
    // from there as lines accumulate. `startOffset` is how many rows
    // up from `row` we start touching — zero when both current and
    // previous drew only one line.
    for (let i = 0; i < rowsToTouch; i++) {
      const r = row - i; // i=0 → bottom row; i=1 → one row up; etc.
      if (r < 1) continue;

      if (i < visibleLines) {
        const lineIdxInArray = firstVisibleIdx + (visibleLines - 1 - i);
        const lineContent = lines[lineIdxInArray]!;
        const pfx = lineIdxInArray === 0 ? promptStr : C.muted('  ' + '\u00B7' + ' ');
        const display = lineIdxInArray === 0 && numLines === 1 && !lineContent
          ? truncate(C.muted(placeholder), Math.max(0, textW))
          : inputLineWindow(
            lineContent,
            lineIdxInArray === lineIdx ? colIdx : lineContent.length,
            textW,
          ).display;

        const padded = display + ' '.repeat(Math.max(0, textW - visibleWidth(display)));
        writeTerminal(ansi.moveTo(r, col) + '\x1b[2K' + pfx + padded);
      } else {
        // This row had content on the previous paint but doesn't anymore
        // (user deleted a line / shrank the input). Clear it so stale
        // text doesn't linger on what is now part of the log / divider
        // zone above.
        writeTerminal(ansi.moveTo(r, col) + '\x1b[2K');
      }
    }
    prevDrawnLines = visibleLines;

    // Cursor — its buffer line is `lineIdx`; its screen row is the
    // bottom-anchored offset within the visible window. Critically,
    // `textBeforeCursor` reads from `lines[lineIdx]` (the buffer), not
    // from the clamped on-screen row — otherwise the cursor X would be
    // computed from a different line than the one being edited.
    const cursorScreenLine = Math.max(
      0,
      Math.min(lineIdx - firstVisibleIdx, visibleLines - 1),
    );
    const curR = row - (visibleLines - 1 - cursorScreenLine);
    const pfxW = lineIdx === 0 ? visibleWidth(prompt) : 4;
    const { cursorCol } = inputLineWindow(lines[lineIdx]!, colIdx, textW);
    const curX = col + pfxW + cursorCol;
    // P2.2.c — coordinator owns the cursor emit when wired; falls
    // back to direct stdout for non-coordinator callers (tests, non-dashboard
    // entry points) so the change is non-breaking.
    if (curR >= 1) {
      const mayClaimCursor = opts.canClaimCursor?.() ?? true;
      if (opts.cursorSink && mayClaimCursor) {
        if (debug.enabled) {
          debug.log('input.cursor.claim', 'chat-main', {
            row: curR,
            col: curX,
            visible: true,
            lineIdx,
            colIdx,
            visibleLines,
            firstVisibleIdx,
            cursorScreenLine,
            hasCursorSink: true,
          });
        }
        opts.cursorSink.setCursor({ row: curR, col: curX, visible: true });
      } else if (opts.cursorSink && debug.enabled && !mayClaimCursor) {
        debug.log('input.cursor.claim', 'chat-main.skipped', {
          row: curR,
          col: curX,
          reason: 'ownership-gate',
        });
      } else if (!opts.cursorSink) {
        writeTerminal(paintCursorMove(curR, curX));
      }
    }

  };

  const pickerModalFamily = pickerModalRuntime.createFamily({
    bounds: { row: getRow(), col, width, height: 1 },
    sources: createChatPickerFamilySources({
      // 명시 K — createChatPickerFamilySource<K> 의 K 를 pin. getItems 반환이
      // conditional 타입 ChatPickerItems<K> 라 역추론이 K 를 union(ChatPickerKind)
      // 으로 잘못 잡아 각 key 에 union 이 할당되던 tsc 부채 수복(2026-07-17).
      slash: createChatPickerFamilySource<'slash'>(slashPickerModalId, getFilteredCommands),
      arg: createChatPickerFamilySource<'arg'>(argPickerModalId, () => picker.argItems()),
      at: createChatPickerFamilySource<'at'>(atPickerModalId, () => picker.atItems()),
      skill: createChatPickerFamilySource<'skill'>(skillPickerModalId, () => picker.skillItems()),
    }),
    maxVisible: MAX_PICKER,
  });

  const activePickerKind = (): ChatPickerKind | null => {
    if (isAtMode()) return 'at';
    if (isSkillMode()) return 'skill';
    if (isArgMode()) return 'arg';
    if (isSlashMode()) return 'slash';
    return null;
  };

  const syncActivePickerModal = (): void => {
    if (opts.shouldSyncPickers?.() === false) {
      if (debug.enabled) {
        debug.log('chat.picker.sync', 'chat-main.skipped', {
          reason: 'ownership-gate',
        });
      }
      pickerModalRuntime.clearAll();
      return;
    }
    pickerModalRuntime.syncFamily({
      activeKind: activePickerKind(),
      clearRows: MAX_PICKER + 3,
      debugLayout: { row, col, width },
      family: pickerModalFamily,
    });
  };

  const drawReverseHistorySearch = () => {
    const row = getRow();
    setInputPromptStartRow(row);
    const visibleLines = 1;
    const rowsToTouch = Math.max(visibleLines, prevDrawnLines);
    const searchRow = row;
    const promptStr = C.accent(prompt);
    const promptW = visibleWidth(prompt);
    const textW = width - promptW - 1;
    const match = currentReverseSearchResult();
    const status = match ? 'reverse-i-search' : 'failed reverse-i-search';
    const prefixRaw = `(${status})\`${reverseSearch.query}': `;
    const prefix =
      visibleWidth(prefixRaw) > textW
        ? prefixRaw.slice(prefixRaw.length - textW)
        : prefixRaw;
    const remainingW = Math.max(0, textW - visibleWidth(prefix));
    const resultRaw = match ?? '';
    const result =
      visibleWidth(resultRaw) > remainingW
        ? resultRaw.slice(0, Math.max(0, remainingW - 1)) + (remainingW > 0 ? '\u2026' : '')
        : resultRaw;
    const display = prefix + result;
    const padded = display + ' '.repeat(Math.max(0, textW - visibleWidth(display)));

    for (let i = 0; i < rowsToTouch; i++) {
      const r = row - i;
      if (r < 1) continue;
      if (i === 0) {
        writeTerminal(ansi.moveTo(searchRow, col) + '\x1b[2K' + promptStr + padded);
      } else {
        writeTerminal(ansi.moveTo(r, col) + '\x1b[2K');
      }
    }
    prevDrawnLines = visibleLines;

    const curR = searchRow;
    const curX = col + promptW + visibleWidth(prefix);
    if (opts.cursorSink && (opts.canClaimCursor?.() ?? true)) {
      opts.cursorSink.setCursor({ row: curR, col: curX, visible: true });
    } else if (!opts.cursorSink) {
      writeTerminal(paintCursorMove(curR, curX));
    }
    if (onLinesChangeHandler && visibleLines !== lastReportedLines) {
      lastReportedLines = visibleLines;
      onLinesChangeHandler(visibleLines);
    }
  };

  /** F-E2 fix — split prompt repaint into a host-safe pure repaint and
   *  a user-mutation repaint that also refreshes mounted picker modals.
   *
   *  Why the split: dashboard's coordinator invokes
   *  `afterRender → repaintPromptAfterRender → promptCtl.repaint()`
   *  on every flush. promptCtl.repaint is wired below to our inner
   *  paint function. Routing that through the user-mutation wrapper's
   *  `requestRender({force:true})` created an infinite flush loop
   *  (flush → afterRender → drawAll → requestRender → schedule next
   *  flush → …) — the user-reported ~48Hz flicker with the picker
   *  open. External render callers (afterRender hook) use
   *  `repaintHost`; chat's main readKey loop + pickerOnRowClick use
   *  `repaintUserMutation` where we WANT a render request because the
   *  buffer / picker state actually mutated. */
  const repaintPure = () => {
    if (reverseSearch.active) {
      clearPicker();
      drawReverseHistorySearch();
      return;
    }
    syncActivePickerModal();
    drawInput();
  };
  const renderActions = createTextInputRenderActions({
    shouldPaint: opts.shouldPaint,
    paintChrome: opts.onPaintChrome,
    paint: repaintPure,
    beforePaint: () => {
      const chunk = hideTextInputCursor(opts.cursorSink);
      if (chunk) writeTerminal(chunk);
      else if (opts.cursorSink) writeTerminal(paintCursorVisibility(false));
    },
    modalSink: opts.modalSink,
    shouldRequestModalRender: () => isAtMode() || isSkillMode() || isArgMode() || isSlashMode(),
  });
  const drawAllInner = renderActions.repaintHost;
  const drawAll = renderActions.repaintUserMutation;
  let pendingExternalSubmitSource: InputSourceRef | undefined;
  const finalizeInput = (result: InputResult): InputResult => {
    clearPicker();
    writeTerminal(endTextInputCursor(opts.cursorSink));
    return result;
  };
  const submitBufferResult = (text: string): InputResult => (
    finalizeInput({
      text: text.trim(),
      submitted: true,
      ...(pendingExternalSubmitSource ? { externalSubmitSource: pendingExternalSubmitSource } : {}),
    })
  );
  const currentBufferText = (): string => lines.join('\n').trim();

  // Expose drawAll so the host can ping us to re-paint after an
  // external screen rewrite (e.g. scratchpad refresh erasing our
  // prompt row). Reset on return below so the closure can be reused
  // safely across input-mode entries.
  if (hostControl) {
    // F-E2 fix — host's afterRender hook calls this. Wire the INNER
    // (pure paint) variant so the render cycle doesn't self-trigger
    // the coordinator into scheduling another flush; only user-
    // originated paths (main readKey loop, picker onRowClick) invoke
    // the outer `drawAll` which requests the next render.
    hostControl.repaint = drawAllInner;
    // Arc C · v2 — external modals (folder picker from Browser
    // dblclick, @ picker Ctrl+I) feed the resulting attachment token
    // back into the live input buffer via this hook. Splices at the
    // current cursor, advances the cursor past the insertion, notifies
    // picker-state about the edit (clears stale nav flags) and
    // redraws. Reset to undefined below when textInput returns.
    hostControl.insertAtCursor = (text: string) => {
      if (!text) return;
      applyBufferState(insertTextAtCursor(bufferState(), text));
      onUserBufferEdit();
      drawAll();
    };
    // 2026-04-30 — external auto-submit hook. Voice multi-turn's
    // sticky-less dictate-fallback uses this to simulate a typed
    // Enter after the transcript lands in the buffer. When `text`
    // is provided, replace the buffer; then inject a synthetic
    // Enter into the readKey queue so the main loop returns the
    // submit outcome exactly like a typed Enter. Reset to
    // undefined on textInput return.
    hostControl.submit = (request?: string | TextInputExternalSubmitRequest) => {
      const nextText = typeof request === 'string' ? request : request?.text;
      pendingExternalSubmitSource = typeof request === 'string' ? undefined : request?.source;
      if (nextText !== undefined) {
        const next = nextText.split('\n');
        lines = next.length > 0 ? next : [''];
        lineIdx = lines.length - 1;
        colIdx = lines[lineIdx]!.length;
        drawAll();
      }
      injectKey({ name: 'enter', ctrl: false, shift: false });
    };
  }

  drawAll();

  while (true) {
    // IDX-F2.5 — picker.onKey may have set pendingSubmit on the
    // previous iteration (the closure can't return from textInput
    // itself). Consume the signal at the top of the loop, tear
    // down the picker row, and return the submit outcome exactly
    // like the picker dispatch path does when picker.dispatch returns
    // an action.kind === 'submit'.
    if (pendingSubmit !== null) {
      const text: string = pendingSubmit;
      pendingSubmit = null;
      lines[0] = text;
      return submitBufferResult(text);
    }

    const key = await (opts.readKey ?? (() => readKey('input')))();

    // Raw-key trace — diagnoses "modifier bit dropped before global-action
    // matcher saw the chord" cases (e.g. tablet terminal apps that
    // intercept Ctrl+Shift+<X> or strip CSI-u modifiers). Logs every
    // non-mouse / non-paste-envelope key with raw bytes so a triage can
    // tell exactly what stdin produced. Mouse/paste filtered out — they
    // dominate the log otherwise.
    if (debug.enabled && key.name !== 'mouse'
        && key.name !== 'paste-start' && key.name !== 'paste-end') {
      const rawHex = key.raw
        ? Array.from(key.raw, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
        : '(none)';
      debug.log('chat.input.readKey', key.name || '(empty)', {
        name: key.name,
        ctrl: key.ctrl,
        shift: key.shift,
        alt: key.alt ?? false,
        rawHex,
      });
    }

    // Hard exit must win over modal/VW pre-routing. When a foreground
    // virtual window is open, onPreKey may hand keys to the modal
    // surface before textInput's own quit branch runs. Claim the quit
    // chord here so Ctrl+Q / Ctrl+Shift+Q remain a reliable escape
    // hatch even while the dashboard input loop is still alive behind
    // a foreground ACP VW.
    if (isTextInputQuitChord(key)) {
      if (debug.isKeyTraceEnabled()) {
        const rawHex = key.raw
          ? Array.from(key.raw, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
          : '(none)';
        debug.log('chat.force-quit.match', key.name || '(empty)', {
          name: key.name,
          ctrl: key.ctrl,
          shift: key.shift,
          alt: key.alt ?? false,
          rawHex,
        });
      }
      closeTui();
      process.exit(0);
    }

    // A bracketed-paste envelope is one atomic event. Handle it before
    // host routing so embedded newlines cannot reach a submit handler.
    if (key.name === 'paste') {
      const pasted = key.paste ?? '';
      const inserted = opts.onPaste ? await opts.onPaste(pasted) : pasted;
      const beforeNumLines = lines.length;
      applyBufferState(insertMultilineTextAtCursor(bufferState(), inserted));
      if (debug.enabled) {
        debug.log('chat.input.paste', 'inserted', {
          rawLen: pasted.length,
          insertedLen: inserted.length,
          chunkCount: inserted.split('\n').length,
          beforeNumLines,
          afterNumLines: lines.length,
          maxLines,
          lineIdx,
          colIdx,
        });
      }
      onUserBufferEdit();
      drawAll();
      continue;
    }

    // MX11b / IDX-F2.5 — pre-key interceptor: lets the host route
    // Enter/Esc/arrows into an active pill popup or a
    // key-participating modal (chat picker onKey with focus:'participates',
    // F2.5) before textInput handles them. onPreKey may return a Promise so the
    // host can await coordinator.tryRouteKeyToTopModalAsync — the
    // picker's async dispatch (filesystem scan for at-picker) runs
    // before the sync key handling below.
    if (opts.onPreKey) {
      const pre = await Promise.resolve(opts.onPreKey(key));
      if (pre === 'consumed') {
        drawAll();
        continue;
      }
    }

    // A-5b.2 · dispatcher hook (routeInputEventAsync · ViewMode='input').
    // Positioned after onPreKey (modal/picker) and BEFORE specialized
    // textInput handlers · A-8 ESC guard fires for drag-active ESC here
    // instead of the DS-3a-follow direct-cancel in opts.onEscape (which
    // A-5b.3 will remove). Dispatcher returns 'passthrough' for every
    // key textInput owns (char / backspace / Enter / arrows) so buffer
    // semantics are undisturbed.
    if (opts.onKey) {
      const dispatched = await Promise.resolve(opts.onKey(key));
      if (dispatched === 'consumed') {
        drawAll();
        continue;
      }
    }

    // Mouse pass-through: delegate to host (scroll log, focus swap, …)
    // then repaint picker + input on top so the bar stays visible.
    if (key.name === 'mouse' && key.mouse) {
      // Wheel over the input area scrolls THROUGH the buffer when it
      // exceeds `maxLines` — moves the cursor up/down by 1, which
      // pulls the visible window via `firstVisibleInputLineIdx`. Only
      // intercepts when there's actually something off-screen and the
      // pointer is inside the input rows; otherwise the event falls
      // through to the host (log scroll, etc.).
      if (
        (key.mouse.type === 'scroll-up' || key.mouse.type === 'scroll-down') &&
        lines.length > maxLines
      ) {
        const visibleLines = Math.min(lines.length, maxLines);
        const inputBottomRow = getRow();
        const inputTopRow = inputBottomRow - visibleLines + 1;
        if (key.mouse.row >= inputTopRow && key.mouse.row <= inputBottomRow) {
          if (key.mouse.type === 'scroll-up') {
            lineIdx = Math.max(0, lineIdx - 1);
          } else {
            lineIdx = Math.min(lines.length - 1, lineIdx + 1);
          }
          colIdx = Math.min(colIdx, lines[lineIdx]!.length);
          if (debug.enabled) {
            debug.log('chat.input.wheel', key.mouse.type, {
              mouseRow: key.mouse.row,
              inputTopRow,
              inputBottomRow,
              lineIdx,
              colIdx,
              numLines: lines.length,
            });
          }
          drawAll();
          continue;
        }
      }
      // IDX-F5d — widget-level 'motion' is never routed to the chat
      // host's onMouse (chat surface has no hover semantics). Filter
      // it out so the discriminated type check below stays exhaustive.
      if (key.mouse.type !== 'motion' && opts.onMouse) {
        const repaint = await opts.onMouse({ ...key.mouse, type: key.mouse.type, shift: key.shift });
        if (repaint !== false) {
          drawAll();
        }
      }
      continue;
    }

    const globalDispatcher = dispatchGlobalAction;
    const globalAction = globalDispatcher
      ? matchTextInputGlobalAction(key, {
          includeCopyLastBlock: true,
        })
      : null;
    if (globalAction && globalDispatcher) {
      await globalDispatcher(globalAction);
      if (globalAction.kind === 'goto-log') {
        // Host owns the focus swap; we return gotoPane:true so the
        // input loop exits cleanly and the dashboard's pane dispatcher
        // picks up the keys.
        return { text: '', submitted: false, gotoPane: true };
      }
      drawAll();
      continue;
    }

    if (key.ctrl && (key.name === 'r' || key.name === 'R' || key.name === 'ㄱ')) {
      reverseSearch = startOrCycleReverseHistorySearch(reverseSearch, history, {
        lines: [...lines],
        lineIdx,
        colIdx,
        historyIdx,
        savedCurrentInput,
      });
      drawAll();
      continue;
    }

    if (reverseSearch.active) {
      const reverseSearchKey = applyReverseHistorySearchKey(reverseSearch, key);
      if (reverseSearchKey.action === 'cancel') {
        cancelReverseHistorySearch(reverseSearch);
        drawAll();
        continue;
      }
      if (reverseSearchKey.action === 'accept') {
        acceptReverseHistorySearch();
        drawAll();
        continue;
      }
      if (reverseSearchKey.action === 'continue') {
        reverseSearch = reverseSearchKey.search;
        drawAll();
        continue;
      }
      cancelReverseHistorySearch(reverseSearch);
      drawAll();
    }

    // KX2 — picker refresh + dispatch. The shared state machine
    // handles navigation / autofill / submit for slash / arg / at
    // pickers; textInput applies the resulting BufferAction.
    //
    // When dispatch returns consumed:false the keystroke falls through
    // to the regular typing / backspace / submit handlers below.
    if (await runInputLoopPickerPrelude(key)) {
      continue;
    }

    // ── Ctrl+V: attach clipboard image at cursor ──
    // Was Ctrl+Shift+V but most macOS terminals don't route that chord
    // to the app (it's their own paste shortcut). Ctrl+V survives in
    // raw mode, so bind there. Also accept `ㅍ` for 한글 IME.
    if (key.ctrl && (key.name === 'v' || key.name === 'V' || key.name === 'ㅍ')) {
      if (opts.onPasteImage) {
        let token: string | null = null;
        try { token = await opts.onPasteImage(); }
        catch { /* swallow — leave buffer unchanged */ }
        if (token) {
          applyBufferState(insertTextAtCursor(bufferState(), token));
          onUserBufferEdit();
        }
        drawAll();
        continue;
      }
    }

    const controlAction = resolveTextInputControlAction(key, {
      currentLine: lines[lineIdx] ?? '',
      cursor: colIdx,
    });

    if (controlAction.kind === 'newline') {
      if (lines.length < maxLines) {
        if (controlAction.stripTrailingBackslash) {
          lines[lineIdx] = lines[lineIdx]!.slice(0, colIdx - 1) + lines[lineIdx]!.slice(colIdx);
          colIdx--;
        }
        applyMultilineEditorState(multilineEditorInsertLineBreak(multilineEditorState()));
      }
    }
    else if (controlAction.kind === 'submit') {
      return submitBufferResult(lines.join('\n'));
    }
    else if (controlAction.kind === 'cancel') {
      // Give the host first crack — used by the dashboard to dismiss
      // a transient image-preview modal without also tearing down the
      // input session. If the host says it consumed the keystroke,
      // stay in the loop and redraw.
      if (opts.onEscape && opts.onEscape(currentBufferText())) {
        debug.log('esc.abort', 'chat-input-consumed', { decision: 'on-escape' });
        drawAll();
        continue;
      }
      debug.log('esc.abort', 'chat-input-consumed', { decision: 'cancel-input' });
      return finalizeInput({ text: '', submitted: false, cancelledBy: 'escape' });
    }
    // ── Goto pane (Ctrl+T primary, Ctrl+M on Kitty-protocol terminals) ──
    // Quick exit chord — the host swaps focus from input to a pane
    // without losing context. Mirrors the Escape teardown so the
    // terminal modes stay clean.
    //   Ctrl+T (0x14) — reliable on every terminal.
    //   Ctrl+M (0x0D) — collides with Enter except under the Kitty
    //                   keyboard protocol; kept for muscle-memory on
    //                   terminals that DO support CSI-u encoding.
    // Korean jamo: ㅅ shares the T key, ㅡ shares M — both accepted
    // so the chord fires under 한글 IME in both spellings.
    else if (controlAction.kind === 'goto-pane') {
      return finalizeInput({ text: '', submitted: false, gotoPane: true });
    }
    // ── Save (Ctrl+S, Ctrl+ㄴ) ──
    // "Persist the current buffer" chord. Distinct from Enter so the
    // host can run a memo / draft flow where Enter would send and
    // Ctrl+S commits-and-stays. Returns the trimmed buffer with
    // `saved: true` — the host decides what saving means. Korean
    // jamo `ㄴ` shares the s key.
    else if (controlAction.kind === 'save') {
      return finalizeInput({ text: currentBufferText(), submitted: false, saved: true });
    }
    // ── View switch from input (Ctrl+1..9) ──
    // Working-dir users want to flip layouts without leaving the
    // prompt. textInput already enables modifyOtherKeys, so
    // Ctrl+<digit> arrives as `K('<digit>', ctrl=true)`. We hand the
    // digit back via `viewSwitch` — the host resolves it against the
    // view registry (by shortcut field) so views like Agents
    // (shortcut='4') and Debug (shortcut='5') work regardless of
    // whether their numeric id matches the digit.
    else if (controlAction.kind === 'view-switch') {
      return finalizeInput({ text: '', submitted: false, viewSwitch: controlAction.view });
    }
    // ── Chord prefix from input (Ctrl+X / Ctrl+ㅌ) ──
    // ⭐ 2026-08-19 `Ctrl+B` → `Ctrl+X` (대표 지시 · Ctrl+B 는 백그라운드 승격으로).
    // Phase O6 wires the chord at the main loop level, which only
    // sees keys when focus is a pane. From input we arm the
    // input-core chord so the next letter can match an `ctrl+x <k>`
    // binding (e.g. `ctrl+x s` → enter sync mode) before this
    // textarea buffers it. Phase 5 of the unified-input plan.
    // R6 — chord window from input-core settings (user-config can
    // override the default 700ms via settings.chordWindowMs).
    else if (controlAction.kind === 'arm-chord') {
      armChordLeader('ctrl+x', undefined, getInputSettings().chordWindowMs);
    }
    const editAction = resolveTextInputEditAction(key, {
      linesLength: lines.length,
      lineIdx,
      historyLength: history.length,
      historyIdx,
    });

    // ── Backspace ──
    if (editAction.kind === 'backspace') {
      if (colIdx > 0) {
        const deleted = deleteAttachmentTokenBeforeCursor({
          line: lines[lineIdx]!,
          cursor: colIdx,
        });
        if (deleted.deleted) {
          lines[lineIdx] = deleted.nextLine;
          colIdx = deleted.nextCursor;
          // Tell the host whether other references survive so it can
          // decide between full cleanup and a no-op.
          if (opts.onTokenDeleted && deleted.token) {
            const stillReferenced = lines.some(l => l.includes(deleted.token!));
            try { opts.onTokenDeleted(deleted.token, stillReferenced); }
            catch { /* swallow */ }
          }
        } else {
          applyMultilineEditorState(multilineEditorBackspace(multilineEditorState()));
        }
      } else if (lineIdx > 0) {
        applyMultilineEditorState(multilineEditorBackspace(multilineEditorState()));
      }
      // Reset picker selection when text changes
      onUserBufferEdit();
    }
    // ── Arrow keys (non-slash mode) ──
    else if (editAction.kind === 'move-left') {
      if (key.ctrl) {
        const action = resolveTextInputTextAction(currentLineEditorState(), key);
        if (action.kind === 'insert') applyCurrentLineEditorState(action.next);
      } else {
        applyMultilineEditorState(multilineEditorMoveLeft(multilineEditorState()));
      }
    }
    else if (editAction.kind === 'move-right') {
      if (key.ctrl) {
        const action = resolveTextInputTextAction(currentLineEditorState(), key);
        if (action.kind === 'insert') applyCurrentLineEditorState(action.next);
      } else {
        applyMultilineEditorState(multilineEditorMoveRight(multilineEditorState()));
      }
    }
    else if (editAction.kind === 'history-older') {
      applyHistoryState(navigateSingleLineHistory(historyState(), history, 'older'));
      onHistoryRecall();
    }
    else if (editAction.kind === 'history-newer') {
      applyHistoryState(navigateSingleLineHistory(historyState(), history, 'newer'));
      onHistoryRecall();
    }
    else if (editAction.kind === 'move-vertical') {
      applyMultilineEditorState(multilineEditorMoveVertical(multilineEditorState(), editAction.delta));
    }
    // ── Home / End ──
    else if (editAction.kind === 'move-home') {
      const next = applyInlineEditorKey(currentLineEditorState(), key);
      if (next) applyCurrentLineEditorState(next);
    }
    else if (editAction.kind === 'move-end') {
      const next = applyInlineEditorKey(currentLineEditorState(), key);
      if (next) applyCurrentLineEditorState(next);
    }
    // ── Kill line ──
    else if (editAction.kind === 'kill-before-cursor') {
      const next = applyInlineEditorKey(currentLineEditorState(), key);
      if (next) applyCurrentLineEditorState(next);
      onUserBufferEdit();
    }
    else if (editAction.kind === 'kill-after-cursor') {
      const next = applyInlineEditorKey(currentLineEditorState(), key);
      if (next) applyCurrentLineEditorState(next);
      onUserBufferEdit();
    }
    // ── Space / tab / regular character (including multi-byte: Korean, CJK, emoji) ──
    else {
      const textAction = resolveTextInputTextAction(currentLineEditorState(), key);
      if (textAction.kind === 'none') { /* skip */ }
      else {
        // P5 — if the input-core chord leader is armed, try the
        // resolver FIRST so `ctrl+x s` (chord continuation) can fire
        // its action (e.g. mode.enter.sync) instead of appending `s`
        // to the buffer. The resolver's chord path always disarms,
        // whether or not a binding matched, so an unbound chord
        // "wastes" the prefix but does NOT steal the continuation —
        // that keystroke still falls through to the normal buffer
        // insert below.
        if (isInputCoreChordArmed()) {
          try {
            const dispatched = dispatchInputEvent(inputCoreKeyEvent(key));
            // dispatchInputEvent is async; we treat it fire-and-forget
            // here. For a match, the handler has queued a draw already
            // (or will); skipping the buffer insert is correct. For a
            // miss the chord is now disarmed and we DON'T have a
            // reliable "was it handled" sync signal — so we peek at
            // the dispatched Promise and fall back to the insert path
            // only on a synchronous decline.
            void dispatched;
          } catch (e) {
            if (debug.enabled) debug.log('chat.chord', 'dispatch-threw', { error: String(e) });
          }
          // Always drop the continuation keystroke after an armed
          // chord — matches tmux behaviour (unbound second key is a
          // silent no-op). Breaks buffer-typo symmetry (user typing
          // fast and accidentally arming the chord would lose the
          // next letter) but the 700ms chord window keeps collisions
          // narrow.
          onUserBufferEdit();
        } else {
          applyCurrentLineEditorState(textAction.next);
          // Reset picker selection when text changes
          onUserBufferEdit();
        }
      }
    }

    await refreshPickerAndDraw();
  }
}

// ── Grok streaming chat ──

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /**
   * String for the common text-only case; ContentBlock[] when a turn
   * carries tool_use / tool_result / image blocks (multi-turn tool
   * loop evidence that needs to survive across chat turns). Keep this
   * structurally compatible with LLMMessage — dashboard casts
   * chat.history straight through to the LLM request assembly.
   */
  content: string | ContentBlock[];
}

/**
 * Deprecated — kept as a back-compat shim. Historically streamed a
 * Grok-only chat; now delegates to streamLLM() which resolves the
 * active provider via user-config (honors openai-codex / local /
 * anthropic / auto-from-env).
 *
 * Prefer calling streamLLM() directly in new code.
 */
export async function streamGrok(
  messages: ChatMessage[],
  onChunk: (delta: string, full: string) => void,
  abortController?: AbortController,
): Promise<string> {
  const { streamLLM } = await import('../llm.js');
  return streamLLM(
    messages.map(m => ({ role: m.role, content: m.content })),
    onChunk,
    abortController ? { signal: abortController.signal } : {},
  );
}

/**
 * Attach a stdin listener that parses keystrokes during streaming and
 * dispatches them to `handler`. Mirrors readKey()'s chunk-splitting so
 * multi-key stdin bursts (e.g. `jjj` held down) all reach the handler
 * in order. The host is responsible for filtering/routing — any key
 * that isn't handled is simply dropped (the main readKey loop won't
 * see it, since no readKey() is active during streaming anyway).
 *
 * Returns cleanup. Call once the streaming `await` returns.
 */
export function attachStreamingKeys(
  handler: (key: Key) => void | Promise<void>,
): () => void {
  const parser = new KeyStreamParser();
  // ⛔⭐ **단독 ESC 조용창**(리뷰 must-fix · 2026-07-30) — 파서가 상태를 갖게 되면서 lone ESC 는
  //    `pending` 에 **머문다**. `readKey` 는 이 타이머를 갖고 있었는데 이 스트리밍 경로만 없어서,
  //    Escape 가 **다음 입력이 올 때까지 전달되지 않고** 그때 Alt 조합으로 오인될 수 있었다
  //    (⚠️ main 의 무상태 `splitKeys` 는 즉시 내보냈으므로 **이 브랜치가 만든 회귀**다).
  //    ⭐ 창 길이는 `readKey` 와 같은 25ms — 두 진입점이 같은 규칙을 쓴다.
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearEscapeTimer = () => { if (escapeTimer) { clearTimeout(escapeTimer); escapeTimer = undefined; } };
  const listener = (data: string | Buffer) => {
    clearEscapeTimer();
    const keys = parser.push(data);
    deliver(keys);
    // ⚠️ `unref()` — 이 타이머가 프로세스를 붙잡아 두면 안 된다(입력 대기는 stdin 의 몫).
    if (parser.hasPendingEscape()) {
      escapeTimer = setTimeout(() => { escapeTimer = undefined; deliver(parser.flushEscape()); }, 25);
      escapeTimer.unref?.();
    }
  };
  function deliver(keys: readonly Key[]): void {
    for (const key of keys) {
      traceKey(key, 'stream');
      try {
        const r = handler(key);
        // Don't await — keep the listener non-blocking so one slow
        // handler (e.g. clipboard copy) can't delay subsequent keys.
        if (r && typeof (r as Promise<void>).then === 'function') {
          (r as Promise<void>).catch(() => { /* swallow */ });
        }
      } catch { /* swallow per-key errors */ }
    }
  }
  const wasPaused = process.stdin.isPaused();
  let cleanedUp = false;
  process.stdin.on('data', listener);
  // A preceding terminal/modal session may have explicitly paused stdin.
  // Adding a data listener does not reliably resume that paused stream, which
  // leaves streaming typeahead and lone Escape with no events at all.
  process.stdin.resume();
  traceKeyListener('attach', 'stream');
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearEscapeTimer();
    process.stdin.removeListener('data', listener);
    traceKeyListener('detach', 'stream');
    if (wasPaused) process.stdin.pause();
  };
}

/**
 * @deprecated Prefer `attachStreamingKeys` which delivers all scroll /
 * pane keys too. Kept as a thin wrapper for call sites that only care
 * about Esc→abort.
 */
export function onEscAbort(controller: AbortController): () => void {
  return attachStreamingKeys((key) => {
    if (key.name === 'escape') controller.abort();
  });
}

// ── Chat UI for dashboard integration ──

export interface ChatState {
  history: ChatMessage[];
  outputLines: string[];
  inputActive: boolean;
  streaming: boolean;
}

export function createChatState(systemPrompt: string): ChatState {
  return {
    history: [{ role: 'system', content: systemPrompt }],
    outputLines: [],
    inputActive: false,
    streaming: false,
  };
}

/**
 * Build context from current dashboard selection.
 */
export interface DashboardContext {
  skill?: string;
  filePath?: string;
  fileContent?: string;
  // Display-only (interpolated into the context preamble). The value is
  // the active plugin's name — 'browse' when none — so any string is valid.
  mode: string;
  syncMode?: string;             // clean/merge/smart/diff
  selectedSkills?: string[];
  selectedServers?: string[];
  selectedServices?: string[];
  recentStatus?: string[];       // last N lines from log pane (plain text)
  lastSelection?: { skills: string[]; servers: string[]; services: string[]; mode: string; ts: string } | null;
  /** Append the sync ACTION-block DSL to the context so the LLM can
   *  emit `{"select": …, "mode": …}` blocks. Should only be true
   *  while the sync plugin is active — otherwise the DSL leaks into
   *  unrelated chats (YouTube summaries etc.) and pollutes responses. */
  includeSyncDSL?: boolean;
}

export function buildContext(ctx: DashboardContext): string {
  const parts: string[] = [];
  const isSyncish = ctx.mode === 'sync' || ctx.mode === 'syncing';

  // Dashboard state
  parts.push(`Dashboard mode: ${ctx.mode}`);

  // Current skill/file — always relevant (user may ask about
  // currently-previewed file regardless of mode).
  if (ctx.skill) parts.push(`Current skill: ${ctx.skill}`);
  if (ctx.filePath) parts.push(`Selected file: ${ctx.filePath}`);

  // Sync-specific state — GATED on sync mode. Previously these were
  // always injected, which taught the LLM to respond as a sync
  // helper even for unrelated questions (YouTube summaries, etc.)
  // and bled `{"select": …}` syntax into answers.
  if (isSyncish) {
    if (ctx.syncMode) parts.push(`Sync mode: ${ctx.syncMode}`);
    if (ctx.selectedSkills?.length) parts.push(`Selected skills: ${ctx.selectedSkills.join(', ')}`);
    if (ctx.selectedServers?.length) parts.push(`Selected servers: ${ctx.selectedServers.join(', ')}`);
    if (ctx.selectedServices?.length) parts.push(`Selected services: ${ctx.selectedServices.join(', ')}`);
    if (ctx.lastSelection) {
      const ls = ctx.lastSelection;
      parts.push(`\nLast selection (${ls.ts}): ${ls.skills.length} skills [${ls.skills.slice(0,5).join(',')}${ls.skills.length > 5 ? '...' : ''}] → ${ls.servers.join(',')} × ${ls.services.join(',')} mode:${ls.mode}`);
    }
  }

  // File content
  if (ctx.fileContent) {
    const preview = ctx.fileContent.slice(0, 3000);
    parts.push(`\nFile content (first 3000 chars):\n\`\`\`\n${preview}\n\`\`\``);
  }

  // Recent status output (diff results, sync logs, etc.)
  if (ctx.recentStatus?.length) {
    parts.push(`\nRecent status output:\n${ctx.recentStatus.join('\n')}`);
  }

  // Sync action-block DSL — appended only on explicit opt-in
  // (`includeSyncDSL`). The dashboard sets this true only when the
  // sync plugin is active, so browse/chat sessions never see it.
  if (ctx.includeSyncDSL) {
    parts.push(
      '\nYou can issue sync actions via a JSON block when the user asks to select targets, run sync, or run diff:\n' +
      '```action\n' +
      '{"select": {"skills": [...], "servers": [...], "services": [...]}, "mode": "clean|merge|smart|diff", "run": "sync|diff"}\n' +
      '```\n' +
      'Only emit this block when the user explicitly asks to act on sync/diff targets; use plain text for analysis.'
    );
  }

  return parts.join('\n');
}

/**
 * Format streaming output into lines for the log pane.
 * Applies markdown rendering: **bold**, *italic*, `code`, headings,
 * lists, blockquotes — then word-wraps to fit terminal width.
 */
export function formatResponse(
  text: string,
  maxWidth: number,
  wrapOpts: { urlAware?: boolean } = {},
): string[] {
  // Apply markdown styling first
  const rendered = renderMarkdown(text);
  const lines: string[] = [];
  for (const paragraph of rendered.split('\n')) {
    const w = visibleWidth(paragraph);
    if (w <= maxWidth) {
      lines.push(paragraph);
    } else {
      lines.push(...urlAwareWrap(paragraph, maxWidth, wrapOpts));
    }
  }
  return lines;
}
