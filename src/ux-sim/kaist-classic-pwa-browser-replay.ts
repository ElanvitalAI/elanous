import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { CHROME_NO_KEYCHAIN_FLAGS } from '../browser-cdp/chrome-flags.js';
import { createKaistPwaReplayWorld, loadKaistClassicPtyReceipt, type KaistReplayScene } from './kaist-classic-pwa-replay-world.js';

interface CdpResponse { id?: number; method?: string; result?: Record<string, unknown>; error?: { message?: string }; params?: Record<string, unknown>; sessionId?: string; }

class CdpPage {
  private readonly ws: WebSocket;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  readonly events = new Map<string, Record<string, unknown>[]>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP command failed'));
        else waiter.resolve(message.result ?? {});
      } else if (message.method) {
        const params = { ...(message.params ?? {}), ...(message.sessionId ? { __cdpSessionId: message.sessionId } : {}) };
        this.events.set(message.method, [...(this.events.get(message.method) ?? []), params]);
        for (const handler of this.handlers.get(message.method) ?? []) handler(params);
      }
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome DevTools WebSocket open timed out')), 10_000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolveOpen(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools WebSocket connection failed')); }, { once: true });
    });
  }

  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }

  close(): void { this.ws.close(); }
}

function mimeType(path: string): string {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
    '.ico': 'image/x-icon' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream';
}

function isReplayOrigin(requestUrl: string, baseUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    const base = new URL(baseUrl);
    const webProtocolPair = (request.protocol === 'ws:' && base.protocol === 'http:')
      || (request.protocol === 'wss:' && base.protocol === 'https:');
    return request.hostname === base.hostname && request.port === base.port
      && (request.protocol === base.protocol || webProtocolPair);
  } catch { return false; }
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await Bun.sleep(100);
  } while (Date.now() < end);
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function chromeExecutable(): string {
  const configured = process.env.CHROME_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome executable missing; set CHROME_BIN on the remote replay host');
}

async function loadDemoGcpArtifacts() {
  const root = resolve('plugins/gcp-architect-expand/sim/sample-output');
  const manifest = JSON.parse(await readFile(join(root, 'board-attachments.json'), 'utf8')) as {
    attachments: Array<{ kind: 'diagram' | 'diagram-source' | 'pdf' | 'html'; title: string; url: string; mime: string; sha256: string; producedBy: string }>;
    deploymentStatus: string;
  };
  const direct = JSON.parse(await readFile('plugins/gcp-architect-expand/demo/graph-direct-test-world-receipt.json', 'utf8')) as {
    graphId: string; runId: string; status: string; pendingNode: string; realGcpCalls: number;
  };
  const proposal = JSON.parse(await readFile(join(root, 'proposal.json'), 'utf8')) as {
    estimate: { price: string; status: string }; security: { grade: string }; realGcpCalls: number;
  };
  if (manifest.deploymentStatus !== 'unverified' || direct.status !== 'awaiting-approval'
    || direct.pendingNode !== 'approve' || direct.realGcpCalls !== 0
    || proposal.estimate.price !== 'unpriced' || proposal.realGcpCalls !== 0) {
    throw new Error('GCP test-world approval and artifact sources are not in their declared states');
  }
  const responses = new Map<string, { mime: string; data: Buffer }>();
  const attachments = await Promise.all(manifest.attachments.map(async (item) => {
    if (!/^\.\/[a-zA-Z0-9.-]+$/.test(item.url)) throw new Error(`unsafe GCP sample artifact path: ${item.url}`);
    const data = await readFile(join(root, item.url));
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash !== item.sha256) throw new Error(`GCP sample artifact hash mismatch: ${item.url}`);
    const url = new URL(item.url.slice(2), 'https://kaist-artifacts.test/').toString();
    responses.set(url, { mime: item.mime, data });
    return { ...item, url };
  }));
  // Chrome's PDF viewer may request this icon after opening a sample artifact.
  responses.set('https://kaist-artifacts.test/favicon.ico', {
    mime: 'image/svg+xml',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
  });
  return { attachments, responses, gcpApproval: {
    graphId: direct.graphId, runId: direct.runId, nodeId: direct.pendingNode,
    message: `GCP 확장안 · 월 비용 ${proposal.estimate.status} · 보안 ${proposal.security.grade} · 승인 전 지출 0`,
  } };
}

/** Serve the static PWA and local-only API fixtures, then capture real headless-Chrome receipts. */
export async function runKaistClassicPwaBrowserReplay(options: {
  readonly pwaOutDir?: string;
  readonly outputDir?: string;
  readonly receiptPath?: string;
  readonly demoLap?: boolean;
} = {}): Promise<Record<string, unknown>> {
  const replayRunId = randomUUID();
  const outputDir = resolve(options.outputDir ?? process.env.KAIST_PWA_REPLAY_OUT ?? join(tmpdir(), 'kaist-pwa-browser-replay', replayRunId));
  await mkdir(outputDir, { recursive: true });
  const receiptPath = join(outputDir, 'receipt.json');
  await rm(receiptPath, { force: true });
  const envelope = loadKaistClassicPtyReceipt(options.receiptPath ?? (options.demoLap
    ? 'src/ux-sim/fixtures/kcb-ticket-classic-pty-receipt.json' : undefined));
  const demo = options.demoLap ? await loadDemoGcpArtifacts() : undefined;
  const world = createKaistPwaReplayWorld(envelope, demo ? {
    gcpApproval: demo.gcpApproval, boardAttachments: demo.attachments,
  } : undefined);
  const fulfilledAttachments: string[] = [];
  const openedAttachments: Array<{ kind: string; url: string; windowOpen: boolean; popupBlocked: boolean; bytesFulfilled: boolean }> = [];
  const pwaOutDir = resolve(options.pwaOutDir ?? process.env.KAIST_PWA_OUT_DIR ?? 'apps/pwa/out');
  if (!existsSync(join(pwaOutDir, 'index.html'))) throw new Error(`static PWA export is missing: ${pwaOutDir}; build it before replay`);
  const sourceRunId = envelope.receipt.graphRun!.runId;
  const missingStaticPaths: string[] = [];
  const externalRequests: string[] = [];
  const blockedExternalRequests: string[] = [];
  const targetFenceProbes: string[] = [];
  const attachedTargetTypes: string[] = [];
  const interceptionErrors: string[] = [];
  const webSocketFenceProbes: boolean[] = [];
  const workerExecutionFenceProbes: boolean[] = [];
  let browserDir: string | undefined;
  let staticServer: ReturnType<typeof Bun.serve<{ purpose: string }>> | undefined;
  let chrome: ReturnType<typeof Bun.spawn> | undefined;
  let baseUrl = '';
  let page: CdpPage | undefined;
  let browser: CdpPage | undefined;
  const scenePages: CdpPage[] = [];
  const capturedScenes: Array<Record<string, unknown>> = [];
  const fencedTargetIds: string[] = [];
  const blockedPopupTargetIds: string[] = [];
  let blockPopupTargets = false;
  const webSocketFence = `(() => {
    const root = globalThis;
    const NativeWebSocket = root.WebSocket;
    if (!NativeWebSocket) return;
    function GuardedWebSocket(url, protocols) {
      const target = new URL(String(url), root.location.href);
      const protocol = target.protocol === 'http:' ? 'ws:' : target.protocol === 'https:' ? 'wss:' : target.protocol;
      const same = target.hostname === root.location.hostname && target.port === root.location.port
        && ((protocol === 'ws:' && root.location.protocol === 'http:')
          || (protocol === 'wss:' && root.location.protocol === 'https:'));
      if (!same) {
        (root.__kaistBlockedWebSockets ||= []).push(target.href);
        throw new DOMException('External WebSocket blocked in KAIST replay', 'SecurityError');
      }
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    }
    Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
    GuardedWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperty(root, 'WebSocket', { configurable: true, writable: true, value: GuardedWebSocket });
    const denyWorker = function DeniedWorker() { throw new DOMException('Worker execution disabled in isolated KAIST replay', 'SecurityError'); };
    for (const key of ['Worker', 'SharedWorker']) if (root[key]) Object.defineProperty(root, key, { configurable: true, writable: true, value: denyWorker });
  })();`;
  try {
    browserDir = await mkdtemp(join(tmpdir(), 'kaist-pwa-chrome-'));
    const profileDir = join(browserDir, 'profile');
    staticServer = Bun.serve<{ purpose: string }>({ hostname: '127.0.0.1', port: 0,
    websocket: { open() {}, message() {}, close() {} },
    async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/acp' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (server.upgrade(request, { data: { purpose: 'kaist-local-test-world' } })) return undefined;
      return new Response('websocket upgrade failed', { status: 400 });
    }
    if (url.pathname.startsWith('/v1/')) return world.handleApi(request);
    if (url.pathname === '/__kaist_replay_bootstrap__') return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Replay setup</title></head><body></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    const decodedUrlPath = decodeURIComponent(url.pathname);
    const decoded = decodedUrlPath === '/app' || decodedUrlPath.startsWith('/app/') ? decodedUrlPath.slice('/app'.length) || '/' : decodedUrlPath;
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const candidate = resolve(pwaOutDir, relative.endsWith('/') ? `${relative}index.html` : relative);
    if (!candidate.startsWith(`${pwaOutDir}${sep}`) && candidate !== join(pwaOutDir, 'index.html')) return new Response('forbidden', { status: 403 });
    const file = existsSync(candidate) ? candidate : resolve(pwaOutDir, `${relative.replace(/\/$/, '')}.html`);
    if (!existsSync(file)) { missingStaticPaths.push(url.pathname); return new Response('not found', { status: 404 }); }
    return new Response(await readFile(file), { headers: { 'content-type': mimeType(file), 'cache-control': 'no-store' } });
    } });
    baseUrl = `http://127.0.0.1:${staticServer.port}`;
    chrome = Bun.spawn([chromeExecutable(), '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, ...CHROME_NO_KEYCHAIN_FLAGS, 'about:blank'],
    { stdout: 'ignore', stderr: 'pipe' });
  const installFenceHandlers = (target: CdpPage): void => {
    target.on('Fetch.requestPaused', (params) => {
      const requestId = String(params.requestId ?? '');
      const request = params.request as Record<string, unknown> | undefined;
      const requestUrl = String(request?.url ?? '');
      const protocol = (() => { try { return new URL(requestUrl).protocol; } catch { return ''; } })();
      const sameOrigin = isReplayOrigin(requestUrl, baseUrl);
      const artifact = demo?.responses.get(requestUrl);
      if (artifact) {
        const sessionId = typeof params.__cdpSessionId === 'string' ? params.__cdpSessionId : undefined;
        void target.call('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: artifact.mime }, { name: 'cache-control', value: 'no-store' }],
          body: artifact.data.toString('base64') }, sessionId)
          .then(() => fulfilledAttachments.push(requestUrl))
          .catch((error) => interceptionErrors.push(`artifact response ${requestUrl}: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const localOrInline = sameOrigin || ['about:', 'blob:', 'data:', 'chrome-extension:'].includes(protocol);
      const command = localOrInline ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      if (!localOrInline && requestUrl) {
        blockedExternalRequests.push(requestUrl);
        if (requestUrl.includes('/kaist-target-fence-probe?')) targetFenceProbes.push(requestUrl);
        else externalRequests.push(requestUrl);
      }
      const sessionId = typeof params.__cdpSessionId === 'string' ? params.__cdpSessionId : undefined;
      void target.call(command, localOrInline ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (protocol === 'chrome-extension:' && message.includes('Invalid InterceptionId')) return;
          interceptionErrors.push(`${command} ${requestUrl}: ${message}`);
        });
    });
    target.on('Network.webSocketCreated', (params) => {
      const requestUrl = String(params.url ?? '');
      const sameOrigin = isReplayOrigin(requestUrl, baseUrl);
      if (!sameOrigin && requestUrl) externalRequests.push(requestUrl);
    });
  };
  const fenceRequests = async (target: CdpPage, sessionId?: string): Promise<void> => {
    await target.call('Network.enable', {}, sessionId);
    await target.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
  };
  const fenceChildTargets = async (target: CdpPage): Promise<void> => {
    target.on('Target.attachedToTarget', (params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const targetInfo = params.targetInfo as Record<string, unknown> | undefined;
      const targetId = typeof targetInfo?.targetId === 'string' ? targetInfo.targetId : undefined;
      const targetType = String(targetInfo?.type ?? '');
      attachedTargetTypes.push(targetType || 'unknown');
      if (!sessionId || !targetId) {
        interceptionErrors.push('Target.attachedToTarget omitted session or target id');
        return;
      }
      void (async () => {
        if (blockPopupTargets && targetType === 'page') {
          await target.call('Target.closeTarget', { targetId });
          blockedPopupTargetIds.push(targetId);
          return;
        }
        if (targetType !== 'page' && targetType !== 'iframe') {
          await target.call('Target.closeTarget', { targetId });
          return;
        }
        await fenceRequests(target, sessionId);
        await target.call('Page.addScriptToEvaluateOnNewDocument', { source: webSocketFence }, sessionId);
        await target.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
        fencedTargetIds.push(targetId);
      })().catch((error) => {
        interceptionErrors.push(`target fence ${targetId}: ${error instanceof Error ? error.message : String(error)}`);
        void target.call('Target.closeTarget', { targetId }).catch(() => undefined);
      });
    });
    await target.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  };
    const activePortFile = join(profileDir, 'DevToolsActivePort');
    const activePort = await waitFor(async () => await Bun.file(activePortFile).text().catch(() => ''), (value) => /^\d+\n/.test(value), 'Chrome DevTools port');
    const cdpPort = Number(activePort.split('\n')[0]);
    const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    const version = await versionResponse.json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) throw new Error('Chrome did not expose its browser DevTools target');
    browser = new CdpPage(version.webSocketDebuggerUrl);
    await browser.open();
    installFenceHandlers(browser);
    await fenceChildTargets(browser);
    const tabsResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const tabs = await tabsResponse.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const tab = tabs.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    if (!tab?.webSocketDebuggerUrl) throw new Error('Chrome did not expose an initial page target');
    page = new CdpPage(tab.webSocketDebuggerUrl);
    await page.open();
    installFenceHandlers(page);
    await page.call('Page.enable');
    await page.call('Runtime.enable');
    await fenceRequests(page);
    // Source: OP KAIST PWA phone scene uses the 390 px mobile viewport.
    await page.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.call('Network.setCookie', { name: 'app-session', value: 'fake-kaist-member', url: baseUrl, path: '/' });
    await page.call('Page.navigate', { url: `${baseUrl}/__kaist_replay_bootstrap__` });
    await waitFor(async () => {
      const result = await page!.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
    }, (state) => state === 'complete', 'loopback PWA bootstrap');
    await page.call('Runtime.evaluate', { expression: `localStorage.setItem('elanous.nexus.baseUrl', ${JSON.stringify(baseUrl)}); localStorage.setItem('elanous.daemon.token', 'fake-kaist-owner-session'); window.dispatchEvent(new Event('elanous.daemon.changed'));` });
    const storageResult = await page.call('Runtime.evaluate', { expression: `JSON.stringify({baseUrl: localStorage.getItem('elanous.nexus.baseUrl'), token: localStorage.getItem('elanous.daemon.token')})`, returnByValue: true });
    const storageValue = String((storageResult.result as Record<string, unknown> | undefined)?.value ?? '');
    if (!storageValue.includes(baseUrl) || !storageValue.includes('fake-kaist-owner-session')) throw new Error(`test-world Nexus configuration did not persist: ${storageValue}`);
    const briefingOutput = asSceneOutput(envelope.receipt.scenes['3']).briefing;
    const briefingSummary = String(briefingOutput?.topics?.[0]?.summary ?? 'KAIST lecture materials');
    const scenes: Array<{ scene: KaistReplayScene; path: string; expected: string[]; sourceRunId: string; input: Record<string, unknown> }> = [
      { scene: 2, path: '/app/board/', expected: [briefingSummary, String(asSceneOutput(envelope.receipt.scenes['4']).suggestion?.ask ?? 'Add a lesson timer')], sourceRunId: envelope.receipt.scenes['2']!.runId, input: envelope.receipt.scenes['2']!.input },
      { scene: 3, path: '/app/chat/', expected: [String(asSceneOutput(envelope.receipt.scenes['4']).suggestion?.ask ?? 'Add a lesson timer'), 'OK · 개발 시작'], sourceRunId: envelope.receipt.scenes['3']!.runId, input: envelope.receipt.scenes['3']!.input },
      { scene: 5, path: demo ? '/app/chat/' : `/app/live-run/?view=instance&source=graph&run=${encodeURIComponent(sourceRunId)}&graph=absorb-build`,
        expected: demo ? ['승인·결정 1'] : ['absorb-build', String(asSceneOutput(envelope.receipt.scenes['4']).suggestion?.ask ?? 'Add a lesson timer'), sourceRunId],
        sourceRunId: demo?.gcpApproval.runId ?? envelope.receipt.scenes['5']!.runId, input: envelope.receipt.scenes['5']!.input },
      { scene: 6, path: '/app/board/', expected: [String(envelope.receipt.boardCard.title ?? 'Add a lesson timer'),
        String(envelope.receipt.scenes['6']!.output.resultUrl ?? ''), ...(demo ? demo.attachments.filter(item => item.kind === 'diagram' || item.kind === 'pdf').map(item => item.title) : ['index.html'])],
        sourceRunId: envelope.receipt.scenes['6']!.runId, input: envelope.receipt.scenes['6']!.input },
    ];

    for (const item of scenes) {
      world.setScene(item.scene);
      const newTab = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
      if (!newTab.ok) throw new Error(`Chrome failed to create isolated scene target: ${newTab.status}`);
      const target = await newTab.json() as { id?: string; webSocketDebuggerUrl?: string };
      if (!target.webSocketDebuggerUrl || !target.id) throw new Error('Chrome scene target omitted its id or debugger socket');
      await waitFor(async () => fencedTargetIds.includes(target.id!), (fenced) => fenced,
        `scene ${item.scene} target paused and fenced before execution`);
      const scenePage = new CdpPage(target.webSocketDebuggerUrl);
      await scenePage.open();
      installFenceHandlers(scenePage);
      await scenePage.call('Page.enable');
      await scenePage.call('Runtime.enable');
      await fenceRequests(scenePage);
      await scenePage.call('Page.addScriptToEvaluateOnNewDocument', { source: webSocketFence });
      await scenePage.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      scenePages.push(scenePage);
      page = scenePage;
      await page.call('Page.navigate', { url: `${baseUrl}/__kaist_replay_bootstrap__` });
      await waitFor(async () => {
        const result = await page!.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
      }, (state) => state === 'complete', `scene ${item.scene} isolated bootstrap`);
      if (item.scene === 2) {
        const popupProbeUrl = `http://198.51.100.1:43827/kaist-target-fence-probe?scene=${item.scene}`;
        const popupOpened = await page.call('Runtime.evaluate', { expression: `Boolean(window.open(${JSON.stringify(popupProbeUrl)}, 'kaist-target-fence-probe'))`, returnByValue: true, userGesture: true });
        if (!(popupOpened.result as Record<string, unknown> | undefined)?.value) throw new Error('Chrome blocked the isolated popup target fence probe');
        await waitFor(async () => targetFenceProbes.some((requestUrl) => requestUrl === popupProbeUrl), (blocked) => blocked,
          `popup target external request paused by the request fence (attached=${attachedTargetTypes.join(',')})`);
      }
      const probe = await page.call('Runtime.evaluate', { expression: `(() => {
        try { new WebSocket('ws://198.51.100.1:43827/kaist-fence-probe'); return false; }
        catch (error) { window.__kaistBlockedWebSockets = []; return error instanceof DOMException && error.name === 'SecurityError'; }
      })()`, returnByValue: true });
      const probePassed = Boolean((probe.result as Record<string, unknown> | undefined)?.value);
      webSocketFenceProbes.push(probePassed);
      if (!probePassed) throw new Error(`scene ${item.scene} external WebSocket fence probe failed`);
      const workerProbe = await page.call('Runtime.evaluate', { expression: `(() => {
        try { new Worker('blob:null/kaist-worker-fence-probe'); return false; }
        catch (error) { return error instanceof DOMException && error.name === 'SecurityError'; }
      })()`, returnByValue: true });
      const workerProbePassed = Boolean((workerProbe.result as Record<string, unknown> | undefined)?.value);
      workerExecutionFenceProbes.push(workerProbePassed);
      if (!workerProbePassed) throw new Error(`scene ${item.scene} worker execution fence probe failed`);
      const url = `${baseUrl}${item.path}`;
      await page.call('Page.navigate', { url });
      let visibleText: string;
      try { visibleText = await waitFor(async () => {
        const result = await page!.call('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
        return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
      }, (text) => item.expected.every((expected) => expected.length > 0 && text.includes(expected)), `scene ${item.scene} visible content`); }
      catch (error) {
        const diagnostic = await page.call('Runtime.evaluate', { expression: `JSON.stringify({href: location.href, baseUrl: localStorage.getItem('elanous.nexus.baseUrl'), scripts: Array.from(document.scripts).map((script) => script.src), resources: performance.getEntriesByType('resource').map((entry) => entry.name), body: document.body?.innerText ?? ''})`, returnByValue: true });
        const requests = (page.events.get('Network.requestWillBeSent') ?? []).map((event) => String((event.request as Record<string, unknown> | undefined)?.url ?? '')).slice(-50);
        const responses = (page.events.get('Network.responseReceived') ?? []).map((event) => ({
          url: String((event.response as Record<string, unknown> | undefined)?.url ?? ''),
          status: Number((event.response as Record<string, unknown> | undefined)?.status ?? 0),
        })).filter((event) => event.status >= 400);
        const failures = (page.events.get('Network.loadingFailed') ?? []).map((event) => ({ error: event.errorText, canceled: event.canceled }));
        const exceptions = (page.events.get('Runtime.exceptionThrown') ?? []).map((event) => ({
          text: event.exceptionDetails && (event.exceptionDetails as Record<string, unknown>).text,
          exception: ((event.exceptionDetails as Record<string, unknown> | undefined)?.exception as Record<string, unknown> | undefined)?.description,
        }));
        const consoleErrors = (page.events.get('Runtime.consoleAPICalled') ?? []).filter((event) => event.type === 'error').map((event) => {
          const args = Array.isArray(event.args) ? event.args as Array<Record<string, unknown>> : [];
          return args.map((argument) => String(argument.value ?? argument.description ?? '')).join(' ').slice(0, 400);
        });
        throw new Error(`${error instanceof Error ? error.message : String(error)}; browser=${String((diagnostic.result as Record<string, unknown> | undefined)?.value ?? '').slice(0, 8000)}; apiUnsupported=${JSON.stringify(world.unsupportedApiPaths)}; requests=${JSON.stringify(requests)}; badResponses=${JSON.stringify(responses)}; failures=${JSON.stringify(failures)}; exceptions=${JSON.stringify(exceptions)}; consoleErrors=${JSON.stringify(consoleErrors)}`);
      }
      if (item.scene === 3) {
        const tapTarget = await page.call('Runtime.evaluate', { expression: `(() => {
          const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('OK · 개발 시작'));
          if (!button || button.disabled) return null;
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight
            || !hit || (hit !== button && !button.contains(hit))) return null;
          return { x, y };
        })()`, returnByValue: true });
        const point = (tapTarget.result as Record<string, unknown> | undefined)?.value as { x?: number; y?: number } | undefined;
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('scene 3 approval button is not visibly tappable');
        await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
        await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
        visibleText = await waitFor(async () => {
          const result = await page!.call('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
          return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
        }, (text) => text.includes(`하니스 요청 접수 ${sourceRunId}`), 'scene 3 approval dispatch receipt');
      }
      if (item.scene === 5 && demo) {
        const tapButton = async (label: string) => {
          const point = await waitFor(async () => {
            const result = await page!.call('Runtime.evaluate', { expression: `(() => {
              const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === ${JSON.stringify(label)} && !item.disabled);
              if (!button) return null;
              button.scrollIntoView({ block: 'center' });
              const rect = button.getBoundingClientRect();
              const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
              return rect.width > 0 && rect.height > 0 && document.elementFromPoint(x, y) === button ? { x, y } : null;
            })()`, returnByValue: true });
            return (result.result as Record<string, unknown> | undefined)?.value as { x: number; y: number } | null;
          }, value => !!value, `scene 5 ${label} button`);
          await page!.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
          await page!.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
        };
        await tapButton('승인·결정 1');
        visibleText = await waitFor(async () => {
          const result = await page!.call('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
          return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
        }, text => text.includes(demo.gcpApproval.message) && text.includes('보류'), 'scene 5 GCP approval choices');
        if (world.graphApprovalPosts.length !== 0) throw new Error('scene 5 posted approval before user tap');
        await tapButton('승인');
        await waitFor(async () => world.graphApprovalPosts.length, count => count === 1, 'scene 5 one GCP approval POST');
      }
      if (item.scene === 6 && demo) {
        // Pause and close each _blank child target before it can run or fetch.
        // The browser's Page.windowOpen proves the real link action; verified
        // sample bytes are then opened separately in the fenced parent tab.
        for (const attachment of demo.attachments.filter(item => item.kind === 'diagram' || item.kind === 'pdf')) {
          const point = await waitFor(async () => {
            const result = await page!.call('Runtime.evaluate', { expression: `(() => {
              const link = [...document.querySelectorAll('a')].find(item => item.href === ${JSON.stringify(attachment.url)} && item.textContent?.includes(${JSON.stringify(attachment.title)}));
              if (!link || link.target !== '_blank') return null;
              link.scrollIntoView({ block: 'center' });
              const rect = link.getBoundingClientRect();
              const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
              return rect.width > 0 && rect.height > 0 && document.elementFromPoint(x, y) === link ? { x, y } : null;
            })()`, returnByValue: true });
            return (result.result as Record<string, unknown> | undefined)?.value as { x: number; y: number } | null;
          }, value => !!value, `scene 6 ${attachment.kind} link`);
          const beforeWindowOpen = (page.events.get('Page.windowOpen') ?? []).length;
          const beforeBlockedTargets = blockedPopupTargetIds.length;
          blockPopupTargets = true;
          await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
          await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point!.x, y: point!.y, button: 'left', clickCount: 1 });
          await waitFor(async () => (page!.events.get('Page.windowOpen') ?? []).slice(beforeWindowOpen), events => events.some(event => event.url === attachment.url && event.userGesture === true),
            `scene 6 ${attachment.kind} user-opened popup`);
          await waitFor(async () => blockedPopupTargetIds.length, count => count > beforeBlockedTargets,
            `scene 6 ${attachment.kind} popup closed before network`);
          blockPopupTargets = false;
          await page.call('Page.navigate', { url: attachment.url });
          await waitFor(async () => fulfilledAttachments.includes(attachment.url), value => value,
            `scene 6 ${attachment.kind} verified bytes opened in fenced tab`);
          const opened = { windowOpen: true, popupBlocked: true, bytesFulfilled: true };
          openedAttachments.push({ kind: attachment.kind, url: attachment.url, ...opened });
          await page.call('Page.navigate', { url: `${baseUrl}/app/board/` });
          await waitFor(async () => {
            const result = await page!.call('Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
            return String((result.result as Record<string, unknown> | undefined)?.value ?? '');
          }, text => text.includes(attachment.title), `scene 6 board return after ${attachment.kind}`);
        }
      }
      const screenshot = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const screenshotPath = join(outputDir, `scene-${item.scene}.png`);
      await writeFile(screenshotPath, Buffer.from(String(screenshot.data), 'base64'));
      const errors = [...(page.events.get('Runtime.exceptionThrown') ?? [])];
      const failedRequests = [...(page.events.get('Network.loadingFailed') ?? [])];
      capturedScenes.push({ runId: replayRunId, sourceRunId: item.sourceRunId, scene: item.scene,
        input: { ...item.input, sourceRunId: item.sourceRunId },
        output: { matched: true, expected: item.expected, visibleText, sourceRunId: item.sourceRunId, screenshot: screenshotPath,
          pageErrors: errors, requestFailures: failedRequests } });
    }
    const allPages = scenePages;
    for (const target of allPages) {
      const blockedSocketRead = await target.call('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__kaistBlockedWebSockets ?? [])', returnByValue: true });
      const blockedSockets = JSON.parse(String((blockedSocketRead.result as Record<string, unknown> | undefined)?.value ?? '[]')) as string[];
      for (const socket of blockedSockets) if (!externalRequests.includes(socket)) externalRequests.push(socket);
    }
    const pageErrors = allPages.flatMap((target) => target.events.get('Runtime.exceptionThrown') ?? []);
    const failedLoads = allPages.flatMap((target) => {
      const requestUrls = new Map((target.events.get('Network.requestWillBeSent') ?? []).map((event) => [
        String(event.requestId ?? ''), String((event.request as Record<string, unknown> | undefined)?.url ?? ''),
      ]));
      return (target.events.get('Network.loadingFailed') ?? []).map((event) => ({
        ...event, url: requestUrls.get(String(event.requestId ?? '')) ?? '',
      }));
    }) as Array<{ canceled?: boolean; type?: string; url: string }>;
    const expectedCancellations = failedLoads.filter((event) => event.canceled === true && (
      (event.type === 'EventSource' && ['/v1/events', '/v1/chat/events'].includes(new URL(event.url || 'http://invalid/').pathname))
      || (demo && event.type === 'Document' && event.url === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html')
    ));
    const requestFailures = failedLoads.filter((event) => !expectedCancellations.includes(event));
    const receipt = { schemaVersion: 1, runId: replayRunId, sourceRunId, source: envelope.source, host: process.env.ELANOUS_REMOTE_HOST ?? 'unspecified',
      browser: 'Chromium headless · 390x844 mobile · loopback test-world only', scenes: capturedScenes,
      approvalPosts: world.approvalPosts,
      graphApprovalPosts: world.graphApprovalPosts, openedAttachments, blockedPopupTargetIds,
      sourceRuns: demo ? { absorb: sourceRunId, gcp: demo.gcpApproval.runId,
        relation: 'composed-test-world; cross-graph handoff unmeasured' } : undefined,
      pageErrors, requestFailures, expectedCancellations, externalRequests, blockedExternalRequests, targetFenceProbes, attachedTargetTypes, fencedTargetIds, interceptionErrors,
      webSocketFenceProbes,
      workerExecutionFenceProbes,
      unsupportedApiPaths: world.unsupportedApiPaths, missingStaticPaths,
      pass: world.approvalPosts.length === 1 && world.approvalPosts[0]?.hasMemberCookie === true
        && (!demo || (world.graphApprovalPosts.length === 1 && world.graphApprovalPosts[0]?.hasMemberCookie === true
          && world.graphApprovalPosts[0]?.decision === 'approved' && openedAttachments.length === 2
          && openedAttachments.every(item => item.windowOpen && item.popupBlocked && item.bytesFulfilled)))
        && pageErrors.length === 0 && requestFailures.length === 0 && externalRequests.length === 0
        && interceptionErrors.length === 0 && world.unsupportedApiPaths.length === 0 && missingStaticPaths.length === 0 };
    if (!receipt.pass) {
      throw new Error(`KAIST browser replay did not close cleanly: ${JSON.stringify({ pageErrors, requestFailures, externalRequests, interceptionErrors, unsupportedApiPaths: world.unsupportedApiPaths, missingStaticPaths })}`);
    }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`KAIST_PWA_BROWSER_RECEIPT ${JSON.stringify({ receiptPath, runId: replayRunId, scenes: capturedScenes.length, pass: true })}\n`);
    return receipt;
  } finally {
    page?.close();
    browser?.close();
    for (const target of scenePages) target.close();
    staticServer?.stop(true);
    chrome?.kill();
    if (browserDir) await rm(browserDir, { recursive: true, force: true });
  }
}

function asSceneOutput(scene: { output: Record<string, unknown> }): Record<string, any> { return scene.output as Record<string, any>; }
