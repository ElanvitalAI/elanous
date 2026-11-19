import type { ConfirmChannel, ConfirmOpts } from '../hitl/confirm.js';
import { requestConfirmation } from '../hitl/confirm.js';
import type { HitlAnswer, HitlAsk, HitlRequest } from './control.js';
import { hitlQuestion } from './control-cli.js';

/**
 * The HITL ask for `els mcp serve`. Stdin is the JSON-RPC protocol, so the person is asked
 * out-of-band through the wired confirm channels (telegram/pushcut/… — the same race
 * `requestConfirmation` runs everywhere). A channel approving → 'approve'; a channel
 * answering no → 'deny'; every channel silent until the timeout → 'timeout' (the door
 * audits 'timeout' and never sends the line — fail-closed). Zero wired channels falls
 * back to deny immediately: no unapproved dangerous `do` is ever sent.
 */
export function mcpHitlAsk(opts: Pick<ConfirmOpts, 'channels' | 'timeoutMs'> = {}): HitlAsk {
  return async (request: HitlRequest): Promise<HitlAnswer> => {
    const result = await requestConfirmation({
      prompt: hitlQuestion(request),
      header: 'els MCP approval',
      requestId: `els-mcp-hitl-${Date.now()}`,
      ...opts,
    });
    if (result.answer) return 'approve';
    return result.channel === 'timeout' ? 'timeout' : 'deny';
  };
}

/** Test seam: the channels a fake backend races. */
export function fakeConfirmChannel(answer: boolean | 'timeout', name = 'test'): ConfirmChannel {
  return {
    name,
    request: async () => (answer === 'timeout' ? await new Promise<null>(() => {}) : answer),
    cancel: () => {},
  };
}
