// Archon-port follow-up (2026-05-08) — disk-backed run history (Caveat #2).
//
// Validates that GET /v1/workflows/runs/{id} falls back to the disk
// record when the in-memory registry is empty (e.g. after a Nexus
// restart) and that GET /v1/workflows/runs lists every run.json on
// disk newest-first.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  _resetWorkflowRunRegistryForTest,
  _setWorkflowRunsRootForTest,
  handleWorkflowRunGet,
  handleWorkflowRunsList,
} from '../src/nexus/api/workflows.js';
import type { MetaApiOpts } from '../src/nexus/api/meta-api.js';
import { runWorkflowToCompletion, type NodeOutput, type WorkflowDefinition } from '../src/workflow-runtime/index.js';

const opts: MetaApiOpts = { noAuth: true };

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'wf-runs-home-'));
  // Override the disk root explicitly — `os.homedir()` caches its
  // first-call result so flipping process.env.HOME doesn't move the
  // path.
  _setWorkflowRunsRootForTest(join(tmpHome, '.elanous', 'workflows-runs'));
  _resetWorkflowRunRegistryForTest();
});

afterEach(() => {
  _setWorkflowRunsRootForTest(null);
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const reqGet = (path: string): Request =>
  new Request(`http://localhost${path}`, {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
  });

function seedRun(runId: string, body: {
  workflowName: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  ok?: boolean;
  outputs?: Record<string, { ok: boolean; output: unknown; durationMs: number }>;
  args?: string;
}): void {
  const runDir = join(tmpHome, '.elanous', 'workflows-runs', runId);
  mkdirSync(join(runDir, 'nodes'), { recursive: true });
  const runJson = {
    runId,
    workflowName: body.workflowName,
    arguments: body.args ?? '',
    startedAt: body.startedAt,
    status: body.status,
    ...(body.status !== 'running'
      ? { ok: body.ok ?? body.status === 'done', completedAt: body.startedAt + 100 }
      : {}),
    outputs: body.outputs ?? {},
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(runJson, null, 2), 'utf-8');
  for (const [k, v] of Object.entries(body.outputs ?? {})) {
    writeFileSync(join(runDir, 'nodes', `${k}.json`), JSON.stringify(v, null, 2), 'utf-8');
  }
}

describe('runWorkflow — resume output validation without the REST handler', () => {
  const workflow: WorkflowDefinition = {
    name: 'resume-guard', description: 'resume guard',
    nodes: [
      { id: 'a', set: { fields: { value: 'first' } } },
      { id: 'b', set: { fields: { value: 'second' } }, depends_on: ['a'] },
      { id: 'c', set: { fields: { value: 'third' } }, depends_on: ['b'] },
    ],
  };
  const deps = {
    callLLM: async () => '',
    runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };

  it('fails instead of emitting workflow_done when previousOutputs is absent or missing an upstream node', async () => {
    const incomplete: Array<Record<string, NodeOutput> | undefined> = [
      undefined, {}, { a: { ok: true, output: 'first', durationMs: 0 } },
    ];
    for (const [index, previousOutputs] of incomplete.entries()) {
      const runDir = join(tmpHome, `resume-${index}`);
      const result = await runWorkflowToCompletion({
        workflow, arguments: '', fromNode: 'c', mode: 'from',
        ...(previousOutputs ? { previousOutputs } : {}),
        runDir,
      }, deps);
      expect(result.ok).toBe(false);
      expect(result.outputs).toEqual({});
      expect(result.events.map(event => event.type)).toEqual(['workflow_start', 'workflow_failed']);
      expect(result.events[1]).toEqual({
        type: 'workflow_failed', error: 'source run missing upstream outputs', partial: {}, mode: 'from',
      });
      const persisted = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
      expect(persisted.status).toBe('failed');
      expect(persisted.error).toBe('source run missing upstream outputs');
    }
  });

  it('resumes when all upstream outputs are present', async () => {
    const result = await runWorkflowToCompletion({
      workflow, arguments: '', fromNode: 'c', mode: 'from', artifactsDir: tmpHome,
      previousOutputs: {
        a: { ok: true, output: 'first', durationMs: 0 },
        b: { ok: true, output: 'second', durationMs: 0 },
      },
    }, deps);
    expect(result.ok).toBe(true);
    expect(result.events.filter(event => event.type === 'node_start').map(event => event.nodeId)).toEqual(['c']);
    expect(Object.keys(result.outputs)).toEqual(['a', 'b', 'c']);
  });
});

describe('GET /v1/workflows/runs/<id> — disk fallback (Caveat #2)', () => {
  it('returns the run when only on disk (cache miss)', async () => {
    seedRun('wf-disk-001', {
      workflowName: 'quick-summary',
      status: 'done',
      startedAt: 1_700_000_000_000,
      outputs: {
        echo: { ok: true, output: 'hello', durationMs: 5 },
      },
      args: 'arg-1',
    });

    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-disk-001'), 'wf-disk-001', opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string;
      workflowName: string;
      ok: boolean;
      events: { type: string; nodeId?: string }[];
      outputs: Record<string, unknown>;
    };
    expect(body.runId).toBe('wf-disk-001');
    expect(body.workflowName).toBe('quick-summary');
    expect(body.ok).toBe(true);
    expect(body.outputs).toEqual({ echo: 'hello' });
    // Reconstructed events: workflow_start + node_done(s) + workflow_done
    expect(body.events[0]?.type).toBe('workflow_start');
    expect(body.events.some(e => e.type === 'node_done' && e.nodeId === 'echo')).toBe(true);
    expect(body.events[body.events.length - 1]?.type).toBe('workflow_done');
    expect(body).not.toHaveProperty('mode');
    expect(body.events.every(event => !('mode' in event))).toBe(true);
  });

  it('returns 404 when neither memory nor disk has the runId', () => {
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-ghost'), 'wf-ghost', opts);
    expect(res.status).toBe(404);
  });

  it('rejects path-traversal-y runIds', () => {
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/..foo'), '../foo', opts);
    // The disk loader rejects "../foo"; the route layer will too. Either
    // way the result is 404 (not_found) rather than reading outside the
    // workflows-runs root.
    expect(res.status).toBe(404);
  });

  it('reconstructs node_done events in execution order, not alphabetical', async () => {
    // Caught via 2026-05-08 dogfood: `confirm depends_on
    // [route-to-digest]` ran AFTER its upstream, but readdirSync(...).
    // sort() pushed `confirm.json` before `route-to-digest.json`
    // alphabetically. The fix iterates `parsed.outputs` (insertion
    // order = execution order) instead.
    seedRun('wf-order-001', {
      workflowName: 'quick-summary',
      status: 'done',
      startedAt: 1_700_000_010_000,
      // The executor writes outputs in topological order: 'route-to-
      // digest' first, then 'confirm'. We seed the same shape here.
      outputs: {
        'route-to-digest': { ok: true, output: 'summary-text', durationMs: 24000 },
        confirm: { ok: true, output: 'summary delivered', durationMs: 5 },
      },
    });
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-order-001'), 'wf-order-001', opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string; nodeId?: string }> };
    const nodeOrder = body.events
      .filter((e) => e.type === 'node_done')
      .map((e) => e.nodeId);
    expect(nodeOrder).toEqual(['route-to-digest', 'confirm']);
  });

  it('falls back to run.json outputs when a per-node file is missing', async () => {
    seedRun('wf-missing-node-001', {
      workflowName: 'partial',
      status: 'done',
      startedAt: 1_700_000_011_000,
      outputs: {
        a: { ok: true, output: 'A', durationMs: 1 },
      },
    });
    // Wipe the per-node file but leave run.json intact.
    const fs = await import('fs');
    fs.rmSync(join(tmpHome, '.elanous', 'workflows-runs', 'wf-missing-node-001', 'nodes', 'a.json'));
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-missing-node-001'), 'wf-missing-node-001', opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string; nodeId?: string; result?: { ok: boolean; output: unknown } }> };
    const aEvent = body.events.find((e) => e.type === 'node_done' && e.nodeId === 'a');
    expect(aEvent).toBeDefined();
    expect(aEvent?.result?.ok).toBe(true);
    expect(aEvent?.result?.output).toBe('A');
  });

  it('hydrates a failed run with status=failed and ok=false', async () => {
    seedRun('wf-fail-001', {
      workflowName: 'broken',
      status: 'failed',
      startedAt: 1_700_000_001_000,
      ok: false,
      outputs: {
        broken: { ok: false, output: '', durationMs: 1 },
      },
    });
    const res = handleWorkflowRunGet(reqGet('/v1/workflows/runs/wf-fail-001'), 'wf-fail-001', opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events: { type: string }[] };
    expect(body.ok).toBe(false);
    expect(body.events[body.events.length - 1]?.type).toBe('workflow_failed');
  });
});

describe('GET /v1/workflows/runs — disk listing (Caveat #2)', () => {
  it('returns empty list when no runs on disk', async () => {
    const res = handleWorkflowRunsList(reqGet('/v1/workflows/runs'), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it('lists every run newest-first by startedAt', async () => {
    // Use timestamps near `now` for the "running" entry so the
    // stale-detection (30 min threshold) doesn't promote it to
    // `orphaned`.
    const now = Date.now();
    seedRun('wf-old-001', { workflowName: 'a', status: 'done', startedAt: now - 200 });
    seedRun('wf-mid-002', { workflowName: 'b', status: 'failed', startedAt: now - 100, ok: false });
    seedRun('wf-new-003', { workflowName: 'c', status: 'running', startedAt: now - 50 });

    const res = handleWorkflowRunsList(reqGet('/v1/workflows/runs'), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { runId: string; status: string; workflowName: string }[];
    };
    expect(body.runs.map(r => r.runId)).toEqual(['wf-new-003', 'wf-mid-002', 'wf-old-001']);
    expect(body.runs[0].status).toBe('running');
    expect(body.runs[1].status).toBe('failed');
    expect(body.runs[2].status).toBe('done');
  });

  it('promotes a stale running run to orphaned (>30 min old)', async () => {
    const ago = Date.now() - 60 * 60 * 1000; // 1h ago
    seedRun('wf-old-running-001', {
      workflowName: 'never-finished',
      status: 'running',
      startedAt: ago,
    });
    seedRun('wf-fresh-running-002', {
      workflowName: 'recent',
      status: 'running',
      startedAt: Date.now() - 60 * 1000,  // 1 min ago — still legit
    });
    const res = handleWorkflowRunsList(reqGet('/v1/workflows/runs'), opts);
    const body = (await res.json()) as { runs: { runId: string; status: string }[] };
    const old = body.runs.find((r) => r.runId === 'wf-old-running-001');
    const fresh = body.runs.find((r) => r.runId === 'wf-fresh-running-002');
    expect(old?.status).toBe('orphaned');
    expect(fresh?.status).toBe('running');
  });

  it('skips dirs with no run.json', async () => {
    seedRun('wf-good-001', { workflowName: 'a', status: 'done', startedAt: 100 });
    // Stray empty dir — should NOT appear in the listing.
    mkdirSync(join(tmpHome, '.elanous', 'workflows-runs', 'wf-empty-002'), { recursive: true });
    const res = handleWorkflowRunsList(reqGet('/v1/workflows/runs'), opts);
    const body = (await res.json()) as { runs: { runId: string }[] };
    expect(body.runs.map(r => r.runId)).toEqual(['wf-good-001']);
  });
});
