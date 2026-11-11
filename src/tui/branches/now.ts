import { contextNowInWorker, type ContextNowAnswer } from '../../context-bus/context-now.js';
import { renderTuiNow } from '../../context-bus/context-now-surfaces.js';
import { debug } from '../../debug/log.js';

export interface NextTuiNowHost {
  readonly chatLines: string[];
  setChatScrollOffset(value: number): void;
  readonly signal?: AbortSignal;
  onUpdate?(): void;
}

type NowSection = 'core' | 'operations';
type NowQuery = (request: { topic: string; section: NowSection; signal?: AbortSignal }) => Promise<ContextNowAnswer>;

function queryWithDeadline(query: NowQuery, topic: string, section: NowSection, signal: AbortSignal | undefined, deadlineMs: number): Promise<ContextNowAnswer> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (answer?: ContextNowAnswer, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(answer!);
    };
    const onAbort = () => { controller.abort(); finish(undefined, new Error('cancelled')); };
    const timer = setTimeout(() => { controller.abort(); finish(undefined, new Error('deadline')); }, deadlineMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => query({ topic, section, signal: controller.signal })).then(
      answer => finish(answer), error => finish(undefined, error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** Show each sourced section as soon as it arrives; a slow ledger cannot hide the other section. */
export async function runNextTuiNowBranchRoute(
  input: string,
  host: NextTuiNowHost,
  query: NowQuery = contextNowInWorker,
  deadlineMs = 8_000, // Source: #36701 measured an approximately ten-second silent /now wait.
): Promise<void> {
  const topic = input.trim() === '지금 상황' ? '' : input.trim().replace(/^\/now(?:\s+|$)/u, '').trim();
  const sections: NowSection[] = ['core', 'operations'];
  let successes = 0;
  await Promise.all(sections.map(async section => {
    try {
      const answer = await queryWithDeadline(query, topic, section, host.signal, deadlineMs);
      if (host.signal?.aborted) return;
      successes++;
      host.chatLines.push(section === 'core' ? '기본 현황' : '운영 현황', ...renderTuiNow(answer));
      host.onUpdate?.();
    } catch (error) {
      if (host.signal?.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('tui.next', 'now-query-failed', { section, reason });
      host.chatLines.push(`${section === 'core' ? '기본' : '운영'} 현황 ${reason === 'deadline' ? '시간 상한 도달' : '조회 실패'} · 나머지 결과는 표시됨`);
      host.onUpdate?.();
    }
  }));
  if (host.signal?.aborted) host.chatLines.push('현재 맥락 조회 취소됨');
  else if (successes === 0) host.chatLines.push('현재 맥락 조회 실패 · /now 다시 시도');
  if (host.signal?.aborted || successes === 0) host.onUpdate?.();
  host.setChatScrollOffset(-1);
}
