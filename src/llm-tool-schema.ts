import { debug } from './debug/log.js';

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

/** Thrown when a Claude-bound request carries a tool schema the provider would reject.
 * The message is one line and names every offending tool, so the turn failure is
 * explainable instead of a bare «요청을 처리하지 못했습니다». */
export class ToolSchemaRejectedError extends Error {
  readonly tools: readonly string[];
  readonly provider: string;
  constructor(message: string, tools: readonly string[], provider: string) {
    super(message);
    this.name = 'ToolSchemaRejectedError';
    this.tools = tools;
    this.provider = provider;
  }
}

/** Anthropic-backed Claude APIs reject top-level JSON Schema composition on tool inputs.
 * Check every tool before serialization so a newly introduced tool cannot turn a whole
 * Claude request into a 400 and trigger an unnoticed provider fallback. Nested schemas
 * remain valid and are deliberately not inspected here. Every rejection is logged as
 * `provider.tool-schema-rejected {tool, provider}` before the one-line error is thrown. */
export function assertNoTopLevelToolSchemaCombinators(
  tools: readonly { name: string; parameters: unknown }[] | undefined,
  ctx: { provider?: string; model?: string } = {},
): void {
  if (!tools?.length) return;
  const combinators = ['anyOf', 'oneOf', 'allOf'] as const;
  const offenders = tools.flatMap((tool) => {
    if (!tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) return [];
    const schema = tool.parameters as Record<string, unknown>;
    const found = combinators.filter((key) => Object.prototype.hasOwnProperty.call(schema, key));
    return found.length ? [{ tool: tool.name, found }] : [];
  });
  if (!offenders.length) return;
  const provider = ctx.provider ?? 'unknown';
  for (const offender of offenders) {
    debug.log('provider', 'tool-schema-rejected', {
      tool: offender.tool, provider, combinators: offender.found, ...(ctx.model ? { model: ctx.model } : {}),
    }, { level: 'error' });
  }
  const invalid = offenders.map((o) => `${o.tool} (${o.found.join(', ')})`);
  throw new ToolSchemaRejectedError(
    `Claude tool schema has unsupported top-level composition: ${invalid.join('; ')}`,
    offenders.map((o) => o.tool),
    provider,
  );
}

/** OpenRouter model ids may include the provider prefix; callers can pass
 * either the catalog id or the already-normalized wire id. */
export function isOpenRouterGrokModel(model: string): boolean {
  const wireModel = model.replace(/^openrouter\//i, '');
  return /^x-ai\/grok(?:[-/]|$)/i.test(wireModel);
}
