import { createHash } from 'node:crypto';
import { parseWorkOrder, WORK_ORDER_FIELDS, type WorkOrder } from './work-order.js';

export type WorkOrderRevision = string;

export interface BuildWorkOrderInput {
  cellId: string;
  version: string;
  lifeId?: string;
  priority?: string;
  peers?: string;
  boundary?: string;
}

/** Build the normalized nine-field core from already-grounded inputs; no CLI, filesystem, or launch side effects. */
export function buildWorkOrder(input: BuildWorkOrderInput): WorkOrder {
  const parsed = parseWorkOrder(JSON.stringify({
    cellId: input.cellId,
    lifeId: input.lifeId,
    version: input.version,
    priority: input.priority,
    peers: input.peers,
    boundary: input.boundary,
  }));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.order;
}


/** Hash only normalized work-order fields and their source revision; callers log the digest, never the directive body. */
export function hashWorkOrderContent(order: WorkOrder, sourceRevision: WorkOrderRevision): string {
  const canonical = {
    cellId: order.cellId.trim(),
    sourceRevision: sourceRevision.trim(),
    fields: WORK_ORDER_FIELDS.map((field) => [field, order[field].trim()] as const),
    dependencies: (order.dependencies ?? []).map(({ cell, state, observedAt }) => ({
      cell: cell.trim(), state: state.trim(), observedAt: observedAt.trim(),
    })).sort((left, right) => {
      const leftKey = JSON.stringify([left.cell, left.state, left.observedAt]);
      const rightKey = JSON.stringify([right.cell, right.state, right.observedAt]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
