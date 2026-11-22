import { PROVIDER_DEFAULT_MODEL } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';

/** Session provider choice from a REPL turn (JSONL stdin path).
 * Mirrors `ScenarioTurn.sessionProvider` in repl/index.ts — provider is validated
 * upstream by parseSessionProvider, here we only carry the non-secret choice.
 */
export interface SessionProviderTurnChoice {
  readonly provider: string;
  readonly model?: string;
}

/**
 * TUI-NEXT-PROVIDER-FLAG-IGNORED: whether a turn's sessionProvider choice is
 * applied must not depend on the ELANOUS_NEXT_TUI_STREAM env gate. `elanous
 * --tui next --provider glm --model glm-5` spawns a non-stream REPL child; the
 * old wiring applied the choice only behind `stream === '1'`, silently
 * ignoring it on the plain JSONL path. Pure decision so both paths share it.
 */
export function sessionProviderAppliesToTurn(
  turn: { sessionProvider?: SessionProviderTurnChoice },
): boolean {
  return turn.sessionProvider !== undefined;
}

/** Turn-config merge for the session provider choice — pure shape only
 * (credential resolution stays in configForSessionProviderTurn). Returns the
 * same cfg object when there is no choice, so callers can identity-check.
 */
export function extractSessionProviderTurnConfig(
  cfg: UserConfig,
  choice: SessionProviderTurnChoice | undefined,
  _streamGate: boolean,
): UserConfig {
  if (!choice) return cfg;
  void _streamGate; // TUI-NEXT-PROVIDER-FLAG-IGNORED: the gate must not change the outcome.
  const provider = choice.provider as UserConfig['llm']['provider'];
  const changed = provider !== cfg.llm.provider;
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      provider,
      model: choice.model ?? (changed ? PROVIDER_DEFAULT_MODEL[provider] : cfg.llm.model),
    },
  };
}
