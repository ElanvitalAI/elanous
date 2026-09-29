import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { registerNodeKind } from '../src/graph-kinds/registry.js';
import { setResolveDaemonEndpointForTest } from '../src/nexus/daemon-endpoint.js';
import { runWorkflowToCompletion, validateWorkflow, type WorkflowDeps } from '../src/workflow-runtime/index.js';

const realBash: WorkflowDeps = {
  callLLM: async () => { throw new Error('llm not used'); },
  runBash: (body, opts) => new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', body], {
      cwd: process.cwd(),
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  }),
};

afterEach(() => setResolveDaemonEndpointForTest(null));

test('registered MCP kind sends typed inputs through the daemon gateway and returns text', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } };
    requests.push({ path: new URL(request.url).pathname, ...body });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      content: [{ type: 'text', text: JSON.stringify(body.params) }],
    } });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  setResolveDaemonEndpointForTest(() => ({ baseUrl: base, healthUrl: `${base}/v1/health`, pwaUrl: `${base}/app/`, source: 'registry' }));
  try {
    expect(registerNodeKind({
      graph: 'workflow', kind: 'demo:ncs', plugin: 'demo', description: 'ncs', core: false,
      run: { mcp: { server: 'ncs', tool: 'ncs_search_units', args: {
        keyword: '{{inputs.keyword}}', limit: '{{inputs.limit}}',
      } } },
    })).toEqual({ ok: true });
    const parsed = validateWorkflow({ name: 'plugin-ncs', description: 'lookup', nodes: [
      { id: 'n1', kind: 'demo:ncs', inputs: { keyword: '재시도 정책', limit: 5 } },
    ] });
    expect(parsed.ok).toBe(true);
    const run = await runWorkflowToCompletion({
      workflow: parsed.workflow!, arguments: '', artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
    }, realBash);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/v1/mcp', jsonrpc: '2.0', method: 'tools/call', params: {
      name: 'ncs.ncs_search_units', arguments: { keyword: '재시도 정책', limit: 5 },
    } });
    expect(run.outputs.n1?.ok).toBe(true);
    expect(run.outputs.n1?.output).toBe(JSON.stringify({ name: 'ncs.ncs_search_units', arguments: { keyword: '재시도 정책', limit: 5 } }));

    expect(registerNodeKind({
      graph: 'workflow', kind: 'demo:ncs-mixed', plugin: 'demo', description: 'mixed', core: false,
      run: { mcp: { server: 'ncs', tool: 'ncs_search_units', args: {
        items: '{{inputs.items}}', summary: 'Found {{inputs.limit}} for {{inputs.keyword}}',
        filter: { region: '{{inputs.region}}', limits: ['{{inputs.limit}}', { label: 'up to {{inputs.limit}}' }] },
      } } },
    })).toEqual({ ok: true });
    const mixed = validateWorkflow({ name: 'plugin-ncs-mixed', description: 'mixed inputs', nodes: [
      { id: 'n1', kind: 'demo:ncs-mixed', inputs: { items: ['one', 'two'], limit: 5, keyword: '재시도 정책', region: '서울' } },
    ] });
    const mixedRun = await runWorkflowToCompletion({
      workflow: mixed.workflow!, arguments: '', artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
    }, realBash);
    expect(requests[1]).toMatchObject({ params: { arguments: {
      items: ['one', 'two'], summary: 'Found 5 for 재시도 정책',
      filter: { region: '서울', limits: [5, { label: 'up to 5' }] },
    } } });
    expect(mixedRun.outputs.n1?.ok).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('registered MCP kind surfaces tool-level error text as node failure', async () => {
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { id: number };
    return Response.json({ jsonrpc: '2.0', id: body.id, result: {
      isError: true, content: [{ type: 'text', text: 'NCS lookup failed' }],
    } });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  setResolveDaemonEndpointForTest(() => ({ baseUrl: base, healthUrl: `${base}/v1/health`, pwaUrl: `${base}/app/`, source: 'registry' }));
  try {
    expect(registerNodeKind({
      graph: 'workflow', kind: 'demo:ncs-failure', plugin: 'demo', description: 'ncs failure', core: false,
      run: { mcp: { server: 'ncs', tool: 'ncs_search_units' } },
    })).toEqual({ ok: true });
    const parsed = validateWorkflow({ name: 'plugin-ncs-failure', description: 'lookup error', nodes: [
      { id: 'n1', kind: 'demo:ncs-failure', inputs: {} },
    ] });
    const run = await runWorkflowToCompletion({
      workflow: parsed.workflow!, arguments: '', artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
    }, realBash);
    expect(run.outputs.n1?.ok).toBe(false);
    expect(run.outputs.n1?.error).toContain('NCS lookup failed');
  } finally {
    server.stop(true);
  }
});

test('MCP kind fails explicitly for image or structured results instead of silently discarding them', async () => {
  let result: unknown = { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const body = await request.json() as { id: number };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  setResolveDaemonEndpointForTest(() => ({ baseUrl: base, healthUrl: `${base}/v1/health`, pwaUrl: `${base}/app/`, source: 'registry' }));
  try {
    expect(registerNodeKind({
      graph: 'workflow', kind: 'demo:ncs-nontext', plugin: 'demo', description: 'nontext', core: false,
      run: { mcp: { server: 'ncs', tool: 'ncs_search_units' } },
    })).toEqual({ ok: true });
    const parsed = validateWorkflow({ name: 'plugin-ncs-nontext', description: 'nontext', nodes: [
      { id: 'n1', kind: 'demo:ncs-nontext', inputs: {} },
    ] });
    expect(parsed.ok).toBe(true);
    for (const unsupported of [
      { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] },
      { content: [{ type: 'text', text: 'partial' }, { type: 'image', text: 'image metadata', data: 'aGVsbG8=' }] },
      { structuredContent: { units: ['one'] } },
    ]) {
      result = unsupported;
      const run = await runWorkflowToCompletion({
        workflow: parsed.workflow!, arguments: '', artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
      }, realBash);
      expect(run.outputs.n1?.ok).toBe(false);
      expect(run.outputs.n1?.error).toContain('unsupported MCP tool result');
    }
  } finally {
    server.stop(true);
  }
});

test('registered bash kind runs through the real shell with the input quoted', async () => {
  expect(registerNodeKind({
    graph: 'workflow', kind: 'demo:echo', plugin: 'demo', description: 'echo', core: false,
    run: { bash: 'printf %s {{inputs.msg}}' },
  }).ok).toBe(true);
  const parsed = validateWorkflow({
    name: 'plugin-echo',
    description: 'echo one input',
    nodes: [{ id: 'n1', kind: 'demo:echo', inputs: { msg: 'a b; echo PWNED' } }],
  });
  expect(parsed.ok).toBe(true);
  const run = await runWorkflowToCompletion({
    workflow: parsed.workflow!,
    arguments: '',
    artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
  }, realBash);
  expect(run.ok).toBe(true);
  expect(run.outputs.n1?.output).toBe('a b; echo PWNED');
  expect(String(run.outputs.n1?.output).split('\n').some((line) => line === 'PWNED')).toBe(false);
});

test('unknown kind and a missing required input are rejected before execution', () => {
  expect(registerNodeKind({
    graph: 'workflow', kind: 'demo:needs-msg', plugin: 'demo', description: 'needs msg', core: false,
    schema: { type: 'object', required: ['msg'] },
    run: { bash: 'printf %s {{inputs.msg}}' },
  }).ok).toBe(true);
  const unknown = validateWorkflow({
    name: 'plugin-unknown',
    description: 'unregistered kind',
    nodes: [{ id: 'n1', kind: 'demo:nope', inputs: {} }],
  });
  expect(unknown.ok).toBe(false);
  expect(unknown.issues.some((issue) => issue.message === "unknown node kind 'demo:nope'")).toBe(true);
  const missing = validateWorkflow({
    name: 'plugin-missing',
    description: 'required input absent',
    nodes: [{ id: 'n1', kind: 'demo:needs-msg', inputs: {} }],
  });
  expect(missing.ok).toBe(false);
  expect(missing.issues.some((issue) => issue.message.includes('msg'))).toBe(true);
});

test('a template that is not inputs.* is an error, not left in place', async () => {
  expect(registerNodeKind({
    graph: 'workflow', kind: 'demo:bad-template', plugin: 'demo', description: 'bad template', core: false,
    run: { bash: 'printf %s {{env.secret}}' },
  }).ok).toBe(true);
  const parsed = validateWorkflow({
    name: 'plugin-bad-template',
    description: 'unsupported placeholder',
    nodes: [{ id: 'n1', kind: 'demo:bad-template', inputs: {} }],
  });
  const run = await runWorkflowToCompletion({
    workflow: parsed.workflow!,
    arguments: '',
    artifactsDir: mkdtempSync(join(tmpdir(), 'wf-plugin-kind-')),
  }, realBash);
  expect(run.ok).toBe(false);
  expect(run.outputs.n1?.error).toContain('{{env.secret}}');
});
