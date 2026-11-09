// ── Discord agent turn — thin flavor shim (M4a) ──
//
// PLAN-multi-surface-pty-shell M4a: the Discord flavor of the elanous
// self turn. Shares the full assembly (tools + finance pack +
// delegate_code_agent + M1 terminal layer + ambient prompts + footer)
// with telegram via src/agent/monad-agent-turn.ts; discord-specific
// deltas ride the per-turn opts (hitlFileSink = fileSinkForChannel for
// screenshot attachments; no `tgChat` ⇒ active-delegation arming stays
// off until M4b ports the interweaving stack).

import type { UserConfig } from './user-config/types.js';
import type { runTurn } from './session/chat.js';
import { makeElanousAgentRunTurn } from './agent/monad-agent-turn.js';

/** Discord flavor of the elanous self turn — consumed by the
 *  `discord-test` runner (M4a-0) and, once the production wire lands,
 *  the nexus discord bot. */
export function makeDiscordAgentRunTurn(cfg: UserConfig): typeof runTurn {
  return makeElanousAgentRunTurn(cfg, 'discord');
}
