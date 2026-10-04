import { describe, expect, it } from 'bun:test';
import { interpolate } from '../../../../../src/workflow-runtime/variables';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';
import { getExpressionCandidates, variableLabel } from './expression-completion';

const def: WorkflowDefinitionLike = {
  name: 'completion',
  nodes: [
    { id: 'fetch', bash: 'echo data', output_format: { properties: { status: { type: 'string' }, _count: { type: 'number' }, 'bad-field': {} } } },
    { id: 'step-2', depends_on: ['fetch'], prompt: 'summarize' },
    { id: 'current', depends_on: ['step-2', 'UPPER'], bash: 'echo' },
    { id: 'UPPER', depends_on: ['fetch'], bash: 'echo' },
    { id: 'later', depends_on: ['current'], bash: 'echo' },
    { id: 'sibling', depends_on: ['fetch'], bash: 'echo' },
  ],
};

it('labels both built-in variables, node output and an output field', () => {
  expect(variableLabel('$ARGUMENTS')).toBe('실행할 때 받은 인자');
  expect(variableLabel('$ARTIFACTS_DIR')).toBe('산출물 폴더');
  expect(variableLabel('$fetch.output')).toBe('fetch 노드 결과');
  expect(variableLabel('$fetch.output.status')).toBe('fetch 노드 결과의 status');
});

describe('getExpressionCandidates', () => {
  it('walks only transitive dependencies and emits runtime-supported output and field references', () => {
    const candidates = getExpressionCandidates(def, 'current', '$');
    expect(candidates).toEqual([
      '$ARGUMENTS', '$ARTIFACTS_DIR', '$fetch.output',
      '$fetch.output.status', '$fetch.output._count', '$step-2.output',
    ]);
    expect(candidates).toContain('$fetch.output');
    expect(candidates).toContain('$fetch.output.status');
    expect(candidates).toContain('$fetch.output._count');
    expect(candidates).toContain('$step-2.output');
    expect(candidates).toContain('$ARGUMENTS');
    expect(candidates).toContain('$ARTIFACTS_DIR');
    expect(candidates).not.toContain('$fetch.output.bad-field');
    expect(candidates).not.toContain('$UPPER.output');
    expect(candidates).not.toContain('$current.output');
    expect(candidates).not.toContain('$later.output');
    expect(candidates).not.toContain('$sibling.output');
    expect(candidates.every((item) => !item.startsWith('{{') && !item.includes('variables.'))).toBe(true);
  });

  it('filters the typed fragment and stops on cycles and missing dependencies', () => {
    const cyclic: WorkflowDefinitionLike = {
      name: 'cyclic',
      nodes: [
        { id: 'a', depends_on: ['b', 'missing'], bash: '' },
        { id: 'b', depends_on: ['a'], bash: '' },
      ],
    };
    expect(getExpressionCandidates(cyclic, 'a', '$')).toEqual(['$ARGUMENTS', '$ARTIFACTS_DIR', '$b.output']);
    expect(getExpressionCandidates(def, 'current', '$fe')).toEqual([
      '$fetch.output', '$fetch.output.status', '$fetch.output._count',
    ]);
    expect(getExpressionCandidates(def, 'current', 'fetch')).toEqual([]);
    expect(getExpressionCandidates(def, 'missing', '$')).toEqual(['$ARGUMENTS', '$ARTIFACTS_DIR']);
  });

  it('emitted candidates resolve through the real runtime interpolator', () => {
    const ctx = {
      arguments: 'hello',
      artifactsDir: '/tmp/artifacts',
      outputs: {
        fetch: { output: { status: 'ok', _count: 2 }, ok: true, durationMs: 0 },
        'step-2': { output: 'summary', ok: true, durationMs: 0 },
      },
    };
    for (const [candidate, expected] of [
      ['$fetch.output', '{"status":"ok","_count":2}'],
      ['$fetch.output.status', 'ok'],
      ['$fetch.output._count', '2'],
      ['$step-2.output', 'summary'],
      ['$ARGUMENTS', 'hello'],
      ['$ARTIFACTS_DIR', '/tmp/artifacts'],
    ]) {
      expect(getExpressionCandidates(def, 'current', '$')).toContain(candidate);
      expect(interpolate(candidate, ctx)).toEqual({ text: expected, missing: [] });
    }
  });
});
