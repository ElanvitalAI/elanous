import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAppScreen } from './app-screen-render.js';
import { discoverChromeBinary } from '../../browser-cdp/client.js';

const chromeTest = test.skipIf(process.platform !== 'darwin' || !discoverChromeBinary());

chromeTest('headless Chrome observes executed DOM text served by the Nexus app host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-fixed-html-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Fixed HTML render
frontend: { kind: static-export, out: out/ }
roles:
  owner: { via: nexus-session }
`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), `<!doctype html><html><body><main>
<h1>Before script</h1><p id="result">Waiting</p>
<script src="/app.js"></script>
</main></body></html>`);
  writeFileSync(join(appDirectory, 'out', 'app.js'), "document.querySelector('#result').textContent = 'Rendered after execution'; window.__ELANOUS_SIM_RENDER_READY__ = true;");
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.status).toBe('measured');
    if (result.status === 'measured') {
      expect(result.screenText).toContain('Rendered after execution');
      expect(result.screenText).not.toContain('document.querySelector');
      expect(result.blockedUrls).toEqual([]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing renderer is explicitly unmeasured', async () => {
  const result = await renderAppScreen({ appDirectory: '/missing', appSlug: 'demo-app', platform: 'darwin', discoverBinary: () => null });
  expect(result).toEqual({ status: 'unmeasured', reason: 'headless Chrome unavailable', blockedUrls: [], browserDeniedUrls: [] });
});

test('unsupported platform is explicitly unmeasured even when Chrome is discoverable', async () => {
  const result = await renderAppScreen({ appDirectory: '/missing', appSlug: 'demo-app', platform: 'linux', discoverBinary: () => '/usr/bin/chromium' });
  expect(result).toMatchObject({ status: 'unmeasured', reason: 'isolated Chrome renderer unavailable on this platform' });
});

chromeTest('headless render blocks and records external browser requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-blocked-network-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Blocked network render
frontend: { kind: static-export, out: out/ }
roles:
  owner: { via: nexus-session }
`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Local screen<script>fetch("https://example.invalid/secret").catch(() => {}); window.__ELANOUS_SIM_RENDER_READY__ = true</script></main>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.status).toBe('measured');
    expect(result.blockedUrls).toContain('https://example.invalid/secret');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('a screen requiring simulated runtime data stays unmeasured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-runtime-data-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Runtime data render
frontend: { kind: static-export, out: out/ }
roles:
  owner: { via: nexus-session }
`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Loading<script>fetch("/__rpc/listNotes", {method:"POST"}).catch(() => {}); window.__ELANOUS_SIM_RENDER_READY__ = true</script></main>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result).toMatchObject({ status: 'unmeasured', reason: 'app screen requires runtime data outside the static render' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('a delayed completion marker measures the settled screen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-delayed-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: Delayed render\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main id="state">Loading</main><script>setTimeout(() => { document.querySelector("#state").textContent="Settled"; window.__ELANOUS_SIM_RENDER_READY__=true }, 150)</script>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.status).toBe('measured');
    if (result.status === 'measured') expect(result.screenText).toContain('Settled');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('a script exception does not turn a partial screen into measured evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-exception-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: Exception render\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Partial</main><script>window.__ELANOUS_SIM_RENDER_READY__=true;throw new Error("broken")</script>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result).toMatchObject({ status: 'unmeasured', reason: 'page script exception' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('browser proxy denies a WebSocket bypass and records the attempted URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-websocket-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: WebSocket render\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Attempted</main><script>new WebSocket("wss://example.invalid/socket");window.__ELANOUS_SIM_RENDER_READY__=true</script>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.blockedUrls).toContain('wss://example.invalid/socket');
    expect(result.browserDeniedUrls.some((url) => url.includes('example.invalid'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('same-origin WebSocket upgrade is blocked and fails page evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-local-websocket-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: Local WebSocket render\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Attempted</main><script>new WebSocket("ws://"+location.host+"/socket");window.__ELANOUS_SIM_RENDER_READY__=true</script>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.blockedUrls.some((url) => url.endsWith('/socket'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('worker execution stays unmeasured and fails closed before nested requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-worker-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: Worker render\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Worker</main><script>new Worker("/worker.js");setTimeout(()=>window.__ELANOUS_SIM_RENDER_READY__=true,200)</script>');
  writeFileSync(join(appDirectory, 'out', 'worker.js'), 'fetch("https://worker.example.invalid/ping").catch(()=>{})');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.status).toBe('unmeasured');
    expect(result.blockedUrls.some((url) => url.endsWith('/worker.js'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

chromeTest('a missing script asset leaves the screen unmeasured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'app-render-script-asset-'));
  const appDirectory = join(root, 'demo-app');
  mkdirSync(join(appDirectory, 'out'), { recursive: true });
  writeFileSync(join(appDirectory, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: demo-app\ntitle: Missing script\nfrontend: { kind: static-export, out: out/ }\nroles:\n  owner: { via: nexus-session }\n`);
  writeFileSync(join(appDirectory, 'out', 'index.html'), '<main>Partial</main><script src="/missing.js"></script><script>window.__ELANOUS_SIM_RENDER_READY__=true</script>');
  try {
    const result = await renderAppScreen({ appDirectory, appSlug: 'demo-app' });
    expect(result.status).toBe('unmeasured');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
