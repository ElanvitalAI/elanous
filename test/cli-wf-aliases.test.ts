// Caveat #3 follow-up (2026-05-08) — `elanous wf` alias + legacy nudge.
//
// Smoke-tests the CLI surface via subprocess so we exercise commander
// the same way real users do (rather than re-running the in-process
// action handlers, which already have coverage in cli-workflow.test.ts).

import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ENTRY = resolve(import.meta.dir, '..', 'src', 'index.ts');

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', [ENTRY, '--test', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'test', ...env },
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('elanous wf — plural alias `workflows`', () => {
  it('`elanous workflows --help` lands on the DAG runtime help', () => {
    const r = run(['workflows', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('YAML DAG workflows');
    expect(r.stdout).toMatch(/Run a workflow|Print a workflow YAML/);
  });

  it('`elanous wf --help` shows the same help with the alias hint', () => {
    const r = run(['wf', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('YAML DAG workflows');
    // Commander renders both names like `wf|workflows` in usage.
    expect(r.stdout).toMatch(/wf\|workflows/);
  });

  it('`elanous workflows list` runs and surfaces builtin workflows', () => {
    const r = run(['workflows', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('quick-summary');
    expect(r.stdout).toContain('pdca-cycle');
  });
});

describe('elanous workflow — singular alias for elanous wf', () => {
  // `elanous workflow` is wired as an alias on the `wf` command
  // (workflow-runtime DAG) alongside the plural `elanous workflows`,
  // so the natural-language singular form works identically.

  it('`elanous workflow list` runs and surfaces builtin workflows', () => {
    const r = run(['workflow', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('quick-summary');
    expect(r.stdout).toContain('pdca-cycle');
  });

  it('`elanous workflow --help` shows DAG runtime help with alias hint', () => {
    const r = run(['workflow', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('YAML DAG workflows');
    // Commander only renders the first alias in the Usage line; the
    // singular `workflow` appears in the description copy.
    expect(r.stdout).toMatch(/wf\|workflows/);
    expect(r.stdout).toContain('`workflow` (singular)');
  });
});

describe('elanous task / scheduler', () => {
  // /task now aliases the TOX /tasks command; the old scheduler command
  // still emits its retirement notice and redirects to /wf.
  const combined = (r: { stdout: string; stderr: string }): string => `${r.stdout}${r.stderr}`;

  it('`elanous task list` executes the same isolated TOX listing as `tasks list`', async () => {
    const root = mkdtempSync(join(resolve(import.meta.dir, '..'), '.task-list-alias-'));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/tasks') res.end(JSON.stringify({ tasks: [{ id: 'alias-task', status: 'ready' }] }));
      else if (req.url === '/v1/tasks/alias-task') res.end(JSON.stringify({ task: {
        id: 'alias-task', title: 'Alias listing sentinel', priority: 'high', status: 'ready', createdAt: 1,
      } }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    try {
      await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('isolated task server did not bind');
      mkdirSync(join(root, 'nexus'));
      writeFileSync(join(root, 'nexus', 'runtime.json'), JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), nexusVersion: '0.1', phase: 'test', httpPort: address.port,
      }));
      const execute = (name: 'task' | 'tasks') => new Promise<{ code: number | null; stdout: string }>((done, reject) => {
        const child = spawn('bun', [ENTRY, `--test=${root}`, name, 'list'], {
          env: { ...process.env, NODE_ENV: 'test' },
        });
        let stdout = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.resume();
        child.once('error', reject);
        child.once('close', (code) => done({ code, stdout }));
      });
      const singular = await execute('task');
      const plural = await execute('tasks');
      expect(singular.code).toBe(0);
      expect(plural.code).toBe(0);
      expect(singular.stdout).toBe(plural.stdout);
      expect(singular.stdout).toContain('id\t우선순위\t상태\t승인\t출처\t제목');
      expect(singular.stdout).toContain('alias-task\thigh\tready\t-\t-\tAlias listing sentinel');
      expect(requests).toEqual(['/v1/tasks', '/v1/tasks/alias-task', '/v1/tasks', '/v1/tasks/alias-task']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('`elanous scheduler list` exits non-zero with retirement notice', () => {
    const r = run(['scheduler', 'list']);
    expect(r.code).not.toBe(0);
    expect(combined(r)).toContain('retired');
    expect(combined(r)).toContain('elanous wf');
  });

  it('`elanous sched` alias also routes to retirement notice', () => {
    const r = run(['sched', 'list']);
    expect(r.code).not.toBe(0);
    expect(combined(r)).toContain('retired');
  });
});
