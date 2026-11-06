// NEXUS · GET /v1/registry/catalog — RFC #2161 Phase 3 catalog endpoint.
//
// Surfaces the static Layer A catalog (providers + models + pattern
// fallback) over the wire so the PWA Showroom dropdown + future
// LlmCatalogCard can drive UI off the same source-of-truth that the
// daemon's `inferProviderFromModel` and `effectiveCapabilities` use.
//
// Phase 5 (Live Registry) will add a sibling `/v1/registry/resolved`
// endpoint that layers apiKey availability + health on top. This
// endpoint stays read-only and snapshot-stable — clients cache the
// result and refresh on demand (no SSE here; live state belongs to
// the resolved view).

import { jsonResponse } from './json-response.js';
import { getCatalog } from '../../registry/loader.js';
import type {
  ModelSpec,
  ProviderRegistration,
} from '../../registry/types.js';

export interface CatalogProviderWire {
  id: string;
  displayName: string;
  aliases: string[];
  modelPrefixes: string[];
  apiKeyEnv: string;
  endpointPattern: string;
  defaultStreaming: ProviderRegistration['defaultStreaming'];
  toolCallingFormat: ProviderRegistration['toolCallingFormat'];
  capabilities: ProviderRegistration['capabilities'];
  builtIn: boolean;
}

export interface CatalogModelWire {
  id: string;
  provider: string;
  displayName: string;
  family?: string;
  familyShortcut?: string;
  contextSize?: number;
  outputMaxTokens?: number;
  vision?: ModelSpec['vision'];
  audio?: ModelSpec['audio'];
  reasoning?: ModelSpec['reasoning'];
  toolCalling?: ModelSpec['toolCalling'];
  pricing?: ModelSpec['pricing'];
  rateLimits?: ModelSpec['rateLimits'];
  deprecated?: string | null;
  releaseDate?: string;
  tokenizer?: ModelSpec['tokenizer'];
  kind?: ModelSpec['kind'];
  capabilities?: ModelSpec['capabilities'];
  discoveryMeta?: ModelSpec['discoveryMeta'];
}

export interface CatalogResponse {
  catalogVersion: number;
  providers: CatalogProviderWire[];
  models: CatalogModelWire[];
  patterns: Array<{
    provider: string;
    prefixes: Array<{ prefix: string; fallback: Partial<CatalogModelWire> }>;
  }>;
  manifest: {
    builtinSource: string;
    globalSource: string;
    fileCount: number;
    loadedAt: string;
  };
}

export function handleRegistryCatalog(): Response {
  const cat = getCatalog();
  const providers: CatalogProviderWire[] = [];
  for (const p of cat.providers.values()) {
    providers.push({
      id: p.id,
      displayName: p.displayName,
      aliases: [...p.aliases],
      modelPrefixes: [...p.modelPrefixes],
      apiKeyEnv: p.apiKeyEnv,
      endpointPattern: p.endpointPattern,
      defaultStreaming: p.defaultStreaming,
      toolCallingFormat: p.toolCallingFormat,
      capabilities: { ...p.capabilities },
      builtIn: p.builtIn,
    });
  }
  providers.sort((a, b) => a.id.localeCompare(b.id));

  const models: CatalogModelWire[] = [];
  for (const m of cat.models.values()) {
    models.push(stripUndefined<CatalogModelWire>({
      id: m.id,
      provider: m.provider,
      displayName: m.displayName,
      family: m.family,
      familyShortcut: m.familyShortcut,
      contextSize: m.contextSize,
      outputMaxTokens: m.outputMaxTokens,
      vision: m.vision,
      audio: m.audio,
      reasoning: m.reasoning,
      toolCalling: m.toolCalling,
      pricing: m.pricing,
      rateLimits: m.rateLimits,
      deprecated: m.deprecated,
      releaseDate: m.releaseDate,
      tokenizer: m.tokenizer,
      kind: m.kind,
      capabilities: m.capabilities,
      discoveryMeta: m.discoveryMeta,
    }));
  }
  models.sort((a, b) =>
    a.provider !== b.provider
      ? a.provider.localeCompare(b.provider)
      : a.id.localeCompare(b.id),
  );

  const patterns = [...cat.patterns.values()].map((p) => ({
    provider: p.provider,
    prefixes: p.prefixes.map((entry) => ({
      prefix: entry.prefix,
      fallback: entry.fallback as Partial<CatalogModelWire>,
    })),
  }));
  patterns.sort((a, b) => a.provider.localeCompare(b.provider));

  const body: CatalogResponse = {
    catalogVersion: cat.catalogVersion,
    providers,
    models,
    patterns,
    manifest: { ...cat.manifest },
  };
  return jsonResponse(body, 200);
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
