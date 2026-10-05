import { createHash, createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';

interface AppConfig { id: number; installation_id: number; pem: string }
interface TokenResponse { token?: unknown; expires_at?: unknown }
export interface GithubInstallationTokenScope { repository: string }
interface InstallationTokenRequest {
  repositories: [string];
  permissions: { contents: 'write'; pull_requests: 'write' };
}

/** Synchronous HTTP seam: CmdRunner must remain synchronous for existing callers. */
export interface GithubAutomationTokenDeps {
  configPath?: string;
  now?: () => number;
  scope?: GithubInstallationTokenScope;
  fetch?: (url: string, jwt: string, body?: InstallationTokenRequest) => TokenResponse;
}

const REFRESH_MARGIN_MS = 10 * 60_000;
const JWT_LIFETIME_SECONDS = 9 * 60;
let cached: { fingerprint: string; token: string; expiresAt: number } | undefined;

function requestToken(url: string, jwt: string, body?: InstallationTokenRequest): TokenResponse {
  const response = spawnSync('curl', [
    '--silent', '--show-error', '--fail', '--max-time', '30', '--request', 'POST',
    '--header', 'Accept: application/vnd.github+json',
    '--header', '@-',
    '--header', 'X-GitHub-Api-Version: 2022-11-28',
    ...(body ? ['--header', 'Content-Type: application/json', '--data-raw', JSON.stringify(body)] : []),
    url,
  ], { encoding: 'utf8', timeout: 35_000, input: `Authorization: Bearer ${jwt}\n`, env: process.env });
  // Never expose curl's stderr: it may contain request credentials.
  if (response.error || response.status !== 0) throw new Error('http-failed');
  return JSON.parse(response.stdout) as TokenResponse;
}

/** Missing App config is a no-op; an unusable configured App falls back to the caller's gh credentials. */
export function githubAutomationToken(deps: GithubAutomationTokenDeps = {}): string | null {
  return githubInstallationCredential(deps)?.token ?? null;
}

/** The App credential is machine-level (like `gh auth` in ~/.config/gh), not per universe: a tree-derived test
 *  universe resolves its config dir to `<tree>/.elanous-test`, where the file never is — 09-29 #21879 was inert there.
 *  Order: explicit path → this universe's config dir → the prod root `~/.elanous`.
 *  An explicit config-dir override (tests · `--config-dir`) is a deliberate boundary — never reach past it.
 *  ELANOUS_GITHUB_APP_CONFIG_PATH pins the machine-level fallback (the bun test preload points it at nothing,
 *  so tests never mint); an explicit config-dir override still wins. */
function appConfigPath(explicit?: string): string {
  const rel = join('secrets', 'github-app', 'app.json');
  const own = join(getElanousConfigDir(), rel);
  const pinned = process.env.ELANOUS_GITHUB_APP_CONFIG_PATH?.trim();
  return explicit ?? (getElanousConfigDirOverride() ? own : pinned || (existsSync(own) ? own : join(prodInstanceRoot(), rel)));
}

/** Scoped requests always mint anew; the returned expiry comes from GitHub's response. */
export function githubInstallationCredential(deps: GithubAutomationTokenDeps = {}): { token: string; expires_at: string } | null {
  let path: string;
  try { path = appConfigPath(deps.configPath); }
  catch {
    try { debug.log('auth.github-app', 'token-failed', { reason: 'config-path-failed' }); } catch { /* fail open */ }
    return null;
  }
  let configText: string;
  try { configText = readFileSync(path, 'utf8'); }
  catch (error) {
    cached = undefined;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    try { debug.log('auth.github-app', 'token-failed', { reason: 'config-read-failed' }); } catch { /* fail open */ }
    return null;
  }
  try {
    const now = (deps.now ?? Date.now)();
    const config = JSON.parse(configText) as AppConfig;
    if (!config || !Number.isSafeInteger(config.id) || config.id <= 0 ||
        !Number.isSafeInteger(config.installation_id) || config.installation_id <= 0 ||
        typeof config.pem !== 'string' || !config.pem) throw new Error('invalid-config');
    const pem = isAbsolute(config.pem) ? readFileSync(config.pem, 'utf8')
      : config.pem.includes('-----BEGIN') ? config.pem
      : readFileSync(join(dirname(path), config.pem), 'utf8');
    const repository = deps.scope?.repository;
    if (deps.scope && (typeof repository !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(repository) || repository === '.' || repository === '..')) {
      throw new Error('invalid-repository');
    }
    const request: InstallationTokenRequest | undefined = repository
      ? { repositories: [repository], permissions: { contents: 'write', pull_requests: 'write' } }
      : undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify([path, config.id, config.installation_id, pem])).digest('hex');
    if (!request && cached?.fingerprint === fingerprint && now < cached.expiresAt - REFRESH_MARGIN_MS) return { token: cached.token, expires_at: new Date(cached.expiresAt).toISOString() };
    if (!request) cached = undefined;
    const issuedAt = Math.floor(now / 1000) - 60;
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: issuedAt, exp: issuedAt + JWT_LIFETIME_SECONDS, iss: String(config.id) })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(pem, 'base64url')}`;
    const url = `https://api.github.com/app/installations/${config.installation_id}/access_tokens`;
    const response = (deps.fetch ?? requestToken)(url, jwt, request);
    const expiresAt = typeof response.expires_at === 'string' ? Date.parse(response.expires_at) : NaN;
    if (typeof response.token !== 'string' || !response.token || !Number.isFinite(expiresAt) ||
        expiresAt <= now + REFRESH_MARGIN_MS) throw new Error('invalid-response');
    if (!request) cached = { fingerprint, token: response.token, expiresAt };
    try { debug.log('auth.github-app', 'token-minted', { installationId: config.installation_id, expiresAt: new Date(expiresAt).toISOString() }); }
    catch { /* logging must not undo a valid token */ }
    return { token: response.token, expires_at: response.expires_at as string };
  } catch {
    if (!deps.scope) cached = undefined;
    // Do not log exceptions: crypto/HTTP failures can include key or bearer material.
    try { debug.log('auth.github-app', 'token-failed', { reason: 'mint-failed' }); } catch { /* fail open */ }
    return null;
  }
}

/** PODCRED1 (10-05): simultaneous launches each minted a scoped token in the same second and the Pods' logins died
 *  together (12:49Z · 5 in 2 s). Concurrent issuers for one repository — across processes — share one mint: the first
 *  takes a lock and mints, the others wait and reuse that result while it is recent and long-lived. */
export interface CoalescedInstallationOptions {
  cacheDir?: string;
  /** Reuse a token minted at most this long ago. */
  windowMs?: number;
  /** …and only while it still has this much life left. */
  minRemainingMs?: number;
  /** Skip reuse (still mint under the lock and publish the result) — for a retry after the shared token failed. */
  fresh?: boolean;
  lockWaitMs?: number;
  staleLockMs?: number;
  now?: () => number;
  sleepSync?: (ms: number) => void;
  mint?: (scope: GithubInstallationTokenScope) => { token: string; expires_at: string } | null;
}

const COALESCE_WINDOW_MS = 120_000;
const COALESCE_MIN_REMAINING_MS = 50 * 60_000;

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function coalescedInstallationCredential(scope: GithubInstallationTokenScope, opts: CoalescedInstallationOptions = {}): { token: string; expires_at: string } | null {
  const now = opts.now ?? Date.now;
  const mint = opts.mint ?? ((s: GithubInstallationTokenScope) => githubInstallationCredential({ scope: s }));
  const windowMs = opts.windowMs ?? COALESCE_WINDOW_MS;
  const minRemainingMs = opts.minRemainingMs ?? COALESCE_MIN_REMAINING_MS;
  const sleepSync = opts.sleepSync ?? blockingSleep;
  // Same boundary as the App config: a test process (or config-dir override) never writes the operational root.
  if (!opts.cacheDir && (process.env.NODE_ENV === 'test' || process.env.ELANOUS_TEST_HOME)) return mint(scope);
  let dir: string;
  let identity: string;
  try {
    const configPath = appConfigPath();
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
    identity = JSON.stringify([configPath, config.id, config.installation_id]);
    dir = opts.cacheDir ?? join(getElanousConfigDirOverride() ? getElanousConfigDir() : prodInstanceRoot(), 'cache', 'github-app-scoped');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    if (!opts.cacheDir) return mint(scope);
    dir = opts.cacheDir;
    identity = 'injected';
  }
  // Keyed by App installation and repository, so another App (another universe or owner) never reuses this token.
  const key = createHash('sha256').update(`${identity}\0${scope.repository}`).digest('hex').slice(0, 32);
  const file = join(dir, `${key}.json`);
  const lock = join(dir, `${key}.lock`);
  let waitStart: number | undefined;
  const reuse = (): { token: string; expires_at: string } | null => {
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown; expiresAt?: unknown; mintedAt?: unknown };
      const t = now();
      if (typeof entry.token === 'string' && entry.token && typeof entry.expiresAt === 'number' && typeof entry.mintedAt === 'number'
        && t - entry.mintedAt <= windowMs && entry.expiresAt - t >= minRemainingMs) {
        try { debug.log('auth.github-app', 'token-coalesced', { ageMs: t - entry.mintedAt, expiresAt: new Date(entry.expiresAt).toISOString(), ...(waitStart === undefined ? {} : { waitedMs: t - waitStart }) }); } catch { /* fail open */ }
        return { token: entry.token, expires_at: new Date(entry.expiresAt).toISOString() };
      }
    } catch { /* no usable entry */ }
    return null;
  };
  const hit = opts.fresh ? null : reuse();
  if (hit) return hit;
  waitStart = now();
  const deadline = waitStart + (opts.lockWaitMs ?? 15_000);
  let locked = false;
  for (;;) {
    try { mkdirSync(lock); locked = true; break; }
    catch {
      try { if (now() - statSync(lock).mtimeMs > (opts.staleLockMs ?? 30_000)) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (now() >= deadline) break;
      sleepSync(200);
      const waited = opts.fresh ? null : reuse();
      if (waited) return waited;
    }
  }
  if (!locked) { try { debug.log('auth.github-app', 'token-coalesce-lock-timeout', { waitedMs: now() - (waitStart ?? now()) }); } catch { /* fail open */ } }
  try {
    const again = opts.fresh ? null : reuse();
    if (again) return again;
    const minted = mint(scope);
    const expiresAt = minted ? Date.parse(minted.expires_at) : NaN;
    if (minted && Number.isFinite(expiresAt)) {
      const temp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify({ token: minted.token, expiresAt, mintedAt: now() }), { mode: 0o600 });
        renameSync(temp, file);
      } catch { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
    }
    return minted;
  } finally {
    if (locked) { try { rmSync(lock, { recursive: true, force: true }); } catch { /* stale-lock rule recovers */ } }
  }
}
