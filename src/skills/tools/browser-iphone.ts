import type { LLMToolSpec } from '../../llm/tool-spec.js';
// Native tools — BI-P5.
//
// Exposes BI-P1 (CDP), BI-P2 (Pushcut), BI-P3 (HITL), and BI-P4
// (iPhone presets) to skill-runner as 9 LLM-callable tools.
//
//   browser_open       process          — spawn Chrome + attach CDP
//   browser_navigate   network          — Page.navigate
//   browser_screenshot read-only        — PNG saved to /tmp/elanous-output
//   browser_read       read-only        — page text, HTML, or screenshot base64
//   browser_close      process          — dispose CDP + Chrome
//   iphone_notify      network          — Pushcut.notify
//   iphone_open_url    network          — openUrlOnSafari
//   iphone_confirm     network T2       — single-channel confirm via Pushcut
//   hitl_confirm       network T2       — race all wired channels
//   iphone_agent_result network         — notifyAgentResult preset
//
// Each dispatcher accepts dep overrides so tests can inject fakes.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';


import {
  createCdpClient,
  createCdpClientFromEndpoint,
  type CdpClient,
} from '../../browser-cdp/client.js';
import {
  getPushcutClient,
  type PushcutClient,
} from '../../pushcut/client.js';
import {
  createIPhonePresets,
  DEFAULT_AGENT_RESULT_NOTIFICATION,
  type IPhonePresetFns,
} from '../../pushcut/iphone-presets.js';
import {
  requestConfirmation,
  createPushcutConfirmChannel,
  type ConfirmChannel,
  type ConfirmResult,
} from '../../hitl/confirm.js';
import {
  awaitGlobalPersonaLoad,
  describeMissingPersona,
  getGlobalPersonaRegistry,
} from '../../persona/global-registry.js';
import { debug } from '../../debug/log.js';
import { getHarnessRunId } from '../../harness/harness-space.js';

// ─── Module singletons (dashboard inits) ─────────────────────────

export type BrowserActionObserver = (event: string, data: Record<string, unknown>) => void;

function observeBrowserAction(
  observe: BrowserActionObserver | undefined,
  data: Record<string, unknown>,
): void {
  try {
    (observe ?? ((event, detail) => debug.log('harness.browser-action', event, detail)))('executed', {
      runId: getHarnessRunId() || null,
      ...data,
    });
  } catch { /* browser action observation is fail-soft */ }
}

interface CdpSession {
  id: string;
  client: CdpClient;
  url?: string;
}

const cdpSessions = new Map<string, CdpSession>();

function mintSessionId(): string {
  return 'cdp_' + randomBytes(3).toString('hex');
}

// ─── browser_open ────────────────────────────────────────────────

export function buildBrowserOpenTool(): LLMToolSpec {
  return {
    name: 'BrowserOpen',
    description: 'Spawn a Chrome browser or attach to an existing CDP endpoint. Returns session_id for BrowserNavigate / BrowserScreenshot / BrowserClose.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL (default about:blank). Ignored when attaching.' },
        headless: { type: 'boolean', description: 'Run spawned browser headless. Default false; ignored when attaching.' },
        port: { type: 'integer', description: 'Remote debugging port. Default 9222.' },
        personaId: { type: 'string', description: 'Global persona registry ID whose browserPort selects the existing CDP endpoint. Requires attach=true.' },
        attach: { type: 'boolean', description: 'Attach to the existing browser CDP endpoint at port or personaId instead of spawning Chrome.' },
      },
      additionalProperties: false,
    },
  };
}

export interface BrowserOpenDeps {
  createClient?: typeof createCdpClient;
  createClientFromEndpoint?: typeof createCdpClientFromEndpoint;
  observe?: BrowserActionObserver;
}

export async function dispatchBrowserOpen(
  raw: Record<string, unknown>,
  deps: BrowserOpenDeps = {},
): Promise<{ output: string }> {
  const port = typeof raw.port === 'number' ? raw.port : undefined;
  const personaId = typeof raw.personaId === 'string' ? raw.personaId : undefined;
  const attached = raw.attach === true;
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  let id: string | null = null;
  try {
    let attachPort = port;
    if (attached && personaId !== undefined) {
      await awaitGlobalPersonaLoad();
      const persona = getGlobalPersonaRegistry().get(personaId);
      if (persona === undefined) {
        throw new Error(describeMissingPersona(personaId, getGlobalPersonaRegistry()));
      }
      if (persona.browserPort === undefined) {
        throw new Error(`persona ${personaId} has no browserPort declared`);
      }
      attachPort = persona.browserPort;
    }
    const client = attached
      ? await (deps.createClientFromEndpoint ?? createCdpClientFromEndpoint)(attachPort)
      : await (deps.createClient ?? createCdpClient)({ url, headless: raw.headless === true, port });
    id = mintSessionId();
    cdpSessions.set(id, { id, client, url });
    observeBrowserAction(deps.observe, {
      action: 'open', sessionId: id, url: url ?? null, target: attached ? 'attach' : 'spawn',
      ok: true, port: client.port, pid: client.pid,
    });
    return { output: `BrowserOpen session_id=${id} port=${client.port} pid=${client.pid}` };
  } catch (error) {
    observeBrowserAction(deps.observe, {
      action: 'open', sessionId: id, url: url ?? null, target: attached ? 'attach' : 'spawn', ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ─── browser_navigate ────────────────────────────────────────────

export function buildBrowserNavigateTool(): LLMToolSpec {
  return {
    name: 'BrowserNavigate',
    description: 'Navigate the browser session to a URL.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['session_id', 'url'],
      additionalProperties: false,
    },
  };
}

export async function dispatchBrowserNavigate(
  raw: Record<string, unknown>,
  deps: { observe?: BrowserActionObserver } = {},
): Promise<{ output: string }> {
  const id = String(raw.session_id ?? '');
  const url = String(raw.url ?? '');
  try {
    const s = cdpSessions.get(id);
    if (!s) throw new Error(`unknown session_id ${id}`);
    if (!url) throw new Error(`'url' is required`);
    await s.client.navigate(url);
    s.url = url;
    observeBrowserAction(deps.observe, { action: 'navigate', sessionId: id, url, target: url, ok: true });
    return { output: `BrowserNavigate session_id=${id} url=${url}` };
  } catch (error) {
    observeBrowserAction(deps.observe, { action: 'navigate', sessionId: id, url, target: url, ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// ─── browser_screenshot ──────────────────────────────────────────

export function buildBrowserScreenshotTool(): LLMToolSpec {
  return {
    name: 'BrowserScreenshot',
    description: 'Capture a PNG screenshot of the browser session and save to /tmp/elanous-output. Returns the absolute path.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        full_page: { type: 'boolean', description: 'Capture beyond viewport. Default false.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  };
}

export interface ScreenshotDeps {
  outputDir?: string;
  writeFile?: (path: string, data: Buffer) => void;
  observe?: BrowserActionObserver;
}

export async function dispatchBrowserScreenshot(
  raw: Record<string, unknown>,
  deps: ScreenshotDeps = {},
): Promise<{ output: string }> {
  const id = String(raw.session_id ?? '');
  let session: CdpSession | undefined;
  try {
    session = cdpSessions.get(id);
    if (!session) throw new Error(`unknown session_id ${id}`);
    const png = await session.client.screenshot({ format: 'png', fullPage: raw.full_page === true });
    const dir = deps.outputDir ?? mkdtempSync(joinPath(tmpdir(), 'elanous-screenshot-'));
    const path = joinPath(dir, `${id}-${Date.now()}.png`);
    const w = deps.writeFile ?? ((p, d) => writeFileSync(p, d));
    w(path, png);
    observeBrowserAction(deps.observe, {
      action: 'screenshot', sessionId: id, url: session.url ?? null, target: 'screenshot', ok: true,
      bytes: png.length, attachmentRef: path, captureOutcome: 'saved',
    });
    return { output: `BrowserScreenshot saved=${path} bytes=${png.length}` };
  } catch (error) {
    observeBrowserAction(deps.observe, {
      action: 'screenshot', sessionId: id, url: session?.url ?? null, target: 'screenshot', ok: false,
      error: error instanceof Error ? error.message : String(error), attachmentRef: null, captureOutcome: 'error',
    });
    throw error;
  }
}

// ─── browser_read ────────────────────────────────────────────────

export type BrowserReadMode = 'text' | 'html' | 'screenshot';

const DEFAULT_READ_MAX_CHARS = 50_000;
const HARD_READ_MAX_CHARS = 200_000;

export function buildBrowserReadTool(): LLMToolSpec {
  return {
    name: 'BrowserRead',
    description: 'Read text, HTML, or a screenshot from a browser session. Text is the default; text and HTML can be scoped with a CSS selector.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        mode: { type: 'string', enum: ['text', 'html', 'screenshot'], description: 'What to extract. Default "text".' },
        selector: { type: 'string', description: 'CSS selector that scopes text or HTML extraction.' },
        max_chars: { type: 'number', description: 'Text or HTML character limit. Default 50000, maximum 200000.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchBrowserRead(
  raw: Record<string, unknown>,
  deps: { observe?: BrowserActionObserver } = {},
): Promise<{ output: string; mode: BrowserReadMode; text?: string; htmlLength?: number; screenshotBase64?: string; truncated?: boolean }> {
  const id = String(raw.session_id ?? '');
  const session = cdpSessions.get(id);
  const rawMode = raw.mode;
  const mode: BrowserReadMode = rawMode === 'html' || rawMode === 'screenshot' ? rawMode : 'text';
  const selector = typeof raw.selector === 'string' ? raw.selector.trim() : '';
  const requestedMax = typeof raw.max_chars === 'number' ? raw.max_chars : DEFAULT_READ_MAX_CHARS;
  const maxChars = Math.min(Math.max(1, Math.floor(requestedMax)), HARD_READ_MAX_CHARS);

  if (!session) {
    const error = new Error(`unknown session_id ${id}`);
    observeBrowserAction(deps.observe, {
      action: 'read', sessionId: id, url: null, target: selector || 'document.body', mode, ok: false,
      error: error.message, attachmentRef: null, captureOutcome: mode === 'screenshot' ? 'error' : 'not-requested',
    });
    throw error;
  }

  if (mode === 'screenshot') {
    try {
      const png = await session.client.screenshot({ format: 'png' });
      const screenshotBase64 = png.toString('base64');
      observeBrowserAction(deps.observe, {
        action: 'read', sessionId: id, url: session.url ?? null, target: 'screenshot', mode, ok: true,
        bytes: png.byteLength, base64Length: screenshotBase64.length, attachmentRef: null, captureOutcome: 'inline-base64',
      });
      return {
        output: [
          `# BrowserRead: screenshot (${png.byteLength} bytes PNG, ${screenshotBase64.length} chars base64)`,
          '---',
          screenshotBase64,
        ].join('\n'),
        mode,
        screenshotBase64,
      };
    } catch (error) {
      observeBrowserAction(deps.observe, {
        action: 'read', sessionId: id, url: session.url ?? null, target: 'screenshot', mode, ok: false,
        error: error instanceof Error ? error.message : String(error), attachmentRef: null, captureOutcome: 'error',
      });
      throw error;
    }
  }

  const property = mode === 'html' ? 'outerHTML' : 'innerText';
  const expression = selector
    ? `(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element ? element.${property} : ''; })()`
    : `document.body.${property}`;
  try {
    const evaluated = await session.client.evaluate(expression);
    const value = evaluated == null ? '' : String(evaluated);
    const truncated = value.length > maxChars;
    const output = truncated ? value.slice(0, maxChars) : value;

    observeBrowserAction(deps.observe, {
      action: 'read', sessionId: id, url: session.url ?? null, target: selector || 'document.body', mode, ok: true,
      charLength: value.length, returnedChars: output.length, truncated, attachmentRef: null, captureOutcome: 'not-requested',
    });
    return {
      output: [
        `# BrowserRead (${mode}${selector ? ` · selector=${selector}` : ''})`,
        `chars: ${output.length}${truncated ? ` (truncated from ${value.length})` : ''}`,
        '---',
        output,
      ].join('\n'),
      mode,
      text: mode === 'text' ? output : undefined,
      htmlLength: mode === 'html' ? value.length : undefined,
      truncated: truncated || undefined,
    };
  } catch (error) {
    observeBrowserAction(deps.observe, {
      action: 'read', sessionId: id, url: session.url ?? null, target: selector || 'document.body', mode, ok: false,
      error: error instanceof Error ? error.message : String(error), attachmentRef: null, captureOutcome: 'not-requested',
    });
    throw error;
  }
}

// ─── browser_close ───────────────────────────────────────────────

export function buildBrowserCloseTool(): LLMToolSpec {
  return {
    name: 'BrowserClose',
    description: 'Close a browser session + kill Chrome.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  };
}

export async function dispatchBrowserClose(
  raw: Record<string, unknown>,
  deps: { observe?: BrowserActionObserver } = {},
): Promise<{ output: string }> {
  const id = String(raw.session_id ?? '');
  let session: CdpSession | undefined;
  try {
    session = cdpSessions.get(id);
    if (!session) throw new Error(`unknown session_id ${id}`);
    await session.client.close();
    cdpSessions.delete(id);
    observeBrowserAction(deps.observe, { action: 'close', sessionId: id, url: session.url ?? null, target: 'session', ok: true });
    return { output: `BrowserClose session_id=${id}` };
  } catch (error) {
    observeBrowserAction(deps.observe, { action: 'close', sessionId: id, url: session?.url ?? null, target: 'session', ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// ─── iphone_notify ───────────────────────────────────────────────

export function buildIPhoneNotifyTool(): LLMToolSpec {
  return {
    name: 'IPhoneNotify',
    description: 'Trigger a Pushcut notification on the user\'s iPhone.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pushcut notification name (must match a notification the user registered in Pushcut).' },
        title: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string', description: 'Optional tap-through URL.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export interface IPhoneDeps {
  client?: PushcutClient;
  presets?: IPhonePresetFns;
}

export async function dispatchIPhoneNotify(
  raw: Record<string, unknown>,
  deps: IPhoneDeps = {},
): Promise<{ output: string }> {
  const client = deps.client ?? getPushcutClient();
  const name = String(raw.name ?? '');
  if (!name) throw new Error(`'name' is required`);
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const r = await client.notify(name, {
    title: typeof raw.title === 'string' ? raw.title : undefined,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    actions: url ? [{ name: 'Open', url }] : undefined,
  });
  return { output: `IPhoneNotify name=${name} ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}` };
}

// ─── iphone_open_url ─────────────────────────────────────────────

export function buildIPhoneOpenUrlTool(): LLMToolSpec {
  return {
    name: 'IPhoneOpenUrl',
    description: 'Open a URL in iPhone Safari via Pushcut.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  };
}

export async function dispatchIPhoneOpenUrl(
  raw: Record<string, unknown>,
  deps: IPhoneDeps = {},
): Promise<{ output: string }> {
  const client = deps.client ?? getPushcutClient();
  const presets = deps.presets ?? createIPhonePresets({ client });
  const url = String(raw.url ?? '');
  if (!url) throw new Error(`'url' is required`);
  const r = await presets.openUrlOnSafari(url);
  return { output: `IPhoneOpenUrl url=${url} ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}` };
}

// ─── iphone_agent_result ─────────────────────────────────────────

export function buildIPhoneAgentResultTool(): LLMToolSpec {
  return {
    name: 'IPhoneAgentResult',
    description: 'Send an "agent done" notification to iPhone. Title + summary + optional tap-through URL.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  };
}

export async function dispatchIPhoneAgentResult(
  raw: Record<string, unknown>,
  deps: IPhoneDeps = {},
): Promise<{ output: string }> {
  const client = deps.client ?? getPushcutClient();
  const presets = deps.presets ?? createIPhonePresets({ client });
  const r = await presets.notifyAgentResult({
    title: String(raw.title ?? 'Agent result'),
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
  });
  return { output: `IPhoneAgentResult ok=${r.ok} via=${DEFAULT_AGENT_RESULT_NOTIFICATION}${r.reason ? ' reason=' + r.reason : ''}` };
}

// ─── iphone_confirm (pushcut-only) ───────────────────────────────

export function buildIPhoneConfirmTool(): LLMToolSpec {
  return {
    name: 'IPhoneConfirm',
    description: 'Ask a Y/N question via Pushcut notification. Returns null when the Pushcut round-trip is not wired (use HitlConfirm for unified channels).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        detail: { type: 'string' },
        notification_name: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

export interface IPhoneConfirmDeps extends IPhoneDeps {
  awaitCallback?: (requestId: string) => Promise<boolean | null>;
}

export async function dispatchIPhoneConfirm(
  raw: Record<string, unknown>,
  deps: IPhoneConfirmDeps = {},
): Promise<{ output: string }> {
  const client = deps.client ?? getPushcutClient();
  const name = typeof raw.notification_name === 'string' ? raw.notification_name : 'monad-confirm';
  const ch = createPushcutConfirmChannel({
    client,
    notificationName: name,
    awaitCallback: deps.awaitCallback,
  });
  const r = await ch.request({
    prompt: String(raw.prompt ?? ''),
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    requestId: `iphone-${Date.now()}`,
  });
  if (r === null) return { output: `IPhoneConfirm answer=null (fire-and-forget)` };
  return { output: `IPhoneConfirm answer=${r}` };
}

// ─── hitl_confirm (unified race) ─────────────────────────────────

export function buildHitlConfirmTool(): LLMToolSpec {
  return {
    name: 'HitlConfirm',
    description: 'Ask the user Y/N across all wired HITL channels (telegram/discord/pushcut/terminal). First answer wins. Returns {answer, channel, elapsed_ms}.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        detail: { type: 'string' },
        yes_label: { type: 'string' },
        no_label: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

export interface HitlConfirmDeps {
  channels?: ConfirmChannel[];
}

export async function dispatchHitlConfirm(
  raw: Record<string, unknown>,
  deps: HitlConfirmDeps = {},
): Promise<{ output: string }> {
  const prompt = String(raw.prompt ?? '');
  if (!prompt) throw new Error(`'prompt' is required`);
  const r: ConfirmResult = await requestConfirmation({
    prompt,
    detail: typeof raw.detail === 'string' ? raw.detail : undefined,
    yesLabel: typeof raw.yes_label === 'string' ? raw.yes_label : undefined,
    noLabel: typeof raw.no_label === 'string' ? raw.no_label : undefined,
    timeoutMs: typeof raw.timeout_ms === 'number' ? raw.timeout_ms : undefined,
    channels: deps.channels,
  });
  return { output: `HitlConfirm answer=${r.answer} channel=${r.channel} elapsed_ms=${r.elapsedMs}` };
}

// ─── Test helpers ────────────────────────────────────────────────

export function _getCdpSessionsForTesting(): Map<string, CdpSession> {
  return cdpSessions;
}
export function _resetCdpSessionsForTesting(): void {
  cdpSessions.clear();
}
