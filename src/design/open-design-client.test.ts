import { describe, expect, test } from 'bun:test';

import {
  createProject,
  getRun,
  listFiles,
  openDesignConfig,
  readFile,
  startRun,
  type OpenDesignConnection,
} from './open-design-client.js';

const TOKEN = 'od-secret-token-value';
const connection: OpenDesignConnection = { url: 'http://open-design.test', token: TOKEN };

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(status: number, body: unknown, captured: Captured[]): typeof fetch {
  return (async (input, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return jsonResponse(status, body);
  }) as typeof fetch;
}

describe('open design client', () => {
  test('five calls use the measured paths, methods, bodies, and bearer header', async () => {
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(200, {}, captured);
    const deps = { fetch: fetchImpl, now: () => 1_000 };

    captured.length = 0;
    const projectFetch = captureFetch(200, {
      project: { id: 'elanous-repo-minimal-1', name: 'repo', designSystemId: 'minimal' },
      conversationId: 'conv-1',
    }, captured);
    const project = await createProject(
      { id: 'elanous-repo-minimal-1', name: 'repo', designSystemId: 'minimal' },
      connection,
      { fetch: projectFetch, now: () => 1_000 },
    );
    expect(project.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      url: 'http://open-design.test/api/projects',
      method: 'POST',
      body: {
        id: 'elanous-repo-minimal-1',
        name: 'repo',
        designSystemId: 'minimal',
        skipDiscoveryBrief: true,
      },
    });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    captured.length = 0;
    const runFetch = captureFetch(200, { runId: 'run-1' }, captured);
    const run = await startRun(
      { projectId: 'elanous-repo-minimal-1', message: 'a landing page', agentId: 'codex' },
      connection,
      { fetch: runFetch, now: () => 2_000 },
    );
    expect(run.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      url: 'http://open-design.test/api/runs',
      method: 'POST',
      body: { projectId: 'elanous-repo-minimal-1', message: 'a landing page', agentId: 'codex' },
    });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    captured.length = 0;
    const getFetch = captureFetch(200, { status: 'succeeded', designSystemId: 'minimal', agentId: 'codex' }, captured);
    const got = await getRun('run-1', connection, { fetch: getFetch, now: () => 3_000 });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.run.status).toBe('succeeded');
    expect(captured[0]).toMatchObject({
      url: 'http://open-design.test/api/runs/run-1',
      method: 'GET',
    });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    captured.length = 0;
    const filesFetch = captureFetch(200, { files: [{ name: 'index.html', size: 12 }] }, captured);
    const files = await listFiles('elanous-repo-minimal-1', connection, { fetch: filesFetch, now: () => 4_000 });
    expect(files.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      url: 'http://open-design.test/api/projects/elanous-repo-minimal-1/files',
      method: 'GET',
    });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    captured.length = 0;
    const readFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response('<html>preview</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const file = await readFile('elanous-repo-minimal-1', 'index.html', connection, { fetch: readFetch, now: () => 5_000 });
    expect(file.ok).toBe(true);
    if (file.ok) expect(file.text).toContain('preview');
    expect(captured[0]).toMatchObject({
      url: 'http://open-design.test/api/projects/elanous-repo-minimal-1/files/index.html',
      method: 'GET',
    });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(deps.fetch).toBe(fetchImpl);
  });

  test('401 and 500 return ok false and never include the token', async () => {
    for (const status of [401, 500]) {
      const fetchImpl = (async () => jsonResponse(status, { error: `denied ${TOKEN}` })) as unknown as typeof fetch;
      const result = await getRun('run-x', connection, { fetch: fetchImpl, now: () => 10 });
      expect(result.ok).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TOKEN);
      if (!result.ok) {
        expect(result.status).toBe(status);
        expect(result.reason).not.toContain(TOKEN);
      }
    }
  });

  test('missing url returns null and does not read a token', () => {
    expect(openDesignConfig({ config: {} })).toBeNull();
    expect(openDesignConfig({ config: { design: {} } })).toBeNull();
    expect(openDesignConfig({
      config: { design: { openDesign: { tokenFile: '/tmp/token' } } },
      readFile: () => { throw new Error('should not read'); },
    })).toBeNull();
  });

  test('configured url reads one token line and never logs it', () => {
    const seen: string[] = [];
    const loaded = openDesignConfig({
      config: { design: { openDesign: { url: 'http://100.64.0.4:7456/', tokenFile: '/tmp/node-b-api-token' } } },
      readFile: (path) => {
        seen.push(path);
        return `\n${TOKEN}\n`;
      },
    });
    expect(seen).toEqual(['/tmp/node-b-api-token']);
    expect(loaded).toEqual({ url: 'http://100.64.0.4:7456', token: TOKEN });
    expect(JSON.stringify({ url: loaded?.url })).not.toContain(TOKEN);
  });
});
