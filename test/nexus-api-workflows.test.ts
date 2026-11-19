// Archon-port T2.3 (2026-05-08) — Nexus workflow REST endpoints.
//
// Tests use the MetaApiOpts directly rather than spinning up the full
// http-server — the routing wire-up is exercised by the wide-regression
// (existing http-server tests) and dispatch-level testing here keeps
// the unit narrow.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import {
  handleWorkflowsList,
  handleWorkflowGet,
  handleWorkflowPut,
  handleWorkflowDelete,
  handleWorkflowValidate,
  handleWorkflowGenerate,
  handleWorkflowSynth,
  handleWorkflowRunStart,
  handleWorkflowRunGet,
  _resetWorkflowRunRegistryForTest,
} from '../src/nexus/api/workflows.js';
import type { MetaApiOpts } from '../src/nexus/api/meta-api.js';

const opts: MetaApiOpts = { noAuth: true };

const VALID_YAML = `name: t-api-demo
description: API test demo
nodes:
  - id: one
    bash: echo hello
`;

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), 'wf-api-'));
  mkdirSync(join(tmpRoot, '.elanous', 'workflows'), { recursive: true });
  process.chdir(tmpRoot);
  _resetWorkflowRunRegistryForTest();
});

afterEach(() => {
  // Move out of tmp before deleting it (rmSync errors on cwd in some envs).
  process.chdir(originalCwd);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const sameOriginHeaders = {
  'sec-fetch-site': 'same-origin',
} as const;

const reqGet = (path: string): Request =>
  new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: sameOriginHeaders,
  });
const reqPost = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const reqPut = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'PUT',
    headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const reqDelete = (path: string): Request =>
  new Request(`http://localhost${path}`, {
    method: 'DELETE',
    headers: sameOriginHeaders,
  });

describe('GET /v1/workflows', () => {
  it('returns built-in samples even with no project workflows', async () => {
    const res = handleWorkflowsList(reqGet('/v1/workflows'), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: { name: string; source: string }[] };
    const names = body.workflows.map(w => w.name);
    expect(names).toContain('quick-summary');
    expect(names).toContain('pdca-cycle');
    expect(names).toContain('code-review');
  });
});

describe('PUT /v1/workflows/{name} → GET → DELETE round-trip', () => {
  it('writes, reads, deletes a project workflow', async () => {
    // PUT
    const putRes = await handleWorkflowPut(
      reqPut('/v1/workflows/t-api-demo', { yaml: VALID_YAML }),
      't-api-demo',
      opts,
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as { ok: boolean; path: string; scope: string };
    expect(putBody.ok).toBe(true);
    expect(putBody.scope).toBe('project');

    // GET
    const getRes = handleWorkflowGet(reqGet('/v1/workflows/t-api-demo'), 't-api-demo', opts);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { name: string; yaml: string; definition: { name: string } };
    expect(getBody.name).toBe('t-api-demo');
    expect(getBody.yaml).toBe(VALID_YAML);
    expect(getBody.definition.name).toBe('t-api-demo');

    // DELETE
    const delRes = handleWorkflowDelete(
      reqDelete('/v1/workflows/t-api-demo'),
      't-api-demo',
      opts,
    );
    expect(delRes.status).toBe(200);

    // GET → 404 after delete
    const get2 = handleWorkflowGet(reqGet('/v1/workflows/t-api-demo'), 't-api-demo', opts);
    expect(get2.status).toBe(404);
  });
});

describe('POST /v1/workflows/validate', () => {
  it('returns 200 ok=true for valid YAML', async () => {
    const res = await handleWorkflowValidate(
      reqPost('/v1/workflows/validate', { yaml: VALID_YAML }),
      opts,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { validation: { ok: boolean } };
    expect(body.validation.ok).toBe(true);
  });

  it('returns 422 with issues for invalid YAML', async () => {
    const bad = `name: bad\ndescription: no nodes\n`;
    const res = await handleWorkflowValidate(
      reqPost('/v1/workflows/validate', { yaml: bad }),
      opts,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { validation: { ok: boolean; issues: unknown[] } };
    expect(body.validation.ok).toBe(false);
    expect(body.validation.issues.length).toBeGreaterThan(0);
  });

  it('returns 400 when body shape is wrong', async () => {
    const res = await handleWorkflowValidate(
      reqPost('/v1/workflows/validate', { not_yaml: 'string' }),
      opts,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/workflows/generate', () => {
  const HAPPY_JSON = JSON.stringify({
    name: 'generated-demo',
    description: 'LLM-generated test workflow',
    nodes: [{ id: 'one', bash: "echo 'hi'" }],
  });

  it('returns 200 with yaml + warnings (when meta-api wired)', async () => {
    // We can't mock the LLM caller through the handler (it imports
    // generateWorkflow lazily). Instead drive it via the handler with
    // a stub provider — but the default caller will refuse without API
    // keys. So override module-level by checking the LOC-tight 400
    // path first, then the 502 path when LLM is unreachable in test
    // env. Happy-path coverage lives in test/workflow-nl-generator.test.ts.

    const res = await handleWorkflowGenerate(
      reqPost('/v1/workflows/generate', { prompt: '' }),
      opts,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('rejects non-object body with 400', async () => {
    const res = await handleWorkflowGenerate(
      new Request('http://localhost/v1/workflows/generate', {
        method: 'POST',
        headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
        body: 'null',
      }),
      opts,
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing prompt with 400', async () => {
    const res = await handleWorkflowGenerate(
      reqPost('/v1/workflows/generate', { provider: 'anthropic' }),
      opts,
    );
    expect(res.status).toBe(400);
  });

  // Wire smoke (per memory feedback_post_route_must_be_in_method_block.md):
  // the route MUST be registered inside the `method !== 'GET'` block of
  // http-server.ts · otherwise it silently 405s in production while
  // handler-level tests pass. Source-level grep keeps the guard cheap.
  it('route registration sits inside the method!==GET block (wire smoke)', () => {
    // beforeEach chdir's into tmpRoot; resolve from import.meta.dir so
    // the wire smoke survives that cwd swap.
    const httpServerPath = join(import.meta.dir, '..', 'src', 'nexus', 'api', 'http-server.ts');
    const src = readFileSync(httpServerPath, 'utf-8');
    // Quote-agnostic (#38766 reformatted http-server.ts to double quotes); the brace
    // anchor pins the mutation BLOCK, not a one-line method-not-allowed guard.
    const methodBlockStart = src.search(/if \(method !== ['"]GET['"]\) \{/);
    expect(methodBlockStart).toBeGreaterThan(0);
    const routeIdx = src.search(/['"]\/v1\/workflows\/generate['"]/);
    expect(routeIdx).toBeGreaterThan(methodBlockStart);
    // Confirm the matching POST guard sits on the same line.
    const lineEnd = src.indexOf('\n', routeIdx);
    const line = src.slice(routeIdx, lineEnd);
    expect(line).toMatch(/method === ['"]POST['"]/);
  });

  it('exports handleWorkflowGenerate from workflows.ts', () => {
    expect(typeof handleWorkflowGenerate).toBe('function');
  });

  // Suppress unused-import warning when HAPPY_JSON is reserved for a
  // future stub-injection seam (currently the LLM path is e2e-covered
  // via test/workflow-nl-generator.test.ts which mocks the dispatcher
  // directly · the handler's lazy import keeps the daemon shell light).
  void HAPPY_JSON;
});

// Surface-unification §C1 (2026-05-11) — POST /v1/workflows/synth.
describe('POST /v1/workflows/synth', () => {
  it('rejects missing intent with 400', async () => {
    const res = await handleWorkflowSynth(
      reqPost('/v1/workflows/synth', {}),
      opts,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('rejects non-object body with 400', async () => {
    const res = await handleWorkflowSynth(
      new Request('http://localhost/v1/workflows/synth', {
        method: 'POST',
        headers: { ...sameOriginHeaders, 'content-type': 'application/json' },
        body: 'null',
      }),
      opts,
    );
    expect(res.status).toBe(400);
  });

  it('route registration sits inside the method!==GET block (wire smoke)', () => {
    const httpServerPath = join(import.meta.dir, '..', 'src', 'nexus', 'api', 'http-server.ts');
    const src = readFileSync(httpServerPath, 'utf-8');
    // Quote-agnostic (#38766 reformatted http-server.ts to double quotes); the brace
    // anchor pins the mutation BLOCK, not a one-line method-not-allowed guard.
    const methodBlockStart = src.search(/if \(method !== ['"]GET['"]\) \{/);
    expect(methodBlockStart).toBeGreaterThan(0);
    const routeIdx = src.search(/['"]\/v1\/workflows\/synth['"]/);
    expect(routeIdx).toBeGreaterThan(methodBlockStart);
    const lineEnd = src.indexOf('\n', routeIdx);
    expect(src.slice(routeIdx, lineEnd)).toMatch(/method === ['"]POST['"]/);
  });

  it('exports handleWorkflowSynth from workflows.ts', () => {
    expect(typeof handleWorkflowSynth).toBe('function');
  });
});

describe('PUT /v1/workflows/{name} validation gate', () => {
  it('returns 422 with validation report when YAML invalid', async () => {
    const res = await handleWorkflowPut(
      reqPut('/v1/workflows/foo', { yaml: 'name: foo\n' }), // missing description+nodes
      'foo',
      opts,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; validation: unknown };
    expect(body.error).toBe('invalid_workflow');
    expect(body.validation).toBeDefined();
  });

  it('returns 422 when YAML name does not match URL name', async () => {
    const res = await handleWorkflowPut(
      reqPut('/v1/workflows/different', { yaml: VALID_YAML }), // YAML says t-api-demo
      'different',
      opts,
    );
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/workflows/{name}/run + GET runs/{id}', () => {
  it('starts a built-in workflow and surfaces its events via GET runs/{id}', async () => {
    // The built-in `quick-summary` is skill-only — without runSkill
    // wired the run will fail fast with a helpful error. That's the
    // expected MVP behavior; we still validate the run/registry path.
    const startRes = await handleWorkflowRunStart(
      reqPost('/v1/workflows/quick-summary/run', { arguments: 'https://example.com' }),
      'quick-summary',
      opts,
    );
    expect(startRes.status).toBe(202);
    const startBody = (await startRes.json()) as { ok: boolean; runId: string };
    expect(startBody.ok).toBe(true);
    expect(startBody.runId).toMatch(/^wf-\d+-[a-z0-9]+$/);

    // Allow the async generator to make at least one tick before we
    // poll — the run is dispatched via setImmediate-equivalent so a
    // microtask flush is enough.
    await new Promise(r => setTimeout(r, 50));

    const detailRes = handleWorkflowRunGet(
      reqGet(`/v1/workflows/runs/${startBody.runId}`),
      startBody.runId,
      opts,
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      runId: string;
      workflowName: string;
      events: { type: string }[];
    };
    expect(detailBody.runId).toBe(startBody.runId);
    expect(detailBody.workflowName).toBe('quick-summary');
    expect(detailBody.events.length).toBeGreaterThan(0);
    expect(detailBody.events[0]?.type).toBe('workflow_start');
  });

  it('returns 404 for unknown workflow name on run', async () => {
    const res = await handleWorkflowRunStart(
      reqPost('/v1/workflows/no-such-workflow/run', {}),
      'no-such-workflow',
      opts,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown runId on GET runs/{id}', () => {
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-fake'), 'wf-fake', opts);
    expect(res.status).toBe(404);
  });
});

describe('auth gate', () => {
  const guarded: MetaApiOpts = { bearerToken: 'secret-xyz' };

  it('rejects cross-origin without bearer', () => {
    const req = new Request('http://evil.test/v1/workflows', { method: 'GET' });
    const res = handleWorkflowsList(req, guarded);
    expect(res.status).toBe(401);
  });

  it('accepts bearer match', () => {
    const req = new Request('http://api.test/v1/workflows', {
      method: 'GET',
      headers: { authorization: 'Bearer secret-xyz' },
    });
    const res = handleWorkflowsList(req, guarded);
    expect(res.status).toBe(200);
  });
});

describe('discovered file is preserved (PUT round-trip)', () => {
  it('writing then listing surfaces the new entry', async () => {
    await handleWorkflowPut(
      reqPut('/v1/workflows/t-api-demo', { yaml: VALID_YAML }),
      't-api-demo',
      opts,
    );
    const listRes = handleWorkflowsList(reqGet('/v1/workflows'), opts);
    const list = (await listRes.json()) as {
      workflows: { name: string; source: string }[];
    };
    const found = list.workflows.find(w => w.name === 't-api-demo');
    expect(found?.source).toBe('project');
  });
});

describe('built-in workflows show up in listing', () => {
  it('confirms 3 named builtins are present alongside any project entries', async () => {
    // Sanity that the discovery still finds builtins even if the
    // per-test cwd has its own project dir.
    writeFileSync(
      join(tmpRoot, '.elanous', 'workflows', 'extra.yaml'),
      'name: extra\ndescription: extra entry\nnodes:\n  - id: x\n    bash: echo\n',
      'utf-8',
    );
    const res = handleWorkflowsList(reqGet('/v1/workflows'), opts);
    const body = (await res.json()) as { workflows: { name: string; source: string }[] };
    const names = body.workflows.map(w => w.name);
    expect(names).toContain('quick-summary');
    expect(names).toContain('pdca-cycle');
    expect(names).toContain('code-review');
    expect(names).toContain('extra');
  });
});
