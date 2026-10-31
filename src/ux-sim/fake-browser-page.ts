import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserHandDeps } from '../tool-runtime/browser-hand-runtime.js';
import type { BrowserActionDeps } from '../harness/browser-act.js';
import type { CdpClient, CdpEventListener } from '../browser-cdp/client.js';

export interface FakeBrowserPageOptions {
  pages: Record<string, string>;
  artifactDir: string;
  approved?: boolean;
}

/** Fake only the external page/CDP boundary; the coordinator and browser-act remain real. */
export function createFakeBrowserPage(options: FakeBrowserPageOptions) {
  const visits: string[] = [];
  const inspections: string[] = [];
  const clicks: Array<{ url: string; target: string }> = [];
  const confirmations: Array<{ url: string; target: string }> = [];
  let currentUrl = '';
  let pendingTarget = '';
  let listener: CdpEventListener | undefined;
  mkdirSync(options.artifactDir, { recursive: true });

  const client: CdpClient = {
    port: 0,
    pid: 0,
    get isAlive() { return true; },
    on(method, next) {
      if (method === 'Page.lifecycleEvent') listener = next;
      return () => { listener = undefined; };
    },
    async navigate(url) {
      if (!listener) throw new Error('fake browser page requires Page.lifecycleEvent subscription before navigate');
      const lifecycleListener = listener;
      currentUrl = url;
      visits.push(url);
      const navigation = { frameId: 'fake-frame', loaderId: `fake-loader-${visits.length}` };
      queueMicrotask(() => lifecycleListener({ method: 'Page.lifecycleEvent', params: { name: 'load', ...navigation } }));
      return navigation;
    },
    async screenshot() { return Buffer.from('fake page screenshot'); },
    async evaluate(expression) {
      if (expression === 'location.href') return currentUrl;
      if (expression.includes('document.querySelector(')) {
        const selector = expression.match(/document\.querySelector\(("(?:[^"\\]|\\.)*")\)/)?.[1];
        pendingTarget = selector ? JSON.parse(selector) as string : 'unknown-target';
        return { x: 10, y: 10, kind: 'navigation', href: currentUrl, text: pendingTarget };
      }
      throw new Error(`fake page does not implement CDP evaluate expression: ${expression.slice(0, 80)}`);
    },
    async setScriptExecutionDisabled() {},
    async click() { clicks.push({ url: currentUrl, target: pendingTarget }); },
    async close() {},
  };

  const browserActionDeps: BrowserActionDeps = {
    connect: async () => client,
    loadWaitTimeoutMs: 100,
    captureTimeoutMs: 100,
    reclaimOpenedTabs: false,
    saveAttachment: async (blob, filename) => {
      const path = join(options.artifactDir, filename);
      const png = Buffer.from(await blob.arrayBuffer());
      writeFileSync(path, png);
      return {
        ok: true,
        entry: { id: 'fake-capture', path, filename, mediaType: 'image/png', size: png.length, createdAt: 0 },
      };
    },
  };

  const deps: BrowserHandDeps = {
    confirmHuman: async input => { confirmations.push(input); return options.approved ?? true; },
    resolvePersona: async id => ({ personaId: id, displayName: 'UX sim page', actionHosts: Object.keys(options.pages).map(url => new URL(url).hostname) }),
    readPageText: async url => { inspections.push(url); return options.pages[url]; },
    browserActDeps: browserActionDeps,
    getApiKey: async () => 'fake-linear-key',
  };

  return { deps, visits, inspections, clicks, confirmations };
}
