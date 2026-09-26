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
