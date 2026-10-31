import { createHash } from 'node:crypto';
import type { Task, TaskExecution, TaskStatus } from '../task-orchestrator/types.js';
import { EventLedger } from './event-ledger.js';
import { parseLinearSecretaryManifest, readApprovedLinearCapture, updateLinearSecretaryProgress } from '../intake-plane/linear-wish.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const STATE_NAMES: Partial<Record<TaskStatus, string>> = {
  running: 'In Progress',
  review: 'In Review',
  done: 'Done',
  failed: 'Todo',
};

type ProjectableTask = Pick<Task, 'id' | 'status' | 'generatedBy' | 'lastExecutionId' | 'notes'> & Pick<Partial<Task>, 'description' | 'title'>;

export interface LinearProjectionOptions {
  task: ProjectableTask;
  apiKey: string;
  fetch?: typeof fetch;
  ledger?: EventLedger;
  /** Linear user ID for the elanous agent, when configured. */
  assigneeId?: string;
  execution?: Pick<TaskExecution, 'output' | 'error' | 'runId' | 'captureArtifacts'>;
}

async function graphql<T>(apiKey: string, fetchFn: typeof fetch, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetchFn(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  const result = await response.json() as { data?: T; errors?: unknown[] };
  if (result.errors?.length || !result.data) throw new Error('Linear GraphQL returned errors or missing data');
  return result.data;
}

function projectionComment(task: ProjectableTask): string | null {
  switch (task.status) {
    case 'running': return `elanous 실행 시작 (task: ${task.id}${task.lastExecutionId ? `, execution: ${task.lastExecutionId}` : ''}).`;
    case 'review': return `elanous 실행 결과가 사람 확인을 기다립니다 (task: ${task.id}).`;
    case 'done': return `elanous 실행 완료 (task: ${task.id}).`;
    case 'failed': return `elanous 실행 실패 (task: ${task.id}).`;
    default: return null;
  }
}

/** Project only Linear-origin task transitions. Every successful write is recorded for inbound echo filtering. */
export async function projectLinearTask({ task, apiKey, fetch: fetchFn = fetch, ledger, assigneeId, execution }: LinearProjectionOptions): Promise<boolean> {
  if (task.generatedBy?.kind !== 'external' || task.generatedBy.provider !== 'linear' || !task.generatedBy.ref) return false;
  const issueId = task.generatedBy.ref;
  const events = ledger ?? new EventLedger();
  const secretary = parseLinearSecretaryManifest(task.description ?? '', issueId);
  if (secretary) {
    if (task.status !== 'running' && task.status !== 'review' && task.status !== 'done' && task.status !== 'failed') return false;
    if (!apiKey) throw new Error('Linear API key is required for projection');
    const state = task.status === 'running' ? 'started' : task.status === 'done' ? 'completed' : 'comment';
    const captureCandidate = execution?.captureArtifacts?.find(capture =>
      capture.runId === execution.runId && capture.runId.trim().length > 0 &&
      capture.linearIssueId === secretary.parentIssueId && capture.externalShare === true && capture.sensitivity === 'public');
    let captureArtifact: typeof captureCandidate;
    if (captureCandidate) {
      try { readApprovedLinearCapture(captureCandidate); captureArtifact = captureCandidate; }
      catch { /* Invalid, stale, or unavailable captures fail closed; progress still syncs without a URL. */ }
    }
    await updateLinearSecretaryProgress({ apiKey, parentIssueId: secretary.parentIssueId, taskIssueId: issueId,
      taskTitle: secretary.tasks.find(item => item.issueId === issueId)!.title, tasks: secretary.tasks, state,
      summary: task.status === 'running' ? '하위 작업을 시작했습니다.'
        : task.status === 'done' ? '하위 작업을 완료했습니다.'
          : task.status === 'failed' ? '하위 작업이 실패했습니다.' : '하위 작업 진행 상태를 갱신했습니다.',
      workaround: task.status === 'failed' ? 'Linear 상태는 In Progress로 유지하고 실패 내용을 기록했습니다.' : undefined,
      captureArtifact,
      ledger: events, fetch: fetchFn });
    return true;
  }
  if (!STATE_NAMES[task.status]) return false;
  if (!apiKey) throw new Error('Linear API key is required for projection');
  const { issue, viewer } = await graphql<{
    issue?: { team?: { states?: { nodes?: Array<{ id: string; name: string }> } } };
    viewer?: { id?: string };
  }>(apiKey, fetchFn,
    'query ProjectorIssue($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } viewer { id } }', { id: issueId });
  const stateName = STATE_NAMES[task.status];
  const state = issue?.team?.states?.nodes?.find(node => node.name.toLowerCase() === stateName!.toLowerCase());
  if (!state?.id) throw new Error(`Linear team workflow state not found: ${stateName}`);
  const agentId = assigneeId ?? viewer?.id;
  if (task.status === 'running' && !agentId) throw new Error('Linear assignee could not be resolved');

  const update = await graphql<{ issueUpdate?: { success?: boolean; issue?: { updatedAt?: string } } }>(apiKey, fetchFn,
    'mutation ProjectorUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { updatedAt } } }',
    { id: issueId, input: { stateId: state.id, ...(task.status === 'running' ? { assigneeId: agentId } : {}) } });
  if (!update.issueUpdate?.success || !update.issueUpdate.issue?.updatedAt) throw new Error('Linear issueUpdate did not return a successful issue timestamp');
  const stateHash = createHash('sha256').update(JSON.stringify({ stateId: state.id, assigneeId: task.status === 'running' ? agentId : undefined })).digest('hex');
  events.record('linear', `outgoing:state:${issueId}:${update.issueUpdate.issue.updatedAt}:${stateHash}`,
    { ref: issueId, occurredAt: update.issueUpdate.issue.updatedAt });

  const comment = projectionComment(task);
  if (comment) {
    const created = await graphql<{ commentCreate?: { success?: boolean; comment?: { id?: string; updatedAt?: string; issue?: { updatedAt?: string } } } }>(apiKey, fetchFn,
      'mutation ProjectorComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id updatedAt issue { updatedAt } } } }',
      { input: { issueId, body: comment } });
    if (!created.commentCreate?.success || !created.commentCreate.comment?.id || !created.commentCreate.comment.issue?.updatedAt) {
      throw new Error('Linear commentCreate did not return a successful issue timestamp');
    }
    const commentHash = createHash('sha256').update(comment).digest('hex');
    events.record('linear', `outgoing:comment:${created.commentCreate.comment.id}:${commentHash}`,
      { ref: issueId, occurredAt: created.commentCreate.comment.issue.updatedAt });
  }
  return true;
}
