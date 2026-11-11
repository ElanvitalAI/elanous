import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

type HandlerDeclaration = { module: string; export: string; skill: string };

function declaredHandler(manifestPath: string, handlerName: string): HandlerDeclaration | null {
  const parsed: unknown = parseYaml(readFileSync(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Record<string, unknown>;
  const handlers = manifest.handlers;
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) return null;
  const row = (handlers as Record<string, unknown>)[handlerName];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const { module, skill } = row as Record<string, unknown>;
  const exportName = (row as Record<string, unknown>).export;
  const skills = new Set((Array.isArray(manifest.skills) ? manifest.skills : [])
    .flatMap(value => value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
      ? [(value as { id: string }).id] : []));
  if (typeof module !== 'string' || !/^handlers\/[A-Za-z0-9_-]+\.ts$/.test(module)
    || typeof exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)
    || typeof skill !== 'string' || !skills.has(skill)) throw new Error(`invalid plugin handler declaration: ${manifestPath}:${handlerName}`);
  return { module, export: exportName, skill };
}

/** Load one manifest-declared plugin function; core knows the handler key, never a feature module path. */
export async function loadDeclaredPluginHandler<T extends (...args: never[]) => unknown>(pluginsRoot: string, handlerName: string): Promise<T | null> {
  if (!existsSync(pluginsRoot)) return null;
  const candidates: Array<{ path: string; exportName: string }> = [];
  const root = realpathSync(pluginsRoot);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(root, entry.name);
    const manifestPath = join(pluginDir, 'plugin.yaml');
    if (!existsSync(manifestPath)) continue;
    const handler = declaredHandler(manifestPath, handlerName);
    if (!handler) continue;
    const path = realpathSync(join(pluginDir, handler.module));
    const inside = relative(realpathSync(pluginDir), path);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`plugin handler escapes its package: ${handlerName}`);
    candidates.push({ path, exportName: handler.export });
  }
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error(`ambiguous plugin handler: ${handlerName}`);
  const candidate = candidates[0]!;
  const module = await import(pathToFileURL(candidate.path).href) as Record<string, unknown>;
  const handler = module[candidate.exportName];
  if (typeof handler !== 'function') throw new Error(`plugin handler export missing: ${handlerName}`);
  return handler as T;
}
