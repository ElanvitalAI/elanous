import { PROVIDER_DEFAULT_MODEL } from '../user-config.js';
import { resolveProviderCredentialAsync } from '../llm/provider-credentials.js';
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
  const provider = selection.provider;
  const changed = provider !== cfg.llm.provider;
  const credential = changed
    ? await resolveProviderCredentialAsync({
      provider, baseProvider: cfg.llm.provider, baseApiKey: cfg.llm.apiKey, rotation: cfg.llm.rotation,
    })
    : undefined;
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      provider,
      model: selection.model ?? (changed ? PROVIDER_DEFAULT_MODEL[provider] : cfg.llm.model),
      ...(changed ? { apiKey: credential?.apiKey, baseUrl: credential?.baseUrl } : {}),
    },
  };
}
