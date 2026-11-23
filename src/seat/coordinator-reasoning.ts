import type { UserConfig } from '../user-config/types.js';

/** A turn-local default, never a persisted config change or an override. */
export function coordinatorReasoningConfig(cfg: UserConfig, coordinator: boolean): UserConfig {
  if (!coordinator || cfg.llm.reasoningLevel !== undefined || cfg.llm.codexReasoning?.effort !== undefined) return cfg;
  return { ...cfg, llm: { ...cfg.llm, reasoningLevel: 'high' } };
}
