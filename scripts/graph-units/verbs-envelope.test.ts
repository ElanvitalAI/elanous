import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseGraphTemplateYaml } from '../../src/self-implement/graph-yaml';
import { buildMakeDocOutput, buildVerifyEnvelope, buildVerifyOutput, unpackMakeDocEnvelope } from './verbs-envelope';

const dir = new URL('../../graphs/units/verbs/', import.meta.url);

test('verb unit YAML declares versioned contracts and all exits without invoking a runner', () => {
  for (const file of ['make-doc.yaml', 'verify.yaml']) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    expect(parseGraphTemplateYaml(source, file).errors).toEqual([]);
  }
  const makeDoc = parseGraphTemplateYaml(readFileSync(new URL('make-doc.yaml', dir), 'utf8'), 'make-doc.yaml').template!;
  expect(makeDoc.graphId).toBe('verb-make-doc');
  expect(makeDoc.version).toBe(1);
  expect(makeDoc.unit?.inputs).toEqual(['ask', 'context', 'prior']);
  expect(makeDoc.unit?.outputs).toEqual(['result', 'evidence']);
  expect(makeDoc.unit?.exits).toEqual(['done', 'rework', 'needs-human', 'failed']);
  expect(readFileSync(new URL('make-doc.yaml', dir), 'utf8')).toMatch(/node_id: failed, kind: observe, recipe: 'cmd:make-doc-output'/);
  const verify = parseGraphTemplateYaml(readFileSync(new URL('verify.yaml', dir), 'utf8'), 'verify.yaml').template!;
  expect(verify.graphId).toBe('verb-verify');
  expect(verify.version).toBe(1);
  expect(verify.unit?.inputs).toEqual(['ask', 'context', 'prior']);
  expect(verify.unit?.outputs).toEqual(['result', 'evidence']);
  expect(verify.unit?.exits).toEqual(['done', 'rework', 'needs-human', 'failed']);
  expect(verify.edges.find(edge => edge.from === 'review')?.map).toEqual({ pass: 'done', fail: 'rework-loop', 'needs-human': 'needs-human', failed: 'failed' });
  expect(readFileSync(new URL('verify.yaml', dir), 'utf8')).toMatch(/node_id: failed, kind: observe, recipe: 'cmd:verify-output-failed'/);
});

test('make-doc envelope adapts context metadata and uses ask for a missing or blank goal', () => {
  const prior = { draft: 'existing' };
  expect(unpackMakeDocEnvelope({ ask: 'Document the feature', context: {
    goal: '  ', worktree: '/tmp/tree', branch: 'ux/docs', 'review-intent': 'docs only',
    'head-sha': 'abc123', 'base-branch': 'main',
  }, prior })).toEqual({ goal: 'Document the feature', worktree: '/tmp/tree', branch: 'ux/docs',
    'review-intent': 'docs only', 'head-sha': 'abc123', 'base-branch': 'main', prior });
  expect(unpackMakeDocEnvelope({ ask: 'minimal' })).toEqual({ goal: 'minimal', worktree: null, branch: null,
    'review-intent': 'minimal', 'head-sha': null, 'base-branch': null, prior: null });
});

test('make-doc exit emits every declared output with nulls for unproduced values', () => {
  expect(buildMakeDocOutput({ input: {}, outputs: { 'document-draft': { summary: 'drafted' } } }))
    .toEqual({ result: 'drafted', evidence: {} });
  expect(buildMakeDocOutput({ input: { prior: { result: 'previous', evidence: { source: 'prior-proof' } } }, outputs: { 'document-draft': {} } }))
    .toEqual({ result: null, evidence: { source: 'prior-proof', 'prior-result': 'previous' } });
  expect(buildMakeDocOutput({ input: { prior: { evidence: { retained: 'old-proof' } }, evidence: { context: 'input-proof' } }, outputs: {
    'document-draft': { evidence: { draft: 'new-proof' } },
  } })).toEqual({ result: null, evidence: { retained: 'old-proof', context: 'input-proof', draft: 'new-proof' } });
  expect(buildMakeDocOutput({ input: { prior: { result: 'keep-me' }, evidence: { 'prior-result': 'input-overwrite' } }, outputs: {
    'document-draft': { evidence: { 'prior-result': 'draft-overwrite' } },
  } }).evidence).toMatchObject({ 'prior-result': 'keep-me' });
});

test('verify adapts the shared ask/context/prior envelope and defaults safely', () => {
  expect(buildVerifyEnvelope({ input: { ask: 'verify this change', context: { start_at: 'review', worktree: '/tmp/tree' }, prior: { result: { diff: 'patch' }, evidence: { 'gate-log': 'prior-gate.log' } } }, outputs: {} })).toEqual({
    outcome: 'review', worktree: '/tmp/tree', 'changed-files': null, diff: 'patch',
    'review-intent': 'verify this change', 'must-fix': null, 'gate-log': 'prior-gate.log',
  });
  expect(buildVerifyEnvelope({ input: { ask: 'verify', context: { start_at: 'unknown' } }, outputs: {} }).outcome).toBe('gate');
  expect(buildVerifyEnvelope({ input: { ask: 'Review this change', context: {} }, outputs: {} })['review-intent']).toBe('Review this change');
  expect(buildVerifyEnvelope({ input: { ask: 'New request', context: {}, prior: { evidence: { 'review-intent': 'old request' } } }, outputs: {} })['review-intent']).toBe('New request');
});

test('verify exit emits the shared result/evidence envelope and carries findings forward', () => {
  expect(buildVerifyOutput({ input: { prior: { evidence: { 'gate-log': 'prior-gate.log', 'review-summary': 'prior-review' } } }, outputs: {
    prepare: { 'gate-log': 'prepared-gate.log' },
    review: { review_summary: 'reviewed', 'must-fix': ['stale finding'] },
    'rework-loop': { must_fix: ['remaining'] }, gate: {},
  } }, 'done')).toEqual({ result: 'done', evidence: {
    'gate-log': 'prepared-gate.log', 'review-summary': 'reviewed', 'must-fix': [],
  } });
  expect(buildVerifyOutput({ input: { prior: { evidence: { preserved: 'proof', 'must-fix': ['old'] } } }, outputs: {} }, 'rework'))
    .toEqual({ result: 'rework', evidence: { preserved: 'proof', 'must-fix': ['old'], 'review-summary': null, 'gate-log': null } });
  expect(buildVerifyOutput({ input: { prior: { evidence: { 'must-fix': ['prior issue'] } } }, outputs: {
    review: { evidence: { 'must-fix': ['review issue'] } },
    'rework-loop': { evidence: { 'must-fix': ['latest rework issue'] } },
  } }, 'rework').evidence).toMatchObject({ 'must-fix': ['latest rework issue'] });
  expect(buildVerifyOutput({ input: { prior: { evidence: {} } }, outputs: {
    review: { review_summary: 'latest review' },
    'rework-loop': { evidence: { 'review-summary': 'rework review', 'gate-log': 'rework gate' } },
    gate: { 'gate-log': 'latest gate' },
  } }, 'done').evidence).toMatchObject({ 'review-summary': 'latest review', 'gate-log': 'latest gate' });
  expect(buildVerifyOutput({ input: { prior: { evidence: { 'gate-log': 'prior-gate.log' } } }, outputs: { prepare: { 'gate-log': 'prior-gate.log' } } }, 'rework'))
    .toEqual({ result: 'rework', evidence: { 'review-summary': null, 'must-fix': null, 'gate-log': 'prior-gate.log' } });
  expect(buildVerifyOutput({ input: { prior: { result: 'keep-prior', evidence: { 'prior-result': 'stale' } } }, outputs: {} }, 'failed').evidence)
    .toMatchObject({ 'prior-result': 'keep-prior' });
});
