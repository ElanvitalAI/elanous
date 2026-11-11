import type { DisplayEvent } from '../display/events.js';
import { isPtyForwardMouseEventType, type DisplayMouseEvent } from '../display/types.js';
import {
  deriveTerminalCapability,
  type TerminalExposureSnapshot,
  type TerminalSurfaceCapability,
} from '../terminal/posture.js';
import {
  resolveTerminalInteractionPolicy,
  type TerminalInteractionPolicy,
} from '../terminal/tui-policy.js';

export type TerminalSurfaceIntentKind =
  | 'caret-focus'
  | 'word-select'
  | 'context-menu'
  | 'viewport-scroll'
  | 'range-select-update'
  | 'range-select-end'
  | 'hover';

export type TerminalMouseIntentEvent = Extract<DisplayEvent, { type: 'terminal:mouse-intent' }>;

export interface TerminalMouseIntentSpec {
  surfaceId: string;
  paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
  mouseType: DisplayMouseEvent['type'];
  row: number;
  col: number;
  exposure: TerminalExposureSnapshot;
  interactionPolicy?: TerminalInteractionPolicy;
}

export function buildTerminalMouseIntentEvent(
  spec: TerminalMouseIntentSpec,
): TerminalMouseIntentEvent {
  return {
    type: 'terminal:mouse-intent',
    surfaceId: spec.surfaceId,
    paneKind: spec.paneKind,
    mouseType: spec.mouseType,
    row: spec.row,
    col: spec.col,
    transport: isPtyForwardMouseEventType(spec.mouseType) ? 'pty-forward' : 'host-only',
    exposure: spec.exposure,
    interactionPolicy: spec.interactionPolicy ?? resolveTerminalInteractionPolicy(spec.exposure),
  };
}

export function interpretTerminalSurfaceIntent(
  event: Pick<TerminalMouseIntentEvent, 'mouseType'>,
): TerminalSurfaceIntentKind {
  switch (event.mouseType) {
    case 'click':
      return 'caret-focus';
    case 'double-click':
      return 'word-select';
    case 'right-click':
      return 'context-menu';
    case 'scroll-up':
    case 'scroll-down':
      return 'viewport-scroll';
    case 'drag':
      return 'range-select-update';
    case 'release':
      return 'range-select-end';
    case 'motion':
      return 'hover';
  }
}

/**
 * PR-2 of multi-platform substrate ROADMAP — JSON-clean semantic intent
 * payload that flows through the consumer chain.
 *
 * Per G6 (capability is gate, intent is meaning): both `kind` (intent
 * meaning) and `capability` (gate vector) appear together. Consumers
 * inspect kind to decide *what* to do, then check capability booleans
 * to decide *whether* the action is permitted.
 *
 * Per G3 (motion / hover canonical chain 밖): `intentFromMouseEvent`
 * returns null for `motion`, so consumers never see `kind: 'hover'`.
 *
 * Per G5 (PTY byte ↔ host interpretation 분리): no PTY byte fields
 * (modifier flags / scroll deltas / screen-coord tuple) carry through.
 * The consumer chain handles host lane only.
 *
 * Serializable-first: every field is JSON-clean. ACP / Discord / PWA
 * gateways can mirror this payload over the wire without translation.
 */
export interface SerializableSurfaceIntent {
  kind: TerminalSurfaceIntentKind;
  surfaceId: string;
  paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
  row: number;
  col: number;
  /** Layer 1 vocabulary — host-agnostic. */
  exposure: TerminalExposureSnapshot;
  /** Per G6 — capability is included so consumers can gate without
   *  re-deriving from exposure. */
  capability: TerminalSurfaceCapability;
}

/**
 * Project a raw `terminal:mouse-intent` event into a serializable
 * surface intent. Returns null for motion (G3) so callers can early-exit
 * their consumer chain on hover events.
 */
export function intentFromMouseEvent(
  event: TerminalMouseIntentEvent,
): SerializableSurfaceIntent | null {
  // G3 — motion / hover stay outside the canonical chain. They
  // continue to flow into the debug mirror but do not enter the
  // consumer-walk path.
  if (event.mouseType === 'motion') return null;
  return {
    kind: interpretTerminalSurfaceIntent(event),
    surfaceId: event.surfaceId,
    paneKind: event.paneKind,
    row: event.row,
    col: event.col,
    exposure: event.exposure,
    capability: deriveTerminalCapability(event.exposure),
  };
}
