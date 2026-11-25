import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getUserConfig } from '../../user-config/reader.js';
import { getSessionProvider } from '../../tui-client/session-provider.js';
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
export function nextTuiFooterModel(sessionId: string | undefined, statusModel: string, routeBadge: string | undefined): string {
  if (sessionId && getSessionProvider(sessionId)) return statusModel;
  return routeBadge || statusModel;
}
