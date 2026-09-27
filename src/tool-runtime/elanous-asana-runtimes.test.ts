import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { handleMcpRequest } from '../mcp/server.js';
import { registerAllDefaultToolRuntimes } from './index.js';
import { _resetToolRuntimeRegistryForTest, getToolRuntime, listToolRuntimes } from './registry.js';
import { ELANOUS_ASANA_RUNTIMES, setElanousAsanaDepsForTest } from './elanous-asana-runtimes.js';

const secret = 'asana-private-token-test-987654321';
const taskFields = 'name,notes,permalink_url,modified_at,created_at,completed,custom_fields.name,custom_fields.enum_value.name';
const names = ['elanous_asana_workspaces', 'elanous_asana_list_tasks', 'elanous_asana_create_task', 'elanous_asana_comment', 'elanous_asana_complete'];
const calls: Array<{ url: URL; init: RequestInit }> = [];
const records: unknown[] = [];
let restore: (() => void) | undefined;
let off: (() => void) | undefined;

const task = (gid: string, priority?: string, completed = false) => ({
  gid, name: `[elanous-lab] ${gid}`, notes: 'details', permalink_url: `https://app.asana.com/0/p/${gid}`,
  completed, created_at: '2026-09-01', modified_at: '2026-09-02',
  custom_fields: priority ? [{ name: 'Priority', enum_value: { name: priority } }] : [],
});
const reply = (data: unknown, next_page: unknown = null, status = 200) =>
  new Response(JSON.stringify({ data, next_page }), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  calls.push({ url, init });
  switch (`${init.method} ${url.pathname}`) {
    case 'GET /api/1.0/users/me': return Promise.resolve(reply({ workspaces: [{ gid: 'w1', name: 'My Workspace' }] }));
    case 'GET /api/1.0/workspaces/w1/projects': return Promise.resolve(reply([{ gid: 'p1', name: 'elanous-lab' }]));
    case 'GET /api/1.0/projects/p1/tasks':
      return Promise.resolve(url.searchParams.get('page') === '2'
        ? reply([task('t4', 'Low'), task('t5'), task('t6', 'High', true),
          ...(url.searchParams.get('completed_since') === '1970-01-01T00:00:00.000Z'
            ? [{ ...task('t7', 'Urgent', true), created_at: '2017-01-01', modified_at: '2017-01-02' }] : [])])
        : reply([task('t1', 'Urgent'), task('t2', 'High'), task('t3', 'Medium')],
          { uri: `https://app.asana.com/api/1.0/projects/p1/tasks?page=2${url.searchParams.has('completed_since') ? '&completed_since=1970-01-01T00%3A00%3A00.000Z' : ''}` }));
    case 'GET /api/1.0/projects/p1/custom_field_settings':
      return Promise.resolve(reply([{ custom_field: { gid: 'cf1', name: 'Priority', enum_options: [
        { gid: 'opt1', name: 'Urgent' }, { gid: 'opt2', name: 'High' },
        { gid: 'opt3', name: 'Medium' }, { gid: 'opt4', name: 'Low' },
      ] } }]));
    case 'GET /api/1.0/projects/no-field/custom_field_settings': return Promise.resolve(reply([]));
    case 'POST /api/1.0/tasks': return Promise.resolve(reply(url.searchParams.has('opt_fields')
      ? task('created', JSON.parse(init.body as string).data.projects[0] === 'no-field' ? undefined : 'High')
      : { gid: 'created', name: 'A7' }));
    case 'POST /api/1.0/tasks/t1/stories': return Promise.resolve(reply({ gid: 'story1' }));
    case 'PUT /api/1.0/tasks/t1': return Promise.resolve(reply(url.searchParams.has('opt_fields')
      ? task('t1', 'Urgent', true) : { gid: 't1', name: '[elanous-lab] t1' }));
    default: throw new Error('Unexpected fake URL');
  }
}
function useFake(token: string | undefined = secret, fetcher = fakeFetch) {
  restore = setElanousAsanaDepsForTest({ getSecret: () => token, fetch: fetcher });
  off = debug.registerSink({ name: 'asana-test', emit: record => records.push(record) });
}
async function invoke(name: string, args: Record<string, unknown> = {}) {
  const rt = ELANOUS_ASANA_RUNTIMES.find(runtime => runtime.id === name)!;
  expect(rt.spec.name).toBe(name);
  return rt.run(args, { surface: 'mcp' });
}
function assertSecretPrivate(result: unknown) {
  expect(JSON.stringify({ result, records })).not.toContain(secret);
}

afterEach(() => {
  restore?.(); restore = undefined;
  off?.(); off = undefined;
  calls.length = 0; records.length = 0;
  _resetToolRuntimeRegistryForTest();
});

describe('Asana MCP runtimes', () => {
  test('workspaces reads /users/me and projects resolve by name or fail with that name', async () => {
    useFake();
    const ws = await invoke(names[0]!);
    expect(ws).toMatchObject({ ok: true, workspaces: [{ gid: 'w1', name: 'My Workspace' }] });
    const listed = await invoke(names[1]!, { projectName: 'elanous-lab', workspace: 'w1', prefix: '[elanous-lab] t1' });
    expect((listed.tasks as unknown[]).length).toBe(1);
    expect(calls.map(c => c.url.pathname)).toContain('/api/1.0/workspaces/w1/projects');
    const missing = await invoke(names[1]!, { projectName: 'missing project' });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toContain('missing project');
    assertSecretPrivate({ ws, listed, missing });
  });

  test('list follows next_page, excludes completed by default, maps all Priority options and null', async () => {
    useFake();
    const result = await invoke(names[1]!, { project: 'p1' });
    expect(result.ok).toBe(true);
    const tasks = result.tasks as Array<Record<string, unknown>>;
    expect(tasks.map(t => t.gid)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(tasks.map(t => t.priority)).toEqual(['urgent', 'high', 'medium', 'low', null]);
    expect(tasks[3]).toMatchObject({ notes: 'details', url: 'https://app.asana.com/0/p/t4', createdAt: '2026-09-01', modifiedAt: '2026-09-02', completed: false });
    expect(calls.map(c => `${c.init.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /api/1.0/projects/p1/tasks?opt_fields=name,notes,permalink_url,modified_at,created_at,completed,custom_fields.name,custom_fields.enum_value.name',
      'GET /api/1.0/projects/p1/tasks?page=2',
    ]);
    expect(calls.every(c => (c.init.headers as Record<string, string>).Authorization === `Bearer ${secret}`)).toBe(true);
    expect(records.filter((r: any) => r.category === 'tool.asana' && r.event === 'called').map((r: any) => r.data))
      .toEqual([expect.objectContaining({ tool: names[1], ok: true, count: 5 })]);
    assertSecretPrivate(result);
  });

  test('completed:true includes old completed tasks by requesting the full completion range on both pages', async () => {
    useFake();
    const result = await invoke(names[1]!, { project: 'p1', completed: true });
    expect(result).toMatchObject({ ok: true, tasks: [
      expect.objectContaining({ gid: 't6', completed: true }),
      expect.objectContaining({ gid: 't7', completed: true, createdAt: '2017-01-01' }),
    ] });
    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.url.searchParams.get('completed_since'))).toEqual([
      '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
    ]);
    assertSecretPrivate(result);
  });

  test('create applies the High option gid; missing Priority field leaves priorityApplied false', async () => {
    useFake();
    const created = await invoke(names[2]!, { project: 'p1', name: 'A7', notes: 'details', priority: 'high' });
    expect(created).toMatchObject({ ok: true, priorityApplied: true, task: {
      gid: 'created', name: '[elanous-lab] created', notes: 'details',
      url: 'https://app.asana.com/0/p/created', priority: 'high', completed: false,
      createdAt: '2026-09-01', modifiedAt: '2026-09-02',
    } });
    expect(calls[1]!.url.pathname).toBe('/api/1.0/tasks');
    expect(calls[1]!.url.searchParams.get('opt_fields')).toBe(taskFields);
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ data: {
      projects: ['p1'], name: 'A7', notes: 'details', custom_fields: { cf1: 'opt2' },
    } });
    calls.length = 0;
    const noField = await invoke(names[2]!, { project: 'no-field', name: 'A8', priority: 'high' });
    expect(noField).toMatchObject({ ok: true, priorityApplied: false, task: { priority: null, completed: false } });
    expect(JSON.parse(calls[1]!.init.body as string).data.custom_fields).toBeUndefined();
    assertSecretPrivate({ created, noField });
  });

  test('comment posts a story and complete PUTs completed:true by default', async () => {
    useFake();
    const commented = await invoke(names[3]!, { task: 't1', text: 'hello' });
    const completed = await invoke(names[4]!, { task: 't1' });
    expect(commented).toMatchObject({ ok: true, story: { gid: 'story1' } });
    expect(completed).toMatchObject({ ok: true, task: {
      gid: 't1', name: '[elanous-lab] t1', notes: 'details',
      url: 'https://app.asana.com/0/p/t1', priority: 'urgent', completed: true,
      createdAt: '2026-09-01', modifiedAt: '2026-09-02',
    } });
    expect(calls[1]!.url.searchParams.get('opt_fields')).toBe(taskFields);
    expect(calls.map(c => `${c.init.method} ${c.url.pathname}`)).toEqual([
      'POST /api/1.0/tasks/t1/stories', 'PUT /api/1.0/tasks/t1',
    ]);
    expect(calls.map(c => JSON.parse(c.init.body as string))).toEqual([
      { data: { text: 'hello' } }, { data: { completed: true } },
    ]);
    assertSecretPrivate({ commented, completed });
  });

  test('missing token returns the exact error for all tools without requests', async () => {
    useFake('');
    const results = await Promise.all(names.map(name => invoke(name)));
    expect(results).toEqual(names.map(() => ({ ok: false, output: 'Asana 토큰이 없다 — 비밀 connector.asana.token 을 넣어라' })));
    expect(calls).toHaveLength(0);
    expect(records.filter((r: any) => r.category === 'tool.asana')).toHaveLength(5);
    assertSecretPrivate(results);
  });

  test('HTTP failures cannot leak response body or token through results or logs', async () => {
    useFake(secret, async () => new Response(secret, { status: 401 }));
    const result = await invoke(names[0]!);
    expect(result).toMatchObject({ ok: false, output: 'Asana 요청 실패 (HTTP 401)' });
    expect(records.filter((r: any) => r.category === 'tool.asana').map((r: any) => r.data))
      .toEqual([expect.objectContaining({ tool: names[0], ok: false, status: 401 })]);
    assertSecretPrivate(result);
  });

  test('redacts the token even if an Asana task field or requested project name contains it', async () => {
    useFake(secret, async (input, init) => {
      if (init.method === 'GET' && input.includes('/projects/p1/tasks')) {
        return reply([task(secret, 'High')]);
      }
      return fakeFetch(input, init);
    });
    const listed = await invoke(names[1]!, { project: 'p1' });
    expect(listed.ok).toBe(true);
    expect((listed.tasks as Array<{ gid: string }>)[0]?.gid).toBe('[redacted]');
    const missing = await invoke(names[1]!, { projectName: secret });
    expect(missing.ok).toBe(false);
    assertSecretPrivate({ listed, missing });
  });

  test('MCP tools/call returns the structured Asana result without exposing its token', async () => {
    useFake();
    const response = await handleMcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'elanous_asana_list_tasks', arguments: { project: 'p1' } },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { structuredContent: { ok: boolean; tasks: unknown[] }; content: Array<{ text: string }> };
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.structuredContent.tasks).toHaveLength(5);
    expect(result.content[0]?.text).toBe('Asana 태스크 5개');
    assertSecretPrivate(response);
  });

  test('default registry registers the five Asana runtimes for MCP only', () => {
    _resetToolRuntimeRegistryForTest();
    registerAllDefaultToolRuntimes();
    expect(names.map(name => getToolRuntime(name))).toEqual([...ELANOUS_ASANA_RUNTIMES]);
    expect(listToolRuntimes('mcp').filter(rt => rt.id.startsWith('elanous_asana_')).map(rt => rt.id)).toEqual(names);
    expect(listToolRuntimes('tui').filter(rt => rt.id.startsWith('elanous_asana_'))).toEqual([]);
    registerAllDefaultToolRuntimes();
    expect(listToolRuntimes('mcp').filter(rt => rt.id.startsWith('elanous_asana_')).map(rt => rt.id)).toEqual(names);
  });

  test('MCP tools/list includes exactly the five additional Asana names with MCP-only catalog metadata', async () => {
    const response = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listed = (response.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    expect(listed.filter(name => name.startsWith('elanous_asana_'))).toEqual(names);
    const { listNativeToolsForHost } = await import('../native-tool-catalog.js');
    const entries = listNativeToolsForHost('mcp').filter(e => e.id.startsWith('elanous_asana_'));
    expect(entries.map(e => e.id)).toEqual(names);
    expect(entries.map(e => e.safety.includes('read-only'))).toEqual([true, true, false, false, false]);
    expect(entries.map(e => e.safety.includes('mutating'))).toEqual([false, false, true, true, true]);
    expect(entries.every(e => e.defaultEnabled && e.host.length === 1 && e.host[0] === 'mcp')).toBe(true);
  });
});
