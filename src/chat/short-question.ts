// The classifier lives in core-turn so the headless ACP path (core-turn-bridge) can use it without importing
// chat code (tui-client-headless-guard). Existing chat callers keep this path.
export * from '../core-turn/short-question.js';
