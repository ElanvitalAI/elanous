import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { exportFileName, nameFromFileName, checkImportFile } from './workflow-file';

test('export filenames sanitize unsafe names and fall back on empty names', () => {
  expect(exportFileName('my flow')).toBe('my-flow.yaml');
  expect(exportFileName('MyFlow')).toBe('MyFlow.yaml');
  expect(exportFileName('')).toBe('workflow.yaml');
  expect(exportFileName('../unsafe:flow')).toBe('unsafe-flow.yaml');
  expect(exportFileName('???')).toBe('workflow.yaml');
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
});
