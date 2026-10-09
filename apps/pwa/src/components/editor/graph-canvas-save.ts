import { NexusApiError, type GraphWizardSteps, type NexusClient } from '@/nexus/client';
import { mapServerIssues, type CanvasIssue } from './graph-canvas-model';

export type CanvasSaveClient = Pick<NexusClient, 'createRunGraph' | 'putRunGraphYaml'>;

/** Permission changes require a saved graph; unsaved YAML cannot be granted access. */
export function shareableCanvasGraphId(context: { graphId: string; saved: boolean }): string | null {
  return context.saved && context.graphId.trim() ? context.graphId : null;
}

export type GraphAccessClient = Pick<NexusClient, 'getRunGraphAccess' | 'putRunGraphAccess'>;

export async function grantCanvasGraphAccess(client: GraphAccessClient, graphId: string, recipient: string, permission: 'view' | 'edit') {
  const applied = await client.putRunGraphAccess(graphId, recipient, permission);
  const after = await client.getRunGraphAccess(graphId);
  if (!after.grants.some((grant) => grant.recipient === applied.recipient && grant.permission === permission)) {
    throw new Error('권한 적용을 확인할 수 없습니다');
  }
  return after;
}

export type CanvasSaveResult =
  | { ok: true; id: string; created: boolean; version?: number }
  | { ok: false; issues: CanvasIssue[] };

function failed(message: string): CanvasSaveResult {
  return { ok: false, issues: [{ source: 'server', message }] };
}

/** Save through the graph API only. A graph not yet saved goes to create (`POST /v1/graphs`, CGE-SAVE);
 *  one already stored under the same id goes to `PUT /v1/graphs/<id>/yaml`. The server validates both. */
export async function saveCanvasGraph(client: CanvasSaveClient, graphId: string, yaml: string, mode: 'create' | 'update', steps?: GraphWizardSteps): Promise<CanvasSaveResult> {
  try {
    // GRAPH-WIZARD-SAVE-RECIPES — a wizard graph carries its steps so «실행» runs the real library steps.
    const nodeSteps = steps && Object.keys(steps).length ? steps : undefined;
    const saved = mode === 'create' ? await client.createRunGraph(graphId, yaml, nodeSteps) : await client.putRunGraphYaml(graphId, yaml, nodeSteps);
    return { ok: true, id: graphId, created: mode === 'create', ...(typeof saved.version === 'number' ? { version: saved.version } : {}) };
  } catch (error) {
    if (!(error instanceof NexusApiError)) return failed(`저장 실패: ${error instanceof Error ? error.message : String(error)}`);
    const body = (error.body ?? {}) as { error?: string; errors?: Array<{ path?: string; message: string }>; reason?: string };
    if (Array.isArray(body.errors) && body.errors.length > 0) return { ok: false, issues: mapServerIssues(yaml, { errors: body.errors }) };
    if (mode === 'create' && (error.status === 404 || error.status === 405)) {
      return failed('새 그래프 저장(POST /v1/graphs)을 이 Daemon 이 아직 지원하지 않습니다 — 서버 업데이트 후 다시 저장하세요');
    }
    if (error.status === 409) return failed(`«${graphId}» 는 이미 있는 그래프 id 입니다 — 다른 id 를 쓰세요`);
    if (body.error === 'reserved-id') return failed(`«${graphId}» 는 예약된 id 라 쓸 수 없습니다 — 다른 id 를 쓰세요`);
    if (body.error === 'graph-id-mismatch') return failed('YAML 의 graph_id 가 저장할 id 와 다릅니다');
    if (error.status === 403) return failed(`«${graphId}» 는 기본 제공 그래프라 덮어쓸 수 없습니다 — 다른 id 를 쓰세요`);
    if (mode === 'update' && error.status === 404) return failed(`«${graphId}» 가 서버에 없습니다 — 새 그래프로 저장하세요`);
    return failed(body.reason ?? (body.error ? `저장 실패: ${body.error} (${error.status})` : `저장 실패 (${error.status})`));
  }
}
