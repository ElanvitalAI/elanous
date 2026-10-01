import { spawnSync } from 'node:child_process';
import { isHeadlessEnv } from '../acp/codex-auth.js';
import { runNexusShow, type NexusShowResult } from '../cli/nexus-show.js';
import { debug } from '../debug/log.js';
import type { UserConfig } from '../user-config.js';

export interface WebFirstSetupDeps {
  config: Pick<UserConfig, 'onboarding'>;
  isTty?: boolean;
  terminal?: boolean;
  showNexus?: () => Promise<NexusShowResult>;
  issueSetupLinkToken?: () => Promise<string | { token: string }>;
  renderQr?: (link: string) => string | undefined;
  openBrowser?: (link: string) => boolean;
  isHeadless?: () => boolean;
  print?: (line: string) => void;
}

function setupUrl(pwa: string, token: string): string {
  return `${pwa.replace(/\/app\/?$/, '').replace(/\/$/, '')}/setup#t=${encodeURIComponent(token)}`;
}

export async function runWebFirstSetup(deps: WebFirstSetupDeps): Promise<'link-shown' | 'fallback'> {
  const observe = (event: 'link-shown' | 'fallback', reason?: string, qr = false, browserOpened = false, remote: 'loopback' | 'tailnet' = 'loopback') => {
    try { debug.log('onboarding.web-first', event, { ...(reason ? { reason } : {}), qr, browserOpened, remote }); }
    catch { /* Observability must not block onboarding. */ }
  };
  if (deps.config.onboarding.webFirst !== true) { observe('fallback', 'disabled'); return 'fallback'; }
  if ((deps.isTty ?? (process.stdin.isTTY === true)) !== true) { observe('fallback', 'non-tty'); return 'fallback'; }
  if (deps.terminal) { observe('fallback', 'terminal'); return 'fallback'; }

  let shown: NexusShowResult;
  try {
    shown = await (deps.showNexus ?? (() => runNexusShow({ format: 'json', out: { log: () => {}, error: () => {} } })))();
  } catch { observe('fallback', 'daemon-unavailable'); return 'fallback'; }
  const running = shown.status === 'unregistered' || (shown.status === 'registered' && shown.instance?.alive === true);
  if (!running || !shown.urls?.pwa.loopback) { observe('fallback', 'daemon-unavailable'); return 'fallback'; }

  let token: string;
  try {
    const issue = deps.issueSetupLinkToken ?? (async () => {
      const modulePath = '../auth/setup-link-token.js';
      const mod = await import(modulePath) as { issueSetupLinkToken?: (options: Record<string, never>) => Promise<string | { token: string }> };
      if (typeof mod.issueSetupLinkToken !== 'function') throw new Error('issuer-missing');
      return mod.issueSetupLinkToken({});
    });
    const issued = await issue();
    token = typeof issued === 'string' ? issued : issued?.token;
    if (!token) throw new Error('issuer-missing');
  } catch { observe('fallback', 'issuer-missing'); return 'fallback'; }

  const print = deps.print ?? console.log;
  const link = setupUrl(shown.urls.pwa.loopback, token);
  const phoneLink = shown.urls.pwa.tailnet ? setupUrl(shown.urls.pwa.tailnet, token) : undefined;
  print('브라우저에서 셋업을 이어가세요');
  print(link);
  let qr = false;
  if (phoneLink) {
    try {
      const rendered = (deps.renderQr ?? ((url: string) => {
        const result = spawnSync('qrencode', ['-t', 'ANSIUTF8', url], { encoding: 'utf8' });
        return result.status === 0 ? result.stdout : undefined;
      }))(phoneLink);
      if (rendered) {
        print(rendered);
        print('같은 와이파이·tailnet 의 폰 카메라로 스캔하세요');
        qr = true;
      }
    } catch { /* QR is optional. */ }
  }
  print('터미널에서 하려면: `elanous setup --terminal`');
  let browserOpened = false;
  if (!(deps.isHeadless ?? (() => isHeadlessEnv(process.env)))()) {
    try {
      browserOpened = (deps.openBrowser ?? ((url: string) => {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd' ? 'xdg-open' : undefined;
        return command ? spawnSync(command, [url], { stdio: 'ignore' }).status === 0 : false;
      }))(link);
    } catch { /* The displayed link remains usable. */ }
  }
  observe('link-shown', undefined, qr, browserOpened, phoneLink ? 'tailnet' : 'loopback');
  return 'link-shown';
}
