import { textOnly } from '../../src/llm/stream-text.js';
// ── IUL-shared materializer pipeline ──────────────────────────
//
// Generic materialize() pipeline that consumes prebuilt (systemPrompt,
// userContent) + catalog + provider, returning a validated WidgetSpec.
// Scenario-specific wrappers compose this — see:
//
//   plugins/iul-canvas/materializer.ts (Scenario 1 · sketch → widget)
//   src/tool-runtime/materialize-runtimes.ts (Phase L LLM tool)
//
// All scenarios share the same parser + validator + catalog check so
// spec shape stays consistent across the whole IUL surface.

import type { LLMMessage, LLMProvider } from '../../src/llm.js';

import type { CatalogEntry } from './prompt.js';
import type { WidgetSpec } from './types.js';

/** Parse the LLM's free-text response into a WidgetSpec. Tolerates
 *  ```json fences, surrounding prose, and trailing commentary. */
export function parseWidgetSpec(raw: string): WidgetSpec {
  const stripped = stripJsonFence(raw).trim();
  const jsonStart = stripped.indexOf('{');
  const jsonEnd = stripped.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('LLM response did not contain a JSON object');
  }
  const json = stripped.slice(jsonStart, jsonEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`LLM response was not valid JSON: ${(err as Error).message}`);
  }
  return validateWidgetSpec(parsed);
}

/** Validate the parsed object against the WidgetSpec schema. Throws
 *  with a specific reason on every failure mode so the caller can
 *  surface the right banner to the user. */
export function validateWidgetSpec(value: unknown): WidgetSpec {
  if (!value || typeof value !== 'object') {
    throw new Error('WidgetSpec must be an object');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.widgetType !== 'string' || v.widgetType.length === 0) {
    throw new Error('WidgetSpec.widgetType must be a non-empty string');
  }
  if (typeof v.reason !== 'string') {
    throw new Error('WidgetSpec.reason must be a string');
  }
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)) {
    throw new Error('WidgetSpec.confidence must be a finite number');
  }
  const conf = Math.max(0, Math.min(1, v.confidence));
  const config = v.config && typeof v.config === 'object'
    ? (v.config as Record<string, unknown>)
    : undefined;
  const character = typeof v.character === 'string' ? v.character : undefined;
  return {
    widgetType: v.widgetType,
    confidence: conf,
    reason: v.reason,
    ...(config !== undefined ? { config } : {}),
    ...(character !== undefined ? { character } : {}),
  };
}

/** True when the spec's widgetType is in the catalog. */
export function specTypeInCatalog(
  spec: WidgetSpec,
  catalog: readonly CatalogEntry[],
): boolean {
  return catalog.some((e) => e.type === spec.widgetType);
}

export interface MaterializeOpts {
  /** Prebuilt system prompt — scenario composes via `buildGenericSystemPrompt`
   *  + scenario-specific patterns. */
  systemPrompt: string;
  /** Prebuilt user content — scenario formats (e.g. `"Sketch:\n<json>"`
   *  for iul-canvas, `"Intent: <text>"` for Phase L tool). */
  userContent: string;
  catalog: readonly CatalogEntry[];
  provider: LLMProvider;
  /** Override the model name (e.g. pin Haiku in tests). Defaults to
   *  `provider.defaultModel`. */
  model?: string;
  /** AbortSignal lets the host cancel a slow LLM call (e.g. user hits
   *  Esc during materialize). */
  signal?: AbortSignal;
}

/** Drive the LLM round-trip. Returns the parsed + catalog-validated
 *  WidgetSpec on success. Throws on parse / validation / catalog-mismatch
 *  failures so the caller can surface the right banner. */
export async function materialize(opts: MaterializeOpts): Promise<WidgetSpec> {
  const { systemPrompt, userContent, catalog, provider } = opts;
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const llmOpts = {
    temperature: 0.1,
    maxTokens: 800,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };

  let raw = '';
  if (provider.streamChat) {
    for await (const delta of textOnly(provider.streamChat(messages, llmOpts))) {
      raw += delta;
    }
  } else {
    for await (const chunk of provider.chat(messages, llmOpts)) {
      raw += chunk;
    }
  }
  if (raw.trim().length === 0) {
    throw new Error('LLM returned an empty response');
  }
  const spec = parseWidgetSpec(raw);
  if (!specTypeInCatalog(spec, catalog)) {
    throw new Error(`LLM picked widget type "${spec.widgetType}" which is not in the catalog`);
  }
  return spec;
}

function stripJsonFence(raw: string): string {
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return fenced ? fenced[1]! : raw;
}
