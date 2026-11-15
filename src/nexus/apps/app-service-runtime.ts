import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SealedAppSource } from './app-source-seal.js';

const FIRST_PORT = 31500;
const LAST_PORT = 31599;
const ENTRY = /^backend\/[A-Za-z0-9][A-Za-z0-9._/-]*\.tsx?$/;
const REFUSED = 'app service refused';
export interface MacAppSandboxInput {
  readonly readRoot: string;
  readonly writeRoot: string;
  readonly wrapper: string;
  readonly bunBinary: string;
  /** Omitted means no network operation, including loopback listen, is allowed. */
  readonly listenPort?: number;
}
function sandboxFail(): never { throw new Error('app sandbox refused'); }
function sbplPath(path: string): string {
  if (!path.startsWith('/') || /[\x00-\x1f]/u.test(path)) sandboxFail();
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/** Resolve existing symlink aliases; for an absent final path, bind it to the real parent. */
function sandboxRealPath(path: string): string {
  if (resolve(path) !== path) sandboxFail();
  let parent = path;
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(parent), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sandboxFail();
      try { lstatSync(parent); sandboxFail(); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') sandboxFail(); }
      const next = dirname(parent);
      if (next === parent) sandboxFail();
      missing.push(basename(parent));
      parent = next;
    }
  }
}
/** Shared Darwin policy. Caller must also supply a minimal env and private cwd to sandbox-exec.
 * Bun startup needs sysctl-read, so this profile does not claim to block host sysctl metadata. */
export function macAppSandboxProfile(input: MacAppSandboxInput): string {
  const { readRoot, writeRoot, wrapper, bunBinary, listenPort } = input;
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) sandboxFail();
  for (const path of [readRoot, writeRoot, wrapper, bunBinary]) {
    sbplPath(path);
    if (resolve(path) !== path) sandboxFail();
  }
  const realReadRoot = sandboxRealPath(readRoot);
  const realWriteRoot = sandboxRealPath(writeRoot);
  const realWrapper = sandboxRealPath(wrapper);
  const realBunBinary = sandboxRealPath(bunBinary);
  if (realWrapper === realReadRoot || (!inside(realReadRoot, realWrapper)
    && !inside(dirname(realWrapper), realWriteRoot))) sandboxFail();
  if (listenPort === undefined && (!inside(realReadRoot, realWrapper)
    || (realWriteRoot !== realReadRoot && !inside(realReadRoot, realWriteRoot)))) sandboxFail();
  if (listenPort !== undefined && (!Number.isInteger(listenPort)
    || listenPort < FIRST_PORT || listenPort > LAST_PORT
    || realWriteRoot === realReadRoot || inside(realReadRoot, realWriteRoot) || inside(realWriteRoot, realReadRoot))) sandboxFail();
  return '(version 1)(allow default)(deny file-read*)(deny file-write*)(deny network*)'
    + '(deny process-fork)(deny signal)(deny process-info*)(allow process-info* (target self))'
    + '(allow signal (target self))'
    + '(allow file-read* (literal "/"))'
    + '(allow file-read* (literal ' + sbplPath(realBunBinary) + '))'
    + '(allow file-read* (subpath ' + sbplPath(realReadRoot) + '))'
    + '(allow file-read* (subpath ' + sbplPath(dirname(realWrapper)) + '))'
    + '(allow file-write* (subpath ' + sbplPath(realWriteRoot) + '))'
    + (listenPort === undefined ? '' : '(allow network-inbound (local ip "localhost:' + listenPort + '"))');
}
/** macOS policy: sealed source is read-only; only a private data directory is writable. */
export function macAppServiceSandboxProfile(root: string, wrapper: string, data: string, bunBinary: string, port: number): string {
  if (!inside(dirname(wrapper), data) || inside(root, data)) fail();
  return macAppSandboxProfile({ readRoot: root, writeRoot: data, wrapper, bunBinary, listenPort: port });
}
const FRONTEND_MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};
function fail(): never { throw new Error(REFUSED); }
function inside(root: string, child: string): boolean {
  const path = child.slice(root.length);
  return child.startsWith(root + sep) && !!path;
}
function probeFree(port: number): Promise<boolean> {
  return new Promise(resolveProbe => {
    const server = createServer();
    server.once('error', () => resolveProbe(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveProbe(true)));
  });
}
function stopChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}
export interface AppServiceBinding {
  readonly port: number;
  readonly pid: number;
  readonly ownerId: string;
  readonly runId: string;
  readonly artifactDigest: string;
  readonly apiPrefix: '/api';
  proxy(request: Request): Promise<Response>;
  stop(): Promise<void>;
}
export interface StartAppServiceInput {
  readonly sealed: SealedAppSource;
  readonly ownerId: string;
  readonly runId: string;
  readonly runtimeRoot: string;
  readonly stillAuthorized: () => boolean | Promise<boolean>;
  readonly readinessTimeoutMs?: number;
}

/** Spawn only a verified Bun request-handler module behind a private fixed loopback listener. */
export async function startAppService(input: StartAppServiceInput): Promise<AppServiceBinding> {
  const { sealed } = input;
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) fail();
  if (sealed.ownerId !== input.ownerId || sealed.runId !== input.runId || !await input.stillAuthorized()) fail();
  if (!Array.isArray(sealed.runtime.startCommand) || sealed.runtime.startCommand.length !== 2
    || sealed.runtime.startCommand[0] !== 'bun' || typeof sealed.runtime.startCommand[1] !== 'string'
    || !ENTRY.test(sealed.runtime.startCommand[1]) || sealed.runtime.startCommand[1].includes('..')) fail();
  const root = resolve(sealed.sealPath);
  const entry = resolve(root, sealed.runtime.startCommand[1]);
  if (!inside(root, entry)) fail();
  const stat = lstatSync(entry);
  const receiptRoot = join(root, '.elanous');
  if (!stat.isFile() || stat.isSymbolicLink() || !existsSync(receiptRoot)) fail();
  const receiptRootStat = lstatSync(receiptRoot);
  if (!receiptRootStat.isDirectory() || receiptRootStat.isSymbolicLink()
    || (receiptRootStat.mode & 0o077) !== 0 || process.getuid && receiptRootStat.uid !== process.getuid()) fail();
  const receiptPath = join(receiptRoot, 'seal.json');
  if (!existsSync(receiptPath)) fail();
  const receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.nlink !== 1
    || receiptStat.size > 8192 || (receiptStat.mode & 0o077) !== 0) fail();
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
  if (receipt.ownerId !== input.ownerId || receipt.runId !== input.runId || receipt.artifactDigest !== sealed.artifactDigest) fail();
  if (receipt.frontendRoot !== sealed.frontendRoot) fail();
  if (sealed.frontendRoot && !sealed.frontendAssets?.has('index.html')) fail();
  const frontendAssets = sealed.frontendAssets
    ? new Map([...sealed.frontendAssets].map(([name, bytes]) => [name, Buffer.from(bytes)])) : undefined;
  const runtimeRoot = resolve(input.runtimeRoot);
  const runtimeStat = lstatSync(runtimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || (runtimeStat.mode & 0o077) !== 0
    || realpathSync(runtimeRoot) !== runtimeRoot) fail();
  const portCandidates = sealed.runtime.port === undefined
    ? Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, index) => FIRST_PORT + index)
    : [sealed.runtime.port];
  let port: number | undefined;
  let lease: string | undefined;
  for (const candidate of portCandidates) {
    if (!Number.isInteger(candidate) || candidate < FIRST_PORT || candidate > LAST_PORT) fail();
    const path = join(runtimeRoot, 'port-' + candidate);
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') { if (sealed.runtime.port !== undefined) fail(); else continue; }
      throw error;
    }
    const candidateIdentity = lstatSync(path, { bigint: true });
    if (!await probeFree(candidate)) {
      const current = lstatSync(path, { bigint: true });
      if (current.dev !== candidateIdentity.dev || current.ino !== candidateIdentity.ino) fail();
      rmSync(path, { recursive: true });
      if (sealed.runtime.port !== undefined) fail();
      continue;
    }
    port = candidate; lease = path; break;
  }
  if (port === undefined || !lease) fail();
  const leaseIdentity = lstatSync(lease, { bigint: true });
  const nonce = randomBytes(24).toString('hex');
  const wrapper = join(lease, 'service-' + randomUUID() + '.ts');
  const sandboxProfile = join(lease, 'service.sb');
  const data = join(lease, 'data');
  const body = `const mod = await import(${JSON.stringify(pathToFileURL(entry).href)});\n`
    + `const handler = mod.default?.fetch ? mod.default.fetch.bind(mod.default) : mod.fetch;\n`
    + `if (typeof handler !== 'function') throw new Error('missing request handler');\n`
    + `Bun.serve({ hostname: '127.0.0.1', port: ${port}, fetch(request) {\n`
    + `  if (new URL(request.url).pathname === '/.well-known/elanous/service-ready') return new Response(${JSON.stringify(nonce)});\n`
    + `  return handler(request);\n` + `} });\n`;
  let child: ChildProcess | undefined;
  let stopped = false;
  const release = () => {
    try {
      const current = lstatSync(lease!, { bigint: true });
      if (current.dev === leaseIdentity.dev && current.ino === leaseIdentity.ino) rmSync(lease!, { recursive: true });
    } catch { /* renamed or absent: never remove another lease */ }
  };
  try {
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(wrapper, body, { flag: 'wx', mode: 0o600 });
    const bunBinary = realpathSync(process.execPath);
    writeFileSync(sandboxProfile, macAppServiceSandboxProfile(root, wrapper, data, bunBinary, port) + '\n', { flag: 'wx', mode: 0o600 });
    if (!await input.stillAuthorized()) fail();
    child = spawn('/usr/bin/sandbox-exec', ['-f', sandboxProfile, bunBinary, wrapper], {
      cwd: data, env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', ELANOUS_APP_DATA_DIR: data }, stdio: 'ignore',
    });
    child.on('error', () => { /* readiness fails closed */ });
    const deadline = Date.now() + Math.min(input.readinessTimeoutMs ?? 5_000, 10_000);
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && !ready) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/elanous/service-ready`, { signal: AbortSignal.timeout(400) });
        ready = response.status === 200 && await response.text() === nonce;
      } catch { await Bun.sleep(50); }
    }
    if (!ready || child.pid === undefined || !await input.stillAuthorized()) fail();
    // The private readiness nonce proves the wrapper started; the declared app health path
    // must independently report success before a public route can point at the service.
    const health = await fetch(`http://127.0.0.1:${port}${sealed.runtime.healthPath}`, {
      redirect: 'manual', signal: AbortSignal.timeout(1_000),
    });
    await health.body?.cancel();
    if (health.status !== 200 || !await input.stillAuthorized()) fail();
    const active = child;
    writeFileSync(join(lease, 'binding.json'), JSON.stringify({ ownerId: input.ownerId, runId: input.runId,
      artifactDigest: sealed.artifactDigest, port, pid: active.pid, state: 'ready' }) + '\n', { flag: 'wx', mode: 0o600 });
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      stopChild(active);
      await Promise.race([new Promise<void>(resolveStop => active.once('close', () => resolveStop())), Bun.sleep(1_000)]);
      if (active.exitCode === null && active.signalCode === null) active.kill('SIGKILL');
      release();
    };
    const proxy = async (request: Request): Promise<Response> => {
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
      const expired = new Promise<never>((_, reject) => {
        deadline.addEventListener('abort', () => reject(new Error('app service request expired')), { once: true });
      });
      try {
        if (stopped || active.exitCode !== null || !await Promise.race([input.stillAuthorized(), expired])) return new Response('Unavailable', { status: 503 });
      } catch { return new Response('Unavailable', { status: 503 }); }
      const original = new URL(request.url);
      let decodedPath: string;
      try { decodedPath = decodeURIComponent(original.pathname); }
      catch { return new Response('Not found', { status: 404 }); }
      const api = original.pathname === '/api' || original.pathname.startsWith('/api/');
      const publicRead = request.method === 'GET' || request.method === 'HEAD';
      if ((!api && !publicRead) || decodedPath.startsWith('/v1/') || decodedPath.startsWith('/__')
        || decodedPath.startsWith('/.well-known/') || /%2f|%5c/i.test(original.pathname)
        || decodedPath.includes('\\') || decodedPath.includes('\0')
        || decodedPath.split('/').some(segment => segment === '.' || segment === '..')
        || (api && decodedPath.includes('%'))) return new Response('Not found', { status: 404 });
      if (!api && frontendAssets) {
        const name = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
        const bytes = frontendAssets.get(name);
        if (!bytes) return new Response('Not found', { status: 404 });
        return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers: {
          'content-type': FRONTEND_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        } });
      }
      const allowed = new Headers();
      for (const key of ['content-type', 'accept']) {
        const value = request.headers.get(key);
        if (value) allowed.set(key, value);
      }
      let body: Buffer | undefined;
      if (!['GET', 'HEAD'].includes(request.method)) {
        const reader = request.body?.getReader();
        if (reader) {
          const parts: Uint8Array[] = []; let size = 0;
          try {
            for (;;) {
              const part = await Promise.race([reader.read(), expired]);
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 64 * 1024) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
              parts.push(part.value);
            }
          } catch { await reader.cancel().catch(() => {}); return new Response('Unavailable', { status: 503 }); }
          finally { reader.releaseLock(); }
          body = Buffer.concat(parts.map(part => Buffer.from(part)));
        }
      }
      try {
        const target = new URL(original.pathname + original.search, `http://127.0.0.1:${port}`);
        const response = await fetch(target, { method: request.method, headers: allowed, body: body as BodyInit | undefined, redirect: 'manual',
          signal: deadline });
        const reader = response.body?.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const part = await Promise.race([reader.read(), expired]);
              if (part.done) break;
              size += part.value.byteLength;
              if (size > 2 * 1024 * 1024) { await reader.cancel(); return new Response('Too large', { status: 502 }); }
              parts.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = Buffer.concat(parts.map(part => Buffer.from(part)));
        const headers = new Headers({ 'cache-control': 'no-store' });
        if (response.headers.has('content-type')) headers.set('content-type', response.headers.get('content-type')!);
        return new Response(request.method === 'HEAD' || [204, 304].includes(response.status) ? null : bytes,
          { status: response.status, headers });
      } catch { return new Response('Unavailable', { status: 503 }); }
    };
    return { port, pid: active.pid!, ownerId: input.ownerId, runId: input.runId,
      artifactDigest: sealed.artifactDigest, apiPrefix: '/api', proxy, stop };
  } catch (error) {
    if (child) {
      stopChild(child);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>(resolveStop => child!.once('close', () => resolveStop())), Bun.sleep(1_000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    release();
    throw error;
  }
}
