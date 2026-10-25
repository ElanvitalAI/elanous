/** Provider wire names have a deliberately smaller alphabet than MCP names.
 * Keep the source name in the TUI/tool catalog and use this reversible map
 * only for one provider request and its returned tool calls. */
export interface ProviderToolNameMap {
  toProviderName(name: string): string;
  toOriginalName(name: string): string;
}

export function sanitizeProviderToolName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'tool';
}

/** Build a deterministic, collision-free mapping for the complete request
 * namespace. Repeated source names intentionally share one wire name. */
export function createProviderToolNameMap(names: readonly string[]): ProviderToolNameMap {
  const originalToProvider = new Map<string, string>();
  const providerToOriginal = new Map<string, string>();

  for (const original of names) {
    if (originalToProvider.has(original)) continue;

    const base = sanitizeProviderToolName(original);
    let candidate = base;
    let suffix = 2;
    while (providerToOriginal.has(candidate)) {
      candidate = `${base}__${suffix++}`;
    }
    originalToProvider.set(original, candidate);
    providerToOriginal.set(candidate, original);
  }

  return {
    toProviderName: (name) => originalToProvider.get(name) ?? sanitizeProviderToolName(name),
    toOriginalName: (name) => providerToOriginal.get(name) ?? name,
  };
}
