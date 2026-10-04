// 새 워크플로 저장 — 이름 칸과 초안 YAML 의 `name:` 을 맞추고, 저장 실패를 사람 말로 푼다.
// 2026-09-30 K3 실물: 이름 칸에 `hwp-report-demo` 를 적어도 YAML 은 `name: my-workflow` 그대로라
// 서버가 `422 name mismatch` 로 거절했고, 화면은 그 오류를 어디에도 보이지 않았다.

import { parseDocument } from 'yaml';

export const WORKFLOW_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Only a top-level YAML boolean true locks the editor (not a comment, string or node field). */
export function workflowIsReadonly(yaml: string): boolean {
  try {
    const doc = parseDocument(yaml);
    return doc.errors.length === 0 && doc.get('readonly') === true;
  } catch {
    return false;
  }
}

/** Make an independent editable draft, never a PUT to the source workflow. */
export function copyWorkflowDraft(yaml: string, name: string, taken: readonly string[] = []): { name: string; yaml: string } {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error('워크플로 YAML을 읽을 수 없습니다.');
  const names = new Set(taken);
  let copyName = `${name}-copy`;
  for (let i = 2; names.has(copyName); i += 1) copyName = `${name}-copy-${i}`;
  doc.set('name', copyName);
  doc.delete('readonly');
  return { name: copyName, yaml: doc.toString() };
}

/** Set the top-level `name:` of a workflow YAML to `name` (prepend one if absent). */
export function withWorkflowName(yaml: string, name: string): string {
  const line = /^name:[^\n]*$/m;
  return line.test(yaml) ? yaml.replace(line, `name: ${name}`) : `name: ${name}\n${yaml}`;
}

/** Why a new workflow cannot be saved yet, or null when the name is fine. */
export function newWorkflowNameProblem(name: string): string | null {
  if (!name.trim()) return '워크플로 이름을 먼저 적어 주세요.';
  if (!WORKFLOW_NAME_RE.test(name.trim())) return '이름은 소문자·숫자와 하이픈(-)만 쓸 수 있습니다. 예: weekly-report';
  return null;
}

/** One-line reason for a failed save (status/body from the daemon error). */
export function workflowSaveErrorText(error: unknown): string {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : NaN;
  const body = typeof error === 'object' && error !== null && 'body' in error ? (error as { body: unknown }).body : undefined;
  const reason = body && typeof body === 'object' && 'reason' in body && typeof (body as { reason: unknown }).reason === 'string'
    ? (body as { reason: string }).reason : '';
  const issues = body && typeof body === 'object' && 'validation' in body
    ? ((body as { validation?: { issues?: Array<{ message?: string }> } }).validation?.issues ?? []) : [];
  if (status === 401 || status === 403) return '저장 권한이 없습니다. 설정에서 연결 토큰을 확인해 주세요.';
  if (status === 409 && body && typeof body === 'object' && 'error' in body && body.error === 'readonly_workflow') {
    return '읽기 전용 워크플로는 덮어쓸 수 없습니다. 사본으로 열어 주세요.';
  }
  if (/name mismatch/i.test(reason)) return '이름 칸과 워크플로 이름이 달라 저장하지 못했습니다. 다시 저장해 주세요.';
  if (issues.length) return `저장하지 못했습니다: ${String(issues[0]?.message ?? '').slice(0, 120)}`;
  if (status === 409) return '같은 이름의 워크플로가 이미 있습니다. 다른 이름을 적어 주세요.';
  return '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}
