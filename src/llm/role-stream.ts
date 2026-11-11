import { getProviderForConfig, streamLLM, type LLMMessage, type LLMOpts, type LLMProvider } from '../llm.js';
import { getUserConfig, resolveRoleLlm, type RoleLlmResolution, type UserConfig } from '../user-config.js';
import type { ModelRole } from '../user-config/types.js';
import { inferRuntimeLlmModelFamily } from './runtime-model-family.js';
import type { LLMProviderName } from '../user-config/types.js';

export type RoleStreamOptions = Omit<LLMOpts, 'model' | 'provider' | 'usageRole'> & {
  config?: UserConfig;
  /** Explicit authoring/Pod model pin; still resolved through the named role. */
  roleModelOverride?: string;
};

export interface RoleStreamDependencies {
  getConfig(): UserConfig;
  resolveRoleLlm(role: ModelRole, options: { config: UserConfig; overrides?: Partial<Record<ModelRole, { model: string; provider: LLMProviderName }>> }): RoleLlmResolution;
  getProviderForConfig(config: UserConfig, model: string): LLMProvider;
  streamLLM: typeof streamLLM;
}

const productionDependencies: RoleStreamDependencies = {
  getConfig: getUserConfig,
  resolveRoleLlm,
  getProviderForConfig,
  streamLLM: (messages, onChunk, options) => import('../llm.js').then(({ streamLLM: stream }) => stream(messages, onChunk, options)),
};

/** Resolve the role once and carry its model/provider together to the wire. */
export function streamRoleLlm(
  role: ModelRole,
  messages: LLMMessage[],
  onChunk: (delta: string, all: string) => void,
  options: RoleStreamOptions = {},
  dependencies: Partial<RoleStreamDependencies> = {},
): Promise<string> {
  const deps = { ...productionDependencies, ...dependencies };
  const { config: suppliedConfig, roleModelOverride, ...streamOptions } = options;
  const config = suppliedConfig ?? deps.getConfig();
  const family = inferRuntimeLlmModelFamily(roleModelOverride);
  // A recognized explicit pin must not resolve the baseline first: Solar-only
  // authoring has no unrelated global provider credentials to fall back to.
  const base = !roleModelOverride || family === 'unknown' ? deps.resolveRoleLlm(role, { config }) : undefined;
  const selected = roleModelOverride
    ? deps.resolveRoleLlm(role, { config, overrides: { [role]: {
      model: roleModelOverride, provider: family !== 'unknown' ? family as LLMProviderName : base!.provider,
    } } })
    : base!;
  const streamProvider = deps.getProviderForConfig({
    ...config,
    llm: { ...config.llm, provider: selected.provider, model: selected.model },
  }, selected.model);
  return deps.streamLLM(messages, onChunk, {
    ...streamOptions,
    model: selected.model,
    provider: streamProvider,
    usageRole: role,
  });
}
