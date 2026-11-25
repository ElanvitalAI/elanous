/**
 * TUI widget kit (TUI-WIDGET-KIT-DEMO) — pure, width-aware renderers: props + width → lines. No I/O, no store reads,
 * no colour (cards in this TUI are plain lines; the painter styles them). Every line is ≤ width at 40/80/120.
 */
export { renderFanoutBoard, FANOUT_GLYPH, type FanoutAgent, type FanoutBoardProps, type FanoutState } from './fanout-board.js';
export { renderResultCard, type ResultCardProps, type ResultSection, type Evidence } from './result-card.js';
export { renderStepList, STEP_GLYPH, type Step, type StepListProps, type StepState } from './step-list.js';
export { renderStat, renderStatRow, STAT_TONE_MARK, type StatProps, type StatTone } from './stat.js';
export { renderGauge, gaugeTone, type GaugeProps, type GaugeTone } from './gauge.js';
export { renderPulseDot, renderCountdown, type CountdownProps } from './pulse.js';
export { renderHandGrid, HAND_GLYPH, type Hand, type HandGridProps, type HandState } from './hand-grid.js';
export { renderFlowLane, type FlowLaneProps } from './flow-lane.js';
export { renderTicker, type TickerEvent, type TickerProps } from './ticker.js';
export { renderHostTile, type HostTileProps, type HostState } from './host-tile.js';
export { renderSparkline } from './sparkline.js';
