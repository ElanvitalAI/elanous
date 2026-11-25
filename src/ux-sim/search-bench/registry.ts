// SEARCH-BENCH strategy registry — every module in ./strategies is loaded and every exported SearchStrategy (or array
// of them) is registered. Adding / changing a strategy = add or edit a file there; the harness is not touched.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchStrategy } from './types.js';

const isStrategy = (v: unknown): v is SearchStrategy =>
  !!v && typeof v === 'object' && typeof (v as SearchStrategy).id === 'string' && typeof (v as SearchStrategy).run === 'function' && typeof (v as SearchStrategy).version === 'number';

export async function loadStrategies(dir = join(import.meta.dir, 'strategies')): Promise<SearchStrategy[]> {
  const out: SearchStrategy[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.test\./.test(f)).sort()) {
    const mod = await import(join(dir, file)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      for (const s of Array.isArray(value) ? value : [value]) if (isStrategy(s)) out.push(s);
    }
  }
  const ids = new Set<string>();
  for (const s of out) { if (ids.has(s.id)) throw new Error(`duplicate strategy id ${s.id}`); ids.add(s.id); }
  return out;
}

/** `--strategies a,b,N3*` — exact ids or a trailing-* prefix. */
export function selectStrategies(all: readonly SearchStrategy[], spec: string | undefined): SearchStrategy[] {
  if (!spec) return [...all];
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = all.filter((s) => parts.some((p) => (p.endsWith('*') ? s.id.startsWith(p.slice(0, -1)) : s.id === p)));
  const unknown = parts.filter((p) => !p.endsWith('*') && !all.some((s) => s.id === p));
  if (unknown.length) throw new Error(`unknown strategy: ${unknown.join(', ')}`);
  return picked;
}
