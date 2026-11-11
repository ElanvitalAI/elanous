import { expect, test } from 'bun:test';
import { agentDisplayLines, agentResultStatus, agentTraceLine, applyAgentEvent, reconcileAgentOutputStatuses } from './agents.js';
import { logViewLines, toolFoldBlockStarts } from '../chat/log-view.js';

test('Agent child start, completion, failure, and background handoff each occupy one line', () => {
  const started = applyAgentEvent([], { phase: 'start', id: 'a', description: '코드 조사' });
  expect(agentDisplayLines(started)).toEqual(['◐ 하위 에이전트 · 실행 중 1']);
  const done = applyAgentEvent(started, { phase: 'finish', id: 'a', status: agentResultStatus({ agent: 'general-purpose', output: '완료' }) });
  expect(agentDisplayLines(done)).toEqual(['✓ 하위 에이전트 · 완료 1']);
  const failed = applyAgentEvent(started, { phase: 'finish', id: 'a', status: agentResultStatus({ error: 'child failed' }) });
  expect(agentDisplayLines(failed)).toEqual(['✗ 하위 에이전트 · 실패 1']);
  expect(agentResultStatus({ isError: true })).toBe('failed');
  const background = applyAgentEvent(started, { phase: 'finish', id: 'a', status: agentResultStatus({ background: true, taskId: 'task-1' }) });
  expect(agentDisplayLines(background)).toEqual(['◐ 하위 에이전트 · 실행 중 1']);
  expect(agentDisplayLines(applyAgentEvent(started, { phase: 'finish', id: 'a', status: agentResultStatus({ output: 'NOT SPAWNED — limit' }) })))
    .toEqual(['✗ 하위 에이전트 · 실패 1']);
});

test('three child tasks stay one grouped card and AgentOutput changes running to completed counts', () => {
  let agents = ['a', 'b', 'c'].reduce((items, id) =>
    applyAgentEvent(items, { phase: 'start', id, description: `child ${id}` }), [] as ReturnType<typeof applyAgentEvent>);
  expect(agentDisplayLines(agents)).toEqual(['◐ 하위 에이전트 · 실행 중 3']);
  const outputs = ['a', 'b', 'c'].map((taskId) => ({
    role: 'tool' as const, content: '⚙️ AgentOutput', toolName: 'AgentOutput',
    toolResult: JSON.stringify({ taskId, retrievalStatus: 'success', state: 'done' }), ts: 't',
  }));
  agents = reconcileAgentOutputStatuses(agents, outputs.slice(0, 1));
  expect(agentDisplayLines(agents)).toEqual(['◐ 하위 에이전트 · 실행 중 2 · 완료 1']);
  agents = reconcileAgentOutputStatuses(agents, outputs);
  expect(agentDisplayLines(agents)).toEqual(['✓ 하위 에이전트 · 완료 3']);
});

test('Agent history shows a bounded status line instead of a folded child transcript', () => {
  const message = { role: 'tool' as const, content: '⚙️ Agent', toolName: 'Agent',
    toolArgs: JSON.stringify({ description: '코드 조사' }),
    toolResult: JSON.stringify({ agent: 'general-purpose', output: 'secret output\n'.repeat(30) }), ts: 't' };
  expect(agentTraceLine(message)).toBe('✓ Agent(코드 조사) · 완료');
  expect(logViewLines([message], 40)).toEqual(['✓ Agent(코드 조사) · 완료', '']);
  expect(toolFoldBlockStarts([message], 40)).toEqual([]);
  expect(agentTraceLine({ ...message, toolName: 'Bash' })).toBeNull();
  expect(agentTraceLine({ ...message, toolResult: JSON.stringify({ error: 'bad' }) })).toBe('✗ Agent(코드 조사) · 실패');
  expect(agentTraceLine({ ...message, toolArgs: JSON.stringify({ description: '조사\x1b[2J\n다음 줄' }) }))
    .toBe('✓ Agent(조사 다음 줄) · 완료');
});
