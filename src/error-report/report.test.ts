import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildErrorReport, ERROR_REPORT_URL, hash12, installId, reportError, retryPendingErrorReport, scrubText, stripStackPaths, type ErrorReportDeps } from './report.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'er1-')); dirs.push(d); return d; };

function deps(over: Partial<ErrorReportDeps> & { calls?: Array<{ url: string; body: Record<string, unknown> }> } = {}): ErrorReportDeps {
  const calls = over.calls ?? [];
  let t = 1_000_000;
  return {
    configDir: () => over.configDir?.() ?? dir(),
    settings: () => ({ enabled: true, identity: false }),
    nexusMeta: async () => ({ alive: true, version: '0.2.8', instance: hash12('/x') }),
    enabledByEnvironment: () => true,
    now: () => (t += 1),
    fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ reportId: 'er_TEST', dedupe: 'abc', count: 1 }, { status: 202 }); }) as unknown as typeof fetch,
    ...over,
  };
}

test('secrets, tokens, emails and the home directory are gone before anything leaves', () => {
  const home = '/Users/someone';
  const raw = `boom at /Users/someone/.elanous/skills/x/SKILL.md token=abcdef123456 elt_ABCDEFGHIJKLMNOP sk-proj-abcdefghijklmnop me@example.com 123456789:AAEhBP0av28aa8fakefakefakefakefake12`;
  const out = scrubText(raw, home);
  expect(out).not.toContain('someone');
  expect(out).not.toContain('abcdef123456');
  expect(out).not.toContain('elt_ABCDEFGHIJKLMNOP');
  expect(out).not.toContain('sk-proj-abcdefghijklmnop');
  expect(out).not.toContain('me@example.com');
  expect(out).not.toContain('AAEhBP0av28');
  expect(out).toContain('~/.elanous/skills/x/SKILL.md');
  expect(stripStackPaths('Error: x\n    at f (/Users/a/src/skills/index.ts:480:9)\n    at /opt/app/run.js:3:1')).toBe('Error: x\n    at f (index.ts:480:9)\n    at (run.js:3:1)');
});

test('the report follows contract v1: consent, install id, hashed instance, no identity unless asked', () => {
  const r = buildErrorReport({ code: 'Skill Index!', message: 'm', stack: 'Error\n at (/a/b.ts:1:2)', surface: 'tui' },
    { installId: '11111111-2222-3333-4444-555555555555', settings: { enabled: true, identity: false, email: 'me@x.io' }, nexus: { alive: false, instance: 'abcdef012345' }, at: '2026-10-01T00:00:00.000Z' });
  expect(r).toMatchObject({ kind: 'error-report', v: 1, code: 'skill-index-', consent: true, who: { installId: '11111111-2222-3333-4444-555555555555' } });
  expect(r.who.email).toBeUndefined();
  expect(r.app.surface).toBe('tui');
  expect(r.stack).toBe('Error\n at (b.ts:1:2)');
  const withId = buildErrorReport({ code: 'x', message: 'm', surface: 'cli' }, { installId: 'i', settings: { enabled: true, identity: true, email: 'me@x.io' }, nexus: { alive: true }, at: 'now' });
  expect(withId.who.email).toBe('me@x.io');
  const big = buildErrorReport({ code: 'x', message: 'm'.repeat(5_000), stack: 's'.repeat(20_000), surface: 'cli' }, { installId: 'i', settings: { enabled: true, identity: false }, nexus: { alive: true }, at: 'now' });
  expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(64 * 1024);
  expect(big.message.length).toBeLessThanOrEqual(2_000);
});

test('install id is random once per config dir and reused after', () => {
  const d = dir();
  const a = installId(d);
  expect(a).toMatch(/^[0-9a-f-]{36}$/);
  expect(installId(d)).toBe(a);
  expect(installId(dir())).not.toBe(a);
});

test('reportError posts to the contract URL, returns the report id, and does not repeat the same error within the hour', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const d = dir();
  const ds = deps({ calls, configDir: () => d });
  expect(await reportError({ code: 'skill-index', message: 'same', surface: 'tui' }, ds)).toEqual({ sent: true, reportId: 'er_TEST' });
  expect(await reportError({ code: 'skill-index', message: 'same', surface: 'tui' }, ds)).toEqual({ sent: false, reason: 'recently-sent' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(ERROR_REPORT_URL);
  expect(calls[0]!.body.consent).toBe(true);
});

test('off switch, tests and the test universe never reach the network', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  expect(await reportError({ code: 'a', message: 'off', surface: 'cli' }, deps({ calls, settings: () => ({ enabled: false, identity: false }) }))).toEqual({ sent: false, reason: 'disabled' });
  expect(await reportError({ code: 'a', message: 'env', surface: 'cli' }, deps({ calls, enabledByEnvironment: () => false }))).toEqual({ sent: false, reason: 'environment' });
  expect(await reportError({ code: 'a', message: 'default-env', surface: 'cli' }, { ...deps({ calls }), enabledByEnvironment: undefined })).toEqual({ sent: false, reason: 'environment' });
  expect(calls).toHaveLength(0);
});

test('a failed send keeps exactly one copy and retries it at most once a day, then clears it', async () => {
  const d = dir();
  let now = 5_000_000;
  let up = false;
  const ds = deps({
    configDir: () => d, now: () => now,
    fetchImpl: (async () => (up ? Response.json({ reportId: 'er_LATER' }, { status: 202 }) : new Response('nope', { status: 404 }))) as unknown as typeof fetch,
  });
  expect(await reportError({ code: 'b', message: 'down', surface: 'cli' }, ds)).toEqual({ sent: false, reason: 'http-404' });
  const pending = join(d, 'error-reports', 'pending.json');
  expect(existsSync(pending)).toBe(true);
  expect(JSON.parse(readFileSync(pending, 'utf8')).report.code).toBe('b');
  up = true;
  expect(await retryPendingErrorReport(ds)).toEqual({ sent: false, reason: 'too-soon' });
  now += 24 * 60 * 60_000 + 1;
  expect(await retryPendingErrorReport(ds)).toEqual({ sent: true, reportId: 'er_LATER' });
  expect(existsSync(pending)).toBe(false);
});
