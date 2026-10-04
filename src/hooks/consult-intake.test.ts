import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSULT_MAX_BYTES, CONSULT_QUEUE_MAX_AGE_MS, ConsultLimiter, ConsultQueue, drainConsults, handleConsultPost, validateConsult } from './consult-intake.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'consult-hook-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const valid = { name: ' Visitor ', org: ' Work ', kind: 'company', interest: 'A', contact: ' 555-0100 ', consent: true };
const request = (body: unknown) => new Request('http://localhost/v1/consult', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

test('schema preserves the Primary field names, normalizes safe lines, drops extras and rejects invalid fields', () => {
  expect(validateConsult({ ...valid, extra: 'discard', name: ' A\nB ' })).toEqual({ ok: true, consult: {
    name: 'A B', org: 'Work', kind: 'company', interest: 'A', contact: '555-0100', consent: true,
  } });
  expect(validateConsult({ ...valid, org: undefined, kind: 'personal' })).toMatchObject({ ok: true, consult: { kind: 'personal' } });
  for (const [field, value] of [['name', ' '], ['org', ' '], ['kind', 'invalid'], ['interest', 'C'], ['contact', ' '], ['consent', false],
    ['name', 'x'.repeat(257)], ['org', 'x'.repeat(257)], ['contact', 'x'.repeat(513)]] as const) {
    expect(validateConsult({ ...valid, [field]: value })).toEqual({ ok: false, field });
  }
});

test('POST limits body to 8 KiB, IP to three/10m and global to 200/day, without exposing submitted values', async () => {
  const queue = new ConsultQueue(root());
  let clock = 1_700_000_000_000;
  const limiter = new ConsultLimiter(() => clock);
  const logs: unknown[] = [];
  const deps = { queue, limiter, now: () => clock, ip: '1.2.3.4', log: (event: string, data: Record<string, unknown>) => logs.push({ event, data }) };
  expect((await handleConsultPost(request({ ...valid, consent: false }), deps)).status).toBe(400);
  expect((await handleConsultPost(request('{broken'), deps)).status).toBe(400);
  expect((await handleConsultPost(request({ ...valid, padding: 'x'.repeat(CONSULT_MAX_BYTES) }), deps)).status).toBe(413);
  for (let i = 0; i < 3; i++) expect((await handleConsultPost(request(valid), deps)).status).toBe(202);
  const fourth = await handleConsultPost(request(valid), deps);
  expect(fourth.status).toBe(429);
  expect(fourth.headers.get('Retry-After')).toBe('600');
  expect(queue.count()).toBe(3);
  expect(statSync(queue.path).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(logs)).not.toContain('Visitor');
  expect(JSON.stringify(logs)).not.toContain('555-0100');
  expect(JSON.stringify(logs)).not.toContain('Work');
  const spoofed = await handleConsultPost(new Request('http://localhost/v1/consult', { method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.8' }, body: JSON.stringify(valid) }), deps);
  expect(spoofed.status).toBe(429);
  clock += 600_000;
  expect((await handleConsultPost(request(valid), deps)).status).toBe(202);
  const global = new ConsultLimiter(() => clock);
  for (let i = 0; i < 200; i++) expect(global.admit(`ip-${i}`)).toBeNull();
  expect(global.admit('ip-201')).toBe(86_400);
  clock += 86_400_000;
  expect(global.admit('ip-201')).toBeNull();
});

test('streaming intake stops at 8 KiB even with no or false Content-Length', async () => {
  const queue = new ConsultQueue(root());
  const limiter = new ConsultLimiter();
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls > 2) throw new Error('read past size limit');
        controller.enqueue(new Uint8Array(pulls === 1 ? CONSULT_MAX_BYTES : 1));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await handleConsultPost(new Request('http://localhost/v1/consult', {
      method: 'POST', headers, body, duplex: 'half',
    } as RequestInit), { queue, limiter });
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
    expect(queue.count()).toBe(0);
  }
});

test('JSONL queue expires after seven days, retries a failed delivery and removes successful records only', async () => {
  const dir = root();
  const now = 1_700_000_000_000;
  const drops: unknown[] = [];
  const queue = new ConsultQueue(dir, (event, data) => drops.push({ event, data }));
  const consult = validateConsult(valid);
  if (!consult.ok) throw new Error('fixture invalid');
  const old = { id: 'old', receivedAt: new Date(now - CONSULT_QUEUE_MAX_AGE_MS - 1).toISOString(), consult: consult.consult };
  const fresh = { ...old, id: 'fresh', receivedAt: new Date(now).toISOString() };
  queue.enqueue(old);
  queue.enqueue(fresh);
  expect(readFileSync(queue.path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  expect(queue.entries(now)).toEqual([fresh]);
  expect(drops).toEqual([{ event: 'dropped', data: { expired: 1 } }]);
  expect(await drainConsults(queue, async () => false, now)).toEqual({ delivered: 0, failed: 1 });
  expect(queue.count()).toBe(1);
  expect(await drainConsults(queue, async item => item.id === 'fresh', now)).toEqual({ delivered: 1, failed: 0 });
  expect(queue.count()).toBe(0);
});
