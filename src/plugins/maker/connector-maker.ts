import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import type { PluginDraft } from './plugin-maker.js';

export interface MakeConnectorOptions {
  dir: string;
  gap: PluginDraft['connectors'][number];
  id: string;
}

/** Add one connector's credential-name-only draft to the existing extension manifest. */
export function makeConnector({ dir: inputDir, gap, id }: MakeConnectorOptions): string {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id) || !gap || !gap.name.trim() || gap.name === '미확인'
    || !gap.use.trim() || !Array.isArray(gap.evidence) || !gap.evidence.every(source => typeof source === 'string')
    || !Array.isArray(gap.missingCredentials)) throw new Error('invalid connector gap or id');
  const dir = resolve(inputDir);
  const path = join(dir, 'plugin.json');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || lstatSync(dir).isSymbolicLink()
    || realpathSync(dir) !== join(realpathSync(dirname(dir)), basename(dir))) {
    throw new Error('plugin.json missing or unsafe');
  }
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid plugin.json');
  const data = raw as Record<string, unknown>;
  const extensions = data.extensions as Record<string, unknown> | undefined;
  const extension = extensions?.['ai.elanous'];
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) throw new Error('missing ai.elanous extension');
  const entry = extension as Record<string, unknown>;
  if (entry.connectors !== undefined && !Array.isArray(entry.connectors)) throw new Error('invalid connectors');
  const manifest = loadPluginManifestFromDir(dir, { id: 'local-plugin' }).manifest;
  if (manifest.contributes.connectors?.some(connector => connector.id === id)) throw new Error(`connector already exists: ${id}`);
  const credentials = gap.missingCredentials.filter(name => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name));
  if (new Set(credentials).size !== credentials.length) throw new Error('duplicate connector credential name');
  entry.connectors = [...(entry.connectors as unknown[] | undefined ?? []), {
    id, fields: credentials.map(name => ({ name, secret: true })),
  }];
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}
