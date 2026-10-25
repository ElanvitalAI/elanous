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

/** OpenRouter model ids may include the provider prefix; callers can pass
 * either the catalog id or the already-normalized wire id. */
export function isOpenRouterGrokModel(model: string): boolean {
  const wireModel = model.replace(/^openrouter\//i, '');
  return /^x-ai\/grok(?:[-/]|$)/i.test(wireModel);
}
