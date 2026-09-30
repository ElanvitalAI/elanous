import type { GraphApproval } from '../../lib/graph-approvals-api';

/** A node can exit 0 yet report `outcome: fail` (the graph routes on it) — show that as not passed. */
function stepPassed(step: GraphApproval['recent'][number]): boolean {
  return step.ok && step.outcome !== 'fail' && step.outcome !== 'error';
}

export function graphApprovalCard(item: GraphApproval, now = Date.now()) {
  const title = item.graphId === 'release-loop' ? '릴리스 발행' : item.graphId === 'announce-loop' ? '공지' : item.graphId;
  const since = Date.parse(item.since);
  const minutes = Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / 60_000));
  const waiting = minutes < 1 ? '방금 전' : minutes < 60 ? `${minutes}분 전` : minutes < 1_440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1_440)}일 전`;
  return {
    title, nodeId: item.nodeId, waiting, message: item.message,
    recent: item.recent.map((step) => `${stepPassed(step) ? '✓' : '✗'} ${step.nodeId}${step.outcome ? ` · ${step.outcome}` : ''}${step.summary ? ` · ${step.summary}` : ''}`),
  };
}

/** Latest-request gate: a list response that started before a newer one (e.g. before a decision's
 * refresh) must not overwrite it, or an already-decided run reappears as approvable. */
export function createLatestRequestGate() {
  let latest = 0;
  return {
    begin(): number { latest += 1; return latest; },
    isLatest(token: number): boolean { return token === latest; },
  };
}
