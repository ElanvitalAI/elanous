import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { validateMirrorManifest } from './mirror-manifest.js';

export type RefRepoRung = 'mirror' | 'upstream' | 'nexus' | 'none';

export interface EnsureRefRepoOptions {
  mirrorBase?: string;
  upstream?: string;
  destRoot: string;
  need: 'code' | 'question';
  timeoutMs?: number;
  /** Only for local, real-git fixtures; production upstreams must be public HTTPS. */
  allowFileUpstream?: boolean;
}

export interface EnsureRefRepoResult {
  path?: string;
  rung: RefRepoRung;
  lastSync?: string;
  fellThrough: Array<{ rung: RefRepoRung; reason: string }>;
}

const DEFAULT_MIRROR = 'git://ref-mirror.elanous-test:9418';
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function gitFailure(stderr: string | null, error: Error | undefined, status: number | null): string {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') return 'timeout';
  return (stderr ?? '').split(/\r?\n/, 1)[0]?.slice(0, 200) || error?.message.slice(0, 200) || `git-exit-${status}`;
}

function fetchExisting(url: string, dest: string, timeoutMs: number): string | undefined {
  const root = spawnSync('git', ['-C', dest, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: timeoutMs });
  if (root.error || root.status !== 0) return root.error ? gitFailure(root.stderr, root.error, root.status) : 'destination-not-checkout';
  if (realpathSync(root.stdout.trim()) !== realpathSync(dest)) return 'destination-not-checkout';
  const result = spawnSync('git', ['-C', dest, 'fetch', '--depth', '1', url], { encoding: 'utf8', timeout: timeoutMs });
  return result.status === 0 && !result.error ? undefined : gitFailure(result.stderr, result.error, result.status);
}

function retrieve(url: string, dest: string, timeoutMs: number): string | undefined {
  if (timeoutMs <= 0) return 'timeout';
  if (existsSync(dest)) return fetchExisting(url, dest, timeoutMs);
  // A clone lives in a private sibling until complete. Publishing a symlink is
  // exclusive: unlike rename, it cannot replace another caller's checkout.
  const privateRoot = mkdtempSync(join(resolve(dest, '..'), '.ref-clone-'));
  const privateRepo = join(privateRoot, 'repo');
  let published = false;
  try {
    const result = spawnSync('git', ['clone', '--depth', '1', '--filter=blob:none', url, privateRepo], { encoding: 'utf8', timeout: timeoutMs });
    if (result.status !== 0 || result.error) return gitFailure(result.stderr, result.error, result.status);
    try {
      symlinkSync(privateRepo, dest, 'dir');
      published = true;
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fetchExisting(url, dest, timeoutMs);
      throw error;
    }
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : 'git-failed';
  } finally {
    if (!published) rmSync(privateRoot, { recursive: true, force: true });
  }
}

function upstreamReason(id: string, upstream: string | undefined, allowFile: boolean): string | undefined {
  if (!upstream) return 'upstream-not-provided';
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return 'upstream-not-https';
  }
  if (url.username || url.password) return 'upstream-has-credentials';
  if (allowFile && url.protocol === 'file:' && !url.search && !url.hash) return undefined;
  const reason = validateMirrorManifest([{ id, upstream }]).refused[0]?.reason;
  return reason === 'credential-url' ? 'upstream-has-credentials' : reason;
}

/** Acquire a reference repository's files; runtime wiring and the nexus query belong to later stages. */
export function ensureRefRepo(id: string, options: EnsureRefRepoOptions): EnsureRefRepoResult {
  const started = Date.now();
  const fellThrough: EnsureRefRepoResult['fellThrough'] = [];
  const finish = (rung: RefRepoRung, path?: string, lastSync?: string): EnsureRefRepoResult => {
    debug.log('grounding.ref', 'ensured', { id, need: options.need, rung, ms: Date.now() - started, fellThrough });
    return { ...(path ? { path } : {}), rung, ...(lastSync !== undefined ? { lastSync } : {}), fellThrough };
  };

  if (!ID_RE.test(id)) {
    fellThrough.push({ rung: 'none', reason: 'bad-id' });
    return finish('none');
  }
  if (options.need === 'question') fellThrough.push({ rung: 'nexus', reason: 'not-available' });

  const dest = join(options.destRoot, id);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const mirrorBase = options.mirrorBase ?? process.env.ELANOUS_REF_MIRROR_URL ?? DEFAULT_MIRROR;
  try {
    mkdirSync(options.destRoot, { recursive: true });
    const mirrorError = retrieve(`${mirrorBase.replace(/\/+$/, '')}/${id}.git`, dest, timeoutMs);
    if (!mirrorError) {
      let lastSync: string | undefined;
      try {
        lastSync = readFileSync(join(dest, '.last-sync'), 'utf8').trim();
      } catch { /* The mirror may not publish a sync marker. */ }
      return finish('mirror', dest, lastSync);
    }
    fellThrough.push({ rung: 'mirror', reason: mirrorError });
  } catch (error) {
    fellThrough.push({ rung: 'mirror', reason: error instanceof Error ? error.message.slice(0, 200) : 'mirror-failed' });
  }

  const reason = upstreamReason(id, options.upstream, options.allowFileUpstream === true);
  if (reason) {
    fellThrough.push({ rung: 'upstream', reason });
    return finish('none');
  }
  try {
    const upstreamError = retrieve(options.upstream!, dest, timeoutMs);
    if (upstreamError) {
      fellThrough.push({ rung: 'upstream', reason: upstreamError });
      return finish('none');
    }
    return finish('upstream', dest);
  } catch (error) {
    fellThrough.push({ rung: 'upstream', reason: error instanceof Error ? error.message.slice(0, 200) : 'upstream-failed' });
    return finish('none');
  }
}
