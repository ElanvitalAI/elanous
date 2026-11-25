/** A known dependency. Unknown targets are retained by the caller, never inferred here. */
export interface WaitEdge {
  from: string;
  to: string | null;
  sinceMs: number;
}

export const WAIT_CYCLE_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Return strongly connected waiting groups whose every connecting edge has been
 * waiting for at least ten minutes. Input is a snapshot, not a durable history:
 * callers must supply the start of the current, uninterrupted dependency.
 * Unknown targets and invalid/future timestamps cannot establish a cycle.
 * This pure function does not notify, wake, or change any seat's state.
 */
export function detectWaitCycles(edges: readonly WaitEdge[], nowMs: number): string[][] {
  if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.from || !edge.to || !Number.isFinite(edge.sinceMs) ||
        nowMs - edge.sinceMs < WAIT_CYCLE_THRESHOLD_MS) continue;
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
    graph.get(edge.from)!.add(edge.to);
  }
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  function visit(node: string): void {
    indices.set(node, index);
    low.set(node, index++);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node)!) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== node);
    if (group.length > 1 || graph.get(node)!.has(node)) result.push(group.sort());
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return result.sort((a, b) => a[0]!.localeCompare(b[0]!));
}
