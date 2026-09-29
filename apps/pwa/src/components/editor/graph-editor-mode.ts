export type GraphEditorMode = 'workflow' | 'harness';

export function resolveGraphEditorMode(value: string | null): GraphEditorMode {
  return value === 'harness' ? 'harness' : 'workflow';
}

export function graphEditorHref(mode: GraphEditorMode): string {
  return `/app/editor/?mode=${mode}`;
}
