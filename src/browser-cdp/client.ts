// CDP client — BI-P1.
//
// Minimal Chrome DevTools Protocol client talking directly over
// WebSocket. No puppeteer/playwright dependency — Chrome spawns
// with `--remote-debugging-port=N` and publishes a
// `webSocketDebuggerUrl` at /json/version. We connect, send
// `{id, method, params}` messages, receive `{id, result}` or
// `{id, error}`.
//
// Scope kept narrow: navigation, capture, evaluation and CDP input.
// Approval of mutating actions belongs to the caller, not this transport.
// Full Puppeteer feature parity is explicitly out of scope.

import { CHROME_NO_KEYCHAIN_FLAGS } from './chrome-flags.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

export class CdpUnavailable extends Error {
  constructor(public readonly reason: 'no-chrome-binary' | 'spawn-failed' | 'connect-failed' | string) {
    super(`cdp unavailable: ${reason}`);
    this.name = 'CdpUnavailable';
  }
}

export class CdpTimeoutError extends Error {
  constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(`CDP call ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpTimeoutError';
  }
}

/** Generous default for normally slow navigation and rendering calls. */
export const DEFAULT_CDP_TIMEOUT_MS = 120_000;
/** Short watchdog for local CDP HTTP endpoint discovery and target cleanup. */
export const DEFAULT_CDP_ATTACH_TIMEOUT_MS = 5_000;

export type CdpEndpoint = number | string;

function cdpEndpointUrl(endpoint: CdpEndpoint, path: string): string {
  if (typeof endpoint === 'number') return `http://127.0.0.1:${endpoint}${path}`;
  const url = new URL(endpoint);
  const cdpPath = new URL(path, 'http://cdp.invalid');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${cdpPath.pathname.replace(/^\//, '')}`;
  const endpointSearch = url.search.slice(1);
  url.search = [cdpPath.search.slice(1), endpointSearch].filter(Boolean).join('&');
  return url.toString();
}

async function fetchCdpEndpoint<T>(
  fetchImpl: typeof fetch,
  endpoint: CdpEndpoint,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`CDP attach ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(cdpEndpointUrl(endpoint, path), { ...init, signal: controller.signal });
        return { response, body: await consume(response) };
      })(),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchCdpEndpointResponse(
  fetchImpl: typeof fetch,
  endpoint: CdpEndpoint,
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  return (await fetchCdpEndpoint(fetchImpl, endpoint, path, init, timeoutMs, async (response) => response)).body;
}

export interface CdpSpawnOpts {
  /** Headless mode. Default false — user wants to SEE the page. */
  headless?: boolean;
  /** Remote debugging port. Default 9222. */
  port?: number;
  /** Override binary path (skip discovery). */
  binary?: string;
  /** Extra --flag values passed verbatim to Chrome. */
  extraFlags?: string[];
  /** Initial URL. Default 'about:blank'. */
  url?: string;
  /** Per-CDP-call watchdog. Default is deliberately generous (120 seconds). */
  timeoutMs?: number;
  /** Per-CDP-HTTP attach watchdog. Separate from the CDP call timeout. */
  attachTimeoutMs?: number;
}

export interface CdpNavigationResult {
  readonly frameId: string;
  readonly errorText?: string;
  /** `Page.navigate` 가 돌려주는 로더 식별자. ⛔ 프로토콜이 «항상» 주지는 않으므로 optional 이다.
   *  ⭐ 이 값이 있어야 「내가 낸 그 네비게이션의 load」와 「남의 load」를 가를 수 있다
   *  (frameId 만으로는 같은 프레임의 다른 이동과 안 갈린다). 없으면 소비자가 대기를 포기한다. */
  readonly loaderId?: string;
}

export interface CdpClient {
  readonly port: number;
  readonly pid: number;
  navigate(url: string): Promise<CdpNavigationResult>;
  /** Capture the current page as PNG bytes (base64 stripped). */
  screenshot(opts?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<Buffer>;
  evaluate(expression: string): Promise<unknown>;
  /** Enable or disable JavaScript execution for subsequent navigations in this page target. */
  setScriptExecutionDisabled(value: boolean): Promise<void>;
  /** Dispatch one primary-button click at viewport coordinates. */
  click?(coordinates: { x: number; y: number }): Promise<void>;
  /** Insert text at the focused element (approval is the caller's responsibility). */
  input?(text: string): Promise<void>;
  /** Dispose — closes Chrome + WebSocket. */
  close(): Promise<void>;
  readonly isAlive: boolean;
  /** Subscribe to CDP events (proxies to the underlying transport).
   *  Returns an unsubscribe fn. May be absent on clients built
   *  before Phase D3 — check for existence before calling. */
  on?(method: string, listener: CdpEventListener): () => void;
  /** ⭐ 임의 CDP 도메인 명령 (`Network.enable`·`Network.getResponseBody` 등).
   *  ⛔ 여기 없는 도메인을 쓰려고 «클라이언트를 새로 짓지 마라» — 이 문으로 들어온다.
   *  `on` 과 마찬가지로 옛 클라이언트엔 «없을 수 있다» — 부르기 전에 존재를 확인한다. */
  send?(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface DiscoverChromeOpts {
  existsSync?: (p: string) => boolean;
  readFile?: (path: string) => string | null;
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
}

function readProcVersion(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function isWindowsInterop(procVersion: string | null): boolean {
  return procVersion !== null && /microsoft/i.test(procVersion);
}

export function isWindowsInteropBinary(path: string): boolean {
  return path.startsWith('/mnt/') && path.endsWith('.exe');
}

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
const WINDOWS_WSL_CANDIDATES = [
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

export function discoverChromeBinary(opts: DiscoverChromeOpts = {}): string | null {
  const fsCheck = opts.existsSync ?? existsSync;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? (process.env as Record<string, string>);
  const readFile = opts.readFile ?? readProcVersion;
  if (env.ELANOUS_CHROME_BIN && fsCheck(env.ELANOUS_CHROME_BIN)) return env.ELANOUS_CHROME_BIN;
  const isWsl = platform === 'linux'
    && (isWindowsInterop(readFile('/proc/version')) || fsCheck('/proc/sys/fs/binfmt_misc/WSLInterop'));
  const list = platform === 'darwin'
    ? MACOS_CANDIDATES
    : isWsl
      ? [...LINUX_CANDIDATES, ...WINDOWS_WSL_CANDIDATES]
      : LINUX_CANDIDATES;
  for (const p of list) if (fsCheck(p)) return p;
  return null;
}

// ─── CDP message transport ───────────────────────────────────────

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** Event dispatched by the browser (no id) — raw CDP shape. */
export interface CdpIncomingEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Listener receives raw CDP events. `method` is the domain-qualified
 *  name (`Page.loadEventFired`). `'*'` subscribes to every event. */
export type CdpEventListener = (event: CdpIncomingEvent) => void;

/** Internal: thin WebSocket wrapper that tracks pending request
 *  ids → resolvers. Exported as a type so callers can inject a
 *  fake in tests. */
export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to browser-pushed events. Pass `'*'` to match every
   *  event; otherwise the listener fires only when `method` matches
   *  exactly. Returns an unsubscribe fn. */
  on?(method: string, listener: CdpEventListener): () => void;
  close(): void;
}

/** Fetches /json/version from localhost:port and returns the
 *  browser-level webSocketDebuggerUrl. Retries briefly because
 *  Chrome takes ~150–400 ms to expose the endpoint after spawn. */
export async function resolveDebuggerUrl(
  port: number,
  opts: { retries?: number; intervalMs?: number; fetchImpl?: typeof fetch; attachTimeoutMs?: number } = {},
): Promise<string> {
  const retries = opts.retries ?? 10;
  const interval = opts.intervalMs ?? 200;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attachTimeoutMs = opts.attachTimeoutMs ?? DEFAULT_CDP_ATTACH_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastErr: unknown = null;
  let attempts = 0;
  // ⛔⭐ 2026-09-10 🅕 실측 — 여기가 «고부하에서 조용히» 끊기던 자리다.
  //    옛 판: `retries(10) × interval(200ms)` = ***약 2초***만 기다렸다. 연결 거부는 «즉시» 실패하므로
  //    열 번이 2초 안에 다 소진된다. 부하 20~70 에서 Chrome 은 그보다 늦게 포트를 연다(저부하 1.5초).
  //    ⇒ ***`attachTimeoutMs` 라는 「예산」이 있는데 아무도 그것을 «쓰지» 않고 있었다.***
  // ✅ 이제 「횟수」와 「예산」 중 ***늦게 끝나는 쪽***까지 기다린다 — 기존 동작을 «줄이지» 않는다.
  while (attempts < retries || Date.now() - startedAt < attachTimeoutMs) {
    attempts += 1;
    try {
      const { response: res, body } = await fetchCdpEndpoint(
        fetchImpl,
        port,
        '/json/version',
        undefined,
        attachTimeoutMs,
        async (response) => await response.json() as { webSocketDebuggerUrl?: string },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      if (body?.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      throw new Error('missing webSocketDebuggerUrl');
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, interval));
    }
  }
  // ⛔⭐ 그리고 «무엇을 했는지» 말한다.
  //    옛 문면은 `Unable to connect. Is the computer able to access the url?` 하나뿐이라
  //    ***「네트워크·주소 문제」처럼 읽혔다*** — 실제로는 「기다림이 모자랐다」였다(15분을 엉뚱한 데 썼다).
  const waited = Date.now() - startedAt;
  throw new CdpUnavailable(
    `connect-failed: ${port} 포트에서 CDP 를 «못 찾았다» — ${attempts}번 시도 · ${waited}ms 기다렸다`
    + ` (예산 ${attachTimeoutMs}ms). ⛔ 「Chrome 이 없다」가 아니라 「그 안에 안 떴다」일 수 있다 —`
    + ` 부하가 높으면 attachTimeoutMs 를 올려라. 마지막 오류: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Create a CDP transport from a webSocketDebuggerUrl. Uses the
 *  built-in global `WebSocket` (Bun / Node 22+). Tests replace via
 *  createCdpTransportFromFactory. */
export async function createCdpTransport(wsUrl: string): Promise<CdpTransport> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  // method → Set<listener>. '*' is a catch-all.
  const listeners = new Map<string, Set<CdpEventListener>>();

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (ev) => reject(new Error(`ws error: ${String(ev)}`)), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as CdpMessage;
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const event: CdpIncomingEvent = {
          method: msg.method,
          params: (msg.params ?? {}) as Record<string, unknown>,
          sessionId: msg.sessionId,
        };
        for (const key of [msg.method, '*']) {
          const set = listeners.get(key);
          if (!set) continue;
          for (const l of set) {
            try { l(event); } catch { /* listener errors don't crash the socket */ }
          }
        }
      }
    } catch { /* ignore malformed */ }
  });

  return {
    send(method, params) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    on(method, listener) {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(listener);
      return () => {
        const s = listeners.get(method);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) listeners.delete(method);
      };
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
      for (const { reject } of pending.values()) reject(new Error('transport closed'));
      pending.clear();
      listeners.clear();
    },
  };
}

// ─── High-level client ──────────────────────────────────────────

export interface CdpClientDeps {
  spawnBinary?: (binary: string, args: string[]) => ChildProcess;
  resolveUrl?: typeof resolveDebuggerUrl;
  createTransport?: (wsUrl: string) => Promise<CdpTransport>;
}

export async function createCdpClient(
  opts: CdpSpawnOpts = {},
  deps: CdpClientDeps = {},
): Promise<CdpClient> {
  const binary = opts.binary ?? discoverChromeBinary();
  if (!binary) throw new CdpUnavailable('no-chrome-binary');

  const port = opts.port ?? 9222;
  const headless = opts.headless ?? false;

  // Use a unique profile dir so multiple CDP clients don't collide.
  const profileDir = mkdtempSync(joinPath(tmpdir(), 'elanous-cdp-'));

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...CHROME_NO_KEYCHAIN_FLAGS,
    '--disable-gpu-vsync',
    // Security: lock the remote-debugging endpoint to loopback only.
    '--remote-debugging-address=127.0.0.1',
    ...(headless ? ['--headless=new'] : []),
    ...(opts.extraFlags ?? []),
    opts.url ?? 'about:blank',
  ];

  const spawnFn = deps.spawnBinary ?? ((b, a) =>
    spawn(b, a, { stdio: 'ignore', detached: false }));

  let child: ChildProcess;
  try {
    child = spawnFn(binary, args);
  } catch (err) {
    rmSync(profileDir, { recursive: true, force: true });
    throw new CdpUnavailable(`spawn-failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attempt connect; if it fails we still have a Chrome pid to kill.
  const resolve = deps.resolveUrl ?? resolveDebuggerUrl;
  const create = deps.createTransport ?? createCdpTransport;
  let transport: CdpTransport;
  try {
    const wsUrl = await resolve(port, { attachTimeoutMs: opts.attachTimeoutMs });
    transport = await create(wsUrl);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    rmSync(profileDir, { recursive: true, force: true });
    if (err instanceof CdpUnavailable) throw err;
    throw new CdpUnavailable(`connect-failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ★ B1(2026-07-22) — transport→client 본체는 spawn/attach 공유(재발명0·아래 buildClientFromTransport).
  const onClose = () => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    rmSync(profileDir, { recursive: true, force: true });
  };
  try {
    return await buildClientFromTransport(transport, {
      port,
      pid: child.pid ?? -1,
      onClose,
      timeoutMs: opts.timeoutMs,
    });
  } catch (error) {
    try { transport.close(); } catch { /* ignore */ }
    onClose();
    throw error;
  }
}

/** ★ transport 위에 CdpClient(navigate/screenshot/evaluate/on/close)를 조립하는 공유 본체. spawn(createCdpClient)과
 *  attach(createCdpClientFromEndpoint) 둘 다 재사용 — 유일 차이는 pid/onClose(브라우저 소유권)·directPage 뿐.
 *  directPage=true(attach): 이미 페이지-레벨 ws 에 붙어 Page/Runtime 도메인이 직접 라우팅되므로 targetId 게이트 생략. */
async function buildClientFromTransport(
  transport: CdpTransport,
  meta: { port: number; pid: number; onClose: () => void; directPage?: boolean; timeoutMs?: number },
): Promise<CdpClient> {
  const timeoutMs = meta.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  const send = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpTimeoutError(method, timeoutMs)), timeoutMs);
      transport.send(method, params).then(
        (result) => { clearTimeout(timer); resolve(result as T); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  let alive = true;
  let targetId: string | null = null;

  if (!meta.directPage) {
    // spawn(browser-level ws): 첫 page 타깃을 찾아 라우팅. directPage 면 이미 page ws 라 생략.
    try {
      const { targetInfos } = await send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
      const page = targetInfos.find((t) => t.type === 'page');
      if (page) targetId = page.targetId;
    } catch (error) {
      if (error instanceof CdpTimeoutError) throw error;
      // browser-level commands still work when target enumeration fails.
    }
  }

  const runOnPage = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (!meta.directPage && !targetId) throw new Error('no page target');
    return send(method, params);
  };

  return {
    port: meta.port,
    pid: meta.pid,
    isAlive: alive,
    async navigate(url) {
      await runOnPage('Page.enable');
      await runOnPage('Page.setLifecycleEventsEnabled', { enabled: true });
      const result = await runOnPage('Page.navigate', { url }) as { frameId: string; errorText?: string; loaderId?: string };
      return {
        frameId: result.frameId,
        ...(result.errorText ? { errorText: result.errorText } : {}),
        ...(result.loaderId ? { loaderId: result.loaderId } : {}),
      };
    },
    async screenshot(o) {
      const result = await runOnPage('Page.captureScreenshot', {
        format: o?.format ?? 'png',
        quality: o?.quality,
        captureBeyondViewport: !!o?.fullPage,
      }) as { data: string };
      return Buffer.from(result.data, 'base64');
    },
    async evaluate(expression) {
      const result = await runOnPage('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }) as { result: { value?: unknown; description?: string }; exceptionDetails?: unknown };
      if (result.exceptionDetails) {
        throw new Error(`evaluate: ${JSON.stringify(result.exceptionDetails)}`);
      }
      return result.result.value;
    },
    async setScriptExecutionDisabled(value) {
      await runOnPage('Emulation.setScriptExecutionDisabled', { value });
    },
    async click({ x, y }) {
      const params = { x, y, button: 'left', clickCount: 1 };
      await runOnPage('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
      await runOnPage('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
    },
    async input(text) {
      // Newlines can submit a form even without an Enter key event.
      if (/[\r\n]/.test(text)) throw new Error('CDP input refuses newlines');
      await runOnPage('Input.insertText', { text });
    },
    async close() {
      if (!alive) return;
      alive = false;
      try { transport.close(); } catch { /* ignore */ }
      meta.onClose();
    },
    on(method, listener) {
      return transport.on?.(method, listener) ?? (() => {});
    },
    send(method, params) {
      return runOnPage(method, params);
    },
  };
}

/** ★ B1 — 이미 뜬 CDP 엔드포인트에서 새 **페이지 타깃**을 만들고 그 page-level ws 를 얻는다(PUT /json/new).
 *  browser-level ws(/json/version)는 Page.* 를 노출 안 해 스크린샷/네비게이션이 안 되므로, 검증엔 page ws 가 필수.
 *  새 탭이라 사용자 기존 탭을 하이재킹 안 함. 반환 targetId 로 close 시 그 탭만 정리. fetch 는 주입 가능(테스트). */
export async function createPageTarget(
  endpoint: CdpEndpoint,
  opts: { url?: string; fetchImpl?: typeof fetch; retries?: number; intervalMs?: number; attachTimeoutMs?: number } = {},
): Promise<{ wsUrl: string; targetId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? 'about:blank';
  const retries = opts.retries ?? 3;
  const interval = opts.intervalMs ?? 150;
  const attachTimeoutMs = opts.attachTimeoutMs ?? DEFAULT_CDP_ATTACH_TIMEOUT_MS;
  let lastErr: unknown = null;
  for (let i = 0; i < retries; i++) {
    try {
      const { response: res, body } = await fetchCdpEndpoint(
        fetchImpl,
        endpoint,
        `/json/new?${encodeURIComponent(url)}`,
        { method: 'PUT' },
        attachTimeoutMs,
        async (response) => await response.json() as { webSocketDebuggerUrl?: string; id?: string },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      if (body?.webSocketDebuggerUrl && body?.id) return { wsUrl: body.webSocketDebuggerUrl, targetId: body.id };
      throw new Error('missing webSocketDebuggerUrl/id');
    } catch (err) { lastErr = err; await new Promise(r => setTimeout(r, interval)); }
  }
  throw new CdpUnavailable(`new-target-failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/**
 * ★ B1(2026-07-22) — 이미 실행 중인 CDP 엔드포인트(port·기본 9222)에 **attach**한다. Chrome-spawn(귀속) 대신
 * 브라우저-무관 attach(browser-debug 스킬 cdp.ts 의 page-target 패턴 동형) — Dia/Arc/Chrome 무엇이 9222 에 떠
 * 있든 붙는다(대표 요구: 특정 브라우저 귀속 X·추후 연결 브라우저만 교체). 새 **페이지 타깃**을 열어 그 page ws 에
 * 붙으므로 Page/Runtime 도메인이 직접 동작(사용자 탭 하이재킹 X). 브라우저 프로세스는 **비소유** → close 는 우리가 연
 * 탭만 정리(PUT /json/close)하고 프로세스는 안 죽인다. 엔드포인트 부재 시 CdpUnavailable(fail-soft 상위 게이트).
 */
export async function createCdpClientFromEndpoint(
  endpoint: CdpEndpoint = 9222,
  deps: {
    createTransport?: (wsUrl: string) => Promise<CdpTransport>;
    fetchImpl?: typeof fetch;
    /** 테스트/커스텀 — page ws+targetId 직접 주입(createPageTarget 우회). */
    resolvePage?: (endpoint: CdpEndpoint) => Promise<{ wsUrl: string; targetId: string }>;
    /** Per-CDP-call watchdog. Default is deliberately generous (120 seconds). */
    timeoutMs?: number;
    /** Per-CDP-HTTP attach watchdog. Separate from the CDP call timeout. */
    attachTimeoutMs?: number;
  } = {},
): Promise<CdpClient> {
  const create = deps.createTransport ?? createCdpTransport;
  const attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_CDP_ATTACH_TIMEOUT_MS;
  const resolvePage = deps.resolvePage ?? ((targetEndpoint: CdpEndpoint) => createPageTarget(targetEndpoint, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    attachTimeoutMs,
  }));
  const fetchImpl = deps.fetchImpl ?? fetch;
  let transport: CdpTransport;
  let targetId: string;
  try {
    const page = await resolvePage(endpoint);
    targetId = page.targetId;
    transport = await create(page.wsUrl);
  } catch (err) {
    if (err instanceof CdpUnavailable) throw err;
    throw new CdpUnavailable(`attach-failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 비소유 브라우저 — 우리가 연 탭만 닫고(fail-soft) 프로세스는 남긴다.
  const onClose = () => { void fetchCdpEndpointResponse(fetchImpl, endpoint, `/json/close/${targetId}`, undefined, attachTimeoutMs).catch(() => {}); };
  try {
    return await buildClientFromTransport(transport, {
      port: typeof endpoint === 'number' ? endpoint : Number(new URL(endpoint).port) || 9222,
      pid: -1, directPage: true, onClose, timeoutMs: deps.timeoutMs,
    });
  } catch (error) {
    try { transport.close(); } catch { /* ignore */ }
    onClose();
    throw error;
  }
}
