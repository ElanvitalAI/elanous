// ── Telegram agent turn — thin flavor shim (M4a) ──
//
// The full assembly (T1/A0 tools + finance pack + delegate_code_agent +
// M1 terminal layer + ambient prompts + footer) moved VERBATIM to
// src/agent/monad-agent-turn.ts when the Discord surface joined
// (PLAN-multi-surface-pty-shell M4a, 2026-07-12). This module keeps the
// telegram-flavored entry point + the historical import path alive.

import type { UserConfig } from './user-config/types.js';
import type { runTurn } from './session/chat.js';
import { makeElanousAgentRunTurn } from './agent/monad-agent-turn.js';

export { delegateBackendToSlashKey } from './agent/monad-agent-turn.js';

/** Telegram flavor of the elanous self turn — drop-in for botFromConfig's
 *  `runTurnImpl`. See makeElanousAgentRunTurn for the shared assembly. */
export function makeTelegramAgentRunTurn(cfg: UserConfig): typeof runTurn {
  return makeElanousAgentRunTurn(cfg, 'telegram');
}
