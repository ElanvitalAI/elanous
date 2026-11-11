import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import iconv from 'iconv-lite';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { createAppAuth, type AppAuthOptions, type IssuedAppInvitation } from './app-auth.js';
import { detectDeclaredHtmlCharset, MADE_WITH_BADGE_ENTITLEMENT } from './made-with-badge.js';
import { applyConceptProofBadge, type SimReceipt } from '../../ux-sim/sim-receipt.js';
import { createAppDatabase, type AppDatabase } from './app-db.js';
import type { NexusEventBus } from '../api/event-bus.js';
import type { AppDbBackupOptions, AppDbBackupStatus } from './app-db-backup.js';
import { emitNexusFunnelEvent, type NexusFunnelRuntime } from './funnel-observe.js';
import type { MemberStore } from '../members/member-store.js';
import { parsePublicAppHost, resolvePublicAppUserId } from '../../relay/relay-server.js';

export interface VerifiedAppOwner {
  readonly memberId: string;
  readonly userSlug: string;
  readonly plan: string;
  readonly entitlements: Readonly<Record<string, unknown>>;
}

/** Shared server accessor for PWA/TUI callers; authentication stays inside the booted host. */
export function resolveVerifiedOwner(
  appHost: NexusAppHost,
  appSlug: string,
  sessionCredential: string,
  members: Pick<MemberStore, 'memberPlanForMember'>,
  configuredPublicUserId?: string,
): VerifiedAppOwner | null {
  return appHost.resolveVerifiedOwner(appSlug, sessionCredential, members, configuredPublicUserId);
}

/** Resolves a member owner from an app session without trusting a caller supplied app slug. */
export function resolveVerifiedMemberOwner(
  appHost: NexusAppHost,
  sessionCredential: string,
  members: Pick<MemberStore, 'memberPlanForMember'>,
  configuredPublicUserId?: string,
): VerifiedAppOwner | null {
  return appHost.resolveVerifiedMemberOwner(sessionCredential, members, configuredPublicUserId);
}

const APP_HOST_SUFFIX = '.app.localhost';
const PUBLIC_APP_DOMAIN = 'elanous.app';
const APP_HOST_STATE_DIR = '.elanous-app-host-state';
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
  /** Trusted server-side Google-member owner session issuance; never exposed as a public app-host route. */
  issueOwnerSession(appSlug: string, memberId: string): { sessionToken: string; expiresAt: string };
  /** Validates a host-bound owner cookie/Bearer, then joins the member plan from the private member DB. */
  resolveVerifiedOwner(appSlug: string, sessionCredential: string, members: Pick<MemberStore, 'memberPlanForMember'>, configuredPublicUserId?: string): VerifiedAppOwner | null;
  /** Validates an owner app session by its server-verified token claim, without an appSlug input. */
  resolveVerifiedMemberOwner(sessionCredential: string, members: Pick<MemberStore, 'memberPlanForMember'>, configuredPublicUserId?: string): VerifiedAppOwner | null;
  readonly slugs: readonly string[];
  /** Parsed, validated manifest snapshot for app-scoped route registration. */
  getManifest(appSlug: string): AppManifest | undefined;
  /** Trusted server-side backup health and isolated restore controls; app requests cannot call these. */
  databaseBackupStatus(appSlug: string): AppDbBackupStatus | null;
  restoreDatabaseBackup(appSlug: string, targetPath: string): ReturnType<NonNullable<AppDatabase['restoreBackup']>>;
  /** Mounts one already-built app directory into the current host after validating its immutable snapshot. */
  mountDirectory(appSlug: string, entitlements?: Readonly<Record<string, unknown>>): void;
  /** Removes one dynamically mounted app after a failed publication attempt. */
  unmountDirectory(appSlug: string): void;
  /** Connects the durable simulation proof used for the served attribution badge. */
  setConceptProofResolver(resolver: (appSlug: string) => SimReceipt | undefined): void;
  close(): void;
}

export type NexusAppHostAuthOptions = Pick<AppAuthOptions, 'dir' | 'key' | 'now' | 'invitationTtlMs' | 'sessionTtlMs' | 'funnel'> & {
  readonly databaseDirectory?: string;
  readonly eventBus?: Pick<NexusEventBus, 'publishAppRowChange'>;
  readonly databaseBackup?: Omit<AppDbBackupOptions, 'appSlug' | 'databasePath' | 'database'>;
};

interface MountedApp {
  readonly slug: string;
  readonly manifest: AppManifest;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly entitlements?: Readonly<Record<string, unknown>>;
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

function createNexusAppHost(
  mounts: ReadonlyMap<string, MountedApp>,
  authBySlug: ReadonlyMap<string, ReturnType<typeof createAppAuth>>,
  appDb?: AppDatabase,
  funnel?: NexusFunnelRuntime,
  mountDirectory?: (appSlug: string, entitlements?: Readonly<Record<string, unknown>>) => void,
  unmountDirectory?: (appSlug: string) => void,
  publicUserSlug?: string,
): NexusAppHost {
  let conceptProofResolver: ((appSlug: string) => SimReceipt | undefined) | undefined;
  const decorateHtml = (appSlug: string, html: string, mounted: MountedApp): string =>
    applyConceptProofBadge(html, conceptProofResolver?.(appSlug), mounted.entitlements);
  return {
    get slugs() { return [...mounts.keys()]; },
    getManifest(appSlug) { return mounts.get(appSlug)?.manifest; },
    databaseBackupStatus(appSlug) { return appDb?.backupStatus?.(appSlug) ?? null; },
    restoreDatabaseBackup(appSlug, targetPath) {
      if (!appDb?.restoreBackup) throw new Error('app database backup is not configured');
      return appDb.restoreBackup(appSlug, targetPath);
    },
    mountDirectory(appSlug, entitlements) {
      if (!mountDirectory) throw new Error('dynamic app mounting is unavailable');
      mountDirectory(appSlug, entitlements ?? {});
    },
    unmountDirectory(appSlug) {
      if (!unmountDirectory) throw new Error('dynamic app unmounting is unavailable');
      unmountDirectory(appSlug);
    },
    setConceptProofResolver(resolver) { conceptProofResolver = resolver; },
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
    issueOwnerSession(appSlug, memberId) {
      const auth = authBySlug.get(appSlug);
      const mounted = mounts.get(appSlug);
      if (!mounted || !auth) throw new Error('app is not mounted or app authentication is unavailable');
      const roles = mounted.manifest.roles as Record<string, unknown> | undefined;
      const ownerRole = roles?.owner;
      const via = typeof ownerRole === 'object' && ownerRole !== null && !Array.isArray(ownerRole)
        ? (ownerRole as Record<string, unknown>).via : undefined;
      if (via !== 'nexus-session') throw new Error('owner role is not available through a member session');
      return auth.issueTrustedSession({ appSlug, memberId, role: 'owner' });
    },
    resolveVerifiedOwner(appSlug, sessionCredential, members, configuredPublicUserId) {
      const auth = authBySlug.get(appSlug);
      const mounted = mounts.get(appSlug);
      if (!auth || !mounted || !sessionCredential) return null;
      const session = auth.getSessionRecord(sessionCredential);
      if (!session || session.appSlug !== appSlug || session.role !== 'owner' || session.source !== 'google-member') return null;
      const plan = members.memberPlanForMember(session.invitedBy);
      const userSlug = resolvePublicAppUserId(undefined, configuredPublicUserId);
      if (!plan || !userSlug) return null;
      return { memberId: session.invitedBy, userSlug, plan: plan.plan, entitlements: plan.entitlements };
    },
    resolveVerifiedMemberOwner(sessionCredential, members, configuredPublicUserId) {
      if (!sessionCredential) return null;
      for (const [appSlug, auth] of authBySlug) {
        const mounted = mounts.get(appSlug);
        if (!mounted) continue;
        const session = auth.getSessionRecord(sessionCredential);
        if (!session || session.appSlug !== appSlug || session.role !== 'owner' || session.source !== 'google-member') continue;
        const plan = members.memberPlanForMember(session.invitedBy);
        const userSlug = resolvePublicAppUserId(undefined, configuredPublicUserId);
        if (!plan || !userSlug) return null;
        return { memberId: session.invitedBy, userSlug, plan: plan.plan, entitlements: plan.entitlements };
      }
      return null;
    },
    handle(req) {
      const hostname = requestHostname(req);
      if (!hostname) return undefined;
      const localHost = hostname.endsWith(APP_HOST_SUFFIX);
      const publicHost = parsePublicAppHost(hostname, PUBLIC_APP_DOMAIN);
      if (!localHost && !hostname.endsWith(`.${PUBLIC_APP_DOMAIN}`)) return undefined;
      if (!localHost && (!publicHost || !publicUserSlug || publicHost.user !== publicUserSlug)) return notFound();
      const slug = localHost ? hostname.slice(0, -APP_HOST_SUFFIX.length) : publicHost!.app;
      const mounted = mounts.get(slug);
      if (!mounted) return notFound();
      const auth = authBySlug.get(slug);
      const roles = mounted.manifest.roles as Record<string, unknown> | undefined;
      const publicRole = roles?.public;
      const publicRead = typeof publicRole === 'object' && publicRole !== null && !Array.isArray(publicRole)
        && (publicRole as Record<string, unknown>).via === 'public-read';
      if (!auth && !publicRead) return new Response('App authentication unavailable', { status: 503 });
      const url = new URL(req.url);
      if (url.pathname === '/__auth/accept') {
        if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
        if (!auth) return new Response('App authentication unavailable', { status: 503 });
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
        const authorization = req.headers.get('authorization') ?? '';
        const bearerToken = /^Bearer (aps_[A-Za-z0-9_-]{16,4096})$/.exec(authorization)?.[1] ?? null;
        const hasCookie = Boolean(req.headers.get('cookie'));
        if (authorization && (!bearerToken || hasCookie)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
        const nativeBearer = Boolean(bearerToken && !hasCookie && !req.headers.has('origin'));
        if (!sameRequestOrigin(req, hostname) && !nativeBearer) return new Response(JSON.stringify({ error: 'origin-not-allowed' }), { status: 403, headers: { 'content-type': 'application/json' } });
        if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') ?? '')) return new Response(JSON.stringify({ error: 'json-required' }), { status: 415, headers: { 'content-type': 'application/json' } });
        const sessionCredential = bearerToken ?? req.headers.get('cookie') ?? '';
        let session = auth?.getSessionRecord(sessionCredential);
        let role = session?.appSlug === slug ? session.role : undefined;
        if (session && bearerToken && session.source !== 'google-member') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
        if (!role && publicRead && !authorization) role = 'public';
        if (!role) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
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
          session = auth?.getSessionRecord(sessionCredential);
          role = session?.appSlug === slug ? session.role : undefined;
          if (session && bearerToken && session.source !== 'google-member') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
          if (!role && publicRead && !authorization) role = 'public';
          if (!role) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
          if (roles && !Object.hasOwn(roles, role)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } });
          const rows = appDb.rpc(slug, rpcMatch[1]!, (rpcInput.params ?? {}) as Record<string, unknown>, role);
          return new Response(JSON.stringify({ rows }), { status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' } });
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const status = message === 'app role is not allowed' ? 403 : message.startsWith('rpc not found:') ? 404 : 400;
          return new Response(JSON.stringify({ error: status === 403 ? 'forbidden' : status === 404 ? 'rpc-not-found' : 'invalid-rpc-request' }), { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json' } });
        }
        })();
      }
      const isPublicReadRequest = publicRead && (req.method === 'GET' || req.method === 'HEAD');
      if (!isPublicReadRequest && (!auth || auth.verifySession({ appSlug: slug, token: req.headers.get('cookie') ?? '' }).status !== 200)) {
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
        'x-nexus-app-origin': `${localHost ? 'http' : 'https'}://${requestAuthority(req, hostname)}`,
      });
      let responseBody = body;
      if (['.html', '.htm'].includes(extname(filePath).toLowerCase())) {
        const asciiView = body.toString('latin1');
        // Source: BOM inspection needs only the first four bytes, the longest supported marker prefix.
        const bytePrefix = body.subarray(0, 4).toString('hex');
        const utf32Bom = bytePrefix.startsWith('0000feff') || bytePrefix.startsWith('fffe0000');
        const utf8Bom = bytePrefix.startsWith('efbbbf');
        const utf16leBom = bytePrefix.startsWith('fffe');
        const utf16beBom = bytePrefix.startsWith('feff');
        const utf16leSignature = /^[0-9a-f]{2}00[0-9a-f]{2}00/i.test(bytePrefix);
        const utf16beSignature = /^00[0-9a-f]{2}00[0-9a-f]{2}/i.test(bytePrefix);
        const bomCharset = utf32Bom ? undefined : utf8Bom ? 'utf-8'
          : utf16leBom ? 'utf-16le'
            : utf16beBom ? 'utf-16be'
              : utf16leSignature ? 'utf-16le'
                : utf16beSignature ? 'utf-16be'
              : undefined;
        const bomHex = utf8Bom ? 'efbbbf' : utf16leBom ? 'fffe' : utf16beBom ? 'feff' : undefined;
        const bomBytes = bomHex ? Buffer.from(bomHex, 'hex') : undefined;
        const declaredCharset = detectDeclaredHtmlCharset(asciiView);
        const charset = bomCharset ?? declaredCharset;
        const bigEndian = charset?.toLowerCase().replaceAll('_', '-') === 'utf-16be'
          || charset?.toLowerCase() === 'utf16be';
        const decodeCharset = bigEndian ? 'utf-16le' : charset;
        if (utf32Bom) {
          responseBody = body;
        } else if (charset && decodeCharset && iconv.encodingExists(decodeCharset)) {
          headers.set('content-type', `text/html; charset=${charset}`);
          // Source: encoded BOM length is determined from its bytes, so decoding starts after the marker.
          const bodyWithoutBom = bomBytes ? body.subarray(bomBytes.length) : body;
          try {
            const decodedBytes = bigEndian ? Buffer.from(bodyWithoutBom).swap16() : bodyWithoutBom;
            const utf8Charset = ['utf-8', 'utf8'].includes(charset.toLowerCase());
            if (utf8Charset) {
              try {
                const html = new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes);
                const transformed = Buffer.from(decorateHtml(slug, html, mounted));
                responseBody = bomBytes ? Buffer.concat([bomBytes, transformed]) : transformed;
              } catch {
                // Source: a byte-preserving fallback still applies entitlement handling to malformed UTF-8 HTML.
                responseBody = Buffer.from(decorateHtml(slug, asciiView, mounted), 'latin1');
              }
            } else {
              const html = iconv.decode(decodedBytes, decodeCharset);
              const encoded = iconv.encode(decorateHtml(slug, html, mounted), decodeCharset);
              const orderedBytes = bigEndian ? Buffer.from(encoded).swap16() : encoded;
              responseBody = bomBytes ? Buffer.concat([bomBytes, orderedBytes]) : orderedBytes;
            }
          } catch {
            responseBody = body;
          }
        } else if (charset) {
          headers.set('content-type', `text/html; charset=${charset}`);
          responseBody = Buffer.from(decorateHtml(slug, asciiView, mounted), 'latin1');
        } else {
          try {
            const html = new TextDecoder('utf-8', { fatal: true }).decode(body);
            responseBody = Buffer.from(decorateHtml(slug, html, mounted));
          } catch {
            // Source: latin1 maps each input byte to one code point, preserving bytes through fallback encode.
            headers.set('content-type', 'text/html; charset=windows-1252');
            responseBody = Buffer.from(decorateHtml(slug, asciiView, mounted), 'latin1');
          }
        }
      }
      const response = new Response(req.method === 'HEAD' ? null : new Uint8Array(responseBody), { status: 200, headers });
      if (req.method === 'GET' && url.pathname === '/' && funnel) {
        emitNexusFunnelEvent(funnel, {
          type: 'app-open', accountHash: funnel.accountHash, appHash: funnel.appHash(slug),
        });
      }
      return response;
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
  publicUserSlug?: string,
): { appHost: NexusAppHost; issues: readonly NexusAppHostIssue[] } {
  const mounts = new Map<string, MountedApp>();
  const authBySlug = new Map<string, ReturnType<typeof createAppAuth>>();
  const databases = new Map<string, AppDatabase>();
  const issues: NexusAppHostIssue[] = [];
  const configuredAppsRoot = resolve(appsDir);
  const appsRoot = () => realpathSync(configuredAppsRoot);
  const mountDirectory = (appSlug: string, entitlements?: Readonly<Record<string, unknown>>, initializeDatabase = true) => {
    const root = appsRoot();
    const mountedBase = mountApp(root, appSlug, simulation);
    const stateDirectory = join(root, APP_HOST_STATE_DIR);
    let mountedEntitlements = entitlements;
    if (mountedEntitlements === undefined) {
      try {
        const state: unknown = JSON.parse(readFileSync(join(stateDirectory, `${appSlug}.json`), 'utf8'));
        if (!state || typeof state !== 'object' || Array.isArray(state)
          || typeof (state as { badgeDisabled?: unknown }).badgeDisabled !== 'boolean') {
          throw new Error('app host entitlement state is invalid');
        }
        if ((state as { badgeDisabled: boolean }).badgeDisabled) {
          // Source: 내부 문서 `nexus-revenue-and-market` §2⑤ — restore managed badge removal after restart.
          mountedEntitlements = { [MADE_WITH_BADGE_ENTITLEMENT]: 0 };
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    const mounted: MountedApp = mountedEntitlements ? { ...mountedBase, entitlements: mountedEntitlements } : mountedBase;
    if (mounted.slug !== appSlug) throw new Error('app directory slug does not match its manifest');
    if (mounts.has(appSlug)) throw new Error('app is already mounted');
    let auth: ReturnType<typeof createAppAuth> | undefined;
    let database: AppDatabase | undefined;
    try {
      if (authOptions) {
        auth = createAppAuth({ ...authOptions, dir: join(authOptions.dir ?? join(root, '..', 'app-session-tokens'), appSlug) });
        const hasDbContract = Object.hasOwn(mounted.manifest, 'tables') || Object.hasOwn(mounted.manifest, 'rpc');
        if (initializeDatabase && hasDbContract) database = createAppDatabase([mounted.manifest], {
          ...(authOptions.databaseDirectory ? { directory: authOptions.databaseDirectory } : {}),
          ...(authOptions.databaseBackup ? { backup: authOptions.databaseBackup } : {}),
        });
      }
      if (entitlements !== undefined) {
        mkdirSync(stateDirectory, { recursive: true });
        // Source: 내부 문서 `nexus-revenue-and-market` §2③⑤ — persist only the derived attribution toggle.
        const badgeDisabled = entitlements[MADE_WITH_BADGE_ENTITLEMENT] === 0;
        const statePath = join(stateDirectory, `${appSlug}.json`);
        const pendingStatePath = `${statePath}.tmp-${randomUUID()}`;
        writeFileSync(pendingStatePath, JSON.stringify({ badgeDisabled }));
        try { renameSync(pendingStatePath, statePath); }
        catch (error) {
          try { unlinkSync(pendingStatePath); } catch { /* the incomplete file is already absent */ }
          throw error;
        }
      }
      mounts.set(appSlug, mounted);
      if (auth) authBySlug.set(appSlug, auth);
      if (database) databases.set(appSlug, database);
    } catch (error) {
      database?.close();
      mounts.delete(appSlug);
      authBySlug.delete(appSlug);
      databases.delete(appSlug);
      throw error;
    }
  };
  const unmountDirectory = (appSlug: string) => {
    databases.get(appSlug)?.close();
    databases.delete(appSlug);
    authBySlug.delete(appSlug);
    mounts.delete(appSlug);
  };
  if (existsSync(configuredAppsRoot)) {
    const root = appsRoot();
    const rootIdentity = stableDirectory(root, root);
    const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const appDir = join(root, entry.name);
      if (!existsSync(join(appDir, 'app.yaml'))) continue;
      try { mountDirectory(entry.name, undefined, false); }
      catch (error) { issues.push({ appDir: basename(appDir), reason: error instanceof Error ? error.message : String(error) }); }
    }
    stableDirectory(root, root, rootIdentity);
  }
  if (authOptions) {
    for (const [slug, mounted] of mounts) {
      const hasDbContract = Object.hasOwn(mounted.manifest, 'tables') || Object.hasOwn(mounted.manifest, 'rpc');
      if (!hasDbContract) continue;
      try {
        databases.set(slug, createAppDatabase([mounted.manifest], {
          ...(authOptions.databaseDirectory ? { directory: authOptions.databaseDirectory } : {}),
          ...(authOptions.eventBus ? { eventBus: authOptions.eventBus } : {}),
          ...(authOptions.databaseBackup ? { backup: authOptions.databaseBackup } : {}),
        }));
      } catch (error) {
        issues.push({ appDir: slug, reason: error instanceof Error ? error.message : String(error) });
        mounts.delete(slug);
        authBySlug.delete(slug);
      }
    }
  }
  let appDb: AppDatabase | undefined;
  if (authOptions) {
    appDb = {
      rpc(slug, name, params, role) {
        const database = databases.get(slug);
        if (!database) throw new Error(`app not found: ${slug}`);
        return database.rpc(slug, name, params, role);
      },
      backupStatus(slug) { return databases.get(slug)?.backupStatus?.(slug) ?? null; },
      createBackupSnapshot(slug) { return databases.get(slug)?.createBackupSnapshot?.(slug) ?? false; },
      restoreBackup(slug, targetPath) {
        const database = databases.get(slug);
        if (!database?.restoreBackup) throw new Error('app database backup is not configured');
        return database.restoreBackup(slug, targetPath);
      },
      close() { for (const database of databases.values()) database.close(); databases.clear(); },
    };
  }
  return { appHost: createNexusAppHost(mounts, authBySlug, appDb, authOptions?.funnel, mountDirectory, unmountDirectory, publicUserSlug), issues };
}
