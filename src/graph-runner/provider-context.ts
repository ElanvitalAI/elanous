import { isDeepStrictEqual } from 'node:util';
import type { GraphExtensionMap } from '../self-implement/graph-yaml.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Preserve caller context while attaching opaque, namespaced graph extension scopes for a provider. */
export function withGraphProviderContextExtensions(
  context: unknown,
  extensions: Readonly<Record<string, GraphExtensionMap>>,
): unknown {
  if (Object.keys(extensions).length === 0) return context;
  const base = record(context) ?? (context === undefined ? {} : { value: context });
  const priorExt = record(base.ext) ?? (base.ext === undefined ? {} : { value: base.ext });
  const mergedExt: Record<string, unknown> = { ...priorExt };
  for (const [scope, values] of Object.entries(extensions)) {
    const priorScope = record(mergedExt[scope]) ?? (mergedExt[scope] === undefined ? {} : { value: mergedExt[scope] });
    const nextScope: Record<string, unknown> = { ...priorScope };
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(nextScope, key) && !isDeepStrictEqual(nextScope[key], value))
        throw new Error('graph provider extension conflict: ' + scope + '.' + key);
      nextScope[key] = value;
    }
    mergedExt[scope] = nextScope;
  }
  return { ...base, ext: mergedExt };
}
