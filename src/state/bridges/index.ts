// ── Presentation track P1.5+ · state bridges barrel ──
//
// Re-exports bridge installers that sync external services with the
// P1 state store. Each bridge is additive · caller owns dispose.

export { bridgeContextKeysToStore } from './context-keys.js';
export { bridgePluginHostToStore } from './plugin-host.js';
export { bridgeViewModeToContextKeys, publishViewMode } from './view-mode.js';
