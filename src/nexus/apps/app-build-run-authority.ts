import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TuiMemberSession } from '../../tui/member-session-contract.js';
import { readRelayMemberKeyFile } from '../../relay/member-token-provider.js';
import type { DynamicOwner } from './dynamic-app-publish.js';

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
