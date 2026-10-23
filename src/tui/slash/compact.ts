// TUI-NEXT-COMPACT — next TUI context compaction (auto before a turn · `/compact` now).
// Wiring only: the threshold (shouldAutoCompact) and the pipeline (runCompactPipeline) run inside the
// shared session bridge `compactSessionHistory` (src/session/compact-session.ts), the same seam the
// continuation loop and `elanous session compact` use. Thresholds and anchor counts are the shared
// `chat.autoCompact` defaults. The REPL child reloads the session file every turn (session/chat.ts
// runTurn → loadSession), so rewriting the store between turns is what the next model call sees.
import { debug } from '../../debug/log.js';
import { compactSessionHistory } from '../../session/compact-session.js';
import type { CompactProvider } from '../../compact/provider.js';
import type { ChatAutoCompactConfig } from '../../user-config.js';
export { COMPACT_BUSY_STATUS, COMPACT_NO_SESSION_STATUS, isCompactCommand } from './compact-command.js';

/** Test/embedding seams. Production passes none of these. */
export interface NextTuiCompactDeps {
  readonly provider?: CompactProvider;
  readonly config?: ChatAutoCompactConfig;
  readonly modelId?: string;
}

export interface NextTuiCompactOutcome {
  readonly fired: boolean;
  readonly reason: string;
  readonly before: number;
  readonly after: number;
  readonly ms: number;
  /** Status-line text, or null when an auto check stays silent (under threshold). */
  readonly status: string | null;
}

function compactStatus(before: number, after: number): string {
  return `압축 ${before}→${after} 메시지`;
}

async function defaultConfig(): Promise<ChatAutoCompactConfig> {
  const { getUserConfig } = await import('../../user-config.js');
  return getUserConfig().chat.autoCompact;
}

/** Same resolution order as the continuation runner (dispatch/continuation-turn-runner.ts). */
async function defaultModelId(): Promise<string | undefined> {
  try {
    const { getUserConfig } = await import('../../user-config.js');
    const cfg = getUserConfig();
    if (cfg.llm?.model) return cfg.llm.model;
    const { getProviderForConfig } = await import('../../llm.js');
    return getProviderForConfig(cfg).defaultModel;
  } catch {
    return undefined;
  }
}

/**
 * Compact the next-TUI session once. `force:false` = the pre-turn auto check (fires only over the
 * shared threshold); `force:true` = `/compact` (bypasses the threshold). Never throws: a failure is
 * observed and reported as not fired, so the caller sends its turn uncompacted.
 */
export async function compactNextTuiSession(
  sessionId: string,
  input: { readonly force: boolean; readonly modelId?: string | null },
  deps: NextTuiCompactDeps = {},
): Promise<NextTuiCompactOutcome> {
  const auto = !input.force;
  const started = Date.now();
  try {
    const config = deps.config ?? await defaultConfig();
    if (auto && !config.enabled) return { fired: false, reason: 'disabled', before: 0, after: 0, ms: 0, status: null };
    const modelId = input.modelId ?? deps.modelId ?? await defaultModelId();
    const result = await compactSessionHistory(sessionId, {
      config,
      force: input.force,
      ...(modelId ? { modelId } : {}),
      ...(deps.provider ? { provider: deps.provider } : {}),
    });
    const ms = Date.now() - started;
    if (result.fired) {
      debug.log('tui.next', 'compact', { auto, before: result.before, after: result.after, ms });
      return { fired: true, reason: result.reason, before: result.before, after: result.after, ms, status: compactStatus(result.before, result.after) };
    }
    if (!auto) debug.log('tui.next', 'compact-skipped', { auto, reason: result.reason, before: result.before, ms });
    return {
      fired: false,
      reason: result.reason,
      before: result.before,
      after: result.after,
      ms,
      status: auto ? null : `압축할 내용 없음 · ${result.before} 메시지`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ms = Date.now() - started;
    debug.log('tui.next', 'compact-failed', { auto, ms, error: message }, { level: 'warn' });
    return { fired: false, reason: 'error', before: 0, after: 0, ms, status: auto ? null : `압축 실패: ${message}` };
  }
}
