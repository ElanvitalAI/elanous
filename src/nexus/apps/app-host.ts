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
import { createAppAuth, type AppAuthOptions, type IssuedAppInvitation } from './app-auth.js';
import { createAppDatabase, type AppDatabase } from './app-db.js';

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
  handle(req: Request): Response | undefined | Promise<Response | undefined>;
  /** Trusted server-side invitation issuance. Public app-host requests cannot call this operation. */
  issueInvitation(appSlug: string, invitedBy: string, ttlMs?: number, role?: string): IssuedAppInvitation;
  readonly slugs: readonly string[];
  /** Parsed, validated manifest snapshot for app-scoped route registration. */
  getManifest(appSlug: string): AppManifest | undefined;
  close(): void;
}

export type NexusAppHostAuthOptions = Pick<AppAuthOptions, 'dir' | 'key' | 'now' | 'invitationTtlMs' | 'sessionTtlMs'> & { readonly databaseDirectory?: string };

interface MountedApp {
  readonly slug: string;
  readonly manifest: AppManifest;
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

async function readJsonBody(req: Request, limit: number): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly tooLarge: boolean }> {
  if (!req.body) return { ok: false, tooLarge: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(part.value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')) };
  } catch { return { ok: false, tooLarge: false }; }
}

function sameRequestOrigin(req: Request, hostname: string): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    const supplied = new URL(origin);
    const request = new URL(req.url);
    return supplied.origin === origin && supplied.origin === `${request.protocol}//${requestAuthority(req, hostname)}`;
  } catch { return false; }
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
  return { slug: manifest.slug, files, manifest };
}

function normalizeRequestPath(pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const pieces = decoded.split('/').filter(Boolean);
  if (pieces.some(piece => piece === '.' || piece === '..')) return undefined;
  return pieces.join('/') || 'index.html';
}

function createNexusAppHost(mounts: ReadonlyMap<string, MountedApp>, authBySlug: ReadonlyMap<string, ReturnType<typeof createAppAuth>>, appDb?: AppDatabase): NexusAppHost {
  return {
    slugs: [...mounts.keys()],
    getManifest(appSlug) { return mounts.get(appSlug)?.manifest; },
    close() { appDb?.close(); },
    issueInvitation(appSlug, invitedBy, ttlMs, role) {
      const auth = authBySlug.get(appSlug);
      const mounted = mounts.get(appSlug);
      if (!mounted || !auth) throw new Error('app is not mounted or app authentication is unavailable');
      const roles = mounted.manifest.roles as Record<string, unknown> | undefined;
      const hasDbContract = Object.hasOwn(mounted.manifest, 'tables') || Object.hasOwn(mounted.manifest, 'rpc');
      // Old static-only manifests may have no viewer role declaration. Keep their invitation flow;
      // the fallback role has no RPC authority unless a declaration explicitly grants it.
      const effectiveRole = role ?? 'viewer';
      const roleDeclaration = roles?.[effectiveRole];
      if (role !== undefined && (!roles || !Object.hasOwn(roles, role))) throw new Error('app role is not declared');
      if (role === undefined && hasDbContract && (!roles || !Object.hasOwn(roles, effectiveRole))) throw new Error('app role is not declared');
      if (roles && Object.hasOwn(roles, effectiveRole)) {
        const via = typeof roleDeclaration === 'object' && roleDeclaration !== null && !Array.isArray(roleDeclaration)
          ? (roleDeclaration as Record<string, unknown>).via : undefined;
        if (via !== 'share-link') throw new Error('app role is not available through a share-link invitation');
      }
      return auth.issueInvitation({ appSlug, invitedBy, role: effectiveRole, ...(ttlMs !== undefined ? { ttlMs } : {}) });
    },
    handle(req) {
      const hostname = requestHostname(req);
      if (!hostname?.endsWith(APP_HOST_SUFFIX)) return undefined;
      const slug = hostname.slice(0, -APP_HOST_SUFFIX.length);
      const mounted = mounts.get(slug);
      if (!mounted) return notFound();
      const auth = authBySlug.get(slug);
      if (!auth) return new Response('App authentication unavailable', { status: 503 });
      const url = new URL(req.url);
      if (url.pathname === '/__auth/accept') {
        if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
        const token = url.searchParams.get('token') ?? '';
        const accepted = auth.acceptInvitation({ appSlug: slug, token });
        if (accepted.status !== 200 || !accepted.cookie) return new Response('Unauthorized', { status: 401 });
        return new Response(null, { status: 303, headers: {
          location: '/', 'set-cookie': accepted.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        } });
      }
      const rpcMatch = /^\/__rpc\/([a-zA-Z][a-zA-Z0-9_-]{0,63})$/.exec(url.pathname);
      if (rpcMatch) {
        return (async () => {
        if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method-not-allowed' }), { status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } });
        if (!sameRequestOrigin(req, hostname)) return new Response(JSON.stringify({ error: 'origin-not-allowed' }), { status: 403, headers: { 'content-type': 'application/json' } });
        if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') ?? '')) return new Response(JSON.stringify({ error: 'json-required' }), { status: 415, headers: { 'content-type': 'application/json' } });
        const sessionCookie = req.headers.get('cookie') ?? '';
        let session = auth.getSessionRecord(sessionCookie);
        if (!session || session.appSlug !== slug) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
        if (!appDb) return new Response(JSON.stringify({ error: 'app-db-not-wired' }), { status: 503, headers: { 'content-type': 'application/json' } });
        const contentLength = req.headers.get('content-length');
        if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > 64 * 1024) return new Response(JSON.stringify({ error: 'request-too-large' }), { status: 413, headers: { 'content-type': 'application/json' } });
        const parsed = await readJsonBody(req, 64 * 1024);
        if (!parsed.ok) return new Response(JSON.stringify({ error: parsed.tooLarge ? 'request-too-large' : 'invalid-json' }), { status: parsed.tooLarge ? 413 : 400, headers: { 'content-type': 'application/json' } });
        const input = parsed.value;
        const rpcInput = input as { params?: unknown };
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => key !== 'params')
          || (Object.hasOwn(input, 'params') && (!rpcInput.params || typeof rpcInput.params !== 'object' || Array.isArray(rpcInput.params)))) {
          return new Response(JSON.stringify({ error: 'invalid-rpc-request' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        try {
          // The request body may have taken long enough for the session to expire or be revoked.
          session = auth.getSessionRecord(sessionCookie);
          if (!session || session.appSlug !== slug) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
          const roles = mounted.manifest.roles as Record<string, unknown> | undefined;
          if (roles && !Object.hasOwn(roles, session.role)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
          const rows = appDb.rpc(slug, rpcMatch[1]!, (rpcInput.params ?? {}) as Record<string, unknown>, session.role);
          return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' } });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const status = message === 'app role is not allowed' ? 403 : message.startsWith('rpc not found:') ? 404 : 400;
          return new Response(JSON.stringify({ error: status === 403 ? 'forbidden' : status === 404 ? 'rpc-not-found' : 'invalid-rpc-request' }), { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
        }
        })();
      }
      if (auth.verifySession({ appSlug: slug, token: req.headers.get('cookie') ?? '' }).status !== 200) {
        return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      const pathname = normalizeRequestPath(url.pathname);
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
  authOptions?: NexusAppHostAuthOptions,
): { appHost: NexusAppHost; issues: readonly NexusAppHostIssue[] } {
  const mounts = new Map<string, MountedApp>();
  const authBySlug = new Map<string, ReturnType<typeof createAppAuth>>();
  const issues: NexusAppHostIssue[] = [];
  if (!existsSync(appsDir)) return { appHost: createNexusAppHost(mounts, authBySlug), issues };

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
      if (authOptions) {
        authBySlug.set(mounted.slug, createAppAuth({ ...authOptions, dir: join(authOptions.dir ?? join(appsRoot, '..', 'app-session-tokens'), mounted.slug) }));
      }
    } catch (error) {
      issues.push({ appDir: basename(appDir), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  stableDirectory(appsRoot, appsRoot, rootIdentity);
  let appDb: AppDatabase | undefined;
  if (authOptions && mounts.size > 0) {
    const databases = new Map<string, AppDatabase>();
    for (const [slug, mounted] of mounts) {
      const hasDbContract = Object.hasOwn(mounted.manifest, 'tables') || Object.hasOwn(mounted.manifest, 'rpc');
      if (!hasDbContract) continue;
      try {
        databases.set(slug, createAppDatabase([mounted.manifest], authOptions.databaseDirectory ? { directory: authOptions.databaseDirectory } : {}));
      } catch (error) {
        issues.push({ appDir: slug, reason: error instanceof Error ? error.message : String(error) });
        mounts.delete(slug);
        authBySlug.delete(slug);
      }
    }
    if (databases.size > 0) {
      appDb = {
        rpc(slug, name, params, role) {
          const database = databases.get(slug);
          if (!database) throw new Error(`app not found: ${slug}`);
          return database.rpc(slug, name, params, role);
        },
        close() { for (const database of databases.values()) database.close(); databases.clear(); },
      };
    }
  }
  return { appHost: createNexusAppHost(mounts, authBySlug, appDb), issues };
}
