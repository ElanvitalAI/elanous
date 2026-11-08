// Node-catalog N4.3 (2026-05-11) — HTTP request executor tests.
//
// We monkey-patch globalThis.fetch for the duration of each case so
// the executor goes through the same code path it would in
// production. The pure `basicAuthHeader` helper has its own cases.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runWorkflowToCompletion,
  type WorkflowDeps,
  type WorkflowDefinition,
} from '../src/workflow-runtime/index.js';
import { validateWorkflow } from '../src/workflow-runtime/schema.js';
import { basicAuthHeader } from '../src/workflow-runtime/nodes/http.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};
type FetchHandler = (input: string, init: FetchInit) => Promise<Response>;

let fakeFetch: FakeFetchDevice | undefined;
let lastInput = '';
let lastInit: FetchInit = {};
let expectedCalls: string[] = [];

function installFetchMock(handler: FetchHandler, url: string, method = 'GET'): void {
  fakeFetch?.restore();
  expectedCalls = [`${method} ${url}`];
  const route = {
    url,
    method,
    response: (request: { url: string; method: string; headers: Readonly<Record<string, string>>; body: string | null }) => {
      lastInput = request.url;
      lastInit = {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body !== null ? { body: request.body } : {}),
      };
      return handler(lastInput, lastInit);
    },
  };
  fakeFetch = createFakeFetchDevice([route]);
}

function restoreFetch(): void {
  if (fakeFetch) {
    expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`).sort()).toEqual([...expectedCalls].sort());
  }
  fakeFetch?.restore();
  fakeFetch = undefined;
  lastInput = '';
  lastInit = {};
  expectedCalls = [];
}

function makeArtifactsDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-http-test-'));
}

function makeDeps(over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    callLLM: async () => '',
    runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    ...over,
  };
}

afterEach(() => {
  restoreFetch();
});

describe('basicAuthHeader (pure)', () => {
  it('encodes username:password as base64', () => {
    expect(basicAuthHeader('alice', 'secret')).toBe('Basic YWxpY2U6c2VjcmV0');
  });
  it('handles empty fields', () => {
    expect(basicAuthHeader('', '')).toBe('Basic Og==');
  });
  it('handles UTF-8 in credentials', () => {
    expect(basicAuthHeader('한', 'pw')).toBe('Basic 7ZWcOnB3');
  });
});

describe('schema · http variant', () => {
  it('accepts a well-formed http node', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [{
        id: 'req',
        http: { method: 'GET', url: 'https://example.com/x' },
      }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown method', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'WAT', url: 'https://x' } }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects missing url', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET' } }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects bad auth type', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [{
        id: 'req',
        http: { method: 'GET', url: 'https://x', auth: { type: 'oauth' } },
      }],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts bearer auth', () => {
    const r = validateWorkflow({
      name: 'demo',
      description: 'd',
      nodes: [{
        id: 'req',
        http: { method: 'GET', url: 'https://x', auth: { type: 'bearer', token: 'xyz' } },
      }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('executor · http node', () => {
  it('parses JSON response body when content-type=application/json', async () => {
    installFetchMock(async () => new Response(JSON.stringify({ name: 'Alice', age: 30 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'https://api.example.com/u');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET', url: 'https://api.example.com/u' } }],
    };
    const { outputs, ok } = await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(ok).toBe(true);
    expect(outputs['req']?.output).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns raw text when content-type is not json', async () => {
    installFetchMock(async () => new Response('plain text response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }), 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET', url: 'https://x' } }],
    };
    const { outputs } = await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(outputs['req']?.output).toBe('plain text response');
  });

  it('interpolates url, headers, and body via $ARGUMENTS / $node.output', async () => {
    installFetchMock(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'https://api.example.com/echo?q=hello', 'POST');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [
        {
          id: 'req',
          http: {
            method: 'POST',
            url: 'https://api.example.com/echo?q=$ARGUMENTS',
            headers: { 'X-Token': '$ARGUMENTS-tok' },
            body: '{"msg":"$ARGUMENTS"}',
          },
        },
      ],
    };
    await runWorkflowToCompletion(
      { workflow: wf, arguments: 'hello', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(lastInput).toBe('https://api.example.com/echo?q=hello');
    expect(lastInit.headers?.['x-token']).toBe('hello-tok');
    expect(lastInit.body).toBe('{"msg":"hello"}');
    expect(lastInit.method).toBe('POST');
  });

  it('attaches Authorization: Bearer <token>', async () => {
    installFetchMock(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{
        id: 'req',
        http: {
          method: 'GET',
          url: 'https://x',
          auth: { type: 'bearer', token: 'abc123' },
        },
      }],
    };
    await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(lastInit.headers?.authorization).toBe('Bearer abc123');
  });

  it('attaches Basic auth header', async () => {
    installFetchMock(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{
        id: 'req',
        http: {
          method: 'GET',
          url: 'https://x',
          auth: { type: 'basic', username: 'alice', password: 'secret' },
        },
      }],
    };
    await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(lastInit.headers?.authorization).toBe('Basic YWxpY2U6c2VjcmV0');
  });

  it('returns ok=false on >=400 status with error message + body preserved', async () => {
    installFetchMock(async () => new Response('not found', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' },
    }), 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET', url: 'https://x' } }],
    };
    const { outputs, ok } = await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(ok).toBe(false);
    expect(outputs['req']?.ok).toBe(false);
    expect(outputs['req']?.error).toContain('404');
    expect(outputs['req']?.output).toBe('not found');
  });

  it('returns ok=false when fetch throws', async () => {
    installFetchMock(async () => { throw new Error('network down'); }, 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET', url: 'https://x' } }],
    };
    const { outputs, ok } = await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    expect(ok).toBe(false);
    expect(outputs['req']?.error).toContain('network down');
  });

  it('reports variant=http in node_start events', async () => {
    installFetchMock(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }), 'https://x/');
    const wf: WorkflowDefinition = {
      name: 'demo',
      description: 'd',
      nodes: [{ id: 'req', http: { method: 'GET', url: 'https://x' } }],
    };
    const { events } = await runWorkflowToCompletion(
      { workflow: wf, arguments: '', artifactsDir: makeArtifactsDir() },
      makeDeps(),
    );
    const start = events.find((e) => e.type === 'node_start');
    expect(start && start.type === 'node_start' && start.nodeType).toBe('http');
  });
});
