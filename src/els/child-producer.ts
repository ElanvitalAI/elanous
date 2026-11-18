// els child producer — the first live source of child tabs: the agent registry's sub-agent start/end events become
// `child` requests to the els server. Fail-soft: no els server, a refused request or a throw never reaches the agent.
// Active only when ELANOUS_ELS_WS names the parent workspace (els sets it for the eln it launches); otherwise nothing
// is wired and no socket is touched.
import type { AgentRegistry } from '../agent/registry.js';
import type { AgentTask } from '../agent/types.js';
import { requestEls } from './client.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

export interface ElsChildProducerOpts {
  readonly registry: AgentRegistry;
  readonly ws: string;
  readonly socketPath: string;
  readonly cwd?: string;
  readonly request?: (socketPath: string, request: ElsRequest) => Promise<ElsResult>;
}

const labelOf = (task: AgentTask): string => task.label?.trim() || task.definition.name || task.id.slice(0, 8);

export function wireElsChildProducer(opts: ElsChildProducerOpts): { dispose(): void } {
  const send = opts.request ?? ((socketPath, request) => requestEls(socketPath, request));
  const post = (request: ElsRequest): void => { void send(opts.socketPath, request).catch(() => { /* no els server: nothing to show */ }); };
  const parentOf = (task: AgentTask): { parent: string } | Record<string, never> => task.parentTaskId ? { parent: task.parentTaskId } : {};
  const started = opts.registry.onTaskStart((task) => {
    post({ op: 'child', action: 'start', id: task.id, ws: opts.ws, source: 'subagent', label: labelOf(task),
      ...(opts.cwd ? { cwd: opts.cwd } : {}), ...parentOf(task) });
  });
  const done = opts.registry.onTaskDone((task) => {
    const ok = task.state === 'done';
    const text = (ok ? task.result : task.error ?? task.result ?? task.state) ?? task.state;
    post({ op: 'child', action: 'end', id: task.id, ok, summary: text.replace(/\s+/g, ' ').slice(0, 200) });
  });
  return { dispose: () => { started.dispose(); done.dispose(); } };
}
