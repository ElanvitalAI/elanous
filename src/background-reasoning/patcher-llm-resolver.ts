// W9e-FU U5 · Patcher LLM callable resolver — bridges user-config
// `background-reasoning.llm.*` into `EntityExtractorCallable` +
// `EmbeddingCallable`. Cf. 내부 문서 §2.3
// follow-up wire.
//
// The resolver wraps an OpenAI-compatible HTTP endpoint
// (LM-Studio · Ollama · Together · etc.) so the same wire works
// against local + cloud loads. The fetch + JSON parse stay isolated
// here so `buildPatcherSubstrate` (boot composer) can DI-test without
// network IO.
//
// Defensive contract: every callable returns a graceful fallback on
// parse / network error. The Patcher daemon would otherwise crash on
// the first failed tick — a fallback `{ entities: [], relations: [] }`
// or `[[]]` keeps the tick stream alive (the empty result will
// surface in the KGS card row as a "low-confidence patcher_card" the
// future Thinker (Y4) can re-process).

import type { EmbeddingCallable } from './patcher-extractors/embedding-generator.js';
import type {
  EntityExtractorCallable,
  EntityExtractInput,
  EntityExtractOutput,
} from './patcher-extractors/entity-extractor.js';
import type { BackgroundReasoningLlmConfig } from '../user-config/types.js';

const DEFAULT_ENTITY_MODEL = 'lm-studio/qwen-7b';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export interface PatcherLlmCallables {
  entityExtractorCallable: EntityExtractorCallable;
  embeddingCallable: EmbeddingCallable;
}

export interface ResolvePatcherLlmOpts {
  /** Override the fetch implementation. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Trim diagnostics — surface raw error bodies to `console.warn`. */
  onError?: (label: string, err: unknown) => void;
}

/** Build callables from the user-config block. Returns `undefined` when
 *  `cfg` is missing (caller falls back to the daemon's
 *  `patcher-llm-deps-missing` skip path). */
export function resolvePatcherLlmCallables(
  cfg: BackgroundReasoningLlmConfig | undefined,
  opts: ResolvePatcherLlmOpts = {},
): PatcherLlmCallables | undefined {
  if (!cfg?.endpoint || cfg.endpoint.trim().length === 0) return undefined;
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '');
  const entityModel = cfg.entityModel ?? DEFAULT_ENTITY_MODEL;
  const embeddingModel = cfg.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onError = opts.onError ?? defaultOnError;

  return {
    entityExtractorCallable: createEntityCallable({
      endpoint,
      model: entityModel,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      fetchImpl,
      onError,
    }),
    embeddingCallable: createEmbeddingCallable({
      endpoint,
      model: embeddingModel,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      fetchImpl,
      onError,
    }),
  };
}

function defaultOnError(label: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[patcher-llm] ${label}: ${msg}`);
}

// ── Entity extractor ──────────────────────────────────────────────────

interface EntityCallableOpts {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
  onError: (label: string, err: unknown) => void;
}

function createEntityCallable(opts: EntityCallableOpts): EntityExtractorCallable {
  return async (input: EntityExtractInput): Promise<EntityExtractOutput> => {
    const prompt = buildEntityPrompt(input);
    try {
      const res = await opts.fetchImpl(`${opts.endpoint}/v1/chat/completions`, {
        method: 'POST',
        ...(input.signal ? { signal: input.signal } : {}),
        headers: buildHeaders(opts.apiKey),
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: 'Reply with strict JSON only. No prose.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
        }),
      });
      if (!res.ok) {
        opts.onError('entity-extract', new Error(`HTTP ${res.status}`));
        return { entities: [], relations: [] };
      }
      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? '';
      return parseEntityResponse(content);
    } catch (err) {
      opts.onError('entity-extract', err);
      return { entities: [], relations: [] };
    }
  };
}

function buildEntityPrompt(input: EntityExtractInput): string {
  const recordsBlock = input.records.slice(0, 32).map((r, i) => `[${i}] (${r.kind}) ${r.text}`).join('\n');
  return [
    input.prompt || 'Extract canonical entities + relations from the records below.',
    '',
    'Output shape:',
    '{ "entities": [{ "id": "snake_case", "label": "Display", "kind"?: "person|skill|workflow|..." }, ...],',
    '  "relations": [{ "fromId": "...", "toId": "...", "predicate": "..." }, ...] }',
    '',
    'Records:',
    recordsBlock,
  ].join('\n');
}

function parseEntityResponse(content: string): EntityExtractOutput {
  const trimmed = content.trim();
  if (!trimmed) return { entities: [], relations: [] };
  // Some local models wrap JSON in ```json ... ``` fences — strip.
  const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!parsed || typeof parsed !== 'object') return { entities: [], relations: [] };
    const p = parsed as { entities?: unknown; relations?: unknown };
    return {
      entities: Array.isArray(p.entities)
        ? p.entities
            .filter((e): e is { id: string; label: string; kind?: string } =>
              !!e && typeof e === 'object'
              && typeof (e as { id?: unknown }).id === 'string'
              && typeof (e as { label?: unknown }).label === 'string')
            .map((e) => ({
              id: e.id,
              label: e.label,
              ...(typeof e.kind === 'string' ? { kind: e.kind } : {}),
            }))
        : [],
      relations: Array.isArray(p.relations)
        ? p.relations
            .filter((r): r is { fromId: string; toId: string; predicate: string } =>
              !!r && typeof r === 'object'
              && typeof (r as { fromId?: unknown }).fromId === 'string'
              && typeof (r as { toId?: unknown }).toId === 'string'
              && typeof (r as { predicate?: unknown }).predicate === 'string')
            .map((r) => ({ fromId: r.fromId, toId: r.toId, predicate: r.predicate }))
        : [],
    };
  } catch {
    return { entities: [], relations: [] };
  }
}

// ── Embedding generator ───────────────────────────────────────────────

interface EmbeddingCallableOpts {
  endpoint: string;
  model: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
  onError: (label: string, err: unknown) => void;
}

function createEmbeddingCallable(opts: EmbeddingCallableOpts): EmbeddingCallable {
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    try {
      const res = await opts.fetchImpl(`${opts.endpoint}/v1/embeddings`, {
        method: 'POST',
        headers: buildHeaders(opts.apiKey),
        body: JSON.stringify({
          model: opts.model,
          input: texts,
        }),
      });
      if (!res.ok) {
        opts.onError('embedding', new Error(`HTTP ${res.status}`));
        return texts.map(() => []);
      }
      const json = await res.json() as { data?: Array<{ embedding?: number[] }> };
      if (!Array.isArray(json.data)) return texts.map(() => []);
      return texts.map((_, i) => {
        const vec = json.data?.[i]?.embedding;
        return Array.isArray(vec) ? vec : [];
      });
    } catch (err) {
      opts.onError('embedding', err);
      return texts.map(() => []);
    }
  };
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  return h;
}
