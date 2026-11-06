// D4 · §6.4 SSE — `GET /v1/workflows/events`.
//
// Mirrors the PersonaRegistry pattern (handlePersonasEvents in
// `personas.ts`) for workflow yaml CRUD on disk: drops the cross-
// client refresh latency for the workflow picker from 30s (the
// `useWorkflows` refetchInterval safety net) to <500ms.
//
// Watches the 3 workflow source directories (project / global /
// builtin · discovered via workflow-runtime/discovery). Emits one
// `event: change` frame per fs.watch trigger with `{ dir, filename,
// eventType }` payload. The client side just invalidates its cached
// list — it does not need to interpret the diff.
//
// Why fs.watch (not chokidar / inotify wrapper): mirrors the existing
// PersonaRegistry approach + keeps zero extra deps. The `persistent:
// false` flag prevents the daemon from staying alive solely for the
// watch handles. Best-effort: failures (unmounted dir · permission
// denied) are silently swallowed so a single bad source doesn't crash
// the stream.
//
// Cross-ref:
//   src/nexus/api/personas.ts (handlePersonasEvents — same shape)
//   src/workflow-runtime/discovery.ts (getProjectWorkflowDir et al.)
//   apps/pwa/src/nexus/hooks/use-workflows.ts (client subscriber)

import { watch as fsWatch, type FSWatcher } from 'fs';
import { existsSync } from 'fs';
import { extname } from 'path';

import {
  getBuiltinWorkflowDir,
  getGlobalWorkflowDir,
  getProjectWorkflowDir,
} from '../../workflow-runtime/discovery.js';
import { jsonResponse } from './json-response.js';
import { SSE_HEARTBEAT_MS } from './sse-heartbeat.js';

/** Shape of a single change event delivered over SSE. The payload is
 *  intentionally minimal — clients should refresh their list, not try
 *  to apply a diff. */
export interface WorkflowChangeEvent {
  /** Which discovery source the file belongs to (project / global /
   *  builtin). Useful for debug logging on the client. */
  source: 'project' | 'global' | 'builtin';
  /** Absolute directory that emitted the event. */
  dir: string;
  /** Bare filename (no path · may be empty on some OSes). */
  filename: string;
  /** Raw fs.watch eventType (`'rename'` for create/delete · `'change'`
   *  for content edits). */
  eventType: string;
}

export interface WorkflowEventsRouteOpts {
  /** Optional auth check — production routes through the meta-api
   *  `checkAuth` shape via the http-server caller; tests pass undefined
   *  to skip, or a stub returning false to verify the 401 short-
   *  circuit. */
  checkAuth?: (req: Request) => boolean;
  /** Test seam — override the directory list. Production passes the
   *  defaults from workflow-runtime/discovery. */
  workflowDirs?: { source: WorkflowChangeEvent['source']; dir: string }[];
  /** Test seam — override the cwd used by getProjectWorkflowDir. */
  cwd?: string;
}

function resolveWorkflowDirs(opts: WorkflowEventsRouteOpts): {
  source: WorkflowChangeEvent['source'];
  dir: string;
}[] {
  if (opts.workflowDirs) return opts.workflowDirs;
  const cwd = opts.cwd ?? process.cwd();
  return [
    { source: 'project', dir: getProjectWorkflowDir(cwd) },
    { source: 'global', dir: getGlobalWorkflowDir() },
    { source: 'builtin', dir: getBuiltinWorkflowDir() },
  ];
}

/** Pure helper — given a filename + eventType, decide whether the
 *  event is relevant (yaml files only · skip reserved `_*` prefix
 *  entries which the discovery walker also skips). */
export function isWorkflowYamlEvent(
  filename: string,
  _eventType: string,
): boolean {
  if (!filename) return false;
  if (filename.startsWith('_')) return false;
  const ext = extname(filename).toLowerCase();
  return ext === '.yaml' || ext === '.yml';
}

/** `GET /v1/workflows/events` — long-lived SSE stream of fs.watch
 *  events on the 3 workflow source directories.
 *
 *  Frame format:
 *    event: hello   data: { sources: [...] }      (first frame, baseline)
 *    event: change  data: WorkflowChangeEvent     (one per fs.watch tick)
 *    : ping                                       (heartbeat, every 5s)
 *
 *  Stream close lifecycle: closing the HTTP request fires `cancel()`
 *  which stops every watcher + the heartbeat. */
export function handleWorkflowsEvents(
  req: Request,
  opts: WorkflowEventsRouteOpts = {},
): Response {
  if (opts.checkAuth && !opts.checkAuth(req)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  const dirs = resolveWorkflowDirs(opts);
  const encoder = new TextEncoder();
  let watchers: FSWatcher[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (kind: string, data: unknown): void => {
        try {
          const frame = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch { /* stream closed */ }
      };

      // Hello frame — gives the client an immediate baseline so it
      // knows which sources are being watched (and which were skipped
      // because the dir doesn't exist yet).
      const presentDirs = dirs.filter((d) => existsSync(d.dir));
      send('hello', {
        sources: presentDirs.map((d) => ({ source: d.source, dir: d.dir })),
        skipped: dirs
          .filter((d) => !presentDirs.includes(d))
          .map((d) => ({ source: d.source, dir: d.dir, reason: 'absent' })),
      });

      for (const { source, dir } of presentDirs) {
        try {
          const w = fsWatch(dir, { persistent: false }, (eventType, filename) => {
            const name = filename ? String(filename) : '';
            if (!isWorkflowYamlEvent(name, eventType)) return;
            send('change', {
              source,
              dir,
              filename: name,
              eventType,
            } satisfies WorkflowChangeEvent);
          });
          watchers.push(w);
        } catch {
          /* swallow — one bad dir shouldn't kill the stream */
        }
      }

      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { /* ignore */ }
      }, SSE_HEARTBEAT_MS);
    },
    cancel() {
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      watchers = [];
      if (heartbeat) {
        try { clearInterval(heartbeat); } catch { /* ignore */ }
        heartbeat = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
}
