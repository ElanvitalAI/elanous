const MAX_IMPORT_SIZE = 256 * 1024;

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
