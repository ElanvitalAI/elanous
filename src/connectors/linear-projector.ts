import { createHash } from 'node:crypto';
import type { Task, TaskExecution, TaskStatus } from '../task-orchestrator/types.js';
import { EventLedger } from './event-ledger.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const STATE_NAMES: Partial<Record<TaskStatus, string>> = {
  running: 'In Progress',
  review: 'In Review',
  done: 'Done',
  failed: 'Todo',
};

type ProjectableTask = Pick<Task, 'id' | 'status' | 'generatedBy' | 'lastExecutionId' | 'notes'>;

export interface LinearProjectionOptions {
  task: ProjectableTask;
  apiKey: string;
  fetch?: typeof fetch;
  ledger?: EventLedger;
  /** Linear user ID for the elanous agent, when configured. */
  assigneeId?: string;
  execution?: Pick<TaskExecution, 'output' | 'error'>;
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

function projectionComment(task: ProjectableTask, execution?: LinearProjectionOptions['execution']): string | null {
  switch (task.status) {
    case 'running': return `elanous 실행 시작 (task: ${task.id}${task.lastExecutionId ? `, execution: ${task.lastExecutionId}` : ''}).`;
    case 'review': return `elanous 실행 결과가 사람 확인을 기다립니다 (task: ${task.id}).${execution?.output ? `\n\n${execution.output.slice(0, 2000)}` : ''}`;
    case 'done': return `elanous 실행 완료 (task: ${task.id}).${execution?.output ? `\n\n${execution.output.slice(0, 2000)}` : ''}`;
    case 'failed': {
      const reason = execution?.error?.message ?? task.notes.at(-1);
      return `elanous 실행 실패 (task: ${task.id}).${reason ? `\n\n${reason.slice(0, 2000)}` : ''}`;
    }
    default: return null;
  }
}

/** Project only Linear-origin task transitions. Every successful write is recorded for inbound echo filtering. */
export async function projectLinearTask({ task, apiKey, fetch: fetchFn = fetch, ledger, assigneeId, execution }: LinearProjectionOptions): Promise<boolean> {
  if (task.generatedBy?.kind !== 'external' || task.generatedBy.provider !== 'linear' || !task.generatedBy.ref || !STATE_NAMES[task.status]) return false;
  if (!apiKey) throw new Error('Linear API key is required for projection');
  const issueId = task.generatedBy.ref;
  const events = ledger ?? new EventLedger();
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

  const comment = projectionComment(task, execution);
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
