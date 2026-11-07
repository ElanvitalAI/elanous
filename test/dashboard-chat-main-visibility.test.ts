import { describe, expect, test } from 'bun:test';

import {
  createChatMainInputVisibilityState,
  isChatMainInputForegroundActive,
  shouldAutoEnterChatMainInput,
} from '../src/dashboard/input/chat-main-visibility.js';

describe('chat-main visibility helpers', () => {
  test('snapshot builder preserves the ownership shape in one exported seam', () => {
    expect(createChatMainInputVisibilityState({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: true,
      chordArmed: false,
      vwLocalComposerActive: true,
      overlayInputActive: false,
    })).toEqual({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: true,
      chordArmed: false,
      vwLocalComposerActive: true,
      overlayInputActive: false,
      inputOwnership: {
        owner: 'vw-local-composer',
        chatMainSuppressed: true,
        vwLocalComposerSuppressed: false,
      },
    });
  });

  test('snapshot builder preserves an explicit ownership snapshot when provided', () => {
    expect(createChatMainInputVisibilityState({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: false,
      chordArmed: false,
      inputOwnership: {
        owner: 'chat-main',
        chatMainSuppressed: false,
        vwLocalComposerSuppressed: true,
      },
    }).inputOwnership).toEqual({
      owner: 'chat-main',
      chatMainSuppressed: false,
      vwLocalComposerSuppressed: true,
    });
  });

  test('foreground-active requires input focus and no blocking modal', () => {
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
    })).toBe(true);
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: true,
    })).toBe(false);
    expect(isChatMainInputForegroundActive({
      workingFocus: 'log',
      blockingForegroundModalOpen: false,
    })).toBe(false);
  });

  test('foreground-active stays off when the current workspace does not expose host input', () => {
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      chatMainAvailable: false,
    })).toBe(false);
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      chatMainAvailable: false,
      pluginActive: false,
      chordArmed: false,
    })).toBe(false);
  });

  test('foreground-active stays off when another workspace owns the foreground even if host chrome rows remain visible', () => {
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      chatMainAvailable: false,
      vwLocalComposerActive: false,
      overlayInputActive: false,
    })).toBe(false);
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      chatMainAvailable: false,
      pluginActive: false,
      chordArmed: false,
      vwLocalComposerActive: false,
      overlayInputActive: false,
    })).toBe(false);
  });

  test('vw local composer or overlay input suppresses chat-main foreground activity', () => {
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      vwLocalComposerActive: true,
    })).toBe(false);
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      overlayInputActive: true,
    })).toBe(false);
  });

  test('chat-main foreground recovers after overlay dismissal only when no higher owner remains', () => {
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      vwLocalComposerActive: true,
      overlayInputActive: true,
    })).toBe(false);
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      vwLocalComposerActive: true,
      overlayInputActive: false,
    })).toBe(false);
    expect(isChatMainInputForegroundActive({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      vwLocalComposerActive: false,
      overlayInputActive: false,
    })).toBe(true);
  });

  test('auto-entry is disabled by plugin activity or an armed chord', () => {
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: false,
      chordArmed: false,
    })).toBe(true);
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: true,
      chordArmed: false,
    })).toBe(false);
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: false,
      chordArmed: true,
    })).toBe(false);
  });

  test('auto-entry stays off while vw local composer or overlay input owns input', () => {
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: false,
      chordArmed: false,
      vwLocalComposerActive: true,
    })).toBe(false);
    expect(shouldAutoEnterChatMainInput({
      workingFocus: 'input',
      blockingForegroundModalOpen: false,
      pluginActive: false,
      chordArmed: false,
      overlayInputActive: true,
    })).toBe(false);
  });
});
