import { expect, test } from 'bun:test';
import { execFileSync, type spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUnit, runGraph } from '../../src/graph-runner/runner';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml';
import { observeLandPolicyDrift, runLandEnqueue, type LandTrainObservation } from '../../scripts/graph-units/land-enqueue';

const unitPath = join(import.meta.dir, 'land', 'land.yaml');
const head = 'a'.repeat(40);

test('land@1 parses and resolves with the journey envelope and four named exits', () => {
  const unit = resolveUnit('land@1', join(import.meta.dir, '..', 'journey', 'ta-journey.yaml'));
  expect(unit.path).toBe(unitPath);
  expect(unit.template.unit).toMatchObject({
    inputs: ['ask', 'context', 'prior'], outputs: ['result', 'evidence'],
    exits: ['done', 'rework', 'needs-human', 'failed'],
  });
  const parsed = parseGraphTemplateYaml(readFileSync(unitPath, 'utf8'), unitPath);
  expect(parsed.errors).toEqual([]);
  expect(unit.template.policy).toEqual(parsed.template?.policy);
});

test('policy block validates batch bounds and non-empty directive text', () => {
  const source = readFileSync(unitPath, 'utf8');
  const parsed = parseGraphTemplateYaml(source, unitPath);
  const policy = parsed.template?.policy;
  expect(parsed.errors).toEqual([]);
  expect(policy?.batch).toMatchObject({ min: 2, max: 4, groupBy: ['area', 'cellPrefix'], maxWaitMin: 30 });
  expect(policy && Object.values(policy).every((field) => typeof field.directive === 'string' && field.directive.trim().length > 0)).toBe(true);

  const invalidBounds = parseGraphTemplateYaml(source.replace('    min: 2', '    min: 1'), unitPath);
  expect(invalidBounds.template).toBeUndefined();
  expect(invalidBounds.errors.some((issue) => issue.path.endsWith('/policy/batch/min'))).toBe(true);
});

test('train policy observer emits land.policy-drift only for measured policy mismatches', () => {
  const source = readFileSync(unitPath, 'utf8');
  const policy = parseGraphTemplateYaml(source, unitPath).template?.policy;
  expect(policy).toBeDefined();
  if (!policy) throw new Error('land train policy did not parse');
  const observed: LandTrainObservation = {
    express: false,
    waitedForBatch: true,
    batchSize: 3,
    groupBy: ['cellPrefix', 'area'],
    waitMinutes: 12,
    scenarioSource: 'fake-harness',
    mockUsed: true,
    gateRuns: 1,
    land: { perPr: 'squash', pinnedHead: true, ejectOnFail: true, integrationPr: false },
  };
  const events: Array<{ event: string; payload: unknown }> = [];
  expect(observeLandPolicyDrift(policy, observed, (event, payload) => events.push({ event, payload }))).toEqual([]);
  expect(events).toEqual([]);
  expect(observeLandPolicyDrift(policy, { ...observed, express: true, waitedForBatch: false, batchSize: 1 },
    (event, payload) => events.push({ event, payload }))).toEqual([]);
  expect(events).toEqual([]);

  const drift = observeLandPolicyDrift(policy, {
    ...observed,
    batchSize: 1,
    scenarioSource: 'live-llm',
    mockUsed: false,
    gateRuns: 2,
    land: { ...observed.land, pinnedHead: false },
  }, (event, payload) => events.push({ event, payload }));
  expect(drift.map((entry) => entry.field)).toEqual([
    '/batch/size', '/scenarioPrebuild/source', '/scenarioPrebuild/mock', '/gate/runs', '/land/pinnedHead',
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: 'land.policy-drift', payload: { drift } });
});

test('land enqueue runtime consumes an optional train observation before its side effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-policy-observation-'));
  try {
    const review = join(root, 'review.json');
    const command = join(root, 'enqueue');
    writeFileSync(review, '{}');
    writeFileSync(command, '#!/bin/sh\n');
    const events: string[] = [];
    const accept = (() => ({ status: 0, stdout: 'ENQUEUED', stderr: '' })) as unknown as typeof spawnSync;
    const result = runLandEnqueue({ context: {
      pr: 29155, expectedHead: head, review, owner: 'train:TC', landTrainObservation: {
        express: false, waitedForBatch: true, batchSize: 1, groupBy: ['area'], waitMinutes: 31,
        scenarioSource: 'live-llm', mockUsed: false, gateRuns: 2,
        land: { perPr: 'merge', pinnedHead: false, ejectOnFail: false, integrationPr: true },
      },
    } }, command, accept, (event) => events.push(event));
    expect(result).toMatchObject({ outcome: 'done', result: 'train-enqueued' });
    expect(events).toEqual(['land.policy-drift']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land@1 requires pinned review and enqueue command before any side effect', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-unit-preflight-'));
  try {
    const review = join(root, 'review.json');
    writeFileSync(review, '{}');
    let calls = 0;
    const fake = (() => { calls++; return { status: 0, stdout: 'queued', stderr: '' }; }) as unknown as typeof spawnSync;
    const input = { context: { pr: 29155, expectedHead: head, review, owner: 'TC' } };
    expect(runLandEnqueue(input, undefined, fake).result).toBe('land-enqueue-command-unavailable');
    expect(runLandEnqueue({ context: { ...input.context, expectedHead: 'stale' } }, '/tmp/anything', fake).result)
      .toBe('expected-head-missing-or-invalid');
    expect(runLandEnqueue({ context: { ...input.context, review: join(root, 'missing.json') } }, '/tmp/anything', fake).result)
      .toBe('review-json-missing');
    expect(calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land@1 sends exact pinned argv to the train and turns refusal into needs-human', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-unit-argv-'));
  try {
    const review = join(root, 'review.json');
    const command = join(root, 'enqueue');
    writeFileSync(review, '{}');
    writeFileSync(command, '#!/bin/sh\n');
    const input = { context: { pr: 29155, expectedHead: head, review, owner: 'train:TC' } };
    let argv: readonly string[] = [];
    const accept = ((_bin: string, args: readonly string[]) => {
      argv = args;
      return { status: 0, stdout: 'ENQUEUED', stderr: '' };
    }) as unknown as typeof spawnSync;
    expect(runLandEnqueue(input, command, accept)).toMatchObject({ outcome: 'done', result: 'train-enqueued', evidence: { enqueued: true, pr: 29155 } });
    expect(argv).toEqual(['29155', 'train:TC', '--expected-head', head, '--review', review]);
    const refuse = (() => ({ status: 1, stdout: 'REFUSE review-head-mismatch', stderr: '' })) as unknown as typeof spawnSync;
    expect(runLandEnqueue(input, command, refuse)).toMatchObject({ outcome: 'needs-human', result: 'land-enqueue-refused', evidence: { enqueued: false, exitCode: 1 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('land@1 checked-in graph runs the real adapter with an isolated fake train executable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-unit-graph-'));
  try {
    const review = join(root, 'review.json');
    const command = join(root, 'enqueue');
    const argsPath = join(root, 'argv.json');
    writeFileSync(review, '{}');
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`);
    execFileSync('chmod', ['+x', command]);
    const run = await runGraph(unitPath, {
      input: { ask: 'enqueue reviewed PR', context: { pr: 29155, expectedHead: head, review, owner: 'TC' }, prior: { result: 'reviewed' } },
      deps: {
        root,
        runBash: async (body, opts) => ({
          stdout: execFileSync('bun', body.split(' ').slice(1), {
            cwd: join(import.meta.dir, '../..'),
            env: { ...opts.env, ELANOUS_LAND_ENQUEUE: command },
            encoding: 'utf8',
          }),
          stderr: '', exitCode: 0,
        }),
      },
    });
    expect(run.status).toBe('done');
    expect(run.path).toEqual(['enqueue', 'done']);
    expect(run.nodes[0]?.output).toContain('"train-enqueued"');
    expect(readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual(['29155', 'train:TC', '--expected-head', head, '--review', review]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
