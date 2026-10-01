import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { debug } from '../debug/log.js';
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL } from './codex.js';
import { expiresAtFromSeconds, saveTokens, type ProviderAuthState } from './store.js';

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_PORT = 1455;
const TIMEOUT_MS = 5 * 60 * 1000;

export interface CodexBrowserLoginOpts {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
  preferredPort?: number;
  mirrorCodex?: boolean;
}

export function browserLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    // Use the Windows URL handler directly; cmd.exe expands & and % even inside OAuth URLs.
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}

/** A launcher that exits non-zero this soon has failed; one still running (or exiting 0) handed the URL off. */
const LAUNCH_GRACE_MS = 1_000;

function openBrowser(url: string): Promise<boolean> {
  const { command, args } = browserLaunchCommand(url);
  return new Promise(resolve => {
    let settled = false;
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.once('error', () => settle(false));
      child.once('exit', code => settle(code === 0));
      child.once('spawn', () => {
        const grace = setTimeout(() => { child.unref(); settle(true); }, LAUNCH_GRACE_MS);
        grace.unref?.();
        child.once('exit', () => clearTimeout(grace));
      });
    } catch { settle(false); }
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Local OAuth callback, independent of a bundled or PATH Codex executable. */
export async function loginWithCodexBrowser(opts: CodexBrowserLoginOpts = {}): Promise<ProviderAuthState> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  let port = opts.preferredPort ?? DEFAULT_PORT;
  let resolveCallback!: (value: ProviderAuthState) => void;
  let rejectCallback!: (reason: Error) => void;
  const callback = new Promise<ProviderAuthState>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  void callback.catch(() => {});
  let settled = false;
  let handling = false;
  const tokenAbort = new AbortController();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') {
      res.writeHead(404).end();
      return;
    }
    debug.log('oauth.codex-browser', 'callback', { port });
    if (handling || settled) { res.writeHead(409).end(); return; }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('Invalid login state.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) {
      res.writeHead(400).end('Login failed. Return to the terminal.');
      rejectCallback(new Error('authorization-denied'));
      return;
    }
    handling = true;
    void (async () => {
      try {
        const response = await (opts.fetchImpl ?? fetch)(CODEX_OAUTH_TOKEN_URL, {
          method: 'POST',
          signal: tokenAbort.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code, redirect_uri: `http://localhost:${port}/auth/callback`,
            client_id: CODEX_OAUTH_CLIENT_ID, code_verifier: verifier,
          }).toString(),
        });
        if (!response.ok) throw new Error('token-exchange');
        const token = await response.json() as {
          access_token?: string; refresh_token?: string; id_token?: string;
          expires_in?: number; scope?: string; token_type?: string;
        };
        if (!token.access_token || !token.refresh_token) throw new Error('token-exchange');
        if (settled) { res.writeHead(410).end(); return; }
        const saved = saveTokens('openai-codex', {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          ...(token.id_token ? { idToken: token.id_token } : {}),
          expiresAt: expiresAtFromSeconds(token.expires_in),
          scope: token.scope,
          tokenType: token.token_type ?? 'Bearer',
        }, { authMode: 'chatgpt', mirrorCodex: opts.mirrorCodex });
        debug.log('oauth.codex-browser', 'exchanged', { port });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<!doctype html><html lang="ko"><meta charset="utf-8"><body>로그인됨 — 터미널로 돌아가세요</body></html>');
        resolveCallback(saved);
      } catch {
        res.writeHead(400).end('Login failed. Return to the terminal.');
        rejectCallback(new Error('token-exchange'));
      }
    })();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => rejectCallback(new Error('cancelled'));
  const onExit = () => server.close();
  const onServerError = () => rejectCallback(new Error('port-unavailable'));
  let listening = false;
  try {
    try { await listen(server, port); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0) throw err;
      await listen(server, 0);
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port-unavailable');
    listening = true;
    port = address.port;
    server.on('error', onServerError);
    process.once('SIGINT', cancel);
    process.once('exit', onExit);
    timer = setTimeout(() => rejectCallback(new Error('timeout')), opts.timeoutMs ?? TIMEOUT_MS);
    const authorize = new URL(AUTHORIZE_URL);
    for (const [key, value] of Object.entries({
      client_id: CODEX_OAUTH_CLIENT_ID, redirect_uri: `http://localhost:${port}/auth/callback`,
      response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state,
      scope: 'openid profile email offline_access', id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs',
    })) authorize.searchParams.set(key, value);
    debug.log('oauth.codex-browser', 'started', { port });
    if (!await (opts.openBrowser ?? openBrowser)(authorize.toString())) throw new Error('browser-unavailable');
    return await callback;
  } catch (err) {
    const reason = err instanceof Error && ['timeout', 'cancelled', 'browser-unavailable', 'authorization-denied', 'token-exchange'].includes(err.message)
      ? err.message : 'port-unavailable';
    debug.log('oauth.codex-browser', 'failed', { port, reason });
    throw new Error(`codex browser login failed: ${reason}`);
  } finally {
    settled = true;
    tokenAbort.abort();
    if (timer) clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('exit', onExit);
    if (listening) server.close();
    server.off('error', onServerError);
  }
}
