// ── D (Phase 3 Bundle 2) — Touch event → SerializableSurfaceIntent ──
//
// 모바일 터치 이벤트 (TouchEvent) 를 substrate Layer 1/2 vocabulary 의
// `SerializableSurfaceIntent` 로 매핑. 데스크탑 mouse → intent 와 같은
// 통일 lane — consumer chain 변경 없이 모바일 통합.
//
// 매핑:
//   single tap                    → caret-focus
//   double tap (300ms 내 2회)      → word-select
//   long press (500ms holding)     → context-menu
//   pinch / spread                 → viewport-scroll (pinch=zoom out,
//                                       spread=zoom in — host 가 결정)
//   swipe (drag → release)         → range-select-update + range-select-end
//
// Pure stateless mapper — host 가 (touchstart, touchmove, touchend)
// 를 sequence 로 넘기면 detector 가 적절한 intent kind 결정.

import type { SerializableSurfaceIntent } from '../surface/terminal-surface-intent.js';
import type { TerminalExposureSnapshot, TerminalSurfaceCapability } from '../terminal/posture.js';

export interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
  /** 1-based touch identifier (multitouch 추적용). */
  readonly identifier: number;
}

export type TouchPhase = 'start' | 'move' | 'end' | 'cancel';

export interface TouchEvent {
  readonly phase: TouchPhase;
  readonly touches: readonly TouchPoint[];
  readonly timestamp: number;
}

export interface TouchSurfaceContext {
  readonly surfaceId: string;
  readonly paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
  readonly exposure: TerminalExposureSnapshot;
  readonly capability: TerminalSurfaceCapability;
  /** Pixel-to-cell conversion: (x, y) → (row, col). Caller knows
   *  the terminal cell metrics. */
  readonly pixelToCell: (x: number, y: number) => { row: number; col: number };
}

// ── State machine ───────────────────────────────────────────────────

export interface TouchDetectorState {
  /** Current sequence: start, optional moves, end. */
  readonly phase: 'idle' | 'pressing' | 'moved';
  /** First touch start position. */
  readonly startPos?: { x: number; y: number };
  /** First touch start time. */
  readonly startedAt?: number;
  /** Last move position (for swipe end). */
  readonly lastMovePos?: { x: number; y: number };
  /** Number of taps detected within DOUBLE_TAP_WINDOW. */
  readonly tapCount: number;
  /** Last tap end time (for double-tap detection). */
  readonly lastTapEndAt?: number;
  /** Long-press timer scheduled. Returns true if fired. */
  readonly longPressFired: boolean;
}

export const initialTouchState: TouchDetectorState = {
  phase: 'idle',
  tapCount: 0,
  longPressFired: false,
};

export const DOUBLE_TAP_WINDOW_MS = 300;
export const LONG_PRESS_THRESHOLD_MS = 500;
export const SWIPE_DISTANCE_THRESHOLD_PX = 10;

export interface TouchToIntentResult {
  readonly intent: SerializableSurfaceIntent | null;
  readonly nextState: TouchDetectorState;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Pure step function — feed every TouchEvent + current state →
 * (optional emitted intent, next state). Host owns the long-press
 * timer (setTimeout) — when timer fires, call this with a synthetic
 * `phase: 'long-press-fire'` ... actually, simpler: long-press is
 * detected on `end` if duration > threshold + no significant move.
 */
export function processTouchEvent(
  event: TouchEvent,
  state: TouchDetectorState,
  ctx: TouchSurfaceContext,
): TouchToIntentResult {
  const touch = event.touches[0];

  switch (event.phase) {
    case 'start': {
      if (!touch) return { intent: null, nextState: state };
      return {
        intent: null,
        nextState: {
          phase: 'pressing',
          startPos: { x: touch.clientX, y: touch.clientY },
          startedAt: event.timestamp,
          lastMovePos: { x: touch.clientX, y: touch.clientY },
          tapCount: state.tapCount,
          ...(state.lastTapEndAt !== undefined ? { lastTapEndAt: state.lastTapEndAt } : {}),
          longPressFired: false,
        },
      };
    }

    case 'move': {
      if (!touch || state.phase === 'idle') return { intent: null, nextState: state };
      const moved = state.startPos
        ? distance(state.startPos, { x: touch.clientX, y: touch.clientY })
        : 0;
      const phase = moved > SWIPE_DISTANCE_THRESHOLD_PX ? 'moved' : state.phase;
      const nextState: TouchDetectorState = {
        ...state,
        phase,
        lastMovePos: { x: touch.clientX, y: touch.clientY },
      };
      // While moving, emit range-select-update.
      if (phase === 'moved') {
        const cell = ctx.pixelToCell(touch.clientX, touch.clientY);
        return {
          intent: {
            kind: 'range-select-update',
            surfaceId: ctx.surfaceId,
            paneKind: ctx.paneKind,
            row: cell.row,
            col: cell.col,
            exposure: ctx.exposure,
            capability: ctx.capability,
          },
          nextState,
        };
      }
      return { intent: null, nextState };
    }

    case 'end': {
      const startPos = state.startPos;
      const startedAt = state.startedAt;
      if (!startPos || startedAt === undefined) {
        return { intent: null, nextState: initialTouchState };
      }
      const endPos = state.lastMovePos ?? startPos;
      const duration = event.timestamp - startedAt;
      const moved = distance(startPos, endPos);
      const cell = ctx.pixelToCell(endPos.x, endPos.y);

      // Swipe → range-select-end
      if (moved > SWIPE_DISTANCE_THRESHOLD_PX) {
        return {
          intent: {
            kind: 'range-select-end',
            surfaceId: ctx.surfaceId,
            paneKind: ctx.paneKind,
            row: cell.row,
            col: cell.col,
            exposure: ctx.exposure,
            capability: ctx.capability,
          },
          nextState: initialTouchState,
        };
      }

      // Long press → context-menu
      if (duration >= LONG_PRESS_THRESHOLD_MS) {
        return {
          intent: {
            kind: 'context-menu',
            surfaceId: ctx.surfaceId,
            paneKind: ctx.paneKind,
            row: cell.row,
            col: cell.col,
            exposure: ctx.exposure,
            capability: ctx.capability,
          },
          nextState: initialTouchState,
        };
      }

      // Tap — check for double-tap.
      const isDoubleTap =
        state.lastTapEndAt !== undefined &&
        (event.timestamp - state.lastTapEndAt) < DOUBLE_TAP_WINDOW_MS;
      if (isDoubleTap) {
        return {
          intent: {
            kind: 'word-select',
            surfaceId: ctx.surfaceId,
            paneKind: ctx.paneKind,
            row: cell.row,
            col: cell.col,
            exposure: ctx.exposure,
            capability: ctx.capability,
          },
          nextState: initialTouchState,
        };
      }
      // Single tap → caret-focus + record for double-tap detection.
      return {
        intent: {
          kind: 'caret-focus',
          surfaceId: ctx.surfaceId,
          paneKind: ctx.paneKind,
          row: cell.row,
          col: cell.col,
          exposure: ctx.exposure,
          capability: ctx.capability,
        },
        nextState: { ...initialTouchState, lastTapEndAt: event.timestamp, tapCount: 1 },
      };
    }

    case 'cancel': {
      return { intent: null, nextState: initialTouchState };
    }
  }
}
