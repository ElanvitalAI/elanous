// A bounded post-research delivery round: only the seat mail tools already admitted by the caller.
import { logAgentTurnUsage, type LLMMessage, type LLMProvider, type LLMStreamEvent, type StreamWithToolsHandlers } from '../llm.js';
import type { LLMToolSpec } from './tool-spec.js';

const MAIL_NAMES = new Set(['MsgPost', 'MsgAck']);
// At most one post and one acknowledgement, so a final round cannot resume research.
const MAX_FINAL_MAIL_CALLS = 2;
// Match the existing force-synthesis pass timeout (llm.ts, F2_TIMEOUT_MS).
const FINAL_MAIL_TIMEOUT_MS = 60_000;

export async function deliverFinalResearchMail(input: {
  provider: LLMProvider; model: string; history: LLMMessage[]; tools: readonly LLMToolSpec[];
  handlers: StreamWithToolsHandlers; turn: number; sessionId?: string; signal?: AbortSignal;
}): Promise<void> {
  const tools = input.tools.filter(tool => MAIL_NAMES.has(tool.name));
  if (!tools.length || !input.provider.streamChat || input.signal?.aborted) return;
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(FINAL_MAIL_TIMEOUT_MS)]) : AbortSignal.timeout(FINAL_MAIL_TIMEOUT_MS);
  const prompt: LLMMessage = { role: 'user', content: 'Research is complete. If this seat must reply or acknowledge a received message, use only the available mail tools now. Otherwise do not call tools.' };
  const calls: Array<Extract<LLMStreamEvent, { type: 'tool_call' }>> = [];
  const allowed = new Set(tools.map(tool => tool.name));
  const used = new Set<string>();
  let usageSeen = false;
  try {
    for await (const event of input.provider.streamChat([...input.history, prompt], {
      model: input.model, tools, signal, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    })) {
      if (event.type === 'usage') {
        usageSeen = true;
        logAgentTurnUsage(input.model, event.usage, { providerName: input.provider.name, site: 'research-final-mail', role: 'research', ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
        input.handlers.onUsage?.(event.usage);
        continue;
      }
      if (event.type !== 'tool_call' || event.argsInvalid || !allowed.has(event.name) || used.has(event.name) || calls.length >= MAX_FINAL_MAIL_CALLS) continue;
      used.add(event.name); calls.push(event);
    }
  } catch {
    if (!usageSeen) logAgentTurnUsage(input.model, 'unmeasured', { providerName: input.provider.name, site: 'research-final-mail', role: 'research', missingReason: 'provider-call-failed' });
    return;
  }
  if (!usageSeen) logAgentTurnUsage(input.model, 'unmeasured', { providerName: input.provider.name, site: 'research-final-mail', role: 'research' });
  if (signal.aborted || !calls.length) return;
  const results: Array<{ type: 'tool_result'; tool_use_id: string; content: string; isError?: boolean }> = [];
  for (const call of calls) {
    if (signal.aborted) break;
    input.handlers.onToolCall?.(call);
    try {
      const result = await input.handlers.dispatchTool(call.name, call.args, { callId: call.id, turnIndex: input.turn });
      input.handlers.onToolResult?.({ id: call.id, name: call.name, result });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result ?? null) });
    } catch (error) {
      results.push({ type: 'tool_result', tool_use_id: call.id, content: error instanceof Error ? error.message : String(error), isError: true });
    }
  }
  if (!results.length) return;
  const completed = calls.slice(0, results.length);
  input.history.push(prompt, { role: 'assistant', content: completed.map(call => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.args, ...(call.providerMeta ? { providerMeta: call.providerMeta } : {}) })) },
    { role: 'user', content: results });
}
