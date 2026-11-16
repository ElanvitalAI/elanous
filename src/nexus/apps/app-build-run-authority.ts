import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TuiMemberSession } from '../../tui/member-session-contract.js';
import { readRelayMemberKeyFile } from '../../relay/member-token-provider.js';
import { DeploymentGrantAuthorizationError,
  type DeploymentGrantBinding, type DeploymentGrantProvider, type DynamicOwner } from './dynamic-app-publish.js';

const RUN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;
const HEAD = /^[a-f0-9]{40}$/u;
const TTL_MS = 2 * 60 * 60 * 1_000;
type Grant = { ownerId: string; userSlug: string; runId: string; appSlug: string;
  issuerExpiresAt: string; sourceHead: string };
type Seal = { version: 1; ownerId: string; userSlug: string; runId: string; appSlug: string;
  sourceHead: string; issuedAt: number; expiresAt: number; sessionHash: string; relayKeyHash: string | null };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionHash = (session: TuiMemberSession) => sha(session.nexusUrl + '\0' + (session.appSlug ?? '')
  + '\0' + session.sessionToken);
function refuse(): never { throw new Error('BUILD_RUN_AUTHORITY_REFUSED'); }
const payload = (value: Seal) => JSON.stringify({ version: value.version, ownerId: value.ownerId,
  userSlug: value.userSlug, runId: value.runId, appSlug: value.appSlug, sourceHead: value.sourceHead,
  issuedAt: value.issuedAt, expiresAt: value.expiresAt, sessionHash: value.sessionHash,
  relayKeyHash: value.relayKeyHash });

/** A removed or replaced local EMK invalidates every seal tied to it. */
export function relayMemberKeyFingerprint(configDir: string): string | undefined {
  try {
    const configPath = join(configDir, 'config.json'); const stat = lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024
      || process.getuid && stat.uid !== process.getuid()) return undefined;
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { nexus?: { relay?: { memberKeyFile?: unknown } } };
    const keyFile = config.nexus?.relay?.memberKeyFile;
    if (typeof keyFile !== 'string' || !keyFile) return undefined;
    const path = isAbsolute(keyFile) ? keyFile : resolve(configDir, keyFile);
    return sha(path + '\0' + readRelayMemberKeyFile(path));
  } catch { return undefined; }
}

/** Persistent Nexus-only signing material, separate from the ACP control bearer. */
export function loadAppBuildRunAuthorityKey(path: string): string {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 32
      || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()
      || realpathSync(path) !== path) refuse();
    return readFileSync(path).toString('hex');
  } catch { refuse(); }
}

/** Nexus alone issues this run-bound capability after the live official owner check.
 * Its local key and private file never enter a graph input or public response. */
export function createAppBuildRunAuthority(options: {
  root: string; hostKey: string; retainedSession: () => TuiMemberSession | undefined;
  relayKeyFingerprint: () => string | undefined; now?: () => number;
  writeRevocationMarker?: (path: string) => void;
}) {
  const now = options.now ?? Date.now;
  const revokedInProcess = new Set<string>();
  if (!options.root.startsWith('/') || options.hostKey.length < 32) refuse();
  const signature = (value: Seal) => createHmac('sha256', options.hostKey)
    .update('elanous-app-build-run-authority-v1\0').update(payload(value)).digest('hex');
  const pathFor = (runId: string) => { if (!RUN.test(runId)) refuse(); return join(options.root, runId + '.json'); };
  const revokedFor = (runId: string) => pathFor(runId) + '.revoked';
  const isRevoked = (runId: string) => {
    if (revokedInProcess.has(runId)) return true;
    try { lstatSync(revokedFor(runId)); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  };
  const revoke = (runId: string) => {
    revokedInProcess.add(runId);
    const marker = revokedFor(runId);
    try {
      if (options.writeRevocationMarker) options.writeRevocationMarker(marker);
      else writeFileSync(marker, 'revoked\n', { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; }
    // ENOSPC may prevent marker creation while rename/unlink still work.
    // Retire the signed source itself so restoring credentials cannot revive it.
    try { renameSync(pathFor(runId), marker); return; }
    catch { try { rmSync(pathFor(runId)); } catch { /* in-process tombstone still refuses */ } }
  };
  const privateRoot = () => {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid() || realpathSync(options.root) !== options.root) refuse();
  };
  return {
    issue(grant: Grant, liveSession: TuiMemberSession): void {
      if (!grant.ownerId || !grant.userSlug || !RUN.test(grant.runId) || !SLUG.test(grant.appSlug)
        || !HEAD.test(grant.sourceHead) || liveSession.appSlug !== grant.appSlug
        || liveSession.nexusUrl !== 'https://api.elanous.ai') refuse();
      const retained = options.retainedSession();
      const relayKeyHash = options.relayKeyFingerprint() ?? null;
      if (!retained || retained.sessionToken !== liveSession.sessionToken || retained.appSlug !== grant.appSlug
        || relayKeyHash !== null && !/^[a-f0-9]{64}$/u.test(relayKeyHash)) refuse();
      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + TTL_MS, Date.parse(grant.issuerExpiresAt));
      if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) refuse();
      const seal: Seal = { version: 1, ownerId: grant.ownerId, userSlug: grant.userSlug,
        runId: grant.runId, appSlug: grant.appSlug, sourceHead: grant.sourceHead, issuedAt, expiresAt,
        sessionHash: sessionHash(liveSession), relayKeyHash };
      privateRoot();
      if (isRevoked(grant.runId)) refuse();
      writeFileSync(pathFor(grant.runId), JSON.stringify({ ...seal, signature: signature(seal) }) + '\n',
        { flag: 'wx', mode: 0o600 });
    },
    resolve(runId: string, appSlug: string, sourceHead: string): DynamicOwner | null {
      try {
        if (!SLUG.test(appSlug) || !HEAD.test(sourceHead)) return null;
        privateRoot();
        if (isRevoked(runId)) return null;
        const path = pathFor(runId); const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
          || stat.size > 2048 || process.getuid && stat.uid !== process.getuid() || realpathSync(path) !== path) return null;
        const item = JSON.parse(readFileSync(path, 'utf8')) as Seal & { signature?: string };
        if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !==
          'appSlug,expiresAt,issuedAt,ownerId,relayKeyHash,runId,sessionHash,signature,sourceHead,userSlug,version'
          || item.version !== 1 || item.runId !== runId || item.appSlug !== appSlug || item.sourceHead !== sourceHead
          || typeof item.ownerId !== 'string' || !item.ownerId || typeof item.userSlug !== 'string' || !item.userSlug
          || !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.expiresAt)
          || item.expiresAt <= now() || item.expiresAt > item.issuedAt + TTL_MS
          || typeof item.sessionHash !== 'string' || item.relayKeyHash !== null
            && (typeof item.relayKeyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.relayKeyHash))
          || typeof item.signature !== 'string' || !/^[a-f0-9]{64}$/u.test(item.signature)) return null;
        const expected = Buffer.from(signature(item), 'hex'); const actual = Buffer.from(item.signature, 'hex');
        if (!timingSafeEqual(expected, actual)) return null;
        const retained = options.retainedSession();
        if (!retained || retained.nexusUrl !== 'https://api.elanous.ai' || retained.appSlug !== appSlug
          || sessionHash(retained) !== item.sessionHash) { revoke(runId); return null; }
        const currentKeyHash = options.relayKeyFingerprint();
        if (!currentKeyHash || !/^[a-f0-9]{64}$/u.test(currentKeyHash)) {
          if (item.relayKeyHash !== null) revoke(runId);
          return null;
        }
        if (item.relayKeyHash === null) {
          // The operator may connect the relay after reserve. Bind the first
          // observed private key before any C claim; later loss/rotation revokes.
          const bound: Seal = { ...item, relayKeyHash: currentKeyHash };
          const temporary = path + '.' + randomUUID() + '.tmp';
          try {
            writeFileSync(temporary, JSON.stringify({ ...bound, signature: signature(bound) }) + '\n',
              { flag: 'wx', mode: 0o600 });
            renameSync(temporary, path);
          } finally { rmSync(temporary, { force: true }); }
        } else if (item.relayKeyHash !== currentKeyHash) { revoke(runId); return null; }
        if (isRevoked(runId)) return null;
        return { memberId: item.ownerId, userSlug: item.userSlug };
      } catch { return null; }
    },
  };
}
export type AppBuildRunAuthority = ReturnType<typeof createAppBuildRunAuthority>;

/** A server-issued deployment grant is distinct from the two-hour local build seal.
 * Only this adapter sees the one-time dpg_ credential; the publisher sees metadata. */
export function createAppDeploymentGrantProvider(options: {
  root: string; getSession: () => TuiMemberSession | undefined;
  fetcher?: typeof fetch; now?: () => number;
}): DeploymentGrantProvider {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const grantIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
  const approvalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const digestPattern = /^[a-f0-9]{64}$/u;
  const relayKeyPattern = /^[A-Za-z0-9_-]{1,128}$/u;
  const endpoint = 'https://api.elanous.ai/v1/members/deployment-grants';
  const denied = (): never => { throw new Error('DEPLOYMENT_GRANT_REFUSED'); };
  const authDenied = (): never => { throw new DeploymentGrantAuthorizationError(); };
  const privateRoot = () => {
    if (!isAbsolute(options.root)) denied();
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid() || realpathSync(options.root) !== options.root) denied();
  };
  const pathFor = (grantId: string) => {
    if (!grantIdPattern.test(grantId)) denied();
    return join(options.root, grantId + '.json');
  };
  const writeCredential = (grantId: string, binding: DeploymentGrantBinding, credential: string) => {
    const path = pathFor(grantId);
    let file: number | undefined;
    let created = false;
    try {
      file = openSync(path, 'wx', 0o600); created = true;
      const bytes = Buffer.from(JSON.stringify({ binding, credential }) + '\n');
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(file, bytes, offset, bytes.length - offset);
        if (count <= 0) denied();
        offset += count;
      }
      fsyncSync(file); closeSync(file); file = undefined;
      const directory = openSync(options.root, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      if (file !== undefined) { try { closeSync(file); } catch { /* preserve denial */ } }
      if (created) { try { unlinkSync(path); } catch { /* no activation receipt was written */ } }
      denied();
    }
  };
  const sessionFor = (appSlug: string) => {
    const session = options.getSession();
    if (session?.nexusUrl !== 'https://api.elanous.ai' || session.appSlug !== appSlug
      || !/^aps_[A-Za-z0-9_-]+$/u.test(session.sessionToken)) return authDenied();
    return session;
  };
  const revokeIssued = async (grantId: string, owner: DynamicOwner, appSlug: string): Promise<void> => {
    if (!grantIdPattern.test(grantId) || !owner.memberId || !SLUG.test(appSlug)) denied();
    const session = sessionFor(appSlug);
    const response = await fetcher(endpoint + '/' + encodeURIComponent(grantId), {
      method: 'DELETE', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(5_000), headers: { authorization: 'Bearer ' + session.sessionToken,
        accept: 'application/json' },
    });
    if ([401, 403, 404].includes(response.status)) { await response.body?.cancel(); authDenied(); }
    if (response.status !== 200 || (await json(response)).revoked !== true) denied();
  };
  const json = async (response: Response): Promise<Record<string, unknown>> => {
    const reader = response.body?.getReader(); if (!reader) return denied();
    const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 8192) denied();
      parts.push(part.value);
    } } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
    return value as Record<string, unknown>;
  };
  const readPrivate = (grantId: string): { binding: DeploymentGrantBinding; credential: string } | null => {
    try {
      privateRoot();
      const path = pathFor(grantId);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192
        || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()
        || realpathSync(path) !== path) return null;
      const row = JSON.parse(readFileSync(path, 'utf8')) as { binding?: DeploymentGrantBinding; credential?: unknown };
      if (!row.binding || row.binding.grantId !== grantId
        || typeof row.credential !== 'string' || !/^dpg_[A-Za-z0-9_-]{43,128}$/u.test(row.credential)) return null;
      try { lstatSync(path + '.revoked'); return null; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
      return { binding: row.binding, credential: row.credential };
    } catch { return null; }
  };
  return {
    async issue(input) {
      if (!input.ownerId || !/^dyn-[0-9a-f-]{36}$/u.test(input.deploymentId)
        || !SLUG.test(input.appSlug) || !RUN.test(input.runId)
        || !HEAD.test(input.sourceHead) || !digestPattern.test(input.artifactDigest)
        || !relayKeyPattern.test(input.relayKeyId)
        || !approvalIdPattern.test(input.approvalId ?? '')
        || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now()) denied();
      privateRoot();
      const session = sessionFor(input.appSlug);
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'manual', credentials: 'omit',
        cache: 'no-store', signal: AbortSignal.timeout(5_000), headers: {
          authorization: 'Bearer ' + session.sessionToken, 'content-type': 'application/json', accept: 'application/json',
        }, body: JSON.stringify({ deploymentId: input.deploymentId,
          appSlug: input.appSlug, runId: input.runId, sourceHead: input.sourceHead,
          artifactDigest: input.artifactDigest, relayKeyId: input.relayKeyId,
          expiresAt: input.expiresAt, approvalId: input.approvalId }) });
      if (response.status !== 201) { await response.body?.cancel(); denied(); }
      const row = await json(response);
      if (Object.hasOwn(row, 'ownerId') || typeof row.grantId !== 'string' || !grantIdPattern.test(row.grantId)
        || row.memberId !== input.ownerId
        || !Number.isSafeInteger(row.grantVersion) || (row.grantVersion as number) < 1
        || typeof row.credential !== 'string' || !/^dpg_[A-Za-z0-9_-]{43,128}$/u.test(row.credential)
        || row.deploymentId !== input.deploymentId
        || row.appSlug !== input.appSlug || row.runId !== input.runId
        || row.sourceHead !== input.sourceHead || row.artifactDigest !== input.artifactDigest
        || row.relayKeyId !== input.relayKeyId || row.approvalId !== input.approvalId
        || typeof row.expiresAt !== 'string'
        || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now()
        || Date.parse(row.expiresAt) > Math.min(Date.parse(input.expiresAt), now() + 24 * 60 * 60 * 1_000)) {
        if (typeof row.grantId === 'string' && grantIdPattern.test(row.grantId)) {
          try { await revokeIssued(row.grantId, { memberId: input.ownerId, userSlug: '' }, input.appSlug); }
          catch (cleanupError) { throw new AggregateError([new Error('DEPLOYMENT_GRANT_BINDING_REFUSED'), cleanupError],
            'deployment grant binding and cleanup refused'); }
        }
        denied();
      }
      const binding: DeploymentGrantBinding = { grantId: row.grantId as string, grantVersion: row.grantVersion as number,
        deploymentId: input.deploymentId, ownerId: input.ownerId,
        appSlug: input.appSlug, runId: input.runId,
        sourceHead: input.sourceHead, artifactDigest: input.artifactDigest,
        relayKeyId: input.relayKeyId, expiresAt: row.expiresAt as string, approvalId: input.approvalId };
      // A failed private write leaves no locally usable credential. A 409 never
      // triggers an automatic revoke or reissue of the server's active grant.
      try { writeCredential(binding.grantId, binding, row.credential as string); }
      catch (writeError) {
        try { await revokeIssued(binding.grantId, { memberId: input.ownerId, userSlug: '' }, input.appSlug); }
        catch (cleanupError) { throw new AggregateError([writeError, cleanupError],
          'deployment grant credential persistence and cleanup refused'); }
        throw writeError;
      }
      return binding;
    },
    async introspect(grantId) {
      const local = readPrivate(grantId); if (!local) return null;
      try {
        const response = await fetcher(endpoint + '/introspect', { method: 'POST', redirect: 'manual',
          credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5_000),
          headers: { authorization: 'Bearer ' + local.credential, accept: 'application/json' } });
        if (response.status !== 200) { await response.body?.cancel(); return null; }
        const row = await json(response); const binding = local.binding;
        return !Object.hasOwn(row, 'ownerId')
          && row.grantId === binding.grantId && row.grantVersion === binding.grantVersion
          && row.deploymentId === binding.deploymentId
          && row.memberId === binding.ownerId && row.appSlug === binding.appSlug
          && row.runId === binding.runId && row.sourceHead === binding.sourceHead
          && row.artifactDigest === binding.artifactDigest && row.relayKeyId === binding.relayKeyId
          && row.expiresAt === binding.expiresAt && row.approvalId === binding.approvalId
          && now() < Date.parse(binding.expiresAt)
          ? binding : null;
      } catch { return null; }
    },
    async revoke(grantId, owner) {
      const local = readPrivate(grantId);
      if (local && local.binding.ownerId !== owner.memberId) return authDenied();
      if (!local) return denied();
      await revokeIssued(grantId, owner, local.binding.appSlug);
      try { writeFileSync(pathFor(grantId) + '.revoked', 'revoked\n', { flag: 'wx', mode: 0o600 }); }
      catch { /* authoritative server revocation already confirmed */ }
    },
    revokeIssued,
  };
}
