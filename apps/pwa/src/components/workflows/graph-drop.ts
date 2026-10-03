import type { GraphKindEntry } from '@/nexus/client';
import type { NodeVariant, WorkflowDefinitionLike } from './workflow-graph-layout';
import { addNode, setNodePosition } from './workflow-graph-mutations';

export const DRAG_MIME = 'application/x-elanous-node';

const CORE_VARIANTS = new Set<NodeVariant>([
  'prompt', 'bash', 'skill', 'cft', 'approval', 'if', 'switch', 'iteration',
  'classify', 'extract', 'set', 'filter', 'template', 'http',
  'scheduleTrigger', 'webhookTrigger', 'discordTrigger', 'telegramTrigger',
  'manualTrigger', 'chatTrigger',
]);

export function encodeDrag(entry: GraphKindEntry): string {
  return JSON.stringify(entry);
}

export function decodeDrag(value: string): GraphKindEntry | null {
  try {
    const entry: unknown = JSON.parse(value);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (candidate.graph !== 'workflow' || typeof candidate.kind !== 'string'
      || typeof candidate.core !== 'boolean' || typeof candidate.description !== 'string'
      || (candidate.plugin !== undefined && candidate.plugin !== null && typeof candidate.plugin !== 'string')) return null;
    if (candidate.core ? !CORE_VARIANTS.has(candidate.kind as NodeVariant)
      : !/^[a-z0-9-]+:[a-z0-9-]+$/.test(candidate.kind)) return null;
    return entry as GraphKindEntry;
  } catch {
    return null;
  }
}

export function addNodeAt(
  def: WorkflowDefinitionLike,
  variant: GraphKindEntry,
  position: { x: number; y: number },
): { def: WorkflowDefinitionLike; id: string } {
  const added = addNode(def, variant.core ? variant.kind as NodeVariant : 'unknown');
  const id = added.nodes.at(-1)!.id;
  const withKind = variant.core ? added : {
    ...added,
    nodes: [
      ...added.nodes.slice(0, -1),
      { id, kind: variant.kind, inputs: {} },
    ],
  };
  return { def: setNodePosition(withKind, id, position), id };
}
