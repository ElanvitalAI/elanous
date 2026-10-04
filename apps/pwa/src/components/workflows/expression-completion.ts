import type { WorkflowDefinitionLike } from './workflow-graph-layout';

// Keep candidate identifiers aligned with workflow-runtime/variables.ts VARIABLE_RE.
const NODE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function variableLabel(candidate: string): string {
  if (candidate === '$ARGUMENTS') return '실행할 때 받은 인자';
  if (candidate === '$ARTIFACTS_DIR') return '산출물 폴더';
  const match = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)\.output(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/.exec(candidate);
  if (!match) return candidate;
  return match[2] ? `${match[1]} 노드 결과의 ${match[2]}` : `${match[1]} 노드 결과`;
}

export function getExpressionCandidates(def: WorkflowDefinitionLike, nodeId: string, typed: string): string[] {
  if (!/^\$[A-Za-z0-9_.-]*$/.test(typed)) return [];

  const nodes = new Map((def.nodes ?? []).map((node) => [node.id, node]));
  const current = nodes.get(nodeId);
  const candidates = new Set<string>(['$ARGUMENTS', '$ARTIFACTS_DIR']);
  const visited = new Set<string>([nodeId]);
  const pending = [...(current?.depends_on ?? [])];

  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    pending.push(...(Array.isArray(node.depends_on) ? node.depends_on : []));
    if (!NODE_ID_RE.test(id)) continue;

    candidates.add(`$${id}.output`);
    const format = node['output_format'];
    if (!format || typeof format !== 'object' || Array.isArray(format)) continue;
    const properties = (format as Record<string, unknown>)['properties'];
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue;
    for (const field of Object.keys(properties)) {
      if (FIELD_RE.test(field)) candidates.add(`$${id}.output.${field}`);
    }
  }
  return [...candidates].filter((candidate) => candidate.startsWith(typed));
}
