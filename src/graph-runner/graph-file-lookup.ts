import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function findGraphFile(graphId: string, extraRoots: string[] = []): string | undefined {
  const roots = [...extraRoots.map((root) => resolve(root)), resolve('graphs'), resolve(import.meta.dir, '../../graphs')];
  for (const root of roots) {
    for (const dir of [root, ...['release', 'ops'].map((part) => join(root, part))]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.yaml') || name === 'recipes.yaml') continue;
        const file = join(dir, name);
        if (!existsSync(join(dir, 'recipes.yaml'))) continue;
        try {
          const parsed: unknown = parseYaml(readFileSync(file, 'utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).graph_id === graphId) return file;
        } catch { continue; }
      }
    }
  }
  return undefined;
}
