import { decideProviderForConfig, getProviderForConfig, streamLLM, type LLMMessage } from '../llm.js';
import { getUserConfig } from '../user-config.js';
import { DEFAULT_TOKEN_BUDGET, trimToBudget } from '../tokens.js';

export interface AskBareDeps {
  getUserConfig: typeof getUserConfig;
  decideProviderForConfig: typeof decideProviderForConfig;
  getProviderForConfig: typeof getProviderForConfig;
  streamLLM: typeof streamLLM;
  trimToBudget: typeof trimToBudget;
}

export async function askBare({ text, provider, model, deps }: {
  text: string;
  provider?: string;
  model?: string;
  deps: AskBareDeps;
}): Promise<{ provider: string; model: string; reply: string }> {
  const messages: LLMMessage[] = [{ role: 'user', content: text }];
  if (deps.trimToBudget(messages, DEFAULT_TOKEN_BUDGET).used > DEFAULT_TOKEN_BUDGET) {
    throw new Error(`ask --bare: input exceeds the ${DEFAULT_TOKEN_BUDGET}-token context budget`);
  }
  const cfg = deps.getUserConfig();
  const selectedConfig = provider === undefined ? cfg : {
    ...cfg,
    llm: {
      ...cfg.llm,
      provider: provider as typeof cfg.llm.provider,
      model: model ?? (provider === cfg.llm.provider ? cfg.llm.model : undefined),
    },
  };
  const selected = deps.decideProviderForConfig(selectedConfig, model);
  const chosenProvider = deps.getProviderForConfig(selectedConfig, model);
  let resolvedProvider = chosenProvider.name;
  let resolvedModel = selected.model;
  const reply = await deps.streamLLM(messages, () => {}, {
    ...(provider === undefined ? { initialProvider: chosenProvider } : { provider: chosenProvider }),
    ...(selected.model === '(none)' ? {} : { model: selected.model }),
    onResolvedProvider: (name, activeModel) => { resolvedProvider = name; resolvedModel = activeModel; },
  });
  return { provider: resolvedProvider, model: resolvedModel, reply };
}
