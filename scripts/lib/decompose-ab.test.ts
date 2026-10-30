import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main as measureMain } from '../measure-decompose-ab.js';
import {
  applyPromptReplacement,
  assertDecomposeAbConfig,
  normalizeDecomposition,
  runDecomposeAb,
  summarizeDecomposeAb,
  type DecomposeAbConfig,
} from './decompose-ab.js';

const config: DecomposeAbConfig = {
  corpus: [
    { id: 'split', feature: 'split this request' },
    { id: 'atomic', feature: 'atomic request', negativeControl: true },
  ],
  repeats: 2,
  maxTasks: 2,
  treatment: { anchor: 'Fewer is better', replacement: 'Always split into independent pieces' },
};

const subtask = (id: string, feature: string, dependsOn: string[] = []) => ({
  id,
  feature,
  completionBoundary: `${feature} is independently complete`,
  mockScenario: { id: 'MS-01', injection: `Run ${id}`, observation: `Observe ${id}` },
  futureAssumptions: [],
  dependsOn,
  goalType: 'implement',
});

const outputs = new Map<string, string>([
  ['split this request', JSON.stringify({ subtasks: [subtask('a', 'A'), subtask('b', 'B', ['a']), subtask('c', 'C'), subtask('d', 'D'), subtask('e', 'E')] })],
  ['atomic request', JSON.stringify({ subtasks: [] })],
]);

const fakeLlm = async (prompt: string): Promise<string> => {
  if (prompt.includes('Always split')) return prompt.includes('atomic request')
    ? JSON.stringify({ subtasks: [subtask('only', 'unwanted'), subtask('extra', 'over-split')] })
    : outputs.get('split this request')!;
  return prompt.includes('atomic request') ? outputs.get('atomic request')! : outputs.get('split this request')!;
};

describe('decompose A/B pure contracts', () => {
  test('changes precisely one anchored prompt fragment and rejects missing or duplicate anchors', () => {
    expect(applyPromptReplacement('before ANCHOR after', { anchor: 'ANCHOR', replacement: 'changed' })).toBe('before changed after');
    expect(() => applyPromptReplacement('unchanged', { anchor: 'missing', replacement: 'changed' })).toThrow('treatment anchor was not found');
    expect(() => applyPromptReplacement('ANCHOR feature ANCHOR', { anchor: 'ANCHOR', replacement: 'changed' })).toThrow('treatment anchor must occur exactly once; found 2');
  });

  test('rejects malformed corpus and invalid repeats before any LLM call', () => {
    expect(() => assertDecomposeAbConfig({ ...config, corpus: [] })).toThrow('corpus must contain at least one item');
    expect(() => assertDecomposeAbConfig({ ...config, repeats: 0 })).toThrow('repeats must be a positive integer');
    expect(() => assertDecomposeAbConfig({ ...config, corpus: [{ id: 'x', feature: '' }] })).toThrow('non-empty id and feature');
  });

  test('preflights the anchor for every corpus item before the first LLM call', async () => {
    const itemSpecificAnchor = { ...config, treatment: { anchor: 'split this request', replacement: 'changed' } };
    expect(() => assertDecomposeAbConfig(itemSpecificAnchor)).toThrow('invalid treatment prompt for corpus item atomic');
    let calls = 0;
    await expect(runDecomposeAb(itemSpecificAnchor, async () => { calls += 1; return '{}'; })).rejects.toThrow('corpus item atomic');
    expect(calls).toBe(0);
  });

  test('requires an injected shared seam and records structured outcomes only', async () => {
    await expect(runDecomposeAb(config, undefined)).rejects.toThrow('both A/B arms require the same injected llm seam');
    const records = await runDecomposeAb(config, fakeLlm);
    expect(records).toHaveLength(8);
    expect(records.every((record) => record.measurement?.outcome === 'decomposed' || record.measurement?.outcome === 'single-no-subtasks')).toBe(true);
    expect(records.find((record) => record.id === 'split' && record.arm === 'control')!.measurement).toMatchObject({
      actualTaskCount: 5, dependencyEdges: 1, exceededRecommendedMax: true, truncatedAtHardMax: true, dependenciesValid: true,
    });
  });

  test('records injected LLM failures and empty responses through the real decomposition path', async () => {
    const failureConfig = { ...config, corpus: [{ id: 'failure', feature: 'failure feature' }, { id: 'empty', feature: 'empty feature' }], repeats: 1 };
    const received: string[] = [];
    const records = await runDecomposeAb(failureConfig, async (prompt) => {
      received.push(prompt);
      if (prompt.includes('failure feature')) throw new Error('injected failure');
      return '';
    });
    expect(records).toHaveLength(4);
    expect(records.filter((record) => record.id === 'failure')).toEqual(expect.arrayContaining([
      expect.objectContaining({ arm: 'control', error: 'injected failure', measurement: expect.objectContaining({ outcome: 'llm-failed', actualTaskCount: 0 }) }),
      expect.objectContaining({ arm: 'treatment', error: 'injected failure', measurement: expect.objectContaining({ outcome: 'llm-failed', actualTaskCount: 0 }) }),
    ]));
    expect(records.filter((record) => record.id === 'empty').map((record) => record.measurement?.outcome)).toEqual(['single-no-subtasks', 'single-no-subtasks']);
    expect(received.some((prompt) => prompt.includes('Always split into independent pieces'))).toBe(true);
    expect(summarizeDecomposeAb(failureConfig, records).byArm.control.outcomes).toEqual({
      decomposed: 0,
      'single-no-subtasks': 1,
      'missing-research-context': 0,
      'grounding-empty': 0,
      'authored-empty': 0,
      'slice-rejected': 0,
      'llm-failed': 1,
    });
  });

  test('uses the prompt received from the runner when applying treatment', async () => {
    const received: string[] = [];
    const runner = async (_feature: string, opts: { llm: (prompt: string) => Promise<string>; maxTasks?: number }) => {
      await opts.llm('CUSTOM Fewer is better prompt');
      return { goals: [], decomposition: { actualTaskCount: 0, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, outcome: 'single-no-subtasks' as const } };
    };
    const records = await runDecomposeAb({ ...config, corpus: [{ id: 'custom', feature: 'feature' }], repeats: 1 }, async (prompt) => {
      received.push(prompt);
      return '{"subtasks":[]}';
    }, runner);
    expect(received).toEqual(['CUSTOM Fewer is better prompt', 'CUSTOM Always split into independent pieces prompt']);
    expect(records.map((record) => record.prompt)).toEqual(received);
  });

  test('records runner exceptions as unmeasured and excludes their incomplete pairs', async () => {
    const runner = async (feature: string, opts: { llm: (prompt: string) => Promise<string>; maxTasks?: number }) => {
      if (feature === 'broken') throw new Error('runner down');
      await opts.llm(`CUSTOM Fewer is better ${feature}`);
      return { goals: [], decomposition: { actualTaskCount: 0, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, outcome: 'single-no-subtasks' as const } };
    };
    const partialConfig = { ...config, corpus: [{ id: 'broken', feature: 'broken' }, { id: 'healthy', feature: 'healthy' }], repeats: 1 };
    const records = await runDecomposeAb(partialConfig, async () => '{"subtasks":[]}', runner);
    expect(records).toHaveLength(4);
    expect(records.filter((record) => record.id === 'broken')).toEqual(expect.arrayContaining([
      expect.objectContaining({ arm: 'control', prompt: '', error: 'runner down', unmeasuredReason: 'runner-exception' }),
      expect.objectContaining({ arm: 'treatment', prompt: '', error: 'runner down', unmeasuredReason: 'runner-exception' }),
    ]));
    expect(records.filter((record) => record.id === 'broken').every((record) => record.measurement === undefined)).toBe(true);
    const summary = summarizeDecomposeAb(partialConfig, records);
    expect(summary).toMatchObject({ expectedRecords: 4, records: 4, observedRecords: 2, unmeasuredRecords: 2 });
    expect(summary.byArm.control).toMatchObject({ expectedRecords: 2, observedRecords: 1, unmeasuredRecords: 1, decompositionRate: { passes: 0, runs: 1 }, multiTaskRate: { passes: 0, runs: 1 } });
    expect(summary.pairs).toHaveLength(1);
    expect(summary.incompletePairs).toEqual([{ id: 'broken', repeat: 0, unmeasuredArms: ['control', 'treatment'] }]);
    expect(records.filter((record) => record.id === 'healthy').map((record) => record.prompt)).toEqual([
      'CUSTOM Fewer is better healthy', 'CUSTOM Always split into independent pieces healthy',
    ]);
  });

  test('keeps one observed arm out of paired analysis and gives an unavailable 0/0 Wilson rate to an unmeasured arm', async () => {
    const runner = async (_feature: string, opts: { llm: (prompt: string) => Promise<string>; maxTasks?: number }) => {
      if (await opts.llm('CUSTOM Fewer is better partial') === 'treatment') throw new Error('treatment runner down');
      return { goals: [], decomposition: { actualTaskCount: 0, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, outcome: 'single-no-subtasks' as const } };
    };
    const oneItem = { ...config, corpus: [{ id: 'partial', feature: 'partial' }], repeats: 1 };
    const records = await runDecomposeAb(oneItem, async (prompt) => prompt.includes('Always split') ? 'treatment' : 'control', runner);
    const summary = summarizeDecomposeAb(oneItem, records);
    expect(summary.byArm.control).toMatchObject({ observedRecords: 1, unmeasuredRecords: 0, decompositionRate: { passes: 0, runs: 1 } });
    expect(summary.byArm.treatment).toMatchObject({ observedRecords: 0, unmeasuredRecords: 1, decompositionRate: { passes: 0, runs: 0, wilson: null }, multiTaskRate: { passes: 0, runs: 0, wilson: null } });
    expect(summary.pairs).toHaveLength(0);
    expect(summary.incompletePairs).toEqual([{ id: 'partial', repeat: 0, unmeasuredArms: ['treatment'] }]);
  });

  test('reports both arms as unmeasured rather than fabricated zero outcomes', async () => {
    const oneItem = { ...config, corpus: [{ id: 'down', feature: 'down' }], repeats: 2 };
    const records = await runDecomposeAb(oneItem, async () => '{"subtasks":[]}', async () => { throw new Error('all runners down'); });
    const summary = summarizeDecomposeAb(oneItem, records);
    expect(summary).toMatchObject({ expectedRecords: 4, records: 4, observedRecords: 0, unmeasuredRecords: 4, pairs: [] });
    for (const arm of ['control', 'treatment'] as const) {
      expect(summary.byArm[arm]).toMatchObject({ expectedRecords: 2, observedRecords: 0, unmeasuredRecords: 2, decompositionRate: { passes: 0, runs: 0, wilson: null }, multiTaskRate: { passes: 0, runs: 0, wilson: null }, outcomes: { decomposed: 0, 'single-no-subtasks': 0, 'llm-failed': 0 } });
    }
    expect(summary.incompletePairs).toEqual([
      { id: 'down', repeat: 0, unmeasuredArms: ['control', 'treatment'] },
      { id: 'down', repeat: 1, unmeasuredArms: ['control', 'treatment'] },
    ]);
  });

  test('normalizes cap metadata and dependency validity from authoritative fields', () => {
    const base = { goals: [{ id: 'a', feature: 'fallback goal', dependsOn: ['missing'] }], decomposition: { actualTaskCount: 0, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, outcome: 'llm-failed' as const, error: 'down' } };
    expect(normalizeDecomposition(base)).toEqual({
      actualTaskCount: 0, dependencyEdges: 1, outcome: 'llm-failed', recommendedMaxTasks: 2,
      exceededRecommendedMax: false, truncatedAtHardMax: false, dependenciesValid: false,
    });
  });

  test('keeps paired records, sample counts/Wilson, negative-control over-splitting, and per-round fluctuation visible', async () => {
    const records = await runDecomposeAb(config, fakeLlm);
    const summary = summarizeDecomposeAb(config, records);
    expect(summary).toMatchObject({ expectedRecords: 8, records: 8 });
    expect(summary.pairs).toHaveLength(4);
    expect(summary.byArm.control.decompositionRate).toMatchObject({ passes: 2, runs: 4 });
    expect(summary.byArm.control.decompositionRate.wilson).not.toBeNull();
    expect(summary.negativeControls).toEqual([
      { id: 'atomic', repeat: 0, controlTaskCount: 0, treatmentTaskCount: 2, overSplit: true },
      { id: 'atomic', repeat: 1, controlTaskCount: 0, treatmentTaskCount: 2, overSplit: true },
    ]);
    expect(summary.rounds).toEqual([
      { repeat: 0, controlDecomposed: 1, treatmentDecomposed: 2, pairs: 2 },
      { repeat: 1, controlDecomposed: 1, treatmentDecomposed: 2, pairs: 2 },
    ]);
  });

  test('reports actual two-or-more-task rates separately from decomposed outcomes and excludes runner exceptions', () => {
    const measurement = (actualTaskCount: number) => ({
      actualTaskCount,
      dependencyEdges: 0,
      outcome: 'decomposed' as const,
      recommendedMaxTasks: 6,
      exceededRecommendedMax: false,
      truncatedAtHardMax: false,
      dependenciesValid: true,
    });
    const rateConfig = { ...config, corpus: [{ id: 'six', feature: 'six' }, { id: 'one', feature: 'one' }, { id: 'down', feature: 'down' }], repeats: 1 };
    const records = [
      { id: 'six', repeat: 0, arm: 'control' as const, prompt: 'control', measurement: measurement(6) },
      { id: 'six', repeat: 0, arm: 'treatment' as const, prompt: 'treatment', measurement: measurement(6) },
      { id: 'one', repeat: 0, arm: 'control' as const, prompt: 'control', measurement: measurement(1) },
      { id: 'one', repeat: 0, arm: 'treatment' as const, prompt: 'treatment', measurement: measurement(1) },
      { id: 'down', repeat: 0, arm: 'control' as const, prompt: '', error: 'runner down', unmeasuredReason: 'runner-exception' as const },
      { id: 'down', repeat: 0, arm: 'treatment' as const, prompt: '', error: 'runner down', unmeasuredReason: 'runner-exception' as const },
    ];
    const summary = summarizeDecomposeAb(rateConfig, records);
    for (const arm of ['control', 'treatment'] as const) {
      expect(summary.byArm[arm].decompositionRate).toMatchObject({ passes: 2, runs: 2 });
      expect(summary.byArm[arm].multiTaskRate).toEqual({ passes: 1, runs: 2, wilson: expect.any(Object) });
    }
  });

  test('treats 0/0 and 0/1 single-no-subtasks negative controls as one retained piece', () => {
    const noSubtasks = { actualTaskCount: 0, dependencyEdges: 0, outcome: 'single-no-subtasks' as const, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, dependenciesValid: true };
    const oneTask = { ...noSubtasks, actualTaskCount: 1 };
    const negativeConfig = { ...config, corpus: [{ id: 'atomic', feature: 'atomic request', negativeControl: true }], repeats: 1 };
    for (const [control, treatment] of [[noSubtasks, noSubtasks], [noSubtasks, oneTask]] as const) {
      const records = [
        { id: 'atomic', repeat: 0, arm: 'control' as const, prompt: 'control', measurement: control },
        { id: 'atomic', repeat: 0, arm: 'treatment' as const, prompt: 'treatment', measurement: treatment },
      ];
      const summary = summarizeDecomposeAb(negativeConfig, records);
      expect(summary.negativeControls[0]!.overSplit).toBe(false);
      expect(summary.byArm.control.multiTaskRate).toEqual({ passes: 0, runs: 1, wilson: expect.any(Object) });
      expect(summary.byArm.treatment.multiTaskRate).toEqual({ passes: 0, runs: 1, wilson: expect.any(Object) });
    }
  });

  test('marks either arm over-split in a negative control', () => {
    const oneTask = { actualTaskCount: 1, dependencyEdges: 0, outcome: 'single-no-subtasks' as const, recommendedMaxTasks: 2, exceededRecommendedMax: false, truncatedAtHardMax: false, dependenciesValid: true };
    const overSplit = { ...oneTask, actualTaskCount: 2, outcome: 'decomposed' as const };
    const records = [
      { id: 'atomic', repeat: 0, arm: 'control' as const, prompt: 'control', measurement: overSplit },
      { id: 'atomic', repeat: 0, arm: 'treatment' as const, prompt: 'treatment', measurement: oneTask },
    ];
    expect(summarizeDecomposeAb({ ...config, corpus: [{ id: 'atomic', feature: 'atomic request', negativeControl: true }], repeats: 1 }, records).negativeControls[0]!.overSplit).toBe(true);
  });

  test('CLI main reads real environment configuration and dynamically loads the configured LLM module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'decompose-ab-'));
    const corpus = join(dir, 'corpus.json');
    const module = join(dir, 'fake-llm.mjs');
    const out = join(dir, 'result.json');
    try {
      writeFileSync(corpus, JSON.stringify({ corpus: [{ id: 'atomic', feature: 'atomic request', negativeControl: true }], maxTasks: 2 }));
      const cliSubtask = JSON.stringify(subtask('only', 'one'));
      writeFileSync(module, `export const llm = async () => JSON.stringify({ subtasks: [${cliSubtask}] })`);
      const logs: string[] = [];
      const original = console.log;
      console.log = (line: string) => { logs.push(line); };
      try {
        await measureMain({
          ...process.env,
          DECOMPOSE_AB_CORPUS: corpus,
          DECOMPOSE_AB_REPEATS: '2',
          DECOMPOSE_AB_ANCHOR: 'Fewer is better',
          DECOMPOSE_AB_REPLACEMENT: 'Always split',
          DECOMPOSE_AB_LLM_MODULE: module,
          DECOMPOSE_AB_OUT: out,
        }, undefined, undefined, []);
      } finally {
        console.log = original;
      }
      const result = JSON.parse(readFileSync(out, 'utf8')) as { config: DecomposeAbConfig; summary: { records: number; expectedRecords: number; byArm: Record<'control' | 'treatment', { decompositionRate: { passes: number; runs: number }; multiTaskRate: { passes: number; runs: number; wilson: unknown } }> } };
      expect(result.config).toMatchObject({ repeats: 2, treatment: { anchor: 'Fewer is better', replacement: 'Always split' } });
      expect(result.summary).toEqual({ ...result.summary, records: 4, expectedRecords: 4 });
      expect(result.summary.byArm.control).toMatchObject({ decompositionRate: { passes: 2, runs: 2 }, multiTaskRate: { passes: 0, runs: 2 } });
      expect(result.summary.byArm.control.multiTaskRate.wilson).not.toBeNull();
      expect(logs[0]).toContain('4/4 attempts; observed 4; unmeasured 0; complete pairs 2; incomplete pairs 0');
      expect(logs[1]).toContain('decomposed 2/2 · 2+ tasks 0/2');
      const failingRunner = async () => { throw new Error('CLI runner down'); };
      await measureMain({
        ...process.env,
        DECOMPOSE_AB_CORPUS: corpus,
        DECOMPOSE_AB_REPEATS: '2',
        DECOMPOSE_AB_ANCHOR: 'Fewer is better',
        DECOMPOSE_AB_REPLACEMENT: 'Always split',
        DECOMPOSE_AB_LLM_MODULE: module,
        DECOMPOSE_AB_OUT: out,
      }, undefined, undefined, [], failingRunner);
      const partial = JSON.parse(readFileSync(out, 'utf8')) as { records: Array<{ error?: string; measurement?: unknown; unmeasuredReason?: string }>; summary: { records: number; expectedRecords: number; observedRecords: number; unmeasuredRecords: number; pairs: unknown[]; incompletePairs: unknown[]; byArm: Record<'control' | 'treatment', { decompositionRate: { passes: number; runs: number; wilson: unknown }; multiTaskRate: { passes: number; runs: number; wilson: unknown } }> } };
      expect(partial.records).toHaveLength(4);
      expect(partial.records.every((record) => record.error === 'CLI runner down' && record.measurement === undefined && record.unmeasuredReason === 'runner-exception')).toBe(true);
      expect(partial.summary).toMatchObject({ records: 4, expectedRecords: 4, observedRecords: 0, unmeasuredRecords: 4 });
      expect(partial.summary.pairs).toHaveLength(0);
      expect(partial.summary.incompletePairs).toHaveLength(2);
      expect(partial.summary.byArm.control.decompositionRate).toEqual({ passes: 0, runs: 0, wilson: null });
      expect(partial.summary.byArm.control.multiTaskRate).toEqual({ passes: 0, runs: 0, wilson: null });
      expect(partial.summary.byArm.treatment.decompositionRate).toEqual({ passes: 0, runs: 0, wilson: null });
      expect(partial.summary.byArm.treatment.multiTaskRate).toEqual({ passes: 0, runs: 0, wilson: null });
      await expect(measureMain(process.env, undefined, undefined, ['unexpected'])).rejects.toThrow('accepts no positional arguments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
