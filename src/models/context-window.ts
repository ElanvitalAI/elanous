import { findCodexModel } from '../codex/models.js';
import { findClaudeModel } from '../anthropic/models.js';
import { findGeminiModel } from '../gemini/models.js';
import { findGrokModel } from '../grok/models.js';
import { loadCatalog } from '../intelligence-map/model-catalog.js';
import { getCapabilitiesStore } from '../policy/model-capabilities.js';
import { debug } from '../debug/log.js';
import { REMOTE_VENDOR_PROVIDERS, remoteContextWindow } from './remote-context-window.js';

function exactCatalogContextWindow(modelId: string): number | null {
  const lowered = modelId.toLowerCase();
  // Wave 3 (2026-05-04) — claude / gemini / grok 도 catalog 보유.
  // Order: codex → claude → gemini → grok → generic. First exact
  // match wins.
  const codex = findCodexModel(modelId);
  if (codex?.contextWindow) return codex.contextWindow;
  const claude = findClaudeModel(modelId);
  if (claude?.contextWindow) return claude.contextWindow;
  const gemini = findGeminiModel(modelId);
  if (gemini?.contextWindow) return gemini.contextWindow;
  const grok = findGrokModel(modelId);
  if (grok?.contextWindow) return grok.contextWindow;
  const catalog = loadCatalog().catalog;
  const hit = catalog.models.find((m) => m.id.toLowerCase() === lowered);
  return hit?.contextWindow ?? null;
}

function capabilityFamilyContextWindow(modelId: string): number | null {
  const m = modelId.toLowerCase();
  const caps = getCapabilitiesStore();
  if (m.includes('claude')) {
    if (m.includes('opus')) return caps.get('claude', 'opus')?.contextWindow ?? null;
    if (m.includes('sonnet')) return caps.get('claude', 'sonnet')?.contextWindow ?? null;
    if (m.includes('haiku')) return caps.get('claude', 'haiku')?.contextWindow ?? null;
  }
  if (m.includes('gemini')) {
    if (m.includes('flash')) return caps.get('gemini', 'flash')?.contextWindow ?? null;
    if (m.includes('pro')) return caps.get('gemini', 'pro')?.contextWindow ?? null;
  }
  if (m.includes('grok')) {
    return loadCatalog().catalog.models.find((entry) => entry.provider === 'grok')?.contextWindow ?? null;
  }
  if (m.startsWith('gpt-4o')) {
    return loadCatalog().catalog.models.find((entry) => entry.id === 'gpt-4o')?.contextWindow ?? 128_000;
  }
  return null;
}

/** `openai/gpt-6-luna` → `gpt-6-luna` — only through a known remote vendor (an unknown prefix stays as it is). */
function remoteVendorBareId(modelId: string): string | null {
  const parts = modelId.trim().toLowerCase().replace(/^openrouter\//, '').split('/');
  return parts.length === 2 && REMOTE_VENDOR_PROVIDERS[parts[0]!] && parts[1] ? parts[1] : null;
}

export function resolveModelContextWindow(modelId: string | undefined): number | null {
  const normalized = modelId?.trim();
  if (!normalized) return null;
  const vendorBare = remoteVendorBareId(normalized);
  const contextWindow = exactCatalogContextWindow(normalized)
    ?? (vendorBare !== null ? exactCatalogContextWindow(vendorBare) : null)
    ?? capabilityFamilyContextWindow(normalized);
  if (contextWindow !== null) return contextWindow;
  // OP-LONG-SESSION-COMPACT (O4 · OP #90602): allow-list remote fallback — everything else is local → unknown.
  const remote = remoteContextWindow(normalized, loadCatalog().catalog.models);
  if (remote) {
    debug.log('models.context-window', 'family-fallback', { modelId, provider: remote.provider, via: remote.via, contextWindow: remote.contextWindow });
    return remote.contextWindow;
  }
  debug.log('models.context-window', 'unknown', { modelId });
  return null;
}
