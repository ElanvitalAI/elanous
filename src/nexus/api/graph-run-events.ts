import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { listGraphRuns } from '../../graph-runner/runner.js';
import { watchGraphRunEvents } from '../../graph-runner/graph-run-event-ledger.js';
import { maskInsideEventValue } from './inside-events.js';

const PATH = /^\/v1\/graph-runs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/events$/;

/** Auth is enforced by the Nexus private-route gate before this handler is called. */
export function handleGraphRunEvents(req: Request, url: URL, root = effectiveInstanceRoot()): Response | undefined {
  const match = PATH.exec(url.pathname);
  if (!match) return undefined;
  if (req.method !== 'GET') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
  const runId = match[1]!;
  if (runId === '.' || runId === '..') return Response.json({ error: 'invalid-run-id' }, { status: 400 });
  const matches = listGraphRuns(root).runs.filter(state => state.runId === runId);
  if (matches.length !== 1) return Response.json({ error: matches.length ? 'ambiguous-run-id' : 'run-not-found' }, { status: matches.length ? 409 : 404 });
  const type = url.searchParams.get('type') ?? undefined;
  const cursor = req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
    return Response.json({ error: 'invalid-event-cursor' }, { status: 400 });
  const encoder = new TextEncoder();
  let cancelled = false;
  let resume: (() => void) | undefined;
  let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stop = new AbortController();
  const onDisconnect = () => {
    if (cancelled) return;
    cancelled = true;
    stop.abort();
    const pending = resume;
    resume = undefined;
    pending?.();
    activeController?.close();
  };
  req.signal.addEventListener('abort', onDisconnect, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      activeController = controller;
      void (async () => {
        try {
          for await (const event of watchGraphRunEvents(root, matches[0]!.graphId, runId,
            { afterSequence: Number(cursor), type, follow: true, signal: stop.signal })) {
            if (cancelled) break;
            // Source: Web Streams desiredSize/HighWaterMark are the consumer's backpressure contract.
            // Pause the journal iterator while the one-frame queue is full.
            if ((controller.desiredSize ?? 0) <= 0) await new Promise<void>(resolve => { resume = resolve; });
            if (cancelled) break;
            controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: graph-event\ndata: ${JSON.stringify(maskInsideEventValue(event))}\n\n`));
          }
          if (!cancelled) controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          req.signal.removeEventListener('abort', onDisconnect);
        }
      })();
    },
    pull() { const pending = resume; resume = undefined; pending?.(); },
    cancel() { cancelled = true; stop.abort(); const pending = resume; resume = undefined; pending?.(); },
  }, { highWaterMark: 1 });
  if (req.signal.aborted) onDisconnect();
  return new Response(stream, { headers: {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  } });
}
