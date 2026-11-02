import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { buildRunTree, parseLiveRunPods, registerRunsTreeCommands, runTreeRecords } from './runs-tree-cli.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';

const row = (event: string, data: Record<string, unknown>, id: number): LogStoreRow => ({
  id, ts: `2026-11-01T19:00:0${id}Z`, ts_ms: id, level: 'info', instance: 'test', surface: 'cli',
  category: 'run.fp', event, session_id: null, trace_id: null, data: JSON.stringify(data),
});

describe('runs tree', () => {
  test('joins persisted parent fingerprints to live child Pods by run id and host labels', () => {
    const records = runTreeRecords([
      row('begin', { fp: 'fp_parent', runId: 'run-123', entrance: 'harness-say', host: 'mbp' }, 1),
    ]);
    const pods = parseLiveRunPods(JSON.stringify({ items: [{
      metadata: {
        name: 'ta-child', namespace: 'harness',
        labels: { 'elanous.ai/parent': 'run-123', 'elanous.ai/launch-host': 'node-b', 'job-name': 'ta-job' },
        annotations: { 'elanous.ai/fp': 'fp_child', 'elanous.ai/parent': 'run-123' },
      },
      spec: { nodeName: 'worker-1' }, status: { phase: 'Running' },
    }] }), 'node-b');
    const tree = buildRunTree(records, pods);
    expect(tree).toHaveLength(2);
    expect(tree[0]?.children).toEqual(['pod:node-b:harness/ta-child']);
    expect(tree[1]).toMatchObject({ kind: 'pod', fp: 'fp_child', parentFp: 'fp_parent', host: 'node-b', status: 'running' });
  });

  test('marks a Pod with unresolved parent as orphan and queries live Pods only when requested', async () => {
    const [pod] = parseLiveRunPods(JSON.stringify({ items: [{
      metadata: { name: 'orphan', namespace: 'harness', labels: { 'elanous.ai/parent': 'missing', 'elanous.ai/launch-host': 'gcp1' }, annotations: { 'elanous.ai/fp': 'fp_child' } },
      status: { phase: 'Pending' },
    }] }), 'gcp1');
    expect(buildRunTree([], pod ? [pod] : [])[0]).toMatchObject({ orphan: true, host: 'gcp1', status: 'pending' });
    expect(buildRunTree([{ fp: 'fp_child', runId: 'child-run', parentRunId: 'missing' }], pod ? [pod] : [])[0]).toMatchObject({ orphan: true, fp: 'fp_child' });
    expect(buildRunTree([{ fp: 'fp_child', runId: 'child-run', parentRunId: 'missing' }], [{ ...pod!, parentRunId: undefined, parentLabel: undefined }])[0]).toMatchObject({ orphan: true, fp: 'fp_child' });
    const [metadataLessPod] = parseLiveRunPods(JSON.stringify({ items: [{
      metadata: { name: 'child', namespace: 'harness', annotations: { 'elanous.ai/fp': 'fp_child' } }, status: { phase: 'Running' },
    }] }), 'node-b');
    expect(metadataLessPod).toBeDefined();
    expect(buildRunTree([
      { fp: 'fp_parent', runId: 'parent-run' },
      { fp: 'fp_child', runId: 'child-run', parentRunId: 'parent-run' },
    ], [metadataLessPod!]).find((node) => node.fp === 'fp_child')).toMatchObject({ orphan: false, parentFp: 'fp_parent' });
    expect(() => parseLiveRunPods('{bad json', 'gcp1')).toThrow();

    const program = new Command();
    let args: readonly string[] = [];
    let output = '';
    registerRunsTreeCommands(program, {
      readRows: () => [row('begin', { fp: 'fp_parent', runId: 'run-123', entrance: 'ta', host: 'mbp' }, 1)],
      kubectl: (nextArgs) => { args = nextArgs; return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'ta-child', namespace: 'harness', labels: { 'elanous.ai/parent': 'run-123', 'elanous.ai/launch-host': 'node-b' }, annotations: { 'elanous.ai/fp': 'fp_child', 'elanous.ai/run': 'child-run', 'elanous.ai/parent': 'run-123' } }, spec: { nodeName: 'worker-1' }, status: { phase: 'Running' } }] }), stderr: '' }; },
      out: (text) => { output = text; },
    });
    await program.parseAsync(['runs', 'tree', 'fp_parent', '--host', 'node-b', '--json'], { from: 'user' });
    expect(args).toEqual(['--context', 'node-b', 'get', 'pods', '--all-namespaces', '-l', 'elanous.ai/parent', '-o', 'json']);
    const result = JSON.parse(output) as { nodes: Array<{ fp?: string; node?: string; children: string[] }> };
    expect(result.nodes.map((node) => node.fp)).toEqual(['fp_parent', 'fp_child']);
    expect(result.nodes[1]).toMatchObject({ fp: 'fp_child', node: 'worker-1' });
    expect(result.nodes.flatMap((node) => node.children).every((id) => result.nodes.some((node) => `run:${node.fp}` === id || id === 'pod:node-b:harness/ta-child'))).toBe(true);

    const basic = new Command();
    let basicOutput = '';
    registerRunsTreeCommands(basic, {
      readRows: () => [row('begin', { fp: 'fp_parent', runId: 'run-123' }, 1)],
      kubectl: () => { throw new Error('default listing must not call kubectl'); },
      out: (text) => { basicOutput = text; },
    });
    await basic.parseAsync(['runs', 'tree'], { from: 'user' });
    expect(basicOutput).toContain('fp_parent');

    const nested = new Command();
    let nestedOutput = '';
    registerRunsTreeCommands(nested, {
      readRows: () => [
        row('begin', { fp: 'fp_root', runId: 'root-run' }, 1),
        row('begin', { fp: 'fp_child', runId: 'child-run', parentRunId: 'root-run' }, 2),
        row('begin', { fp: 'fp_grandchild', runId: 'grandchild-run', parentFp: 'fp_child' }, 3),
      ],
      out: (text) => { nestedOutput = text; },
    });
    await nested.parseAsync(['runs', 'tree', 'fp_child', '--json'], { from: 'user' });
    const nestedResult = JSON.parse(nestedOutput) as { nodes: Array<{ fp?: string; children: string[] }> };
    expect(nestedResult.nodes.map((node) => node.fp).sort()).toEqual(['fp_child', 'fp_grandchild', 'fp_root']);
    expect(nestedResult.nodes.flatMap((node) => node.children).every((id) => nestedResult.nodes.some((node) => `run:${node.fp}` === id))).toBe(true);
  });
});
