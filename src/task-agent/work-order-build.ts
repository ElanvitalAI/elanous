import { createHash } from 'node:crypto';
import { parseWorkOrder, workOrderBudgetLimits, WORK_ORDER_FIELDS, type WorkOrder } from './work-order.js';

export type WorkOrderRevision = string;

export interface BuildWorkOrderInput {
  cellId: string;
  version: string;
  lifeId?: string;
  priority?: string;
  peers?: string;
  boundary?: string;
  /** 시간·모델 티어·Pod 자리·재작업 상한 — critical 칸(비면 hand 가 발사 거부). */
  budget?: string;
  /** 현재 계약 — critical 칸. */
  contract?: string;
  /** 막히면 누구에게 올리는지 — critical 칸. */
  escalation?: string;
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
    budget: input.budget,
    contract: input.contract,
    escalation: input.escalation,
  }));
  if (!parsed.ok) throw new Error(parsed.reason);
  const budgetLimits = input.budget === undefined ? undefined : workOrderBudgetLimits(input.budget); // TA-BUDGET-WALL: 무효 예산은 관용(budgetLimits 생략) — 벽은 handTask 발사 경계(taBudgetWallRefusal)에서 난다.
  return { ...parsed.order, ...(budgetLimits ? { budgetLimits } : {}) };
}


/** Hash only normalized work-order fields and their source revision; callers log the digest, never the directive body. */
export function hashWorkOrderContent(order: WorkOrder, sourceRevision: WorkOrderRevision): string {
  const canonical = {
    cellId: order.cellId.trim(),
    sourceRevision: sourceRevision.trim(),
    fields: WORK_ORDER_FIELDS.map((field) => [field, order[field].trim()] as const),
    ...(order.owner !== undefined ? { owner: order.owner } : {}),
    ...(order.card !== undefined ? { card: order.card } : {}),
    ...(order.noAutoMerge !== undefined ? { noAutoMerge: order.noAutoMerge } : {}),
    ...(order.budgetLimits !== undefined ? { budgetLimits: order.budgetLimits } : {}),
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
