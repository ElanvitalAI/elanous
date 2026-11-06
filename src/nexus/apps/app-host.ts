import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseAppManifest, type AppManifest } from './app-contract.js';

const APP_HOST_SUFFIX = '.app.localhost';
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface NexusAppHostIssue {
  readonly appDir: string;
  readonly reason: string;
}

export interface NexusAppHost {
  /** Reserves app-host origins before API routing, even when no app bundle mounted. */
  handle(req: Request): Response | undefined;
  readonly slugs: readonly string[];
  close(): void;
}

interface MountedApp {
  readonly slug: string;
  readonly files: ReadonlyMap<string, Buffer>;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly nlink: string;
}

/** Test seam for deterministic mount-time filesystem interleavings. */
export interface NexusAppHostFsSimulation {
  beforeOpen?(path: string, flags: number): void;
  openFile?(path: string, flags: number, openReal: () => number): number;
}

function requestHostname(req: Request): string | undefined {
  const authority = req.headers.get('host');
  if (!authority || /[\s/@\\]/.test(authority)) return undefined;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password) return undefined;
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function requestAuthority(req: Request, hostname: string): string {
  const authority = req.headers.get('host')!;
  const parsed = new URL(`http://${authority}`);
  return parsed.port ? `${hostname}:${parsed.port}` : hostname;
}

function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameIdentity(expected: FileIdentity, actual: BigIntStats): boolean {
  const identity = identityOf(actual);
  return expected.dev === identity.dev && expected.ino === identity.ino && expected.size === identity.size
    && expected.mtimeNs === identity.mtimeNs && expected.ctimeNs === identity.ctimeNs
    && expected.nlink === identity.nlink;
}

function identityOf(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), nlink: stat.nlink.toString(),
  };
}

function stableDirectory(root: string, path: string, expected?: FileIdentity): FileIdentity {
  const before = lstatSync(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('mount directory is not a real directory');
  const identity = identityOf(before);
  if (expected && !sameIdentity(expected, before)) throw new Error('mount directory changed during snapshot');
  const canonical = realpathSync(path);
  if (!isInside(root, canonical)) throw new Error('mount directory escapes app root');
  const after = lstatSync(path, { bigint: true });
  if (!sameIdentity(identity, after) || !after.isDirectory() || realpathSync(path) !== canonical) {
    throw new Error('mount directory changed during snapshot');
  }
  return identity;
}

function readSnapshotFile(
  root: string,
  path: string,
  simulation?: NexusAppHostFsSimulation,
  onIdentity?: (identity: FileIdentity) => void,
): Buffer {
  const beforePath = realpathSync(path);
  if (!isInside(root, beforePath)) throw new Error('app file escapes export root');
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('app files must be regular, non-linked files');
  }
  const identity = identityOf(before);
  onIdentity?.(identity);
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  simulation?.beforeOpen?.(path, openFlags);

  let fd: number | undefined;
  try {
    fd = simulation?.openFile
      ? simulation.openFile(path, openFlags, () => openSync(path, openFlags))
      : openSync(path, openFlags);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(identity, opened)) {
      throw new Error('app file changed between validation and open');
    }
    const contents = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity, after)) throw new Error('app file changed while snapshotting');
    const afterPath = realpathSync(path);
    const afterLstat = lstatSync(path, { bigint: true });
    if (afterPath !== beforePath || !sameIdentity(identity, afterLstat) || afterLstat.isSymbolicLink()) {
      throw new Error('app file path changed while snapshotting');
    }
    return contents;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function snapshotDirectory(
  root: string,
  directory: string,
  files: Map<string, Buffer>,
  identities: Map<string, FileIdentity>,
  relativeDir = '',
  simulation?: NexusAppHostFsSimulation,
): void {
  const identity = stableDirectory(root, directory);
  identities.set(relativeDir || '.', identity);
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) {
      throw new Error('invalid app asset path');
    }
    const path = join(directory, entry.name);
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed in app exports');
    if (stat.isDirectory()) {
      const childIdentity = stableDirectory(root, path, identityOf(stat));
      snapshotDirectory(root, path, files, identities, relativePath, simulation);
      stableDirectory(root, path, childIdentity);
      continue;
    }
    if (!stat.isFile()) throw new Error('app exports may only contain regular files and directories');
    const canonical = realpathSync(path);
    if (!isInside(root, canonical)) throw new Error('app file escapes export root');
    files.set(relativePath, readSnapshotFile(root, path, simulation, fileIdentity => identities.set(relativePath, fileIdentity)));
  }
  stableDirectory(root, directory, identity);
}

function verifySnapshot(
  root: string,
  directory: string,
  expected: ReadonlyMap<string, Buffer>,
  expectedIdentities: ReadonlyMap<string, FileIdentity>,
): void {
  const current = new Map<string, Buffer>();
  const currentIdentities = new Map<string, FileIdentity>();
  snapshotDirectory(root, directory, current, currentIdentities);
  if (current.size !== expected.size) throw new Error('app export changed during snapshot');
  for (const [path, contents] of expected) {
    if (!current.get(path)?.equals(contents)) throw new Error('app export changed during snapshot');
  }
  // Nanosecond ctime also catches a file changed and restored between the two scans.
  if (currentIdentities.size !== expectedIdentities.size) throw new Error('app export identity changed during snapshot');
  for (const [path, identity] of expectedIdentities) {
    const currentIdentity = currentIdentities.get(path);
    if (!currentIdentity || JSON.stringify(identity) !== JSON.stringify(currentIdentity)) {
      throw new Error('app export identity changed during snapshot');
    }
  }
}

function mountApp(appsRoot: string, entryName: string, simulation?: NexusAppHostFsSimulation): MountedApp {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entryName) || entryName.includes('--')) {
    throw new Error('app directory name is not a safe slug');
  }
  const appPath = join(appsRoot, entryName);
  const appIdentity = stableDirectory(appsRoot, appPath);
  const appRoot = realpathSync(appPath);
  if (!isInside(appsRoot, appRoot)) throw new Error('app root escapes apps directory');
  stableDirectory(appsRoot, appPath, appIdentity);
  const manifestPath = join(appRoot, 'app.yaml');
  const parsed = parseAppManifest(readSnapshotFile(appRoot, manifestPath, simulation).toString('utf8'));
  if (!parsed.ok) throw new Error(`app.yaml rejected: ${parsed.errors.map(issue => `${issue.path} ${issue.reason}`).join('; ')}`);

  const manifest = parsed.manifest as AppManifest & { frontend?: { kind?: unknown; out?: unknown } };
  if (manifest.slug !== entryName) throw new Error('directory name must match app.yaml slug');
  if (manifest.frontend?.kind !== 'static-export') throw new Error('frontend.kind must be static-export');
  const out = typeof manifest.frontend.out === 'string' ? manifest.frontend.out : 'out';
  if (!out || isAbsolute(out) || out.includes('\\') || out.includes('\0')) throw new Error('frontend.out must be app-relative');
  const outputPath = resolve(appRoot, out);
  if (!isInside(appRoot, outputPath) || outputPath === appRoot) throw new Error('frontend.out escapes the app directory');
  const outputRoot = realpathSync(outputPath);
  if (!isInside(appRoot, outputRoot) || !statSync(outputRoot).isDirectory()) throw new Error('frontend.out must be an in-app directory');
  const files = new Map<string, Buffer>();
  const identities = new Map<string, FileIdentity>();
  snapshotDirectory(outputRoot, outputRoot, files, identities, '', simulation);
  if (!files.has('index.html')) throw new Error('frontend.out has no index.html');
  verifySnapshot(outputRoot, outputRoot, files, identities);
  stableDirectory(appsRoot, appPath, appIdentity);
  return { slug: manifest.slug, files };
}

function normalizeRequestPath(pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const pieces = decoded.split('/').filter(Boolean);
  if (pieces.some(piece => piece === '.' || piece === '..')) return undefined;
  return pieces.join('/') || 'index.html';
}

function createNexusAppHost(mounts: ReadonlyMap<string, MountedApp>): NexusAppHost {
  return {
    slugs: [...mounts.keys()],
    close() {},
    handle(req) {
      const hostname = requestHostname(req);
      if (!hostname?.endsWith(APP_HOST_SUFFIX)) return undefined;
      const slug = hostname.slice(0, -APP_HOST_SUFFIX.length);
      const mounted = mounts.get(slug);
      if (!mounted) return notFound();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const pathname = normalizeRequestPath(new URL(req.url).pathname);
      if (!pathname) return notFound();
      const filePath = mounted.files.has(pathname) ? pathname : `${pathname.replace(/\/$/, '')}/index.html`;
      const body = mounted.files.get(filePath);
      if (!body) return notFound();
      const headers = new Headers({
        'content-type': MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-nexus-app-host': hostname,
        'x-nexus-app-origin': `http://${requestAuthority(req, hostname)}`,
      });
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
    },
  };
}

/**
 * App bundles are read into an immutable in-memory snapshot while mounting. The synchronous
 * traversal serializes mounts on this JavaScript event loop; identity and realpath checks reject
 * swaps during traversal, and request handling never reopens mutable filesystem paths. The lock
 * does not coordinate an external process; a final content pass rejects observed in-place updates.
 */
export function loadNexusAppHost(
  appsDir: string,
  simulation?: NexusAppHostFsSimulation,
): { appHost: NexusAppHost; issues: readonly NexusAppHostIssue[] } {
  const mounts = new Map<string, MountedApp>();
  const issues: NexusAppHostIssue[] = [];
  if (!existsSync(appsDir)) return { appHost: createNexusAppHost(mounts), issues };

  const appsRoot = realpathSync(appsDir);
  const rootIdentity = stableDirectory(appsRoot, appsRoot);
  const entries = readdirSync(appsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const appDir = join(appsRoot, entry.name);
    if (!existsSync(join(appDir, 'app.yaml'))) continue;
    try {
      const mounted = mountApp(appsRoot, entry.name, simulation);
      if (mounts.has(mounted.slug)) throw new Error('duplicate app slug');
      mounts.set(mounted.slug, mounted);
    } catch (error) {
      issues.push({ appDir: basename(appDir), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  stableDirectory(appsRoot, appsRoot, rootIdentity);
  return { appHost: createNexusAppHost(mounts), issues };
}
