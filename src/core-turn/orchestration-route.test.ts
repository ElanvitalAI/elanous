// DEMO-FANOUT-LIVE-OP-SEAT — an orchestration request is never answered by the research/grounding route.
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as llm from '../llm.js';
import { runCoreTurn } from './run-core-turn.js';
import { coordinatorSeatSet, orchestrationSkipReason } from './orchestration-route.js';

const spec = (name: string) => ({ name, description: name, parameters: { type: 'object' } });
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => { while (restores.length) restores.pop()!.mockRestore(); });

async function ladderCalls(userText: string, seat: string | null, tools: string[]): Promise<number> {
  let calls = 0;
  restores.push(spyOn(llm, 'streamLLMWithTools').mockImplementation(async () => 'done'));
  await runCoreTurn({ sessionId: 'orch-route-test', messages: [{ role: 'user', content: userText }], userText,
    tools: tools.map(spec), dispatchTool: async () => 'ok', signal: new AbortController().signal },
  { runResearch: async () => { calls += 1; return { ok: true, output: 'evidence' }; }, stallSeat: seat, stallMailer: async () => {} });
  return calls;
}

test('demo-check S2: the OP asking for 3 research tabs reaches the tool loop, not the research ladder', async () => {
  const line = '2027 Korea equity outlook — split it into 3 research tabs (news, sentiment, market)';
  expect(await ladderCalls(line, 'OP', ['WebSearch', 'WebFetch', 'ElsControl'])).toBe(0);
});

test('a line naming an orchestration tool in the pool skips the ladder for a seatless caller too', async () => {
  expect(await ladderCalls('Use ElsControl to open 3 research tabs on Korea equities', null, ['WebSearch', 'WebFetch', 'ElsControl'])).toBe(0);
  expect(await ladderCalls('Use the Agent tool to research Korea equities in parallel', null, ['WebSearch', 'WebFetch', 'Agent'])).toBe(0);
});

test('without an orchestration tool in the pool the research route is unchanged', async () => {
  expect(await ladderCalls('research the 2027 Korea equity outlook', 'OP', ['WebSearch', 'WebFetch'])).toBe(1);
  expect(await ladderCalls('Use ElsControl to research the 2027 Korea equity outlook', null, ['WebSearch', 'WebFetch'])).toBe(1);
});

test('a seatless research question with ElsControl in the pool but not named keeps the research route', async () => {
  expect(await ladderCalls('research the 2027 Korea equity outlook', null, ['WebSearch', 'WebFetch', 'ElsControl'])).toBe(1);
});

test('skip reasons are structural: tool named as a whole token, or a coordinator seat', () => {
  const coordinators = new Set(['OP', 'HQX']);
  expect(orchestrationSkipReason('please use ElsControl now', null, ['ElsControl'], coordinators)).toBe('orchestration-tool-named');
  expect(orchestrationSkipReason('ElsControlled research', null, ['ElsControl'], coordinators)).toBeNull();
  expect(orchestrationSkipReason('agents column research', null, ['Agent'], coordinators)).toBeNull();
  expect(orchestrationSkipReason('research tabs', 'op', ['ElsControl'], coordinators)).toBe('coordinator-orchestrates');
  expect(orchestrationSkipReason('research tabs', 'HQX', ['Agent'], coordinators)).toBe('coordinator-orchestrates');
  expect(orchestrationSkipReason('research tabs', 'TC', ['ElsControl'], coordinators)).toBeNull();
  expect(orchestrationSkipReason('use ElsControl', 'OP', ['WebSearch'], coordinators)).toBeNull();
  expect(orchestrationSkipReason('research news and mail OP', null, ['WebSearch', 'MsgPost'], coordinators, true)).toBe('delegated-worker');
});

test('a delegated worker pane (els parent pane in env) researches in the tool loop, so it can mail the result back', async () => {
  const saved = process.env.ELANOUS_ELS_PARENT_PANE;
  process.env.ELANOUS_ELS_PARENT_PANE = 'p75a03a07';
  try { expect(await ladderCalls('research 2027 Korea equity news, then mail the result to OP', null, ['WebSearch', 'WebFetch', 'MsgPost'])).toBe(0); }
  finally { if (saved === undefined) delete process.env.ELANOUS_ELS_PARENT_PANE; else process.env.ELANOUS_ELS_PARENT_PANE = saved; }
});

test('coordinator seats: OP always, plus a declared HQ coordinator; an unreadable declaration keeps OP alone', () => {
  expect([...coordinatorSeatSet(() => undefined)]).toEqual(['OP']);
  expect([...coordinatorSeatSet(() => ' hq1 ')]).toEqual(['OP', 'HQ1']);
  expect([...coordinatorSeatSet(() => { throw new Error('bad yaml'); })]).toEqual(['OP']);
});
