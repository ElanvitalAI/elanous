import type { TaskCardEntry } from '../../apps/pwa/src/lib/task-card-model.js';

export interface MemberBoardFeedAdapter {
  read(memberId: string): Promise<TaskCardEntry[]>;
  watch(memberId: string, signal: AbortSignal, onBoardCard: () => void, onReady: () => void): Promise<void>;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Keep the existing TaskCard journal projection current from the Nexus board API. */
export function startMemberBoardFeed(options: {
  adapter: MemberBoardFeedAdapter;
  memberId: string;
  onEntries: (entries: TaskCardEntry[]) => void;
  onError?: (error: Error) => void;
  sseConnectTimeoutMs?: number;
}): () => void {
  const controller = new AbortController();
  let stopped = false;
  let refreshInFlight: Promise<void> | undefined;
  let refreshRequested = false;

  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (refreshInFlight) {
      refreshRequested = true;
      return refreshInFlight;
    }
    refreshInFlight = options.adapter.read(options.memberId)
      .then((entries) => { if (!stopped) options.onEntries(entries); })
      .catch((error: unknown) => {
        if (!stopped) options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        refreshInFlight = undefined;
        if (refreshRequested && !stopped) {
          refreshRequested = false;
          void refresh();
        }
      });
    return refreshInFlight;
  };

  const connect = async () => {
    let retryMs = 250;
    while (!stopped) {
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => { markReady = resolve; });
      let connectedAt: number | undefined;
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort();
      controller.signal.addEventListener('abort', abortAttempt, { once: true });
      let timedOut = false;
      const connectTimeout = setTimeout(() => {
        if (connectedAt === undefined && !stopped) {
          timedOut = true;
          attemptController.abort();
        }
      }, options.sseConnectTimeoutMs ?? 10_000);
      const watching = options.adapter.watch(
        options.memberId,
        attemptController.signal,
        () => { void refresh(); },
        () => { connectedAt ??= Date.now(); clearTimeout(connectTimeout); markReady(); },
      );
      const result = await Promise.race([
        ready.then(() => 'ready' as const),
        watching.then(() => 'closed' as const, () => 'failed' as const),
      ]);

      if (stopped) return;
      if (result === 'ready') {
        // Wait for the SSE response before the authoritative snapshot. Any
        // event arriving during this read schedules a trailing snapshot.
        await refresh();
      }

      try {
        await watching;
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          options.onError?.(timedOut
            ? new Error('Nexus board SSE 연결 응답 시간이 초과됐습니다.')
            : error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        clearTimeout(connectTimeout);
        controller.signal.removeEventListener('abort', abortAttempt);
      }
      if (stopped) return;

      // A closed stream can have missed cards during the gap. Reconcile before
      // reconnecting, then back off if the server keeps closing the stream.
      await refresh();
      // Reset only after the connection survived long enough to be considered
      // stable; a fast-close loop must retain its exponential backoff.
      if (connectedAt !== undefined && Date.now() - connectedAt >= 30_000) retryMs = 250;
      if (!stopped) await waitForRetry(retryMs, controller.signal);
      retryMs = Math.min(retryMs * 2, 10_000);
      if (connectedAt === undefined && !stopped) options.onError?.(new Error('Nexus board SSE가 준비되기 전에 연결이 끝났습니다.'));
    }
  };
  // The board snapshot is useful even if the SSE endpoint stalls before its
  // headers arrive. A successful SSE connection triggers another reconcile.
  void refresh();
  void connect().catch((error: unknown) => {
    if (!stopped) options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });

  return () => {
    stopped = true;
    controller.abort();
  };
}
