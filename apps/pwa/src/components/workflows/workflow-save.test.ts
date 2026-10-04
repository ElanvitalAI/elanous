import { describe, expect, test } from 'bun:test';
import { copyWorkflowDraft, newWorkflowNameProblem, withWorkflowName, workflowIsReadonly, workflowSaveErrorText } from './workflow-save';
import { parse } from 'yaml';

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
    expect(workflowSaveErrorText({ status: 409, body: { error: 'readonly_workflow' } })).toContain('읽기 전용');
  });
});

describe('readonly workflow draft', () => {
  test('only top-level boolean true locks; missing, false, string, comment and nested value do not', () => {
    expect(workflowIsReadonly(`readonly: true\n${TEMPLATE}`)).toBe(true);
    for (const yaml of [TEMPLATE, `readonly: false\n${TEMPLATE}`, `readonly: "true"\n${TEMPLATE}`,
      `# readonly: true\n${TEMPLATE}`, `name: x\nnodes:\n  - id: first\n    readonly: true\n`]) {
      expect(workflowIsReadonly(yaml)).toBe(false);
    }
  });
  test('copy opens editable unsaved draft with fresh -copy name and preserves nodes, never mutating source', () => {
    const original = `name: example\nreadonly: true\ndescription: keep\nnodes:\n  - id: first\n    bash: echo hello\n`;
    const result = copyWorkflowDraft(original, 'example');
    expect(result.name).toBe('example-copy');
    expect(parse(result.yaml)).toEqual({ name: 'example-copy', description: 'keep', nodes: [{ id: 'first', bash: 'echo hello' }] });
    expect(original).toContain('readonly: true');
    expect(workflowIsReadonly(result.yaml)).toBe(false);
    expect(copyWorkflowDraft(original, 'example', ['example-copy']).name).toBe('example-copy-2');
  });
});
