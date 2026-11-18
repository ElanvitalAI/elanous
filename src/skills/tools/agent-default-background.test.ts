import { expect, test } from 'bun:test';
import type { LLMProvider } from '../../llm.js';
import { globalTaskNotificationQueue } from '../../agent/task-notification.js';
import { dispatchAgent } from './agent.js';

test('an Agent without an explicit mode returns while its child is still running', async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const provider: LLMProvider = {
    name: 'gated', defaultModel: 'gated', available: () => true,
    async *streamChat() { started(); await hold; yield { type: 'text', delta: 'child complete' }; },
    async *chat() {},
  };
  const result = dispatchAgent({ description: 'long child', prompt: 'independent long child' }, {
    provider, resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'test', tools: [] }),
  });
  try {
    await running;
    const first = await Promise.race([result, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 100))]);
    expect(first).not.toBe('blocked');
    if (first !== 'blocked') expect(first.background).toBe(true);
  } finally {
    release();
    await result;
  }
});

test('an explicitly synchronous Agent detaches after ten seconds', async () => {
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const provider: LLMProvider = {
    name: 'gated', defaultModel: 'gated', available: () => true,
    async *streamChat() { started(); await hold; yield { type: 'text', delta: 'child complete' }; },
    async *chat() {},
  };
  const result = dispatchAgent({ description: 'long synchronous child', prompt: 'independent child', run_in_background: false }, {
    provider, parentSessionId: 'sync-cap-test', resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'test', tools: [] }),
  });
  try {
    await running;
    const first = await Promise.race([result, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 11000))]);
    expect(first).not.toBe('blocked');
    if (first !== 'blocked') {
      expect(first.background).toBe(true);
      release();
      const deadline = Date.now() + 1000;
      while (!globalTaskNotificationQueue.has(first.taskId) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const notification = globalTaskNotificationQueue.drainForParentSession('sync-cap-test');
      expect(notification.map(item => [item.taskId, item.output])).toContainEqual([first.taskId, 'child complete']);
    }
  } finally {
    release();
    await result;
  }
}, 15000);

test('queued work delivers completion under its original ticket', async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const provider: LLMProvider = {
    name: 'gated', defaultModel: 'gated', available: () => true,
    async *streamChat() { calls++; await new Promise<void>(resolve => releases.push(resolve)); yield { type: 'text', delta: 'queued result' }; },
    async *chat() {},
  };
  const opts = { provider, parentSessionId: 'queue-ticket-test', resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'test', tools: [] }) };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(predicate()).toBe(true);
  };
  try {
    for (let i = 0; i < 8; i++) await dispatchAgent({ description: `queue ${i}`, prompt: `queue ${i}` }, opts);
    await waitFor(() => calls === 8);
    const ticket = await dispatchAgent({ description: 'queue ninth', prompt: 'queue ninth' }, opts);
    expect(ticket.background).toBe(true);
    releases[0]!();
    await waitFor(() => calls === 9);
    releases[8]!();
    await waitFor(() => globalTaskNotificationQueue.has(ticket.taskId));
    const notices = globalTaskNotificationQueue.drainForParentSession('queue-ticket-test');
    expect(notices.map(notice => [notice.taskId, notice.output])).toContainEqual([ticket.taskId, 'queued result']);
  } finally {
    for (const release of releases) release();
  }
}, 5000);

test('explicit queue waiting detaches within ten seconds', async () => {
  const releases: Array<() => void> = [];
  let calls = 0;
  const provider: LLMProvider = {
    name: 'gated', defaultModel: 'gated', available: () => true,
    async *streamChat() { calls++; await new Promise<void>(resolve => releases.push(resolve)); yield { type: 'text', delta: 'done' }; },
    async *chat() {},
  };
  const opts = { provider, parentSessionId: 'queue-cap-test', resolveAgentDef: () => ({ name: 'general-purpose', systemPrompt: 'test', tools: [] }) };
  try {
    for (let i = 0; i < 8; i++) await dispatchAgent({ description: `cap ${i}`, prompt: `cap ${i}` }, opts);
    while (calls < 8) await new Promise(resolve => setTimeout(resolve, 5));
    const pending = dispatchAgent({ description: 'cap ninth', prompt: 'cap ninth', wait_for_slot: true }, opts);
    const first = await Promise.race([pending, new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 11000))]);
    expect(first).not.toBe('blocked');
    if (first !== 'blocked') {
      expect(first.background).toBe(true);
      releases[0]!();
      const deadline = Date.now() + 1000;
      while (calls < 9 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(calls).toBe(9);
    }
  } finally {
    for (const release of releases) release();
  }
}, 15000);
