import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { exportFileName, nameFromFileName, checkImportFile, readonlyExportFileName, readonlyExportYaml } from './workflow-file';
import { parse } from 'yaml';

test('export filenames sanitize unsafe names and fall back on empty names', () => {
  expect(exportFileName('my flow')).toBe('my-flow.yaml');
  expect(exportFileName('MyFlow')).toBe('MyFlow.yaml');
  expect(exportFileName('')).toBe('workflow.yaml');
  expect(exportFileName('../unsafe:flow')).toBe('unsafe-flow.yaml');
  expect(exportFileName('???')).toBe('workflow.yaml');
});

test('readonly export locks a copy of the YAML, preserving content without mutating the draft', () => {
  const draft = 'name: demo\nreadonly: false\ndescription: "read only: false"\nnodes:\n  - id: first\n    bash: echo hello\n';
  const exported = readonlyExportYaml(draft);
  expect(parse(exported)).toEqual({
    name: 'demo', readonly: true, description: 'read only: false',
    nodes: [{ id: 'first', bash: 'echo hello' }],
  });
  expect(draft).toContain('readonly: false');
  expect(parse(readonlyExportYaml(exported)).readonly).toBe(true);
  expect(readonlyExportFileName('my flow')).toBe('my-flow-readonly.yaml');
  expect(exportFileName('my flow')).toBe('my-flow.yaml');
});

test('readonly export rejects invalid YAML instead of downloading a misleading file', () => {
  expect(() => readonlyExportYaml('name: [unclosed\n')).toThrow('워크플로 YAML을 읽을 수 없어');
  expect(() => readonlyExportYaml('just text\n')).toThrow('워크플로 YAML을 읽을 수 없어');
});

test('imported filename loses YAML extension and becomes lowercase kebab-case', () => {
  expect(nameFromFileName('My Flow.yml')).toBe('my-flow');
  expect(nameFromFileName('Report.YAML')).toBe('report');
});

test('import validation rejects wrong extension, over 256KB and empty body', () => {
  expect(checkImportFile({ name: 'foo.txt', size: 2, text: 'ok' })).toEqual({ ok: false, reason: 'YAML 파일(.yaml 또는 .yml)을 선택해 주세요.' });
  expect(checkImportFile({ name: 'foo.yml', size: 256 * 1024 + 1, text: 'ok' })).toEqual({ ok: false, reason: '파일 크기는 256KB 이하여야 합니다.' });
  expect(checkImportFile({ name: 'foo.yaml', size: 2, text: ' \n ' })).toEqual({ ok: false, reason: '내용이 비어 있는 파일은 가져올 수 없습니다.' });
});

test('valid YAML file preserves the exact draft and suggests its filename', () => {
  expect(checkImportFile({ name: 'My Flow.yml', size: 15, text: 'name: my flow\n' })).toEqual({ ok: true, yaml: 'name: my flow\n', suggestedName: 'my-flow' });
  expect(checkImportFile({ name: 'test.yaml', size: 256 * 1024, text: 'ok' }).ok).toBe(true);
});

test('editor wires the gallery and offers export of the draft next to Save', () => {
  const source = readFileSync(new URL('./WorkflowsPanel.tsx', import.meta.url), 'utf8');
  expect(source).toMatch(/onClick=\{\(\) => setShowCreateModal\(true\)\}/);
  expect(source).toMatch(/showCreateModal && \(\s*<WorkflowCreateModal\s+onApply=\{handleNew\}/);
  expect(source).toMatch(/onClose=\{\(\) => setShowCreateModal\(false\)\}/);
  expect(source).toMatch(/onApply=\{handleNew\}/);
  expect(source).toMatch(/setDraftYaml\(yaml\)/);
  expect(source).toMatch(/setNewName\(suggestedName \?\? ''\)/);
  expect(source).toMatch(/onClick=\{handleExport\}\s+disabled=\{!draftYaml\.trim\(\)\}/);
  expect(source).toMatch(/new Blob\(\[draftYaml\]/);
  expect(source).toMatch(/link\.download = exportFileName\(creatingNew \? newName : selectedName \?\? ''\)/);
  expect(source).toMatch(/document\.body\.appendChild\(link\)/);
  expect(source).toMatch(/link\.click\(\)/);
  expect(source).toMatch(/link\.remove\(\)/);
  expect(source).toMatch(/URL\.revokeObjectURL\(url\)/);
  expect(source.indexOf('내보내기')).toBeLessThan(source.indexOf('Save\n'));
  expect(source).toMatch(/onClick=\{handleReadonlyExport\}\s+disabled=\{!draftYaml\.trim\(\)\}/);
  expect(source).toContain('읽기 전용 사본 내보내기');
  expect(source).toMatch(/const yaml = readonlyExportYaml\(draftYaml\)/);
  expect(source).toMatch(/new Blob\(\[yaml\], \{ type: 'application\/x-yaml' \}\)/);
  expect(source).toMatch(/link\.download = readonlyExportFileName\(creatingNew \? newName : selectedName \?\? ''\)/);
  expect(source).toMatch(/setSaveError\(err instanceof Error \? err\.message : String\(err\)\)/);
});
