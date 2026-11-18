/** Observe submitted prompts to external coding-agent TUIs, not their internal HTTP calls. */
import { basename } from 'node:path';
import { getAmbientSessionId } from '../../debug/log.js';
import type { PtyHandle } from '../../pty-shell/registry.js';
import { llmObserveDelegation } from '../../session-runtime/llm-call-gateway.js';

type Brand = 'claude-code' | 'codex';
const codingAgents = new WeakMap<PtyHandle, { brand: Brand; model?: string }>();

function explicitModel(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--model' || arg === '-m') && args[i + 1]) return args[i + 1];
    if (arg.startsWith('--model=') && arg.length > '--model='.length) return arg.slice('--model='.length);
  }
  return undefined;
}

export function registerCodingAgentPty(handle: PtyHandle, brand: Brand, args: readonly string[] = []): void {
  codingAgents.set(handle, { brand, model: explicitModel(args) });
}

/** Only an unambiguous direct executable is classified; shell wrappers are not inferred. */
export function registerDirectCodingAgentPty(handle: PtyHandle, cmd: string, args: readonly string[] = []): void {
  const binary = basename(cmd);
  if (binary === 'claude' || binary === 'codex') {
    registerCodingAgentPty(handle, binary === 'claude' ? 'claude-code' : 'codex', args);
  }
}

/** An Enter/submit is one CLI prompt dispatch, even if text was typed in separate writes. */
export function observeCodingAgentSubmit<T>(handle: PtyHandle, send: () => T): T {
  const agent = codingAgents.get(handle);
  if (!agent) return send();
  // External CLIs choose their own endpoint and may send multiple HTTP requests;
  // observe only the delegated prompt, with no HTTP host inferred.
  return llmObserveDelegation({
    provider: agent.brand,
    ...(agent.model ? { model: agent.model } : {}),
    role: 'child',
    ...(getAmbientSessionId() ? { parentSessionId: getAmbientSessionId()! } : {}),
    selectionSource: agent.model ? 'explicit' : 'fallback',
    billing: 'subscription',
    requestedBy: 'pty-coding-agent-prompt',
  }, send);
}
