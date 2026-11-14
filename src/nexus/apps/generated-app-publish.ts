import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { loadNexusAppHost, type NexusAppHost } from './app-host.js';
import { fingerprintAppSourceDirectory, withAppSourceLock } from './app-source-snapshot.js';
import { probeTailscale } from '../onboarding/tailscale-probe.js';

export interface GeneratedArtifact {
  manifest: AppManifest; staticExportDir: string; ownerId: string; runId: string;
}
export interface GeneratedPublishRequest {
  action: 'simulate' | 'publish' | 'undo'; runId: string;
  artifact?: unknown; receipt?: unknown; deploymentId?: unknown;
}
export interface AppListener { url: string; stop(): void }
interface Seal { id: string; ownerId: string; runId: string; slug: string; fingerprint: string }
interface Deployment extends Seal { dev: string; ino: string; state: 'pending' | 'published' | 'deleting' | 'undone'; url?: string; stagingPath?: string }
export interface GeneratedPublisherOptions {
  artifactRoot: string; appsRoot: string; appHost: NexusAppHost;
  /** Test seam only; production binds a Tailscale interface, never 0.0.0.0. */
  listen?: (host: NexusAppHost, slug: string, previousUrl?: string) => Promise<AppListener>;
}
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const RECEIPT = /^sim-[0-9a-f-]{36}$/;
const DEPLOYMENT = /^dep-[0-9a-f]{64}$/;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function fingerprint(path: string): string {
  return fingerprintAppSourceDirectory(path, { includeGeneratedFiles: true });
}
function fail(): never { throw new Error('generated app operation refused'); }
function tailnetIp(host: string): boolean {
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/** Transport only: reuse the existing app host; each app gets a distinct origin. */
export function listenOnAppHost(host: NexusAppHost, slug: string, address: string, testLoopback = false, previousUrl?: string): AppListener {
  if (!SLUG.test(slug) || !tailnetIp(address) && !(testLoopback && address === '127.0.0.1')) fail();
  const previous = previousUrl ? new URL(previousUrl) : undefined;
  if (previous && (previous.protocol !== 'http:' || previous.hostname !== address || !previous.port)) fail();
  let origin = '';
  const server = Bun.serve({
    hostname: address, port: previous ? Number(previous.port) : 0,
    async fetch(request) {
      if (!origin || new URL(request.url).origin !== origin) return new Response('Forbidden', { status: 403 });
      const requestOrigin = request.headers.get('origin');
      if (requestOrigin && requestOrigin !== origin) return new Response('Forbidden', { status: 403 });
      const source = new URL(request.url);
      const virtual = new URL(source.pathname + source.search, 'http://' + slug + '.app.localhost');
      const forwarded = new Request(virtual, request);
      forwarded.headers.set('host', virtual.host);
      // Never forward Nexus/member or other application cookies to generated content.
      const appCookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim())
        .filter(part => part.startsWith('__Host-app-session='));
      if (appCookies.length === 1) forwarded.headers.set('cookie', appCookies[0]!);
      else forwarded.headers.delete('cookie');
      if (requestOrigin) forwarded.headers.set('origin', virtual.origin);
      return await host.handle(forwarded) ?? new Response('Not Found', { status: 404 });
    },
  });
  origin = server.url.origin;
  return { url: origin + '/', stop: () => { server.stop(true); } };
}
async function productionListener(host: NexusAppHost, slug: string, previousUrl?: string): Promise<AppListener> {
  const probe = await probeTailscale();
  const ip = probe.alive ? probe.ips?.find(tailnetIp) : undefined;
  if (!ip) throw new Error('tailnet app transport unavailable');
  return listenOnAppHost(host, slug, ip, false, previousUrl);
}

/** Existing manifest, snapshot, source lock and mount are the deployment engine. */
export function createGeneratedAppPublisher(options: GeneratedPublisherOptions) {
  const requestedArtifactRoot = resolve(options.artifactRoot);
  mkdirSync(requestedArtifactRoot, { recursive: true, mode: 0o700 });
  const artifactRoot = realpathSync(requestedArtifactRoot);
  const appsRoot = resolve(options.appsRoot);
  const ledger = join(artifactRoot, 'generated-app-deployments');
  mkdirSync(ledger, { recursive: true, mode: 0o700 });
  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  const listeners = new Map<string, AppListener>();
  const privateSlugs = new Map<string, string>();
  const activeDeployments = new Map<string, string>();
  const runKey = (owner: string, run: string, slug: string) => createHash('sha256').update(owner + '\\0' + run + '\\0' + slug).digest('hex');
  // Existing wildcard/relay ingress must not inherit a new generated mount.
  for (const filename of readdirSync(ledger)) {
    if (!DEPLOYMENT.test(filename.replace(/\.json$/, ''))) continue;
    try {
      const value = object(JSON.parse(readFileSync(join(ledger, filename), 'utf8')));
      if ((value.state === 'pending' || value.state === 'published' || value.state === 'deleting') && typeof value.slug === 'string' && SLUG.test(value.slug)) privateSlugs.set(value.slug, String(value.id));
    } catch { /* corrupted receipts are rejected by restore */ }
  }
  const write = (value: Seal | Deployment) => {
    const path = join(ledger, value.id + '.json');
    const temp = path + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  };
  const read = (id: unknown, pattern: RegExp): Record<string, unknown> => {
    if (typeof id !== 'string' || !pattern.test(id)) fail();
    const path = join(ledger, id + '.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.size > 8192 || process.getuid && stat.uid !== process.getuid()) fail();
    return object(JSON.parse(readFileSync(path, 'utf8')));
  };
  const artifact = (owner: string, request: GeneratedPublishRequest) => {
    const value = object(request.artifact);
    if (!owner || value.ownerId !== owner || value.runId !== request.runId || !RUN.test(request.runId)
      || typeof value.staticExportDir !== 'string' || !isAbsolute(value.staticExportDir)) fail();
    const parsed = parseAppManifest(stringify(value.manifest));
    if (!parsed.ok || !SLUG.test(parsed.manifest.slug)) fail();
    const submittedOut = resolve(value.staticExportDir);
    if (!inside(requestedArtifactRoot, submittedOut) && !inside(artifactRoot, submittedOut)) fail();
    const out = inside(requestedArtifactRoot, submittedOut)
      ? resolve(artifactRoot, relative(requestedArtifactRoot, submittedOut)) : submittedOut;
    const source = dirname(out);
    const buildRoot = join(realpathSync(artifactRoot), 'app-build-artifacts');
    const ownerRoot = join(buildRoot, createHash('sha256').update(owner).digest('hex'));
    if (realpathSync(buildRoot) !== buildRoot || realpathSync(ownerRoot) !== ownerRoot) fail();
    if (basename(source) !== parsed.manifest.slug || basename(out) !== 'out'
      || dirname(dirname(source)) !== ownerRoot || !(basename(dirname(source)).startsWith(request.runId + '-')
        && /^[A-Za-z0-9]{6}$/.test(basename(dirname(source)).slice(request.runId.length + 1)))
      || !inside(ownerRoot, source) || realpathSync(source) !== source || realpathSync(out) !== out) fail();
    const buildRecordPath = join(dirname(source), '.build-record.json');
    const recordStat = lstatSync(buildRecordPath);
    if (!recordStat.isFile() || recordStat.isSymbolicLink() || recordStat.nlink !== 1
      || recordStat.size > 8192 || (recordStat.mode & 0o077) !== 0
      || process.getuid && recordStat.uid !== process.getuid()) fail();
    const buildRecord = object(JSON.parse(readFileSync(buildRecordPath, 'utf8')));
    if (buildRecord.ownerId !== owner || buildRecord.runId !== request.runId
      || buildRecord.slug !== parsed.manifest.slug || buildRecord.appRoot !== source) fail();
    const manifestFile = join(source, 'app.yaml');
    const manifestStat = lstatSync(manifestFile);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail();
    const disk = parseAppManifest(readFileSync(manifestFile, 'utf8'));
    if (!disk.ok || stable(disk.manifest) !== stable(parsed.manifest)) fail();
    const sourceFingerprint = fingerprint(source); // rejects symlinks and unstable reads
    return { source, manifest: parsed.manifest, fingerprint: sourceFingerprint };
  };
  const verifyEntry = async (host: NexusAppHost, slug: string) => {
    const response = await host.handle(new Request('http://' + slug + '.app.localhost/', { headers: { host: slug + '.app.localhost' } }));
    if (response?.status !== 200) throw new Error('app entry requires an explicit public-read contract');
    const body = await response.text();
    if (!body.trim()) fail();
    return body;
  };
  const sameDirectory = (path: string, value: Deployment): boolean => {
    if (!existsSync(path)) return false;
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev.toString() === value.dev && stat.ino.toString() === value.ino;
  };
  const releaseDeployment = (value: Deployment) => {
    if (privateSlugs.get(value.slug) === value.id) privateSlugs.delete(value.slug);
    const key = runKey(value.ownerId, value.runId, value.slug);
    if (activeDeployments.get(key) === value.id) activeDeployments.delete(key);
  };
  const recoverPending = (value: Deployment) => {
    const target = join(appsRoot, value.slug);
    if (value.stagingPath && (dirname(value.stagingPath) !== ledger || !basename(value.stagingPath).startsWith('.deploy-'))) fail();
    if (sameDirectory(target, value)) {
      listeners.get(value.id)?.stop(); listeners.delete(value.id);
      options.appHost.unmountDirectory(value.slug);
      rmSync(target, { recursive: true });
    }
    if (value.stagingPath && sameDirectory(value.stagingPath, value)) rmSync(value.stagingPath, { recursive: true });
    write({ ...value, state: 'undone' });
    releaseDeployment(value);
  };
  return {
    isPrivateSlug: (slug: string) => privateSlugs.has(slug),
    async execute(ownerId: string, request: GeneratedPublishRequest, expectedSlug?: string): Promise<Record<string, unknown>> {
      if (!ownerId || !RUN.test(request.runId)) fail();
      if (request.action === 'undo') {
        const value = read(request.deploymentId, DEPLOYMENT) as unknown as Deployment;
        if (value.ownerId !== ownerId || value.runId !== request.runId || !SLUG.test(value.slug) || expectedSlug && expectedSlug !== value.slug) fail();
        const target = join(appsRoot, value.slug);
        return withAppSourceLock(value.slug, target, async assertHeld => {
          if (value.state === 'pending' || value.state === 'deleting') { assertHeld(); recoverPending(value); return { status: 'undone', deploymentId: value.id }; }
          if (value.state === 'undone') return { status: 'undone', deploymentId: value.id };
          const stat = lstatSync(target, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== value.dev
            || stat.ino.toString() !== value.ino || fingerprint(target) !== value.fingerprint) fail();
          assertHeld();
          // Persist the deletion decision before any irreversible filesystem change.
          const deleting: Deployment = { ...value, state: 'deleting' };
          write(deleting);
          recoverPending(deleting);
          return { status: 'undone', deploymentId: value.id, runId: value.runId };
        });
      }
      const built = artifact(ownerId, request);
      const slug = built.manifest.slug;
      if (expectedSlug && expectedSlug !== slug) fail();
      if (request.action === 'simulate') {
        const temp = mkdtempSync(join(ledger, '.check-'));
        let checkHost: NexusAppHost | undefined;
        try {
          const checkApps = join(temp, 'apps'); mkdirSync(checkApps);
          const copied = join(checkApps, slug);
          cpSync(built.source, copied, { recursive: true, force: false, errorOnExist: true });
          if (fingerprint(copied) !== built.fingerprint
            || fingerprint(built.source) !== built.fingerprint) fail();
          const loaded = loadNexusAppHost(checkApps, undefined, {
            key: randomBytes(32).toString('hex'), dir: join(temp, 'sessions'), databaseDirectory: join(temp, 'db'),
          });
          checkHost = loaded.appHost;
          if (loaded.issues.length || !checkHost.slugs.includes(slug)) fail();
          await verifyEntry(checkHost, slug);
          const seal: Seal = { id: 'sim-' + randomUUID(), ownerId, runId: request.runId, slug, fingerprint: built.fingerprint };
          write(seal);
          return { status: 'simulated', receipt: seal.id, scope: 'manifest-and-app-host-snapshot', runId: request.runId };
        } finally { checkHost?.close(); rmSync(temp, { recursive: true, force: true }); }
      }
      if (request.action !== 'publish') fail();
      const seal = read(request.receipt, RECEIPT) as unknown as Seal;
      if (seal.ownerId !== ownerId || seal.runId !== request.runId || seal.slug !== slug
        || seal.fingerprint !== built.fingerprint) fail();
      const target = join(appsRoot, slug);
      return withAppSourceLock(slug, target, async assertHeld => {
        // This hotfix never overwrites an existing application, even the same owner's.
        const key = runKey(ownerId, request.runId, slug);
        const activeId = activeDeployments.get(key);
        const deploymentId = 'dep-' + createHash('sha256').update(key + randomUUID()).digest('hex');
        if (existsSync(target) || options.appHost.slugs.includes(slug)) {
          const existing = read(activeId, DEPLOYMENT) as unknown as Deployment;
          const live = activeId ? listeners.get(activeId) : undefined;
          const current = lstatSync(target, { bigint: true });
          if (!live || existing.state !== 'published' || existing.ownerId !== ownerId || existing.runId !== request.runId
            || existing.fingerprint !== built.fingerprint || current.dev.toString() !== existing.dev || current.ino.toString() !== existing.ino
            || fingerprint(target) !== existing.fingerprint) fail();
          return { status: 'published', resultUrl: live.url, publicUrl: live.url, deploymentId: existing.id, runId: request.runId, scope: 'same-machine-tailnet' };
        }
        // A private staging inode is durably recorded before it can appear in appsRoot.
        const stagingPath = mkdtempSync(join(ledger, '.deploy-'));
        const stat = lstatSync(stagingPath, { bigint: true });
        const deployment: Deployment = { ...seal, id: deploymentId, state: 'pending',
          dev: stat.dev.toString(), ino: stat.ino.toString(), stagingPath };
        let mounted = false;
        let listener: AppListener | undefined;
        try {
          write(deployment);
          privateSlugs.set(slug, deployment.id);
          // Commit the manifest last so startup cannot mount a partially copied bundle.
          for (const entry of ['out']) cpSync(join(built.source, entry), join(stagingPath, entry), { recursive: true, force: false, errorOnExist: true });
          writeFileSync(join(stagingPath, '.manifest-pending'), readFileSync(join(built.source, 'app.yaml')), { flag: 'wx', mode: 0o600 });
          renameSync(join(stagingPath, '.manifest-pending'), join(stagingPath, 'app.yaml'));
          if (fingerprint(stagingPath) !== built.fingerprint
            || fingerprint(built.source) !== built.fingerprint) fail();
          assertHeld();
          if (existsSync(target) || options.appHost.slugs.includes(slug)) fail();
          renameSync(stagingPath, target);
          options.appHost.mountDirectory(slug); mounted = true;
          const expectedEntry = await verifyEntry(options.appHost, slug);
          listener = await (options.listen ?? productionListener)(options.appHost, slug);
          const endpoint = new URL(listener.url);
          if (endpoint.protocol !== 'http:' || !endpoint.port
            || !(tailnetIp(endpoint.hostname) || options.listen && endpoint.hostname === '127.0.0.1')
            || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) fail();
          const response = await fetch(listener.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
          if (response.status !== 200 || await response.text() !== expectedEntry) fail();
          assertHeld();
          write({ ...deployment, state: 'published', url: listener.url });
          listeners.set(deployment.id, listener);
          activeDeployments.set(key, deployment.id);
          return { status: 'published', resultUrl: listener.url, publicUrl: listener.url,
            deploymentId: deployment.id, runId: request.runId, scope: 'same-machine-tailnet' };
        } catch (error) {
          listener?.stop();
          if (mounted && sameDirectory(target, deployment)) options.appHost.unmountDirectory(slug);
          if (existsSync(target)) {
            const current = lstatSync(target, { bigint: true });
            if (current.dev.toString() === deployment.dev && current.ino.toString() === deployment.ino) rmSync(target, { recursive: true });
          }
          if (sameDirectory(stagingPath, deployment)) rmSync(stagingPath, { recursive: true });
          write({ ...deployment, state: 'undone' });
          releaseDeployment(deployment);
          throw error;
        }
      });
    },
    async restore() {
      let restored = 0; let unavailable = 0;
      for (const filename of readdirSync(ledger)) {
        const id = filename.endsWith('.json') ? filename.slice(0, -5) : '';
        if (!DEPLOYMENT.test(id)) continue;
        try {
          const value = read(id, DEPLOYMENT) as unknown as Deployment;
          if (!SLUG.test(value.slug) || !RUN.test(value.runId)) fail();
          if (value.state === 'pending' || value.state === 'deleting') {
            const target = join(appsRoot, value.slug);
            await withAppSourceLock(value.slug, target, async assertHeld => { assertHeld(); recoverPending(value); });
            continue;
          }
          if (value.state !== 'published') continue;
          if (!value.url) fail();
          const target = join(appsRoot, value.slug);
          await withAppSourceLock(value.slug, target, async assertHeld => {
            const stat = lstatSync(target, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== value.dev || stat.ino.toString() !== value.ino
              || fingerprint(target) !== value.fingerprint) fail();
            if (!options.appHost.slugs.includes(value.slug)) options.appHost.mountDirectory(value.slug);
            assertHeld();
            const listener = await (options.listen ?? productionListener)(options.appHost, value.slug, value.url);
            if (listener.url !== value.url) { listener.stop(); fail(); }
            listeners.set(id, listener);
            privateSlugs.set(value.slug, value.id);
            activeDeployments.set(runKey(value.ownerId, value.runId, value.slug), id);
            restored++;
          });
        } catch { unavailable++; }
      }
      return { restored, unavailable };
    },
    close() { for (const listener of listeners.values()) listener.stop(); listeners.clear(); },
  };
}
export type GeneratedAppPublisher = ReturnType<typeof createGeneratedAppPublisher>;

/** A member-authenticated consumer of the existing Nexus appRoutes registry. */
export function createGeneratedAppPublishRoute(publisher: GeneratedAppPublisher,
  resolveOwner: (request: Request) => Promise<string | null>, webOrigin?: string) {
  return async (request: Request): Promise<Response | undefined> => {
    const match = /^\/v1\/apps\/([a-z0-9][a-z0-9-]*)\/generated-deployment$/.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    if (!request.headers.has('authorization') && !request.headers.has('cookie')) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const origin = request.headers.get('origin');
    const native = /^Bearer aps_[A-Za-z0-9_-]+$/.test(request.headers.get('authorization') ?? '') && !request.headers.has('cookie');
    if (request.headers.get('sec-fetch-site') === 'cross-site'
      || (origin ? origin !== webOrigin : !native)) return Response.json({ error: 'origin-not-allowed' }, { status: 403 });
    const owner = await resolveOwner(request).catch(() => null);
    if (!owner) return Response.json({ error: 'unauthorized' }, { status: 401 });
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) fail();
      const reader = request.body?.getReader(); if (!reader) fail();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); fail(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const body = object(JSON.parse(Buffer.concat(chunks.map(part => Buffer.from(part))).toString('utf8')));
      if (Object.keys(body).some(key => !['action', 'runId', 'artifact', 'receipt', 'deploymentId'].includes(key))
        || typeof body.runId !== 'string' || !['simulate', 'publish', 'undo'].includes(String(body.action))) fail();
      if (body.action !== 'undo' && object(object(body.artifact).manifest).slug !== match[1]) fail();
      const result = await publisher.execute(owner, body as unknown as GeneratedPublishRequest, match[1]);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ error: 'generated-app-operation-refused' }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
  };
}

/** Keep generated mounts off the shared public wildcard and relay ingress. */
export function withGeneratedAppsPrivateIngress(host: NexusAppHost, isPrivate: (slug: string) => boolean): NexusAppHost {
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property !== 'handle') return Reflect.get(target, property, receiver);
      return (request: Request) => {
        const authority = request.headers.get('host') ?? new URL(request.url).host;
        let hostname: string;
        try { hostname = new URL('http://' + authority).hostname.toLowerCase().replace(/\.$/, ''); }
        catch { return new Response('Not Found', { status: 404 }); }
        const slug = hostname.endsWith('.app.localhost') ? hostname.slice(0, -'.app.localhost'.length)
          : hostname.endsWith('.elanous.app') ? hostname.slice(0, -'.elanous.app'.length).split('--')[0] : undefined;
        if (slug && isPrivate(slug)) return new Response('Not Found', { status: 404 });
        return target.handle(request);
      };
    },
  });
}
