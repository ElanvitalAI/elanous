import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { loadPluginManifestFromDir, type PluginManifest } from '../core/manifest.js';
import { loadPluginNodes } from '../../graph-kinds/plugin-nodes.js';
import { getNodeKindRegistration, listNodeKinds, unregisterPluginNodeKind } from '../../graph-kinds/registry.js';
import { verifyIndex, type MarketplaceIndex, type VerifyIndexResult } from '../../market/signed-index.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { ensureMarketIndex, MarketFetchError, type MarketFetchOptions } from './market-fetch.js';

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/;
const SHA = /^[a-fA-F0-9]{40}$/;
const HASH = /^[a-fA-F0-9]{64}$/;

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
}

export interface InstallOptions {
  root?: string;
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
}

export class PluginInstallError extends Error {
  constructor(public readonly reason: 'signature' | 'scan' | 'consent-denied' | 'credentials' | 'conflict' | 'io', message: string) {
    super(message);
    this.name = 'PluginInstallError';
  }
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

function copyPlugin(source: string, destination: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail('io', `plugin directory not found: ${source}`);
  safeTree(source);
  cpSync(source, destination, { recursive: true, filter: path => basename(path) !== '.git' });
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
  const matches = index.plugins.filter(plugin => plugin && plugin.name === name);
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
    if (error instanceof MarketFetchError && /^market not configured: /.test(error.message) && hasLocalMarketIndex(marketName, opts)) {
      return localMarketSource(spec, target, opts);
    }
    if (error instanceof MarketFetchError) throw new PluginInstallError(error.reason, error.message);
    throw error;
  }
  const matches = marketIndex.index.plugins.filter(entry => entry.name === name);
  if (matches.length !== 1) fail('io', `plugin not found or ambiguous in ${marketName}: ${name}`);
  const entry = matches[0]!;
  const artifact = entry.artifact;
  if (!artifact || typeof artifact.key !== 'string' || !artifact.key || !HASH.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) fail('io', 'invalid artifact key, hash or size');
  // Check the key as written, before URL resolution folds `..`/`.` or percent-encoded separators away.
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(artifact.key) || artifact.key.split('/').some(part => part === '.' || part === '..')) fail('io', 'unsafe artifact key');
  const base = new URL(marketIndex.market.url);
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
  return { market: marketName, sha256: artifact.sha256, signature: marketIndex.signature, expectedName: name, expectedVersion: entry.version };
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

export async function installPlugin(spec: string, opts: InstallOptions = {}): Promise<InstalledPlugin> {
  const root = resolve(opts.root ?? elanousStateRoot());
  const stageRoot = join(root, 'plugins', '.staging');
  mkdirSync(stageRoot, { recursive: true });
  const stage = mkdtempSync(join(stageRoot, 'plugin-'));
  try {
    const source = marketSpec(spec, opts)
      ? await fetchedMarketSource(spec, join(stage, 'package'), opts)
      : resolvePluginSource(spec, join(stage, 'package'), opts);
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
    for (const asset of [...(manifest.contributes.graphs ?? []), ...(manifest.contributes.vocab ?? [])]) {
      const path = inside(packageRoot, asset);
      if (!existsSync(path) || !realpathSync(path).startsWith(`${realpathSync(packageRoot)}${sep}`)) fail('io', `plugin asset not found or unsafe: ${asset}`);
    }
    const destination = join(root, 'plugins', source.market, name, version);
    const emit = (event: InstallEvent) => opts.onEvent?.(event);
    emit({ event: 'resolve', plugin: name, version, sha256: source.sha256 });
    emit({ event: 'verify', signature: source.signature, scan: 'safe' });
    const capabilities = manifest.capabilities.map(capability => capability.kind);
    const required = capabilities.length > 0;
    emit({ event: 'consent', capabilities, required });
    if (required && !(opts.yes || await opts.consent?.(capabilities))) fail('consent-denied', 'plugin capabilities require consent');
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
      if (existsSync(destination)) fail('conflict', `plugin already installed: ${name}@${version}`);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(join(stage, 'package'), destination);
      const item = { name, version, market: source.market, path: destination, sha256: source.sha256, installedAt: new Date().toISOString() };
      try {
        writeLedger(root, [...listInstalledPlugins(root), item]);
      } catch (error) {
        rmSync(destination, { recursive: true, force: true });
        throw error;
      }
      return item;
    });
    // The install is committed above; a listener that throws must not turn a finished install into a failure
    // (the ledger would say «installed» while the caller saw «io», and a retry would hit «conflict»).
    try { emit({ event: 'done', plugin: name, version, path: destination }); } catch { /* listener failure only */ }
    return installed;
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError('io', error instanceof Error ? error.message : String(error));
  } finally {
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
    writeFileSync(temp, JSON.stringify([...unique.values()].map(({ name, version, market, sha256, installedAt }) =>
      ({ name, version, market, sha256, ...(installedAt === undefined ? {} : { installedAt }) })), null, 2));
    renameSync(temp, ledger);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function listInstalledPlugins(root = elanousStateRoot()): InstalledPlugin[] {
  const base = join(root, 'plugins');
  if (!existsSync(base)) return [];
  const result: InstalledPlugin[] = [];
  let ledger: Array<Pick<InstalledPlugin, 'name' | 'version' | 'market' | 'sha256' | 'installedAt'>> = [];
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
          const manifest = loadPluginManifestFromDir(path, { id: name.name }).manifest;
          if (manifest.id === name.name && manifest.version === version.name) {
            const recorded = ledger.find(entry => entry.name === name.name && entry.version === version.name && entry.market === market.name);
            result.push({ name: name.name, version: version.name, market: market.name, path,
              sha256: recorded?.sha256 ?? null,
              ...(typeof recorded?.installedAt === 'string' ? { installedAt: recorded.installedAt } : {}) });
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
    const entries = listInstalledPlugins(root).filter(item => item.name === name);
    if (!entries.length) return 0;
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
