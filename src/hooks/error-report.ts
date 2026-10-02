// Error reports from users' devices (ER2 · contract v1, channel 10-01 22:16). The public bot VM receives them on
// `POST /v1/reports`, checks size, rate and schema, queues them on disk and forwards them over the tailnet to the
// Primary, which stores them for 30 days and alerts the operator. No S3 credentials live on the VM.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const REPORT_MAX_BYTES = 64 * 1024;
/** Queue bounds while the Primary is unreachable: oldest reports beyond these are dropped (logged). */
export const REPORT_QUEUE_MAX = 5000;
export const REPORT_QUEUE_MAX_AGE_MS = 7 * 24 * 3600_000;

const SURFACES = ['tui', 'pwa', 'cli', 'daemon'] as const;
export interface ErrorReport {
  kind: 'error-report';
  v: 1;
  code: string;
  message: string;
  stack?: string;
  app: { version: string; sha: string; surface: (typeof SURFACES)[number]; os: string; arch: string };
  nexus: { alive: boolean; version?: string; instance?: string };
  who: { installId: string; email?: string; telegramUser?: string };
  at: string;
  consent: true;
}
/** What the VM forwards: the report plus what the receiver derived. */
export interface ReceivedReport { reportId: string; dedupe: string; receivedAt: string; report: ErrorReport }

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** Strict schema: unknown fields are dropped, a bad required field names itself. */
export function validateErrorReport(body: unknown): { ok: true; report: ErrorReport } | { ok: false; field: string } {
  const b = obj(body);
  if (!b) return { ok: false, field: 'body' };
  if (b.kind !== 'error-report') return { ok: false, field: 'kind' };
  if (b.v !== 1) return { ok: false, field: 'v' };
  if (b.consent !== true) return { ok: false, field: 'consent' };
  const code = typeof b.code === 'string' && /^[a-z0-9-]{1,64}$/.test(b.code) ? b.code : undefined;
  if (!code) return { ok: false, field: 'code' };
  const message = str(b.message, 2000);
  if (!message) return { ok: false, field: 'message' };
  if (b.stack !== undefined && !str(b.stack, 8000)) return { ok: false, field: 'stack' };
  const app = obj(b.app);
  const version = str(app?.version, 64);
  const sha = str(app?.sha, 64);
  const surface = SURFACES.find((s) => s === app?.surface);
  const os = str(app?.os, 64);
  const arch = str(app?.arch, 32);
  if (!version || !sha || !surface || !os || !arch) return { ok: false, field: 'app' };
  const nexus = obj(b.nexus);
  if (!nexus || typeof nexus.alive !== 'boolean') return { ok: false, field: 'nexus' };
  const who = obj(b.who);
  const installId = typeof who?.installId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who.installId) ? who.installId : undefined;
  if (!installId) return { ok: false, field: 'who.installId' };
  const at = typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) ? b.at : undefined;
  if (!at) return { ok: false, field: 'at' };
  // nexus.instance is accepted only as a hash — a raw instance name can carry a host name.
  const instance = typeof nexus.instance === 'string' && /^[0-9a-f]{12,64}$/.test(nexus.instance) ? nexus.instance : undefined;
  const email = str(who?.email, 254);
  const telegramUser = str(who?.telegramUser, 64);
  return {
    ok: true,
    report: {
      kind: 'error-report', v: 1, code, message, ...(typeof b.stack === 'string' ? { stack: b.stack } : {}),
      app: { version, sha, surface, os, arch },
      nexus: { alive: nexus.alive, ...(str(nexus.version, 64) ? { version: nexus.version as string } : {}), ...(instance ? { instance } : {}) },
      who: { installId, ...(email ? { email } : {}), ...(telegramUser ? { telegramUser } : {}) },
      at, consent: true,
    },
  };
}

/** Same error = same code and same first stack frame. Computed by the receiver, never sent by the device. */
export function reportDedupe(report: Pick<ErrorReport, 'code' | 'stack'>): string {
  const frame = (report.stack ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0 && l !== report.code) ?? '';
  return createHash('sha256').update(`${report.code}\n${frame}`).digest('hex').slice(0, 12);
}

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';
/** `er_` + 26 chars: 10 time chars then 16 random — sortable by receipt time. */
export function newReportId(now: number = Date.now()): string {
  let t = '';
  let n = now;
  for (let i = 0; i < 10; i++) { t = B32[n % 32]! + t; n = Math.floor(n / 32); }
  const r = [...randomBytes(16)].map((x) => B32[x % 32]).join('');
  return `er_${t}${r}`;
}

/** In-memory sliding windows: per install 5/min and 20/day, per IP 60/hour; same (install, dedupe) stored once an hour. */
export class ReportLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly stored = new Map<string, number>();
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  private take(key: string, windowMs: number, max: number): number | null {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) { this.hits.set(key, list); return Math.ceil((windowMs - (t - list[0]!)) / 1000); }
    list.push(t);
    this.hits.set(key, list);
    return null;
  }

  /** Returns seconds to wait when limited, otherwise null (and records the hit). */
  admit(installId: string, ip: string): number | null {
    return this.take(`ip:${ip}`, 3600_000, 60)
      ?? this.take(`im:${installId}`, 60_000, 5)
      ?? this.take(`id:${installId}`, 24 * 3600_000, 20);
  }

  /** Counts this occurrence; true when it should be stored (first of this install+dedupe within an hour). */
  occurrence(installId: string, dedupe: string): { store: boolean; count24h: number } {
    const t = this.now();
    const list = (this.seen.get(dedupe) ?? []).filter((x) => t - x < 24 * 3600_000);
    list.push(t);
    this.seen.set(dedupe, list);
    const key = `${installId}:${dedupe}`;
    const last = this.stored.get(key);
    const store = last === undefined || t - last >= 3600_000;
    if (store) this.stored.set(key, t);
    return { store, count24h: list.length };
  }
}

/** On-disk queue on the VM: one file per report, atomic writes, bounded by count and age. */
export class ReportQueue {
  readonly directory: string;
  constructor(root: string, private readonly log: (event: string, data: Record<string, unknown>) => void = () => {}) {
    this.directory = join(root, 'hooks', 'reports');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private path(reportId: string): string { return join(this.directory, `${reportId}.json`); }
  enqueue(item: ReceivedReport): void {
    const path = this.path(item.reportId);
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(item)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  }
  /** Oldest first; drops entries past the age or count bound (logged, never silent). */
  entries(now: number = Date.now()): ReceivedReport[] {
    const names = readdirSync(this.directory).filter((n) => /^er_[0-9a-z]{26}\.json$/.test(n)).sort();
    const kept: ReceivedReport[] = [];
    let expired = 0;
    for (const name of names) {
      const full = join(this.directory, name);
      try {
        const item = JSON.parse(readFileSync(full, 'utf8')) as ReceivedReport;
        if (now - Date.parse(item.receivedAt) > REPORT_QUEUE_MAX_AGE_MS) { rmSync(full, { force: true }); expired++; continue; }
        kept.push(item);
      } catch { rmSync(full, { force: true }); }
    }
    const overflow = kept.length - REPORT_QUEUE_MAX;
    if (overflow > 0) for (const item of kept.splice(0, overflow)) rmSync(this.path(item.reportId), { force: true });
    if (expired || overflow > 0) this.log('dropped', { expired, overflow: Math.max(0, overflow) });
    return kept;
  }
  count(): number { return readdirSync(this.directory).filter((n) => /^er_[0-9a-z]{26}\.json$/.test(n)).length; }
  delivered(reportId: string): void { rmSync(this.path(reportId), { force: true }); }
}

/** Handles `POST /v1/reports` on the VM. Pure enough to test without a server. */
export async function handleReportPost(request: Request, deps: {
  limiter: ReportLimiter; queue: ReportQueue; now?: () => number; ip?: string;
  log?: (event: string, data: Record<string, unknown>) => void; wake?: () => void;
}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > REPORT_MAX_BYTES) { log('rejected', { reason: 'too-large' }); return Response.json({ error: 'too-large' }, { status: 413 }); }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > REPORT_MAX_BYTES) { log('rejected', { reason: 'too-large' }); return Response.json({ error: 'too-large' }, { status: 413 }); }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return Response.json({ error: 'invalid', field: 'body' }, { status: 400 }); }
  const checked = validateErrorReport(body);
  if (!checked.ok) { log('rejected', { reason: 'invalid', field: checked.field }); return Response.json({ error: 'invalid', field: checked.field }, { status: 400 }); }
  const report = checked.report;
  const ip = deps.ip ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const wait = deps.limiter.admit(report.who.installId, ip);
  if (wait !== null) {
    log('rejected', { reason: 'rate-limited' });
    return Response.json({ error: 'rate-limited', retryAfterSec: wait }, { status: 429, headers: { 'Retry-After': String(wait) } });
  }
  const dedupe = reportDedupe(report);
  const reportId = newReportId(now());
  const { store, count24h } = deps.limiter.occurrence(report.who.installId, dedupe);
  if (store) {
    deps.queue.enqueue({ reportId, dedupe, receivedAt: new Date(now()).toISOString(), report });
    deps.wake?.();
  }
  log('accepted', { code: report.code, surface: report.app.surface, stored: store, count24h });
  return Response.json({ reportId, dedupe, count: count24h }, { status: 202 });
}

/** Forward queued reports to the Primary; delivered ones leave the queue, failures wait for the next drain. */
export async function drainReports(queue: ReportQueue, forward: (item: ReceivedReport) => Promise<boolean>, now: number = Date.now()): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  for (const item of queue.entries(now)) {
    let ok = false;
    try { ok = await forward(item); } catch { ok = false; }
    if (ok) { queue.delivered(item.reportId); delivered++; } else { failed++; break; }
  }
  return { delivered, failed };
}

