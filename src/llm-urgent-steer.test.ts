import { expect, test } from 'bun:test';
import { streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from './llm.js';
import { signalUrgentSteer } from './session/urgent-steer.js';
import { createNextTuiSteerInbox } from './repl/next-tui-steer.js';
import { drainPendingUserInput } from './session/pending-input.js';

test('SEAT-STEER-PREEMPT: an urgent decision interrupts a stalled generation and reaches the next provider request', async () => {
  const sessionId = 'urgent-generation-test';
  const seen: string[][] = [];
  let enteredFirst = () => {};
  const first = new Promise<void>((resolve) => { enteredFirst = resolve; });
  let aborted = false;
  const provider: LLMProvider = {
    name: 'urgent-generation-provider', defaultModel: 'urgent-generation-model', available: () => true,
    async *chat() { yield 'unused'; },
    streamChat(messages, options) {
      seen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
      if (seen.length > 1) return (async function* () { yield { type: 'text', delta: 'decision received' } as LLMStreamEvent; })();
      options?.signal?.addEventListener('abort', () => { aborted = true; });
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { enteredFirst(); return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {}); },
        async return() { return { done: true, value: undefined }; },
      } as AsyncGenerator<LLMStreamEvent, void, unknown>;
    },
  };
  const pending: string[] = [];
  const result = streamLLMWithTools([{ role: 'user', content: 'initial work' }],
    { onText() {}, dispatchTool: async () => 'unused' },
    { provider, model: provider.defaultModel, tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
      // 출처: #126648 이 시험은 끊긴 최초 요청 한 번과 결정 우편을 받은 후속 요청 한 번만 허용한다.
      sessionId, maxTurns: 2, drainPendingUserInput: () => pending.splice(0) });
  await first;
  pending.push('OP decision: stop and report');
  signalUrgentSteer(sessionId);
  expect(await Promise.race([result, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('urgent steer stalled')), 1000))])).toBe('decision received');
  expect(aborted).toBe(true);
  expect(seen).toHaveLength(2);
  expect(seen[1]?.some((s) => s.includes('OP decision: stop and report'))).toBe(true);
});

test('a decision arriving during the final allowed provider request reaches another request', async () => {
  const sessionId = 'urgent-final-request-test';
  const pending: string[] = [];
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: 'urgent-final-provider', defaultModel: 'urgent-final-model', available: () => true,
    async *chat() { yield 'unused'; },
    streamChat(messages) {
      const request = seen.length + 1;
      seen.push(JSON.stringify(messages));
      if (request >= 3) return (async function* () { yield { type: 'text', delta: 'both decisions received' } as LLMStreamEvent; })();
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          queueMicrotask(() => { pending.push(`decision-${request}`); signalUrgentSteer(sessionId); });
          return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {});
        },
        async return() { return { done: true, value: undefined }; },
      } as AsyncGenerator<LLMStreamEvent, void, unknown>;
    },
  };
  const result = await Promise.race([
    streamLLMWithTools([{ role: 'user', content: 'initial' }], { onText() {}, dispatchTool: async () => '' },
      { provider, model: provider.defaultModel, sessionId, maxTurns: 1,
        tools: [{ name: 'probe', description: '', parameters: { type: 'object' } }],
        drainPendingUserInput: () => pending.splice(0) }),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('last decision stalled')), 5000)),
  ]);
  expect(result).toBe('both decisions received');
  expect(seen).toHaveLength(3);
  expect(seen[1]).toContain('decision-1');
  expect(seen[2]).toContain('decision-2');
  expect(pending).toEqual([]);
});

// JUD-B #129504/#129619 — urgent grace at the budget boundary (maxTurns 3). Two in-budget interrupts use both grace
// grants; the third decision rides the one continuation request; a fourth that lands on that last request is never
// drained into an unsent request — it stays pending and the child steer inbox hands it back as the next turn.
const DECISIONS = ['DECISION-1', 'DECISION-2', 'DECISION-3', 'DECISION-4', 'DECISION-5'];
const carriedIds = (body: string): string[] => DECISIONS.filter((d) => body.includes(d));

function stallingProvider(onRequest: (request: number) => void, answerAfter: number): { provider: LLMProvider; seen: string[] } {
  const seen: string[] = [];
  const provider: LLMProvider = {
    name: 'urgent-grace-provider', defaultModel: 'urgent-grace-model', available: () => true,
    async *chat() { yield 'unused'; },
    streamChat(messages) {
      const request = seen.length + 1;
      seen.push(JSON.stringify(messages));
      if (request > answerAfter) return (async function* () { yield { type: 'text', delta: `answer-${request}` } as LLMStreamEvent; })();
      return {
        [Symbol.asyncIterator]() { return this; },
        next() { queueMicrotask(() => onRequest(request)); return new Promise<IteratorResult<LLMStreamEvent, void>>(() => {}); },
        async return() { return { done: true, value: undefined }; },
      } as AsyncGenerator<LLMStreamEvent, void, unknown>;
    },
  };
  return { provider, seen };
}

const graceOpts = (provider: LLMProvider, sessionId: string, drain: () => readonly string[]) => ({
  // 출처: #129504 JUD-B 가설의 예산 경계 — maxTurns 3, 유예 2회.
  provider, model: provider.defaultModel, sessionId, maxTurns: 3,
  tools: [{ name: 'probe', description: '', parameters: { type: 'object' as const } }], drainPendingUserInput: drain,
});

const withDeadline = <T>(p: Promise<T>): Promise<T> => Promise.race([p,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error('urgent grace stalled')), 5000))]);

test('urgent grace A: every request interrupted — boundary decision stays pending, never dropped', async () => {
  const sessionId = 'urgent-grace-a';
  const pending: string[] = [];
  const { provider, seen } = stallingProvider((request) => { pending.push(`DECISION-${request}`); signalUrgentSteer(sessionId); }, 99);
  await withDeadline(streamLLMWithTools([{ role: 'user', content: 'initial' }], { onText() {}, dispatchTool: async () => '' },
    graceOpts(provider, sessionId, () => pending.splice(0))));
  expect(seen.map(carriedIds)).toEqual([[], ['DECISION-1'], ['DECISION-1', 'DECISION-2'], ['DECISION-1', 'DECISION-2', 'DECISION-3']]);
  expect(pending).toEqual(['DECISION-4']);
});

test('urgent grace C: three interrupts then an answer — all three decisions delivered, nothing pending', async () => {
  const sessionId = 'urgent-grace-c';
  const pending: string[] = [];
  const { provider, seen } = stallingProvider((request) => { pending.push(`DECISION-${request}`); signalUrgentSteer(sessionId); }, 3);
  const result = await withDeadline(streamLLMWithTools([{ role: 'user', content: 'initial' }], { onText() {}, dispatchTool: async () => '' },
    graceOpts(provider, sessionId, () => pending.splice(0))));
  expect(result).toBe('answer-4');
  expect(seen.map(carriedIds)).toEqual([[], ['DECISION-1'], ['DECISION-1', 'DECISION-2'], ['DECISION-1', 'DECISION-2', 'DECISION-3']]);
  expect(pending).toEqual([]);
});

test('urgent grace D: real child steer inbox — applied steer-1..3, boundary steer-4 carried to the next turn', async () => {
  const sessionId = 'urgent-grace-d';
  const applied: string[] = [];
  const inbox = createNextTuiSteerInbox(sessionId, (ids) => { applied.push(...ids); });
  const { provider, seen } = stallingProvider((request) => { inbox.push(`steer-${request}`, `DECISION-${request}`, true); }, 99);
  await withDeadline(streamLLMWithTools([{ role: 'user', content: 'initial' }], { onText() {}, dispatchTool: async () => '' },
    graceOpts(provider, sessionId, () => drainPendingUserInput(sessionId))));
  expect(seen.map(carriedIds)).toEqual([[], ['DECISION-1'], ['DECISION-1', 'DECISION-2'], ['DECISION-1', 'DECISION-2', 'DECISION-3']]);
  expect(applied).toEqual(['steer-1', 'steer-2', 'steer-3']);
  expect(inbox.finish()).toEqual(['steer-4']);
  expect(drainPendingUserInput(sessionId)).toEqual([]);
});
