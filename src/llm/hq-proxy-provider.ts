import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../llm.js';
import type { LLMConfig } from '../user-config/types.js';
import { isIP } from 'node:net';

/** Remote transport only. HQ provider credentials are never read here. */
export function makeHqProxyProvider(config: LLMConfig): LLMProvider {
  const defaultModel = config.model && /^(?:gpt-|codex-)[A-Za-z0-9._-]+$/.test(config.model)
    ? config.model : 'gpt-6.1-terra';
  const endpoint = config.baseUrl;
  const bearerToken = config.apiKey;
  const machineToken = process.env.ELANOUS_HQ_PROXY_MACHINE_TOKEN;
  const seat = process.env.ELANOUS_SEAT;
  const purpose = process.env.ELANOUS_LLM_PURPOSE?.trim();
  const pr = process.env.ELANOUS_PR_NUMBER;
  const validEndpoint = (() => {
    try {
      const url = new URL(endpoint ?? '');
      const octets = url.hostname.split('.').map(Number);
      const tailIpv4 = isIP(url.hostname) === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
      return url.protocol === 'https:' && (tailIpv4 || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname));
    } catch { return false; }
  })();
  const memberToken = /^emt_[A-Za-z0-9]{1,43}$/.test(bearerToken ?? '');
  const available = () => validEndpoint && !!bearerToken && (memberToken || !!machineToken) && !!seat && !!purpose;
  async function* streamChat(messages: LLMMessage[], opts: LLMOpts = {}): AsyncGenerator<LLMStreamEvent> {
    if (!available()) throw new Error('HQ proxy requires a tailnet HTTPS llm.baseUrl, bearer token, ELANOUS_SEAT, and ELANOUS_LLM_PURPOSE');
    const url = new URL('/v1/llm/proxy', endpoint);
    const response = await fetch(url, {
      method: 'POST', signal: opts.signal, redirect: 'error',
      headers: { authorization: `Bearer ${bearerToken}`, ...(memberToken ? {} : { 'x-elanous-machine-token': machineToken! }), 'content-type': 'application/json' },
      body: JSON.stringify({ seat, purpose, ...(pr && /^\d+$/.test(pr) ? { pr: Number(pr) } : {}),
        model: opts.model ?? defaultModel, messages,
        options: { tools: opts.tools, toolChoice: opts.toolChoice, maxTokens: opts.maxTokens,
          temperature: opts.temperature, reasoningEffort: opts.reasoningEffort, sessionId: opts.sessionId } }),
    });
    if (!response.ok) throw new Error(`HQ proxy request failed (${response.status})`);
    if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
      if (!response.body) throw new Error('HQ proxy returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let sawUsageEvent = false;
      let completed = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line) continue;
            const frame = JSON.parse(line) as { event?: LLMStreamEvent; usage?: import('../prompt-cache/types.js').LLMUsage; error?: string };
            if (frame.error) throw new Error(`HQ proxy stream failed (${frame.error})`);
            if (frame.event) {
              if (frame.event.type === 'usage' && !sawUsageEvent) {
                sawUsageEvent = true;
                opts.onUsage?.(frame.event.usage);
              }
              yield frame.event;
            }
            if (frame.usage) {
              completed = true;
              if (!sawUsageEvent) opts.onUsage?.(frame.usage);
            }
          }
          if (done) break;
        }
        if (pending.trim()) throw new Error('HQ proxy returned a truncated stream');
        if (!completed) throw new Error('HQ proxy stream ended without a usage completion frame');
      } finally { reader.releaseLock(); }
      return;
    }
    const result = await response.json() as { events?: LLMStreamEvent[]; usage?: import('../prompt-cache/types.js').LLMUsage };
    if (!Array.isArray(result.events)) throw new Error('HQ proxy returned an invalid response');
    for (const event of result.events) yield event;
    if (result.usage && !result.events.some(event => event.type === 'usage')) opts.onUsage?.(result.usage);
  }
  return {
    name: 'hq-proxy', defaultModel, available,
    streamChat,
    async *chat(messages, opts) { for await (const event of streamChat(messages, opts)) if (event.type === 'text') yield event.delta; },
  };
}
