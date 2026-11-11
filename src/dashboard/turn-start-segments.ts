/** Classic dashboard compatibility entry for shared TUI turn-start tracing. */
export {
  TURN_START_CATEGORY,
  TURN_START_SEGMENTS_EVENT,
  TURN_START_TRACE_CAP_MS,
  createTurnStartSegments,
  setTurnStartSegments,
  beginTurnStartSegments,
  markTurnStartSegment,
  endTurnStartSegments,
} from '../tui/turn-start-segments.js';
export type {
  TurnStartSegments,
  TurnStartSegmentsOptions,
  TurnStartSegmentsRecorder,
} from '../tui/turn-start-segments.js';
