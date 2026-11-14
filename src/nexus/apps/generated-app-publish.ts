import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { parseAppManifest, type AppManifest } from './app-contract.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
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
interface Deployment extends Seal { dev: string; ino: string; state: 'pending' | 'published' | 'deleting' | 'undone'; ownerBound?: boolean; url?: string; stagingPath?: string }
export interface GeneratedPublisherOptions {
  artifactRoot: string; appsRoot: string; appHost: NexusAppHost;
  /** Defaults to Nexus's production state roots; explicit roots keep fake hosts isolated. */
  databaseDirectory?: string; sessionDirectory?: string;
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
  const databaseDirectory = resolve(options.databaseDirectory ?? join(getElanousConfigDir(), 'nexus', 'apps'));
  const sessionDirectory = resolve(options.sessionDirectory ?? join(artifactRoot, 'app-session-tokens'));
  const ledger = join(artifactRoot, 'generated-app-deployments');
  mkdirSync(ledger, { recursive: true, mode: 0o700 });
  mkdirSync(appsRoot, { recursive: true, mode: 0o700 });
  const listeners = new Map<string, AppListener>();
  const privateSlugs = new Map<string, string>();
  const knownDeploymentSlugs = new Set<string>();
  const boundOwners = new Map<string, { ownerId: string; fingerprint: string; rank: number }>();
  const activeDeployments = new Map<string, string>();
  let untrustedOwnerLedger = false;
  const sourceOwnerMarker = (root: string) => join(root, '.elanous-generated-owner');
  const runKey = (owner: string, run: string, slug: string) => createHash('sha256').update(owner + '\\0' + run + '\\0' + slug).digest('hex');
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
  // A damaged receipt has no trustworthy slug. Hide every app on shared ingress
  // until the ledger is repaired, rather than expose a generated mount on startup.
  for (const filename of readdirSync(ledger)) {
    if (!filename.startsWith('dep-') || !filename.endsWith('.json')) continue;
    const id = filename.slice(0, -5);
    try {
      const value = read(id, DEPLOYMENT);
      if (typeof value.slug !== 'string' || !SLUG.test(value.slug)
        || typeof value.ownerId !== 'string' || !value.ownerId || value.id !== id
        || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) fail();
      knownDeploymentSlugs.add(value.slug);
      if (value.state === 'pending' || value.state === 'published' || value.state === 'deleting') privateSlugs.set(value.slug, id);
      else if (value.state !== 'undone') fail();
      if (value.ownerBound !== false || value.state === 'published' || value.state === 'deleting') {
        const previous = boundOwners.get(value.slug);
        if (previous && previous.ownerId !== value.ownerId) fail();
        const rank = value.state === 'published' ? 2 : value.state === 'pending' || value.state === 'deleting' ? 1 : 0;
        if (!previous || rank > previous.rank) boundOwners.set(value.slug, { ownerId: value.ownerId, fingerprint: value.fingerprint, rank });
      }
    } catch { untrustedOwnerLedger = true; }
  }
  if (!untrustedOwnerLedger) {
    for (const [slug, binding] of boundOwners) {
      try {
        if (!options.appHost.bindGeneratedOwner) fail();
        options.appHost.bindGeneratedOwner(slug, binding.ownerId, binding.fingerprint);
      } catch { untrustedOwnerLedger = true; }
    }
  }
  const persistedSlugState = (slug: string): boolean => {
    let databaseEntries: string[];
    try { databaseEntries = readdirSync(databaseDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      databaseEntries = [];
    }
    const databaseName = slug + '.db';
    if (databaseEntries.some(name => name === databaseName || name.startsWith(databaseName + '.') || name.startsWith(databaseName + '-'))) return true;
    try { lstatSync(join(sessionDirectory, slug)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  };
  // A simulation receipt is not owner authority, but its source fingerprint
  // identifies a generated mount when the deployment receipt was lost.
  const simulatedSources = new Map<string, Set<string>>();
  for (const filename of readdirSync(ledger)) {
    if (!filename.startsWith('sim-') || !filename.endsWith('.json')) continue;
    const id = filename.slice(0, -5);
    try {
      const value = read(id, RECEIPT);
      if (value.id !== id || typeof value.slug !== 'string' || !SLUG.test(value.slug)
        || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) fail();
      const fingerprints = simulatedSources.get(value.slug) ?? new Set<string>();
      fingerprints.add(value.fingerprint);
      simulatedSources.set(value.slug, fingerprints);
    } catch { untrustedOwnerLedger = true; }
  }
  for (const [slug, fingerprints] of simulatedSources) {
    if (knownDeploymentSlugs.has(slug) || !options.appHost.slugs.includes(slug)) continue;
    try {
      if (fingerprints.has(fingerprint(join(appsRoot, slug))) || persistedSlugState(slug)) privateSlugs.set(slug, 'orphaned-source');
    } catch { untrustedOwnerLedger = true; }
  }
  // The empty marker survives receipt loss but never enters the static export
  // or changes the file fingerprint. Undo removes it with the source directory.
  for (const entry of readdirSync(appsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
    const slug = entry.name;
    try {
      const stat = lstatSync(sourceOwnerMarker(join(appsRoot, slug)));
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
      privateSlugs.set(slug, 'source-marker');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') untrustedOwnerLedger = true;
    }
  }
  // Deployment receipts survive undo. They are the durable slug ownership record:
  // unmounting a source must never make its persisted auth and database reusable by a new member.
  // Call under the per-slug source lock so two processes cannot both claim an unused slug.
  const assertSlugOwner = (slug: string, ownerId: string) => {
    if (untrustedOwnerLedger) fail();
    let hasBoundOwner = false;
    for (const filename of readdirSync(ledger)) {
      if (!filename.startsWith('dep-') || !filename.endsWith('.json')) continue;
      const id = filename.slice(0, -5);
      if (!DEPLOYMENT.test(id)) fail();
      const previous = read(id, DEPLOYMENT);
      if (typeof previous.slug !== 'string' || !SLUG.test(previous.slug)
        || typeof previous.ownerId !== 'string' || !previous.ownerId) fail();
      // New receipts abandoned before the durable mount decision have no app auth or DB.
      // Legacy receipts lack this marker, so keep their existing ownership fail-closed.
      if (previous.ownerBound === false && (previous.state === 'pending' || previous.state === 'undone')) continue;
      if (previous.slug === slug) {
        hasBoundOwner = true;
        if (previous.ownerId !== ownerId) fail();
      }
    }
    // An old DB or app session with no verifiable receipt cannot be claimed by a new writer.
    if (!hasBoundOwner && persistedSlugState(slug)) fail();
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
    if (privateSlugs.get(value.slug) === 'source-marker') {
      try { lstatSync(sourceOwnerMarker(target)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        privateSlugs.delete(value.slug);
      }
    }
  };
  return {
    isPrivateSlug: (slug: string) => untrustedOwnerLedger || privateSlugs.has(slug),
    async execute(ownerId: string, request: GeneratedPublishRequest, expectedSlug?: string,
      stillOwner?: () => Promise<boolean>): Promise<Record<string, unknown>> {
      if (!ownerId || !RUN.test(request.runId)) fail();
      const requireCurrentOwner = async () => { if (stillOwner && !await stillOwner()) fail(); };
      if (request.action === 'undo') {
        const value = read(request.deploymentId, DEPLOYMENT) as unknown as Deployment;
        if (value.ownerId !== ownerId || value.runId !== request.runId || !SLUG.test(value.slug) || expectedSlug && expectedSlug !== value.slug) fail();
        const target = join(appsRoot, value.slug);
        return withAppSourceLock(value.slug, target, async assertHeld => {
          await requireCurrentOwner();
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
          await requireCurrentOwner();
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
        assertHeld();
        await requireCurrentOwner();
        assertSlugOwner(slug, ownerId);
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
          await requireCurrentOwner();
          return { status: 'published', resultUrl: live.url, publicUrl: live.url, deploymentId: existing.id, runId: request.runId, scope: 'same-machine-tailnet' };
        }
        // A private staging inode is durably recorded before it can appear in appsRoot.
        const stagingPath = mkdtempSync(join(ledger, '.deploy-'));
        const stat = lstatSync(stagingPath, { bigint: true });
        let deployment: Deployment = { ...seal, id: deploymentId, state: 'pending', ownerBound: false,
          dev: stat.dev.toString(), ino: stat.ino.toString(), stagingPath };
        let mounted = false;
        let promoted = false;
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
          mkdirSync(sourceOwnerMarker(stagingPath), { mode: 0o700 });
          await requireCurrentOwner();
          assertHeld();
          // Commit ownership before the source enters appsRoot, where startup may mount it
          // and create persistent slug-scoped auth/DB state after a process crash.
          const bound = { ...deployment, ownerBound: true };
          write(bound);
          deployment = bound;
          renameSync(stagingPath, target);
          promoted = true;
          if (!options.appHost.bindGeneratedOwner) fail();
          options.appHost.bindGeneratedOwner(slug, ownerId, built.fingerprint);
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
          // A failed rename is a confirmed non-exposure; only a successful promotion
          // can leave persisted auth/DB state after mount or a later failure.
          write({ ...deployment, state: 'undone', ownerBound: promoted && deployment.ownerBound });
          releaseDeployment(deployment);
          throw error;
        }
      });
    },
    async restore() {
      if (untrustedOwnerLedger) return { restored: 0, unavailable: readdirSync(ledger).filter(name => name.startsWith('dep-') && name.endsWith('.json')).length };
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
            assertSlugOwner(value.slug, value.ownerId);
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
    const gate = new AbortController();
    const timer = setTimeout(() => gate.abort(), 10_000);
    const onAbort = () => gate.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    const aborted = new Promise<never>((_, reject) => {
      gate.signal.addEventListener('abort', () => reject(new Error('generated app request expired')), { once: true });
    });
    if (request.signal.aborted) gate.abort();
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    try {
      const owner = await bounded(resolveOwner(request).catch(() => null));
      if (!owner) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) fail();
      const reader = request.body?.getReader(); if (!reader) fail();
      const chunks: Uint8Array[] = []; let size = 0;
      const cancelBody = () => { void reader.cancel().catch(() => {}); };
      gate.signal.addEventListener('abort', cancelBody, { once: true });
      try {
        if (gate.signal.aborted) fail();
        for (;;) {
          const part = await bounded(reader.read()); if (gate.signal.aborted) fail();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) { await bounded(reader.cancel()); fail(); }
          chunks.push(part.value);
        }
      } finally { gate.signal.removeEventListener('abort', cancelBody); reader.releaseLock(); }
      const body = object(JSON.parse(Buffer.concat(chunks.map(part => Buffer.from(part))).toString('utf8')));
      if (Object.keys(body).some(key => !['action', 'runId', 'artifact', 'receipt', 'deploymentId'].includes(key))
        || typeof body.runId !== 'string' || !['simulate', 'publish', 'undo'].includes(String(body.action))) fail();
      if (body.action !== 'undo' && object(object(body.artifact).manifest).slug !== match[1]) fail();
      // Body receipt may outlive the member session used at route admission.
      const stillOwner = async () => !gate.signal.aborted && await bounded(resolveOwner(request)) === owner && !gate.signal.aborted;
      if (!await stillOwner()) fail();
      const result = await publisher.execute(owner, body as unknown as GeneratedPublishRequest, match[1], stillOwner);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch { return Response.json({ error: 'generated-app-operation-refused' }, { status: 400, headers: { 'cache-control': 'no-store' } }); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', onAbort); }
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
