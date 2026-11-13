type Row = Record<string, unknown>;

const row = (value: unknown): Row => {
  if (typeof value === 'string') {
    try { return row(JSON.parse(value) as unknown); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Show only the persisted, source-linked briefing from the completed graph. */
export function nextScene2BriefReceipt(value: unknown, expectedGraphId: string): string | null {
  const graph = row(value);
  if (!expectedGraphId || graph.graphId !== expectedGraphId || graph.status !== 'done') return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(row) : [];
  const briefIndex = nodes.findIndex(node => row(row(node.output).evidence).briefing !== undefined);
  const briefNodeId = string(nodes[briefIndex]?.nodeId);
  const saveNodeId = ['save', briefNodeId].join('-');
  if (briefIndex < 0 || !nodes.slice(briefIndex + 1).some(node => node.ok === true && node.executed === true
    && node.nodeId === saveNodeId && row(row(node.output).result).stored === true)) return null;
  const brief = row(row(nodes[briefIndex]?.output).evidence);
  const briefing = row(brief.briefing);
  const id = string(briefing.id);
  const summary = string(briefing.summary);
  const owner = string(brief.memberId);
  const scrapIds = briefing.scrapIds;
  if (!id || !summary || !owner || !Array.isArray(scrapIds) || scrapIds.length === 0
    || !scrapIds.every(source => string(source))) return null;
  return [`흡수·브리핑 완료 · ${id}`, summary,
    `출처 스크랩: ${scrapIds.map(string).join(', ')}`].join('\n');
}
