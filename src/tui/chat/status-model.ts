import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getUserConfig } from '../../user-config/reader.js';
import { getSessionProvider } from '../../tui-client/session-provider.js';
import { getSessionTierOverride } from '../../model-tier/session-override.js';
import { PROVIDER_DEFAULT_MODEL } from '../../user-config.js';

/** The provider/model the NEXT request will use, as the TUI knows it without reading credentials or starting a
 *  provider. One resolver for the status bar, `/status` and `/provider` so they cannot disagree
 *  (TUI-MODEL-DISPLAY-CONSISTENT). */
export function resolveNextTuiSelection(
  sessionId?: string,
  session?: { readonly provider?: string; readonly model?: string } | null,
): { readonly provider: string; readonly model: string } {
  const config = getUserConfig();
  const selected = sessionId ? getSessionProvider(sessionId) : undefined;
  const override = sessionId ? explicitTurnTier(config, sessionId)?.model : undefined;
  const provider = selected?.provider
    ?? (config.llm.provider === 'auto' ? session?.provider ?? config.llm.provider : config.llm.provider);
  const model = selected?.model || override
    || (selected && selected.provider !== config.llm.provider ? PROVIDER_DEFAULT_MODEL[selected.provider] : undefined)
    || (config.llm.model === 'auto' ? session?.model : undefined)
    || config.llm.model || session?.model
    // DEMO-ENGLISH-FIRST-RUN: first run saves the provider with an empty model — show that provider's default, not «unset».
    || PROVIDER_DEFAULT_MODEL[provider as keyof typeof PROVIDER_DEFAULT_MODEL] || 'unset';
  return { provider, model };
}

/** Current configured/selected model label without reading credentials or starting a provider. */
export function readNextTuiStatusModel(
  sessionId?: string,
  session?: { readonly provider?: string; readonly model?: string } | null,
): string {
  const { provider, model } = resolveNextTuiSelection(sessionId, session);
  return `${provider}/${model}`;
}

/** ELS-SEAT-MODEL-DECLARE: the footer model. A session-scoped choice (`/provider` or launch `--provider`) is what the
 *  next request uses, so it wins over the last route badge — that badge still names the model before the switch. */
/** SEAT-MODEL-SURVIVES-MIGRATION (live 11-27 11:2x): OP's main turns ran on gpt-6.1-sol after `/model deep` while the
 *  footer still said gpt-6.1-terra — the route badge is the config route, blind to the session tier override. The footer
 *  now shows the model the main turn uses: a session provider or a session tier override (statusModel already resolves
 *  both) → statusModel; else the model the last main turn actually answered with (`answered` · the same model the
 *  llm.usage role:main row records); else the route badge. */
export function nextTuiFooterModel(sessionId: string | undefined, statusModel: string, routeBadge: string | undefined, answered?: string | null): string {
  if (sessionId && (getSessionProvider(sessionId) || getSessionTierOverride(sessionId)?.llm)) return statusModel;
  if (answered) return answered.includes('/') ? answered : `${statusModel.split('/')[0]}/${answered}`;
  return routeBadge || statusModel;
}
