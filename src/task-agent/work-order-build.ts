import { parseWorkOrder, type WorkOrder } from './work-order.js';

export interface BuildWorkOrderInput {
  cellId: string;
  version: string;
  lifeId?: string;
  priority?: string;
  peers?: string;
}

/** Build the normalized nine-field core from already-grounded inputs; no CLI, filesystem, or launch side effects. */
export function buildWorkOrder(input: BuildWorkOrderInput): WorkOrder {
  const parsed = parseWorkOrder(JSON.stringify({
    cellId: input.cellId,
    lifeId: input.lifeId,
    version: input.version,
    priority: input.priority,
    peers: input.peers,
  }));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.order;
}
