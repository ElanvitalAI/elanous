import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getUserConfig } from '../../user-config/reader.js';
import { getSessionProvider } from '../../tui-client/session-provider.js';
import { PROVIDER_DEFAULT_MODEL } from '../../user-config.js';

/** Current configured/selected model label without reading credentials or starting a provider. */
export function readNextTuiStatusModel(
  sessionId?: string,
  session?: { readonly provider?: string; readonly model?: string } | null,
): string {
  const config = getUserConfig();
  const selected = sessionId ? getSessionProvider(sessionId) : undefined;
  const override = sessionId ? explicitTurnTier(config, sessionId)?.model : undefined;
  const provider = selected?.provider
    ?? (config.llm.provider === 'auto' ? session?.provider ?? config.llm.provider : config.llm.provider);
  const model = selected?.model || override
    || (selected && selected.provider !== config.llm.provider ? PROVIDER_DEFAULT_MODEL[selected.provider] : undefined)
    || (config.llm.model === 'auto' ? session?.model : undefined)
    || config.llm.model || session?.model || '미설정';
  return `${provider}/${model}`;
}

