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
