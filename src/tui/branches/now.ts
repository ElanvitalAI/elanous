import { contextNowInWorker, type ContextNowAnswer } from '../../context-bus/context-now.js';
import { renderTuiNow } from '../../context-bus/context-now-surfaces.js';
import { debug } from '../../debug/log.js';

export interface NextTuiNowHost {
  readonly chatLines: string[];
  setChatScrollOffset(value: number): void;
}

/** Reuses the classic TUI's source-labelled context query and renderer. */
export async function runNextTuiNowBranchRoute(
  input: string,
  host: NextTuiNowHost,
  query: (request: { topic: string }) => Promise<ContextNowAnswer> = contextNowInWorker,
): Promise<void> {
  const topic = input.trim() === '지금 상황' ? '' : input.trim().replace(/^\/now(?:\s+|$)/u, '').trim();
  try {
    const answer = await query({ topic });
    host.chatLines.push(...renderTuiNow(answer));
  } catch (error) {
    debug.log('tui.next', 'now-query-failed', { message: error instanceof Error ? error.message : String(error) });
    host.chatLines.push('현재 맥락 조회 실패 · /now 다시 시도');
  }
  host.setChatScrollOffset(-1);
}
