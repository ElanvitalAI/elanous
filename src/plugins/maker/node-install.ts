import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../../debug/log.js';
import { listNodeKinds } from '../../graph-kinds/registry.js';
import { loadPluginNodes } from '../../graph-kinds/plugin-nodes.js';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { installPlugin, type InstalledPlugin } from '../install/plugin-install.js';
import { addNode, type AddNodeOptions, type AddNodeResult } from './node-maker.js';

export interface AddAndInstallNodeOptions extends Omit<AddNodeOptions, 'deps'> {
  /** Accept the plugin's requested capabilities without asking (same meaning as `plugin add --yes`). */
  yes?: boolean;
  deps?: {
    addNode?: typeof addNode;
    installPlugin?: typeof installPlugin;
    consent?: (capabilities: string[]) => boolean | Promise<boolean>;
    sync?: (installed: InstalledPlugin) => void | Promise<void>;
    listNodeKinds?: typeof listNodeKinds;
    codex?: NonNullable<AddNodeOptions['deps']>['codex'];
  };
}

export interface AddAndInstallNodeResult extends Omit<AddNodeResult, 'status' | 'timings'> {
  status: 'installed' | 'failed';
  plugin?: string;
  installedPath?: string;
  timings: AddNodeResult['timings'] & { install: number; sync: number };
}

function installedNodeManifest(installed: InstalledPlugin, kind: string) {
  const { manifest, inferred } = loadPluginManifestFromDir(installed.path, { id: installed.name });
  if (inferred || manifest.id !== installed.name || manifest.version !== installed.version) {
    throw new Error(`installed plugin manifest mismatch: ${installed.name}@${installed.version}`);
  }
  const root = realpathSync(installed.path);
  const matches = (manifest.contributes.nodes ?? []).some(path => {
    const file = realpathSync(resolve(root, path));
    if (!path.startsWith('./') || !file.startsWith(`${root}${sep}`)) throw new Error(`unsafe installed node path: ${path}`);
    const node: unknown = parseYaml(readFileSync(file, 'utf8'));
    return node !== null && typeof node === 'object' && !Array.isArray(node)
      && (node as Record<string, unknown>).kind === kind
      && (node as Record<string, unknown>).graph === 'workflow';
  });
  if (!matches) throw new Error(`installed node not found: ${installed.name}:${kind}`);
  return manifest;
}

export async function addAndInstallNode({ dir, request, kind, yes, deps }: AddAndInstallNodeOptions): Promise<AddAndInstallNodeResult> {
  const added = await (deps?.addNode ?? addNode)({ dir, request, kind,
    ...(deps?.codex ? { deps: { codex: deps.codex } } : {}),
  });
  const result: AddAndInstallNodeResult = {
    ...added, status: 'failed', timings: { ...added.timings, install: 0, sync: 0 },
  };
  if (added.status !== 'added') return result;

  try {
    const startedInstall = performance.now();
    let installed: InstalledPlugin;
    try {
      installed = await (deps?.installPlugin ?? installPlugin)(added.dir, {
        ...(yes === undefined ? {} : { yes }),
        consent: deps?.consent ?? (() => false),
      });
    } finally {
      result.timings.install = Math.round(performance.now() - startedInstall);
      debug.log('plugin.node-install', 'install', { ms: result.timings.install });
    }
    result.plugin = installed.name;
    result.installedPath = installed.path;
    const startedSync = performance.now();
    try {
      const manifest = installedNodeManifest(installed, added.kind);
      if (deps?.sync) await deps.sync(installed);
      else {
        const loaded = loadPluginNodes(installed.path, manifest);
        if (loaded.errors.length) throw new Error(`node sync failed: ${loaded.errors.join('; ')}`);
      }
      const registered = (deps?.listNodeKinds ?? listNodeKinds)('workflow')
        .some(entry => entry.plugin === installed.name && entry.kind === `${installed.name}:${added.kind}`);
      if (!registered) throw new Error(`node kind not registered: ${installed.name}:${added.kind}`);
      result.status = 'installed';
    } finally {
      result.timings.sync = Math.round(performance.now() - startedSync);
      debug.log('plugin.node-install', 'sync', { ms: result.timings.sync, status: result.status });
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
