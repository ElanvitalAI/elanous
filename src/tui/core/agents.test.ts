import { expect, test } from 'bun:test';
import { agentDisplayLine, agentDisplayLines, agentResultStatus, agentTraceLine, applyAgentEvent, reconcileAgentOutputStatuses, reconcileNestedAgentSnapshot } from './agents.js';

test('AgentOutput settlement agrees in the summary and individual row', () => {
  const started = applyAgentEvent([], { phase: 'start', id: 'task-1', description: 'worker' });
  const background = applyAgentEvent(started, { phase: 'finish', id: 'task-1', status: 'background' });
  const settled = reconcileAgentOutputStatuses(background, [{ role: 'tool', content: '⚙️ AgentOutput',
    toolName: 'AgentOutput', toolResult: JSON.stringify({ taskId: 'task-1', retrievalStatus: 'success', state: 'done' }), ts: 't' }]);
  expect(agentDisplayLines(settled)).toEqual(['✓ 하위 에이전트 · 완료 1']);
  expect(settled.map(agentDisplayLine)).toEqual(['✓ Agent(worker) · 완료']);
});

test('late nested completion updates the settled display without replacing top-level agents', () => {
  const top = applyAgentEvent([], { phase: 'start', id: 'root', description: 'root' });
  const nested = reconcileNestedAgentSnapshot(top, [{ id: 'grandchild', description: '↳ grandchild', status: 'done' }]);
  expect(nested).toEqual([...top, { id: 'grandchild', description: '↳ grandchild', status: 'done', source: 'nested' }]);
  expect(reconcileNestedAgentSnapshot(nested, [{ id: 'grandchild', description: '↳ grandchild', status: 'failed' }]))
    .toEqual([...top, { id: 'grandchild', description: '↳ grandchild', status: 'failed', source: 'nested' }]);
  const userNamed = applyAgentEvent(nested, { phase: 'start', id: 'named', description: '↳ user named' });
  expect(reconcileNestedAgentSnapshot(userNamed, [])).toEqual([...top,
    { id: 'named', description: '↳ user named', status: 'running' }]);
});
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

test('background task snapshot replaces a stale running card before AgentOutput is consumed', () => {
  const started = ['call-a', 'call-b'].reduce((items, id) =>
    applyAgentEvent(items, { phase: 'start', id, description: `child ${id}` }), [] as ReturnType<typeof applyAgentEvent>);
  const messages = ['a', 'b'].map((id) => ({
    role: 'tool' as const, content: 'Agent', toolName: 'Agent', toolCallId: `call-${id}`,
    toolResult: JSON.stringify({ background: true, taskId: `task-${id}`, output: `(running in background — taskId=task-${id})` }), ts: 't',
  }));
  const tasks = [
    { id: 'task-a', label: 'child a', state: 'done' as const },
    { id: 'task-b', label: 'child b', state: 'error' as const },
  ];
  expect(agentDisplayLines(reconcileAgentOutputStatuses(started, messages, tasks)))
    .toEqual(['✗ 하위 에이전트 · 완료 1 · 실패 1']); // Source: the terminal states in this background task snapshot.
  const output = [{ role: 'tool' as const, content: 'AgentOutput', toolName: 'AgentOutput',
    toolResult: JSON.stringify({ taskId: 'task-b', retrievalStatus: 'success', state: 'done' }), ts: 't' }];
  expect(agentDisplayLines(reconcileAgentOutputStatuses(started, [...messages, ...output], tasks)))
    .toEqual(['✓ 하위 에이전트 · 완료 2']); // Source: the authoritative AgentOutput marks task-b done.
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
