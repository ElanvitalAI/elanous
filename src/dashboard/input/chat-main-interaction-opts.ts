import type { Key } from '../../tui.js';
import type { ChatMainTextInputBaseOpts } from './chat-main-turn.js';
import {
  resolveChatMainInputPointerAction,
  resolveChatMainInputPreKeyAction,
  runChatMainInputPointerAction,
  runChatMainInputPreKeyAction,
} from './chat-main-actions.js';
import type { DisplayMouseEvent } from '../../display/types.js';
import type { DashboardKeyRouteResult } from './key-types.js';

export type DashboardChatMainInteractionOpts = Pick<
  ChatMainTextInputBaseOpts,
  | 'cursorSink'
  | 'canClaimCursor'
  | 'modalSink'
  | 'shouldSyncPickers'
  | 'onPasteImage'
  | 'onKey'
  | 'onPreKey'
  | 'onQuitChord'
  | 'onMouse'
>;

export interface CreateDashboardChatMainInteractionOptsDeps {
  cursorSink: NonNullable<DashboardChatMainInteractionOpts['cursorSink']>;
  canClaimCursor?: DashboardChatMainInteractionOpts['canClaimCursor'];
  modalSink: NonNullable<DashboardChatMainInteractionOpts['modalSink']>;
  shouldSyncPickers?: DashboardChatMainInteractionOpts['shouldSyncPickers'];
  onPasteImage: NonNullable<DashboardChatMainInteractionOpts['onPasteImage']>;
  routeVoiceKey?: (key: Key) => 'consumed' | 'passthrough' | Promise<'consumed' | 'passthrough'>;
  /** PR-S1V.D4 (2026-04-29) — long-press Space dictation pre-key hook.
   *  Dashboard wires this to a `space-longpress-detector` that watches
   *  the OS key-repeat stream and fires `voice-input-host.startDictation`
   *  / `stopDictation` at the right moments. The detector itself decides
   *  consumed vs passthrough — typically `'passthrough'` so the first
   *  Space char still lands in the input buffer (long-press does not
   *  cancel that), and `'consumed'` only after the long-press has fired
   *  (to swallow the OS key-repeat stream so dictation isn't typed in
   *  alongside the transcript). Optional — when omitted, no long-press
   *  detection happens and Space behaves exactly as it did pre-D4.
   *
   *  Async return so the cancel-by-other-key path can `await
   *  host.stopDictation()` before the terminator key reaches the chat
   *  input — without that await the transcript insert can race the
   *  terminator and produce out-of-order buffer like "a<transcript>"
   *  instead of "<transcript>a" (PR #1109 review fix). */
  routeLongPressDictation?: (key: Key) => 'consumed' | 'passthrough' | Promise<'consumed' | 'passthrough'>;
  routeInputKey: NonNullable<DashboardChatMainInteractionOpts['onKey']>;
  routeQuitChord?: NonNullable<DashboardChatMainInteractionOpts['onQuitChord']>;
  shouldRouteInputDispatcherKey?: (key: Key) => boolean;
  hasActiveStatusPopup: () => boolean;
  hasTerminalModal: () => boolean;
  shouldRouteForegroundModalKey?: (key: Key) => boolean;
  toKeyEvent: (key: Key) => Parameters<typeof resolveChatMainInputPreKeyAction>[1]['toKeyEvent'] extends (key: Key) => infer R ? R : never;
  routeStatusPopupKey: (key: Key) => DashboardKeyRouteResult;
  handleTerminalModalKey: Parameters<typeof runChatMainInputPreKeyAction>[1]['handleTerminalModalKey'];
  tryRouteForegroundModalKey: Parameters<typeof runChatMainInputPreKeyAction>[1]['tryRouteForegroundModalKey'];
  redraw: () => void;
  dispatchMouse: (mouse: DisplayMouseEvent) => void;
}

export function createDashboardChatMainInteractionOpts(
  deps: CreateDashboardChatMainInteractionOptsDeps,
): DashboardChatMainInteractionOpts {
  return {
    cursorSink: deps.cursorSink,
    canClaimCursor: deps.canClaimCursor,
    modalSink: deps.modalSink,
    shouldSyncPickers: deps.shouldSyncPickers,
    onPasteImage: deps.onPasteImage,
    onKey: async (key) => {
      if (deps.shouldRouteInputDispatcherKey?.(key) === false) {
        return 'passthrough';
      }
      return await deps.routeInputKey(key);
    },
    onQuitChord: deps.routeQuitChord,
    onPreKey: async (key) => {
      if (deps.routeVoiceKey) {
        const voiceRoute = await deps.routeVoiceKey(key);
        if (voiceRoute === 'consumed') return 'consumed';
      }
      // PR-S1V.D4 — Long-press Space dictation hook. Sits between the
      // explicit voice chord (Ctrl+Shift+V) and the modal/popup pre-key
      // path so a long Space hold becomes dictation regardless of
      // whether a popup or terminal modal is active. The detector
      // decides consumed (post-fire OS repeats / final release) vs
      // passthrough (first Space char before threshold).
      if (deps.routeLongPressDictation) {
        const dictationRoute = await deps.routeLongPressDictation(key);
        if (dictationRoute === 'consumed') return 'consumed';
      }
      if (deps.shouldRouteForegroundModalKey?.(key) === false) {
        return 'passthrough';
      }
      const action = resolveChatMainInputPreKeyAction(key, {
        hasActiveStatusPopup: deps.hasActiveStatusPopup(),
        hasTerminalModal: deps.hasTerminalModal(),
        toKeyEvent: deps.toKeyEvent,
      });
      return await runChatMainInputPreKeyAction(action, {
        routeStatusPopupKey: deps.routeStatusPopupKey,
        handleTerminalModalKey: deps.handleTerminalModalKey,
        tryRouteForegroundModalKey: deps.tryRouteForegroundModalKey,
        redraw: deps.redraw,
      });
    },
    onMouse: (mouse) => {
      runChatMainInputPointerAction(
        resolveChatMainInputPointerAction(mouse),
        { dispatchMouse: deps.dispatchMouse },
      );
      if (deps.canClaimCursor?.() === false) {
        return false;
      }
    },
  };
}
