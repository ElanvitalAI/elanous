// ── BrowserNavigate + BrowserRead ToolRuntime (BCO Phase D4) ──
//
// The first two LLM-callable entry points into the Browser Context
// Organ. Both are registered with shouldDefer=true — their schemas
// surface only via ToolSearch so the base prompt stays lean for
// agents that don't need web access.
//
// Dependency surface:
//   • `src/browser-cdp/client.ts::createCdpClient` — spawns Chrome
//     + wires CDP transport. Injected via setBrowserRuntimeDeps so
//     tests can supply a fake.
//   • `src/browser-cdp/watchdog.ts::createWatchdog` — used for
//     `waitForLoad` (subscribe to Page.loadEventFired). Also injected.
//
// This file does NOT implement the full persistent daemon (Phase
// D1). It holds a lazy singleton per elanous process: first call
// spawns Chrome, subsequent calls reuse; the client lives until the
// process exits or `closeBrowserRuntime()` is invoked.
// BrowserRead remains read-only. An explicitly requested BrowserNavigate
// input asks a person through the HITL confirmation channels only and fails
// closed without approval. The shell-command approver is never consulted: an
// unattended surface may auto-allow shell patterns, which must not type into a page.
// Click still runs through performBrowserAction in src/harness/browser-act.ts,
// where armed, reversibility and host-boundary checks precede CdpClient.click.

import type { CdpClient } from '../browser-cdp/client.js';
import { createCdpClient, CdpUnavailable } from '../browser-cdp/client.js';
import { getBrowserCdpAvailability } from '../browser-cdp/availability.js';
import { defaultControlSignalBus } from '../input/control-signal.js';
import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { decideTypeAction } from '../harness/browser-act-type.js';
import { requestConfirmation } from '../hitl/confirm.js';
import type { TypeTarget } from '../harness/bot-type-request.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

// ─── Dependency injection ───────────────────────────────────────

export type BrowserActionObserver = (event: string, data: Record<string, unknown>) => void;

export interface BrowserRuntimeDeps {
  /** Returns a ready-to-use CDP client (spawning Chrome if needed).
   *  Null signals unavailability (e.g. headless dev env without
   *  Chrome binary). */
  getClient: () => Promise<CdpClient | null>;
  /** Close the client held by the singleton (test cleanup). */
  closeClient?: () => Promise<void>;
  observe?: BrowserActionObserver;
}

function observeBrowserAction(data: Record<string, unknown>): void {
  try {
    const runId = getHarnessRunId() || null;
    (deps.observe ?? ((event, detail) => debug.log('harness.browser-action', event, detail)))('executed', {
      runId,
      sessionId: 'browser-runtime',
      attribution: {
        kind: runId ? 'run' : 'entry-point',
        entryPoint: 'tool-runtime/browser-runtime',
      },
      ...data,
    });
  } catch { /* browser action observation is fail-soft */ }
}

let singletonClient: CdpClient | null = null;
let singletonPromise: Promise<CdpClient | null> | null = null;

async function defaultGetClient(): Promise<CdpClient | null> {
  if (singletonClient && singletonClient.isAlive) return singletonClient;
  if (singletonPromise) return singletonPromise;
  singletonPromise = (async () => {
    try {
      const c = await createCdpClient({ headless: true });
      singletonClient = c;
      return c;
    } catch (err) {
      singletonPromise = null;
      if (err instanceof CdpUnavailable) return null;
      throw err;
    }
  })();
  const resolved = await singletonPromise;
  singletonPromise = null;
  return resolved;
}

async function defaultCloseClient(): Promise<void> {
  if (singletonClient) {
    try { await singletonClient.close(); } catch { /* ignore */ }
    singletonClient = null;
  }
  singletonPromise = null;
}

let deps: BrowserRuntimeDeps = {
  getClient: defaultGetClient,
  closeClient: defaultCloseClient,
};
let attachedControlSignalBus: ReturnType<typeof defaultControlSignalBus> | null = null;

function ensureBrowserControlSignalConsumer(): void {
  const bus = defaultControlSignalBus();
  if (attachedControlSignalBus === bus) return;
  attachedControlSignalBus = bus;
  bus.subscribe(
    { kind: 'browser-cdp-stop', minUrgency: 'quick-pass', surface: 'browser' },
    () => {
      void deps.closeClient?.();
    },
  );
}

export function setBrowserRuntimeDeps(next: Partial<BrowserRuntimeDeps>): void {
  deps = { ...deps, ...next };
}

export async function closeBrowserRuntime(): Promise<void> {
  if (deps.closeClient) await deps.closeClient();
}

// ─── BrowserNavigate ────────────────────────────────────────────

export interface BrowserNavigateArgs {
  /** Absolute URL. Scheme required. */
  url: string;
  /** Input requires a selected target and explicit approval; no form submission. */
  input?: { selector: string; text: string };
  /** When true, block until Page.loadEventFired (or timeoutMs).
   *  Default true. */
  waitForLoad?: boolean;
  /** Milliseconds to wait for load. Default 10000, cap 60000. */
  timeoutMs?: number;
}

export interface BrowserNavigateResult extends Record<string, unknown> {
  output: string;
  finalUrl: string;
  title: string;
  loadMs: number;
  timedOut?: boolean;
}

export function buildBrowserNavigateTool(): LLMToolSpec {
  return {
    name: 'BrowserNavigate',
    description:
      'Navigate the Elanous Browser Context Organ (persistent headless Chrome) to a URL. ' +
      'Returns the final URL (after redirects), page title, and load time. Pair with ' +
      'BrowserRead to extract text/HTML/screenshot. Deferred: schema surfaces only via ' +
      'ToolSearch — use when the user asks you to open a page, read a URL, or check a ' +
      'staging deployment. Idempotent-safe; retries are allowed on transient failures.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL including scheme (https://...). about:blank also accepted.',
        },
        input: {
          type: 'object',
          description: 'Type into a selected page field only after explicit approval. Never submits a form.',
          properties: {
            selector: { type: 'string', description: 'CSS selector of the input field.' },
            text: { type: 'string', description: 'Text without newlines (at most 200 characters).' },
          },
          required: ['selector', 'text'],
          additionalProperties: false,
        },
        waitForLoad: {
          type: 'boolean',
          description: 'Wait for Page.loadEventFired before returning. Default true.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max wait for load in milliseconds. Default 10000, cap 60000.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

const DEFAULT_NAV_TIMEOUT_MS = 10_000;
const MAX_NAV_TIMEOUT_MS = 60_000;

export async function dispatchBrowserNavigate(args: BrowserNavigateArgs, ctx?: ToolRuntimeContext): Promise<BrowserNavigateResult> {
  ensureBrowserControlSignalConsumer();
  const url = String(args.url ?? '').trim();
  const input = args.input;
  // Input is never an implicit side effect of navigation. Approval is scoped
  // to this URL, selector and text, before connecting or dispatching CDP.
  if (input !== undefined) {
    if (typeof input.selector !== 'string' || !input.selector.trim()
      || typeof input.text !== 'string' || !input.text.trim()
      || /[\r\n]/.test(input.text) || input.text.length > 200) {
      return { output: '# BrowserNavigate: invalid input', finalUrl: '', title: '', loadMs: 0 };
    }
    let httpUrl = false;
    try { httpUrl = ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* invalid URL */ }
    if (!httpUrl) return { output: '# BrowserNavigate: invalid input URL', finalUrl: '', title: '', loadMs: 0 };
    let approved = false;
    try {
      // Human confirmation only — `ctx.approver` is the shell-command approver (TC review of #24990).
      approved = (await requestConfirmation({
        prompt: `Browser input on ${url}`,
        detail: `Selector: ${input.selector}\nText: ${input.text}`,
        ...(ctx?.confirmChannels ? { channels: ctx.confirmChannels } : {}),
        onTimeout: () => false,
      })).answer === true;
    } catch { /* approval failure is denial */ }
    if (!approved) return { output: '# BrowserNavigate: input not approved', finalUrl: '', title: '', loadMs: 0 };
  }
  if (!url) {
    observeBrowserAction({ action: 'navigate', url: '', target: 'url', ok: false, error: 'url is required' });
    return { output: '# BrowserNavigate: error\nurl is required', finalUrl: '', title: '', loadMs: 0 };
  }
  const waitForLoad = args.waitForLoad !== false;
  const timeoutMs = Math.min(Math.max(0, Math.floor(args.timeoutMs ?? DEFAULT_NAV_TIMEOUT_MS)), MAX_NAV_TIMEOUT_MS);

  let client: CdpClient | null;
  try {
    client = await deps.getClient();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    observeBrowserAction({ action: 'navigate', url, target: url, ok: false, error });
    throw err;
  }
  if (!client) {
    const availability = getBrowserCdpAvailability();
    observeBrowserAction({ action: 'navigate', url, target: url, ok: false, error: 'chrome-unavailable' });
    return {
      output: `# BrowserNavigate: Chrome unavailable\n${availability.note}`,
      finalUrl: '',
      title: '',
      loadMs: 0,
    };
  }

  const started = Date.now();

  // Optional: subscribe to Page.loadEventFired before navigating so
  // we don't miss a fast load. Requires Phase-D3-aware clients
  // (those with an `on` method); if unavailable we skip the wait.
  let loadPromise: Promise<{ timedOut: boolean }> | null = null;
  if (waitForLoad && typeof client.on === 'function') {
    loadPromise = new Promise((resolve) => {
      const off = client.on!('Page.loadEventFired', () => {
        off();
        resolve({ timedOut: false });
      });
      const timer = setTimeout(() => {
        off();
        resolve({ timedOut: true });
      }, timeoutMs);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    });
  }

  try {
    await client.navigate(url);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    observeBrowserAction({ action: 'navigate', url, target: url, ok: false, error, loadMs: Date.now() - started });
    return {
      output: `# BrowserNavigate: error\n${error}`,
      finalUrl: url,
      title: '',
      loadMs: Date.now() - started,
    };
  }

  let timedOut = false;
  if (loadPromise) {
    const r = await loadPromise;
    timedOut = r.timedOut;
  }

  if (input !== undefined) {
    try {
      if (!client.input) throw new Error('CDP input unavailable');
      const currentUrl = await client.evaluate('document.location.href');
      if (currentUrl !== new URL(url).href) throw new Error('CDP input refused: page URL changed after approval');
      const inspected = await client.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(input.selector)});
        if (!(element instanceof HTMLElement)) return null;
        return { tag: element.tagName.toLowerCase(),
          type: element instanceof HTMLInputElement ? element.type : null,
          name: element.getAttribute('name'), id: element.getAttribute('id'),
          contentEditable: element.isContentEditable, inForm: !!element.closest('form') };
      })()`);
      const candidate = inspected && typeof inspected === 'object' ? inspected as Record<string, unknown> : null;
      const target: TypeTarget | null = candidate
        && typeof candidate.tag === 'string'
        && (candidate.type === null || typeof candidate.type === 'string')
        && (candidate.name === null || typeof candidate.name === 'string')
        && (candidate.id === null || typeof candidate.id === 'string')
        && typeof candidate.contentEditable === 'boolean' && typeof candidate.inForm === 'boolean'
        ? candidate as TypeTarget : null;
      const verdict = decideTypeAction({ url, selector: input.selector, text: input.text,
        // The caller's approval is for this exact URL; it cannot authorize a different host.
        actionHosts: [new URL(url).hostname], armed: true, target });
      if (!verdict.allowed) throw new Error(verdict.reason);
      const focused = await client.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(input.selector)});
        if (!(element instanceof HTMLElement)) return false;
        element.focus();
        return document.activeElement === element;
      })()`);
      if (focused !== true) throw new Error('CDP input target could not be focused');
      await client.input(input.text);
    } catch (err) {
      return { output: `# BrowserNavigate: input error\n${err instanceof Error ? err.message : String(err)}`,
        finalUrl: url, title: '', loadMs: Date.now() - started };
    }
  }

  const loadMs = Date.now() - started;

  // Best-effort metadata. Errors here don't abort the tool.
  let title = '';
  let finalUrl = url;
  try { title = String(await client.evaluate('document.title') ?? ''); } catch { /* keep empty */ }
  try { finalUrl = String(await client.evaluate('document.location.href') ?? url); } catch { /* keep requested */ }

  const output = [
    `# BrowserNavigate: ${finalUrl}`,
    `title: ${title || '(empty)'}`,
    `loadMs: ${loadMs}`,
    timedOut ? 'warning: load event timed out' : '',
  ].filter(Boolean).join('\n');

  observeBrowserAction({ action: 'navigate', url: finalUrl, target: url, ok: true, titleLength: title.length, loadMs, timedOut });
  return { output, finalUrl, title, loadMs, timedOut: timedOut || undefined };
}

export const browserNavigateRuntime: ToolRuntime<BrowserNavigateArgs, BrowserNavigateResult> = {
  id: 'browser_navigate',
  spec: buildBrowserNavigateTool(),
  async run(req, ctx: ToolRuntimeContext) {
    return dispatchBrowserNavigate(req, ctx);
  },
};

// ─── BrowserRead ────────────────────────────────────────────────

export type BrowserReadMode = 'text' | 'html' | 'screenshot';

export interface BrowserReadArgs {
  /** What to extract. Default 'text'. */
  mode?: BrowserReadMode;
  /** CSS selector. When present, scope to the matching element (or
   *  first match). Only honored for 'text' and 'html' modes. */
  selector?: string;
  /** Max chars to return for text/html. Default 50_000, hard cap 200_000. */
  maxChars?: number;
}

export interface BrowserReadResult extends Record<string, unknown> {
  output: string;
  mode: BrowserReadMode;
  text?: string;
  htmlLength?: number;
  screenshotBase64?: string;
  truncated?: boolean;
}

export function buildBrowserReadTool(): LLMToolSpec {
  return {
    name: 'BrowserRead',
    description:
      'Read the currently loaded page in the Elanous Browser Context Organ. Modes: ' +
      '"text" (document.body.innerText or selector innerText; default), "html" (outerHTML, ' +
      'capped), "screenshot" (PNG base64). Pair with BrowserNavigate. Deferred: schema ' +
      'surfaces only via ToolSearch.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['text', 'html', 'screenshot'],
          description: 'What to extract. Default "text".',
        },
        selector: {
          type: 'string',
          description: 'CSS selector. Scopes text/html to the matching element. Ignored for screenshot.',
        },
        maxChars: {
          type: 'number',
          description: 'Truncate text/html to this many chars. Default 50000, max 200000.',
        },
      },
      additionalProperties: false,
    },
  };
}

const DEFAULT_READ_MAX_CHARS = 50_000;
const HARD_READ_MAX_CHARS = 200_000;

function escapeForJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function dispatchBrowserRead(args: BrowserReadArgs): Promise<BrowserReadResult> {
  ensureBrowserControlSignalConsumer();
  const mode: BrowserReadMode = args.mode ?? 'text';
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  const maxChars = Math.min(
    Math.max(1, Math.floor(args.maxChars ?? DEFAULT_READ_MAX_CHARS)),
    HARD_READ_MAX_CHARS,
  );

  let client: CdpClient | null;
  try {
    client = await deps.getClient();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    observeBrowserAction({ action: 'read', target: selector || 'document.body', mode, ok: false, error, attachmentRef: null, captureOutcome: mode === 'screenshot' ? 'error' : 'not-requested' });
    throw err;
  }
  if (!client) {
    const availability = getBrowserCdpAvailability();
    observeBrowserAction({ action: 'read', target: selector || 'document.body', mode, ok: false, error: 'chrome-unavailable', attachmentRef: null, captureOutcome: mode === 'screenshot' ? 'unavailable' : 'not-requested' });
    return {
      output: `# BrowserRead: Chrome unavailable\n${availability.note}`,
      mode,
    };
  }

  if (mode === 'screenshot') {
    try {
      const png = await client.screenshot({ format: 'png' });
      const b64 = png.toString('base64');
      observeBrowserAction({ action: 'read', target: 'screenshot', mode, ok: true, bytes: png.byteLength, base64Length: b64.length, attachmentRef: null, captureOutcome: 'inline-base64' });
      return {
        output: `# BrowserRead: screenshot (${png.byteLength} bytes PNG, ${b64.length} chars base64)`,
        mode,
        screenshotBase64: b64,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      observeBrowserAction({ action: 'read', target: 'screenshot', mode, ok: false, error, attachmentRef: null, captureOutcome: 'error' });
      return {
        output: `# BrowserRead: screenshot error\n${error}`,
        mode,
      };
    }
  }

  const property = mode === 'html' ? 'outerHTML' : 'innerText';
  const targetExpr = selector
    ? `(document.querySelector('${escapeForJs(selector)}') || document.body).${property}`
    : `document.body.${property}`;

  let value: string;
  try {
    const v = await client.evaluate(targetExpr);
    value = v == null ? '' : String(v);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    observeBrowserAction({ action: 'read', target: selector || 'document.body', mode, ok: false, error, attachmentRef: null, captureOutcome: 'not-requested' });
    return {
      output: `# BrowserRead: evaluate error\n${error}`,
      mode,
    };
  }

  const truncated = value.length > maxChars;
  const out = truncated ? value.slice(0, maxChars) : value;

  observeBrowserAction({ action: 'read', target: selector || 'document.body', mode, ok: true, charLength: value.length, returnedChars: out.length, truncated, attachmentRef: null, captureOutcome: 'not-requested' });
  return {
    output: [
      `# BrowserRead (${mode}${selector ? ` · selector=${selector}` : ''})`,
      `chars: ${out.length}${truncated ? ` (truncated from ${value.length})` : ''}`,
      '---',
      out,
    ].join('\n'),
    mode,
    text: mode === 'text' ? out : undefined,
    htmlLength: mode === 'html' ? value.length : undefined,
    truncated: truncated || undefined,
  };
}

export const browserReadRuntime: ToolRuntime<BrowserReadArgs, BrowserReadResult> = {
  id: 'browser_read',
  spec: buildBrowserReadTool(),
  async run(req, _ctx: ToolRuntimeContext) {
    return dispatchBrowserRead(req);
  },
};

// ─── Barrel ─────────────────────────────────────────────────────

export const ALL_BROWSER_RUNTIMES = [browserNavigateRuntime, browserReadRuntime];
