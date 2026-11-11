/** Gate deadlines are scoped to an active cloud lease, not an old join after cleanup. */
export function activeReleaseCloudDeadline(nodes: readonly { nodeId: string; ok: boolean; output?: unknown }[]): number | undefined {
  const leaveNodes = new Set(['cloud-leave-ok', 'cloud-leave-fail', 'cloud-leave-error', 'cloud-leave-join-fail']);
  const transition = [...nodes].reverse().find(record => record.ok &&
    (record.nodeId === 'cloud-join' || leaveNodes.has(record.nodeId)));
  if (transition?.nodeId !== 'cloud-join') return undefined;
  let output = transition.output;
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { return undefined; }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const deadlineAt = (output as Record<string, unknown>).deadlineAt;
  return typeof deadlineAt === 'number' ? deadlineAt : undefined;
}
