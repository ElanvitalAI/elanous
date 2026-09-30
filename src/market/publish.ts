import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { packDirDeterministic } from './tgz.js';
import { signIndex, verifyIndex, type MarketplaceIndex } from './signed-index.js';

type IndexConnector = MarketplaceIndex['plugins'][number]['ai.elanous']['connectors'][number];

function normalizeConnectors(connectors: unknown): { ok: true; value: IndexConnector[] } | { ok: false } {
  if (!Array.isArray(connectors)) return { ok: false };
  const value: IndexConnector[] = [];
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  for (const connector of connectors) {
    if (!record(connector) || typeof connector.id !== 'string' || !connector.id) return { ok: false };
    if (Array.isArray(connector.userConfig)) {
      if (typeof connector.kind !== 'string' || !connector.userConfig.every((field: unknown) =>
        record(field) && typeof field.key === 'string' && field.key.trim().length > 0 && typeof field.label === 'string' &&
        typeof field.secret === 'boolean' && (field.env === undefined || typeof field.env === 'string'))) {
        return { ok: false };
      }
      value.push(connector as IndexConnector);
    } else if (Array.isArray(connector.fields)) {
      if ((connector.kind !== undefined && typeof connector.kind !== 'string') || !connector.fields.every((field: unknown) =>
        record(field) && typeof field.name === 'string' && field.name.trim().length > 0 && typeof field.secret === 'boolean' &&
        (field.label === undefined || typeof field.label === 'string') &&
        (field.env === undefined || typeof field.env === 'string'))) {
        return { ok: false };
      }
      value.push({ id: connector.id, kind: (connector.kind ?? 'credentials') as string,
        userConfig: connector.fields.map((field: Record<string, unknown>) => ({
          key: field.name as string, label: (field.label ?? field.name) as string, secret: field.secret === true,
          ...(field.env ? { env: field.env as string } : {}),
        })) });
    } else {
      return { ok: false };
    }
  }
  return { ok: true, value };
}

function unpackLocal(archive: Uint8Array, destination: string): void {
  const tar = gunzipSync(archive);
  const field = (part: Buffer) => part.toString('utf8').replace(/\0.*$/, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(field(header.subarray(124, 136)).trim(), 8);
    const name = field(header.subarray(0, 100));
    const prefix = field(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    if (!Number.isSafeInteger(size) || size < 0 || !path || path.split('/').some(part => !part || part === '.' || part === '..') ||
        header[156] !== 48 || offset + 512 + size > tar.length) throw new Error('invalid packed archive');
    const file = join(destination, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, tar.subarray(offset + 512, offset + 512 + size),
      { mode: parseInt(field(header.subarray(100, 108)).trim(), 8) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

export interface PublishResult {
  ok: boolean;
  sequence: number;
  published: Array<{ name: string; version: string; sha256: string; bundled: string[] }>;
  skipped: Array<{ dir: string; reason: string }>;
  /** Published anyway, but a reviewer should look (e.g. a third-party graph relying on core recipes). */
  warnings: Array<{ dir: string; graph: string; reason: 'third-party-core-recipe'; recipes: string[] }>;
}

export function publishMarket(input: {
  pluginsDir: string;
  bundleRoot?: string;
  outDir: string;
  market: { name: string; displayName: string };
  key: { keyId: string; privateKeyPem: string };
  source?: { repoUrl: string; sha: string; basePath: string };
  now?: Date;
}): PublishResult {
  let sequence = 1;
  let currentName: string | undefined;
  let currentVersion: string | undefined;
  try {
    const indexPath = join(input.outDir, 'marketplace.json');
    const previous: MarketplaceIndex | undefined = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : undefined;
    if (previous) {
      if (!Number.isSafeInteger(previous.sequence) || previous.sequence < 0 || !Array.isArray(previous.plugins)) throw new Error('invalid previous marketplace.json');
      sequence = previous.sequence + 1;
    }
    // The public index describes the current catalog, not every version ever published.
    const historyPath = join(input.outDir, '.publication-history.json');
    const history: Array<{ name: string; version: string; sha256: string }> = existsSync(historyPath)
      ? JSON.parse(readFileSync(historyPath, 'utf8')) : [];
    if (!Array.isArray(history) || history.some(item => !item || typeof item.name !== 'string' ||
        typeof item.version !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) {
      throw new Error('invalid publication history');
    }
    if (!existsSync(historyPath) && previous && previous.sequence > 1) {
      throw new Error('missing publication history: cannot prove version immutability');
    }
    const recordedHashes = new Map<string, string>();
    const remember = (name: string, version: string, sha256: string) => {
      const identity = JSON.stringify([name, version]);
      const recorded = recordedHashes.get(identity);
      if (recorded && recorded !== sha256) throw new Error(`version-immutable: ${name}@${version}`);
      if (!recorded) {
        recordedHashes.set(identity, sha256);
        history.push({ name, version, sha256 });
      }
    };
    const saved = history.splice(0);
    for (const item of saved) remember(item.name, item.version, item.sha256);
    for (const item of previous?.plugins ?? []) {
      if (!item.artifact || typeof item.artifact.sha256 !== 'string') throw new Error('invalid previous marketplace.json');
      remember(item.name, item.version, item.artifact.sha256);
    }
    const published: PublishResult['published'] = [];
    const skipped: PublishResult['skipped'] = [];
    const warnings: PublishResult['warnings'] = [];
    const plugins: MarketplaceIndex['plugins'] = [];
    const archives: Array<{ key: string; data: Uint8Array; name: string }> = [];
    for (const dir of readdirSync(input.pluginsDir).sort()) {
      const folder = join(input.pluginsDir, dir);
      if (!lstatSync(folder).isDirectory()) continue;
      currentName = dir;
      currentVersion = undefined;
      const manifestPath = join(folder, 'plugin.json');
      const skip = (reason: string) => {
        skipped.push({ dir, reason });
        debug.log('market.publish', 'skipped', { name: dir, version: currentVersion, sequence, reason });
      };
      if (!existsSync(manifestPath)) { skip('missing-plugin.json'); continue; }
      let manifest: Record<string, unknown>;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
      catch { skip('invalid-plugin.json'); continue; }
      const ai = manifest?.extensions && typeof manifest.extensions === 'object'
        ? (manifest.extensions as Record<string, unknown>)['ai.elanous'] : undefined;
      if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' ||
          typeof manifest.description !== 'string' || !ai || typeof ai !== 'object' || Array.isArray(ai)) {
        skip('invalid-plugin.json'); continue;
      }
      currentVersion = manifest.version;
      if (!/^[a-z0-9-]{2,40}$/.test(manifest.name) || manifest.name !== dir ||
          !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
        skip('invalid-plugin.json'); continue;
      }
      const { category, bundle, ...metadata } = ai as MarketplaceIndex['plugins'][number]['ai.elanous'] & { category?: string; bundle?: unknown };
      if (!Array.isArray(metadata.capabilities) ||
          (category !== undefined && typeof category !== 'string')) {
        skip('invalid-plugin.json'); continue;
      }
      if (metadata.pricing !== undefined && metadata.pricing?.model !== 'free') {
        skip('paid-not-allowed-in-M0'); continue;
      }
      const normalized = normalizeConnectors(metadata.connectors);
      if (!normalized.ok) { skip('invalid-connectors'); continue; }
      const bundleItem = (item: unknown): item is string | { from: string; as: string } => typeof item === 'string' ||
        (!!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { from?: unknown }).from === 'string' &&
          typeof (item as { as?: unknown }).as === 'string');
      if (bundle !== undefined && (!Array.isArray(bundle) || !bundle.every(bundleItem))) {
        skip('invalid-plugin.json'); continue;
      }
      const extraDirs: Array<{ from: string; as: string }> = [];
      const bundled: string[] = [];
      let bundleError: string | undefined;
      if (bundle !== undefined && !input.bundleRoot) bundleError = 'bundle-root-missing';
      if (bundle !== undefined && input.bundleRoot) {
        const root = realpathSync(input.bundleRoot);
        const inside = (path: string) => {
          const rel = relative(root, path);
          return rel !== '..' && !rel.startsWith(`..${posix.sep}`) && !isAbsolute(rel);
        };
        for (const entry of bundle as Array<string | { from: string; as: string }>) {
          // A string names a skill folder (skills/<name>); { from, as } places any file or folder at `as`.
          const item = typeof entry === 'string' ? entry : entry.from;
          const candidate = resolve(root, item);
          if (isAbsolute(item) || !inside(candidate)) { bundleError = 'bundle-path-outside-root'; break; }
          if (!existsSync(candidate)) { bundleError = 'bundle-missing'; break; }
          const from = realpathSync(candidate);
          if (!inside(from)) { bundleError = 'bundle-path-outside-root'; break; }
          if (typeof entry !== 'string') {
            const stat = lstatSync(from);
            if (stat.isFile()) { extraDirs.push({ from, as: entry.as }); bundled.push(entry.as); continue; }
            if (!stat.isDirectory()) { bundleError = 'bundle-missing'; break; }
          } else if (!lstatSync(from).isDirectory()) { bundleError = 'bundle-missing'; break; }
          const checkContents = (path: string): boolean => readdirSync(path).every(name => {
            const child = join(path, name);
            const stat = lstatSync(child);
            if (stat.isSymbolicLink()) return false;
            const real = realpathSync(child);
            if (!inside(real)) return false;
            return !stat.isDirectory() || checkContents(child);
          });
          if (!checkContents(from)) { bundleError = 'bundle-path-outside-root'; break; }
          if (typeof entry !== 'string') { extraDirs.push({ from, as: entry.as }); bundled.push(entry.as); continue; }
          if (!['SKILL.md', 'skill.md'].some(file => {
            const skill = join(from, file);
            return existsSync(skill) && lstatSync(skill).isFile();
          })) {
            bundleError = 'bundle-not-a-skill'; break;
          }
          const name = basename(candidate);
          extraDirs.push({ from, as: `skills/${name}` });
          bundled.push(name);
        }
      }
      // The loader registers only graphs listed in the manifest, so each listed path must ship in the package.
      if (!bundleError && Array.isArray(metadata.graphs) && !metadata.graphs.every(graph => typeof graph === 'string' &&
          (existsSync(join(folder, graph)) || extraDirs.some(extra => graph === extra.as || graph.startsWith(`${extra.as}/`))))) {
        bundleError = 'graph-missing';
      }
      if (bundleError) { skip(bundleError); continue; }
      // Third-party graphs may only use their own recipes (graphs/…/recipes.yaml next to the graph) or custom nodes;
      // leaning on core code recipes is published but flagged. First-party packs may point at core recipes.
      if ((ai as { trust?: unknown }).trust !== 'official' && Array.isArray(metadata.graphs)) {
        const packagePath = (path: string): string | null => {
          if (existsSync(join(folder, path))) return join(folder, path);
          const extra = extraDirs.find(item => path === item.as || path.startsWith(`${item.as}/`));
          return extra ? join(extra.from, path.slice(extra.as.length)) : null;
        };
        for (const graph of metadata.graphs) {
          try {
            const source = packagePath(graph);
            if (!source || !lstatSync(source).isFile()) continue;
            const spec = parseYaml(readFileSync(source, 'utf8')) as { nodes?: Array<{ recipe?: unknown }> } | null;
            const recipesFile = packagePath(posix.join(posix.dirname(graph), 'recipes.yaml'));
            const own = recipesFile && existsSync(recipesFile)
              ? new Set(Object.keys((parseYaml(readFileSync(recipesFile, 'utf8')) as Record<string, unknown> | null) ?? {})) : new Set<string>();
            const foreign = [...new Set((spec?.nodes ?? []).map(node => node?.recipe)
              .filter((recipe): recipe is string => typeof recipe === 'string' && !own.has(recipe)))].sort();
            if (foreign.length) {
              warnings.push({ dir, graph, reason: 'third-party-core-recipe', recipes: foreign });
              debug.log('market.publish', 'warning', { name: manifest.name, version: manifest.version, sequence, reason: 'third-party-core-recipe', graph, recipes: foreign });
            }
          } catch { /* A graph that cannot be read is the loader's validation error, not a publish warning. */ }
        }
      }
      let archive: Uint8Array;
      try { archive = packDirDeterministic(folder, { extraDirs }); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.startsWith('bundle-conflict')) { skip('bundle-conflict'); continue; }
        throw error;
      }
      let sha256 = createHash('sha256').update(archive).digest('hex');
      const recorded = recordedHashes.get(JSON.stringify([manifest.name, manifest.version]));
      if (recorded && recorded !== sha256) {
        const existingPath = join(input.outDir, manifest.name, manifest.version, `${recorded}.tgz`);
        let sameContent = false;
        if (existsSync(existingPath)) {
          try {
            const existing = readFileSync(existingPath);
            sameContent = createHash('sha256').update(existing).digest('hex') === recorded &&
              gunzipSync(existing).equals(gunzipSync(archive));
            if (sameContent) {
              archive = existing;
              sha256 = recorded;
            }
          } catch { /* An unreadable archive cannot prove immutability. */ }
        }
        if (!sameContent) throw new Error(`version-immutable: ${manifest.name}@${manifest.version}`);
        debug.log('market.publish', 'reused-artifact', { name: manifest.name, version: manifest.version,
          reason: 'same-content-different-gzip' });
      }
      remember(manifest.name, manifest.version, sha256);
      const key = `${manifest.name}/${manifest.version}/${sha256}.tgz`;
      const source: MarketplaceIndex['plugins'][number]['source'] = input.source
        ? { source: 'git-subdir', url: input.source.repoUrl, path: posix.join(input.source.basePath, dir), sha: input.source.sha }
        : { source: 'local', path: `./plugins/${dir}` };
      plugins.push({ name: manifest.name, source,
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: category ?? 'Productivity', version: manifest.version,
        description: manifest.description, artifact: { sha256, bytes: archive.length, key },
        'ai.elanous': { ...metadata, connectors: normalized.value, pricing: metadata.pricing ?? { model: 'free' } },
      });
      archives.push({ key, data: archive, name: dir });
      published.push({ name: manifest.name, version: manifest.version, sha256, bundled });
      debug.log('market.publish', 'bundled', { name: manifest.name, version: manifest.version, skills: bundled });
    }
    const index: MarketplaceIndex = { name: input.market.name, interface: { displayName: input.market.displayName },
      sequence, generatedAt: (input.now ?? new Date()).toISOString(), plugins };
    const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
    let signatureText: string;
    let publicKey: string;
    try {
      signatureText = signIndex(bytes, input.key.privateKeyPem, input.key.keyId);
      publicKey = createPublicKey(input.key.privateKeyPem).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    } catch {
      throw new Error('invalid signing key');
    }
    const trustedKeys = [{ keyId: input.key.keyId, publicKey }];
    const candidate = verifyIndex({ marketplaceBytes: bytes, signatureText, trustedKeys });
    if (!candidate.ok) throw new Error(`index verification failed: ${candidate.reason}: ${candidate.detail}`);
    for (const archive of archives) {
      const destination = join(input.outDir, archive.key);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, archive.data);
      if (!input.source) {
        const unpacked = join(input.outDir, 'plugins', archive.name);
        rmSync(unpacked, { recursive: true, force: true });
        unpackLocal(archive.data, unpacked);
      }
    }
    mkdirSync(input.outDir, { recursive: true });
    // Preserve the ledger before exposing an index that may later omit these versions.
    writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');
    writeFileSync(indexPath, bytes);
    if (!input.source) {
      const codexIndex = join(input.outDir, '.agents', 'plugins', 'marketplace.json');
      mkdirSync(join(codexIndex, '..'), { recursive: true });
      writeFileSync(codexIndex, bytes);
    }
    writeFileSync(join(input.outDir, 'index.sig'), signatureText);
    const verified = verifyIndex({ marketplaceBytes: readFileSync(indexPath),
      signatureText: readFileSync(join(input.outDir, 'index.sig'), 'utf8'), trustedKeys });
    if (!verified.ok) throw new Error(`index verification failed: ${verified.reason}: ${verified.detail}`);
    for (const item of published) debug.log('market.publish', 'published', { name: item.name, version: item.version, sequence });
    return { ok: true, sequence, published, skipped, warnings };
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : 'unknown-error';
    const reason = input.key.privateKeyPem && rawReason.includes(input.key.privateKeyPem) ? 'invalid signing key' : rawReason;
    debug.log('market.publish', 'failed', { name: currentName, version: currentVersion, sequence, reason });
    if (reason.startsWith('version-immutable')) throw new Error(reason);
    throw new Error(`market publish failed: ${reason}`);
  }
}
