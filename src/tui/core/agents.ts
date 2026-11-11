import type { SerializedMessage } from '../../session/index.js';
import { parseToolResultEnvelope } from '../../chat/tool-render/result-text.js';
import type { BackgroundTaskSnapshot } from '../chat/background-job-status.js';

export type AgentDisplayStatus = 'running' | 'background' | 'done' | 'failed';
export interface AgentDisplay { readonly id: string; readonly description: string; readonly status: AgentDisplayStatus; readonly source?: 'nested' }
export type AgentDisplayEvent =
  | { readonly phase: 'start'; readonly id: string; readonly description?: string; readonly source?: 'nested' }
  | { readonly phase: 'finish'; readonly id: string; readonly status: Exclude<AgentDisplayStatus, 'running'> };

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? parseToolResultEnvelope(value).value : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

function description(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  return Array.from(raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 64).join('');
}

export function agentResultStatus(result: unknown): Exclude<AgentDisplayStatus, 'running'> {
  const value = record(result);
  if (value?.isError === true || typeof value?.error === 'string'
    || (typeof value?.output === 'string' && value.output.startsWith('NOT SPAWNED'))) return 'failed';
  if (value?.background === true) return 'background';
  return 'done';
}

/** Project only Agent tool events; the REPL remains the owner of child execution. */
export function applyAgentEvent(current: readonly AgentDisplay[], event: AgentDisplayEvent): AgentDisplay[] {
  const previous = current.find((item) => item.id === event.id);
  const next: AgentDisplay = event.phase === 'start'
    ? { id: event.id, description: description(event.description), status: 'running', ...(event.source ? { source: event.source } : {}) }
    : { id: event.id, description: previous?.description ?? '', status: event.status, ...(previous?.source ? { source: previous.source } : {}) };
  return [...current.filter((item) => item.id !== event.id), next];
}

/** Replace completed descendants from the sticky REPL status frame. */
export function reconcileNestedAgentSnapshot(current: readonly AgentDisplay[], value: unknown): AgentDisplay[] {
  if (!Array.isArray(value)) return [...current];
  let next = current.filter((item) => item.source !== 'nested');
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string'
      || typeof item.description !== 'string' || !item.description.startsWith('↳ ')
      || (item.status !== 'done' && item.status !== 'failed')) continue;
    next = applyAgentEvent(next, { phase: 'start', id: item.id, description: item.description, source: 'nested' });
    next = applyAgentEvent(next, { phase: 'finish', id: item.id, status: item.status });
  }
  return next;
}

/** AgentOutput is the authoritative terminal result for a background Agent card. */
export function reconcileAgentOutputStatuses(
  current: readonly AgentDisplay[],
  messages: readonly SerializedMessage[],
  tasks: readonly BackgroundTaskSnapshot[] = [],
): AgentDisplay[] {
  const statuses = new Map(current.map((item) => [item.id, item.status]));
  const callByTaskId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolName !== 'Agent' || !message.toolCallId) continue;
    const taskId = record(message.toolResult)?.taskId;
    if (typeof taskId === 'string') callByTaskId.set(taskId, message.toolCallId);
  }
  for (const task of tasks) {
    const callId = callByTaskId.get(task.id) ?? task.id;
    if (!statuses.has(callId)) continue;
    if (task.state === 'done') statuses.set(callId, 'done');
    if (task.state === 'error' || task.state === 'aborted') statuses.set(callId, 'failed');
  }
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolName !== 'AgentOutput' || message.toolResult === undefined) continue;
    const output = record(message.toolResult);
    const id = typeof output?.taskId === 'string' ? (callByTaskId.get(output.taskId) ?? output.taskId) : '';
    if (!statuses.has(id) || output?.retrievalStatus !== 'success') continue;
    statuses.set(id, output.state === 'done' ? 'done' : 'failed');
  }
  return current.map((item) => ({ ...item, status: statuses.get(item.id) ?? item.status }));
}

export function agentDisplayLine(item: Pick<AgentDisplay, 'description' | 'status'>): string {
  const head = item.description ? `Agent(${item.description})` : 'Agent';
  const status = item.status === 'failed' ? '✗' : item.status === 'done' ? '✓' : '◐';
  const tail = item.status === 'failed' ? '실패' : item.status === 'done' ? '완료'
    : item.status === 'background' ? '백그라운드 실행 중' : '진행 중';
  return `${status} ${head} · ${tail}`;
}

export function agentDisplayLines(items: readonly AgentDisplay[]): string[] {
  if (!items.length) return [];
  const running = items.filter(({ status }) => status === 'running').length;
  const background = items.filter(({ status }) => status === 'background').length;
  const done = items.filter(({ status }) => status === 'done').length;
  const failed = items.filter(({ status }) => status === 'failed').length;
  const active = running + background;
  const parts = [
    ...(active ? [`실행 중 ${active}`] : []),
    ...(done ? [`완료 ${done}`] : []),
    ...(failed ? [`실패 ${failed}`] : []),
  ];
  const marker = active ? '◐' : failed ? '✗' : '✓';
  return [`${marker} 하위 에이전트 · ${parts.join(' · ')}`];
}

/** Persisted Agent tool results use the same one-line shape after the turn settles. */
export function agentTraceLine(message: Pick<SerializedMessage, 'toolName' | 'toolArgs' | 'toolResult'>): string | null {
  if (message.toolName !== 'Agent') return null;
  const args = record(message.toolArgs);
  return agentDisplayLine({
    description: description(args?.description),
    status: message.toolResult === undefined ? 'running' : agentResultStatus(message.toolResult),
  });
}
