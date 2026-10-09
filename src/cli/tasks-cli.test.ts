import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { defaultTaskLauncher, ELANOUS_CLI_ENTRY, registerTasksCommands, spawnDetachedConfirmed, taskLauncherArgv, type DetachedSpawn, type TasksCliDeps } from './tasks-cli.js';

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

test('tasks cover --json reads two filtered log sources and measures land without inventing other denominators', async () => {
  const queries: Array<{ exactCategories?: string[]; events?: string[]; sinceMs?: number; untilMs?: number }> = [];
  const since = '2026-10-01T00:00:00Z';
  const until = '2026-10-08T00:00:00Z';
  const result = await run(['tasks', 'cover', '--since', since, '--until', until, '--json'], {
    coverLogs: (query) => {
      queries.push(query);
      const payloads = query.exactCategories?.[0] === 'task-agent'
        ? [{ kind: 'land', result: 'done' }, { kind: 'review', result: 'done' }, { kind: 'review', result: 'done' }, { kind: 'land', result: 'failed' }]
        : [...Array.from({ length: 4 }, () => ({ step: 'merge', ok: true })), { step: 'merge', ok: false }];
      return payloads.map((data) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(data) }) as LogStoreRow);
    },
  });
  expect(result.code ?? 0).toBe(0);
  expect(queries.map((query) => [query.exactCategories, query.events, query.sinceMs, query.untilMs])).toEqual([
    [['task-agent'], ['action'], Date.parse(since), Date.parse(until)],
    [['pr.land'], ['step'], Date.parse(since), Date.parse(until)],
  ]);
  expect(JSON.parse(result.lines[0]!).rows).toContainEqual({ verb: 'land', byTaskAgent: 1, total: 4, observedActions: 2, ratio: 0.25, state: 'measured', liveActions: 2, shadowActions: 0, stewardTransition: 'observed' });
  expect(JSON.parse(result.lines[0]!).rows[1]).toEqual({ verb: 'review', byTaskAgent: 2, total: null, observedActions: 2, ratio: null, state: 'no-denominator', liveActions: 2, shadowActions: 0, stewardTransition: 'unmeasured' });
});

test('tasks cover --lines uses the one-line formatter on the read-only observation path', async () => {
  const queries: string[] = [];
  const result = await run(['tasks', 'cover', '--lines'], { coverLogs: (query) => {
    queries.push(query.exactCategories![0]!);
    const data = query.exactCategories?.[0] === 'task-agent'
      ? [{ kind: 'land', result: 'done' }, { kind: 'land', result: 'shadow' }, { kind: 'review', result: 'shadow' }]
      : [{ step: 'merge', ok: true }, { step: 'merge', ok: true }];
    return data.map((item) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(item) }) as LogStoreRow);
  } });
  expect(result.code ?? 0).toBe(0);
  expect(queries).toEqual(['task-agent', 'pr.land']);
  expect(result.lines).toEqual([
    'land: TA 1/2 (50.0%) · live 1 · shadow 1 · steward-transition observed',
    'review: TA 0/- (-) · live 0 · shadow 1 · steward-transition unmeasured',
    'retry: TA 0/- (-) · live 0 · shadow 0 · steward-transition unmeasured',
    'green: TA 0/- (-) · live 0 · shadow 0 · steward-transition unmeasured',
  ]);
});

test('tasks cover reports unreadable sources and rejects an inverted window without querying', async () => {
  const result = await run(['tasks', 'cover'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'pr.land') throw new Error('unavailable');
    return [];
  } });
  expect(result.lines).toContain('land\t0\t-\t-\tunreadable\t0');
  const unknown = await run(['tasks', 'cover'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'task-agent') throw new Error('unavailable');
    return [];
  } });
  expect(unknown.lines).toContain('land\t-\t0\t-\tunreadable\t-');
  expect(unknown.lines).toContain('review\t-\t-\t-\tunreadable\t-');
  const unknownJson = await run(['tasks', 'cover', '--json'], { coverLogs: (query) => {
    if (query.exactCategories?.[0] === 'task-agent') throw new Error('unavailable');
    return [];
  } });
  expect(JSON.parse(unknownJson.lines[0]!).rows[0]).toMatchObject({ byTaskAgent: null, observedActions: null, state: 'unreadable' });
  expect(result.lines[0]).toBe('동사\t대신\t전체\t비율\t상태\t관측 사건');
  let calls = 0;
  const invalid = await run(['tasks', 'cover', '--since', '2026-10-09T00:00:00Z', '--until', '2026-10-08T00:00:00Z'], {
    coverLogs: () => { calls++; return []; },
  });
  expect(invalid.code).toBe(1);
  expect(calls).toBe(0);
});

test('tasks cover --json keeps a single JSON result and declares when a source reaches its query bound', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'review', result: 'done' }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => query.exactCategories?.[0] === 'task-agent' ? Array(100_000).fill(action) : [],
  });
  expect(result.lines).toHaveLength(1);
  const body = JSON.parse(result.lines[0]!);
  expect(body.limitReached).toBe(true);
  expect(body.warning).toContain('상한 100000 도달');
  expect(body.rows[0]).toMatchObject({ verb: 'land', state: 'unreadable', ratio: null });
  expect(body.rows[1]).toMatchObject({ verb: 'review', byTaskAgent: null, total: null, observedActions: null, state: 'unreadable' });
});

test('tasks cover marks land unknown when a bounded merge query has successful merges', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done' }) } as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => query.exactCategories?.[0] === 'task-agent' ? [action] : Array(100_000).fill(merge),
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.limitReached).toBe(true);
  expect(body.rows[0]).toMatchObject({ verb: 'land', byTaskAgent: 1, total: null, ratio: null, state: 'unreadable' });
});

test('tasks cover --json takes a federated read and says how many stores it could not read', async () => {
  const action = { category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done' }) } as LogStoreRow;
  const merge = { category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as LogStoreRow;
  const result = await run(['tasks', 'cover', '--json'], {
    coverLogs: (query) => ({
      rows: query.exactCategories?.[0] === 'task-agent' ? [action] : [merge, merge, merge, merge],
      limitReached: false, unreadableStores: 2, storesRead: 5,
    }),
  });
  const body = JSON.parse(result.lines[0]!);
  expect(body.rows[0]).toEqual({ verb: 'land', byTaskAgent: 1, total: 4, observedActions: 1, ratio: 0.25, state: 'measured', liveActions: 1, shadowActions: 0, stewardTransition: 'observed' });
  expect(body.unreadableStores).toBe(2);
  expect(body.storeWarning).toContain('2개를 못 읽었다');
});

test('task hand requires project id and target together', async () => {
  const result = await run(['task', 'hand', '보고서', '--project', 'p1'], { registerSink: async () => true });
  expect(result.code).toBe(1);
  expect(result.lines.join('\n')).toContain('--target');
});

test('detached launcher keeps original options without cwd and sets cwd when supplied', async () => {
  const target = mkdtempSync(join(tmpdir(), 'tasks-cli-target-'));
  const options: Array<{ detached: true; stdio: 'ignore'; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const spawn: DetachedSpawn = (_command, _args, opts) => {
    options.push(opts);
    const listeners: Record<string, Array<(...args: never[]) => void>> = {};
    const child = {
      pid: 123,
      once(event: 'spawn' | 'error', listener: (...args: never[]) => void) {
        (listeners[event] ??= []).push(listener);
        if (event === 'spawn') queueMicrotask(() => listener());
      },
      removeListener() {},
      unref() {},
    };
    return child;
  };
  await spawnDetachedConfirmed(spawn, 'bun', ['x']);
  await spawnDetachedConfirmed(spawn, 'bun', ['x'], 2_000, target);
  expect(options).toEqual([{ detached: true, stdio: 'ignore' }, { detached: true, stdio: 'ignore', cwd: target }]);
  // TA-CARD-RUN-LINK: env 를 주면 부모 환경 위에 얹는다(런 id 상속).
  await spawnDetachedConfirmed(spawn, 'bun', ['x'], 2_000, undefined, { ELANOUS_RUN_ID: 'run-test-1234' });
  expect(options[2]!.env?.ELANOUS_RUN_ID).toBe('run-test-1234');
  expect(options[2]!.env?.PATH).toBe(process.env.PATH);
});

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
  expect(command?.commands.map((entry) => entry.name())).toEqual(['cover', 'list', 'hand', 'parents', 'board', 'advance', 'show', 'approve']);
});

test('an isolated universe without an acp-token still lists — no Authorization header is sent', async () => {
  const server = nexus();
  const result = await run(['tasks', 'list'], { baseUrl: 'http://127.0.0.1:31415', bearerToken: '', fetch: server.fetchNexus });
  expect(result.code ?? 0).toBe(0);
  expect(result.lines.slice(1).map((line) => line.split('\t')[0])).toEqual(['urgent', 'high', 'medium', 'low']);
  expect(server.requests.every((req) => req.authorization === null)).toBe(true);
});

test('real detached spawn: the env handed by the launcher reaches the child (ELANOUS_RUN_ID inheritance)', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const out = join(mkdtempSync(join(tmpdir(), 'tasks-cli-env-')), 'env.txt');
  await spawnDetachedConfirmed(spawn as unknown as DetachedSpawn, process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.ELANOUS_RUN_ID ?? '')`], 2_000, undefined, { ELANOUS_RUN_ID: 'run-inherit-check-1234' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(out) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  expect(readFileSync(out, 'utf8')).toBe('run-inherit-check-1234');
});

test('ORCH-LIVE-1008: the hand launcher runs the elanous CLI entry, not whatever script started this process (orchestrator tick)', async () => {
  const started = process.argv[1];
  const seen: string[][] = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    seen.push([command, ...args]);
    const handlers: Record<string, () => void> = {};
    setTimeout(() => handlers.spawn?.(), 0);
    return { pid: 1, once: (event: string, fn: () => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as DetachedSpawn;
  try {
    process.argv[1] = '/somewhere/src/loops/orchestrator/tick.ts';
    await defaultTaskLauncher(['harness', 'say', 'x'], undefined, undefined, { spawn: fakeSpawn });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(process.execPath);
    expect(seen[0]![1]).toBe(ELANOUS_CLI_ENTRY);
    expect(seen[0]![1]!.endsWith('/bin/elanous.mjs')).toBe(true);
    expect(existsSync(seen[0]![1]!)).toBe(true);
    expect(seen[0]!.slice(2)).toContain('harness');
    expect(taskLauncherArgv('/cfg', ['a'])).toEqual([ELANOUS_CLI_ENTRY, '--config-dir', '/cfg', 'a']);
  } finally { process.argv[1] = started; }
});

/** A fake detached child that writes `stderr` to the fd it was handed and exits with `code` (or stays alive). */
function exitingSpawn(code: number | null, stderr = ''): { spawn: DetachedSpawn; stdio: unknown[] } {
  const stdio: unknown[] = [];
  const spawn = ((_command: string, _args: string[], options: { stdio: unknown }) => {
    stdio.push(options.stdio);
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    setTimeout(() => {
      handlers.spawn?.();
      if (code === null) return;
      const fd = (options.stdio as unknown[])[2];
      if (stderr && typeof fd === 'number') writeSync(fd, stderr);
      setTimeout(() => handlers.exit?.(code, null), 5);
    }, 0);
    return { pid: 9, once: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as DetachedSpawn;
  return { spawn, stdio };
}

const launchContext = (runId: string) => ({ runId, launchId: 'tl-test', env: { ELANOUS_RUN_ID: runId } });

test('STOP-RECORD launch-failed: a child that exits nonzero right after launch writes exactly one stop line and throws', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const written: RunLedgerEntry[] = [];
  const longTail = `error: unknown command 'tick.ts'\n${Array.from({ length: 40 }, (_, i) => `    at frame${i} (x.ts:${i})`).join('\n')}`;
  const { spawn, stdio } = exitingSpawn(2, longTail);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0001'),
    { spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=2');
  expect((stdio[0] as unknown[]).slice(0, 2)).toEqual(['ignore', 'ignore']);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ runId: 'run-launchfail-0001', event: 'stop', data: {
    class: 'launch-failed', cause: "child rc=2: error: unknown command 'tick.ts'", evidenceRef: join(stderrDir, 'run-launchfail-0001.stderr'), nextMove: expect.any(String) } });
  expect(String(written[0]!.data.cause).length).toBeLessThanOrEqual(120);
  expect(String(written[0]!.data.cause)).not.toContain('frame');
});

test('STOP-RECORD launch-failed: a child still running after the window (or exiting 0) records no stop and returns the receipt', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const written: RunLedgerEntry[] = [];
  const alive = await defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchok-0001'),
    { spawn: exitingSpawn(null).spawn, stderrDir, earlyExitWindowMs: 50, writeStop: (entry) => { written.push(entry); } });
  expect(alive).toEqual({ runId: 'run-launchok-0001' });
  const clean = await defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchok-0002'),
    { spawn: exitingSpawn(0).spawn, stderrDir, earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } });
  expect(clean).toEqual({ runId: 'run-launchok-0002' });
  expect(written).toHaveLength(0);
});

test('STOP-RECORD launch-failed: no stderr still records rc only', async () => {
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0002'),
    { spawn: exitingSpawn(7).spawn, stderrDir: mkdtempSync(join(tmpdir(), 'tasks-cli-launch-')), earlyExitWindowMs: 1_000, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow();
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=7']);
});

test('STOP-RECORD launch-failed: a rerun truncates the old stderr and an existing stop is not duplicated (review must-fix)', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  writeFileSync(join(stderrDir, 'run-launchfail-0003.stderr'), 'stale error from the previous attempt\n');
  const written: RunLedgerEntry[] = [];
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0003'),
    { spawn: exitingSpawn(3, 'fresh error\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('fresh error');
  expect(written.map((entry) => entry.data.cause)).toEqual(['child rc=3: fresh error']);
  await expect(defaultTaskLauncher(['harness', 'say', 'x'], undefined, launchContext('run-launchfail-0004'),
    { spawn: exitingSpawn(3, 'boom\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => true, writeStop: (entry) => { written.push(entry); } })).rejects.toThrow('rc=3');
  expect(written).toHaveLength(1);
});

test('STOP-RECORD launch-failed: through task hand --live the card is launch-failed, not launched', async () => {
  const stderrDir = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const taskStatePath = join(mkdtempSync(join(tmpdir(), 'tasks-cli-card-')), 'task-agent-actions.json');
  const written: RunLedgerEntry[] = [];
  const result = await run(['task', 'hand', 'ship it', '--live'], {
    taskStatePath, registerSink: async () => true,
    taskLauncher: (args, cwd, context) => defaultTaskLauncher(args, cwd, context,
      { spawn: exitingSpawn(2, 'error: bad argv\n').spawn, stderrDir, earlyExitWindowMs: 1_000, hasStop: () => false, writeStop: (entry) => { written.push(entry); } }),
  });
  expect(result.code).toBe(1);
  const cards = Object.values(JSON.parse(readFileSync(taskStatePath, 'utf8')).tasks) as Array<{ status: string; history: Array<{ event: string; detail?: string }> }>;
  expect(cards).toHaveLength(1);
  expect(cards[0]!.status).toBe('launch-failed');
  expect(cards[0]!.history[0]!.detail).toContain('child rc=2: error: bad argv');
  expect(written).toHaveLength(1);
  expect(written[0]!.data).toMatchObject({ class: 'launch-failed' });
});
