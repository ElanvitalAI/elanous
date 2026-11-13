import { createNexusBoardAdapter, type NexusBoardAdapterOptions } from '../tui-client/nexus-board-adapter.js';
import { projectTuiMiniBoard, formatTuiMiniBoardCard } from '../tui-client/mini-board-projection.js';

type GraphState = { graphId?: unknown; status?: unknown; runId?: unknown };

const normalizedRunId = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value : '';

/** Consume the authoritative member board after the build graph, without inferring deployment from the graph alone. */
export async function nextScene6BoardReceipt(input: {
  graph: unknown;
  expectedGraphId: string;
  cardId: string;
  memberId: string;
  nexusUrl: string;
  sessionToken: string;
  fetchImpl?: NexusBoardAdapterOptions['fetchImpl'];
}): Promise<string | null> {
  const graph = input.graph as GraphState | null;
  const runId = normalizedRunId(graph?.runId);
  if (!graph || !input.expectedGraphId || graph.graphId !== input.expectedGraphId || graph.status !== 'done' || !runId || !input.cardId || !input.memberId) return null;
  const adapter = createNexusBoardAdapter({
    baseUrl: input.nexusUrl, accessToken: () => input.sessionToken,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const entries = await adapter.read(input.memberId);
  // Project only the authoritative current-run rows. Otherwise foldCard can
  // combine a current-run identity with an older deployed release or attachment.
  const currentRun = entries.filter(entry => entry.taskId === input.cardId && normalizedRunId(entry.runId) === runId);
  if (!currentRun.length) return null;
  const board = projectTuiMiniBoard(currentRun);
  const card = board.columns.find(column => column.id === 'done')?.cards.find(row => row.taskId === input.cardId);
  if (!card) return null;
  const attachments = card.attachments ?? [];
  if (!attachments.some(item => item.kind === 'diagram') || !attachments.some(item => item.kind === 'pdf')) return null;
  return `개발 진행 보드 · 배포됨\n${formatTuiMiniBoardCard(card)}`;
}
