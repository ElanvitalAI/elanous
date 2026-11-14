import { readStoredFirecrawlKey } from '../setup/firecrawl-key.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import type { ToolRuntimeContext } from '../tool-runtime/types.js';
import { parsePluginManifest } from '../plugins/core/manifest.js';

// Source: 내부 문서 `FIRECRAWL-DEFAULT-ONESHOT` — bounded one-call budget.
const DEADLINE_MS = 60_000;
const POLL_MS = 1_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100; // 출처: 내부 문서 `FIRECRAWL-DEFAULT-ONESHOT` 설계 예산
const OUTPUT_CHARS = 100_000;
const RESPONSE_BYTES = 2_000_000; // 출처: 내부 문서 `FIRECRAWL-DEFAULT-ONESHOT` 설계 예산
const API = 'https://api.firecrawl.dev/v2/';
const SETUP = 'elanous setup firecrawl';

export function firecrawlPluginSpec(): LLMToolSpec {
  const manifest = parsePluginManifest(JSON.parse(readFileSync(resolve(import.meta.dir, '../../plugins/firecrawl/plugin.json'), 'utf8')));
  const tool = manifest.contributes.aiTools?.find(item => item.name === 'firecrawl');
  if (!tool?.route) throw new Error('Firecrawl bundled route unavailable');
  return { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} }, pluginId: manifest.id, route: tool.route };
}

export async function readFirecrawlKey(): Promise<string | undefined> {
  return await readStoredFirecrawlKey() || process.env.FIRECRAWL_API_KEY?.trim() || undefined;
}

function publicUrl(input: unknown): URL | undefined {
  if (typeof input !== 'string') return;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)
      || [...url.searchParams.keys()].some(name => /^(?:access_token|refresh_token|api[_-]?key|token|password|authorization)$/i.test(name))) return;
    url.hash = '';
    return url;
  } catch { return; }
}
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Bound even an async secret backend that cannot itself accept an abort signal.
 * Late resolution/rejection is consumed; it cannot resume provider dispatch. */
function withinBudget<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export async function runFirecrawl(args: Record<string, unknown>, context?: Pick<ToolRuntimeContext, 'signal'>, deps: {
  readKey?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  /** Code-only test seam; never accepted from model input or environment. */
  apiBase?: string;
  pollMs?: number;
  deadlineSignal?: AbortSignal;
} = {}): Promise<Record<string, unknown>> {
  const url = publicUrl(args.url);
  const mode = args.mode ?? 'crawl';
  const limit = args.limit ?? DEFAULT_LIMIT;
  if (!url || (mode !== 'scrape' && mode !== 'crawl') || typeof limit !== 'number'
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT
    || Object.keys(args).some(k => !['url', 'mode', 'limit'].includes(k)))
    return { status: 'failed', error: 'Use a public http(s) URL, mode scrape/crawl, and limit 1–100; credentials in URLs are not allowed.' };
  const deadline = deps.deadlineSignal ?? AbortSignal.timeout(DEADLINE_MS);
  const signal = context?.signal ? AbortSignal.any([deadline, context.signal]) : deadline;
  let key: string | undefined;
  try { key = await withinBudget(deps.readKey ?? readFirecrawlKey, signal); }
  catch {
    if (context?.signal?.aborted) return { status: 'cancelled', message: 'Cancelled before any provider request.' };
    return { status: 'failed', error: deadline.aborted ? 'Firecrawl timed out during secret lookup; no provider request sent.' : 'Firecrawl secret store unavailable', setupCommand: SETUP };
  }
  if (!key) return { status: 'key-needed', setupCommand: SETUP, message: 'Firecrawl 키를 설정하거나 온보딩에서 건너뛴 단계를 다시 여세요.' };
  const redact = (value: string) => value.replaceAll(key!, '[redacted]');
  let crawlAttempted = false;
  const base = new URL(deps.apiBase ?? API);
  const request = (path: string, body?: unknown) => withinBudget(async () => {
    signal.throwIfAborted();
    if (path === 'crawl' && body !== undefined) crawlAttempted = true;
    const response = await (deps.fetch ?? fetch)(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`provider-http-${response.status}`);
    // Bound provider input as well as the final text output.
    if (Number(response.headers.get('content-length')) > RESPONSE_BYTES) throw new Error('provider-response-too-large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('provider-response-empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > RESPONSE_BYTES) throw new Error('provider-response-too-large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!record(data) || data.success === false) throw new Error('provider-response-invalid');
    return data;
  }, signal);
  const pages: Array<{ url?: string; markdown: string }> = [];
  let chars = 0;
  let truncated = false;
  let jobId: string | undefined;
  const append = (items: unknown) => {
    if (!Array.isArray(items)) throw new Error('provider-pages-invalid');
    for (const item of items) {
      if (!record(item) || typeof item.markdown !== 'string') throw new Error('provider-page-invalid');
      if (pages.length >= limit || chars >= OUTPUT_CHARS) { truncated = true; break; }
      const safeText = redact(item.markdown);
      const markdown = safeText.slice(0, OUTPUT_CHARS - chars);
      if (markdown.length < safeText.length) truncated = true;
      chars += markdown.length;
      const source = record(item.metadata) ? publicUrl(item.metadata.sourceURL) : undefined;
      pages.push({ ...(source ? { url: redact(source.href) } : {}), markdown });
    }
  };
  try {
    if (mode === 'scrape') {
      const result = await request('scrape', { url: url.href, formats: ['markdown'], onlyMainContent: true });
      append([result.data]);
      return { status: 'completed', mode, pages, truncated };
    }
    const started = await request('crawl', { url: url.href, limit, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } });
    if (typeof started.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(started.id)) throw new Error('provider-job-invalid');
    if (started.id.includes(key)) throw new Error('provider-job-invalid');
    jobId = started.id;
    while (true) {
      const result = await request(`crawl/${encodeURIComponent(jobId)}`);
      if (result.status === 'failed' || result.status === 'cancelled') return { status: 'failed', jobId, remoteMayContinue: false, error: 'Firecrawl crawl failed or cancelled', message: 'The remote job reported a terminal state. Starting a new crawl can incur additional charges.' };
      if (result.status === 'completed') {
        append(result.data);
        let next = result.next;
        const seen = new Set<string>();
        while (typeof next === 'string' && pages.length < limit && !truncated) {
          const target = new URL(next, base);
          if (seen.has(target.href)) throw new Error('provider-pagination-cycle');
          seen.add(target.href);
          if (target.origin !== base.origin || target.pathname !== new URL(`crawl/${jobId}`, base).pathname
            || target.username || target.password || target.hash) throw new Error('provider-pagination-invalid');
          const page = await request(target.pathname.slice(base.pathname.length) + target.search);
          append(page.data);
          if (page.next === next) throw new Error('provider-pagination-invalid');
          next = page.next;
        }
        if (next) truncated = true;
        return { status: 'completed', mode, jobId, pages, truncated };
      }
      if (result.status !== 'scraping') throw new Error('provider-status-invalid');
      await delay(deps.pollMs ?? POLL_MS, undefined, { signal });
    }
  } catch {
    const remote = crawlAttempted ? {
      ...(jobId ? { jobId } : {}), remoteMayContinue: true,
      message: 'A remote paid crawl may exist or continue, even without a job ID. Starting a new crawl can duplicate charges; check the existing job or provider dashboard first.',
    } : {};
    if (context?.signal?.aborted) return { status: 'cancelled', ...remote };
    if (deadline.aborted && jobId) return { status: 'pending', ...remote };
    return { status: 'failed', error: 'Firecrawl request failed; check key or provider status.', setupCommand: SETUP, ...remote };
  }
}
