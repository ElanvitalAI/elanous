import { readFileSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { parse } from 'yaml';
import type { PluginManifest } from '../plugins/core/manifest.js';
import { registerNodeKind, type GraphKind, type NodeKindRun } from './registry.js';

export interface PluginNodeLoadResult {
  errors: string[];
}

/** Load declarative node kinds independently: a broken YAML cannot hide a sibling definition. */
export function loadPluginNodes(pluginDir: string, manifest: PluginManifest): PluginNodeLoadResult {
  const result: PluginNodeLoadResult = { errors: [] };
  for (const path of manifest.contributes.nodes ?? []) {
    try {
      const root = realpathSync(pluginDir);
      const file = realpathSync(resolve(root, path));
      const rel = relative(root, file);
      if (!path.startsWith('./') || !rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
        throw new Error('node path must remain inside the plugin dir');
      }
      const raw: unknown = parse(readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('node must be an object');
      const node = raw as Record<string, unknown>;
      if (typeof node.kind !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(node.kind)) {
        throw new Error('kind must be a kebab-case name');
      }
      if (node.graph !== 'workflow' && node.graph !== 'harness') throw new Error('graph must be workflow or harness');
      if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)
        || (node.inputs as Record<string, unknown>).type !== 'object') {
        throw new Error('inputs must be an object schema');
      }
      let run: NodeKindRun | undefined;
      if (node.graph === 'workflow') {
        if (!node.run || typeof node.run !== 'object' || Array.isArray(node.run)) throw new Error('run must be an object');
        const spec = node.run as Record<string, unknown>;
        if (Object.keys(spec).length !== 1 || !['bash', 'http', 'skill'].some((key) => key in spec)) {
          throw new Error('run must contain exactly one bash, http or skill executor');
        }
        run = spec as NodeKindRun;
      } else if (node.run !== undefined) {
        throw new Error('harness nodes cannot define run');
      }
      const kind = `${manifest.id}:${node.kind}`;
      const registration = registerNodeKind({
        graph: node.graph as GraphKind,
        kind,
        plugin: manifest.id,
        description: typeof node.description === 'string' ? node.description : '',
        schema: node.inputs as Record<string, unknown>,
        core: false,
        ...(run ? { run } : {}),
      });
      if (!registration.ok) throw new Error(`node ${kind} rejected: ${registration.reason}`);
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
