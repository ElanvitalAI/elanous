import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleReportPost, newReportId, REPORT_MAX_BYTES, REPORT_QUEUE_MAX_AGE_MS, ReportLimiter, ReportQueue, reportDedupe, validateErrorReport } from './error-report.js';
import { startHookReceiver } from './receiver.js';

const roots: string[] = [];
const tmp = () => { const r = mkdtempSync(join(tmpdir(), 'er2-')); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
function report(extra: Record<string, unknown> = {}) {
  return {
    kind: 'error-report', v: 1, code: 'skill-index', message: 'description.trim is not a function',
    stack: 'TypeError: description.trim is not a function\n    at indexSkill (skills/index.ts:42:7)\n    at load (skills/load.ts:9:3)',
    app: { version: '0.2.7', sha: 'eadd7c31', surface: 'tui', os: 'darwin', arch: 'arm64' },
    nexus: { alive: true, version: '0.2.7', instance: 'a1b2c3d4e5f6' },
    who: { installId: INSTALL }, at: '2026-10-01T14:00:00Z', consent: true, ...extra,
  };
}
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://x/v1/reports', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('validateErrorReport', () => {
  test('accepts the contract, drops unknown fields, keeps identity only when given', () => {
    const r = validateErrorReport({ ...report(), extra: 'x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('extra' in r.report).toBe(false);
    expect(r.report.who).toEqual({ installId: INSTALL });
    expect(validateErrorReport(report({ who: { installId: INSTALL, email: 'a@b.c' } }))).toMatchObject({ ok: true, report: { who: { email: 'a@b.c' } } });
  });
  test('refuses no consent, a non-UUID install id, a bad code and an oversized message — and names the field', () => {
    expect(validateErrorReport(report({ consent: false }))).toEqual({ ok: false, field: 'consent' });
    expect(validateErrorReport(report({ who: { installId: 'user-mbp' } }))).toEqual({ ok: false, field: 'who.installId' });
    expect(validateErrorReport(report({ code: 'Skill Index!' }))).toEqual({ ok: false, field: 'code' });
    expect(validateErrorReport(report({ message: 'x'.repeat(2001) }))).toEqual({ ok: false, field: 'message' });
  });
  test('a raw instance name (it can carry a host name) is dropped; only a hash is kept', () => {
    const r = validateErrorReport(report({ nexus: { alive: true, instance: 'MacBookProM5' } }));
    expect(r.ok && r.report.nexus).toEqual({ alive: true });
  });
});

describe('POST /v1/reports handler', () => {
  test('202 with reportId, dedupe and count; same error from the same install is stored once an hour but counted', async () => {
    const queue = new ReportQueue(tmp());
    const limiter = new ReportLimiter(() => 1_000_000);
    const first = await handleReportPost(post(report()), { limiter, queue, now: () => 1_000_000, ip: '1.2.3.4' });
    expect(first.status).toBe(202);
    const body = await first.json() as { reportId: string; dedupe: string; count: number };
    expect(body.reportId).toMatch(/^er_[0-9a-z]{26}$/);
    expect(body.dedupe).toBe(reportDedupe(report()));
    expect(body.count).toBe(1);
    const second = await (await handleReportPost(post(report()), { limiter, queue, now: () => 1_000_000, ip: '1.2.3.4' })).json() as { count: number };
    expect(second.count).toBe(2);
    expect(queue.count()).toBe(1);
  });
  test('413 above 64 KiB · 400 on bad JSON or no consent · 429 with Retry-After on the 6th report in a minute', async () => {
    const queue = new ReportQueue(tmp());
    const limiter = new ReportLimiter(() => 5_000_000);
    const deps = { limiter, queue, now: () => 5_000_000, ip: '5.6.7.8' };
    expect((await handleReportPost(post('x'.repeat(REPORT_MAX_BYTES + 1)), deps)).status).toBe(413);
    expect(await (await handleReportPost(post('{oops'), deps)).json()).toEqual({ error: 'invalid', field: 'body' });
    expect(await (await handleReportPost(post(report({ consent: false })), deps)).json()).toEqual({ error: 'invalid', field: 'consent' });
    for (let i = 0; i < 5; i++) expect((await handleReportPost(post(report({ code: `c${i}` })), deps)).status).toBe(202);
    const limited = await handleReportPost(post(report({ code: 'c9' })), deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('ReportQueue bounds (Primary unreachable)', () => {
  test('reports older than the age bound are dropped and the drop is logged', () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const queue = new ReportQueue(tmp(), (e, d) => logs.push([e, d]));
    const now = Date.parse('2026-10-10T00:00:00Z');
    const checked = validateErrorReport(report());
    if (!checked.ok) throw new Error('fixture invalid');
    const old = { reportId: newReportId(now - REPORT_QUEUE_MAX_AGE_MS - 1000), dedupe: 'aaaaaaaaaaaa', receivedAt: new Date(now - REPORT_QUEUE_MAX_AGE_MS - 1000).toISOString(), report: checked.report };
    const fresh = { ...old, reportId: newReportId(now), receivedAt: new Date(now).toISOString() };
    queue.enqueue(old);
    queue.enqueue(fresh);
    expect(queue.entries(now).map((e) => e.reportId)).toEqual([fresh.reportId]);
    expect(logs).toEqual([['dropped', { expired: 1, overflow: 0 }]]);
  });
});

describe('real receiver', () => {
  test('POST /v1/reports is forwarded; a failed forward stays queued and is retried', async () => {
    const root = tmp();
    const forwarded: string[] = [];
    let up = false;
    const server = startHookReceiver({ port: 0, secrets: {}, root, retryBaseMs: 1,
      forward: async () => 200,
      forwardReport: async (item) => { if (!up) return false; forwarded.push(item.report.code); return true; } });
    try {
      const res = await fetch(new URL('/v1/reports', server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report()) });
      expect(res.status).toBe(202);
      await Bun.sleep(50);
      expect(forwarded).toEqual([]);
      expect(readdirSync(join(root, 'hooks', 'reports')).length).toBe(1);
      up = true;
      for (let i = 0; i < 100 && forwarded.length === 0; i++) await Bun.sleep(20);
      expect(forwarded).toEqual(['skill-index']);
      expect(readdirSync(join(root, 'hooks', 'reports')).length).toBe(0);
      const health = await (await fetch(new URL('/hooks/health', server.url))).json() as { reportsQueued: number };
      expect(health.reportsQueued).toBe(0);
    } finally { server.stop(); }
  });
});

