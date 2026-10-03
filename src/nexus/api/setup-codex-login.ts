import { debug } from '../../debug/log.js';
import { loginWithCodexBrowser } from '../../oauth/codex-browser-login.js';
import {
  CODEX_DEVICE_LOGIN_URL,
  exchangeDeviceAuthCode,
  pollDeviceCode,
  requestDeviceCode,
} from '../../oauth/codex.js';
import { expiresAtFromSeconds, saveTokens } from '../../oauth/store.js';
import { getUserConfig, reloadUserConfig, saveUserConfig } from '../../user-config.js';

type Mode = 'browser' | 'device';
type CodexLoginStatus =
  | { state: 'idle' }
  | { state: 'pending'; mode: Mode; authorizeUrl?: string; userCode?: string; verificationUrl?: string }
  | { state: 'ok'; mode: Mode }
  | { state: 'error'; mode: Mode; error: string };

const TIMEOUT_MS = 5 * 60_000;
const SAFE_ERRORS = [
  'timeout', 'authorization-denied', 'browser-unavailable', 'port-unavailable',
  'token-exchange', 'device-code-failed', 'device-poll-failed', 'config-save-failed',
] as const;

type Failure = typeof SAFE_ERRORS[number];
function reason(error: unknown, mode: Mode): Failure {
  const message = error instanceof Error ? error.message : '';
  for (const value of SAFE_ERRORS) if (message === value || message === `codex browser login failed: ${value}`) return value;
  return mode === 'browser' ? 'browser-unavailable' : 'device-poll-failed';
}

interface LoginDeps {
  browser: (openBrowser: (url: string) => boolean) => Promise<unknown>;
  device: (ready: (userCode: string, verificationUrl: string) => void) => Promise<unknown>;
  saveProvider: () => void;
  observe: (event: 'started' | 'ok' | 'error', mode: Mode) => void;
}

async function deviceLogin(ready: (userCode: string, verificationUrl: string) => void): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const fetchImpl = ((input, init) => fetch(input, { ...init, signal: controller.signal })) as typeof fetch;
  try {
    let code: Awaited<ReturnType<typeof requestDeviceCode>>;
    try { code = await requestDeviceCode({ fetchImpl }); }
    catch { throw new Error('device-code-failed'); }
    if (controller.signal.aborted) throw new Error('timeout');
    ready(code.user_code, code.verification_uri || CODEX_DEVICE_LOGIN_URL);
    const interval = Math.max(3000, (code.interval ?? 0) * 1000);
    const deadline = Date.now() + TIMEOUT_MS;
    while (!controller.signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
      if (controller.signal.aborted || Date.now() >= deadline) break;
      let result: Awaited<ReturnType<typeof pollDeviceCode>>;
      try { result = await pollDeviceCode(code.device_auth_id, code.user_code, { fetchImpl }); }
      catch { throw new Error('device-poll-failed'); }
      if (!result) continue;
      let token: Awaited<ReturnType<typeof exchangeDeviceAuthCode>>;
      try { token = await exchangeDeviceAuthCode(result.authorization_code, result.code_verifier, { fetchImpl }); }
      catch { throw new Error('token-exchange'); }
      if (controller.signal.aborted) break;
      saveTokens('openai-codex', {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        ...(token.id_token ? { idToken: token.id_token } : {}),
        expiresAt: expiresAtFromSeconds(token.expires_in),
        scope: token.scope,
        tokenType: token.token_type ?? 'Bearer',
      }, { authMode: 'chatgpt' });
      return;
    }
    throw new Error('timeout');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function saveCodexProvider(): void {
  const cur = getUserConfig();
  saveUserConfig({ ...cur, llm: { ...cur.llm, provider: 'openai-codex', apiKey: undefined, baseUrl: undefined, model: undefined } });
  reloadUserConfig();
}

const defaultDeps: LoginDeps = {
  browser: (openBrowser) => loginWithCodexBrowser({ openBrowser, timeoutMs: TIMEOUT_MS }),
  device: deviceLogin,
  saveProvider: saveCodexProvider,
  observe: (event, mode) => { debug.log('setup.codex-login', event, { mode }); },
};

function json(body: CodexLoginStatus | { error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

/** One in-process login survives leaving or reloading the setup page. */
export function createCodexLoginHandlers(deps: LoginDeps = defaultDeps) {
  let status: CodexLoginStatus = { state: 'idle' };
  let preparing: Promise<void> | undefined;
  let generation = 0;

  const get = (): Response => json(status);

  const post = async (req: Request): Promise<Response> => {
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: 'invalid-json' }, 400); }
    const mode = body && typeof body === 'object' && 'mode' in body ? body.mode : undefined;
    if (mode !== 'browser' && mode !== 'device') return json({ error: 'invalid-mode' }, 400);
    // Same method again → the login already in flight. A different method → start over; the older
    // attempt's result is ignored (generation). Browser → device is the recovery path when a popup
    // was blocked; device needs no local port, so it never collides with the browser's callback server.
    if (status.state === 'pending' && status.mode === mode) {
      if (preparing) await preparing;
      return json(status);
    }

    status = { state: 'pending', mode };
    const attempt = ++generation;
    deps.observe('started', mode);
    let resolveReady!: () => void;
    preparing = new Promise<void>((resolve) => { resolveReady = resolve; });
    const ready = (fields: Pick<Extract<CodexLoginStatus, { state: 'pending' }>, 'authorizeUrl' | 'userCode' | 'verificationUrl'>) => {
      if (generation === attempt && status.state === 'pending' && status.mode === mode) {
        status = { ...status, ...fields };
        resolveReady();
      }
    };
    void (async () => {
      try {
        if (mode === 'browser') {
          await deps.browser((url) => { ready({ authorizeUrl: url }); return true; });
        } else {
          await deps.device((userCode, verificationUrl) => ready({ userCode, verificationUrl }));
        }
        if (generation !== attempt) return;
        try { deps.saveProvider(); } catch { throw new Error('config-save-failed'); }
        status = { state: 'ok', mode };
        deps.observe('ok', mode);
      } catch (error) {
        if (generation !== attempt) return;
        status = { state: 'error', mode, error: reason(error, mode) };
        deps.observe('error', mode);
      } finally {
        resolveReady();
        if (generation === attempt) preparing = undefined;
      }
    })();
    await preparing;
    return json(status);
  };
  return { get, post };
}

const login = createCodexLoginHandlers();
export const handleSetupCodexLoginGet = login.get;
export const handleSetupCodexLoginPost = login.post;
