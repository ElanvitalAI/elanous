import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, type ComponentProps } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _setEventSourceFactoryForTest } from '@/lib/shared-event-source';
import { parseHTML } from 'linkedom';
import { InsidePageContent } from './InsidePage';
import { ArchitectureScene } from './ArchitectureScene';
import { ARCHITECTURE_MAP } from './architecture-map';
import { leaksInternal } from './public-text';

let params = new URLSearchParams();

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event };

// linkedom's `window` is a proxy over globalThis: `Object.defineProperty(window, k, …)` lands on globalThis as a
// non-writable property and outlives this file, so a later file in the same bun process fails on `globalThis.k = …`.
const WINDOW_DEFINED_KEYS = ['location', 'history', 'localStorage'] as const;
const globalDescriptors = WINDOW_DEFINED_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
function restoreWindowDefinedGlobals(): void {
  for (const [k, d] of globalDescriptors) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
}
let root: import('react-dom/client').Root;
let host: HTMLElement;
let address: URL;
let storage: Map<string, string>;
let storageFails = false;
let fullscreenCalls = 0;

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  address = new URL('https://example.test/inside');
  params = address.searchParams;
  storage = new Map();
  storageFails = false;
  fullscreenCalls = 0;
  Object.defineProperty(window, 'location', { configurable: true, value: { get href() { return address.toString(); } } });
  Object.defineProperty(window, 'history', { configurable: true, value: {
    state: null, replaceState: (_state: unknown, _title: string, url: string) => { address = new URL(url); },
  } });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => { if (storageFails) throw Error('unavailable'); return storage.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storageFails) throw Error('unavailable'); storage.set(key, value); },
  } });
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  _setEventSourceFactoryForTest(null);
  Object.assign(globalThis, originals);
  restoreWindowDefinedGlobals();
});

async function render(query = '', liveTrace: import('react').ReactNode = <p data-live-trace>라이브 트레이스</p>) {
  address = new URL(`https://example.test/inside${query}`);
  params = address.searchParams;
  await act(async () => root.render(<InsidePageContent search={params} liveTrace={liveTrace} editorScene={<p data-editor-scene>편집기</p>} loopScene={<p data-loop-scene>루프</p>} wizardScene={<p data-wizard-scene>마법사 단계</p>} ptyScene={<p data-pty-scene>PTY</p>} />));
}

async function key(value: string, target: Element = document.body) {
  await act(async () => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true }) as KeyboardEvent;
    Object.defineProperty(event, 'key', { value });
    target.dispatchEvent(event);
  });
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new window.Event('click', { bubbles: true })); });
}

const selected = () => host.querySelector('nav [aria-current="page"]')?.textContent;
const scenes = () => [...host.querySelectorAll('[data-inside-scene]')];

test('six tabs, default and out-of-range query fall back to ①; scene ③ is addressable and earlier scenes stay mounted hidden', async () => {
  await render('?scene=9');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(selected()).toContain('1 문서 아키텍처');
  const first = scenes()[0];
  expect(first.querySelectorAll('details')).toHaveLength(6);
  await click(host.querySelectorAll('nav button')[2]);
  expect(selected()).toContain('3 루프 에이전트');
  expect(address.searchParams.get('scene')).toBe('3');
  expect(scenes()[0]).toBe(first);
  expect(first.hasAttribute('hidden')).toBe(true);
  expect(scenes()[2].hasAttribute('hidden')).toBe(false);
  expect(scenes()[1].querySelector('[data-live-trace]')).not.toBeNull();
  expect(scenes()[3].querySelector('[data-editor-scene]')).not.toBeNull();
  expect(scenes()[2].querySelector('[data-loop-scene]')).not.toBeNull();
  expect(scenes()[4].querySelector('[data-wizard-scene]')?.textContent).toBe('마법사 단계');
  expect(scenes()[5].querySelector('[data-pty-scene]')).not.toBeNull();
  expect(leaksInternal(scenes()[4].textContent ?? '')).toEqual([]);
  await render('?scene=3');
  expect(selected()).toContain('3 루프 에이전트');
});

test('arrow keys change scene, editable targets do not; F requests fullscreen only when supported', async () => {
  await render();
  const input = document.createElement('input');
  host.appendChild(input);
  await key('ArrowRight', input);
  expect(selected()).toContain('1 문서 아키텍처');
  await key('ArrowRight');
  expect(selected()).toContain('2 라이브 트레이스');
  await key('ArrowLeft');
  expect(selected()).toContain('1 문서 아키텍처');
  await key('f');
  expect(fullscreenCalls).toBe(0);
  Object.defineProperty(host.querySelector('main'), 'requestFullscreen', { configurable: true, value: () => { fullscreenCalls++; return Promise.resolve(); } });
  await key('F');
  expect(fullscreenCalls).toBe(1);
});

test('demo query and D persist, keep fifth tab and leave only public text on the stage', async () => {
  await render('?scene=5&demo=1');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(host.querySelectorAll('nav button')[4].textContent).toContain('5 마법사 → 마켓');
  expect(host.textContent).toContain('시연');
  expect(selected()).toContain('5 마법사 → 마켓');
  expect(scenes()[4].querySelector('[data-wizard-scene]')).not.toBeNull();
  expect(leaksInternal(host.textContent ?? '')).toEqual([]);
  await key('d');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(selected()).toContain('5 마법사 → 마켓');
  expect(storage.get('elanous.inside.demo')).toBe('0');
  await key('D');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(selected()).toContain('5 마법사 → 마켓');
  expect(storage.get('elanous.inside.demo')).toBe('1');
  expect(address.searchParams.get('demo')).toBe('1');
});

test('?demo=1 alone is remembered, so a later bare /inside opens in demo mode (review must-fix · INSIDE1a)', async () => {
  await render('?demo=1');
  expect(storage.get('elanous.inside.demo')).toBe('1');
  await render();
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(host.querySelector('[aria-label="시연 모드"]')).not.toBeNull();
  await render('?demo=0');
  expect(storage.get('elanous.inside.demo')).toBe('0');
});

test('demo state is restored from storage; denied reads and writes fall back to the URL', async () => {
  storage.set('elanous.inside.demo', '1');
  await render();
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  expect(host.querySelector('[aria-label="시연 모드"]')).not.toBeNull();
  storageFails = true;
  await key('d');
  expect(address.searchParams.get('demo')).toBe('0');
  await key('d');
  expect(address.searchParams.get('demo')).toBe('1');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
  await render('?demo=0');
  expect(host.querySelectorAll('nav button')).toHaveLength(6);
});

test('ArchitectureScene renders six mapped cells in pillar-foundation-floor order and reveals paths on expansion', async () => {
  await act(async () => root.render(<ArchitectureScene />));
  const map = host.querySelector('[data-architecture-scene]')!;
  expect(map.getAttribute('style')).toContain('font-size:18px');
  expect(map.children[1].getAttribute('aria-label')).toBe('네 기둥');
  expect(map.children[2].getAttribute('aria-label')).toBe('받침');
  expect(map.children[2].getAttribute('style')).toContain('max-width:480px');
  expect(map.children[2].getAttribute('style')).toContain('justify-self:center');
  expect(map.children[3].getAttribute('aria-label')).toBe('바닥');
  const cells = [...map.querySelectorAll('details')];
  expect(cells).toHaveLength(6);
  for (const [index, entry] of [...ARCHITECTURE_MAP.slice(0, 4), ARCHITECTURE_MAP[5], ARCHITECTURE_MAP[4]].entries()) {
    expect(cells[index].querySelector('summary')?.textContent).toBe(entry.title);
  }
  const cell = cells[0];
  expect(cell.hasAttribute('open')).toBe(false);
  await click(cell.querySelector('summary')!);
  expect(cell.hasAttribute('open')).toBe(true);
  expect(cell.querySelectorAll('li')).toHaveLength(ARCHITECTURE_MAP[0].docs.length + ARCHITECTURE_MAP[0].code.length);
  // every listed path is shown whole — a long hyphenated file name is not a secret (review must-fix · INSIDE1a)
  expect([...cell.querySelectorAll('li')].map((li) => li.textContent)).toEqual([...ARCHITECTURE_MAP[0].docs, ...ARCHITECTURE_MAP[0].code]);
  expect(leaksInternal(cell.textContent ?? '')).toEqual([]);
  expect(cell.textContent).toContain('src/mission-loop/composite-cycle.ts');
  expect(cell.textContent).toContain('src/harness/mission-solve-loop.ts');
  await click(cell.querySelector('summary')!);
  expect(cell.hasAttribute('open')).toBe(false);
});

const BUILD_TIMEOUT_MS = 300_000;
const BROWSER_TIMEOUT_MS = 360_000;

function exportedInsideIsFresh(pwaDir: string): boolean {
  const insideHtml = join(pwaDir, 'out/inside/index.html');
  if (!existsSync(insideHtml) || !existsSync(join(pwaDir, 'out/_next'))) return false;
  const builtAt = statSync(insideHtml).mtimeMs;
  const sourceDirs = ['src', 'public'];
  const inputs = ['next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'package.json', 'bun.lock'];
  for (const input of inputs) {
    const path = join(pwaDir, input);
    if (!existsSync(path) || statSync(path).mtimeMs >= builtAt) return false;
  }
  const dirs = sourceDirs.map((dir) => join(pwaDir, dir));
  while (dirs.length) {
    const dir = dirs.pop()!;
    if (!existsSync(dir)) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile() && statSync(path).mtimeMs >= builtAt) return false;
    }
  }
  return true;
}

test('exported /inside is reused only when its HTML is newer than PWA sources and build inputs', () => {
  const pwaDir = mkdtempSync(join(tmpdir(), 'inside-export-freshness-'));
  const inputFiles = ['next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'package.json', 'bun.lock'];
  try {
    mkdirSync(join(pwaDir, 'src/nested'), { recursive: true });
    mkdirSync(join(pwaDir, 'public'), { recursive: true });
    mkdirSync(join(pwaDir, 'out/inside'), { recursive: true });
    mkdirSync(join(pwaDir, 'out/_next'), { recursive: true });
    for (const input of [...inputFiles, 'src/nested/InsidePage.tsx', 'public/icon.svg', 'out/inside/index.html']) {
      const path = join(pwaDir, input);
      writeFileSync(path, input);
      utimesSync(path, new Date(1_000), new Date(1_000));
    }
    const html = join(pwaDir, 'out/inside/index.html');
    utimesSync(html, new Date(3_000), new Date(3_000));
    expect(exportedInsideIsFresh(pwaDir)).toBe(true);
    utimesSync(join(pwaDir, 'src/nested/InsidePage.tsx'), new Date(3_000), new Date(3_000));
    expect(exportedInsideIsFresh(pwaDir)).toBe(false);
    utimesSync(join(pwaDir, 'src/nested/InsidePage.tsx'), new Date(1_000), new Date(1_000));
    for (const input of ['src/nested/InsidePage.tsx', 'public/icon.svg', ...inputFiles]) {
      const path = join(pwaDir, input);
      utimesSync(path, new Date(4_000), new Date(4_000));
      expect(exportedInsideIsFresh(pwaDir)).toBe(false);
      utimesSync(path, new Date(1_000), new Date(1_000));
    }
    rmSync(html);
    expect(exportedInsideIsFresh(pwaDir)).toBe(false);
    writeFileSync(html, 'out/inside/index.html');
    utimesSync(html, new Date(3_000), new Date(3_000));
    rmSync(join(pwaDir, 'out/_next'), { recursive: true });
    expect(exportedInsideIsFresh(pwaDir)).toBe(false);
  } finally {
    rmSync(pwaDir, { recursive: true, force: true });
  }
});

// Run wherever a browser exists (gate pod: /usr/local/bin/chromium · Mac: Google Chrome · or CHROME_BIN). Only when none is
// found is the test skipped — and it says so, never silently (OP 12:4x · INSIDE1c follow-up: a Mac gate went red on a
// hard-coded pod path).
const CHROMIUM = [process.env.CHROME_BIN, '/usr/local/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((path): path is string => !!path && existsSync(path));
if (!CHROMIUM) console.warn('[skip] fresh exported /inside browser check — no Chromium/Chrome found (CHROME_BIN · /usr/local/bin/chromium · Google Chrome.app)');
test.skipIf(!CHROMIUM)('fresh exported /inside renders scene ①② at 375px, 1440px and 1920px in Chromium without overflow', async () => {
  const pwaDir = join(import.meta.dir, '../../..');
  if (!exportedInsideIsFresh(pwaDir)) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: pwaDir, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, maxBuffer: 10_000_000 });
    expect(build.status, build.error?.message || build.stderr || build.stdout).toBe(0);
  }
  const out = join(pwaDir, 'out');
  expect(existsSync(join(out, 'inside/index.html'))).toBe(true);
  const server = Bun.serve({ port: 0, fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    const relative = pathname.replace(/^\/app\//, '').replace(/\/$/, '/index.html') || 'index.html';
    if (!pathname.startsWith('/app/') || relative.includes('..')) return new Response('not found', { status: 404 });
    const path = join(out, relative);
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css'
      : path.endsWith('.js') ? 'application/javascript' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    return new Response(Bun.file(path), { headers: { 'content-type': type } });
  } });
  const initial = await (await fetch(`http://127.0.0.1:${server.port}/app/inside/?demo=0`)).text();
  expect(initial).toContain('베타 — 화면과 동작이 바뀔 수 있습니다.');
  expect(initial).toContain('엘라누스 안쪽');
  const profile = mkdtempSync(join(tmpdir(), 'inside-browser-'));
  const browser = spawn(CHROMIUM!, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    let debuggerUrl = '';
    for (let attempt = 0; attempt < 100 && !debuggerUrl; attempt++) {
      if (!browser.pid || browser.exitCode !== null) throw Error('Chromium exited before exposing CDP');
      if (existsSync(join(profile, 'DevToolsActivePort'))) {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        try {
          const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          debuggerUrl = tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl ?? '';
        } catch { /* CDP endpoint not ready yet. */ }
      }
      if (!debuggerUrl) await Bun.sleep(100);
    }
    expect(debuggerUrl).not.toBe('');
    socket = new WebSocket(debuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(Error('CDP connection failed')); });
    let id = 0;
    const pending = new Map<number, (result: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }) => void>();
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };
      if (reply.id && pending.has(reply.id)) { pending.get(reply.id)!(reply); pending.delete(reply.id); }
    };
    const send = (method: string, params: object = {}) => new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }>((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket!.send(JSON.stringify({ id: next, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__insideStreams = [];
      window.EventSource = class {
        constructor(url) { this.url = url; this.handlers = {}; window.__insideStreams.push(this); }
        addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
        removeEventListener(name, fn) { this.handlers[name] = (this.handlers[name] || []).filter((handler) => handler !== fn); }
        close() {}
        emit(frame) { for (const handler of this.handlers.log || []) handler({ data: JSON.stringify(frame) }); }
      };
    ` });
    const url = `http://127.0.0.1:${server.port}/app/inside/?demo=0`;
    const demoUrl = `http://127.0.0.1:${server.port}/app/inside/?demo=1`;
    await send('Page.navigate', { url: demoUrl });
    let demoBanner: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await send('Runtime.evaluate', { expression: `(() => {
        if (!document.querySelector('[data-inside-page] [aria-label="시연 모드"]')) return null;
        return document.body.innerText.includes('베타 — 화면과 동작이 바뀔 수 있습니다.');
      })()`, returnByValue: true });
      demoBanner = response.result?.result?.value;
      if (demoBanner === false) break;
      await Bun.sleep(100);
    }
    expect(demoBanner).toBe(false);
    const frame = { category: 'graph.run', event: 'node', ts: '2026-10-03T00:00:00Z', data: { graphId: 'demo', runId: 'demo123', nodeId: 'alpha', phase: 'start' } };
    for (const width of [375, 1440, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url });
      for (const scene of [1, 2]) {
      let measured: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await send('Runtime.evaluate', { expression: `(() => {
          const stage = document.querySelector('[data-inside-page]');
          const active = document.querySelector('[data-inside-scene="${scene}"]');
          if (!stage || !active || active.hidden || location.pathname !== '/app/inside/') return null;
          const font = (selector) => getComputedStyle(document.querySelector(selector)).fontSize;
          return { title: font('[data-inside-page] h1'), tab: font('[data-inside-page] nav button'),
            scene1: ${scene} === 1 ? font('[data-inside-scene="1"] [data-architecture-scene] details p') : null,
            scene1Cell: ${scene} === 1 ? font('[data-inside-scene="1"] [data-architecture-scene] details summary') : null,
            scene2: ${scene} === 2 ? font('[data-inside-scene="2"] section header h2') : null,
            chip: ${scene} === 2 ? font('[data-inside-scene="2"] [role="listitem"] span') : null,
            scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
        })()`, returnByValue: true });
        expect(response.error).toBeUndefined();
        expect(response.result?.exceptionDetails).toBeUndefined();
        measured = response.result?.result?.value as Record<string, unknown> | undefined;
        if (measured) break;
        await Bun.sleep(100);
      }
      if (!measured) {
        const diagnostic = await send('Runtime.evaluate', { expression: `({ href: location.href, text: document.body.innerText.slice(0, 400), stage: !!document.querySelector('[data-inside-page]'), active: !!document.querySelector('[data-inside-scene="${scene}"]') })`, returnByValue: true });
        throw Error(`browser scene ${scene} at ${width}: ${JSON.stringify(diagnostic.result?.result?.value)}`);
      }
      expect(measured!.viewport).toBe(width);
      expect(measured!.scrollWidth).toBeLessThanOrEqual(width);
      expect(measured!.title).toBe(width === 375 ? '28px' : '40px');
      expect(measured!.tab).toBe(width === 375 ? '18px' : '22px');
      if (scene === 1) {
        expect(measured!.scene1).toBe(width === 375 ? '18px' : '22px');
        expect(measured!.scene1Cell).toBe(width === 375 ? '18px' : '22px');
      } else {
        expect(measured!.scene2).toBe(width === 375 ? '18px' : '22px');
        expect(measured!.chip).toBe(width === 375 ? '18px' : '22px');
      }
      if (scene === 1) {
        await send('Runtime.evaluate', { expression: `document.querySelectorAll('[data-inside-page] nav button')[1].click()` });
        for (let attempt = 0; attempt < 50; attempt++) {
          const streams = await send('Runtime.evaluate', { expression: `window.__insideStreams.length`, returnByValue: true });
          if (Number(streams.result?.result?.value) > 0) break;
          await Bun.sleep(100);
        }
        const injected = await send('Runtime.evaluate', { expression: `(() => { const stream = window.__insideStreams.find(s => s.url.includes('/v1/logs/stream') && /category=graph\\.run/.test(s.url)); if (!stream) return false; stream.emit(${JSON.stringify(frame)}); return true; })()`, returnByValue: true });
        expect(injected.result?.result?.value).toBe(true);
      }
      }
    }
  } finally {
    socket?.close();
    browser.kill();
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}, BUILD_TIMEOUT_MS + BROWSER_TIMEOUT_MS);

if (!CHROMIUM) console.warn('[skip] fold approximation /inside browser check — no Chromium/Chrome found');
test.skipIf(!CHROMIUM)('fresh exported /inside scenes 1–6 at approximate folded outer 344px, unfolded inner 884px, and 1920px stay inside the viewport in Chromium', async () => {
  const pwaDir = join(import.meta.dir, '../../..');
  if (!exportedInsideIsFresh(pwaDir)) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: pwaDir, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, maxBuffer: 10_000_000 });
    expect(build.status, build.error?.message || build.stderr || build.stdout).toBe(0);
  }
  const out = join(pwaDir, 'out');
  expect(existsSync(join(out, 'inside/index.html'))).toBe(true);
  const server = Bun.serve({ port: 0, fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    const relative = pathname.replace(/^\/app\//, '').replace(/\/$/, '/index.html') || 'index.html';
    if (!pathname.startsWith('/app/') || relative.includes('..')) return new Response('not found', { status: 404 });
    const path = join(out, relative);
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css'
      : path.endsWith('.js') ? 'application/javascript' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    return new Response(Bun.file(path), { headers: { 'content-type': type } });
  } });
  const profile = mkdtempSync(join(tmpdir(), 'inside-fold-browser-'));
  const browser = spawn(CHROMIUM!, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  try {
    let debuggerUrl = '';
    for (let attempt = 0; attempt < 100 && !debuggerUrl; attempt++) {
      if (!browser.pid || browser.exitCode !== null) throw Error('Chromium exited before exposing CDP');
      if (existsSync(join(profile, 'DevToolsActivePort'))) {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        try {
          const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
          debuggerUrl = tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl ?? '';
        } catch { /* CDP endpoint not ready yet. */ }
      }
      if (!debuggerUrl) await Bun.sleep(100);
    }
    expect(debuggerUrl).not.toBe('');
    socket = new WebSocket(debuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = () => reject(Error('CDP connection failed')); });
    let id = 0;
    const pending = new Map<number, (result: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }) => void>();
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown };
      if (reply.id && pending.has(reply.id)) { pending.get(reply.id)!(reply); pending.delete(reply.id); }
    };
    const send = (method: string, params: object = {}) => new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown }; error?: unknown }>((resolve) => {
      const next = ++id;
      pending.set(next, resolve);
      socket!.send(JSON.stringify({ id: next, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const url = `http://127.0.0.1:${server.port}/app/inside/?demo=0`;
    for (const width of [344, 884, 1920]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url });
      for (const scene of [1, 2, 3, 4, 5, 6]) {
        let measured: { scrollWidth: number; clientWidth: number; navLeft: number; navRight: number; navVisible: boolean; contentVisible: boolean; clipped: string[] } | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          const response = await send('Runtime.evaluate', { expression: `(() => {
            const stage = document.querySelector('[data-inside-page]');
            const buttons = stage?.querySelector('nav')?.querySelectorAll('button');
            const active = stage?.querySelector('[data-inside-scene="${scene}"]');
            if (location.pathname !== '/app/inside/' || buttons?.length !== 6 ||
                !active || active.hidden || buttons[${scene - 1}].getAttribute('aria-current') !== 'page') return null;
            const nav = stage.querySelector('nav');
            const box = nav.getBoundingClientRect();
            const anchors = {
              1: ['[data-architecture-scene] h2', '[data-architecture-scene] details summary'],
              2: ['[aria-label="라이브 트레이스"] p'],
              3: ['[aria-label="루프 에이전트 보기"] button', '[aria-label="루프 에이전트 활동"] article', '[aria-label="지금 도는 런"] p'],
              4: ['[aria-label="그래프 편집 모드"] button', '[aria-label="실행 그래프 목록"]', '[aria-label="실행 그래프 캔버스"]'],
              5: ['[aria-label="마법사 → 마켓"] p', '[aria-label="마법사 → 마켓"] code'],
              6: ['[aria-label="PTY 인텔리전스"] h2', '[aria-label="PTY 인텔리전스"] p'],
            }[${scene}];
            const viewport = document.documentElement.clientWidth;
            const clipped = [];
            let contentVisible = true;
            for (const selector of anchors) {
              const items = [...active.querySelectorAll(selector)];
              if (!items.length) { contentVisible = false; clipped.push('missing ' + selector); continue; }
              for (const item of items) {
                const rect = item.getBoundingClientRect();
                const style = getComputedStyle(item);
                if (!item.getClientRects().length || style.visibility !== 'visible' || style.display === 'none' ||
                    (selector !== '[aria-label="실행 그래프 캔버스"]' && !item.textContent.trim()) ||
                    rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= viewport) {
                  contentVisible = false;
                  clipped.push('invisible ' + selector);
                  continue;
                }
                let left = 0, right = viewport;
                let scrollable = false;
                for (let parent = item.parentElement; parent; parent = parent.parentElement) {
                  const overflow = getComputedStyle(parent).overflowX;
                  if (!['hidden', 'clip', 'auto', 'scroll'].includes(overflow)) continue;
                  const bounds = parent.getBoundingClientRect();
                  if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollWidth > parent.clientWidth) {
                    if (bounds.left < right && bounds.right > left) scrollable = true;
                    continue;
                  }
                  left = Math.max(left, bounds.left);
                  right = Math.min(right, bounds.right);
                }
                if ((rect.left < left - 1 || rect.right > right + 1) && !scrollable)
                  clipped.push(selector + ' ' + Math.round(rect.left) + '..' + Math.round(rect.right) + ' outside ' + Math.round(left) + '..' + Math.round(right));
                if (scrollable && selector === '[aria-label="실행 그래프 캔버스"]') {
                  const panel = item.closest('[role="tabpanel"]');
                  const old = panel.scrollLeft;
                  panel.scrollLeft = panel.scrollWidth;
                  if (panel.scrollLeft <= old) clipped.push('editor content cannot be scrolled into view');
                  panel.scrollLeft = old;
                }
              }
            }
            return { scrollWidth: document.documentElement.scrollWidth, clientWidth: viewport,
              navLeft: box.left, navRight: box.right, navVisible: box.width > 0 && box.height > 0, contentVisible, clipped };
          })()`, returnByValue: true });
          expect(response.error).toBeUndefined();
          expect(response.result?.exceptionDetails).toBeUndefined();
          measured = response.result?.result?.value as typeof measured;
          if (measured) break;
          await Bun.sleep(100);
        }
        if (!measured) {
          const diagnostic = await send('Runtime.evaluate', { expression: `({ href: location.href, text: document.body.innerText.slice(0, 400), stage: !!document.querySelector('[data-inside-page]'), active: !!document.querySelector('[data-inside-scene="${scene}"]'), buttons: [...document.querySelectorAll('[data-inside-page] nav button')].map(button => button.getAttribute('aria-current')) })`, returnByValue: true });
          throw Error(`browser scene ${scene} at ${width}: ${JSON.stringify(diagnostic.result?.result?.value)}`);
        }
        const label = `scene ${scene} at ${width}px: scrollWidth ${measured.scrollWidth}`;
        expect(measured.clientWidth, label).toBe(width);
        expect(measured.scrollWidth, label).toBeLessThanOrEqual(measured.clientWidth);
        expect(measured.navVisible && measured.navLeft >= 0 && measured.navRight <= measured.clientWidth, label).toBe(true);
        expect(measured.contentVisible, `${label}: ${measured.clipped.join('; ')}`).toBe(true);
        expect(measured.clipped, label).toEqual([]);
        if (scene < 6) {
          const click = await send('Runtime.evaluate', { expression: `document.querySelectorAll('[data-inside-page] nav button')[${scene}].click()` });
          expect(click.error, label).toBeUndefined();
          expect(click.result?.exceptionDetails, label).toBeUndefined();
        }
      }
    }
  } finally {
    socket?.close();
    browser.kill();
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
}, BUILD_TIMEOUT_MS + BROWSER_TIMEOUT_MS);

test('architecture cells expand to show documented paths with at least 18px base text', async () => {
  await render();
  const stage = host.querySelector('main')!;
  expect(stage.getAttribute('style')).toContain('font-size:18px');
  expect(host.querySelector('nav')?.getAttribute('style')).toContain('48px');
  expect(host.querySelector('[aria-label="네 기둥"]')?.querySelectorAll('details')).toHaveLength(4);
  const cell = host.querySelector('[aria-label="네 기둥"] details')!;
  expect(cell.querySelector('summary')?.textContent).toContain('미션 패브릭');
  expect(cell.hasAttribute('open')).toBe(false);
  await click(cell.querySelector('summary')!);
  expect(cell.hasAttribute('open')).toBe(true);
  expect(cell.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
  expect(cell.textContent).toContain('docs/manual/');
  const map = host.querySelector('[data-architecture-scene]')!;
  expect(map.children[1].getAttribute('aria-label')).toBe('네 기둥');
  expect(map.children[2].getAttribute('aria-label')).toBe('받침');
  expect(map.children[3].getAttribute('aria-label')).toBe('바닥');
});

test('scene ⑥ receives distinct sanitized approval and denial outcomes through live SSE without leaking command text', async () => {
  const listeners = new Set<(event: unknown) => void>();
  let closed = false;
  let streamUrl = '';
  _setEventSourceFactoryForTest((url) => {
    streamUrl = url;
    return {
      addEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'log') listeners.add(listener); },
      removeEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'log') listeners.delete(listener); },
      close: () => { closed = true; },
    } as unknown as EventSource;
  });
  const client = {
    logsStreamUrl: (params: Record<string, string>) => `/v1/logs/stream?${new URLSearchParams(params)}`,
    snapshotTerminal: async () => ({ status: 'success' as const, screen: 'ready' }),
    streamTerminal: () => () => {},
  };
  type Context = NonNullable<ComponentProps<typeof DaemonContext.Provider>['value']>;
  const context = { client: client as unknown as Context['client'], config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
  address = new URL('https://example.test/inside?scene=6');
  await act(async () => root.render(<DaemonContext.Provider value={context}><InsidePageContent search={address.searchParams} liveTrace={<p />} editorScene={<p />} loopScene={<p />} wizardScene={<p />} /></DaemonContext.Provider>));
  const line = () => host.querySelector('[data-inside-scene="6"] [aria-label="PTY 인텔리전스"]')!;
  expect(streamUrl).toBe('/v1/logs/stream?exactCategory=pty.decision');
  expect(line().textContent).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 기록 없음');
  expect(line().querySelectorAll('li')).toHaveLength(0);
  const base = { ts: new Date().toISOString(), missionId: 'mission-1', sessionId: 'session-1', terminalId: 'terminal-1', agent: 'codex' };
  const emit = async (data: Record<string, unknown>) => {
    await act(async () => { for (const listener of listeners) listener({ data: JSON.stringify({ category: 'pty.decision', event: data.step, data }) }); });
  };
  await emit({ ...base, seq: 1, step: 'read', text: 'cat /home/ubuntu/private/command' });
  await emit({ ...base, seq: 2, step: 'judge', text: '판단' });
  await emit({ ...base, seq: 3, step: 'answer', text: 'run sensitive command', detail: { question: '진행?', answer: '승인 OP /home/ubuntu/private/command' } });
  await emit({ ...base, seq: 4, step: 'answer', text: 'rm sensitive command', detail: { question: '거부?', answer: '거부' } });
  const outcomes = [...line().querySelectorAll('li')].map(item => item.textContent ?? '');
  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]).toContain('거부');
  expect(outcomes[1]).toMatch(/ · 승인$/);
  expect(line().textContent).not.toContain('COO');
  expect([...line().querySelectorAll('li time')].map(time => time.getAttribute('dateTime'))).toEqual([base.ts, base.ts]);
  for (const secret of ['진행?', '거부?', 'private/command', 'run sensitive command', 'rm sensitive command', 'cat /home/ubuntu']) expect(line().textContent).not.toContain(secret);
  expect(leaksInternal(line().textContent ?? '')).toEqual([]);
  expect(line().textContent).not.toContain('지금 PTY 판단이 없습니다');
  await act(async () => root.unmount());
  expect(listeners.size).toBe(0);
  expect(closed).toBe(true);
});

test('scene ⑥ clears old decisions and releases the old stream when the daemon client changes', async () => {
  const streams = new Map<string, { listeners: Set<(event: unknown) => void>; closed: boolean }>();
  _setEventSourceFactoryForTest((url) => {
    const source = { listeners: new Set<(event: unknown) => void>(), closed: false };
    streams.set(url, source);
    return {
      addEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'log') source.listeners.add(listener); },
      removeEventListener: (name: string, listener: (event: unknown) => void) => { if (name === 'log') source.listeners.delete(listener); },
      close: () => { source.closed = true; },
    } as unknown as EventSource;
  });
  type Context = NonNullable<ComponentProps<typeof DaemonContext.Provider>['value']>;
  const client = (url: string | null) => ({
    logsStreamUrl: (params: Record<string, string>) => {
      expect(params).toEqual({ exactCategory: 'pty.decision' });
      return url;
    },
    snapshotTerminal: async () => ({ status: 'success' as const, screen: 'ready' }),
    streamTerminal: () => () => {},
  });
  const a = client('/daemon-a');
  const unavailable = client(null);
  const b = client('/daemon-b');
  const show = async (current: typeof a) => {
    const context: Context = { client: current as unknown as Context['client'], config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
    await act(async () => root.render(<DaemonContext.Provider value={context}><InsidePageContent search={params} liveTrace={<p />} editorScene={<p />} loopScene={<p />} wizardScene={<p />} /></DaemonContext.Provider>));
  };
  const emit = async (url: string, missionId: string, text: string) => {
    const data = { ts: new Date().toISOString(), missionId, seq: 1, sessionId: 'session-1', terminalId: 'terminal-1', agent: 'codex', step: 'read', text };
    await act(async () => { for (const listener of streams.get(url)!.listeners) listener({ data: JSON.stringify({ category: 'pty.decision', event: 'read', data }) }); });
  };
  const line = () => host.querySelector('[data-inside-scene="6"] [aria-label="PTY 인텔리전스"]')!;
  params = new URLSearchParams('scene=6');
  await show(a);
  await emit('/daemon-a', 'mission-a', '이전 판단');
  expect(line().textContent).toContain('지금 PTY 판단이 없습니다');
  expect(line().textContent).not.toContain('이전 판단');

  await show(unavailable);
  expect(streams.get('/daemon-a')!.closed).toBe(true);
  expect(streams.get('/daemon-a')!.listeners.size).toBe(0);
  expect(streams.size).toBe(1);
  expect(line().textContent).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 기록 없음');
  expect(line().textContent).not.toContain('이전 판단');

  await show(b);
  expect(line().textContent).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 기록 없음');
  await emit('/daemon-b', 'mission-b', '새 판단');
  expect(line().querySelectorAll('li')).toHaveLength(0);
  expect(line().textContent).toContain('지금 PTY 판단이 없습니다');
  expect(line().textContent).not.toContain('새 판단');
  expect(line().textContent).not.toContain('이전 판단');
  await act(async () => root.unmount());
  expect(streams.get('/daemon-b')!.closed).toBe(true);
  expect(streams.get('/daemon-b')!.listeners.size).toBe(0);
});

test('scene ⑥ is addressable; demo arrows visit ⑤ in both directions (④ → ⑤ → ⑥ → ⑤)', async () => {
  await render('?scene=6');
  expect(scenes()[5].hasAttribute('hidden')).toBe(false);
  expect(scenes()[5].querySelector('[data-pty-scene]')).not.toBeNull();
  await render('?demo=1&scene=4');
  const previous = scenes().filter((_, index) => index !== 4);
  await key('ArrowRight');
  expect(scenes()[4].hasAttribute('hidden')).toBe(false);
  expect(selected()).toContain('5 마법사 → 마켓');
  expect(address.searchParams.get('scene')).toBe('5');
  for (const old of previous) expect(scenes()).toContain(old);
  await key('ArrowRight');
  expect(scenes()[5].hasAttribute('hidden')).toBe(false);
  await key('ArrowLeft');
  expect(scenes()[4].hasAttribute('hidden')).toBe(false);
  await click(host.querySelectorAll('nav button')[4]);
  expect(selected()).toContain('5 마법사 → 마켓');
});
