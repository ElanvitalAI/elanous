import { updateToolActivity, toolActivityLines, interleavedTurnLines, runningToolLabel, TOOL_RUNNING_GLYPH, type ToolActivityRow } from './chat/tool-activity.js';
import { keepBottomStatus } from './core/bottom-status.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { CTRL_C_ARM_MS, resolveCtrlCInInput } from '../chat/ctrl-c-in-input.js';
import { footerBreathingRoom } from './core/footer-breathing-room.js';
import { accountsRowLine, progressRowLine, renderStatusRows, STATUS_THREE_ROWS_MIN_HEIGHT, STATUS_TWO_ROWS_MIN_HEIGHT } from './chat/status-rows.js';
import { nextAssistantPreviewText } from './chat/assistant-preview.js';
import { C, initTui, initTuiPrimary, closeTui, injectKey, pendingKeyCount as tuiPendingKeyCount, lastHumanKeyAt as tuiLastHumanKeyAt, readKey, setTuiAltScreen, setTuiMouseCapture, type Key } from '../tui.js';
import { hasDisplayableCompletedToolBlock, nextTuiActivityRow, createNextTuiCompactPainter, createNextTuiHistoryCache, fitLogLine, foldTargetAtScreenRow, isNextTuiContextCountStatus, isToolFoldToggleKey, NEXT_TUI_TITLE, nextTuiCompactHeight, nextTuiStatusAfterWelcome, nextVisibleFoldTarget, renderNextTuiCompactFrame, safeStatusText, streamReplyLines, toolFoldBlockStarts, wheelScroll, wrapLogLines } from './core/render.js';
import { renderNextTuiEntryFrame, shellApprovalCommandViewport } from './core/entry-render.js';
import type { MessageBlock } from '../conv-substrate/message-block.js';
import { nextMessageBlockDetailLevel } from './chat/message-block-view.js';
import { addTranscriptMarker, missionArrivalText } from './chat/mission-arrival.js';
import { compactMarkerText, displayRowsAfterReload, mergeDisplayAfterCompact, previousAttemptMarker } from './core/compact-display.js';
import { createMessageBlockSessionStore, upsertMessageBlock } from './core/message-block-session.js';
import { formatMessageBlockRawTrace, resolveMessageBlockRawTrace } from './core/message-block-raw-ref.js';
import { BackgroundJobStatus } from './chat/background-job-status.js';
import { MOUSE_RESIDUE_WINDOW_MS, MouseResidueGuard, composerViewport, replaceSlashPickerQuery, wheelDirection } from './input/composer.js';
import { inlineEditorInsert, type InlineEditorState } from '../input-core/inline-editor.js';
import { createContextRegistry } from '../context.js';
import { hasClipboardImage, readClipboardText } from '../clipboard/index.js';
import { registerClipboardImageAttachment } from '../clipboard/image-attachment.js';
import { readClipboardPaste } from '../clipboard/paste.js';
import { carrySessionProvider, requestNewTuiSession } from './slash/new-session.js';
import { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS } from './slash/compact-command.js';
import { RESUME_BUSY_STATUS, parseResumeCommand } from './slash/resume-command.js';
import { reportTuiProgress, reportTuiTurn } from '../pty-shell/tui-run-state.js';
import { setTuiForegroundSessionId } from '../capture/tui-self-report.js';
import { createNextTuiQueue, type NextTuiSettledTurn, type NextTuiQueueInterruptReason } from './core/queue.js';
import { stripQueueModelContext, withInterruptedOnPurposeContext, withQueueNoticeContext, withReplacementCandidateContext } from '../chat/interjection.js';
import { preparePassiveResultCarry } from './passive-result-turn.js';
import { seatMailBundleText } from './seat-mail-digest.js';
import { replacementCandidateContextLine, replacementCandidateScreenLine } from '../chat/queue-supersede.js';
import { isTurnTypeaheadSteerable } from '../chat/turn-typeahead.js';
import { agentDisplayLine, agentDisplayLines, applyAgentEvent, reconcileAgentOutputStatuses, reconcileNestedAgentSnapshot, type AgentDisplay } from './core/agents.js';
import { englishFooterText, nextTuiElapsedMs, nextTuiTurnIsPhase } from './chat/status-line.js';
import { decideNextTuiAutoContinue, startNextTuiTurn } from './core/turn.js';
import { heldPreToolText } from './core/held-answer.js';
import { createTurnStallWatch, stallMinutes } from './core/turn-stall.js';
import { debug } from '../debug/log.js';
import { anchorStickyScroll, stickyScrollHint, stickyScrollResetAllowed, type StickyScrollMemo, type StickyScrollResetCause } from './core/sticky-scroll.js';
import { setCliStderrSink } from '../git-fs/cli-stderr.js';
import { createInputLagProbe, noteInputLagPaint, setInputLagProbe } from './input-lag-probe.js';
import type { NextTuiWakeup } from '../tui-client/next-wakeup.js';
import { CapsuleActivity } from './chat/capsule-activity.js';
import { withCapsuleDone } from './chat/capsule-transcript.js';
import { createNoticeGate, nextNoticeRows } from './chat/notice-gate.js';
import { detectSeat, detectSeatTui } from '../seat/seat-boot-preamble.js';
import type { SeatWorkPullMountDeps } from './seat-work-pull.js';
import { randomUUID } from 'node:crypto';
import type { CeoAcceptedTurn } from '../agent-events/ceo-ingress.js';
import { postCeoTurnReply, type CeoTurnRef } from './ceo-turn-reply.js';
import { createSeatApprovalHandler, seatApprovalLedgerPorts } from './seat-approval-policy.js';
import { createSeatStopDriver, setSeatStopHandler } from './seat-stop-port.js';
import { readUnreadSummary } from '../msg/msg-store.js';
import { pullSeatAfterGoal, releaseBusyAfterSettle, settleSeatPullTurnEnd, type SeatPullAfterGoalDeps } from './seat-pull-after-goal.js';
import { createSessionWakeupBinder, WAKEUP_DEFER_MAX_MS } from '../skills/tools/schedule-wakeup.js';
import { countInterimDisplay, internalTurnOriginOfText, planInterimDisplay } from './chat/goal-interim.js';
import type { NextTuiLoopBranch } from '../tui-client/next-loop-command.js';
import { handleSignalsSlash, type SignalsSlashContext } from './slash/signals.js';
import { updatePtyManifestSession } from '../pty-shell/pty-manifest.js';
import { agentTurnBanner, continueBanner } from './chat/continue-banner.js';
import { createNextTuiCoreInput } from './core/input.js';
import { formatInlinePanel } from './input/inline-panel.js';
import { QUEUE_PANEL_HINT, queueFullTextView, queuePanelKey, queuePanelMove, queuePanelOrder, queuePanelSpec, queueWaitRows, type QueuePanelAction, type QueuePanelViewing } from './input/queue-panel.js';
import { NextTuiQueueConflictError } from './core/queue.js';
import { createChildNoticeProducers } from './core/notice-producers.js'; // #38031 CHILD-NOTICE
import { createNeedsHumanPush } from './needs-human-push.js';
import { createNeedsHumanDeps } from './needs-human-wiring.js';
import { createSeatMailArrivalWatcher } from './seat-mail-arrival.js'; // #38031 자리 우편 도착 감시
import { createIdleEventWake, graphNodeEndNotice, graphRunIdleNotice, idleChildLabel } from './idle-event-wake.js';
import { createIdleWakeDoor } from './idle-wake-door.js';
import { createQueueFinishFirst, heldChip, midTurnMailAction, orderReleased, P1_PAUSE_NOTE, RESUME_PAUSED_WORK_PROMPT } from './queue-finish-first.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from '../chat/internal-turn-contract.js';
import { QUEUE_IDLE_STALL_MS, QUEUE_IDLE_TICK_MS, createQueueIdleWatchdog } from './core/queue-idle-watchdog.js';
import { seatMailOnArrived } from './seat-mail-on-arrived.js';
import { offerSeatMailSteer, type SeatMailMidTurnEvent } from './seat-mail-midturn-steer.js';
import { isNextTuiSlashCommandDraft } from './slash/during-turn.js'; // TUI-SLASH-DURING-TURN
import { enqueueMidTurnEvent } from '../session/mid-turn-events.js';
// OP-EVENT-WATCH-WAKE: event-watch-runner 는 동적 import (entry 는 훅만).
import { createLedgerReceiptWriter, readSeatMailMessages } from './seat-message-receipts.js'; // SEAT-INBOX B1-C 메시지 단위 notice ⊕ 영수증
import { nextSlashCandidates } from './input/slash-complete.js';
import { createPromptHistoryStore, mergePromptHistory, moveEditorLine, upDownTarget } from './input/prompt-history.js';
import { nextFirstScreenLines } from './branches/first-screen.js';
import type { NextTuiHarnessRunner } from './branches/harness.js';
import type { GraphInstanceView } from '../../plugins/graph-instance-view/handlers/view-model.js';
import { monotonicNowMs, requiresLongShellEscConfirmation } from '../esc-shell-timing.js';
import { graphProgressStatus } from '../graph-runner/graph-progress-observation.js';
import { projectGraphLoopViews, type GraphLoopView, type GraphViewEvent } from '../graph-view/model.js';
import { createGraphDetailController } from './graph-detail/controller.js';
import { createRunnerProgressProjector } from '../graph-view/runner-progress.js';
import { createNodeLivenessTui, nodeLivenessFooterLine, nodeLivenessProgressRow, withNodeLivenessToolRow } from '../graph-view/node-liveness-tui.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { graphViewShowsBlock, graphViewShowsHint, graphViewSurfaceMode, graphViewTurnLines } from '../graph-view/surface.js';
import { createShellApprovalSession, shellApprovalPromptHelp, shellApprovalPromptTitle } from './shell-approval-session.js';
import { createPublishApprovalHost } from './publish-approval-session.js';
import { openPublishApprovalUrl } from './publish-approval-open.js';
import { createHarnessAskUserSession, harnessAskUserComposerLines } from './harness-ask-user-session.js';
import { SYNCHRONIZED_OUTPUT_BEGIN, SYNCHRONIZED_OUTPUT_END, openSynchronizedOutputRegion, synchronizedOutputDisabledByEnv } from '../display/synchronized-output-region.js';
import { remoteFrameRows, ScreenPaintCache } from './core/screen-paint-cache.js';
import { newPtyPickerKey } from './sidetab/new-pty-picker.js';
import { formatSidetabSectionFrame, normalizeSidetabSectionOrder, reorderSidetabSections, sidetabSectionTargetAt, type SidetabSectionFrame, type SidetabSectionId } from './sidetab/sections.js';
import type { SerializedMessage } from '../session/index.js';
import { formatTurnEndTime } from '../thinking-line.js';
import { displayNextPublicReplyText, projectUserReplyStatus, streamReplyProgress, turnReplyFailureMessage } from './core/next-public-reply.js';
import { nextTuiPublicHistory, publicUserText, shownAnswerCount } from './core/public-history.js';
import { foldExpandedIndexes, queueNoticeMeta, seatMailNoticeParts, toggleNoticePartFold, withNoticeOpenParts } from './chat/notice-fold.js';
import { chatRowsOnScreen, createTranscriptVanishDetector, vanishPreview } from './core/transcript-vanish.js';
import { logViewLines } from './chat/log-view.js';
import { joinedSteerRows, liveSteerStatus } from './core/steer-status.js';
// The common dispatch verdict lives in its own leaf so the entry chain can
// use it even when the wire leaf import failed (#38443 r4).
import { noticeOneDispatch } from './external-event-one-verdict.js';
import { createEntryTurnDoor, humanFirstDetail, nextDoorOpener, runDoorTurn, doorOutcomeOf, type DoorTurnKind, type EntryTurnDoor } from './turn-events/door-wire.js';
import { createSeatMailAdapter, type SeatMailAdapter } from './turn-events/mail-adapter.js';
import { createTurnEventBus } from './turn-events/bus.js';
import { getAgentEventEmitter } from '../agent-events/emit.js';
import { createAgentEventBridge } from './agent-event-bridge.js';
import { wireNoticeEvents } from './agent-event-notice-wire.js';
import { createWakeupBusConsumer, openLateWakeupTurn, type WakeupBusConsumer } from './turn-events/wakeup-consumer.js';

let nextTuiRouteRegistry: typeof import('./core/registry.js') | undefined;
/** Full picker chrome: title + four candidates + hint (the previous fixed default). */
const INLINE_PANEL_MAX_ROWS = 6;
/**
 * ELN-QUEUE-PANEL-CTRLC-RACE (2026-11-18): the auto-submit Enter the queue drain replays after a turn ends
 * (dispatchQueued §8.6). It is the door's own handoff, not the person's key — the queue panel must not read
 * it as «edit the selected item»; it falls through to the ordinary submit path, its only purpose.
 */
const syntheticEnterKey: Key = { name: 'enter', ctrl: false, shift: false, raw: '\r' };

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

/** One queued notice as entry took it off the idle queue. */
export interface QueuedExternalEventOne {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  /** When the event existed, if the producer knows. Absent is unknown. */
  readonly occurredAt?: number;
  /** The ledger message id a seat-mail notice carries — keeps the #38804 eventId chain through a held re-dispatch. */
  readonly msgId?: number;
  /** Queued items still behind this one (already off the queue). */
  readonly remaining: number;
}

/**
 * The one chain entry runs when a notice leaves the idle queue: import the
 * wire leaf, open the row, and follow the dispatch verdict through the
 * leaf. One chain: the import failure alone is recovered (the refusal cell
 * of the common verdict), and an exception after the import rejects this
 * chain instead of being swallowed into a second queue wake.
 */
export function dispatchQueuedExternalEventOne(input: {
  readonly notice: QueuedExternalEventOne;
  /** OP #129546 ① — bundle drain이면 묶음 전체: 각 항목이 plan link 에 각각 결속된다(머리만이 아니라). */
  readonly bundled?: readonly QueuedExternalEventOne[];
  /** Test seam for the import; production imports the real leaf. */
  readonly wire?: Promise<typeof import('./external-event-one-wire.js')>;
  /** The plan link learns which turn owns this notice (seat-mail only). */
  readonly onSeatMail?: (id: string, text: string) => void;
  readonly injectKey: () => void;
  readonly keepOpen: (opened: import('./external-event-one-wire.js').ExternalEventOneOpened) => void;
  readonly startChatTurn: (text: string, status: string) => void;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** CAPSULE-C2 (flag on): false once a person took the door during the import — the notice is kept, not opened. */
  readonly held?: () => boolean;
  readonly onSuperseded?: () => void;
  /** CAPSULE-C2 (flag on): the chain is over (a turn started, or nothing to start) — the door frees an unstarted hold. */
  readonly afterDispatch?: () => void;
}): Promise<void> {
  const { id, text, source, occurredAt, remaining } = input.notice;
  const receivedAt = Date.now();
  // OP #129546 ① — 묶음이면 묶음 전체가 plan link 에 각각 결속되고(제 머리 우편 포함), 한 통이면 제 한 통이:
  // 나머지의 결속이 빠지면 plan 이 본문에 이미 실린 우편을 재배달(중복 턴)할 수 있다.
  const seatMailOnes = input.bundled !== undefined
    ? input.bundled.filter((one) => one.source === 'seat-mail')
    : source === 'seat-mail' ? [input.notice] : [];
  for (const one of seatMailOnes) input.onSeatMail?.(one.id, one.text);
  const wire = input.wire ?? import('./external-event-one-wire.js');
  return wire
    // r4: the catch is for the import alone, on this chain. The leaf did not
    // load, so this is the refusal cell of the common verdict: no turn, and
    // a later queued item still wakes. #38501 fields stay on the new chain:
    // the failed receipt is observed with the id and the error, not silent.
    .catch((error) => {
      input.log('queue-notice-open-failed', {
        source, id, remaining, receipt: 'failed', error: String(error).slice(0, 200) });
      input.afterDispatch?.();
      if (noticeOneDispatch({ injected: false, remaining }).wakeQueue) input.injectKey();
      return null;
    })
    .then((leaf) => {
      if (!leaf) return;
      if (input.held && !input.held()) {
        // The ledger has not seen this id: keeping it is loss 0, and it opens after the person's turn.
        input.log('queue-notice-superseded', { source, id, remaining });
        input.onSuperseded?.();
        return;
      }
      // CAPSULE-C2-FU: afterDispatch in finally — a throw in open/dispatch/startChatTurn still frees an unstarted
      // hold (once), and the chain still rejects.
      try {
        const opened = leaf.openExternalEventOne({
          id,
          text,
          ...(source === undefined ? {} : { source }),
          ...(occurredAt === undefined ? {} : { occurredAt }),
          receivedAt,
        });
        // A duplicate or a refusal is not a turn. The leaf already posted the
        // failed receipt. The item is already off the queue, so the next queued
        // notice must still wake. Entry follows the verdict through the leaf.
        leaf.dispatchExternalEventOne({
          opened,
          dispatch: noticeOneDispatch({ injected: opened.injected, remaining }),
          remaining,
          injectKey: input.injectKey,
          keepOpen: input.keepOpen,
          startChatTurn: input.startChatTurn,
          log: input.log,
        });
      } finally {
        input.afterDispatch?.();
      }
    });
}

/**
 * JUD hold #123230 (request 123207 · OP #123241 P0) — the notice's `startChatTurn` wrapper:
 * the intake acknowledgement binds to the REAL turn start. `runDoorTurn` returns false when
 * the door REFUSED the turn reservation (busy, or the holder is gone) — the body never ran and
 * nothing threw, so silence must not read as acceptance: refused → `failed` (the entry answers
 * a refusal — never a 👀 for a no-op); started → `accepted` (the honest 👀 moment); a throwing
 * start → `failed` + rethrow (afterDispatch still frees the unstarted hold).
 */
export function startChatTurnWithIntakeAck(input: {
  readonly startChatTurn: (text: string, status: string) => boolean;
  readonly notifyTurnIntake: (id: string, status: 'accepted' | 'failed' | 'cancelled', turn?: CeoAcceptedTurn) => void;
  readonly acceptedTurn?: () => CeoAcceptedTurn | undefined;
  readonly noticeId: string;
  readonly render: () => void;
}): (text: string, status: string) => void {
  const { startChatTurn, notifyTurnIntake, noticeId, render } = input;
  return (text, status) => {
    let started: boolean;
    try {
      started = startChatTurn(text, status);
    } catch (error) {
      notifyTurnIntake(noticeId, 'failed');
      throw error;
    }
    notifyTurnIntake(noticeId, started ? 'accepted' : 'failed', started ? input.acceptedTurn?.() : undefined);
    render();
  };
}

type NextTuiTermSession = {
  id: string;
  title: string;
  kind: string;
  status: 'running' | 'backgrounded' | 'completed' | 'killed' | 'exited';
  cwd?: string;
  exitCode?: number | null;
};

/** What the C6 seam sees at the wake (also emitted as turn-life:queue-wake-seen). */
export interface QueueWakeBarrierState {
  readonly busy: boolean;
  readonly queued: number;
  readonly pendingKeys: number;
  readonly draftChars: number;
  readonly door: 'off' | 'idle' | 'reserved' | 'running' | 'closing';
}

export interface NextTuiOptions {
  /** Root launch flags select this process's session without editing shared config. */
  readonly initialProvider?: { readonly provider: string; readonly model?: string };
  /** Existing authenticated Nexus member session, supplied by the Next host. */
  readonly memberBoardSession?: () => { nexusUrl: string; sessionToken: string } | undefined;
  readonly resumeSessionId?: string;
  readonly sidetabMode?: 'off' | 'collapsed' | 'open';
  readonly compactHeight?: number;
  /** Test seam for the approval panel deadline; production uses the REPL timeout. */
  readonly shellApprovalTimeoutMs?: number;
  /** Test seam: silence (ms) with nothing running after which a turn is judged stalled (default 15 min). */
  readonly turnStallLimitMs?: number;
  /** Test seam: idle-with-queue time (ms) after which the queue watchdog wakes the loop (default QUEUE_IDLE_STALL_MS). */
  readonly queueIdleStallMs?: number;
  /** SEAT-WORK-PULL (OP #139787) — mount override for tests; null disables the pull outright. */
  readonly workPullForTest?: {
    readonly seat?: string | null;
    readonly intervalMs?: number;
    readonly pullDeps?: NonNullable<SeatWorkPullMountDeps['pullDeps']>;
  } | null;
  /** Test seam: the seat whose saved plan boots into the queue (production: process.cwd() and the real home). */
  readonly seatPlanBootForTest?: { readonly cwd: string; readonly home: string };
  /**
   * C6 sim seam (CX-9 #89715): awaited when a queueWake reaches the key loop, before the door/dispatch decides.
   * A PTY test holds the wake here until its person input is typed, then releases it — the boot-notice vs first-Enter
   * race becomes deterministic. Production never sets it.
   */
  readonly queueWakeBarrierForTest?: (state: QueueWakeBarrierState) => Promise<void>;
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

/** TUI-IDLE-CPU-SPIN: the public view of the transcript, memoised so an idle render (sidetab 1 s timer) hands the
 *  history cache the SAME array and skips re-wrapping every message. Invalidated exactly like the former inline cache. */
export function createNextTuiPublicHistoryView(): (visible: readonly SerializedMessage[], busy: boolean, turnStartedAt?: number) => readonly SerializedMessage[] {
  let cache: { source: readonly SerializedMessage[]; length: number; busy: boolean; since: number | undefined;
    last: SerializedMessage | undefined; view: readonly SerializedMessage[] } | null = null;
  return (visible, busy, turnStartedAt) => {
    const since = busy ? turnStartedAt : undefined;
    if (!cache || cache.source !== visible || cache.length !== visible.length || cache.last !== visible.at(-1) || cache.busy !== busy || cache.since !== since) {
      cache = { source: visible, length: visible.length, busy, since, last: visible.at(-1),
        // A running turn hides only ITS OWN saved answer (the live preview shows it); an earlier answer stays.
        view: nextTuiPublicHistory(visible, busy && since !== undefined ? { since } : busy).map((message) => message.role === 'assistant' && message.content.includes('\t')
          ? { ...message, content: displayNextPublicReplyText(message.content) } : message) };
    }
    return cache.view;
  };
}

interface SlashPickerCandidate { readonly value: string; readonly description: string }

/** Local chat entry: history and input are TUI-owned; turn execution stays shared. */
export async function showNextTui(options: NextTuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('elanous --tui next requires stdin TTY');
  try { (await import('../seat/seat-local-instructions.js')).ensureSeatLocalInstructions(process.cwd()); }
  catch (error) { debug.log('tui.local-instructions', 'next-start-skipped', { error: error instanceof Error ? error.message : String(error) }); }
  if ((process.stdout.columns || 0) < 20 || (process.stdout.rows || 0) < 6) {
    throw new Error('elanous --tui next requires at least 20 columns and 6 rows');
  }
  const { readNextTuiStatusModel, nextTuiFooterModel } = await import('./chat/status-model.js');
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
  setTuiForegroundSessionId(id);
  if (options.initialProvider) {
    const { parseSessionProvider, setSessionProvider } = await import('../tui-client/session-provider.js');
    setSessionProvider(id, parseSessionProvider(options.initialProvider.provider, options.initialProvider.model));
  }
  let session = id ? loadSession(id) : null;
  let messages = session?.messages ?? [];
  /** TUI-ANSWER-VANISH ⑤ — the reload that replaced `messages` since the last frame, and the running turn's door. */
  let vanishReload: 'compaction' | 'compact-reload' | 'session-reload' | undefined;
  let vanishTurnDoor: string | undefined;
  let vanishTurnSource: string | undefined;
  const vanishRowLines = new WeakMap<SerializedMessage, { columns: number; lines: readonly string[] }>();
  const observeVanish = createTranscriptVanishDetector((event) => {
    debug.log('tui.transcript', 'answer-vanished', { ...event }, { level: 'info' });
  });
  /** TUI-ANSWER-VANISH-ON-TOOLCALL — first-class record of what a transcript reload did to shown answers. */
  const observeTranscriptReload = (before: readonly SerializedMessage[], after: readonly SerializedMessage[], at: string, sessionId: string | undefined): void => {
    const was = shownAnswerCount(before);
    const now = shownAnswerCount(after);
    if (now < was) debug.log('tui.transcript', 'answer-drop', { at, sessionId, before: was, after: now }, { level: 'warn' });
    else if (now > was) debug.log('tui.transcript', 'answer-commit', { at, sessionId, before: was, after: now });
  };
  // The seat ledger is touched only on next-TUI boot, and only when the
  // optional seat directory exists. The one dashboard module below is the
  // turn-start segments recorder wired over the shared turn delegation.
  const { createSeatMailHeaderHook } = await import('./seat-mail-boot.js');
  // ELN-PLAN-WIRE-SEAT: rebuilt below once the prompt queue exists, so the header can show «계획 k/m».
  let seatMailHeader = createSeatMailHeaderHook(process.cwd());
  let seatPlan: import('./seat-mail-boot.js').SeatPlanRuntime | null = null;
  let seatPlanLink: ReturnType<typeof import('./seat-mail-boot.js').createSeatPlanTurnLink> | null = null;
  const input = createNextTuiCoreInput();
  let status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
  // U1a · #22868 — the empty-input Ctrl+C arm-exit contract (same resolver as the chat key loop).
  let ctrlCArmedAt: number | null = null;
  let ctrlCHintTimer: ReturnType<typeof setTimeout> | null = null;
  // #39550 r4 — 이 arm 이 footer status 슬롯에 쓴 안내 텍스트(«자기 안내»). 만료·clear-input이 슬롯을 되돌리는
  // 것은 «자기가 띄운 종료 안내»가 아직 그 슬롯에 있을 때뿐이다(#22868 «다른 키 사이엔 아무것도 안 함»).
  let ctrlCHintText: string | null = null;
  let graphProgressLine: string | null = null;
  // NEXT-TUI-INPUT-HISTORY: prompts survive sessions per working directory (slash commands included, secrets never).
  const promptHistory = createPromptHistoryStore(process.cwd());
  let savedPrompts = promptHistory.load();
  const rememberPrompt = (text: string): void => {
    const trimmed = text.trim();
    // A folded paste token cannot be expanded again later; such a prompt is not recalled.
    if (!trimmed || /\[Paste #\d+ · /u.test(trimmed)) return;
    promptHistory.record(trimmed);
    savedPrompts = [...savedPrompts.filter((item) => item !== trimmed), trimmed];
  };
  const historyPrompts = (): string[] => mergePromptHistory(savedPrompts,
    messages.filter((message) => message.role === 'user').map((message) => message.content));
  // GRAPH-VIEW-TRIGGER (개정 4): the turn's graph loops as an inline block in the conversation stream.
  const graphViewMode = graphViewSurfaceMode(process.env.ELANOUS_NEXT_TUI_GRAPH_VIEW);
  let graphView = createRunnerProgressProjector();
  // NODE-INNER-PROGRESS «추가» 4): the run ledger drives the tool row and progress row without a sidetab; a stalled
  // node queues its notice (childNotices exists by the time a turn observes a graph run).
  const nodeLivenessTui = createNodeLivenessTui({ root: effectiveInstanceRoot(),
    onStalled: (text) => { childNotices.graphNodeStalled(text); } });
  let executionModelBadge: string | undefined;
  let resolveExecutionModelBadge: (() => string | undefined) | undefined;
  let executionModelBadgeLoading = false;
  let tuiClosed = false;
  let welcomePending = true;
  let lastCompactCount: string | null = null;
  const compactHeight = nextTuiCompactHeight(process.env.ELANOUS_NEXT_TUI_COMPACT_HEIGHT, options.compactHeight);
  let compactMode = (process.stdout.rows || 24) <= compactHeight;
  // ⌨️ TUI-TYPING-LAG-OBS — compact 칠도 실제 화면 write 이므로 칠 훅을 건다(full-screen paintScreen
  // 의 훅과 같은 계약. 없으면 compact 모드에서 키가 쌓이고 1000ms ABANDON 로 버려져 줄이 0건이 된다).
  const compactPainter = createNextTuiCompactPainter((text) => { process.stdout.write(text); noteInputLagPaint(); });
  let busy = false;
  const activeShellCapsules = new Set<string>();
  const agentEvents = createAgentEventBridge(getAgentEventEmitter()); // ELN-AGENT-EVENT-PROTOCOL: no ELANOUS_EVENT_SOCKET → no-op
  // NEED-HUMAN-PUSH: the needs-person block is also pushed up the ladder (coordinator → OP → CEO card), one mail per block.
  const needsHuman = createNeedsHumanPush(createNeedsHumanDeps({ cwd: process.cwd(), resumeWith: () => { agentEvents.resume(); goalContinue?.noteHumanTurn(); } }));
  let outerElsArmed = false; // ELS-NESTING-RULE ③: the session already lives in an els pane; this eln closes and els takes the terminal
  let handoffExit = false;
  /** #38510 r1 MF1: every busy flip is a turn boundary the idle watchdog must see (set once it exists). */
  let onBusyFlip: (() => void) | null = null;
  // CAPSULE-C2 (flag on): the one turn door; a chat turn's end (busy → false) gives its reservation back.
  let entryDoor: EntryTurnDoor | null = null;
  // A ref, not a let: it is assigned inside the boot closure below, which a `let` narrowing would hide (TS2339 never).
  const seatStopRef: { current: ReturnType<typeof createSeatStopDriver> | null } = { current: null };
  let doorTurnKind: DoorTurnKind | undefined;
  // O2 (TC #94744): the bus's first consumer — a late one-shot the scheduler gave up on opens its turn through the door.
  let wakeupBusConsumer: WakeupBusConsumer | null = null;
  let wakeupBusTurn: string | null = null;
  // QUEUE-FINISH-FIRST (대표 11-24 12:4x) — the seat's own work finishes before ordinary mail opens a turn.
  const finishFirst = createQueueFinishFirst({ log: (category, event, data) => { debug.log(category, event, data); } });
  const setBusy = (next: boolean): void => {
    if (busy === next) return;
    busy = next;
    if (next) finishFirst.noteTurnStarted();
    agentEvents.busy(next);
    if (!next && wakeupBusTurn !== null) { wakeupBusConsumer?.settle(wakeupBusTurn, doorOutcomeOf(doorTurnKind)); wakeupBusTurn = null; }
    if (!next) { entryDoor?.endTurn(doorTurnKind); doorTurnKind = undefined; }
    // SEAT-GRACEFUL-QUIT-CONTROL: a quit/migrate that waited for this turn runs now (checkpoint → exit/restart).
    if (!next && seatStopRef.current) void seatStopRef.current.turnEnded().catch((error) => { debug.log('seat-stop', 'turn-end-failed', { error: String(error).slice(0, 200) }, { level: 'warn' }); });
    onBusyFlip?.();
  };
  let turnElapsedMs: number | undefined;
  /** ELN-TURN-END-STALL: signs of life from the running turn; a long silence with nothing running ends it. */
  let turnStallWatch = createTurnStallWatch({ now: () => performance.now(), limitMs: options.turnStallLimitMs });
  let turnStallHandled = false;
  let measuredUsage: { inputTokens?: number; outputTokens?: number } | undefined;
  let streamedOutputChars: number | undefined;
  let telemetrySessionId: string | null = null;
  let turnElapsedTimer: ReturnType<typeof setInterval> | null = null;
  let turnAbort: AbortController | null = null;
  let turnDone: Promise<void> | null = null;
  let humanQuitRequested = false;
  let scroll = 0;
  /** TUI-STICKY-SCROLLBACK: the last frame's row count, so a scrolled view keeps its top row as rows arrive. */
  let stickyMemo: StickyScrollMemo | null = null;
  /** Move the view back to the bottom only for the person's own action; a turn end never steals it. */
  const resetScroll = (cause: StickyScrollResetCause): void => {
    if (scroll <= 0) return;
    if (!stickyScrollResetAllowed(cause)) {
      debug.log('tui.scroll', 'reset-blocked', { cause, scroll, maxScroll, unseenRows: stickyMemo?.unseenRows ?? 0 }, { level: 'info' });
      return;
    }
    debug.log('tui.scroll', 'reset', { cause, scroll, maxScroll }, { level: 'info' });
    scroll = 0;
    if (stickyMemo) stickyMemo = { ...stickyMemo, unseenRows: 0 };
  };
  const applyWheel = (direction: 'up' | 'down'): void => {
    const before = scroll;
    scroll = wheelScroll(scroll, direction, maxScroll);
    debug.log('tui.scroll', 'wheel', { delta: direction === 'up' ? 'up' : 'down', from: before, scroll, maxScroll }, { level: 'debug' });
  };
  const prepareHistory = createNextTuiHistoryCache();
  const publicHistoryView = createNextTuiPublicHistoryView();
  /** Wall clock of the running turn's start — which saved answer is the running turn's own (public history ④). */
  let runningTurnStartedAt: number | undefined;
  // The compact path's retained-prefix measure gets its own slot so it never evicts the full history.
  const prepareRetainedHistory = createNextTuiHistoryCache();
  let compactSourcesCache: { messages: readonly SerializedMessage[]; sources: string[] } | null = null;
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
  let remoteSidetabRows: import('./sidetab/list.js').SidetabRow[] = [];
  let remoteSidetabRefreshPending = false;
  let elsSidetabRows: import('./sidetab/list.js').SidetabRow[] = [];
  // ELS-DESKTOP-SIDETAB-SUBSCRIBE: the server's push feed; null while the panel is closed. The 1 s timer polls only when it is not live.
  let elsFeed: import('./sidetab/els-subscribe.js').ElsFeed | null = null;
  let elsSidetabRefreshPending = false;
  let sidetabApi: typeof import('./sidetab/list.js') | null = null;
  const getSidetabViewMode = (): 'current' | 'all' | 'workspaces' => sidetabViewMode;
  const sidetabScope = () => getSidetabViewMode() === 'workspaces'
    ? { mode: 'workspaces' as const, expandedWorkspaceIds: [...expandedWorkspaceIds] }
    : undefined;
  // ⚠️ `as` 단언은 «null 로 좁혀지는» 흐름 분석을 푸는 것 — 값은 클로저(ensureSidetabAttachments) 안에서만 바뀐다.
  let sidetabAttachments: import('./sidetab/attach.js').SidetabAttachmentController | null = null as import('./sidetab/attach.js').SidetabAttachmentController | null;
  let workspaceInput: ReturnType<typeof import('./sidetab/workspace-input-controller.js').createWorkspaceInputController> | null = null;
  let refreshWorkspaceInputRows: typeof import('./sidetab/workspace-input-controller.js').refreshWorkspaceInputRows | null = null;
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
  // Only the typed assistant-text lane may preview in basic chat. Unclassified
  // child output stays in the explicit diagnostic log; neither is persisted here.
  let streamPreview: { sessionId: string; text: string; assistantText: boolean } | null = null;
  let agents: AgentDisplay[] = [];
  /** Rows of the last `/resume` list — `/resume <n>` picks from what the user saw. */
  let lastResumeRows: import('../session/index.js').SessionMeta[] | null = null;
  // The async refresh callback fills this holder; its declared property type stays valid in the input loop.
  const atFileInput: { current: ReturnType<typeof import('./input/at-picker.js').createAtPickerPanel> | null } = { current: null };
  // ELN-QUEUE-ITEM-CONTROLS: per-item queue panel (Up on an empty composer while items wait).
  let queuePanel: { selected: number } | null = null;
  let queuePanelViewing: QueuePanelViewing | null = null;
  // NEXT-TUI-PROVIDER-PICKER-PLACEMENT: bare /provider opens this popup above the composer.
  let providerPicker: ReturnType<typeof import('./input/provider-picker.js').createProviderPickerPanel> | null = null;
  const isInternalWakeForeground = (): boolean => focus === 'input' && !sidetabFocused && !atFileInput.current?.isOpen
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
  // SEAT-STATE-ENUM: an approval prompt on screen = WAITING_APPROVAL/APPROVAL_PENDING for els, reported from the prompt's own
  // lifecycle (open → settled), not from the prompt text. A second request while one is up does not open a prompt.
  const reportedApprovalDecision: typeof shellApproval.beginDecision = (command, callId, kind, windowMs) => {
    const opens = !shellApproval.active();
    const decision = shellApproval.beginDecision(command, callId, kind, windowMs);
    if (!opens || !shellApproval.active()) return decision;
    agentEvents.approval(true);
    return decision.finally(() => { if (!shellApproval.active()) agentEvents.approval(false); });
  };
  // Owner publish approval (public URL screen): the child sends the URL as a structured field; Enter hands «acknowledged» back and the
  // screen closes — the owner's decision itself is polled in the child. Logic and tests live in ./publish-approval-session.js.
  const publishApproval = createPublishApprovalHost({
    setStatus: (line) => { status = line; },
    render: () => render(),
    openUrl: (url) => openPublishApprovalUrl(url),
    columns: () => Math.max(1, (process.stdout.columns || 80) - (sidetabOpen && sidetabApi ? sidetabApi.sidetabWidthForTerminal(Math.max(1, process.stdout.columns || 1)) : 0)),
  });
  let interviewPreviousEditor: InlineEditorState | null = null;
  const interviewDraftText = () => interviewPreviousEditor?.text ?? '';
  const harnessAskUser = createHarnessAskUserSession({
    sessionId: () => id,
    canBegin: () => !tuiClosed && !shellApproval.active(),
    onBegin: () => { interviewPreviousEditor = input.editor; input.setText(''); focus = 'input'; },
    onSettled: () => { if (interviewPreviousEditor) input.setEditor(interviewPreviousEditor); interviewPreviousEditor = null; },
    setStatus: (line) => { status = line; },
    render: () => render(),
  });
  const activeShellCalls = new Map<string, NextTuiActiveShellCall>();
  const activeToolCalls = new Map<string, string>();
  let visibleToolActivity: ToolActivityRow[] = [];
  // NEXT-TUI-TOOL-LOG-NOT-PINNED: reply-text offset at each tool start, and the settled turn's
  // tool rows anchored after its user message so they stay above the final answer.
  const toolTextOffsets = new Map<string, number>();
  // Every settled turn keeps its tool rows after its own user message, like classic's transcript.
  const settledTurnTools = new Map<string, { anchor: number; userContent: string; rows: ToolActivityRow[]; graph?: readonly GraphViewEvent[] }[]>();
  // TUI-ANSWER-VANISH-ON-TOOLCALL — pre-tool streamed lines a tool-round clear frame pulled off the
  // screen, kept as display-only rows under the turn's question (never persisted, never replayed to the model).
  const heldAnswerRows = new Map<string, { anchor: number; userContent: string; text: string }>();
  /** Every graph loop this session showed: settled turns first, then the running turn. */
  const sessionGraphViews = (): GraphLoopView[] => [...projectGraphLoopViews([
    ...(settledTurnTools.get(id ?? '') ?? []).flatMap((entry) => entry.graph ?? []), ...graphView.events]).values()];
  // GRAPH-VIEW-DETAIL-SIDETAB (개정 5): the detail panel lives in its own module; entry forwards keys and frames.
  const graphDetail = createGraphDetailController({ views: sessionGraphViews, render: () => render(), setStatus: (text) => { status = text; } });
  let settledInline: { key: string; map: Map<number, string[]> } | null = null;
  const shellActivitySnapshotRequest: { current: (() => boolean) | null } = { current: null };
  const pushNowRequest: { current: ((requestId: string) => boolean) | null } = { current: null };
  const pushNowCommit: { current: ((requestId: string) => boolean) | null } = { current: null };
  let shellEscSnapshotPending = false;
  let pushNowSnapshotPending = false;
  let pushNowRequestId: string | null = null;
  let pushNowPhase: 'checking' | 'committing' | null = null;
  const pushNowCommitting = (): boolean => pushNowPhase === 'committing';
  let pushNowRequestSerial = 0;
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
  /** NOTICE-FOLD-1LINE — notice rows opened by a click or the fold key, by row id (kept across renders and reloads). */
  const expandedNoticeRows = new Set<string>();
  /** The rows the last frame drew (display indexes) — a fold target's index resolves against these. */
  let lastFrameMessages: readonly SerializedMessage[] = [];
  let noticeOpenView: { from: readonly SerializedMessage[]; key: string; view: readonly SerializedMessage[] } | null = null;
  const messageBlockSessions = createMessageBlockSessionStore();
  let messageBlocks: MessageBlock[] = [];
  const turnEndMarkers = new Map<string, import('./chat/capsule-transcript.js').TranscriptMarker[]>();
  /** TUI-KEEP-TRANSCRIPT-ON-COMPACT — sessions compacted while shown here: their reloads keep the displayed rows. */
  const compactedDisplaySessions = new Set<string>();
  /** The rows to show after reloading `sessionId` from the store. A session compacted while on screen keeps every
   *  row already displayed (compaction shrinks the model context only); any other reload replaces as before. */
  const displayAfterReload = (sessionId: string, reloaded: SerializedMessage[] | undefined, at: string): SerializedMessage[] => {
    const merged = displayRowsAfterReload({ sameSession: id === sessionId, compacted: compactedDisplaySessions.has(sessionId),
      displayed: messages, reloaded: reloaded ?? [] });
    if (merged.keptMissing > 0) debug.log('tui.transcript', 'compact-display-kept', { at, sessionId, kept: merged.keptMissing });
    return merged.rows;
  };
  /** A same-session compaction: keep the shown rows, append the new ones and fold one marker at the compaction point. */
  const displayAfterCompaction = (sessionId: string, reloaded: SerializedMessage[] | undefined, compactStatus: string): SerializedMessage[] => {
    if (id !== sessionId) return reloaded ?? [];
    compactedDisplaySessions.add(sessionId);
    const merged = mergeDisplayAfterCompact(messages, reloaded ?? []);
    if (merged.compactionPoint >= 0)
      turnEndMarkers.set(sessionId, [...(turnEndMarkers.get(sessionId) ?? []),
        { afterMessageIndex: merged.compactionPoint, text: compactMarkerText(compactStatus), tone: 'dim' }]);
    debug.log('tui.transcript', 'compact-display-kept', { at: 'compact', sessionId, kept: merged.keptMissing, shown: merged.rows.length });
    return merged.rows;
  };
  let lastTurnEndStatus: { sessionId: string; text: string } | null = null;
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
  const advanceMessageBlockDetail = (blockId: string): void => {
    if (!id) return;
    const block = messageBlocks.find((candidate) => candidate.id === blockId);
    if (!block) return;
    const level = nextMessageBlockDetailLevel(block, messageBlockLevels.get(block.id) ?? 0);
    messageBlockLevels.set(block.id, level);
    if (level === 3 && block.detail?.rawRef && !messageBlockRawTexts.has(block.id)) {
      const trace = resolveMessageBlockRawTrace(loadSession(id)?.messages ?? [], block);
      if (trace) messageBlockRawTexts.set(block.id, formatMessageBlockRawTrace(trace));
    }
    saveMessageBlockSession();
  };
  let logWindow: { start: number; rows: number; columns: number; bodyTop: number; leadingBlankRows: number; foldTargets: readonly ({ kind: 'message'; id: string; start: number; end: number } | { kind: 'tool'; index: number; part?: number; start: number; end: number })[] } = { start: 0, rows: 0, columns: 80, bodyTop: 1, leadingBlankRows: 0, foldTargets: [] };
  let lastFoldTargetKey: string | null = null;
  /** NOTICE-FOLD-1LINE — the queue items' structured facts (count · senders · ledger ids) for the notice turn by notice id. */
  const noticeHeadMeta = new Map<string, import('../chat/interjection.js').QueueNoticeMeta>();
  const keepNoticeHeadMeta = (noticeId: string, text: string, entries: readonly { id: string; msgId?: number }[]): void => {
    if (noticeHeadMeta.has(noticeId)) return;
    const items = entries.map((entry) => queue.get(entry.id));
    const facts = entries.map((entry, at) => ({ ...(entry.msgId === undefined ? {} : { msgId: entry.msgId }),
      ...(items[at]?.mail ? { sender: items[at]!.mail!.sender } : {}), ...(items[at]?.capsuleFailed ? { failed: items[at]!.capsuleFailed } : {}) }));
    noticeHeadMeta.set(noticeId, queueNoticeMeta(facts, seatMailNoticeParts(text, items.flatMap((item) => item ? [item] : []))));
    if (noticeHeadMeta.size > 64) noticeHeadMeta.delete(noticeHeadMeta.keys().next().value!);
  };
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
    // ⌨️ TUI-TYPING-LAG-OBS — next TUI 의 칠은 이 paintScreen write 하나로 난다(render() 도
    // 최종적으로 여기를 지난다). 클래식의 tui-render-cache.ts:139 와 같은 칠 훅 — 이게 없으면
    // noteInputLagKey 로 쌓인 키가 1000ms ABANDON 로 버려져 tui.input-lag 줄이 0건이 된다.
    noteInputLagPaint();
  };
  const backgroundJobs = new BackgroundJobStatus(id);
  const backgroundSubscription: { stop?: () => void } = {};
  const capsuleSubscription: { stop?: (() => void) | null } = {};
  // [턴 근본 배선 #4b] B3 (CX-1 #89710/#90532/#90871 · always on): a running capsule's folded progress lines in the footer.
  const capsuleActivity = new CapsuleActivity(id ?? '');
  const capsuleActivitySubscription: { stop?: (() => void) | null } = {};
  const healthSubscription: { stop?: () => void } = {};
  let healthSnapshot: import('./chat/self-health-status.js').NextTuiSelfHealthSnapshot | null = null;
  let observedSessionId: string | null = null;
  // TUI-NEXT-QUEUE-AND-WAKE — what is submitted while busy waits here (the classic FIFO state) and
  // leaves one item per settle. A200: a chat line is also handed to the running turn as a steer (joins the
  // next model request); Esc leaves what is still queued as the next turn by itself, not back in the prompt.
  const queue = createNextTuiQueue({ turnLifeLog: emitTurnLife });
  // ELN-AGENT-EVENT-PROTOCOL residual (0.3.34 P0 · OP 결정 #136151): main wired only the busy flip — notice production
  // never reached the bridge (the cell's JUD-B HOLD note). Every producer funnels into queue.enqueueNotice, so one
  // wrap wires the whole real path (seat-mail, capsule-done, event-watch, ceo-ingress, sidetab, harness-child, graph-node).
  wireNoticeEvents(queue, agentEvents);
  let activeTurnRunId: string | null = null;
  const ceoNoticeRefs = new Map<string, CeoTurnRef>();
  // OP #122919 / JUD hold #122913 — the ACTUAL-INTAKE acknowledgements for dequeued notices:
  // the ceo ingress 👀 binds to a real turn accepting the notice as its input (notifyTurnIntake
  // from the dispatch site below), never to the queue's drain-time `delivered` transition
  // (that fires when the batch is handed to the caller that submits it — before acceptance).
  type TurnIntakeStatus = 'accepted' | 'failed' | 'cancelled';
  const turnIntakeListeners = new Set<(item: { id: string; status: TurnIntakeStatus; turn?: CeoAcceptedTurn }) => void>();
  const notifyTurnIntake = (id: string, status: TurnIntakeStatus, turn?: CeoAcceptedTurn): void => {
    for (const listener of turnIntakeListeners) {
      try { listener({ id, status, ...(turn ? { turn } : {}) }); } catch { /* a listener never breaks the intake dispatch */ }
    }
  };
  const onTurnIntake = (listener: (item: { id: string; status: TurnIntakeStatus }) => void): (() => void) => {
    turnIntakeListeners.add(listener);
    return () => { turnIntakeListeners.delete(listener); };
  };
  // Distinct sentinels: the loop owns them, nothing else reads them as keys.
  // queueWake is declared here, before the seat-mail watcher closes over it.
  const queueWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  // SEAT-GRACEFUL-QUIT-CONTROL (CX-12 #89832 · TC #89800/#89986): a seat-stop request exits the loop through this key
  // after the turn ended (quit · migrate) or after an abort (force). Ctrl+Q stays as the stuck-TUI rung, unchanged.
  const seatStopKey: Key = { name: '', ctrl: false, shift: false, raw: '' };
  const offSeatStop = await (async () => {
    const [{ createSeatControl }, { writeSeatControlHandoff }, { requestTuiSelfRestart }, { join }] = await Promise.all([
      import('../seat/seat-control.js'), import('../seat/seat-control-handoff.js'),
      import('../capture/tui-self-report.js'), import('node:path')]);
    const seatControl = createSeatControl({
      checkpoint: async (mode) => {
        const seat = detectSeat(process.cwd())?.seat;
        // ELS-BATON-AUTO-ON-RESTART: the OP TUI hands the OP lease to the acting seat right before it stops
        // (the server takes it back when the next OP TUI in this pane reports its build). Best effort, never blocks the stop.
        if (seat === 'OP' && process.env.ELANOUS_ELS_PANE && process.env.ELANOUS_ELS_SOCKET) {
          try {
            const { requestEls } = await import('../els/client.js');
            await requestEls(process.env.ELANOUS_ELS_SOCKET, { op: 'baton', action: 'auto-hand', reason: `seat-stop ${mode}`, exclude: [process.pid] }, 3_000);
          } catch { /* the pane-exit hook and update-all still hand it */ }
        }
        if (!seat || !id) return;
        await writeSeatControlHandoff(join(effectiveInstanceRoot(), 'seat-control'), driver.liveRequestId(),
          { seat, sessionId: id, mode, createdAt: new Date().toISOString() });
      },
      exit: () => { injectKey(seatStopKey); },
      // CX-12 #90980 + JUD-B #38765 ⓜ: the requestId of the stop that owns the door rides as a structured field
      // (no string parsing). The driver pins it at registration — a refused duplicate never rewrites it.
      migrate: (sessionId) => { const requestId = driver.liveRequestId(); requestTuiSelfRestart(`seat-stop:migrate:${sessionId}`, Date.now(), requestId ? { requestId } : undefined); injectKey(seatStopKey); },
      abort: () => { turnAbort?.abort(); },
    });
    const driver = createSeatStopDriver({ control: seatControl, busy: () => busy,
      capsulesActive: () => activeShellCapsules.size > 0 });
    seatStopRef.current = driver;
    return setSeatStopHandler(async (request) => {
      // JUD-B #38765 ⓜ: the driver owns the live requestId (pinned per request, restored on refusal) — this handler never writes it.
      const result = await driver.request(request, id ?? undefined);
      try { emitTurnLife('turn-life:seat-stop-requested', { requestId: request.requestId, mode: request.mode, busy, result, turnId: id ?? null }); } catch { /* observability is fail-open */ }
      return result;
    });
  })();
  // OBSERVE-TURN-EVENT-LIFECYCLE — 방금 꺼낸 재생 턴의 문 라벨(startChatTurn 관측이 텍스트로 대조해 읽는다).
  let turnStartLabel: { door: string; text: string; source?: string; itemId?: string; eventId?: string | number } | null = null; // 출처: #38804 — msgId(number)가 사슬 값으로 그대로 흐른다
  // IDLE-WAKE-SINGLE-DOOR — self-pull, graph, mail, and the event bundle knock here.
  const idleWakeDoor = createIdleWakeDoor({
    busy: () => busy,
    injectKey: (key) => injectKey(key as Key),
    queueWake,
    log: (event, data) => { debug.log('queue', event, data); },
    turnLifeLog: emitTurnLife,
  });
  /** CAPSULE-C2: notices a person's Enter displaced before their ledger opened — they go first at the next offer. */
  // CAPSULE-C2-FU: FIFO, not one slot — a second displaced notice never overwrites the first.
  const heldNotices: Parameters<typeof dispatchQueuedExternalEventOne>[0]['notice'][] = [];
  // A dequeued notice remains pending while its wire import is in flight.
  let noticesInFlight = 0;
  let doorHumanFirst: () => string | null = () => null;
  // TURN-FIELD-BUG-5: the key that submitted the last person turn is not «typing» once that turn ended.
  let humanTurnKeyAt = 0;
  // CAPSULE-FLAGS-REMOVE-DEFAULT: the one door is always on (the flag-off branches below go in R1b).
  {
    doorHumanFirst = () => humanFirstDetail({ draft: () => input.editor.text, unreadKeys: tuiPendingKeyCount,
      lastHumanKeyAt: tuiLastHumanKeyAt, now: Date.now, lastHumanTurnKeyAt: () => humanTurnKeyAt });
    entryDoor = createEntryTurnDoor({
      humanFirst: () => doorHumanFirst(),
      // CAPSULE-C2-FU: a person's queued line is not held for human-first (only notices · wakes are).
      nextIsHuman: () => queue.peekActionableKind() === 'user',
      // A ring at a turn end goes back through the key loop (never re-entrant inside setBusy).
      onOffer: (reason) => { if (reason === 'turn-end') injectKey(queueWake); else { queueIdleWatchdog.noteDispatch(); dispatchQueued(); } },
      // TC rule (OBSERVE-TURN-LIFE-DIAG-COMPLETE): every door step is a turn-life event; `token` correlates reserve → end.
      log: (event, data) => { try { emitTurnLife(`turn-life:${event}`, { stage: 'C2', ...data }); } catch { /* observability is fail-open */ } },
    });
    debug.log('turn-door', 'door-on', {});
  }
  // SEAT-NOTICE-BOOT-RACE (P0): a boot-wake opens the notice turn before the person has
  // said anything, and their first words were then absorbed as a steer into that auto
  // turn — the reply turn vanished. Until the person's first own turn starts, the
  // boot-wake is refused (logged) and the idle-stall still sends the item unattended.
  let personTurnStarted = false;
  // ELN-SEAT-IDLE-QUEUE-STALL — a knock can be dropped (busy · terminal not raw yet) or never sent (boot plan item):
  // the watchdog reads «idle ∧ queued» itself and wakes the same door key, with an event, after N seconds.
  const queueIdleWatchdog = createQueueIdleWatchdog({
    now: () => performance.now(),
    idle: () => !busy && !tuiClosed && queuePanel === null && doorHumanFirst() === null,
    // QUEUE-FINISH-FIRST — held mail is not a stall (it waits for the work on purpose; the starvation tick wakes it).
    queued: () => Math.max(0, queue.autoDispatchCount + heldNotices.length - finishFirst.heldActionableCount()),
    wake: (event) => {
      // SEAT-NOTICE-BOOT-RACE: the person has had no turn yet — refuse the boot-wake so
      // their first words are not steered into a notice turn that opened before them.
      // The watchdog logs boot-wake-refused; the 5 s idle-stall still sends the item
      // when the seat stays unattended, and the first settle dispatches it when attended.
      if (event === 'boot-wake' && !personTurnStarted) {
        debug.log('tui.next', 'boot-wake-person-first', { count: queue.count });
        return false;
      }
      return injectKey(queueWake);
    },
    log: (event, data) => { debug.log('queue', event, data, { level: 'warn' }); },
    stallMs: options.queueIdleStallMs ?? QUEUE_IDLE_STALL_MS,
  });
  onBusyFlip = () => { queueIdleWatchdog.noteTurnBoundary(); };
  queue.onEnqueued(() => { queueIdleWatchdog.noteQueued(); });
  let queueIdleTimer: ReturnType<typeof setInterval> | null = null;
  idleWakeDoor.register({ id: 'self-pull' });
  idleWakeDoor.register({ id: 'graph-node' });
  idleWakeDoor.register({ id: 'seat-mail' });
  idleWakeDoor.register({ id: 'external-event' });
  // [턴 근본 배선 #4a] B1: an unregistered source is refused by knock() — the capsule-done doorbell must be on the list.
  idleWakeDoor.register({ id: 'capsule-done' });
  idleWakeDoor.register({ id: 'event-watch' });
  // [턴 근본 배선] OP-CHANNEL-INGRESS ③ — the ceo ingress doorbell: an authenticated CEO frame
  // queued as this session's turn input knocks the same one idle door.
  idleWakeDoor.register({ id: 'ceo-ingress' });
  // [턴 근본 배선 #3] C3 (CC-4 #89716 · always on since CAPSULE-FLAGS-REMOVE-DEFAULT): one owner per seat mail, shared
  // by the watcher and the plan — the modules' own default instances are for tests only (CC-4 #90942).
  const seatMailAdapter: SeatMailAdapter | null = createSeatMailAdapter({ log: (event, data) => { debug.log('seat-mail', event, data); } });
  // Mail → decomposition → plan: the active plan item is a seat-mail notice in this queue (banner-less internal turn).
  try {
    const { createSeatMailPlanRuntime, createSeatPlanTurnLink, seatTaskQueueFromPromptQueue, resolveSeatId } = await import('./seat-mail-boot.js');
    const planSeat = options.seatPlanBootForTest;
    const recipient = resolveSeatId(planSeat?.cwd ?? process.cwd());
    const clockWriter = createLedgerReceiptWriter();
    const booted = createSeatMailPlanRuntime({ cwd: planSeat?.cwd ?? process.cwd(), ...(planSeat ? { deps: { home: planSeat.home } } : {}),
      queue: seatTaskQueueFromPromptQueue(queue, (messageId, eventId) => {
        if (recipient) clockWriter.recordStarted?.({ messageId, recipient, eventId });
      }), ...(seatMailAdapter ? { mailAdapter: seatMailAdapter } : {}) });
    if (booted.runtime) { seatPlan = booted.runtime; seatPlanLink = createSeatPlanTurnLink(booted.runtime); seatMailHeader = booted.header; }
  } catch { /* boot goes on without a plan */ }
  // #38031 (ELN-CHILD-NOTICE) — 사이드탭 미션 종결 알림 생산자(같은 (source,text) 중복 적입 억제).
  const childNotices = createChildNoticeProducers(queue);
  // OP #106762 ⓐ — 턴 중 이벤트가 배수돼 모델 입력에 실리면, 같은 사건의 대기 큐 노티스를 원본에서 지운다
  // (같은 msgId 는 세션 동안 한 번 · fail-open: 이미 떠난 항목은 조용히 넘어간다).
  const removeQueuedNotice = (match: { source: string; msgId?: number; text?: string; capsuleId?: string }): number => {
    if (match.source === 'capsule-done' && match.capsuleId) return queue.removeCapsuleDoneNotice(match.capsuleId) ? 1 : 0;
    const wanted = queue.items.filter((item) =>
      item.kind === 'notice' && item.source === match.source &&
      (match.msgId !== undefined ? item.msgId === match.msgId : match.text !== undefined && item.text === match.text));
    let removed = 0;
    for (const item of wanted) {
      try { queue.cancel(item.id, 'mid-turn-carried'); removed += 1; } catch { /* fail-open */ }
    }
    return removed;
  };
  type SeatMailSteerSource = { msgId: number; from: string; intent?: string | null };
  const steerRequest: { current: ((steerId: string, text: string, urgent?: boolean, seatMail?: SeatMailSteerSource) => boolean) | null } = { current: null };
  const steerRetract: { current: ((steerIds: readonly string[]) => void) | null } = { current: null };
  let steerSerial = 0;
  /**
   * JUD-B #129006: steer handle → ledger msgId for seat mail offered to the running child turn. The parent-local
   * mid-turn box is drained only by an in-process core turn; a Next TUI turn runs in the child, so busy-turn mail goes
   * over the same steer IPC a typed line uses (never urgent — no sender preempts). Applied → the queued notice is
   * carried (the watcher settles it at the turn end); not applied → the notice stays queued for the next turn.
   */
  const mailSteers = new Map<string, number>();
  // #38031 — 자리 우편 도착 감시(기본 15초 폴링 · 첫 관측은 기준선만). notice 는 이 큐에 그대로.
  // MF(r3): 핸들을 변수로 보존해야 showNextTui 종료(finally)에서 stop() 할 수 있다 — 버리면 TUI 를 닫아도 15초 폴링이 남는다.
  // Seat mail that lands during a turn stays a queued notice. The idle door (queueWake after settle)
  // opens it as the next turn; it is not offered to the running turn as a steer (#38193).
  // SEAT-INBOX B1-C — one notice per message (msgId) · receipts delivered (enqueue) · seen (queue delivered).
  const seatMailWatcher = createSeatMailArrivalWatcher(process.cwd(), queue, {
    heartbeat: { getSessionId: () => id },
    onArrived: ((inner) => (arrivals?: Parameters<typeof inner>[0]) => { needsHuman.noteArrivals(arrivals); inner(arrivals); })(seatMailOnArrived({
      busy: () => busy, injectKey: () => { idleWakeDoor.knock('seat-mail'); }, queueWake,
      // SEAT-MAIL-COALESCE-NOTICE — arrivals within 3s share one knock (one digest turn).
      schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      enqueueMidTurn: (event, onDrained) => {
        const offerSteer = (): boolean => {
          if (event.kind !== 'seat-mail' || !steerRequest.current) return false;
          // SEAT-STEER-PREEMPT ② (OP #132479 ②): 결정 우편(구조화 intent)은 urgent steer 로 제안돼 실행 중
          // 턴을 선점한다. 보안 계약(b5c5c3b3) 보존 — 보낸 자리 이름은 무시되고 결정은 intent 만으로 인식된다.
          const steerId = offerSeatMailSteer(event, (id, text, urgent, seatMail) => steerRequest.current?.(id, text, urgent, seatMail) === true, () => ++steerSerial);
          if (steerId === null) return false;
          mailSteers.set(steerId, Number(event.id));
          debug.log('tui.next', 'seat-mail-steer-offered', { msgId: Number(event.id), steerId });
          return true;
        };
        // QUEUE-FINISH-FIRST ⊕ QUEUE-P1-3MIN — while the seat's own work is open: P2 is held (the next continuation peeks
        // it); a P1 joins the running turn at the next step boundary (steer · after the running tool batch, never cutting
        // a tool) once it has waited 60 s — a decision at once. P0 and related mail keep the steer path unchanged.
        if (event.kind === 'seat-mail' && finishFirst.holding()) {
          const msgId = Number(event.id);
          const item = queue.items.find((one) => one.kind === 'notice' && one.source === 'seat-mail' && one.msgId === msgId);
          const cls = item ? finishFirst.classify(item) : null;
          if (item && cls) {
            const action = midTurnMailAction(item, cls, true, Date.now());
            if (action.kind === 'held') {
              debug.log('tui.queue', 'held', { class: cls, waitedMs: 0, reason: 'work-in-progress', msgId, midTurn: true });
              return false;
            }
            if (action.kind === 'steer-at') {
              debug.log('tui.queue', 'held', { class: cls, waitedMs: 0, reason: 'p1-gate', msgId, midTurn: true, joinInMs: action.inMs });
              const timer = setTimeout(() => {
                const still = queue.items.find((one) => one.id === item.id && one.status === 'queued');
                if (!still) return;
                if (busy && offerSteer()) { finishFirst.noteP1Steered(still); return; }
                injectKey(queueWake);
              }, action.inMs);
              (timer as { unref?: () => void }).unref?.();
              return false;
            }
            if (cls === 'P1' && offerSteer()) { finishFirst.noteP1Steered(item); return true; }
          }
        }
        if (offerSteer()) return true;
        const sid = telemetrySessionId; return sid !== null && enqueueMidTurnEvent(sid, event, onDrained);
      },
      removeQueuedNotice,
    })),
    turnLifeLog: emitTurnLife,
    messages: { read: (cwd, afterId) => readSeatMailMessages(cwd, afterId), receipts: createLedgerReceiptWriter() },
    ...(seatMailAdapter ? { mailAdapter: seatMailAdapter } : {}),
  });
  // Project the actual watcher's health alongside the existing plan in every header render.
  const mailHeaderSeat = options.seatPlanBootForTest;
  seatMailHeader = createSeatMailHeaderHook(
    mailHeaderSeat?.cwd ?? process.cwd(),
    mailHeaderSeat ? { home: mailHeaderSeat.home } : {},
    seatPlan,
    seatMailWatcher,
  );
  try { seatMailWatcher.start(); } catch { /* the header exposes start-error without aborting the TUI */ }
  // SEAT-WORK-PULL (OP #139787 · part 4 mount) — an idle seat with no in-flight work pulls the
  // next roster cell on a periodic poll: claimed → one 'work-pull' notice + one queueWake inject
  // through the same idle door as seat mail; no-work → evidence line only (no notice, no turn).
  // The person-first gate is the boot-race rule: before the seat's own first turn, even the poll
  // stays silent. A non-seat TUI mounts nothing (detectSeat null → no polling at all).
  let workPullStop: (() => void) | null = null;
  if (options.workPullForTest !== null) {
    const workPullSeat = options.workPullForTest?.seat !== undefined
      ? options.workPullForTest.seat
      : (detectSeat(process.cwd())?.seat ?? null);
    try {
      const { mountSeatWorkPull } = await import('./seat-work-pull.js');
      workPullStop = mountSeatWorkPull({
        seat: workPullSeat,
        busy: () => busy,
        personTurnStarted: () => personTurnStarted,
        enqueueNotice: (text) => queue.enqueueNotice(text, 'work-pull', {}),
        injectKey: (key) => { injectKey(key as Key); }, queueWake,
        ...(options.workPullForTest?.pullDeps ? { pullDeps: options.workPullForTest.pullDeps } : {}),
        ...(options.workPullForTest?.intervalMs !== undefined ? { intervalMs: options.workPullForTest.intervalMs } : {}),
      });
    } catch { /* the pull is optional; the doors and mail still work */ }
  }
  // ELN-EXTERNAL-EVENTS-BETWEEN-TURNS — a harness child finishing, or a graph
  // node ending, stays a queued notice. The idle door opens only when nothing
  // is running; a running turn is never steered.
  const idleEventWake = createIdleEventWake({
    busy: () => busy,
    injectKey: () => { /* the single door knocks; this leaf only queues */ },
    queueWake,
    enqueueChild: (info) => childNotices.harnessChildFinished(info),
    enqueueGraphNode: (text) => childNotices.graphNodeStalled(text),
    enqueueGraphRun: (text) => childNotices.graphNodeStalled(text),
    childLabel: idleChildLabel,
    graphNodeText: graphNodeEndNotice,
    graphRunText: graphRunIdleNotice,
  });
  const { globalTaskNotificationQueue } = await import('../agent/task-notification.js');
  const offIdleChildWake = globalTaskNotificationQueue.onEnqueue((n) => {
    if (idleEventWake.onChild(n)) idleWakeDoor.knock('graph-node');
  });
  const { onGraphNodeLifecycle, onGraphRunIdleWake } = await import('../graph-runner/runner.js');
  const { graphProgressObservation } = await import('../graph-runner/graph-progress-observation.js');
  // A node end only queues. The knock is the run-level wake below (once).
  const offIdleGraphNode = onGraphNodeLifecycle((event) => {
    const observed = graphProgressObservation(event);
    if (observed) idleEventWake.onGraphNode(observed);
  });
  const offIdleGraphWake = onGraphRunIdleWake((wake) => {
    if (idleEventWake.onGraphRun(wake)) idleWakeDoor.knock('graph-node');
  });
  // ELS-GRAPH-LIVE-VIEW — inside an els pane (els sets ELANOUS_ELS_WS), this process's graph runs become a child tab in
  // that workspace: node chain in start order, node-progress as each line's note, ● ◐ ✕ from the last event.
  const elsGraphWs = process.env.ELANOUS_ELS_WS?.trim();
  let offElsGraph: () => void = () => {};
  if (elsGraphWs) {
    const [{ wireElsGraphProducer }, { requestEls }, { elsSocketPath }, { onGraphNodeProgress }] = await Promise.all([
      import('../els/graph-producer.js'), import('../els/client.js'), import('../els/server.js'), import('../graph-runner/runner.js')]);
    const producer = wireElsGraphProducer({ ws: elsGraphWs, socketPath: process.env.ELANOUS_ELS_SOCKET?.trim() || elsSocketPath(),
      cwd: process.cwd(), request: (socketPath, request) => requestEls(socketPath, request),
      sources: { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake } });
    offElsGraph = () => producer.dispose();
  }
  // OP-EVENT-WATCH-WAKE: 감시 줄이 큐에 들어가면 queueWake. spawn·줄 버퍼는 runner.
  const eventWatchWake: { current: (() => void) | null } = { current: null };
  // Read through a local so a literal-empty test env does not narrow the command to "".
  const eventWatchEnv = process.env.ELANOUS_EVENT_WATCH;
  const eventWatchCommand = (eventWatchEnv ?? '').trim();
  // ELANOUS_EVENT_WATCH_DEADLINE_MS is a duration. 600000 means ten minutes from now,
  // not an absolute epoch (that comparison expires the watch on the first tick).
  const { eventWatchDeadlineMs } = await import('./event-watch-deadline.js');
  const eventWatchDeadline = eventWatchDeadlineMs(process.env.ELANOUS_EVENT_WATCH_DEADLINE_MS, Date.now());
  const eventWatchStop: { current: (() => void) | null } = { current: null };
  /** Dequeued interruption belongs to the next actual chat turn, even if a notice yields the door. */
  let interruptContextFor: NextTuiQueueInterruptReason | null = null;
  /** mf1(#38102 r4): the notice dispatchQueued is about to open — consumed (and cleared) by startChatTurn. */
  let pendingNoticeTurn: {
    id: string;
    source: string;
    text: string;
    /** Poll time. The leaf records this as receivedAt, separate from injectedAt. */
    receivedAt: number;
    occurredAt?: number;
    /** The leaf's turn-end step. Entry does not import the receipt. */
    finish: (turnOk: boolean) => Promise<unknown>;
  } | null = null;
  /** ELN-QUEUE-SUPERSEDE — the queued text leaving now and the «대체 후보» model-context line its turn carries. */
  let replacementContextFor: { text: string; line: string } | null = null;
  /** The prompt text a queued submission displaced; it comes back once that submission is sent. */
  let restoreDraft: string | null = null;
  /** ⏰/↻ lines from the wakeup scheduler and the internal-turn door (newest last, at most three). */
  let notices: string[] = [];
  let internalNotices: string[] = [];
  eventWatchWake.current = () => { idleWakeDoor.knock('external-event'); };
  if (eventWatchCommand.length > 0) {
    void import('./event-watch-runner.js').then(({ startEventWatchRunner, attachEventWatchProcess }) => {
      const runner = startEventWatchRunner(queue, {
        command: eventWatchCommand,
        deadlineMs: eventWatchDeadline,
        onQueued: () => { eventWatchWake.current?.(); },
      });
      const attached = attachEventWatchProcess(runner, eventWatchCommand, { deadlineMs: eventWatchDeadline });
      eventWatchStop.current = () => { attached.stop(); };
    });
  }
  const internalWake: Key = { name: '', ctrl: false, shift: false, raw: '' };
  let wakeup: NextTuiWakeup | null = null;
  /** Binds the wakeup file to the current conversation; call after every `id` change (same id is ignored). */
  let bindWakeupSession: ((sessionId: string | null) => void) | null = null;
  let loopBranch: NextTuiLoopBranch | null = null;
  let decideBranchRoute: ((input: string) => string) | undefined;
  let pluginWizardFlow: ReturnType<typeof import('./branches/plugin-wizard.js').createPluginWizardFlow> | null = null;
  // TURN-END-BEFORE-GOAL — 답이 약속만 하고 끝나면 깨움 문으로 한 턴 더(classic 과 같은 모듈 · 동적 로드).
  let goalContinue: ReturnType<(typeof dashboardRuntime)['createGoalContinue']> | null = null;
  /** SESSION-AUTOPILOT — the session's autopilot controller (state file in the memory store · created with the wake door). */
  let autopilot: import('../session-autopilot/autopilot.js').SessionAutopilot | null = null;
  /** The chip on the status line («🚗 AUTO · <goal> · next ⏰hh:mm») — refreshed on boot, turn end, tick and /autopilot. */
  let autopilotChip = '';
  /** A seat retro/bulletin rhythm already wakes this session (coordinators add no extra timer). */
  let autopilotRhythm = false;
  /** SEAT-PULL-ON-IDLE-LIVE — 골이 다음 턴을 안 열었을 때만, opt-in 자리의 빈 계획에서 칸 하나를 집는다. */
  let seatSelfPull: SeatPullAfterGoalDeps['hook'] = null;
  /** 이번 턴이 실패·취소로 끝났나 — 그런 턴은 이어가지 않는다. */
  /** 마지막으로 관측에 남긴 접힌 중간 답 수(next · 바뀔 때만 'folded' 한 줄). */
  let interimFoldedShown = 0;
  // TUI-NOTICE-QUIET: only act-on-it or failure notices reach the screen; the rest is logged (chat/notice-gate.ts).
  const noticeGate = createNoticeGate((kind, line) => {
    debug.log('tui.notice', 'suppressed', { kind, text: line.slice(0, 200) });
  });
  const pushNotice = (line: string): void => {
    notices = nextNoticeRows(notices, { kind: 'notice', line: safeStatusText(line) }, noticeGate);
  };
  const pushInternalNotice = (line: string): void => {
    internalNotices = [...internalNotices, safeStatusText(line)].slice(-3);
  };
  // STATUSLINE-WIRE: the footer is the declarative status line (src/statusline/next-tui.ts); a broken user
  // statusline.yaml falls back to the default with one notice.
  const { createNextTuiStatusline, compactFooterTurn, displayCwd } = await import('../statusline/next-tui.js');
  const { runningBuild } = await import('../pty-shell/tui-run-state.js');
  const footerBuild = runningBuild();
  const { createFleetSegment } = await import('../statusline/sources/machines.js');
  // STATUSLINE-SOURCES-RESPONSIVE: the fleet segment (sources/machines.ts) — polled after the first paint.
  // The build stamp needs a git call: it too is looked up after the first footer has been painted, not on the boot path.
  const fleetSegment = createFleetSegment({ onChange: () => render() });
  // TUI-STATUS-3ROW row 3: the LLM account snapshot — read from its cache file off the render path; a stale file starts
  // one background `elanous usage status-cache` child (sources/llm-usage.ts). Started after the first paint.
  const { createLlmUsageSource } = await import('../statusline/sources/llm-usage.js');
  const llmUsage = createLlmUsageSource({ onChange: () => render() });
  const footerStatusline = createNextTuiStatusline({ build: footerBuild, cwd: () => process.cwd(), fleet: fleetSegment.value,
    afterFirstPaint: () => {
      void import('../version/build-stamp.js').then(({ buildCommitTime }) => {
        // Paint again when the stamp arrived: an idle screen has no other event that would show it.
        if (footerStatusline.setCommitTime(buildCommitTime(footerBuild))) render();
      }).catch(() => { /* no stamp */ });
      fleetSegment.start();
      llmUsage.start();
    } });
  if (footerStatusline.warning) pushNotice(footerStatusline.warning);
  // OP-CHANNEL-INGRESS ②③ — els provisioned THIS tab's ceo ingress (socket + per-tab secret in
  // the env): host the listener; one authenticated frame becomes the session's TURN INPUT (front
  // of the queue, never shell typing) and knocks the idle door. Absent env → inactive (fail-soft).
  void import('../agent-events/ceo-ingress-entry.js').then(async ({ wireCeoIngressEntry }) => {
    const listener = await wireCeoIngressEntry(process.env, {
      enqueueNotice: (text, source, meta) => {
        const notice = queue.enqueueNotice(text, source, { occurredAt: meta?.occurredAt ?? Date.now() });
        if (meta?.ceo) ceoNoticeRefs.set(notice.id, meta.ceo);
        return notice;
      },
      knock: () => { idleWakeDoor.knock('ceo-ingress'); },
      // JUD hold #122410 — the queue's terminal leaves (cancelled/superseded refuse: never turn input).
      onTransition: (notify) => queue.onTransition((item) => {
        if (item.status === 'queued') return; // never at transition time — a structural guard only
        if (item.status === 'cancelled' || item.status === 'superseded') ceoNoticeRefs.delete(item.id);
        notify({ id: item.id, status: item.status });
      }),
      // OP #122919 / JUD hold #122913 — the 👀 binds to ACTUAL TURN INTAKE: the TUI's
      // acknowledgement that a real turn accepted the notice as its input. The queue's
      // `delivered` transition fires at drain hand-out — before submission — so the answer
      // (and els' 👀) waits on this channel instead (accepted → answer(0) / failed·cancelled → refusal).
      onIntake: (notify) => onTurnIntake(notify),
    });
    if (listener) debug.log('agent-events', 'ceo-ingress-entry-on', { socketPath: listener.socketPath });
  }).catch((error) => {
    debug.log('agent-events', 'ceo-ingress-entry-failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const observeSession = (
    sessionId: string,
    onBackground: typeof import('../tui-client/local-chat-turn.js').onLocalChatBackgroundStatus,
    onHealth: typeof import('../tui-client/local-chat-turn.js').onLocalChatSelfHealthStatus,
  ): void => {
    if (observedSessionId === sessionId) return;
    backgroundSubscription.stop?.();
    capsuleSubscription.stop?.();
    capsuleSubscription.stop = null;
    capsuleActivitySubscription.stop?.();
    capsuleActivitySubscription.stop = null;
    capsuleActivity.setSessionId(sessionId);
    // CAPSULE-B1 (D12) — a finished background capsule queues one notice and knocks the idle door.
    // Same lazily loaded modules as the status sources (already cached when a session is observed).
    void Promise.all([import('../tui-client/local-chat-turn.js'), import('./capsule-done-knock.js'), import('./shell-watch-knock.js')])
      .then(([chat, knock, watch]) => {
        if (observedSessionId !== sessionId || capsuleSubscription.stop) return;
        const stopDone = knock.wireCapsuleDoneKnock({
          sessionId, subscribe: chat.onLocalChatCapsuleEvent,
          enqueue: (event) => childNotices.capsuleDone(event, event.endedAt), knock: () => { idleWakeDoor.knock('capsule-done'); },
          busy: () => busy,
          enqueueMidTurn: (event, onDrained) => enqueueMidTurnEvent(sessionId, event, onDrained),
          removeQueuedNotice,
        });
        const stopWatch = watch.wireShellWatchKnock({ sessionId, subscribe: chat.onLocalChatCapsuleEvent,
          enqueue: (text, at) => queue.enqueueNotice(text, 'event-watch', { occurredAt: at }),
          knock: () => { idleWakeDoor.knock('event-watch'); },
        });
        const stopMigrationWait = chat.onLocalChatCapsuleEvent(sessionId, (event) => {
          if (event.kind !== 'shell') return;
          if (event.type === 'capsule-progress') activeShellCapsules.add(event.capsuleId);
          else activeShellCapsules.delete(event.capsuleId);
          // A pending migrate leaves through the normal turn-end door after the capsule-done notice turn.
        });
        capsuleSubscription.stop = () => { stopDone(); stopWatch(); stopMigrationWait(); };
        // B3: the same frames, folded per capsule (tool arguments and outputs never enter the view).
        // Restack note: main's new guard system (tuiClosed/observedSessionId/id — cf. the health
        // subscription below) applies here too, and this wiring stays AFTER the capsule-done /
        // shell-watch / migration-wait subscriptions so the existing cleanup order is untouched.
        capsuleActivitySubscription.stop = chat.onLocalChatCapsuleEvent(sessionId, (event) => {
          if (tuiClosed || observedSessionId !== sessionId || id !== sessionId) return;
          if (event.type === 'capsule-progress') {
            try { emitTurnLife('turn-life:capsule-progress-received', { capsuleId: event.capsuleId, sessionId, kind: event.kind }); } catch { /* observability is fail-open */ }
          }
          // CAPSULE-FOOTER-ONCE (대표 11-24 13:0x): a finished capsule leaves the footer and is written once into the transcript now.
          const finished = capsuleActivity.accept(event);
          if (finished && messages.length > 0) {
            turnEndMarkers.set(sessionId, withCapsuleDone(turnEndMarkers.get(sessionId) ?? [], messages.length - 1, finished));
            debug.log('tui.capsule', 'done-to-transcript', { kind: finished.kind, status: finished.status, seconds: finished.seconds, afterMessageIndex: messages.length - 1 });
          } else if (finished) debug.log('tui.capsule', 'done-no-anchor', { kind: finished.kind, status: finished.status, line: finished.line.slice(0, 200) });
          render();
        });
      }).catch(() => { /* the doorbell is optional; the next-turn drain still delivers the result */ });
    healthSubscription.stop?.();
    healthSnapshot = null;
    backgroundSubscription.stop = onBackground(sessionId, (frame) => {
      if (frame === null) backgroundJobs.clear();
      else if (backgroundJobs.accept(frame) && id === sessionId) {
        try {
          agents = reconcileNestedAgentSnapshot(agents, (JSON.parse(frame) as { nestedAgents?: unknown }).nestedAgents);
        } catch { /* background status has its own validator */ }
      }
      if (id === sessionId && !busy) {
        session = loadSession(sessionId);
        vanishReload ??= 'session-reload';
        messages = session ? displayAfterReload(sessionId, session.messages, 'background') : messages;
      }
      render();
    });
    healthSubscription.stop = onHealth(sessionId, (snapshot) => {
      if (tuiClosed || observedSessionId !== sessionId || id !== sessionId
        || (snapshot && snapshot.sessionId !== sessionId)) return;
      if (snapshot && healthSnapshot && snapshot.capturedAt < healthSnapshot.capturedAt) return;
      healthSnapshot = snapshot;
      render();
    });
    observedSessionId = sessionId;
  };
  // MISSION-FABRIC-REMOVAL(대표 11-05) — /mission 은 지웠다. 미션 패브릭(autopilot 미션 스토어)은 시뮬레이션 장치로 새로 짓는다.
  const slashHandlers = new Map<string, (args: string[], context: SignalsSlashContext) => Promise<void>>();
  slashHandlers.set('signals', handleSignalsSlash);
  const handleStatus: NonNullable<ReturnType<typeof slashHandlers.get>> = async (_args, context) =>
    (await import('./branches/status.js')).runNextTuiStatusBranchRoute('/status', { addLines: (...lines) => context.chatLines.push(...lines), sessionId: id ?? undefined });
  slashHandlers.set('status', handleStatus);
  slashHandlers.set('st', handleStatus);
  slashHandlers.set('remaining', async (args, context) => (await import('./branches/remaining.js')).handleNextTuiRemainingSlash(args, context));
  // SESSION-AUTOPILOT — `/autopilot on [goal] | off | resume | hold | goals | status` calls the same controller as the tool.
  slashHandlers.set('autopilot', async (args, context) => {
    const { runAutopilotSlash } = await import('../session-autopilot/autopilot-slash.js');
    if (!autopilot) { context.chatLines.push('🚗 자율주행: 아직 준비 중 (깨움 문이 뜬 뒤 다시)'); return; }
    context.chatLines.push(...runAutopilotSlash(autopilot, args));
    refreshAutopilotChip();
    if (autopilot.isActive() && !busy) armAutopilotWake('slash');
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
  const { nextTuiShortStatus } = await import('./chat/status-line.js');
  // RAIL-STALE-TUI-HEAD: after a rail update this process may still run the old version dir; show
  // «⟳ 재기동 필요» before app_build hits the bridge head check. Checked at boot and on turn start only.
  const { codeRevision } = await import('../version/code-revision.js');
  const { createStaleInstallWatch, detectStaleInstall } = await import('../version/stale-install.js');
  const bootHead = codeRevision();
  const { startElsBuildReporter } = await import('../els/build-reporter.js');
  const stopElsBuildReporter = startElsBuildReporter(bootHead);
  const staleInstall = createStaleInstallWatch({ detect: () => detectStaleInstall({ runningHead: bootHead }) });
  staleInstall.check();

  // TURN-START-BLOCK-REST — 턴 경계 recorder: showNextTui → runLocalChatTurn 위임 턴의
  // 시작 경계(begin)와 첫 응답 경계(end · stream-open)를 세션 키로 열고 닫아
  // debug.log('tui.turn-start', 'segments', …) 줄 한 개로 남긴다. 박동은 전용 input-lag
  // 프로브(20ms·unref)의 것만 읽는다 — 키 지연 계측(noteKey/notePaint) 등록은 바로 아래
  // inputLagProbe 가 맡는다(별개 인스턴스 · 창이 겹친다). recorder·프로브 타이머는 모두 unref 라 teardown 이 기다리는 대상에 들지 않고, dispose 는
  // 부르지 않는다 — 닫힌 턴의 줄은 박동 두 번 뒤 지연 emit 되므로 dispose 가 그 줄을 끊는다.
  const turnStartBeats = createInputLagProbe({ log: () => {}, isBusy: () => busy });
  // ⌨️ TUI-TYPING-LAG-OBS — 키→칠 ms ⊕ 턴 시작 창 루프 지연(`tui.input-lag`) 등록. 클래식
  // 대시보드(src/dashboard/index.ts)와 같은 배선: 등록이 없으면 noteKey/notePaint 훅이
  // 전부 noop 이라 minim5 실측처럼 줄이 0건으로 나온다. heartbeat 는 위 turnStartBeats 것을
  // 재활용하지 않는다 — 등록 프로브가 칠까지 잰다(창이 겹친다). teardown 에서 해제·dispose.
  const inputLagProbe = createInputLagProbe({
    isBusy: () => busy,
    log: (category, event, data) => { debug.log(category, event, { ...data }); },
  });
  setInputLagProbe(inputLagProbe);
  dashboardRuntime.setTurnStartSegments(dashboardRuntime.createTurnStartSegments({
    beats: turnStartBeats.beats,
    log: (category, event, data) => { debug.log(category, event, data); },
    isBusy: () => busy,
  }));

  // ⌨️ TUI-NEXT-KEYSTROKE-COST (OP #132091 PR-1): idle 키 입력의 입력줄-only 빠른 칠 캐시.
  // 서명(문자열)+참조(메시지·에이전트·스트림·툴행·헬스)이 같고 TTL 안이면 프롬프트 행만 다시 조립해
  // paintScreen 으로 통과시키고 전신 재조립(prepareHistory → renderNextTuiEntryFrame)을 건너뛴다.
  // 칠 이외 입력이 바뀌면 서명이 어긋나 느긋한 전신 render() 로 돌아가고, 캐시는 TTL 뒤 만료돼
  // 배경 갱신(헬스·커밋시각·작업 칸 회전)의 오래된 화면 상한을 묶는다.
  type InputLineFastFrame = {
    sig: string;
    refs: { messages: readonly SerializedMessage[]; agents: unknown; streamPreview: unknown; visibleToolActivity: unknown; healthSnapshot: unknown };
    at: number; promptMaxRows: number; promptLineCount: number; promptRow: number;
    before: readonly string[]; after: readonly string[];
    compact?: { rowsAbove: number; headerLen: number; retained: number | undefined };
  };
  let inputLineFastFrame: InputLineFastFrame | null = null;
  const INPUT_LINE_FAST_TTL_MS = 1_000; // 캐시 수명(ms) — 배경 재칠 상한 (출처: #132091)
  const inputLineFastSig = (columns: number, rows: number, chatColumns: number, statusText: string, messagesLength: number,
    noticesJoined: string, internalJoined: string, activityJoined: string, queueCount: number, queueItems: number,
    bgRunning: number, bgPending: number, welcome: number, badge: string): string =>
    `${columns}│${rows}│${chatColumns}│${statusText}│${messagesLength}│${noticesJoined}│${internalJoined}│${activityJoined}│${queueCount}│${queueItems}│${bgRunning}│${bgPending}│${welcome}│${badge}`;

  // ⌨️ TUI-NEXT-KEYSTROKE-COST (OP #132091 PR-2): busy 칠 60fps 프레임 상한.
  // 스트리밍 델타(onPreview)·250ms 턴 타이머·상태줄 변경이 저마다 곧바로 render() 를
  // 부르면 한 프레임 안에 칠이 겹쳐 나간다(합성 실측 node-b · /tmp/fps-diag3-out.log: 최소 간격 2.8ms·8ms).
  // busy 중 칠은 이 게이트를 지난다: 마지막 칠로부터 한 프레임(16.7ms)이 지나지 않았으면
  // 프레임 경계로 미루고, 이미 예약된 칠이 있으면 합친다(마지막 상태로 한 번).
  // 턴 시작 첫 칠(A207 즉시)·종결 칠(onSettled)·idle 입력줄 칠(PR-1)은 게이트 밖 그대로다.
  const BUSY_FRAME_MS = 1_000 / 60; // 60fps 프레임 창(ms) = 1000/60 (출처: #132091)
  let busyFrameLastPaintAt = 0;
  let busyFrameScheduled = false;
  const renderBusyCapped = (): void => {
    const sinceLast = performance.now() - busyFrameLastPaintAt;
    if (sinceLast >= BUSY_FRAME_MS) {
      busyFrameLastPaintAt = performance.now();
      render();
      return;
    }
    if (busyFrameScheduled) return;
    busyFrameScheduled = true;
    setTimeout(() => {
      busyFrameScheduled = false;
      busyFrameLastPaintAt = performance.now();
      render();
    }, BUSY_FRAME_MS - sinceLast);
  };
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
      const footer = fitLogLine(` ${englishFooterText(status)} `, Math.max(1, columns));
      const body = remoteFrameRows(sidetabRemoteFrame, columns, rows - 1);
      paintScreen([...Array(Math.max(0, rows - 1 - body.length)).fill(''), ...body, `\x1b[7m${footer}\x1b[0m`], rows, 1, columns, rows);
      return;
    }
    const columns = process.stdout.columns || 0;
    const rows = process.stdout.rows || 0;
    if (columns < 20 || rows < 6) {
      paintScreen([fitLogLine('Terminal too small · q quit', Math.max(1, columns))], 1, 1, columns, rows);
      return;
    }
    // A narrow or short terminal has no room beside the chat: the requested detail covers the screen until Esc.
    const graphOverlay = graphDetail.overlay(columns, rows, compactMode);
    if (graphOverlay) {
      const footer = fitLogLine(` ${englishFooterText(status)} `, Math.max(1, columns));
      paintScreen([...graphOverlay, `\x1b[7m${footer}\x1b[0m`], rows, 1, columns, rows);
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
      stopElsFeed();
    }
    if (compactMode) setTuiMouseCapture(sidetabOpen);
    const sidetabWidth = sidetabOpen ? sidetabApi!.sidetabWidthForTerminal(columns) : 0;
    // GRAPH-VIEW-DETAIL-SIDETAB: the requested detail is a panel to the right of the chat.
    const graphDetailColumns = graphDetail.columns(columns);
    const chatColumns = columns - sidetabWidth - (sidetabOpen ? 1 : 0) - graphDetailColumns - (graphDetailColumns > 0 ? 1 : 0);
    // ⌨️ TUI-NEXT-KEYSTROKE-COST (OP #132091 PR-1): idle 입력줄-only 빠른 칠 — 서명·참조·TTL 이 모두 맞으면
    // 프롬프트 행만 다시 조립해 칠하고 전신 재조립을 건너뛴다(키→칠 p95 < 5ms 목표). 줄 수가 바뀌는 편집
    // (줄바꿈 발생)은 프레임 줄 수가 흔들리므로 느긋한 전신 경로로 돌아간다.
    if (inputLineFastFrame && !busy && !sidetabOpen && graphDetailColumns === 0 && scroll === 0 && focus === 'input'
      && !slashPicker && stopConfirmationSelection === null && !queuePanel && !providerPicker?.panel && !atFileInput.current?.panel
      && !shellApproval.active() && !harnessAskUser.active() && !streamPreview && !pendingEcho && !sidetabAttachments?.hasModal()
      && (compactMode ? inputLineFastFrame.compact !== undefined : inputLineFastFrame.compact === undefined)
      && inputLineFastFrame.refs.messages === messages && inputLineFastFrame.refs.agents === agents
      && inputLineFastFrame.refs.streamPreview === (streamPreview ?? null) && inputLineFastFrame.refs.visibleToolActivity === visibleToolActivity
      && inputLineFastFrame.refs.healthSnapshot === (healthSnapshot ?? null)
      && performance.now() - inputLineFastFrame.at < INPUT_LINE_FAST_TTL_MS) {
      const bgFast = backgroundJobs.snapshot();
      if (inputLineFastFrame.sig === inputLineFastSig(columns, rows, chatColumns, status, messages.length,
        notices.join('·'), internalNotices.join('·'), activity.join('·'), queue.count, queue.items.length,
        bgFast?.running ?? -1, bgFast?.pending ?? -1, welcomePending ? 1 : 0, executionModelBadge ?? '')) {
        const promptFast = composerViewport(input.editor, { columns: chatColumns, maxRows: inputLineFastFrame.promptMaxRows });
        if (promptFast.lines.length === inputLineFastFrame.promptLineCount) {
          const linesFast = [...inputLineFastFrame.before, ...promptFast.lines, ...inputLineFastFrame.after];
          if (compactMode && inputLineFastFrame.compact) {
            // Compact 칠도 같은 원리: 프롬프트 줄만 갈아끼워 캐시된 칠 인자로 viewport painter 를 통과시킨다.
            compactPainter.paint(linesFast, promptFast.cursorCol, rows, columns, inputLineFastFrame.compact.rowsAbove,
              inputLineFastFrame.promptRow + promptFast.cursorRow, inputLineFastFrame.compact.headerLen,
              undefined, undefined, inputLineFastFrame.compact.retained);
          } else {
            paintScreen(linesFast, inputLineFastFrame.promptRow + promptFast.cursorRow, promptFast.cursorCol, columns, rows);
          }
          return;
        }
      }
    }
    const backgroundLine = noticeGate.backgroundRow(backgroundJobs.line());
    const staleInstallLine = staleInstall.marker();
    noticeGate.noteSticky(staleInstallLine);
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
    // A «n steer pending» status follows the queue; a stale claim is corrected once and observed.
    const liveStatusForQueue = (): string => {
      const live = liveSteerStatus(status, queue.steerCount, busy);
      if (live.stale) {
        debug.log('tui.next', 'steer-status-stale', { shown: status.split(' · ')[0], steering: queue.steerCount, busy });
        status = live.text;
      }
      return live.text;
    };
    const title = fitLogLine(NEXT_TUI_TITLE, chatColumns);
    const seatHeadline = seatMailHeader(healthSnapshot, wakeup);
    const header = [title, seatHeadline ? fitLogLine(seatHeadline, chatColumns) : '─'.repeat(Math.max(0, chatColumns))];
    const rawTurnStatus = busy && activeShellCalls.size > 0
      ? 'Bash 실행 · Esc 취소'
      : busy && activeToolCalls.size > 0
        ? '도구 실행 · Esc 취소'
        : !busy && focus === 'log'
          ? `로그 탐색 · ↑↓ 스크롤${toolFoldBlockStarts(messages, chatColumns).length > 0 ? ' · Enter 접기/펼치기' : ''} · Esc 입력`
          : liveStatusForQueue();
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
    // B3: at most a few folded capsule rows, never more than the screen leaves for chat (CX-1 handoff patch).
    const capsuleLines = capsuleActivity.runningLines().slice(-Math.max(1, rows - 8));
    // TUI-STATUS-3ROW: the default bottom status is two rows on a tall screen (seat · work).
    const statusRowsActive = !footerStatusline.custom && footerStatusline.position === 'bottom';
    // Row 3 (accounts · host load) from 24 rows: cached numbers only (sources/llm-usage.ts · fleet poller hosts).
    const accountsRow = statusRowsActive && rows >= STATUS_THREE_ROWS_MIN_HEIGHT
      ? accountsRowLine({ snapshot: llmUsage.current(), hosts: fleetSegment.hosts(), nowMs: Date.now() }, chatColumns) : null;
    const statusRowCount = (statusRowsActive && rows >= STATUS_TWO_ROWS_MIN_HEIGHT ? (accountsRow ? 3 : 2) : 1) + capsuleLines.length + (backgroundLine ? 1 : 0) + (staleInstallLine ? 1 : 0);
    const attachmentRowLimit = Math.max(1, Math.min(6, rows - header.length - statusRowCount - 1));
    const attachmentBodyRows = Math.max(1, attachmentRowLimit - 1);
    contextAttachmentScrollStep = attachmentBodyRows;
    contextAttachmentScrollPages = Math.max(1, Math.ceil(attachmentContent.length / attachmentBodyRows));
    contextAttachmentScrollMax = (contextAttachmentScrollPages - 1) * attachmentBodyRows;
    contextAttachmentScroll = Math.max(0, Math.min(contextAttachmentScroll, contextAttachmentScrollMax));
    contextAttachmentScrollPage = Math.floor(contextAttachmentScroll / attachmentBodyRows) + 1;
    const attachmentOverflow = contextAttachmentScrollMax > 0;
    const rawAttachmentHint = attachmentOverflow && focus === 'input' && !atFileInput.current?.isOpen && !slashPicker && !activeShellApproval
      ? `Attachments ${contextAttachmentScrollPage}/${contextAttachmentScrollPages} · PgUp/PgDn`
      : null;
    const statusMinimumWidth = Bun.stringWidth(`실패·미·Q${queue.count}·B${backgroundTasks}`);
    const hintWidth = chatColumns - statusMinimumWidth - Bun.stringWidth(' · ');
    const attachmentHint = rawAttachmentHint && hintWidth > 0
      ? [
          rawAttachmentHint,
          `${contextAttachmentScrollPage}/${contextAttachmentScrollPages} PgUp/PgDn`,
          'PgUp/PgDn',
          `Attachments ${contextAttachmentScrollPage}/${contextAttachmentScrollPages}`,
          'Attachments',
        ].find((candidate) => Bun.stringWidth(candidate) <= hintWidth) ?? null
      : null;
    const statusWidth = Math.max(1, chatColumns - (attachmentHint ? Bun.stringWidth(`${attachmentHint} · `) : 0));
    const statusInput = {
      turnState: turnStatusBase,
      model: readNextTuiStatusModel(id ?? undefined, session?.meta),
      queued: queue.count + heldNotices.length,
      steering: queue.steerCount,
      backgroundTasks,
      width: statusWidth,
      elapsedMs: id === telemetrySessionId ? turnElapsedMs : undefined,
      measuredUsage: id === telemetrySessionId ? measuredUsage : undefined,
      // 출처: #37786 — classic의 본문 문자/4 추정과 공급자 실측 값을 구분한다.
      estimatedOutputTokens: busy && id === telemetrySessionId && streamedOutputChars !== undefined
        ? Math.ceil(streamedOutputChars / 4) : undefined,
    };
    const statusLineDrawn = footerStatusline.render(statusInput);
    // Logic below reads the old footer text (facts); the screen shows the whole declarative line.
    const statusLine = statusLineDrawn.facts;
    // QUEUE-FINISH-FIRST — one compact chip while ordinary mail waits for the current work.
    const heldChipText = heldChip(finishFirst.heldCount());
    // The turn-end summary replaces only the idle input status; log navigation keeps its own guide.
    // While the log is at the bottom the same text is already the transcript's turn-end marker, so the
    // footer repeats it only when the marker has scrolled out of view (no duplicate «Worked for» rows).
    const showTurnEnd = !busy && focus !== 'log' && scroll > 0 && lastTurnEndStatus?.sessionId === id;
    const scrollHint = stickyScrollHint(scroll, stickyMemo?.unseenRows ?? 0);
    const turnStatus = [scrollHint, showTurnEnd
      ? lastTurnEndStatus!.text : [statusLine, autopilotChip, heldChipText, attachmentHint].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
    const attachmentFooter = attachmentLines.length
      ? [attachmentLines[0]!, ...attachmentContent.slice(contextAttachmentScroll, contextAttachmentScroll + attachmentBodyRows)]
      : [];
    const withAttachmentFooter = (lines: string[]): string[] => [...attachmentFooter, ...lines];
    const livenessView = busy && id === telemetrySessionId ? nodeLivenessTui.view(Date.now()) : null;
    const graphFooterLine = nodeLivenessFooterLine(livenessView, graphProgressLine, chatColumns);
    const compactStatusInput = { ...statusInput, model: nextTuiFooterModel(id ?? undefined, statusInput.model, executionModelBadge), width: chatColumns };
    // DESIGN §2b (대표 11-18): the status line sits under the input, the last row, by default (`position: bottom`); the
    // progress row above the input says the turn, so while one runs the bottom line drops its turn clause.
    const statusAtBottom = footerStatusline.position === 'bottom';
    // Only a plain phase is dropped (the progress row says it); an action answer in the turn slot stays.
    const omitTurn = statusAtBottom && busy && nextTuiTurnIsPhase(statusInput.turnState);
    const compactTurnBase = showTurnEnd ? lastTurnEndStatus!.text : compactFooterTurn({
      welcomePending,
      // The attachment hint on its own (#38292 REVIEW-1 ①): glued after the footer sentence it was the first thing
      // cut on an 80-column line. (The old nextTuiCompactActionStatus passed the whole English sentence through —
      // «Turn Turn done …» — so the compact branch no longer uses it.)
      attachmentHint: [heldChipText, attachmentHint].filter(Boolean).join(' · ') || null,
      // At the bottom during a turn the progress row says the turn; the compact facts (children, hints) stay (#38392 REVIEW-1 ①).
      shortTurn: omitTurn ? '' : nextTuiShortStatus(compactStatusInput).turn,
      activeChildren: agents.filter(({ status: agentStatus }) => agentStatus === 'running' || agentStatus === 'background').length,
    });
    const compactTurn = scrollHint ? [scrollHint, compactTurnBase].filter(Boolean).join(' · ') : compactTurnBase;
    // NEXT-TUI-FOOTER-24-ROWS: the declarative line on compact screens too (cwd · version stay on an 80×24 terminal);
    // the compact-only facts take the turn's place (statusline/next-tui.ts compactFooterTurn). The compact line keeps
    // its model: the execution badge (the model the next turn will use) when known.
    const statusRow: string | undefined = rows <= compactHeight
      // While a turn runs the bottom line drops the turn's own fields; a replacement in the turn slot (children, a hint)
      // stays (#38392 r2 ②).
      ? footerStatusline.render(compactStatusInput, compactTurn, omitTurn).shown
      // The turn-end summary or the attachment hint replaces only the turn part; the cwd, the version and a user
      // layout's other segments stay (the declarative line is drawn again with that text in the turn's place).
      : turnStatus
        ? (turnStatus === statusLine
          ? (omitTurn ? footerStatusline.render({ ...statusInput, width: chatColumns }, undefined, true).shown : statusLineDrawn.shown)
          // During a turn at the bottom, a hint replaces the slot on its own (the sentence it was glued to is the turn).
          : footerStatusline.render({ ...statusInput, width: chatColumns },
            omitTurn && attachmentHint && !showTurnEnd ? attachmentHint : turnStatus, omitTurn).shown)
        : undefined;
    const statusFooter = [
      ...(staleInstallLine ? [fitLogLine(staleInstallLine, chatColumns)] : []),
      ...capsuleLines.map((line) => fitLogLine(line, chatColumns)),
      ...(backgroundLine ? [fitLogLine(backgroundLine, chatColumns)] : []),
      // ELS P0 (OP #127947 · #127912): each utterance waiting out the running turn gets its own dim row
      // above the input — the original text, the «나:» identity and the «대기 i/n» waiting mark — before
      // ↑ opens the queue panel; the panel's Enter edit is the full-text path for what a narrow row cut.
      ...queueWaitRows(queue.items, rows <= compactHeight).map((row) => C.dim(fitLogLine(row, chatColumns))),
      ...(busy && graphFooterLine && graphViewShowsHint(graphViewMode) ? [fitLogLine(englishFooterText(graphFooterLine), chatColumns)] : []),
      ...(rows > compactHeight && welcomePending ? [fitLogLine('Enter send · Esc cancel · Ctrl+Q quit', chatColumns)] : []),
      ...(statusRow !== undefined && !statusAtBottom ? [statusRow] : []),
    ];
    // TUI-STATUS-3ROW v1 (대표 11-24): with the default definition the bottom status is the seat row (autopilot · seat ·
    // goal · model once · build) over the work row (attention · turn state · counters); the turn's elapsed and tokens
    // live in the progress row above the input. A user statusline.yaml keeps the declarative line above.
    const bottomStatusRows: readonly string[] | undefined = statusRowsActive
      ? renderStatusRows({
          width: chatColumns, height: rows,
          attention: [scrollHint, showTurnEnd ? lastTurnEndStatus!.text : null,
            rows <= compactHeight && welcomePending ? 'Enter send · Esc cancel · Ctrl+Q quit' : null, heldChipText, attachmentHint],
          // The turn state stays a word in the work row (els reads «Turn running»); a plain phase during a turn is the
          // progress row's job.
          state: showTurnEnd || omitTurn ? '' : nextTuiShortStatus(compactStatusInput).turn,
          autopilot: autopilotChip, seat: displayCwd(process.cwd()).leaf,
          model: nextTuiShortStatus(compactStatusInput).model, build: footerStatusline.buildShort(),
          queued: statusInput.queued, steering: statusInput.steering, background: backgroundTasks,
          children: agents.filter(({ status: agentStatus }) => agentStatus === 'running' || agentStatus === 'background').length,
          needsHuman: needsHuman.activeBlockId() ? 1 : 0,
        }).rows
      : statusRow !== undefined && statusAtBottom ? [statusRow] : undefined;
    const bottomStatusRow = bottomStatusRows?.[0];
    if (queuePanel && queue.count === 0) { queuePanel = null; queuePanelViewing = null; }
    // ELS-QUEUE-WAIT-DISPLAY r2 (OP #128306 ② · JUD-B #128270): the read-only full-text view over the
    // queue list — v opens it, nothing here cancels or sends; Enter edit stays the list's own path. The
    // scroll is clamped to what fits and written back (queueFullTextView), so the cursor never floats.
    let queueViewLines: string[] | null = null;
    if (queuePanel && queuePanelViewing) {
      const viewing = queuePanelViewing;
      const viewMax = Math.max(1, Math.min(INLINE_PANEL_MAX_ROWS, rows - header.length - 2));
      const view = queueFullTextView(queue.items, viewing, chatColumns, Math.max(1, viewMax < 3 ? viewMax : viewMax - 2));
      if (!view) queuePanelViewing = null;
      else {
        viewing.scroll = view.scroll;
        queueViewLines = [
          fitLogLine(view.position ? `${view.title} · ${view.position}` : view.title, chatColumns),
          ...view.lines.map((line) => fitLogLine(line, chatColumns)),
          fitLogLine(view.hint, chatColumns),
        ];
      }
    }
    const panelSpec = queueViewLines
      ? null
      : queuePanel
      ? queuePanelSpec(queue.items, queuePanel.selected)
      : providerPicker?.panel
      ? providerPicker.panel
      : atFileInput.current?.panel
      ? atFileInput.current.panel
      : slashPicker
        ? {
            title: '/ Commands',
            rows: slashPicker.candidates.map((candidate) => ({ label: candidate.value, description: candidate.description })),
            selected: slashPicker.selected,
            hint: '↑↓ select · Tab complete · Enter run · Esc close',
          }
        : stopConfirmationSelection !== null
          ? {
              title: stopConfirmationKind === 'long-shell' ? 'Confirm stopping long shell' : 'Confirm stopping turn',
              rows: [{ label: 'y. stop' }, { label: 'n. continue' }],
              selected: stopConfirmationSelection,
              hint: 'y/n answer · default N · Enter=continue · Esc close',
            }
          : null;
    slashPickerVisible = Boolean(slashPicker && !atFileInput.current?.isOpen && !activeShellApproval);
    const footer = withAttachmentFooter(activeShellApproval
      ? [
          fitLogLine(englishFooterText(shellApprovalPromptTitle(activeShellApproval.kind)), chatColumns),
          ...approvalCommandLines.slice(approvalScroll, approvalScroll + approvalPageSize).map((line) => fitLogLine(line, chatColumns)),
          fitLogLine(`Command ${approvalScroll + 1}-${Math.min(approvalCommandLines.length, approvalScroll + approvalPageSize)} / ${approvalCommandLines.length} · ↑↓ view content`, chatColumns),
          fitLogLine(englishFooterText(shellApprovalPromptHelp(activeShellApproval.kind)), chatColumns),
        ]
      : queueViewLines
      ? queueViewLines
      : panelSpec
      // The panel gets only the rows left after the header, one conversation row and the input row; a six-row terminal is
      // `crowded` (title/hint/separator omitted, first candidate and the input stay visible) instead of clipping the top.
      ? formatInlinePanel({ ...panelSpec, title: englishFooterText(panelSpec.title), hint: englishFooterText(panelSpec.hint) },
        Math.max(1, Math.min(INLINE_PANEL_MAX_ROWS, rows - header.length - 2))).map((line) => fitLogLine(line, chatColumns))
      : statusFooter);
    // TUI-FOOTER-BREATHING-ROOM (대표 r2): on a roomy screen the bottom area breathes — ③ one margin row
    // after the conversation and ② one blank row above the input, the old separator right over the input,
    // the input, then ① a thin separator between the input and the bottom status line (DESIGN §2b keeps
    // the status line last). At or under the compact height, or when the footer (an approval, a panel)
    // leaves no room for the spare rows, they fold first ④ and today's tight layout stays: the
    // conversation keeps its minimum and the #38392 separator lock keeps its row.
    const breathingRoom = footerBreathingRoom({ rows, headerRows: header.length, footerRows: footer.length,
      compactHeight, bottomStatus: bottomStatusRows !== undefined });
    // The status line under the input stays with any panel open; only a screen too short for header · footer · input ·
    // status · one conversation row drops it (#38392 r2 ①, core/bottom-status.ts).
    // TUI-STATUS-3ROW: two status rows when they fit; a screen that cannot hold both keeps the work row (attention).
    const statusBlock = (shown: readonly string[]): string[] | null => shown.length > 0
      && keepBottomStatus({ rows, headerRows: header.length, footerRows: footer.length, statusRows: shown.length + (breathingRoom ? 1 : 0) })
      ? (breathingRoom ? [C.border('─'.repeat(chatColumns)), ...shown] : [...shown])
      : null;
    // Row 3 goes first when the screen is short of rows; then the seat row; the work row (attention) stays longest.
    const belowPrompt = bottomStatusRow !== undefined && bottomStatusRows
      ? (accountsRow ? statusBlock([...bottomStatusRows, accountsRow]) : null)
        ?? statusBlock(bottomStatusRows) ?? statusBlock(bottomStatusRows.slice(-1)) ?? []
      : [];
    if (breathingRoom) {
      footer.push('', '', C.dim('─'.repeat(chatColumns))); // ③ margin · ② blank · the separator over the input (the old rule stays, 대표 r2)
    } else if (rows - header.length - footer.length - belowPrompt.length >= 3) {
      // Reserve a transcript row and a prompt row before adding this decoration.
      // Use the current chat width so resizing and an open sidetab stay aligned.
      footer.push(C.dim('─'.repeat(chatColumns)));
    }
    // Keep title, status and at least one log row visible on ordinary small terminals.
    const interviewCall = harnessAskUser.active();
    const interviewLines = interviewCall ? harnessAskUserComposerLines(interviewCall)
      .flatMap(line => wrapLogLines(line, chatColumns)) : [];
    const interviewRows = Math.min(interviewLines.length, Math.max(0, rows - header.length - footer.length - belowPrompt.length - 2));
    const visibleInterviewLines = harnessAskUser.viewport(interviewLines, interviewRows);
    const promptMaxRows = Math.max(1, Math.min(6, rows - header.length - footer.length - belowPrompt.length - visibleInterviewLines.length - 1)); // Source: #36682
    const prompt = composerViewport(input.editor, { columns: chatColumns, maxRows: promptMaxRows });
    const promptLines = [...visibleInterviewLines, ...prompt.lines];
    const promptCursorRow = visibleInterviewLines.length + prompt.cursorRow;
    // Keep submitted user text visible until the session transcript catches up.
    const visibleMessages = pendingEcho && !messages.slice(pendingEchoStart).some((message) =>
      message.role === 'user' && message.content === pendingEcho!.content)
      ? [...messages, pendingEcho] : messages;
    const basicChat = focus === 'input';
    let displayedMessages: readonly SerializedMessage[] = visibleMessages;
    if (basicChat) displayedMessages = publicHistoryView(visibleMessages, busy, runningTurnStartedAt);
    // NOTICE-FOLD-1LINE — mark the open mails of notice rows (display only); the same array while none is open.
    const openKey = [...expandedNoticeRows].sort().join('\u0000');
    if (openKey.includes('#')) {
      if (noticeOpenView?.from !== displayedMessages || noticeOpenView.key !== openKey)
        noticeOpenView = { from: displayedMessages, key: openKey, view: withNoticeOpenParts(displayedMessages, expandedNoticeRows) };
      displayedMessages = noticeOpenView.view;
    }
    const reconciledAgents = reconcileAgentOutputStatuses(agents, messages, backgroundJobs.snapshot()?.tasks);
    const previewText = streamPreview?.assistantText
      ? nextAssistantPreviewText(streamPreview.text) : streamPreview?.text;
    // Keep a completed call until its corresponding saved result can render in detail.
    const shownToolRows = (rows: readonly ToolActivityRow[]) => basicChat ? rows : rows.filter((row) =>
      row.finishedAt === undefined || !hasDisplayableCompletedToolBlock(row.id, messageBlocks, visibleMessages));
    const liveToolRows = shownToolRows(visibleToolActivity);
    const streamingReply = busy && streamPreview?.sessionId === id && previewText
      && (!basicChat || streamPreview.assistantText);
    const agentLines = !basicChat ? [
      ...agentDisplayLines(reconciledAgents),
      ...reconciledAgents.map(agentDisplayLine),
      ...(backgroundJobs.taskLines?.() ?? []).map(safeStatusText),
    ] : [];
    // NEXT-TUI-TOOL-LOG-NOT-PINNED: tool rows and streamed text form one chronological flow.
    const displayActivity = withNodeLivenessToolRow(streamingReply
      ? [...agentLines, ...interleavedTurnLines(liveToolRows, toolTextOffsets, previewText!, performance.now(),
        (chunk) => streamReplyLines(chunk, chatColumns))]
      : [...toolActivityLines(liveToolRows, performance.now()), ...agentLines, ...activity],
    TOOL_RUNNING_GLYPH, livenessView, Date.now());
    // GRAPH-VIEW-TRIGGER: the live block sits under the turn's flow and above the working row, updated in place.
    if (busy && id === telemetrySessionId && graphViewShowsBlock(graphViewMode) && graphView.events.length > 0) {
      // 출처: 개정 4 «화면 높이 상한 넘으면 오래된 실행 블록부터 접음» — the chat area's upper half.
      const graphRows = Math.max(1, Math.floor(rows / 2));
      displayActivity.push(...graphViewTurnLines(graphView.events, chatColumns, graphRows, Date.now()));
    }
    // The footer hint already carries the liveness row in the hint modes; inline-only shows it under the block.
    const livenessRow = graphViewShowsHint(graphViewMode) ? undefined : nodeLivenessProgressRow(livenessView, chatColumns);
    if (livenessRow) displayActivity.push(livenessRow);
    // NEXT-TUI-WORKING-ROW: right under the streamed text, above the prompt — the turn is running.
    if (busy && id === telemetrySessionId) {
      const runningTool = runningToolLabel(liveToolRows);
      // TUI-STATUS-3ROW: the turn's tokens (↑in ↓out) ride on this row now, not on the bottom status.
      displayActivity.push(progressRowLine({
        phase: runningTool ? { kind: 'tool', ...runningTool } : streamingReply ? { kind: 'responding' }
          : (streamedOutputChars ?? 0) > 0 ? { kind: 'responding' } : { kind: 'thinking' },
        elapsedMs: turnElapsedMs ?? 0, queued: queue.count,
        inputTokens: measuredUsage?.inputTokens, outputTokens: measuredUsage?.outputTokens,
        estimatedOutputTokens: (streamedOutputChars ?? 0) > 0 ? Math.ceil(streamedOutputChars! / 4) : undefined,
      }, chatColumns));
    }
    let inlineInsertions: Map<number, string[]> | undefined;
    // nextTuiPublicHistory keeps saved indexes, so a raw user-message index anchors the displayed row.
    // TUI-ANSWER-VANISH-ON-TOOLCALL — held pre-tool lines render above the tool rows of the same turn.
    const heldInsert = heldAnswerRows.get(id ?? '');
    const heldLines = heldInsert && displayedMessages[heldInsert.anchor]?.role === 'user'
      && displayedMessages[heldInsert.anchor]?.content === heldInsert.userContent
      ? streamReplyLines(heldInsert.text, chatColumns) : [];
    const settledEntries: [number, string[]][] = [];
    let heldInserted = false;
    for (const { anchor, userContent, rows, graph } of settledTurnTools.get(id ?? '') ?? []) {
      const toolLines = toolActivityLines(shownToolRows(rows), performance.now());
      // A finished loop stays in the transcript as its folded line (a failed one keeps the failed node open).
      const graphLines = graph && graphViewShowsBlock(graphViewMode)
        ? graphViewTurnLines(graph, chatColumns, Number.POSITIVE_INFINITY, Date.now()) : [];
      const heldPrefix = anchor === heldInsert?.anchor ? heldLines.map((line) => nextTuiActivityRow(line, chatColumns)) : [];
      if (heldPrefix.length > 0) heldInserted = true;
      const lines = [...heldPrefix, ...toolLines, ...graphLines];
      // Compaction reloads and may re-index messages: attach only to the same user turn, never a neighbour.
      const anchored = displayedMessages[anchor];
      if (lines.length === 0 || anchored?.role !== 'user' || anchored.content !== userContent) continue;
      // Blank row before the answer, like after a user message; rows dim as in the live flow.
      settledEntries.push([anchor, [...heldPrefix, ...toolLines.map((line) => nextTuiActivityRow(line, chatColumns)), ...graphLines, '']]);
    }
    if (heldLines.length > 0 && heldInsert && !heldInserted) {
      const anchored = displayedMessages[heldInsert.anchor];
      if (anchored?.role === 'user' && anchored.content === heldInsert.userContent)
        settledEntries.push([heldInsert.anchor, [...heldLines.map((line) => nextTuiActivityRow(line, chatColumns)), '']]);
    }
    if (settledEntries.length > 0) {
      const key = settledEntries.map(([anchor, lines]) => anchor + '\u0000' + lines.join('\n')).join('\u0001');
      if (settledInline?.key !== key) settledInline = { key, map: new Map(settledEntries) };
      inlineInsertions = settledInline.map;
    }
    // Source: renderNextTuiLogFrame reserves one prompt row after header and footer.
    const firstScreen = nextFirstScreenLines({
      width: chatColumns,
      availableRows: Math.max(0, rows - header.length - footer.length - belowPrompt.length - promptLines.length),
      hasMessages: displayedMessages.length > 0,
      hasActivity: displayActivity.length > 0,
      hasNotices: notices.length > 0,
      hasDraft: input.editor.text.length > 0,
      busy,
    });
    const frameInput = { messages: displayedMessages,
      turnEndMarkers: turnEndMarkers.get(id ?? '') ?? [], expandMarkers: !basicChat,
      messageBlocks: (basicChat ? [] : messageBlocks).map((block) => ({
      block, level: messageBlockLevels.get(block.id) ?? 0, rawText: messageBlockRawTexts.get(block.id),
      afterMessageIndex: messageBlockAfterMessageIndexes.get(block.id),
    })), columns: chatColumns, rows,
      header, footer, belowPrompt,
      promptLine: prompt.line, promptLines, notices: basicChat ? notices : [...notices, ...internalNotices], activity: [...publishApproval.session.lines(), ...firstScreen, ...displayActivity], scroll,
      inlineInsertions,
      // NOTICE-FOLD-1LINE — notice rows open by row id in both views; tool blocks only in the log view (as before).
      expandedToolIndexes: foldExpandedIndexes(displayedMessages, basicChat ? null : expandedToolBlocks, expandedNoticeRows) };
    lastFrameMessages = displayedMessages;
    const prepared = prepareHistory(frameInput);
    const paintFrame = (input: typeof frameInput) => compactMode
      ? renderNextTuiCompactFrame(input, prepared)
      : renderNextTuiEntryFrame(input, prepared);
    let frame = paintFrame(frameInput);
    // TUI-STICKY-SCROLLBACK: rows appended below a scrolled view keep the same top row on screen.
    const stickyLayout = `${id ?? ''}|${chatColumns}|${basicChat ? 'chat' : 'log'}|${compactMode ? 'compact' : 'full'}`;
    const historyRows = frame.historyRows ?? 0;
    const anchored = anchorStickyScroll(scroll, stickyMemo, historyRows, stickyLayout);
    if (anchored.delta !== 0 && anchored.scroll !== scroll) {
      scroll = anchored.scroll;
      frame = paintFrame({ ...frameInput, scroll });
    }
    ({ scroll, maxScroll, logWindow } = frame);
    stickyMemo = { historyRows, layout: stickyLayout, unseenRows: scroll > 0 ? anchored.unseenRows : 0 };
    const { lines, promptRow } = frame;
    // TUI-ANSWER-VANISH ⑤ — a chat row on the last screen that is gone from this one is logged with its cause.
    try {
      const reload = vanishReload;
      vanishReload = undefined;
      const { onScreen, evaluated } = chatRowsOnScreen({ saved: visibleMessages, displayed: displayedMessages, screenLines: frame.body,
        tail: 8, renderRow: (row) => {
          const hit = vanishRowLines.get(row);
          if (hit && hit.columns === chatColumns) return hit.lines;
          const rendered = logViewLines([row], chatColumns);
          vanishRowLines.set(row, { columns: chatColumns, lines: rendered });
          return rendered;
        } });
      observeVanish({ sessionId: id ?? undefined, saved: visibleMessages, displayed: displayedMessages, onScreen, evaluated,
        scroll, userScrolled: scroll > 0, busy, ...(reload ? { reload } : {}),
        ...(vanishTurnDoor !== undefined ? { turnDoor: vanishTurnDoor } : {}),
        ...(vanishTurnSource !== undefined ? { turnSource: vanishTurnSource } : {}) });
    } catch { /* observability is fail-open */ }
    // ⌨️ TUI-NEXT-KEYSTROKE-COST (OP #132091 PR-1): idle 프레임(팝업 없음·스크롤 0·입력 포커스)이면
    // 다음 idle 키를 위해 프롬프트 주변(앞/뒤 줄)을 저장한다 — 서명 재료는 fast 경로와 동일 튜플.
    if (!busy && !sidetabOpen && graphDetailColumns === 0 && scroll === 0 && focus === 'input'
      && !slashPicker && stopConfirmationSelection === null && !queuePanel && !providerPicker?.panel && !atFileInput.current?.panel
      && !activeShellApproval && !interviewCall && !streamPreview && !pendingEcho && !sidetabAttachments?.hasModal()) {
      const bgSlow = backgroundJobs.snapshot();
      inputLineFastFrame = {
        sig: inputLineFastSig(columns, rows, chatColumns, status, messages.length,
          notices.join('·'), internalNotices.join('·'), activity.join('·'), queue.count, queue.items.length,
          bgSlow?.running ?? -1, bgSlow?.pending ?? -1, welcomePending ? 1 : 0, executionModelBadge ?? ''),
        refs: { messages, agents, streamPreview: streamPreview ?? null, visibleToolActivity, healthSnapshot: healthSnapshot ?? null },
        at: performance.now(), promptMaxRows, promptLineCount: promptLines.length, promptRow,
        before: lines.slice(0, promptRow - 1), after: lines.slice(promptRow - 1 + promptLines.length),
      };
    }
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
    graphDetail.noteChatFrame(lines, chatColumns, sidetabOpen && !compactMode ? sidetabWidth + 1 : 0);
    const chatScreenLines = sidetabOpen && !compactMode
      ? Array.from({ length: Math.max(lines.length, sidetabLines.length) }, (_, index) =>
          `${sidetabLines[index] ?? ' '.repeat(sidetabWidth)}│${lines[index] ?? ''}`)
      : lines;
    const screenLines = graphDetail.compose(chatScreenLines, columns, rows);
    if (compactMode) {
      if (compactSourcesCache?.messages !== displayedMessages || compactSourcesCache.sources.length !== displayedMessages.length)
        compactSourcesCache = { messages: displayedMessages, sources: displayedMessages.map((message) => JSON.stringify(message)) };
      const sources = compactSourcesCache.sources;
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
          retainedStableCount = prepareRetainedHistory(retainedInput).lines.length;
        }
      }
      const decorate = sidetabOpen ? (visible: readonly string[]): readonly string[] =>
        Array.from({ length: rows }, (_, index) => `${sidetabLines[index] ?? ' '.repeat(sidetabWidth)}│${visible[index] ?? ''}`) : undefined;
      const cursorCol = prompt.cursorCol + (sidetabOpen ? sidetabWidth + 1 : 0);
      if (frame.scroll > 0) compactPainter.paintViewport(screenLines, cursorCol, rows, columns, promptRow + promptCursorRow, decorate);
      else {
        compactPainter.paint(screenLines, cursorCol, rows, columns,
          header.length + prepared.lines.length, promptRow + promptCursorRow, header.length, decorate,
          boundaryKind ? { kind: boundaryKind, chatColumns, retainedStableCount } : undefined,
          geometry ? retainedStableCount : undefined);
        // A scrolled paint is temporary. Apply its pending geometry only when
        // the stable painter resumes at the tail.
        compactGeometry = { columns, rows, chatColumns, sources };
        compactReturnPending = false;
        // ⌨️ TUI-NEXT-KEYSTROKE-COST (OP #132091 PR-1): compact 안정 칠 직후의 칠 인자를 같이 저장한다 —
        // 이 스코프에만 geometry·retainedStableCount 가 산다.
        if (inputLineFastFrame) inputLineFastFrame.compact = {
          rowsAbove: header.length + prepared.lines.length, headerLen: header.length,
          retained: geometry ? retainedStableCount : undefined,
        };
      }
      // Compact chat has overwritten rows owned by the full-screen cache.
      // Reopening the sidetab must repaint every row, including unchanged text.
      screenPaintCache.invalidate(rows);
    }
    else {
      paintScreen(screenLines, promptRow + promptCursorRow, prompt.cursorCol + (sidetabOpen ? sidetabWidth + 1 : 0), columns, rows);
    }
    if (sidetabAttachments?.hasModal() && !paintingCoordinatorFrame) {
      sidetabAttachments.refresh();
      screenPaintCache.invalidate(rows);
      if (compactMode) compactPainter.invalidateViewport();
    }
  };

  const ensureSidetabAttachments = async (): Promise<void> => {
    if (sidetabAttachments) return;
    const installer = await import('../agent-mission/tool-install.js') as unknown as {
      detectAgentCli?: (agent: 'codex' | 'claude') => Promise<{
        agent: 'codex' | 'claude'; installed: boolean; version: string | null;
        login: 'ready' | 'needed' | 'unknown'; message: string;
      }>;
    };
    sidetabAttachments = (await import('./sidetab/attach.js')).createSidetabAttachmentController({
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
    const workspaceInputModule = await import('./sidetab/workspace-input-controller.js');
    refreshWorkspaceInputRows = workspaceInputModule.refreshWorkspaceInputRows;
    workspaceInput = workspaceInputModule.createWorkspaceInputController(ports);
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
    if (!sidetabOpen && !outerElsArmed) {
      // ELS-NESTING-RULE ③: a bare eln with a live els server puts els around this session (same session id, a pane).
      // Anything else — inside a pane, no server, a turn running, a failed hand-off — keeps the toggle below as it was.
      const handoff = await import('./els-handoff.js');
      const moved = await handoff.elnToggleHandoff({
        env: process.env, sessionId: id!, cwd: process.cwd(), busy, ...handoff.realToggleHandoffSeams(),
        armOuter: () => { outerElsArmed = true; return true; },
      });
      if (moved.kind === 'exit') { status = moved.message; handoffExit = true; injectKey(seatStopKey); return; }
      if ('message' in moved) status = moved.message;
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
      void tickElsSidetab();
      if (process.env.ELANOUS_REMOTE_SIDETAB === '1') void refreshRemoteSidetabRows();
      sidetabRefreshTimer = setInterval(() => {
        if (!sidetabOpen || !sidetabApi) return;
        refreshSidetabRows();
        refreshRichView();
        void tickElsSidetab();
        if (process.env.ELANOUS_REMOTE_SIDETAB === '1') void refreshRemoteSidetabRows();
        render();
      }, 1000);
    } else if (!sidetabOpen && sidetabRefreshTimer !== null) {
      clearInterval(sidetabRefreshTimer);
      sidetabRefreshTimer = null;
      stopElsFeed();
    }
  };

  const refreshSidetabRows = (): void => {
    if (sidetabApi) {
      const selectedId = sidetabRows[sidetabSelected]?.id;
      sidetabRows = [...sidetabApi.loadSidetabRows(getSidetabViewMode() === 'all', undefined, sidetabScope()), ...remoteSidetabRows, ...elsSidetabRows];
      const preservedIndex = selectedId ? sidetabRows.findIndex((row) => row.id === selectedId) : -1;
      sidetabSelected = preservedIndex >= 0
        ? preservedIndex
        : Math.min(sidetabSelected, Math.max(0, sidetabRows.length - 1));
      // A fresh selection never lands on an els tree header (ws / tab / host line, no pane address): it moves to the next row.
      const onElsHeader = (row: { kind: string; id: string } | undefined): boolean => row?.kind === 'els' && !row.id.startsWith('els:');
      if (preservedIndex < 0 && onElsHeader(sidetabRows[sidetabSelected])) {
        const next = sidetabRows.findIndex((row, index) => index > sidetabSelected && !onElsHeader(row));
        if (next >= 0) sidetabSelected = next;
      }
    }
    // Follow the row list. No local tab clears an automatic binding and returns.
    if (workspaceInput && refreshWorkspaceInputRows) refreshWorkspaceInputRows(workspaceInput);
    refreshRichView();
  };
  const toggleWorkspaceRow = (row: { id: string; kind: string }): boolean => {
    if (sidetabViewMode !== 'workspaces' || row.kind !== 'workspace') return false;
    if (expandedWorkspaceIds.has(row.id)) expandedWorkspaceIds.delete(row.id);
    else expandedWorkspaceIds.add(row.id);
    refreshSidetabRows();
    return true;
  };

  const elsRowActions = async (): Promise<import('./sidetab/els-actions.js').ElsRowActionDeps> => {
    const { federation } = (await import('./sidetab/els-subscribe.js')).realElsFederation();
    return { do: (address, text, from) => federation.do(address, text, from), read: (address) => federation.read(address),
      from: process.env.ELANOUS_TRACK?.trim() || process.env.ELANOUS_SEAT?.trim() || 'sidetab' };
  };
  const stopElsFeed = (): void => { elsFeed?.stop(); elsFeed = null; };
  // One panel tick for the els section: follow the server's push (subscribe op); poll `ls` only when the push is not live
  // (no server / older server / dropped) or on the slow heartbeat for the federated part. A feed that cannot be built polls.
  const tickElsSidetab = async (): Promise<void> => {
    try {
      const subscribe = await import('./sidetab/els-subscribe.js');
      if (!sidetabOpen) return;
      elsFeed ??= subscribe.realElsFeed(() => { void refreshElsSidetabRows().then(() => { if (sidetabOpen) render(); }); });
      if (!elsFeed.tick().poll) return;
    } catch { /* fall through to the plain poll */ }
    await refreshElsSidetabRows();
  };
  // The els server's spaces (ws/tab/pane, status words, ⇄host). Read-only: no server is started and none is stopped
  // when the panel closes; no answer means no rows.
  const refreshElsSidetabRows = async (): Promise<void> => {
    if (elsSidetabRefreshPending) return;
    elsSidetabRefreshPending = true;
    try {
      const subscribe = await import('./sidetab/els-subscribe.js');
      const next = await subscribe.fetchElsSidetabRows(subscribe.realElsSubscribeDeps());
      if (JSON.stringify(next) !== JSON.stringify(elsSidetabRows)) {
        elsSidetabRows = next;
        refreshSidetabRows();
      }
    } catch { /* els is optional; the other sections remain. */ }
    finally { elsSidetabRefreshPending = false; }
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
    setTuiForegroundSessionId(id);
    bindWakeupSession?.(id);
    restoreMessageBlockSession(targetId);
    lastFoldTargetKey = null;
    expandedNoticeRows.clear();
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
    observeSession(targetId, statusSources.onLocalChatBackgroundStatus, statusSources.onLocalChatSelfHealthStatus);
    goalContinue?.noteHumanTurn(); agentEvents.resume(); needsHuman.resumed();
    lastResumeRows = null;
    expandedToolBlocks.clear();
    activity = [];
    agents = [];
    activeShellCalls.clear();
    resetScroll('session-switch');
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
    // Keep filesystem picker code lazy; all query and dismissal state stays in the input branch.
    if (!atFileInput.current && !/(?:^|\s)@[\p{L}\p{N}_./~\\-]*$/u.test(input.editor.text.slice(0, input.editor.cursor))) return;
    if (!atFileInput.current) {
      atFileInput.current = (await import('./input/at-picker.js')).createAtPickerPanel(process.cwd());
      debug.log('tui.next', 'at-picker-module-loaded', { onDemand: true });
    }
    const nextStatus = await atFileInput.current.refresh(input.editor.text, input.editor.cursor);
    if (nextStatus) status = nextStatus;
    else if (status.startsWith('@ 파일')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
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
  const settle = (turn?: NextTuiSettledTurn): void => {
    // A path that ends without onSettled (never started) is «no answer»: a pending mail turn wakes again, never marked seen
    // by a later turn. After onSettled already reported, this is a no-op.
    wakeup?.noteTurnFinished(false);
    seatMailWatcher.noteTurnFinished(false);
    wakeup?.gate.noteTurnSettled();
    try { seatPlan?.absorb(); } catch { /* mail absorption never blocks a turn end */ }
    const noticePending = heldNotices.length > 0 || noticesInFlight > 0;
    const result = queue.settle(input.editor.text, turn, noticePending);
    // Held and importing notices live outside the queue and may be its only pending work.
    // Only the notice case moves the reason out of the queue: resubmit reasons stay queued for deliver() at the idle boundary,
    // so a later item's cancel leave() cannot strand them in entry scope and leak `reason:esc` into an unrelated turn.
    if (noticePending) {
      const reason = queue.takeResumeReason();
      if (reason !== undefined) interruptContextFor ??= reason;
    }
    if (result.kind === 'restore-original') {
      const draft = input.editor.text;
      input.setText(draft ? `${result.text}\n${draft}` : result.text);
      input.clearHistory();
      status = 'Response cancelled · sent text restored to the prompt · Enter to send';
      debug.log('tui.next', 'cancel-restore-original', { chars: result.text.length });
    } else if (result.kind === 'resubmit') {
      if (queuePanel) {
        // ELN-QUEUE-PANEL-CTRLC-RACE (2026-11-18): the queue panel is open, so the person is managing the queue.
        // Ctrl+C stops the turn and the items stay in the panel — the auto-drain must not race them (its synthetic
        // Enter would read as a panel action) and the stopped state stays on screen.
        status = `응답 중단됨 · 큐 ${result.count}건은 패널에 남음`;
        debug.log('tui.next', 'queue-resubmit-held-by-panel', { count: result.count });
      } else {
        status = `응답 취소됨 · 대기 ${result.count}건 다음 턴으로 자동 제출`;
        debug.log('tui.next', 'queue-resubmit-after-interrupt', { count: result.count });
        injectKey(queueWake);
      }
    } else if (result.kind === 'wake') injectKey(queueWake);
  };

  /** CAPSULE-C2: one notice through the door — kept (not opened) if a person takes the door during the import. */
  const dispatchNoticeThroughDoor = (notice: (typeof heldNotices)[number],
    reservation: import('../turn-capsule/contract.js').DoorReservation,
    bundled?: readonly (typeof heldNotices)[number][]): void => {
    noticesInFlight++;
    try {
      void dispatchQueuedExternalEventOne({
        notice,
        ...(bundled === undefined ? {} : { bundled }),
        onSeatMail: (oneId, oneText) => { seatPlanLink?.noticeDispatched(oneId, oneText); },
        injectKey: () => injectKey(queueWake),
        keepOpen: (one) => { pendingNoticeTurn = one; },
        // OP #122919 / JUD holds #122913 + #123230 — the intake ack rides the REAL turn acceptance
        // (startChatTurn taken), never the drain-time dequeue that handed this notice out, and never
        // a silent refusal: accepted → the honest 👀 moment; a throwing or REFUSED start → failed →
        // refusal (no 👀 for a no-op). The binding lives in startChatTurnWithIntakeAck (tested there).
        startChatTurn: startChatTurnWithIntakeAck({
          startChatTurn,
          notifyTurnIntake,
          acceptedTurn: () => id && activeTurnRunId ? { sessionId: id, turnRunId: activeTurnRunId } : undefined,
          noticeId: notice.id,
          render,
        }),
        log: (event, fields) => { debug.log('tui.next', event, fields); },
        held: () => entryDoor?.door.holds(reservation) === true,
        onSuperseded: () => { heldNotices.unshift(notice); },
        afterDispatch: () => { entryDoor?.releaseIfUnstarted(reservation); },
      }).finally(() => { noticesInFlight--; });
    } catch (error) {
      noticesInFlight--;
      throw error;
    }
  };

  /** O2: the door holds a reservation and nothing is queued — open one late wakeup from the bus (never twice). */
  const openLateWakeup = (): boolean => {
    const consumer = wakeupBusConsumer;
    const scheduler = wakeup?.scheduler;
    if (!consumer || !scheduler) return false;
    const result = openLateWakeupTurn({
      consumer,
      start: (event) => {
        turnStartLabel = { door: 'internal', text: event.text, source: 'scheduled', itemId: event.id, eventId: event.id };
        // JUD-B should (#38905): a start that throws must not leave this label for a later human turn with the same text.
        try { startChatTurn(event.text, continueBanner('scheduled'), { kind: 'system', origin: 'scheduled' }); }
        catch (error) { turnStartLabel = null; throw error; }
      },
      running: () => busy,
      cancel: (wakeupId) => scheduler.cancel(wakeupId),
      abort: () => { turnAbort?.abort(); },
      track: (eventId) => { wakeupBusTurn = eventId; },
      log: (event, data) => { try { emitTurnLife(`turn-life:${event}`, data); } catch { /* observability is fail-open */ } },
    });
    return result === 'opened' || result === 'cancel-refused';
  };

  /**
   * QUEUE-FINISH-FIRST — run the seat's own continuation at this idle boundary (goal-continue, else the OP requirement
   * continuation). It opens through {@link startContinuationTurn}; if nothing opens, the door is knocked again and the
   * leaf releases the held mail (continuation-not-started).
   */
  const queuedForFinishFirst = () => queue.items.filter((item) => item.status === 'queued');
  /**
   * QUEUE-FINISH-FIRST — every continuation (goal · requirement) opens here: while mail is held the turn carries
   * (A) the held-mail headline block (peek — every held mail is seen within one turn, bodies deferred) and
   * (B) related mail (a reply to what the work waits on · the seat's own child result) in full, taken off the queue.
   */
  const startContinuationTurn = (text: string, opts: StartTurnIfIdleOptions): StartTurnIfIdleResult => {
    const extras = finishFirst.continuationExtras(queuedForFinishFirst());
    const result = wakeup!.gate.startTurnIfIdle(`${text}${extras.suffix}`, opts);
    if (result.opened) {
      finishFirst.noteContinuationOpened();
      if (extras.relatedIds.length > 0) {
        const joined = queue.takeNotices(extras.relatedIds);
        debug.log('tui.queue', 'joined', { count: joined.length, msgIds: joined.flatMap((one) => (one.msgId === undefined ? [] : [one.msgId])), turnId: result.turnId });
      }
      if (extras.peeked > 0) {
        finishFirst.notePeeked(extras.heldIds);
        debug.log('tui.queue', 'peeked', { count: extras.peeked, turnId: result.turnId });
      }
    }
    return result;
  };
  /** QUEUE-FINISH-FIRST — `mail-reply:<id>` waits this seat armed (msg wait-for) — a reply to one joins the work. Fail-soft. */
  const armedMailReplyWaits = async (): Promise<number[]> => {
    try {
      const seat = detectSeat(process.cwd())?.seat ?? null;
      if (!seat) return [];
      const [{ listWakers }, { mailReplyId }] = await Promise.all([import('../msg/self-timer-watch.js'), import('../op-requirements/turn-end.js')]);
      return listWakers(seat).filter((w) => w.status === 'armed').flatMap((w) => mailReplyId(w.condition));
    } catch { return []; }
  };
  /**
   * QUEUE-P1-3MIN — the work a P1 paused resumes with one continuation (front of the line). Busy or refused → a few
   * short retries; the idle door's «continue» verdict also calls this first.
   */
  const resumePausedWork = (attempt = 0): boolean => {
    if (!finishFirst.resumePending()) return false;
    const retry = (): void => {
      if (attempt >= 6) return;
      const timer = setTimeout(() => { resumePausedWork(attempt + 1); }, 100 * 2 ** attempt);
      (timer as { unref?: () => void }).unref?.();
    };
    if (busy || !wakeup) { retry(); return false; }
    const result = startContinuationTurn(RESUME_PAUSED_WORK_PROMPT, { origin: 'goal-continue', reason: 'resume paused work' });
    if (result.opened) { finishFirst.noteResumed(result.turnId); return true; }
    retry();
    return false;
  };
  const runContinuationFirst = (): void => {
    if (resumePausedWork()) return;
    const knockAgain = (): void => { finishFirst.noteContinuationTried(); injectKey(queueWake); };
    let opened = false;
    try { opened = goalContinue?.isArmed() === true && goalContinue.check().opened; } catch { opened = false; }
    if (opened) return;
    const seat = detectSeat(process.cwd())?.seat ?? null;
    if (seat !== 'OP' || !wakeup) { knockAgain(); return; }
    void import('../op-requirements/turn-end.js')
      .then(({ runRequirementTurnEnd }) => runRequirementTurnEnd({ seat, humanTurn: null, startTurnIfIdle: startContinuationTurn,
        notify: (line) => { pushNotice(line); render(); } }))
      .then((req) => { if (!req.opened) knockAgain(); })
      .catch((error) => { debug.log('op.requirements', 'continue-first-failed', { error: String(error).slice(0, 200) }); knockAgain(); });
  };

  // ── SESSION-AUTOPILOT (대표 11-24) ─────────────────────────────────────────────────────────────────────────────
  // 관측 = debug.log('autopilot', on|off|pause|resume|stop|armed|goal-rolled|decided) · 인지 = controller.turnEnded ·
  // 수복 = arm a wake through the ScheduleWakeup scheduler (the same door as the model's own wakes) · human = pause.
  let autopilotTick: ReturnType<typeof setInterval> | null = null;
  let autopilotLastKeyAt = 0;
  const refreshAutopilotChip = (): void => {
    const next = autopilot ? autopilot.statusText() : '';
    if (next !== autopilotChip) { autopilotChip = next; render(); }
  };
  const noteAutopilotHuman = (): void => {
    if (!autopilot) return;
    try { autopilot.noteHuman(); autopilotLastKeyAt = tuiLastHumanKeyAt(); refreshAutopilotChip(); } catch { /* fail-open */ }
  };
  /** Arm one wake when autopilot is active and nothing is scheduled. Returns true when one was armed. */
  const armAutopilotWake = (why: string, plan?: { delayMs: number; reason: string }): boolean => {
    const scheduler = wakeup?.scheduler;
    if (!autopilot || !scheduler || !autopilot.isActive()) return false;
    if (scheduler.list().length > 0) return false;
    const delayMs = plan?.delayMs ?? 30 * 60_000;
    const result = scheduler.schedule({ delaySeconds: Math.round(delayMs / 1000), reason: plan?.reason ?? `🚗 자율주행: 목표를 향해 이어서 진행${autopilot.state().goal ? ` — ${autopilot.state().goal}` : ''}` });
    if (result.ok) autopilot.noteArmed(result.entry.id, result.entry.dueAt);
    else debug.log('autopilot', 'arm-failed', { why, error: result.error });
    refreshAutopilotChip();
    return result.ok;
  };
  const autopilotTurnEnded = (end: { from: import('../session/index.js').MessageSource | undefined; failed: boolean; failureSig?: string; fingerprint: string; openWork: boolean; continuationOpened: boolean }): void => {
    if (!autopilot) return;
    try {
      const scheduled = wakeup?.scheduler.list() ?? [];
      // Self-initiated = autopilot's own armed wake fired (scheduled origin · its wake id left the scheduler).
      // Mail · notice · person · retro turns are external events: never counted as autopilot volume.
      const ownWake = autopilot.ownWakeId();
      const selfInitiated = end.from?.kind === 'system' && end.from.origin === 'scheduled' && ownWake !== undefined && !scheduled.some((entry) => entry.id === ownWake);
      const verdict = autopilot.turnEnded({ selfInitiated, fingerprint: end.fingerprint, failed: end.failed,
        ...(end.failureSig !== undefined ? { failureSig: end.failureSig } : {}), openWork: end.openWork, rhythmActive: autopilotRhythm,
        ...(scheduled.length > 0 ? { scheduledWakeAt: scheduled[0]!.dueAt } : end.continuationOpened ? { scheduledWakeAt: Date.now() } : {}) });
      if (verdict.arm) armAutopilotWake('turn-end', verdict.arm);
      refreshAutopilotChip();
    } catch (error) { debug.log('autopilot', 'turn-end-failed', { error: String(error).slice(0, 200) }); }
  };
  const startAutopilot = async (): Promise<void> => {
    try {
      const [ap, { isCoordinatorSeat }, { releaseLedgerRoot }, { join }, { homedir }, { devVersion }] = await Promise.all([
        import('../session-autopilot/autopilot.js'), import('../seat/seat-role.js'), import('../instance/resolve.js'), import('node:path'), import('node:os'),
        import('../release-loop/checklist.js')]);
      const seat = detectSeat(process.cwd())?.seat ?? null;
      autopilot = ap.createAutopilot({
        file: ap.autopilotStateFile(process.cwd()),
        coordinator: isCoordinatorSeat(seat),
        standingGoal: (() => {
          // The release cycle source (plan status:current → schedule → package; published → next) · cached 60 s (sqlite read).
          let cached: { at: number; goal: ReturnType<typeof ap.resolveStandingGoal> } | null = null;
          return () => {
            if (cached && Date.now() - cached.at < 60_000) return cached.goal;
            const goal = ap.resolveStandingGoal({ hqRoot: join(homedir(), 'elanous-hq'), ledgerRoot: releaseLedgerRoot(), installedVersion: devVersion() });
            cached = { at: Date.now(), goal };
            return goal;
          };
        })(),
        ...(id ? { sessionId: id } : {}),
        raiseDecision: ap.raiseAutopilotDecision,
        postProgress: (goal, due) => { const cardId = ap.raiseGoalProgressCard(goal, due, id ?? undefined); pushNotice(`🚗 목표 임박 · ${goal.title} · ${due} — 진행 카드 ${cardId}`); },
        notify: (line) => { pushNotice(line); render(); },
      });
      autopilot.refresh();
      autopilotLastKeyAt = tuiLastHumanKeyAt();
      refreshAutopilotChip();
      autopilotTick = setInterval(() => {
        if (!autopilot) return;
        try {
          // A human keystroke since the last look = the person took the wheel.
          const key = tuiLastHumanKeyAt();
          if (key > autopilotLastKeyAt) { autopilotLastKeyAt = key; autopilot.noteHuman(); }
          autopilot.refresh();
          const resumed = autopilot.tick();
          if (resumed && !busy) armAutopilotWake('auto-resume', { delayMs: 60_000, reason: `🚗 자율주행 재개: 목표를 향해 이어서 진행${autopilot.state().goal ? ` — ${autopilot.state().goal}` : ''}` });
          refreshAutopilotChip();
        } catch (error) { debug.log('autopilot', 'tick-failed', { error: String(error).slice(0, 200) }); }
      }, 30_000);
      (autopilotTick as { unref?: () => void }).unref?.();
      if (autopilot.isActive() && !busy) armAutopilotWake('boot');
    } catch (error) { debug.log('autopilot', 'start-failed', { error: String(error).slice(0, 200) }); }
  };

  /** Sends the head of the queue through the ordinary idle submit path (slash commands included). */
  const dispatchQueued = (): void => {
    // ELN-QUEUE-PANEL-CTRLC-RACE (2026-11-23 r2): the one funnel every auto-drain knock reaches — the idle watchdog's
    // own doc (core/queue-idle-watchdog.ts): «the wake goes through the same key and the same dispatchQueued path as
    // every other knock» — so the settle's resubmit, the queue's turn-end knock (#38590) and the watchdog's stall wake
    // all land here. While the queue panel is open the person owns the queue: no auto-drain may open a turn over the
    // panel. Items stay put; the watchdog re-knocks after the panel closes. A person's own submit never passes here.
    if (queuePanel) {
      debug.log('tui.next', 'queue-dispatch-held-by-panel', { queued: queue.count });
      return;
    }
    if (queue.count > 0 && queue.autoDispatchCount === 0 && heldNotices.length === 0) {
      openLateWakeup();
      return;
    }
    // QUEUE-FINISH-FIRST — while the seat's own work is open, the continuation goes before ordinary (P1/P2) mail.
    // The verdict is the leaf's (decideIdleQueue); here it is only followed. A person's line / P0 still starts now.
    const finishVerdict = heldNotices.length === 0 ? finishFirst.decide(queuedForFinishFirst()) : { kind: 'pass' as const };
    if (finishVerdict.kind === 'hold') { render(); return; }
    if (finishVerdict.kind === 'continue') { render(); runContinuationFirst(); return; }
    // QUEUE-P1-3MIN — deliver-p1: the due P1s leave now (P2 and not-yet-due P1 stay held); open work pauses and resumes.
    const keepHeldIds = finishVerdict.kind === 'pass-unheld' || finishVerdict.kind === 'deliver-p1' ? new Set(finishVerdict.heldIds) : null;
    const pauseNote = finishVerdict.kind === 'deliver-p1' && finishVerdict.paused ? `\n\n${P1_PAUSE_NOTE}` : '';
    // CAPSULE-C2: reserve before the dequeue — the busy mark exists before the notice chain's await (D7).
    // CAPSULE-C2-FU: a person's line at the head goes before a held notice and is never refused for human-first.
    const door = entryDoor;
    if (!door) return;
    const opener = nextDoorOpener({ headKind: queue.peekActionableKind(), hasHeldNotice: heldNotices.length > 0 });
    const reservation = opener === 'person' ? door.reserveHuman() : door.reserveAuto();
    if (!reservation) return;
    const held = opener === 'held-notice' ? heldNotices.shift() : undefined;
    if (held) {
      keepNoticeHeadMeta(held.id, held.text, [held]);
      turnStartLabel = { door: 'queue-notice', text: held.text, source: held.source ?? undefined, eventId: held.msgId ?? held.id }; // 출처: #38804 — eventId = msgId ?? id(도착·큐·꺼냄 사슬과 같은 id · OP msg:93180)
      dispatchNoticeThroughDoor(held, reservation);
      return;
    }
    if (opener === 'none' && openLateWakeup()) return;
    // SEAT-NOTICE-BUNDLE-DRAIN (OP #128938 · OP 필수 #129540) — 쌓인 알림 전부를 한 턴 묶음으로 연다.
    // 사람 줄이 head면(opener 'person') 묶음을 돌리지 않는다: 그 reservation은 사람 dequeue·dispatch가 쓴다.
    // drainNotices는 head가 알림일 때만(opener 'queue-notice') — 사람 예약을 알림이 가로채지 않는다.
    if (opener === 'queue-notice') {
      const drained = queue.drainNotices(keepHeldIds ? (item) => keepHeldIds.has(item.id) : undefined);
      // QUEUE-FINISH-FIRST — a released digest goes P1 first (arrival order kept inside a class).
      const bundle = drained.kind === 'notices' ? { ...drained, notices: orderReleased(drained.notices, finishFirst.waits()) } : drained;
      if (keepHeldIds && bundle.kind !== 'notices') { door.releaseIfUnstarted(reservation); return; }
      if (bundle.kind === 'notices' && bundle.notices.length > 0 && finishVerdict.kind !== 'deliver-p1') finishFirst.noteMailTurn();
      if (bundle.kind === 'notices' && bundle.notices.length > 0) {
        const head = bundle.notices[0]!;
        // SEAT-MAIL-COALESCE-NOTICE — the bundle's seat mail is ONE digest (count + one line per mail · action bodies).
        const joined = `${seatMailBundleText(bundle.notices)}${pauseNote}`;
        keepNoticeHeadMeta(head.id, joined, bundle.notices);
        turnStartLabel = { door: 'queue-notice', text: joined, source: head.source ?? undefined, eventId: head.msgId ?? head.id }; // 출처: #38804 — eventId = msgId ?? id
        // OP #129546 ① — 묶음 30통이면 30통 전체가 이 dispatch 한 번에 결속된다(머리만이 아니라):
        // 각 항목은 제 id/msgId 사슬(#38804)을 그대로 가지고 plan link 에 제 본문으로 각각 닿는다.
        const bundled: readonly (typeof heldNotices)[number][] = bundle.notices.map((one) => ({
          id: one.id, text: one.text, remaining: bundle.remaining,
          ...(one.source === undefined ? {} : { source: one.source }),
          ...(one.occurredAt === undefined ? {} : { occurredAt: one.occurredAt }),
          ...(one.msgId === undefined ? {} : { msgId: one.msgId }),
        }));
        dispatchNoticeThroughDoor({ id: head.id, text: joined, remaining: bundle.remaining,
          ...(head.source === undefined ? {} : { source: head.source }),
          ...(head.occurredAt === undefined ? {} : { occurredAt: head.occurredAt }),
          ...(head.msgId === undefined ? {} : { msgId: head.msgId }) }, reservation, bundled);
        return;
      }
    }
    // 출처: main #39526 — 사람 preemption 사슬을 위해 dequeue 는 actionable 항목만 나간다(병합 보존).
    const handoff = queue.dequeueActionable();
    if (handoff.kind !== 'submit') {
      door.releaseIfUnstarted(reservation);
      return;
    }
    if (handoff.afterInterrupt) interruptContextFor ??= handoff.interruptReason ?? 'interrupt';
    // mf1(#38102 r4): a notice is not the person — it opens its own turn through the door (one notice, one turn,
    // one chain: dispatchQueuedExternalEventOne). The composer, the draft and noteHumanTurn are untouched; the model
    // alone sees the one-line source head («[notice · seat-mail]») on the turn it answers.
    if (handoff.itemKind === 'notice') {
      keepNoticeHeadMeta(handoff.id, handoff.text, [handoff]);
      // OBSERVE-TURN-EVENT-LIFECYCLE — 재생하는 알림의 문 라벨(비동기라 startChatTurn 이 텍스트로 대조).
      turnStartLabel = { door: 'queue-notice', text: handoff.text, source: handoff.source ?? undefined, eventId: handoff.msgId ?? handoff.id }; // 출처: #38804 — eventId = msgId ?? id(도착·큐·꺼냄 사슬과 같은 id · OP msg:93180)
      dispatchNoticeThroughDoor({ id: handoff.id, text: handoff.text, remaining: handoff.remaining,
        ...(handoff.source === undefined ? {} : { source: handoff.source }),
        ...(handoff.occurredAt === undefined ? {} : { occurredAt: handoff.occurredAt }),
        ...(handoff.msgId === undefined ? {} : { msgId: handoff.msgId }) }, reservation); // 출처: #38804 — held 재접수로 되돌아도 msgId 사슬 유지
      return;
    }
    // A queued person's line replays Enter, which takes the door as a person.
    door.releaseIfUnstarted(reservation);
    // 대기열에서 나가는 것도 사람이 쳐 둔 턴이다 — 골 이어가기의 연속·지문을 비운다(r3 must-fix).
    goalContinue?.noteHumanTurn(); agentEvents.resume(); needsHuman.resumed();
    finishFirst.noteHumanTurn();
    noteAutopilotHuman();
    personTurnStarted = true;
    const candidate = queue.replacementCandidate(handoff.id);
    const candidateOld = candidate ? queue.get(candidate.candidateFor) : undefined;
    // The old item's status at dispatch decides the wording (queued vs already delivered); cancelled → no line.
    const candidateLine = candidate && candidateOld
      ? replacementCandidateContextLine(candidate, candidateOld.text, candidateOld.status)
      : null;
    replacementContextFor = candidateLine ? { text: handoff.text.trim(), line: candidateLine } : null;
    // OBSERVE-TURN-EVENT-LIFECYCLE — 재생하는 대기 사용자 줄의 문 라벨(replay Enter → startChatTurn 이 읽는다).
    turnStartLabel = { door: 'queue-user', text: handoff.text, itemId: handoff.id, eventId: handoff.msgId ?? handoff.id }; // 출처: #38804 — eventId = msgId ?? id(itemId 는 #92565 규칙 그대로 · OP msg:93180)
    restoreDraft = input.editor.text;
    input.setText(handoff.text);
    focus = 'input';
    input.clearHistory();
    debug.log('tui.next', 'queue-dispatched', { length: handoff.text.length, remaining: handoff.remaining });
    replay.push(syntheticEnterKey);
  };

  /** Apply the execution-side snapshot captured when Esc was pressed. */
  const applyShellEscDecision = (): void => {
    shellEscSnapshotPending = false;
    const shellDecision = nextTuiShellEscDecision(activeShellCalls, monotonicNowMs());
    if (shellDecision !== 'confirm') {
      turnAbort?.abort();
      queue.markInterrupted('esc');
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
  // MSG-SOURCE-HIERARCHY: who sent the running turn (absent = a person at the keyboard).
  let turnFrom: import('../session/index.js').MessageSource | undefined;
  // CAPSULE-C2 (flag on): no turn without the door's reservation — two openers can never run two turns.
  // CAPSULE-C2-FU: a throw before setBusy(true) ends the door ('failed') instead of locking it forever.
  // JUD hold #123230 — return runDoorTurn's boolean: false = the door REFUSED the reservation (body
  // never ran, nothing threw) — the notice intake ack binds to that, never to silence.
  const startChatTurn = (turnText: string, banner?: string, from?: import('../session/index.js').MessageSource, workReferences?: readonly import('../core-turn/seat-owner-check.js').WorkReference[]): boolean =>
    runDoorTurn(entryDoor, () => busy, () => { startChatTurnBody(turnText, banner, from, workReferences); });
  const startChatTurnBody = (turnText: string, banner?: string, from?: import('../session/index.js').MessageSource, workReferences?: readonly import('../core-turn/seat-owner-check.js').WorkReference[]): void => {
    const turnRunId = randomUUID();
    activeTurnRunId = turnRunId;
    turnFrom = from;
    // SESSION-AUTOPILOT — the running turn's origin: goal writes in an autonomous turn become proposal cards.
    try { autopilot?.noteTurnStart(from?.kind === 'human' ? 'human' : 'auto'); } catch { /* fail-open */ }
    // SCHEDULE-WAKEUP-TURN-CAP: every real turn start gets its own gate turn id (notice/mail/queue turns skip the gate's open paths).
    wakeup?.gate.noteTurnStarted();
    // Which plan item (if any) this turn works for: a dispatched plan notice, or an automatic follow-up of one.
    const planChainNotice = seatPlanLink?.turnStarted(turnText, banner !== undefined) ?? null;
    activity = [];
    graphProgressLine = null;
    graphView = createRunnerProgressProjector();
    nodeLivenessTui.reset();
    agents = [];
    activeShellCalls.clear();
    activeToolCalls.clear();
    visibleToolActivity = [];
    toolTextOffsets.clear();
    stopConfirmationSelection = null;
    stopConfirmationKind = null;
    pushNowSnapshotPending = false;
    pushNowRequestId = null;
    pushNowPhase = null;
    const attachments = [...atAttachmentTokens].filter(([token]) => turnText.includes(token)).map(([, path]) => path);
    if (!id) {
      id = createSession({ source: 'tui' }).id;
      setTuiForegroundSessionId(id);
      bindWakeupSession?.(id);
      restoreMessageBlockSession(id);
      setActiveSessionId(id);
      session = loadSession(id);
      backgroundJobs.setSessionId(id);
    }
    const turnSessionId = id;
    // mf1(#38102 r4): only the exact notice text dispatched a moment ago claims the source head.
    const noticeTurn = pendingNoticeTurn !== null && pendingNoticeTurn.text === turnText ? pendingNoticeTurn : null;
    const ceoTurn = noticeTurn ? ceoNoticeRefs.get(noticeTurn.id) : undefined;
    if (noticeTurn) ceoNoticeRefs.delete(noticeTurn.id);
    const noticeSource = noticeTurn?.source ?? null;
    const noticeMeta = noticeTurn ? noticeHeadMeta.get(noticeTurn.id) : undefined;
    if (noticeTurn) noticeHeadMeta.delete(noticeTurn.id);
    pendingNoticeTurn = null;
    const replacementContextLine = replacementContextFor !== null && turnText.trim() === replacementContextFor.text
      ? replacementContextFor.line
      : null;
    replacementContextFor = null;
    let stopSteerApplied: (() => void) | null = null;
    staleInstall.check();
    setBusy(true);
    // OBSERVE-TURN-EVENT-LIFECYCLE — 턴 시작(재생·알림은 라벨 텍스트 대조, 아니면 human 문).
    try {
      const label = turnStartLabel;
      const matched = label !== null && label.text === turnText.trim();
      emitTurnLife('turn-life:turn-start', {
        door: matched ? label!.door : 'human',
        ...(matched && label!.source !== undefined ? { source: label!.source } : {}),
        ...(matched && label!.itemId !== undefined ? { itemId: label!.itemId } : {}),
        ...(matched && label!.eventId !== undefined ? { eventId: label!.eventId } : {}), // 출처: TC #92565 — 라벨 세터의 itemId 규칙 그대로 eventId 일치
        turnSessionId,
      });
      vanishTurnDoor = matched ? label!.door : 'human';
      vanishTurnSource = matched ? label!.source : undefined;
      if (matched) turnStartLabel = null;
    } catch { /* observability is fail-open */ }
    lastTurnEndStatus = null;
    telemetrySessionId = turnSessionId;
    const turnStartedAt = performance.now();
    const turnStartedWallAt = Date.now();
    runningTurnStartedAt = turnStartedWallAt;
    turnElapsedMs = 0;
    measuredUsage = undefined;
    streamedOutputChars = 0;
    if (turnElapsedTimer !== null) clearInterval(turnElapsedTimer);
    turnStallWatch = createTurnStallWatch({ now: () => performance.now(), limitMs: options.turnStallLimitMs });
    turnStallHandled = false;
    turnElapsedTimer = setInterval(() => {
      if (tuiClosed || !busy || id !== turnSessionId) return;
      turnElapsedMs = nextTuiElapsedMs(turnStartedAt, performance.now(), turnElapsedMs);
      // A silent turn that never ends keeps queued input waiting forever (E/D stall evidence): stop it like Esc.
      const verdict = turnStallWatch.check({ running: activeShellCalls.size + activeToolCalls.size
        + agents.filter((agent) => agent.status === 'running').length });
      if (verdict.stalled && !turnStallHandled && turnAbort && !turnAbort.signal.aborted) {
        turnStallHandled = true;
        debug.log('tui.next', 'turn.stalled', { sessionId: turnSessionId, idleMs: Math.round(verdict.idleMs), queued: queue.count,
          streamedChars: streamedOutputChars ?? 0, elapsedMs: Math.round(turnElapsedMs ?? 0) }, { level: 'warn' });
        queue.markInterrupted('stream-stall');
        turnAbort.abort('stall');
        status = `No output for ${stallMinutes(verdict.idleMs)} min · turn stopped${queue.count > 0 ? ' · queued input is sent next' : ''}`;
      }
      renderBusyCapped();
    }, 250);
    // herdr pane 이면 턴 시작·끝을 working → idle 로 신고한다(`eln herdr prompt --wait` 가 이것을 기다린다).
    // 녹음기는 startTuiSelfReport 가 이미 열었다 — 없으면 아무것도 안 한다.
    reportTuiTurn('busy');
    // 턴 시작도 진전이다(SURVIVAL-PROGRESS-CLOCK) — 마지막 진전 시각의 0초를 잡는다.
    reportTuiProgress();
    // An internal turn says where it came from (classic «↻ 자동 재개(<origin>): <이유>») instead of looking typed.
    // TUI-GOAL-INTERIM-QUIET — the log draws a recognized internal input in place («↻ 자동 재개(<origin>)»), so the
    // notice list would only repeat it under the last reply; the status line still names it while the turn runs.
    // A207 — the running status is immediate (a turn that never opens must still say it is
    // running). Only «↻ Continuing» waits until the turn handle has actually returned.
    status = '응답 중 · Esc 취소';
    render();
    dashboardRuntime.beginTurnStartSegments(turnSessionId);
    // 이번 턴이 만든 답만 골 이어가기 판정에 쓴다 — 시작 때 세션 길이를 잡아 둔다.
    const messagesAtTurnStart = messages.length;
    const turn = startNextTuiTurn({ sessionId: turnSessionId, text: turnText }, {
      run: async ({ sessionId, text, signal }, onDelta, onCompact, onNotice, onAgent, onStatus, onMessageBlock) => {
        const { runLocalChatTurn, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus, requestLocalChatShellActivitySnapshot, requestLocalChatPushNow, commitLocalChatPushNow,
          requestLocalChatSteer, retractLocalChatSteer, onLocalChatSteerApplied } = await import('../tui-client/local-chat-turn.js');
        // A207 — a cancel that lands while the module is loading never starts the chat turn,
        // and never paints «↻ Continuing». The running status was already drawn above.
        if (signal.aborted || id !== turnSessionId) return { goalComplete: false };
        shellActivitySnapshotRequest.current = () => requestLocalChatShellActivitySnapshot(sessionId);
        pushNowRequest.current = (requestId) => requestLocalChatPushNow(sessionId, requestId);
        pushNowCommit.current = (requestId) => commitLocalChatPushNow(sessionId, requestId);
        // A200 — steer IPC (absent in older module doubles: input then simply waits for the turn end).
        if (typeof requestLocalChatSteer === 'function' && typeof onLocalChatSteerApplied === 'function') {
          steerRequest.current = (steerId, steerText, urgent = false, seatMail) => !signal.aborted && requestLocalChatSteer(sessionId, steerId, steerText, urgent, seatMail);
          steerRetract.current = (steerIds) => { if (typeof retractLocalChatSteer === 'function') retractLocalChatSteer(sessionId, steerIds); };
          stopSteerApplied?.();
          stopSteerApplied = onLocalChatSteerApplied(sessionId, (steerIds) => {
            if (!busy || id !== turnSessionId) return;
            // The person's own lines that join now are echoed into the transcript where they joined (below the
            // tool results, above the next answer) and saved, so the next turn's history carries them too.
            const joinedLines = joinedSteerRows(queue.items, steerIds, () => new Date().toISOString());
            const applied = queue.markSteered(steerIds);
            for (const row of joinedLines) {
              appendMessage(sessionId, row);
              debug.log('tui.transcript', 'steer-echo', { sessionId, chars: row.content.length });
            }
            if (joinedLines.length > 0) {
              session = loadSession(sessionId);
              vanishReload ??= 'session-reload';
              messages = session ? displayAfterReload(sessionId, session.messages, 'steer') : messages;
            }
            let mailApplied = 0;
            for (const steerId of steerIds) {
              const msgId = mailSteers.get(steerId);
              if (msgId === undefined) continue;
              mailSteers.delete(steerId);
              removeQueuedNotice({ source: 'seat-mail', msgId });
              mailApplied += 1;
              debug.log('tui.next', 'seat-mail-steer-applied', { msgId, steerId });
            }
            if (applied + mailApplied === 0) return;
            pushNotice('Steer applied');
            status = '조향 반영 · 응답 중 · Esc 취소';
            debug.log('tui.next', 'steer-applied', { count: applied, remaining: queue.count });
            render();
          });
        }
        observeSession(sessionId, onLocalChatBackgroundStatus, onLocalChatSelfHealthStatus);
        const interruptContext = interruptContextFor;
        // Model-context lines, outermost first: interrupted-on-purpose → «대체 후보» → the person's words.
        const withCandidate = replacementContextLine ? withReplacementCandidateContext(text, replacementContextLine) : text;
        // mf1(#38102 r4): the notice turn carries the one-line source head for the model only; the person's
        // view is stripped back to the notice text (public-history, like the interrupt/candidate heads).
        const withNotice = noticeSource !== null ? withQueueNoticeContext(withCandidate, noticeSource, noticeMeta) : withCandidate;
        const passiveCarry = preparePassiveResultCarry(queue, withNotice);
        const childText = interruptContext !== null ? withInterruptedOnPurposeContext(passiveCarry.text, interruptContext) : passiveCarry.text;
        if (noticeSource !== null) debug.log('tui.next', 'turn-notice-context', { source: noticeSource, chars: text.length });
        if (replacementContextLine) debug.log('tui.next', 'turn-replacement-candidate-context', { chars: text.length });
        if (interruptContext !== null) debug.log('tui.next', 'turn-after-interrupt', { chars: text.length });
        if (signal.aborted || id !== turnSessionId) return { goalComplete: false };
        // A207 — «↻ Continuing» only after runLocalChatTurn has returned its handle. A throw
        // during that open never paints the banner. The running status is already on screen.
        let turnOpenPainted = false;
        const paintTurnOpen = (): void => {
          if (turnOpenPainted || signal.aborted || id !== turnSessionId) return;
          turnOpenPainted = true;
          if (!banner || internalTurnOriginOfText(turnText)) return;
          pushNotice(banner);
          renderBusyCapped();
        };
        const opened = runLocalChatTurn(sessionId, childText, signal, undefined, undefined, (...args) => {
          const [delta, replace, source] = args;
          turnStallWatch.touch();
          if (!signal.aborted && id === sessionId && !replace && source === 'assistant-text') {
            streamedOutputChars = Math.min(Number.MAX_SAFE_INTEGER, (streamedOutputChars ?? 0) + delta.length);
          }
          onDelta(...args);
        },
          { onCompact: (outcome) => onCompact(outcome.status ?? ''), onMessageBlock,
            onMeasuredUsage: (usage) => {
              if (id !== turnSessionId || !busy) return;
              measuredUsage = usage;
              renderBusyCapped();
            } }, attachments, onStatus, onAgent,
          (event) => {
            turnStallWatch.touch();
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
            turnStallWatch.touch();
            if (!busy || id !== turnSessionId) return;
            // Child stdout orders deltas and tool events; flush the throttled preview so the offset matches.
            if (event.phase !== 'finish') turn.flushPreview();
            visibleToolActivity = updateToolActivity(visibleToolActivity, event, performance.now());
            const textAt = streamPreview?.sessionId === turnSessionId ? streamPreview.text.length : 0;
            for (const callId of event.phase === 'snapshot' ? event.calls.map((call) => call.id) : event.phase === 'start' ? [event.id] : [])
              if (!toolTextOffsets.has(callId)) toolTextOffsets.set(callId, textAt);
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
              renderBusyCapped();
            } else renderBusyCapped();
          }, (event) => applyPushNowDecision(event.requestId, event.outcome, event.activeTools),
          (event) => {
            if (!busy || id !== turnSessionId) return;
            graphProgressLine = graphProgressStatus(event);
            graphView.observe(event);
            nodeLivenessTui.observe(event, runningToolLabel(visibleToolActivity)?.name);
            reportTuiProgress();
            render();
          }, turnFrom, () => {
            passiveCarry.commit();
            // A child pipe flush is the best available delivery boundary, not provider acknowledgement.
            if (interruptContext !== null && interruptContextFor === interruptContext) interruptContextFor = null;
          }, workReferences);
        paintTurnOpen();
        return opened;
      },
      onProgress: reportTuiProgress,
      // A207 — the banner is painted in run() after the turn handle returns. This still
      // closes the turn-start timing segment on the first stream byte, not before it.
      onStreamOpen: () => dashboardRuntime.endTurnStartSegments(turnSessionId, 'stream-open'),
      // TUI-ANSWER-VANISH-ON-TOOLCALL — the cleared pre-tool lines stay on screen above the tool rows.
      onHeldAnswer: (text) => {
        let anchor = -1;
        for (let index = messages.length - 1; index >= 0 && anchor < 0; index -= 1)
          if (messages[index]!.role === 'user' && stripQueueModelContext(messages[index]!.content) === turnText) anchor = index;
        // The displayed bubble of that row (a long notice body is folded · public-history ⑤), so the anchor matches.
        if (anchor >= 0) heldAnswerRows.set(turnSessionId, { anchor, userContent: publicUserText(messages[anchor]!.content), text });
      },
      onPreview: (preview, replace, source) => {
        // A replaced reply restarts the text; earlier tools now precede all of it.
        if (replace) for (const callId of toolTextOffsets.keys()) toolTextOffsets.set(callId, 0);
        // TUI-KEEP-TRANSCRIPT-ON-COMPACT ② — a replaced preview stays on screen as one folded «previous attempt» line.
        if (replace && streamPreview?.sessionId === turnSessionId) {
          const shown = streamPreview.assistantText ? nextAssistantPreviewText(streamPreview.text) : streamPreview.text;
          const attempt = previousAttemptMarker(shown, preview);
          if (attempt) {
            if (id === turnSessionId && messages.length > 0) {
              turnEndMarkers.set(turnSessionId, [...(turnEndMarkers.get(turnSessionId) ?? []),
                { afterMessageIndex: messages.length - 1, text: attempt.text, tone: 'dim', detail: attempt.detail }]);
              debug.log('tui.transcript', 'preview-replaced', { sessionId: turnSessionId, chars: shown.length, kept: true });
            } else debug.log('tui.transcript', 'answer-vanished', { sessionId: turnSessionId, cause: 'preview-replace',
              chars: shown.length, preview: vanishPreview(shown) }, { level: 'info' });
          }
        }
        // The REPL tags only session/chat onText; tool, reasoning and diagnostic frames stay separate.
        streamPreview = { sessionId: turnSessionId, text: preview, assistantText: source === 'assistant-text' };
        const progress = preview ? streamReplyProgress(turnSessionId) : null;
        activity = progress ? streamReplyLines(progress, process.stdout.columns || 80) : [];
        renderBusyCapped();
      },
      onCompact: (compactStatus) => {
        turnStallWatch.touch();
        // Compaction details may include child diagnostics; the basic chat shows only the state.
        // Settlement still reports the count. A head of Compacted folds to done and
        // drops both the count and Turn done from the 24-row footer.
        if (/^Compacted \d+→\d+ messages$/.test(compactStatus)) lastCompactCount = compactStatus;
        status = projectUserReplyStatus(compactStatus);
        session = loadSession(turnSessionId);
        // A status without counts (not fired · failed) is no compaction point — reload as any other reload.
        const compactedDisplay = /^Compacted\b/.test(compactStatus)
          ? displayAfterCompaction(turnSessionId, session?.messages, compactStatus)
          : displayAfterReload(turnSessionId, session?.messages ?? [], 'compact-not-fired');
        observeTranscriptReload(messages, compactedDisplay, 'compact', turnSessionId);
        vanishReload = 'compact-reload';
        messages = compactedDisplay;
        expandedToolBlocks.clear();
        render();
      },
      onNotice: (line) => { turnStallWatch.touch(); pushNotice(line); render(); },
      onStatus: (line) => {
        if (isNextTuiContextCountStatus(line)) return;
        turnStallWatch.touch();
        status = projectUserReplyStatus(line);
        renderBusyCapped();
      },
      onAgent: (event) => {
        turnStallWatch.touch();
        agents = applyAgentEvent(agents, event);
        reportTuiProgress();
        render();
      },
      onMessageBlock: (block) => {
        turnStallWatch.touch();
        const state = messageBlockSessions.restore(turnSessionId);
        upsertMessageBlock(state, block, Math.max(0, messagesAtTurnStart));
        messageBlockSessions.save(turnSessionId, state);
        if (id === turnSessionId) {
          session = loadSession(turnSessionId);
          const reloaded = session ? displayAfterReload(turnSessionId, session.messages, 'message-block') : messages;
          observeTranscriptReload(messages, reloaded, 'message-block', turnSessionId);
          vanishReload ??= 'session-reload';
          messages = reloaded;
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
        // Read before the per-turn counters are cleared: did anything answer at all (reply text or a tool)?
        const turnResponded = (streamedOutputChars ?? 0) > 0 || visibleToolActivity.length > 0;
        // OBSERVE-TURN-EVENT-LIFECYCLE — 턴 종료(stalled 는 stall 감시 판정 · toolMsMax 는 여기서 모른다 → 생략).
        try {
          emitTurnLife('turn-life:turn-end', {
            reason: turnStallHandled ? 'stalled' : outcome.goalStopReason === 'max_turns' ? 'max_turns' : outcome.kind,
            elapsedMs: Math.round(turnElapsedMs ?? 0),
            responded: turnResponded,
            queued: queue.count,
          });
        } catch { /* observability is fail-open */ }
        // CAPSULE-C2-FU: a stall-abort (turn.stalled) ends the door as 'stopped', not a person's 'cancelled'.
        doorTurnKind = turnStallHandled && outcome.kind === 'cancelled' ? 'stopped' : outcome.kind;
        streamedOutputChars = undefined;
        if (outcome.kind !== 'completed') measuredUsage = undefined;
        pendingEcho = null;
        stopConfirmationSelection = null;
        stopConfirmationKind = null;
        activeShellCalls.clear();
        activeToolCalls.clear();
        shellActivitySnapshotRequest.current = null;
        pushNowCommit.current = null;
        pushNowRequest.current = null;
        steerRequest.current = null;
        steerRetract.current = null;
        mailSteers.clear();
        stopSteerApplied?.();
        stopSteerApplied = null;
        shellEscSnapshotPending = false;
        pushNowSnapshotPending = false;
        pushNowRequestId = null;
        pushNowPhase = null;
        const compactNote = outcome.compacted ? `${lastCompactCount ?? 'Compacted'} · ` : '';
        lastCompactCount = null;
        status = outcome.kind === 'cancelled' ? `${compactNote}cancelled · Enter send`
          : outcome.kind === 'failed' ? `${compactNote}reply failed`
            : outcome.goalStopReason === 'max_turns' ? 'Turn cap reached — continuing automatically · or send your next input'
              : `${compactNote}Turn done · Enter send · Ctrl+Q quit`;
        const failure = turnReplyFailureMessage(turnSessionId, outcome.kind === 'failed', outcome.authFailureKind, outcome.error);
        if (failure) appendMessage(turnSessionId, {
          role: 'assistant', content: failure, ts: new Date().toISOString(), replyFinal: false, replyFailure: true,
          ...(outcome.authFailureKind ? { replyFailureKind: outcome.authFailureKind } : {}),
        });
        session = loadSession(turnSessionId);
        vanishReload ??= 'session-reload';
        messages = displayAfterReload(turnSessionId, session?.messages, 'settled');
        if (ceoTurn && outcome.kind === 'completed' && outcome.goalStopReason !== 'max_turns') {
          const reply = messages.slice(messagesAtTurnStart).filter((row) => row.role === 'assistant' && row.replyFinal === true).at(-1)?.content;
          if (reply) {
            try { postCeoTurnReply({ ...ceoTurn, sessionId: turnSessionId, turnRunId }, reply,
              process.env.ELANOUS_CEO_INGRESS_AUTH ?? ''); }
            catch (error) { debug.log('ceo-channel', 'reply-post-failed', { error: error instanceof Error ? error.message : String(error) }); }
          }
        }
        const turnEndText = formatTurnEndTime(turnStartedWallAt, Date.now(), outcome.kind !== 'completed', backgroundJobs.snapshot()?.running ?? 0);
        // Keep a non-ordinary outcome (cap reached, failed, cancelled, compacted) visible after the
        // turn-end summary; an ordinary completion shows the summary alone (#37966).
        const ordinaryCompletion = outcome.kind === 'completed' && outcome.goalStopReason !== 'max_turns' && !outcome.compacted;
        lastTurnEndStatus = { sessionId: turnSessionId, text: ordinaryCompletion ? turnEndText : `${turnEndText} · ${status}` };
        if (messages.length > 0) {
          const markers = turnEndMarkers.get(turnSessionId) ?? [];
          markers.push({ afterMessageIndex: messages.length - 1, text: turnEndText });
          turnEndMarkers.set(turnSessionId, markers);
        }
        // TUI-ANSWER-VANISH-ON-TOOLCALL — the real wire never sends a replace frame for a
        // tool-round clear (llm.ts emits an empty chunk and chat.ts drops the full flag), so
        // the pre-tool streamed lines live only in the live preview. Hand them to the screen
        // holder before the live state is discarded, so the settled transcript keeps them
        // above the tool rows of the same turn (same holder, settle path).
        if (!heldAnswerRows.has(turnSessionId) && streamPreview !== null && streamPreview.sessionId === turnSessionId
          && visibleToolActivity.length > 0) {
          const heldText = heldPreToolText(streamPreview, toolTextOffsets);
          if (heldText !== null) {
            let anchor = -1;
            for (let index = messages.length - 1; index >= 0 && anchor < 0; index -= 1)
              if (messages[index]!.role === 'user' && stripQueueModelContext(messages[index]!.content) === turnText) anchor = index;
            if (anchor >= 0) heldAnswerRows.set(turnSessionId, { anchor, userContent: turnText, text: heldText });
          }
        }
        activity = [];
        streamPreview = null;
        // Keep the completed tree visible after settlement, now inline after the turn's user
        // message (above the saved answer) instead of a tail below it; a new turn resets it.
        graphView.settle(Date.now());
        if (visibleToolActivity.length > 0 || graphView.events.length > 0) {
          let anchor = -1;
          for (let index = messages.length - 1; index >= 0 && anchor < 0; index -= 1)
            if (messages[index]!.role === 'user' && stripQueueModelContext(messages[index]!.content) === turnText) anchor = index;
          if (anchor >= 0) settledTurnTools.set(turnSessionId, [...(settledTurnTools.get(turnSessionId) ?? [])
            .filter((entry) => entry.anchor !== anchor), { anchor, userContent: publicUserText(messages[anchor]!.content), rows: visibleToolActivity,
              ...(graphView.events.length > 0 ? { graph: [...graphView.events] } : {}) }]);
        }
        visibleToolActivity = [];
        turnAbort = null;
        // TUI-STICKY-SCROLLBACK: a turn end (often a notice turn) never moves a scrolled view; the person's submit/End does.
        resetScroll('turn-end');
        // A mail turn marks its mail seen only once it answered; a turn that failed or was cancelled right away wakes again.
        wakeup?.noteTurnFinished(turnResponded);
        // B1-C seen only after an answered turn (seat-mail notices too) — a failed turn requeues once, never «seen».
        // C3: the adapter settles by the real outcome (cancelled/stopped = at once · failed = back-off) — D10.
        if (seatMailAdapter) seatMailWatcher.noteTurnFinished(turnResponded, doorOutcomeOf(doorTurnKind));
        else seatMailWatcher.noteTurnFinished(turnResponded);
        if (noticeTurn) {
          const finishNotice = noticeTurn.finish;
          const noticeTurnOk = outcome.kind === 'completed';
          void finishNotice(noticeTurnOk).catch(() => { /* a receipt never blocks the turn end */ });
        }
        // Only a person's own turn can give its text back; an internal turn (banner) never touches the prompt.
        settle(banner === undefined ? { text: turnText, responded: turnResponded } : undefined);
        // TUI-GOAL-INTERIM-QUIET 관측 — 그리기 계획(log-view 와 같은 함수)의 접힘 수가 바뀐 턴 끝에 한 줄.
        try {
          const shown = countInterimDisplay(planInterimDisplay(messages));
          if (shown.folded !== interimFoldedShown) {
            interimFoldedShown = shown.folded;
            debug.log('tui.goal-interim', 'folded', { surface: 'next', ...shown });
          }
        } catch { /* fail-soft: 관측은 턴 정리를 막지 않는다 */ }
        // A finished plan closes its mail item whatever the auto-continue decision is below (a queued input or a draft makes that yield).
        try {
          if (seatPlanLink?.turnEnded(planChainNotice, outcome.kind === 'completed', outcome.planOutcome) && queue.count > 0) injectKey(queueWake);
        } catch { /* plan bookkeeping never blocks a turn end */ }
        // QUEUE-FINISH-FIRST — ordinary (P1/P2) mail no longer makes the turn end «yield»: the continuation is judged
        // first, and the mail waits (held · peeked) while the work stays open. A person's line / P0 still yields.
        const holdableQueued = queuedForFinishFirst().filter((item) => item.kind === 'notice' && item.passive !== true
          && (finishFirst.classify(item) === 'P1' || finishFirst.classify(item) === 'P2')).length;
        const auto = decideNextTuiAutoContinue(outcome, Math.max(0, queue.autoDispatchCount - holdableQueued), input.editor.text);
        let continuationOpenedAtEnd = false;
        let requirementPending = false;
        let waitingReplyTo: number[] = [];
        if (goalContinue && auto === 'complete') goalContinue.noteGoalCompleted();
        if (goalContinue && auto === 'yield') {
          debug.log('tui.proactive', 'yield-user-input', { queued: queue.count, bufferedChars: input.editor.text.length });
        }
        const settleTurn = async (): Promise<void> => {
              if (!(auto === 'check' && goalContinue && wakeup)) return;
              // One branch: the goal controller is created with the wakeup door, so it is always here.
              // Self-pull runs in this same branch only when goalContinue.check() opened nothing.
              try {
                goalContinue.noteTurnEnded({ lines: dashboardRuntime.replyLinesOfThisTurn(messages, outcome.compacted ? 'after-last-user' : messagesAtTurnStart), failed: outcome.kind === 'failed', ...(outcome.goalStopReason ? { stopReason: outcome.goalStopReason } : {}), ...(outcome.planOutcome ? { plan: outcome.planOutcome } : {}) });
                const settled = await settleSeatPullTurnEnd({
                  auto,
                  goal: {
                    check: () => {
                      try { const r = goalContinue!.check(); if (r.opened) continuationOpenedAtEnd = true; return r; }
                      catch { return { opened: true, reason: 'goal-check-threw' }; }
                    },
                  },
                  pull: async () => {
                    // OP-REQUIREMENT-LOOP: open OP requirements get one continuation turn before self-pull.
                    const pullSeat = detectSeat(process.cwd())?.seat ?? null;
                    if (pullSeat === 'OP') {
                      try {
                        const { runRequirementTurnEnd } = await import('../op-requirements/turn-end.js');
                        const req = await runRequirementTurnEnd({ seat: pullSeat, humanTurn: from?.kind === 'human' ? { turnId: turnRunId, text: turnText } : null,
                          startTurnIfIdle: (text, opts) => startContinuationTurn(text, opts), notify: (line) => { pushNotice(line); render(); } });
                        requirementPending = req.pending === true;
                        waitingReplyTo = req.waitingReplyTo ?? [];
                        if (req.opened) continuationOpenedAtEnd = true;
                        if (req.opened) return { pulled: false, skipped: 'goal-opened' as const, hook: seatSelfPull };
                      } catch (error) { debug.log('op.requirements', 'turn-end-failed', { error: String(error).slice(0, 200) }); }
                    }
                    return pullSeatAfterGoal({
                    goal: null,
                    startTurnIfIdle: (text, opts) => wakeup!.gate.startTurnIfIdle(text, opts),
                    seat: pullSeat,
                    queueCount: queue.count,
                    draftLength: input.editor.text.length,
                    readUnread: readUnreadSummary,
                    hook: seatSelfPull,
                    startTurnIfIdleForHook: (text, opts) => wakeup!.gate.startTurnIfIdle(text, opts),
                  });
                  },
                });
                if (settled) seatSelfPull = settled.hook;
              } catch { /* a goal check or a pull never blocks turn settlement */ }
        };
        // Stay busy through settle. A sidetab switch requested in that window stays
        // pending (switchSession sees busy) and runs only after this release.
        try {
          await releaseBusyAfterSettle({
            settle: async () => {
              // QUEUE-FINISH-FIRST — work-in-progress for this turn end; recorded before release opens the door.
              try { await settleTurn(); } finally {
                const armed = goalContinue?.isArmed() === true;
                finishFirst.noteTurnEnd({ workInProgress: auto === 'check' && (armed || continuationOpenedAtEnd || requirementPending),
                  waitingReplyTo: [...waitingReplyTo, ...(await armedMailReplyWaits())] });
                // SESSION-AUTOPILOT — never just stop: no continuation opened and no wake scheduled → arm one (cadence).
                autopilotTurnEnded({ from, failed: outcome.kind === 'failed',
                  ...(outcome.kind === 'failed' ? { failureSig: String(outcome.error ?? outcome.goalStopReason ?? 'failed') } : {}),
                  fingerprint: (() => { try { return dashboardRuntime.replyLinesOfThisTurn(messages, outcome.compacted ? 'after-last-user' : messagesAtTurnStart).join('\n'); } catch { return ''; } })(),
                  openWork: armed || requirementPending, continuationOpened: continuationOpenedAtEnd });
                // QUEUE-P1-3MIN — the P1 turn is over: the paused work resumes right after release (retries while busy).
                if (finishFirst.resumePending()) { const timer = setTimeout(() => { resumePausedWork(); }, 50); (timer as { unref?: () => void }).unref?.(); }
              }
            },
            pendingSwitch: () => pendingSidetabSwitch,
            queueCount: () => queue.count,
            release: () => {
              setBusy(false);
              // OBSERVE-TURN-EVENT-LIFECYCLE — 한가 복귀: 남은 대기가 있으면 턴 끝 노크(self-pull) 가 곧 연다.
              try { emitTurnLife('turn-life:idle', { queued: queue.count, nextDoor: queue.count > 0 ? 'self-pull' : 'none' }); } catch { /* observability is fail-open */ }
            },
            applySwitch: async (sessionId) => { await switchSidetabSession(sessionId); },
            wakeQueue: () => { idleWakeDoor.knock('self-pull'); },
          });
        } finally {
          pendingSidetabSwitch = null;
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
    // The side list is remembered as open across sessions, so this branch is the COMMON start: the els rows (this host's
    // panes, ⇄herdr, registered hosts) must be read here too, not only after a toggle.
    void tickElsSidetab();
    sidetabRefreshTimer = setInterval(() => {
      if (!sidetabApi || !sidetabOpen) return;
      refreshSidetabRows();
      refreshRichView();
      void tickElsSidetab();
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
      const { turnPacingFromEnv } = await import('./input/internal-turn.js');
      const pacing = turnPacingFromEnv();
      const { setNextSidetabHandler, setNextSidetabIpcEnabled, setNextTuiPublishApprovalHandler, setNextTuiShellApprovalHandler, setNextTuiShellApprovalCancelHandler, setNextTuiHarnessAskUserHandler, setNextMemberBoardSessionSource, setNextRunShellCardHandler } = await import('../tui-client/local-chat-turn.js');
      setNextMemberBoardSessionSource(options.memberBoardSession ?? null);
      const { createNextSidetabHostHandler } = await import('./sidetab/nl-tool.js');
      setNextSidetabIpcEnabled(true);
      // The retro modules load here, in the same lazy block as the wake-up factory (nothing of it is on the boot path).
      const retroDep = await (async () => {
        const [{ createFileSeatRetroStateStore, parseSeatRetroIntervalMin, seatRetroStateFile }, { resolveSeatRetroSeat }] =
          await Promise.all([import('../seat/seat-retro.js'), import('../seat/seat-retro-seat.js')]);
        const seatName = resolveSeatRetroSeat(process.cwd());
        const intervalMin = parseSeatRetroIntervalMin(process.env.ELANOUS_SEAT_RETRO_INTERVAL_MIN);
        if (!seatName || intervalMin <= 0) return {};
        // OP-CEO-ALLOCATION-LOOP: the OP retro carries the runtime-built operating dashboard in its metrics slot (turn tail · cache-safe).
        const opDashboard = seatName === 'OP' ? await import('../ops-dashboard/retro-wiring.js').then((m) => m.startOpDashboardRefresh()).catch(() => null) : null;
        try { return { retro: { seat: seatName, intervalMin, store: createFileSeatRetroStateStore(seatRetroStateFile(seatName)), ...(opDashboard ? { metrics: opDashboard.metrics } : {}) } }; }
        catch { return {}; }
      })();
      // TURN-CAPSULE-EVENTS R1(C4) — the scheduler's bus adapter (schedule-wakeup.ts:219) gets its production
      // source: late wakes now publish TurnEvents. No switch — always on. CC-2 will wire the first consumer
      // to this same bus handle.
      const turnEventBus = createTurnEventBus();
      wakeup = createNextTuiWakeup({
        isTurnRunning: () => busy,
    turnLifeLog: emitTurnLife,
        ...(pacing ? { pacing } : {}),
        isInputForeground: isInternalWakeForeground,
        // C3: with one mail owner the watcher (1a) offers each msgId once; the mail-wake path (1b) folds (D9).
        enableSeatMailWake: seatMailAdapter === null,
        getBufferText: () => input.editor.text,
        getQueuedCount: () => queue.count,
        pendingKeyCount: tuiPendingKeyCount,
        requestYield: () => injectKey(internalWake),
        notify: (line) => { pushNotice(line); render(); },
        // TURN-CAPSULE-EVENTS R1(C4) — every scheduled/fired/cancelled wake lands on the turn-event bus.
        publishEvent: (event) => {
          turnEventBus.publish(event);
          if (!busy && event.dedupeKey.endsWith(':late')) entryDoor?.door.offer('event');
        },
        // SEAT-ROLE-CARD device 2 — a seat's built-in self-retro (ELANOUS_SEAT_RETRO_INTERVAL_MIN, minutes; 0 = off).
        ...retroDep,
      });
      // ⭐ OP-CRON-PROMPTS O2 — TUI 재기동해도 예약 깨움이 살게 파일에 저장·시작 복원한다(대화가 바뀌면 다시 묶는다).
      const wakeupScheduler = wakeup.scheduler;
      wakeupBusConsumer = createWakeupBusConsumer({ bus: turnEventBus,
        wakeups: () => wakeupScheduler.list().map((entry) => ({ id: entry.id, fireCount: entry.fireCount, deliverBy: entry.dueAt + WAKEUP_DEFER_MAX_MS })),
        log: (event, data) => { try { emitTurnLife(`turn-life:${event}`, data); } catch { /* observability is fail-open */ } } });
      bindWakeupSession = createSessionWakeupBinder(wakeup.scheduler, detectSeat(process.cwd())?.seat);
      bindWakeupSession(id);
      setNextTuiWakeupTool(wakeup.tool);
      // ELN-SEAT-APPROVAL-POLICY: an unattended seat auto-approves its allowlist and asks OP by mail for the rest (keyboard stays up).
      const approvalSeat = (() => { try { return detectSeatTui(process.cwd())?.seat ?? null; } catch { return null; } })();
      setNextTuiShellApprovalHandler(approvalSeat === null ? reportedApprovalDecision : createSeatApprovalHandler({
        seat: approvalSeat, local: reportedApprovalDecision, cancelLocal: (callId) => shellApproval.cancel(callId, 'host-cancelled'),
        ...seatApprovalLedgerPorts(approvalSeat, { log: (event, data) => { try { debug.log('seat.approval', event, data, { level: 'warn' }); } catch { /* fail-open */ } } }),
        setStatus: (line) => { status = line; render(); },
        log: (event, data) => { try { debug.log('seat.approval', event, data, event.endsWith('-failed') ? { level: 'warn' } : undefined); } catch { /* fail-open */ } },
      }));
      setNextRunShellCardHandler((command, callId) => reportedApprovalDecision(command, callId, 'bash'));
      setNextTuiPublishApprovalHandler(publishApproval.begin);
      setNextTuiShellApprovalCancelHandler((callId, reason) => {
        if (!publishApproval.cancel(callId)) shellApproval.cancel(callId, reason);
      });
      setNextTuiHarnessAskUserHandler(harnessAskUser.begin, harnessAskUser.cancel);
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
        // The mission runs without holding the turn; its arrival is announced in the transcript.
        onMissionSettled: (info) => {
          const line = missionArrivalText(info);
          // Turn-independent: a transcript marker survives the activity reset of whatever turn is running.
          if (!addTranscriptMarker(turnEndMarkers, id ?? '', messages.length, line)) activity.push(line);
          status = info.ok ? '미션 결과 도착' : '미션 실패';
          refreshSidetabRows();
          render();
        },
      }));
      autopilotRhythm = 'retro' in retroDep;
      await startAutopilot();
      goalContinue = dashboardRuntime.createGoalContinue({
        // QUEUE-FINISH-FIRST — the continuation carries the held-mail peek and related mail (startContinuationTurn).
        startTurnIfIdle: (text, opts) => startContinuationTurn(text, opts),
        notify: (line) => { pushNotice(line); render(); },
        // SEAT-STATE-ENUM: the block goes to els as a code (BLOCKED + one reason), never as the notice sentence.
        onBlocked: (reason, detail) => { agentEvents.blocked(reason, detail); needsHuman.blocked(reason, detail); },
        planNudge: true,
        // The gate only parks the turn. Watch until this loop takes it; otherwise withdraw and say stop.
        confirmSeatCapTurnStarted: (turnId) => wakeup!.confirmSeatCapTurnStarted(turnId),
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
        vanishReload ??= 'session-reload';
        messages = displayAfterReload(id!, session?.messages, 'sim-watch');
        render();
      } catch (error) {
        if (simWatchTimer !== null) clearInterval(simWatchTimer);
        simWatchTimer = null;
        status = 'SIM 관측 감시 중단';
        pushNotice(safeStatusText(error instanceof Error ? error.message : String(error)));
        render();
      }
    }, 250) : null;
    // NEXT-TUI-DIFF-RENDER (2/2): the first frame is painted; warm the chat child now (first answer ~1.8 s sooner).
    if (id) {
      const warmId = id;
      void import('../tui-client/local-chat-turn.js').then((module) => {
        if (!tuiClosed && id === warmId && typeof module.warmLocalChatSession === 'function') module.warmLocalChatSession(warmId);
      }).catch(() => { /* the first turn spawns as before */ });
    }
    // Raw mode is on and the loop is about to read (injectKey is a no-op before raw mode): items queued during boot —
    // the seat plan's restored active item, mail absorbed at boot — are woken here instead of waiting for a person to
    // type. Inside this try, so the finally always clears the interval.
    queueIdleWatchdog.kick('boot');
    queueIdleTimer = setInterval(() => {
      queueIdleWatchdog.tick();
      // QUEUE-FINISH-FIRST — a held item past its wait limit (P1 10 min · P2 20 min) or a closed coalescing window wakes the door.
      if (!busy && finishFirst.heldCount() > 0 && finishFirst.releaseDue(queuedForFinishFirst())) injectKey(queueWake);
    }, QUEUE_IDLE_TICK_MS);
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
      if (key === seatStopKey) {
        // quit/migrate arrive after the turn ended; force already aborted it. Same exit as Ctrl+Q from here on.
        await turnDone;
        break;
      }
      // A physical quit wins before queueWake/internalWake and before any automatic turn door.
      // The input parser rejects synthetic quit bytes; no queued notice can postpone this branch.
      if (key.ctrl && key.name === 'q') {
        humanQuitRequested = true;
        turnAbort?.abort('human quit');
        debug.log('seat.steer.preempt', 'human-quit', { queued: queue.count, busy });
        break;
      }
      // JUD #38658 ⓑ: a stop is decided — no new turn; queued items stay queued (the next seat body gets them).
      if ((key === queueWake || key === internalWake) && seatStopRef.current && !seatStopRef.current.allowsNewTurn()) {
        if (key === internalWake) wakeup?.gate.port.declined?.('seat-stopping');
        debug.log('seat-stop', 'turn-held', { source: key === queueWake ? 'queue' : 'internal', queued: queue.count });
        render();
        continue;
      }
      // ELN-QUEUE-PANEL-CTRLC-RACE (2026-11-23 r2): same rule as the seat-stop hold above — with the queue panel
      // open the person is managing the queue, so every knock that uses this key (the settle's resubmit, the queue's
      // turn-end door #38590, the idle watchdog's stall wake) is consumed without knocking the door. The watchdog
      // retries after the panel closes, and the settle's «응답 중단됨 · 큐 N건은 패널에 남음» stays on screen.
      if (key === queueWake && queuePanel) {
        debug.log('tui.next', 'queue-wake-held-by-panel', { queued: queue.count });
        render();
        continue;
      }
      if (key === queueWake) {
        if (options.queueWakeBarrierForTest) {
          const seen: QueueWakeBarrierState = { busy, queued: queue.count, pendingKeys: tuiPendingKeyCount(),
            draftChars: input.editor.text.length, door: entryDoor ? entryDoor.door.state() : 'off' };
          try { emitTurnLife('turn-life:queue-wake-seen', { ...seen }); } catch { /* observability is fail-open */ }
          await options.queueWakeBarrierForTest(seen);
        }
        if (!busy) entryDoor?.door.offer('event');
        else debug.log('queue', 'wake-while-busy', { queued: queue.count }); // the turn end knocks again; the watchdog backs it
        // OBSERVE-TURN-EVENT-LIFECYCLE — 바쁜 문 노크(감시개 재시도 등): 알림은 대기한다.
        if (busy) { try { emitTurnLife('turn-life:event-while-busy', { source: 'queue', action: 'wait' }); } catch { /* observability is fail-open */ } }
        render();
        continue;
      }
      if (key === internalWake) {
        // The door rechecks focus and human input after the yield key reaches this loop.
        // CAPSULE-C2 (flag on): an internal turn takes the door first; refused (busy) → the gate withdraws it, never two turns.
        const doorHold = entryDoor && wakeup?.gate.pendingTurnId() ? entryDoor.reserveAuto() : undefined;
        if (doorHold === null) {
          wakeup?.gate.port.declined?.('door-busy');
          render();
          continue;
        }
        const request = wakeup?.takePendingIfIdle();
        // OBSERVE-TURN-EVENT-LIFECYCLE — 꺼낸 내부 턴의 문 라벨(startChatTurn 관측이 텍스트로 대조해 읽는다).
        if (request !== null) turnStartLabel = { door: 'internal', text: request.input, source: request.origin, itemId: request.turnId, eventId: request.turnId }; // 출처: TC #92565 — itemId = eventId = turnId
        if (!request && doorHold) entryDoor?.releaseIfUnstarted(doorHold);
        // A calm English line (turn limit · next step · remaining plan · scheduled …), not the internal origin name.
        // MSG-SOURCE-HIERARCHY: a turn that delivers another seat's mail says that seat («⇢ OP · request · due 14:00 · #id»).
        if (request) startChatTurn(request.input, request.from ? agentTurnBanner(request.from) : continueBanner(request.origin, request.reason),
          request.from ?? { kind: 'system', origin: request.origin }, request.workReferences);
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
          if (step.wheel) applyWheel(step.wheel);
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
      // GRAPH-VIEW-DETAIL-SIDETAB: Ctrl/Alt+click, Ctrl+G and the open detail's keys.
      if (graphDetail.handleKey(key, input.editor.text.length === 0)) {
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
      if (key.name === 'mouse' && (key.mouse?.type === 'click' || key.mouse?.type === 'double-click' || key.mouse?.type === 'right-click')) {
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
                    status = `${menu.title} · 1 Open here · 2 Rename · 3 Close · Esc cancel`;
                  }
                }
              }
            }
            panelClick = true;
          }
        }
        if (!panelClick) sidetabDragSource = null;
        if (!panelClick && (key.mouse.type === 'click' || key.mouse.type === 'double-click') && !sidetabAttachments?.hasModal() && !sidetabAttachments?.hasRemoteView()) {
          const target = foldTargetAtScreenRow(logWindow.foldTargets, logWindow, key.mouse.row);
          // NOTICE-FOLD-1LINE — a click on a notice opens/folds it in place (the view and the focus stay as they are).
          if (target?.kind === 'tool' && toggleNoticePartFold(expandedNoticeRows, lastFrameMessages, target.index, target.part)) {
            lastFoldTargetKey = `tool:${target.index}${target.part === undefined ? '' : `#${target.part}`}`;
          } else if (target) {
            focus = 'log';
            lastFoldTargetKey = target.kind === 'message' ? `message:${target.id}` : `tool:${target.index}`;
            if (target.kind === 'message') {
              advanceMessageBlockDetail(target.id);
            } else if (expandedToolBlocks.has(target.index)) expandedToolBlocks.delete(target.index);
            else expandedToolBlocks.add(target.index);
          }
        }
        render();
        continue;
      }
      if (sidetabAttachments?.handleKey(key)) {
        render();
        continue;
      }
      if (publishApproval.session.handleKey(key)) {
        render();
        continue;
      }
      if (shellApproval.handleKey(key)) {
        render();
        continue;
      }
      if (harnessAskUser.active()) {
        if (key.name === 'escape') harnessAskUser.escape();
        else if (key.name === 'pageup' || key.name === 'pagedown') {
          harnessAskUser.scroll(key.name === 'pageup' ? 'up' : 'down');
        }
        else {
          const retainedDraft = interviewDraftText();
          const interviewInput = input.applyKey(key, [retainedDraft]);
          if (interviewInput.action === 'submit') {
            const answer = input.expandSubmission(interviewInput.submitted ?? '', [retainedDraft]);
            harnessAskUser.submit(answer);
          }
          else if (interviewInput.action === 'cancel') harnessAskUser.escape();
        }
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
            queue.markInterrupted('esc');
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
        applyWheel(wheel);
        render();
        continue;
      }
      // Releases/motion left unclaimed by a pane are pointer events, not composer input.
      // In particular, releasing a fold click must not switch back to basic chat.
      if (key.name === 'mouse') continue;
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
        const action = newPtyPickerKey(key);
        sidetabMode = 'list';
        if (action.kind === 'spawn') {
          await ensureSidetabAttachments();
          sidetabAttachments?.spawn(action.character);
          refreshSidetabRows();
        }
        // Only a choice letter or Esc belongs to the picker; anything else closes it and is typed as usual.
        if (action.kind !== 'pass') {
          render();
          continue;
        }
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
      // An open queue panel is the top layer: its Esc closes it (the panel branch below) and never interrupts the
      // running turn. Ctrl+C still interrupts (ELN-QUEUE-ITEM-CONTROLS live check 11-18: Esc stopped the turn).
      if (busy && ((key.name === 'escape' && !queuePanel) || (key.ctrl && key.name === 'c'))) {
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
      if (!busy && focus === 'input' && !atFileInput.current?.isOpen && !slashPicker && !shellApproval.active()
        && contextAttachmentScrollMax > 0
        && ((key.name === 'pageup' && contextAttachmentScroll > 0)
          || (key.name === 'pagedown' && contextAttachmentScroll < contextAttachmentScrollMax))) {
        const delta = key.name === 'pageup' ? -contextAttachmentScrollStep : contextAttachmentScrollStep;
        contextAttachmentScroll = Math.max(0, Math.min(contextAttachmentScrollMax, contextAttachmentScroll + delta));
        render();
        continue;
      }
      // TUI-STICKY-SCROLLBACK: End jumps a scrolled view back to the newest rows (the «↓ N new · End to jump» hint).
      if (key.name === 'end' && scroll > 0 && !key.ctrl && !key.alt && !key.meta) {
        resetScroll('end-key');
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
        const targetKey = (candidate: typeof visibleTargets[number]): string => candidate.kind === 'message' ? `message:${candidate.id}`
          : `tool:${candidate.index}${candidate.part === undefined ? '' : `#${candidate.part}`}`;
        const target = nextVisibleFoldTarget(visibleTargets, messageBlocks, messageBlockLevels, lastFoldTargetKey);
        if (target?.kind === 'message') {
          lastFoldTargetKey = targetKey(target);
          advanceMessageBlockDetail(target.id);
          render();
          continue;
        }
        if (target?.kind === 'tool') {
          lastFoldTargetKey = targetKey(target);
          if (toggleNoticePartFold(expandedNoticeRows, lastFrameMessages, target.index, target.part)) { /* NOTICE-FOLD-1LINE — by row id */ }
          else if (expandedToolBlocks.has(target.index)) expandedToolBlocks.delete(target.index);
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
      if (!busy && focus === 'input' && providerPicker?.isOpen) {
        const action = providerPicker.handleKey(key);
        if (action) {
          if (action.kind === 'dismissed') { providerPicker = null; status = 'provider 선택 닫힘 · Enter 전송'; }
          if (action.kind === 'selected') {
            providerPicker = null;
            const sessionId = id;
            if (!sessionId) status = '현재 대화를 찾을 수 없어 provider를 바꾸지 못했습니다';
            else {
              // Same validated session-switch path as typing /provider use <provider>; its lines are not shown.
              try {
                const { runLocalProviderCommand } = await import('../tui-client/local-provider-command.js');
                await runLocalProviderCommand(`use ${action.provider}`, new AbortController().signal, () => {}, sessionId);
                status = `이 세션 provider: ${action.provider} · 다음 턴부터 적용`;
              } catch (error) {
                status = `provider 실패: ${safeStatusText(error instanceof Error ? error.message : String(error))}`;
              }
            }
          }
          render();
          continue;
        }
      }
      if (!busy && focus === 'input') {
        const action = atFileInput.current?.handleKey(key, input.editor.text);
        if (action) {
          if (action.kind === 'dismissed') status = '파일 선택 닫힘 · Enter 전송';
          if (action.kind === 'selected') {
            const picked = action.accept(++atAttachmentOrdinal);
            input.setEditor({ text: picked.text, cursor: picked.cursor });
            atAttachmentTokens.set(picked.token, picked.absPath);
            await refreshVisibleContextAttachmentArea();
            status = '파일 첨부 추가됨 · Enter 전송';
            debug.log('tui.next', 'at-picker-selected', { path: picked.absPath });
          }
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
          // TUI-SLASH-TEXT-KOREAN-AND-RESIDUE: the picker guide must not outlive the picker.
          if (status.startsWith('슬래시 명령')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
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
      // ELN-QUEUE-PANEL-CTRLC-RACE (2026-11-18): the drain's synthetic auto-Enter is the door's own handoff, not
      // the person's key — the panel (and its «Editing queued item» Enter branch) reads real keys only, so the
      // handoff falls through to the ordinary submit path, which is its only purpose.
      if (queuePanel && key !== syntheticEnterKey) {
        const items = queue.items;
        // r3: explicit panel-action union breaks the circular inferred initializer at this line
        // (TS7022 — pregate r2 RED, receipt PREGATE-RED/39556-44919e10b3c9-node-b).
        const action: QueuePanelAction | null = items.length > 0 ? queuePanelKey(key, items, queuePanel.selected, queuePanelViewing) : { kind: 'closed' as const };
        // Typing while the panel is open closes it and goes to the composer (same rule as the /side new picker):
        // Backspace and Enter can no longer cancel an item or overwrite the draft by accident (#38095 r1).
        if (action?.kind === 'pass') {
          queuePanel = null;
          queuePanelViewing = null;
          status = 'Queue closed';
        } else if (action) {
          const row = action.kind === 'toggle-delivery' || action.kind === 'cancel' || action.kind === 'edit' ? queue.get(action.id) : undefined;
          try {
            if (action.kind === 'moved') queuePanel.selected = queuePanelMove(items, queuePanel.selected, key.name === 'up' ? 'up' : 'down');
            else if (action.kind === 'view') {
              // OP #128306 ②: read-only full text — the item stays queued (viewing is not editing).
              queuePanelViewing = { id: action.id, scroll: 0 };
              status = 'Viewing queued text · ↑↓ scroll · v/Enter back · Esc close';
            } else if (action.kind === 'view-close') {
              queuePanelViewing = null;
              status = 'Queue list';
            } else if (action.kind === 'view-scroll' && queuePanelViewing) {
              queuePanelViewing.scroll = Math.max(0, queuePanelViewing.scroll + action.delta);
            } else if (action.kind === 'closed') { queuePanel = null; queuePanelViewing = null; status = 'Queue closed'; }
            else if (action.kind === 'refused') status = action.reason;
            else if (action.kind === 'toggle-delivery' && action.to === 'queue') {
              if (row?.steerId) steerRetract.current?.([row.steerId]);
              queue.changeDelivery(action.id, 'queue');
              status = 'Moved to queue · sends after the turn';
            } else if (action.kind === 'toggle-delivery') {
              // Offer the text to the running turn like a freshly typed steer; without a running turn it stays queued.
              const candidate = `steer-${++steerSerial}`;
              const steerText = row ? input.expandSubmission(row.text, [input.editor.text, ...queue.pendingTexts]).trim() : '';
              if (busy && steerText && steerRequest.current?.(candidate, steerText)) {
                queue.changeDelivery(action.id, 'steer', candidate);
                status = 'Moved to steer · joins at the next tool boundary';
              } else status = 'No running turn to steer · kept in queue';
            } else if (action.kind === 'cancel') {
              if (row?.steerId) steerRetract.current?.([row.steerId]);
              queue.cancel(action.id, 'user');
              status = 'Queued item cancelled';
            } else if (action.kind === 'edit') {
              // Out of the queue while edited, so no drain can send it; Enter sends the edited text again.
              if (row?.steerId) steerRetract.current?.([row.steerId]);
              queue.cancel(action.id, 'edited');
              input.setText(action.text);
              queuePanel = null;
              queuePanelViewing = null;
              status = 'Editing queued item · Enter sends it again';
            }
          } catch (error) {
            if (!(error instanceof NextTuiQueueConflictError)) throw error;
            status = 'Item was already delivered or changed';
          }
          if (queuePanel) {
            // Keep the selection on the moved row (order re-sorts steer before queue); clamp after a cancel.
            const order = queuePanelOrder(queue.items);
            const followed = action.kind === 'toggle-delivery' ? order.findIndex((entry) => entry.id === action.id) : -1;
            queuePanel.selected = followed >= 0 ? followed : Math.min(queuePanel.selected, Math.max(0, order.length - 1));
          }
          debug.log('tui.next', 'queue-panel', { action: action.kind, count: queue.count });
          render();
          continue;
        }
      }
      // One ↑ rule (upDownTarget): waiting items and an empty composer open the queue panel; history never takes over.
      if (focus === 'input' && key.name === 'up' && !key.ctrl && !key.alt && !key.shift && !key.meta && !slashPickerVisible
        && upDownTarget({ key: 'up', editor: input.editor, busy, queued: queue.count }) === 'queue-panel') {
        queuePanel = { selected: 0 };
        queuePanelViewing = null;
        status = `Queue · ${QUEUE_PANEL_HINT}`;
        render();
        continue;
      }
      // TUI-SLASH-DURING-TURN — a plain Enter on a «/명령» draft is not conversation input: it skips
      // the busy branch below (which would queue or steer it until the turn ends) and falls through to
      // the ordinary submit dispatch, which executes the command locally right now — turn-scoped targets
      // answer «다음 턴부터», unknown ones get the unknown-command notice. Commands that must keep the
      // busy branch (turn/session-scoped or busy-swapping) and non-command «/…» drafts stay queued as before.
      const slashCommandEnter = busy && (key.name === 'enter' || key.name === 'return') && !key.shift && !key.ctrl && !key.alt
        && input.editor.text.trim().startsWith('/')
        && isNextTuiSlashCommandDraft(input.editor.text, await loadNextTuiRouteRegistry());
      if (busy && !slashCommandEnter) {
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
          if (recalled && recalled.steerIds.length > 0) steerRetract.current?.(recalled.steerIds);
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
        // ↑/↓ while a turn runs: line moves in a multi-line draft; the queue-panel case opened its panel above;
        // otherwise prompt history.
        if ((key.name === 'up' || key.name === 'down') && !key.ctrl && !key.alt && !key.shift && !key.meta) {
          const target = upDownTarget({ key: key.name, editor: input.editor, busy: true, queued: queue.count });
          if (target === 'line') input.setEditor(moveEditorLine(input.editor, key.name));
          else if (target === 'history') input.browseHistory(key.name, historyPrompts());
          render();
          continue;
        }
        const pending = input.applyKey(key, queue.pendingTexts);
        if (pending.action === 'submit' && pending.submitted) rememberPrompt(pending.submitted);
        if (pending.action === 'submit' && pending.submitted) {
          resetScroll('submit');
          // OBSERVE-TURN-EVENT-LIFECYCLE — 턴 중 사람 줄 도착(조향/대기 판정은 바로 아래).
          try { emitTurnLife('turn-life:event-arrived', { source: 'human', busy: true, arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
          const routeRegistry = await loadNextTuiRouteRegistry();
          const pendingRoute = routeRegistry.resolveNextTuiRoute(pending.submitted, routeRegistry.NEXT_TUI_INPUT_CONTEXT);
          if (pendingRoute?.action === 'quit') {
            humanQuitRequested = true;
            turnAbort?.abort('human quit command');
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
          // A200: a chat line also goes to the running turn as a steer — it joins the next model request
          // (after the current tool results); the queue row stays as «조향 대기» until the child confirms.
          // ELN-QUEUE-SUPERSEDE: same target ⊕ correction word → a «대체 후보» hint (no status change, §6 inv. 10).
          // The steer carries its one model-context line; the queue records the hint at enqueue.
          const replacementPreview = queue.previewReplacementCandidate(pending.submitted);
          const replacementOld = replacementPreview.kind === 'candidate' ? queue.get(replacementPreview.candidateFor) : undefined;
          let steerId: string | undefined;
          if (steerRequest.current && !personTurnStarted && isTurnTypeaheadSteerable(pending.submitted)) {
            // SEAT-NOTICE-BOOT-RACE: no own turn yet, so the running turn is an
            // auto-started one — the person's first words must not steer into it.
            debug.log('tui.next', 'person-first-queued-not-steered', {
              length: pending.submitted.length, count: queue.count,
            });
          }
          if (steerRequest.current && personTurnStarted && isTurnTypeaheadSteerable(pending.submitted)) {
            const candidate = `steer-${++steerSerial}`;
            const expanded = input.expandSubmission(pending.submitted,
              [input.editor.text, ...queue.pendingTexts, pending.submitted]).trim();
            const steerLine = replacementPreview.kind === 'candidate' && replacementOld
              ? replacementCandidateContextLine(replacementPreview, replacementOld.text, replacementOld.status)
              : null;
            const steerText = expanded && steerLine ? withReplacementCandidateContext(expanded, steerLine) : expanded;
            if (steerText && steerRequest.current(candidate, steerText)) steerId = candidate;
          }
          const enqueued = queue.enqueue(pending.submitted, steerId);
          const detected = queue.replacementCandidate(enqueued.id);
          const detectedOld = detected ? queue.get(detected.candidateFor) : undefined;
          if (detected && detectedOld) {
            pushNotice(replacementCandidateScreenLine(detected, detectedOld.text));
            debug.log('tui.next', 'queue-replacement-candidate', { id: enqueued.id, candidateFor: detected.candidateFor, targets: detected.targets });
          }
          status = steerId
            ? `조향 대기 ${queue.steerCount}건 · 다음 도구 경계에 넣음 · Esc 취소`
            : '응답 중 · 완료 뒤 순서대로 전송 · Esc 취소';
          debug.log('tui.next', steerId ? 'steer-sent' : 'queue-enqueued', { length: pending.submitted.length, count: queue.count });
          // OBSERVE-TURN-EVENT-LIFECYCLE — 조향이면 steer, 아니면 대기열 wait(capsule 은 여기서 모른다 → 생략).
          try { emitTurnLife('turn-life:event-while-busy', { source: 'human', action: steerId !== undefined ? 'steer' : 'wait' }); } catch { /* observability is fail-open */ }
        }
        render();
        continue;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (upDownTarget({ key: key.name, editor: input.editor, busy: false, queued: queue.count }) === 'line')
          input.setEditor(moveEditorLine(input.editor, key.name));
        else input.browseHistory(key.name, historyPrompts());
        slashPicker = null;
        render();
        continue;
      }
      focus = 'input';
      if (selectedSlashCommand !== null) input.setEditor(replaceSlashPickerQuery(input.editor, selectedSlashCommand));
      // U1a · #22868 — the empty-input Ctrl+C contract, carried over from the chat key loop: first press
      // arms (hint), second press within CTRL_C_ARM_MS exits, text present clears the input. The composer's
      // own quit-on-empty-Ctrl+C (applyComposerKey) never fires for Ctrl+C because this runs first.
      if (key.ctrl && (key.name === 'c' || key.name === 'ㅊ') && !key.shift && !key.alt) {
        const ctrlC = resolveCtrlCInInput({ text: input.editor.text, now: Date.now(), armedAt: ctrlCArmedAt });
        ctrlCArmedAt = ctrlC.armedAt;
        status = ctrlC.hint ?? status;
        if (ctrlC.action === 'arm-exit') ctrlCHintText = ctrlC.hint;
        if (ctrlCHintTimer) clearTimeout(ctrlCHintTimer);
        ctrlCHintTimer = null;
        if (ctrlC.action === 'arm-exit') {
          // The hint promises «one more press exits» only while that is true — expire it with the arm.
          const armedAt = ctrlC.armedAt;
          ctrlCHintTimer = setTimeout(() => {
            ctrlCHintTimer = null;
            if (ctrlCArmedAt !== armedAt) return;
            ctrlCArmedAt = null;
            // #22868 «다른 키 사이엔 아무것도 안 함»(#39550 r4): 슬롯에 자기 안내가 남아 있을 때만 되돌린다 —
            // 그 사이 다른 안내(글 입력·Enter·Esc 취소 등)가 세워져 있으면 그 안내를 지우지 않는다.
            if (status === ctrlCHintText) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
            ctrlCHintText = null;
            render();
          }, CTRL_C_ARM_MS + 50);
          ctrlCHintTimer.unref?.();
        }
        if (ctrlC.action === 'clear-input') {
          // Disarmed by text: the «one more press exits» promise is void — retire the hint with the arm,
          // mirroring the expiry timer above (a hint may never outlive the arm that made it).
          if (status === ctrlCHintText) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
          ctrlCHintText = null;
          input.setText('');
          input.retainLivePasteTokens([input.editor.text, ...queue.pendingTexts]);
          input.noteAction('cancel');
          // TUI-CTRLC-CLEAR-PICKER-CLEANUP-FU (REVIEW-2 #131196 · OP #131201): clear-input cancels the
          // composer text, so the popups that text opened (at picker · / picker) and its navigation state
          // (slashNavigated) must close with it — the same cleanup the common cancel path below does for
          // submit/cancel/quit. Otherwise the next Tab/Enter can fire an already-cancelled candidate.
          atFileInput.current?.close();
          slashPicker = null;
          slashNavigated = false;
        }
        if (ctrlC.action === 'exit') break;
        render();
        continue;
      }
      const result = input.applyKey(key, queue.pendingTexts);
      input.noteAction(result.action);
      if (result.action === 'edit') {
        await refreshAtPicker();
        await refreshSlashPicker();
      } else if (result.action === 'submit' || result.action === 'cancel' || result.action === 'quit') {
        atFileInput.current?.close();
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
        resetScroll('submit');
        const submittedFull = input.expandSubmission(result.submitted, [input.editor.text, ...queue.pendingTexts]);
        // 지운 붙여넣기의 원문은 놓는다 — 입력칸·대기열에 남은 토큰만 쥔다(r3 must-fix).
        input.retainLivePasteTokens([input.editor.text, ...queue.pendingTexts]);
        const submitted = submittedFull.trim();
        rememberPrompt(submitted);
        // A submitted command replaces the picker guide; commands that set no status leave the default.
        if (status.startsWith('슬래시 명령')) status = 'Enter 전송 · Esc 취소 · Ctrl+Q 종료';
        if (submitted === '/tasks') {
          const lines = backgroundJobs.taskLines();
          activity = lines.length > 0 ? [`${lines.length} tasks · /tasks stop <id prefix> to cancel`] : ['No background Agent tasks'];
          status = 'Task list · Enter to send';
          render();
          continue;
        }
        if (submitted.startsWith('/tasks stop ')) {
          const prefix = submitted.slice('/tasks stop '.length).trim();
          const taskId = prefix.length >= 4 ? backgroundJobs.resolveTask(prefix) : null;
          if (!taskId || !id) status = 'Enter a unique task ID prefix of at least 4 characters';
          else {
            const { requestLocalChatTaskStop } = await import('../tui-client/local-chat-turn.js');
            status = requestLocalChatTaskStop(id, taskId) ? `Stop requested for task ${backgroundJobs.displayTaskId(taskId)}` : 'Task stop request failed';
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
          // TUI-WAKE-NOTICE-HIDDEN: a notice never sits below the person's newest message.
          notices = nextNoticeRows(notices, { kind: 'person' }, noticeGate);
          internalNotices = [];
          pendingEcho = { role: 'user', content: submittedFull, ts: new Date().toISOString() };
          pendingEchoStart = messages.length;
          render();
        }
        if (route?.action === 'quit') break;
        if (route?.id === 'session.new') {
          pluginWizardFlow = null;
          const next = await requestNewTuiSession({ busy, from: id });
          if (next.kind === 'started') {
            loopBranch?.stop();
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            capsuleSubscription.stop?.();
            capsuleSubscription.stop = null;
            capsuleActivitySubscription.stop?.();
            capsuleActivitySubscription.stop = null;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            saveMessageBlockSession();
            // The new conversation inherits the TUI's session provider (TUI-NEW-SESSION-KEEPS-PROVIDER).
            await carrySessionProvider(previous, next.id);
            id = next.id;
            setTuiForegroundSessionId(id);
            bindWakeupSession?.(id);
            restoreMessageBlockSession(id);
            lastFoldTargetKey = null;
            expandedNoticeRows.clear();
            lastResumeRows = null;
            session = loadSession(id);
            messages = [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            resetScroll('session-switch');
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
          let manualCompactStatus: string | null = null;
          setBusy(true);
          // OBSERVE-TURN-EVENT-LIFECYCLE — 채팅 턴 밖의 busy(압축): internal 문 관측.
          try { emitTurnLife('turn-life:turn-start', { door: 'internal', turnSessionId: id, eventId: id }); } catch { /* observability is fail-open */ } // 출처: TC #92565 — eventId = turnSessionId
          status = 'Compacting';
          turnAbort = null;
          turnDone = Promise.all([import('./slash/compact.js'), import('../tui-client/local-chat-turn.js')])
            .then(([{ compactNextTuiSession }, { localChatModel }]) =>
              compactNextTuiSession(compactSessionId, { force: true, modelId: localChatModel(compactSessionId) }))
            .then((outcome) => {
              if (outcome.fired) manualCompactStatus = outcome.status ?? 'Compacted';
              status = `${outcome.status ?? 'Compacted'} · Enter send`;
            })
            .catch((error: unknown) => {
              status = `Compaction failed: ${safeStatusText(error instanceof Error ? error.message : String(error))}`;
            })
            .finally(() => {
              session = loadSession(compactSessionId);
              vanishReload ??= 'compact-reload';
              messages = manualCompactStatus !== null
                ? displayAfterCompaction(compactSessionId, session?.messages, manualCompactStatus)
                : displayAfterReload(compactSessionId, session?.messages, 'manual-compact');
              expandedToolBlocks.clear();
              setBusy(false);
              resetScroll('compaction');
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
            loopBranch?.stop();
            const previous = id;
            backgroundSubscription.stop?.();
            backgroundSubscription.stop = undefined;
            capsuleSubscription.stop?.();
            capsuleSubscription.stop = null;
            capsuleActivitySubscription.stop?.();
            capsuleActivitySubscription.stop = null;
            if (previous) {
              const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
              await closeLocalChatSession(previous);
            }
            saveMessageBlockSession();
            id = next.id;
            setTuiForegroundSessionId(id);
            bindWakeupSession?.(id);
            restoreMessageBlockSession(id);
            lastFoldTargetKey = null;
            expandedNoticeRows.clear();
            lastResumeRows = null;
            session = loadSession(id);
            vanishReload ??= 'session-reload';
            messages = session?.messages ?? [];
            expandedToolBlocks.clear();
            backgroundJobs.setSessionId(id);
            backgroundJobs.clear();
            activity = [];
            resetScroll('resume');
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
          if (!command.trim() || command.trim() === 'list') {
            status = 'provider 목록 확인 중';
            render();
            const [{ getUserConfig, PROVIDER_DEFAULT_MODEL }, { configForSessionProviderTurn, getSessionProvider }, { detectProviders }, picker] = await Promise.all([
              import('../user-config.js'), import('../tui-client/session-provider.js'),
              import('../llm/provider-detect.js'), import('./input/provider-picker.js'),
            ]);
            const llm = (await configForSessionProviderTurn(getUserConfig(), id ? getSessionProvider(id) : undefined)).llm;
            // Availability flags only; agent-cli logins (claude/agy) are not LLM providers here.
            const detected = await detectProviders().catch(() => []);
            const credentialed = new Set(detected.filter((entry) => entry.available && entry.auth !== 'agent-cli').map((entry) => entry.provider));
            providerPicker = picker.createProviderPickerPanel(picker.providerPickerEntries({
              current: llm.provider, currentModel: llm.model, defaults: PROVIDER_DEFAULT_MODEL, credentialed,
              rotation: (llm.rotation ?? []).map((item) => item.provider),
            }));
            status = 'provider 선택 · ↑↓ · Enter 적용 · Esc 닫기';
            render();
            continue;
          }
          activity = ['provider 목록 조회 중'];
          setBusy(true);
          // OBSERVE-TURN-EVENT-LIFECYCLE — 채팅 턴 밖의 busy(provider): provider 문 관측.
          try { emitTurnLife('turn-life:turn-start', { door: 'provider', turnSessionId: id, eventId: id }); } catch { /* observability is fail-open */ } // 출처: TC #92565 — eventId = turnSessionId
          status = 'provider 조회 중 · Esc 취소';
          const abort = new AbortController();
          turnAbort = abort;
          turnDone = import('../tui-client/local-provider-command.js')
            .then(({ runLocalProviderCommand }) => runLocalProviderCommand(command, abort.signal, (line) => {
              activity.push(safeStatusText(line));
              activity = activity.slice(-80);
              render();
            }, id ?? undefined))
            .then(() => { status = 'provider 명령 완료 · Enter 전송'; })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              status = message === 'provider lookup cancelled' || message === 'provider switch cancelled'
                ? 'provider 명령 취소됨 · Enter 전송'
                : `provider 실패: ${safeStatusText(message)}`;
            })
            .finally(() => {
              setBusy(false);
              turnAbort = null;
              settle();
              render();
            });
          render();
          continue;
        }
        if (route?.branchHost === 'loop' && route.branchModule) {
          const branch = await import(route.branchModule) as typeof import('../tui-client/next-loop-command.js');
          loopBranch ??= branch.createNextTuiLoopBranch(
            () => wakeup?.gate ?? null,
            (event, data) => debug.log('dashboard.loop', event, data),
          );
          activity.push(...loopBranch.run(submitted));
          status = 'Enter 전송';
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
          setBusy(true);
          // OBSERVE-TURN-EVENT-LIFECYCLE — 채팅 턴 밖의 busy(하니스): harness 문 관측.
          try { emitTurnLife('turn-life:turn-start', { door: 'harness', turnSessionId: id, eventId: id }); } catch { /* observability is fail-open */ } // 출처: TC #92565 — eventId = turnSessionId
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
              setBusy(false);
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
        if (route?.id === 'graph') {
          graphDetail.runCommand(submitted);
          render();
          continue;
        }
        if (route?.action === 'help') {
          const helpLines = (await loadNextTuiRouteRegistry()).buildNextTuiHelpLines();
          // Replace, not append: repeated /help shows one help block, not a growing stack.
          activity = [...helpLines];
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
          setBusy(true);
          // OBSERVE-TURN-EVENT-LIFECYCLE — 채팅 턴 밖의 busy(now 분기): internal 문 관측.
          try { emitTurnLife('turn-life:turn-start', { door: 'internal', turnSessionId: id, eventId: id }); } catch { /* observability is fail-open */ } // 출처: TC #92565 — eventId = turnSessionId
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
            setBusy(false);
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
              // An els row (this host's pane, a registered host's, herdr's) is typed into through `els do`, not the PTY manifest.
              const elsAddress = (await import('./sidetab/els-actions.js')).elsAddressOfRow(row);
              if (elsAddress) return (await import('./sidetab/els-actions.js')).sendToElsRow(await elsRowActions(), elsAddress, message);
              await ensureSidetabAttachments();
              return sidetabAttachments!.sendSideAgent(row, message);
            },
            readSelectedAgent: async () => {
              const row = sidetabRows[sidetabSelected];
              if (!row) return undefined;
              const elsAddress = (await import('./sidetab/els-actions.js')).elsAddressOfRow(row);
              if (elsAddress) return (await import('./sidetab/els-actions.js')).readElsRow(await elsRowActions(), elsAddress);
              await ensureSidetabAttachments();
              return sidetabAttachments!.readSideAgent(row);
            },
            sendSelectedAgentKeys: async (names) => {
              const row = sidetabRows[sidetabSelected];
              if (!row) return false;
              await ensureSidetabAttachments();
              return sidetabAttachments!.sendSideAgentKeys(row, names);
            },
            selectedAgentStatus: async () => {
              const row = sidetabRows[sidetabSelected];
              if (!row) return undefined;
              await ensureSidetabAttachments();
              return sidetabAttachments!.sideAgentStatus(row);
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
              if (mode === 'sidechat') refreshSidetabRows();
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
        if (route?.action === 'command' && slashHandlers.has(submitted.slice(1).trim().split(/\s+/)[0] ?? '')) {
          slashContext.chatLines = activity;
          const [command = '', ...args] = submitted.slice('/'.length).trim().split(/\s+/);
          const dispatched = await dispatchSlash(command, args, slashContext);
          if (!dispatched) activity.push('Unknown slash command');
          status = 'Enter 전송';
          render();
          continue;
        }
        if (!route) {
          // TUI-UNKNOWN-SLASH-NOT-SENT: a mistyped «/명령» is answered here, never sent as a paid model turn.
          const { unknownSlashNotice } = await import('./slash/unknown-slash.js');
          const known = routeRegistry.NEXT_TUI_ROUTE_REGISTRY.flatMap((entry) => [...entry.slash, ...entry.slashPrefixes]);
          const notice = unknownSlashNotice(submitted, known);
          if (notice) {
            activity.push(...notice);
            status = 'Enter 전송';
            render();
            continue;
          }
        }
        // A person's turn: an internal turn opened but not yet run gives way, and the door's «last turn» moves.
        wakeup?.gate.port.declined?.('human-turn');
        wakeup?.gate.noteHumanTurn();
        goalContinue?.noteHumanTurn(); agentEvents.resume(); needsHuman.resumed();
        finishFirst.noteHumanTurn();
        noteAutopilotHuman();
        humanTurnKeyAt = tuiLastHumanKeyAt();
        personTurnStarted = true;
        // OBSERVE-TURN-EVENT-LIFECYCLE — 한가 자리에 사람 턴 도착.
        try { emitTurnLife('turn-life:event-arrived', { source: 'human', busy: false, arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
        // JUD #38658 ⓑ: the seat is stopping — the person's line waits in the queue, no new turn.
        if (seatStopRef.current && !seatStopRef.current.allowsNewTurn()) {
          queue.enqueue(submittedFull);
          status = 'Seat stopping · your input is kept for the next session';
        // CAPSULE-C2 (flag on): a person's Enter takes the door, ahead of an automatic turn that has not started.
        } else if (entryDoor && !entryDoor.reserveHuman()) {
          queue.enqueue(submittedFull);
          status = '작업 중 · 다음 턴으로 대기';
        } else startChatTurn(submittedFull, undefined, { kind: 'human' }); // SEAT-HUMAN-GOAL-PIN ① — 사람 제출 경로는 출처를 명시 전달(미전달은 fail-closed · OP #130461)
      }
      render();
    }
  } finally {
    tuiClosed = true;
    if (turnElapsedTimer !== null) clearInterval(turnElapsedTimer);
    if (queueIdleTimer !== null) clearInterval(queueIdleTimer);
    if (autopilotTick !== null) clearInterval(autopilotTick);
    // MF(r3): TUI 닫힘 → 자리 우편 감시 폴링도 정지(핸들 보존으로 가능). 남으면 messages.db 를 계속 열고 죽은 큐에 notice 를 넣는다.
    seatMailWatcher.stop();
    workPullStop?.();
    offSeatStop();
    offIdleChildWake();
    offIdleGraphNode();
    offIdleGraphWake();
    offElsGraph();
    eventWatchStop.current?.();
    // #38260 REVIEW-2 ②: the fleet poller ends with this TUI (a re-entry creates its own; no second poller keeps asking).
    fleetSegment.stop();
    llmUsage.stop();
    if (simWatchTimer !== null) clearInterval(simWatchTimer);
    if (sidetabRefreshTimer !== null) clearInterval(sidetabRefreshTimer);
    stopElsFeed();
    if (sidetabChordTimer !== null) clearTimeout(sidetabChordTimer);
    sidetabAttachments?.close();
    restoreCliStderrSink?.();
    stopElsBuildReporter();
    restoreCliStderrSink = null;
    restoreTuiStderrOwner?.();
    restoreTuiStderrOwner = null;
    // ⌨️ TUI-TYPING-LAG-OBS — 등록 해제·프로브 정리(클래식 대시보드 teardown 과 같은 순서).
    setInputLagProbe(null);
    inputLagProbe.dispose();
    if (residueTimer !== null) clearTimeout(residueTimer);
    loopBranch?.dispose();
    wakeup?.dispose();
    if (wakeup) {
      const { setNextTuiWakeupTool } = await import('../tui-client/next-wakeup.js');
      setNextTuiWakeupTool(null);
    }
    const { setNextSidetabHandler, setNextSidetabIpcEnabled } = await import('../tui-client/local-chat-turn.js');
    publishApproval.dispose();
    shellApproval.dispose();
    harnessAskUser.dispose();
    const { setNextTuiPublishApprovalHandler, setNextTuiShellApprovalHandler, setNextTuiShellApprovalCancelHandler, setNextTuiHarnessAskUserHandler, setNextRunShellCardHandler } = await import('../tui-client/local-chat-turn.js');
    setNextTuiPublishApprovalHandler(null);
    setNextRunShellCardHandler(null);
    setNextTuiShellApprovalHandler(null);
    setNextTuiShellApprovalCancelHandler(null);
    setNextTuiHarnessAskUserHandler(null, null);
    setNextSidetabHandler(null);
    setNextSidetabIpcEnabled(false);
    (await import('../tui-client/local-chat-turn.js')).setNextMemberBoardSessionSource(null);
    turnAbort?.abort();
    // A wedged child must not hold the physical quit behind its own turn promise.
    if (humanQuitRequested) {
      closeTui();
      // The child close below owns cancellation. Never join a stalled turn on the physical quit path.
      void turnDone?.catch(() => {});
    } else await turnDone;
    capsuleSubscription.stop?.();
    capsuleActivitySubscription.stop?.();
    backgroundSubscription.stop?.();
    healthSubscription.stop?.();
    if (id) {
      const { closeLocalChatSession } = await import('../tui-client/local-chat-turn.js');
      const closing = closeLocalChatSession(id);
      if (humanQuitRequested) void closing.catch(() => {});
      else await closing;
    }
    process.stdout.off('resize', render);
    closeTui();
  }
  if (handoffExit && outerElsArmed) process.exitCode = (await import('./els-handoff.js')).runOuterEls();
}
