import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstRunEnvironment, isNexusFirstRunPass, verifyNexusFirstRun } from './nexus-first-run.js';

// A real child and loopback server are required to prove own-PID shutdown. No product daemon,
// external provider, operator HOME/config, or installed current prefix is used by this fixture.
async function probe(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'a158-fixture-'));
  const binary = join(root, 'elanous');
  writeFileSync(binary, `#!${process.execPath}
import { createServer } from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
if (process.argv.includes('--version')) { console.log('0.3.25 261121_0855 ${'a'.repeat(40)}'); process.exit(0); }
const state = process.argv.find(a => a.startsWith('--test=')).slice(7);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
mkdirSync(state + '/nexus', { recursive: true });
if (process.env.ELANOUS_NEXUS_NO_AUTH || process.env.AWS_SECRET_ACCESS_KEY || process.env.OPENAI_API_KEY)
  process.exit(7);
if (mode === 'exit') process.exit(2);
const server = createServer((req, res) => {
  if (req.url === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: mode !== 'bad-ok', testUniverse: mode !== 'prod',
      universeRoot: mode === 'foreign-root' ? '/operator/state' : realpathSync(state + '/nexus') }));
  } else { res.writeHead(mode === 'app404' ? 404 : 200); res.end('app'); }
}).listen(port, '127.0.0.1');
process.on('SIGINT', () => { if (mode !== 'stubborn') server.close(() => process.exit(mode === 'bad-stop' ? 3 : 0)); });
`);
  chmodSync(binary, 0o700);
  const priorTmp = process.env.TMPDIR;
  if (mode === 'temp-alias') {
    mkdirSync(join(root, 'real-temp'));
    symlinkSync(join(root, 'real-temp'), join(root, 'alias-temp'));
    process.env.TMPDIR = join(root, 'alias-temp');
  }
  try { return await verifyNexusFirstRun(binary, '0.3.25', 'a'.repeat(40), { bootMs: 600, stopMs: 150 }); }
  finally {
    if (priorTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmp;
    rmSync(root, { recursive: true, force: true });
  }
}

test('empty environment never inherits production secrets, config, runtime hooks or no-auth', () => {
  const env = firstRunEnvironment('/isolated/home', '/usr/bin');
  expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'NODE_ENV', 'NO_COLOR', 'PATH', 'SHELL', 'TERM', 'TMPDIR']);
  expect(env.HOME).toBe('/isolated/home');
  expect(env.ELANOUS_STATE_DIR).toBeUndefined();
  expect(env.ELANOUS_NEXUS_NO_AUTH).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
});

test('installed first startup requires health and app 200, exact test root and own PID exit', async () => {
  const receipt = await probe('ok');
  expect(receipt.ok).toBe(true);
  expect(receipt.healthOk).toBe(true);
  expect(receipt.app).toBe(200);
  expect(Number.isSafeInteger(receipt.pid)).toBe(true);
  expect(receipt.ownPidStopped).toBe(true);
  expect(receipt.forcedKill).toBe(false);
});

for (const mode of ['app404', 'bad-ok', 'prod', 'foreign-root', 'exit']) {
  test(`first startup rejects ${mode} and still cleans up only its child`, async () => {
    const receipt = await probe(mode);
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toBeDefined();
    expect(receipt.ownPidStopped).toBe(true);
  });
}

test('a daemon requiring SIGKILL is cleaned up but cannot pass', async () => {
  const receipt = await probe('stubborn');
  expect(receipt.ok).toBe(false);
  expect(receipt.forcedKill).toBe(true);
  expect(receipt.ownPidStopped).toBe(true);
});

test('own PID absence cannot hide a failing Nexus shutdown', async () => {
  const receipt = await probe('bad-stop');
  expect(receipt.ok).toBe(false);
  expect(receipt.ownPidStopped).toBe(true);
  expect(receipt.forcedKill).toBe(false);
  expect(receipt.exitCode).toBe(3);
});

test('a symlinked temporary directory still uses the canonical private test root', async () => {
  const receipt = await probe('temp-alias');
  expect(receipt.ok).toBe(true);
  expect(receipt.testUniverse).toBe(true);
  expect(receipt.ownPidStopped).toBe(true);
});

test('receipt validation requires exit zero even when ok and own PID flags claim success', () => {
  const receipt = { ok: true, versionLine: `0.3.25 ${'a'.repeat(40)}`, health: 200, healthOk: true,
    app: 200, testUniverse: true, pid: 12345, ownPidStopped: true, forcedKill: false, exitCode: 0 };
  expect(isNexusFirstRunPass(receipt)).toBe(true);
  for (const exitCode of [3, null, undefined])
    expect(isNexusFirstRunPass({ ...receipt, exitCode })).toBe(false);
});
