import { describe, expect, test } from 'bun:test';
import { newWorkflowNameProblem, withWorkflowName, workflowSaveErrorText } from './workflow-save';

const TEMPLATE = 'name: my-workflow\ndescription: |\n  Use when: …\nnodes:\n  - id: first\n    bash: echo hello\n';

describe('new workflow save (K3 실물 2026-09-30 · 422 name mismatch)', () => {
  test('the typed name replaces the template name, so the body matches the path', () => {
    const yaml = withWorkflowName(TEMPLATE, 'hwp-report-demo');
    expect(yaml.split('\n')[0]).toBe('name: hwp-report-demo');
    expect(yaml).not.toContain('my-workflow');
    expect(yaml).toContain('bash: echo hello');
  });
  test('only the top-level name changes — a nested `name:` stays', () => {
    const yaml = withWorkflowName('name: a\nnodes:\n  - id: x\n    skill:\n      name: hwp-write\n', 'b');
    expect(yaml).toContain('name: b\n');
    expect(yaml).toContain('      name: hwp-write');
  });
  test('a YAML without a name gets one prepended', () => {
    expect(withWorkflowName('nodes: []\n', 'x')).toBe('name: x\nnodes: []\n');
  });
  test('bad or empty names are explained instead of silently ignored', () => {
    expect(newWorkflowNameProblem('')).toContain('이름');
    expect(newWorkflowNameProblem('Weekly Report')).toContain('소문자');
    expect(newWorkflowNameProblem('weekly-report')).toBeNull();
  });
  test('daemon errors read as one plain sentence', () => {
    expect(workflowSaveErrorText({ status: 422, body: { error: 'invalid_workflow', reason: 'name mismatch: YAML name=my-workflow' } })).toContain('이름');
    expect(workflowSaveErrorText({ status: 422, body: { validation: { ok: false, issues: [{ message: "missing required input 'markdown'" }] } } })).toContain("missing required input 'markdown'");
    expect(workflowSaveErrorText({ status: 401, body: {} })).toContain('권한');
    expect(workflowSaveErrorText(new Error('boom'))).toContain('저장하지 못했습니다');
  });
});
