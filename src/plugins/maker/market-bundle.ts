import { createHash, createPublicKey } from 'node:crypto';
import { signIndex, validateMarketplaceIndex, verifyIndex, type MarketplaceIndex } from '../../market/signed-index.js';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { userConfigPath } from '../../user-config.js';
import { loadPluginManifestFromDir } from '../core/manifest.js';
import { LEAK_MARKERS, loadPrivateRedactions, privateIdentifierMarkers, scanLeaks } from '../../../scripts/public-export.js';

export interface MarketBundleResult {
  path: string;
  artifact: string;
  signature: 'signed' | 'signing-required';
}

function packageFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === '.git' || entry.name === '.elanous' || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error(`unsafe market bundle entry: ${path}`);
    if (entry.isDirectory()) files.push(...packageFiles(dir, path));
    else files.push(path);
  }
  return files;
}

/** Prepare a local, reviewable official-market index and tar artifact; never publishes either file. */
export function bundleInstalledWizardPlugin(installedPath: string, outputDir: string, configPath = userConfigPath()): MarketBundleResult {
  const source = resolve(installedPath);
  const manifestFile = join(source, 'plugin.json');
  if (!lstatSync(source).isDirectory() || !lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) {
    throw new Error('market bundle requires an installed plugin.json');
  }
  const raw: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { name?: unknown }).name !== 'string') {
    throw new Error('invalid market plugin manifest name');
  }
  const { manifest, inferred } = loadPluginManifestFromDir(source, { id: (raw as { name: string }).name });
  if (inferred || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(manifest.id) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
    throw new Error('invalid market plugin manifest name or version');
  }
  if ((raw as { extensions?: { 'ai.elanous'?: { researchDraft?: boolean } } }).extensions?.['ai.elanous']?.researchDraft === true) {
    throw new Error('research draft cannot be bundled for market');
  }
  const files = packageFiles(source);
  if (!files.length) throw new Error('empty plugin bundle');
  if (manifest.id !== (raw as { name: string }).name) throw new Error('market plugin manifest name mismatch');
  for (const asset of [manifest.main, ...(manifest.contributes.graphs ?? []), ...(manifest.contributes.vocab ?? []), ...(manifest.contributes.nodes ?? [])]) {
    if (asset === './plugin.ts' && !('main' in (raw as object))) continue;
    if (!files.includes(asset.replace(/^\.\//, ''))) throw new Error(`market manifest asset missing: ${asset}`);
  }
  const redactions = loadPrivateRedactions();
  if (!redactions) throw new Error('private export redaction list unavailable; market bundle refused');
  const hits = scanLeaks(source, files, [...LEAK_MARKERS, ...privateIdentifierMarkers(redactions)]);
  if (hits.length) throw new Error(`market bundle leak: ${hits.map(hit => `${hit.file}:${hit.line} ${hit.marker}`).join(', ')}`);
  const config: unknown = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid market signing config');
  const signing = (config as { market?: { signing?: { keyId?: unknown; privateKey?: unknown } } }).market?.signing;
  const hasKey = signing?.privateKey !== undefined || signing?.keyId !== undefined;
  if (hasKey && (typeof signing?.privateKey !== 'string' || !signing.privateKey.trim() || typeof signing.keyId !== 'string' || !signing.keyId.trim())) {
    throw new Error('market signing requires configured keyId and privateKey');
  }
  const target = resolve(outputDir);
  if (target === source || target.startsWith(`${source}${sep}`) || source.startsWith(`${target}${sep}`)) throw new Error('market bundle output must be outside plugin directory');
  if (existsSync(target)) throw new Error(`market bundle already exists: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target);
  try {
    const artifactKey = `${manifest.id}-${manifest.version}.tgz`;
    const artifact = join(target, artifactKey);
    const tar = spawnSync('tar', ['-czf', artifact, '-C', source, '--', ...files], { encoding: 'utf8' });
    if (tar.status !== 0 || tar.error) throw new Error(`market archive failed: ${tar.error?.message ?? tar.stderr}`);
    const bytes = readFileSync(artifact);
    const index: MarketplaceIndex = { name: 'elanous', interface: { displayName: 'Elanous' }, sequence: 1, plugins: [{
      name: manifest.id, version: manifest.version, description: manifest.description,
      source: { source: 'local', path: '.' },
      artifact: { key: artifactKey, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
      'ai.elanous': {
        capabilities: manifest.capabilities.map(capability => capability.kind),
        connectors: (manifest.contributes.connectors ?? []).map(connector => ({
          id: connector.id, kind: 'user-config', userConfig: (connector.userConfig ?? connector.fields?.map(field => ({
            key: field.name, label: field.name, secret: field.secret === true,
          })) ?? []).map(field => ({ key: field.key, label: field.label ?? field.key, secret: field.secret === true })),
        })),
        graphs: manifest.contributes.graphs ?? [], vocab: manifest.contributes.vocab ?? [],
        pricing: { model: 'free' },
      },
    }] };
    const invalid = validateMarketplaceIndex(index);
    if (invalid) throw new Error(`invalid market index: ${invalid}`);
    const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
    writeFileSync(join(target, 'marketplace.json'), indexBytes);
    if (hasKey) {
      const signatureText = signIndex(indexBytes, signing!.privateKey as string, signing!.keyId as string);
      const check = verifyIndex({ marketplaceBytes: indexBytes, signatureText, trustedKeys: [{
        keyId: signing!.keyId as string,
        publicKey: createPublicKey(signing!.privateKey as string).export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'),
      }] });
      if (!check.ok) throw new Error(`market index signature invalid: ${check.detail}`);
      writeFileSync(join(target, 'index.sig'), signatureText);
    }
    return { path: target, artifact, signature: hasKey ? 'signed' : 'signing-required' };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
