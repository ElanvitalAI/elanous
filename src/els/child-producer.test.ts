import { expect, test } from 'bun:test';
import { AgentRegistry } from '../agent/registry.js';
import { wireElsChildProducer } from './child-producer.js';
import type { ElsRequest } from './server.js';

test('sub-agent start and end become child start/end requests; a failing server is ignored', async () => {
  const registry = new AgentRegistry();
  const sent: ElsRequest[] = [];
  const wired = wireElsChildProducer({ registry, ws: 'OP', socketPath: '/x/els.sock',
    request: (_path, request) => { sent.push(request); return Promise.reject(new Error('no server')); } });
  const def = { name: 'general-purpose', description: 'd' } as never;
  const task = registry.register(def, 'prompt');
  await registry.runManaged(task.id, async () => 'all good');
  expect(sent.map((r) => (r.op === 'child' ? [r.action, r.ws ?? '', r.source ?? ''] : []))).toEqual([['start', 'OP', 'subagent'], ['end', '', '']]);
  const end = sent[1]!;
  expect(end.op === 'child' && end.ok === true && end.summary).toBe('all good');
  wired.dispose();
  const again = registry.register(def, 'p2');
  await registry.runManaged(again.id, async () => 'x');
  expect(sent).toHaveLength(2);
});
