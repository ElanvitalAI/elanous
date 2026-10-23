import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import { TASK_CARD_PREFIX } from '../task-agent/task-card-prefix.js';
import type { Task } from '../task-orchestrator/types.js';
import type { TasksCliDeps } from './tasks-cli.js';

/**
 * CLI-ENTRY-LAZY — `tasks list`·`tasks show` 의 등록과 넥서스 조회 보조.
 * ⛔ 이 파일은 task-agent 의 board·shadow·mission 클러스터(·dashboard)를 «정적으로» 싣지 않는다 — 가벼운 진입(`light-cli.ts`)이
 * `tasks-cli.ts` 전체 대신 이것만 등록한다. 과제 카드(`ta-…`) 상세는 `tasks-card-show.ts` 를 그때 싣는다.
 * 같은 등록 함수를 `tasks-cli.ts` 가 부르므로 전체 진입과 출력 계약이 한 코드다.
 */

type TaskRow = Pick<Task, 'id' | 'title' | 'priority' | 'status' | 'createdAt' | 'approval' | 'generatedBy'>;

/** `tasks hand`·`show` 가 남기는 `task-agent` 관측의 logs.db surface 라벨. */
export const TASK_AGENT_SINK_SURFACE = 'task-agent';

/**
 * 독립 CLI 프로세스는 데몬의 logs.db 싱크를 상속하지 않는다 — 등록하지 않으면 `debug.log('task-agent', …)` 가
 * 파일 트레일에만 남고 `elanous logs --category task-agent` 에 0건으로 보인다(10-06 실측: 카드 3장 · 이벤트 0).
 * fail-open — 등록 실패가 과제 넘기기를 막지 않는다.
 */
export async function registerTaskAgentSink(register?: (surface: string) => Promise<unknown>): Promise<void> {
  try {
    const fn = register ?? (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink;
    await fn(TASK_AGENT_SINK_SURFACE);
  } catch { /* fail-open — 파일 트레일이 진실원 */ }
}

const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
export const NEXUS_DOWN = '넥서스가 안 떠 있다 — `elanous nexus run`';

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

export function credentials(deps: TasksCliDeps): { baseUrl: string; token?: string } | null {
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

export class NexusUnavailable extends Error {}

export async function request(deps: TasksCliDeps, auth: { baseUrl: string; token?: string }, path: string, method = 'GET'): Promise<Response> {
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

export async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error('넥서스 응답 JSON이 유효하지 않다'); }
}

function httpError(response: Response): Error {
  // Do not echo server-supplied error bodies: they may contain credentials.
  return new Error(`HTTP ${response.status}`);
}

export function handleError(error: unknown, out: (line: string) => void): void {
  if (error instanceof NexusUnavailable) {
    out(NEXUS_DOWN);
    process.exitCode = 2;
  } else {
    out(error instanceof Error ? error.message : '태스크 요청 실패');
    process.exitCode = 1;
  }
}

/** `tasks` 하위 명령들이 함께 쓰는 출력·인증 문맥 — 응답 출력에서 쓰인 토큰을 가린다. */
export interface TasksCliContext {
  deps: TasksCliDeps;
  out: (line: string) => void;
  authenticate: () => { baseUrl: string; token?: string };
  clearToken: () => void;
}

export function createTasksCliContext(deps: TasksCliDeps): TasksCliContext {
  let activeToken: string | undefined;
  const output = deps.output ?? console.log;
  return {
    deps,
    out: (line: string) => output(activeToken ? line.replaceAll(activeToken, '[redacted]') : line),
    authenticate: () => {
      const auth = credentials(deps);
      activeToken = auth?.token;
      if (!auth) throw new NexusUnavailable();
      return auth;
    },
    clearToken: () => { activeToken = undefined; },
  };
}

/** `tasks` 뿌리 명령(별칭 `task`) — 전체·가벼운 등록이 같은 뿌리를 쓴다. */
export function registerTasksRoot(program: Command): Command {
  return program.command('tasks').alias('task').description('TOX 태스크 조회 및 승인 · TASK-AGENT 과제 넘기기(hand)');
}

export function registerTaskListCommand(tasks: Command, ctx: TasksCliContext): void {
  const { deps, out, authenticate } = ctx;
  tasks.command('list')
    .description('우선순위와 생성 시각 순으로 태스크 보기')
    .option('--status <s>', '상태로 필터')
    .option('--provider <p>', '외부 출처로 필터')
    .option('--json', 'JSON 출력')
    .action(async (opts: { status?: string; provider?: string; json?: boolean }) => {
      try {
        ctx.clearToken();
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
}

export function registerTaskShowCommand(tasks: Command, ctx: TasksCliContext): void {
  const { deps, out, authenticate } = ctx;
  tasks.command('show <id>')
    .description(`태스크 상세 보기 (id 가 \`${TASK_CARD_PREFIX}\` 로 시작하면 TASK-AGENT 과제 카드 ⊕ 다음 수)`)
    .option('--json', 'JSON 출력')
    .action(async (id: string, opts: { json?: boolean }) => {
      if (id.startsWith(TASK_CARD_PREFIX)) {
        const { showTaskCard } = await import('./tasks-card-show.js');
        await showTaskCard(id, opts, deps, out);
        return;
      }
      try {
        ctx.clearToken();
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
}

/** 가벼운 진입 전용 — `tasks list`·`tasks show` 만 등록한다(전체 레지스트리 `registerTasksCommands` 를 싣지 않는다). */
export function registerTaskReadCommands(program: Command, deps: TasksCliDeps = {}): void {
  const ctx = createTasksCliContext(deps);
  const tasks = registerTasksRoot(program);
  registerTaskListCommand(tasks, ctx);
  registerTaskShowCommand(tasks, ctx);
}
