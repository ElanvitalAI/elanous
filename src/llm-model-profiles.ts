import profileData from './llm-model-profiles.json';

export interface ModelProfile {
  readonly name: string;
  /** Lowercase model-ID prefixes, after optional OpenRouter transport prefixes. */
  readonly id_match: readonly string[];
  readonly prompt: {
    readonly variant: string;
    readonly blocks: Readonly<Partial<Record<'act_dont_ask' | 'tool_enforcement' | 'execution_discipline', string>>>;
  };
  readonly reasoning: {
    readonly effort_map?: Readonly<Record<string, string>>;
    /** null means no override until a provider error or benchmark verifies the value. */
    readonly can_disable: boolean | null;
    readonly echo_reasoning_content: boolean | null;
  };
  readonly sampling: Readonly<{
    temperature?: number;
    top_p?: number;
    /** Omitted until a model-specific source or benchmark verifies an override. */
    frequency_penalty?: number;
  }>;
  readonly limits: Readonly<{
    context?: number;
    max_output?: number;
  }>;
  readonly timeouts: Readonly<{
    header_s?: number;
    first_token_s?: number;
    idle_chunk_s?: number;
    total_s?: number;
  }>;
  readonly evidence: readonly Readonly<{
    fields: readonly string[];
    reference: string;
    status: string;
  }>[];
}

interface ModelProfileData {
  readonly schema_version: number;
  readonly profiles: readonly ModelProfile[];
}

const data = profileData as ModelProfileData;

if (data.schema_version !== 1) {
  throw new Error(`Unsupported model profile schema: ${data.schema_version}`);
}

/** Static profile inputs only. The runtime may choose whether and when to apply them. */
const MODEL_PROFILES: readonly ModelProfile[] = data.profiles;

function normalizedModelId(modelId: string): string {
  let normalized = modelId.trim().toLowerCase();
  // Elanous may use either the provider ID or its OpenRouter transport wrapper.
  while (normalized.startsWith('openrouter/')) normalized = normalized.slice('openrouter/'.length);
  return normalized;
}

/** Longest provider/model prefix wins; sibling model variants keep runtime defaults. */
export function resolveModelProfile(modelId: string, profiles: readonly ModelProfile[] = MODEL_PROFILES): ModelProfile | undefined {
  const normalized = normalizedModelId(modelId);
  if (!normalized) return undefined;

  let matched: ModelProfile | undefined;
  let longestPrefix = 0;
  for (const profile of profiles) {
    for (const prefix of profile.id_match) {
      const matches = normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.startsWith(`${prefix}:`);
      if (matches && prefix.length > longestPrefix) {
        matched = profile;
        longestPrefix = prefix.length;
      }
    }
  }
  return matched;
}
