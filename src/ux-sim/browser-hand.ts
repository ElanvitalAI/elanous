// BrowserHand 시뮬레이션 — 페이지·Linear 네트워크 경계만 대역하고 생산 coordinator와 browser-act를 부른다.
import {
  dispatchBrowserHand,
  type BrowserHandArgs,
  type BrowserHandDeps,
  type BrowserHandRepairNode,
  type BrowserHandResult,
} from '../tool-runtime/browser-hand-runtime.js';
import { performBrowserAction, type BrowserActionDeps, type BrowserActionResult } from '../harness/browser-act.js';
import type { CdpClient, CdpEventListener } from '../browser-cdp/client.js';

export type BrowserHandScenario = 'attach' | 'paywall-fallback' | 'selection-roundtrip';

export interface BrowserHandSimulationResult {
  scenario: BrowserHandScenario;
  runId: string;
  observedRunId: string | null;
  observedBrowserActionRunIds: readonly (string | null)[];
  result: BrowserHandResult;
  pageReads: readonly string[];
  browserActions: readonly string[];
  repairNodes: readonly BrowserHandRepairNode[];
  linear: {
    uploads: readonly { filename: string; contentType: string; bytes: number }[];
    attachments: readonly { issueId: string; title: string; url: string }[];
    comments: readonly { issueId: string; body: string }[];
  };
}

const ISSUE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const PERSONA = {
  personaId: 'ux-sim-browser-hand',
  displayName: 'UX simulation browser',
  actionHosts: ['ir.example.test', 'archive.example.test'],
};
const PRIMARY_URL = 'https://ir.example.test/filing';
const ALTERNATE_URL = 'https://archive.example.test/filing';
const CAPTURE_REF = 'ux-sim://browser-hand/capture.png';

function fakeCdp(): CdpClient {
  let lifecycleListener: CdpEventListener | undefined;
  return {
    port: 0,
    pid: 0,
    get isAlive() { return true; },
    on(method, listener) {
      if (method === 'Page.lifecycleEvent') lifecycleListener = listener;
      return () => { lifecycleListener = undefined; };
    },
    async navigate() {
      queueMicrotask(() => lifecycleListener?.({
        method: 'Page.lifecycleEvent',
        params: { name: 'load', frameId: 'ux-sim-frame', loaderId: 'ux-sim-loader' },
      }));
      return { frameId: 'ux-sim-frame', loaderId: 'ux-sim-loader' };
    },
    async screenshot() { return Buffer.from([137, 80, 78, 71]); },
    async evaluate() { throw new Error('unexpected page evaluation; execute seam supplies click coordinates'); },
    async setScriptExecutionDisabled(value) {
      // Canary: BrowserHand must not disable page scripts; fail loudly if that production behavior is introduced.
      if (value) throw new Error('BrowserHand simulation must not disable page scripts');
    },
    async close() {},
  };
}

/** Run the real BrowserHand coordinator and performBrowserAction with only browser and Linear I/O faked. */
export async function simBrowserHand(scenario: BrowserHandScenario, linearSubtaskId = ISSUE_ID, runId = 'run-ux-sim-browser-hand'): Promise<BrowserHandSimulationResult> {
  let observedRunId: string | null = null;
  const observedBrowserActionRunIds: Array<string | null> = [];
  const pageReads: string[] = [];
  const browserActions: string[] = [];
  const repairNodes: BrowserHandRepairNode[] = [];
  const uploads: Array<{ filename: string; contentType: string; bytes: number }> = [];
  const attachments: Array<{ issueId: string; title: string; url: string }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];

  const args: BrowserHandArgs = {
    url: PRIMARY_URL,
    target: 'body',
    armed: true,
    linearSubtaskId,
    persona: PERSONA.personaId,
    ...(scenario === 'paywall-fallback' ? { alternateUrl: ALTERNATE_URL } : {}),
    ...(scenario === 'selection-roundtrip'
      ? { includeThisToo: true, selection: { text: 'Revenue rose 12%', tab: 'Q3 filing' } }
      : {}),
  };

  const browserAct = async (request: Parameters<typeof performBrowserAction>[0], deps?: BrowserActionDeps): Promise<BrowserActionResult> => {
    browserActions.push(request.url);
    return performBrowserAction(request, {
      ...deps,
      connect: async () => fakeCdp(),
      // `performBrowserAction` uses this injected click boundary, so the fake page's evaluate must stay unused.
      execute: async () => ({ x: 41, y: 73 }),
      loadWaitTimeoutMs: 20,
      captureTimeoutMs: 20,
      reclaimOpenedTabs: false,
      saveAttachment: async () => ({
        ok: true,
        entry: {
          id: 'ux-sim-browser-hand-capture',
          path: CAPTURE_REF,
          filename: 'capture.png',
          mediaType: 'image/png',
          size: 4,
          createdAt: 0,
        },
      }),
    });
  };

  const deps: BrowserHandDeps = {
    browserAct,
    confirmHuman: async () => true,
    resolvePersona: async () => PERSONA,
    readPageText: async url => {
      pageReads.push(url);
      return scenario === 'paywall-fallback' && url === PRIMARY_URL
        ? 'Subscribe to continue'
        : 'Public filing content';
    },
    browserActDeps: {
      getRunId: () => { observedRunId = runId; return runId; },
      observe(event, data) {
        if (event === 'repair-node') repairNodes.push(data as BrowserHandRepairNode);
        if (event === 'executed') {
          const row = data as { runId?: unknown };
          observedBrowserActionRunIds.push(typeof row.runId === 'string' ? row.runId : null);
        }
      },
    },
    getApiKey: async () => 'ux-sim-fake-linear-key',
    readCapture: async path => {
      if (path !== CAPTURE_REF) throw new Error(`unexpected simulated capture ref: ${path}`);
      return Buffer.from([137, 80, 78, 71]);
    },
    upload: async input => {
      uploads.push({ filename: input.filename, contentType: input.contentType, bytes: input.body.byteLength });
      return 'https://uploads.example.test/browser-hand.png';
    },
    attach: async input => {
      attachments.push({ issueId: input.issueId, title: input.title, url: input.url });
      return 'ux-sim-attachment-1';
    },
    reflectSelection: async input => {
      comments.push(input);
      return true;
    },
  };
  const result = await dispatchBrowserHand(args, undefined, deps);

  return {
    scenario,
    runId,
    observedRunId,
    observedBrowserActionRunIds,
    result,
    pageReads,
    browserActions,
    repairNodes,
    linear: { uploads, attachments, comments },
  };
}
