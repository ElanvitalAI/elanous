import type { GraphKindEntry } from '@/nexus/client';
import { CORE_GRAPH_KINDS, CORE_WORKFLOW_KINDS } from '@/lib/run-graph-yaml-edit';

export type GraphEditorMode = GraphKindEntry['graph'];

/** Node groups are palette sections, not mutually exclusive editor modes. `graph` remains the wire vocabulary. */
export const GRAPH_EDITOR_NODE_GROUPS = [
  { graph: 'workflow', label: '작업 노드', fallbackKinds: CORE_WORKFLOW_KINDS },
  { graph: 'harness', label: '실행 단계 노드', fallbackKinds: CORE_GRAPH_KINDS },
] as const satisfies readonly { graph: GraphEditorMode; label: string; fallbackKinds: readonly string[] }[];

export interface GraphEditorNodeGroup {
  graph: GraphEditorMode;
  label: string;
  kinds: GraphKindEntry[];
  fallback: boolean;
}

/** Preserve each kind's graph identity for graph-specific validation and saving on the shared palette. */
export function graphEditorNodeGroups(kinds: readonly GraphKindEntry[]): GraphEditorNodeGroup[] {
  return GRAPH_EDITOR_NODE_GROUPS.map(({ graph, label, fallbackKinds }) => {
    const available = kinds.filter((entry) => entry.graph === graph);
    return {
      graph, label,
      kinds: available.length ? available : fallbackKinds.map((kind) => ({
        graph, kind, plugin: null, description: '', schema: {}, core: true,
      })),
      fallback: available.length === 0,
    };
  });
}

export function resolveGraphEditorMode(value: string | null): GraphEditorMode {
  return value === 'harness' ? 'harness' : 'workflow';
}

export function graphEditorHref(mode: GraphEditorMode): string {
  // Legacy deep links still name the wire graph, even though the palette now shows both groups.
  const group = GRAPH_EDITOR_NODE_GROUPS.find((entry) => entry.graph === mode)!;
  return `/app/editor/?mode=${group.graph}`;
}
