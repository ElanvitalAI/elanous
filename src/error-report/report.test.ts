import { afterEach, expect, jest, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildErrorReport, captureFatal, ERROR_REPORT_URL, flushCrashQueue, hash12, installId, reportError, retryPendingErrorReport, scrubText, stripStackPaths, type ErrorReportDeps } from './report.js';

const dirs: string[] = [];
let fakeTimersActive = false;
afterEach(() => {
  if (fakeTimersActive) { jest.clearAllTimers(); jest.useRealTimers(); fakeTimersActive = false; }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'er1-')); dirs.push(d); return d; };

function deps(over: Partial<ErrorReportDeps> & { calls?: Array<{ url: string; body: Record<string, unknown> }> } = {}): ErrorReportDeps {
  const calls = over.calls ?? [];
  let t = 1_000_000;
  return {
    configDir: () => over.configDir?.() ?? dir(),
    settings: () => ({ enabled: true, identity: false, consented: true }),
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

test('before first-run notice new and previously queued reports never reach hooks; after notice the queued report can retry', async () => {
  const d = dir();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let shown = false;
  let now = 1_000_000;
  const ds = deps({ calls, configDir: () => d, now: () => now,
    settings: () => ({ enabled: true, identity: false, consented: shown }),
    nexusMeta: async () => { throw Error('no network metadata before notice'); },
  });
  expect(await reportError({ code: 'pre-notice', message: 'offline', surface: 'cli' }, ds))
    .toEqual({ sent: false, reason: 'awaiting-notice' });
  const pending = join(d, 'error-reports', 'pending.json');
  expect(existsSync(pending)).toBe(true);
  expect(JSON.parse(readFileSync(pending, 'utf8')).report.code).toBe('pre-notice');
  now += 24 * 60 * 60_000 + 1;
  expect(await retryPendingErrorReport(ds)).toEqual({ sent: false, reason: 'awaiting-notice' });
  expect(calls).toHaveLength(0);
  shown = true;
  expect(await retryPendingErrorReport(ds)).toEqual({ sent: true, reportId: 'er_TEST' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(ERROR_REPORT_URL);
  expect(existsSync(pending)).toBe(false);
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

test('FATAL-REPORT-AUTO: crash records flush once through ER1 with secrets scrubbed; no consent never sends', async () => {
  const d = dir();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const ds = deps({ calls, configDir: () => d });
  captureFatal(new Error('fatal token=testing-secret-123456'), { surface: 'cli', ...ds });
  const localRecords = readdirSync(join(d, 'crash'));
  expect(localRecords).toHaveLength(1);
  expect(readFileSync(join(d, 'crash', localRecords[0]!), 'utf8')).not.toContain('testing-secret-123456');
  const [firstFlush, concurrentFlush] = await Promise.all([flushCrashQueue(ds), flushCrashQueue(ds)]);
  expect(firstFlush).toMatchObject({ sent: 1, skipped: 0 });
  expect(concurrentFlush).toEqual(firstFlush);
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0]!.body)).not.toContain('testing-secret-123456');
  expect(await flushCrashQueue(ds)).toMatchObject({ sent: 0 });

  const bounded = dir();
  for (let i = 0; i < 22; i++) captureFatal(new Error(`fatal-${i}`), { surface: 'cli', configDir: () => bounded, settings: () => ({ enabled: true, identity: false, consented: true }), enabledByEnvironment: () => true });
  expect(readdirSync(join(bounded, 'crash'))).toHaveLength(20);

  const declined = dir();
  captureFatal(new Error('declined fatal token=declined-secret-123456'), {
    surface: 'cli',
    configDir: () => declined,
    settings: () => ({ enabled: true, identity: false, consented: false }),
    enabledByEnvironment: () => true,
  });
  expect(await flushCrashQueue({ ...ds, configDir: () => declined, settings: () => ({ enabled: true, identity: false, consented: false }) })).toMatchObject({ sent: 0, skipped: 1 });
  expect(calls).toHaveLength(1);
});

test('FATAL-REPORT-AUTO: an actual fatal child exit is delivered once on the next startup', async () => {
  const d = dir();
  writeFileSync(join(d, 'config.json'), JSON.stringify({ errorReports: { enabled: true, noticeShown: true } }), { mode: 0o600 });
  const configUrl = new URL('../elanous-config-dir.ts', import.meta.url).href;
  const reportUrl = new URL('./report.ts', import.meta.url).href;
  const child = `delete process.env.BUN_TEST; process.env.NODE_ENV='production'; const c=await import(${JSON.stringify(configUrl)}); c.setElanousConfigDir(process.env.FATAL_TEST_CONFIG); const r=await import(${JSON.stringify(reportUrl)}); r.installFatalErrorHandlers('cli'); setTimeout(()=>{throw new Error('token=child-secret-123456');},0);`;
  const exited = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', env: { ...process.env, FATAL_TEST_CONFIG: d, NODE_ENV: 'production' } });
  expect(exited.status).toBe(1);
  expect(exited.stderr).toContain('child-secret-123456'); // fatal hook records without suppressing Bun's original diagnostic.
  const files = readdirSync(join(d, 'crash')).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(d, 'crash', files[0]!), 'utf8')).not.toContain('child-secret-123456');

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  expect(await flushCrashQueue(deps({ calls, configDir: () => d }))).toMatchObject({ sent: 1, skipped: 0 });
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0]!.body)).not.toContain('child-secret-123456');
  expect(await flushCrashQueue(deps({ calls, configDir: () => d }))).toMatchObject({ sent: 0 });
  expect(calls).toHaveLength(1);
});

test('FATAL-REPORT-AUTO: the production CLI crash then restart uses its config, notifies once, and honors revoked identity consent', () => {
  const runCliRestart = (configDir: string, sentFile: string) => {
    const binUrl = new URL('../../bin/elanous.mjs', import.meta.url).href;
    const fakeFetchUrl = new URL('../ux-sim/fake-fetch.ts', import.meta.url).href;
    const child = `delete process.env.BUN_TEST; process.env.NODE_ENV='production'; process.env.ELANOUS_FAST_ROUTER='0';
      const fs=await import('node:fs');
      const { createFakeFetchDevice } = await import(${JSON.stringify(fakeFetchUrl)});
      const device = createFakeFetchDevice([{url:'https://hooks.elanous.ai/v1/reports', method:'POST', response: request => {
        fs.writeFileSync(process.env.FATAL_SENT_FILE, String(request.body)); return Response.json({reportId:'er_FAKE'}, {status:202});
      }}]);
      process.argv=[process.execPath, new URL(${JSON.stringify(binUrl)}).pathname, '--config-dir', process.env.FATAL_TEST_CONFIG, '--help']; await import(${JSON.stringify(binUrl)});
      // Startup schedules the pending flush; allow slower remote CI a wider window before restoring fetch.
      for (let i=0; i<500 && !device.calls().some(call => call.status === 202); i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!device.calls().some(call => call.status === 202)) throw new Error('fake error-report route was not reached');`;
    return spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', env: { ...process.env, FATAL_TEST_CONFIG: configDir, FATAL_SENT_FILE: sentFile, NODE_ENV: 'production', BUN_TEST: '' } });
  };

  const consentedDir = dir();
  const configFile = join(consentedDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ errorReports: { enabled: true, noticeShown: true, identity: true, email: 'old@example.com' } }), { mode: 0o600 });
  const binUrl = new URL('../../bin/elanous.mjs', import.meta.url).href;
  const fatalChild = `delete process.env.BUN_TEST; process.env.NODE_ENV='production'; process.env.ELANOUS_FAST_ROUTER='0';
    process.argv=[process.execPath, new URL(${JSON.stringify(binUrl)}).pathname, '--config-dir', process.env.FATAL_TEST_CONFIG, 'where', '--json'];
    await import(${JSON.stringify(binUrl)}); setTimeout(()=>{throw new Error('token=production-child-secret-123456');},250);`;
  const crashed = spawnSync(process.execPath, ['-e', fatalChild], { encoding: 'utf8', env: { ...process.env, FATAL_TEST_CONFIG: consentedDir, NODE_ENV: 'production', BUN_TEST: '' } });
  expect(crashed.status).toBe(1);
  expect(crashed.stderr).toContain('production-child-secret-123456');
  const crashFiles = readdirSync(join(consentedDir, 'crash')).filter((name) => name.endsWith('.json'));
  expect(crashFiles).toHaveLength(1);
  expect(readFileSync(join(consentedDir, 'crash', crashFiles[0]!), 'utf8')).not.toContain('production-child-secret-123456');
  // The report was captured while identity sharing was enabled. Revoke it before next startup.
  writeFileSync(configFile, JSON.stringify({ errorReports: { enabled: true, noticeShown: true, identity: false, email: 'old@example.com' } }), { mode: 0o600 });
  const sentFile = join(consentedDir, 'fake-receiver.json');
  const restarted = runCliRestart(consentedDir, sentFile);
  expect(restarted.status).toBe(0);
  expect(restarted.stderr).toContain('이전 실행의 치명 오류 보고 1건을 전송했습니다.');
  const sent = JSON.parse(readFileSync(sentFile, 'utf8')) as { who: { email?: string }; message: string };
  expect(sent.who.email).toBeUndefined();
  expect(sent.message).toContain('Error:');
  expect(sent.message).not.toContain('production-child-secret-123456');

  const declinedDir = dir();
  writeFileSync(join(declinedDir, 'config.json'), JSON.stringify({ errorReports: { enabled: true, noticeShown: false, identity: false } }), { mode: 0o600 });
  captureFatal(new Error('declined crash'), { surface: 'cli', configDir: () => declinedDir, settings: () => ({ enabled: true, identity: true, consented: true, email: 'private@example.com' }), enabledByEnvironment: () => true });
  const declinedSentFile = join(declinedDir, 'fake-receiver.json');
  const declined = runCliRestart(declinedDir, declinedSentFile);
  expect(declined.status).toBe(0);
  expect(declined.stderr).toContain('동의가 없어 전송하지 않았습니다.');
  expect(existsSync(declinedSentFile)).toBe(false);
}, 60_000);

test('FATAL-REPORT-AUTO: crash spool expires records older than seven days', async () => {
  const d = dir();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const base = 1_800_000_000_000;
  const configDir = () => d;
  const settings = () => ({ enabled: true, identity: false, consented: true });
  captureFatal(new Error('old crash'), { surface: 'cli', configDir, settings, now: () => base, enabledByEnvironment: () => true });
  const result = await flushCrashQueue(deps({ calls, configDir, now: () => base + 8 * 24 * 60 * 60_000 }));
  expect(result).toMatchObject({ sent: 0, skipped: 0 });
  expect(readdirSync(join(d, 'crash'))).toHaveLength(0);

  captureFatal(new Error('fresh crash'), { surface: 'cli', configDir, settings, now: () => base + 8 * 24 * 60 * 60_000, enabledByEnvironment: () => true });
  const freshResult = await flushCrashQueue(deps({ calls, configDir, now: () => base + 8 * 24 * 60 * 60_000 }));
  expect(freshResult).toMatchObject({ sent: 1, skipped: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.message).toContain('fresh crash');
  expect(readdirSync(join(d, 'crash'))).toHaveLength(0);
});

test('FATAL-REPORT-AUTO: a failed crash send retries after connectivity recovers in the same process', async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000 });
  fakeTimersActive = true;
  const d = dir();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let online = false;
  const ds = deps({ configDir: () => d,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return online ? Response.json({ reportId: 'er_RECOVERED' }, { status: 202 }) : new Response('offline', { status: 503 });
    }) as unknown as typeof fetch,
  });
  captureFatal(new Error('temporary offline'), { surface: 'cli', ...ds });
  expect(await flushCrashQueue(ds)).toMatchObject({ sent: 0, skipped: 0 });
  expect(calls).toHaveLength(1);
  online = true;
  jest.advanceTimersByTime(60_000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(calls).toHaveLength(2);
  expect(readdirSync(join(d, 'crash'))).toHaveLength(0);
});

test('first-run notice line names identity fields only when identity reporting is on', async () => {
  const { errorReportNoticeLine } = await import('./report.js');
  expect(errorReportNoticeLine(undefined)).toContain('익명 진단을');
  expect(errorReportNoticeLine({ identity: false, email: 'a@b.c' })).toContain('익명 진단을');
  expect(errorReportNoticeLine({ identity: true, email: 'a@b.c' })).toContain('설정된 신원(이메일)을');
  expect(errorReportNoticeLine({ identity: true, email: 'a@b.c', telegramUser: 'u' })).toContain('설정된 신원(이메일·텔레그램 사용자)을');
  // identity on but no field set: the report carries none, so the notice says anonymous.
  expect(errorReportNoticeLine({ identity: true })).toContain('익명 진단을');
  for (const settings of [{ identity: true }, { identity: true, email: 'a@b.c' }, { identity: false, email: 'a@b.c', telegramUser: 'u' }, { identity: true, email: 'a@b.c', telegramUser: 'u' }]) {
    const report = buildErrorReport({ code: 'c', message: 'm', surface: 'cli' }, { installId: 'i', settings: { enabled: true, ...settings }, nexus: { alive: false }, at: new Date(0).toISOString() }) as unknown as Record<string, unknown>;
    const line = errorReportNoticeLine(settings);
    const sentFields = ['email', 'telegramUser'].filter((field) => JSON.stringify(report).includes(`"${field}"`));
    expect(line.includes('익명 진단을')).toBe(sentFields.length === 0);
    if ('email' in settings) expect(line.includes('이메일')).toBe(sentFields.includes('email'));
    if ('telegramUser' in settings) expect(line.includes('텔레그램 사용자')).toBe(sentFields.includes('telegramUser'));
  }
});
