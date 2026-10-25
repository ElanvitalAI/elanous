import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideDraftClose } from './draft-close-node.js';
import { flattenGraphTemplate } from '../../src/self-implement/graph-unit-resolver.js';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml.js';
import { runGraph } from '../../src/graph-runner/runner.js';

const root = join(import.meta.dir, '../..');
const head = 'a'.repeat(40);
const mainSha = 'b'.repeat(40);

function input(overrides: Record<string, unknown> = {}) {
  return {
    mapRunId: 'map-test-1',
    snapshotTime: '2026-10-24T00:00:00.000Z',
    inventoryComplete: true,
    mainSha,
    item: {
      repository: 'ElanvitalAI/elanous',
      pr: 123,
      headOid: head,
      state: 'OPEN',
      isDraft: true,
      title: 'query-only draft',
      branch: 'self-impl/goalid-a1b2-title-12345678-rabcd',
      labels: ['elanous:from-ux'],
      body: '칸: DRAFT-CLOSE-RECIPE\n카드: ta-20261024-abcd12',
      createdAt: '2026-10-20T00:00:00.000Z',
      lastCommitAt: '2026-10-21T00:00:00.000Z',
      changedFiles: ['src/example.ts'],
      changedFilesComplete: true,
      latestFileChanges: { 'src/example.ts': '2026-10-21T00:00:00.000Z' },
      liveBranches: [],
      runStatus: 'failed',
      finalRunResult: true,
      openDraftsComplete: true,
      mergedTwinsComplete: true,
      openDrafts: [],
      mergedTwins: [],
      ...overrides,
    },
  };
}

describe('draft-close deterministic recipe', () => {
  test('routes an exact-head GLM mf0 and changed-gate-zero item to H2 harvest handoff', () => {
    const result = decideDraftClose(input({ reviewGate: {
      headOid: head, gateHeadOid: head, review: 'warn', mustFix: [], gate: 'pass', introduced: 0,
    } }));
    expect(result.outcome).toBe('harvest');
    expect(result.result).toMatchObject({ kind: 'harvest', pr: 123, headOid: head, writes: [],
      handoff: ['merge-origin-main-into-branch', 'resolve-conflicts-on-same-branch', 'changed-gate-introduced-0',
        'GLM-review-same-head-mustFix-0', 'land-enqueue-without-gate-summary'] });
  });

  test('protected labels outrank a harvestable label and never produce a close candidate', () => {
    const result = decideDraftClose(input({ labels: ['elanous:running', 'elanous:harvestable'] }));
    expect(result).toMatchObject({ outcome: 'hold', result: { kind: 'hold', classification: 'protected', protectedReason: 'elanous:running' } });
  });

  test('a harvestable label cannot route to harvest without same-head review and gate evidence', () => {
    const result = decideDraftClose(input({ labels: ['elanous:from-ux', 'elanous:harvestable'] }));
    expect(result).toMatchObject({ outcome: 'close-candidate', result: { kind: 'close-candidate', classification: 'stale' } });
  });

  test('a gate without its explicit head cannot be assumed to match the review head', () => {
    const result = decideDraftClose(input({ reviewGate: { headOid: head, review: 'warn', mustFix: [], gate: 'pass', introduced: 0 } }));
    expect(result).toMatchObject({ outcome: 'close-candidate', result: { kind: 'close-candidate', classification: 'stale' } });
  });

  test('uses decideDraft deterministically and emits a reduce-only close result row', () => {
    const result = decideDraftClose(input());
    expect(result.outcome).toBe('close-candidate');
    expect(result.result).toMatchObject({ kind: 'close-candidate', classification: 'stale', reason: expect.stringContaining('stale-ended-run'),
      pr: 123, headOid: head, writeBoundary: 'reduce-only', writes: [] });
  });

  test('an incomplete inventory suppresses candidate rows and fails closed', () => {
    const result = decideDraftClose({ ...input(), inventoryComplete: false });
    expect(result).toMatchObject({ outcome: 'hold', result: { kind: 'hold', inventoryComplete: false, pr: null, rowsSuppressed: true } });
  });

  test('a missing last-commit timestamp holds as human and preserves PR/head identity', () => {
    const result = decideDraftClose(input({ lastCommitAt: '' }));
    expect(result).toMatchObject({ outcome: 'hold', result: { kind: 'hold', classification: 'human', pr: 123, headOid: head } });
  });

  test('conflicting inventory completeness claims fail closed', () => {
    const result = decideDraftClose({ ...input(), inventory: { complete: false } });
    expect(result).toMatchObject({ outcome: 'hold', result: { kind: 'hold', rowsSuppressed: true,
      reason: 'conflicting inventory completeness claims' } });
  });

  test('an incomplete merged-peer snapshot cannot become a close candidate', () => {
    const result = decideDraftClose(input({ mergedTwinsComplete: false }));
    expect(result).toMatchObject({ outcome: 'hold', result: { kind: 'hold', classification: 'human' } });
  });

  test('the published graph parses and contains separate harvest, close-candidate, and hold routes', () => {
    const graphPath = join(root, 'graphs/work/draft-close.yaml');
    const parsed = parseGraphTemplateYaml(readFileSync(graphPath, 'utf8'), graphPath);
    expect(parsed.errors).toEqual([]);
    const flat = flattenGraphTemplate(parsed.template!, graphPath);
    const decision = flat.edges.find((edge) => edge.from === 'decide');
    expect(decision?.map).toEqual({ harvest: 'harvest', 'close-candidate': 'close-candidate', hold: 'hold', failed: 'failed' });
  });

  test('runner loads all four recipe commands and dry-runs five isolated fixture rows without writes', async () => {
    const graphPath = join(root, 'graphs/work/draft-close.yaml');
    const stateRoot = mkdtempSync(join(tmpdir(), 'draft-close-c1-'));
    const retainLedger = process.env.DRAFT_CLOSE_KEEP_FIXTURE_LEDGER === '1';
    const base = input().item as Record<string, unknown>;
    const fixtures: Array<{ id: string; input: Record<string, unknown>; node: string; kind: string; classification: string }> = [
      { id: 'protected', input: input({ labels: ['elanous:running'] }), node: 'hold', kind: 'hold', classification: 'protected' },
      { id: 'twin', input: input({ mergedTwins: [{ number: 234, title: 'query-only draft', branch: base.branch,
        body: base.body, changedFiles: ['src/example.ts'], mergedAt: '2026-10-22T00:00:00.000Z' }] }),
        node: 'close-candidate', kind: 'close-candidate', classification: 'superseded' },
      { id: 'harvest', input: input({ reviewGate: { headOid: head, gateHeadOid: head, review: 'warn', mustFix: [], gate: 'pass', introduced: 0 } }), node: 'harvest', kind: 'harvest', classification: 'harvest' },
      { id: 'stale', input: input(), node: 'close-candidate', kind: 'close-candidate', classification: 'stale' },
      { id: 'human', input: input({ lastCommitAt: '2026-10-24T00:00:00.000Z', runStatus: 'unknown', liveBranches: [base.branch], finalRunResult: undefined }), node: 'hold', kind: 'hold', classification: 'keep' },
    ];
    try {
      const rows: Array<{ fixture: string; kind: string; classification: string; writes: unknown }> = [];
      for (const fixture of fixtures) {
        const run = await runGraph(graphPath, { runId: `c1-${fixture.id}`, input: fixture.input, dryRun: true, deps: { root: stateRoot } });
        expect(run.status).toBe('done');
        expect(run.path).toEqual(['decide', fixture.node, 'done']);
        const emitter = run.nodes.find((candidate) => candidate.nodeId === fixture.node)!;
        const emitted = JSON.parse(emitter.output as string) as { result: { kind: string; classification: string; writes: unknown } };
        expect(emitted.result).toMatchObject({ kind: fixture.kind, classification: fixture.classification, writes: [] });
        rows.push({ fixture: fixture.id, kind: emitted.result.kind, classification: emitted.result.classification, writes: emitted.result.writes });
      }
      expect(rows).toHaveLength(5);
      expect(rows.every((entry) => Array.isArray(entry.writes) && entry.writes.length === 0)).toBe(true);
      expect(readdirSync(stateRoot)).toEqual(['graph-runs']);
      const ledgerDir = join(stateRoot, 'graph-runs', 'work-draft-close');
      expect(readdirSync(ledgerDir).filter((name) => name.endsWith('.json'))).toHaveLength(5);
      console.log(`[draft-close-c1-fixtures] ${JSON.stringify(rows)}`);
      if (retainLedger) console.log(`[draft-close-c1-ledger-root] ${stateRoot}`);
    } finally {
      if (!retainLedger) rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
