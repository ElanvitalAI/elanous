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
    if (candidate.core ? !/^[a-z][a-zA-Z0-9]*$/.test(candidate.kind)
      : !/^[a-z0-9-]+:[a-z0-9-]+$/.test(candidate.kind)) return null;
    return entry as GraphKindEntry;
  } catch {
    return null;
  }
}

export function addPaletteNode(def: WorkflowDefinitionLike, entry: GraphKindEntry): WorkflowDefinitionLike {
  const knownCore = entry.core && CORE_VARIANTS.has(entry.kind as NodeVariant);
  const added = addNode(def, knownCore ? entry.kind as NodeVariant : 'unknown');
  if (knownCore) return added;
  const id = added.nodes.at(-1)!.id;
  return {
    ...added,
    nodes: [
      ...added.nodes.slice(0, -1),
      entry.core ? { id, [entry.kind]: {} } : { id, kind: entry.kind, inputs: {} },
    ],
  };
}

export function addNodeAt(
  def: WorkflowDefinitionLike,
  variant: GraphKindEntry,
  position: { x: number; y: number },
): { def: WorkflowDefinitionLike; id: string } {
  const added = addPaletteNode(def, variant);
  const id = added.nodes.at(-1)!.id;
  return { def: setNodePosition(added, id, position), id };
}
