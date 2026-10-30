import { expect, spyOn, test } from 'bun:test';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { buildAgentTool } from '../skills/tools/agent.js';
import { dispatchSessionRuntimeTool } from '../session-runtime/index.js';
import * as llmModule from '../llm.js';
import { streamLLMWithTools, type LLMProvider } from '../llm.js';
import { bootDashboardAcpSession } from './acp-boot.js';
import { enqueueClassicSidetabMissionCompletion } from './classic-sidetab-mission-job.js';
import { createDashboardClassicSidetabMissionCallbacks } from './index.js';
import { startClassicMissionCli } from './mission-cli-consumer.js';

test('classic dashboard ACP boot returns running immediately and delivers one terminal mission notification', async () => {
  const missionCalls: Array<{ agent: string; mission: string }> = [];
  const nextModelInputs: string[] = [];
  const notifications = new TaskNotificationQueue();
  let completion: Promise<unknown> | undefined;
  let outputPath = '';
  let statusRead = 0;
  let sawAgentToolWithHand = false;
  let modelTurn = 0;
  const classicMission = createDashboardClassicSidetabMissionCallbacks(async (agent, mission) => {
    missionCalls.push({ agent, mission });
    const started = await startClassicMissionCli({ agent, prompt: mission }, {
      now: () => 1,
      delay: async () => {},
      runCli: async args => {
        if (args[1] === 'run') {
          outputPath = args[args.indexOf('--out') + 1]!;
          return { code: 0, stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'running' }), stderr: '' };
        }
        if (args[1] === 'status') {
          statusRead += 1;
          return statusRead === 1
            ? { code: 0, stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'running' }), stderr: '' }
            : { code: 0, stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'completed', result: `The classic sidetab mission is complete. ${outputPath}` }), stderr: '' };
        }
        throw new Error(`unexpected fake Codex CLI call: ${args.join(' ')}`);
      },
    });
    if (!('completion' in started)) throw new Error('mission did not start independently');
    completion = started.completion;
    enqueueClassicSidetabMissionCompletion(started, agent, notification => notifications.enqueue(notification));
    return {
      ok: true,
      status: 'running',
      interactionId: started.interactionId,
      path: started.path,
      content: 'Independent sidetab job started; this conversation can continue.',
    };
  });
  const provider: LLMProvider = {
    name: 'classic-acp-fixture',
    defaultModel: 'classic-acp-fixture',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages, options) {
      sawAgentToolWithHand ||= (options?.tools ?? []).some(tool => tool.name === 'Agent'
        && ((tool.parameters.properties as Record<string, unknown>).hand !== undefined));
      if (modelTurn++ === 0) {
        yield {
          type: 'tool_call',
          id: 'classic-acp-mission-1',
          name: 'Agent',
          args: { description: 'write status utility', prompt: 'Write a tiny status utility.', hand: 'codex' },
        };
        return;
      }
      const input = JSON.stringify(messages);
      nextModelInputs.push(input);
      yield { type: 'text', delta: input };
    },
  };
  const realStreamLLMWithTools = streamLLMWithTools;
  const streamSpy = spyOn(llmModule, 'streamLLMWithTools').mockImplementation((messages, handlers, options = {}) =>
    realStreamLLMWithTools(messages, handlers, { ...options, provider }));

  let boot: Awaited<ReturnType<typeof bootDashboardAcpSession>> | undefined;
  try {
    boot = await bootDashboardAcpSession({
      getCwd: () => process.cwd(),
      getChatHistory: () => [],
      getPreamble: () => [],
      getTools: () => classicMission.getTools([buildAgentTool()]),
      getActiveModel: () => null,
      dispatchTool: async (name, args) => classicMission.dispatchTool(name, args) ?? { error: 'unknown tool' },
      pushTurnToolHistory: () => {},
    });
    const output: string[] = [];
    const toolResults: unknown[] = [];
    await boot.session.send({
      userText: 'codex 띄워서 작은 상태 유틸을 만들어 줘',
      onText: chunk => output.push(chunk),
      onToolResult: call => toolResults.push(call.result),
    });

    expect(sawAgentToolWithHand).toBe(true);
    expect(missionCalls).toEqual([{ agent: 'codex', mission: 'Write a tiny status utility.' }]);
    expect(toolResults).toEqual([{
      status: 'running',
      body: 'Independent sidetab job started; this conversation can continue.',
      artifacts: [],
      id: '123e4567-e89b-42d3-a456-426614174000',
    }]);
    expect(nextModelInputs).toHaveLength(1);
    expect(nextModelInputs[0]).toContain('Independent sidetab job started; this conversation can continue.');
    expect(nextModelInputs[0]).not.toContain(outputPath);
    expect(output.join('')).toContain('Independent sidetab job started; this conversation can continue.');
    await completion;
    await new Promise(resolve => setTimeout(resolve, 0));
    const delivered = notifications.drain();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ taskId: '123e4567-e89b-42d3-a456-426614174000', state: 'done' });
    expect(JSON.parse(delivered[0]!.output)).toEqual({
      status: 'done',
      body: 'The classic sidetab mission is complete. [internal result]',
      artifacts: [],
      id: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(notifications.drain()).toEqual([]);
  } finally {
    try {
      await boot?.session.close();
    } finally {
      streamSpy.mockRestore();
    }
  }
});

test('classic ACP Agent with omitted/internal hand reaches the built-in session-runtime dispatcher', async () => {
  let modelTurn = 0;
  let builtInAgentCalls = 0;
  let externalMissionCalls = 0;
  const classicMission = createDashboardClassicSidetabMissionCallbacks(async () => {
    externalMissionCalls += 1;
    throw new Error('internal Agent must use the built-in dispatcher');
  });
  const provider: LLMProvider = {
    name: 'classic-acp-agent-fallback-fixture',
    defaultModel: 'classic-acp-agent-fallback-fixture',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat() {
      if (modelTurn++ === 0) {
        yield { type: 'tool_call', id: 'classic-agent-fallback-1', name: 'Agent',
          args: { description: 'use built-in', prompt: 'Delegate through the normal Agent.' } };
        return;
      }
      yield { type: 'text', delta: 'built-in completed' };
    },
  };
  const realStreamLLMWithTools = streamLLMWithTools;
  const streamSpy = spyOn(llmModule, 'streamLLMWithTools').mockImplementation((messages, handlers, options = {}) =>
    realStreamLLMWithTools(messages, handlers, { ...options, provider }));
  let boot: Awaited<ReturnType<typeof bootDashboardAcpSession>> | undefined;
  try {
    boot = await bootDashboardAcpSession({
      getCwd: () => process.cwd(),
      getChatHistory: () => [],
      getPreamble: () => [],
      getTools: () => classicMission.getTools([buildAgentTool()]),
      getActiveModel: () => null,
      dispatchTool: async (name, args) => classicMission.dispatchTool(name, args) ?? dispatchSessionRuntimeTool(name, args, {
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async () => ({ error: 'unexpected Agent runtime route' }),
        dispatchPluginTool: async () => ({ ok: false, error: 'unused' }),
        dispatchNativeTool: async (toolName, input) => {
          expect(toolName).toBe('Agent');
          builtInAgentCalls += 1;
          return { status: 'built-in-agent', description: input.description };
        },
      }),
      pushTurnToolHistory: () => {},
    });
    const results: unknown[] = [];
    await boot.session.send({ userText: 'Use the built-in sub-agent.', onText: () => {}, onToolResult: call => results.push(call.result) });
    expect(results).toEqual([{ status: 'built-in-agent', description: 'use built-in' }]);
    expect(builtInAgentCalls).toBe(1);
    expect(externalMissionCalls).toBe(0);
  } finally {
    try { await boot?.session.close(); }
    finally { streamSpy.mockRestore(); }
  }
});
