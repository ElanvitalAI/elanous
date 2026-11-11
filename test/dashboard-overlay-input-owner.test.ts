import { describe, expect, test } from 'bun:test';

import {
  hasOverlayInputOwner,
  isOverlayInputSurface,
} from '../src/dashboard/input/overlay-input.js';
import type { DisplaySurface, ModalTier, SurfaceId } from '../src/display/types.js';

function modal(id: SurfaceId, opts: {
  tier: ModalTier;
  focus?: 'owns' | 'participates' | 'none';
  interactionClass?: 'workspace' | 'blocking-modal' | 'embedded-overlay';
}): DisplaySurface {
  return {
    id,
    kind: 'modal',
    owner: 'dashboard',
    priority: 100,
    focus: opts.focus ?? 'owns',
    tier: opts.tier,
    interactionClass: opts.interactionClass,
    bounds: { row: 1, col: 1, width: 10, height: 3 },
    paint: () => '',
    render: () => [],
  };
}

describe('dashboard overlay input owner', () => {
  test('focus:owns popup modal owns overlay input', () => {
    const surface = modal('popup:1', { tier: 'popup' });
    expect(isOverlayInputSurface(surface)).toBe(true);
    expect(hasOverlayInputOwner({
      focusStack: ['popup:1'],
      surfaceAt: () => surface,
    })).toBe(true);
  });

  test('focus:participates picker does NOT own overlay input (chat picker contract)', () => {
    // Bugfix 2026-05-03 — picker-flicker RCA: chat slash/at/skill/arg
    // pickers declare `focus: 'participates'` (paint-only, receive
    // onKey via dispatch chain) but do NOT own input — chat-main is
    // still the input owner. Treating them as overlay-input owners
    // suppressed chat-main, which then triggered `clearAll()` on the
    // picker, which then released the suppression — a 30 Hz mount/
    // unmount feedback loop. Only `focus === 'owns'` actually captures.
    const surface = modal('picker:1', {
      tier: 'picker',
      focus: 'participates',
    });
    expect(isOverlayInputSurface(surface)).toBe(false);
  });

  test('focus:owns picker captures overlay input', () => {
    // Distinguish from the participates case: pickers built via
    // `mountViewAsModalSurface` pickers with their own query input
    // declare `focus: 'owns'` because
    // they have their own query input and capture the keystrokes.
    const surface = modal('picker:owning', {
      tier: 'picker',
      focus: 'owns',
    });
    expect(isOverlayInputSurface(surface)).toBe(true);
  });

  test('focus:none picker is paint-only and does NOT own input', () => {
    const surface = modal('picker:paint-only', {
      tier: 'picker',
      focus: 'none',
    });
    expect(isOverlayInputSurface(surface)).toBe(false);
  });

  test('terminal and tooltip surfaces do not count as overlay-input owners', () => {
    expect(isOverlayInputSurface(modal('term:1', { tier: 'terminal' }))).toBe(false);
    expect(isOverlayInputSurface(modal('tip:1', { tier: 'tooltip', focus: 'none' }))).toBe(false);
  });

  test('workspace and embedded-overlay surfaces do not count as overlay-input owners even if focus:owns', () => {
    expect(isOverlayInputSurface(modal('vw:1', {
      tier: 'vw',
      interactionClass: 'workspace',
    }))).toBe(false);
    expect(isOverlayInputSurface(modal('companion:1', {
      tier: 'popup',
      interactionClass: 'embedded-overlay',
    }))).toBe(false);
  });

  test('top-down scan skips non-input overlays and finds popup below them', () => {
    const surfaces = new Map<SurfaceId, DisplaySurface>([
      ['popup:1', modal('popup:1', { tier: 'popup' })],
      ['tip:1', modal('tip:1', { tier: 'tooltip', focus: 'none' })],
    ]);
    expect(hasOverlayInputOwner({
      focusStack: ['popup:1', 'tip:1'],
      surfaceAt: (id) => surfaces.get(id),
    })).toBe(true);
  });
});
