/** Convert legacy JSON Schema tuple `items` arrays to the modern
 * `prefixItems` form used by Grok's OpenAI-compatible tool validator.
 * Other schema keywords, including min/maxItems and coordinate constraints,
 * are preserved recursively. */
export function sanitizeToolSchemaForGrok(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeToolSchemaForGrok);
  if (!schema || typeof schema !== 'object') return schema;

  const record = schema as Record<string, unknown>;
  const tupleItems = Array.isArray(record.items) ? record.items : undefined;
  const hasPrefixItems = Array.isArray(record.prefixItems);
  const hasAdditionalItems = Object.prototype.hasOwnProperty.call(record, 'additionalItems');
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'additionalItems' || (key === 'items' && tupleItems)) continue;
    output[key] = sanitizeToolSchemaForGrok(value);
  }

  if (tupleItems) {
    output.prefixItems = tupleItems.map(sanitizeToolSchemaForGrok);
  }
  if (hasAdditionalItems && (tupleItems || hasPrefixItems)) {
    output.items = sanitizeToolSchemaForGrok(record.additionalItems);
  }

  return output;
}

/** Anthropic-backed Claude APIs reject top-level JSON Schema composition on tool inputs.
 * Check every tool before serialization so a newly introduced tool cannot turn a whole
 * Claude request into a 400 and trigger an unnoticed provider fallback. Nested schemas
 * remain valid and are deliberately not inspected here. */
export function assertNoTopLevelToolSchemaCombinators(
  tools: readonly { name: string; parameters: unknown }[] | undefined,
): void {
  if (!tools?.length) return;
  const combinators = ['anyOf', 'oneOf', 'allOf'] as const;
  const invalid = tools.flatMap((tool) => {
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) return [];
    const schema = tool.parameters as Record<string, unknown>;
    const found = combinators.filter((key) => Object.prototype.hasOwnProperty.call(schema, key));
    return found.length ? [`${tool.name} (${found.join(', ')})`] : [];
  });
  if (invalid.length) {
    throw new Error(`Claude tool schema has unsupported top-level composition: ${invalid.join('; ')}`);
  }
}

/** OpenRouter model ids may include the provider prefix; callers can pass
 * either the catalog id or the already-normalized wire id. */
export function isOpenRouterGrokModel(model: string): boolean {
  const wireModel = model.replace(/^openrouter\//i, '');
  return /^x-ai\/grok(?:[-/]|$)/i.test(wireModel);
}
