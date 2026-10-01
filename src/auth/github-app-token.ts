import { createHash, createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** Scoped requests always mint anew; the returned expiry comes from GitHub's response. */
export function githubInstallationCredential(deps: GithubAutomationTokenDeps = {}): { token: string; expires_at: string } | null {
  let path: string;
  // The App credential is machine-level (like `gh auth` in ~/.config/gh), not per universe: a tree-derived test
  // universe resolves its config dir to `<tree>/.elanous-test`, where the file never is — 09-29 #21879 was inert there.
  // Order: explicit path → this universe's config dir → the prod root `~/.elanous`.
  try {
    const rel = join('secrets', 'github-app', 'app.json');
    const own = join(getElanousConfigDir(), rel);
    // An explicit config-dir override (tests · `--config-dir`) is a deliberate boundary — never reach past it.
    // ELANOUS_GITHUB_APP_CONFIG_PATH pins the machine-level fallback (the bun test preload points it at nothing,
    // so tests never mint); an explicit config-dir override still wins.
    const pinned = process.env.ELANOUS_GITHUB_APP_CONFIG_PATH?.trim();
    path = deps.configPath ?? (getElanousConfigDirOverride() ? own : pinned || (existsSync(own) ? own : join(prodInstanceRoot(), rel)));
  }
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
