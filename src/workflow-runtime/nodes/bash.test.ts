import { expect, test } from 'bun:test';
import { executeBashNode } from './bash.js';
import type { NodeExecContext, WorkflowDeps } from '../types.js';

const context: NodeExecContext = {
  arguments: '', artifactsDir: '/tmp/artifacts', outputs: {},
  resolvedProvider: undefined, resolvedModel: undefined, toolPolicy: {},
};

test('bash forwards a node-scoped environment to runBash without changing the command', async () => {
  const env: NodeJS.ProcessEnv = { ELANOUS_GRAPH_CONTEXT: '/tmp/graph-context.json', PATH: '/usr/bin' };
  let received: Parameters<WorkflowDeps['runBash']> | undefined;
  const deps: WorkflowDeps = {
    callLLM: async () => '',
    runBash: async (...args) => {
      received = args;
      return { stdout: 'command-output', stderr: '', exitCode: 0 };
    },
  };
  const result = await executeBashNode({ id: 'cmd', bash: 'printf command-output', idle_timeout: 1000 }, { ...context, env }, deps);
  expect(result).toMatchObject({ ok: true, output: 'command-output' });
  expect(received).toEqual(['printf command-output', {
    timeoutMs: 1000, signal: undefined, cwd: process.cwd(), env,
  }]);
});

test('bash leaves the runBash environment unspecified for workflows without one', async () => {
  let received: Parameters<WorkflowDeps['runBash']>[1] | undefined;
  const deps: WorkflowDeps = {
    callLLM: async () => '',
    runBash: async (_body, opts) => {
      received = opts;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  await executeBashNode({ id: 'cmd', bash: 'true' }, context, deps);
  expect(received).toEqual({ timeoutMs: undefined, signal: undefined, cwd: process.cwd() });
  expect(received).not.toHaveProperty('env');
});

test('bash node error keeps the first 200 and last 800 of a long stderr, including the real error line', async () => {
  const head = 'B'.repeat(200);
  const middle = 'M'.repeat(1_000);
  const tail = `${'T'.repeat(789)}\nREAL-ERROR`;
  const stderr = head + middle + tail;
  expect(stderr.length).toBe(2_000);
  const deps: WorkflowDeps = {
    callLLM: async () => '',
    runBash: async () => ({ stdout: '', stderr, exitCode: 1 }),
  };
  const result = await executeBashNode({ id: 'cmd', bash: 'false' }, context, deps);
  expect(result.ok).toBe(false);
  expect(result.error).toContain(head);
  expect(result.error).toContain('REAL-ERROR');
  expect(result.error).not.toContain(middle);
  expect(result.error!.indexOf('REAL-ERROR')).toBeGreaterThan(result.error!.indexOf('…'));
});
