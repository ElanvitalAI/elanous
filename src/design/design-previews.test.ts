import { describe, expect, test } from 'bun:test';

import { makeDesignPreviews, type DesignPreviewDeps } from './design-previews.js';
import type { OpenDesignConnection } from './open-design-client.js';

const connection: OpenDesignConnection = { url: 'http://open-design.test', token: 'preview-token' };

interface Route {
  method: string;
  path: string;
  body?: unknown;
}

function daemon(handlers: {
  onProject?: (body: { id: string; designSystemId: string }) => Response;
  onRun?: (body: { projectId: string; message: string; agentId: string }) => Response;
  onGetRun?: (runId: string, calls: number) => Response;
  onFiles?: (projectId: string) => Response;
  onRead?: (projectId: string, name: string) => Response;
}, seen: Route[]): typeof fetch {
  const polls = new Map<string, number>();
  return (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    seen.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (method === 'POST' && url.pathname === '/api/projects') {
      return handlers.onProject?.(body as { id: string; designSystemId: string })
        ?? Response.json({ project: { id: body?.id, name: 'n', designSystemId: body?.designSystemId }, conversationId: 'c' });
    }
    if (method === 'POST' && url.pathname === '/api/runs') {
      return handlers.onRun?.(body as { projectId: string; message: string; agentId: string })
        ?? Response.json({ runId: `run-${String(body?.projectId)}` });
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      const n = (polls.get(runId) ?? 0) + 1;
      polls.set(runId, n);
      return handlers.onGetRun?.(runId, n) ?? Response.json({ status: 'succeeded', designSystemId: 'minimal', agentId: 'codex' });
    }
    const filesMatch = /^\/api\/projects\/([^/]+)\/files$/.exec(url.pathname);
    if (method === 'GET' && filesMatch) {
      return handlers.onFiles?.(decodeURIComponent(filesMatch[1]!))
        ?? Response.json({ files: [{ name: 'notes.txt', size: 1 }, { name: 'index.html', size: 20 }] });
    }
    const readMatch = /^\/api\/projects\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && readMatch) {
      const projectId = decodeURIComponent(readMatch[1]!);
      const name = decodeURIComponent(readMatch[2]!);
      return handlers.onRead?.(projectId, name)
        ?? new Response(`<html>${projectId}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('missing', { status: 404 });
  }) as typeof fetch;
}

function ioDeps(root: string): { deps: DesignPreviewDeps; files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const deps: DesignPreviewDeps = {
    connection,
    now: () => 0,
    sleep: async () => {},
    clock: () => '20260928034100',
    mkdir: (path) => { dirs.push(path); },
    writeFile: (path, contents) => { files.set(path, contents); },
  };
  void root;
  return { deps, files, dirs };
}

describe('design previews', () => {
  test('runs two systems in parallel and saves the first html', async () => {
    const seen: Route[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const base = daemon({}, seen);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await base(input, init); } finally { inFlight -= 1; }
    }) as typeof fetch;
    const { deps, files } = ioDeps('/repo/sample');
    const results = await makeDesignPreviews({
      repoRoot: '/repo/sample',
      brief: 'same brief',
      systems: ['minimal', 'editorial'],
    }, { ...deps, fetch: fetchImpl });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(files.get('/repo/sample/design/previews/minimal.html')).toContain('minimal');
    expect(files.get('/repo/sample/design/previews/editorial.html')).toContain('editorial');
    expect(results.every((result) => result.status === 'succeeded' && result.path?.endsWith(`${result.system}.html`))).toBe(true);
    const runs = seen.filter((route) => route.path === '/api/runs');
    expect(runs).toHaveLength(2);
    expect(runs.every((route) => (route.body as { message: string }).message === 'same brief')).toBe(true);
  });

  test('a failed run does not block the other system from saving', async () => {
    const seen: Route[] = [];
    const fetchImpl = daemon({
      onGetRun: (runId) => Response.json({ status: runId.includes('editorial') ? 'failed' : 'succeeded' }),
    }, seen);
    const { deps, files } = ioDeps('/repo/sample');
    const results = await makeDesignPreviews({
      repoRoot: '/repo/sample',
      brief: 'brief',
      systems: ['minimal', 'editorial'],
    }, { ...deps, fetch: fetchImpl });

    const minimal = results.find((result) => result.system === 'minimal');
    const editorial = results.find((result) => result.system === 'editorial');
    expect(minimal?.ok).toBe(true);
    expect(minimal?.path).toBe('/repo/sample/design/previews/minimal.html');
    expect(files.has('/repo/sample/design/previews/minimal.html')).toBe(true);
    expect(editorial?.ok).toBe(false);
    expect(editorial?.status).toBe('failed');
    expect(files.has('/repo/sample/design/previews/editorial.html')).toBe(false);
  });

  test('a failed run carries OpenDesign\'s own error sentence in the reason', async () => {
    const fetchImpl = daemon({
      onGetRun: () => Response.json({ status: 'failed', error: 'Claude Code could not authenticate. Run `claude`, use `/login`.' }),
    }, []);
    const { deps } = ioDeps('/repo/sample');
    const [result] = await makeDesignPreviews({ repoRoot: '/repo/sample', brief: 'brief', systems: ['minimal'] }, { ...deps, fetch: fetchImpl });
    expect(result?.ok).toBe(false);
    expect(result?.reason).toBe('failed: Claude Code could not authenticate. Run `claude`, use `/login`.');
  });

  test('polling past the limit returns timeout and writes nothing', async () => {
    let now = 0;
    const seen: Route[] = [];
    const fetchImpl = daemon({
      onGetRun: () => Response.json({ status: 'running' }),
    }, seen);
    const { deps, files } = ioDeps('/repo/sample');
    const results = await makeDesignPreviews({
      repoRoot: '/repo/sample',
      brief: 'brief',
      systems: ['minimal'],
      pollMs: 10,
      timeoutMs: 25,
    }, {
      ...deps,
      fetch: fetchImpl,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(results).toEqual([expect.objectContaining({ system: 'minimal', ok: false, status: 'timeout' })]);
    expect(files.size).toBe(0);
  });
});
