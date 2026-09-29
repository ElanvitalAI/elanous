import type { LLMProvider } from '../llm.js';

export interface ProviderProbeResult {
  success: boolean;
  durationMs: number;
  model: string;
  error?: string;
}

export interface ProviderProbeOptions {
  timeoutMs?: number;
}

const PROBE_PROMPT = 'Reply with OK.';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Make one bounded, tool-free request without exposing response text or provider errors. */
export async function probeProvider(
  provider: LLMProvider,
  options: ProviderProbeOptions = {},
): Promise<ProviderProbeResult> {
  const started = performance.now();
  const model = provider.defaultModel;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const request = (async () => {
    let receivedText = false;
    for await (const chunk of provider.chat(
      [{ role: 'user', content: PROBE_PROMPT }],
      { model, maxTokens: 16, tools: [], toolChoice: 'none', signal: controller.signal },
    )) {
      if (chunk.length > 0) receivedText = true;
    }
    return receivedText;
  })();
  try {
    const receivedText = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('timeout'));
        }, timeoutMs);
      }),
    ]);
    return receivedText
      ? { success: true, durationMs: performance.now() - started, model }
      : { success: false, durationMs: performance.now() - started, model, error: 'empty response' };
  } catch {
    return { success: false, durationMs: performance.now() - started, model, error: timedOut ? 'timeout' : 'probe failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
