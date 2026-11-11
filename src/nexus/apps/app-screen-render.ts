import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCdpClient, createCdpClientFromEndpoint, discoverChromeBinary } from '../../browser-cdp/client.js';
import { loadNexusAppHost } from './app-host.js';

export type AppScreenMeasurement =
  | { readonly status: 'measured'; readonly screenText: string; readonly blockedUrls: readonly string[]; readonly browserDeniedUrls: readonly string[] }
  | { readonly status: 'unmeasured'; readonly reason: string; readonly blockedUrls: readonly string[]; readonly browserDeniedUrls: readonly string[] };

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === 'string') reject(new Error('CDP loopback port unavailable'));
        else resolve(address.port);
      });
    });
  });
}

/** Render one mounted static export through the actual Nexus app-host response path. */
export async function renderAppScreen(input: {
  readonly appDirectory: string;
  readonly appSlug: string;
  readonly discoverBinary?: () => string | null;
  readonly platform?: NodeJS.Platform;
}): Promise<AppScreenMeasurement> {
  if ((input.platform ?? process.platform) !== 'darwin') {
    return { status: 'unmeasured', reason: 'isolated Chrome renderer unavailable on this platform', blockedUrls: [], browserDeniedUrls: [] };
  }
  const binary = (input.discoverBinary ?? discoverChromeBinary)();
  if (!binary) return { status: 'unmeasured', reason: 'headless Chrome unavailable', blockedUrls: [], browserDeniedUrls: [] };

  const scratch = mkdtempSync(join(tmpdir(), 'app-screen-render-'));
  let browser: Awaited<ReturnType<typeof createCdpClient>> | undefined;
  let page: Awaited<ReturnType<typeof createCdpClientFromEndpoint>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let proxy: Server | undefined;
  let appHost: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
  const blockedUrls: string[] = [];
  const browserDeniedUrls: string[] = [];
  let needsRuntimeData = false;
  const renderErrors: string[] = [];
  try {
    const loaded = loadNexusAppHost(dirname(input.appDirectory), undefined, {
      dir: join(scratch, 'sessions'), key: randomBytes(32).toString('hex'), databaseDirectory: join(scratch, 'db'),
    });
    appHost = loaded.appHost;
    if (!appHost.slugs.includes(input.appSlug)) throw new Error(`Nexus app host did not mount ${input.appSlug}`);
    let cookie = '';
    try { cookie = `__Host-app-session=${appHost.issueOwnerSession(input.appSlug, 'sim-render-owner').sessionToken}`; }
    catch { /* A public-read app can render without an owner session. */ }
    const host = `${input.appSlug}.app.localhost`;
    const fetchFromHost = (path: string, method: string) => appHost!.handle(new Request(`http://${host}${path}`, {
      method, headers: { host, ...(cookie ? { cookie } : {}) },
    }));
    const entry = await fetchFromHost('/', 'GET');
    if (!entry || entry.status !== 200 || !entry.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Nexus app host did not provide HTML');
    }
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' && request.method !== 'HEAD'
        || url.pathname.startsWith('/__rpc/') || url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
        needsRuntimeData = true;
        return new Response('runtime data is outside static render', { status: 503 });
      }
      return await fetchFromHost(url.pathname + url.search, request.method) ?? new Response('Not Found', { status: 404 });
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    // This proxy belongs only to the disposable app browser context, not Chrome's
    // own services. CONNECT, upgrades and every non-app URL are denied here;
    // the OS sandbox also denies non-loopback sockets.
    // Source: #36320 follow-up — bound proxy headers and slow connections while collecting render evidence.
    proxy = createServer((socket) => {
      let header = '';
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on('data', (chunk: Buffer) => {
        header += chunk.toString('latin1');
        if (header.length > 16_384) { socket.destroy(); return; }
        if (!header.includes('\r\n\r\n')) return;
        socket.removeAllListeners('data');
        const [method, target] = header.split(' ', 3);
        let url: URL;
        try { url = new URL(method === 'CONNECT' ? `https://${target}/` : target); }
        catch { socket.destroy(); return; }
        const allowed = (method === 'GET' || method === 'HEAD') && url.origin === origin
          && !/\r\nupgrade:\s*websocket/i.test(header);
        if (!allowed) {
          browserDeniedUrls.push(url.href);
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        void fetch(url, { method }).then(async (response) => {
          const body = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
          const type = response.headers.get('content-type') ?? 'application/octet-stream';
          socket.end(`HTTP/1.1 ${response.status} ${response.statusText}\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n` + body.toString('latin1'), 'latin1');
        }).catch(() => socket.destroy());
      });
    });
    await new Promise<void>((resolve, reject) => proxy!.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
    const proxyPort = (proxy.address() as { port: number }).port;
    const cdpPort = await freeLoopbackPort();
    // Source: 내부 문서 `MANUAL-tui-live-verification-2026-08-03` — bound disposable browser calls in a live probe.
    browser = await createCdpClient({ binary, port: cdpPort, headless: true, url: 'about:blank', timeoutMs: 10_000, attachTimeoutMs: 10_000,
      extraFlags: ['--disable-background-networking', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--disable-quic', '--disable-webrtc', '--no-sandbox', '--disable-sync', '--disable-component-update',
        '--disable-domain-reliability', '--disable-default-apps', '--no-service-autorun', '--no-pings',
        '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,SafeBrowsingEnhancedProtection'],
    }, { spawnBinary: (chrome, args) => {
      return spawn('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))', chrome, ...args], { stdio: 'ignore' });
    } });
    const context = await browser.send!('Target.createBrowserContext', {
      proxyServer: `http://127.0.0.1:${proxyPort}`, proxyBypassList: '<-loopback>',
    }) as { browserContextId: string };
    const target = await browser.send!('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId }) as { targetId: string };
    let wsUrl: string | undefined;
    // Source: #36320 follow-up — bound discovery of the isolated app target's CDP endpoint.
    for (let attempt = 0; attempt < 20 && !wsUrl; attempt++) {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json()) as Array<{ id?: string; webSocketDebuggerUrl?: string }>;
      wsUrl = targets.find((item) => item.id === target.targetId)?.webSocketDebuggerUrl;
      if (!wsUrl) await Bun.sleep(50);
    }
    if (!wsUrl) throw new Error('isolated app target unavailable');
    page = await createCdpClientFromEndpoint(cdpPort, { resolvePage: async () => ({ targetId: target.targetId, wsUrl: wsUrl! }), timeoutMs: 5_000 });
    if (!page.on || !page.send) throw new Error('CDP request interception unavailable');
    page.on('Runtime.exceptionThrown', () => { renderErrors.push('page script exception'); });
    page.on('Network.loadingFailed', (event) => {
      const params = (event as { params?: { type?: string; canceled?: boolean } }).params;
      if (params?.type === 'Script' && !params.canceled) renderErrors.push('script load failed');
    });
    page.on('Network.responseReceived', (event) => {
      const params = (event as { params?: { type?: string; response?: { status?: number } } }).params;
      if (params?.type === 'Script' && (params.response?.status ?? 0) >= 400) renderErrors.push('script response failed');
    });
    page.on('Network.requestWillBeSent', (event) => {
      const params = (event as { params?: { type?: string; request?: { url?: string } } }).params;
      const url = params?.request?.url;
      if ((params?.type === 'Fetch' || params?.type === 'XHR') && url?.startsWith(origin)) needsRuntimeData = true;
    });
    page.on('Network.webSocketCreated', (event) => {
      const url = (event as { params?: { url?: string } }).params?.url;
      if (url) blockedUrls.push(url);
    });
    page.on('Target.attachedToTarget', (event) => {
      const params = (event as { params?: { sessionId?: string; targetInfo?: { type?: string; url?: string } } }).params;
      if (!params?.sessionId || !['worker', 'shared_worker', 'service_worker'].includes(params.targetInfo?.type ?? '')) return;
      // A worker may spawn nested workers before their requests can be attributed.
      // Fail closed on the first worker target rather than treating its screen as measured.
      blockedUrls.push(params.targetInfo?.url || `worker-target:${params.targetInfo?.type}`);
      renderErrors.push('app worker target is outside the measured screen boundary');
    });
    page.on('Fetch.requestPaused', (event) => {
      const params = (event as { params?: { requestId?: string; request?: { url?: string } } }).params;
      if (!params?.requestId || !params.request?.url) return;
      const url = params.request.url;
      const allowed = url.startsWith(`${origin}/`);
      if (!allowed) blockedUrls.push(url);
      void page!.send!(`Fetch.${allowed ? 'continueRequest' : 'failRequest'}`,
        allowed ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: 'BlockedByClient' })
        .catch(() => { blockedUrls.push(url); });
    });
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
      filter: [{ type: 'worker', exclude: false }, { type: 'shared_worker', exclude: false }, { type: 'service_worker', exclude: false }] });
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    const navigation = await page.navigate(`${origin}/`);
    if (navigation.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`);
    // Source: #36320 follow-up — only an explicit app completion marker makes async screen state measurable.
    const deadline = Date.now() + 5_000;
    let screenText: string | undefined;
    while (Date.now() < deadline) {
      const observed = await page.evaluate('document.readyState === "complete" && window.__ELANOUS_SIM_RENDER_READY__ === true ? document.body?.innerText : null');
      if (typeof observed === 'string') { screenText = observed; break; }
      await Bun.sleep(50);
    }
    if (screenText === undefined) throw new Error('app did not signal render completion before deadline');
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // Source: #36320 follow-up — one short settle window lets late task and network-error events arrive after the app's completion signal.
    await Bun.sleep(250);
    const settled = await page.evaluate('window.__ELANOUS_SIM_RENDER_READY__ === true ? document.body?.innerText : null');
    if (settled !== screenText) throw new Error('app screen changed after its completion signal');
    screenText = settled as string;
    if (typeof screenText !== 'string') throw new Error('Chrome did not expose rendered body text');
    if (renderErrors.length) throw new Error(renderErrors.join('; '));
    if (needsRuntimeData) return { status: 'unmeasured', reason: 'app screen requires runtime data outside the static render', blockedUrls, browserDeniedUrls };
    return { status: 'measured', screenText, blockedUrls, browserDeniedUrls };
  } catch (error) {
    return { status: 'unmeasured', reason: error instanceof Error ? error.message : String(error), blockedUrls, browserDeniedUrls };
  } finally {
    try { await page?.close(); } catch { /* browser teardown still runs */ }
    try { await browser?.close(); } catch { /* cleanup best effort */ }
    server?.stop(true);
    proxy?.close();
    appHost?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
