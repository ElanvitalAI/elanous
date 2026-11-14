import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { compare as compareSemver, maxSatisfying, satisfies as satisfiesSemver, validRange } from 'semver';
import { loadPluginManifestFromDir, type PluginManifest } from '../core/manifest.js';
import { inspectPluginSecurity } from '../core/capability-policy.js';
import { decidePluginInstallation } from '../core/trust-store.js';
import { loadPluginNodes } from '../../graph-kinds/plugin-nodes.js';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { verifyIndex, type MarketplaceIndex, type VerifyIndexResult } from '../../market/signed-index.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { ensureInternalMarketIndex, ensureMarketIndex, MarketFetchError, type MarketFetchOptions } from './market-fetch.js';

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/;
const SHA = /^[a-fA-F0-9]{40}$/;
const HASH = /^[a-fA-F0-9]{64}$/;

/** Curated scene packages offered by the default install group. Service-key
 *  declarations live in each package manifest and use the shared key catalog. */
export const DEFAULT_PLUGIN_GROUP = [
  { id: 'firecrawl', label: '웹사이트 크롤링', requiredServiceKeys: ['firecrawl'], optionalServiceKeys: [], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: [] },
  { id: 'demo-research', label: '리서치', requiredServiceKeys: [], optionalServiceKeys: ['exa', 'firecrawl', 'xai', 'tavily'], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: [] },
  { id: 'demo-linear-secretary', label: '리니어 비서', requiredServiceKeys: ['linear'], optionalServiceKeys: ['telegram', 'telegram-chat'], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: [] },
  { id: 'demo-absorption-briefing', label: '흡수 브리핑', requiredServiceKeys: [], optionalServiceKeys: ['exa', 'firecrawl', 'xai', 'telegram', 'telegram-chat', 'linear'], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: [] },
  { id: 'demo-browser-hand', label: '브라우저 손', requiredServiceKeys: [], optionalServiceKeys: ['linear'], requiredPrerequisites: ['llm-provider', 'aside'], optionalPrerequisites: [] },
  { id: 'demo-video-briefing', label: '영상 브리핑', requiredServiceKeys: [], optionalServiceKeys: ['elevenlabs', 'telegram', 'telegram-chat'], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: [] },
  { id: 'demo-plugin-wizard', label: '플러그인 마법사', requiredServiceKeys: [], optionalServiceKeys: [], requiredPrerequisites: ['llm-provider'], optionalPrerequisites: ['claude-cli', 'github-cli'] },
] as const;

/** Packages used by first-run onboarding and the 11-14 walkthrough, in dependency order. */
export const DEMO1114_PLUGIN_IDS = [
  'firecrawl', 'architecture-deliverables', 'elanous-app-deploy', 'absorb',
  'demo-absorption-briefing', 'demo-brief-to-requirements', 'gcp-architect-expand',
] as const;

export type DefaultPluginStatus = {
  id: typeof DEFAULT_PLUGIN_GROUP[number]['id'];
  label: string;
  status: 'ready' | 'key-needed';
  missingRequiredKeys: string[];
  missingPrerequisites: string[];
  optionalKeysMissing: string[];
  optionalPrerequisitesMissing: string[];
};

/** Public readiness identifiers only; callers must never pass secret values. */
export function defaultPluginStatuses(input: {
  readyServiceKeyIds?: readonly string[];
  satisfiedPrerequisites?: readonly string[];
} = {}): DefaultPluginStatus[] {
  const readyKeys = new Set(input.readyServiceKeyIds ?? []);
  const satisfied = new Set(input.satisfiedPrerequisites ?? []);
  return DEFAULT_PLUGIN_GROUP.map(plugin => {
    const missingRequiredKeys = plugin.requiredServiceKeys.filter(id => !readyKeys.has(id));
    const missingPrerequisites = plugin.requiredPrerequisites.filter(id => !satisfied.has(id));
    return {
      id: plugin.id,
      label: plugin.label,
      status: missingRequiredKeys.length || missingPrerequisites.length ? 'key-needed' : 'ready',
      missingRequiredKeys,
      missingPrerequisites,
      optionalKeysMissing: plugin.optionalServiceKeys.filter(id => !readyKeys.has(id)),
      optionalPrerequisitesMissing: plugin.optionalPrerequisites.filter(id => !satisfied.has(id)),
    };
  });
}

const DEFAULT_PLUGIN_ROOT = resolve(import.meta.dir, '../../../plugins');

/** The shipped board handler has exactly these three out-of-package host imports. */
function knownAbsorbHostImports(packageRoot: string, security: ReturnType<typeof inspectPluginSecurity>): boolean {
  const dangerous = security.findings.filter(finding => finding.level === 'dangerous');
  if (dangerous.length !== 3 || dangerous.some(finding => finding.code !== 'unsafe-import')) return false;
  const handler = join(packageRoot, 'handlers', 'board-approval.ts');
  if (!existsSync(handler)) return false;
  const imports = [...readFileSync(handler, 'utf8').matchAll(/^import\s+.+\s+from\s+['"]([^'"]+)['"];?\s*$/gm)]
    .map(match => match[1]!)
    .filter(target => target.startsWith('../') || target.startsWith('/') || target.startsWith('file:'));
  const expected = [
    '../../../src/nexus/api/board-api.js',
    '../../../src/graph-runner/runner.js',
    '../../../src/tool-router/index.js',
  ];
  return imports.length === expected.length && expected.every(target => imports.includes(target));
}

/** Install the curated default group from this distribution's packaged plugin assets. */
export async function installDefaultPluginGroup(opts: InstallOptions = {}): Promise<InstalledPlugin[]> {
  const root = resolve(opts.root ?? elanousStateRoot());
  const installed: InstalledPlugin[] = [];
  for (const plugin of DEFAULT_PLUGIN_GROUP) {
    const packageRoot = join(DEFAULT_PLUGIN_ROOT, plugin.id);
    const manifest = loadPluginManifestFromDir(packageRoot, { id: plugin.id }).manifest;
    const existing = listInstalledPlugins(root).find(item =>
      item.market === 'local' && item.name === manifest.id && item.version === manifest.version);
    installed.push(existing ?? await installPlugin(packageRoot, { ...opts, root }));
  }
  return installed;
}

/** First-run install from packaged assets; retain per-package failures for a visible retry. */
export async function installDemo1114PluginGroup(opts: InstallOptions = {}): Promise<{
  installed: InstalledPlugin[]; failed: string[];
}> {
  const root = resolve(opts.root ?? elanousStateRoot());
  const installed: InstalledPlugin[] = [];
  const failed: string[] = [];
  for (const id of DEMO1114_PLUGIN_IDS) {
    try {
      const source = join(DEFAULT_PLUGIN_ROOT, id);
      const manifest = loadPluginManifestFromDir(source, { id }).manifest;
      const existing = listInstalledPlugins(root).find(item =>
        item.market === 'local' && item.name === manifest.id && item.version === manifest.version);
      if (existing && id === 'elanous-app-deploy' && manifest.main) {
        const sourceMain = inside(source, manifest.main);
        const installedMain = inside(existing.path, manifest.main);
        assertInstallParents(root, installedMain);
        if (!existsSync(installedMain)) {
          // Restore only the missing bundled entry; keep the version and user config.
          copyFileSync(sourceMain, installedMain, constants.COPYFILE_EXCL);
        }
        const entry = lstatSync(installedMain);
        if (!entry.isFile() || entry.isSymbolicLink() || !readFileSync(installedMain).equals(readFileSync(sourceMain)))
          fail('scan', `bundled plugin entry differs: ${id}`);
      }
      if (existing) {
        const expectedRoot = mkdtempSync(join(tmpdir(), 'elanous-demo-pack-'));
        try {
          const expected = join(expectedRoot, 'package');
          copyPlugin(source, expected);
          if (!samePackTree(existing.path, expected)) fail('scan', `bundled plugin package differs: ${id}`);
        } finally { rmSync(expectedRoot, { recursive: true, force: true }); }
      }
      // These bundled first-party packages are part of the selected first-run product.
      // Their declared capabilities remain subject to the static security scan.
      installed.push(existing ?? await installPlugin(source, {
        ...opts, root, yes: opts.yes ?? true, deferRuntimePreparation: true,
      }));
    } catch { failed.push(id); }
  }
  return { installed, failed };
}

export type InstallEvent =
  | { event: 'resolve'; plugin: string; version: string; sha256: string | null }
  | { event: 'verify'; signature: 'ok' | 'missing' | 'bad'; scan: 'safe' | 'caution' | 'dangerous' }
  | { event: 'consent'; capabilities: string[]; required: boolean }
  | { event: 'credentials'; connectors: Array<{ id: string; fields: Array<{ name: string; secret: boolean }> }> }
  | { event: 'registered'; /** Vocab file paths, not graph node kinds. */ kinds: string[]; nodes: string[]; nodeErrors: number; graphs: string[]; skills: string[] }
  | { event: 'done'; plugin: string; version: string; path: string };

export interface InstalledPlugin {
  name: string;
  version: string;
  market: string;
  path: string;
  sha256: string | null;
  /** Absent for installations recorded before timestamps were introduced. */
  installedAt?: string;
  /** New packages installed for one dependency request share this receipt id. */
  installBundleId?: string;
}

export interface InstallOptions {
  root?: string;
  /** Stage bundled packages during first run; runtime requirements remain declared for use. */
  deferRuntimePreparation?: boolean;
  marketDir?: string;
  cwd?: string;
  allowUnsigned?: boolean;
  refresh?: boolean;
  yes?: boolean;
  trustedKeys?: ReadonlyArray<{ keyId: string; publicKey: string }>;
  verifySignature?: typeof verifyIndex;
  hashArtifact?: (bytes: Uint8Array) => string;
  onEvent?: (event: InstallEvent) => void;
  consent?: (capabilities: string[]) => boolean | Promise<boolean>;
  fetcher?: MarketFetchOptions['fetcher'];
  configPath?: string;
  /** Enterprise context for knowledge packs in a private market. */
  enterpriseId?: string;
  /** Internal pin after a signed dependency range has been resolved. */
  requestedPluginVersion?: string;
  /** Internal branch exclusion while backtracking an unpinned root request. */
  excludedPluginVersions?: ReadonlySet<string>;
  /** Test seam; production runs only the fixed uv commands derived from validated runtime declarations. */
  runRuntimeCommand?: (command: string, args: readonly string[], cwd: string) => { status: number | null; stderr?: string };
}

export class PluginInstallError extends Error {
  constructor(public readonly reason: 'signature' | 'scan' | 'consent-denied' | 'credentials' | 'conflict' | 'io', message: string) {
    super(message);
    this.name = 'PluginInstallError';
  }
}

class RootAlreadyInstalled extends PluginInstallError {
  constructor(name: string, version: string) { super('conflict', `plugin already installed: ${name}@${version}`); }
}

function fail(reason: PluginInstallError['reason'], detail: string): never {
  throw new PluginInstallError(reason, detail);
}

function child(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) fail('io', `${command}: ${result.error?.message ?? result.stderr?.trim() ?? 'failed'}`);
  return result.stdout.trim();
}

function inside(root: string, rel: string): string {
  if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.split(/[\\/]/).includes('..')) fail('io', `unsafe plugin path: ${rel}`);
  const path = resolve(root, rel);
  if (path !== root && !path.startsWith(`${root}${sep}`)) fail('io', `unsafe plugin path: ${rel}`);
  return path;
}

function safeTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('scan', `unsafe plugin entry: ${entry.name}`);
    if (entry.isDirectory()) safeTree(path);
  }
}

function packPathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Never follow a linked installation root or parent while reusing, moving or rolling back a package. */
function assertInstallParents(root: string, destination: string): void {
  const parts = relative(root, dirname(destination)).split(sep).filter(Boolean);
  if (parts.some(part => part === '..') || isAbsolute(relative(root, destination))) fail('io', `unsafe installation path: ${destination}`);
  // macOS exposes system aliases such as /var -> /private/var; inspect the
  // canonical path after that alias, without exempting any caller-owned parent.
  const systemAlias = process.platform === 'darwin' && ['/var', '/tmp'].find(path => root === path || root.startsWith(`${path}${sep}`));
  const checkedRoot = systemAlias ? resolve(realpathSync(systemAlias), relative(systemAlias, root)) : root;
  const parents = [checkedRoot];
  while (dirname(parents[0]!) !== parents[0]) parents.unshift(dirname(parents[0]!));
  let parent = checkedRoot;
  for (const part of parts) {
    parent = join(parent, part);
    parents.push(parent);
  }
  for (const path of parents) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('io', `unsafe installation parent: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Only an unchanged, ordinary extracted tree can satisfy the verified staged artifact. */
function samePackTree(existing: string, verified: string): boolean {
  if (!lstatSync(existing).isDirectory()) return false;
  const current = readdirSync(existing, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const expected = readdirSync(verified, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (current.length !== expected.length) return false;
  return current.every((entry, i) => {
    const other = expected[i]!;
    if (entry.name !== other.name || entry.isSymbolicLink() || other.isSymbolicLink()) return false;
    if (entry.isDirectory() && other.isDirectory()) return samePackTree(join(existing, entry.name), join(verified, entry.name));
    return entry.isFile() && other.isFile() && readFileSync(join(existing, entry.name)).equals(readFileSync(join(verified, entry.name)));
  });
}

function copyPlugin(source: string, destination: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail('io', `plugin directory not found: ${source}`);
  safeTree(source);
  // This bundled demo keeps binary screenshots and PDFs under sim/. Its
  // published package uses none of them; keep every other plugin's sim/ intact.
  const gcpDemo = join(DEFAULT_PLUGIN_ROOT, 'gcp-architect-expand');
  const bundledGcpDemo = existsSync(gcpDemo) && realpathSync(source) === realpathSync(gcpDemo);
  cpSync(source, destination, { recursive: true,
    filter: path => basename(path) !== '.git' && !(bundledGcpDemo && relative(source, path) === 'sim') });
}

function indexPath(market: string, opts: InstallOptions): string {
  const base = resolve(opts.marketDir ?? join(opts.root ?? elanousStateRoot(), 'markets'));
  const candidates = [join(base, market, 'marketplace.json'), join(base, market, '.agents', 'plugins', 'marketplace.json')];
  const path = candidates.find(existsSync);
  if (!path) fail('io', `market index not found: ${market}`);
  return path;
}

function marketEntry(spec: string, opts: InstallOptions): { market: string; entry: MarketplaceIndex['plugins'][number]; signature: 'ok' | 'missing' } {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  const market = spec.slice(at + 1);
  if (!NAME.test(name) || !NAME.test(market)) fail('io', `invalid plugin or market name: ${spec}`);
  const path = indexPath(market, opts);
  const bytes = readFileSync(path);
  const sigPath = join(dirname(path), 'index.sig');
  const signature = existsSync(sigPath) ? 'ok' : 'missing';
  let index: MarketplaceIndex;
  if (signature === 'missing' && opts.allowUnsigned) {
    try { index = JSON.parse(bytes.toString('utf8')) as MarketplaceIndex; } catch { fail('io', 'invalid marketplace.json'); }
  } else {
    if (signature === 'missing') fail('signature', `missing index.sig: ${market}`);
    const result: VerifyIndexResult = (opts.verifySignature ?? verifyIndex)({
      marketplaceBytes: bytes, signatureText: readFileSync(sigPath, 'utf8'), trustedKeys: opts.trustedKeys ?? [],
    });
    if (!result.ok) fail('signature', `${result.reason}: ${result.detail}`);
    index = result.index;
  }
  if (!index || index.name !== market || !Array.isArray(index.plugins)) fail('io', `invalid market index: ${market}`);
  const candidates = index.plugins.filter(plugin => plugin && plugin.name === name);
  const versions = candidates.map(plugin => plugin.version);
  const eligible = versions.filter(version => !opts.excludedPluginVersions?.has(version));
  const version = opts.requestedPluginVersion ?? maxSatisfying(eligible, '*') ?? maxSatisfying(eligible, '*', { includePrerelease: true });
  if (!version && opts.excludedPluginVersions?.size) fail('conflict', `no remaining plugin version: ${name}@${market}`);
  const matches = candidates.filter(plugin => plugin.version === version);
  if (matches.length !== 1 || !matches[0]?.source || typeof matches[0].source.source !== 'string' || typeof matches[0]?.version !== 'string') fail('io', `plugin not found or malformed in ${market}: ${name}`);
  return { market, entry: matches[0]!, signature };
}

/** Offline: a signed index placed in `<markets>/<name>/` without a configured URL (pre-fetch behaviour — kept). */
function localMarketSource(spec: string, target: string, opts: InstallOptions): ResolvedPluginSource {
    const { market, entry, signature } = marketEntry(spec, opts);
    const source = entry.source;
    const sourceRoot = dirname(indexPath(market, opts));
    if (entry.artifact) {
      if (!HASH.test(entry.artifact.sha256) || !Number.isSafeInteger(entry.artifact.bytes) || entry.artifact.bytes < 0) fail('io', 'invalid artifact hash or size');
      const artifactPath = inside(sourceRoot, entry.artifact.key);
      if (!existsSync(artifactPath)) fail('io', `artifact unavailable: ${entry.artifact.key}`);
      if (!realpathSync(artifactPath).startsWith(`${realpathSync(sourceRoot)}${sep}`)) fail('scan', 'artifact escapes market directory');
      const bytes = readFileSync(artifactPath);
      const actual = (opts.hashArtifact ?? (data => createHash('sha256').update(data).digest('hex')))(bytes);
      if (actual.toLowerCase() !== entry.artifact.sha256.toLowerCase() || bytes.length !== entry.artifact.bytes) fail('scan', 'artifact sha256 or size mismatch');
      unpackArchive(bytes, target);
    } else if (signature === 'missing' && opts.allowUnsigned && source.source === 'local' && typeof source.path === 'string') {
      const sourcePath = inside(sourceRoot, source.path);
      if (existsSync(sourcePath) && !realpathSync(sourcePath).startsWith(`${realpathSync(sourceRoot)}${sep}`)) fail('scan', 'source escapes market directory');
      copyPlugin(sourcePath, target);
    } else if (signature === 'missing' && opts.allowUnsigned && source.source === 'git-subdir' && typeof source.url === 'string' && typeof source.path === 'string' && typeof source.sha === 'string' && SHA.test(source.sha)) {
      gitSource(source.url, target, source.path, source.sha);
    } else {
      fail('io', `market entry has no verifiable artifact: ${entry.name}`);
    }
    return { market, sha256: entry.artifact?.sha256 ?? null, signature, expectedName: entry.name, expectedVersion: entry.version };
}

function hasLocalMarketIndex(market: string, opts: InstallOptions): boolean {
  const base = resolve(opts.marketDir ?? join(opts.root ?? elanousStateRoot(), 'markets'));
  return [join(base, market, 'marketplace.json'), join(base, market, '.agents', 'plugins', 'marketplace.json')].some(existsSync);
}

function unpackArchive(bytes: Uint8Array, target: string): void {
  const archive = join(dirname(target), 'artifact.tgz');
  writeFileSync(archive, bytes);
  try {
    const entries = child('tar', ['-tzf', archive]).split('\n');
    for (const item of entries) {
      if (item === '.' || item === './') continue;
      inside(target, item.replace(/^\.\//, ''));
    }
    // Links and special entries can write outside the destination before a post-extract scan.
    const types = child('tar', ['-tvzf', archive]).split('\n');
    if (types.some(line => line && !['-', 'd'].includes(line[0]!))) fail('scan', 'artifact contains links or special files');
    mkdirSync(target);
    child('tar', ['-xzf', archive, '-C', target, '--no-same-owner', '--no-same-permissions']);
    safeTree(target);
  } finally {
    rmSync(archive, { force: true });
  }
}

type ResolvedPluginSource = { market: string; sha256: string | null; signature: 'ok' | 'missing'; expectedName?: string; expectedVersion?: string };

function marketSpec(spec: string, opts: InstallOptions): boolean {
  return /^[a-z0-9][a-z0-9-]{1,39}@[a-z0-9][a-z0-9-]{1,39}$/.test(spec) && !existsSync(resolve(opts.cwd ?? process.cwd(), spec));
}

async function fetchedMarketSource(spec: string, target: string, opts: InstallOptions): Promise<ResolvedPluginSource> {
  const [name, marketName] = spec.split('@') as [string, string];
  let marketIndex: Awaited<ReturnType<typeof ensureMarketIndex>>;
  try {
    marketIndex = await ensureMarketIndex(marketName, {
      root: opts.root, marketDir: opts.marketDir, configPath: opts.configPath, fetcher: opts.fetcher,
      refresh: opts.refresh, verifySignature: opts.verifySignature, trustedKeys: opts.trustedKeys,
    });
  } catch (error) {
    if (error instanceof MarketFetchError && /^market not configured: /.test(error.message) && opts.enterpriseId !== undefined) {
      try {
        marketIndex = await ensureInternalMarketIndex(marketName, opts.enterpriseId, {
          root: opts.root, marketDir: opts.marketDir, configPath: opts.configPath, fetcher: opts.fetcher, refresh: opts.refresh,
        });
      } catch (internalError) {
        if (internalError instanceof MarketFetchError) throw new PluginInstallError(internalError.reason, internalError.message);
        throw internalError;
      }
    } else if (error instanceof MarketFetchError && /^market not configured: /.test(error.message) && hasLocalMarketIndex(marketName, opts)) {
      return localMarketSource(spec, target, opts);
    } else if (error instanceof MarketFetchError) throw new PluginInstallError(error.reason, error.message);
    else throw error;
  }
  const candidates = marketIndex.index.plugins.filter(entry => entry.name === name);
  const versions = candidates.map(entry => entry.version);
  const eligible = versions.filter(version => !opts.excludedPluginVersions?.has(version));
  const version = opts.requestedPluginVersion ?? maxSatisfying(eligible, '*') ?? maxSatisfying(eligible, '*', { includePrerelease: true });
  if (!version && opts.excludedPluginVersions?.size) fail('conflict', `no remaining plugin version: ${name}@${marketName}`);
  const matches = candidates.filter(entry => entry.version === version);
  if (matches.length !== 1) fail('io', `plugin not found or ambiguous in ${marketName}: ${name}`);
  const entry = matches[0]!;
  await fetchVerifiedArtifact(entry.artifact, marketIndex.market.url, target, opts);
  return { market: marketName, sha256: entry.artifact.sha256, signature: marketIndex.signature, expectedName: name, expectedVersion: entry.version };
}

async function fetchVerifiedArtifact(artifact: MarketplaceIndex['plugins'][number]['artifact'], marketUrl: string, target: string, opts: InstallOptions): Promise<void> {
  if (!artifact || typeof artifact.key !== 'string' || !artifact.key || !HASH.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) fail('io', 'invalid artifact key, hash or size');
  // Check the key as written, before URL resolution folds `..`/`.` or percent-encoded separators away.
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(artifact.key) || artifact.key.split('/').some(part => part === '.' || part === '..')) fail('io', 'unsafe artifact key');
  const base = new URL(marketUrl);
  const url = new URL(artifact.key, base);
  if (url.protocol !== 'https:' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)
    || url.username || url.password || url.search || url.hash || /[\\?#]/.test(artifact.key)) fail('io', 'unsafe artifact key');
  let response: Response;
  // The URL checks above hold only if no redirect moves the download elsewhere.
  try { response = await (opts.fetcher ?? fetch)(url.href, { redirect: 'error' }); }
  catch { fail('io', 'artifact fetch failed: network error'); }
  if (!response.ok || !response.body) fail('io', `artifact fetch failed: HTTP ${response.status}`);
  if (response.redirected || (response.url && response.url !== url.href)) fail('io', 'artifact fetch was redirected');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > artifact.bytes) fail('scan', 'artifact sha256 or size mismatch');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (length !== artifact.bytes || (opts.hashArtifact ?? (data => createHash('sha256').update(data).digest('hex')))(bytes).toLowerCase() !== artifact.sha256.toLowerCase()) {
    fail('scan', 'artifact sha256 or size mismatch');
  }
  unpackArchive(bytes, target);
}

async function stageRequiredKnowledgePacks(names: string[], market: string, stage: string, root: string, opts: InstallOptions): Promise<Array<{ name: string; destination: string; staged: string }>> {
  if (!names.length) return [];
  if (market === 'local') fail('io', 'knowledge pack requires need a signed market');
  const unique = [...new Set(names)];
  if (unique.some(name => !NAME.test(name))) fail('io', 'invalid required knowledge pack name');
  let index: MarketplaceIndex;
  let url: string | undefined;
  let directory: string | undefined;
  let internalVerified = false;
  try {
    const options = { root, marketDir: opts.marketDir, configPath: opts.configPath, fetcher: opts.fetcher,
      refresh: opts.refresh, verifySignature: opts.verifySignature, trustedKeys: opts.trustedKeys };
    let result: Awaited<ReturnType<typeof ensureMarketIndex>>;
    try { result = await ensureMarketIndex(market, options); }
    catch (error) {
      if (!(error instanceof MarketFetchError) || !/^market not configured: /.test(error.message) || opts.enterpriseId === undefined) throw error;
      result = await ensureInternalMarketIndex(market, opts.enterpriseId, options);
      internalVerified = true;
    }
    index = result.index;
    url = result.market.url;
  } catch (error) {
    if (error instanceof MarketFetchError && /^market not configured: /.test(error.message) && hasLocalMarketIndex(market, opts)) {
      const path = indexPath(market, opts);
      directory = dirname(path);
      const sig = join(directory, 'index.sig');
      if (!existsSync(sig)) fail('signature', `missing index.sig: ${market}`);
      const result = (opts.verifySignature ?? verifyIndex)({ marketplaceBytes: readFileSync(path), signatureText: readFileSync(sig, 'utf8'), trustedKeys: opts.trustedKeys ?? [] });
      if (!result.ok) fail('signature', `${result.reason}: ${result.detail}`);
      if (result.index.name !== market) fail('io', `market index name mismatch: ${market}`);
      index = result.index;
    } else if (error instanceof MarketFetchError) throw new PluginInstallError(error.reason, error.message);
    else throw error;
  }
  const packs: Array<{ name: string; destination: string; staged: string }> = [];
  for (const name of unique) {
    const matches = (index.knowledgePacks ?? []).filter(entry => entry.name === name);
    if (matches.length !== 1) fail('io', `required knowledge pack not found or ambiguous: ${name}`);
    const entry = matches[0]!;
    if (!VERSION.test(entry.version)) fail('io', `invalid required knowledge pack version: ${name}`);
    if (entry.visibility === 'internal') {
      if (!opts.enterpriseId || entry.enterpriseId !== opts.enterpriseId) fail('io', `knowledge pack not authorized: ${name}`);
      if (!internalVerified) {
        try {
          const authorized = await ensureInternalMarketIndex(market, opts.enterpriseId, {
            root, marketDir: opts.marketDir, configPath: opts.configPath, fetcher: opts.fetcher, refresh: opts.refresh,
          });
          if (!authorized.index.knowledgePacks?.some(pack => pack.name === name && pack.version === entry.version
            && pack.artifact.sha256 === entry.artifact.sha256 && pack.artifact.bytes === entry.artifact.bytes
            && pack.artifact.key === entry.artifact.key)) fail('io', `knowledge pack not authorized: ${name}`);
        } catch (error) {
          if (error instanceof MarketFetchError) throw new PluginInstallError(error.reason, error.message);
          throw error;
        }
      }
    }
    const staged = join(stage, `knowledge-${packs.length}`);
    if (directory) {
      const artifactPath = inside(directory, entry.artifact.key);
      if (!existsSync(artifactPath) || !realpathSync(artifactPath).startsWith(`${realpathSync(directory)}${sep}`)) fail('scan', `unsafe knowledge pack artifact: ${name}`);
      const bytes = readFileSync(artifactPath);
      if (bytes.length !== entry.artifact.bytes || (opts.hashArtifact ?? (data => createHash('sha256').update(data).digest('hex')))(bytes).toLowerCase() !== entry.artifact.sha256.toLowerCase()) fail('scan', 'artifact sha256 or size mismatch');
      unpackArchive(bytes, staged);
    } else {
      await fetchVerifiedArtifact(entry.artifact, url!, staged, opts);
    }
    packs.push({ name, staged, destination: join(root, 'knowledge-packs', market, name, entry.version) });
  }
  return packs;
}

export function resolvePluginSource(spec: string, target: string, opts: InstallOptions = {}): ResolvedPluginSource {
  // Synchronous callers keep the offline contract: a signed index already placed under `<markets>/<name>/`.
  if (marketSpec(spec, opts)) return localMarketSource(spec, target, opts);
  const local = resolve(opts.cwd ?? process.cwd(), spec);
  if (existsSync(local)) {
    copyPlugin(realpathSync(local), target);
    return { market: 'local', sha256: null, signature: 'missing' };
  }
  const match = /^(.*?\.git)(?:#([a-fA-F0-9]{40}))?(?::(.+))?$/.exec(spec);
  if (!match) fail('io', `unsupported plugin source: ${spec}`);
  if (match[3] && !match[2]) fail('io', 'git subdirectory requires a pinned 40-hex sha');
  gitSource(match[1]!, target, match[3], match[2]);
  return { market: 'local', sha256: null, signature: 'missing' };
}

function gitSource(url: string, destination: string, path?: unknown, sha?: unknown): void {
  if (sha !== undefined && (typeof sha !== 'string' || !SHA.test(sha))) fail('io', 'git sha must be a full 40-hex commit');
  const temp = mkdtempSync(join(tmpdir(), 'elanous-plugin-git-'));
  try {
    child('git', ['clone', '--quiet', '--no-checkout', '--', url, temp]);
    child('git', ['checkout', '--quiet', '--detach', sha ?? 'HEAD'], temp);
    if (sha && child('git', ['rev-parse', 'HEAD'], temp).toLowerCase() !== sha.toLowerCase()) fail('io', 'git commit mismatch');
    const subdir = path === undefined ? temp : inside(temp, String(path));
    if (existsSync(subdir) && !realpathSync(subdir).startsWith(`${realpathSync(temp)}${sep}`) && subdir !== temp) fail('scan', 'git subdirectory escapes repository');
    copyPlugin(subdir, destination);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function hasSkill(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(entry => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')));
}

function inspectPluginNodes(packageRoot: string, manifest: PluginManifest): { nodes: string[]; nodeErrors: number } {
  if (!manifest.contributes.nodes?.length) return { nodes: [], nodeErrors: 0 };
  // Registration validates each staged definition. Use a private identity so existing installations
  // cannot reject an otherwise valid kind as a duplicate; only this inspection's entries are removed.
  const inspectionId = `inspect-${randomUUID().replaceAll('-', '')}`;
  let nodeErrors = 0;
  const nodes: string[] = [];
  try {
    nodeErrors = loadPluginNodes(packageRoot, { ...manifest, id: inspectionId }).errors.length;
  } finally {
    for (const entry of listNodeKinds()) {
      if (entry.plugin !== inspectionId) continue;
      nodes.push(`${manifest.id}:${entry.kind.slice(inspectionId.length + 1)}`);
      const registered = getNodeKindRegistration(entry.graph, entry.kind);
      if (registered) unregisterPluginNodeKind(entry.graph, entry.kind, inspectionId, registered);
    }
  }
  return { nodes, nodeErrors };
}

function declaresMain(packageRoot: string): boolean {
  for (const file of ['plugin.json', join('.codex-plugin', 'plugin.json')]) {
    const path = join(packageRoot, file);
    if (!existsSync(path)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (raw && typeof raw === 'object' && 'main' in raw) return true;
    } catch { return true; }
  }
  return !existsSync(join(packageRoot, 'plugin.json')) && !existsSync(join(packageRoot, '.codex-plugin', 'plugin.json'));
}

/** [wiring] Caller: installPlugin. The PluginManifest normalized by
 * loadPluginManifestFromDir is handed into the install path here — the install
 * destination follows the manifest identity, never the source spec/dir name. */
export function pluginInstallPath(root: string, market: string, manifest: PluginManifest): string {
  return join(root, 'plugins', market, manifest.id, manifest.version);
}

type DeclaredPluginRef = { id: string; range: string; optional: boolean; market?: string };

export function parseDeclaredPluginRef(value: NonNullable<NonNullable<PluginManifest['dependencies']>['plugins']>[number]): DeclaredPluginRef {
  const at = typeof value === 'string' ? value.indexOf('@') : -1;
  const id = typeof value === 'string' ? at < 0 ? value : value.slice(0, at) : value.id;
  const range = typeof value === 'string' ? at < 0 ? '*' : value.slice(at + 1) : value.version ?? '*';
  const optional = typeof value === 'string' ? false : value.optional === true;
  const market = typeof value === 'string' ? undefined : value.market;
  if (!NAME.test(id) || !validRange(range) || (market !== undefined && !NAME.test(market))) {
    fail('io', `invalid plugin dependency: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return { id, range, optional, ...(market ? { market } : {}) };
}

function prepareDeclaredRuntime(manifest: PluginManifest, destination: string, opts: InstallOptions, bundledSource: boolean): void {
  if (opts.deferRuntimePreparation) {
    if (!bundledSource) fail('io', `runtime preparation can only be deferred for bundled plugins: ${manifest.id}`);
    return;
  }
  for (const runtime of manifest.dependencies?.runtime ?? []) {
    const distributionProject = runtime.project.startsWith('@distribution/');
    if (distributionProject && !bundledSource) fail('io', `runtime project unavailable: ${manifest.id}`);
    const projectRoot = distributionProject ? dirname(DEFAULT_PLUGIN_ROOT) : destination;
    const project = inside(projectRoot, distributionProject ? runtime.project.slice('@distribution/'.length) : runtime.project);
    const canonicalRoot = realpathSync(projectRoot);
    if (!existsSync(project) || !realpathSync(project).startsWith(`${canonicalRoot}${sep}`) ||
      !existsSync(join(project, 'pyproject.toml')) || !lstatSync(join(project, 'pyproject.toml')).isFile()) {
      fail('io', `runtime project missing or unsafe: ${manifest.id}`);
    }
    const extraArgs = runtime.extras.flatMap(extra => ['--extra', extra]);
    const commands: string[][] = [
      ['sync', ...extraArgs],
      ...(runtime.browser === 'chromium' ? [['run', ...extraArgs, 'python', '-m', 'playwright', 'install', 'chromium']] : []),
    ];
    for (const args of commands) {
      let status: number | null;
      try {
        status = opts.runRuntimeCommand
          ? opts.runRuntimeCommand('uv', args, project).status
          : spawnSync('uv', args, { cwd: project, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 }).status;
      } catch { status = null; }
      if (status !== 0) fail('io', `runtime preparation failed: ${manifest.id} requires uv/python${runtime.browser ? ' and Playwright Chromium' : ''}; install uv or check the declared project`);
    }
  }
}

/** Verify declared plugin requirements against installed package manifests; never install them implicitly here. */
function assertDeclaredPluginDependencies(manifest: PluginManifest, root: string): void {
  if (!manifest.dependencies?.plugins?.length) return;
  const installed = listInstalledPlugins(root);
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const visit = (owner: PluginManifest, ownerKey: string): void => {
    if (checked.has(ownerKey)) return;
    if (visiting.has(ownerKey)) fail('conflict', `plugin dependency cycle: ${owner.id}@${owner.version}`);
    visiting.add(ownerKey);
    for (const declaration of owner.dependencies?.plugins ?? []) {
      const ref = parseDeclaredPluginRef(declaration);
      if (ref.optional) continue;
      if (ref.id === owner.id) fail('conflict', `plugin cannot depend on itself: ${ref.id}`);
      const matches = installed.filter(item => item.name === ref.id && (!ref.market || item.market === ref.market)
        && satisfiesSemver(item.version, ref.range)).sort((a, b) => compareSemver(b.version, a.version));
      if (!matches.length) {
        fail('conflict', `required plugin not installed: ${ref.id}@${ref.range}`);
      }
      if (matches.length > 1 && matches[0]!.version === matches[1]!.version) fail('conflict', `ambiguous plugin dependency: ${ref.id}@${ref.range}`);
      const match = matches[0]!;
      const dependency = loadPluginManifestFromDir(match.path, { id: match.name, version: match.version }).manifest;
      visit(dependency, `${match.market}/${match.name}/${match.version}`);
    }
    visiting.delete(ownerKey);
    checked.add(ownerKey);
  };
  visit(manifest, `candidate/${manifest.id}/${manifest.version}`);
}

interface DependencyInstallContext {
  stack: string[];
  selected: Map<string, { version: string; market: string }>;
  constraints: Map<string, DeclaredPluginRef[]>;
  excludedVersions: Map<string, Set<string>>;
  created: InstalledPlugin[];
  createdPacks: Array<{ path: string; dev: number; ino: number }>;
  bundleId?: string;
}

class DependencyReplan extends Error {}

async function signedDependencyVersion(ref: DeclaredPluginRef, market: string, opts: InstallOptions,
  constraints: DeclaredPluginRef[], excluded: ReadonlySet<string> = new Set()): Promise<string> {
  let index: MarketplaceIndex;
  try {
    const result = await ensureMarketIndex(market, { root: opts.root, marketDir: opts.marketDir,
      configPath: opts.configPath, fetcher: opts.fetcher, refresh: opts.refresh,
      verifySignature: opts.verifySignature, trustedKeys: opts.trustedKeys });
    index = result.index;
  } catch (error) {
    if (error instanceof MarketFetchError) throw new PluginInstallError(error.reason, error.message);
    throw error;
  }
  const versions = index.plugins.filter(entry => entry.name === ref.id).map(entry => entry.version);
  if (!versions.length) fail('conflict', `required plugin not found in ${market}: ${ref.id}`);
  const selected = versions.filter(version => !excluded.has(version) && constraints.every(item => satisfiesSemver(version, item.range)))
    .sort((a, b) => compareSemver(b, a))[0];
  if (!selected) fail('conflict', `plugin version conflict: ${ref.id}@${ref.range} in ${market}`);
  return selected;
}

async function ensureDeclaredPluginDependencies(
  manifest: PluginManifest, sourceMarket: string, root: string, opts: InstallOptions, context: DependencyInstallContext,
  sourcePath?: string,
): Promise<void> {
  const declarations = manifest.dependencies?.plugins ?? [];
  if (declarations.length) context.bundleId ??= randomUUID();
  for (const declaration of declarations) {
    const ref = parseDeclaredPluginRef(declaration);
    // Optional integrations never constrain the required install graph.
    if (ref.optional) continue;
    if (ref.id === manifest.id || context.stack.includes(ref.id)) fail('conflict', `plugin dependency cycle: ${[...context.stack, ref.id].join(' -> ')}`);
    const constraints = context.constraints.get(ref.id) ?? [];
    if (!constraints.some(item => item.range === ref.range && item.market === ref.market)) constraints.push(ref);
    context.constraints.set(ref.id, constraints);
    const markets = [...new Set(constraints.map(item => item.market).filter((value): value is string => !!value))];
    if (markets.length > 1) fail('conflict', `plugin market conflict: ${ref.id}`);
    const market = markets[0] ?? sourceMarket;
    const excluded = context.excludedVersions.get(ref.id) ?? new Set<string>();
    const installed = listInstalledPlugins(root).filter(item => item.name === ref.id && (!markets.length || item.market === market)
      && !excluded.has(item.version) && constraints.every(constraint => satisfiesSemver(item.version, constraint.range)))
      .sort((a, b) => compareSemver(b.version, a.version));
    if (installed.length > 1 && installed[0]!.version === installed[1]!.version) fail('conflict', `ambiguous plugin dependency: ${ref.id}@${ref.range}`);
    const existing = installed[0];
    if (existing) {
      const chosen = context.selected.get(ref.id);
      if (chosen && (chosen.version !== existing.version || chosen.market !== existing.market)) {
        throw new DependencyReplan(`plugin ${ref.id} must be reselected`);
      }
      context.selected.set(ref.id, { version: existing.version, market: existing.market });
      continue;
    }
    if (market === 'local') {
      if (!sourcePath) fail('conflict', `required plugin not installed: ${ref.id}@${ref.range}`);
      const sibling = join(dirname(sourcePath), ref.id);
      if (!existsSync(sibling)) fail('conflict', `required plugin not installed: ${ref.id}@${ref.range}`);
      const local = loadPluginManifestFromDir(sibling, { id: ref.id }).manifest;
      if (local.id !== ref.id || !satisfiesSemver(local.version, ref.range)) {
        fail('conflict', `plugin version conflict: ${ref.id}@${ref.range}`);
      }
      const chosen = context.selected.get(ref.id);
      if (chosen && (chosen.version !== local.version || chosen.market !== 'local')) {
        throw new DependencyReplan(`plugin ${ref.id} must be reselected`);
      }
      context.selected.set(ref.id, { version: local.version, market: 'local' });
      await installPluginInternal(sibling, opts, context);
      continue;
    }
    const chosen = context.selected.get(ref.id);
    const version = await signedDependencyVersion(ref, market, opts, constraints, excluded);
    if (chosen && (chosen.version !== version || chosen.market !== market)) {
      throw new DependencyReplan(`plugin ${ref.id} must be reselected`);
    }
    context.selected.set(ref.id, { version, market });
    await installPluginInternal(`${ref.id}@${market}`, { ...opts, requestedPluginVersion: version }, context);
  }
}

function rollbackDependencyInstall(context: DependencyInstallContext, root: string): void {
  if (!context.created.length && !context.createdPacks.length) return;
  withLedgerLock(root, () => {
    const current = listInstalledPlugins(root);
    const owned = context.created.filter(item => current.some(candidate => candidate.market === item.market
      && candidate.name === item.name && candidate.version === item.version
      && candidate.installBundleId === item.installBundleId && candidate.installedAt === item.installedAt));
    const createdKeys = new Set(owned.map(item => `${item.market}/${item.name}/${item.version}`));
    const retained = new Set<string>();
    // An independently committed plugin may have started using a staged dependency.
    // Keep that dependency and its transitive requirements when rolling back this bundle.
    const visitRequired = (item: InstalledPlugin): void => {
      const key = `${item.market}/${item.name}/${item.version}`;
      if (retained.has(key)) return;
      retained.add(key);
      const manifest = loadPluginManifestFromDir(item.path, { id: item.name, version: item.version }).manifest;
      for (const declaration of manifest.dependencies?.plugins ?? []) {
        const ref = parseDeclaredPluginRef(declaration);
        if (ref.optional) continue;
        for (const dependency of current.filter(candidate => candidate.name === ref.id &&
          (!ref.market || candidate.market === ref.market) && satisfiesSemver(candidate.version, ref.range))) visitRequired(dependency);
      }
    };
    for (const item of current) {
      if (!createdKeys.has(`${item.market}/${item.name}/${item.version}`)) visitRequired(item);
    }
    for (const item of context.created.reverse()) {
      if (!createdKeys.has(`${item.market}/${item.name}/${item.version}`)) continue;
      if (retained.has(`${item.market}/${item.name}/${item.version}`)) continue;
      assertInstallParents(root, item.path);
      rmSync(item.path, { recursive: true, force: true });
    }
    const retainedPacks = new Set<string>();
    for (const item of current) {
      if (!retained.has(`${item.market}/${item.name}/${item.version}`)) continue;
      const manifest = loadPluginManifestFromDir(item.path, { id: item.name, version: item.version }).manifest;
      for (const name of manifest.requires?.knowledgePacks ?? []) retainedPacks.add(`${item.market}/${name}`);
    }
    for (const pack of context.createdPacks) {
      const { path } = pack;
      const market = basename(dirname(dirname(path)));
      const name = basename(dirname(path));
      if (retainedPacks.has(`${market}/${name}`)) continue;
      assertInstallParents(root, path);
      if (!packPathExists(path)) continue;
      const currentPack = lstatSync(path);
      if (currentPack.dev !== pack.dev || currentPack.ino !== pack.ino) continue;
      rmSync(path, { recursive: true, force: true });
    }
    writeLedger(root, listInstalledPlugins(root).map(item => retained.has(`${item.market}/${item.name}/${item.version}`) && createdKeys.has(`${item.market}/${item.name}/${item.version}`)
      ? { ...item, installBundleId: undefined } : item));
  });
}

export async function installPlugin(spec: string, opts: InstallOptions = {}): Promise<InstalledPlugin> {
  const root = resolve(opts.root ?? elanousStateRoot());
  type ExclusionPlan = Map<string, Set<string>>;
  const pending: ExclusionPlan[] = [new Map()];
  const seen = new Set<string>(['[]']);
  let attempts = 0;
  let lastConflict: unknown;
  while (pending.length) {
    // Source: bounded search keeps a crafted signed market from multiplying install attempts without limit.
    if (++attempts > 256) fail('conflict', 'plugin dependency search exceeded its attempt limit');
    const excludedVersions = pending.pop()!;
    // Constraints are scoped to this candidate graph; another version may declare different transitive requirements.
    const context: DependencyInstallContext = { stack: [], selected: new Map(), constraints: new Map(), excludedVersions, created: [], createdPacks: [] };
    try { return await installPluginInternal(spec, opts, context); }
    catch (error) {
      try { rollbackDependencyInstall(context, root); }
      catch (rollbackError) { fail('io', `plugin dependency rollback failed: ${String(rollbackError)}`); }
      if (error instanceof RootAlreadyInstalled) throw error;
      if (!(error instanceof DependencyReplan || error instanceof PluginInstallError && error.reason === 'conflict')) throw error;
      lastConflict ??= error;
      // Explore a sibling for each selected candidate, most recently chosen first.
      // Exclusions belong to that branch only; a version needed by another sibling remains eligible.
      for (const [id, choice] of context.selected) {
        const next: ExclusionPlan = new Map([...excludedVersions].map(([key, versions]) => [key, new Set(versions)]));
        const banned = next.get(id) ?? new Set<string>();
        banned.add(choice.version);
        next.set(id, banned);
        const key = JSON.stringify([...next].sort(([a], [b]) => a.localeCompare(b)).map(([plugin, versions]) => [plugin, [...versions].sort()]));
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(next);
      }
    }
  }
  if (lastConflict) throw lastConflict;
  fail('conflict', 'no compatible plugin dependency graph');
}

async function installPluginInternal(spec: string, opts: InstallOptions, context: DependencyInstallContext): Promise<InstalledPlugin> {
  const root = resolve(opts.root ?? elanousStateRoot());
  // Only this distribution's bundled absorb handler imports host APIs outside
  // its package. Author-supplied trust metadata cannot grant this exception.
  const bundledAbsorb = (() => {
    const candidate = resolve(opts.cwd ?? process.cwd(), spec);
    const bundled = join(DEFAULT_PLUGIN_ROOT, 'absorb');
    return existsSync(candidate) && existsSync(bundled) && realpathSync(candidate) === realpathSync(bundled);
  })();
  const stageRoot = join(root, 'plugins', '.staging');
  assertInstallParents(root, join(stageRoot, 'plugin'));
  mkdirSync(stageRoot, { recursive: true });
  assertInstallParents(root, join(stageRoot, 'plugin'));
  const stage = mkdtempSync(join(stageRoot, 'plugin-'));
  let stackPushed = false;
  try {
    const isMarketSpec = marketSpec(spec, opts);
    const isRootRequest = context.stack.length === 0;
    const rootMarketName = isMarketSpec && isRootRequest ? spec.split('@')[0] : undefined;
    const sourceOpts = rootMarketName ? { ...opts, excludedPluginVersions: context.excludedVersions.get(rootMarketName) } : opts;
    const source = isMarketSpec
      ? await fetchedMarketSource(spec, join(stage, 'package'), sourceOpts)
      : resolvePluginSource(spec, join(stage, 'package'), opts);
    const originalSource = isMarketSpec ? undefined : resolve(opts.cwd ?? process.cwd(), spec);
    const bundledSource = !!originalSource && existsSync(originalSource) &&
      realpathSync(originalSource).startsWith(`${realpathSync(DEFAULT_PLUGIN_ROOT)}${sep}`);
    const stagedManifest = join(stage, 'package', 'plugin.json');
    if (existsSync(stagedManifest)) {
      const rawManifest: unknown = JSON.parse(readFileSync(stagedManifest, 'utf8'));
      if (rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)) {
        const rawExtensions = (rawManifest as Record<string, unknown>).extensions;
        if (rawExtensions && typeof rawExtensions === 'object' && !Array.isArray(rawExtensions)) {
          const elanous = (rawExtensions as Record<string, unknown>)['ai.elanous'];
          if (elanous && typeof elanous === 'object' && !Array.isArray(elanous) &&
            (elanous as Record<string, unknown>).researchDraft === true) {
            fail('io', 'research draft only: implement and validate graph steps before installation');
          }
        }
      }
    }
    const manifest: PluginManifest = loadPluginManifestFromDir(join(stage, 'package'), { id: source.expectedName ?? basename(spec) }).manifest;
    if (!NAME.test(manifest.id) || !VERSION.test(manifest.version)) fail('io', 'invalid plugin name or version');
    if (source.expectedName && (manifest.id !== source.expectedName || manifest.version !== source.expectedVersion)) fail('conflict', 'market name or version differs from manifest');
    if (rootMarketName) context.selected.set(manifest.id, { version: manifest.version, market: source.market });
    // [wiring] installPlugin is the caller: the PluginManifest normalized above by
    // loadPluginManifestFromDir (present manifest or the loader's manifest-absent
    // fallback) is handed into the install path here, past the NAME/VERSION gates.
    const destination = pluginInstallPath(root, source.market, manifest);
    const packageRoot = join(stage, 'package');
    const mainPath = inside(packageRoot, manifest.main);
    // A skills/graphs-only pack (official `elanous-basics`) declares no `main` — the default `./plugin.ts` is not a promise.
    // …but only a pack that ships something to install (skills or graphs) may omit it.
    const shipsAssets = hasSkill(join(packageRoot, 'skills')) || (manifest.contributes.graphs?.length ?? 0) > 0;
    if (existsSync(mainPath) || declaresMain(packageRoot) || !shipsAssets) {
      if (!existsSync(mainPath) || !realpathSync(mainPath).startsWith(`${realpathSync(packageRoot)}${sep}`)) fail('io', `plugin main not found or unsafe: ${manifest.main}`);
    }
    const name = manifest.id;
    const version = manifest.version;
    if (context.stack.includes(name)) fail('conflict', `plugin dependency cycle: ${[...context.stack, name].join(' -> ')}`);
    context.stack.push(name);
    stackPushed = true;
    for (const asset of [...(manifest.contributes.graphs ?? []), ...(manifest.contributes.vocab ?? [])]) {
      const path = inside(packageRoot, asset);
      if (!existsSync(path) || !realpathSync(path).startsWith(`${realpathSync(packageRoot)}${sep}`)) fail('io', `plugin asset not found or unsafe: ${asset}`);
    }
    const emit = (event: InstallEvent) => opts.onEvent?.(event);
    emit({ event: 'resolve', plugin: name, version, sha256: source.sha256 });
    let security: ReturnType<typeof inspectPluginSecurity>;
    try { security = inspectPluginSecurity(packageRoot); }
    catch { fail('scan', 'plugin static security scan failed'); }
    emit({ event: 'verify', signature: source.signature, scan: security.scan });
    const capabilities = manifest.capabilities.map(capability => capability.kind);
    if (manifest.dependencies?.runtime?.length && !bundledSource) {
      // uv may run project build hooks. A signature authenticates the artifact,
      // but a separate explicit approval is needed before executing its code.
      if (source.signature !== 'ok' || !await opts.consent?.(['runtime:uv-python'])) {
        fail('consent-denied', `runtime preparation requires signed plugin and explicit approval: ${manifest.id}`);
      }
    }
    const required = capabilities.length > 0;
    const preConsent = decidePluginInstallation(security, capabilities, false);
    const bundledHostImports = bundledAbsorb && knownAbsorbHostImports(packageRoot, security);
    if (!preConsent.ok && preConsent.reason === 'scan' && !bundledHostImports) fail('scan', 'plugin static security scan rejected package');
    emit({ event: 'consent', capabilities, required });
    const consented = !required || !!(opts.yes || await opts.consent?.(capabilities));
    if (!consented) fail('consent-denied', 'plugin capabilities require consent');
    const decision = decidePluginInstallation(security, capabilities, consented);
    if (!decision.ok && !(decision.reason === 'scan' && bundledHostImports)) fail(decision.reason, decision.reason === 'scan'
      ? 'plugin static security scan rejected package' : 'plugin capabilities require consent');
    await ensureDeclaredPluginDependencies(manifest, source.market, root, opts, context,
      isMarketSpec ? undefined : resolve(opts.cwd ?? process.cwd(), spec));
    assertDeclaredPluginDependencies(manifest, root);
    const packs = await stageRequiredKnowledgePacks(manifest.requires?.knowledgePacks ?? [], source.market, stage, root, opts);
    emit({ event: 'credentials', connectors: (manifest.contributes.connectors ?? []).map(connector => ({
      id: connector.id, fields: (connector.fields ?? connector.userConfig?.map(field => ({ name: field.key, secret: field.secret })) ?? [])
        .map(field => ({ name: field.name, secret: field.secret === true })),
    })) });
    const kinds = manifest.contributes.vocab ?? [];
    const graphs = manifest.contributes.graphs ?? [];
    const skills = manifest.contributes.skills === undefined
      ? existsSync(join(packageRoot, 'skills'))
        ? readdirSync(join(packageRoot, 'skills'), { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')
            && existsSync(join(packageRoot, 'skills', entry.name, 'SKILL.md')))
          .map(entry => entry.name).sort()
        : []
      : manifest.contributes.skills.map(skill => skill.name ?? skill.id ?? '').filter(Boolean);
    const { nodes, nodeErrors } = inspectPluginNodes(packageRoot, manifest);
    emit({ event: 'registered', kinds, nodes, nodeErrors, graphs, skills });
    const installed = withLedgerLock(root, () => {
      // Recheck under the ledger lock: another installer/remover may have changed dependencies after staging.
      assertDeclaredPluginDependencies(manifest, root);
      assertInstallParents(root, destination);
      if (existsSync(destination)) {
        if (isRootRequest) throw new RootAlreadyInstalled(name, version);
        fail('conflict', `plugin already installed: ${name}@${version}`);
      }
      for (const pack of packs) {
        assertInstallParents(root, pack.destination);
        if (packPathExists(pack.destination) && !samePackTree(pack.destination, pack.staged)) {
          fail('conflict', `installed knowledge pack differs from verified artifact: ${pack.name}`);
        }
      }
      const moved: string[] = [];
      try {
        for (const pack of packs) {
          assertInstallParents(root, pack.destination);
          if (packPathExists(pack.destination)) continue;
          mkdirSync(dirname(pack.destination), { recursive: true });
          assertInstallParents(root, pack.destination);
          renameSync(pack.staged, pack.destination);
          moved.push(pack.destination);
        }
        mkdirSync(dirname(destination), { recursive: true });
        assertInstallParents(root, destination);
        renameSync(join(stage, 'package'), destination);
        moved.push(destination);
        const item = { name, version, market: source.market, path: destination, sha256: source.sha256,
          installedAt: new Date().toISOString(), ...(context.bundleId ? { installBundleId: context.bundleId } : {}) };
        let installedSecurity: ReturnType<typeof inspectPluginSecurity>;
        try { installedSecurity = inspectPluginSecurity(destination); }
        catch { fail('scan', 'plugin package integrity verification failed'); }
        if (installedSecurity.integrity !== security.integrity ||
          (installedSecurity.scan === 'dangerous' && !bundledHostImports)) {
          fail('scan', 'plugin package integrity changed during installation');
        }
        prepareDeclaredRuntime(manifest, destination, opts, bundledSource);
        const movedPackIdentities = packs.filter(pack => moved.includes(pack.destination)).map(pack => {
          const identity = lstatSync(pack.destination);
          return { path: pack.destination, dev: identity.dev, ino: identity.ino };
        });
        writeLedger(root, [...listInstalledPlugins(root), item]);
        context.createdPacks.push(...movedPackIdentities);
        return item;
      } catch (error) {
        for (const path of moved.reverse()) {
          assertInstallParents(root, path);
          rmSync(path, { recursive: true, force: true });
        }
        throw error;
      }
    });
    // The install is committed above; a listener that throws must not turn a finished install into a failure
    // (the ledger would say «installed» while the caller saw «io», and a retry would hit «conflict»).
    try { emit({ event: 'done', plugin: name, version, path: destination }); } catch { /* listener failure only */ }
    context.created.push(installed);
    return installed;
  } catch (error) {
    if (error instanceof PluginInstallError || error instanceof DependencyReplan) throw error;
    throw new PluginInstallError('io', error instanceof Error ? error.message : String(error));
  } finally {
    if (stackPushed) context.stack.pop();
    rmSync(stage, { recursive: true, force: true });
  }
}

type Flock = (fd: number, operation: number) => number;
let flockSymbol: Flock | null | undefined;
/** flock(2) via FFI on macOS/Linux, loaded on first use — importing this module must not open libc
 *  (Windows has neither library, and a top-level dlopen would break every command that imports the installer). */
function ledgerFlock(): Flock | null {
  if (flockSymbol !== undefined) return flockSymbol;
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
  try {
    flockSymbol = library ? dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock as Flock : null;
  } catch {
    flockSymbol = null;
  }
  return flockSymbol;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Serializes ledger updates. flock where available (the kernel drops it when the holder dies); otherwise a lock
 *  directory holding the owner pid, taken over when that pid is gone. */
export function withLedgerLock<T>(root: string, update: () => T, flock: Flock | null = ledgerFlock()): T {
  const base = join(root, 'plugins');
  mkdirSync(base, { recursive: true });
  const deadline = Date.now() + 10_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  if (flock) {
    // Keep the inode in place: unlinking a locked file lets a second process lock a new inode.
    const fd = openSync(join(base, '.installed.lock'), 'a');
    let acquired = false;
    try {
      while (flock(fd, 2 | 4) !== 0) {
        if (Date.now() >= deadline) fail('io', 'timed out waiting for plugin ledger lock');
        Atomics.wait(pause, 0, 0, 10);
      }
      acquired = true;
      return update();
    } finally {
      if (acquired) flock(fd, 8);
      closeSync(fd);
    }
  }
  const dir = join(base, '.installed.lock.d');
  const owner = join(dir, 'pid');
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(owner, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(existsSync(owner) ? readFileSync(owner, 'utf8').trim() : NaN);
      if (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) { rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) fail('io', 'timed out waiting for plugin ledger lock');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try {
    return update();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLedger(root: string, entries: InstalledPlugin[]): void {
  const ledger = join(root, 'plugins', 'installed.json');
  const unique = new Map(entries.map(entry => [`${entry.market}/${entry.name}/${entry.version}`, entry]));
  const temp = `${ledger}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify([...unique.values()].map(({ name, version, market, sha256, installedAt, installBundleId }) =>
      ({ name, version, market, sha256, ...(installedAt === undefined ? {} : { installedAt }),
        ...(installBundleId === undefined ? {} : { installBundleId }) })), null, 2));
    renameSync(temp, ledger);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function listInstalledPlugins(root = elanousStateRoot()): InstalledPlugin[] {
  const base = join(root, 'plugins');
  if (!existsSync(base)) return [];
  const result: InstalledPlugin[] = [];
  let ledger: Array<Pick<InstalledPlugin, 'name' | 'version' | 'market' | 'sha256' | 'installedAt' | 'installBundleId'>> = [];
  try {
    ledger = JSON.parse(readFileSync(join(base, 'installed.json'), 'utf8'));
    if (!Array.isArray(ledger)) ledger = [];
  } catch { /* no ledger yet */ }
  for (const market of readdirSync(base, { withFileTypes: true })) {
    if (!market.isDirectory() || market.name === '.staging' || !NAME.test(market.name)) continue;
    for (const name of readdirSync(join(base, market.name), { withFileTypes: true })) {
      if (!name.isDirectory() || !NAME.test(name.name)) continue;
      for (const version of readdirSync(join(base, market.name, name.name), { withFileTypes: true })) {
        if (!version.isDirectory() || !VERSION.test(version.name)) continue;
        const path = join(base, market.name, name.name, version.name);
        try {
          const loaded = loadPluginManifestFromDir(path, { id: name.name, version: version.name, allowClaudeManifest: true });
          const isClaudeManifest = loaded.path === join(path, '.claude-plugin', 'plugin.json');
          const manifest = loaded.manifest;
          if (manifest.id === name.name && manifest.version === version.name && (!isClaudeManifest || manifest.name === name.name)) {
            const recorded = ledger.find(entry => entry.name === name.name && entry.version === version.name && entry.market === market.name);
            result.push({ name: name.name, version: version.name, market: market.name, path,
              sha256: recorded?.sha256 ?? null,
              ...(typeof recorded?.installedAt === 'string' ? { installedAt: recorded.installedAt } : {}),
              ...(typeof recorded?.installBundleId === 'string' ? { installBundleId: recorded.installBundleId } : {}) });
          }
        } catch { /* malformed packages are not installed plugins */ }
      }
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.market.localeCompare(b.market) || a.version.localeCompare(b.version));
}

export function removePlugin(name: string, root = elanousStateRoot()): number {
  if (!NAME.test(name)) fail('io', `invalid plugin name: ${name}`);
  return withLedgerLock(root, () => {
    const installed = listInstalledPlugins(root);
    const entries = installed.filter(item => item.name === name);
    if (!entries.length) return 0;
    for (const dependent of installed.filter(item => item.name !== name)) {
      const manifest = loadPluginManifestFromDir(dependent.path, { id: dependent.name, version: dependent.version }).manifest;
      if ((manifest.dependencies?.plugins ?? []).some(item => {
        const ref = parseDeclaredPluginRef(item);
        return !ref.optional && ref.id === name;
      })) fail('conflict', `plugin ${name} is required by installed plugin ${dependent.name}@${dependent.version}`);
    }
    const staging = join(root, 'plugins', '.staging');
    mkdirSync(staging, { recursive: true });
    const quarantine = mkdtempSync(join(staging, 'remove-'));
    const moved: Array<{ original: string; temporary: string }> = [];
    try {
      for (const [index, entry] of entries.entries()) {
        const temporary = join(quarantine, String(index));
        renameSync(entry.path, temporary);
        moved.push({ original: entry.path, temporary });
      }
      writeLedger(root, listInstalledPlugins(root));
    } catch (error) {
      try {
        for (const entry of moved.reverse()) renameSync(entry.temporary, entry.original);
      } catch (rollbackError) {
        fail('io', `plugin removal rollback failed; packages remain at ${quarantine}: ${String(rollbackError)}`);
      }
      throw error;
    }
    rmSync(quarantine, { recursive: true, force: true });
    return entries.length;
  });
}
