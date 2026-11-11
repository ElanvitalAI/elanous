import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishStaticGeneration } from '../../apps/pwa/scripts/publish-static-generation';
import { runPwaFormalUpdate, runPwaFormalUpdateNode, simulatePwaFormalUpdateSwapFailure } from './pwa-formal-update';

const roots: string[] = [];
type InjectedFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

async function exportedPwa(buildSha: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'pwa-formal-export-'));
  roots.push(root);
  const exportRoot = path.join(root, 'out');
  const html = `<main data-build-sha="${buildSha}"></main><script src="/app/_next/static/app.js"></script>`;
  const script = 'built application bundle';
  const sw = Buffer.from('built service worker');
  await mkdir(path.join(exportRoot, 'settings'), { recursive: true });
  await mkdir(path.join(exportRoot, '_next', 'static'), { recursive: true });
  await writeFile(path.join(exportRoot, 'settings', 'index.html'), html);
  await writeFile(path.join(exportRoot, '_next', 'static', 'app.js'), script);
  await writeFile(path.join(exportRoot, 'sw.js'), sw);
  return { exportRoot, html, script, sw };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pwa-formal-update-sim-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const publishRoot = path.join(root, 'publish');
  const old = path.join(publishRoot, '.pwa-generations', 'old');
  await mkdir(path.join(source, '_next'), { recursive: true });
  await mkdir(path.join(old, '_next'), { recursive: true });
  await mkdir(publishRoot, { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<main>new release</main>');
  await writeFile(path.join(source, '_next', 'app.js'), 'new build');
  await writeFile(path.join(old, 'index.html'), '<main>previous release</main>');
  await writeFile(path.join(old, '_next', 'app.js'), 'previous build');
  const out = path.join(publishRoot, 'out');
  await symlink(path.relative(publishRoot, old), out, 'dir');
  return { source, publishRoot, old, out };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('release-pwa-formal-update-sim: injected atomic-swap failure keeps the prior served release and never restarts', async () => {
  const { source, publishRoot, old, out } = await fixture();
  const calls: string[] = [];
  const result = await runPwaFormalUpdate({
    expectedBuildSha: 'abcdef0',
    expectedServiceWorkerSha256: 'a'.repeat(64),
    buildAndSwap: async () => {
      calls.push('build');
      await publishStaticGeneration(source, publishRoot, {
        renamePointer: async () => { calls.push('swap'); throw new Error('injected pointer rename failure'); },
      });
    },
    restart: async () => { calls.push('restart'); },
    observe: async () => { calls.push('observe'); return { buildSha: 'abcdef0', serviceWorkerSha256: 'a'.repeat(64), pageUrl: 'http://127.0.0.1/app/' }; },
  });

  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', steps: [], summary: expect.stringContaining('before Nexus restart') });
  expect(calls).toEqual(['build', 'swap']);
  expect(await readlink(out)).toBe(path.relative(publishRoot, old));
  expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<main>previous release</main>');
  expect(await readFile(path.join(out, '_next', 'app.js'), 'utf8')).toBe('previous build');
});

test('release-pwa-formal-update-sim: production swap-failure simulation reports observed zero restart and client calls', async () => {
  const result = await simulatePwaFormalUpdateSwapFailure();
  expect(result).toMatchObject({
    verdict: 'fail',
    activeHtml: '<main>previous</main>',
    restartCalled: false,
    observed: false,
  });
  expect(result.activeGeneration).toContain('.pwa-generations/previous');
});

test('release-pwa-formal-update-sim: successful swap restarts before confirming served build and service worker', async () => {
  const { source, publishRoot, out } = await fixture();
  const calls: string[] = [];
  const result = await runPwaFormalUpdate({
    expectedBuildSha: 'abcdef0123456789',
    expectedServiceWorkerSha256: 'b'.repeat(64),
    buildAndSwap: async () => {
      calls.push('build');
      await publishStaticGeneration(source, publishRoot);
      calls.push('swap');
    },
    restart: async () => { calls.push('restart'); },
    observe: async () => {
      calls.push('observe');
      expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<main>new release</main>');
      return { buildSha: 'abcdef0123456789', serviceWorkerSha256: 'b'.repeat(64), pageUrl: 'http://127.0.0.1/app/settings' };
    },
  });

  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', steps: [
    'build-and-atomic-swap', 'nexus-restarted-static', 'client-build-and-service-worker-confirmed',
  ], observation: { buildSha: 'abcdef0123456789', pageUrl: 'http://127.0.0.1/app/settings' } });
  expect(calls).toEqual(['build', 'swap', 'restart', 'observe']);
});

test('release-pwa-formal-update-node: injected CLI and HTTP boundaries confirm served build and service worker', async () => {
  const { exportRoot, html, script, sw } = await exportedPwa('abcdef0');
  const commands: string[] = [];
  const buildSha = 'abcdef0';
  const expectedSwSha = createHash('sha256').update(sw).digest('hex');
  const run = (command: string, args: string[]) => {
    commands.push(`${command} ${args.join(' ')}`);
    if (command === 'git') return { status: 0, stdout: buildSha, stderr: '' };
    if (args[0] === 'bin/elanous.mjs' && args[1] === 'nexus' && args[2] === 'show') {
      return { status: 0, stdout: JSON.stringify({ urls: { pwa: { loopback: 'http://127.0.0.1:4173/app/' } } }), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const fetchImpl: InjectedFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/app/settings/') return new Response(html);
    if (url.pathname === '/app/_next/static/app.js') return new Response(script);
    if (url.pathname === '/app/sw.js') return new Response(sw);
    return new Response('not found', { status: 404 });
  };

  const result = await runPwaFormalUpdateNode(run, process.cwd(), fetchImpl, exportRoot);
  expect(result).toMatchObject({ outcome: 'ok', verdict: 'pass', observation: {
    buildSha, serviceWorkerSha256: expectedSwSha, pageUrl: 'http://127.0.0.1:4173/app/settings/',
  } });
  expect(commands).toEqual([
    'git rev-parse --short HEAD',
    'bun bin/elanous.mjs nexus build',
    'bun bin/elanous.mjs nexus pwa restart --static',
    'bun bin/elanous.mjs nexus show --json',
  ]);
});

test('release-pwa-formal-update-node: stale HTML cannot pass because a referenced shared chunk contains the new SHA', async () => {
  const { exportRoot, script, sw } = await exportedPwa('abcdef0');
  const run = (command: string, args: string[]) => command === 'git'
    ? { status: 0, stdout: 'abcdef0', stderr: '' }
    : args[2] === 'show'
      ? { status: 0, stdout: JSON.stringify({ urls: { pwa: { loopback: 'http://127.0.0.1:4173/app/' } } }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  const fetchImpl: InjectedFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/app/settings/') return new Response('<main data-build-sha="stale"></main><script src="/app/_next/static/app.js"></script>');
    if (url.pathname === '/app/_next/static/app.js') return new Response(script);
    if (url.pathname === '/app/sw.js') return new Response(sw);
    return new Response('not found', { status: 404 });
  };
  const result = await runPwaFormalUpdateNode(run, process.cwd(), fetchImpl, exportRoot);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail', steps: ['build-and-atomic-swap', 'nexus-restarted-static'],
    summary: expect.stringContaining('served settings HTML differs from built PWA export') });
});

test('release-pwa-formal-update-node: injected service-worker digest mismatch fails closed', async () => {
  const { exportRoot, html, script } = await exportedPwa('abcdef0');
  const run = (command: string, args: string[]) => command === 'git'
    ? { status: 0, stdout: 'abcdef0', stderr: '' }
    : args[2] === 'show'
      ? { status: 0, stdout: JSON.stringify({ urls: { pwa: { loopback: 'http://127.0.0.1:4173/app/' } } }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  const fetchImpl: InjectedFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/app/settings/') return new Response(html);
    if (url.pathname === '/app/_next/static/app.js') return new Response(script);
    if (url.pathname === '/app/sw.js') return new Response('stale service worker');
    return new Response('not found', { status: 404 });
  };
  const result = await runPwaFormalUpdateNode(run, process.cwd(), fetchImpl, exportRoot);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail',
    summary: expect.stringContaining('served service worker differs from built PWA export') });
});

test('release-pwa-formal-update-node: injected asset HTTP error fails closed', async () => {
  const { exportRoot, html } = await exportedPwa('abcdef0');
  const run = (command: string, args: string[]) => command === 'git'
    ? { status: 0, stdout: 'abcdef0', stderr: '' }
    : args[2] === 'show'
      ? { status: 0, stdout: JSON.stringify({ urls: { pwa: { loopback: 'http://127.0.0.1:4173/app/' } } }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  const fetchImpl: InjectedFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/app/settings/') return new Response(html);
    if (url.pathname === '/app/_next/static/app.js') return new Response('unavailable', { status: 503 });
    return new Response('not found', { status: 404 });
  };
  const result = await runPwaFormalUpdateNode(run, process.cwd(), fetchImpl, exportRoot);
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail',
    summary: expect.stringContaining('PWA script HTTP 503') });
});
