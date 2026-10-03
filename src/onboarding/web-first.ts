import { spawnSync } from 'node:child_process';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { findNexusLifecycleState } from '../nexus/supervisor/lock.js';
import { isLanReachableBind, isPrivateIpv4, pickLanAddress } from './lan-address.js';
import { isHeadlessEnv } from '../acp/codex-auth.js';
import { runBgLaunch, type BgLaunchResult } from '../cli/bg-launch.js';
import { joinRestHealthUrl, runNexusShow, type NexusShowResult } from '../cli/nexus-show.js';
import { issueSetupLinkToken } from '../auth/setup-link-tokens.js';
import { debug } from '../debug/log.js';
import { browserUnavailableReason } from '../oauth/browser-availability.js';
import type { UserConfig } from '../user-config.js';

export interface WebFirstSetupDeps {
  config: Pick<UserConfig, 'onboarding'>;
  /** Whether a person is at a terminal (stdin TTY). Without one the web path only uses a daemon that is already up. */
  isTty?: boolean;
  terminal?: boolean;
  startedAt?: number;
  showNexus?: () => Promise<NexusShowResult>;
  startDaemon?: () => Promise<BgLaunchResult>;
  probeHealth?: (url: string, timeoutMs: number) => Promise<boolean>;
  issueSetupLinkToken?: () => Promise<string | { token: string }>;
  renderQr?: (link: string) => string | undefined;
  openBrowser?: (link: string) => boolean;
  isHeadless?: () => boolean;
  browserEnv?: NodeJS.ProcessEnv;
  browserPlatform?: NodeJS.Platform;
  httpHost?: () => string | undefined;
  interfaces?: typeof networkInterfaces;
  defaultRouteInterface?: () => string | undefined;
  hostname?: typeof hostname;
  username?: () => string;
  print?: (line: string) => void;
}

const STARTUP_TIMEOUT_MS = 12_000;

async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function setupUrl(pwa: string, token: string): string {
  return `${pwa.replace(/\/app\/?$/, '').replace(/\/$/, '')}/setup#t=${encodeURIComponent(token)}`;
}

export async function runWebFirstSetup(deps: WebFirstSetupDeps): Promise<'link-shown' | 'fallback'> {
  const startedAt = deps.startedAt ?? Date.now();
  const print = deps.print ?? console.log;
  const observe = (event: 'link-shown' | 'fallback', reason?: string, qr = false, browserOpened = false, remote: 'loopback' | 'tailnet' = 'loopback', ms?: number, lan?: 'shown' | 'loopback-bind' | 'no-address', ssh?: boolean) => {
    try { debug.log('onboarding.web-first', event, { ...(reason ? { reason } : {}), qr, browserOpened, remote, ...(ms !== undefined ? { ms } : {}), ...(lan ? { lan, ssh } : {}) }); }
    catch { /* Observability must not block onboarding. */ }
  };
  const fallback = (reason: string): 'fallback' => {
    print(`웹 셋업을 사용할 수 없습니다 (${reason}). 터미널 설정으로 전환합니다.`);
    observe('fallback', reason);
    return 'fallback';
  };
  if (deps.config.onboarding.webFirst === false) { observe('fallback', 'disabled'); return 'fallback'; }
  if (deps.terminal) { observe('fallback', 'terminal'); return 'fallback'; }

  const show = deps.showNexus ?? (() => runNexusShow({ format: 'json', out: { log: () => {}, error: () => {} } }));
  let shown: NexusShowResult | undefined;
  try { shown = await show(); } catch { /* A missing daemon may make inspection fail. */ }
  const running = shown?.status === 'unregistered' || (shown?.status === 'registered' && shown.instance?.alive === true);
  // A script, pipe or CI run never starts a daemon on its own: without a terminal the web path
  // only uses a daemon that already answers health once. (install.sh runs first setup with
  // stdin on /dev/tty, so the install → web path still starts one.)
  if ((deps.isTty ?? (process.stdin.isTTY === true)) !== true) {
    const rest = running ? shown?.urls?.rest.loopback : undefined;
    const up = rest && shown?.urls?.pwa.loopback
      ? await (deps.probeHealth ?? probeHealth)(joinRestHealthUrl(rest), 500) : false;
    if (!up) { observe('fallback', 'non-tty'); return 'fallback'; }
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  if (!running || !shown?.urls?.pwa.loopback) {
    let launch: BgLaunchResult;
    try {
      launch = await (deps.startDaemon ?? (() => runBgLaunch({ out: { log: () => {}, error: () => {} } })))();
    } catch { return fallback('daemon-start-failed'); }
    if (launch.exitCode !== 0) return fallback('daemon-start-failed');
  }

  let healthy = false;
  while (Date.now() < deadline) {
    try {
      shown = await show();
      const live = shown.status === 'unregistered' || (shown.status === 'registered' && shown.instance?.alive === true);
      if (live && shown.urls?.pwa.loopback && shown.urls.rest.loopback) {
        const remaining = deadline - Date.now();
        if (remaining > 0 && await (deps.probeHealth ?? probeHealth)(joinRestHealthUrl(shown.urls.rest.loopback), Math.min(remaining, 500))) {
          healthy = true;
          break;
        }
      }
    } catch { /* A daemon may not have published its URLs yet. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(200, remaining));
  }
  if (!healthy) return fallback(running ? 'daemon-health-unavailable' : 'daemon-health-timeout');

  if (!shown?.urls?.pwa.loopback) return fallback('daemon-unavailable');

  let token: string;
  try {
    const issued = await (deps.issueSetupLinkToken ?? (() => Promise.resolve(issueSetupLinkToken({}))))();
    token = typeof issued === 'string' ? issued : issued?.token;
    if (!token) throw new Error('issuer-missing');
  } catch { return fallback('issuer-missing'); }

  const link = setupUrl(shown.urls.pwa.loopback, token);
  const localUrl = new URL(shown.urls.pwa.loopback);
  const port = localUrl.port || (localUrl.protocol === 'https:' ? '443' : '80');
  let httpHost: string | undefined;
  try { httpHost = (deps.httpHost ?? (() => findNexusLifecycleState()?.runtime?.httpHost))(); }
  catch { /* Unknown bind must not produce a LAN link. */ }
  const confirmedBind = typeof httpHost === 'string';
  const reachable = confirmedBind && isLanReachableBind(httpHost);
  let lanAddress: string | null = null;
  if (reachable && httpHost !== undefined) {
    if (isPrivateIpv4(httpHost.trim())) {
      lanAddress = httpHost.trim();
    } else {
      try {
        lanAddress = pickLanAddress({
          interfaces: (deps.interfaces ?? networkInterfaces)(),
          defaultRouteInterface: deps.defaultRouteInterface,
        });
      } catch { /* Optional LAN discovery must not block the local setup link. */ }
    }
  }
  const lan: 'shown' | 'loopback-bind' | 'no-address' = !confirmedBind ? 'no-address' : !reachable ? 'loopback-bind' : lanAddress ? 'shown' : 'no-address';
  const lanLink = lanAddress ? setupUrl(`http://${lanAddress}:${port}/app/`, token) : undefined;
  const phoneLink = shown.urls.pwa.tailnet ? setupUrl(shown.urls.pwa.tailnet, token) : lanLink;
  print('브라우저에서 셋업을 이어가세요');
  print(link);
  if (lanLink) {
    print(`같은 와이파이의 폰이면: ${lanLink}`);
    print('이 링크는 10분 안에 한 번만 열 수 있습니다');
  } else if (lan === 'loopback-bind') {
    print('같은 와이파이에서 열려면 `elanous nexus run` 을 루프백 없이 다시 띄우세요');
  }
  const linkShownMs = Date.now() - startedAt;
  let qr = false;
  if (phoneLink) {
    try {
      const rendered = (deps.renderQr ?? ((url: string) => {
        const result = spawnSync('qrencode', ['-t', 'ANSIUTF8', url], { encoding: 'utf8' });
        return result.status === 0 ? result.stdout : undefined;
      }))(phoneLink);
      if (rendered) {
        print(rendered);
        print(shown.urls.pwa.tailnet ? '같은 와이파이·tailnet 의 폰 카메라로 스캔하세요' : '같은 와이파이의 폰 카메라로 스캔하세요');
        qr = true;
      }
    } catch { /* QR is optional. */ }
  }
  print('터미널에서 하려면: `elanous setup --terminal`');
  let browserOpened = false;
  const env = deps.browserEnv ?? process.env;
  const ssh = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  const why = browserUnavailableReason(env, deps.browserPlatform ?? process.platform);
  if (why) {
    print(why);
    debug.log('browser.open', 'skipped', { reason: why.includes('ssh') ? 'ssh' : 'no-display' });
  } else if (!(deps.isHeadless ?? (() => isHeadlessEnv(deps.browserEnv ?? process.env)))()) {
    try {
      browserOpened = (deps.openBrowser ?? ((url: string) => {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd' ? 'xdg-open' : undefined;
        return command ? spawnSync(command, [url], { stdio: 'ignore' }).status === 0 : false;
      }))(link);
    } catch { /* The displayed link remains usable. */ }
  }
  if (ssh) {
    try {
      print(`ssh -L ${port}:localhost:${port} ${(deps.username ?? (() => userInfo().username))()}@${(deps.hostname ?? hostname)()}`);
    } catch { /* Optional SSH guidance must not block the setup link. */ }
  }
  observe('link-shown', undefined, qr, browserOpened, shown.urls.pwa.tailnet ? 'tailnet' : 'loopback', linkShownMs, lan, ssh);
  return 'link-shown';
}
