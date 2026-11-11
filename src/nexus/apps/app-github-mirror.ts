import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSecretId } from '../config/secrets/app-secret-ledger.js';
import { canonicalGithubRepository, readGithubMirrorCredentialAsync, type GithubMirrorCredential } from '../config/secrets/index.js';
import { containsSecret } from './app-source-snapshot.js';

const MAX_OBJECTS = 20_000;
const MAX_BYTES = 50 * 1024 * 1024;
const CANARY_MARKER = 'ELANOUS_CANARY_V1';

export interface MirrorHistoryScan {
  readonly verdict: 'clean' | 'leaked' | 'indeterminate';
  /** Exact commit whose reachable objects were checked and may be pushed. */
  readonly head?: string;
  readonly objectsEnumerated?: number;
  /** Includes the object whose size crossed a limit, even if its bytes were not read. */
  readonly bytesMeasured?: number;
  readonly objectsScanned: number;
  readonly bytesScanned: number;
}

export type MirrorPushResult =
  | { readonly ok: true; readonly before?: string; readonly after: string }
  | { readonly ok: false; readonly reason: 'token-unknown' | 'token-expired' | 'permission-denied' | 'repository-denied' | 'push-failed' };

export interface AppGithubMirrorDependencies {
  readonly readToken?: (appSlug: string) => Promise<GithubMirrorCredential | undefined>;
  readonly scanHistory?: (sourceRepo: string, token: string) => Promise<MirrorHistoryScan> | MirrorHistoryScan;
  readonly push?: (input: { readonly sourceRepo: string; readonly repository: string; readonly token: string;
    readonly sourceHead: string; readonly expectedBefore?: string }) => Promise<MirrorPushResult> | MirrorPushResult;
}

export type AppGithubMirrorOutcome =
  | { readonly ok: true; readonly kind: 'export' | 'mirror'; readonly after: string; readonly before?: string;
      readonly objectsScanned: number; readonly bytesScanned: number; readonly objectsEnumerated?: number; readonly bytesMeasured?: number }
  | { readonly ok: false; readonly reason: 'missing-token' | 'repository-denied' | 'canary-hit' | 'scan-incomplete'
      | 'token-unknown' | 'token-expired' | 'permission-denied' | 'push-failed';
      readonly objectsScanned?: number; readonly bytesScanned?: number; readonly objectsEnumerated?: number; readonly bytesMeasured?: number };

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  for (const key of Object.keys(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|curl_ca_bundle|ssl_cert_file)$/i.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}

/** Reject local transport knobs that could redirect HTTPS or weaken TLS. */
export function isMirrorGitConfigSafe(sourceRepo: string): boolean {
  const config = git(sourceRepo, ['config', '--null', '--name-only', '--list', '--includes']);
  return config !== null && !config.toString('utf8').split('\0')
    .some((key) => /^(?:url\.|http\.|credential\.|core\.askpass$)/i.test(key));
}

function git(sourceRepo: string, args: readonly string[], maxBuffer = 64 * 1024 * 1024): Buffer | null {
  const result = spawnSync('git', ['-C', sourceRepo, ...args], {
    env: { ...isolatedGitEnv(), GIT_ALLOW_PROTOCOL: 'file' }, maxBuffer, timeout: 30_000,
  });
  return !result.error && result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
}

function treeHasSecretFile(tree: Buffer, oidBytes: number): boolean | null {
  let offset = 0;
  while (offset < tree.byteLength) {
    const space = tree.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : tree.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + oidBytes > tree.byteLength) return null;
    const name = tree.subarray(space + 1, nul).toString('utf8');
    if (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) return true;
    offset = nul + 1 + oidBytes;
  }
  return false;
}

/** Scan every object reachable from local refs, including old commit metadata. */
export function scanLocalGitHistory(sourceRepo: string, token: string,
  limits: { readonly maxObjects?: number; readonly maxBytes?: number } = {}): MirrorHistoryScan {
  const maxObjects = limits.maxObjects ?? MAX_OBJECTS;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const incomplete = (objectsScanned = 0, bytesScanned = 0, extra: Partial<MirrorHistoryScan> = {}): MirrorHistoryScan =>
    ({ verdict: 'indeterminate', objectsScanned, bytesScanned, ...extra });
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return incomplete();
  let source: string;
  try { source = realpathSync(sourceRepo); } catch { return incomplete(); }
  const head = git(source, ['rev-parse', 'HEAD'], 128)?.toString('utf8').trim();
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return incomplete();
  const listed = git(source, ['rev-list', '--objects', '--all', head]);
  if (!listed) return incomplete();
  const oids = new Set(listed.toString('utf8').split('\n').flatMap((line) => {
    const oid = /^([a-f0-9]{40}|[a-f0-9]{64})(?:\s|$)/.exec(line)?.[1];
    return oid ? [oid] : [];
  }));
  if (!oids.size) return incomplete(0, 0, { head });
  if (oids.size > maxObjects) return incomplete(0, 0, { head, objectsEnumerated: oids.size, bytesMeasured: 0 });
  let objectsScanned = 0;
  let bytesScanned = 0;
  for (const oid of oids) {
    const type = git(source, ['cat-file', '-t', oid], 128)?.toString('utf8').trim();
    if (!type || !['blob', 'commit', 'tree', 'tag'].includes(type))
      return incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned });
    const size = Number(git(source, ['cat-file', '-s', oid], 128)?.toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0)
      return incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned });
    if (bytesScanned + size > maxBytes)
      return incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned + size });
    const content = git(source, ['cat-file', type, oid], size + 1024);
    if (!content || content.byteLength !== size)
      return incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned + size });
    objectsScanned += 1;
    bytesScanned += size;
    if (type === 'tree') {
      const hasSecretFile = treeHasSecretFile(content, oid.length / 2);
      if (hasSecretFile === null) return incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned });
      if (hasSecretFile) return { verdict: 'leaked', head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned, objectsScanned, bytesScanned };
    }
    const text = content.toString('latin1');
    if (text.includes(CANARY_MARKER) || (token.length > 0 && content.includes(Buffer.from(token, 'utf8'))) || containsSecret(text)) {
      return { verdict: 'leaked', head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned, objectsScanned, bytesScanned };
    }
  }
  return objectsScanned > 0 && bytesScanned > 0
    ? { verdict: 'clean', head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned, objectsScanned, bytesScanned }
    : incomplete(objectsScanned, bytesScanned, { head, objectsEnumerated: oids.size, bytesMeasured: bytesScanned });
}

/** GitHub HTTPS push; the token travels only through a short-lived askpass environment. */
function pushGithubMirror(input: { readonly sourceRepo: string; readonly repository: string; readonly token: string;
  readonly sourceHead: string; readonly expectedBefore?: string }): MirrorPushResult {
  const repository = canonicalGithubRepository(input.repository);
  let source: string;
  try { source = realpathSync(input.sourceRepo); } catch { return { ok: false, reason: 'push-failed' }; }
  if (!isMirrorGitConfigSafe(source) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sourceHead)
    || git(source, ['cat-file', '-t', input.sourceHead], 128)?.toString('utf8').trim() !== 'commit') return { ok: false, reason: 'push-failed' };
  if (input.expectedBefore !== undefined && (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.expectedBefore)
    || git(source, ['merge-base', '--is-ancestor', input.expectedBefore, input.sourceHead], 128) === null)) {
    return { ok: false, reason: 'push-failed' };
  }
  const askpassDir = mkdtempSync(join(tmpdir(), 'app-github-mirror-'));
  try {
    // Fetch only the scanned commit before the token enters any child environment.
    // A mirror clone would also copy unrelated refs and unreachable loose objects.
    const stagingRepo = join(askpassDir, 'staging.git');
    const stagingEnv = { ...isolatedGitEnv(), GIT_ALLOW_PROTOCOL: 'file' };
    const initialized = spawnSync('git', ['init', '--bare', '-b', 'main', stagingRepo], {
      env: stagingEnv, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (initialized.error || initialized.status !== 0) return { ok: false, reason: 'push-failed' };
    const fetched = spawnSync('git', ['-C', stagingRepo, 'fetch', '--no-tags', '--no-write-fetch-head',
      source, input.sourceHead], { env: stagingEnv, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (fetched.error || fetched.status !== 0 || !isMirrorGitConfigSafe(stagingRepo)
      || git(stagingRepo, ['cat-file', '-t', input.sourceHead], 128)?.toString('utf8').trim() !== 'commit')
      return { ok: false, reason: 'push-failed' };
    if (input.expectedBefore !== undefined
      && git(stagingRepo, ['merge-base', '--is-ancestor', input.expectedBefore, input.sourceHead], 128) === null)
      return { ok: false, reason: 'push-failed' };
    const askpass = join(askpassDir, 'askpass');
    writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf x-access-token ;;\n  *Password*) printf %s "$ELANOUS_GITHUB_MIRROR_TOKEN" ;;\nesac\n', { mode: 0o700 });
    chmodSync(askpass, 0o700);
    const remote = `https://github.com/${repository}.git`;
    const env = { ...isolatedGitEnv(), GIT_ALLOW_PROTOCOL: 'https', GIT_ASKPASS: askpass,
      ELANOUS_GITHUB_MIRROR_TOKEN: input.token };
    const gitArgs = ['-C', stagingRepo, '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
      '-c', 'http.proxy=', '-c', 'http.sslVerify=true'];
    if (input.expectedBefore !== undefined) {
      const observed = spawnSync('git', [...gitArgs, 'ls-remote', '--heads', remote, 'refs/heads/main'],
        { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
      const remoteHead = Buffer.isBuffer(observed.stdout)
        ? /^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/main\s*$/.exec(observed.stdout.toString('utf8'))?.[1]
        : undefined;
      if (observed.error || observed.status !== 0 || remoteHead !== input.expectedBefore)
        return { ok: false, reason: 'push-failed' };
    }
    const lease = input.expectedBefore === undefined ? []
      : [`--force-with-lease=refs/heads/main:${input.expectedBefore}`];
    const result = spawnSync('git', [...gitArgs, 'push', '--no-verify', ...lease, remote,
      `${input.sourceHead}:refs/heads/main`], { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0
      ? { ok: true, ...(input.expectedBefore ? { before: input.expectedBefore } : {}), after: input.sourceHead }
      : { ok: false, reason: 'push-failed' };
  } finally { rmSync(askpassDir, { recursive: true, force: true }); }
}

/** Source repo stays authoritative; only an explicit push can update GitHub. */
export function createAppGithubMirror(deps: AppGithubMirrorDependencies = {}) {
  const readToken = deps.readToken ?? readGithubMirrorCredentialAsync;
  const scanHistory = deps.scanHistory ?? scanLocalGitHistory;
  const push = deps.push ?? pushGithubMirror;
  return {
    async push(input: { readonly appSlug: string; readonly repository: string; readonly sourceRepo: string;
      /** Durable last mirrored ref from the caller's app ledger, absent on first export. */
      readonly previousHead?: string }): Promise<AppGithubMirrorOutcome> {
      appSecretId(input.appSlug, 'GITHUB_MIRROR_TOKEN');
      const repository = canonicalGithubRepository(input.repository);
      const credential = await readToken(input.appSlug);
      if (!credential) return { ok: false, reason: 'missing-token' };
      if (credential.repository !== repository) return { ok: false, reason: 'repository-denied' };
      let scan: MirrorHistoryScan;
      try { scan = await scanHistory(input.sourceRepo, credential.token); }
      catch { return { ok: false, reason: 'scan-incomplete' }; }
      const measured = { objectsScanned: scan.objectsScanned, bytesScanned: scan.bytesScanned,
        ...(scan.objectsEnumerated !== undefined ? { objectsEnumerated: scan.objectsEnumerated } : {}),
        ...(scan.bytesMeasured !== undefined ? { bytesMeasured: scan.bytesMeasured } : {}) };
      if (scan.verdict === 'leaked') return { ok: false, reason: 'canary-hit', ...measured };
      if (scan.verdict !== 'clean' || !Number.isSafeInteger(scan.objectsScanned) || scan.objectsScanned < 1
        || !Number.isSafeInteger(scan.bytesScanned) || scan.bytesScanned < 1
        || !scan.head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scan.head))
        return { ok: false, reason: 'scan-incomplete', ...measured };
      if (input.previousHead !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.previousHead))
        return { ok: false, reason: 'push-failed', ...measured };
      let result: MirrorPushResult;
      try { result = await push({ sourceRepo: input.sourceRepo, repository, token: credential.token,
        sourceHead: scan.head, ...(input.previousHead ? { expectedBefore: input.previousHead } : {}) }); }
      catch { return { ok: false, reason: 'push-failed', ...measured }; }
      if (!result.ok) return { ok: false, reason: result.reason, ...measured };
      if (result.after !== scan.head || (input.previousHead !== undefined && result.before !== input.previousHead))
        return { ok: false, reason: 'push-failed', ...measured };
      return { ok: true, kind: input.previousHead === undefined ? 'export' : 'mirror',
        after: result.after, ...(result.before ? { before: result.before } : {}),
        ...measured };
    },
  };
}
