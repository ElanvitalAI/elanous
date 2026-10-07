import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { registerTasksCommands, type TasksCliDeps } from './tasks-cli.js';

const token = 'secret-acp-token-sentinel';
const tasks = [
  { id: 'low', title: 'Low task', status: 'backlog', priority: 'low', createdAt: 1, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-1' } },
  { id: 'urgent', title: 'Urgent task', status: 'backlog', priority: 'urgent', createdAt: 4, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-4' } },
  { id: 'medium', title: 'Medium task', status: 'ready', priority: 'medium', createdAt: 3, approval: { state: 'approved' }, generatedBy: { kind: 'external', provider: 'github', ref: 'G-3' } },
  { id: 'high', title: 'High task', status: 'backlog', priority: 'high', createdAt: 2, approval: { state: 'pending' }, generatedBy: { kind: 'external', provider: 'linear', ref: 'L-2' } },
];

function nexus() {
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  const fetchNexus = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ path: url.pathname, method, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.pathname === '/v1/tasks') return Response.json({ summary: { total: 4 }, tasks: tasks.map(({ id, title, priority, status, createdAt }) => ({ id, title, priority, status, createdAt })) });
    const id = decodeURIComponent(url.pathname.slice('/v1/tasks/'.length).replace(/\/approve$/, ''));
    if (method === 'POST' && id === 'b') return Response.json({ error: 'conflict', reason: 'not pending' }, { status: 409 });
    const task = tasks.find((row) => row.id === id);
    if (!task) return Response.json({ error: 'not_found' }, { status: 404 });
    if (method === 'POST') return Response.json({ taskId: id, status: 'ready', approval: { state: 'approved' } });
    return Response.json({ task, executions: [], events: [] });
  };
  return { requests, fetchNexus: fetchNexus as typeof fetch };
}

async function run(args: string[], deps: TasksCliDeps): Promise<{ lines: string[]; code: number | undefined }> {
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { ...deps, output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', ...args]);
    return { lines, code: process.exitCode };
  } finally { process.exitCode = previous ?? 0; }
}

test('list sorts urgent > high > medium > low and fetches real approval/source through authenticated details', async () => {
  const server = nexus();
  const result = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: server.fetchNexus });
  expect(result.code ?? 0).toBe(0);
  expect(result.lines[0]).toBe('id\t우선순위\t상태\t승인\t출처\t제목');
  expect(result.lines.slice(1).map((line) => line.split('\t')[0])).toEqual(['urgent', 'high', 'medium', 'low']);
  expect(result.lines[1]).toContain('pending\tlinear:L-4\tUrgent task');
  expect(result.lines[3]).toContain('approved\tgithub:G-3\tMedium task');
  expect(server.requests.map((req) => req.path)).toEqual(['/v1/tasks', '/v1/tasks/low', '/v1/tasks/urgent', '/v1/tasks/medium', '/v1/tasks/high']);
  expect(server.requests.every((req) => req.authorization === `Bearer ${token}`)).toBe(true);
  expect(result.lines.join('\n')).not.toContain(token);
});

test('tasks with equal priority sort by creation time before id', async () => {
  const server = nexus();
  const earlier = { ...tasks[3]!, id: 'older-high', title: 'Older high', createdAt: 0 };
  const result = await run(['tasks', 'list', '--json'], {
    baseUrl: 'http://127.0.0.1:31415', bearerToken: token,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/tasks')) {
        return Response.json({ tasks: [...tasks.map(({ id, status }) => ({ id, status })), { id: earlier.id, status: earlier.status }] });
      }
      if (String(input).endsWith('/v1/tasks/older-high')) return Response.json({ task: earlier });
      return server.fetchNexus(input, init);
    }) as typeof fetch,
  });
  expect(JSON.parse(result.lines[0]!).map((task: { id: string }) => task.id)).toEqual(['urgent', 'older-high', 'high', 'medium', 'low']);
});

test('status/provider filters and JSON show preserve the full detail payload', async () => {
  const server = nexus();
  const deps = { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: server.fetchNexus };
  const filtered = await run(['task', 'list', '--status', 'backlog', '--provider', 'linear', '--json'], deps);
  expect(JSON.parse(filtered.lines[0]!).map((task: { id: string }) => task.id)).toEqual(['urgent', 'high', 'low']);
  const shown = await run(['tasks', 'show', 'urgent', '--json'], deps);
  expect(JSON.parse(shown.lines[0]!)).toMatchObject({ task: { id: 'urgent', priority: 'urgent', approval: { state: 'pending' } }, executions: [], events: [] });
  expect(filtered.lines.concat(shown.lines).join('\n')).not.toContain(token);
});

test('approve a b sends both POST requests and 409 prints failed with exit 1, without leaking token', async () => {
  const server = nexus();
  const result = await run(['tasks', 'approve', 'a', 'b'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/a/approve')) {
      server.requests.push({ path: '/v1/tasks/a/approve', method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json({ taskId: 'a', status: 'ready', approval: { state: 'approved' } });
    }
    return server.fetchNexus(input, init);
  }) as unknown as typeof fetch });
  expect(result.lines).toEqual(['a\tapproved', 'b\tfailed HTTP 409']);
  expect(result.code).toBe(1);
  expect(server.requests).toEqual([
    { path: '/v1/tasks/a/approve', method: 'POST', authorization: `Bearer ${token}` },
    { path: '/v1/tasks/b/approve', method: 'POST', authorization: `Bearer ${token}` },
  ]);
  expect(result.lines.join('\n')).not.toContain(token);
});

test('token strings in task fields or remote errors never reach output', async () => {
  const server = nexus();
  const output = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await server.fetchNexus(input, init);
    if (String(input).endsWith('/v1/tasks/low')) return Response.json({ task: { ...tasks[0], title: `contains ${token}` } });
    return response;
  }) as typeof fetch });
  expect(output.lines.join('\n')).not.toContain(token);
  const error = await run(['tasks', 'approve', 'a'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: token, fetch: (async () => Response.json({ error: token }, { status: 503 })) as unknown as typeof fetch });
  expect(error.lines).toEqual(['a\tfailed HTTP 503']);
  expect(error.lines.join('\n')).not.toContain(token);
});

test('unavailable nexus exits 2; fetch exceptions never disclose credentials', async () => {
  const unavailable = await run(['tasks', 'list'], { bearerToken: token, baseUrl: '', fetch: (async () => { throw new Error('should not fetch'); }) as unknown as typeof fetch });
  expect(unavailable).toEqual({ lines: ['넥서스가 안 떠 있다 — `elanous nexus run`'], code: 2 });
  const thrown = await run(['tasks', 'show', 'a'], { bearerToken: token, baseUrl: 'http://127.0.0.1:31415', fetch: (async () => { throw new Error(`failed with ${token}`); }) as unknown as typeof fetch });
  expect(thrown).toEqual({ lines: ['넥서스가 안 떠 있다 — `elanous nexus run`'], code: 2 });
});

test('index wires tasks instead of the retirement stub, and scheduler stays retired', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain('registerTasksCommands(program);');
  expect(source).not.toContain(".command('task [args...]')");
  expect(source).toContain(".command('scheduler [args...]')");
  const program = new Command().name('elanous');
  registerTasksCommands(program);
  const command = program.commands.find((entry) => entry.name() === 'tasks');
  expect(command?.aliases()).toContain('task');
  expect(command?.commands.map((entry) => entry.name())).toEqual(['list', 'hand', 'advance', 'show', 'approve']);
});

test('an isolated universe without an acp-token still lists — no Authorization header is sent', async () => {
  const server = nexus();
  const result = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: '', fetch: server.fetchNexus });
  expect(result.code ?? 0).toBe(0);
  expect(result.lines.slice(1).map((line) => line.split('\t')[0])).toEqual(['urgent', 'high', 'medium', 'low']);
  expect(server.requests.every((req) => req.authorization === null)).toBe(true);
});
