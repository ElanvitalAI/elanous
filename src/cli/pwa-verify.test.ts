import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { runPwaVerify, type PwaVerifyOpts } from './pwa-verify.js';
import type { StalenessVerdict } from './pwa-staleness.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const FRESH: StalenessVerdict = { stale: false, reason: 'fresh', sourceMtime: 1, outMtime: 2 };
const STALE: StalenessVerdict = { stale: true, reason: 'source-newer', sourceMtime: 2, outMtime: 1 };

function entry(name: string, kind: 'file' | 'directory'): Dirent {
  return { name, isFile: () => kind === 'file', isDirectory: () => kind === 'directory' } as Dirent;
}

function artifactTree(
  entries: Record<string, Dirent[]>,
  files: Record<string, string | Error>,
): Pick<PwaVerifyOpts, 'readDirFn' | 'readFileFn'> {
  return {
    readDirFn: async (path: string) => {
      const result = entries[path];
      if (!result) throw new Error(`ENOENT: ${path}`);
      return result;
    },
    readFileFn: async (path: string) => {
      const result = files[path];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new Error(`ENOENT: ${path}`);
      return result;
    },
  };
}

const DEFAULT_ARTIFACT = artifactTree(
  { '/pwa/out': [entry('index.html', 'file')] },
  { '/pwa/out/index.html': '<html>MARKER</html>' },
);

function options(overrides: Partial<Parameters<typeof runPwaVerify>[0]> = {}) {
  return {
    cwd: '/pwa',
    projectCwd: '/project',
    stalenessFn: () => FRESH,
    ...DEFAULT_ARTIFACT,
    resolveEndpointFn: async () => 'http://127.0.0.1:31415/app/',
    fetchFn: async () => new Response('<html>MARKER</html>', { status: 200 }),
    out: { log: () => {} },
    ...overrides,
  };
}

describe('runPwaVerify', () => {
  test('reports a fresh staleness result without marker checks when marker is omitted', async () => {
    const result = await runPwaVerify(options());
    expect(result.exitCode).toBe(0);
    expect(result.staleness).toMatchObject({ status: 'measured', verdict: FRESH });
    expect(result.artifactMarker).toEqual({ status: 'marker-unspecified' });
    expect(result.httpMarker).toEqual({ status: 'marker-unspecified' });
    expect(result.browser).toBe('not-answered');
  });

  test('finds the artifact marker in a nested served file', async () => {
    const root = '/pwa/out';
    const nested = join(root, '_next', 'static', 'chunks', 'marker.js');
    const result = await runPwaVerify(options({
      marker: 'MARKER',
      ...artifactTree(
        {
          [root]: [entry('_next', 'directory'), entry('index.html', 'file')],
          [join(root, '_next')]: [entry('static', 'directory')],
          [join(root, '_next', 'static')]: [entry('chunks', 'directory')],
          [join(root, '_next', 'static', 'chunks')]: [entry('marker.js', 'file')],
        },
        { [join(root, 'index.html')]: 'old artifact', [nested]: 'const marker = "MARKER";' },
      ),
    }));
    expect(result.artifact).toBe(root);
    expect(result.artifactMarker).toEqual({ status: 'present' });
  });

  test('reports absent only after a complete artifact scan', async () => {
    const result = await runPwaVerify(options({ marker: 'MARKER', ...artifactTree(
      { '/pwa/out': [entry('index.html', 'file'), entry('nested', 'directory')], '/pwa/out/nested': [entry('app.js', 'file')] },
      { '/pwa/out/index.html': 'old artifact', '/pwa/out/nested/app.js': 'still old' },
    ) }));
    expect(result.artifactMarker).toEqual({ status: 'absent' });
    expect(result.httpMarker.status).toBe('present');
  });

  test('keeps artifact scans unmeasurable when a read or directory enumeration fails without a marker', async () => {
    const unreadable = await runPwaVerify(options({ marker: 'MARKER', ...artifactTree(
      { '/pwa/out': [entry('denied.js', 'file'), entry('old.js', 'file')] },
      { '/pwa/out/denied.js': new Error('EACCES'), '/pwa/out/old.js': 'old artifact' },
    ) }));
    expect(unreadable.artifactMarker).toEqual({ status: 'unmeasurable', detail: 'scan failures: denied.js: EACCES' });

    const deniedDirectory = await runPwaVerify(options({ marker: 'MARKER', ...artifactTree(
      { '/pwa/out': [entry('denied', 'directory'), entry('old.js', 'file')] },
      { '/pwa/out/old.js': 'old artifact' },
    ) }));
    expect(deniedDirectory.artifactMarker).toEqual({ status: 'unmeasurable', detail: 'scan failures: denied: ENOENT: /pwa/out/denied' });
  });

  test('keeps scanning after failures and preserves them when another file contains the marker', async () => {
    const result = await runPwaVerify(options({ marker: 'MARKER', ...artifactTree(
      { '/pwa/out': [entry('denied.js', 'file'), entry('nested', 'directory')], '/pwa/out/nested': [entry('marker.js', 'file')] },
      { '/pwa/out/denied.js': new Error('EACCES'), '/pwa/out/nested/marker.js': 'MARKER' },
    ) }));
    expect(result.artifactMarker).toEqual({ status: 'present', detail: 'scan failures: denied.js: EACCES' });
  });

  test('reports stale source separately from marker results', async () => {
    const result = await runPwaVerify(options({ marker: 'MARKER', stalenessFn: () => STALE }));
    expect(result.staleness.verdict).toEqual(STALE);
    expect(result.artifactMarker.status).toBe('present');
    expect(result.httpMarker.status).toBe('present');
  });

  test('keeps staleness unmeasurable separate from successful marker checks', async () => {
    const result = await runPwaVerify(options({ marker: 'MARKER', stalenessFn: () => { throw new Error('mtime denied'); } }));
    expect(result.staleness).toEqual({ status: 'unmeasurable', detail: 'mtime denied' });
    expect(result.artifactMarker.status).toBe('present');
    expect(result.httpMarker.status).toBe('present');
  });

  test('reports HTTP marker absent while artifact marker remains present', async () => {
    const result = await runPwaVerify(options({ marker: 'MARKER', fetchFn: async () => new Response('old HTTP body', { status: 200 }) }));
    expect(result.artifactMarker.status).toBe('present');
    expect(result.httpMarker.status).toBe('absent');
  });

  test('reports unavailable, failing, redirected HTTP as unmeasurable', async () => {
    const unavailable = await runPwaVerify(options({ marker: 'MARKER', resolveEndpointFn: async () => undefined }));
    expect(unavailable.httpMarker.status).toBe('unmeasurable');

    const refused = await runPwaVerify(options({ marker: 'MARKER', fetchFn: async () => { throw new Error('connection refused'); } }));
    expect(refused.httpMarker).toEqual({ status: 'unmeasurable', detail: 'connection refused' });

    const failed = await runPwaVerify(options({ marker: 'MARKER', fetchFn: async () => new Response('', { status: 503 }) }));
    expect(failed.httpMarker).toEqual({ status: 'unmeasurable', detail: 'HTTP 503' });

    const redirected = await runPwaVerify(options({ marker: 'MARKER', fetchFn: async () => new Response('', { status: 302 }) }));
    expect(redirected.httpMarker).toEqual({ status: 'unmeasurable', detail: 'HTTP 302' });
  });

  test('emits structured JSON with all three layers', async () => {
    const logs: string[] = [];
    await runPwaVerify(options({ marker: 'MARKER', format: 'json', out: { log: (line) => logs.push(line) } }));
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.staleness.status).toBe('measured');
    expect(parsed.artifactMarker.status).toBe('present');
    expect(parsed.httpMarker.status).toBe('present');
    expect(parsed.browser).toBe('not-answered');
  });

  test('registered nexus pwa command exposes verify with and without an optional marker', () => {
    const help = execFileSync('bun', ['bin/elanous.mjs', 'nexus', 'pwa', 'verify', '--help'], { encoding: 'utf8' });
    expect(help).toContain('nexus pwa verify [options] [marker]');
    expect(help).toContain('Read-only verification');
  });
});
