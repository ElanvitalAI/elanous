import { isMap, parseDocument } from 'yaml';

const MAX_IMPORT_SIZE = 256 * 1024;

/** Add the same top-level lock the workflow store checks, without changing the editor draft. */
export function readonlyExportYaml(yaml: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) {
    throw new Error('워크플로 YAML을 읽을 수 없어 읽기 전용 사본을 내보내지 못했습니다.');
  }
  doc.set('readonly', true);
  return doc.toString();
}

export function readonlyExportFileName(name: string): string {
  return exportFileName(name).replace(/\.yaml$/, '-readonly.yaml');
}

function safeName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function exportFileName(name: string): string {
  return `${safeName(name) || 'workflow'}.yaml`;
}

export function nameFromFileName(file: string): string {
  return safeName(file.replace(/\.ya?ml$/i, '').toLowerCase());
}

export function checkImportFile(file: { name: string; size: number; text: string }):
  | { ok: true; yaml: string; suggestedName: string }
  | { ok: false; reason: string } {
  if (!/\.ya?ml$/i.test(file.name)) return { ok: false, reason: 'YAML 파일(.yaml 또는 .yml)을 선택해 주세요.' };
  if (file.size > MAX_IMPORT_SIZE) return { ok: false, reason: '파일 크기는 256KB 이하여야 합니다.' };
  if (!file.text.trim()) return { ok: false, reason: '내용이 비어 있는 파일은 가져올 수 없습니다.' };
  return { ok: true, yaml: file.text, suggestedName: nameFromFileName(file.name) || 'workflow' };
}
