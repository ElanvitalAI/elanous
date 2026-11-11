import { explicitTurnTier } from '../../model-tier/turn-tier.js';
import { getUserConfig } from '../../user-config/reader.js';

/** Current configured/selected model label without reading credentials or starting a provider. */
export function readNextTuiStatusModel(
  sessionId?: string,
  session?: { readonly provider?: string; readonly model?: string } | null,
): string {
  const config = getUserConfig();
  const override = sessionId ? explicitTurnTier(config, sessionId)?.model : undefined;
  const provider = config.llm.provider === 'auto' ? session?.provider ?? config.llm.provider : config.llm.provider;
  const model = override || (config.llm.model === 'auto' ? session?.model : undefined)
    || config.llm.model || session?.model || '미설정';
  return `${provider}/${model}`;
}

