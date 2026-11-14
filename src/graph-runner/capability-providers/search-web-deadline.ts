// Source: #38423 — the entire lookup, fetch, and body read must share one 15 s ceiling.
export const SEARCH_REQUEST_TIMEOUT_MS = 15_000;

/** Bounds work even when credential lookup or a response stream ignores AbortSignal. */
export async function runSearchWithDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal,
  timeoutMs = SEARCH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_REQUEST_TIMEOUT_MS)
    throw new Error('invalid search timeout');
  const controller = new AbortController();
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectAbort(new Error('search deadline exceeded or cancelled'));
  };
  outerSignal?.addEventListener('abort', abort, { once: true });
  if (outerSignal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]); }
  finally { clearTimeout(timer); outerSignal?.removeEventListener('abort', abort); }
}

/** A stalled reader is raced against the same deadline; cancellation is best-effort. */
export async function readSearchJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes || !response.body) throw new Error('invalid search response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new Error('search response cancelled'));
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('invalid search response');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A pending read may still be settling. */ }
  }
}
