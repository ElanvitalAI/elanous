/**
 * GraphRunHost (GRAPH-RUN-DETACHED-FROM-TURN stage 1a): one call starts a graph run and returns its runId at once.
 * The run belongs to this process (the nexus), not to the caller's turn: no turn signal, tool cap or request is attached to it.
 * One process only (OP Q1). This stage only EXECUTES: there is no retry key, no read-back and no owner lookup, so nothing
 * stored is ever trusted for a later request. The start record is written for the audit trail and never read here.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { runGraph, type GraphRunOptions } from './runner.js';

/** Stage 1a origins come from the trusted bearer only; `human` needs a verified session and arrives with the read/owner stage. */
export type GraphRunOrigin =
  | { readonly kind: 'seat'; readonly seat?: string }
  | { readonly kind: 'graph'; readonly parentRunId: string; readonly parentNodeId: string };

export interface GraphRunStartRecord {
  readonly runId: string;
  readonly graphId: string;
  readonly origin: GraphRunOrigin;
  readonly startedAt: string;
  /** `started` = accepted by this host; `failed` = the runner threw. */
  readonly status: 'started' | 'failed';
  readonly error?: string;
}

export type GraphRunStartResult =
  | { readonly ok: true; readonly runId: string; readonly status: 'started' }
  | { readonly ok: false; readonly error: 'graph-not-found' | 'bad-origin' | 'bad-request' | 'record-write-failed' };

export interface GraphRunHostDeps {
  readonly root?: string;
  readonly resolveGraphFile: (graphId: string) => string | undefined;
  readonly run?: (file: string, options: GraphRunOptions) => Promise<unknown>;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
  /** Test seam for the permission step of a record write. */
  readonly chmod?: (path: string, mode: number) => void;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isGraphRunSegment = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && SEGMENT.test(value);

const ORIGIN_FIELDS_SEAT: ReadonlySet<string> = new Set(['kind', 'seat']);
const ORIGIN_FIELDS_GRAPH: ReadonlySet<string> = new Set(['kind', 'parentRunId', 'parentNodeId']);

/** The origin comes from the request body; every id in it is segment-checked, and parent ids are only recorded (the caller holds the trusted bearer). */
export function parseGraphRunOrigin(raw: unknown): GraphRunOrigin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { kind, seat, parentRunId, parentNodeId } = raw as Record<string, unknown>;
  // A field this stage does not honour is refused, never dropped silently.
  const allowed = kind === 'seat' ? ORIGIN_FIELDS_SEAT : kind === 'graph' ? ORIGIN_FIELDS_GRAPH : undefined;
  if (!allowed || Object.keys(raw).some(field => !allowed.has(field))) return null;
  if (kind === 'seat') return seat === undefined ? { kind } : isGraphRunSegment(seat) ? { kind, seat } : null;
  if (kind === 'graph' && isGraphRunSegment(parentRunId) && isGraphRunSegment(parentNodeId)) return { kind, parentRunId, parentNodeId };
  return null;
}

export function createGraphRunHost(deps: GraphRunHostDeps) {
  const root = deps.root ?? effectiveInstanceRoot();
  const run = deps.run ?? ((file: string, options: GraphRunOptions) => runGraph(file, options));
  const now = deps.now ?? (() => new Date());
  const chmod = deps.chmod ?? chmodSync;
  const dir = join(root, 'graph-runs', '_starts');
  const file = (runId: string) => join(dir, `${runId}.json`);

  const write = (record: GraphRunStartRecord, exclusive: boolean): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = file(record.runId);
    if (exclusive) {
      writeFileSync(target, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      // A record that could not be made private is not a start: remove it, so nothing half-written stays behind.
      try { chmod(target, 0o600); }
      catch (error) { try { unlinkSync(target); } catch { /* the original error is the one that matters */ } throw error; }
    } else {
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, target);
      chmod(target, 0o600);
    }
  };

  return {
    /** Records the start, launches the run without awaiting it, and returns a fresh runId. Every call is a new run. */
    start(input: { graphId: unknown; input?: unknown; origin: GraphRunOrigin | null }): GraphRunStartResult {
      const { graphId, origin } = input;
      if (!isGraphRunSegment(graphId)) return { ok: false, error: 'bad-request' };
      if (!origin) return { ok: false, error: 'bad-origin' };
      const graphFile = deps.resolveGraphFile(graphId);
      if (!graphFile) return { ok: false, error: 'graph-not-found' };
      const runId = (deps.newRunId ?? (() => `run-${randomUUID()}`))();
      const record: GraphRunStartRecord = { runId, graphId, origin, startedAt: now().toISOString(), status: 'started' };
      try { write(record, true); }
      catch (error) {
        debug.log('graph-run-host', 'record-write-failed', { runId, error: String(error) }, { level: 'error' });
        return { ok: false, error: 'record-write-failed' };
      }
      // Detached on purpose: no request, turn or tool signal is passed, so nothing the caller does can cancel it.
      void Promise.resolve().then(() => run(graphFile, { runId, input: input.input, quiet: true })).catch((error: unknown) => {
        const message = String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_CHARS);
        try { write({ ...record, status: 'failed', error: message }, false); }
        catch (writeError) { debug.log('graph-run-host', 'failed-record-write-failed', { runId, error: String(writeError) }, { level: 'error' }); }
        debug.log('graph-run-host', 'run-failed', { runId, graphId, error: message }, { level: 'error' });
      });
      debug.log('graph-run-host', 'started', { runId, graphId, origin: origin.kind });
      return { ok: true, runId, status: 'started' };
    },
  };
}
const MAX_ERROR_CHARS = 300;
export type GraphRunHost = ReturnType<typeof createGraphRunHost>;
