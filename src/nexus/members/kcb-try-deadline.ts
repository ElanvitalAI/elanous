/** Return at the deadline even when a provider ignores cancellation; always signal it first. */
export async function runKcbTryWithinDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, requestSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort(requestSignal?.reason);
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
  if (requestSignal?.aborted) onRequestAbort();
  const timer = setTimeout(() => controller.abort(new Error('try-timeout')), timeoutMs);
  try {
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    return await Promise.race([run(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener('abort', onRequestAbort);
  }
}
