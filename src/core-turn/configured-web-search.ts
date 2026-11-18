// CHAT-TOOLS-ENTRY-VIA-CORE-TURN (#38246 · JUD-B TUI/ACP clause) — one rule for every surface that routes a tool turn
// through the core turn: the structured research route only becomes eligible with a web tool in the pool
// (run-core-turn.ts `structuredRouteEligible`), so add WebSearch when a search provider is configured.
// Same rule as `buildContinuationAgentTools` (telegram) and the CLI (`chat --tools` / `agent`).
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { debug } from '../debug/log.js';

type ToolDispatch = (name: string, args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<unknown>;

/** Surfaces that may get the configured WebSearch added (an allowlist — a new surface is opted in explicitly). */
export type ConfiguredWebSearchSurface = 'chat' | 'agent' | 'tui';

/**
 * Add WebSearch to a tool catalog when a search provider is configured (sync-ready or typed-store pending).
 * Unchanged when WebSearch is already present; when no provider is configured the omission is logged
 * (`chat.tools web-search-omitted`) so a turn that cannot reach the structured route is visible.
 */
export function withConfiguredWebSearch<T extends { specs: LLMToolSpec[]; dispatch: ToolDispatch }>(
  built: T,
  surface: ConfiguredWebSearchSurface,
): T {
  if (built.specs.some(spec => spec.name === 'WebSearch')) return built;
  const webRegistry = require('../web-search/index.js') as typeof import('../web-search/index.js');
  const configured = webRegistry.getAvailableWebSearchProviders().length + webRegistry.webSearchProvidersPendingAsyncReadiness().length;
  if (configured < 1) {
    debug.log('chat.tools', 'web-search-omitted', { surface, reason: 'no-search-provider' });
    return built;
  }
  const ws = require('../skills/tools/web-search.js') as typeof import('../skills/tools/web-search.js');
  const dispatch: ToolDispatch = async (name, args, context) => name === 'WebSearch'
    ? ws.dispatchWebSearch(args, context?.signal ? { signal: context.signal } : {})
    : built.dispatch(name, args, context);
  return { ...built, specs: [...built.specs, ws.buildWebSearchTool()], dispatch } as T;
}
