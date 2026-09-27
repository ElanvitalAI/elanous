import type { LLMToolSpec } from '../llm.js';
import { debug } from '../debug/log.js';
import { getSecret } from '../nexus/config/secrets/index.js';
import type { ToolRuntime } from './types.js';

const BASE = 'https://app.asana.com/api/1.0';
const TOKEN_MISSING = 'Asana 토큰이 없다 — 비밀 connector.asana.token 을 넣어라';
const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
const TASK_FIELDS = 'name,notes,permalink_url,modified_at,created_at,completed,custom_fields.name,custom_fields.enum_value.name';
type Priority = typeof PRIORITIES[number];
type Args = Record<string, unknown>;
type Result = { ok: boolean; output: string; [key: string]: unknown };
type Page<T> = { data: T; next_page?: { uri?: string } | null };
type Workspace = { gid: string; name: string };
type Project = { gid: string; name: string };
type Field = { gid: string; name: string; enum_options?: Array<{ gid: string; name: string }> };
type Task = {
  gid: string; name: string; notes?: string; permalink_url?: string;
  completed: boolean; created_at?: string; modified_at?: string;
  custom_fields?: Array<{ name: string; enum_value?: { name: string } | null }>;
};

const productionDeps = { fetch: (input: string, init: RequestInit) => fetch(input, init), getSecret };
let deps = productionDeps;

/** Inject fake HTTP and secret access without reading or writing the real secret store. */
export function setElanousAsanaDepsForTest(overrides: Partial<typeof productionDeps>): () => void {
  if (deps !== productionDeps) throw new Error('Asana dependencies already injected');
  const injected = { ...productionDeps, ...overrides };
  deps = injected;
  return () => { if (deps === injected) deps = productionDeps; };
}

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LLMToolSpec {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}
const string = { type: 'string' };
const boolean = { type: 'boolean' };
const priority = { type: 'string', enum: [...PRIORITIES] };

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 값이 필요하다`);
  return value.trim();
}
function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}
function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} 는 boolean 이어야 한다`);
  return value;
}
function parsePriority(value: unknown): Priority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PRIORITIES.includes(value as Priority)) throw new Error('priority 는 urgent, high, medium, low 중 하나여야 한다');
  return value as Priority;
}
function taskPriority(task: Task): Priority | null {
  const value = task.custom_fields?.find(field => field.name === 'Priority')?.enum_value?.name?.toLowerCase();
  return PRIORITIES.find(p => p === value) ?? null;
}
function taskView(task: Task) {
  return {
    gid: task.gid, name: task.name, notes: task.notes ?? '', url: task.permalink_url ?? '',
    priority: taskPriority(task), completed: task.completed,
    createdAt: task.created_at ?? null, modifiedAt: task.modified_at ?? null,
  };
}

async function request<T>(token: string, path: string, method = 'GET', data?: unknown): Promise<Page<T>> {
  // Asana's pagination URI is absolute; never forward the bearer credential to another origin.
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, BASE + '/');
  if (url.origin !== new URL(BASE).origin || !url.pathname.startsWith('/api/1.0/')) throw new Error('Asana 페이지 주소가 올바르지 않다');
  const response = await deps.fetch(url.href, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
    redirect: 'error',
  });
  if (!response.ok) throw new AsanaHttpError(response.status);
  return await response.json() as Page<T>;
}
class AsanaHttpError extends Error {
  constructor(readonly status: number) { super(`Asana HTTP ${status}`); }
}
class AsanaProjectNotFound extends Error {}
async function pages<T>(token: string, path: string): Promise<T[]> {
  const items: T[] = [];
  const visited = new Set<string>();
  let next: string | undefined = path;
  while (next) {
    if (visited.has(next)) throw new Error('Asana 페이지 순환');
    visited.add(next);
    const page: Page<T[]> = await request<T[]>(token, next);
    items.push(...page.data);
    next = page.next_page?.uri;
  }
  return items;
}

async function resolveProject(token: string, raw: Args): Promise<string> {
  const project = optionalString(raw.project, 'project');
  if (project) return project;
  const name = requiredString(raw.projectName, 'projectName');
  const workspace = optionalString(raw.workspace, 'workspace');
  const workspaces = workspace ? [{ gid: workspace }] : (await request<{ workspaces: Workspace[] }>(token, '/users/me')).data.workspaces;
  for (const ws of workspaces) {
    const projects = await pages<Project>(token, `/workspaces/${encodeURIComponent(ws.gid)}/projects?opt_fields=name`);
    const found = projects.find(p => p.name === name);
    if (found) return found.gid;
  }
  throw new AsanaProjectNotFound(`Asana 프로젝트 '${name}' 을 찾지 못했다`);
}

async function listTasks(token: string, raw: Args): Promise<Result> {
  const project = await resolveProject(token, raw);
  const completed = optionalBoolean(raw.completed, 'completed', false);
  const prefix = optionalString(raw.prefix, 'prefix');
  const tasks = (await pages<Task>(token, `/projects/${encodeURIComponent(project)}/tasks?opt_fields=${TASK_FIELDS}${completed ? '&completed_since=1970-01-01T00:00:00.000Z' : ''}`))
    .filter(task => task.completed === completed && (prefix === undefined || task.name.startsWith(prefix)))
    .map(taskView);
  return { ok: true, output: `Asana 태스크 ${tasks.length}개`, tasks };
}

async function createTask(token: string, raw: Args): Promise<Result> {
  const project = requiredString(raw.project, 'project');
  const name = requiredString(raw.name, 'name');
  const notes = optionalString(raw.notes, 'notes');
  const wanted = parsePriority(raw.priority);
  let customFields: Record<string, string> | undefined;
  if (wanted) {
    const settings = await pages<{ custom_field: Field }>(token,
      `/projects/${encodeURIComponent(project)}/custom_field_settings?opt_fields=custom_field.name,custom_field.gid,custom_field.enum_options.name,custom_field.enum_options.gid`);
    const field = settings.find(s => s.custom_field.name === 'Priority')?.custom_field;
    const option = field?.enum_options?.find(o => o.name.toLowerCase() === wanted);
    if (field && option) customFields = { [field.gid]: option.gid };
  }
  const data = { projects: [project], name, ...(notes === undefined ? {} : { notes }), ...(customFields ? { custom_fields: customFields } : {}) };
  const task = (await request<Task>(token, `/tasks?opt_fields=${TASK_FIELDS}`, 'POST', data)).data;
  return { ok: true, output: `Asana 태스크 생성: ${task.gid}`, task: taskView(task), priorityApplied: !!customFields };
}

async function comment(token: string, raw: Args): Promise<Result> {
  const task = requiredString(raw.task, 'task');
  const text = requiredString(raw.text, 'text');
  const story = (await request<{ gid: string }>(token, `/tasks/${encodeURIComponent(task)}/stories`, 'POST', { text })).data;
  return { ok: true, output: `Asana 댓글 생성: ${story.gid}`, story: { gid: story.gid } };
}

async function complete(token: string, raw: Args): Promise<Result> {
  const task = requiredString(raw.task, 'task');
  const completed = optionalBoolean(raw.completed, 'completed', true);
  const updated = (await request<Task>(token, `/tasks/${encodeURIComponent(task)}?opt_fields=${TASK_FIELDS}`, 'PUT', { completed })).data;
  return { ok: true, output: `Asana 태스크 ${task}: completed=${completed}`, task: taskView(updated) };
}

function redactToken<T>(value: T, token: string): T {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]') as T;
  if (Array.isArray(value)) return value.map(item => redactToken(item, token)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactToken(item, token)])) as T;
  }
  return value;
}

function runtime(name: string, toolSpec: LLMToolSpec, action: (token: string, args: Args) => Promise<Result>): ToolRuntime<Args, Result> {
  return {
    id: name, spec: toolSpec,
    async run(args) {
      let status: number | undefined;
      let result: Result;
      let token: string | undefined;
      try {
        token = deps.getSecret('connector.asana.token');
        result = !token ? { ok: false, output: TOKEN_MISSING } : redactToken(await action(token, args), token);
      } catch (error) {
        // Never surface a transport exception or response body: either can contain the bearer token.
        status = error instanceof AsanaHttpError ? error.status : undefined;
        const missingProject = error instanceof AsanaProjectNotFound ? error.message : undefined;
        result = { ok: false, output: missingProject ? (token ? redactToken(missingProject, token) : missingProject) : status ? `Asana 요청 실패 (HTTP ${status})` : 'Asana 요청 실패' };
      }
      debug.log('tool.asana', 'called', {
        tool: name, ok: result.ok, ...(status === undefined ? {} : { status }),
        ...(Array.isArray(result.tasks) ? { count: result.tasks.length } : {}),
      });
      return result;
    },
  };
}

export const ELANOUS_ASANA_RUNTIMES: ReadonlyArray<ToolRuntime<Args, Result>> = [
  runtime('elanous_asana_workspaces', spec('elanous_asana_workspaces', 'List Asana workspaces for the current user.', {}),
    async token => {
      const workspaces = (await request<{ workspaces: Workspace[] }>(token, '/users/me')).data.workspaces.map(({ gid, name }) => ({ gid, name }));
      return { ok: true, output: `Asana 워크스페이스 ${workspaces.length}개`, workspaces };
    }),
  runtime('elanous_asana_list_tasks', spec('elanous_asana_list_tasks', 'List project tasks across all Asana pages; defaults to incomplete tasks.',
    { project: string, projectName: string, workspace: string, completed: boolean, prefix: string }), listTasks),
  runtime('elanous_asana_create_task', spec('elanous_asana_create_task', 'Create an Asana task in a project with optional Priority enum.',
    { project: string, name: string, notes: string, priority }, ['project', 'name']), createTask),
  runtime('elanous_asana_comment', spec('elanous_asana_comment', 'Post a comment on an Asana task.',
    { task: string, text: string }, ['task', 'text']), comment),
  runtime('elanous_asana_complete', spec('elanous_asana_complete', 'Set an Asana task completed flag (defaults true).',
    { task: string, completed: boolean }, ['task']), complete),
];
