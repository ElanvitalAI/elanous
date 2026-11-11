import type { GraphInstanceView } from './view-model.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const dot: Record<GraphInstanceView['nodes'][number]['state'], string> = {
  queued: '○', running: '●', waiting: '◐', done: '✓', failed: '✕', unknown: '?',
  on: '●', off: '○', stopped: '◼',
};

function plain(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
}

function fit(value: string, width: number): string {
  const text = plain(value);
  const limit = Math.max(0, width);
  let result = '';
  let cells = 0;
  const clipped = Bun.stringWidth(text) > limit;
  const contentLimit = clipped ? Math.max(0, limit - 1) : limit;
  for (const { segment } of segmenter.segment(text)) {
    const size = Bun.stringWidth(segment);
    if (cells + size > contentLimit) break;
    result += segment;
    cells += size;
  }
  if (clipped && limit > 0) { result += '…'; cells++; }
  return result + ' '.repeat(Math.max(0, limit - cells));
}

function fitEnd(value: string, width: number): string {
  const text = plain(value);
  const limit = Math.max(0, width);
  if (Bun.stringWidth(text) <= limit) return fit(text, limit);
  if (limit === 0) return '';
  let result = '';
  let cells = 0;
  for (const { segment } of [...segmenter.segment(text)].reverse()) {
    const size = Bun.stringWidth(segment);
    if (cells + size > limit - 1) break;
    result = segment + result;
    cells += size;
  }
  return fit(`…${result}`, limit);
}

function bar(ratio: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.floor(cells * ratio)));
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
}

function progressLine(view: GraphInstanceView, width: number): string {
  const { completed, total } = view.progress;
  const label = view.progress.label ?? '진행';
  if (total === null || total === 0) return fit(`${label} ░░░ ${completed}/?`, width);
  const cells = Math.max(1, Math.min(10, width - 11));
  return fit(`${label} ${bar(completed / total, cells)} ${completed}/${total}`, width);
}

/** Terminal-only projection. Semantic identity, status and order stay in the JSON. */
export function renderGraphInstanceTerminal(view: GraphInstanceView, width: number, height: number, selectedNodeId?: string): string[] {
  const columns = Math.max(0, Math.floor(width));
  const rows = Math.max(0, Math.floor(height));
  if (columns === 0 || rows === 0) return [];
  const statusPrefix = '상태 │ ';
  const status = columns <= Bun.stringWidth(statusPrefix)
    ? fit(statusPrefix, columns)
    : statusPrefix + fitEnd(view.statusLine, columns - Bun.stringWidth(statusPrefix));
  if (rows === 1) return [status];
  const progress = progressLine(view, columns);
  if (rows === 2) return [progress, status];

  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const diagram: string[] = [fit(`${view.instance.title} · ${view.instance.source}`, columns)];
  const nodeLineStarts = new Map<string, number>();
  for (const node of view.nodes) {
    nodeLineStarts.set(node.id, diagram.length);
    const bodyWidth = Math.max(0, columns - 2);
    const label = `${dot[node.state]} ${node.label}${node.resource ? ` · ${node.resource.hostKind}` : ''}${node.model ? ` · ${node.model}` : ''}${node.role ? ` · ${node.role}` : ''}`;
    if (columns >= 4) {
      diagram.push(`┌${'─'.repeat(bodyWidth)}┐`);
      diagram.push(`│${fit(label, bodyWidth)}│`);
      diagram.push(`└${'─'.repeat(bodyWidth)}┘`);
    } else diagram.push(fit(label, columns));
    if (node.resource) {
      const { cpuCores, loadavg, memory, tasks } = node.resource;
      const cpu = cpuCores && loadavg ? `CPU ${bar(loadavg[0] / cpuCores, 5)} ${loadavg[0].toFixed(1)}` : 'CPU 측정 없음';
      const mem = memory && memory.totalBytes > 0 ? `MEM ${bar(memory.usedBytes / memory.totalBytes, 5)} ${Math.round(100 * memory.usedBytes / memory.totalBytes)}%` : 'MEM 측정 없음';
      diagram.push(fit(` ${cpu}`, columns), fit(` ${mem}`, columns));
      diagram.push(fit(` 작업 ${tasks.length ? tasks.map((task) => `${task.kind}:${task.label}`).join(' · ') : '없음'}`, columns));
    }
    for (const edge of view.edges.filter((item) => item.from === node.id)) {
      const target = byId.get(edge.to)?.label ?? edge.to;
      const arrow = edge.kind === 'branch' ? '├┄>' : edge.kind === 'join' ? '└┄>' : '┄┄>';
      diagram.push(fit(` ${arrow} ${target}`, columns));
    }
  }
  const latestLogs = [...view.logs].sort((a, b) => a.seq - b.seq);
  const reserve = 2 + (latestLogs.length > 0 && rows >= 4 ? 1 : 0);
  const diagramCapacity = Math.max(0, rows - reserve);
  const active = selectedNodeId ?? view.progress.activeNodeIds[0];
  // Keep the complete selected box in view when the side panel is short.
  const activeLine = active ? nodeLineStarts.get(active) ?? 0 : 0;
  const start = activeLine >= diagramCapacity && diagramCapacity > 0 ? Math.min(activeLine, diagram.length - diagramCapacity) : 0;
  const visible = diagram.slice(start, start + diagramCapacity);
  const logCapacity = Math.max(0, rows - visible.length - 2);
  const logLines = logCapacity > 0 ? latestLogs.slice(-logCapacity).map((log) => fit(`로그 │ ${log.text}`, columns)) : [];
  return [...visible, ...logLines, progress, status].slice(-rows);
}
