// RELEASE-GRAPH-IN-ELS — a release run/cut/publish started from a plain shell shows up as a graph tab in els.
// Observation only: it never blocks or fails the release. No els server (socket absent) → no-op; any els request
// error → one log line, then silence. Workspace = ELANOUS_ELS_WS, else «OP». Dry-run events are skipped by the producer.
import { existsSync } from 'node:fs';
import { requestEls } from '../../src/els/client.js';
import { wireElsGraphProducer, type ElsGraphProducerSources } from '../../src/els/graph-producer.js';
import { elsSocketPath } from '../../src/els/server.js';
import { onGraphNodeLifecycle, onGraphNodeProgress, onGraphRunIdleWake } from '../../src/graph-runner/runner.js';
import type { ElsResult } from '../../src/els/core.js';
import type { ElsRequest } from '../../src/els/server.js';
import { debug } from '../../src/debug/log.js';

export interface ObserveGraphInElsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly socketPath?: string;
  readonly cwd?: string;
  readonly sources?: ElsGraphProducerSources;
  readonly request?: (socketPath: string, request: ElsRequest) => Promise<ElsResult>;
  readonly log?: (line: string) => void;
}

/** Start observing; the returned `stop()` waits for queued requests and detaches. Never throws. */
export function observeGraphInEls(options: ObserveGraphInElsOptions = {}): { stop(): Promise<void> } {
  const log = options.log ?? ((line: string) => debug.log('release.run', 'els-graph-observe', { line }));
  try {
    const env = options.env ?? process.env;
    const socketPath = options.socketPath ?? env.ELANOUS_ELS_SOCKET?.trim() ?? elsSocketPath();
    if (!existsSync(socketPath)) { log(`els-graph-observe: no els server at ${socketPath} — release runs without a graph tab`); return { async stop() {} }; }
    let reported = false;
    const send = options.request ?? requestEls;
    const producer = wireElsGraphProducer({ ws: env.ELANOUS_ELS_WS?.trim() || 'OP', socketPath, ...(options.cwd ? { cwd: options.cwd } : {}),
      sources: options.sources ?? { onLifecycle: onGraphNodeLifecycle, onProgress: onGraphNodeProgress, onRunEnd: onGraphRunIdleWake },
      request: async (path, request) => {
        try { return await send(path, request); } catch (error) {
          if (!reported) { reported = true; log(`els-graph-observe: els request failed (${error instanceof Error ? error.message : String(error)}) — continuing without the tab`); }
          throw error;
        }
      } });
    return { async stop() { try { await producer.idle(); } finally { producer.dispose(); } } };
  } catch (error) {
    try { log(`els-graph-observe: not started (${error instanceof Error ? error.message : String(error)})`); } catch { /* never fails the release */ }
    return { async stop() {} };
  }
}
