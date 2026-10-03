import { debug } from '../debug/log.js';
import { readFileSync } from 'node:fs';
import { getUserConfig, parseEventsConfig, userConfigPath, type EventsConfig } from '../user-config.js';
import { dispatchHook, type HookWake } from './dispatch.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { HookQueue, type QueuedHook } from './queue.js';
import { recordGithubShadow } from './github-shadow.js';
import { toExternalTask, verifyWebhook, type HookProvider } from './providers.js';
import { drainReports, handleReportPost, ReportLimiter, ReportQueue, type ReceivedReport } from './error-report.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';

export interface HookSecrets {
  linear?: string;
  asana?: string;
  github?: string;
  saveAsana?: (secret: string) => Promise<void>;
}
export interface HookReceiverOptions {
  host?: string;
  port: number;
  secrets: HookSecrets;
  forward?: (event: QueuedHook) => Promise<Response | number>;
  now?: () => number;
  root?: string;
  retryBaseMs?: number;
  events?: EventsConfig;
  wakeSeat?: HookWake;
  /** ER2 — forward one queued error report to the Primary; default = POST /v1/reports/ingest over the tailnet. */
  forwardReport?: (item: ReceivedReport) => Promise<boolean>;
  /** GET-only public metadata lookup; failure forces human review. */
  githubFetch?: typeof fetch;
}

/** `/v1/tasks` lives on the Primary's nexus API, not on the control plane — so the address is its own setting. */
export function hooksPrimaryUrl(config: { hooks?: { primaryUrl?: unknown } }): URL {
  const value = config.hooks?.primaryUrl;
  if (typeof value !== 'string' || !value) throw new Error('hooks.primaryUrl missing');
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('hooks.primaryUrl must be http(s)');
  return url;
}

async function forwardReportToPrimary(item: ReceivedReport): Promise<boolean> {
  const config = JSON.parse(readFileSync(userConfigPath(), 'utf8')) as { hooks?: { primaryTokenRef?: string; primaryUrl?: unknown } };
  const ref = config.hooks?.primaryTokenRef;
  if (!ref) throw new Error('primary token reference missing');
  const token = await getSecretAsync(ref);
  if (!token) throw new Error('primary token missing');
  const response = await fetch(new URL('/v1/reports/ingest', hooksPrimaryUrl(config)), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(item), signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export function startHookReceiver(options: HookReceiverOptions): { url: string; stop: () => void; queue: HookQueue } {
  const queue = new HookQueue(options.root);
  const reportQueue = new ReportQueue(options.root ?? effectiveInstanceRoot(), (event, data) => debug.log('hooks.reports', event, data));
  const reportLimiter = new ReportLimiter(options.now ?? Date.now);
  const forwardReport = options.forwardReport ?? forwardReportToPrimary;
  let reportFailures = 0;
  let reportNextAt = 0;
  let reportsDraining = false;
  async function drainReportQueue(): Promise<void> {
    if (stopped || reportsDraining || Date.now() < reportNextAt) return;
    reportsDraining = true;
    try {
      const result = await drainReports(reportQueue, forwardReport, (options.now ?? Date.now)());
      if (result.delivered) debug.log('hooks.reports', 'forwarded', { delivered: result.delivered });
      if (result.failed) {
        reportFailures++;
        reportNextAt = Date.now() + Math.min(300_000, Math.max(1, options.retryBaseMs ?? 1000) * 2 ** Math.min(reportFailures - 1, 20));
        debug.log('hooks.reports', 'forward-failed', { queued: reportQueue.count(), failures: reportFailures });
      } else reportFailures = 0;
    } finally { reportsDraining = false; }
  }
  const now = options.now ?? Date.now;
  const events = options.events ?? getUserConfig().events ?? parseEventsConfig(undefined);
  // L14: public-repository intake events take the shadow ledger path; every other event keeps the seat dispatch path.
  const dispatch = options.forward ?? ((event: QueuedHook) => dispatchHook(event, options.root ?? effectiveInstanceRoot(), events, options.wakeSeat).then(() => 204));
  const forward = (event: QueuedHook) => event.provider === 'github' && event.task.github
    ? recordGithubShadow(event, options.root ?? effectiveInstanceRoot(), options.githubFetch).then(() => 204)
    : dispatch(event);
  const attempts = new Map<string, { next: number; failures: number }>();
  const pending = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining = false;
  async function drain(): Promise<void> {
    if (stopped || draining) return;
    draining = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    try {
      for (const event of queue.entries()) {
        const key = `${event.provider}:${event.eventId}`;
        if (pending.has(key) || (attempts.get(key)?.next ?? 0) > Date.now()) continue;
        pending.add(key);
        void (async () => {
          try {
            const result = await forward(event);
            if (typeof result === 'number' ? result < 200 || result >= 300 : !result.ok)
              throw new Error('forward failed');
            queue.delivered(event, now());
            attempts.delete(key);
          } catch {
            const base = Math.max(1, options.retryBaseMs ?? 1000);
            const failures = (attempts.get(key)?.failures ?? 0) + 1;
            attempts.set(key, { next: Date.now() + Math.min(300_000, base * 2 ** Math.min(failures - 1, 20)), failures });
          } finally { pending.delete(key); }
        })();
      }
    } finally {
      void drainReportQueue();
      draining = false;
      if (!stopped) timer = setTimeout(() => { void drain(); }, Math.min(1000, options.retryBaseMs ?? 1000));
    }
  }
  const server = Bun.serve({ hostname: options.host ?? '127.0.0.1', port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/hooks/health')
        return Response.json({ ok: true, queued: queue.count(), reportsQueued: reportQueue.count() });
      if (request.method === 'POST' && url.pathname === '/v1/reports')
        return handleReportPost(request, { limiter: reportLimiter, queue: reportQueue, ...(options.now ? { now: options.now } : {}),
          log: (event, data) => debug.log('hooks.reports', event, data), wake: () => { reportNextAt = 0; void drainReportQueue(); } });
      if (request.method !== 'POST' || !/^\/hooks\/(linear|asana|github)$/.test(url.pathname)) return new Response('Not Found', { status: 404 });
      const provider = url.pathname.slice('/hooks/'.length) as HookProvider;
      const reject = (reason: string) => {
        debug.log('hooks.receiver', 'rejected', { provider, reason });
        return new Response('Unauthorized', { status: 401 });
      };
      try {
        if (provider === 'asana' && request.headers.has('x-hook-secret')) {
          const secret = request.headers.get('x-hook-secret')!;
          if (!secret || /[\r\n]/.test(secret) || (options.secrets.asana && options.secrets.asana !== secret) ||
              (!options.secrets.asana && !options.secrets.saveAsana)) return reject('invalid-handshake');
          if (!options.secrets.asana) {
            await options.secrets.saveAsana!(secret);
            options.secrets.asana = secret;
          }
          return new Response(null, { status: 200, headers: { 'X-Hook-Secret': secret } });
        }
        const secret = options.secrets[provider];
        if (!secret) return reject('missing-secret');
        const raw = Buffer.from(await request.arrayBuffer());
        const verified = verifyWebhook(provider, raw, request.headers, secret, now());
        if (!verified.ok) return reject(verified.reason);
        if (verified.ignored !== undefined) {
          debug.log('hooks.receiver', 'ignored', { provider, kind: verified.ignored });
          return new Response(null, { status: 200 });
        }
        if (provider === 'linear' || provider === 'github') {
          const eventId = verified.eventIds[0]!;
          const body = verified.body as { type?: string; action: string; githubEvent?: string };
          const kind = provider === 'linear' ? `${body.type}:${body.action}` : `${body.githubEvent}:${body.action}`;
          queue.enqueue({ provider, eventId, kind, task: toExternalTask(provider, { ...body, eventId }) });
        } else {
          const body = verified.body as { events: unknown[] };
          const tasks = body.events.map(event => ({ event: event as { action?: string }, task: toExternalTask(provider, { event, task: (event as { task?: unknown }).task }) }));
          for (const { event, task } of tasks) queue.enqueue({ provider, eventId: task.eventId, kind: `task:${event.action ?? 'unknown'}`, task });
        }
        if (!draining) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { void drain(); }, 0);
        }
        return new Response(null, { status: 200 });
      } catch {
        return new Response('Service Unavailable', { status: 503 });
      }
    },
  });
  void drain();
  return { url: server.url.toString(), queue, stop() { stopped = true; if (timer) clearTimeout(timer); server.stop(); } };
}
