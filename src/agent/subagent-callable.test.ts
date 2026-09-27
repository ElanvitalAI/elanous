import { expect, test } from 'bun:test';
import type { LLMProvider, LLMToolSpec } from '../llm.js';
import type { AgentSpawnOpts } from './types.js';
import { createGlobalSubagentCallable } from './subagent-callable.js';
import type { AgentRegistry } from './registry.js';

// 2026-09-27 dogfood: TOX `run` tasks asked for `general-purpose` and the default resolver
// (4-layer map without the builtin dir) said «not found». The default must reach builtins.
test('default resolver reaches the builtin general-purpose definition', async () => {
  const spawned: string[] = [];
  const registry = {
    spawn: ({ definition }: { definition: { name: string } }) => {
      spawned.push(definition.name);
      return { task: { id: 'agent-1' }, events: (async function* () { yield { type: 'done', result: 'ok' } as never; })() };
    },
    abort: () => {},
  } as unknown as AgentRegistry;
  const call = createGlobalSubagentCallable({
    registry, hostTools: [{ name: 'Bash' } as LLMToolSpec], dispatchTool: async () => 'ok',
  });
  const { address } = await call({ definitionName: 'general-purpose', prompt: 'hello' });
  expect(address).not.toContain('subagent:unknown');
  expect(spawned).toEqual(['general-purpose']);
});

test('run callable filters host tools and fails closed when tools or dispatch are unavailable', async () => {
  const spawns: AgentSpawnOpts[] = [];
  const registry = {
    spawn: (opts: AgentSpawnOpts) => {
      spawns.push(opts);
      return {
        task: { id: 'agent-tools', controller: new AbortController() },
        events: (async function* () { yield { type: 'done', text: 'ran' } as const; })(),
      };
    },
    abort: () => {},
  } as unknown as AgentRegistry;
  const names = ['Bash', 'Read', 'Agent', 'Foo'];
  const hostTools = names.map(name => ({ name } as LLMToolSpec));
  let dispatchedSignal: AbortSignal | undefined;
  const dispatchedNames: string[] = [];
  const dispatchTool = async (name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
    dispatchedNames.push(name);
    dispatchedSignal = signal;
    return 'ok';
  };
  const provider = {} as LLMProvider;
  const call = createGlobalSubagentCallable({ registry, hostTools, dispatchTool, provider, cwd: '/test/tool-cwd' });
  const run = await call({ definitionName: 'general-purpose', prompt: 'run command' });
  expect((await run.done).status).toBe('completed');
  expect(spawns[0]!.provider).toBe(provider);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.tools?.map(tool => tool.name)).toEqual(['Bash', 'Read']);
  expect(spawns[0]!.dispatchTool).toBeDefined();
  expect(await spawns[0]!.dispatchTool!('Bash', {})).toBe('ok');
  for (const name of ['Agent', 'Foo', 'Edit']) {
    await expect(spawns[0]!.dispatchTool!(name, {})).rejects.toThrow(`subagent tool '${name}' is not allowed`);
  }
  expect(dispatchedNames).toEqual(['Bash']);
  expect(dispatchedSignal).toBeInstanceOf(AbortSignal);
  expect(spawns[0]!.cwd).toBe('/test/tool-cwd');

  const noTools = await createGlobalSubagentCallable({ registry })({ definitionName: 'general-purpose', prompt: 'run command' });
  expect(noTools.address).toBe('subagent:no-tools:general-purpose');
  const noToolsResult = await noTools.done;
  expect(noToolsResult.status).toBe('failed');
  expect(noToolsResult.output.startsWith('no-tools:')).toBe(true);
  expect(noToolsResult.output.includes('host tool count=unknown')).toBe(true);
  expect(noToolsResult.output.includes('Bash, Read, Edit, Grep, WebFetch')).toBe(true);
  const emptyHost = await createGlobalSubagentCallable({ registry, hostTools: [], dispatchTool })({ definitionName: 'general-purpose', prompt: 'run command' });
  expect((await emptyHost.done).output).toContain('host tool count=0');
  const noDispatch = await createGlobalSubagentCallable({ registry, hostTools })({ definitionName: 'general-purpose', prompt: 'run command' });
  expect((await noDispatch.done).status).toBe('failed');
  expect(spawns).toHaveLength(1);

  const restricted = createGlobalSubagentCallable({
    registry, hostTools, dispatchTool,
    resolveDefinition: () => ({
      name: 'restricted', description: 'test', systemPrompt: 'test',
      tools: ['Bash', 'Read'], disallowedTools: ['Read'],
    }),
  });
  await restricted({ definitionName: 'restricted', prompt: 'test' });
  expect(spawns[1]!.tools?.map(tool => tool.name)).toEqual(['Bash']);
  await expect(spawns[1]!.dispatchTool!('Read', {})).rejects.toThrow("subagent tool 'Read' is not allowed");
  expect(dispatchedNames).toEqual(['Bash']);
});
