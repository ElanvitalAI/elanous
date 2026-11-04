import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { dispatchSessionRuntimeTool } from '../session-runtime/index.js';
import { streamLLMWithTools, type LLMProvider } from '../llm.js';
import { CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME, CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME, CLASSIC_SIDETAB_MISSION_TOOL_NAME, createClassicSidetabMissionTool } from './classic-sidetab-mission.js';
import { createDashboardClassicSidetabMissionCallbacks } from './index.js';
import { startClassicMissionCli } from './mission-cli-consumer.js';

test('classic chat exposes and dispatches a sidetab mission without leaking its internal result path', async () => {
  const requests: Array<{ agent: string; mission: string }> = [];
  let turn = 0;
  let sawTool = false;
  let resultWasFedBack = false;
  let outputPath = '';
  let statusRead = 0;
  const classicMission = createDashboardClassicSidetabMissionCallbacks(async (agent, mission) => {
    requests.push({ agent, mission });
    const started = await startClassicMissionCli({ agent, prompt: mission }, {
      now: () => 1,
      delay: async () => {},
      runCli: async args => {
        if (args[0] === 'mission' && args[1] === 'run') {
          outputPath = args[args.indexOf('--out') + 1]!;
          return { code: 0, stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'running' }), stderr: '' };
        }
        if (args[0] === 'mission' && args[1] === 'status') {
          statusRead += 1;
          if (statusRead === 1) {
            return {
              code: 0,
              stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'running' }),
              stderr: '',
            };
          }
          return {
            code: 0,
            stdout: JSON.stringify({ missionId: '123e4567-e89b-42d3-a456-426614174000', status: 'completed', result: `The requested change is complete. ${outputPath}` }),
            stderr: '',
          };
        }
        throw new Error(`unexpected fake Codex CLI call: ${args.join(' ')}`);
      },
    });
    return 'completion' in started ? started.completion : started;
  });
  const provider: LLMProvider = {
    name: 'local-test',
    defaultModel: 'local-test',
    available: () => true,
    async *chat() { yield 'unused'; },
    async *streamChat(messages, options) {
      sawTool ||= (options?.tools ?? []).some(({ name }) => name === CLASSIC_SIDETAB_MISSION_TOOL_NAME);
      if (turn++ === 0) {
        yield {
          type: 'tool_call',
          id: 'classic-mission-1',
          name: CLASSIC_SIDETAB_MISSION_TOOL_NAME,
          args: { agent: 'codex', mission: 'Write a tiny status utility.' },
        };
      } else {
        const context = JSON.stringify(messages);
        resultWasFedBack = context.includes('The requested change is complete. [internal result]');
        yield { type: 'text', delta: context };
      }
    },
  };
  const toolResults: unknown[] = [];

  const answer = await streamLLMWithTools([{ role: 'user', content: 'codex 띄워서 작은 상태 유틸을 만들어 줘' }], {
    onText: () => {},
    onToolResult: (call) => toolResults.push(call.result),
    dispatchTool: async (name, args) => classicMission.dispatchTool(name, args) ?? { error: 'unknown tool' },
  }, { provider, tools: classicMission.getTools([]), maxTurns: 2 });

  expect(sawTool).toBe(true);
  expect(requests).toEqual([{ agent: 'codex', mission: 'Write a tiny status utility.' }]);
  expect(toolResults).toEqual([{
    status: 'done',
    body: 'The requested change is complete. [internal result]',
    artifacts: [],
    id: '123e4567-e89b-42d3-a456-426614174000',
  }]);
  expect(resultWasFedBack).toBe(true);
  expect(answer).toContain('The requested change is complete. [internal result]');
  expect(JSON.stringify(toolResults)).not.toContain('/private/state');
});

test('splits a parent request into scoped Codex and Claude briefs under one parent call ID', async () => {
  const starts: Array<{ agent: string; codexBrief: string; claudeBrief: string; callId?: string; parentSessionId?: string }> = [];
  const tool = createClassicSidetabMissionTool(
    async () => { throw new Error('single mission must not start'); },
    async (agent, codexBrief, claudeBrief, context) => {
      starts.push({ agent, codexBrief, claudeBrief, callId: context?.callId, parentSessionId: context?.parentSessionId });
      return {
        pairId: 'pair-1',
        codex: { ok: true, status: 'running', interactionId: 'codex-child' },
        claude: { ok: true, status: 'running', interactionId: 'claude-child' },
      };
    },
  );
  const result = await tool.dispatch({
    agent: 'claude',
    mission: 'Add authenticated export support.',
    decomposition: {
      status: 'ready',
      codex: { scope: 'Implement the export authorization guard.', deliverables: 'Guard and focused unit tests.', dependsOn: 'Existing export API contract.' },
      claude: { scope: 'Document the authenticated export behavior.', deliverables: 'User-facing docs and examples.', dependsOn: 'Existing export API contract.' },
    },
  }, { callId: 'parent-call-42', parentSessionId: 'parent-session-9' });
  expect(result.status).toBe('running');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ agent: 'codex', callId: 'parent-call-42', parentSessionId: 'parent-session-9' });
  expect(starts[0]?.codexBrief).toContain('Implement the export authorization guard.');
  expect(starts[0]?.codexBrief).toContain('Guard and focused unit tests.');
  expect(starts[0]?.codexBrief).toContain('Existing export API contract.');
  expect(starts[0]?.claudeBrief).toContain('Document the authenticated export behavior.');
  expect(starts[0]?.claudeBrief).toContain('User-facing docs and examples.');
  expect(starts[0]?.claudeBrief).toContain('Existing export API contract.');
  expect(starts[0]?.codexBrief).not.toEqual(starts[0]?.claudeBrief);
});

test('keeps distinct legacy pair prompts dispatchable while routing Codex and Claude roles', async () => {
  let received: { agent: string; codexBrief: string; claudeBrief: string } | undefined;
  const tool = createClassicSidetabMissionTool(
    async () => { throw new Error('single mission must not start'); },
    async (agent, codexBrief, claudeBrief) => {
      received = { agent, codexBrief, claudeBrief };
      return {
        pairId: 'legacy-pair',
        codex: { ok: true, status: 'running', interactionId: 'codex-child' },
        claude: { ok: true, status: 'running', interactionId: 'claude-child' },
      };
    },
  );
  await tool.dispatch({ agent: 'claude', mission: 'Claude-scoped task', parallelMission: 'Codex-scoped task' });
  expect(received).toEqual({
    agent: 'codex',
    codexBrief: 'Codex-scoped task',
    claudeBrief: 'Claude-scoped task',
  });
});

test('holds an unsplittable parent request with its reason and launches no child', async () => {
  let childDispatches = 0;
  const tool = createClassicSidetabMissionTool(
    async () => { throw new Error('single mission must not start'); },
    async () => {
      childDispatches += 1;
      throw new Error('pair must not start');
    },
  );
  const result = await tool.dispatch({
    agent: 'codex',
    mission: 'Make one atomic migration that must be authored and validated by the same hand.',
    decomposition: { status: 'cannot-split', reason: 'The migration authoring and validation must remain one atomic owner.' },
  });
  expect(result).toMatchObject({
    status: 'error',
    body: 'Pair dispatch held: The migration authoring and validation must remain one atomic owner.',
  });
  expect(childDispatches).toBe(0);
});

test('rejects duplicate pair briefs before dispatching either mock child', async () => {
  let childDispatches = 0;
  const tool = createClassicSidetabMissionTool(
    async () => { throw new Error('single mission must not start'); },
    async () => {
      childDispatches += 1;
      return {
        pairId: 'duplicate-pair',
        codex: { ok: true, status: 'running', interactionId: 'codex-child' },
        claude: { ok: true, status: 'running', interactionId: 'claude-child' },
      };
    },
  );
  const result = await tool.dispatch(
    { agent: 'codex', mission: 'Implement the auth guard.', parallelMission: '  Implement the auth guard.  ' },
    { callId: 'parent-call-1', parentSessionId: 'parent-session-1' },
  );
  expect(result).toMatchObject({
    status: 'error',
    body: 'Pair missions must be distinct child briefs; split the parent task before dispatch',
  });
  expect(childDispatches).toBe(0);
});

test('linear mission binding stays single-only while pairs skip sync with a warning and continue', async () => {
  const seen: Array<string | undefined> = [];
  const pairContexts: Array<unknown> = [];
  const events: Array<{ category: string; event: string; data: unknown; level?: string }> = [];
  const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown, options?: { level?: string }) => {
    events.push({ category, event, data, ...(options?.level ? { level: options.level } : {}) });
  }) as typeof debug.log);
  const tool = createClassicSidetabMissionTool(async (_agent, _mission, context) => {
    seen.push(context?.linearIssueId);
    return { ok: true, status: 'running', interactionId: '123e4567-e89b-42d3-a456-426614174000' };
  }, async (_agent, _mission, _parallelMission, context) => {
    pairContexts.push(context);
    return ({
    pairId: 'pair',
    codex: { ok: true, status: 'running', interactionId: '123e4567-e89b-42d3-a456-426614174000' },
    claude: { ok: true, status: 'running', interactionId: '123e4567-e89b-42d3-a456-426614174001' },
    });
  });
  try {
    expect((await tool.dispatch({ agent: 'codex', mission: 'work', linearIssueId: 'DEMO-42' })).status).toBe('running');
    expect(seen).toEqual(['DEMO-42']);
    expect((await tool.dispatch(
      {
        agent: 'codex', mission: 'Parent request: work', linearIssueId: 'DEMO-42',
        decomposition: {
          status: 'ready',
          codex: { scope: 'Implement work API.', deliverables: 'API code.', dependsOn: 'Existing API.' },
          claude: { scope: 'Review work API.', deliverables: 'Review notes.', dependsOn: 'Existing API.' },
        },
      },
      { callId: 'pair-call', parentSessionId: 'parent-session', linearIssueId: 'DEMO-42' },
    )).status).toBe('running');
    expect(seen).toEqual(['DEMO-42']);
    expect(pairContexts).toEqual([{ callId: 'pair-call', parentSessionId: 'parent-session' }]);
    expect(events).toContainEqual({
      category: 'agent-mission.sidetab',
      event: 'linear-sync-skipped-for-parallel',
      data: {
        source: 'tool-input+dispatch-context',
        reason: 'Linear progress sync is only supported for a single sidetab mission',
      },
      level: 'warn',
    });
  } finally {
    logSpy.mockRestore();
  }
});

test('strict-schema empty optional sentinels normalize before trio exclusivity checks', async () => {
  const started: Array<{ mission: string; context?: unknown }> = [];
  const singles: string[] = [];
  const tool = createClassicSidetabMissionTool(
    async (_agent, mission) => {
      singles.push(mission);
      return { ok: true, status: 'running', interactionId: 'single-1' };
    },
    undefined,
    async (mission, context) => {
      started.push({ mission, context });
      return {
        trioId: 'trio-1',
        members: {
          codex: { ok: true, status: 'running', interactionId: 'codex-1' },
          claude: { ok: true, status: 'running', interactionId: 'claude-1' },
          grok: { ok: true, status: 'running', interactionId: 'grok-1' },
        },
      };
    },
  );
  const properties = (tool.spec.parameters as { properties: Record<string, unknown> }).properties;
  const parallelSchema = properties.parallelMission as { anyOf: Array<Record<string, unknown>> };
  expect(properties.decomposition).toMatchObject({ type: 'object' });
  const linearSchema = properties.linearIssueId as { anyOf: Array<Record<string, unknown>> };
  expect(parallelSchema.anyOf).toContainEqual({ type: 'null' });
  expect(parallelSchema.anyOf.some((schema) => schema.type === 'array' && schema.maxItems === 0)).toBe(true);
  expect(linearSchema.anyOf).toContainEqual({ type: 'null' });
  expect(linearSchema.anyOf.some((schema) => schema.type === 'array' && schema.maxItems === 0)).toBe(true);

  let turn = 0;
  let toolResult: unknown;
  const provider: LLMProvider = {
    name: 'local-test',
    defaultModel: 'local-test',
    available: () => true,
    async *chat() { yield 'done'; },
    async *streamChat(_messages, options) {
      const missionTool = options?.tools?.find(({ name }) => name === CLASSIC_SIDETAB_MISSION_TOOL_NAME);
      expect(missionTool?.parameters).toMatchObject(tool.spec.parameters);
      if (turn++ === 0) {
        yield {
          type: 'tool_call', id: 'strict-shaped-call', name: CLASSIC_SIDETAB_MISSION_TOOL_NAME,
          args: { agent: 'codex', mission: 'same task', parallelMission: null, linearIssueId: [], withGrok: true },
        };
      } else {
        yield { type: 'text', delta: 'started' };
      }
    },
  };
  await streamLLMWithTools([{ role: 'user', content: 'start a three-hand mission' }], {
    onText: () => {},
    onToolResult: (call) => { toolResult = call.result; },
    dispatchTool: async (_name, args) => tool.dispatch(args),
  }, { provider, tools: [tool.spec], maxTurns: 2 });
  expect(toolResult).toMatchObject({ status: 'running', id: 'codex-1' });
  expect(started).toEqual([{ mission: 'same task', context: undefined }]);
  await expect(tool.dispatch({
    agent: 'codex', mission: 'same task', parallelMission: 'different task', linearIssueId: '', withGrok: true,
  })).resolves.toMatchObject({ status: 'error', body: 'withGrok compares the same mission; omit parallelMission' });
  expect(started).toHaveLength(1);

  const placeholdersOnly = await tool.dispatch({
    agent: 'codex', mission: 'single', parallelMission: '', linearIssueId: null, withGrok: '',
  });
  expect(placeholdersOnly).toMatchObject({ status: 'running', id: 'single-1' });
  expect(singles).toEqual(['single']);
});

test('HandReply tool is present only with its runtime seam and validates correction identity inputs', async () => {
  const called: unknown[] = [];
  const mission = createDashboardClassicSidetabMissionCallbacks(
    async () => ({ ok: false, status: 'failed', error: 'unused' }),
    undefined,
    undefined,
    async (input) => { called.push(input); return { ok: true, body: 'delivered' }; },
  );
  const handReplySpec = mission.getTools([]).find((tool) => tool.name === CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME);
  expect(handReplySpec?.parameters).toMatchObject({ required: ['missionId', 'kind', 'text', 'actor', 'replyTo'] });
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_HAND_REPLY_TOOL_NAME, {
    missionId: '123e4567-e89b-42d3-a456-426614174000', kind: 'correct', text: 'Narrow the next step.', actor: 'agent', replyTo: 3,
    runId: 'run-1', scope: 'src/agent-mission', stop: true, priority: 'P0',
  })).resolves.toMatchObject({ status: 'done', body: 'delivered' });
  expect(called).toEqual([{
    missionId: '123e4567-e89b-42d3-a456-426614174000', kind: 'correct', text: 'Narrow the next step.', actor: 'agent', replyTo: 3,
    runId: 'run-1', scope: 'src/agent-mission', stop: true, priority: 'P0',
  }]);
});

test('classic sidetab mission returns the running interaction ID without waiting for job completion', async () => {
  const missionId = '123e4567-e89b-42d3-a456-426614174000';
  const mission = createDashboardClassicSidetabMissionCallbacks(async (_agent, prompt) => {
    expect(prompt).toBe('Continue independently.');
    return {
      ok: true,
      status: 'running',
      interactionId: missionId,
      path: '/private/state/result.md',
      content: 'Independent sidetab job started. /private/state/result.md',
    };
  });
  const result = await mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, {
    agent: 'codex',
    mission: 'Continue independently.',
  });
  expect(result).toEqual({
    status: 'running',
    body: 'Independent sidetab job started. [internal result]',
    artifacts: [],
    id: missionId,
  });
  expect(JSON.stringify(result)).not.toContain('/private/state');
});

test('classic sidetab mission can be cancelled only by an explicit mission ID request', async () => {
  const missionId = '123e4567-e89b-42d3-a456-426614174000';
  const cancelledIds: string[] = [];
  const mission = createDashboardClassicSidetabMissionCallbacks(async () => ({ ok: true, status: 'running', interactionId: missionId }), async id => {
    cancelledIds.push(id);
    return true;
  });
  expect(mission.getTools([]).map(tool => tool.name)).toEqual([CLASSIC_SIDETAB_MISSION_TOOL_NAME, CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME]);
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME, { missionId })).resolves.toEqual({
    status: 'done', body: 'Sidetab mission cancellation requested.', artifacts: [], id: missionId,
  });
  expect(cancelledIds).toEqual([missionId]);
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_CANCEL_TOOL_NAME, { missionId: 'not-an-id' })).resolves.toMatchObject({ status: 'error' });
  expect(cancelledIds).toEqual([missionId]);
});

test('Agent hand defaults to internal and routes codex/claude through the async sidetab mission contract', async () => {
  const missionId = '123e4567-e89b-42d3-a456-426614174000';
  const launched: Array<{ agent: string; prompt: string; callId?: string }> = [];
  const mission = createDashboardClassicSidetabMissionCallbacks(async (agent, prompt, context) => {
    launched.push({ agent, prompt, callId: context?.callId });
    if (agent === 'claude') return {
      ok: true,
      status: 'completed',
      interactionId: missionId,
      path: '/private/state/result.md',
      content: 'Finished. /private/state/result.md',
    };
    return {
      ok: true,
      status: 'running',
      interactionId: missionId,
      path: '/private/state/result.md',
      content: 'Independent sidetab job started. /private/state/result.md',
    };
  });
  const originalAgentSpec = {
    name: 'Agent',
    description: 'Delegate work to an internal sub-agent.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' }, prompt: { type: 'string' } },
      required: ['description', 'prompt'],
    },
  };
  const tools = mission.getTools([originalAgentSpec]);
  const agentSpec = tools.find(tool => tool.name === 'Agent')!;
  expect((agentSpec.parameters.properties as Record<string, unknown>).hand).toMatchObject({
    type: 'string',
    enum: ['internal', 'codex', 'claude'],
  });
  expect(mission.dispatchTool('Agent', { description: 'delegate', prompt: 'Work.' })).toBeUndefined();
  expect(mission.dispatchTool('Agent', { description: 'delegate', prompt: 'Work.', hand: 'internal' })).toBeUndefined();
  await expect(mission.dispatchTool('Agent', {
    description: 'delegate', prompt: 'Work independently.', hand: 'codex',
  }, { callId: 'tool-call-7' })).resolves.toEqual({
    status: 'running', body: 'Independent sidetab job started. [internal result]', artifacts: [], id: missionId,
  });
  expect(launched).toEqual([{ agent: 'codex', prompt: 'Work independently.', callId: 'tool-call-7' }]);
  await expect(mission.dispatchTool('Agent', {
    description: 'delegate', prompt: 'Review this.', hand: 'claude',
  })).resolves.toEqual({
    status: 'done', body: 'Finished. [internal result]', artifacts: [], id: missionId,
  });
  expect(launched[1]).toEqual({ agent: 'claude', prompt: 'Review this.', callId: undefined });
  await expect(mission.dispatchTool('Agent', { prompt: 'Work.', hand: 'other' })).resolves.toMatchObject({
    status: 'error', body: 'hand must be internal, codex, or claude',
  });
  expect(JSON.stringify(launched)).not.toContain('/private/state');
});

test('Agent hand omitted/internal falls through to the established session-runtime Agent dispatcher', async () => {
  const mission = createDashboardClassicSidetabMissionCallbacks(async () => {
    throw new Error('internal Agent must not start an external mission');
  });
  let nativeAgentCalls = 0;
  const runBuiltinAgent = async (args: Record<string, unknown>) => {
    const intercepted = mission.dispatchTool('Agent', args);
    if (intercepted) return intercepted;
    return dispatchSessionRuntimeTool('Agent', args, {
      getToolRuntime: () => undefined,
      dispatchToolRuntime: async () => ({ error: 'unexpected runtime Agent path' }),
      dispatchPluginTool: async () => ({ ok: false, error: 'unused' }),
      dispatchNativeTool: async (name, input) => {
        expect(name).toBe('Agent');
        nativeAgentCalls += 1;
        return { status: 'built-in-agent', description: input.description };
      },
    });
  };
  await expect(runBuiltinAgent({ description: 'internal', prompt: 'Use the normal sub-agent.' }))
    .resolves.toEqual({ status: 'built-in-agent', description: 'internal' });
  await expect(runBuiltinAgent({ description: 'explicit internal', prompt: 'Keep the normal route.', hand: 'internal' }))
    .resolves.toEqual({ status: 'built-in-agent', description: 'explicit internal' });
  expect(nativeAgentCalls).toBe(2);
});

test('classic sidetab mission rejects missing mission text and reports failure without exposing the path', async () => {
  let calls = 0;
  const tool = createDashboardClassicSidetabMissionCallbacks(async () => {
    calls += 1;
    return { ok: false, path: '/private/state/failed.md', error: 'Agent did not return to its prompt' };
  });

  await expect(tool.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: '  ' })).resolves.toMatchObject({ status: 'error', body: 'mission text is required' });
  await expect(tool.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: 'Do work.', outputPath: '/private/state/result.md' })).resolves.toMatchObject({ status: 'error', body: 'arguments contain unsupported fields' });
  await expect(tool.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, ['codex', 'Do work.'])).resolves.toMatchObject({ status: 'error', body: 'arguments must be an object' });
  await expect(tool.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: 'Do work.' })).resolves.toMatchObject({ status: 'error', body: 'Sidetab mission failed; no result was returned' });
  expect(calls).toBe(1);
});

test('classic sidetab mission redacts the internal path from failure details and labels Claude correctly', async () => {
  const outputPath = '/private/state/missions/failed/result.md';
  const mission = createDashboardClassicSidetabMissionCallbacks(async (agent) => agent === 'claude'
    ? { ok: true, status: 'completed', interactionId: 'claude-123', path: outputPath, content: `Done. ${outputPath}` }
    : { ok: false, path: outputPath, error: `Cannot read /private/state/missions/failed/secrets.txt or ${outputPath}` });
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: 'Work.' }))
    .resolves.toMatchObject({ status: 'error', body: 'Sidetab mission failed; no result was returned' });
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'claude', mission: 'Work.' }))
    .resolves.toEqual({ status: 'done', body: 'Done. [internal result]', artifacts: [], id: 'claude-123' });
});

test('classic sidetab mission sanitizes an internal absolute path when the runtime throws before returning a result', async () => {
  const mission = createDashboardClassicSidetabMissionCallbacks(async () => {
    throw new Error('failed while writing /private/state/missions/id/result.md');
  });
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: 'Work.' }))
    .resolves.toEqual({ status: 'error', body: 'Sidetab mission failed before a result was available', artifacts: [], id: null });
});

test('classic sidetab mission does not expose failure text when the runtime omitted its result path', async () => {
  const mission = createDashboardClassicSidetabMissionCallbacks(async () => ({
    ok: false,
    error: 'failed while writing /private/state/missions/id/result.md',
  }));
  await expect(mission.dispatchTool(CLASSIC_SIDETAB_MISSION_TOOL_NAME, { agent: 'codex', mission: 'Work.' }))
    .resolves.toEqual({ status: 'error', body: 'Sidetab mission failed; no result was returned', artifacts: [], id: null });
});
