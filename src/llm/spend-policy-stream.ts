// Apply the spend gate to each actual provider request, including retries, without buffering the stream.
import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../llm.js';
import { withCodexAccountOverride } from '../oauth/codex-account-override.js';
import type { LlmCallGateResult, LlmCallOutcome, LlmCallHandle } from '../oauth/llm-call-gate.js';

/** A policy stop must never enter the ordinary provider fallback chain. */
export class SpendPolicyStopError extends Error {
  constructor(message: string) { super(message); this.name = 'SpendPolicyStopError'; }
}

export interface SpendPolicyStreamInput {
  messages: LLMMessage[];
  opts: LLMOpts;
  original: LLMProvider;
  select(): Promise<LlmCallGateResult>;
  settle(handle: LlmCallHandle, outcome: LlmCallOutcome): Promise<unknown>;
  signalFromError(error: unknown): LlmCallOutcome['signal'];
  accountForRow(row: string): string | undefined;
  providerForName(name: string): LLMProvider | undefined;
  onSelected(provider: LLMProvider, model: string): void;
  onDecision?(outcome: LlmCallGateResult['outcome']): void;
}

/**
 * Manual iterator forwards return() directly, preserving the tool loop's idle/abort watchdog.
 * Gate and settle happen once per provider attempt. A cancel before starting releases its reservation;
 * a request that started is conservatively settled as failed if interrupted.
 */
export function spendPolicyStream(input: SpendPolicyStreamInput): AsyncIterableIterator<LLMStreamEvent> {
  let opening: Promise<void> | undefined;
  let iterator: AsyncIterator<LLMStreamEvent> | undefined;
  let handle: LlmCallHandle | undefined;
  let account: string | undefined;
  let actualUsd: number | undefined;
  let closed = false, started = false, settled = false;
  const inScope = <T>(run: () => T): T => account ? withCodexAccountOverride(account, run) : run();
  const finish = async (outcome: LlmCallOutcome) => {
    if (!handle || settled) return;
    settled = true;
    await input.settle(handle, outcome);
  };
  const open = async () => {
    let selection: LlmCallGateResult;
    try { selection = await input.select(); } catch { throw new SpendPolicyStopError('LLM spend guard selection failed'); }
    input.onDecision?.(selection.outcome);
    if (selection.outcome === 'stop') throw new SpendPolicyStopError(`LLM spend guard stop: ${selection.reason}`);
    if (selection.outcome === 'go') handle = selection.handle;
    if (closed || input.opts.signal?.aborted) { await finish({ status: 'not-called' }); return; }
    const chosen = selection.outcome === 'go' ? input.providerForName(selection.provider) : input.original;
    const model = selection.outcome === 'go' ? selection.model : input.opts.model ?? input.original.defaultModel;
    if (!chosen?.streamChat || (selection.outcome === 'go' && (chosen.name !== selection.provider || !chosen.available()))) {
      await finish({ status: 'not-called' });
      throw new SpendPolicyStopError(`LLM spend guard selected unavailable provider ${selection.outcome === 'go' ? selection.provider : input.original.name}`);
    }
    account = selection.outcome === 'go' && selection.provider === 'openai-codex' ? input.accountForRow(selection.row) : undefined;
    const explicitAccount = process.env.ELANOUS_CODEX_ACCOUNT?.trim();
    if (account && explicitAccount && explicitAccount !== account) {
      await finish({ status: 'not-called' });
      throw new SpendPolicyStopError('LLM spend guard selected a different account from the explicit Codex account');
    }
    input.onSelected(chosen, model);
    try {
      iterator = inScope(() => chosen.streamChat!(input.messages, { ...input.opts, model })[Symbol.asyncIterator]());
    } catch (error) { await finish({ status: 'not-called' }); throw error; }
  };
  const result: AsyncIterableIterator<LLMStreamEvent> = {
    [Symbol.asyncIterator]() { return result; },
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        opening ??= open(); await opening;
        if (closed || !iterator) return { done: true, value: undefined };
        started = true;
        const step = await inScope(() => iterator!.next());
        if (!step.done && step.value.type === 'usage') {
          const cost = step.value.usage.reportedCostUsd;
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) actualUsd = cost;
        }
        if (step.done) { closed = true; await finish({ status: 'ok', ...(actualUsd !== undefined ? { actualUsd } : {}) }); }
        return step;
      } catch (error) {
        closed = true;
        const signal = input.signalFromError(error);
        await finish({ status: started ? 'failed' : 'not-called', ...(actualUsd !== undefined ? { actualUsd } : {}), ...(signal ? { signal } : {}) });
        throw error;
      }
    },
    async return(value?: void) {
      closed = true;
      if (iterator?.return) { try { void Promise.resolve(inScope(() => iterator!.return!(value))).catch(() => {}); } catch { /* abort already signalled by caller */ } }
      await finish({ status: started ? 'failed' : 'not-called', ...(actualUsd !== undefined ? { actualUsd } : {}) });
      return { done: true, value };
    },
  };
  return result;
}
