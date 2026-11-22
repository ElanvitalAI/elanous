// CHAT-TOOLS-ENTRY-VIA-CORE-TURN — JUD-B TUI clause (OP decision #84368: the Next TUI is the demo and daily surface, so
// its tool turns take the same core turn as the CLI (#38246), the daemon and ACP). The decision is structural — the
// caller's own state, never a sentence classifier (R-SIG): `isResearchAgentIntent` no longer decides a Next TUI turn.
import { debug } from '../debug/log.js';

export type TuiCoreTurnSkipReason = 'no-tools' | 'harness-child';

export type TuiCoreTurnDecision = { coreTurn: true } | { coreTurn: false; reason: TuiCoreTurnSkipReason };

/**
 * Whether a Next TUI (repl child) turn runs through the core turn. Exclusions match #38246 (agent-cli.ts
 * `routeThroughCoreTurn`): a turn without tools and a harness child (`ELANOUS_HARNESS_SPACE`) keep their existing path.
 * A Next TUI turn never arms the goal loop (CHAT-GOAL-LOOP-DEFAULT-OFF), so there is no goal-loop exclusion here.
 * `ask` and allowlisted surfaces never reach the repl child.
 */
export function decideTuiCoreTurn(input: { hasTools: boolean; harnessChild: boolean }): TuiCoreTurnDecision {
  if (!input.hasTools) return { coreTurn: false, reason: 'no-tools' };
  if (input.harnessChild) return { coreTurn: false, reason: 'harness-child' };
  return { coreTurn: true };
}

/**
 * The per-turn route record, same event as the CLI (`chat.tools core-turn-route`): the decision (with the skip reason on
 * a skip branch), whether WebSearch reached the pool, and the research question-plan cost (planCalled · planLatencyMs).
 */
export function logTuiCoreTurnRoute(
  decision: TuiCoreTurnDecision,
  webSearchInPool: boolean,
  planCalls: ReadonlyArray<{ outcome: string; elapsedMs: number }>,
): void {
  try {
    debug.log('chat.tools', 'core-turn-route', {
      surface: 'tui', coreTurn: decision.coreTurn,
      ...(decision.coreTurn ? {} : { skipReason: decision.reason }),
      webSearch: webSearchInPool,
      planCalled: planCalls.length > 0,
      ...(planCalls.length > 0
        ? { planLatencyMs: planCalls.reduce((sum, call) => sum + call.elapsedMs, 0), planOutcome: planCalls.at(-1)!.outcome }
        : {}),
    });
  } catch { /* observation cannot interrupt a turn */ }
}
