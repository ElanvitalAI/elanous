import { PROVIDER_DEFAULT_MODEL } from '../user-config.js';
import { resolveProviderCredentialAsync } from '../llm/provider-credentials.js';
import { extractSessionProviderTurnConfig } from '../repl/session-provider-turn.js';
import type { UserConfig } from '../user-config/types.js';

/** Process-local selection. Credentials are resolved for each turn, never stored here.
 * Reference: openai/codex@970111f codex-rs/core/src/session/mod.rs:922-927,2031-2042,2081
 * keeps provider choice in session configuration; a shared global write is not needed.
 */
export interface SessionProviderSelection {
  readonly provider: UserConfig['llm']['provider'];
  readonly model?: string;
}

const selections = new Map<string, SessionProviderSelection>();

export function parseSessionProvider(provider: string, model?: string): SessionProviderSelection {
  const normalized = provider.trim().toLowerCase();
  if (!Object.hasOwn(PROVIDER_DEFAULT_MODEL, normalized)) throw new Error(`알 수 없는 provider: ${provider}`);
  if (model !== undefined && !model.trim()) throw new Error('모델 ID가 비었습니다');
  return { provider: normalized as SessionProviderSelection['provider'], ...(model ? { model: model.trim() } : {}) };
}

export function setSessionProvider(sessionId: string, selection: SessionProviderSelection): void {
  if (!sessionId) throw new Error('현재 대화를 찾을 수 없습니다');
  selections.set(sessionId, selection);
}

export function getSessionProvider(sessionId: string): SessionProviderSelection | undefined {
  return selections.get(sessionId);
}

export function clearSessionProvider(sessionId: string): void {
  selections.delete(sessionId);
}

/** Apply the host's non-secret choice to the real REPL turn via existing credential sources.
 * Reference: xai-org/grok-build@2bdd1d6 crates/codegen/xai-grok-shell/src/session/acp_session_impl/model_switch.rs:79-118
 * applies selected model and credential together. We resolve credential at turn time and store only choice.
 */
export async function configForSessionProviderTurn(
  cfg: UserConfig,
  selection: SessionProviderSelection | undefined,
): Promise<UserConfig> {
  if (!selection) return cfg;
  const changed = selection.provider !== cfg.llm.provider;
  const credential = changed
    ? await resolveProviderCredentialAsync({
      provider: selection.provider, baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey, rotation: cfg.llm.rotation,
    })
    : undefined;
  // Single-sourced merge shape (TUI-NEXT-PROVIDER-FLAG-IGNORED): the pure
  // helper owns provider/model selection; this wrapper only adds credentials.
  const merged = extractSessionProviderTurnConfig(cfg, selection, true);
  return {
    ...merged,
    llm: {
      ...merged.llm,
      ...(changed ? { apiKey: credential?.apiKey, baseUrl: credential?.baseUrl } : {}),
    },
  };
}

/** HARNESS-CHILD-PROVIDER-PASSTHROUGH: the session's --provider/--model choice must reach every LLM
 * call the session's REPL child makes — the main turn (goal-loop/research core path resolves the
 * provider from user config, not from the per-turn cfg) and in-process Agent children — plus any
 * harness/CLI child that process spawns. The existing per-run env override does exactly that:
 * user-config resolves ELANOUS_LLM_PROVIDER/ELANOUS_LLM_MODEL with the matching credential.
 */
export interface SessionProviderChildEnv {
  /** Env entries to add to the REPL child; empty when the session has no explicit choice. */
  readonly env: Record<string, string>;
  /** Identity of the choice the child was started with; a different key needs a fresh child. */
  readonly key: string;
}

export function sessionProviderChildEnv(selection: SessionProviderSelection | undefined): SessionProviderChildEnv {
  if (!selection) return { env: {}, key: '' };
  const model = selection.model ?? PROVIDER_DEFAULT_MODEL[selection.provider];
  return {
    env: { ELANOUS_LLM_PROVIDER: selection.provider, ...(model ? { ELANOUS_LLM_MODEL: model } : {}) },
    key: `${selection.provider}/${model ?? ''}`,
  };
}
