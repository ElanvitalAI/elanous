import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRegistry } from '../agent/registry.js';
import { dispatchAgentOutput } from '../agent/agent-output-tool.js';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { debug } from '../debug/log.js';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../llm.js';
import { parse as parseYaml } from 'yaml';
import { dispatchSelfImplementManaged, ManagedTaskAdmissionStore, buildSelfImplementDaemonSpec } from '../boot/daemon-tools/self-implement.js';

interface ToolAsyncFailLoopScenario {
  version: 0;
  id: 'tui-selfimplement-retry-loop';
  recording: {
    tool: 'SelfImplement';
    feature: string;
    repeatedCalls: number;
    invalidGoalFiles: string[];
    finalFeature: string;
    finalGoalFile: string;
    oldGoalTitle: string;
    fakeHarnessFailure: string;
    agentOutputRepeatCalls: number;
  };
}

export interface ToolAsyncFailLoopEvidence {
  recordedToolCallCount: number;
  emittedToolCallCount: number;
  incidentEmittedToolCallCount: number;
  incidentDispatchedToolCallCount: number;
  blockedIncidentToolCallCount: number;
  dispatchedToolCallCount: number;
  blockedToolCallCount: number;
  finalOldGoalDispatched: boolean;
  invalidDispatches: number;
  managedAdmissions: number;
  repeatBlockedEvents: number;
  doomLoopDetected: boolean;
  lateFailureVisible: boolean;
  lateFailureRepeatDispatches: number;
  reusedGoalTitle: string | null;
}

/** Replays the SelfImplement retry incident through the real model tool loop and daemon adapter. */
export async function runToolAsyncFailLoopSimulation(): Promise<ToolAsyncFailLoopEvidence> {
  const scenarioFile = resolve(import.meta.dir, '../../scenarios/ux-sim/tui-selfimplement-retry-loop.yaml');
  const scenario = parseYaml(readFileSync(scenarioFile, 'utf8')) as ToolAsyncFailLoopScenario;
  if (scenario.id !== 'tui-selfimplement-retry-loop' || scenario.recording.invalidGoalFiles.length === 0 || scenario.recording.repeatedCalls <= 3) {
    throw new Error('invalid tui-selfimplement-retry-loop scenario recording');
  }
  const root = mkdtempSync(join(tmpdir(), 'tool-async-fail-loop-'));
  const repo = join(root, 'repo');
  const goals = join(repo, '.elanous', 'goals');
  mkdirSync(goals, { recursive: true });
  const oldGoal = join(repo, scenario.recording.finalGoalFile);
  writeFileSync(oldGoal, `# ${scenario.recording.oldGoalTitle}\n\n## WHAT TO BUILD\nKeep this unrelated goal unchanged.\n`);
  const registry = new AgentRegistry();
  const admission = new ManagedTaskAdmissionStore(join(root, 'admissions'));
  let invalidDispatches = 0;
  let reusedGoalTitle: string | null = null;
  let acceptedTaskId: string | null = null;
  let finalOldGoalDispatched = false;
  let incidentEmittedToolCallCount = 0;
  let incidentDispatchedToolCallCount = 0;
  const emittedToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let repeatBlockedEvents = 0;
  let doomLoopDetected = false;
  const originalLog = debug.log;
  debug.log = ((category: string, event: string) => {
    if (category === 'llm.router' && event === 'tool-error-repeat-blocked') repeatBlockedEvents++;
    if (category === 'llm.tool-loop.retry' && event === 'doom-loop-detected') doomLoopDetected = true;
  }) as typeof debug.log;
  const failureProvider = (name: string, toolName: string, args: Array<Record<string, unknown>>): LLMProvider => {
    let recordingEmitted = false;
    return {
      name, defaultModel: 'sim', available: () => true,
      async *chat() {},
      async *streamChat() {
        if (recordingEmitted) { yield { type: 'text', delta: 'stopped' } satisfies LLMStreamEvent; return; }
        recordingEmitted = true;
        for (const [index, toolArgs] of args.entries()) {
          emittedToolCalls.push({ name: toolName, args: toolArgs });
          yield { type: 'tool_call', id: `call-${index + 1}`, name: toolName, args: toolArgs } satisfies LLMStreamEvent;
        }
      },
    };
  };
  const dispatchRecordedSelfImplement = async (args: Record<string, unknown>, sessionId: string, callId?: string) => {
    if (args.goalFile !== oldGoal) invalidDispatches++;
    const result = await dispatchSelfImplementManaged(args, {
      cwd: repo, sessionId, toolCallId: callId, signal: new AbortController().signal,
    }, async () => { throw new Error(scenario.recording.fakeHarnessFailure); }, undefined, undefined, undefined, admission,
    { registry, taskNotifications: new TaskNotificationQueue() });
    if ('taskId' in result && args.goalFile === oldGoal) {
      acceptedTaskId = result.taskId;
      finalOldGoalDispatched = true;
      if (result.message.includes(`reused goal: ${scenario.recording.oldGoalTitle}`)) reusedGoalTitle = scenario.recording.oldGoalTitle;
    }
    return result;
  };
  try {
    await streamLLMWithTools([{ role: 'user', content: 'resume the harness request' }], {
      onText() {},
      dispatchTool: async (_name, args, ctx) => {
        incidentDispatchedToolCallCount++;
        return dispatchRecordedSelfImplement(args, 'incident-session', ctx?.callId);
      },
    }, {
      provider: failureProvider('recorded-tf-selfimplement-incident', scenario.recording.tool, [
        ...Array.from({ length: scenario.recording.repeatedCalls }, (_, index) => ({
          feature: scenario.recording.feature, goalFile: scenario.recording.invalidGoalFiles[index % scenario.recording.invalidGoalFiles.length],
        })),
        { feature: scenario.recording.finalFeature, goalFile: oldGoal },
      ]),
      model: 'sim', tools: [buildSelfImplementDaemonSpec()], maxTurns: 2,
    });
    incidentEmittedToolCallCount = emittedToolCalls.length;
    const lateTaskId = acceptedTaskId;
    if (!lateTaskId || !finalOldGoalDispatched) throw new Error('recorded final old-goal call was not dispatched by the incident tool loop');
    for (let i = 0; i < 100 && registry.get(lateTaskId)?.state !== 'error'; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const lateResult = await dispatchAgentOutput({ taskId: lateTaskId }, { registry });

    let lateDispatches = 0;
    const repeatProvider = ((): LLMProvider => {
      let turn = 0;
      return {
        name: 'agent-output-failure-simulation', defaultModel: 'sim', available: () => true,
        async *chat() {},
        async *streamChat() {
          turn++;
          if (turn <= scenario.recording.agentOutputRepeatCalls) {
            const args = { taskId: lateTaskId };
            emittedToolCalls.push({ name: 'AgentOutput', args });
            yield { type: 'tool_call', id: `out-${turn}`, name: 'AgentOutput', args } satisfies LLMStreamEvent;
          } else yield { type: 'text', delta: 'stopped' } satisfies LLMStreamEvent;
        },
      };
    })();
    await streamLLMWithTools([{ role: 'user', content: 'check the run result' }], {
      onText() {},
      dispatchTool: async (_name, args) => {
        lateDispatches++;
        return dispatchAgentOutput(args, { registry });
      },
    }, {
      provider: repeatProvider, model: 'sim',
      tools: [{ name: 'AgentOutput', description: 'read a task result', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } }],
      maxTurns: scenario.recording.agentOutputRepeatCalls + 1,
    });
    return {
      invalidDispatches, managedAdmissions: registry.list().length, repeatBlockedEvents,
      doomLoopDetected, lateFailureVisible: lateResult.isError === true && lateResult.output.includes('ImagePullBackOff'),
      lateFailureRepeatDispatches: lateDispatches, reusedGoalTitle, recordedToolCallCount: scenario.recording.repeatedCalls + 1,
      emittedToolCallCount: emittedToolCalls.length, incidentEmittedToolCallCount, incidentDispatchedToolCallCount,
      blockedIncidentToolCallCount: incidentEmittedToolCallCount - incidentDispatchedToolCallCount,
      dispatchedToolCallCount: incidentDispatchedToolCallCount + lateDispatches,
      blockedToolCallCount: emittedToolCalls.length - incidentDispatchedToolCallCount - lateDispatches, finalOldGoalDispatched,
    };
  } finally {
    debug.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
}
