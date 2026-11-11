import { contextNow, contextNowInWorker, type ContextNowDeps } from './context-now.js';
import { renderTuiNow } from './context-now-surfaces.js';

/** Shared release status surface used by the classic slash handler and simulation. */
export async function releaseTuiStatusLines(nowDeps?: ContextNowDeps): Promise<string[]> {
  const answer = nowDeps ? contextNow({ topic: '발행 상황' }, nowDeps)
    : await contextNowInWorker({ topic: '발행 상황' });
  return renderTuiNow(answer);
}
