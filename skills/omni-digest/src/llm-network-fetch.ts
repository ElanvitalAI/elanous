/** Observation boundary for HTTP LLM sends — vendored minimal copy of
 * src/session-runtime/llm-call-gateway.ts `llmNetworkFetch` (SKILL-LITE1: a skill
 * ships alone; there is no repository `src/` next to it in the public pack or a lite Pod).
 * Inside the repository the host may install `globalThis.__elanousDebugLog` to receive the
 * ledger rows; standalone the telemetry is silently skipped. Never logs credentials,
 * bodies or URL path/query — hostname only. */
export interface LlmCallContext {
  provider?: string;
  model?: string;
  sessionId?: string;
  parentSessionId?: string;
  role?: 'main' | 'child' | 'aux';
  requestedBy?: string;
}

/** Exactly one attempt row, emitted BEFORE the network send (including rejected/aborted sends). */
export function llmNetworkFetch(url: string | URL, init: RequestInit, fields: LlmCallContext = {}): Promise<Response> {
  try {
    // URL.hostname strips path, query, credentials and port; never fall back to the input URL on parse failure.
    let host: string | null = null;
    try { host = new URL(url).hostname || null; } catch { /* malformed URL is still sent to fetch */ }
    const emit = (globalThis as { __elanousDebugLog?: (category: string, event: string, data?: unknown) => void }).__elanousDebugLog;
    emit?.('llm.call', 'attempt', {
      provider: fields.provider ?? 'unknown', model: fields.model ?? null, host,
      sessionId: fields.sessionId ?? null, parentSessionId: fields.parentSessionId ?? null,
      role: fields.role ?? (fields.parentSessionId ? 'child' : 'main'),
      requestedBy: fields.requestedBy ?? 'provider',
    });
  } catch { /* telemetry must never alter transport behavior */ }
  return fetch(url, init);
}
