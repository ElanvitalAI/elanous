/** Route metadata is inert prompt-planning metadata; it never loads or executes a plugin handler. */
export interface LLMToolRouteMetadata {
  triggers: string[];
  examples: string[];
  sideEffects: 'read-only' | 'mutating' | 'external' | 'irreversible';
  risk: 'low' | 'medium' | 'high';
  cost: 'cheap' | 'spawns-run' | 'spends-llm' | 'spends-cloud';
  requiresConfirm: boolean;
}

/** JSONSchema-shaped tool definition sent to the provider (no handler). */
export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSONSchema
  /** Present only for manifest-declared plugin routes. */
  pluginId?: string;
  route?: LLMToolRouteMetadata;
}



/** Convert a plugin runtime definition to the provider spec without losing
 *  manifest route identity used by tier-flip and ToolSearch. */
export function toLLMToolSpec(tool: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  pluginId?: string;
  route?: LLMToolRouteMetadata;
}): LLMToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.pluginId && tool.route ? { pluginId: tool.pluginId, route: tool.route } : {}),
  };
}
