import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppActionResolvedCredentials } from './app-actions.js';

const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const JOB_ID = /^[0-9a-f-]{36}$/i;
const MAX_PROMPT_CHARS = 8_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type AppJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AppJobFailure = 'invalid-input' | 'provider-failed' | 'result-unavailable' | 'timeout';

export interface AppJobRecord {
  readonly id: string;
  readonly appSlug: string;
  readonly status: AppJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultKey?: string;
  readonly errorCode?: AppJobFailure;
}

export interface AppJobEvent {
  readonly id: number;
  readonly jobId: string;
  readonly appSlug: string;
  readonly status: AppJobStatus;
  readonly occurredAt: string;
  readonly resultKey?: string;
  readonly errorCode?: AppJobFailure;
}

interface AppJobRow {
  id: string;
  app_slug: string;
  status: AppJobStatus;
  created_at: string;
  updated_at: string;
  result_key: string | null;
  error_code: AppJobFailure | null;
  provider_request_id: string | null;
  notification_sent: number;
}

interface AppJobEventRow {
  id: number;
  job_id: string;
  app_slug: string;
  status: AppJobStatus;
  occurred_at: string;
  result_key: string | null;
  error_code: AppJobFailure | null;
}

export interface AppJobLedger {
  create(input: { id: string; appSlug: string; now: string }): AppJobRecord;
  get(input: { appSlug: string; jobId: string }): AppJobRecord | undefined;
  active(): readonly AppJobRecord[];
  transition(input: { appSlug: string; jobId: string; status: AppJobStatus; now: string; resultKey?: string; errorCode?: AppJobFailure }): AppJobRecord;
  events(input: { appSlug: string; jobId: string; afterId?: number }): readonly AppJobEvent[];
  markNotified(input: { appSlug: string; jobId: string }): boolean;
  close(): void;
}

function publicRecord(row: AppJobRow): AppJobRecord {
  return {
    id: row.id, appSlug: row.app_slug, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.result_key === null ? {} : { resultKey: row.result_key }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function publicEvent(row: AppJobEventRow): AppJobEvent {
  return {
    id: row.id, jobId: row.job_id, appSlug: row.app_slug, status: row.status, occurredAt: row.occurred_at,
    ...(row.result_key === null ? {} : { resultKey: row.result_key }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function validAppSlug(appSlug: string): boolean {
  return APP_SLUG.test(appSlug) && !appSlug.includes('--') && !appSlug.startsWith('xn--');
}

function jobFrom(db: Database, appSlug: string, jobId: string): AppJobRow | undefined {
  return db.query('SELECT * FROM app_generation_jobs WHERE app_slug = ? AND id = ?').get(appSlug, jobId) as AppJobRow | undefined;
}

/** Durable metadata-only ledger. Prompts, source bytes, URLs, provider errors, and credentials are never persisted. */
export function createAppJobLedger(databasePath: string): AppJobLedger {
  if (!databasePath.trim()) throw new Error('app job ledger path is required');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new Database(databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(`CREATE TABLE IF NOT EXISTS app_generation_jobs (
    id TEXT PRIMARY KEY,
    app_slug TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    result_key TEXT,
    error_code TEXT,
    notification_sent INTEGER NOT NULL DEFAULT 0 CHECK(notification_sent IN (0, 1)),
    UNIQUE(app_slug, id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_generation_job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    app_slug TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
    occurred_at TEXT NOT NULL,
    result_key TEXT,
    error_code TEXT,
    FOREIGN KEY(app_slug, job_id) REFERENCES app_generation_jobs(app_slug, id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS app_generation_job_events_lookup ON app_generation_job_events(app_slug, job_id, id)');

  function appendEvent(row: AppJobRow, now: string): void {
    db.query(`INSERT INTO app_generation_job_events(job_id, app_slug, status, occurred_at, result_key, error_code)
      VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, row.app_slug, row.status, now, row.result_key, row.error_code);
  }

  return {
    create(input) {
      if (!validAppSlug(input.appSlug)) throw new Error('invalid app job slug');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.query(`INSERT INTO app_generation_jobs(id, app_slug, status, created_at, updated_at)
          VALUES (?, ?, 'queued', ?, ?)`).run(input.id, input.appSlug, input.now, input.now);
        const row = jobFrom(db, input.appSlug, input.id)!;
        appendEvent(row, input.now);
        db.exec('COMMIT');
        return publicRecord(row);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(input) {
      const row = jobFrom(db, input.appSlug, input.jobId);
      return row ? publicRecord(row) : undefined;
    },
    active() {
      return (db.query("SELECT * FROM app_generation_jobs WHERE status IN ('queued', 'running') ORDER BY created_at, id").all() as AppJobRow[]).map(publicRecord);
    },
    transition(input) {
      if (!['queued', 'running', 'completed', 'failed'].includes(input.status)) throw new Error('invalid app job status');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = jobFrom(db, input.appSlug, input.jobId);
        if (!prior) throw new Error('app job not found');
        if (prior.status === 'completed' || prior.status === 'failed') { db.exec('COMMIT'); return publicRecord(prior); }
        if (input.status === 'completed' && typeof input.resultKey !== 'string') throw new Error('completed app job requires a result key');
        if (input.status === 'failed' && !input.errorCode) throw new Error('failed app job requires a stable error code');
        db.query('UPDATE app_generation_jobs SET status=?, updated_at=?, result_key=?, error_code=? WHERE app_slug=? AND id=?')
          .run(input.status, input.now, input.resultKey ?? null, input.errorCode ?? null, input.appSlug, input.jobId);
        const row = jobFrom(db, input.appSlug, input.jobId)!;
        appendEvent(row, input.now);
        db.exec('COMMIT');
        return publicRecord(row);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    events(input) {
      const rows = db.query(`SELECT e.* FROM app_generation_job_events e
        JOIN app_generation_jobs j ON j.app_slug=e.app_slug AND j.id=e.job_id
        WHERE e.app_slug=? AND e.job_id=? AND e.id>? ORDER BY e.id LIMIT 1000`)
        .all(input.appSlug, input.jobId, input.afterId ?? 0) as AppJobEventRow[];
      return rows.map(publicEvent);
    },
    markNotified(input) {
      return db.query('UPDATE app_generation_jobs SET notification_sent=1 WHERE app_slug=? AND id=? AND notification_sent=0 AND status IN (\'completed\', \'failed\')')
        .run(input.appSlug, input.jobId).changes > 0;
    },
    close() { db.close(); },
  };
}

export interface AppGenerationBackend {
  submit(input: { readonly prompt: string; readonly image: Uint8Array; readonly mimeType: string }): Promise<string>;
  poll(providerRequestId: string): Promise<{ readonly status: string; readonly resultUrl?: string }>;
}

export interface AppJobsOptions {
  readonly ledger: AppJobLedger;
  readonly saveResult: (input: { readonly appSlug: string; readonly jobId: string; readonly url: string }) => Promise<{ readonly key: string } | undefined>;
  readonly notify?: (input: { readonly appSlug: string; readonly jobId: string; readonly status: 'completed' | 'failed'; readonly resultKey?: string }) => Promise<void> | void;
  readonly now?: () => Date;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly id?: () => string;
}

export interface AppJobs {
  submit(input: { readonly appSlug: string; readonly prompt: string; readonly image: Uint8Array; readonly mimeType: string; readonly backend: AppGenerationBackend; readonly ownerConfirmed: boolean }): AppJobRecord;
  get(input: { readonly appSlug: string; readonly jobId: string }): AppJobRecord | undefined;
  close(): void;
}

export interface AppGenerationRuntime {
  readonly jobs: AppJobs;
  readonly ledger: AppJobLedger;
  /** App-scoped backend only; global CLI OAuth must never be substituted on this route. */
  readonly backendForCredentials: (credentials: AppActionResolvedCredentials) => AppGenerationBackend;
}

/** Connects a validated app action to the durable queue; provider calls stay behind the injected backend. */
export function createAppJobsGenerateAction(runtime: AppGenerationRuntime) {
  return async (input: { appSlug: string; prompt: string; image: Uint8Array; mimeType: string; credentials: AppActionResolvedCredentials }) => {
    const backend = runtime.backendForCredentials(input.credentials);
    const { credentials: _credentials, ...jobInput } = input;
    const job = runtime.jobs.submit({ ...jobInput, backend, ownerConfirmed: true });
    return { jobId: job.id, eventsUrl: `/v1/apps/${input.appSlug}/jobs/${job.id}/events` };
  };
}

export class AppJobError extends Error {
  constructor(readonly code: AppJobFailure) { super(code); this.name = 'AppJobError'; }
}

/** Queues a provider generation, persists only lifecycle metadata, stores terminal output, then notifies. */
export function createAppJobs(options: AppJobsOptions): AppJobs {
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const maxPolls = options.maxPolls ?? 1_200;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || !Number.isSafeInteger(maxPolls) || maxPolls < 1) {
    throw new Error('invalid app job polling limits');
  }
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;

  // Provider request IDs are intentionally ephemeral. A process restart cannot resume them,
  // so fail interrupted records explicitly instead of leaving clients polling forever.
  for (const record of options.ledger.active()) {
    options.ledger.transition({ appSlug: record.appSlug, jobId: record.id, status: 'failed', errorCode: 'provider-failed', now: now().toISOString() });
  }

  function terminal(record: AppJobRecord): void {
    if (record.status !== 'completed' && record.status !== 'failed') return;
    if (!options.notify || !options.ledger.markNotified({ appSlug: record.appSlug, jobId: record.id })) return;
    void Promise.resolve(options.notify({ appSlug: record.appSlug, jobId: record.id, status: record.status,
      ...(record.resultKey ? { resultKey: record.resultKey } : {}) })).catch(() => undefined);
  }

  async function run(input: { appSlug: string; prompt: string; image: Uint8Array; mimeType: string; backend: AppGenerationBackend }, job: AppJobRecord): Promise<void> {
    try {
      const providerRequestId = await input.backend.submit({ prompt: input.prompt, image: input.image, mimeType: input.mimeType });
      if (!providerRequestId || providerRequestId.length > 128) throw new AppJobError('provider-failed');
      options.ledger.transition({ appSlug: input.appSlug, jobId: job.id, status: 'running', now: now().toISOString() });
      for (let attempt = 0; attempt < maxPolls; attempt += 1) {
        if (closed) return;
        const result = await input.backend.poll(providerRequestId);
        if (result.status === 'completed') {
          if (!result.resultUrl) throw new AppJobError('result-unavailable');
          const stored = await options.saveResult({ appSlug: input.appSlug, jobId: job.id, url: result.resultUrl });
          if (!stored || !stored.key.startsWith(`apps/${input.appSlug}/generated/`)) throw new AppJobError('result-unavailable');
          terminal(options.ledger.transition({ appSlug: input.appSlug, jobId: job.id, status: 'completed', resultKey: stored.key, now: now().toISOString() }));
          return;
        }
        if (['failed', 'canceled', 'nsfw'].includes(result.status)) throw new AppJobError('provider-failed');
        if (result.status !== 'queued' && result.status !== 'in_progress' && result.status !== 'processing') throw new AppJobError('provider-failed');
        if (attempt + 1 < maxPolls && pollIntervalMs > 0) {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => { timers.delete(timer); resolve(); }, pollIntervalMs);
            timers.add(timer);
          });
        }
      }
      throw new AppJobError('timeout');
    } catch (error) {
      const code = error instanceof AppJobError ? error.code : 'provider-failed';
      try { terminal(options.ledger.transition({ appSlug: input.appSlug, jobId: job.id, status: 'failed', errorCode: code, now: now().toISOString() })); }
      catch { /* a terminal transition is idempotent and must not leak provider errors */ }
    }
  }

  return {
    submit(input) {
      if (closed) throw new Error('app jobs is closed');
      if (!validAppSlug(input.appSlug) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_CHARS
        || !(input.image instanceof Uint8Array) || input.image.byteLength < 1 || input.image.byteLength > MAX_IMAGE_BYTES
        || !/^image\/(?:jpeg|png|webp)$/.test(input.mimeType)) throw new AppJobError('invalid-input');
      if (input.ownerConfirmed !== true) throw new AppJobError('invalid-input');
      const job = options.ledger.create({ id: (options.id ?? randomUUID)(), appSlug: input.appSlug, now: now().toISOString() });
      void run(input, job);
      return job;
    },
    get(input) { return options.ledger.get(input); },
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); options.ledger.close(); },
  };
}

export interface AppJobsHttpRuntime {
  readonly jobs: Pick<AppJobs, 'get'>;
  readonly ledger: Pick<AppJobLedger, 'events'>;
  readonly authorize: (request: Request, appSlug: string) => boolean | Promise<boolean>;
}

/** Owner-authenticated status and resumable SSE stream for a single app's generation jobs. */
export async function handleAppJobRequest(request: Request, runtime: AppJobsHttpRuntime): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = /^\/v1\/apps\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/jobs\/([0-9a-f-]{36})(?:\/(events))?$/.exec(url.pathname);
  if (!match) return undefined;
  const appSlug = match[1]!;
  const jobId = match[2]!;
  const eventsPath = match[3] === 'events';
  if (!validAppSlug(appSlug) || !JOB_ID.test(jobId)) return Response.json({ error: 'not-found' }, { status: 404 });
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
  if (!await runtime.authorize(request, appSlug)) return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'cache-control': 'no-store' } });
  const job = runtime.jobs.get({ appSlug, jobId });
  if (!job) return Response.json({ error: 'job-not-found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  if (!eventsPath) return Response.json({ job }, { headers: { 'cache-control': 'no-store' } });
  const lastId = request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '0';
  if (!/^\d{1,12}$/.test(lastId)) return Response.json({ error: 'invalid-event-cursor' }, { status: 400 });
  let cursor = Number(lastId);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const emitEvents = (): void => {
        for (const event of runtime.ledger.events({ appSlug, jobId, afterId: cursor })) {
          cursor = event.id;
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`));
        }
      };
      const poll = () => {
        if (closed) return;
        try {
          emitEvents();
          const latest = runtime.jobs.get({ appSlug, jobId });
          if (latest?.status === 'completed' || latest?.status === 'failed') {
            // A terminal transition can commit after the first event query and before get().
            // The committed terminal status guarantees a second query can now observe its event.
            emitEvents();
            closed = true;
            controller.close();
            return;
          }
          timer = setTimeout(poll, 500);
        } catch { closed = true; controller.error(new Error('job event stream unavailable')); }
      };
      poll();
    },
    cancel() { closed = true; if (timer) clearTimeout(timer); },
  });
  return new Response(stream, { headers: { 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } });
}
