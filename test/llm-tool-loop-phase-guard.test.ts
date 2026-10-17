import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { readFileSync } from 'node:fs';
import { requestPause, resetPauseFlag } from '../src/turn-checkpoint/index.js';
import {
  INACTIVE_PLAN_MODE_STATE,
  resetPlanModeState,
  setPlanModeState,
} from '../src/plan-mode/index.js';
import {
  buildToolLoopPhaseRejectionLog,
  buildToolLoopPhaseRejectionMessage,
  getToolLoopPhaseRejectedTools,
  getToolLoopPhaseRejectedCalls,
  streamLLMWithTools,
  type ContentBlock,
  type LLMMessage,
  type LLMProvider,
  type LLMStreamEvent,
  type ToolLoopFollowupPhase,
  type ToolLoopPhaseRejectionLogFields,
} from '../src/llm.js';
import { ACTION_PHASE_OPS_TOOLS } from '../src/llm/tool-loop-steered-rejection.js';
import { LEDGER_CLI_NATIVE_TOOL } from '../src/skills/tools/shell.js';

const phases: Array<{
  phase: ToolLoopFollowupPhase;
  directive: string;
  event: string;
}> = [
  {
    phase: 'inspect-synthesis',
    directive: 'INSPECT BUDGET EXHAUSTED',
    event: 'tool-loop.inspect-synthesis-phase.tool-rejected',
  },
  {
    phase: 'inspect-action',
    directive: 'INSPECT ACTION REQUIRED',
    event: 'tool-loop.inspect-action-phase.tool-rejected',
  },
  {
    phase: 'inspect-execution',
    directive: 'INSPECT EXECUTION REQUIRED',
    event: 'tool-loop.inspect-execution-phase.tool-rejected',
  },
  {
    phase: 'repair-action',
    directive: 'REPAIR ACTION REQUIRED',
    event: 'tool-loop.repair-action-phase.tool-rejected',
  },
  {
    phase: 'verify-action',
    directive: 'VERIFY ACTION REQUIRED',
    event: 'tool-loop.verify-action-phase.tool-rejected',
  },
];

const existingPayload: ToolLoopPhaseRejectionLogFields = {
  turn: 7,
  maxTurns: 12,
  exploratoryTurnStreak: 3,
  inspectSynthesisArmed: true,
  autoNarrowedReadCount: 2,
  rejectedTools: ['Edit', 'Write'],
  rejectedCount: 2,
};

function toolsInSet(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = new Set([`);
  if (start < 0) return [];
  const end = source.indexOf(']);', start);
  if (end < 0) return [];
  return source.slice(start, end).match(/'([^']+)'/g)?.map((tool) => tool.slice(1, -1)) ?? [];
}

const TOOLS = ['Agent', 'Edit', 'Write', 'Bash', 'RunShell', 'Glob', 'Grep', 'Read', 'MsgList', 'ChecklistList', 'MsgPost', 'MsgAck', 'AgentOutput'].map((name) => ({
  name,
  description: 'd',
  parameters: { type: 'object' },
}));

afterEach(() => {
  resetPlanModeState();
  resetPauseFlag();
});

function scriptedProvider(turns: LLMStreamEvent[][]): {
  provider: LLMProvider;
  capturedMessagesAt: (index: number) => LLMMessage[] | undefined;
} {
  let call = 0;
  const captured: LLMMessage[][] = [];
  const provider: LLMProvider = {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(messages) {
      captured.push(messages.map((message) => ({ ...message })));
      for (const event of turns[call++] ?? []) yield event;
    },
    async *chat() {},
  };
  return { provider, capturedMessagesAt: (index) => captured[index] };
}

function toolResults(messages: LLMMessage[] | undefined): Array<Extract<ContentBlock, { type: 'tool_result' }>> {
  if (!messages) return [];
  return messages.flatMap((message) => message.role === 'user' && Array.isArray(message.content)
    ? message.content.filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    : []);
}

describe('tool-loop followup phase rejection', () => {
  test.each(phases)('$phase clearly rejects pending tools while retaining its directive', ({ phase, directive }) => {
    const message = buildToolLoopPhaseRejectionMessage(phase, ['Edit', 'Write'], 2);

    expect(message).toStartWith('TOOL CALL REJECTED');
    expect(message).toContain('Edit, Write did NOT run');
    expect(message).toContain('Nothing they would have changed has changed.');
    expect(message).toContain(directive);
  });

  test('identifies only canonical rejection stubs and returns their tool names', () => {
    expect(getToolLoopPhaseRejectedTools(buildToolLoopPhaseRejectionMessage('verify-action', ['Write', 'Bash'], 0))).toEqual(['Write', 'Bash']);
    expect(getToolLoopPhaseRejectedTools('normal tool output')).toBeNull();
    expect(getToolLoopPhaseRejectedTools('')).toBeNull();
    expect(getToolLoopPhaseRejectedTools('The marker TOOL CALL REJECTED — Write did NOT run. is merely discussed.')).toBeNull();
  });

  test('uses a distinct event and matching phase field for every followup guard', () => {
    const rejections = phases.map(({ phase }) => buildToolLoopPhaseRejectionLog(phase, existingPayload));

    expect(new Set(rejections.map(({ event }) => event)).size).toBe(5);
    for (const [index, rejection] of rejections.entries()) {
      expect(rejection.event).toBe(phases[index]!.event);
      expect(rejection.payload.phase).toBe(phases[index]!.phase);
    }
  });

  test('preserves the existing rejection payload fields', () => {
    for (const { phase } of phases) {
      const { payload } = buildToolLoopPhaseRejectionLog(phase, existingPayload);
      expect(payload).toMatchObject(existingPayload);
      for (const field of [
        'turn',
        'maxTurns',
        'exploratoryTurnStreak',
        'inspectSynthesisArmed',
        'autoNarrowedReadCount',
        'rejectedTools',
        'rejectedCount',
      ]) {
        expect(payload).toHaveProperty(field);
      }
    }
  });

  test.each([
    ['inspect-action', 'Bash'],
    ['inspect-execution', 'Bash'],
    ['repair-action', 'Read'],
    ['verify-action', 'Read'],
  ] as const)('%s rejects only the disallowed call in a mixed batch', (phase, allowedName) => {
    const calls = [
      { id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
      { id: 'allowed', name: allowedName, args: {} },
      { id: 'grep-content', name: 'Grep', args: { output_mode: 'content' } },
      { id: 'grep-count', name: 'Grep', args: { output_mode: 'count' } },
      { id: 'grep-files', name: 'Grep', args: { output_mode: 'files_with_matches' } },
    ];

    expect(getToolLoopPhaseRejectedCalls(phase, calls).map((call) => call.id)).toEqual(['blocked', 'grep-files']);
  });

  // TUI-VERIFY-PHASE-MSG-TOOLS(#67) · TUI-REPAIR-PHASE-DELEGATE-RESULT(#41)
  test.each(['inspect-action', 'inspect-execution', 'repair-action', 'verify-action'] as const)(
    '%s keeps every RunShell ledger steer target and delegate result runnable (no dead end)',
    (phase) => {
      const steerTargets = [...new Set(Object.values(LEDGER_CLI_NATIVE_TOOL)), 'ChecklistEdit'];
      const calls = [...steerTargets, 'AgentOutput', 'AgentList', 'RunShell', 'Agent'].map((name) => ({ id: name, name, args: {} }));
      expect(getToolLoopPhaseRejectedCalls(phase, calls)).toEqual([]);
      for (const name of steerTargets) expect(ACTION_PHASE_OPS_TOOLS as readonly string[]).toContain(name);
      // exploratory tools stay blocked — the phase still forces action
      expect(getToolLoopPhaseRejectedCalls(phase, [{ id: 'g', name: 'Glob', args: {} }]).map((c) => c.id)).toEqual(['g']);
    },
  );

  // TUI-OPS-TURN-GUARD 관측 공백 ② — 옛 빌드에서 수리·검증 단계가 거부한 운영 도구 넷.
  //   읽기·관측(logs_query · PtyShellPoll)만 통과, 쓰기 동작이 있는 schedule_manage · se_build 는 그대로 거부.
  test.each(['inspect-action', 'inspect-execution', 'repair-action', 'verify-action'] as const)(
    '%s runs read-only ops observation tools but still rejects write-capable ops tools',
    (phase) => {
      const allowed = ['logs_query', 'PtyShellPoll'].map((name) => ({ id: name, name, args: {} }));
      expect(getToolLoopPhaseRejectedCalls(phase, allowed)).toEqual([]);
      for (const { name } of allowed) expect(ACTION_PHASE_OPS_TOOLS as readonly string[]).toContain(name);

      const writeCapable = ['schedule_manage', 'se_build', 'Glob'].map((name) => ({ id: name, name, args: {} }));
      expect(getToolLoopPhaseRejectedCalls(phase, writeCapable).map((c) => c.id)).toEqual(['schedule_manage', 'se_build', 'Glob']);
      for (const name of ['schedule_manage', 'se_build']) expect(ACTION_PHASE_OPS_TOOLS as readonly string[]).not.toContain(name);
    },
  );

  test('inspect-execution still rejects edit tools next to the added observation tools', () => {
    const calls = ['logs_query', 'PtyShellPoll', 'Edit', 'Write'].map((name) => ({ id: name, name, args: {} }));
    expect(getToolLoopPhaseRejectedCalls('inspect-execution', calls).map((c) => c.id)).toEqual(['Edit', 'Write']);
  });

  test('inspect-synthesis still rejects every tool, including the added observation tools', () => {
    const calls = ['logs_query', 'PtyShellPoll'].map((name) => ({ id: name, name, args: {} }));
    expect(getToolLoopPhaseRejectedCalls('inspect-synthesis', calls).map((c) => c.id)).toEqual(['logs_query', 'PtyShellPoll']);
  });

  test('verify phase runs MsgPost/MsgList/MsgAck after edits and still rejects Glob', async () => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test focused.ts' } }],
      [{ type: 'tool_call', id: 'edit', name: 'Edit', args: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }],
      [
        { type: 'tool_call', id: 'post', name: 'MsgPost', args: { to: 'OP', body: 'done' } },
        { type: 'tool_call', id: 'list', name: 'MsgList', args: {} },
        { type: 'tool_call', id: 'ack', name: 'MsgAck', args: { id: 1 } },
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
      ],
      [{ type: 'text', delta: 'reported' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'fix and report' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('reported');
    expect(dispatched).toEqual(['Bash', 'Edit', 'MsgPost', 'MsgList', 'MsgAck']);
    const results = toolResults(capturedMessagesAt(3)).slice(-4);
    expect(results.map((block) => block.content)).toEqual(['MsgPost ran', 'MsgList ran', 'MsgAck ran', expect.stringContaining('Glob did NOT run')]);
    expect(String(results[3]!.content)).toContain('VERIFY ACTION REQUIRED');
  });

  test('repair phase receives a delegated result via AgentOutput and still rejects Glob', async () => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'false' } }],
      [
        { type: 'tool_call', id: 'out', name: 'AgentOutput', args: { taskId: 't1', block: true } },
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
      ],
      [{ type: 'text', delta: 'used delegate result' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'delegate and repair' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('used delegate result');
    expect(dispatched).toEqual(['Bash', 'AgentOutput']);
    const results = toolResults(capturedMessagesAt(2)).slice(-2);
    expect(results[0]!.content).toBe('AgentOutput ran');
    expect(String(results[1]!.content)).toContain('REPAIR ACTION REQUIRED');
  });

  test('reports rejected and executed tool names separately in a partial rejection', () => {
    const message = buildToolLoopPhaseRejectionMessage('repair-action', ['Glob'], 0, ['Read', 'Bash']);

    expect(message).toContain('Glob did NOT run');
    expect(message).toContain('The following allowed tool call(s) are not blocked and continue in original order: Read, Bash.');
    expect(message).toContain('REPAIR ACTION REQUIRED');
    expect(getToolLoopPhaseRejectedTools(message)).toEqual(['Glob']);
  });

  test.each([
    { approvalKey: 'rejected:ops-ledger-cli', nextTool: 'MsgList', nextArgs: {}, shellArgs: (index: number) => ({ command: ['eln', 'msg', 'list', `--page=${index}`] }) },
    { approvalKey: 'rejected:cd', nextTool: 'Glob', nextArgs: { pattern: '**/*.ts' }, shellArgs: (index: number) => ({ command: ['cd', `directory-${index}`] }) },
  ])('five $approvalKey steer turns do not arm repair before $nextTool', async ({ approvalKey, nextTool, nextArgs, shellArgs }) => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      ...Array.from({ length: 5 }, (_, index): LLMStreamEvent[] => [
        { type: 'tool_call', id: `steer-${index}`, name: 'RunShell', args: shellArgs(index) },
      ]),
      [{ type: 'tool_call', id: 'read-after-steer', name: nextTool, args: nextArgs }],
      [{ type: 'text', delta: 'read complete' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'read the ledger' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'RunShell'
            ? { output: `use ${nextTool} instead`, exitCode: null, outcome: 'spawn-error', elapsedMs: 0, approvalKey }
            : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('read complete');
    expect(dispatched).toEqual([...Array(5).fill('RunShell'), nextTool]);
    const results = Array.from({ length: 6 }, (_, index) => toolResults(capturedMessagesAt(index + 1))).flat();
    expect(results.find((block) => block.tool_use_id === 'read-after-steer')?.content).toBe(`${nextTool} ran`);
    expect(results.every((block) => !String(block.content).includes('REPAIR ACTION REQUIRED'))).toBe(true);
  });

  test('real Bash failure permits operational ledger reads but still rejects Glob', async () => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'false' } }],
      [
        { type: 'tool_call', id: 'mail', name: 'MsgList', args: {} },
        { type: 'tool_call', id: 'checklist', name: 'ChecklistList', args: {} },
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
      ],
      [{ type: 'text', delta: 'repair continues' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'run and inspect' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('repair continues');
    expect(dispatched).toEqual(['Bash', 'MsgList', 'ChecklistList']);
    const results = toolResults(capturedMessagesAt(2)).slice(-3);
    expect(results.map((block) => block.tool_use_id)).toEqual(['mail', 'checklist', 'blocked']);
    expect(results[0]!.content).toBe('MsgList ran');
    expect(results[1]!.content).toBe('ChecklistList ran');
    expect(results[2]!.content).toContain('Glob did NOT run');
    expect(results[2]!.content).toContain('REPAIR ACTION REQUIRED');
  });

  test('dispatches permitted repair calls from a mixed batch and preserves call-id result order', async () => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test failing.ts' } }],
      [
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
        { type: 'tool_call', id: 'allowed', name: 'Read', args: { file_path: 'src/llm.ts' } },
        { type: 'tool_call', id: 'grep-content', name: 'Grep', args: { pattern: 'phase', output_mode: 'content' } },
      ],
      [{ type: 'text', delta: 'repaired' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('repaired');
    expect(dispatched).toEqual(['Bash', 'Read', 'Grep']);
    const results = toolResults(capturedMessagesAt(2)).slice(-3);
    expect(results.map((block) => block.tool_use_id)).toEqual(['blocked', 'allowed', 'grep-content']);
    expect(results[0]!.content).toContain('Glob did NOT run');
    expect(results[0]!.content).toContain('are not blocked and continue in original order: Read, Grep');
    expect(results[1]!.content).toBe('Read ran');
    expect(results[2]!.content).toBe('Grep ran');
  });

  test('preserves allowed-first mixed repair call, callback, history, and result order', async () => {
    const dispatched: string[] = [];
    const callbacks: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test failing.ts' } }],
      [
        { type: 'tool_call', id: 'allowed', name: 'Read', args: { file_path: 'src/llm.ts' } },
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
        { type: 'tool_call', id: 'grep-content', name: 'Grep', args: { pattern: 'phase', output_mode: 'content' } },
      ],
      [{ type: 'text', delta: 'repaired' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        onToolCall: (call) => callbacks.push(`call:${call.id}`),
        onToolResult: ({ id }) => callbacks.push(`result:${id}`),
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('repaired');
    expect(dispatched).toEqual(['Bash', 'Read', 'Grep']);
    expect(callbacks).toEqual([
      'call:fail', 'result:fail',
      'call:allowed', 'result:allowed',
      'call:blocked', 'result:blocked',
      'call:grep-content', 'result:grep-content',
    ]);
    const results = toolResults(capturedMessagesAt(2)).slice(-3);
    expect(results.map((block) => block.tool_use_id)).toEqual(['allowed', 'blocked', 'grep-content']);
    expect(results[0]!.content).toBe('Read ran');
    expect(results[1]!.content).toContain('Glob did NOT run');
    expect(results[2]!.content).toBe('Grep ran');
  });

  test('serializes Agent → rejected → Agent mixed repair calls in original callback and result order', async () => {
    const dispatched: string[] = [];
    const callbacks: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test failing.ts' } }],
      [
        { type: 'tool_call', id: 'agent-one', name: 'Agent', args: { description: 'first' } },
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
        { type: 'tool_call', id: 'agent-two', name: 'Agent', args: { description: 'second' } },
      ],
      [{ type: 'text', delta: 'repaired' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        onToolCall: (call) => callbacks.push(`call:${call.id}`),
        onToolResult: ({ id }) => callbacks.push(`result:${id}`),
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('repaired');
    expect(dispatched).toEqual(['Bash', 'Agent', 'Agent']);
    expect(callbacks).toEqual([
      'call:fail', 'result:fail',
      'call:agent-one', 'result:agent-one',
      'call:blocked', 'result:blocked',
      'call:agent-two', 'result:agent-two',
    ]);
    const results = toolResults(capturedMessagesAt(2)).slice(-3);
    expect(results.map((block) => block.tool_use_id)).toEqual(['agent-one', 'blocked', 'agent-two']);
    expect(results.map((block) => block.content)).toEqual(['Agent ran', expect.stringContaining('Glob did NOT run'), 'Agent ran']);
  });

  test('does not record partially rejected calls when a checkpoint pauses before dispatch', async () => {
    const dispatched: string[] = [];
    const callbacks: string[] = [];
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test failing.ts' } }],
      [
        { type: 'tool_call', id: 'blocked', name: 'Glob', args: { pattern: '**/*.ts' } },
        { type: 'tool_call', id: 'allowed', name: 'Read', args: { file_path: 'src/llm.ts' } },
      ],
    ]);

    try {
      const result = await streamLLMWithTools(
        [{ role: 'user', content: 'go' }],
        {
          onText() {},
          onToolCall: (call) => callbacks.push(`call:${call.id}`),
          onToolResult: ({ id }) => {
            callbacks.push(`result:${id}`);
            if (id === 'fail') requestPause();
          },
          dispatchTool: async (name) => {
            dispatched.push(name);
            return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
          },
        },
        { provider, tools: TOOLS, maxTurns: 30 },
      );

      expect(result).toContain('[paused] checkpoint saved');
      expect(dispatched).toEqual(['Bash']);
      expect(callbacks).toEqual(['call:fail', 'result:fail']);
      expect(result).not.toContain('Glob did NOT run');
    } finally {
      resetPauseFlag();
    }
  });

  test('counts rejected phase stubs in identical-success repeat tracking without executing them', async () => {
    const dispatched: string[] = [];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test failing.ts' } }],
      [
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'tool_call' as const,
          id: `glob-${index}`,
          name: 'Glob',
          args: { pattern: '**/*.ts' },
        })),
        { type: 'tool_call', id: 'read', name: 'Read', args: { file_path: 'src/llm.ts' } },
      ],
      [{ type: 'text', delta: 'repaired' }],
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash' ? { output: 'failed', exitCode: 1, outcome: 'exit' } : `${name} ran`;
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(result).toContain('repaired');
    expect(dispatched).toEqual(['Bash', 'Read']);
    const results = toolResults(capturedMessagesAt(2)).slice(-6);
    expect(results.slice(0, 5).every((block) => typeof block.content === 'string' && block.content.includes('Glob did NOT run'))).toBe(true);
    expect(results[5]!.content).toBe('Read ran');
    expect((capturedMessagesAt(2) ?? []).some((message) =>
      typeof message.content === 'string'
      && message.content.includes('You have called Glob with identical arguments 5 times'),
    )).toBe(true);
  });

  test('keeps invalid-tool stubs in error doom tracking while phase rejections stay excluded', async () => {
    setPlanModeState({
      ...INACTIVE_PLAN_MODE_STATE,
      active: true,
      sessionId: 'phase-guard-invalid-tool-doom',
      startedAt: Date.now(),
      phase: 'explore',
      planFilePath: '/tmp/phase-guard-plan.md',
    });
    const { provider, capturedMessagesAt } = scriptedProvider(Array.from({ length: 3 }, (_, index) => [
      { type: 'tool_call' as const, id: `missing-${index}`, name: 'MissingTool', args: {} },
    ]));
    let dispatched = 0;
    const logSpy = spyOn(debug, 'log');

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'exercise invalid tool tracking' }],
      {
        onText() {},
        dispatchTool: async () => {
          dispatched++;
          return 'should not run';
        },
      },
      { provider, tools: TOOLS, maxTurns: 8 },
    );

    const heal = logSpy.mock.calls.find((call) => call[1] === 'doom-loop-self-heal');
    logSpy.mockRestore();
    expect(dispatched).toBe(0);
    expect(result).not.toContain('[ASK USER]');
    expect(heal?.[2]).toMatchObject({ reason: 'plan-mode', attempt: 1, action: 'guidance', tool: 'MissingTool' });
    expect(toolResults(capturedMessagesAt(1)).slice(-1)[0]!.content).toContain('INVALID TOOL — "MissingTool"');
  });

  test('keeps dedup, search-block, and read-block stubs in identical-success repeat tracking', async () => {
    const scenarios = [
      {
        name: 'Read',
        args: { file_path: '/tmp/repeated.ts' },
        expectedDispatches: 2,
        stub: 'RE-CALL BLOCKED',
      },
      {
        name: 'Glob',
        args: { pattern: 'src/llm.ts' },
        expectedDispatches: 0,
        stub: 'LITERAL-PATH GLOB BLOCKED',
      },
      {
        name: 'Read',
        args: { file_path: 'AGENTS.md' },
        expectedDispatches: 0,
        stub: 'ANCHOR READ BLOCKED',
        // #27630: only an anchor actually loaded (fenced) in the prompt blocks Read.
        system: '=== Root guide (AGENTS.md) ===\ncomplete\n=== end AGENTS.md ===',
      },
    ] as const;

    for (const scenario of scenarios) {
      const { provider, capturedMessagesAt } = scriptedProvider([
        Array.from({ length: 5 }, (_, index) => ({
          type: 'tool_call' as const,
          id: `${scenario.name}-${index}`,
          name: scenario.name,
          args: scenario.args,
        })),
        [{ type: 'text', delta: 'done' }],
      ]);
      let dispatched = 0;

      const result = await streamLLMWithTools(
        [
          ...('system' in scenario ? [{ role: 'system' as const, content: scenario.system }] : []),
          { role: 'user', content: 'exercise blocked-stub repeat tracking' },
        ],
        {
          onText() {},
          dispatchTool: async () => {
            dispatched++;
            return 'real result';
          },
        },
        { provider, model: 'gpt-5.4', tools: TOOLS, maxTurns: 12 },
      );

      expect(result).toBe('done');
      expect(dispatched).toBe(scenario.expectedDispatches);
      const nextTurn = capturedMessagesAt(1) ?? [];
      const intervention = nextTurn.find((message) =>
        typeof message.content === 'string'
        && message.content.includes('identical arguments 5 times'),
      );
      // ⛔ `intervention` 이 없으면 `undefined.toContain(...)` 이 «타입 오류»로 죽어
      //    ***진짜 실패(「개입 메시지가 안 생겼다」)를 가린다*** — 실제로 그 상태로 빨갛다.
      //    ⇒ 없을 때는 「무엇이 있었나」를 문자열로 세워 대서, 실패가 «읽히게» 한다.
      const interventionText = intervention?.content ?? (
        `<개입 메시지 없음 — nextTurn ${nextTurn.length}건 · roles=[${nextTurn.map((m) => m.role).join(', ')}]>`
      );
      expect(interventionText).toContain(`You have called ${scenario.name} with identical arguments 5 times`);
      expect(toolResults(nextTurn).some((block) =>
        typeof block.content === 'string' && block.content.includes(scenario.stub),
      )).toBe(true);
    }
  });

  test('counts repeated mixed verify batches as rejections and hard-stops on the second', async () => {
    const dispatched: string[] = [];
    const mixedBatch = (suffix: string): LLMStreamEvent[] => [
      { type: 'tool_call', id: `glob-${suffix}`, name: 'Glob', args: { pattern: '**/*.ts' } },
      { type: 'tool_call', id: `bash-${suffix}`, name: 'Bash', args: { command: 'bun test focused.ts' } },
    ];
    const { provider, capturedMessagesAt } = scriptedProvider([
      [{ type: 'tool_call', id: 'fail', name: 'Bash', args: { command: 'bun test focused.ts' } }],
      [{ type: 'tool_call', id: 'edit', name: 'Edit', args: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }],
      mixedBatch('one'),
      mixedBatch('two'),
    ]);

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          return name === 'Bash'
            ? { output: 'failed', exitCode: 1, outcome: 'exit' }
            : 'ok';
        },
      },
      { provider, tools: TOOLS, maxTurns: 30 },
    );

    expect(dispatched).toEqual(['Bash', 'Edit', 'Bash']);
    expect(toolResults(capturedMessagesAt(3)).slice(-2)[0]!.content).toContain('Glob did NOT run');
    expect(result).toContain('[VERIFY IGNORED]');
  });

  test('does not record callbacks or tool-call history for the second whole-batch rejection hard-stop', async () => {
    const callbacks: string[] = [];
    const { provider } = scriptedProvider(Array.from({ length: 10 }, (_, turn) => [
      { type: 'tool_call' as const, id: `call-${turn}`, name: 'Read', args: { file_path: `file-${turn}.ts` } },
    ]));

    const result = await streamLLMWithTools(
      [{ role: 'user', content: 'go' }],
      {
        onText() {},
        onToolCall: (call) => callbacks.push(`call:${call.id}`),
        onToolResult: ({ id }) => callbacks.push(`result:${id}`),
        dispatchTool: async () => 'ok',
      },
      { provider, tools: TOOLS, maxTurns: 10 },
    );

    expect(result).toContain('[SYNTHESIS IGNORED]');
    expect(callbacks).toEqual(Array.from({ length: 4 }, (_, turn) => [
      `call:call-${turn}`,
      `result:call-${turn}`,
    ]).flat());
    const source = readFileSync(new URL('../src/llm.ts', import.meta.url), 'utf8');
    const hardStopGuard = source.indexOf('if (rejectsWholeBatch && hardStopText === null) {');
    const historyWrite = source.indexOf('toolCallHistory.push({ name: call.name, args: call.args });', hardStopGuard);
    expect(hardStopGuard).toBeGreaterThan(source.indexOf('if (synthesisRejectionCount >= 2) {'));
    expect(historyWrite).toBeGreaterThan(hardStopGuard);
  });

  test('classifies Plan and MarkStepDone with UpdatePlan across the five phase sets', () => {
    const source = readFileSync(new URL('../src/llm.ts', import.meta.url), 'utf8');
    const sets = [
      'EXPLORATORY_TOOLS',
      'INSPECT_ACTION_TOOLS',
      'EXECUTION_ACTION_TOOLS',
      'REPAIR_ACTION_TOOLS',
      'VERIFY_ACTION_TOOLS',
    ] as const;
    const actionSets = sets.filter((name) => name !== 'EXPLORATORY_TOOLS');

    for (const setName of sets) {
      const tools = toolsInSet(source, setName);
      const hasUpdatePlan = tools.includes('UpdatePlan');
      expect(tools.includes('Plan')).toBe(hasUpdatePlan);
      expect(tools.includes('MarkStepDone')).toBe(hasUpdatePlan);
    }

    expect(toolsInSet(source, 'EXPLORATORY_TOOLS')).not.toContain('UpdatePlan');
    expect(toolsInSet(source, 'EXPLORATORY_TOOLS')).not.toContain('Plan');
    expect(toolsInSet(source, 'EXPLORATORY_TOOLS')).not.toContain('MarkStepDone');
    for (const setName of actionSets) {
      expect(toolsInSet(source, setName)).toContain('UpdatePlan');
      expect(toolsInSet(source, setName)).toContain('Plan');
      expect(toolsInSet(source, setName)).toContain('MarkStepDone');
    }
  });
});
