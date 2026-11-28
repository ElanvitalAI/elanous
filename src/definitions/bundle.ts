import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadDefinition, type DefinitionKind } from './loader.js';
import { readDefinitionYaml } from './yaml.js';

// Preflight only: this does not install definitions or start a universe.
const kinds: Record<string, DefinitionKind> = { agents: 'agent', graphs: 'graph', policies: 'policy' };
export function inspectBundle(root: string): { units: string[]; errors: string[] } {
  const errors: string[] = [], units: string[] = [];
  try {
    const base = realpathSync(root);
    const manifest = resolve(base, 'elanous.package.yaml');
    if (lstatSync(manifest).isSymbolicLink()) throw new Error('manifest must not be a symlink');
    const { doc } = readDefinitionYaml(manifest);
    if (doc.errors.length) throw new Error(`invalid manifest YAML: ${doc.errors[0]?.message}`);
    const data = doc.toJS() as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string' || !data.name.trim() || typeof data.version !== 'string' || !data.version.trim()) throw new Error('manifest requires name and version');
    const provides = data.provides;
    if (!provides || typeof provides !== 'object' || Array.isArray(provides)) throw new Error('provides must be a mapping');
    const seen = new Set<string>();
    for (const [category, entries] of Object.entries(provides)) {
      if (!Array.isArray(entries)) { errors.push(`${category}: expected list`); continue; }
      if (!Object.hasOwn(kinds, category)) { errors.push(`${category}: unsupported category`); continue; }
      for (const entry of entries) {
        if (typeof entry !== 'string' || !entry || isAbsolute(entry)) { errors.push(`${category}: invalid path`); continue; }
        try {
          const file = realpathSync(resolve(base, entry));
          const rel = relative(base, file);
          if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('path escapes bundle');
          if (seen.has(file)) throw new Error('duplicate unit path');
          seen.add(file);
          const result = loadDefinition(file);
          if (result.errors.length) { errors.push(...result.errors.map(e => `${entry}:${e.line}: ${e.message}`)); continue; }
          if (result.kind !== kinds[category]) { errors.push(`${entry}: expected ${kinds[category]}, got ${result.kind}`); continue; }
          units.push(`${category}:${entry}`);
        } catch (e) { errors.push(`${entry}: ${String(e)}`); }
      }
    }
    if (!units.length && !errors.length) errors.push('provides must contain at least one supported unit');
  } catch (e) { errors.push(String(e)); }
  return { units, errors };
}
