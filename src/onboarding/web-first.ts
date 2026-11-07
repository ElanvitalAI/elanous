import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { hostname, networkInterfaces, userInfo } from 'node:os';
import { findNexusLifecycleState } from '../nexus/supervisor/lock.js';
import { isLanReachableBind, isPrivateIpv4, pickLanAddress } from './lan-address.js';
import { isHeadlessEnv } from '../acp/codex-auth.js';
import { runBgLaunch, type BgLaunchResult } from '../cli/bg-launch.js';
import { joinRestHealthUrl, runNexusShow, type NexusShowResult } from '../cli/nexus-show.js';
import { issueSetupLinkToken } from '../auth/setup-link-tokens.js';
import { debug } from '../debug/log.js';
import { detectLocale, type Locale } from '../expression/locale.js';
import { browserUnavailableReason } from '../oauth/browser-availability.js';
import type { UserConfig } from '../user-config.js';

export interface WebFirstSetupDeps {
  config: Pick<UserConfig, 'onboarding'>;
  /** Whether a person is at a terminal (stdin TTY). */
  isTty?: boolean;
  terminal?: boolean;
  /** Set true when this entry owns first-run launch and may start a missing daemon without a TTY. */
  startIfMissing?: boolean;
  startedAt?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Locale for user-facing wording; defaults to the shared ambient decision (detectLocale). */
  locale?: Locale;
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

// The onboarding flow waits at most twelve seconds for a daemon before falling back to terminal setup.
const STARTUP_TIMEOUT_MS = 12_000;
const require = createRequire(import.meta.url);

export function renderTerminalQr(link: string): string | undefined {
  try {
    const qr = require('qrcode-terminal') as {
      generate: (value: string, options: { small: boolean }, callback: (value: string) => void) => void;
    };
    let rendered: string | undefined;
    qr.generate(link, { small: true }, value => { rendered = value; });
    return rendered;
  } catch { return undefined; }
}

/** User-facing web-first fallback wording, routed by the shared locale decision (detectLocale). */
const WEB_FIRST_TEXT = {
  ko: {
    unavailable: (reason: string) => `웹 셋업을 사용할 수 없습니다 (${reason}). 터미널 설정으로 전환합니다.`,
    daemonNotRunning: '웹 셋업 데몬이 아직 실행되지 않았습니다 · 터미널 설정을 계속합니다',
    daemonHealthUnavailable: '웹 셋업 데몬은 실행 중이지만 헬스 확인에 실패했습니다 · 터미널 설정을 계속합니다',
    daemonEndpointUnavailable: '웹 셋업 데몬은 실행 중이지만 셋업 주소를 확인할 수 없습니다 · 터미널 설정을 계속합니다',
    daemonInspectionUnavailable: '웹 셋업 데몬 상태를 확인하지 못했습니다 · 터미널 설정을 계속합니다',
    startingDaemon: '웹 셋업을 위해 데몬을 시작합니다.',
    continueInBrowser: '브라우저에서 셋업을 이어가세요',
    phoneOnSameWifi: (link: string) => `같은 와이파이의 폰이면: ${link}`,
    linkSingleUse: '이 링크는 10분 안에 한 번만 열 수 있습니다',
    sameWifiRestart: '같은 와이파이에서 열려면 `elanous nexus run` 을 루프백 없이 다시 띄우세요',
    scanTailnet: 'tailnet에 연결된 기기의 카메라로 스캔하세요',
    scanSameWifi: '같은 와이파이의 폰 카메라로 스캔하세요',
    scanAfterTunnel: 'SSH -L 을 실행한 뒤 이 기기의 브라우저에서 여세요',
    tailnetLink: (link: string) => `어디서든(Tailscale): ${link}`,
    reachability: (browser: 'available' | 'unavailable' | 'unknown', lan: 'available' | 'unavailable' | 'unknown', tailnet: boolean) => `접속 경로: 이 기기 브라우저 ${browser === 'available' ? '사용 가능' : browser === 'unknown' ? '조회 미확인' : '현재 세션에서 사용 불가'} · 같은 네트워크 ${lan === 'available' ? '주소 있음' : lan === 'unknown' ? '조회 미확인' : '주소 없음'} · Tailscale ${tailnet ? '주소 있음' : '주소 없음'} · 외부 공개 여부 미확인`,
    terminalInstead: '링크가 열리지 않으면 터미널 설정에서 계속하세요: `elanous setup --terminal`',
  },
  en: {
    unavailable: (reason: string) => `web setup is unavailable (${reason}); switching to terminal setup.`,
    daemonNotRunning: 'web setup daemon is not running yet; continuing in terminal setup',
    daemonHealthUnavailable: 'web setup daemon is running but its health check failed; continuing in terminal setup',
    daemonEndpointUnavailable: 'web setup daemon is running but its setup endpoint is unavailable; continuing in terminal setup',
    daemonInspectionUnavailable: 'could not inspect the web setup daemon; continuing in terminal setup',
    startingDaemon: 'starting the daemon for web setup.',
    continueInBrowser: 'continue setup in your browser',
    phoneOnSameWifi: (link: string) => `on a phone on the same wifi: ${link}`,
    linkSingleUse: 'this link can be opened only once within 10 minutes',
    sameWifiRestart: 'to open it from the same wifi, restart `elanous nexus run` without a loopback-only bind',
    scanTailnet: 'scan with a phone connected to your Tailscale tailnet',
    scanSameWifi: 'scan with a phone camera on the same wifi',
    scanAfterTunnel: 'open it in this device’s browser after starting SSH -L',
    tailnetLink: (link: string) => `from anywhere (Tailscale): ${link}`,
    reachability: (browser: 'available' | 'unavailable' | 'unknown', lan: 'available' | 'unavailable' | 'unknown', tailnet: boolean) => `Reachability: browser on this device ${browser === 'available' ? 'available' : browser === 'unknown' ? 'not checked' : 'unavailable in this session'} · same network ${lan === 'available' ? 'address available' : lan === 'unknown' ? 'not checked' : 'no address'} · Tailscale ${tailnet ? 'address available' : 'no address'} · public access unverified`,
    terminalInstead: 'If the link does not open, continue setup in the terminal: `elanous setup --terminal`',
  },
} as const;

async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function setupUrl(pwa: string, token: string): string {
  return `${pwa.replace(/\/$/, '')}/setup/#t=${encodeURIComponent(token)}`;
}

export async function runWebFirstSetup(deps: WebFirstSetupDeps): Promise<'link-shown' | 'fallback'> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const startedAt = deps.startedAt ?? now();
  const print = deps.print ?? console.log;
  const text = WEB_FIRST_TEXT[(deps.locale ?? detectLocale()) === 'en' ? 'en' : 'ko'];
  const observe = (event: 'link-shown' | 'fallback', reason?: string, qr = false, browserOpened = false, remote: 'loopback' | 'tailnet' = 'loopback', ms?: number, lan?: 'shown' | 'loopback-bind' | 'no-address' | 'unknown', ssh?: boolean) => {
    try { debug.log('onboarding.web-first', event, { ...(reason ? { reason } : {}), qr, browserOpened, remote, ...(ms !== undefined ? { ms } : {}), ...(lan ? { lan, ssh } : {}) }); }
    catch { /* Observability must not block onboarding. */ }
  };
  const fallback = (reason: string): 'fallback' => {
    print(text.unavailable(reason));
    observe('fallback', reason);
    return 'fallback';
  };
  if (deps.config.onboarding.webFirst === false) { observe('fallback', 'disabled'); return 'fallback'; }
  if (deps.terminal) { observe('fallback', 'terminal'); return 'fallback'; }

  const show = deps.showNexus ?? (() => runNexusShow({ format: 'json', out: { log: () => {}, error: () => {} } }));
  let shown: NexusShowResult | undefined;
  let inspectionFailed = false;
  try { shown = await show(); } catch { inspectionFailed = true; }
  const running = shown?.status === 'unregistered' || (shown?.status === 'registered' && shown.instance?.alive === true);
  const confirmedNotRunning = shown?.status === 'absent' || (shown?.status === 'registered' && shown.instance?.alive === false);
  if (deps.startIfMissing === false && !running) {
    const reason = confirmedNotRunning ? 'daemon-not-running' : 'daemon-inspection-failed';
    print(confirmedNotRunning ? text.daemonNotRunning : text.daemonInspectionUnavailable);
    observe('fallback', reason);
    return 'fallback';
  }
  // Non-interactive automation remains read-only by default. First-run callers may opt in so an
  // installer can start the daemon and hand a headless user the link and SSH-forward command.
  if ((deps.isTty ?? (process.stdin.isTTY === true)) !== true && deps.startIfMissing !== true) {
    const rest = running ? shown?.urls?.rest.loopback : undefined;
    const up = rest && shown?.urls?.pwa.loopback
      ? await (deps.probeHealth ?? probeHealth)(joinRestHealthUrl(rest), 500) : false;
    if (!up) { observe('fallback', 'non-tty'); return 'fallback'; }
  }
  const deadline = now() + STARTUP_TIMEOUT_MS;
  if (!running || !shown?.urls?.pwa.loopback || !shown?.urls?.rest.loopback) {
    if (deps.startIfMissing === false) {
      const reason = !running ? 'daemon-not-running' : 'daemon-endpoint-unavailable';
      print(!running ? text.daemonNotRunning : text.daemonEndpointUnavailable);
      observe('fallback', reason);
      return 'fallback';
    }
    print(text.startingDaemon);
    let launch: BgLaunchResult;
    try {
      launch = await (deps.startDaemon ?? (() => runBgLaunch({ out: { log: () => {}, error: () => {} } })))();
    } catch { return fallback('daemon-start-failed'); }
    if (launch.exitCode !== 0) return fallback('daemon-start-failed');
  }

  let healthy = false;
  while (now() < deadline) {
    try {
      shown = await show();
      inspectionFailed = false;
    } catch {
      inspectionFailed = true; /* A daemon may not have published its status yet. */
    }
    if (!inspectionFailed && shown) {
      const live = shown.status === 'unregistered' || (shown.status === 'registered' && shown.instance?.alive === true);
      if (live && shown.urls?.pwa.loopback && shown.urls.rest.loopback) {
        const remaining = deadline - now();
        if (remaining > 0) {
          try {
            healthy = await (deps.probeHealth ?? probeHealth)(joinRestHealthUrl(shown.urls.rest.loopback), Math.min(remaining, 500));
          } catch {
            healthy = false; /* A probe exception is a failed health check, not a show/inspection failure. */
          }
          if (healthy) break;
        }
      }
    }
    if (deps.startIfMissing === false) break;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(200, remaining));
  }
  if (!healthy && deps.startIfMissing === false) {
    const stillRunning = shown?.status === 'unregistered' || (shown?.status === 'registered' && shown.instance?.alive === true);
    const confirmedNotRunning = shown?.status === 'absent' || (shown?.status === 'registered' && shown.instance?.alive === false);
    const endpointMissing = stillRunning && (!shown?.urls?.pwa.loopback || !shown.urls.rest.loopback);
    const reason = inspectionFailed ? 'daemon-inspection-failed'
      : endpointMissing ? 'daemon-endpoint-unavailable'
      : stillRunning ? 'daemon-health-unavailable'
      : confirmedNotRunning ? 'daemon-not-running'
      : 'daemon-inspection-failed';
    const message = reason === 'daemon-health-unavailable' ? text.daemonHealthUnavailable
      : reason === 'daemon-endpoint-unavailable' ? text.daemonEndpointUnavailable
      : reason === 'daemon-not-running' ? text.daemonNotRunning
      : text.daemonInspectionUnavailable;
    print(message);
    observe('fallback', reason);
    return 'fallback';
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
  let lanInspectionUnknown = !confirmedBind;
  if (reachable && httpHost !== undefined) {
    if (isPrivateIpv4(httpHost.trim())) {
      lanAddress = httpHost.trim();
    } else {
      try {
        lanAddress = pickLanAddress({
          interfaces: (deps.interfaces ?? networkInterfaces)(),
          defaultRouteInterface: deps.defaultRouteInterface,
        });
      } catch { lanInspectionUnknown = true; /* Optional LAN discovery must not block the local setup link. */ }
    }
  }
  const lan: 'shown' | 'loopback-bind' | 'no-address' | 'unknown' = lanInspectionUnknown ? 'unknown' : !reachable ? 'loopback-bind' : lanAddress ? 'shown' : 'no-address';
  const lanLink = lanAddress ? setupUrl(`http://${lanAddress}:${port}/app/`, token) : undefined;
  const tailnetLink = shown.urls.pwa.tailnet ? setupUrl(shown.urls.pwa.tailnet, token) : undefined;
  const phoneLink = tailnetLink ?? lanLink;
  const env = deps.browserEnv ?? process.env;
  const ssh = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  const noDisplay = !!browserUnavailableReason(env, deps.browserPlatform ?? process.platform);
  const isHeadless = (deps.isHeadless ?? (() => isHeadlessEnv(env)))();
  const why = browserUnavailableReason(env, deps.browserPlatform ?? process.platform);
  const tunnelHint = ssh || noDisplay || isHeadless || (deps.isTty ?? (process.stdin.isTTY === true)) !== true;
  const qrLink = phoneLink ?? (tunnelHint ? link : undefined);
  let browserOpened = false;
  let browserReachability: 'available' | 'unavailable' | 'unknown' = 'unknown';
  if (why) {
    browserReachability = 'unavailable';
    debug.log('browser.open', 'skipped', { reason: why.includes('ssh') ? 'ssh' : 'no-display' });
  } else if (isHeadless) {
    browserReachability = 'unavailable';
  } else {
    try {
      const opened = deps.openBrowser ? deps.openBrowser(link) : (() => {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' || process.platform === 'freebsd' || process.platform === 'openbsd' ? 'xdg-open' : undefined;
        return command ? spawnSync(command, [link], { stdio: 'ignore' }).status === 0 : undefined;
      })();
      if (opened === true) { browserOpened = true; browserReachability = 'available'; }
      else if (opened === false) browserReachability = 'unavailable';
    } catch { /* Keep browser reachability unknown when the opener gives no result. */ }
  }
  const lanReachability = lan === 'shown' ? 'available' : lan === 'unknown' ? 'unknown' : 'unavailable';
  print(text.reachability(browserReachability, lanReachability, !!tailnetLink));
  print(text.continueInBrowser);
  print(link);
  if (lanLink) {
    print(text.phoneOnSameWifi(lanLink));
    print(text.linkSingleUse);
  } else if (lan === 'loopback-bind') {
    print(text.sameWifiRestart);
  }
  if (tailnetLink) print(text.tailnetLink(tailnetLink));
  const linkShownMs = now() - startedAt;
  let qr = false;
  if (qrLink) {
    try {
      const rendered = (deps.renderQr ?? renderTerminalQr)(qrLink);
      if (rendered) {
        print(rendered);
        print(phoneLink ? tailnetLink ? text.scanTailnet : text.scanSameWifi : text.scanAfterTunnel);
        qr = true;
      }
    } catch { /* QR is optional. */ }
  }
  print(text.terminalInstead);
  if (why) {
    print(why);
  }
  if (tunnelHint) {
    try {
      print(`ssh -L ${port}:localhost:${port} ${(deps.username ?? (() => userInfo().username))()}@${(deps.hostname ?? hostname)()}`);
    } catch { /* Optional SSH guidance must not block the setup link. */ }
  }
  observe('link-shown', undefined, qr, browserOpened, shown.urls.pwa.tailnet ? 'tailnet' : 'loopback', linkShownMs, lan, ssh);
  return 'link-shown';
}
