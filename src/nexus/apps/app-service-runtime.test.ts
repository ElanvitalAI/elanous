import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealAppSource } from './app-source-seal.js';
import { macAppSandboxProfile, startAppService } from './app-service-runtime.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(port?: number, healthStatus = 200, sourceForRoot?: (root: string) => string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-app-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const sealRoot = join(root, 'seals');
  const runtimeRoot = join(root, 'runtime');
  for (const path of [sourceRoot, sealRoot, runtimeRoot, join(sourceRoot, 'backend')]) mkdirSync(path, { mode: 0o700 });
  const source = sourceForRoot?.(root) ?? `export default { fetch(request: Request) { const url = new URL(request.url); return Response.json({ path: url.pathname, search: url.search, auth: request.headers.get('authorization'), cookie: request.headers.get('cookie') }, { status: url.pathname === '/health' ? ${healthStatus} : 200 }); } };\n`;
  writeFileSync(join(sourceRoot, 'backend/server.ts'), source, { mode: 0o600 });
  writeFileSync(join(sourceRoot, 'ARCHITECTURE.md'), '# fake app\n', { mode: 0o600 });
  const receipt = { schemaVersion: 'source-artifact@1', root: sourceRoot,
    files: { 'backend/server.ts': sha(source), 'ARCHITECTURE.md': sha('# fake app\n') },
    metadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], ...(port === undefined ? {} : { port }), healthPath: '/health' }, apiPrefix: '/api' },
    executed: false, published: false };
  writeFileSync(join(sourceRoot, 'source-artifact.json'), JSON.stringify(receipt), { mode: 0o600 });
  const sealed = await sealAppSource({ sourceRoot, sealRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
  return { root, runtimeRoot, sealed };
}

test('declared port starts a private service, proxies only API, strips credentials, and owns undo', async () => {
  const f = await fixture(31578);
  const service = await startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
  cleanup.push(() => service.stop());
  expect(service.port).toBe(31578);
  const response = await service.proxy(new Request('https://demo--test.elanous.app/api/items?a=1&b=2', { headers: { authorization: 'Bearer fake', cookie: 'secret=fake' } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ path: '/api/items', search: '?a=1&b=2', auth: null, cookie: null });
  expect((await service.proxy(new Request('https://demo--test.elanous.app/v1/members/owner'))).status).toBe(404);
  await service.stop();
  expect((await service.proxy(new Request('https://demo--test.elanous.app/api/items'))).status).toBe(503);
  await expect(fetch(`http://127.0.0.1:${service.port}/health`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
});

test('missing manifest port assigns and records a reserved free port', async () => {
  const f = await fixture();
  const service = await startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
  cleanup.push(() => service.stop());
  // source: #64039 STEP2 reserved loopback port contract.
  expect(service.port).toBeGreaterThanOrEqual(31500);
  // source: #64039 STEP2 reserved loopback port contract.
  expect(service.port).toBeLessThanOrEqual(31599);
  expect(JSON.parse(readFileSync(join(f.runtimeRoot, 'port-' + service.port, 'binding.json'), 'utf8')))
    .toMatchObject({ port: service.port, pid: service.pid, ownerId: 'owner-a', runId: 'run-a' });
  expect((await service.proxy(new Request('https://demo--test.elanous.app/api/items'))).status).toBe(200);
});

test('declared app health failure prevents publication and frees the candidate port', async () => {
  const f = await fixture(31579, 503);
  await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot,
    ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
  expect(readdirSync(f.runtimeRoot)).toEqual([]);
});

test('foreign owner, revoked approval, and port collision reject before a second process', async () => {
  const f = await fixture(31579);
  await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-b', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
  await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => false })).rejects.toThrow('app service refused');
  const service = await startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
  cleanup.push(() => service.stop());
  await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
  expect((await service.proxy(new Request('https://demo--test.elanous.app/api/items'))).status).toBe(200);
});

test('unallowlisted argv and changed receipt refuse service startup', async () => {
  const f = await fixture(31580);
  const malicious = { ...f.sealed, runtime: { ...f.sealed.runtime, startCommand: ['sh', '-c', 'anything'] } };
  await expect(startAppService({ sealed: malicious, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
  const receiptPath = join(f.sealed.sealPath, '.elanous', 'seal.json');
  chmodSync(receiptPath, 0o600);
  writeFileSync(receiptPath, JSON.stringify({ ownerId: 'owner-b', runId: 'run-a', artifactDigest: f.sealed.artifactDigest }));
  await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot, ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
});

test('oversized API body and cancelled request stop before reaching the app', async () => {
  const f = await fixture();
  const service = await startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot,
    ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
  cleanup.push(() => service.stop());
  const oversized = await service.proxy(new Request('https://demo--test.elanous.app/api/items', {
    method: 'POST', body: 'x'.repeat(65 * 1024), headers: { 'content-type': 'text/plain' },
  }));
  expect(oversized.status).toBe(413);
  const abort = new AbortController();
  abort.abort();
  const cancelled = await service.proxy(new Request('https://demo--test.elanous.app/api/items', {
    method: 'POST', body: 'fake', signal: abort.signal,
  }));
  expect(cancelled.status).toBe(503);
  expect((await service.proxy(new Request('https://demo--test.elanous.app/api/items'))).status).toBe(200);
});

test('occupied declared port refuses and removes only its candidate lease', async () => {
  const f = await fixture(31581);
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(31581, '127.0.0.1', resolve));
  try {
    await expect(startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot,
      ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true })).rejects.toThrow('app service refused');
    expect(existsSync(join(f.runtimeRoot, 'port-31581'))).toBe(false);
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

test('sandboxed app cannot read other private files, mutate its seal, signal another PID, or connect out', async () => {
  const victim = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  if (!victim.pid) throw new Error('missing fake victim PID');
  cleanup.push(() => { if (victim.exitCode === null) victim.kill('SIGKILL'); });
  const listener = createServer((_socket) => { throw new Error('sandboxed app reached outbound listener'); });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing fake outbound port');
  const attempts: number[] = [];
  listener.removeAllListeners('connection');
  listener.on('connection', socket => { attempts.push(1); socket.destroy(); });
  try {
    const f = await fixture(undefined, 200, root => {
      const claim = join(root, 'server-claim.json');
      const foreign = join(root, 'other-app', 'secret.txt');
      writeFileSync(claim, 'claim-secret', { mode: 0o600 });
      mkdirSync(join(root, 'other-app'), { mode: 0o700 });
      writeFileSync(foreign, 'other-app-secret', { mode: 0o600 });
      return `import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';\n`
        + `const attempt = (action) => { try { return action(); } catch { return 'denied'; } };\n`
        + `export default { async fetch(request) { if (new URL(request.url).pathname === '/health') return new Response('healthy');\n`
        + `const claim = attempt(() => readFileSync(${JSON.stringify(claim)}, 'utf8'));\n`
        + `const foreign = attempt(() => readFileSync(${JSON.stringify(foreign)}, 'utf8'));\n`
        + `const write = attempt(() => writeFileSync(${JSON.stringify(join(root, 'outside.txt'))}, 'escaped'));\n`
        + `const sealWrite = attempt(() => writeFileSync(new URL('../.elanous/seal.json', import.meta.url), 'tampered'));\n`
        + `const sealLinkWrite = attempt(() => { symlinkSync(new URL('../.elanous/seal.json', import.meta.url), 'seal-link'); writeFileSync('seal-link', 'tampered'); return 'written'; });\n`
        + `const ownWrite = attempt(() => { writeFileSync('app-owned.txt', 'owned'); return 'written'; });\n`
        + `const foreignSignal = attempt(() => { process.kill(${victim.pid}, 'SIGTERM'); return 'signaled'; });\n`
        + `const selfSignal = attempt(() => { process.kill(process.pid, 'SIGCONT'); return 'signaled'; });\n`
        + `const child = attempt(() => Bun.spawnSync(['/bin/echo', 'probe']).exitCode === 0 ? 'spawned' : 'denied');\n`
        + `const outbound = await fetch('http://127.0.0.1:${address.port}/', { signal: AbortSignal.timeout(300) }).then(() => 'connected', () => 'denied');\n`
        + `return Response.json({ claim, foreign, write, sealWrite, sealLinkWrite, ownWrite, foreignSignal, selfSignal, child, outbound, home: process.env.HOME ?? null, serverKey: process.env.ELANOUS_APPROVED_TEST_APP_RELAY_TOKEN ?? null, dataDir: process.env.ELANOUS_APP_DATA_DIR ?? null }); } };\n`;
    });
    const service = await startAppService({ sealed: f.sealed, runtimeRoot: f.runtimeRoot,
      ownerId: 'owner-a', runId: 'run-a', stillAuthorized: () => true });
    cleanup.push(() => service.stop());
    const response = await service.proxy(new Request('https://demo--test.elanous.app/api/probe'));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ claim: 'denied', foreign: 'denied', write: 'denied', sealWrite: 'denied', sealLinkWrite: 'denied',
      ownWrite: 'written', foreignSignal: 'denied', selfSignal: 'signaled', child: 'denied', outbound: 'denied', home: null, serverKey: null });
    expect(result.dataDir).toBe(join(f.runtimeRoot, 'port-' + service.port, 'data'));
    expect(attempts).toHaveLength(0);
    expect(existsSync(join(f.root, 'outside.txt'))).toBe(false);
    expect(readFileSync(join(result.dataDir, 'app-owned.txt'), 'utf8')).toBe('owned');
    expect(JSON.parse(readFileSync(join(f.sealed.sealPath, '.elanous', 'seal.json'), 'utf8')).artifactDigest).toBe(f.sealed.artifactDigest);
    expect(victim.exitCode).toBeNull();
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});
test('omitted port grants neither loopback listen nor outbound connection to a materializer', async () => {
  if (process.platform !== 'darwin') return;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'app-sandbox-profile-')));
  const app = join(base, 'app');
  const other = join(base, 'other');
  mkdirSync(app, { mode: 0o700 });
  mkdirSync(other, { mode: 0o700 });
  const secret = join(other, 'secret');
  writeFileSync(secret, 'fake-private', { mode: 0o600 });
  const listener = createServer();
  let connections = 0;
  listener.on('connection', socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing fake listener');
  try {
    const wrapper = join(app, 'probe.ts');
    const profile = join(app, 'probe.sb');
    const source = [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const attempt = (run) => { try { return run(); } catch { return 'denied'; } };",
      "const ownWrite = attempt(() => { writeFileSync('owned.txt', 'ok'); return 'written'; });",
      'const foreignRead = attempt(() => readFileSync(' + JSON.stringify(secret) + ", 'utf8'));",
      "const listen = attempt(() => { const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('ok'); } }); server.stop(); return 'allowed'; });",
      "const outbound = await fetch('http://127.0.0.1:" + address.port + "/', { signal: AbortSignal.timeout(300) }).then(() => 'allowed', () => 'denied');",
      "console.log(JSON.stringify({ ownWrite, foreignRead, listen, outbound, home: process.env.HOME, tmp: process.env.TMPDIR }));",
    ].join('\n') + '\n';
    writeFileSync(wrapper, source, { mode: 0o600 });
    const policy = macAppSandboxProfile({ readRoot: app, writeRoot: app, wrapper, bunBinary: realpathSync(process.execPath) });
    expect(policy).toContain('(deny network*)');
    expect(policy).not.toContain('(allow network-inbound');
    writeFileSync(profile, policy + '\n', { mode: 0o600 });
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, realpathSync(process.execPath), wrapper], {
      cwd: app, env: { PATH: '/usr/bin:/bin', HOME: app, TMPDIR: app }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox probe timed out')); }, 3_000);
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({ ownWrite: 'written', foreignRead: 'denied',
      listen: 'denied', outbound: 'denied', home: app, tmp: app });
    expect(readFileSync(join(app, 'owned.txt'), 'utf8')).toBe('ok');
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  }
});

test('service ports remain bounded and cannot write into a sealed read root', () => {
  if (process.platform !== 'darwin') return;
  const input = { readRoot: '/private/sealed', writeRoot: '/private/lease/data', wrapper: '/private/lease/start.ts',
    bunBinary: '/usr/local/bin/bun' };
  expect(() => macAppSandboxProfile({ ...input, listenPort: 0 })).toThrow('app sandbox refused');
  expect(() => macAppSandboxProfile({ ...input, writeRoot: input.readRoot, listenPort: 31500 })).toThrow('app sandbox refused');
  expect(() => macAppSandboxProfile({ ...input, writeRoot: '/private/sealed/data', wrapper: '/private/sealed/start.ts', listenPort: 31500 })).toThrow('app sandbox refused');
  expect(() => macAppSandboxProfile({ ...input, readRoot: '/private/lease/sealed', writeRoot: '/private/lease', wrapper: '/private/lease/sealed/start.ts', listenPort: 31500 })).toThrow('app sandbox refused');
  expect(() => macAppSandboxProfile({ ...input, writeRoot: '/private/lease/../sealed', listenPort: 31500 })).toThrow('app sandbox refused');
  const policy = macAppSandboxProfile({ ...input, listenPort: 31500 });
  expect(policy).toContain('localhost:31500');
  expect(policy).toContain('(subpath "/private/lease/data")');
  expect(policy).not.toContain('(allow file-write* (subpath "/private/sealed"))');
});

test('service root overlap rejects symlink aliases and an absent data child', () => {
  if (process.platform !== 'darwin') return;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'app-sandbox-alias-')));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const physical = join(base, 'physical');
  const sealed = join(physical, 'sealed');
  const alias = join(base, 'alias');
  mkdirSync(sealed, { recursive: true, mode: 0o700 });
  symlinkSync(physical, alias, 'dir');
  const readRoot = join(alias, 'sealed');
  const wrapper = join(readRoot, 'start.ts');
  const bunBinary = realpathSync(process.execPath);
  expect(() => macAppSandboxProfile({ readRoot, writeRoot: join(sealed, 'data'), wrapper,
    bunBinary, listenPort: 31500 })).toThrow('app sandbox refused');
  expect(() => macAppSandboxProfile({ readRoot, writeRoot: physical, wrapper,
    bunBinary, listenPort: 31500 })).toThrow('app sandbox refused');
  if (base.startsWith('/private/var/')) {
    expect(() => macAppSandboxProfile({ readRoot: join(base.slice('/private'.length), 'physical', 'sealed'),
      writeRoot: join(sealed, 'data'), wrapper: join(base.slice('/private'.length), 'physical', 'sealed', 'start.ts'),
      bunBinary, listenPort: 31500 })).toThrow('app sandbox refused');
  }
  const safe = macAppSandboxProfile({ readRoot, writeRoot: join(base, 'separate-data'), wrapper,
    bunBinary, listenPort: 31500 });
  expect(safe).toContain('(subpath "' + sealed + '")');
});

test('non-Darwin profile generation refuses before any sandbox command', () => {
  if (process.platform === 'darwin') return;
  expect(() => macAppSandboxProfile({ readRoot: '/private/app', writeRoot: '/private/app',
    wrapper: '/private/app/probe.ts', bunBinary: '/usr/local/bin/bun' })).toThrow('app sandbox refused');
});
