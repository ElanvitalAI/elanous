import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { listInstalledPlugins, type InstalledPlugin } from '../plugins/install/plugin-install.js';
import { loadPluginManifestFromDir, type PluginManifest } from '../plugins/core/manifest.js';
import { loadPluginNodes } from './plugin-nodes.js';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind, type GraphKind, type NodeKindEntry } from './registry.js';

export interface InstalledPluginNodeSyncResult {
  registered: number;
  removed: number;
  errors: Array<{ plugin: string; reason: string }>;
}

type OwnedNode = { graph: GraphKind; kind: string; plugin: string; registered: NodeKindEntry };
type InstalledNodeState = { stamp: string; owned: Map<string, { fingerprint: string; nodes: OwnedNode[] }> };
const states = new Map<string, InstalledNodeState>();

function fingerprint(item: InstalledPlugin, manifest: PluginManifest): string {
  const root = realpathSync(item.path);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([item.name, item.version, item.market, item.sha256, item.installedAt, manifest]));
  for (const path of manifest.contributes.nodes ?? []) {
    const file = realpathSync(resolve(root, path));
    const rel = relative(root, file);
    if (!path.startsWith('./') || !rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error(`node path must remain inside the plugin dir: ${path}`);
    }
    hash.update(path);
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

/** Reconcile only registrations made by this sync; the registry's identity check protects other owners. */
export function syncInstalledPluginNodes(root: string): InstalledPluginNodeSyncResult {
  const result: InstalledPluginNodeSyncResult = { registered: 0, removed: 0, errors: [] };
  const stateRoot = resolve(root);
  const ledger = statSync(join(stateRoot, 'plugins', 'installed.json'), { throwIfNoEntry: false, bigint: true });
  // The installer atomically replaces the ledger, so mtime and size alone can
  // coincide across installs. File identity and ctime detect that replacement.
  const stamp = ledger ? `${ledger.dev}:${ledger.ino}:${ledger.ctimeNs}:${ledger.mtimeNs}:${ledger.size}` : 'missing';
  const previous = states.get(stateRoot);
  if (previous?.stamp === stamp) return result;

  // The installer commits a new ledger via rename after the package directory is in place.
  // If discovery itself fails, the stamp is not advanced and the next request retries.
  const installed = listInstalledPlugins(stateRoot);
  const current = new Set(installed.map(item => item.path));
  const owned = previous?.owned ?? new Map<string, { fingerprint: string; nodes: OwnedNode[] }>();
  const removeOwned = (path: string): void => {
    for (const node of owned.get(path)?.nodes ?? []) {
      if (unregisterPluginNodeKind(node.graph, node.kind, node.plugin, node.registered)) result.removed++;
    }
    owned.delete(path);
  };
  for (const path of owned.keys()) {
    if (!current.has(path)) removeOwned(path);
  }

  for (const item of installed) {
    try {
      const manifest = loadPluginManifestFromDir(item.path, { id: item.name }).manifest;
      if (!manifest.contributes.nodes?.length) {
        removeOwned(item.path);
        continue;
      }
      const version = fingerprint(item, manifest);
      if (owned.get(item.path)?.fingerprint === version) continue;
      removeOwned(item.path);
      const before = new Set(listNodeKinds().filter(entry => entry.plugin === manifest.id).map(entry => `${entry.graph}:${entry.kind}`));
      const loaded = loadPluginNodes(item.path, manifest);
      const nodes: OwnedNode[] = [];
      for (const entry of listNodeKinds().filter(entry => entry.plugin === manifest.id && !before.has(`${entry.graph}:${entry.kind}`))) {
        const registered = getNodeKindRegistration(entry.graph, entry.kind);
        if (registered) nodes.push({ graph: entry.graph, kind: entry.kind, plugin: manifest.id, registered });
      }
      if (loaded.errors.length) {
        for (const node of nodes) unregisterPluginNodeKind(node.graph, node.kind, node.plugin, node.registered);
        result.errors.push({ plugin: item.name, reason: loaded.errors.join('; ') });
        owned.set(item.path, { fingerprint: version, nodes: [] });
        continue;
      }
      result.registered += nodes.length;
      owned.set(item.path, { fingerprint: version, nodes });
    } catch (error) {
      removeOwned(item.path);
      result.errors.push({ plugin: item.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  states.set(stateRoot, { stamp, owned });
  debug.log('graph.kinds', 'installed-sync', { root: stateRoot, ...result });
  return result;
}
