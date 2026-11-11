import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publishStaticGeneration } from '../../apps/pwa/scripts/publish-static-generation.js';
import { runCommand, type CommandRunner } from './node-verdict.js';

export interface PwaFormalUpdateObservation {
  buildSha: string;
  serviceWorkerSha256: string;
  pageUrl: string;
}

export interface PwaFormalUpdateResult {
  outcome: 'ok' | 'fail';
  verdict: 'pass' | 'fail';
  summary: string;
  steps: string[];
  observation?: PwaFormalUpdateObservation;
}

export interface PwaFormalUpdateDeps {
  expectedBuildSha: string;
  expectedServiceWorkerSha256: string;
  buildAndSwap: () => Promise<void>;
  restart: () => Promise<void>;
  observe: () => Promise<PwaFormalUpdateObservation>;
}

export interface PwaStaticSwapFailureObservation {
  verdict: 'fail';
  activeGeneration: string;
  activeHtml: string;
  restartCalled: boolean;
  observed: boolean;
}

type PwaFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

/** Run the post-publish PWA sequence in order; a failed atomic swap never restarts Nexus. */
export async function runPwaFormalUpdate(deps: PwaFormalUpdateDeps): Promise<PwaFormalUpdateResult> {
  const steps: string[] = [];
  try {
    await deps.buildAndSwap();
    steps.push('build-and-atomic-swap');
  } catch (error) {
    return { outcome: 'fail', verdict: 'fail', summary: `PWA build/swap failed before Nexus restart: ${message(error)}`, steps };
  }

  try {
    await deps.restart();
    steps.push('nexus-restarted-static');
  } catch (error) {
    return { outcome: 'fail', verdict: 'fail', summary: `PWA static generation swapped but Nexus restart failed: ${message(error)}`, steps };
  }

  try {
    const observation = await deps.observe();
    if (!/^[a-f0-9]{7,40}$/i.test(observation.buildSha) || observation.buildSha !== deps.expectedBuildSha
      || !/^[a-f0-9]{64}$/i.test(observation.serviceWorkerSha256)
      || observation.serviceWorkerSha256 !== deps.expectedServiceWorkerSha256 || !observation.pageUrl.startsWith('http')) {
      throw new Error('served PWA build SHA or service-worker digest does not match the built generation');
    }
    steps.push('client-build-and-service-worker-confirmed');
    return { outcome: 'ok', verdict: 'pass', summary: 'PWA build → atomic swap → Nexus restart → client build/SW confirmed', steps, observation };
  } catch (error) {
    return { outcome: 'fail', verdict: 'fail', summary: `PWA client refresh confirmation failed: ${message(error)}`, steps };
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').trim();
}

/** Production atomic publisher under an injected pointer-swap failure, in a disposable sandbox. */
export async function simulatePwaFormalUpdateSwapFailure(): Promise<PwaStaticSwapFailureObservation> {
  const root = await mkdtemp(path.join(tmpdir(), 'pwa-formal-update-world-'));
  try {
    const source = path.join(root, 'candidate');
    const publishRoot = path.join(root, 'served');
    const previous = path.join(publishRoot, '.pwa-generations', 'previous');
    await mkdir(path.join(source, '_next'), { recursive: true });
    await mkdir(path.join(previous, '_next'), { recursive: true });
    await mkdir(publishRoot, { recursive: true });
    await writeFile(path.join(source, 'index.html'), '<main>candidate</main>');
    await writeFile(path.join(source, '_next', 'app.js'), 'candidate');
    await writeFile(path.join(previous, 'index.html'), '<main>previous</main>');
    await writeFile(path.join(previous, '_next', 'app.js'), 'previous');
    const out = path.join(publishRoot, 'out');
    await symlink(path.relative(publishRoot, previous), out, 'dir');
    let restartCalled = false;
    let observed = false;
    const result = await runPwaFormalUpdate({
      expectedBuildSha: 'candidate',
      expectedServiceWorkerSha256: 'b'.repeat(64),
      buildAndSwap: async () => { await publishStaticGeneration(source, publishRoot, {
        renamePointer: async () => { throw new Error('injected pointer swap failure'); },
      }); },
      restart: async () => { restartCalled = true; },
      observe: async () => { observed = true; return { buildSha: 'candidate', serviceWorkerSha256: 'b'.repeat(64), pageUrl: 'http://127.0.0.1/' }; },
    });
    const activeGeneration = await readlink(out);
    const activeHtml = await readFile(path.join(out, 'index.html'), 'utf8');
    if (result.verdict !== 'fail' || result.steps.length !== 0
      || restartCalled || observed
      || activeGeneration !== path.relative(publishRoot, previous) || activeHtml !== '<main>previous</main>') {
      throw new Error('failed static swap did not preserve the previously served generation');
    }
    return { verdict: 'fail', activeGeneration, activeHtml, restartCalled, observed };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function commandOutput(run: CommandRunner, command: string, args: string[], cwd: string, timeout = 120_000): string {
  const result = run(command, args, cwd, timeout);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (rc=${result.status}): ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0]}`);
  return result.stdout.trim();
}

function exportedFile(exportRoot: string, base: URL, resource: URL): string {
  const basePath = base.pathname.replace(/\/+$/, '');
  const pathname = decodeURIComponent(resource.pathname);
  if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
    throw new Error(`PWA resource escaped static base path: ${resource.pathname}`);
  }
  let relative = basePath ? pathname.slice(basePath.length).replace(/^\/+/, '') : pathname.replace(/^\/+/, '');
  if (!relative) relative = 'index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  const root = path.resolve(exportRoot);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`PWA resource escaped static export: ${resource.pathname}`);
  return file;
}

async function assertServedFileMatches(response: Response, file: string, label: string): Promise<Uint8Array> {
  const served = new Uint8Array(await response.arrayBuffer());
  const built = readFileSync(file);
  const servedSha = createHash('sha256').update(served).digest('hex');
  const builtSha = createHash('sha256').update(built).digest('hex');
  if (servedSha !== builtSha) throw new Error(`served ${label} differs from built PWA export`);
  return served;
}

async function observeServedPwa(run: CommandRunner, cwd: string, exportRoot: string, expectedBuildSha: string, fetchImpl: PwaFetch): Promise<PwaFormalUpdateObservation> {
  const status = JSON.parse(commandOutput(run, 'bun', ['bin/elanous.mjs', 'nexus', 'show', '--json'], cwd)) as {
    urls?: { pwa?: { loopback?: string } };
  };
  const base = status.urls?.pwa?.loopback;
  if (!base) throw new Error('nexus show did not provide a loopback PWA URL');
  const pageUrl = new URL('settings/', base.endsWith('/') ? base : `${base}/`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(pageUrl.hostname)) throw new Error('PWA client verification must use the loopback URL');
  const page = await fetchImpl(pageUrl, { cache: 'no-store' });
  if (!page.ok) throw new Error(`settings page HTTP ${page.status}`);
  const html = new TextDecoder().decode(await assertServedFileMatches(page, exportedFile(exportRoot, new URL(base), pageUrl), 'settings HTML'));
  if (!html.includes(expectedBuildSha)) throw new Error(`served PWA HTML does not contain build SHA ${expectedBuildSha}`);
  const scriptUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1]!, pageUrl)).filter((url) => url.origin === pageUrl.origin && url.pathname.includes('/_next/'));
  if (!scriptUrls.length) throw new Error('settings page has no exported Next.js scripts');
  await Promise.all(scriptUrls.map(async (url) => {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`PWA script HTTP ${response.status}: ${url.pathname}`);
    await assertServedFileMatches(response, exportedFile(exportRoot, new URL(base), url), `JavaScript asset ${url.pathname}`);
  }));
  const swUrl = new URL('sw.js', base.endsWith('/') ? base : `${base}/`);
  const sw = await fetchImpl(swUrl, { cache: 'no-store' });
  if (!sw.ok) throw new Error(`service worker HTTP ${sw.status}`);
  const bytes = await assertServedFileMatches(sw, exportedFile(exportRoot, new URL(base), swUrl), 'service worker');
  return { buildSha: expectedBuildSha, serviceWorkerSha256: createHash('sha256').update(bytes).digest('hex'), pageUrl: pageUrl.toString() };
}

export async function runPwaFormalUpdateNode(run: CommandRunner = runCommand, cwd = process.cwd(), fetchImpl: PwaFetch = (input, init) => fetch(input, init), exportRoot = path.join(cwd, 'apps/pwa/out')): Promise<PwaFormalUpdateResult> {
  const expectedBuildSha = commandOutput(run, 'git', ['rev-parse', '--short', 'HEAD'], cwd).toLowerCase();
  const expectedServiceWorkerSha256 = createHash('sha256').update(readFileSync(path.join(exportRoot, 'sw.js'))).digest('hex');
  return runPwaFormalUpdate({
    expectedBuildSha,
    expectedServiceWorkerSha256,
    buildAndSwap: async () => { commandOutput(run, 'bun', ['bin/elanous.mjs', 'nexus', 'build'], cwd, 900_000); },
    restart: async () => { commandOutput(run, 'bun', ['bin/elanous.mjs', 'nexus', 'pwa', 'restart', '--static'], cwd, 180_000); },
    observe: () => observeServedPwa(run, cwd, exportRoot, expectedBuildSha, fetchImpl),
  });
}

async function main(): Promise<void> {
  try {
    const result = await runPwaFormalUpdateNode();
    console.log(JSON.stringify(result));
    process.exitCode = result.verdict === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ outcome: 'error', verdict: 'fail', summary: message(error) }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
