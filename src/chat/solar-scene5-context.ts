import { readFileSync } from 'node:fs';

export const SOLAR_SCENE5_QUESTION = '오늘 데모에서 확인한 사실과 아직 확인하지 못한 사실을 각각 두 항목으로 구분해 한국어로 써 주세요.';

interface GraphReceipt {
  graphId: string;
  runId: string;
  status: string;
  path: string[];
  nodes: Array<{ nodeId: string; ok: boolean; executed: boolean }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

/** Extract only graph-run provenance and outcomes. Raw node output can contain private data. */
export function parseSolarScene4Receipt(raw: unknown): GraphReceipt {
  if (!isRecord(raw)
    || typeof raw.graphId !== 'string' || !raw.graphId.trim()
    || typeof raw.runId !== 'string' || !raw.runId.trim()
    || !['running', 'paused', 'cancelled', 'done', 'failed', 'budget-exceeded', 'awaiting-approval'].includes(String(raw.status))
    || !Array.isArray(raw.path) || !raw.path.every(item => typeof item === 'string')
    || !Array.isArray(raw.nodes)
    || !raw.nodes.every(node => isRecord(node) && typeof node.nodeId === 'string' && typeof node.ok === 'boolean' && typeof node.executed === 'boolean')) {
    throw new Error('scene 4 receipt must be graph run --json output with graphId, runId, status, path and nodes');
  }
  return {
    graphId: cleanLine(raw.graphId),
    runId: cleanLine(raw.runId),
    status: String(raw.status),
    path: raw.path.map(item => cleanLine(item as string)),
    nodes: raw.nodes.map(node => ({
      nodeId: cleanLine((node as Record<string, unknown>).nodeId as string),
      ok: (node as Record<string, unknown>).ok as boolean,
      executed: (node as Record<string, unknown>).executed as boolean,
    })),
  };
}

export function composeSolarScene5Input(receipt: GraphReceipt): string {
  const nodeSummary = receipt.nodes.length
    ? receipt.nodes.map(node => `${node.nodeId}: ${node.executed ? (node.ok ? '실행 성공' : '실행 실패') : '실행 안 됨'}`).join(', ')
    : '기록 없음';
  return [
    '직전 장면 4의 실제 graph run 영수증 요약:',
    `graphId: ${receipt.graphId}`,
    `runId: ${receipt.runId}`,
    `최종 상태: ${receipt.status}`,
    `경로: ${receipt.path.join(' → ') || '기록 없음'}`,
    `노드 결과: ${nodeSummary}`,
    '이 영수증은 장면 4만 증명합니다. 장면 1~3의 결과와 Solar provider/model 호출 여부는 이 영수증만으로 확인할 수 없습니다. 영수증에 없는 성공이나 호출을 지어내지 마세요.',
    '',
    SOLAR_SCENE5_QUESTION,
  ].join('\n');
}

/** CLI bridge: consume the exact JSON printed by the preceding graph scene. */
export function solarScene5InputFromFile(file: string): string {
  return composeSolarScene5Input(parseSolarScene4Receipt(JSON.parse(readFileSync(file, 'utf8'))));
}
