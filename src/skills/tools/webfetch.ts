import type { LLMToolSpec } from '../../llm/tool-spec.js';
// ── WebFetch tool (Claude Code-compatible URL fetcher) ──
//
// Ports claude-code-fork/src/tools/WebFetchTool. Fetches a URL,
// converts HTML → markdown with a lightweight inline converter,
// and returns the content as the tool_result. MVP omits the
// secondary LLM pass that claude-code uses to "answer the prompt
// over the fetched markdown" — in our skill runner the same model
// that dispatched WebFetch is still in the conversation loop, so
// it can consume the markdown directly and apply the `prompt`
// parameter itself on its next turn. Skipping the second hop
// saves a round trip and avoids mixing models.
//
// Scope:
//   - Works with any text-ish content type (HTML, text/plain,
//     JSON, markdown). HTML gets a pure-JS markdown-ish conversion
//     (no turndown dependency — we collapse tags and preserve
//     links/headings in a way the LLM handles fine).
//   - Non-text content types (image/*, application/octet-stream,
//     etc.) return descriptive metadata only — saving the binary
//     to local storage is out of scope for now.
//   - 60s network timeout, 10MB body cap, one redirect hop
//     (Node's `fetch` handles redirect by default).
//   - Simple in-process cache (15 min TTL, LRU at 20 entries) so
//     repeat fetches during one session don't re-download.
//   - No domain allowlist / blocklist integration — the skill
//     runner is a local dev tool, not a multi-tenant service.
//
// Failure surfaces as thrown Error (wrapped into isError tool_result
// by streamLLMWithTools). Timeouts, DNS failures, 4xx/5xx all throw
// with short actionable messages.



const TIMEOUT_MS = 60_000;
const MAX_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_CAP = 20;

export interface WebFetchArgs {
  url: string;
  prompt: string;
}

export interface WebFetchResult {
  /** String suitable for use as the tool_result content. */
  output: string;
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  cached: boolean;
  /** ms spent on the network fetch (0 for cache hits). */
  durationMs: number;
}

export function buildWebFetchTool(): LLMToolSpec {
  return {
    name: 'WebFetch',
    description:
      'Fetch a URL and return its content as markdown. HTML gets converted to ' +
      'a readable plain-text/markdown form; text/JSON/markdown come back as-is. ' +
      'After you receive the content, apply the `prompt` yourself on the next turn — ' +
      'e.g. extract a summary, pick out an answer, or look for a specific section. ' +
      'Content is capped at 10MB, network timeout 60s, results cached for 15 minutes.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Fully-qualified http(s) URL to fetch.',
        },
        prompt: {
          type: 'string',
          description: 'Describe what you want to extract from the fetched content. Informational only in MVP — the model applies this on its next turn rather than via a separate LLM call.',
        },
      },
      required: ['url', 'prompt'],
    },
  };
}

interface CacheEntry { result: WebFetchResult; ts: number; }
const cache = new Map<string, CacheEntry>();

/** Exposed for tests — resets the module-level fetch cache. */
export function _resetWebFetchCache(): void { cache.clear(); }

export async function dispatchWebFetch(
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<WebFetchResult> {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('WebFetch: url is required');
  // Minimal URL validation — let `new URL()` be authoritative.
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error(`WebFetch: invalid url ${JSON.stringify(url)}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`WebFetch: only http(s) supported (got ${parsed.protocol})`);
  }

  // Cache hit — identical url reused within TTL skips the network.
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.result, cached: true, durationMs: 0 };
  }

  const started = Date.now();
  const fetchFn = opts.fetchImpl ?? fetch;

  // AbortController lets us enforce both the per-call signal and our
  // own 60s timeout. Whichever fires first cancels the fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Some hosts 403 on a bare request without UA; claim to be a
        // generic fetcher so we don't pretend to be a browser.
        'user-agent': 'monad-agent WebFetch/1.0',
        accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.1',
      },
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') {
      throw new Error(`WebFetch: timed out or aborted after ${Date.now() - started}ms (${url})`);
    }
    throw new Error(`WebFetch: network error — ${err?.message || err}`);
  }
  clearTimeout(timer);

  const status = res.status;
  const contentType = (res.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();

  if (status >= 400) {
    throw new Error(`WebFetch: HTTP ${status} ${res.statusText} — ${url}`);
  }

  // Stream body with byte cap — avoid downloading a 2GB blob just to
  // discover we couldn't have used it anyway.
  const { text, bytes, truncated } = await readWithCap(res, MAX_BYTES);
  const durationMs = Date.now() - started;

  let output: string;
  if (isTextLike(contentType)) {
    const rendered = contentType.includes('html') ? htmlToMarkdown(text) : text;
    output = rendered;
  } else if (contentType.startsWith('image/')) {
    output = `[image: ${url}, ${formatBytes(bytes)}, ${contentType} — MVP: use Bash + curl/wget to save locally]`;
  } else {
    output = `[binary: ${url}, ${formatBytes(bytes)}, ${contentType} — MVP: use Bash + curl to save locally]`;
  }

  if (truncated) {
    output += `\n\n[... content truncated at ${formatBytes(MAX_BYTES)} ...]`;
  }

  const result: WebFetchResult = {
    output,
    url: res.url,   // final URL after redirects
    status, contentType, bytes, cached: false, durationMs,
  };

  // LRU-ish: evict oldest when full.
  if (cache.size >= CACHE_CAP) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(url, { result, ts: Date.now() });

  return result;
}

// ── internals ──

function isTextLike(ct: string): boolean {
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('yaml')
  );
}

async function readWithCap(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      total = maxBytes;
      truncated = true;
      try { await reader.cancel(); } catch { /* already closed */ }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { text: buf.toString('utf8'), bytes: total, truncated };
}

/** Minimal HTML → markdown-ish converter. Not pretty, but enough
 *  that the LLM can find links, headings, and body text. Keeps the
 *  dependency footprint to zero (no turndown). */
function htmlToMarkdown(html: string): string {
  let s = html;
  // Drop script/style/noscript bodies entirely.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Headings.
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, body) => {
    const hashes = '#'.repeat(Number(n));
    return `\n\n${hashes} ${stripTags(body)}\n\n`;
  });
  // Links → markdown.
  s = s.replace(/<a[^>]*\bhref=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, h1, h2, body) => `[${stripTags(body)}](${h1 ?? h2 ?? ''})`);
  // List items first — the block-tag sweep below would otherwise
  // collapse `<li>` to a bare newline, losing the bullet.
  s = s.replace(/<\/li\s*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  // Paragraphs + block-ish tags → linebreaks.
  s = s.replace(/<\/?(p|div|section|article|header|footer|main|br|tr)[^>]*>/gi, '\n');
  // Strip all remaining tags.
  s = stripTags(s);
  // Decode the five common HTML entities inline (skipping a full
  // decoder keeps this dep-free and covers 95% of pages).
  s = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse runs of blank lines / whitespace.
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return s.trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
