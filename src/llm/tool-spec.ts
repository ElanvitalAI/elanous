/** JSONSchema-shaped tool definition sent to the provider (no handler). */
export interface LLMToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSONSchema
}

