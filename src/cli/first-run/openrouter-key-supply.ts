import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { scanCredentialImports } from '../../setup/cred-import-scan.js';
import { getSecretAsync, listCredentialSlotsAsync, selectBackendFromConfig } from '../../nexus/config/secrets/index.js';
import { credentialRegistrationCompleted, issueCredentialRegistrationLinkToken, revokeCredentialRegistrationLinkToken } from '../../auth/setup-link-tokens.js';
import { renderTerminalQr } from '../../onboarding/web-first.js';
import { resolveNexusPwa } from '../../nexus/pwa-resolution.js';
import { browserLaunchCommand } from '../../oauth/codex-browser-login.js';
import { isHeadlessEnv } from '../../acp/codex-auth.js';
import type { SetupKeysIO, FirstRunProviderSetupOptions } from '../setup-keys.js';

const SLOT = 'cred:openrouter.api_key';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const openRouterKeySuffix = (value: string): string => value.length <= 4 ? '••••' : value.slice(-4);

export interface OpenRouterKeyCandidate { source: string; lastFour: string; read(): string }

export function scanOpenRouterKeyCandidates(options: FirstRunProviderSetupOptions): OpenRouterKeyCandidate[] {
  const candidates: OpenRouterKeyCandidate[] = [];
  const envValue = (options.env ?? process.env).OPENROUTER_API_KEY;
  if (envValue?.trim()) candidates.push({ source: '환경변수 OPENROUTER_API_KEY', lastFour: openRouterKeySuffix(envValue), read: () => envValue.trim() });
  const scan = scanCredentialImports({ homeDir: options.homeDir, cwd: options.cwd, configPath: options.configPath, existingSlots: [] });
  for (const proposal of scan.proposals.filter(row => row.slot === SLOT)) {
    const value = scan.readSelected([proposal.id])[SLOT];
    if (!value) continue;
    const source = proposal.sourcePath.includes('#llm.') ? 'Elanous 설정'
      : /\.(?:zshrc|bashrc|bash_profile|profile)$/.test(proposal.sourcePath) ? '셸 시작 파일' : '.env 파일';
    candidates.push({ source, lastFour: openRouterKeySuffix(value), read: () => value });
  }
  return candidates;
}

async function launchBrowser(url: string): Promise<boolean> {
  const { command, args } = browserLaunchCommand(url);
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

/** CLI PKCE uses loopback on a GUI host. OpenRouter explicitly supports no-callback
 * headless mode: after authorization its page displays a one-use code for terminal input.
 * Source: https://openrouter.ai/docs/guides/overview/auth/oauth (Headless Apps). */
export async function openRouterPkce(io: Pick<SetupKeysIO, 'ask' | 'askSecret' | 'print'>, options: {
  headless: boolean; fetch?: typeof fetch; openBrowser?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  let server: ReturnType<typeof createServer> | undefined;
  let callbackUrl: string | undefined;
  let awaitCode: Promise<string> | undefined;
  let callbackTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!options.headless) {
      awaitCode = new Promise<string>((resolve, reject) => {
        server = createServer((request, response) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (request.method !== 'GET' || url.pathname !== '/openrouter/callback') { response.writeHead(404).end(); return; }
          if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid state'); return; }
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) { response.writeHead(400).end('Authorization failed'); reject(new Error('authorization-failed')); return; }
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            .end('<!doctype html><meta charset="utf-8"><p>OpenRouter 연결 완료. 터미널로 돌아가세요.</p>');
          resolve(code);
        });
      });
      await new Promise<void>((resolve, reject) => server!.listen(0, '127.0.0.1', () => resolve()).once('error', reject));
      const address = server?.address();
      if (!address || typeof address === 'string') throw new Error('callback-unavailable');
      callbackUrl = `http://127.0.0.1:${address.port}/openrouter/callback`;
    }
    const authorize = new URL('https://openrouter.ai/auth');
    if (callbackUrl) authorize.searchParams.set('callback_url', callbackUrl);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('key_label', 'Elanous');
    if (callbackUrl) authorize.searchParams.set('state', state);
    io.print(`OpenRouter 로그인: ${authorize.toString()}`);
    if (options.headless) io.print('브라우저에서 승인하면 승인 화면에 표시된 일회용 코드를 터미널에 숨김 입력하세요.');
    if (!options.headless) await (options.openBrowser ?? launchBrowser)(authorize.toString());
    const code = options.headless
      ? io.askSecret ? (await io.askSecret('브라우저에 표시된 일회용 인증 코드 (Enter=취소): ')).trim() : ''
      : await Promise.race([awaitCode!, new Promise<never>((_, reject) => {
        callbackTimer = setTimeout(() => reject(new Error('timeout')), options.timeoutMs ?? 600_000);
      })]);
    if (!code) return undefined;
    const response = await (options.fetch ?? fetch)(EXCHANGE_URL, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { key?: unknown };
    return typeof payload.key === 'string' && payload.key.trim() && !/[\r\n\0]/.test(payload.key) ? payload.key : undefined;
  } catch { return undefined; }
  finally { if (callbackTimer) clearTimeout(callbackTimer); server?.close(); }
}

export interface PhoneRegistrationOptions extends FirstRunProviderSetupOptions {
  resolvePwa?: typeof resolveNexusPwa;
  issueLink?: typeof issueCredentialRegistrationLinkToken;
  revokeLink?: typeof revokeCredentialRegistrationLinkToken;
  renderQr?: typeof renderTerminalQr;
  registrationComplete?: typeof credentialRegistrationCompleted;
}

export async function registerOpenRouterByPhone(io: Pick<SetupKeysIO, 'ask' | 'print'>, options: PhoneRegistrationOptions): Promise<boolean> {
  const pwa = (options.resolvePwa ?? resolveNexusPwa)();
  if (!('url' in pwa) || pwa.source !== 'tailnet') {
    io.print('폰 등록에는 실행 중인 Nexus PWA의 tailnet 공유 주소가 필요합니다. eln nexus pwa share enable 후 다시 시도하세요.');
    return false;
  }
  const issued = (options.issueLink ?? issueCredentialRegistrationLinkToken)(SLOT);
  const url = new URL('/app/credentials/register/claim/', pwa.url);
  url.hash = `t=${issued.token}`;
  try {
    const qr = (options.renderQr ?? renderTerminalQr)(url.toString());
    if (!qr) return false;
    io.print('폰으로 QR을 스캔해 OpenRouter 키를 등록하세요. 링크는 10분 후 만료됩니다.');
    io.print(qr);
    await io.ask('등록을 마치면 Enter: ');
    if (!(options.registrationComplete ?? credentialRegistrationCompleted)(issued.token, SLOT)) return false;
    (options.initializeCredentialBackend ?? selectBackendFromConfig)();
    const slots = await (options.listCredentialSlots ?? listCredentialSlotsAsync)();
    return slots.some(slot => slot.id === SLOT && slot.present);
  } finally { (options.revokeLink ?? revokeCredentialRegistrationLinkToken)(issued.token); }
}

export async function existingOpenRouterKey(): Promise<string | undefined> {
  selectBackendFromConfig();
  return getSecretAsync(SLOT);
}

export function openRouterHeadless(options: FirstRunProviderSetupOptions): boolean {
  return options.isHeadless?.() ?? isHeadlessEnv(options.env);
}
