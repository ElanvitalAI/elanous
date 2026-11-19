/**
 * OP-LONG-SESSION-COMPACT (O4) — the context window of a REMOTE model the catalog does not list exactly.
 *
 * Allow list, not block list (OP decision #90602 after three rounds of JUD ⓑ on local ids): a model id counts as remote
 * only when it has the shape a known remote provider actually sends; everything else is treated as local and keeps the
 * conservative default (unknown → compaction starts early, the safe side).
 *
 *   remote ⇔ (a) `[openrouter/]<vendor>/<model>` with a vendor of a remote catalog provider, or
 *            (b) a bare `<family>-<digit>…` whose family a remote catalog provider serves in that same shape (glm-5.3).
 *   window  = the smallest cloud window of that provider's catalog entries (never a guess above what it is known to hold).
 *   always conservative: an explicit parameter count (`-8b`) or a quantized/local build marker in the id.
 *
 * Pure: the catalog comes in as an argument.
 */

export interface RemoteCatalogEntry {
  readonly id: string;
  readonly provider: string;
  readonly family?: string;
  readonly contextWindow?: number;
  readonly local?: boolean;
}

/**
 * OpenRouter-style vendor prefix → catalog provider. Source: the vendor segment OpenRouter uses for each catalog provider
 * (z-ai/glm-5.3 · qwen/qwen3.8-max · openai/gpt-6-luna · anthropic/claude-opus-5.5 · x-ai/grok · google/gemini ·
 * moonshotai/kimi), as seen in llm-usage rows 11-18.
 */
export const REMOTE_VENDOR_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  'z-ai': ['glm'],
  qwen: ['qwen'],
  openai: ['openai', 'openai-codex'],
  anthropic: ['anthropic'],
  google: ['gemini'],
  'x-ai': ['grok'],
  moonshotai: ['kimi'],
};

export interface RemoteWindow { readonly provider: string; readonly contextWindow: number; readonly via: 'vendor' | 'bare-shape' }

const CONSERVATIVE_MARKERS = [
  /(?:^|[-_/:])\d+(?:\.\d+)?b(?:$|[-_.:])/, // explicit parameter count: qwen3-8b · Qwen3-8B-4bit
  /(?:^|[-_.])(?:\d+bit|q\d(?:_k)?(?:_[sml])?|gguf|mlx)(?:$|[-_.])/, // quantized / local build
];

function cloudEntries(catalog: readonly RemoteCatalogEntry[], providers: readonly string[]): RemoteCatalogEntry[] {
  return catalog.filter((m) => m.local !== true && providers.includes(m.provider)
    && typeof m.contextWindow === 'number' && m.contextWindow > 0);
}

function smallest(entries: readonly RemoteCatalogEntry[]): number {
  return Math.min(...entries.map((m) => m.contextWindow as number));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function remoteContextWindow(modelId: string, catalog: readonly RemoteCatalogEntry[]): RemoteWindow | null {
  const lowered = modelId.trim().toLowerCase();
  if (!lowered || lowered.includes(':')) return null; // an ollama tag (`name:size`) is a local build
  if (CONSERVATIVE_MARKERS.some((re) => re.test(lowered))) return null;
  const route = lowered.replace(/^openrouter\//, '');
  const parts = route.split('/');
  if (parts.length === 2) {
    const providers = REMOTE_VENDOR_PROVIDERS[parts[0]!];
    if (!providers || !parts[1]) return null; // an unknown vendor (mlx-community/ · ollama/ · lmstudio/ …) is not remote
    const entries = cloudEntries(catalog, providers);
    return entries.length === 0 ? null : { provider: entries[0]!.provider, contextWindow: smallest(entries), via: 'vendor' };
  }
  if (parts.length !== 1) return null;
  // A bare id: remote only in the exact shape a remote provider's own catalog ids have — `<family>-<digit>…`.
  for (const entry of catalog) {
    if (entry.local === true || !entry.family) continue;
    const shape = new RegExp(`^${escape(entry.family.toLowerCase())}-\\d`);
    if (!shape.test(route) || !shape.test(entry.id.toLowerCase())) continue;
    const entries = cloudEntries(catalog, [entry.provider]).filter((m) => m.family === entry.family);
    if (entries.length > 0) return { provider: entry.provider, contextWindow: smallest(entries), via: 'bare-shape' };
  }
  return null;
}
