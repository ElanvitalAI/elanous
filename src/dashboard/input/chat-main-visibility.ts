import type { PaneFocus } from '../../workspace-types.js';
import {
  deriveInputOwnershipSnapshot,
  type InputOwnershipSnapshot,
} from './input-owner.js';

export interface ChatMainInputVisibilityState {
  workingFocus: PaneFocus;
  blockingForegroundModalOpen: boolean;
  chatMainAvailable?: boolean;
  pluginActive: boolean;
  chordArmed: boolean;
  vwLocalComposerActive?: boolean;
  overlayInputActive?: boolean;
  questionActive?: boolean;
  inputOwnership?: InputOwnershipSnapshot;
}

/** Dashboard still computes the raw ownership signals locally, but the
 *  snapshot shape itself now lives here so `dashboard/index.ts` stops
 *  owning an ad-hoc visibility object contract. */
export function createChatMainInputVisibilityState(
  state: ChatMainInputVisibilityState,
): ChatMainInputVisibilityState {
  return {
    ...state,
    inputOwnership: state.inputOwnership
      ?? deriveInputOwnershipSnapshot({
        chatMainFocused: state.workingFocus === 'input' && !state.blockingForegroundModalOpen,
        chatMainAvailable: state.chatMainAvailable ?? true,
        vwLocalComposerActive: state.vwLocalComposerActive ?? false,
        overlayInputActive: state.overlayInputActive ?? false,
        questionActive: state.questionActive ?? false,
      }),
  };
}

/** Foreground-active means the legacy working-dir focus still points at
 *  the chat input AND no blocking foreground modal has demoted it into
 *  a background surface. */
export function isChatMainInputForegroundActive(
  state: Pick<
    ChatMainInputVisibilityState,
    | 'workingFocus'
    | 'blockingForegroundModalOpen'
    | 'chatMainAvailable'
    | 'vwLocalComposerActive'
    | 'overlayInputActive'
    | 'questionActive'
  >,
): boolean {
  return createChatMainInputVisibilityState({
    workingFocus: state.workingFocus,
    blockingForegroundModalOpen: state.blockingForegroundModalOpen,
    chatMainAvailable: state.chatMainAvailable,
    pluginActive: false,
    chordArmed: false,
    vwLocalComposerActive: state.vwLocalComposerActive,
    overlayInputActive: state.overlayInputActive,
    questionActive: state.questionActive,
  }).inputOwnership?.owner === 'chat-main';
}

/** Auto-entry is stricter than foreground-active: plugin-owned key
 *  flows and armed chords should keep control rather than dropping into
 *  the chat input loop. */
export function shouldAutoEnterChatMainInput(
  state: ChatMainInputVisibilityState,
): boolean {
  return isChatMainInputForegroundActive(state)
    && !state.pluginActive
    && !state.chordArmed;
}
