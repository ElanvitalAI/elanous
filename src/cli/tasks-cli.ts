import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import type { Task } from '../task-orchestrator/types.js';

type TaskRow = Pick<Task, 'id' | 'title' | 'priority' | 'status' | 'createdAt' | 'approval' | 'generatedBy'>;

export interface TasksCliDeps {
  baseUrl?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  output?: (line: string) => void;
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const NEXUS_DOWN = '넥서스가 안 떠 있다 — `elanous nexus run`';

function taskOrder(a: TaskRow, b: TaskRow): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function taskSource(task: TaskRow): string {
  return task.generatedBy?.kind === 'external'
    ? `${task.generatedBy.provider}:${task.generatedBy.ref}` : '-';
}

function taskLine(task: TaskRow): string {
  return [task.id, task.priority, task.status, task.approval?.state ?? '-', taskSource(task), task.title].join('\t');
}

function credentials(deps: TasksCliDeps): { baseUrl: string; token?: string } | null {
  const port = deps.baseUrl !== undefined ? undefined : readNexusRuntime()?.httpPort;
  const baseUrl = deps.baseUrl ?? (port ? `http://127.0.0.1:${port}` : undefined);
  if (!baseUrl) return null;
  // Same as `connector linear sync`: an isolated (--test) universe has no acp-token and its
  // daemon accepts loopback callers without one — send the bearer only when there is one.
  let token = deps.bearerToken;
  if (token === undefined) {
    try { token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
    catch { token = undefined; }
  }
  return { baseUrl, ...(token ? { token } : {}) };
}

class NexusUnavailable extends Error {}

async function request(deps: TasksCliDeps, auth: { baseUrl: string; token?: string }, path: string, method = 'GET'): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(`${auth.baseUrl}${path}`, {
      method,
      headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
    });
  } catch {
    // Fetch exceptions can include the URL or credentials; never forward their text.
    throw new NexusUnavailable();
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error('넥서스 응답 JSON이 유효하지 않다'); }
}

function httpError(response: Response): Error {
  // Do not echo server-supplied error bodies: they may contain credentials.
  return new Error(`HTTP ${response.status}`);
}

function handleError(error: unknown, out: (line: string) => void): void {
  if (error instanceof NexusUnavailable) {
    out(NEXUS_DOWN);
    process.exitCode = 2;
  } else {
    out(error instanceof Error ? error.message : '태스크 요청 실패');
    process.exitCode = 1;
  }
}

export function registerTasksCommands(program: Command, deps: TasksCliDeps = {}): void {
  let activeToken: string | undefined;
  const output = deps.output ?? console.log;
  const out = (line: string) => output(activeToken ? line.replaceAll(activeToken, '[redacted]') : line);
  const authenticate = () => {
    const auth = credentials(deps);
    activeToken = auth?.token;
    if (!auth) throw new NexusUnavailable();
    return auth;
  };
  const tasks = program.command('tasks').alias('task').description('TOX 태스크 조회 및 승인');

  tasks.command('list')
    .description('우선순위와 생성 시각 순으로 태스크 보기')
    .option('--status <s>', '상태로 필터')
    .option('--provider <p>', '외부 출처로 필터')
    .option('--json', 'JSON 출력')
    .action(async (opts: { status?: string; provider?: string; json?: boolean }) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, '/v1/tasks');
        if (!response.ok) throw httpError(response);
        const body = await responseJson(response) as { tasks?: Array<Pick<TaskRow, 'id' | 'status'>> };
        if (!Array.isArray(body?.tasks)) throw new Error('넥서스 태스크 목록 형식이 유효하지 않다');
        const cards = body.tasks.filter((task) => !opts.status || task.status === opts.status);
        // The list endpoint returns board cards without approval or provenance.
        // Obtain those fields from the detail endpoint rather than displaying guesses.
        const rows: TaskRow[] = [];
        for (const card of cards) {
          const detail = await request(deps, auth, `/v1/tasks/${encodeURIComponent(card.id)}`);
          if (!detail.ok) throw httpError(detail);
          const data = await responseJson(detail) as { task?: TaskRow };
          if (!data?.task || data.task.id !== card.id) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
          if (!opts.provider || (data.task.generatedBy?.kind === 'external' && data.task.generatedBy.provider === opts.provider)) rows.push(data.task);
        }
        rows.sort(taskOrder);
        if (opts.json) out(JSON.stringify(rows));
        else {
          out('id\t우선순위\t상태\t승인\t출처\t제목');
          for (const row of rows) out(taskLine(row));
        }
      } catch (error) { handleError(error, out); }
    });

  tasks.command('show <id>')
    .description('태스크 상세 보기')
    .option('--json', 'JSON 출력')
    .action(async (id: string, opts: { json?: boolean }) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}`);
        if (!response.ok) throw httpError(response);
        const data = await responseJson(response) as { task?: TaskRow };
        if (!data?.task) throw new Error('넥서스 태스크 상세 형식이 유효하지 않다');
        if (opts.json) out(JSON.stringify(data));
        else {
          out(taskLine(data.task));
          out(JSON.stringify(data, null, 2));
        }
      } catch (error) { handleError(error, out); }
    });

  tasks.command('approve <id...>')
    .description('외부 태스크 승인')
    .action(async (ids: string[]) => {
      try {
        activeToken = undefined;
        const auth = authenticate();
        let failed = false;
        for (const id of ids) {
          try {
            const response = await request(deps, auth, `/v1/tasks/${encodeURIComponent(id)}/approve`, 'POST');
            if (!response.ok) {
              out(`${id}\tfailed HTTP ${response.status}`);
              failed = true;
              continue;
            }
            const result = await responseJson(response) as { already?: boolean };
            out(`${id}\t${result?.already ? 'already' : 'approved'}`);
          } catch (error) {
            if (error instanceof NexusUnavailable) {
              out(`${id}\tfailed ${NEXUS_DOWN}`);
              process.exitCode = 2;
            } else {
              out(`${id}\tfailed 응답 JSON이 유효하지 않다`);
              failed = true;
            }
          }
        }
        if (failed && process.exitCode !== 2) process.exitCode = 1;
      } catch (error) { handleError(error, out); }
    });
}
